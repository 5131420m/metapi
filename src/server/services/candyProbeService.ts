/**
 * Candy-question degrade probe.
 *
 * Runs one cheap, self-graded question bundle against a single channel, through the same
 * upstream request builder the proxy uses, wearing the client fingerprint that matches the
 * channel's model family (Claude → Claude Code, GPT/Codex → Codex CLI, others → OpenAI SDK).
 *
 * What this service deliberately does NOT do (P1 scope):
 * - it does not touch routing, cooldowns, channel health or failure counters;
 * - it does not auto-exclude anything. A verdict is recorded for display only, so the
 *   feature cannot shrink availability or change proxy behaviour.
 *
 * It DOES write one usage-log row per run, tagged `candy_probe`, so an operator can audit
 * when a channel was tested and what came back. That row carries no cost and never feeds
 * channel health; it is an audit trail, not proxy traffic.
 *
 * The exclusion policy is a separate, later slice that reads these verdicts.
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import { resolveResponseTimeoutMs } from '../proxy-core/responseTimeoutPolicy.js';
import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { buildOauthProviderHeaders } from './oauth/service.js';
import { resolveProbeModelName, resolveProbeTokenValue } from './channelProbeContext.js';
import { resolveChannelProxyUrl, withSiteRecordProxyRequestInit } from './siteProxy.js';
import { dispatchRuntimeRequest } from './runtimeDispatch.js';
import { isLikelyConversationModel } from './runtimeModelProbe.js';
import { insertProxyLog } from './proxyLogStore.js';
import {
  createProbeDeadline,
  remainingTimeoutMs,
  withTimeout,
} from './probeDeadline.js';
import {
  runWithSiteApiEndpointPool,
  SiteApiEndpointRequestError,
} from './siteApiEndpointService.js';
import {
  CANDY_PROBE_CLIENT_APP_NAME,
  CANDY_PROBE_CLIENT_FAMILY,
  CANDY_PROBE_MAX_TIMEOUT_MS,
} from '../../shared/candyProbe.js';
import {
  buildUpstreamEndpointRequest,
  resolveUpstreamEndpointCandidates,
  type UpstreamEndpoint,
} from './upstreamEndpointRuntime.js';
import { executeEndpointFlow, type BuiltEndpointRequest } from '../proxy-core/orchestration/endpointFlow.js';
import { readRuntimeResponseText } from '../proxy-core/executors/types.js';
import {
  buildSurfaceProxyDebugResponseHeaders,
  captureSurfaceProxyDebugSuccessResponseBody,
  safeFinalizeSurfaceProxyDebugTrace,
  safeInsertSurfaceProxyDebugAttempt,
  safeUpdateSurfaceProxyDebugCandidates,
  safeUpdateSurfaceProxyDebugSelection,
  startSurfaceProxyDebugTrace,
} from './proxyDebugTraceRuntime.js';
import type { ProxyDebugTraceSession } from './proxyDebugTraceStore.js';
import {
  buildCandyProbePrompt,
  readCandyAnswer,
  resolveCandyProbeVerdict,
  CANDY_BAG_REFERENCE_QUESTION,
  type CandyAnswerRead,
  type CandyBagQuestion,
} from './candyProbe/candyBagQuestion.js';
import { generateCandyBagQuestion } from './candyProbe/generatedQuestions.js';
import { resolveCandyProbeExpectation } from './candyProbe/modelExpectation.js';
import {
  getCandyFingerprint,
  resolveCandyFingerprintIdForModel,
  type CandyFingerprint,
  type CandyFingerprintId,
} from './candyProbe/fingerprints.js';
import { extractCandyProbeAnswerPayload, isTruncatedStopReason } from './candyProbe/responseParsing.js';
import {
  candyProbeConfigMatches,
  getCandyProbeResultForChannel,
  getCandyProbeSnapshots,
  getCandyProbeStoreGeneration,
  hydrateCandyProbeResultsFromSettings,
  recordCandyProbeResultIfCurrent,
  type CandyProbeConfigFingerprint,
  type CandyProbeResult,
  type CandyProbeSampleResult,
  type CandyProbeSnapshot,
  type CandyProbeTrigger,
} from './candyProbe/resultStore.js';

export { getCandyProbeResultForChannel, getCandyProbeSnapshots, hydrateCandyProbeResultsFromSettings };
export type { CandyProbeResult, CandyProbeSnapshot };

export const CANDY_PROBE_MIN_TIMEOUT_MS = 1_000;
/** Re-exported from the shared module so the web's backstop cannot drift from the server. */
export { CANDY_PROBE_MAX_TIMEOUT_MS } from '../../shared/candyProbe.js';

/**
 * Floor applied to the SETTINGS-DERIVED budget only.
 *
 * The proxy's streaming setting is a first-byte / mid-stream-silence budget: it exists to
 * catch a dead upstream, and the proxy satisfies it as soon as the first byte lands. A probe
 * has to wait for a WHOLE completion — and it now asks for reasoning, so on a thinking model the
 * time goes exactly where the proxy's budget does not look. Reusing that number as the total
 * budget produced false "未完成"（inconclusive）verdicts, which is why the floor exists.
 *
 * This floor is also why there is no separate "fallback ceiling" constant: the settings budget is
 * already at least this large, so a smaller fallback could never be the answer. `0` in settings
 * means "no wait limit" to the proxy; for a probe it means "use this floor".
 *
 * A run is ONE question: the budget covers discovery plus the single request, clamped to
 * `CANDY_PROBE_MAX_TIMEOUT_MS`, which is what keeps a run inside the web's backstop
 * whatever the settings say.
 *
 * Not applied to an explicit `timeoutMs` override: that is the caller's own decision (and the
 * knob the tests use to keep a stalled-upstream case short).
 */
export const CANDY_PROBE_TIMEOUT_FLOOR_MS = 120_000;

/**
 * Usage-log marker, so probe traffic is identifiable and filterable in 使用日志 (and
 * excludable from every aggregate — see `proxyLogQueries.ts`). Re-exported here because
 * callers of the probe already import this module.
 */
export { CANDY_PROBE_CLIENT_FAMILY } from '../../shared/candyProbe.js';

function clampCandyProbeTimeoutMs(value: number): number {
  return Math.min(
    CANDY_PROBE_MAX_TIMEOUT_MS,
    Math.max(CANDY_PROBE_MIN_TIMEOUT_MS, Math.trunc(value)),
  );
}

/**
 * The probe's budget, taken from the same setting the proxy uses for a streaming request,
 * so an operator tunes one knob rather than two.
 *
 * The probe always streams, so the streaming budget is the meaningful one. `0` means the
 * operator removed the wait limit for the proxy; a probe still needs a ceiling, and the floor
 * below is what it falls back to.
 */
export function resolveCandyProbeTimeoutMs(override?: number | null): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return clampCandyProbeTimeoutMs(override);
  }
  const fromSettings = resolveResponseTimeoutMs('stream', config);
  const budget = fromSettings > 0 ? fromSettings : CANDY_PROBE_TIMEOUT_FLOOR_MS;
  return clampCandyProbeTimeoutMs(Math.max(budget, CANDY_PROBE_TIMEOUT_FLOOR_MS));
}

/** One wording for the deadline, so the trace, the log note and the UI all agree. */
export function candyProbeTimeoutMessage(timeoutMs: number): string {
  return `探测超时：上游未在 ${Math.round(timeoutMs / 1000)}s 内完成`;
}

/**
 * Normalise the several usage shapes upstreams return into proxy-log token columns.
 *
 * Deliberately does not invent numbers. A streaming chat upstream that was not asked for
 * usage reports nothing, and a partial sum is worse than a blank: `total = 0 + output`
 * would claim a total that excludes the prompt entirely.
 *
 * Derivation happens only in directions that are exact:
 *
 * - a missing side from a real total;
 * - the total from two real sides. Anthropic reports `input_tokens` / `output_tokens` and no
 *   total at all, so without this every claude-path probe logged a zero total while both
 *   halves were known — the sum of two measured numbers, not an invention.
 */
function normalizeCandyProbeUsage(usage: Record<string, unknown> | null | undefined): {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
} {
  const readNumber = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = usage?.[key];
      if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    }
    return null;
  };
  let promptTokens = readNumber('input_tokens', 'prompt_tokens', 'promptTokenCount');
  let completionTokens = readNumber('output_tokens', 'completion_tokens', 'candidatesTokenCount');
  let totalTokens = readNumber('total_tokens', 'totalTokenCount');

  if (totalTokens != null) {
    if (promptTokens == null && completionTokens != null) promptTokens = Math.max(0, totalTokens - completionTokens);
    if (completionTokens == null && promptTokens != null) completionTokens = Math.max(0, totalTokens - promptTokens);
  } else if (promptTokens != null && completionTokens != null) {
    totalTokens = promptTokens + completionTokens;
  }

  return { promptTokens, completionTokens, totalTokens };
}

/**
 * The verdict, as one line of text.
 *
 * This used to BE the row's `client_app_name`, which meant the usage-log page's client
 * filter grew one entry per wording. The app name is now a fixed marker and this text
 * travels in `error_message`, where it reads as the note it is.
 *
 * Four wordings, no tally: a probe is one question, one answer. "疑似降智" appears only
 * when the model was EXPECTED to pass (see `modelExpectation.ts`); for anything else the
 * same wrong answer is recorded as a plain "答错". "未完成" is not a softer 答错 — it
 * means the run could not be scored at all (upstream error, timeout, truncation, no
 * committed answer).
 */
export function buildCandyProbeLogNote(
  result: Pick<
    CandyProbeResult,
    'verdict' | 'reason' | 'expectation' | 'trigger'
  >,
): string {
  // Scheduled rows carry the prefix so the usage log can tell the schedule's own traffic
  // from a click, at a glance and without a new filter entry.
  const prefix = result.trigger === 'schedule' ? '［巡检］' : '';
  const tail = result.reason ? `｜${result.reason}` : '';
  if (result.verdict === 'pass') return `${prefix}糖果题判定：通过`;
  if (result.verdict === 'fail') {
    const headline = result.expectation === 'expected' ? '疑似降智' : '答错';
    return `${prefix}糖果题判定：${headline}${tail}`;
  }
  return `${prefix}糖果题判定：未完成${tail}`;
}

/** The downstream path the probe's fingerprint impersonates, for the debug trace. */
function resolveFingerprintDownstreamPath(downstreamFormat: CandyFingerprint['downstreamFormat']): string {
  if (downstreamFormat === 'claude') return '/v1/messages';
  if (downstreamFormat === 'responses') return '/v1/responses';
  return '/v1/chat/completions';
}

/**
 * Mirror one probe into the usage log.
 *
 * Failures here must never fail the probe: the verdict is the product, the log row is the
 * audit trail. Cost is pinned to 0 because a probe is metapi's own traffic, not a billable
 * downstream request.
 */
async function recordCandyProbeUsageLog(input: {
  result: CandyProbeResult;
  accountId: number | null;
  httpStatus: number | null;
  usage: Record<string, unknown> | null;
}): Promise<void> {
  const { result } = input;
  try {
    const tokens = normalizeCandyProbeUsage(input.usage);
    await insertProxyLog({
      routeId: result.routeId ?? null,
      channelId: result.channelId,
      accountId: input.accountId,
      modelRequested: result.model,
      modelActual: result.actualModel,
      status: result.verdict === 'inconclusive' ? 'failed' : 'success',
      httpStatus: input.httpStatus,
      isStream: true,
      latencyMs: result.latencyMs,
      promptTokens: tokens.promptTokens,
      completionTokens: tokens.completionTokens,
      totalTokens: tokens.totalTokens,
      estimatedCost: 0,
      clientFamily: CANDY_PROBE_CLIENT_FAMILY,
      clientAppName: CANDY_PROBE_CLIENT_APP_NAME,
      clientConfidence: 'high',
      // The verdict is this row's payload; it lives in error_message so the client columns
      // stay a stable vocabulary (and so the log list shows it).
      errorMessage: buildCandyProbeLogNote(result),
      retryCount: 0,
    });
  } catch {
    // Audit-only: swallow so a logging hiccup cannot turn a good verdict into an error.
  }
}

export class CandyProbeRequestError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'CandyProbeRequestError';
    this.statusCode = statusCode;
  }
}

type CandyProbeChannelRow = {
  route_channels: typeof schema.routeChannels.$inferSelect;
  token_routes: typeof schema.tokenRoutes.$inferSelect;
  accounts: typeof schema.accounts.$inferSelect;
  sites: typeof schema.sites.$inferSelect;
  account_tokens: typeof schema.accountTokens.$inferSelect | null;
};

type CandyProbeChannelContext = {
  channelId: number;
  routeId: number;
  modelName: string;
  tokenValue: string;
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
  /** What the verdict is measured against; a snapshot is dropped when this changes. */
  config: CandyProbeConfigFingerprint;
};

// `resolveProbeModelName` / `resolveProbeTokenValue` are shared with the channel recovery
// probe — see `channelProbeContext.ts`. They used to be copied verbatim into both services.


async function loadChannelProbeContext(channelId: number): Promise<CandyProbeChannelContext> {
  const row = await db.select()
    .from(schema.routeChannels)
    .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .innerJoin(schema.tokenRoutes, eq(schema.routeChannels.routeId, schema.tokenRoutes.id))
    .leftJoin(schema.accountTokens, eq(schema.routeChannels.tokenId, schema.accountTokens.id))
    .where(eq(schema.routeChannels.id, channelId))
    .get();
  if (!row) {
    throw new CandyProbeRequestError(`通道 #${channelId} 不存在`, 404);
  }

  const modelName = resolveProbeModelName(row);
  if (!modelName) {
    throw new CandyProbeRequestError('该通道没有可用于探测的来源模型名', 400);
  }
  if (!isLikelyConversationModel(modelName)) {
    throw new CandyProbeRequestError(`模型 ${modelName} 不是对话模型，糖果题探测不适用`, 400);
  }

  const tokenValue = resolveProbeTokenValue(row);
  if (!tokenValue) {
    throw new CandyProbeRequestError('该通道没有可用凭据，无法发起探测', 400);
  }

  return {
    channelId,
    routeId: row.route_channels.routeId,
    modelName,
    tokenValue,
    account: row.accounts,
    site: row.sites,
    config: {
      model: modelName,
      accountId: row.accounts.id ?? null,
      tokenId: row.route_channels.tokenId ?? null,
    },
  };
}

function resolveFingerprintId(
  modelName: string,
  requested: CandyFingerprintId | 'auto' | undefined,
): CandyFingerprintId {
  if (requested && requested !== 'auto') return requested;
  return resolveCandyFingerprintIdForModel(modelName);
}

/**
 * The probe's execution is bounded by the run deadline handed to the site API endpoint
 * pool — request dispatch, first-byte observation, body read AND every pool rotation all
 * sit inside it.
 *
 * `executeEndpointFlow` only resolves once the response is usable (it observes the first
 * byte), so a relay that accepts the connection and then stalls can hang *inside* the flow;
 * and even when the flow resolves, a stream that never ends would hang the body read. The
 * pool races each target's whole exchange against `deadlineAtMs` and aborts its signal —
 * which the probe composes into the fetch (see the dispatch closure) — and the probe also
 * passes its own `timeoutMessage`, so the deadline surfaces with the probe's wording.
 */

/**
 * Consecutive fail/inconclusive runs against the current config, for the schedule's
 * recheck backoff.
 *
 * A verdict against a DIFFERENT config never continues the streak — swapping the channel's
 * model or credential starts the story over. Must be read BEFORE the run's own result is
 * recorded, so it sees the previous verdict.
 */
function resolveCandyFailStreak(input: {
  channelId: number;
  config: CandyProbeConfigFingerprint;
  verdict: 'pass' | 'fail' | 'inconclusive';
}): number {
  if (input.verdict === 'pass') return 0;
  const previous = getCandyProbeResultForChannel(input.channelId);
  if (previous && candyProbeConfigMatches(previous.config, input.config)) {
    return (previous.failStreak ?? 0) + 1;
  }
  return 1;
}

function buildInconclusiveResult(input: {
  channelId: number;
  routeId: number | null;
  modelName: string;
  fingerprintId: CandyFingerprintId;
  question: CandyBagQuestion;
  latencyMs: number | null;
  reason: string;
  endpoint: string | null;
  config: CandyProbeConfigFingerprint;
  trigger: CandyProbeTrigger;
  failStreak: number;
}): CandyProbeResult {
  return {
    channelId: input.channelId,
    routeId: input.routeId,
    model: input.modelName,
    fingerprint: input.fingerprintId,
    verdict: 'inconclusive',
    score: 0,
    total: 1,
    endpoint: input.endpoint,
    actualModel: null,
    latencyMs: input.latencyMs,
    checkedAt: new Date().toISOString(),
    reason: input.reason,
    question: {
      id: input.question.id,
      prompt: input.question.prompt,
      expected: input.question.expectedLabel,
    },
    samples: [{ index: 1, answer: '', correct: false, note: input.reason }],
    validSampleCount: 0,
    expectation: resolveCandyProbeExpectation(input.modelName),
    config: input.config,
    trigger: input.trigger,
    failStreak: input.failStreak,
  };
}

/**
 * The verdict text, with the failure that caused it kept in view.
 *
 * An unscored run ("没有可判读的答案") would hide WHY on its own: a 404, a timeout and a
 * refusal all look the same, and they call for different operator responses. The failure
 * is appended, not substituted — it explains the verdict rather than replacing it.
 */
function buildCandyProbeReason(input: {
  gradedReason: string | null;
  payloadMessage: string | null;
  firstFailureReason: string | null;
}): string | null {
  const parts: string[] = [];
  if (input.gradedReason) {
    parts.push(input.firstFailureReason ? `${input.gradedReason}：${input.firstFailureReason}` : input.gradedReason);
  } else {
    const tail = input.payloadMessage ?? input.firstFailureReason;
    if (tail) parts.push(tail);
  }
  return parts.length > 0 ? parts.join('；') : null;
}

/**
 * Pick the question for this run.
 *
 * The reference bag is used often enough to stay comparable with what people measure by hand,
 * while the generated instances keep a relay (or a model that has seen the public question)
 * from special-casing it. If no usable instance can be drawn the reference question is the
 * answer — it is always valid, and a degenerate generated question would measure nothing.
 */
export function selectCandyBagQuestion(random: () => number): CandyBagQuestion {
  if (random() < 0.5) return CANDY_BAG_REFERENCE_QUESTION;
  return generateCandyBagQuestion(random) ?? CANDY_BAG_REFERENCE_QUESTION;
}

/**
 * The per-sample note shown in the detail panel.
 *
 * A sample that fell back to scanning the text, or that landed on a KNOWN wrong total, is worth
 * saying out loud: it is the difference between "the model answered 20" (a real mistake) and
 * "we could not find the answer line and read the last number" (a reading compromise).
 */
function buildCandyProbeSampleNote(
  read: CandyAnswerRead,
  payload: { stopReason?: string | null; errorMessage?: string | null },
): string | null {
  const notes: string[] = [];
  if (read.source === 'text-fallback') {
    // Say WHICH compromise was made: a verdict resting on a reading heuristic is weaker
    // evidence than one read off the model's own committed line.
    notes.push(
      read.fallbackLayer === 'terse' ? '没有「答案：」行，回答很短，按首个数字判定'
        : read.fallbackLayer === 'marker' ? '没有「答案：」行，按最后的自报结论判定'
          : '没有「答案：」行，按末行数字判定',
    );
    if (!read.correct && !read.convicts) {
      // The prose read a wrong number, which may be an intermediate value the reasoning
      // discarded — the sample is demoted to invalid rather than counted as wrong.
      notes.push('兜底读出的数字不是答案，样本记为无效，不参与判定');
    }
  }
  if (!read.correct && read.matchedWrongAnswer !== null) notes.push(`命中已知错误答案 ${read.matchedWrongAnswer}`);
  if (read.source === 'none') notes.push('没有可判读的数字');
  if (isTruncatedStopReason(payload.stopReason)) notes.push('输出被截断');
  if (payload.errorMessage) notes.push(String(payload.errorMessage).slice(0, 120));
  return notes.length > 0 ? notes.join('｜') : null;
}

/**
 * Runs in flight, keyed by what the verdict depends on.
 *
 * Every probe is a real upstream request, and the UI is not the only caller: the batch
 * button fires one per channel, two browser tabs can both be open, and a scheduled sweep
 * may overlap a click. Single-flight per (channel + parameters) means a double click costs
 * one upstream request and both callers get the same answer. The parameters are part of the
 * key on purpose — a Claude fingerprint and a Codex fingerprint are different tests and
 * must not be answered with each other's result.
 */
const inFlightProbes = new Map<string, Promise<CandyProbeResult>>();

/** Global ceiling: without it, N routes × 2 workers is an unbounded fan-out upstream. */
export const CANDY_PROBE_MAX_CONCURRENT = 4;

let activeProbes = 0;
const probeSlotWaiters: Array<() => void> = [];

/**
 * Take one of the global probe slots, waiting no later than the run deadline.
 *
 * A released slot is handed STRAIGHT to the next waiter (the count does not drop and rise
 * again), so a caller arriving in between cannot slip past the queue and push the
 * concurrency over the ceiling. The wait is bounded by the run's own deadline: a batch over
 * many channels queues behind earlier waves, and an unbounded wait would hold the HTTP
 * request open long past the web's backstop only to time out the moment it got a slot.
 */
function acquireProbeSlot(deadlineAtMs: number, timeoutMessage: string): Promise<() => void> {
  const makeRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = probeSlotWaiters.shift();
      if (next) next();
      else activeProbes = Math.max(0, activeProbes - 1);
    };
  };

  if (activeProbes < CANDY_PROBE_MAX_CONCURRENT && probeSlotWaiters.length === 0) {
    activeProbes += 1;
    return Promise.resolve(makeRelease());
  }

  return new Promise((resolve, reject) => {
    const waiter = () => {
      clearTimeout(timer);
      resolve(makeRelease());
    };
    const timer = setTimeout(() => {
      const index = probeSlotWaiters.indexOf(waiter);
      if (index >= 0) probeSlotWaiters.splice(index, 1);
      reject(new Error(timeoutMessage));
    }, Math.max(0, deadlineAtMs - Date.now()));
    timer.unref?.();
    probeSlotWaiters.push(waiter);
  });
}

/** Test seam: the semaphore is module state, so tests must be able to see it drain. */
export function resetCandyProbeConcurrencyForTests(): void {
  activeProbes = 0;
  probeSlotWaiters.length = 0;
  inFlightProbes.clear();
  activeChannelRunCounts.clear();
}

export function runChannelCandyProbe(input: {
  channelId: number;
  fingerprint?: CandyFingerprintId | 'auto';
  requestId?: string | null;
  /** Override the run ceiling (tests use a short one); clamped to a sane range. */
  timeoutMs?: number;
  /** Question-selection randomness; injectable so a test can pin the drawn question. */
  random?: () => number;
  /** What started the run; recorded on the result and shown in the detail panel. */
  trigger?: CandyProbeTrigger;
}): Promise<CandyProbeResult> {
  const channelId = Math.trunc(input.channelId);
  if (!Number.isFinite(channelId) || channelId <= 0) {
    return Promise.reject(new CandyProbeRequestError('无效的通道 ID', 400));
  }

  const flightKey = [
    channelId,
    input.fingerprint ?? 'auto',
    input.timeoutMs ?? '',
    // An injected random source means the caller is pinning the question, so two such runs
    // are not interchangeable and must not share one result.
    input.random ? 'seeded' : '',
    // A scheduled run fails fast on a busy site (it must not queue behind real traffic); a
    // click waits. Sharing one promise would hand the click the schedule's "Site busy".
    input.trigger ?? 'manual',
  ].join('|');
  const existing = inFlightProbes.get(flightKey);
  if (existing) return existing;

  noteChannelRunStart(channelId);
  const run = executeChannelCandyProbe(input)
    .finally(() => {
      inFlightProbes.delete(flightKey);
      noteChannelRunEnd(channelId);
    });
  inFlightProbes.set(flightKey, run);
  return run;
}

/**
 * Runs per channel currently in flight, counted rather than flagged: two callers with
 * different parameters (a manual 1-sample run beside a scheduled 3-sample run) may run
 * concurrently, and the flag must not clear while either is still going.
 */
const activeChannelRunCounts = new Map<number, number>();

function noteChannelRunStart(channelId: number): void {
  activeChannelRunCounts.set(channelId, (activeChannelRunCounts.get(channelId) ?? 0) + 1);
}

function noteChannelRunEnd(channelId: number): void {
  const remaining = (activeChannelRunCounts.get(channelId) ?? 1) - 1;
  if (remaining <= 0) activeChannelRunCounts.delete(channelId);
  else activeChannelRunCounts.set(channelId, remaining);
}

/** Whether any probe run is currently in flight for this channel (manual or scheduled). */
export function isCandyProbeInFlight(channelId: number): boolean {
  if (!Number.isFinite(channelId) || channelId <= 0) return false;
  return activeChannelRunCounts.has(Math.trunc(channelId));
}

async function executeChannelCandyProbe(input: {
  channelId: number;
  fingerprint?: CandyFingerprintId | 'auto';
  requestId?: string | null;
  timeoutMs?: number;
  random?: () => number;
  trigger?: CandyProbeTrigger;
}): Promise<CandyProbeResult> {
  // No slot is taken here: the single upstream request takes one (see below), so a run
  // holds a slot only while its request is actually in flight.
  return runChannelCandyProbeUnbounded(input);
}

async function runChannelCandyProbeUnbounded(input: {
  channelId: number;
  fingerprint?: CandyFingerprintId | 'auto';
  requestId?: string | null;
  timeoutMs?: number;
  /** Question-selection randomness; injectable so a test can pin the drawn question. */
  random?: () => number;
  trigger?: CandyProbeTrigger;
}): Promise<CandyProbeResult> {
  const channelId = Math.trunc(input.channelId);
  const timeoutMs = resolveCandyProbeTimeoutMs(input.timeoutMs);
  const trigger: CandyProbeTrigger = input.trigger ?? 'manual';
  // One deadline for the WHOLE run — discovery plus the single question.
  const runDeadline = createProbeDeadline(timeoutMs);
  if (!Number.isFinite(channelId) || channelId <= 0) {
    throw new CandyProbeRequestError('无效的通道 ID', 400);
  }

  // Read BEFORE the first await: a reset that lands while this run is in flight must invalidate
  // the verdict, and reading it after `loadChannelProbeContext` (or after waiting for a slot)
  // would compare against a generation that already moved.
  const storeGeneration = getCandyProbeStoreGeneration();

  const context = await loadChannelProbeContext(channelId);
  const fingerprintId = resolveFingerprintId(context.modelName, input.fingerprint);
  const fingerprint = getCandyFingerprint(fingerprintId);

  const random = input.random ?? Math.random;
  const question = selectCandyBagQuestion(random);

  /** Store the verdict, mirror it into the usage log, and close the debug trace. */
  let debugTrace: ProxyDebugTraceSession | null = null;
  let successfulUpstreamPath: string | null = null;
  const finish = async (
    result: CandyProbeResult,
    audit: {
      /** Whether an upstream exchange completed with a usable HTTP response (2xx read included). */
      exchangeOk?: boolean;
      usage?: Record<string, unknown> | null;
      httpStatus?: number | null;
      responseHeaders?: Record<string, unknown> | null;
      responseBody?: unknown;
    } = {},
  ): Promise<CandyProbeResult> => {
    // A probe that started before a factory reset / backup import describes a database that
    // is gone, and after the replacement a channel id can even be reused. Record it only if
    // the store has not been reset meanwhile.
    //
    // There is deliberately nothing to do when it is dropped: the usage log row below still
    // records that the probe ran (tagged `candy_probe`), which is what an operator auditing the
    // reset needs to see. An earlier version of this spot carried an empty `if` with a comment
    // claiming it wrote to the debug trace; it did not, and a branch that promises work it does
    // not do is worse than no branch.
    recordCandyProbeResultIfCurrent(result, storeGeneration);
    await recordCandyProbeUsageLog({
      result,
      accountId: context.account.id ?? null,
      httpStatus: audit.httpStatus ?? null,
      usage: audit.usage ?? null,
    });
    await safeFinalizeSurfaceProxyDebugTrace(debugTrace, {
      // The trace records the REQUEST outcome, exactly like the proxy surfaces do — not the
      // verdict. `exchangeOk` is the honest signal: a 502 with a body is a completed-but-
      // failed exchange, so `httpStatus != null` alone would mark it success.
      finalStatus: audit.exchangeOk === true ? 'success' : 'failed',
      finalHttpStatus: audit.httpStatus ?? null,
      finalUpstreamPath: result.endpoint ? successfulUpstreamPath : null,
      finalResponseHeaders: audit.responseHeaders ?? null,
      finalResponseBody: audit.responseBody ?? null,
    });
    return result;
  };

  const startedAtMs = Date.now();
  const timeoutMessage = candyProbeTimeoutMessage(timeoutMs);
  const oauth = getOauthInfoFromAccount(context.account);
  const prompt = buildCandyProbePrompt(question);
  const fingerprintInput = {
    model: context.modelName,
    prompt,
    scopeKey: `${context.site.id}:${channelId}`,
  };

  try {
    // Candidate resolution can itself talk upstream (model discovery), and it is shared by
    // every sample, so it draws from the run deadline: what it leaves is what the samples get.
    const endpointCandidates = await withTimeout(
      () => resolveUpstreamEndpointCandidates(
        { site: context.site, account: context.account },
        context.modelName,
        fingerprint.downstreamFormat,
        context.modelName,
        {},
        { oauthProvider: oauth?.provider },
      ),
      remainingTimeoutMs(runDeadline, timeoutMessage),
      timeoutMessage,
    );
    if (endpointCandidates.length <= 0) {
      const result = buildInconclusiveResult({
        channelId,
        routeId: context.routeId,
        modelName: context.modelName,
        fingerprintId,
        question,
        latencyMs: Date.now() - startedAtMs,
        reason: '没有可用的上游端点候选',
        endpoint: null,
        config: context.config,
        trigger,
        failStreak: resolveCandyFailStreak({ channelId, config: context.config, verdict: 'inconclusive' }),
      });
      return finish(result);
    }

    const oauthProviderHeaders = buildOauthProviderHeaders({
      account: context.account,
      downstreamHeaders: {},
    });
    const providerHeaders = {
      ...oauthProviderHeaders,
      ...fingerprint.buildProviderHeaders(fingerprintInput),
    };
    const openaiBody = fingerprint.buildOpenAiBody(fingerprintInput);
    const claudeBody = fingerprint.buildClaudeBody?.(fingerprintInput);
    const responsesBody = fingerprint.buildResponsesBody?.(fingerprintInput);
    const channelProxyUrl = resolveChannelProxyUrl(context.site, context.account.extraConfig);
    // The identity the probe wears is the identity the site already gives real traffic
    // (openAiResponsesSurface reads the same setting): when the site has Codex identity
    // synthesis off, a real Codex request carries no synthesized metadata, and a probe that
    // added it would be measuring a different request than the one it stands in for — the
    // debian box runs 39 of 41 sites with synthesis off. `codex_chat` pins OFF explicitly:
    // the chat surface has no identity synthesis at all, whatever the site says.
    const probeCodexIdentityMode: 'off' | 'synthesize' | undefined = (
      fingerprintId === 'codex_chat' ? 'off' : context.site.codexIdentityMode as 'off' | 'synthesize' | undefined
    );

    // Debug traces are written by the proxy surfaces; a probe that bypassed them would be
    // invisible in 调试抓取, which is precisely where an operator looks when a probe
    // misbehaves. Tagged `candy_probe` so it is distinguishable from real traffic, and
    // subject to the same enable/target filters as everything else.
    debugTrace = await startSurfaceProxyDebugTrace({
      downstreamPath: resolveFingerprintDownstreamPath(fingerprint.downstreamFormat),
      clientKind: CANDY_PROBE_CLIENT_FAMILY,
      sessionId: null,
      traceHint: `candy-probe:${channelId}`,
      requestedModel: context.modelName,
      downstreamApiKeyId: null,
      requestHeaders: providerHeaders,
      requestBody: claudeBody ?? responsesBody ?? openaiBody,
    });
    await safeUpdateSurfaceProxyDebugSelection(debugTrace, {
      selectedChannelId: channelId,
      selectedRouteId: context.routeId,
      selectedAccountId: context.account.id ?? null,
      selectedSiteId: context.site.id,
      selectedSitePlatform: context.site.platform,
    });
    await safeUpdateSurfaceProxyDebugCandidates(debugTrace, {
      endpointCandidates,
      decisionSummary: {
        source: CANDY_PROBE_CLIENT_FAMILY,
        fingerprint: fingerprintId,
        questionId: question.id,
        // Recorded so a trace shows whether the probe looked like the CLI it claims to be.
        codexIdentityMode: probeCodexIdentityMode ?? 'off',
      },
    });

    let successfulEndpoint: UpstreamEndpoint | null = null;
    let debugAttemptIndex = 0;

    // One question, one run. The probe slot caps probe pressure on the box; the site lease
    // the pool acquires caps its pressure on the site exactly the way a real request is
    // capped — the probe is the request it stands in for.
    // Bounded by the run deadline: a timeout here rejects into the catch below (未完成).
    const releaseSlot = await acquireProbeSlot(runDeadline.deadlineAtMs, timeoutMessage);
    try {
      // Same URL-selection path as a real request (`runWithSiteApiEndpointPool`): the probe
      // hits the site's API 请求池 endpoint, rotates to the next target on the same failures
      // a real request rotates on, and records its exchanges into the pool's cooldown
      // state. A site without pool endpoints falls back to site.url — exactly what the
      // probe did before, so those sites behave identically.
      const outcome = await runWithSiteApiEndpointPool(
        context.site,
        async (target, poolContext) => {
          const buildRequest = (endpoint: UpstreamEndpoint): BuiltEndpointRequest => {
            const request = buildUpstreamEndpointRequest({
              endpoint,
              modelName: context.modelName,
              stream: fingerprint.stream,
              tokenValue: context.tokenValue,
              oauthProvider: oauth?.provider,
              oauthProjectId: oauth?.projectId,
              sitePlatform: context.site.platform,
              siteUrl: target.baseUrl,
              openaiBody,
              downstreamFormat: fingerprint.downstreamFormat,
              downstreamHeaders: {},
              providerHeaders,
              claudeOriginalBody: claudeBody,
              responsesOriginalBody: responsesBody,
              // The probe stands in for a real client, so it must look like one — and like the
              // SAME client the site's real traffic looks like: the site's Codex-identity setting
              // decides whether the synthesis runs, exactly as it does for a real request through
              // the proxy (`codex_chat` passes OFF because the chat surface never synthesizes).
              codexIdentityMode: probeCodexIdentityMode,
              codexIdentityScopeKey: `site:${context.site.id}`,
              codexIdentityTurnKey: input.requestId ?? undefined,
            });
            return {
              endpoint,
              path: request.path,
              headers: request.headers,
              body: request.body as Record<string, unknown>,
              runtime: request.runtime,
            };
          };

          const dispatchRequest = async (
            request: BuiltEndpointRequest,
            targetUrl: string,
            signal?: AbortSignal,
          ) => dispatchRuntimeRequest({
            siteUrl: target.baseUrl,
            targetUrl,
            // The flow signal carries the first-byte budget, the pool signal the run
            // deadline — composed with the same AbortSignal.any the runtime dispatch
            // uses, so a stalled upstream is cut off instead of outliving the run.
            signal: signal && poolContext.signal
              ? AbortSignal.any([signal, poolContext.signal])
              : signal ?? poolContext.signal,
            request,
            buildInit: (_requestUrl, requestForFetch) => withSiteRecordProxyRequestInit(
              context.site,
              {
                method: 'POST',
                headers: requestForFetch.headers,
                body: JSON.stringify(requestForFetch.body),
              },
              channelProxyUrl,
            ),
          });

          const flow = await executeEndpointFlow({
            siteUrl: target.baseUrl,
            // No proxyUrl here: the forwarding proxy is already injected through
            // buildInit → withSiteRecordProxyRequestInit, exactly like a real request
            // surface. endpointFlow's proxyUrl is a base-URL override, not a forwarding
            // proxy — passing one made the probe request the proxy address itself and
            // poisoned pool endpoints with failures that never happened upstream.
            endpointCandidates,
            buildRequest,
            dispatchRequest,
            // The same first-byte budget a real streamed request gets: a target that
            // accepts the connection but never starts answering rotates to the next pool
            // target instead of eating the whole run budget.
            firstByteTimeoutMs: resolveResponseTimeoutMs('stream', config),
            onAttemptSuccess: async (ctx) => {
              successfulEndpoint = ctx.request.endpoint;
              successfulUpstreamPath = ctx.request.path;
              await safeInsertSurfaceProxyDebugAttempt(debugTrace, {
                attemptIndex: debugAttemptIndex++,
                endpoint: ctx.request.endpoint,
                requestPath: ctx.request.path,
                targetUrl: ctx.targetUrl,
                runtimeExecutor: ctx.request.runtime?.executor ?? null,
                requestHeaders: ctx.request.headers,
                requestBody: ctx.request.body,
                responseStatus: ctx.response.status ?? null,
                responseHeaders: buildSurfaceProxyDebugResponseHeaders(ctx.response),
                // Streamed bodies are assembled below and handed to finalize instead.
                responseBody: await captureSurfaceProxyDebugSuccessResponseBody(debugTrace, ctx),
              });
            },
            onAttemptFailure: async (ctx) => {
              await safeInsertSurfaceProxyDebugAttempt(debugTrace, {
                attemptIndex: debugAttemptIndex++,
                endpoint: ctx.request.endpoint,
                requestPath: ctx.request.path,
                targetUrl: ctx.targetUrl,
                runtimeExecutor: ctx.request.runtime?.executor ?? null,
                requestHeaders: ctx.request.headers,
                requestBody: ctx.request.body,
                responseStatus: ctx.response?.status ?? null,
                rawErrorText: ctx.errText || null,
              });
            },
          });

          if (!flow.ok) {
            // A failed request is not a wrong answer: the model never got to answer, and
            // marking a 402/429/502 as 答错 would blame the channel's quota for its
            // arithmetic. Hand the failure to the pool so it records the endpoint failure
            // and rotates to the next target on exactly the failures a real request would
            // rotate on (transport, 5xx, first-byte); 4xx business errors come straight
            // back out and land in the run's catch as 未完成.
            throw new SiteApiEndpointRequestError(flow.errText || 'unknown error', {
              status: flow.status ?? null,
              rawErrText: flow.rawErrText ?? null,
              failureKind: flow.failureKind ?? null,
            });
          }
          const text = await readRuntimeResponseText(flow.upstream);
          return { flow, text };
        },
        {
          // The single run deadline still covers discovery and every pool rotation: a run
          // can never outlive its budget, whatever the pool does internally.
          deadlineAtMs: runDeadline.deadlineAtMs,
          // Keep the probe's own timeout wording — the pool raises this verbatim.
          timeoutMessage,
          requestScopeId: input.requestId ?? undefined,
          // A scheduled probe must not queue behind real traffic on a saturated site: it
          // gives up immediately and the fail backoff reschedules it. A manual click keeps
          // the default wait — the operator asked for this one.
          siteLeaseWaitMs: trigger === 'schedule' ? 0 : undefined,
        },
      );

      const latencyMs = Date.now() - startedAtMs;
      // The pool operation only returns on a successful exchange — every failure shape
      // leaves as SiteApiEndpointRequestError and lands in the catch below, so the flow
      // here is always the ok variant.
      const responseHeaders = buildSurfaceProxyDebugResponseHeaders(outcome.flow.upstream);

      const contentType = typeof outcome.flow.upstream.headers?.get === 'function'
        ? outcome.flow.upstream.headers.get('content-type')
        : null;
      const payload = extractCandyProbeAnswerPayload(outcome.text, contentType);
      const read = readCandyAnswer(question, payload.text);

      // A truncated or errored stream may have lost the 答案 line mid-write ("答案：2" of a
      // 21); grading the fragment would turn an upstream cut-off into a verdict. An error
      // event (Anthropic `error`, Responses `response.failed`, a mid-stream `{error}`
      // chunk) leaves no stop reason, so it counts as cut short too. Only an
      // already-correct read survives either.
      const streamErrored = !!payload.errorMessage;
      if ((isTruncatedStopReason(payload.stopReason) || streamErrored) && !read.correct) {
        const cutReason = streamErrored
          ? `上游流报错：${String(payload.errorMessage).slice(0, 120)}`
          : '输出被截断';
        const result = buildInconclusiveResult({
          channelId,
          routeId: context.routeId,
          modelName: context.modelName,
          fingerprintId,
          question,
          latencyMs,
          reason: cutReason,
          endpoint: successfulEndpoint,
          config: context.config,
          trigger,
          failStreak: resolveCandyFailStreak({ channelId, config: context.config, verdict: 'inconclusive' }),
        });
        return finish(result, {
          exchangeOk: true,
          usage: payload.usage ?? null,
          httpStatus: outcome.flow.upstream.status ?? null,
          responseHeaders,
          responseBody: { verdict: 'inconclusive', reason: cutReason, questionId: question.id },
        });
      }

      const graded = resolveCandyProbeVerdict(read);
      const sample: CandyProbeSampleResult = {
        index: 1,
        answer: read.answerText,
        correct: read.correct,
        note: buildCandyProbeSampleNote(read, payload),
      };
      const result: CandyProbeResult = {
        channelId,
        routeId: context.routeId,
        model: context.modelName,
        fingerprint: fingerprintId,
        verdict: graded.verdict,
        score: read.correct ? 1 : 0,
        total: 1,
        endpoint: successfulEndpoint,
        actualModel: payload.model ?? null,
        latencyMs,
        checkedAt: new Date().toISOString(),
        reason: buildCandyProbeReason({
          gradedReason: graded.reason,
          payloadMessage: payload.errorMessage ?? null,
          firstFailureReason: null,
        }),
        question: {
          id: question.id,
          prompt: question.prompt,
          expected: question.expectedLabel,
        },
        samples: [sample],
        validSampleCount: read.source !== 'none' && (read.correct || read.convicts) ? 1 : 0,
        expectation: resolveCandyProbeExpectation(context.modelName),
        config: context.config,
        trigger,
        failStreak: resolveCandyFailStreak({ channelId, config: context.config, verdict: graded.verdict }),
      };
      return finish(result, {
        exchangeOk: true,
        usage: payload.usage ?? null,
        httpStatus: outcome.flow.upstream.status ?? null,
        responseHeaders,
        // A streamed body is assembled here rather than in the debug capture hook, so hand the
        // parsed payload over; the trace store applies the capture settings itself.
        responseBody: {
          verdict: result.verdict,
          reason: result.reason,
          questionId: question.id,
          answer: sample.answer,
          correct: sample.correct,
          note: sample.note,
        },
      });
    } finally {
      releaseSlot();
    }
  } catch (error) {
    // A scheduled run that found the site saturated never sent anything upstream: it gave
    // up so real traffic would not wait behind it. That is not an observation about the
    // channel, so it must not replace the last verdict, bump the fail streak, write a
    // usage-log row or be copied onto identity siblings. Rethrow; the sweep logs and skips.
    if (
      trigger === 'schedule'
      && error instanceof SiteApiEndpointRequestError
      && error.siteConcurrencyTimeout
    ) {
      await safeFinalizeSurfaceProxyDebugTrace(debugTrace, {
        finalStatus: 'failed',
        finalHttpStatus: error.status ?? null,
        finalUpstreamPath: null,
        finalResponseHeaders: null,
        finalResponseBody: { skipped: 'site-busy' },
      });
      throw error;
    }
    const reason = error instanceof Error ? error.message : '探测失败';
    const result = buildInconclusiveResult({
      channelId,
      routeId: context.routeId,
      modelName: context.modelName,
      fingerprintId,
      question,
      latencyMs: Date.now() - startedAtMs,
      reason,
      endpoint: null,
      config: context.config,
      trigger,
      failStreak: resolveCandyFailStreak({ channelId, config: context.config, verdict: 'inconclusive' }),
    });
    // Upstream failures now surface as SiteApiEndpointRequestError once the pool has
    // tried every rotatable target; its status still belongs in the usage log (transport
    // errors carry null, the deadline and lease errors carry their own).
    const httpStatus = error instanceof SiteApiEndpointRequestError ? error.status : null;
    return finish(result, { exchangeOk: false, httpStatus });
  }
}
