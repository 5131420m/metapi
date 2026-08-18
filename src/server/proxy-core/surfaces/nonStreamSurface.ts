import { config } from '../../config.js';
import {
  buildCanonicalRoutingFailure,
  buildCanonicalUpstreamFailure,
  resolvePublicTerminalFailure,
  serializePublicTerminalFailure,
  type CanonicalFailureProtocol,
} from '../../services/downstreamErrorPolicy.js';

export type NonStreamTerminalFailureInput = {
  protocol: CanonicalFailureProtocol;
  requestedModel: string;
  status: number;
  message: string;
  downstreamApiKeyId?: number | null;
  originalPayload?: unknown;
  cause?: 'upstream' | 'routing';
  terminalScope?: 'attempt' | 'attempt_budget_exhausted' | 'route_exhausted';
  attemptedChannelCount?: number;
  maxChannelAttempts?: number;
  eligibleChannelCount?: number;
};

export function resolveNonStreamTerminalFailure(
  input: NonStreamTerminalFailureInput,
): { status: number; payload: unknown } {
  const failure = input.cause === 'routing'
    ? buildCanonicalRoutingFailure({
      protocol: input.protocol,
      requestedModel: input.requestedModel,
      downstreamApiKeyId: input.downstreamApiKeyId,
      message: input.message,
    })
    : buildCanonicalUpstreamFailure({
      status: input.status,
      message: input.message,
      protocol: input.protocol,
      requestedModel: input.requestedModel,
      downstreamApiKeyId: input.downstreamApiKeyId,
      originalPayload: input.originalPayload,
      terminalScope: input.terminalScope ?? 'attempt',
      attemptedChannelCount: input.attemptedChannelCount,
      maxChannelAttempts: input.maxChannelAttempts,
      eligibleChannelCount: input.eligibleChannelCount,
    });
  const decision = resolvePublicTerminalFailure(failure, config.downstreamErrorPolicy);
  return {
    status: decision.status,
    payload: serializePublicTerminalFailure(decision, input.protocol),
  };
}

export function parseNonStreamOriginalPayload(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
