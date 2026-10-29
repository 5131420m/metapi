import { describe, expect, it } from 'vitest';
import type { IdentityAnalysis } from './detector.js';
import { IDENTITY_MISMATCH_MIN_PROBABILITY, resolveIdentityVerdict } from './verdict.js';

function candidate(model: string, family: string, probability: number | null = null) {
  return {
    model,
    display_name: model,
    family,
    family_name: family.toUpperCase(),
    score: 1,
    probability,
  };
}

function analysis(overrides: Partial<IdentityAnalysis> = {}): IdentityAnalysis {
  const results = overrides.results ?? [
    candidate('gemini-2.5-pro', 'gemini', 0.82),
    candidate('claude-opus-4.6', 'claude', 0.1),
    candidate('gpt-5.4', 'gpt', 0.05),
  ];
  return {
    decision: 'scored',
    prediction: results[0]?.model ?? '',
    prediction_name: results[0]?.display_name ?? '',
    family_prediction: results[0]?.family ?? '',
    family_prediction_name: results[0]?.family_name ?? '',
    results,
    ranking_score: 1,
    probability: results[0]?.probability ?? null,
    probability_status: 'reference_calibrated',
    probability_scope: 'reference-bank',
    calibration: null,
    used_outputs: 3,
    diagnostics: [],
    sequence: { autocorrelation: 0.1, small_step_share: 0.1, model_like: true },
    method: 'test',
    model_version: { base_sha256: 'x' },
    evidence: { insufficient: false, label: '', reason: '', threshold: null, method: 'test' },
    ...overrides,
  };
}

/** A partial (uncalibrated) ranking: no probabilities anywhere. */
function partial(results: ReturnType<typeof candidate>[]): IdentityAnalysis {
  return analysis({
    decision: 'partial',
    results: results.map((item) => ({ ...item, probability: null })),
    probability: null,
    probability_status: 'unavailable',
    used_outputs: 2,
  });
}

/**
 * The four hub.linux.do runs recorded on the 199 test box (2026-10-25), top candidates as
 * the detector ranked them. They are why the grading exists: under the old family-only rule
 * all four read "身份一致".
 */
describe('resolveIdentityVerdict — the 199 hub runs', () => {
  it('#26 glm-5.3-flash: the claimed model on top → model_match', () => {
    const resolved = resolveIdentityVerdict(analysis({
      results: [
        candidate('glm-5.3-flash', 'glm', 0.7693),
        candidate('glm-5.3-flashx', 'glm', 0.2303),
        candidate('mimo-v2.5-pro', 'mimo', 0.0002),
      ],
      probability: 0.7693,
    }), 'glm-5.3-flash');
    expect(resolved.verdict).toBe('model_match');
    expect(resolved.claimedRank).toBe(1);
    expect(resolved.claimedProbability).toBeCloseTo(0.7693, 4);
  });

  it('#24 deepseek-v4.1-flash: a dated snapshot of the claim on top → model_match', () => {
    const resolved = resolveIdentityVerdict(analysis({
      results: [
        candidate('deepseek-v4.1-flash-1017', 'deepseek', 0.8886),
        candidate('deepseek-v4.1-flash', 'deepseek', 0.0854),
        candidate('qwen3.8-omni-flash', 'qwen', 0.0203),
      ],
      probability: 0.8886,
    }), 'deepseek-v4.1-flash');
    expect(resolved.verdict).toBe('model_match');
    expect(resolved.claimedRank).toBe(1);
    // The line's probability is the sum over its snapshots.
    expect(resolved.claimedProbability).toBeCloseTo(0.974, 3);
  });

  it('#27 deepseek-v4-flash: another model of the family on top → version_mismatch', () => {
    const results = [
      candidate('deepseek-v4.1-flash-1017', 'deepseek', 0.9997),
      candidate('qwen3.8-omni-flash', 'qwen', 0.0001),
      candidate('deepseek-v4.1-flash', 'deepseek', 0.0001),
      ...Array.from({ length: 20 }, (_, index) => candidate(`filler-${index}`, 'gpt', 0)),
      candidate('deepseek-v4-flash', 'deepseek', 0),
    ];
    const resolved = resolveIdentityVerdict(analysis({ results, probability: 0.9997 }), 'deepseek-v4-flash');
    expect(resolved.verdict).toBe('version_mismatch');
    expect(resolved.claimedRank).toBe(24);
    expect(resolved.reason).toContain('deepseek-v4.1-flash-1017');
    expect(resolved.reason).toContain('第 24');
  });

  it('#25 gpt-5.6-luna: a partial ranking in the claimed family → likely_match', () => {
    const resolved = resolveIdentityVerdict(partial([
      candidate('gpt-5.6-luna', 'gpt'),
      candidate('gpt-5.6-sol', 'gpt'),
      candidate('gpt-5.6-terra', 'gpt'),
    ]), 'gpt-5.6-luna');
    expect(resolved.verdict).toBe('likely_match');
    expect(resolved.claimedProbability).toBeNull();
    expect(resolved.reason).toContain('未校准');
  });
});

describe('resolveIdentityVerdict — same family', () => {
  it('family_match when the claimed model is not in the bank', () => {
    const resolved = resolveIdentityVerdict(analysis({
      results: [candidate('claude-opus-4.6', 'claude', 0.9), candidate('gpt-5.4', 'gpt', 0.05)],
      probability: 0.9,
    }), 'claude-opus-9-preview');
    expect(resolved.verdict).toBe('family_match');
    expect(resolved.claimedRank).toBeNull();
    expect(resolved.reason).toContain('不在参考库内');
  });

  it('family_match when another model leads, but below the floor', () => {
    const below = IDENTITY_MISMATCH_MIN_PROBABILITY - 0.01;
    const resolved = resolveIdentityVerdict(analysis({
      results: [candidate('claude-sonnet-5', 'claude', below), candidate('claude-opus-4.6', 'claude', 0.3)],
      probability: below,
    }), 'claude-opus-4-6');
    expect(resolved.verdict).toBe('family_match');
    expect(resolved.claimedRank).toBe(2);
  });

  it('version_mismatch exactly at the floor', () => {
    const resolved = resolveIdentityVerdict(analysis({
      results: [
        candidate('claude-sonnet-5', 'claude', IDENTITY_MISMATCH_MIN_PROBABILITY),
        candidate('claude-opus-4.6', 'claude', 0.3),
      ],
      probability: IDENTITY_MISMATCH_MIN_PROBABILITY,
    }), 'claude-opus-4-6');
    expect(resolved.verdict).toBe('version_mismatch');
  });

  it('model_match at any confidence when the claimed line is on top', () => {
    const resolved = resolveIdentityVerdict(analysis({
      results: [candidate('claude-opus-4.6', 'claude', 0.2), candidate('gpt-5.4', 'gpt', 0.19)],
      probability: 0.2,
    }), 'anthropic/claude-opus-4-6-20260101');
    expect(resolved.verdict).toBe('model_match');
  });

  it('likely_match on a partial ranking even when the claimed model is on top', () => {
    expect(resolveIdentityVerdict(partial([
      candidate('claude-opus-4.6', 'claude'),
      candidate('gpt-5.4', 'gpt'),
    ]), 'claude-opus-4-6').verdict).toBe('likely_match');
  });
});

describe('resolveIdentityVerdict — another family', () => {
  it('mismatch: calibrated confidence above the floor', () => {
    const resolved = resolveIdentityVerdict(analysis(), 'claude-opus-4-6');
    expect(resolved.verdict).toBe('mismatch');
    expect(resolved.prediction?.model).toBe('gemini-2.5-pro');
    expect(resolved.claimedRank).toBe(2);
    expect(resolved.reason).toContain('gemini-2.5-pro');
  });

  it('uncertain below the confidence floor', () => {
    const below = IDENTITY_MISMATCH_MIN_PROBABILITY - 0.01;
    const results = [candidate('gemini-2.5-pro', 'gemini', below), candidate('claude-opus-4.6', 'claude', 0.3)];
    expect(resolveIdentityVerdict(analysis({ results, probability: below }), 'claude-opus-4-6').verdict).toBe('uncertain');
  });

  it('uncertain on a partial ranking, however confident it looks', () => {
    expect(resolveIdentityVerdict(partial([
      candidate('gemini-2.5-pro', 'gemini'),
      candidate('claude-opus-4.6', 'claude'),
    ]), 'claude-opus-4-6').verdict).toBe('uncertain');
  });

  it('uncertain when the claimed model is outside the bank', () => {
    expect(resolveIdentityVerdict(analysis(), 'llama-3.1-70b').verdict).toBe('uncertain');
  });

  it('uncertain when the claimed family is recognised but has no model in the bank', () => {
    const results = [candidate('gemini-2.5-pro', 'gemini', 0.9), candidate('gpt-5.4', 'gpt', 0.05)];
    expect(resolveIdentityVerdict(analysis({ results, probability: 0.9 }), 'grok-4.5').verdict).toBe('uncertain');
  });
});

describe('resolveIdentityVerdict — no ranking', () => {
  it('not_model whenever the detector says so', () => {
    expect(resolveIdentityVerdict(
      analysis({ decision: 'not_model', results: [], probability: null }),
      'claude-opus-4-6',
    ).verdict).toBe('not_model');
  });

  it('inconclusive when nothing could be scored', () => {
    expect(resolveIdentityVerdict(
      analysis({ decision: 'unscorable', results: [], probability: null }),
      'claude-opus-4-6',
    ).verdict).toBe('inconclusive');
  });

  it('keeps at most five candidates but ranks the claim over the full list', () => {
    const results = [
      ...Array.from({ length: 8 }, (_, index) => candidate(`gpt-${index}`, 'gpt', 0.1)),
      candidate('gpt-5.4', 'gpt', 0.01),
    ];
    const resolved = resolveIdentityVerdict(analysis({ results, probability: 0.1 }), 'gpt-5.4');
    expect(resolved.candidates).toHaveLength(5);
    expect(resolved.claimedRank).toBe(9);
  });
});
