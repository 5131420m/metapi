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
import { isUsableAccountToken } from './accountTokenService.js';
import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { buildOauthProviderHeaders } from './oauth/service.js';
import { resolveChannelProxyUrl, withSiteRecordProxyRequestInit } from './siteProxy.js';
import { dispatchRuntimeRequest } from './runtimeDispatch.js';
import { isLikelyConversationModel } from './runtimeModelProbe.js';
import { insertProxyLog } from './proxyLogStore.js';
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
import { isExactTokenRouteModelPattern } from '../../shared/tokenRoutePatterns.js';
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
export const CANDY_PROBE_MAX_TIMEOUT_MS = 600_000;
export const CANDY_PROBE_PASS_MIN_CORRECT = 2;

/** Usage-log marker, so probe traffic is identifiable and filterable in 使用日志. */
export const CANDY_PROBE_CLIENT_FAMILY = 'candy_probe';

function clampCandyProbeTimeoutMs(value: number): number {
  return Math.min(
    CANDY_PROBE_MAX_TIMEOUT_MS,
    Math.max(CANDY_PROBE_MIN_TIMEOUT_MS, Math.trunc(value)),
  );
}

/**
 * The probe's ceiling, taken from the same setting the proxy uses for a streaming request,
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
  return clampCandyProbeTimeoutMs(fromSettings > 0 ? fromSettings : CANDY_PROBE_TIMEOUT_MS);
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

export function buildCandyProbeLogLabel(result: Pick<CandyProbeResult, 'verdict' | 'score' | 'total'>): string {
  if (result.verdict === 'pass') return `糖果题 · 通过 ${result.score}/${result.total}`;
  if (result.verdict === 'fail') return `糖果题 · 疑似降智 ${result.score}/${result.total}`;
  return '糖果题 · 不确定';
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
      clientAppName: buildCandyProbeLogLabel(result),
      clientConfidence: 'high',
      errorMessage: result.verdict === 'pass' ? null : result.reason,
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
};

function resolveProbeModelName(row: CandyProbeChannelRow): string {
  const sourceModel = String(row.route_channels.sourceModel || '').trim();
  if (sourceModel) return sourceModel;
  const routeModelPattern = String(row.token_routes.modelPattern || '').trim();
  return isExactTokenRouteModelPattern(routeModelPattern) ? routeModelPattern : '';
}

function resolveProbeTokenValue(row: CandyProbeChannelRow): string | null {
  if (typeof row.route_channels.tokenId === 'number' && row.route_channels.tokenId > 0) {
    if (!row.account_tokens || !isUsableAccountToken(row.account_tokens)) return null;
    const tokenValue = String(row.account_tokens.token || '').trim();
    return tokenValue || null;
  }

  if (getOauthInfoFromAccount(row.accounts)) {
    const accessToken = String(row.accounts.accessToken || '').trim();
    return accessToken || null;
  }

  const fallbackApiToken = String(row.accounts.apiToken || '').trim();
  return fallbackApiToken || null;
}

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
 * Bound the whole probe execution — request dispatch, first-byte observation AND body
 * read — to one deadline.
 *
 * `executeEndpointFlow` only resolves once the response is usable (it observes the first
 * byte), so a relay that accepts the connection and then stalls can hang *inside* the
 * flow; and even when the flow resolves, a stream that never ends would hang the body
 * read. The earlier shape cleared the abort timer before the body read, so a mid-stream
 * stall escaped the ceiling entirely. Racing the whole execution against the remaining
 * budget closes both holes, and also works for dispatchers that ignore the abort signal.
 */
async function runProbeWithDeadline<T>(input: {
  execute: () => Promise<T>;
  deadlineAtMs: number;
  timeoutMs: number;
  abortController: AbortController;
}): Promise<T> {
  const execution = input.execute();
  // If the deadline wins the race the execution may settle later; keep that from
  // surfacing as an unhandled rejection.
  execution.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      execution,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          input.abortController.abort(new Error('candy probe deadline'));
          reject(new Error(`探测超时：上游未在 ${Math.round(input.timeoutMs / 1000)}s 内完成`));
        }, Math.max(1, input.deadlineAtMs - Date.now()));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildInconclusiveResult(input: {
  channelId: number;
  routeId: number | null;
  modelName: string;
  fingerprintId: CandyFingerprintId;
  questionCount: number;
  latencyMs: number | null;
  reason: string;
  endpoint: string | null;
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
  };
}

export async function runChannelCandyProbe(input: {
  channelId: number;
  fingerprint?: CandyFingerprintId | 'auto';
  questionCount?: number;
  requestId?: string | null;
  /** Override the probe ceiling (tests use a short one); clamped to a sane range. */
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

  const startedAtMs = Date.now();
  const oauth = getOauthInfoFromAccount(context.account);
  const fingerprintInput = {
    model: context.modelName,
    prompt: buildCandyProbePrompt(questions),
    scopeKey: `${context.site.id}:${channelId}`,
  };

  try {
    const endpointCandidates = await resolveUpstreamEndpointCandidates(
      { site: context.site, account: context.account },
      context.modelName,
      fingerprint.downstreamFormat,
      context.modelName,
      {},
      { oauthProvider: oauth?.provider },
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

    const deadlineAtMs = startedAtMs + timeoutMs;
    const abortController = new AbortController();
    const abortTimer = setTimeout(() => {
      abortController.abort(new Error(`candy probe timeout (${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);
    abortTimer.unref?.();

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
          signal: abortController.signal,
        },
        channelProxyUrl,
      ),
    });

    let successfulEndpoint: UpstreamEndpoint | null = null;
    let debugAttemptIndex = 0;
    let flowResult: Awaited<ReturnType<typeof executeEndpointFlow>>;
    let rawText = '';
    try {
      const outcome = await runProbeWithDeadline({
        deadlineAtMs,
        timeoutMs,
        abortController,
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
    } finally {
      clearTimeout(abortTimer);
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
      minCorrect: CANDY_PROBE_PASS_MIN_CORRECT,
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
    });
    return finish(result);
  }
}
