import { describe, expect, it } from 'vitest';
import {
  buildCandyProbeBadgeLabel,
  buildCandyProbeVerdictLabel,
  formatCandyProbeCheckedAt,
  formatCandyProbeFingerprint,
  resolveCandyProbeTone,
} from './presentation.js';

describe('candy probe presentation', () => {
  it('labels each verdict with its score', () => {
    expect(buildCandyProbeBadgeLabel({ verdict: 'pass', score: 3, total: 3 })).toBe('🍬 通过 3/3');
    expect(buildCandyProbeBadgeLabel({ verdict: 'fail', score: 1, total: 3 })).toBe('🍬 疑似降智 1/3');
    expect(buildCandyProbeBadgeLabel({ verdict: 'inconclusive', score: 0, total: 3 })).toBe('🍬 不确定');
  });

  it('maps verdicts onto the shared tone vocabulary', () => {
    expect(resolveCandyProbeTone('pass')).toBe('primary');
    expect(resolveCandyProbeTone('fail')).toBe('danger');
    expect(resolveCandyProbeTone('inconclusive')).toBe('warning');
  });

  it('translates verdicts for the detail panel', () => {
    expect(buildCandyProbeVerdictLabel('pass')).toBe('通过');
    expect(buildCandyProbeVerdictLabel('fail')).toBe('疑似降智');
    expect(buildCandyProbeVerdictLabel('inconclusive')).toBe('不确定');
  });

  it('translates known fingerprints and passes unknown ones through', () => {
    expect(formatCandyProbeFingerprint('claude_code')).toBe('Claude Code');
    expect(formatCandyProbeFingerprint('codex')).toBe('Codex CLI');
    expect(formatCandyProbeFingerprint('generic_openai')).toBe('Codex CLI（OpenAI 兼容）');
    expect(formatCandyProbeFingerprint('custom_profile')).toBe('custom_profile');
  });

  it('formats a parseable timestamp and survives a bad one', () => {
    const iso = '2026-10-17T12:00:00.000Z';
    expect(formatCandyProbeCheckedAt(iso)).toBe(new Date(iso).toLocaleString());
    expect(formatCandyProbeCheckedAt('not-a-date')).toBe('not-a-date');
  });
});
