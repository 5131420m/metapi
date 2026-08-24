import { config } from '../../config.js';
import {
  buildCanonicalRoutingFailure,
  buildCanonicalUpstreamFailure,
  resolveAggregatedPublicTerminalFailure,
  resolvePublicTerminalFailure,
  serializePublicTerminalFailure,
  type CanonicalFailureProtocol,
  type CanonicalProxyFailure,
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

/**
 * Which terminal scope a non-stream route should report for a failure it is about to
 * relay downstream.
 *
 * `attempt_budget_exhausted` is a claim about the ATTEMPT BUDGET, not about whether the
 * failure was retryable in principle: `isPolicyInScope()` reads it as permission to
 * neutralize the upstream's own status into a generic 503. Deriving it from "the retry
 * guard refused" conflates two different refusals — `canRetryChannelSelection()` also
 * returns false for a forced channel regardless of `retryCount`, so a pinned first
 * attempt was reported as an exhausted budget and the model tester received a rewritten
 * 503 instead of the upstream error it exists to display.
 *
 * The counter is the same one the shared surfaces use (`sharedSurface.ts`:
 * `retryCount >= maxRetries` against the base bound, with no forced-channel special
 * case) and it covers that scenario on its own: forced mode never increments
 * `retryCount`, so the count stays below the bound and the failure stays `attempt`.
 * The `retryable` gate is the other half — a determinate request defect is the caller's
 * fault and must reach them unchanged even once the budget really is gone.
 */
export function resolveNonStreamTerminalScope(input: {
  retryable: boolean;
  retryCount: number;
  maxRetries: number;
}): 'attempt' | 'attempt_budget_exhausted' {
  if (!input.retryable) return 'attempt';
  return input.retryCount >= input.maxRetries ? 'attempt_budget_exhausted' : 'attempt';
}

/**
 * Per-request failure accumulator for the hand-rolled non-stream retry loops.
 *
 * `resolveNonStreamTerminalFailure()` sees ONE failure — the last one — so a request
 * that burned several channels reported only the final channel's error. The shared
 * surfaces instead collect every precommit failure and resolve them together
 * (`sharedSurface.ts` `terminalFailures[]` -> `resolveAggregatedPublicTerminalFailure`),
 * which is what makes "same cause across channels keeps its specific status, mixed
 * causes collapse to one pool-exhausted answer" work. Since these routes retry up to
 * `getProxyMaxChannelRetries()` times, multi-failure requests are the normal shape here,
 * not an edge case.
 *
 * Deliberately NOT the surface toolkit itself: `createSurfaceFailureToolkit()` takes a
 * surface lifecycle (SSE commit state, warning scope, downstream transport, a raised
 * per-key attempt budget) that these routes have no notion of. This is the same
 * accumulate-then-aggregate contract with only the parts a non-stream route can answer.
 */
export function createNonStreamFailureAccumulator(input: {
  protocol: CanonicalFailureProtocol;
  requestedModel: string;
  downstreamApiKeyId?: number | null;
}) {
  const failures: CanonicalProxyFailure[] = [];

  const build = (attempt: {
    status: number;
    message: string;
    originalPayload?: unknown;
    terminalScope?: 'attempt' | 'attempt_budget_exhausted' | 'route_exhausted';
    attemptedChannelCount?: number;
    maxChannelAttempts?: number;
    channelId?: number;
    upstreamModel?: string;
  }): CanonicalProxyFailure => buildCanonicalUpstreamFailure({
    status: attempt.status,
    message: attempt.message,
    protocol: input.protocol,
    requestedModel: input.requestedModel,
    downstreamApiKeyId: input.downstreamApiKeyId,
    originalPayload: attempt.originalPayload,
    terminalScope: attempt.terminalScope ?? 'attempt',
    attemptedChannelCount: attempt.attemptedChannelCount,
    maxChannelAttempts: attempt.maxChannelAttempts,
    channelId: attempt.channelId,
    upstreamModel: attempt.upstreamModel,
  });

  return {
    /** Record one channel's failure. Call on every attempt, including retried ones. */
    record(attempt: Parameters<typeof build>[0]): void {
      failures.push(build(attempt));
    },
    /**
     * Resolve the downstream answer for the attempt the loop is giving up on.
     *
     * The final attempt is recorded here rather than by the caller so the fallback and
     * the last accumulated entry cannot disagree about scope: the aggregate carries the
     * fallback's `terminalScope`, so a mismatch would silently change whether the
     * rewrite applies at all.
     */
    resolveTerminal(attempt: Parameters<typeof build>[0]): { status: number; payload: unknown } {
      const fallback = build(attempt);
      failures.push(fallback);
      const decision = resolveAggregatedPublicTerminalFailure(
        failures,
        fallback,
        config.downstreamErrorPolicy,
      );
      return {
        status: decision.status,
        payload: serializePublicTerminalFailure(decision, input.protocol),
      };
    },
    get recordedCount(): number {
      return failures.length;
    },
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
