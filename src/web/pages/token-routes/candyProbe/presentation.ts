/**
 * Shared presentation for candy-probe verdicts, so the row badge and the detail panel
 * cannot drift apart in wording or colour.
 */

import type { QualityTone } from '../../helpers/qualityBadges.js';
import type { CandyProbeSnapshot, CandyProbeVerdict } from '../types.js';

export const CANDY_PROBE_FINGERPRINT_LABELS: Record<string, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex CLI',
  generic_openai: 'OpenAI SDK',
};

export function formatCandyProbeFingerprint(fingerprint: string): string {
  return CANDY_PROBE_FINGERPRINT_LABELS[fingerprint] ?? fingerprint;
}

export function formatCandyProbeCheckedAt(checkedAt: string): string {
  const timestamp = Date.parse(checkedAt);
  if (!Number.isFinite(timestamp)) return checkedAt;
  return new Date(timestamp).toLocaleString();
}

export function resolveCandyProbeTone(verdict: CandyProbeVerdict): QualityTone {
  if (verdict === 'pass') return 'primary';
  if (verdict === 'fail') return 'danger';
  return 'warning';
}

export function buildCandyProbeBadgeLabel(probe: Pick<CandyProbeSnapshot, 'verdict' | 'score' | 'total'>): string {
  if (probe.verdict === 'pass') return `🍬 通过 ${probe.score}/${probe.total}`;
  if (probe.verdict === 'fail') return `🍬 疑似降智 ${probe.score}/${probe.total}`;
  return '🍬 不确定';
}

export function buildCandyProbeVerdictLabel(verdict: CandyProbeVerdict): string {
  if (verdict === 'pass') return '通过';
  if (verdict === 'fail') return '疑似降智';
  return '不确定';
}
