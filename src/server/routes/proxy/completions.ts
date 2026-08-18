import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fetch } from 'undici';
import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { tokenRouter } from '../../services/tokenRouter.js';
import { reportProxyAllFailed, reportTokenExpired } from '../../services/alertService.js';
import { isTokenExpiredError } from '../../services/alertRules.js';
import { shouldRetryProxyRequest } from '../../services/proxyRetryPolicy.js';
import { resolveProxyUsageWithSelfLogFallback } from '../../services/proxyUsageFallbackService.js';
import { mergeProxyUsage, parseProxyUsage, pullSseDataEvents } from '../../services/proxyUsageParser.js';
import { ensureModelAllowedForDownstreamKey, getDownstreamRoutingPolicy, recordDownstreamCostUsage } from './downstreamPolicy.js';
import { parseNonStreamOriginalPayload, resolveNonStreamTerminalFailure } from '../../proxy-core/surfaces/nonStreamSurface.js';
import { withSiteRecordProxyRequestInit } from '../../services/siteProxy.js';
import { getProxyUrlFromExtraConfig } from '../../services/accountExtraConfig.js';
import { composeProxyLogMessage } from '../../services/proxyLogMessage.js';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { detectProxyFailure } from '../../services/proxyFailureJudge.js';
import { resolveProxyLogBilling } from './proxyBilling.js';
import { getProxyAuthContext } from '../../middleware/auth.js';
import { buildUpstreamUrl } from './upstreamUrl.js';
import { detectDownstreamClientContext, type DownstreamClientContext } from '../../proxy-core/downstreamClientContext.js';
import { insertProxyLog } from '../../services/proxyLogStore.js';
import { fetchWithObservedFirstByte, getObservedResponseMeta } from '../../proxy-core/firstByteTimeout.js';
import { getProxyMaxChannelRetries } from '../../services/proxyChannelRetry.js';
import { runWithSiteApiEndpointPool, SiteApiEndpointRequestError } from '../../services/siteApiEndpointService.js';
import {
  buildForcedChannelUnavailableMessage,
  canRetryChannelSelection,
  getTesterForcedChannelId,
  selectProxyChannelForAttempt,
} from '../../proxy-core/channelSelection.js';
import { pipeLegacyCompletionsStream } from '../../proxy-core/surfaces/legacyCompletionsStream.js';

export async function completionsProxyRoute(app: FastifyInstance) {
  app.post('/v1/completions', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    const requestedModel = body?.model;
    if (!requestedModel) {
      return reply.code(400).send({ error: { message: 'model is required', type: 'invalid_request_error' } });
    }
    if (!await ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;
    const downstreamPolicy = getDownstreamRoutingPolicy(request);
    const forcedChannelId = getTesterForcedChannelId({
      headers: request.headers as Record<string, unknown>,
      clientIp: request.ip,
    });
    const downstreamApiKeyId = getProxyAuthContext(request)?.keyId ?? null;
    const downstreamPath = '/v1/completions';
    const clientContext = detectDownstreamClientContext({
      downstreamPath,
      headers: request.headers as Record<string, unknown>,
      body,
    });

    const isStream = body.stream === true;
    const firstByteTimeoutMs = Math.max(0, Math.trunc((config.proxyFirstByteTimeoutSec || 0) * 1000));
    const excludeChannelIds: number[] = [];
    let retryCount = 0;
    const siteApiEndpointRequestScopeId = randomUUID();

    while (retryCount <= getProxyMaxChannelRetries()) {
      const selected = await selectProxyChannelForAttempt({
        requestedModel,
        downstreamPolicy,
        excludeChannelIds,
        retryCount,
        forcedChannelId,
      });

      if (!selected) {
        const noChannelMessage = buildForcedChannelUnavailableMessage(forcedChannelId);
        await reportProxyAllFailed({
          model: requestedModel,
          reason: forcedChannelId ? noChannelMessage : 'No available channels after retries',
        });
        const terminal = resolveNonStreamTerminalFailure({
          protocol: 'openai',
          requestedModel,
          status: 503,
          message: noChannelMessage,
          downstreamApiKeyId,
          cause: 'routing',
        });
        return reply.code(terminal.status).send(terminal.payload);
      }

      excludeChannelIds.push(selected.channel.id);

      const upstreamModel = selected.actualModel || requestedModel;
      const forwardBody = { ...body, model: upstreamModel };
      const startTime = Date.now();
      try {
        const { upstream, firstByteLatencyMs } = await runWithSiteApiEndpointPool(selected.site, async (target) => {
          const attemptStartedAtMs = Date.now();
          const targetUrl = buildUpstreamUrl(target.baseUrl, '/v1/completions');
          const response = await fetchWithObservedFirstByte(
            async (signal) => fetch(targetUrl, withSiteRecordProxyRequestInit(selected.site, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${selected.tokenValue}`,
              },
              body: JSON.stringify(forwardBody),
              signal,
            }, getProxyUrlFromExtraConfig(selected.account.extraConfig))),
            {
              firstByteTimeoutMs,
              startedAtMs: attemptStartedAtMs,
            },
          );
          const observedResponseMeta = getObservedResponseMeta(response);
          const observedFirstByteLatencyMs = observedResponseMeta?.firstByteLatencyMs ?? null;
          if (!response.ok) {
            const errText = await response.text().catch(() => 'unknown error');
            throw new SiteApiEndpointRequestError(errText || 'unknown error', {
              status: response.status,
              rawErrText: errText || null,
              firstByteLatencyMs: observedFirstByteLatencyMs,
              failureKind: observedResponseMeta?.timedOutBeforeFirstByte ? 'first-byte-timeout' : null,
            });
          }
          return {
            upstream: response,
            firstByteLatencyMs: observedFirstByteLatencyMs,
          };
        }, { requestScopeId: siteApiEndpointRequestScopeId });

        if (isStream) {
          const reader = upstream.body?.getReader();
          if (!reader) {
            throw new Error('upstream completion stream has no readable body');
          }
          const streamResult = await pipeLegacyCompletionsStream({
            reader,
            commit: () => reply.raw.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            }),
            write: (chunk) => reply.raw.write(chunk),
          });
          if (streamResult.committed && !reply.raw.writableEnded && !reply.raw.destroyed) {
            reply.raw.end();
          }
          if (streamResult.status === 'failed') {
            const errorText = streamResult.errorMessage || 'completion stream failed';
            await recordTokenRouterEventBestEffort('record channel failure', () => tokenRouter.recordFailure(selected.channel.id, {
              status: 502,
              errorText,
              modelName: upstreamModel,
            }));
            logProxy(
              selected, requestedModel, 'failed', 502, Date.now() - startTime, errorText, retryCount, downstreamApiKeyId,
              0, 0, 0, 0, null, clientContext, downstreamPath, null, true, firstByteLatencyMs,
            );
            if (streamResult.committed) return;
            if (canRetryChannelSelection(retryCount, forcedChannelId)) {
              retryCount++;
              continue;
            }
            const terminal = resolveNonStreamTerminalFailure({
              protocol: 'openai',
              requestedModel,
              status: 502,
              message: errorText,
              downstreamApiKeyId,
              terminalScope: 'attempt_budget_exhausted',
              attemptedChannelCount: excludeChannelIds.length,
              maxChannelAttempts: forcedChannelId === null ? getProxyMaxChannelRetries() + 1 : 1,
            });
            return reply.code(terminal.status).send(terminal.payload);
          }
          const parsedUsage = streamResult.usage;

          const latency = Date.now() - startTime;
          const resolvedUsage = await resolveProxyUsageWithSelfLogFallback({
            site: selected.site,
            account: selected.account,
            tokenValue: selected.tokenValue,
            tokenName: selected.tokenName,
            modelName: selected.actualModel || requestedModel,
            requestStartedAtMs: startTime,
            requestEndedAtMs: startTime + latency,
            localLatencyMs: latency,
            usage: {
              promptTokens: parsedUsage.promptTokens,
              completionTokens: parsedUsage.completionTokens,
              totalTokens: parsedUsage.totalTokens,
            },
          });
          const { estimatedCost, billingDetails } = await resolveProxyLogBilling({
            site: selected.site,
            account: selected.account,
            modelName: selected.actualModel || requestedModel,
            parsedUsage,
            resolvedUsage,
          });
          await recordTokenRouterEventBestEffort('record channel success', () => (
            tokenRouter.recordSuccess(selected.channel.id, latency, estimatedCost, upstreamModel)
          ));
          recordDownstreamCostUsage(request, estimatedCost);
          logProxy(
            selected,
            requestedModel,
            'success',
            200,
            latency,
            null,
            retryCount,
            downstreamApiKeyId,
            resolvedUsage.promptTokens,
            resolvedUsage.completionTokens,
            resolvedUsage.totalTokens,
            estimatedCost,
            billingDetails,
            clientContext,
            downstreamPath,
            resolvedUsage.usageSource,
            isStream,
            firstByteLatencyMs,
          );
          return;
        }

        const rawText = await upstream.text();
        let data: any = rawText;
        try {
          data = JSON.parse(rawText);
        } catch {
          data = rawText;
        }
        const latency = Date.now() - startTime;
        const parsedUsage = parseProxyUsage(data);
        const failure = detectProxyFailure({ rawText, usage: parsedUsage });
        if (failure) {
          const errText = failure.reason;
          await recordTokenRouterEventBestEffort('record channel failure', () => tokenRouter.recordFailure(selected.channel.id, {
            status: failure.status,
            errorText: errText,
            modelName: upstreamModel,
          }));
          logProxy(
            selected,
            requestedModel,
            'failed',
            failure.status,
            latency,
            errText,
            retryCount,
            downstreamApiKeyId,
            0,
            0,
            0,
            0,
            null,
            clientContext,
            downstreamPath,
            null,
            isStream,
            firstByteLatencyMs,
          );

          if (shouldRetryProxyRequest(failure.status, errText) && canRetryChannelSelection(retryCount, forcedChannelId)) {
            retryCount += 1;
            continue;
          }

          await reportProxyAllFailed({
            model: requestedModel,
            reason: failure.reason,
          });

          const terminal = resolveNonStreamTerminalFailure({
            protocol: 'openai',
            requestedModel,
            status: failure.status,
            message: errText,
            downstreamApiKeyId,
            originalPayload: data,
            terminalScope: shouldRetryProxyRequest(failure.status, errText)
              ? 'attempt_budget_exhausted'
              : 'attempt',
            attemptedChannelCount: excludeChannelIds.length,
            maxChannelAttempts: forcedChannelId === null ? getProxyMaxChannelRetries() + 1 : 1,
          });
          return reply.code(terminal.status).send(terminal.payload);
        }

        const resolvedUsage = await resolveProxyUsageWithSelfLogFallback({
          site: selected.site,
          account: selected.account,
          tokenValue: selected.tokenValue,
          tokenName: selected.tokenName,
          modelName: selected.actualModel || requestedModel,
          requestStartedAtMs: startTime,
          requestEndedAtMs: startTime + latency,
          localLatencyMs: latency,
          usage: {
            promptTokens: parsedUsage.promptTokens,
            completionTokens: parsedUsage.completionTokens,
            totalTokens: parsedUsage.totalTokens,
          },
        });
        const { estimatedCost, billingDetails } = await resolveProxyLogBilling({
          site: selected.site,
          account: selected.account,
          modelName: selected.actualModel || requestedModel,
          parsedUsage,
          resolvedUsage,
        });

        await recordTokenRouterEventBestEffort('record channel success', () => (
          tokenRouter.recordSuccess(selected.channel.id, latency, estimatedCost, upstreamModel)
        ));
        recordDownstreamCostUsage(request, estimatedCost);
        logProxy(
          selected,
          requestedModel,
          'success',
          200,
          latency,
          null,
          retryCount,
          downstreamApiKeyId,
          resolvedUsage.promptTokens,
          resolvedUsage.completionTokens,
          resolvedUsage.totalTokens,
          estimatedCost,
          billingDetails,
          clientContext,
          downstreamPath,
          resolvedUsage.usageSource,
          isStream,
          firstByteLatencyMs,
        );
        return reply.send(data);
      } catch (err: any) {
        const status = err instanceof SiteApiEndpointRequestError ? (err.status || 0) : 0;
        const errorText = err?.message || 'network failure';
        const firstByteLatencyMs = err instanceof SiteApiEndpointRequestError ? err.firstByteLatencyMs : null;
        await recordTokenRouterEventBestEffort('record channel failure', () => tokenRouter.recordFailure(selected.channel.id, {
          status,
          errorText,
          modelName: upstreamModel,
          failureKind: err instanceof SiteApiEndpointRequestError && err.failureKind === 'first-byte-timeout'
            ? err.failureKind
            : null,
        }));
        logProxy(
          selected,
          requestedModel,
          'failed',
          status,
          Date.now() - startTime,
          errorText,
          retryCount,
          downstreamApiKeyId,
          0,
          0,
          0,
          0,
          null,
          clientContext,
          downstreamPath,
          null,
          isStream,
          firstByteLatencyMs,
        );
        if (status > 0 && isTokenExpiredError({ status, message: errorText })) {
          await reportTokenExpired({
            accountId: selected.account.id,
            username: selected.account.username,
            siteName: selected.site.name,
            detail: `HTTP ${status}`,
          });
        }
        if ((status > 0 ? shouldRetryProxyRequest(status, errorText) : true) && canRetryChannelSelection(retryCount, forcedChannelId)) {
          retryCount++;
          continue;
        }
        await reportProxyAllFailed({
          model: requestedModel,
          reason: errorText || 'network failure',
        });
        const terminal = resolveNonStreamTerminalFailure({
          protocol: 'openai',
          requestedModel,
          status: status || 502,
          message: status > 0 ? errorText : `Upstream error: ${errorText}`,
          downstreamApiKeyId,
          originalPayload: parseNonStreamOriginalPayload(err instanceof SiteApiEndpointRequestError ? err.rawErrText : errorText),
          terminalScope: (status > 0 ? shouldRetryProxyRequest(status, errorText) : true)
            ? 'attempt_budget_exhausted'
            : 'attempt',
          attemptedChannelCount: excludeChannelIds.length,
          maxChannelAttempts: forcedChannelId === null ? getProxyMaxChannelRetries() + 1 : 1,
        });
        return reply.code(terminal.status).send(terminal.payload);
      }
    }
  });
}

async function logProxy(
  selected: any,
  modelRequested: string,
  status: string,
  httpStatus: number,
  latencyMs: number,
  errorMessage: string | null,
  retryCount: number,
  downstreamApiKeyId: number | null = null,
  promptTokens = 0,
  completionTokens = 0,
  totalTokens = 0,
  estimatedCost = 0,
  billingDetails: unknown = null,
  clientContext: DownstreamClientContext | null = null,
  downstreamPath = '/v1/completions',
  usageSource: 'upstream' | 'self-log' | 'unknown' | null = null,
  isStream: boolean,
  firstByteLatencyMs: number | null,
) {
  try {
    const createdAt = formatUtcSqlDateTime(new Date());
    const normalizedErrorMessage = composeProxyLogMessage({
      clientKind: clientContext?.clientKind && clientContext.clientKind !== 'generic'
        ? clientContext.clientKind
        : null,
      sessionId: clientContext?.sessionId || null,
      traceHint: clientContext?.traceHint || null,
      downstreamPath,
      usageSource,
      errorMessage,
    });
    await insertProxyLog({
      routeId: selected.channel.routeId,
      channelId: selected.channel.id,
      accountId: selected.account.id,
      downstreamApiKeyId,
      modelRequested,
      modelActual: selected.actualModel || modelRequested,
      status,
      httpStatus,
      isStream,
      firstByteLatencyMs,
      latencyMs,
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedCost,
      billingDetails,
      clientFamily: clientContext?.clientKind || null,
      clientAppId: clientContext?.clientAppId || null,
      clientAppName: clientContext?.clientAppName || null,
      clientConfidence: clientContext?.clientConfidence || null,
      errorMessage: normalizedErrorMessage,
      retryCount,
      createdAt,
    });
  } catch (error) {
    console.warn('[proxy/completions] failed to write proxy log', error);
  }
}

async function recordTokenRouterEventBestEffort(
  label: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    console.warn(`[proxy/completions] failed to ${label}`, error);
  }
}

