/**
 * Type declarations for the candy-question probe.
 *
 * `src/shared` ships hand-written `.js` + `.d.ts` pairs because the server program
 * (`tsconfig.server.json`) has `rootDir: src/server` and the web bundle needs the same
 * shapes; see `scripts/dev/copy-runtime-db-generated.ts` for the build-time copy.
 *
 * These three types are the ones BOTH sides need, which is why they live here rather than
 * in `services/candyProbe/`: the web used to declare its own copies, so a new verdict value
 * could compile on one side and silently fall through the other.
 */

/** `client_family` value written on every probe usage-log row. */
export declare const CANDY_PROBE_CLIENT_FAMILY: 'candy_probe';

/** Fixed `client_app_name` for probe rows; the verdict travels in `error_message`. */
export declare const CANDY_PROBE_CLIENT_APP_NAME: '糖果题检测';

/** Hard ceiling for one probe run; the web waits longer than this, never shorter. */
export declare const CANDY_PROBE_MAX_TIMEOUT_MS: 600000;

/**
 * The three verdicts.
 *
 * `inconclusive` is not a weaker `fail`: it means the run could not be scored (no parseable
 * answer, a refusal, a truncation) and must never be treated as evidence of degradation.
 */
export type CandyProbeVerdict = 'pass' | 'fail' | 'inconclusive';

/** One graded question, as shown in the detail panel. */
export type CandyProbeQuestionResult = {
  id: string;
  prompt: string;
  expected: string;
  answer: string;
  correct: boolean;
};

/**
 * What a verdict was measured against.
 *
 * A channel is configuration, not identity: swap its source model or its credential and the
 * old verdict describes a different upstream, so a snapshot whose fingerprint no longer
 * matches is dropped instead of shown.
 */
export type CandyProbeConfigFingerprint = {
  model: string;
  accountId: number | null;
  tokenId: number | null;
};
