/**
 * Shared presentation for model fingerprint verdicts, so the row badge, the toast, the
 * route-sweep summary and the detail panel cannot drift apart in wording or colour.
 *
 * The wording is deliberately modest: the ranking is a closed-set ordering within the
 * lm-detector reference bank, so "一致" never becomes "已验证", and a mismatch is "疑似".
 * The labels themselves live in `src/shared/modelIdentityProbe.js` (the usage-log note on
 * the server reads the same table).
 */

import type { QualityTone } from '../../helpers/qualityBadges.js';
import { IDENTITY_PROBE_VERDICT_LABELS } from '../../../../shared/modelIdentityProbe.js';
import type {
  IdentityProbeCandidate,
  IdentityProbeSnapshot,
  IdentityProbeVerdict,
} from '../types.js';

export { IDENTITY_PROBE_VERDICT_LABELS };

/** One-sentence explanation per verdict, for the detail panel's headline. */
export const IDENTITY_PROBE_VERDICT_EXPLANATIONS: Record<IdentityProbeVerdict, string> = {
  model_match: '已校准排名中最像的候选就是声称的型号（含它的日期快照）。',
  version_mismatch: '最像的候选与声称的型号同属一个家族，但不是同一个型号，且置信度达到阈值：疑似同家族换版本或降配。',
  family_match: '最像的候选与声称的型号同属一个家族，但无法确认具体型号：声称的型号不在参考库内，或另一型号领先得不够多。',
  likely_match: '只有部分回答有效，排名未校准；最像的候选与声称的型号同属一个家族，只能作为倾向参考。',
  mismatch: '参考库中最像的候选属于另一个家族，且置信度达到阈值。',
  uncertain: '已评分，但不足以判断一致或不一致。',
  not_model: '回答的数字序列不像语言模型写的，可能是脚本、真随机数或固定回复。',
  inconclusive: '没有拿到可评分的回答，无法给出结论。',
};

/** The same claim boundary the README of lm-detector states, shown wherever a verdict is. */
export const IDENTITY_PROBE_DISCLAIMER = '结果是参考库内的封闭集合排序，不是身份证明。';

/** Verdicts whose top candidate is in the claimed family (the "一致" side of the scale). */
export function isIdentityProbeFamilyAgreement(verdict: IdentityProbeVerdict): boolean {
  return verdict === 'model_match' || verdict === 'family_match' || verdict === 'likely_match';
}

export function formatIdentityProbeVerdict(verdict: IdentityProbeVerdict): string {
  return IDENTITY_PROBE_VERDICT_LABELS[verdict] ?? verdict;
}

export function buildIdentityProbeBadgeLabel(probe: Pick<IdentityProbeSnapshot, 'verdict'>): string {
  return `🔍 ${formatIdentityProbeVerdict(probe.verdict)}`;
}

/**
 * Colour by how much the verdict says: only a confirmed model is green; a family-level or
 * uncalibrated agreement is amber (it is NOT a confirmation); a swap is red.
 */
export function resolveIdentityProbeTone(verdict: IdentityProbeVerdict): QualityTone {
  if (verdict === 'model_match') return 'primary';
  if (verdict === 'mismatch' || verdict === 'version_mismatch' || verdict === 'not_model') return 'danger';
  return 'warning';
}

/** `82%`, or `未校准` without a calibrated confidence. */
export function formatIdentityProbability(probability: number | null | undefined): string {
  if (typeof probability !== 'number' || !Number.isFinite(probability)) return '未校准';
  return `${Math.round(probability * 100)}%`;
}

/** `Gemini 2.5 Pro（Gemini · 82%）` for one candidate. */
export function formatIdentityCandidate(candidate: IdentityProbeCandidate | null | undefined): string {
  if (!candidate) return '—';
  return `${candidate.displayName}（${candidate.familyName} · ${formatIdentityProbability(candidate.probability)}）`;
}

/** `第 24 名（0%）` / `第 1 名` / `库内无该型号` / `不在参考库内`. */
export function formatIdentityClaimedRank(
  probe: Pick<IdentityProbeSnapshot, 'claimedRank' | 'claimedProbability' | 'claimedFamily'>,
): string {
  if (probe.claimedRank) {
    const share = typeof probe.claimedProbability === 'number' ? `（${formatIdentityProbability(probe.claimedProbability)}）` : '';
    return `第 ${probe.claimedRank} 名${share}`;
  }
  return probe.claimedFamily ? '库内无该型号' : '不在参考库内';
}

/** The toast after a manual run. */
export function buildIdentityProbeToast(
  result: Pick<IdentityProbeSnapshot, 'verdict' | 'reason' | 'prediction' | 'probability'>,
): { kind: 'success' | 'error' | 'info'; message: string } {
  const label = formatIdentityProbeVerdict(result.verdict);
  const top = result.prediction ? `，最像 ${result.prediction.displayName}（${formatIdentityProbability(result.probability)}）` : '';
  if (result.verdict === 'model_match') return { kind: 'success', message: `模型指纹：${label}${top}` };
  if (result.verdict === 'mismatch' || result.verdict === 'version_mismatch' || result.verdict === 'not_model') {
    return { kind: 'error', message: `模型指纹：${label}${result.reason ? `｜${result.reason}` : top}` };
  }
  return { kind: 'info', message: `模型指纹：${label}${result.reason ? `｜${result.reason}` : top}` };
}

export function buildIdentityProbeTooltip(probe: IdentityProbeSnapshot, canOpenDetail: boolean): string {
  return [
    `声称 ${probe.model}`,
    probe.prediction ? `最像 ${formatIdentityCandidate(probe.prediction)}` : null,
    probe.claimedRank ? `声称型号${formatIdentityClaimedRank(probe)}` : null,
    `检测于 ${new Date(probe.checkedAt).toLocaleString()}`,
    `有效至 ${new Date(probe.expiresAt).toLocaleString()}`,
    probe.fresh ? null : '已过期',
    probe.reason,
    IDENTITY_PROBE_DISCLAIMER,
    canOpenDetail ? '点击查看候选与样本明细' : null,
  ].filter(Boolean).join(' · ');
}

/** Per-verdict counts of one route sweep, plus channels the probe could not run on. */
export type IdentityProbeBatchTally = Record<IdentityProbeVerdict, number> & {
  /** The request itself was refused (no credential, non-conversation model…). */
  rejected: number;
};

export function createIdentityProbeBatchTally(): IdentityProbeBatchTally {
  return {
    model_match: 0,
    version_mismatch: 0,
    family_match: 0,
    likely_match: 0,
    mismatch: 0,
    uncertain: 0,
    not_model: 0,
    inconclusive: 0,
    rejected: 0,
  };
}

/** Summary order: the findings that need attention first. */
const BATCH_SUMMARY_ORDER: IdentityProbeVerdict[] = [
  'mismatch',
  'version_mismatch',
  'not_model',
  'model_match',
  'family_match',
  'likely_match',
  'uncertain',
  'inconclusive',
];

/** The route-sweep summary, one clause per non-empty tier, in the badges' own vocabulary. */
export function buildIdentityProbeBatchSummary(tally: IdentityProbeBatchTally, skipped: number): string {
  const parts = BATCH_SUMMARY_ORDER
    .filter((verdict) => tally[verdict] > 0)
    .map((verdict) => `${formatIdentityProbeVerdict(verdict)} ${tally[verdict]}`);
  if (tally.rejected > 0) parts.push(`无法检测 ${tally.rejected}`);
  if (skipped > 0) parts.push(`跳过 ${skipped}`);
  return parts.length > 0 ? parts.join(' · ') : '没有结果';
}

/** Toast kind for a finished sweep: red when anything looks swapped. */
export function resolveIdentityProbeBatchToastKind(tally: IdentityProbeBatchTally): 'success' | 'error' | 'info' {
  if (tally.mismatch > 0 || tally.version_mismatch > 0 || tally.not_model > 0) return 'error';
  const total = BATCH_SUMMARY_ORDER.reduce((sum, verdict) => sum + tally[verdict], 0) + tally.rejected;
  return total > 0 && tally.model_match === total ? 'success' : 'info';
}
