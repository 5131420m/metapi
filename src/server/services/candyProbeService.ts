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
 * The exclusion policy is a separate, later slice that reads these verdicts.
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { isUsableAccountToken } from './accountTokenService.js';
import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { buildOauthProviderHeaders } from './oauth/service.js';
import { resolveChannelProxyUrl, withSiteRecordProxyRequestInit } from './siteProxy.js';
import { dispatchRuntimeRequest } from './runtimeDispatch.js';
import { isLikelyConversationModel } from './runtimeModelProbe.js';
import {
  buildUpstreamEndpointRequest,
  resolveUpstreamEndpointCandidates,
  type UpstreamEndpoint,
} from './upstreamEndpointRuntime.js';
import { executeEndpointFlow, type BuiltEndpointRequest } from '../proxy-core/orchestration/endpointFlow.js';
import { readRuntimeResponseText } from '../proxy-core/executors/types.js';
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

/** Per-run ceiling. The probe is one small completion; 25s is generous without stalling a click. */
export const CANDY_PROBE_TIMEOUT_MS = 25_000;
export const CANDY_PROBE_PASS_MIN_CORRECT = 2;

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
}): Promise<CandyProbeResult> {
  const channelId = Math.trunc(input.channelId);
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
      return recordCandyProbeResult(result);
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

    const abortController = new AbortController();
    const abortTimer = setTimeout(() => {
      abortController.abort(new Error(`candy probe timeout (${Math.round(CANDY_PROBE_TIMEOUT_MS / 1000)}s)`));
    }, CANDY_PROBE_TIMEOUT_MS);
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
    let flowResult: Awaited<ReturnType<typeof executeEndpointFlow>>;
    try {
      flowResult = await executeEndpointFlow({
        siteUrl: context.site.url,
        proxyUrl: channelProxyUrl,
        endpointCandidates,
        buildRequest,
        dispatchRequest,
        onAttemptSuccess: (ctx) => {
          successfulEndpoint = ctx.request.endpoint;
        },
      });
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
      return recordCandyProbeResult(result);
    }

    const rawText = await readRuntimeResponseText(flowResult.upstream);
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
    return recordCandyProbeResult(result);
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
    return recordCandyProbeResult(result);
  }
}
