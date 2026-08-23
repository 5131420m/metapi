import { isUpstreamWrapperFailureText } from './upstreamFailureSignals.js';

export const DOWNSTREAM_ERROR_POLICY_MODES = [
  'off',
  'resilient',
] as const;

export type DownstreamErrorPolicyMode = typeof DOWNSTREAM_ERROR_POLICY_MODES[number];
export type CanonicalFailureProtocol = 'openai' | 'chat' | 'responses' | 'messages' | 'gemini';
export type CanonicalFailureTransport = 'http' | 'sse' | 'websocket';
export type CanonicalFailurePhase = 'precommit' | 'postcommit';
export type CanonicalFailureTerminalScope = 'attempt' | 'attempt_budget_exhausted' | 'route_exhausted';
export type CanonicalFailureOrigin =
  | 'downstream_request'
  | 'downstream_auth'
  | 'upstream'
  | 'routing'
  | 'metapi_internal';
export type CanonicalFailureCause =
  | 'request_invalid'
  | 'upstream_auth'
  | 'upstream_billing'
  | 'upstream_rate_limit'
  | 'upstream_timeout'
  | 'upstream_overload'
  | 'upstream_pool_exhausted'
  | 'invalid_upstream_response'
  | 'route_exhausted'
  | 'request_scoped_not_found'
  | 'upstream_model_unavailable'
  | 'internal_error';

export type DownstreamErrorPolicyConfig = {
  mode: DownstreamErrorPolicyMode;
  downstreamApiKeyIds: number[];
  /**
   * Opt-in: try another channel for a 400/422 that carries no marker either way.
   *
   * Optional so the ~59 existing policy literals across the tree stay valid; an absent
   * value means disabled, which is also the shipped default.
   */
  indeterminateRetry?: DownstreamIndeterminateRetryConfig;
};

export type DownstreamIndeterminateRetryConfig = {
  enabled: boolean;
  /** Include 413. Off by default: retrying re-uploads the body and may be billed twice. */
  includePayloadTooLarge: boolean;
  /** Extra channel attempts granted to indeterminate 4xx failures. */
  maxAttempts: number;
};

export type CanonicalProxyFailure = {
  origin: CanonicalFailureOrigin;
  cause: CanonicalFailureCause;
  protocol: CanonicalFailureProtocol;
  transport: CanonicalFailureTransport;
  phase: CanonicalFailurePhase;
  terminalScope: CanonicalFailureTerminalScope;
  attemptedChannelCount?: number;
  maxChannelAttempts?: number;
  eligibleChannelCount?: number;
  originalStatus?: number;
  originalType?: string;
  originalCode?: string;
  originalMessage: string;
  originalPayload?: unknown;
  requestedModel: string;
  upstreamModel?: string;
  channelId?: number;
  downstreamApiKeyId?: number | null;
};

export type PublicFailureDecision = {
  status: number;
  type: 'server_error' | 'upstream_error';
  code?: string;
  message: string;
  rewritten: boolean;
  originalPayload?: unknown;
};

export const DEFAULT_INDETERMINATE_RETRY: DownstreamIndeterminateRetryConfig = {
  enabled: false,
  includePayloadTooLarge: false,
  maxAttempts: 3,
};

/**
 * Ceiling on total upstream attempts for one downstream request, counting both ordinary
 * retries and indeterminate-4xx retries. Without it the two budgets compose
 * multiplicatively (3 ordinary + 3 indeterminate = 6 uploads of the same body).
 */
export const MAX_TOTAL_CHANNEL_ATTEMPTS = 4;

export const DEFAULT_DOWNSTREAM_ERROR_POLICY: DownstreamErrorPolicyConfig = {
  mode: 'off',
  downstreamApiKeyIds: [],
  indeterminateRetry: structuredClone(DEFAULT_INDETERMINATE_RETRY),
};

/**
 * Effective indeterminate-retry settings for one downstream key.
 *
 * Admission is deliberately the same predicate the presentation layer uses
 * (`mode === 'resilient'` AND the key is listed): the feature is a per-key service
 * level, so routing and presentation must agree on who is in scope. Anything out of
 * scope gets `enabled: false` and therefore the unchanged legacy behaviour.
 */
export function resolveIndeterminateRetryPlan(
  policy: DownstreamErrorPolicyConfig,
  downstreamApiKeyId?: number | null,
): DownstreamIndeterminateRetryConfig {
  const configured = policy.indeterminateRetry ?? DEFAULT_INDETERMINATE_RETRY;
  if (!configured.enabled) return { ...configured, enabled: false };
  if (policy.mode !== 'resilient') return { ...configured, enabled: false };
  if (typeof downstreamApiKeyId !== 'number') return { ...configured, enabled: false };
  if (!policy.downstreamApiKeyIds.includes(downstreamApiKeyId)) {
    return { ...configured, enabled: false };
  }
  return { ...configured };
}

/**
 * Retry ceiling for a surface's attempt loop, raised only for keys that opted into
 * indeterminate-4xx retries.
 *
 * This exists because the surface's `while (retryCount <= bound)` guard and the retry
 * decision must agree. A surface loop body either returns a response or `continue`s, so
 * if the toolkit authorizes a retry that the loop guard then refuses, the loop simply
 * exits and the handler returns without ever answering — the request hangs. The extra
 * budget therefore has to reach the loop bound, not just the retry predicate.
 *
 * Ordinary failures keep the base bound (enforced separately by the toolkit's
 * `maybeRetry`); only the indeterminate path may consume the raised one.
 * `MAX_TOTAL_CHANNEL_ATTEMPTS` caps the two budgets so they add rather than multiply.
 */
export function resolveIndeterminateRetryCeiling(input: {
  baseMaxRetries: number;
  policy: DownstreamErrorPolicyConfig;
  downstreamApiKeyId?: number | null;
}): number {
  const plan = resolveIndeterminateRetryPlan(input.policy, input.downstreamApiKeyId);
  if (!plan.enabled) return input.baseMaxRetries;
  // Never return less than the base. `PROXY_MAX_CHANNEL_ATTEMPTS` is operator-configurable,
  // so a deployment can set an ordinary budget larger than MAX_TOTAL_CHANNEL_ATTEMPTS; a
  // bare `Math.min` would then make this the LOOP bound for every failure type and cut the
  // operator's configured budget (measured 5 retries -> 3) the moment a key opted in —
  // enabling a resilience feature would have made routing less resilient.
  return Math.max(
    input.baseMaxRetries,
    Math.min(MAX_TOTAL_CHANNEL_ATTEMPTS - 1, input.baseMaxRetries + plan.maxAttempts),
  );
}

export function sanitizePostcommitFailureMessage(input: {
  message: string;
  downstreamApiKeyId?: number | null;
  policy: DownstreamErrorPolicyConfig;
}): string {
  if (
    input.policy.mode !== 'resilient'
    || typeof input.downstreamApiKeyId !== 'number'
    || !input.policy.downstreamApiKeyIds.includes(input.downstreamApiKeyId)
  ) {
    return input.message;
  }
  return 'The upstream stream failed after output began.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Wrapper markers frequently live ONLY in the upstream body's `error.type` /
 * `error.code`, because `summarizeUpstreamError()` keeps `error.message` and drops
 * type/code whenever a message exists. Inspect the retained original payload as well
 * as the summarized message so a relayed failure is recognized either way.
 */
function hasUpstreamWrapperFailureSignal(input: {
  message: string;
  originalType?: string;
  originalCode?: string;
  originalPayload?: unknown;
}): boolean {
  if (isUpstreamWrapperFailureText(input.message)) return true;
  if (isUpstreamWrapperFailureText(input.originalType)) return true;
  if (isUpstreamWrapperFailureText(input.originalCode)) return true;
  const payload = input.originalPayload;
  if (!isRecord(payload)) return false;
  const error = isRecord(payload.error) ? payload.error : payload;
  return isUpstreamWrapperFailureText(asTrimmedString(error.type))
    || isUpstreamWrapperFailureText(asTrimmedString(error.code));
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePositiveIntegerIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  if (value.some((item) => typeof item !== 'number' || !Number.isInteger(item) || item <= 0)) {
    throw new Error('下游终态错误策略 downstreamApiKeyIds 无效：每项必须是正整数');
  }
  return Array.from(new Set(value))
    .slice(0, 100);
}

export function parseDownstreamErrorPolicyConfig(value: unknown): DownstreamErrorPolicyConfig {
  if (value === undefined || value === null || value === '') {
    return structuredClone(DEFAULT_DOWNSTREAM_ERROR_POLICY);
  }
  if (!isRecord(value)) {
    throw new Error('下游终态错误策略格式无效：需要 object');
  }
  const mode = asTrimmedString(value.mode);
  if (!DOWNSTREAM_ERROR_POLICY_MODES.includes(mode as DownstreamErrorPolicyMode)) {
    throw new Error(`下游终态错误策略 mode 无效：${mode || '(empty)'}`);
  }
  if (value.downstreamApiKeyIds !== undefined && !Array.isArray(value.downstreamApiKeyIds)) {
    throw new Error('下游终态错误策略 downstreamApiKeyIds 无效：需要 number[]');
  }
  const downstreamApiKeyIds = normalizePositiveIntegerIds(value.downstreamApiKeyIds);
  if (mode === 'resilient' && downstreamApiKeyIds.length === 0) {
    throw new Error('韧性模式必须至少选择一个专用下游 API Key');
  }
  return {
    mode: mode as DownstreamErrorPolicyMode,
    downstreamApiKeyIds: mode === 'resilient' ? downstreamApiKeyIds : [],
    indeterminateRetry: parseIndeterminateRetryConfig(value.indeterminateRetry),
  };
}

function parseIndeterminateRetryConfig(value: unknown): DownstreamIndeterminateRetryConfig {
  if (value === undefined || value === null || value === '') {
    return structuredClone(DEFAULT_INDETERMINATE_RETRY);
  }
  if (!isRecord(value)) {
    throw new Error('不确定 4xx 重试配置格式无效：需要 object');
  }
  const enabled = value.enabled === undefined ? false : value.enabled;
  if (typeof enabled !== 'boolean') {
    throw new Error('不确定 4xx 重试 enabled 无效：需要 boolean');
  }
  const includePayloadTooLarge = value.includePayloadTooLarge === undefined
    ? false
    : value.includePayloadTooLarge;
  if (typeof includePayloadTooLarge !== 'boolean') {
    throw new Error('不确定 4xx 重试 includePayloadTooLarge 无效：需要 boolean');
  }
  const rawMaxAttempts = value.maxAttempts === undefined
    ? DEFAULT_INDETERMINATE_RETRY.maxAttempts
    : value.maxAttempts;
  if (typeof rawMaxAttempts !== 'number' || !Number.isInteger(rawMaxAttempts) || rawMaxAttempts < 1) {
    throw new Error('不确定 4xx 重试 maxAttempts 无效：需要 >= 1 的整数');
  }
  return {
    enabled,
    includePayloadTooLarge,
    maxAttempts: Math.min(rawMaxAttempts, MAX_TOTAL_CHANNEL_ATTEMPTS),
  };
}

export function inferCanonicalFailureCause(
  status: number,
  message: string,
  protocol: CanonicalFailureProtocol = 'responses',
  hasWrapperSignal = false,
): CanonicalFailureCause {
  const normalizedMessage = message.toLowerCase();
  if (/no available channel|pool exhausted/.test(normalizedMessage)) return 'route_exhausted';
  if (status === 401 || status === 403) return 'upstream_auth';
  if (status === 402 || /billing|payment|balance|insufficient credit/.test(normalizedMessage)) {
    return 'upstream_billing';
  }
  if (status === 429 || /rate.?limit|quota exceeded|too many requests/.test(normalizedMessage)) {
    return 'upstream_rate_limit';
  }
  if (status === 408 || status === 504 || /timed?\s*out|timeout|first byte/.test(normalizedMessage)) {
    return 'upstream_timeout';
  }
  if (/malformed|invalid (json|sse|response)|protocol error/.test(normalizedMessage)) {
    return 'invalid_upstream_response';
  }
  if (status === 503 || /overload|capacity/.test(normalizedMessage)) {
    return 'upstream_overload';
  }
  if (status === 404 && protocol === 'responses' && (
    normalizedMessage.includes('previous_response_not_found')
    || /previous[\s_-]*response(?:[\s_-]*(?:id|identifier))?[\s_-]*not[\s_-]*found/.test(normalizedMessage)
  )) {
    return 'request_scoped_not_found';
  }
  // A 400/413/422 that only carries an upstream relay/wrapper marker is NOT a
  // deterministic request error: a sibling channel can accept a byte-identical body.
  // The retry layer already treats these as channel-local, so classifying them as
  // `request_invalid` here would make the two layers disagree and leak a bare
  // 400/422 to the client after every channel had in fact been tried.
  if (hasWrapperSignal || isUpstreamWrapperFailureText(message)) return 'invalid_upstream_response';
  if (status === 400 || status === 413 || status === 422) return 'request_invalid';
  if (status === 404) return 'upstream_model_unavailable';
  return 'internal_error';
}

export function buildCanonicalUpstreamFailure(input: {
  status: number;
  message: string;
  protocol: CanonicalFailureProtocol;
  transport?: CanonicalFailureTransport;
  phase?: CanonicalFailurePhase;
  terminalScope?: CanonicalFailureTerminalScope;
  runtimeFailureStatus?: number | null;
  attemptedChannelCount?: number;
  maxChannelAttempts?: number;
  eligibleChannelCount?: number;
  requestedModel: string;
  upstreamModel?: string;
  channelId?: number;
  downstreamApiKeyId?: number | null;
  originalType?: string;
  originalCode?: string;
  originalPayload?: unknown;
}): CanonicalProxyFailure {
  return {
    origin: 'upstream',
    cause: inferCanonicalFailureCause(
      input.status,
      input.message,
      input.protocol,
      hasUpstreamWrapperFailureSignal({
        message: input.message,
        originalType: input.originalType,
        originalCode: input.originalCode,
        originalPayload: input.originalPayload,
      }),
    ),
    protocol: input.protocol,
    transport: input.transport ?? 'http',
    phase: input.phase ?? 'precommit',
    terminalScope: input.terminalScope ?? 'attempt',
    attemptedChannelCount: input.attemptedChannelCount,
    maxChannelAttempts: input.maxChannelAttempts,
    eligibleChannelCount: input.eligibleChannelCount,
    originalStatus: input.runtimeFailureStatus ?? input.status,
    originalType: input.originalType,
    originalCode: input.originalCode,
    originalMessage: input.message,
    originalPayload: input.originalPayload,
    requestedModel: input.requestedModel,
    upstreamModel: input.upstreamModel,
    channelId: input.channelId,
    downstreamApiKeyId: input.downstreamApiKeyId,
  };
}

export function buildCanonicalRoutingFailure(input: {
  protocol: CanonicalFailureProtocol;
  requestedModel: string;
  downstreamApiKeyId?: number | null;
  message?: string;
  transport?: CanonicalFailureTransport;
  phase?: CanonicalFailurePhase;
}): CanonicalProxyFailure {
  return {
    origin: 'routing',
    cause: 'route_exhausted',
    protocol: input.protocol,
    transport: input.transport ?? 'http',
    phase: input.phase ?? 'precommit',
    terminalScope: 'route_exhausted',
    originalStatus: 503,
    originalType: 'server_error',
    originalMessage: input.message || 'No available channels after retries',
    requestedModel: input.requestedModel,
    downstreamApiKeyId: input.downstreamApiKeyId,
  };
}

export function aggregateCanonicalFailures(
  failures: CanonicalProxyFailure[],
): CanonicalProxyFailure {
  if (failures.length === 0) {
    return {
      origin: 'routing',
      cause: 'route_exhausted',
      protocol: 'responses',
      transport: 'http',
      phase: 'precommit',
      terminalScope: 'route_exhausted',
      originalStatus: 503,
      originalMessage: 'No available channels after retries',
      requestedModel: '',
    };
  }
  const lastFailure = failures[failures.length - 1];
  const precommitFailures = failures.filter((failure) => failure.phase === 'precommit');
  if (precommitFailures.length === 0) return { ...lastFailure };
  const lastPrecommitFailure = precommitFailures[precommitFailures.length - 1];
  const distinctCauses = new Set(precommitFailures.map((failure) => failure.cause));
  if (distinctCauses.size === 1) return { ...lastPrecommitFailure };
  return {
    ...lastPrecommitFailure,
    origin: 'routing',
    cause: 'upstream_pool_exhausted',
    terminalScope: 'attempt_budget_exhausted',
    originalStatus: 503,
    originalType: undefined,
    originalCode: undefined,
    originalMessage: 'All configured upstream channels were exhausted by mixed failures.',
    // NOTE: originalPayload is deliberately NOT reset alongside type/code above — the
    // spread carries it through. Mixed causes are the common shape once indeterminate-4xx
    // retries are in play, so clearing it would drop the upstream evidence in exactly the
    // case where several different channels were actually tried.
  };
}

function isPolicyTarget(
  failure: CanonicalProxyFailure,
  policy: DownstreamErrorPolicyConfig,
): boolean {
  if (policy.mode !== 'resilient') return false;
  if (failure.origin !== 'upstream' && failure.origin !== 'routing') return false;
  if (failure.phase !== 'precommit') return false;
  if (failure.transport === 'websocket') return false;
  const downstreamApiKeyId = failure.downstreamApiKeyId;
  return typeof downstreamApiKeyId === 'number'
    && policy.downstreamApiKeyIds.includes(downstreamApiKeyId);
}

function isPolicyInScope(
  failure: CanonicalProxyFailure,
  policy: DownstreamErrorPolicyConfig,
): boolean {
  return failure.terminalScope !== 'attempt' && isPolicyTarget(failure, policy);
}

export function resolvePublicTerminalFailure(
  failure: CanonicalProxyFailure,
  policy: DownstreamErrorPolicyConfig,
): PublicFailureDecision {
  if (!isPolicyInScope(failure, policy)) {
    return {
      status: failure.originalStatus || 502,
      type: failure.originalType === 'server_error' ? 'server_error' : 'upstream_error',
      code: failure.originalCode,
      message: failure.originalMessage,
      rewritten: false,
      originalPayload: failure.originalPayload,
    };
  }

  // Deterministic client errors must reach the caller verbatim: masking a genuinely
  // malformed request as 503 sends the client into a pointless retry loop. The status
  // check is the safety net for causes we failed to infer — but it must not swallow a
  // relayed upstream wrapper failure that merely happens to arrive on a 4xx, since
  // those were retried across channels and are not the caller's fault.
  const isDeterministicRequestFailure = failure.cause === 'request_invalid'
    || (
      failure.cause !== 'invalid_upstream_response'
      && (
        failure.originalStatus === 400
        || failure.originalStatus === 413
        || failure.originalStatus === 422
      )
    );
  if (isDeterministicRequestFailure) {
    return {
      status: failure.originalStatus || 400,
      type: failure.originalType === 'server_error' ? 'server_error' : 'upstream_error',
      code: failure.originalCode,
      message: failure.originalMessage,
      rewritten: false,
      originalPayload: failure.originalPayload,
    };
  }

  switch (failure.cause) {
    case 'invalid_upstream_response':
      return {
        status: 502,
        type: 'server_error',
        code: 'metapi_invalid_upstream_response',
        message: 'The upstream returned an invalid gateway response.',
        rewritten: true,
        // Keep the upstream's own body as evidence. The neutral 502 is what the client
        // routes on (a bare relayed 422 reads like the caller's fault); the original
        // payload is what a human needs to see to diagnose which upstream refused and
        // why. Dropping it left only "invalid gateway response", which names no cause.
        originalPayload: failure.originalPayload,
      };
    case 'upstream_timeout':
      return {
        status: 504,
        type: 'server_error',
        code: 'metapi_upstream_timeout',
        message: 'The upstream request timed out after all available channels were exhausted.',
        rewritten: true,
      };
    case 'upstream_auth':
      return {
        status: 503,
        type: 'server_error',
        code: 'metapi_upstream_auth_exhausted',
        message: 'All configured upstream channels are currently unavailable.',
        rewritten: true,
      };
    case 'upstream_billing':
      return {
        status: 503,
        type: 'server_error',
        code: 'metapi_upstream_billing_exhausted',
        message: 'All configured upstream channels are currently unavailable.',
        rewritten: true,
      };
    case 'upstream_rate_limit':
      return {
        status: 503,
        type: 'server_error',
        code: 'metapi_upstream_rate_limited',
        message: 'All configured upstream channels are temporarily unavailable.',
        rewritten: true,
      };
    case 'route_exhausted':
      return {
        status: 503,
        type: 'server_error',
        code: 'metapi_no_available_channel',
        message: 'No upstream channel is currently available.',
        rewritten: true,
      };
    case 'request_scoped_not_found':
      return {
        status: 404,
        type: 'server_error',
        code: 'previous_response_not_found',
        message: 'The referenced Responses resource was not found.',
        rewritten: true,
      };
    case 'upstream_model_unavailable':
      return {
        status: 503,
        type: 'server_error',
        code: 'metapi_upstream_model_unavailable',
        message: 'The requested model is currently unavailable across all configured upstream channels.',
        rewritten: true,
      };
    case 'upstream_overload':
    case 'upstream_pool_exhausted':
    case 'internal_error':
    default:
      return {
        status: 503,
        type: 'server_error',
        code: 'metapi_upstream_pool_exhausted',
        message: 'All configured upstream channels are currently unavailable.',
        rewritten: true,
      };
  }
}

export function serializePublicTerminalFailure(
  decision: PublicFailureDecision,
  protocol: CanonicalFailureProtocol = 'chat',
): unknown {
  if (!decision.rewritten && decision.originalPayload !== undefined) {
    if (isRecord(decision.originalPayload)) {
      const payload = structuredClone(decision.originalPayload);
      if (protocol !== 'openai' && isRecord(payload.error)) {
        if (!asTrimmedString(payload.error.message)) payload.error.message = decision.message;
        if (!asTrimmedString(payload.error.type)) payload.error.type = decision.type;
      }
      return payload;
    }
    return structuredClone(decision.originalPayload);
  }
  if (protocol === 'messages' && decision.rewritten) {
    return {
      type: 'error',
      error: {
        type: 'api_error',
        message: decision.message,
        ...(buildUpstreamEvidence(decision) ?? {}),
      },
    };
  }
  return {
    error: {
      message: decision.message,
      type: decision.type === 'upstream_error' ? 'upstream_error' : decision.type,
      ...(decision.code ? { code: decision.code } : {}),
      ...(buildUpstreamEvidence(decision) ?? {}),
    },
  };
}

/**
 * Attaches the upstream's original body to a REWRITTEN decision under its own key.
 *
 * A rewritten decision must not be serialized as the upstream payload itself — that is
 * precisely the leak the rewrite exists to prevent, and the status/type/code the client
 * routes on have to stay Metapi's. Nesting the evidence keeps the public contract
 * (`error.message` / `error.type` / `error.code`) byte-identical while preserving the
 * diagnostic detail that was previously discarded.
 */
function buildUpstreamEvidence(
  decision: PublicFailureDecision,
): { upstream_error?: unknown } | null {
  if (!decision.rewritten) return null;
  if (decision.originalPayload === undefined) return null;
  return { upstream_error: structuredClone(decision.originalPayload) };
}

export function resolveAggregatedPublicTerminalFailure(
  failures: CanonicalProxyFailure[],
  fallback: CanonicalProxyFailure,
  policy: DownstreamErrorPolicyConfig,
): PublicFailureDecision {
  const targetedFailures = failures.filter((failure) => isPolicyTarget(failure, policy));
  if (targetedFailures.length === 0) {
    return resolvePublicTerminalFailure(fallback, policy);
  }
  if (!isPolicyInScope(fallback, policy)) {
    return resolvePublicTerminalFailure(fallback, policy);
  }
  if (fallback.cause === 'request_invalid' || fallback.cause === 'request_scoped_not_found') {
    return resolvePublicTerminalFailure(fallback, policy);
  }
  const aggregate = aggregateCanonicalFailures(targetedFailures);
  return resolvePublicTerminalFailure({
    ...aggregate,
    terminalScope: fallback.terminalScope,
  }, policy);
}
