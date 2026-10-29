import { describe, expect, it } from 'vitest';
import { buildProbeCombinedSummary } from './probeSummary.js';
import type { IdentityProbeVerdict } from './types.js';

const candy = (verdict: 'pass' | 'fail' | 'inconclusive', expectation: 'expected' | 'reference-only' | 'unknown' = 'expected', fresh = true) => ({
  verdict,
  expectation,
  fresh,
});
const identity = (verdict: IdentityProbeVerdict, fresh = true) => ({ verdict, fresh });

describe('buildProbeCombinedSummary', () => {
  it('says nothing unless both sides are present and fresh', () => {
    expect(buildProbeCombinedSummary(null, identity('model_match'))).toBeNull();
    expect(buildProbeCombinedSummary(candy('pass'), null)).toBeNull();
    expect(buildProbeCombinedSummary(candy('pass', 'expected', false), identity('model_match'))).toBeNull();
    expect(buildProbeCombinedSummary(candy('pass'), identity('model_match', false))).toBeNull();
  });

  it('reads the model-level cells', () => {
    expect(buildProbeCombinedSummary(candy('pass'), identity('model_match'))?.tone).toBe('primary');
    expect(buildProbeCombinedSummary(candy('fail'), identity('model_match'))?.text).toContain('同型号降配');
  });

  it('reads a version swap', () => {
    // The 199 hub #27 pairing: candy answered wrong, fingerprint points at another version.
    const both = buildProbeCombinedSummary(candy('fail'), identity('version_mismatch'));
    expect(both?.tone).toBe('danger');
    expect(both?.text).toContain('更弱型号');
    expect(buildProbeCombinedSummary(candy('pass'), identity('version_mismatch'))?.tone).toBe('warning');
  });

  it('never calls a family-level agreement "正常"', () => {
    expect(buildProbeCombinedSummary(candy('pass'), identity('family_match'))).toBeNull();
    expect(buildProbeCombinedSummary(candy('pass'), identity('likely_match'))).toBeNull();
    expect(buildProbeCombinedSummary(candy('fail'), identity('family_match'))?.text).toContain('型号无法确认');
  });

  it('reads the cross-family cells', () => {
    expect(buildProbeCombinedSummary(candy('pass'), identity('mismatch'))?.text).toContain('挂名');
    expect(buildProbeCombinedSummary(candy('fail'), identity('mismatch'))?.text).toContain('更弱');
  });

  it('flags non-model output whatever the candy verdict', () => {
    for (const verdict of ['pass', 'fail', 'inconclusive'] as const) {
      expect(buildProbeCombinedSummary(candy(verdict), identity('not_model'))?.tone).toBe('danger');
    }
  });

  it('does not call a small model wrong answer degradation', () => {
    expect(buildProbeCombinedSummary(candy('fail', 'reference-only'), identity('model_match'))).toBeNull();
    expect(buildProbeCombinedSummary(candy('fail', 'reference-only'), identity('version_mismatch'))).toBeNull();
    expect(buildProbeCombinedSummary(candy('fail', 'unknown'), identity('mismatch'))?.tone).toBe('warning');
  });

  it('adds nothing when the fingerprint is uncertain or inconclusive', () => {
    expect(buildProbeCombinedSummary(candy('fail'), identity('uncertain'))).toBeNull();
    expect(buildProbeCombinedSummary(candy('pass'), identity('inconclusive'))).toBeNull();
  });
});
