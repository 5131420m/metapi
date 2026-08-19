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

export const DEFAULT_DOWNSTREAM_ERROR_POLICY: DownstreamErrorPolicyConfig = {
  mode: 'off',
  downstreamApiKeyIds: [],
};

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
  };
}

export function inferCanonicalFailureCause(
  status: number,
  message: string,
  protocol: CanonicalFailureProtocol = 'responses',
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
    cause: inferCanonicalFailureCause(input.status, input.message, input.protocol),
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

  if (
    failure.cause === 'request_invalid'
    || failure.originalStatus === 400
    || failure.originalStatus === 413
    || failure.originalStatus === 422
  ) {
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
      },
    };
  }
  return {
    error: {
      message: decision.message,
      type: decision.type === 'upstream_error' ? 'upstream_error' : decision.type,
      ...(decision.code ? { code: decision.code } : {}),
    },
  };
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
