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
  runWithDeadline,
  withTimeout,
} from './probeDeadline.js';
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
  DEFAULT_CANDY_DISCRIMINATIVE_COUNT,
  DEFAULT_CANDY_QUESTION_COUNT,
  gradeCandyProbeRun,
  selectCandyQuestions,
} from './candyProbe/questionBank.js';
import {
  getCandyFingerprint,
  resolveCandyFingerprintIdForModel,
  type CandyFingerprint,
  type CandyFingerprintId,
} from './candyProbe/fingerprints.js';
import { extractCandyProbeAnswerPayload } from './candyProbe/responseParsing.js';
import {
  getCandyProbeResultForChannel,
  getCandyProbeSnapshots,
  hydrateCandyProbeResultsFromSettings,
  recordCandyProbeResult,
  type CandyProbeConfigFingerprint,
  type CandyProbeResult,
  type CandyProbeSnapshot,
} from './candyProbe/resultStore.js';

export { getCandyProbeResultForChannel, getCandyProbeSnapshots, hydrateCandyProbeResultsFromSettings };
export type { CandyProbeResult, CandyProbeSnapshot };

/**
 * Per-run fallback ceiling. Normally the probe rides the streaming budget from settings
 * ("首字超时 / 流中途静默超时"); this value applies only when the operator disabled it (0).
 */
export const CANDY_PROBE_TIMEOUT_MS = 25_000;
export const CANDY_PROBE_MIN_TIMEOUT_MS = 1_000;
/** Re-exported from the shared module so the web's backstop cannot drift from the server. */
export { CANDY_PROBE_MAX_TIMEOUT_MS } from '../../shared/candyProbe.js';

/**
 * Floor applied to the SETTINGS-DERIVED budget only.
 *
 * The proxy's streaming setting is a first-byte / mid-stream-silence budget: it exists to
 * catch a dead upstream, and the proxy satisfies it as soon as the first byte lands. A
 * probe has to wait for a whole completion, which on a reasoning model is exactly where the
 * time goes, so reusing that number as the total budget produced false "不确定" verdicts.
 *
 * Not applied to an explicit `timeoutMs` override: that is the caller's own decision (and
 * the knob the tests use to keep a stalled-upstream case short).
 */
export const CANDY_PROBE_TIMEOUT_FLOOR_MS = 60_000;

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
 * operator removed the wait limit; a probe still needs a ceiling, so the fallback applies
 * there instead of "wait forever".
 */
export function resolveCandyProbeTimeoutMs(override?: number | null): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return clampCandyProbeTimeoutMs(override);
  }
  const fromSettings = resolveResponseTimeoutMs('stream', config);
  const budget = fromSettings > 0 ? fromSettings : CANDY_PROBE_TIMEOUT_MS;
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
 * would claim a total that excludes the prompt entirely. Derivation happens only in
 * directions that are exact — the missing side from a real total.
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
  const totalTokens = readNumber('total_tokens', 'totalTokenCount');

  if (totalTokens != null) {
    if (promptTokens == null && completionTokens != null) promptTokens = Math.max(0, totalTokens - completionTokens);
    if (completionTokens == null && promptTokens != null) completionTokens = Math.max(0, totalTokens - promptTokens);
  }

  return { promptTokens, completionTokens, totalTokens };
}

/**
 * The verdict, as one line of text.
 *
 * This used to BE the row's `client_app_name`, which meant the usage-log page's client
 * filter grew one entry per wording ("通过 2/3", "通过 3/3", …). The app name is now a
 * fixed marker and this text travels in `error_message`, where it reads as the note it is.
 */
export function buildCandyProbeLogNote(result: Pick<CandyProbeResult, 'verdict' | 'score' | 'total' | 'reason'>): string {
  const score = `${result.score}/${result.total}`;
  if (result.verdict === 'pass') return `糖果题判定：通过 ${score}`;
  if (result.verdict === 'fail') {
    return `糖果题判定：疑似降智 ${score}${result.reason ? `｜${result.reason}` : ''}`;
  }
  return `糖果题判定：不确定${result.reason ? `｜${result.reason}` : ''}`;
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
 * The probe's execution is bounded by `runWithDeadline` (see `probeDeadline.ts`) — request
 * dispatch, first-byte observation AND body read all sit inside it.
 *
 * `executeEndpointFlow` only resolves once the response is usable (it observes the first
 * byte), so a relay that accepts the connection and then stalls can hang *inside* the flow;
 * and even when the flow resolves, a stream that never ends would hang the body read. An
 * earlier shape cleared the abort timer before the body read, so a mid-stream stall escaped
 * the ceiling entirely. Racing the whole execution against the remaining budget closes both
 * holes, and also works for dispatchers that ignore the abort signal.
 */

function buildInconclusiveResult(input: {
  channelId: number;
  routeId: number | null;
  modelName: string;
  fingerprintId: CandyFingerprintId;
  questionCount: number;
  latencyMs: number | null;
  reason: string;
  endpoint: string | null;
  config: CandyProbeConfigFingerprint;
}): CandyProbeResult {
  return {
    channelId: input.channelId,
    routeId: input.routeId,
    model: input.modelName,
    fingerprint: input.fingerprintId,
    verdict: 'inconclusive',
    score: 0,
    total: input.questionCount,
    endpoint: input.endpoint,
    actualModel: null,
    latencyMs: input.latencyMs,
    checkedAt: new Date().toISOString(),
    reason: input.reason,
    parseMode: 'none',
    questions: [],
    config: input.config,
  };
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

async function acquireProbeSlot(): Promise<() => void> {
  if (activeProbes >= CANDY_PROBE_MAX_CONCURRENT) {
    await new Promise<void>((resolve) => {
      probeSlotWaiters.push(resolve);
    });
  }
  activeProbes += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeProbes = Math.max(0, activeProbes - 1);
    const next = probeSlotWaiters.shift();
    if (next) next();
  };
}

/** Test seam: the semaphore is module state, so tests must be able to see it drain. */
export function resetCandyProbeConcurrencyForTests(): void {
  activeProbes = 0;
  probeSlotWaiters.length = 0;
  inFlightProbes.clear();
}

export function runChannelCandyProbe(input: {
  channelId: number;
  fingerprint?: CandyFingerprintId | 'auto';
  questionCount?: number;
  requestId?: string | null;
  /** Override the probe ceiling (tests use a short one); clamped to a sane range. */
  timeoutMs?: number;
}): Promise<CandyProbeResult> {
  const channelId = Math.trunc(input.channelId);
  if (!Number.isFinite(channelId) || channelId <= 0) {
    return Promise.reject(new CandyProbeRequestError('无效的通道 ID', 400));
  }

  const flightKey = [
    channelId,
    input.fingerprint ?? 'auto',
    input.questionCount ?? DEFAULT_CANDY_QUESTION_COUNT,
    input.timeoutMs ?? '',
  ].join('|');
  const existing = inFlightProbes.get(flightKey);
  if (existing) return existing;

  const run = executeChannelCandyProbe(input)
    .finally(() => {
      inFlightProbes.delete(flightKey);
    });
  inFlightProbes.set(flightKey, run);
  return run;
}

async function executeChannelCandyProbe(input: {
  channelId: number;
  fingerprint?: CandyFingerprintId | 'auto';
  questionCount?: number;
  requestId?: string | null;
  timeoutMs?: number;
}): Promise<CandyProbeResult> {
  const releaseSlot = await acquireProbeSlot();
  try {
    return await runChannelCandyProbeUnbounded(input);
  } finally {
    releaseSlot();
  }
}

async function runChannelCandyProbeUnbounded(input: {
  channelId: number;
  fingerprint?: CandyFingerprintId | 'auto';
  questionCount?: number;
  requestId?: string | null;
  timeoutMs?: number;
}): Promise<CandyProbeResult> {
  const channelId = Math.trunc(input.channelId);
  const timeoutMs = resolveCandyProbeTimeoutMs(input.timeoutMs);
  if (!Number.isFinite(channelId) || channelId <= 0) {
    throw new CandyProbeRequestError('无效的通道 ID', 400);
  }

  const context = await loadChannelProbeContext(channelId);
  const fingerprintId = resolveFingerprintId(context.modelName, input.fingerprint);
  const fingerprint = getCandyFingerprint(fingerprintId);

  const questions = selectCandyQuestions({
    count: input.questionCount ?? DEFAULT_CANDY_QUESTION_COUNT,
    discriminativeCount: DEFAULT_CANDY_DISCRIMINATIVE_COUNT,
  });
  if (questions.length <= 0) {
    throw new CandyProbeRequestError('糖果题库为空，无法探测', 500);
  }

  /** Store the verdict, mirror it into the usage log, and close the debug trace. */
  let debugTrace: ProxyDebugTraceSession | null = null;
  let successfulUpstreamPath: string | null = null;
  const finish = async (
    result: CandyProbeResult,
    audit: {
      usage?: Record<string, unknown> | null;
      httpStatus?: number | null;
      responseHeaders?: Record<string, unknown> | null;
      responseBody?: unknown;
    } = {},
  ): Promise<CandyProbeResult> => {
    recordCandyProbeResult(result);
    await recordCandyProbeUsageLog({
      result,
      accountId: context.account.id ?? null,
      httpStatus: audit.httpStatus ?? null,
      usage: audit.usage ?? null,
    });
    await safeFinalizeSurfaceProxyDebugTrace(debugTrace, {
      // The probe request can succeed while the verdict is bad; the trace records the
      // request outcome, exactly like the proxy surfaces do.
      finalStatus: result.verdict === 'inconclusive' ? 'failed' : 'success',
      finalHttpStatus: audit.httpStatus ?? null,
      finalUpstreamPath: result.endpoint ? successfulUpstreamPath : null,
      finalResponseHeaders: audit.responseHeaders ?? null,
      finalResponseBody: audit.responseBody ?? null,
    });
    return result;
  };

  // One deadline for the whole run: candidate resolution and the upstream execution both
  // budget against the same instant instead of each getting a fresh full timeout.
  const deadline = createProbeDeadline(timeoutMs);
  const startedAtMs = deadline.startedAtMs;
  const timeoutMessage = candyProbeTimeoutMessage(timeoutMs);
  const oauth = getOauthInfoFromAccount(context.account);
  const fingerprintInput = {
    model: context.modelName,
    prompt: buildCandyProbePrompt(questions),
    scopeKey: `${context.site.id}:${channelId}`,
  };

  try {
    // Candidate resolution can itself talk upstream (model discovery). Bounded by the SAME
    // deadline as the rest of the run, so a slow discovery cannot push the probe past its
    // budget — the execution phase then inherits whatever is left.
    const endpointCandidates = await withTimeout(
      () => resolveUpstreamEndpointCandidates(
        { site: context.site, account: context.account },
        context.modelName,
        fingerprint.downstreamFormat,
        context.modelName,
        {},
        { oauthProvider: oauth?.provider },
      ),
      remainingTimeoutMs(deadline, timeoutMessage),
      timeoutMessage,
    );
    if (endpointCandidates.length <= 0) {
      const result = buildInconclusiveResult({
        channelId,
        routeId: context.routeId,
        modelName: context.modelName,
        fingerprintId,
        questionCount: questions.length,
        latencyMs: Date.now() - startedAtMs,
        reason: '没有可用的上游端点候选',
        endpoint: null,
        config: context.config,
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
        questionCount: questions.length,
      },
    });

    const buildRequest = (endpoint: UpstreamEndpoint): BuiltEndpointRequest => {
      const request = buildUpstreamEndpointRequest({
        endpoint,
        modelName: context.modelName,
        stream: fingerprint.stream,
        tokenValue: context.tokenValue,
        oauthProvider: oauth?.provider,
        oauthProjectId: oauth?.projectId,
        sitePlatform: context.site.platform,
        siteUrl: context.site.url,
        openaiBody,
        downstreamFormat: fingerprint.downstreamFormat,
        downstreamHeaders: {},
        providerHeaders,
        claudeOriginalBody: claudeBody,
        responsesOriginalBody: responsesBody,
        codexIdentityMode: context.site.codexIdentityMode as 'off' | 'synthesize' | undefined,
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
    ) => dispatchRuntimeRequest({
      siteUrl: context.site.url,
      targetUrl,
      request,
      buildInit: (_requestUrl, requestForFetch) => withSiteRecordProxyRequestInit(
        context.site,
        {
          method: 'POST',
          headers: requestForFetch.headers,
          body: JSON.stringify(requestForFetch.body),
          signal: deadline.abortController.signal,
        },
        channelProxyUrl,
      ),
    });

    let successfulEndpoint: UpstreamEndpoint | null = null;
    let debugAttemptIndex = 0;
    let flowResult: Awaited<ReturnType<typeof executeEndpointFlow>>;
    let rawText = '';
    {
      const outcome = await runWithDeadline({
        deadline,
        timeoutMessage,
        execute: async () => {
          const flow = await executeEndpointFlow({
            siteUrl: context.site.url,
            proxyUrl: channelProxyUrl,
            endpointCandidates,
            buildRequest,
            dispatchRequest,
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
          const text = flow.ok ? await readRuntimeResponseText(flow.upstream) : '';
          return { flow, text };
        },
      });
      flowResult = outcome.flow;
      rawText = outcome.text;
    }

    const latencyMs = Date.now() - startedAtMs;

    if (!flowResult.ok) {
      const errorText = String(flowResult.rawErrText || flowResult.errText || '').trim();
      const result = buildInconclusiveResult({
        channelId,
        routeId: context.routeId,
        modelName: context.modelName,
        fingerprintId,
        questionCount: questions.length,
        latencyMs,
        reason: `上游返回 ${flowResult.status || '错误'}${errorText ? `：${errorText.slice(0, 200)}` : ''}`,
        endpoint: successfulEndpoint,
        config: context.config,
      });
      return finish(result, { httpStatus: flowResult.status ?? null });
    }

    const contentType = typeof flowResult.upstream.headers?.get === 'function'
      ? flowResult.upstream.headers.get('content-type')
      : null;
    const payload = extractCandyProbeAnswerPayload(rawText, contentType);

    const grade = gradeCandyProbeRun({
      questions,
      text: payload.text,
      stopReason: payload.stopReason,
    });

    const result: CandyProbeResult = {
      channelId,
      routeId: context.routeId,
      model: context.modelName,
      fingerprint: fingerprintId,
      verdict: grade.verdict,
      score: grade.score,
      total: grade.total,
      endpoint: successfulEndpoint,
      actualModel: payload.model,
      latencyMs,
      checkedAt: new Date().toISOString(),
      reason: grade.reason ?? payload.errorMessage,
      parseMode: grade.parseMode,
      questions: grade.questions,
      config: context.config,
    };
    return finish(result, {
      usage: payload.usage,
      httpStatus: flowResult.upstream.status ?? 200,
      responseHeaders: buildSurfaceProxyDebugResponseHeaders(flowResult.upstream),
      // A streamed body is assembled here rather than in the debug capture hook, so hand
      // the parsed payload over; the trace store applies the capture settings itself.
      responseBody: {
        verdict: result.verdict,
        score: result.score,
        total: result.total,
        reason: result.reason,
        text: payload.text,
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : '探测失败';
    const result = buildInconclusiveResult({
      channelId,
      routeId: context.routeId,
      modelName: context.modelName,
      fingerprintId,
      questionCount: questions.length,
      latencyMs: Date.now() - startedAtMs,
      reason,
      endpoint: null,
      config: context.config,
    });
    return finish(result);
  }
}
