import { config } from '../../config.js';
import {
  buildCanonicalRoutingFailure,
  buildCanonicalUpstreamFailure,
  resolveAggregatedPublicTerminalFailure,
  resolveIndeterminateRetryCeiling,
  resolveIndeterminateRetryPlan,
  resolvePublicTerminalFailure,
  serializePublicTerminalFailure,
  MAX_TOTAL_CHANNEL_ATTEMPTS,
  type CanonicalFailureProtocol,
  type CanonicalProxyFailure,
} from '../../services/downstreamErrorPolicy.js';
import { getProxyMaxChannelRetries } from '../../services/proxyChannelRetry.js';
import {
  buildFailureSignature,
  extractOriginalErrorIdentity,
  isDeterminateRequestShapeText,
  isIndeterminate4xx,
} from '../../services/upstreamFailureSignals.js';

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

/**
 * Per-request attempt budget for the hand-rolled non-stream retry loops, including the
 * indeterminate-4xx probe.
 *
 * Two budgets, deliberately not one. An ordinary retryable failure keeps
 * `baseMaxRetries`; only an unexplained 400/422 (413 opt-in) may spend the raised
 * `maxRetries`. Collapsing them would hand every failure type an extra upstream attempt
 * the moment a key opted into a resilience feature.
 *
 * `maxRetries` MUST be the `while` loop bound. `canRetryChannelSelection()` falls back to
 * the global bound when given no third argument, so authorizing a probe the loop then
 * refuses drops the request out of the handler with no response sent — a hang, which is
 * strictly worse than the feature not working. Loop bound, ordinary guard and probe guard
 * are three halves of one decision and have to move together.
 *
 * Mirrors `sharedSurface.ts`'s `maybeRetryIndeterminate` gate-for-gate rather than
 * reimplementing the policy: same plan resolution, same ordering, same global cap.
 */
export function createNonStreamRetryBudget(input: {
  downstreamApiKeyId?: number | null;
}) {
  const policy = config.downstreamErrorPolicy;
  const baseMaxRetries = getProxyMaxChannelRetries();
  const plan = resolveIndeterminateRetryPlan(policy, input.downstreamApiKeyId);
  const ceiling = resolveIndeterminateRetryCeiling({
    baseMaxRetries,
    policy,
    downstreamApiKeyId: input.downstreamApiKeyId,
  });
  const seenSignatures = new Set<string>();
  let probesSpent = 0;

  return {
    /** Bound for ordinary retryable failures. Never raised by the probe feature. */
    baseMaxRetries,
    /** Bound the `while` loop and the probe's own guard must both use. */
    maxRetries: ceiling,
    /**
     * True when this failure earns one more channel purely because the response cannot
     * tell a malformed body from a channel-specific refusal.
     *
     * Call only AFTER the ordinary retry predicate has declined: a determinate 4xx makes
     * `shouldRetryProxyRequest` return false, and that is precisely how control reaches
     * here, so this repeats the request-shape gate rather than relying on that ordering.
     *
     * Budget and signature checks run before the seen-set is mutated — a decline must not
     * record a signature, or an attempt that was never retried would suppress a later
     * legitimate probe of the same rejection.
     */
    maybeRetryIndeterminate(args: {
      status: number;
      retryCount: number;
      errText: string;
      originalPayload?: unknown;
    }): boolean {
      if (!plan.enabled) return false;
      if (!isIndeterminate4xx(args.status, {
        includePayloadTooLarge: plan.includePayloadTooLarge,
      })) {
        return false;
      }
      // Summarized text only. A `"type":"validation_error"` envelope wrapping a
      // channel-level fault is exactly the case this exists to retry.
      if (isDeterminateRequestShapeText(args.errText)) return false;
      if (probesSpent >= plan.maxAttempts) return false;
      // One bound, two constraints: stay inside the loop bound AND inside the global
      // attempt cap, so the two budgets add rather than multiply.
      if (args.retryCount >= Math.min(ceiling, MAX_TOTAL_CHANNEL_ATTEMPTS - 1)) return false;
      const identity = extractOriginalErrorIdentity(args.originalPayload);
      const signature = buildFailureSignature({
        status: args.status,
        type: identity.type,
        code: identity.code,
        message: args.errText,
      });
      if (seenSignatures.has(signature)) return false;
      seenSignatures.add(signature);
      probesSpent += 1;
      return true;
    },
    get probeCount(): number {
      return probesSpent;
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
