/**
 * Model fingerprint (identity) probe: "is this channel really the model it claims to be?"
 *
 * Sends lm-detector's three number challenges to one channel and ranks the replies against
 * the lm-detector reference bank. It complements the candy probe rather than replacing it:
 * the candy probe measures whether THIS call can reason, this one estimates WHO answers.
 *
 * Shape, mirroring `candyProbeService` on purpose:
 * - manual, one channel per click; the verdict is display-only and never feeds routing,
 *   health, cooldowns or stickiness;
 * - the requests are real requests through the site API endpoint pool (URL selection,
 *   rotation, endpoint accounting, the site lease), exactly like the candy probe's;
 * - one usage-log row per run, tagged `model_identity_probe`, cost 0;
 * - one debug trace per challenge, tagged the same way.
 *
 * Deliberate differences:
 * - the three challenges are sent ONE AFTER ANOTHER, each holding one probe slot and one site
 *   lease, so a run never takes three of a small site's slots at once;
 * - the request HEADERS wear the client identity real traffic on this box was observed to
 *   send (`observedClientIdentity`), the same identity the candy probe wears: a relay that
 *   routes by client identity decides which backend answers, and "who answers real traffic"
 *   is the question. A caller can ask for the neutral SDK identity instead (`clientIdentity:
 *   'sdk'`) to compare the two;
 * - the request BODY is always the SDK's (`buildIdentityRequestBody`), never the observed
 *   body shape: the reference bank was sampled under that body, and a ranking is only
 *   meaningful in the environment the bank was built in. Headers do not change what a model
 *   writes; a relay that rewrites the body on seeing a CLI identity can, which the detail
 *   panel says, and which the `sdk` comparison mode exists to expose.
 */

import { config } from '../config.js';
import type { schema } from '../db/index.js';
import { resolveResponseTimeoutMs } from '../proxy-core/responseTimeoutPolicy.js';
import { executeEndpointFlow, type BuiltEndpointRequest } from '../proxy-core/orchestration/endpointFlow.js';
import { readRuntimeResponseText } from '../proxy-core/executors/types.js';
import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { buildOauthProviderHeaders } from './oauth/service.js';
import { loadProbeChannelRow, resolveProbeModelName, resolveProbeTokenValue } from './channelProbeContext.js';
import { resolveChannelProxyUrl, withSiteRecordProxyRequestInit } from './siteProxy.js';
import { dispatchRuntimeRequest } from './runtimeDispatch.js';
import { isLikelyConversationModel } from './runtimeModelProbe.js';
import { insertProxyLog } from './proxyLogStore.js';
import { createProbeDeadline, remainingTimeoutMs, withTimeout } from './probeDeadline.js';
import { runWithSiteApiEndpointPool, SiteApiEndpointRequestError } from './siteApiEndpointService.js';
import {
  buildUpstreamEndpointRequest,
  resolveUpstreamEndpointCandidates,
  type UpstreamEndpoint,
} from './upstreamEndpointRuntime.js';
import {
  buildSurfaceProxyDebugResponseHeaders,
  safeFinalizeSurfaceProxyDebugTrace,
  safeInsertSurfaceProxyDebugAttempt,
  safeUpdateSurfaceProxyDebugCandidates,
  safeUpdateSurfaceProxyDebugSelection,
  startSurfaceProxyDebugTrace,
} from './proxyDebugTraceRuntime.js';
import { isCandyCodexResponsesModel } from './candyProbe/fingerprints.js';
import {
  resolveClientIdentityProfile,
  resolveSdkClientIdentityProfile,
  type ClientIdentityProfile,
} from './observedClientIdentity.js';
import {
  extractCandyProbeAnswerPayload,
  isTruncatedStopReason,
  normalizeCandyProbeUsage,
} from './candyProbe/responseParsing.js';
import { resolveCandyProbeTimeoutMs } from './candyProbeService.js';
import {
  buildIdentityRequestBody,
  generateIdentityChallenges,
  getIdentityDetector,
  minimumIdentityNumbers,
  parseIdentityNumbers,
  type IdentityChallenge,
  type IdentityDetector,
  type IdentityOutput,
} from './modelIdentityProbe/detector.js';
import { resolveIdentityVerdict } from './modelIdentityProbe/verdict.js';
import { resolveClaimedIdentity } from './modelIdentityProbe/familyMap.js';
import {
  getIdentityProbeResultForChannel,
  getIdentityProbeSnapshots,
  getIdentityProbeStoreGeneration,
  hydrateIdentityProbeResultsFromSettings,
  recordIdentityProbeResultIfCurrent,
  type IdentityProbeConfigFingerprint,
  type IdentityProbeResult,
  type IdentityProbeSnapshot,
} from './modelIdentityProbe/resultStore.js';
import {
  IDENTITY_PROBE_CLIENT_APP_NAME,
  IDENTITY_PROBE_CLIENT_FAMILY,
  IDENTITY_PROBE_MAX_TIMEOUT_MS,
  IDENTITY_PROBE_VERDICT_LABELS,
} from '../../shared/modelIdentityProbe.js';
import type {
  IdentityProbeClientIdentityMode,
  IdentityProbeRequestFormat,
  IdentityProbeSampleSummary,
} from '../../shared/modelIdentityProbe.js';

export { getIdentityProbeResultForChannel, getIdentityProbeSnapshots, hydrateIdentityProbeResultsFromSettings };
export { getLoadedIdentityBankBuiltAt } from './modelIdentityProbe/detector.js';
export type { IdentityProbeResult, IdentityProbeSnapshot };
export { IDENTITY_PROBE_CLIENT_FAMILY, IDENTITY_PROBE_MAX_TIMEOUT_MS } from '../../shared/modelIdentityProbe.js';

/** Global ceiling on runs holding an upstream request; separate from the candy probe's. */
export const IDENTITY_PROBE_MAX_CONCURRENT = 2;

export class IdentityProbeRequestError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'IdentityProbeRequestError';
    this.statusCode = statusCode;
  }
}

/**
 * The run's budget: three challenges' worth of the candy probe's single-request budget
 * (which already derives from the proxy's streaming setting, with its floor), clamped to the
 * shared ceiling. An explicit override is the caller's decision (tests use a short one).
 */
export function resolveIdentityProbeTimeoutMs(override?: number | null): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return Math.min(IDENTITY_PROBE_MAX_TIMEOUT_MS, Math.max(1_000, Math.trunc(override)));
  }
  return Math.min(IDENTITY_PROBE_MAX_TIMEOUT_MS, resolveCandyProbeTimeoutMs() * 3);
}

export function identityProbeTimeoutMessage(timeoutMs: number): string {
  return `指纹检测超时：未在 ${Math.round(timeoutMs / 1000)}s 内完成`;
}

/** Which downstream shape to send: Claude → messages, GPT/Codex → responses, others → chat. */
export function resolveIdentityRequestFormat(modelName: string): IdentityProbeRequestFormat {
  const normalized = String(modelName || '').trim().toLowerCase();
  if (normalized.includes('claude')) return 'claude';
  if (isCandyCodexResponsesModel(normalized)) return 'responses';
  return 'openai';
}

function resolveDownstreamPath(format: IdentityProbeRequestFormat): string {
  if (format === 'claude') return '/v1/messages';
  if (format === 'responses') return '/v1/responses';
  return '/v1/chat/completions';
}

function formatPercent(value: number | null): string {
  return value === null ? '' : ` · ${Math.round(value * 100)}%`;
}

/** The usage-log note: one line, fixed vocabulary, the top candidate in view. */
export function buildIdentityProbeLogNote(
  result: Pick<IdentityProbeResult, 'verdict' | 'reason' | 'prediction' | 'probability'>,
): string {
  const headline = IDENTITY_PROBE_VERDICT_LABELS[result.verdict] ?? result.verdict;
  const top = result.prediction
    ? `｜最像 ${result.prediction.displayName}${formatPercent(result.probability)}`
    : '';
  const tail = result.verdict !== 'model_match' && result.reason ? `｜${result.reason}` : '';
  return `模型指纹判定：${headline}${top}${tail}`;
}

/**
 * Sum one usage column across the challenges, or null unless EVERY challenge reported it:
 * a partial sum would claim a total that silently excludes the challenges that reported none.
 */
function sumUsageColumn(values: Array<number | null>): number | null {
  if (values.length === 0 || values.some((value) => value === null)) return null;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

type ChannelContext = {
  channelId: number;
  routeId: number;
  modelName: string;
  tokenValue: string;
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
  accountId: number | null;
  tokenId: number | null;
};

async function loadChannelContext(channelId: number): Promise<ChannelContext> {
  const row = await loadProbeChannelRow(channelId);
  if (!row) throw new IdentityProbeRequestError(`通道 #${channelId} 不存在`, 404);
  const modelName = resolveProbeModelName(row);
  if (!modelName) throw new IdentityProbeRequestError('该通道没有可用于检测的来源模型名', 400);
  if (!isLikelyConversationModel(modelName)) {
    throw new IdentityProbeRequestError(`模型 ${modelName} 不是对话模型，指纹检测不适用`, 400);
  }
  const tokenValue = resolveProbeTokenValue(row);
  if (!tokenValue) throw new IdentityProbeRequestError('该通道没有可用凭据，无法发起检测', 400);
  return {
    channelId,
    routeId: row.route_channels.routeId,
    modelName,
    tokenValue,
    account: row.accounts,
    site: row.sites,
    accountId: row.accounts.id ?? null,
    tokenId: row.route_channels.tokenId ?? null,
  };
}

// ---- concurrency -------------------------------------------------------------------------

const inFlightRuns = new Map<number, Promise<IdentityProbeResult>>();
let activeSlots = 0;
const slotWaiters: Array<() => void> = [];

/**
 * Take a probe slot, waiting no later than the run deadline. Same semaphore discipline as
 * the candy probe's `acquireProbeSlot`: a released slot is handed straight to the next
 * waiter, so a newcomer cannot slip past the queue.
 */
function acquireSlot(deadlineAtMs: number, timeoutMessage: string): Promise<() => void> {
  const makeRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = slotWaiters.shift();
      if (next) next();
      else activeSlots = Math.max(0, activeSlots - 1);
    };
  };
  if (activeSlots < IDENTITY_PROBE_MAX_CONCURRENT && slotWaiters.length === 0) {
    activeSlots += 1;
    return Promise.resolve(makeRelease());
  }
  return new Promise((resolve, reject) => {
    const waiter = () => {
      clearTimeout(timer);
      resolve(makeRelease());
    };
    const timer = setTimeout(() => {
      const index = slotWaiters.indexOf(waiter);
      if (index >= 0) slotWaiters.splice(index, 1);
      reject(new Error(timeoutMessage));
    }, Math.max(0, deadlineAtMs - Date.now()));
    timer.unref?.();
    slotWaiters.push(waiter);
  });
}

export function isIdentityProbeInFlight(channelId: number): boolean {
  return Number.isFinite(channelId) && inFlightRuns.has(Math.trunc(channelId));
}

export function resetIdentityProbeConcurrencyForTests(): void {
  activeSlots = 0;
  slotWaiters.length = 0;
  inFlightRuns.clear();
}

// ---- run ---------------------------------------------------------------------------------

export type RunChannelIdentityProbeInput = {
  channelId: number;
  requestId?: string | null;
  /** Override the run ceiling (tests use a short one). */
  timeoutMs?: number;
  /** Header identity: observed real client (default) or the neutral SDK comparison mode. */
  clientIdentity?: IdentityProbeClientIdentityMode;
};

/**
 * Run one detection round. Single-flight per channel: a second click while a run is going
 * gets the same promise, so it costs no extra upstream requests — even when the second call
 * asks for a different `clientIdentity` (it then receives the running run's result, whose
 * `identitySource` says which identity was used).
 */
export function runChannelIdentityProbe(input: RunChannelIdentityProbeInput): Promise<IdentityProbeResult> {
  const channelId = Math.trunc(input.channelId);
  if (!Number.isFinite(channelId) || channelId <= 0) {
    return Promise.reject(new IdentityProbeRequestError('无效的通道 ID', 400));
  }
  const existing = inFlightRuns.get(channelId);
  if (existing) return existing;
  const run = executeIdentityProbe({ ...input, channelId })
    .finally(() => inFlightRuns.delete(channelId));
  inFlightRuns.set(channelId, run);
  return run;
}

type ChallengeOutcome = {
  sample: IdentityProbeSampleSummary;
  /** The reply text handed to the detector; '' for a failed challenge. */
  text: string;
  endpoint: UpstreamEndpoint | null;
  responseModel: string | null;
  usage: Record<string, unknown> | null;
  httpStatus: number | null;
};

async function executeIdentityProbe(input: RunChannelIdentityProbeInput): Promise<IdentityProbeResult> {
  const channelId = input.channelId;
  const timeoutMs = resolveIdentityProbeTimeoutMs(input.timeoutMs);
  const timeoutMessage = identityProbeTimeoutMessage(timeoutMs);
  const deadline = createProbeDeadline(timeoutMs);
  // Read before the first await: a reset during the run must invalidate its verdict.
  const storeGeneration = getIdentityProbeStoreGeneration();
  const startedAtMs = Date.now();

  const context = await loadChannelContext(channelId);
  const requestFormat = resolveIdentityRequestFormat(context.modelName);
  const identitySessionSeed = `identity:${context.site.id}:${channelId}`;
  const identity: ClientIdentityProfile = input.clientIdentity === 'sdk'
    ? resolveSdkClientIdentityProfile(identitySessionSeed, context.modelName)
    : resolveClientIdentityProfile({
      downstreamFormat: requestFormat,
      sessionSeed: identitySessionSeed,
      modelName: context.modelName,
    });
  // Identity headers ride as DOWNSTREAM headers (the passthrough rules real traffic meets);
  // provider headers carry the OAuth account headers, plus the SDK identity in `sdk` mode.
  const providerHeaders = {
    ...buildOauthProviderHeaders({ account: context.account, downstreamHeaders: identity.downstreamHeaders }),
    ...identity.providerHeaders,
  };
  const baseConfig: IdentityProbeConfigFingerprint = {
    model: context.modelName,
    accountId: context.accountId,
    tokenId: context.tokenId,
    bankBuiltAt: null,
  };

  const buildResult = (partial: Partial<IdentityProbeResult> & Pick<IdentityProbeResult, 'verdict' | 'reason'>): IdentityProbeResult => {
    const claimed = resolveClaimedIdentity(context.modelName, []);
    return {
      channelId,
      routeId: context.routeId,
      model: context.modelName,
      decision: null,
      prediction: null,
      candidates: [],
      probability: null,
      probabilityStatus: 'unavailable',
      claimedModel: claimed.claimedModel,
      claimedFamily: claimed.claimedFamily,
      claimedFamilyName: claimed.claimedFamilyName,
      claimedRank: null,
      claimedProbability: null,
      modelLike: null,
      usedOutputs: 0,
      samples: [],
      requestFormat,
      endpoint: null,
      actualModel: null,
      latencyMs: Date.now() - startedAtMs,
      checkedAt: new Date().toISOString(),
      config: baseConfig,
      trigger: 'manual',
      identitySource: identity.source,
      identityUserAgent: identity.userAgent,
      ...partial,
    };
  };

  const finish = async (result: IdentityProbeResult, outcomes: ChallengeOutcome[]): Promise<IdentityProbeResult> => {
    recordIdentityProbeResultIfCurrent(result, storeGeneration);
    await recordUsageLog(result, context.accountId, outcomes);
    return result;
  };

  // 1. The reference bank first: without it nothing can be scored, and spending the
  //    channel's quota on replies nobody can rank would be pure waste.
  let detector: IdentityDetector;
  try {
    detector = await withTimeout(
      () => getIdentityDetector(),
      remainingTimeoutMs(deadline, timeoutMessage),
      timeoutMessage,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finish(buildResult({ verdict: 'inconclusive', reason: `参考库不可用：${message}`.slice(0, 300) }), []);
  }
  const config_: IdentityProbeConfigFingerprint = { ...baseConfig, bankBuiltAt: detector.builtAt };

  // 2. Endpoint candidates, once for all three challenges.
  const oauth = getOauthInfoFromAccount(context.account);
  let endpointCandidates: UpstreamEndpoint[];
  try {
    endpointCandidates = await withTimeout(
      () => resolveUpstreamEndpointCandidates(
        { site: context.site, account: context.account },
        context.modelName,
        requestFormat,
        context.modelName,
        {},
        { oauthProvider: oauth?.provider },
      ),
      remainingTimeoutMs(deadline, timeoutMessage),
      timeoutMessage,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '端点解析失败';
    return finish(buildResult({ verdict: 'inconclusive', reason: message, config: config_ }), []);
  }
  if (endpointCandidates.length <= 0) {
    return finish(buildResult({ verdict: 'inconclusive', reason: '没有可用的上游端点候选', config: config_ }), []);
  }

  // 3. Three challenges, one after another, all wearing one identity (one session id).
  const challenges = generateIdentityChallenges();
  const outcomes: ChallengeOutcome[] = [];
  for (let index = 0; index < challenges.length; index += 1) {
    const challenge = challenges[index]!;
    outcomes.push(await runChallenge({
      context,
      challenge,
      index: index + 1,
      requestFormat,
      endpointCandidates,
      identity,
      providerHeaders,
      oauth,
      deadlineAtMs: deadline.deadlineAtMs,
      timeoutMessage,
      requestId: input.requestId ?? null,
    }));
  }

  const firstOk = outcomes.find((outcome) => outcome.endpoint !== null) ?? null;
  const shared = {
    samples: outcomes.map((outcome) => outcome.sample),
    endpoint: firstOk?.endpoint ?? null,
    actualModel: outcomes.find((outcome) => outcome.responseModel)?.responseModel ?? null,
    config: config_,
  };

  // 4. Score. Nothing accepted → nothing to rank.
  if (!outcomes.some((outcome) => outcome.sample.accepted)) {
    const firstError = outcomes.find((outcome) => outcome.sample.error)?.sample.error ?? null;
    return finish(buildResult({
      verdict: 'inconclusive',
      reason: firstError ? `没有可评分的回答：${firstError}` : '没有可评分的回答（整数个数不足）',
      ...shared,
    }), outcomes);
  }

  const outputs: IdentityOutput[] = outcomes.map((outcome, index) => ({
    text: outcome.sample.accepted ? outcome.text : '',
    expected_count: challenges[index]!.expected_count,
  }));
  let resolution: ReturnType<typeof resolveIdentityVerdict>;
  try {
    resolution = resolveIdentityVerdict(detector.analyze(outputs), context.modelName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finish(buildResult({ verdict: 'inconclusive', reason: `评分失败：${message}`.slice(0, 300), ...shared }), outcomes);
  }

  return finish(buildResult({
    verdict: resolution.verdict,
    reason: resolution.reason,
    decision: resolution.decision,
    prediction: resolution.prediction,
    candidates: resolution.candidates,
    probability: resolution.probability,
    probabilityStatus: resolution.probabilityStatus,
    claimedModel: resolution.claimedModel,
    claimedFamily: resolution.claimedFamily,
    claimedFamilyName: resolution.claimedFamilyName,
    claimedRank: resolution.claimedRank,
    claimedProbability: resolution.claimedProbability,
    modelLike: resolution.modelLike,
    usedOutputs: resolution.usedOutputs,
    ...shared,
  }), outcomes);
}

async function runChallenge(input: {
  context: ChannelContext;
  challenge: IdentityChallenge;
  index: number;
  requestFormat: IdentityProbeRequestFormat;
  endpointCandidates: UpstreamEndpoint[];
  identity: ClientIdentityProfile;
  providerHeaders: Record<string, string>;
  oauth: ReturnType<typeof getOauthInfoFromAccount>;
  deadlineAtMs: number;
  timeoutMessage: string;
  requestId: string | null;
}): Promise<ChallengeOutcome> {
  const { context, challenge } = input;
  const startedAtMs = Date.now();
  const expectedCount = challenge.expected_count;
  const failed = (error: string, extra: Partial<ChallengeOutcome> = {}): ChallengeOutcome => ({
    sample: {
      index: input.index,
      state: 'failed',
      count: 0,
      expectedCount,
      accepted: false,
      responseModel: extra.responseModel ?? null,
      latencyMs: Date.now() - startedAtMs,
      error: error.slice(0, 300),
    },
    text: '',
    endpoint: extra.endpoint ?? null,
    responseModel: extra.responseModel ?? null,
    usage: extra.usage ?? null,
    httpStatus: extra.httpStatus ?? null,
  });

  const openaiBody = buildIdentityRequestBody('openai', context.modelName, challenge.prompt);
  const claudeBody = buildIdentityRequestBody('claude', context.modelName, challenge.prompt);
  const responsesBody = buildIdentityRequestBody('responses', context.modelName, challenge.prompt);
  const channelProxyUrl = resolveChannelProxyUrl(context.site, context.account.extraConfig);
  // Same rule as the candy probe: a client identity follows the site's Codex identity
  // setting (it only adds `client_metadata` and headers, never prompt text); the chat
  // surface and the neutral SDK identity never synthesize one.
  const codexIdentityMode: 'off' | 'synthesize' | undefined = (
    input.identity.source === 'sdk' || input.requestFormat === 'openai'
      ? 'off'
      : context.site.codexIdentityMode as 'off' | 'synthesize' | undefined
  );

  const debugTrace = await startSurfaceProxyDebugTrace({
    downstreamPath: resolveDownstreamPath(input.requestFormat),
    clientKind: IDENTITY_PROBE_CLIENT_FAMILY,
    sessionId: null,
    traceHint: `identity-probe:${context.channelId}:${input.index}`,
    requestedModel: context.modelName,
    downstreamApiKeyId: null,
    requestHeaders: { ...input.identity.downstreamHeaders, ...input.providerHeaders },
    requestBody: input.requestFormat === 'claude' ? claudeBody : input.requestFormat === 'responses' ? responsesBody : openaiBody,
  });
  await safeUpdateSurfaceProxyDebugSelection(debugTrace, {
    selectedChannelId: context.channelId,
    selectedRouteId: context.routeId,
    selectedAccountId: context.accountId,
    selectedSiteId: context.site.id,
    selectedSitePlatform: context.site.platform,
  });
  await safeUpdateSurfaceProxyDebugCandidates(debugTrace, {
    endpointCandidates: input.endpointCandidates,
    decisionSummary: {
      source: IDENTITY_PROBE_CLIENT_FAMILY,
      challengeId: challenge.id,
      expectedCount,
      identitySource: input.identity.source,
      identityUserAgent: input.identity.userAgent,
      codexIdentityMode: codexIdentityMode ?? 'off',
    },
  });

  let successfulEndpoint: UpstreamEndpoint | null = null;
  let successfulPath: string | null = null;
  let attemptIndex = 0;
  let releaseSlot: (() => void) | null = null;
  try {
    releaseSlot = await acquireSlot(input.deadlineAtMs, input.timeoutMessage);
    const outcome = await runWithSiteApiEndpointPool(
      context.site,
      async (target, poolContext) => {
        const buildRequest = (endpoint: UpstreamEndpoint): BuiltEndpointRequest => {
          const request = buildUpstreamEndpointRequest({
            endpoint,
            modelName: context.modelName,
            stream: true,
            tokenValue: context.tokenValue,
            oauthProvider: input.oauth?.provider,
            oauthProjectId: input.oauth?.projectId,
            sitePlatform: context.site.platform,
            siteUrl: target.baseUrl,
            openaiBody,
            downstreamFormat: input.requestFormat,
            downstreamHeaders: input.identity.downstreamHeaders,
            providerHeaders: input.providerHeaders,
            claudeOriginalBody: claudeBody,
            responsesOriginalBody: responsesBody,
            codexIdentityMode,
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

        // The forwarding proxy is applied in buildInit only; the endpoint flow below gets no
        // base-URL override (the candy probe's M1 lesson, pinned by the architecture test).
        const flow = await executeEndpointFlow({
          siteUrl: target.baseUrl,
          endpointCandidates: input.endpointCandidates,
          buildRequest,
          dispatchRequest: (request, targetUrl, signal) => dispatchRuntimeRequest({
            siteUrl: target.baseUrl,
            targetUrl,
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
          }),
          firstByteTimeoutMs: resolveResponseTimeoutMs('stream', config),
          onAttemptSuccess: async (ctx) => {
            successfulEndpoint = ctx.request.endpoint;
            successfulPath = ctx.request.path;
            await safeInsertSurfaceProxyDebugAttempt(debugTrace, {
              attemptIndex: attemptIndex++,
              endpoint: ctx.request.endpoint,
              requestPath: ctx.request.path,
              targetUrl: ctx.targetUrl,
              runtimeExecutor: ctx.request.runtime?.executor ?? null,
              requestHeaders: ctx.request.headers,
              requestBody: ctx.request.body,
              responseStatus: ctx.response.status ?? null,
              responseHeaders: buildSurfaceProxyDebugResponseHeaders(ctx.response),
              responseBody: null,
            });
          },
          onAttemptFailure: async (ctx) => {
            await safeInsertSurfaceProxyDebugAttempt(debugTrace, {
              attemptIndex: attemptIndex++,
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
        deadlineAtMs: input.deadlineAtMs,
        timeoutMessage: input.timeoutMessage,
        requestScopeId: input.requestId ? `${input.requestId}:${input.index}` : undefined,
      },
    );

    const httpStatus = outcome.flow.upstream.status ?? null;
    const contentType = typeof outcome.flow.upstream.headers?.get === 'function'
      ? outcome.flow.upstream.headers.get('content-type')
      : null;
    const payload = extractCandyProbeAnswerPayload(outcome.text, contentType);
    const count = parseIdentityNumbers(payload.text).length;
    const accepted = count >= minimumIdentityNumbers(expectedCount);
    const truncated = isTruncatedStopReason(payload.stopReason);

    await safeFinalizeSurfaceProxyDebugTrace(debugTrace, {
      finalStatus: 'success',
      finalHttpStatus: httpStatus,
      finalUpstreamPath: successfulPath,
      finalResponseHeaders: buildSurfaceProxyDebugResponseHeaders(outcome.flow.upstream),
      finalResponseBody: { challengeId: challenge.id, expectedCount, count, accepted, stopReason: payload.stopReason },
    });

    const responseModel = payload.model ?? null;
    if (!accepted) {
      const reason = truncated
        ? `输出被截断（${count}/${expectedCount} 个整数）`
        : payload.errorMessage
          ? String(payload.errorMessage)
          : `整数个数不足（${count}，至少需要 ${minimumIdentityNumbers(expectedCount)}）`;
      const rejected = failed(reason, { endpoint: successfulEndpoint, responseModel, usage: payload.usage ?? null, httpStatus });
      return { ...rejected, sample: { ...rejected.sample, count } };
    }
    return {
      sample: {
        index: input.index,
        state: truncated ? 'truncated' : 'complete',
        count,
        expectedCount,
        accepted: true,
        responseModel,
        latencyMs: Date.now() - startedAtMs,
        error: null,
      },
      text: payload.text,
      endpoint: successfulEndpoint,
      responseModel,
      usage: payload.usage ?? null,
      httpStatus,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '请求失败';
    const httpStatus = error instanceof SiteApiEndpointRequestError ? error.status : null;
    await safeFinalizeSurfaceProxyDebugTrace(debugTrace, {
      finalStatus: 'failed',
      finalHttpStatus: httpStatus,
      finalUpstreamPath: null,
      finalResponseHeaders: null,
      finalResponseBody: null,
    });
    return failed(message, { httpStatus });
  } finally {
    releaseSlot?.();
  }
}

/** One usage-log row per run. Audit only: a logging failure never fails the probe. */
async function recordUsageLog(
  result: IdentityProbeResult,
  accountId: number | null,
  outcomes: ChallengeOutcome[],
): Promise<void> {
  try {
    const usages = outcomes.map((outcome) => normalizeCandyProbeUsage(outcome.usage));
    const lastStatus = [...outcomes].reverse().find((outcome) => outcome.httpStatus !== null)?.httpStatus ?? null;
    await insertProxyLog({
      routeId: result.routeId ?? null,
      channelId: result.channelId,
      accountId,
      modelRequested: result.model,
      modelActual: result.actualModel,
      status: result.verdict === 'inconclusive' ? 'failed' : 'success',
      httpStatus: lastStatus,
      isStream: true,
      latencyMs: result.latencyMs,
      promptTokens: sumUsageColumn(usages.map((usage) => usage.promptTokens)),
      completionTokens: sumUsageColumn(usages.map((usage) => usage.completionTokens)),
      totalTokens: sumUsageColumn(usages.map((usage) => usage.totalTokens)),
      estimatedCost: 0,
      clientFamily: IDENTITY_PROBE_CLIENT_FAMILY,
      clientAppName: IDENTITY_PROBE_CLIENT_APP_NAME,
      clientConfidence: 'high',
      errorMessage: buildIdentityProbeLogNote(result),
      retryCount: 0,
    });
  } catch {
    // Audit-only.
  }
}
