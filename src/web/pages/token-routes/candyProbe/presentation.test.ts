import { describe, expect, it } from 'vitest';
import {
  buildCandyProbeBadgeLabel,
  buildCandyProbeBatchSummary,
  buildCandyProbeVerdictLabel,
  formatCandyProbeCheckedAt,
  formatCandyProbeFingerprint,
  resolveCandyProbeTone,
} from './presentation.js';

describe('candy probe presentation', () => {
  it('labels each verdict, one question and one answer with no tally', () => {
    expect(buildCandyProbeBadgeLabel({
      verdict: 'pass', expectation: 'expected',
    })).toBe('🍬 通过');
    expect(buildCandyProbeBadgeLabel({
      verdict: 'inconclusive', expectation: 'expected',
    })).toBe('🍬 未完成');
  });

  it('only claims degradation for a model that was expected to pass', () => {
    // The reported wording problem: "疑似降智" was printed for EVERY wrong answer, including a
    // small model that is expected to fail a question needing case analysis.
    expect(buildCandyProbeBadgeLabel({
      verdict: 'fail', expectation: 'expected',
    })).toBe('🍬 疑似降智');
    expect(buildCandyProbeBadgeLabel({
      verdict: 'fail', expectation: 'reference-only',
    })).toBe('🍬 答错');
    expect(buildCandyProbeBadgeLabel({
      verdict: 'fail', expectation: 'unknown',
    })).toBe('🍬 答错');
  });

  it('keeps a non-degradation failure out of the danger tone', () => {
    expect(resolveCandyProbeTone('fail', 'expected')).toBe('danger');
    expect(resolveCandyProbeTone('fail', 'reference-only')).toBe('warning');
    expect(resolveCandyProbeTone('fail', 'unknown')).toBe('warning');
  });

  it('maps verdicts onto the shared tone vocabulary', () => {
    expect(resolveCandyProbeTone('pass')).toBe('primary');
    // Without a stated baseline, a failure is not painted as danger.
    expect(resolveCandyProbeTone('fail')).toBe('warning');
    expect(resolveCandyProbeTone('inconclusive')).toBe('warning');
  });

  it('translates verdicts for the detail panel', () => {
    expect(buildCandyProbeVerdictLabel('pass')).toBe('通过');
    expect(buildCandyProbeVerdictLabel('fail', 'expected')).toBe('疑似降智');
    expect(buildCandyProbeVerdictLabel('fail', 'reference-only')).toBe('答错');
    expect(buildCandyProbeVerdictLabel('inconclusive')).toBe('未完成');
  });

  it('translates known fingerprints and passes unknown ones through', () => {
    expect(formatCandyProbeFingerprint('claude_code')).toBe('Claude Code');
    expect(formatCandyProbeFingerprint('codex')).toBe('Codex CLI');
    expect(formatCandyProbeFingerprint('codex_chat')).toBe('Codex CLI (Chat)');
    expect(formatCandyProbeFingerprint('generic_openai')).toBe('OpenAI SDK');
    expect(formatCandyProbeFingerprint('custom_profile')).toBe('custom_profile');
    // A missing id (older stored verdict) must not render "undefined".
    expect(formatCandyProbeFingerprint(null)).toBe('未知');
    expect(formatCandyProbeFingerprint(undefined)).toBe('未知');
  });

  it('formats a parseable timestamp and survives a bad one', () => {
    const iso = '2026-10-17T12:00:00.000Z';
    expect(formatCandyProbeCheckedAt(iso)).toBe(new Date(iso).toLocaleString());
    expect(formatCandyProbeCheckedAt('not-a-date')).toBe('not-a-date');
  });

  it('splits the route-sweep summary by the badge\'s own fail tier', () => {
    // Only an `expected` model's wrong answer is 疑似降智; everything else is 答错 —
    // the toast and the rows next to it must agree.
    expect(buildCandyProbeBatchSummary(
      { pass: 3, degraded: 1, wrong: 2, inconclusive: 1, rejected: 0 }, 0,
    )).toBe('通过 3 · 疑似降智 1 · 答错 2 · 未完成 1');
    // Empty tiers are omitted rather than shown as zero.
    expect(buildCandyProbeBatchSummary(
      { pass: 2, degraded: 0, wrong: 0, inconclusive: 1, rejected: 1 }, 2,
    )).toBe('通过 2 · 未完成 1 · 无法探测 1 · 跳过 2');
  });
});
