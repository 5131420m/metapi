/**
 * The combined reading of the two channel probes, in ONE place.
 *
 * The candy probe says whether this call can reason; the fingerprint probe estimates who
 * answers. Neither is merged into a score: each keeps its own badge, and this function only
 * adds a sentence when the pair says something neither says alone. Both detail panels call
 * it, so they cannot disagree.
 *
 * Returns null (no sentence) when either side is missing or stale, or when the pair carries
 * no joint meaning — the badges speak for themselves then.
 */

import type { CandyProbeSnapshot, IdentityProbeSnapshot } from './types.js';

export type ProbeCombinedSummary = {
  tone: 'primary' | 'warning' | 'danger';
  text: string;
};

type CandySide = Pick<CandyProbeSnapshot, 'verdict' | 'expectation' | 'fresh'>;
type IdentitySide = Pick<IdentityProbeSnapshot, 'verdict' | 'fresh'>;

export function buildProbeCombinedSummary(
  candy: CandySide | null | undefined,
  identity: IdentitySide | null | undefined,
): ProbeCombinedSummary | null {
  if (!candy || !identity || !candy.fresh || !identity.fresh) return null;

  if (identity.verdict === 'not_model') {
    return { tone: 'danger', text: '指纹检测的回答疑似不是模型生成，两项结果都不可信，建议排查该渠道。' };
  }

  const candyFailedExpected = candy.verdict === 'fail' && candy.expectation === 'expected';
  const candyFailedOther = candy.verdict === 'fail' && candy.expectation !== 'expected';

  if (identity.verdict === 'model_match') {
    if (candy.verdict === 'pass') return { tone: 'primary', text: '能力与型号均正常。' };
    if (candyFailedExpected) {
      return { tone: 'warning', text: '型号一致但答错：疑似同型号降配，排查量化版本、推理参数或系统提示注入。' };
    }
    return null;
  }

  if (identity.verdict === 'version_mismatch') {
    if (candyFailedExpected) {
      return { tone: 'danger', text: '疑似换版本且答错：很可能换成了同家族的更弱型号。' };
    }
    if (candy.verdict === 'pass') {
      return { tone: 'warning', text: '疑似换版本，但能力正常：可能换成了同家族能力相近的型号，建议复测确认。' };
    }
    return null;
  }

  if (identity.verdict === 'family_match' || identity.verdict === 'likely_match') {
    // Only a family-level agreement: the candy failure is the stronger signal here.
    if (candyFailedExpected) {
      return { tone: 'warning', text: '家族一致但答错：型号无法确认，疑似同家族降配。' };
    }
    return null;
  }

  if (identity.verdict === 'mismatch') {
    if (candy.verdict === 'pass') {
      return { tone: 'danger', text: '能力正常但身份不符：疑似挂名其他模型（换成了能力相近的别家模型）。' };
    }
    if (candyFailedExpected) return { tone: 'danger', text: '身份不符且答错：疑似换成了更弱的其他模型。' };
    if (candyFailedOther || candy.verdict === 'inconclusive') {
      return { tone: 'warning', text: '身份不符；糖果题对该模型没有判定基线，以指纹结果为参考。' };
    }
  }

  return null;
}
