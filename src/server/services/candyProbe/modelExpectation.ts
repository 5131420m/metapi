/**
 * What a wrong answer MEANS, which depends on the model.
 *
 * The probe used to call every wrong answer "疑似降智". That is a claim about a comparison, and
 * without a baseline it really meant "this model got it wrong" — which is exactly what a small
 * model is expected to do. A Haiku or a 4o-mini failing a question that needs case analysis is
 * not evidence of a swapped model, and saying so trains operators to ignore the badge.
 *
 * So the verdict is read against what the model is expected to do:
 *
 * - `expected`      — a model that reasons by construction (o-series, gpt-5 on the responses
 *                     path, explicit reasoner/thinking variants). A wrong answer is worth
 *                     calling out: "疑似降智".
 * - `reference-only` — a small/fast model. A wrong answer is within expectation; the result is
 *                     still recorded, but only as a reference.
 * - `unknown`       — no basis to judge. A wrong answer is reported as a wrong answer, without
 *                     the degradation claim.
 *
 * The table is deliberately small and name-based: it is a *baseline for wording*, not routing
 * or scoring input. A model missing from it is `unknown`, never silently `expected` — the whole
 * point is to stop guessing.
 *
 * Promotion rule: a model joins `expected` only after a measured pass rate ≥ 90% on a trusted
 * (official or known-good) channel, with the calibration recorded in the test. No model has
 * been calibrated yet — the current list is reasoning-by-construction only, because the probe
 * sends its requests WITHOUT thinking enabled, and a non-reasoning flagship asked to do case
 * analysis can miss for reasons that have nothing to do with a swapped backend.
 */

export type CandyProbeExpectation = 'expected' | 'reference-only' | 'unknown';

/**
 * Small / fast model families: expected to be weaker than the flagship of their vendor.
 *
 * Matched case-insensitively against the model id. Order does not matter; every pattern is
 * tried and the first hit wins, so a name containing both `mini` and `gpt-5` (e.g.
 * `gpt-5-mini`) resolves as reference-only.
 */
const REFERENCE_ONLY_PATTERNS: readonly RegExp[] = [
  /\bhaiku\b/,
  /\bmini\b/,
  /\bnano\b/,
  /\bflash\b/,
  /\blite\b/,
  /\bsmall\b/,
  /\btiny\b/,
  // Parameter-count suffixes are the clearest signal a local model is small.
  /\b[1-9]b\b/,
  /\b1[0-9]b\b/,
  /\b3[0-2]b\b/,
  /\bturbo\b/,
  /\bcheap\b/,
];

/**
 * Reasoning-by-construction families: these reason on the candy question even though the
 * probe's request bodies do not enable thinking.
 *
 * Non-reasoning flagships (gpt-4o, claude-*-sonnet, deepseek-chat, …) are deliberately NOT
 * here: the probe asks them for case analysis without reasoning mode, and grading a miss as
 * "疑似降智" without a measured pass rate is exactly the false alarm this table exists to
 * prevent. They stay `unknown` until calibrated (see the promotion rule above).
 *
 * A model only counts as `expected` when it matches here, so a name we have never seen falls
 * through to `unknown` instead of inheriting the strongest claim.
 */
const EXPECTED_PATTERNS: readonly RegExp[] = [
  // OpenAI o-series: reasoning by construction.
  /\bo[1-9]\b/,
  // gpt-5 and friends: the responses path runs them with reasoning on. The `-chat` variants
  // are the non-reasoning ones and stay out — including dotted versions such as
  // `gpt-5.1-chat-latest`, so the lookahead scans the whole rest of the id.
  /\bgpt-5(?![\w.-]*\bchat\b)/,
  // Explicit reasoning variants, whatever the vendor.
  /\breasoner\b/,
  /\bthinking\b/,
  // deepseek-r1 wears its reasoning on a suffix instead of a word.
  /\bdeepseek-r[0-9]\b/,
];

/**
 * Classify one model id.
 *
 * Reference-only patterns win over flagship ones: `gpt-5-mini` is a small model wearing a
 * flagship name, and calling it "expected" would produce exactly the false alarm this exists
 * to prevent.
 */
export function resolveCandyProbeExpectation(model: string | null | undefined): CandyProbeExpectation {
  const normalized = typeof model === 'string' ? model.trim().toLowerCase() : '';
  if (!normalized) return 'unknown';
  if (REFERENCE_ONLY_PATTERNS.some((pattern) => pattern.test(normalized))) return 'reference-only';
  if (EXPECTED_PATTERNS.some((pattern) => pattern.test(normalized))) return 'expected';
  return 'unknown';
}

/**
 * Whether a failing verdict may be described as degradation.
 *
 * Only a model that was expected to pass can be "worse than it claims to be".
 */
export function isCandyProbeDegradationClaim(verdict: string, expectation: CandyProbeExpectation): boolean {
  return verdict === 'fail' && expectation === 'expected';
}
