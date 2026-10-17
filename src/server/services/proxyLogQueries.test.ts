/**
 * Behavioural half of the proxy-log read policy (the textual half is
 * `proxyLogReads.architecture.test.ts`).
 *
 * The case that matters most here is the nullable column: `client_family` is NULL on every
 * row written before the probe existed, and `client_family <> 'candy_probe'` evaluates to
 * NULL — not TRUE — for those rows. A naive exclusion would therefore silently drop all
 * legacy history out of the dashboard, which is worse than counting a probe.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { and, eq, sql } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');

describe('meteredProxyLogCondition', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let queries: typeof import('./proxyLogQueries.js');
  let store: typeof import('./proxyLogStore.js');

  const readCount = async (options: { metered: boolean }): Promise<number> => {
    const query = db
      .select({ total: sql<number>`count(*)` })
      .from(schema.proxyLogs);
    const filtered = options.metered
      ? query.where(queries.meteredProxyLogCondition())
      : query;
    const row = await filtered.get();
    return Number((row as { total?: number } | undefined)?.total ?? 0);
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-proxy-log-queries-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    queries = await import('./proxyLogQueries.js');
    store = await import('./proxyLogStore.js');
  });

  beforeEach(async () => {
    await db.delete(schema.proxyLogs).run();
  });

  afterAll(() => {
    // Windows keeps the SQLite file handle open; a failed temp-dir cleanup must not fail the run.
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  async function seedLog(input: {
    model: string;
    clientFamily: string | null;
    status?: string;
  }): Promise<void> {
    await store.insertProxyLog({
      routeId: null,
      channelId: 1,
      accountId: null,
      modelRequested: input.model,
      modelActual: null,
      status: input.status ?? 'success',
      httpStatus: 200,
      isStream: true,
      latencyMs: 10,
      estimatedCost: 0,
      clientFamily: input.clientFamily,
      errorMessage: null,
      retryCount: 0,
    });
  }

  it('keeps legacy rows whose client_family is NULL', async () => {
    await seedLog({ model: 'legacy', clientFamily: null });
    await seedLog({ model: 'probe', clientFamily: 'candy_probe' });
    await seedLog({ model: 'real', clientFamily: 'codex' });

    expect(await readCount({ metered: false })).toBe(3);
    // Two, not one: a bare `<> 'candy_probe'` would have dropped the NULL row as well.
    expect(await readCount({ metered: true })).toBe(2);

    const meteredModels = await db
      .select({ model: schema.proxyLogs.modelRequested })
      .from(schema.proxyLogs)
      .where(queries.meteredProxyLogCondition())
      .all();
    expect(meteredModels.map((row) => row.model).sort()).toEqual(['legacy', 'real']);
  });

  it('excludes only the probe family, whatever its status', async () => {
    // The probe writes success for pass AND for a degraded verdict, and failed for
    // uncertain — which is exactly why it has to be excluded rather than filtered by status.
    await seedLog({ model: 'p1', clientFamily: 'candy_probe', status: 'success' });
    await seedLog({ model: 'p2', clientFamily: 'candy_probe', status: 'failed' });
    await seedLog({ model: 'real', clientFamily: 'claude_code', status: 'failed' });

    const rows = await db
      .select({ total: sql<number>`count(*)` })
      .from(schema.proxyLogs)
      .where(and(
        eq(schema.proxyLogs.status, 'failed'),
        queries.meteredProxyLogCondition(),
      ))
      .get();
    expect(Number((rows as { total?: number } | undefined)?.total ?? 0)).toBe(1);
  });

  it('composes with an existing where-clause without changing its matches', async () => {
    await seedLog({ model: 'wanted', clientFamily: 'codex' });
    await seedLog({ model: 'wanted-probe', clientFamily: 'candy_probe' });
    await seedLog({ model: 'other', clientFamily: 'codex' });

    const rows = await db
      .select({ model: schema.proxyLogs.modelRequested })
      .from(schema.proxyLogs)
      .where(and(
        eq(schema.proxyLogs.modelRequested, 'wanted'),
        queries.meteredProxyLogCondition(),
      ))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.model).toBe('wanted');
  });

  it('exposes the probe family as the marker the writer uses', () => {
    expect(queries.PROBE_CLIENT_FAMILY).toBe('candy_probe');
  });
});
