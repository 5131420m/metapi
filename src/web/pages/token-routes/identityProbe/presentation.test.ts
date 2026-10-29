import { describe, expect, it } from 'vitest';
import {
  buildIdentityProbeBadgeLabel,
  buildIdentityProbeBatchSummary,
  buildIdentityProbeToast,
  createIdentityProbeBatchTally,
  formatIdentityCandidate,
  formatIdentityClaimedRank,
  formatIdentityProbability,
  IDENTITY_PROBE_VERDICT_EXPLANATIONS,
  IDENTITY_PROBE_VERDICT_LABELS,
  resolveIdentityProbeBatchToastKind,
  resolveIdentityProbeTone,
} from './presentation.js';

const candidate = {
  model: 'gemini-2.5-pro',
  displayName: 'gemini-2.5-pro',
  family: 'gemini',
  familyName: 'Gemini',
  probability: 0.824,
};

describe('identity probe presentation', () => {
  it('labels every verdict, with an explanation for each', () => {
    expect(buildIdentityProbeBadgeLabel({ verdict: 'model_match' })).toBe('🔍 型号一致');
    expect(buildIdentityProbeBadgeLabel({ verdict: 'version_mismatch' })).toBe('🔍 疑似换版本');
    expect(buildIdentityProbeBadgeLabel({ verdict: 'family_match' })).toBe('🔍 家族一致');
    expect(buildIdentityProbeBadgeLabel({ verdict: 'likely_match' })).toBe('🔍 倾向一致');
    expect(buildIdentityProbeBadgeLabel({ verdict: 'mismatch' })).toBe('🔍 疑似换皮');
    expect(Object.keys(IDENTITY_PROBE_VERDICT_EXPLANATIONS).sort()).toEqual(Object.keys(IDENTITY_PROBE_VERDICT_LABELS).sort());
  });

  it('only paints a confirmed model green', () => {
    expect(resolveIdentityProbeTone('model_match')).toBe('primary');
    expect(resolveIdentityProbeTone('family_match')).toBe('warning');
    expect(resolveIdentityProbeTone('likely_match')).toBe('warning');
    expect(resolveIdentityProbeTone('version_mismatch')).toBe('danger');
    expect(resolveIdentityProbeTone('mismatch')).toBe('danger');
    expect(resolveIdentityProbeTone('not_model')).toBe('danger');
    expect(resolveIdentityProbeTone('uncertain')).toBe('warning');
    expect(resolveIdentityProbeTone('inconclusive')).toBe('warning');
  });

  it('formats confidence and the claimed rank', () => {
    expect(formatIdentityProbability(0.824)).toBe('82%');
    expect(formatIdentityProbability(null)).toBe('未校准');
    expect(formatIdentityCandidate(candidate)).toBe('gemini-2.5-pro（Gemini · 82%）');
    expect(formatIdentityCandidate(null)).toBe('—');
    expect(formatIdentityClaimedRank({ claimedRank: 24, claimedProbability: 0, claimedFamily: 'deepseek' })).toBe('第 24 名（0%）');
    expect(formatIdentityClaimedRank({ claimedRank: 1, claimedProbability: null, claimedFamily: 'gpt' })).toBe('第 1 名');
    expect(formatIdentityClaimedRank({ claimedRank: null, claimedProbability: null, claimedFamily: 'gpt' })).toBe('库内无该型号');
    expect(formatIdentityClaimedRank({ claimedRank: null, claimedProbability: null, claimedFamily: null })).toBe('不在参考库内');
  });

  it('chooses the toast kind by verdict', () => {
    expect(buildIdentityProbeToast({ verdict: 'model_match', reason: null, prediction: candidate, probability: 0.8 }).kind).toBe('success');
    expect(buildIdentityProbeToast({ verdict: 'family_match', reason: '型号无法确认', prediction: candidate, probability: 0.8 }).kind).toBe('info');
    const version = buildIdentityProbeToast({ verdict: 'version_mismatch', reason: '最像同家族的 x', prediction: candidate, probability: 0.9 });
    expect(version).toEqual({ kind: 'error', message: '模型指纹：疑似换版本｜最像同家族的 x' });
    const mismatch = buildIdentityProbeToast({ verdict: 'mismatch', reason: null, prediction: candidate, probability: 0.8 });
    expect(mismatch.kind).toBe('error');
    expect(mismatch.message).toContain('gemini-2.5-pro');
    expect(buildIdentityProbeToast({ verdict: 'inconclusive', reason: '参考库不可用', prediction: null, probability: null }))
      .toEqual({ kind: 'info', message: '模型指纹：未完成｜参考库不可用' });
  });

  it('summarises a route sweep, problems first', () => {
    const tally = createIdentityProbeBatchTally();
    tally.model_match = 2;
    tally.version_mismatch = 1;
    tally.likely_match = 1;
    tally.rejected = 1;
    expect(buildIdentityProbeBatchSummary(tally, 2)).toBe('疑似换版本 1 · 型号一致 2 · 倾向一致 1 · 无法检测 1 · 跳过 2');
    expect(resolveIdentityProbeBatchToastKind(tally)).toBe('error');
  });

  it('is green only when every channel is a confirmed model', () => {
    const all = createIdentityProbeBatchTally();
    all.model_match = 3;
    expect(resolveIdentityProbeBatchToastKind(all)).toBe('success');
    all.family_match = 1;
    expect(resolveIdentityProbeBatchToastKind(all)).toBe('info');
    expect(buildIdentityProbeBatchSummary(createIdentityProbeBatchTally(), 0)).toBe('没有结果');
  });
});
