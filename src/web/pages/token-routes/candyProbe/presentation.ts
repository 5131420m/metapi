/**
 * Shared presentation for candy-probe verdicts, so the row badge and the detail panel
 * cannot drift apart in wording or colour.
 */

import type { QualityTone } from '../../helpers/qualityBadges.js';
import type { CandyProbeSnapshot, CandyProbeTrigger, CandyProbeVerdict } from '../types.js';

export const CANDY_PROBE_FINGERPRINT_LABELS: Record<string, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex CLI',
  // The extension variant: a Codex-CLI identity on /v1/chat/completions, without the
  // session/turn metadata — the shape aggregator traffic wears on non-GPT models.
  codex_chat: 'Codex CLI (Chat)',
  // Models that are neither Claude nor GPT wear a neutral SDK identity: that is what the
  // chat endpoint they are sent to can actually come from. Selectable manually; the auto
  // rule now prefers the Codex chat variant for those families.
  generic_openai: 'OpenAI SDK',
};

/**
 * Human label for a fingerprint id.
 *
 * Accepts a missing id (an older stored verdict, or a probe that never got as far as picking
 * one) so callers can format a toast without a null check of their own.
 */
export function formatCandyProbeFingerprint(fingerprint: string | null | undefined): string {
  if (!fingerprint) return '未知';
  return CANDY_PROBE_FINGERPRINT_LABELS[fingerprint] ?? fingerprint;
}

export function formatCandyProbeCheckedAt(checkedAt: string): string {
  const timestamp = Date.parse(checkedAt);
  if (!Number.isFinite(timestamp)) return checkedAt;
  return new Date(timestamp).toLocaleString();
}

/**
 * Human label for what started a run.
 *
 * Missing means older than the schedule feature, and every run back then was a click:
 * the honest label for absence is "手动", not a third state the UI has to explain.
 */
export function formatCandyProbeTrigger(trigger: CandyProbeTrigger | null | undefined): string {
  return trigger === 'schedule' ? '巡检' : '手动';
}

/**
 * The badge tone.
 *
 * A failure by a model that was NOT expected to pass this question is not a danger signal: it
 * is a recorded observation, and colouring it red is how a badge teaches operators to ignore it.
 */
export function resolveCandyProbeTone(verdict: CandyProbeVerdict, expectation?: string): QualityTone {
  if (verdict === 'pass') return 'primary';
  if (verdict === 'fail') return expectation === 'expected' ? 'danger' : 'warning';
  return 'warning';
}

/**
 * The verdict headline shown by the badge and the row.
 *
 * "疑似降智" is a comparison and only appears when the model was expected to answer (see the
 * server's `modelExpectation.ts`); any other model's wrong answer is written as what it is.
 * "未完成" is not a softer 答错 — it means the run could not be scored at all (upstream
 * error, timeout, truncation, no committed answer).
 */
export function buildCandyProbeVerdictLabel(
  verdict: CandyProbeVerdict,
  expectation?: string,
): string {
  if (verdict === 'pass') return '通过';
  if (verdict === 'fail') return expectation === 'expected' ? '疑似降智' : '答错';
  return '未完成';
}

export function buildCandyProbeBadgeLabel(
  probe: Pick<CandyProbeSnapshot, 'verdict' | 'expectation'>,
): string {
  // One question, one answer: no tally to show.
  return `🍬 ${buildCandyProbeVerdictLabel(probe.verdict, probe.expectation)}`;
}

/** What a route-wide sweep produced, already graded by the badge's own vocabulary. */
export type CandyProbeBatchTally = {
  pass: number;
  /** Wrong answers by models that were expected to pass — the 疑似降智 tier. */
  degraded: number;
  /** Wrong answers by models without that expectation — a recorded observation. */
  wrong: number;
  inconclusive: number;
  rejected: number;
};

/**
 * The route-sweep summary, one clause per tier.
 *
 * The fail tier is split the same way the badge splits it (only an `expected` model's
 * wrong answer is called 疑似降智), so the toast and the rows next to it cannot disagree.
 */
export function buildCandyProbeBatchSummary(tally: CandyProbeBatchTally, skipped: number): string {
  return [
    `通过 ${tally.pass}`,
    ...(tally.degraded > 0 ? [`疑似降智 ${tally.degraded}`] : []),
    ...(tally.wrong > 0 ? [`答错 ${tally.wrong}`] : []),
    `未完成 ${tally.inconclusive}`,
    ...(tally.rejected > 0 ? [`无法探测 ${tally.rejected}`] : []),
    ...(skipped > 0 ? [`跳过 ${skipped}`] : []),
  ].join(' · ');
}
