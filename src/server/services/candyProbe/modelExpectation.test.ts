import { describe, expect, it } from 'vitest';
import { isCandyProbeDegradationClaim, resolveCandyProbeExpectation } from './modelExpectation.js';

/**
 * `expected` is the strongest claim the probe can make, so the bar for joining it is high:
 * reasoning by construction only. The probe's request bodies do NOT enable thinking, and a
 * non-reasoning flagship asked for case analysis can miss honestly — grading that as
 * "疑似降智" is the false alarm this table exists to prevent.
 *
 * Promotion rule (see modelExpectation.ts): a model joins `expected` only after a measured
 * pass rate ≥ 90% on a trusted channel. NO model has been calibrated yet, so this suite
 * pins the reasoning-only baseline; when a calibration lands, record the measured rate
 * here and move the model up in the same change.
 */
describe('candy probe model expectation', () => {
  it('expects only models that reason by construction', () => {
    for (const model of [
      'gpt-5.6-sol', // gpt-5 on the responses path: reasoning on
      'gpt-5',
      'o3',
      'o1',
      'deepseek-reasoner',
      'deepseek-r1',
      'claude-opus-4-1-thinking',
      'gemini-2.5-pro-thinking',
    ]) {
      expect(resolveCandyProbeExpectation(model), model).toBe('expected');
    }
  });

  it('keeps non-reasoning flagships unknown until calibrated', () => {
    // These reason optionally at best; the probe sends no thinking, so a miss is not
    // evidence of a swapped backend.
    for (const model of [
      'claude-opus-5',
      'claude-sonnet-4-5',
      'claude-3-5-sonnet',
      'gpt-4o',
      'gpt-4.1',
      'gpt-5-chat-latest', // the non-reasoning gpt-5 variant, on purpose
      'gpt-5.1-chat-latest', // dotted versions of the chat variant stay out too
      'gpt-5.2-chat',
      'deepseek-chat',
      'deepseek-v4.1',
      'kimi-k2',
      'gemini-2.5-pro',
      'qwen-max',
      'glm-4.5-air',
      'grok-4',
    ]) {
      expect(resolveCandyProbeExpectation(model), model).toBe('unknown');
    }
  });

  it('treats small and fast families as reference-only', () => {
    for (const model of [
      'claude-3-5-haiku',
      'gpt-4o-mini',
      'gpt-5-mini',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'qwen-turbo',
      'llama-3-8b',
      'mistral-small',
      'glm-4-flash',
    ]) {
      expect(resolveCandyProbeExpectation(model), model).toBe('reference-only');
    }
  });

  it('refuses to guess for an unknown model', () => {
    // The whole point: a name we do not know must not inherit "should have passed".
    for (const model of ['', null, undefined, 'some-relay-model', 'internal-v2']) {
      expect(resolveCandyProbeExpectation(model as string)).toBe('unknown');
    }
  });

  it('only calls a failure degradation when the model was expected to pass', () => {
    expect(isCandyProbeDegradationClaim('fail', 'expected')).toBe(true);
    expect(isCandyProbeDegradationClaim('fail', 'reference-only')).toBe(false);
    expect(isCandyProbeDegradationClaim('fail', 'unknown')).toBe(false);
    expect(isCandyProbeDegradationClaim('pass', 'expected')).toBe(false);
    expect(isCandyProbeDegradationClaim('inconclusive', 'expected')).toBe(false);
  });
});
