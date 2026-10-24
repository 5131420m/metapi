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

/** Hard ceiling for ONE probe run (discovery + the single question), enforced server-side; the web waits longer than this, never shorter. */
export declare const CANDY_PROBE_MAX_TIMEOUT_MS: 600000;

/**
 * The three verdicts.
 *
 * `inconclusive` ("未完成") is not a weaker `fail`: it means the run could not be scored
 * (upstream error, timeout, truncation, or no committed answer) and must never be treated
 * as evidence of degradation.
 */
export type CandyProbeVerdict = 'pass' | 'fail' | 'inconclusive';

/**
 * The single answer of the single candy question.
 *
 * `answer` is the text the answer was read from ('' when nothing readable came back), and
 * `note` explains any reading compromise ("没有「答案：」行，按首个数字判定", "命中已知错误
 * 答案 20"). Null when the read needs no explanation.
 */
export type CandyProbeSampleResult = {
  /** Always 1: one question, one answer. */
  index: number;
  /** The text the answer was read from ('' when nothing readable came back). */
  answer: string;
  correct: boolean;
  note: string | null;
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

/** The question a verdict was measured on, for the detail panel. */
export type CandyProbeQuestionInfo = {
  id: string;
  prompt: string;
  expected: string;
};

/**
 * What a wrong answer means for THIS model — the baseline the wording depends on.
 *
 * `expected` (flagships/reasoning) may be called degradation; `reference-only` (small/fast
 * models) is recorded but not presented as degradation; `unknown` gets no claim at all. See
 * `services/candyProbe/modelExpectation.ts` — the point is that "降智" is a comparison, and
 * without a baseline it only ever meant "this model got it wrong".
 */
export type CandyProbeExpectation = 'expected' | 'reference-only' | 'unknown';

/**
 * What started a run: a button click, or the background schedule.
 *
 * Stored on the result and shown in the detail panel, so an operator reading a verdict
 * knows whether someone chose to test this channel or the schedule did — the two have
 * different costs and different trust. Rows persisted before the field existed are read
 * back as `manual`.
 */
export type CandyProbeTrigger = 'manual' | 'schedule';
