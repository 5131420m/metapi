/**
 * Executable version of the proxy-log read policy.
 *
 * The problem this locks: probe traffic is written to `proxy_logs` (so it is auditable),
 * and several aggregates read that same table. When the probe was first added, every one
 * of those aggregates silently started counting metapi's own requests — a button click
 * moved the dashboard's success rate and failure count.
 *
 * A comment asking people to remember is not a guard. This test reads the source and
 * fails when a `proxy_logs` read neither excludes probe traffic nor declares itself a
 * row-level view, so a new aggregate cannot quietly reintroduce the bug.
 *
 * WHAT IT CANNOT DO (known limitations, accepted for now):
 *
 * - It matches `meteredProxyLogCondition(` within a window of lines, so a *neighbouring*
 *   query in the same function can satisfy it on behalf of the one that actually lacks it.
 * - It looks for the literal `.from(schema.proxyLogs)`; a read written across lines
 *   (`.from(\n  schema.proxyLogs,\n)`) is not seen at all, so it would neither fail nor warn.
 * - It says nothing about reads that reach the table through a helper, e.g. a query built in
 *   another module and only invoked here.
 *
 * It is a regression tripwire for the common shape, not a proof. A precise version needs an
 * AST (or a runtime query-count assertion) and is not worth the machinery until a read
 * escapes it in practice.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROXY_LOG_VIEW_INCLUDES_PROBE } from './proxyLogQueries.js';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** How far after `.from(schema.proxyLogs)` the exclusion / marker may appear. */
const LOOKAHEAD_LINES = 25;
/** How far before it a marker comment may sit. */
const LOOKBEHIND_LINES = 4;

/**
 * Files allowed to read `proxy_logs` without either marker.
 *
 * `proxyLogStore` owns the table (it is the writer), and `proxyLogQueries` owns the
 * condition this test is about.
 */
const OWNER_FILES = new Set([
  'services/proxyLogStore.ts',
  'services/proxyLogQueries.ts',
]);

function listServerSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      listServerSources(full, out);
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts') || entry.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

type ProxyLogRead = {
  file: string;
  line: number;
  text: string;
  governed: boolean;
  reason: string;
};

function collectProxyLogReads(): ProxyLogRead[] {
  const reads: ProxyLogRead[] = [];

  for (const full of listServerSources(SERVER_ROOT)) {
    const relative = full.slice(SERVER_ROOT.length + 1).replace(/\\/g, '/');
    const lines = readFileSync(full, 'utf8').split(/\r?\n/);

    lines.forEach((line, index) => {
      if (!line.includes('from(schema.proxyLogs)') && !line.includes('from(schema.proxy_logs)')) {
        return;
      }
      if (OWNER_FILES.has(relative)) return;

      const after = lines.slice(index, index + LOOKAHEAD_LINES).join('\n');
      const before = lines.slice(Math.max(0, index - LOOKBEHIND_LINES), index).join('\n');

      const excludesProbes = after.includes('meteredProxyLogCondition(');
      const declaresRowLevelView = before.includes(PROXY_LOG_VIEW_INCLUDES_PROBE);

      reads.push({
        file: relative,
        line: index + 1,
        text: line.trim(),
        governed: excludesProbes || declaresRowLevelView,
        reason: excludesProbes
          ? 'excludes probe traffic'
          : declaresRowLevelView
            ? 'row-level view'
            : 'NEITHER: add meteredProxyLogCondition() to its where-clause, or mark it as a row-level view',
      });
    });
  }

  return reads;
}

describe('proxy log read policy', () => {
  const reads = collectProxyLogReads();

  it('finds the proxy_logs reads it is supposed to govern', () => {
    // A guard that silently matches nothing would pass forever; this pins the floor.
    expect(reads.length).toBeGreaterThanOrEqual(15);
  });

  it('every proxy_logs read either excludes probe traffic or declares itself a row-level view', () => {
    const ungoverned = reads.filter((read) => !read.governed);
    const report = ungoverned
      .map((read) => `  ${read.file}:${read.line}  ${read.reason}\n    ${read.text}`)
      .join('\n');
    expect(ungoverned, `ungoverned proxy_logs reads:\n${report}`).toEqual([]);
  });

  it('keeps both halves of the contract in use, not just one', () => {
    // If someone "fixed" a failure by marking every aggregate as a row-level view, the
    // first assertion would still pass while the policy was gone.
    const excluding = reads.filter((read) => read.reason === 'excludes probe traffic');
    const rowLevel = reads.filter((read) => read.reason === 'row-level view');
    expect(excluding.length).toBeGreaterThanOrEqual(8);
    expect(rowLevel.length).toBeGreaterThanOrEqual(4);
  });

  it('documents that the condition is NULL-safe where it is defined', () => {
    // The behavioural half of this lives in `proxyLogQueries.test.ts`; this only pins that
    // the definition keeps using a NULL-safe comparison rather than a bare `<>`.
    const source = readFileSync(resolve(SERVER_ROOT, 'services/proxyLogQueries.ts'), 'utf8');
    expect(source).toContain('isNull(');
    expect(source).toContain('CANDY_PROBE_CLIENT_FAMILY');
    expect(source).not.toMatch(/ne\(\s*schema\.proxyLogs\.clientFamily,\s*CANDY_PROBE_CLIENT_FAMILY\s*\)\s*;?\s*$/m);
  });
});
