/**
 * Turn an lm-detector `Analysis` and the channel's claimed model into a graded verdict.
 *
 * The ranking is a closed-set ordering within the reference bank: a model outside the bank
 * still gets a "closest" candidate. So every claim is narrow, and a stronger claim needs
 * stronger evidence. "Same model" is compared by MODEL LINE (`familyMap.identityModelLineKey`),
 * so a dated snapshot of the claimed model counts as the claimed model.
 *
 * Top candidate in the claimed FAMILY:
 * - not calibrated (only some replies usable)                       → `likely_match`
 * - calibrated, top candidate is the claimed model line             → `model_match`
 * - calibrated, claimed model in the bank, another model of the family on top with confidence
 *   at or above `IDENTITY_MISMATCH_MIN_PROBABILITY`                  → `version_mismatch`
 * - calibrated otherwise (claimed model not in the bank, or the other model's lead is weak)
 *                                                                    → `family_match`
 *
 * Top candidate in ANOTHER family (unchanged from before the grading):
 * - claimed family unknown / not in the bank, not calibrated, or below the floor → `uncertain`
 * - otherwise                                                        → `mismatch`
 */

import type { IdentityAnalysis } from './detector.js';
import { isSameIdentityModelLine, resolveClaimedIdentity, type ClaimedIdentity } from './familyMap.js';
import type {
  IdentityProbeCandidate,
  IdentityProbeDecision,
  IdentityProbeVerdict,
} from '../../../shared/modelIdentityProbe.js';

/**
 * Confidence floor for a `mismatch` or a `version_mismatch` claim.
 *
 * NOT CALIBRATED. 0.6 is a starting point: the plan is to run known-good (official) channels
 * several times, look at the top-candidate confidence on their `model_match` runs, and set
 * the floor below the bulk of that distribution. Inside one family the fingerprints are
 * closer than across families, so `version_mismatch` is the claim most likely to need a
 * higher floor once real data exists.
 */
export const IDENTITY_MISMATCH_MIN_PROBABILITY = 0.6;

/** How many candidates are kept on a result. */
export const IDENTITY_TOP_CANDIDATES = 5;

export type IdentityVerdictResolution = Omit<ClaimedIdentity, 'claimedFamilyInBank'> & {
  verdict: IdentityProbeVerdict;
  decision: IdentityProbeDecision;
  prediction: IdentityProbeCandidate | null;
  candidates: IdentityProbeCandidate[];
  probability: number | null;
  probabilityStatus: 'reference_calibrated' | 'unavailable';
  modelLike: boolean | null;
  usedOutputs: number;
  reason: string | null;
};

function toCandidate(result: IdentityAnalysis['results'][number]): IdentityProbeCandidate {
  return {
    model: result.model,
    displayName: result.display_name || result.model,
    family: result.family,
    familyName: result.family_name || result.family,
    probability: typeof result.probability === 'number' && Number.isFinite(result.probability)
      ? result.probability
      : null,
  };
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function describeClaimed(claimed: ClaimedIdentity): string {
  if (claimed.claimedRank === null) return '';
  const share = claimed.claimedProbability === null ? '' : `（${formatPercent(claimed.claimedProbability)}）`;
  return `声称的型号排第 ${claimed.claimedRank}${share}`;
}

export function resolveIdentityVerdict(
  analysis: IdentityAnalysis,
  claimedModelName: string,
): IdentityVerdictResolution {
  const results = Array.isArray(analysis.results) ? analysis.results : [];
  const claimedFull = resolveClaimedIdentity(claimedModelName, results);
  const { claimedFamilyInBank, ...claimed } = claimedFull;
  const candidates = results.slice(0, IDENTITY_TOP_CANDIDATES).map(toCandidate);
  const prediction = candidates[0] ?? null;
  const probability = typeof analysis.probability === 'number' && Number.isFinite(analysis.probability)
    ? analysis.probability
    : null;
  const calibrated = analysis.decision === 'scored' && probability !== null;
  const base = {
    ...claimed,
    decision: analysis.decision,
    prediction,
    candidates,
    probability,
    probabilityStatus: analysis.probability_status === 'reference_calibrated'
      ? 'reference_calibrated' as const
      : 'unavailable' as const,
    modelLike: analysis.sequence ? analysis.sequence.model_like === true : null,
    usedOutputs: Number.isFinite(analysis.used_outputs) ? analysis.used_outputs : 0,
  };

  if (analysis.decision === 'not_model') {
    return { ...base, verdict: 'not_model', reason: '回答不像语言模型生成（可能是脚本、真随机数或固定回复）' };
  }
  if (analysis.decision === 'unscorable' || !prediction) {
    return { ...base, verdict: 'inconclusive', reason: '有效回答不足，无法评分' };
  }

  // ---- top candidate in the claimed family ----
  if (claimed.claimedFamily && prediction.family === claimed.claimedFamily) {
    if (!calibrated) {
      return {
        ...base,
        verdict: 'likely_match',
        reason: `仅部分回答有效，排名未校准；最像 ${prediction.displayName}，只能说倾向同一家族`,
      };
    }
    if (isSameIdentityModelLine(prediction.model, claimedModelName)) {
      return { ...base, verdict: 'model_match', reason: null };
    }
    if (claimed.claimedRank !== null && probability >= IDENTITY_MISMATCH_MIN_PROBABILITY) {
      return {
        ...base,
        verdict: 'version_mismatch',
        reason: `最像同家族的 ${prediction.displayName}（${formatPercent(probability)}），不是声称的型号；${describeClaimed(claimedFull)}`,
      };
    }
    return {
      ...base,
      verdict: 'family_match',
      reason: claimed.claimedRank === null
        ? `声称的型号不在参考库内，只能确认属于 ${claimed.claimedFamilyName ?? claimed.claimedFamily} 家族；最像 ${prediction.displayName}`
        : `最像同家族的 ${prediction.displayName}（${formatPercent(probability)}），置信度不足以判定换了版本；${describeClaimed(claimedFull)}`,
    };
  }

  // ---- top candidate in another family ----
  if (!claimed.claimedFamily || !claimedFamilyInBank) {
    return { ...base, verdict: 'uncertain', reason: '声称的模型不在参考库内，无法判断是否一致' };
  }
  if (!calibrated) {
    return { ...base, verdict: 'uncertain', reason: `最像 ${prediction.displayName}，但只有部分回答有效，置信度未校准` };
  }
  if (probability < IDENTITY_MISMATCH_MIN_PROBABILITY) {
    return {
      ...base,
      verdict: 'uncertain',
      reason: `最像 ${prediction.displayName}（${formatPercent(probability)}），置信度低于 ${formatPercent(IDENTITY_MISMATCH_MIN_PROBABILITY)}`,
    };
  }
  return {
    ...base,
    verdict: 'mismatch',
    reason: `最像 ${prediction.displayName}（${formatPercent(probability)}），与声称的 ${claimed.claimedFamilyName ?? claimed.claimedFamily} 家族不符`,
  };
}
