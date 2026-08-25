import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fetch } from 'undici';
import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { tokenRouter } from '../../services/tokenRouter.js';
import { reportProxyAllFailed, reportTokenExpired } from '../../services/alertService.js';
import { isTokenExpiredError } from '../../services/alertRules.js';
import { shouldRetryProxyRequest } from '../../services/proxyRetryPolicy.js';
import { ensureModelAllowedForDownstreamKey, getDownstreamRoutingPolicy, recordDownstreamCostUsage } from './downstreamPolicy.js';
import {
  createNonStreamFailureAccumulator,
  createNonStreamRetryBudget,
  parseNonStreamOriginalPayload,
  resolveNonStreamTerminalFailure,
  resolveNonStreamTerminalScope,
} from '../../proxy-core/surfaces/nonStreamSurface.js';
import { withSiteRecordProxyRequestInit } from '../../services/siteProxy.js';
import { getProxyUrlFromExtraConfig } from '../../services/accountExtraConfig.js';
import { composeProxyLogMessage } from '../../services/proxyLogMessage.js';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { getProxyAuthContext } from '../../middleware/auth.js';
import { buildUpstreamUrl } from './upstreamUrl.js';
import { summarizeUpstreamError } from './upstreamError.js';
import { detectDownstreamClientContext, type DownstreamClientContext } from '../../proxy-core/downstreamClientContext.js';
import { insertProxyLog } from '../../services/proxyLogStore.js';
import { fetchWithObservedFirstByte, getObservedResponseMeta } from '../../proxy-core/firstByteTimeout.js';
import { resolveResponseTimeoutKind, resolveResponseTimeoutMs } from '../../proxy-core/responseTimeoutPolicy.js';

import { runWithSiteApiEndpointPool, SiteApiEndpointRequestError } from '../../services/siteApiEndpointService.js';
import {
  buildForcedChannelUnavailableMessage,
  canRetryChannelSelection,
  getTesterForcedChannelId,
  selectProxyChannelForAttempt,
} from '../../proxy-core/channelSelection.js';
const DEFAULT_SEARCH_MODEL = '__search';
const DEFAULT_MAX_RESULTS = 10;
const MAX_MAX_RESULTS = 20;

export async function searchProxyRoute(app: FastifyInstance) {
  app.post('/v1/search', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query) {
      return reply.code(400).send({
        error: { message: 'query is required', type: 'invalid_request_error' },
      });
    }
    if (body.stream === true) {
      return reply.code(400).send({
        error: { message: 'search does not support streaming', type: 'invalid_request_error' },
      });
    }
    const rawMaxResults = body.max_results;
    const maxResults = rawMaxResults == null
      ? DEFAULT_MAX_RESULTS
      : (typeof rawMaxResults === 'number' && Number.isInteger(rawMaxResults)
        ? rawMaxResults
        : NaN);
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_MAX_RESULTS) {
      return reply.code(400).send({
        error: {
          message: `max_results must be an integer between 1 and ${MAX_MAX_RESULTS}`,
          type: 'invalid_request_error',
        },
      });
    }

    const requestedModel = typeof body.model === 'string' && body.model.trim().length > 0
      ? body.model.trim()
      : DEFAULT_SEARCH_MODEL;

    if (!await ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;
    const downstreamPolicy = getDownstreamRoutingPolicy(request);
    const forcedChannelId = getTesterForcedChannelId({
      headers: request.headers as Record<string, unknown>,
      clientIp: request.ip,
    });
    const downstreamApiKeyId = getProxyAuthContext(request)?.keyId ?? null;
    const downstreamPath = '/v1/search';
    const clientContext = detectDownstreamClientContext({
      downstreamPath,
      headers: request.headers as Record<string, unknown>,
      body,
    });
    const firstByteTimeoutMs = resolveResponseTimeoutMs(
      resolveResponseTimeoutKind({ downstreamPath, isStream: false, body }),
      config,
    );
    const excludeChannelIds: number[] = [];
    const failureAccumulator = createNonStreamFailureAccumulator({
      protocol: 'openai',
      requestedModel,
      downstreamApiKeyId,
    });
    const retryBudget = createNonStreamRetryBudget({ downstreamApiKeyId });
    let retryCount = 0;
    const siteApiEndpointRequestScopeId = randomUUID();

    // Bound by the raised ceiling, never the base: an authorized indeterminate probe the
    // loop then refuses would exit the handler without sending anything.
    while (retryCount <= retryBudget.maxRetries) {
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
      const forwardBody = {
        ...body,
        max_results: maxResults,
        model: upstreamModel,
      };
      const startTime = Date.now();

      try {
        const { upstream, text, firstByteLatencyMs } = await runWithSiteApiEndpointPool(selected.site, async (target) => {
          const attemptStartedAtMs = Date.now();
          const targetUrl = buildUpstreamUrl(target.baseUrl, '/v1/search');
          const response = await fetchWithObservedFirstByte(
            async (signal) => fetch(targetUrl, withSiteRecordProxyRequestInit(selected.site, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${selected.tokenValue}`,
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
          const responseText = await response.text();
          if (!response.ok) {
            throw new SiteApiEndpointRequestError(summarizeUpstreamError(response.status, responseText), {
              status: response.status,
              rawErrText: responseText || null,
              firstByteLatencyMs: observedFirstByteLatencyMs,
              failureKind: observedResponseMeta?.timedOutBeforeFirstByte ? 'first-byte-timeout' : null,
            });
          }
          return {
            upstream: response,
            text: responseText,
            firstByteLatencyMs: observedFirstByteLatencyMs,
          };
        }, { requestScopeId: siteApiEndpointRequestScopeId });

        let data: any;
        try {
          data = JSON.parse(text);
        } catch {
          const errorText = 'Upstream returned malformed search JSON';
          await recordTokenRouterEventBestEffort('record malformed upstream response', () => tokenRouter.recordFailure(selected.channel.id, {
            status: 502,
            errorText,
            modelName: upstreamModel,
          }));
          logProxy(
            selected,
            requestedModel,
            'failed',
            502,
            Date.now() - startTime,
            errorText,
            retryCount,
            downstreamApiKeyId,
            clientContext,
            downstreamPath,
            false,
            firstByteLatencyMs,
          );
          const malformedAttempt = {
            status: 502,
            message: errorText,
            originalPayload: parseNonStreamOriginalPayload(text),
            terminalScope: resolveNonStreamTerminalScope({
              retryable: true,
              retryCount,
              maxRetries: retryBudget.baseMaxRetries,
            }),
            attemptedChannelCount: excludeChannelIds.length,
            maxChannelAttempts: forcedChannelId === null ? retryBudget.baseMaxRetries + 1 : 1,
            channelId: selected.channel.id,
            upstreamModel,
          };
          // Base budget only. A malformed 2xx body is reported as 502, which is never an
          // indeterminate 4xx, so the probe has nothing to add here.
          if (canRetryChannelSelection(retryCount, forcedChannelId, retryBudget.baseMaxRetries)) {
            failureAccumulator.record(malformedAttempt);
            retryCount += 1;
            continue;
          }
          await reportProxyAllFailed({ model: requestedModel, reason: errorText });
          const terminal = failureAccumulator.resolveTerminal(malformedAttempt);
          return reply.code(terminal.status).send(terminal.payload);
        }

        const latency = Date.now() - startTime;
        await recordTokenRouterEventBestEffort('record channel success', () => (
          tokenRouter.recordSuccess(selected.channel.id, latency, 0, upstreamModel)
        ));
        recordDownstreamCostUsage(request, 0);
        logProxy(
          selected,
          requestedModel,
          'success',
          upstream.status,
          latency,
          null,
          retryCount,
          downstreamApiKeyId,
          clientContext,
          downstreamPath,
          false,
          firstByteLatencyMs,
        );
        return reply.code(upstream.status).send(data);
      } catch (error: any) {
        const status = error instanceof SiteApiEndpointRequestError ? (error.status || 0) : 0;
        const errorText = error?.message || 'network error';
        const rawErrorText = error instanceof SiteApiEndpointRequestError ? error.rawErrText : null;
        const firstByteLatencyMs = error instanceof SiteApiEndpointRequestError ? error.firstByteLatencyMs : null;
        await recordTokenRouterEventBestEffort('record channel failure', () => tokenRouter.recordFailure(selected.channel.id, {
          status,
          errorText: rawErrorText || errorText,
          modelName: upstreamModel,
          failureKind: error instanceof SiteApiEndpointRequestError && error.failureKind === 'first-byte-timeout'
            ? error.failureKind
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
          clientContext,
          downstreamPath,
          false,
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
        const retryable = status > 0 ? shouldRetryProxyRequest(status, errorText, rawErrorText) : true;
        const failedAttempt = {
          status: status || 502,
          message: status > 0 ? errorText : `Upstream error: ${errorText}`,
          originalPayload: parseNonStreamOriginalPayload(error instanceof SiteApiEndpointRequestError ? error.rawErrText : errorText),
          terminalScope: resolveNonStreamTerminalScope({
            retryable,
            retryCount,
            maxRetries: retryBudget.baseMaxRetries,
          }),
          attemptedChannelCount: excludeChannelIds.length,
          maxChannelAttempts: forcedChannelId === null ? retryBudget.baseMaxRetries + 1 : 1,
          channelId: selected.channel.id,
          upstreamModel,
        };
        // Ordinary retryable failure: base budget only. The raised ceiling belongs to the
        // indeterminate probe below, or enabling that feature would quietly grant every
        // failure type an extra upstream attempt.
        if (retryable && canRetryChannelSelection(retryCount, forcedChannelId, retryBudget.baseMaxRetries)) {
          failureAccumulator.record(failedAttempt);
          retryCount += 1;
          continue;
        }
        // Unexplained 4xx: spend one more channel to tell a malformed body apart from a
        // channel that refuses one a sibling accepts. Reached only after the ordinary
        // predicate declined, which is how a determinate 4xx arrives here too — hence the
        // probe repeats the request-shape gate itself.
        if (
          status > 0
          && retryBudget.maybeRetryIndeterminate({
            status,
            retryCount,
            errText: errorText,
            originalPayload: failedAttempt.originalPayload,
          })
          && canRetryChannelSelection(retryCount, forcedChannelId, retryBudget.maxRetries)
        ) {
          failureAccumulator.record(failedAttempt);
          retryCount += 1;
          continue;
        }
        await reportProxyAllFailed({
          model: requestedModel,
          reason: errorText || 'network failure',
        });
        const terminal = failureAccumulator.resolveTerminal(failedAttempt);
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
  clientContext: DownstreamClientContext | null = null,
  downstreamPath = '/v1/search',
  isStream = false,
  firstByteLatencyMs: number | null = null,
) {
  try {
    const createdAt = formatUtcSqlDateTime(new Date());
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
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      errorMessage: composeProxyLogMessage({
        clientKind: clientContext?.clientKind && clientContext.clientKind !== 'generic'
          ? clientContext.clientKind
          : null,
        sessionId: clientContext?.sessionId || null,
        traceHint: clientContext?.traceHint || null,
        downstreamPath,
        errorMessage,
      }),
      clientFamily: clientContext?.clientKind || null,
      clientAppId: clientContext?.clientAppId || null,
      clientAppName: clientContext?.clientAppName || null,
      clientConfidence: clientContext?.clientConfidence || null,
      retryCount,
      createdAt,
    });
  } catch (error) {
    console.warn('[proxy/search] failed to write proxy log', error);
  }
}

async function recordTokenRouterEventBestEffort(
  label: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    console.warn(`[proxy/search] failed to ${label}`, error);
  }
}
