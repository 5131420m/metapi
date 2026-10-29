/**
 * Type declarations for the model fingerprint (identity) probe, shared by server and web.
 * See `candyProbe.d.ts` for why `src/shared` ships hand-written `.js` + `.d.ts` pairs.
 */

export declare const IDENTITY_PROBE_CLIENT_FAMILY: 'model_identity_probe';
export declare const IDENTITY_PROBE_CLIENT_APP_NAME: '模型指纹检测';
export declare const IDENTITY_PROBE_MAX_TIMEOUT_MS: 900000;
export declare const IDENTITY_PROBE_CHALLENGE_COUNT: 3;
/** Model-line key: a model and its dated snapshots share one key (see the `.js`). */
export declare function identityModelLineKey(name: string): string;
/** Short verdict labels, shared by the usage-log note and every web surface. */
export declare const IDENTITY_PROBE_VERDICT_LABELS: Readonly<Record<IdentityProbeVerdict, string>>;

/**
 * Graded verdicts. "Same model" means the same model line: a bank model and its date
 * snapshots (`deepseek-v4.1-flash` / `deepseek-v4.1-flash-1017`) count as one.
 *
 * Same family as the claim:
 * - `model_match`      — calibrated ranking, and the top candidate is the claimed model;
 * - `version_mismatch` — calibrated, the claimed model is in the bank, but the top candidate
 *                        is ANOTHER model of the same family with confidence above the
 *                        threshold (a version swap / downgrade inside the family);
 * - `family_match`     — calibrated, same family, but the model itself cannot be confirmed:
 *                        the claimed model is not in the bank, or the other-model lead is
 *                        below the threshold;
 * - `likely_match`     — same family, but the ranking is not calibrated (only some replies
 *                        were usable), so even the family is only a lean.
 *
 * Other outcomes:
 * - `mismatch`     — calibrated, confidence above the threshold, the claimed family is in
 *                    the bank, and the top candidate belongs to another family;
 * - `uncertain`    — scored, but no claim can be made (model outside the bank, low
 *                    confidence, a partial ranking pointing at another family);
 * - `not_model`    — the replies do not look like language-model output at all;
 * - `inconclusive` — nothing could be scored (upstream errors, timeouts, no reference data).
 *
 * Results stored before the grading existed carry `match`, which only ever meant "same
 * family"; the store reads it as `family_match`.
 */
export type IdentityProbeVerdict =
  | 'model_match'
  | 'version_mismatch'
  | 'family_match'
  | 'likely_match'
  | 'mismatch'
  | 'uncertain'
  | 'not_model'
  | 'inconclusive';

/** What started a run. Only manual runs exist today; the type leaves room for a schedule. */
export type IdentityProbeTrigger = 'manual';

/** Which detector decision the ranking came from (lm-detector `Analysis.decision`). */
export type IdentityProbeDecision = 'scored' | 'partial' | 'unscorable' | 'not_model';

/** One ranked candidate from the reference bank. */
export type IdentityProbeCandidate = {
  model: string;
  displayName: string;
  family: string;
  familyName: string;
  /** Closed-set probability within the reference bank; null without calibration. */
  probability: number | null;
};

/** One challenge's outcome, without the raw numbers. */
export type IdentityProbeSampleSummary = {
  index: number;
  /** `complete` / `truncated` (enough numbers before the cut) / `failed`. */
  state: 'complete' | 'truncated' | 'failed';
  /** Integers parsed from the reply (the longest 1–355 run). */
  count: number;
  /** Integers the challenge asked for. */
  expectedCount: number;
  /** Whether the reply carried enough integers to be scored. */
  accepted: boolean;
  responseModel: string | null;
  latencyMs: number | null;
  error: string | null;
};

/** The downstream shape the probe sent (decides the SDK body and endpoint preference). */
export type IdentityProbeRequestFormat = 'openai' | 'claude' | 'responses';

/**
 * One recorded run. Declared here so the server store and the web read one shape.
 *
 * Raw replies are deliberately not kept: three replies × ~300 integers × hundreds of
 * channels would bloat the settings row the store persists into.
 */
export type IdentityProbeResult = {
  channelId: number;
  routeId: number | null;
  /** The model name the channel claims (what was requested upstream). */
  model: string;
  verdict: IdentityProbeVerdict;
  reason: string | null;
  /** Detector decision; null when nothing reached the detector. */
  decision: IdentityProbeDecision | null;
  /** Top candidate; null without a ranking. */
  prediction: IdentityProbeCandidate | null;
  /** Top candidates, best first (at most five). */
  candidates: IdentityProbeCandidate[];
  /** Calibrated closed-set probability of the top candidate; null without calibration. */
  probability: number | null;
  probabilityStatus: 'reference_calibrated' | 'unavailable';
  /** The bank model the claimed name resolved to, when it is in the bank. */
  claimedModel: string | null;
  claimedFamily: string | null;
  claimedFamilyName: string | null;
  /** 1-based rank of the claimed model (its best-ranked snapshot) in the full ranking. */
  claimedRank: number | null;
  /**
   * Calibrated probability of the claimed model, summed over its date snapshots; null when
   * the claimed model is not in the bank or the ranking is not calibrated.
   */
  claimedProbability: number | null;
  /** Detector's sequence check: false means the replies do not look model-written. */
  modelLike: boolean | null;
  /** Replies the detector actually scored (0–3). */
  usedOutputs: number;
  samples: IdentityProbeSampleSummary[];
  requestFormat: IdentityProbeRequestFormat;
  /** Upstream endpoint kind the first successful challenge landed on. */
  endpoint: string | null;
  /** Model name the upstream reported back, from the first reply that carried one. */
  actualModel: string | null;
  latencyMs: number | null;
  checkedAt: string;
  config: IdentityProbeConfigFingerprint;
  trigger: IdentityProbeTrigger;
};

/** List-view shape: the result without per-sample and per-candidate detail. */
export type IdentityProbeSnapshot = Omit<IdentityProbeResult, 'samples' | 'candidates'> & {
  /** False once the verdict is older than the freshness window. */
  fresh: boolean;
  expiresAt: string;
};

/** What a verdict was measured against; a snapshot is dropped when any part changes. */
export type IdentityProbeConfigFingerprint = {
  model: string;
  accountId: number | null;
  tokenId: number | null;
  /** `builtAt` of the reference bank used for scoring; null when none could be loaded. */
  bankBuiltAt: string | null;
};
