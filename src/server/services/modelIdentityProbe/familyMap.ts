/**
 * Map a channel's claimed model name onto the lm-detector reference bank.
 *
 * Two levels, strongest first:
 *
 * 1. a model line in the bank (after normalizing vendor prefixes, date suffixes, dated
 *    snapshot suffixes and the `4-6` / `4.6` version spelling) — gives the claimed model's
 *    own rank and probability;
 * 2. a family by name pattern — enough to say "the top candidate is another family".
 *
 * A name that matches neither is outside the bank: no family claim can be made about it,
 * which the verdict reads as `uncertain`, never `mismatch`.
 *
 * The family ids are the bank's own (`analysis.results[].family`), read from the reference
 * bank built 2026-10-24: claude, gpt, gemini, grok, glm, qwen, kimi, hunyuan, muse, mimo,
 * step, deepseek, seed. The test pins every id in the pattern table to that list.
 */

import { identityModelLineKey } from '../../../shared/modelIdentityProbe.js';

export type IdentityCandidateLike = {
  model: string;
  family: string;
  family_name?: string;
  probability?: number | null;
};

/** Pattern → bank family id. First hit wins; order only matters for overlapping names. */
export const IDENTITY_FAMILY_PATTERNS: ReadonlyArray<{ family: string; pattern: RegExp }> = [
  { family: 'claude', pattern: /claude/ },
  { family: 'gpt', pattern: /(^|[^a-z])(gpt|chatgpt|codex)|(^|[-_/])o[1-9](?:[-_/.]|$)/ },
  { family: 'gemini', pattern: /gemini/ },
  { family: 'grok', pattern: /grok/ },
  { family: 'deepseek', pattern: /deepseek/ },
  { family: 'qwen', pattern: /qwen|qwq/ },
  { family: 'glm', pattern: /(^|[^a-z])glm|chatglm|zhipu/ },
  { family: 'kimi', pattern: /kimi|moonshot/ },
  { family: 'hunyuan', pattern: /hunyuan|(^|[^a-z])hy[0-9]/ },
  { family: 'mimo', pattern: /mimo/ },
  { family: 'step', pattern: /(^|[^a-z])step-?[0-9]/ },
  { family: 'seed', pattern: /(^|[^a-z])seed-|doubao/ },
  { family: 'muse', pattern: /(^|[^a-z])muse-/ },
];

/**
 * Comparison key for a model id.
 *
 * Lowercase; drop a `vendor/` prefix; drop a trailing 8-digit or ISO date (`-20250929`,
 * `-2025-09-29`) and `-latest`; write a digit-hyphen-digit version as a dot
 * (`claude-opus-4-6` → `claude-opus-4.6`), which is how the bank spells versions.
 */
export function normalizeIdentityModelKey(name: string): string {
  let key = String(name || '').trim().toLowerCase();
  const slash = key.lastIndexOf('/');
  if (slash >= 0) key = key.slice(slash + 1);
  key = key
    .replace(/-latest$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/(\d)[-.](?=\d(?:\D|$))/g, '$1.');
  return key;
}

/**
 * Model-line key (a model and its dated snapshots share one), owned by the shared module so
 * the web detail panel highlights exactly the candidates the verdict counted as the claim.
 */
export { identityModelLineKey };

/** Bank family id for a model name by pattern, or null. */
export function resolveIdentityFamilyByName(name: string): string | null {
  const normalized = normalizeIdentityModelKey(name);
  if (!normalized) return null;
  for (const entry of IDENTITY_FAMILY_PATTERNS) {
    if (entry.pattern.test(normalized)) return entry.family;
  }
  return null;
}

export type ClaimedIdentity = {
  /** The bank model the claim resolved to, or null without an exact hit. */
  claimedModel: string | null;
  /** The bank family of the claim, or null when the name is outside the bank. */
  claimedFamily: string | null;
  /** Human family name from the bank, when known. */
  claimedFamilyName: string | null;
  /** 1-based rank of the claimed model's best-ranked snapshot; null without a hit. */
  claimedRank: number | null;
  /**
   * Summed probability over every bank snapshot of the claimed model line; null without a
   * hit, or when the candidates carry no probabilities (an uncalibrated ranking).
   */
  claimedProbability: number | null;
  /** Whether the claimed family has any model in the bank. */
  claimedFamilyInBank: boolean;
};

/** Whether a candidate is a snapshot of the claimed model line. */
export function isSameIdentityModelLine(candidateModel: string, claimedName: string): boolean {
  const claimedLine = identityModelLineKey(claimedName);
  return !!claimedLine && identityModelLineKey(candidateModel) === claimedLine;
}

/**
 * Resolve the claim against the ranked candidates.
 *
 * `candidates` should be the full ranked list (`analysis.results`); with an empty list (an
 * unscored run) only the name-pattern family can be resolved, and `claimedFamilyInBank` is
 * false because there is nothing to compare against.
 *
 * The claim is matched by MODEL LINE, so a claim of `deepseek-v4.1-flash` is found whether
 * the bank ranks the base id or a dated snapshot of it first; the probability of a line is
 * the sum over its snapshots.
 */
export function resolveClaimedIdentity(
  claimedName: string,
  candidates: readonly IdentityCandidateLike[],
): ClaimedIdentity {
  const index = candidates.findIndex((candidate) => isSameIdentityModelLine(candidate.model, claimedName));
  if (index >= 0) {
    const hit = candidates[index]!;
    const lineProbabilities = candidates
      .filter((candidate) => isSameIdentityModelLine(candidate.model, claimedName))
      .map((candidate) => candidate.probability);
    const calibrated = lineProbabilities.every((value) => typeof value === 'number' && Number.isFinite(value));
    return {
      claimedModel: hit.model,
      claimedFamily: hit.family,
      claimedFamilyName: hit.family_name ?? null,
      claimedRank: index + 1,
      claimedProbability: calibrated
        ? Math.min(1, lineProbabilities.reduce<number>((sum, value) => sum + (value as number), 0))
        : null,
      claimedFamilyInBank: true,
    };
  }

  const family = resolveIdentityFamilyByName(claimedName);
  const familyHit = family ? candidates.find((candidate) => candidate.family === family) : undefined;
  return {
    claimedModel: null,
    claimedFamily: family,
    claimedFamilyName: familyHit?.family_name ?? null,
    claimedRank: null,
    claimedProbability: null,
    claimedFamilyInBank: !!familyHit,
  };
}
