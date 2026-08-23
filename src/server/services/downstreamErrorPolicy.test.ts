import { describe, expect, it } from 'vitest';

import {
  aggregateCanonicalFailures,
  buildCanonicalUpstreamFailure,
  buildCanonicalRoutingFailure,
  parseDownstreamErrorPolicyConfig,
  resolveAggregatedPublicTerminalFailure,
  resolvePublicTerminalFailure,
  serializePublicTerminalFailure,
  sanitizePostcommitFailureMessage,
} from './downstreamErrorPolicy.js';

const resilientPolicy = parseDownstreamErrorPolicyConfig({
  mode: 'resilient',
  downstreamApiKeyIds: [12],
});

function failure(status: number, message: string, downstreamApiKeyId: number | null = 12) {
  return buildCanonicalUpstreamFailure({
    status,
    message,
    protocol: 'responses',
    requestedModel: 'gpt-5.6',
    upstreamModel: 'gpt-5.6-sol',
    channelId: 99,
    downstreamApiKeyId,
    terminalScope: 'attempt_budget_exhausted',
  });
}

describe('downstream terminal error policy', () => {
  it('sanitizes scoped postcommit upstream errors without changing operational details', () => {
    const policy = {
      mode: 'resilient' as const,
      downstreamApiKeyIds: [12],
    };
    expect(sanitizePostcommitFailureMessage({
      message: 'invalid api key sk-secret from upstream vendor',
      downstreamApiKeyId: 12,
      policy,
    })).toBe('The upstream stream failed after output began.');
    expect(sanitizePostcommitFailureMessage({
      message: 'invalid api key sk-secret from upstream vendor',
      downstreamApiKeyId: 13,
      policy,
    })).toBe('invalid api key sk-secret from upstream vendor');
  });
  it('does not rewrite an attempt-level upstream failure', () => {
    const failure = {
      ...buildCanonicalUpstreamFailure({
        status: 401,
        message: 'expired upstream token',
        protocol: 'responses',
        requestedModel: 'gpt-5',
        downstreamApiKeyId: 12,
      }),
      terminalScope: 'attempt' as const,
    };

    expect(resolvePublicTerminalFailure(failure, resilientPolicy)).toMatchObject({
      status: 401,
      rewritten: false,
      message: 'expired upstream token',
    });
  });

  it('rewrites an attempt-budget-exhausted upstream auth failure', () => {
    const failure = {
      ...buildCanonicalUpstreamFailure({
        status: 401,
        message: 'expired upstream token',
        protocol: 'responses',
        requestedModel: 'gpt-5',
        downstreamApiKeyId: 12,
      }),
      terminalScope: 'attempt_budget_exhausted' as const,
    };

    expect(resolvePublicTerminalFailure(failure, resilientPolicy)).toMatchObject({
      status: 503,
      rewritten: true,
      code: 'metapi_upstream_auth_exhausted',
    });
  });

  it.each([
    [400, 'invalid parameter value'],
    [413, 'payload too large'],
    [422, 'semantic validation failed'],
  ])('preserves deterministic HTTP %i request failures after attempt exhaustion', (status, message) => {
    const failure = {
      ...buildCanonicalUpstreamFailure({
        status,
        message,
        protocol: 'responses',
        requestedModel: 'gpt-5',
        downstreamApiKeyId: 12,
      }),
      terminalScope: 'attempt_budget_exhausted' as const,
    };

    expect(resolvePublicTerminalFailure(failure, resilientPolicy)).toMatchObject({
      status,
      rewritten: false,
      message,
    });
  });

  it('requires a dedicated downstream key scope for resilient mode', () => {
    expect(() => parseDownstreamErrorPolicyConfig({
      mode: 'resilient',
      downstreamApiKeyIds: [],
    })).toThrow('韧性模式必须至少选择一个专用下游 API Key');
  });

  it('normalizes and de-duplicates dedicated downstream key ids', () => {
    expect(parseDownstreamErrorPolicyConfig({
      mode: 'resilient',
      downstreamApiKeyIds: [12, 12, 15],
    })).toEqual({
      mode: 'resilient',
      downstreamApiKeyIds: [12, 15],
    });
  });

  it('canonicalizes non-resilient modes to an empty downstream key scope', () => {
    expect(parseDownstreamErrorPolicyConfig({ mode: 'off', downstreamApiKeyIds: [12] })).toEqual({
      mode: 'off',
      downstreamApiKeyIds: [],
    });
    expect(() => parseDownstreamErrorPolicyConfig({
      mode: 'passthrough',
      downstreamApiKeyIds: [12],
    })).toThrow('mode 无效');
  });

  it('rejects invalid numeric dedicated downstream key ids', () => {
    expect(() => parseDownstreamErrorPolicyConfig({
      mode: 'resilient',
      downstreamApiKeyIds: [12, -1, 0, 1.5],
    })).toThrow('必须是正整数');
  });

  it('rejects non-numeric dedicated downstream key ids instead of coercing them', () => {
    expect(() => parseDownstreamErrorPolicyConfig({
      mode: 'resilient',
      downstreamApiKeyIds: ['12'],
    })).toThrow('必须是正整数');
  });

  it.each([
    [401, 'expired upstream token', 503, 'metapi_upstream_auth_exhausted'],
    [403, 'account forbidden', 503, 'metapi_upstream_auth_exhausted'],
    [429, 'quota exceeded', 503, 'metapi_upstream_rate_limited'],
    [504, 'upstream timed out', 504, 'metapi_upstream_timeout'],
    [502, 'invalid SSE response', 502, 'metapi_invalid_upstream_response'],
  ])('rewrites terminal upstream %i without exposing credential text', (status, message, publicStatus, publicCode) => {
    const decision = resolvePublicTerminalFailure(failure(status, message), resilientPolicy);

    expect(decision).toMatchObject({
      status: publicStatus,
      type: 'server_error',
      code: publicCode,
      rewritten: true,
    });
    expect(decision.message).not.toContain(message);
    expect(serializePublicTerminalFailure(decision)).toEqual({
      error: {
        message: decision.message,
        type: 'server_error',
        code: publicCode,
      },
    });
  });

  it('preserves a Responses request-scoped previous-response 404', () => {
    const decision = resolvePublicTerminalFailure(
      failure(404, 'previous_response_not_found: Previous response id not found'),
      resilientPolicy,
    );

    expect(decision).toMatchObject({
      status: 404,
      code: 'previous_response_not_found',
      rewritten: true,
    });
  });

  it.each(['chat', 'messages'] as const)(
    'does not classify previous-response text as a request-scoped 404 for %s',
    (protocol) => {
      const canonical = buildCanonicalUpstreamFailure({
        status: 404,
        message: 'previous_response_not_found: Previous response id not found',
        protocol,
        requestedModel: 'gpt-5.6',
        downstreamApiKeyId: 12,
        terminalScope: 'attempt_budget_exhausted',
      });

      expect(canonical.cause).toBe('upstream_model_unavailable');
      expect(resolvePublicTerminalFailure(canonical, resilientPolicy)).toMatchObject({
        status: 503,
        code: 'metapi_upstream_model_unavailable',
      });
    },
  );

  it('does not expose a generic deep-upstream model 404 to the downstream client', () => {
    const decision = resolvePublicTerminalFailure(
      failure(404, 'The model does not exist'),
      resilientPolicy,
    );

    expect(decision).toMatchObject({
      status: 503,
      code: 'metapi_upstream_model_unavailable',
      rewritten: true,
    });
  });

  it('does not treat a generic request-id 404 as a Responses continuation miss', () => {
    const decision = resolvePublicTerminalFailure(
      failure(404, 'request id req_missing was not found'),
      resilientPolicy,
    );

    expect(decision).toMatchObject({
      status: 503,
      code: 'metapi_upstream_model_unavailable',
      rewritten: true,
    });
  });

  it('preserves a deterministic terminal fallback instead of aggregating it into a transient pool failure', () => {
    const priorRetryableFailure = failure(401, 'expired upstream token');
    const deterministicPayload = {
      error: {
        type: 'invalid_request_error',
        code: 'invalid_parameter',
        message: 'invalid parameter value',
        param: 'input',
      },
    };
    const deterministicFailure = {
      ...buildCanonicalUpstreamFailure({
        status: 400,
        message: 'invalid parameter value',
        protocol: 'responses',
        requestedModel: 'gpt-5.6',
        downstreamApiKeyId: 12,
        originalPayload: deterministicPayload,
      }),
      terminalScope: 'attempt_budget_exhausted' as const,
    };

    const decision = resolveAggregatedPublicTerminalFailure(
      [priorRetryableFailure],
      deterministicFailure,
      resilientPolicy,
    );

    expect(decision).toMatchObject({
      status: 400,
      rewritten: false,
      message: 'invalid parameter value',
      originalPayload: deterministicPayload,
    });
    expect(serializePublicTerminalFailure(decision, 'responses')).toEqual(deterministicPayload);
  });

  it('classifies a relayed upstream wrapper failure on a 4xx as an upstream fault, not a request error', () => {
    const wrapperFailure = failure(422, 'Upstream returned HTTP 422: openai_error');

    expect(wrapperFailure.cause).toBe('invalid_upstream_response');
    expect(resolvePublicTerminalFailure(wrapperFailure, resilientPolicy)).toMatchObject({
      status: 502,
      code: 'metapi_invalid_upstream_response',
      rewritten: true,
    });
  });

  it('detects a wrapper marker that survives only in the retained original payload', () => {
    // The summarized message keeps error.message and drops error.type, so the
    // channel-local evidence exists solely on the original payload here.
    const wrapperFailure = buildCanonicalUpstreamFailure({
      status: 422,
      message: 'request could not be completed',
      protocol: 'responses',
      requestedModel: 'gpt-5.6',
      downstreamApiKeyId: 12,
      terminalScope: 'attempt_budget_exhausted',
      originalPayload: {
        error: {
          message: 'request could not be completed',
          type: 'bad_response_status_code',
        },
      },
    });

    expect(wrapperFailure.cause).toBe('invalid_upstream_response');
    expect(resolvePublicTerminalFailure(wrapperFailure, resilientPolicy).rewritten).toBe(true);
  });

  it('aggregates mixed causes when the last channel returned a relayed wrapper 4xx', () => {
    const transientFailure = failure(503, 'service unavailable');
    const wrapperFailure = failure(422, 'Upstream returned HTTP 422: bad response status code 422');

    const decision = resolveAggregatedPublicTerminalFailure(
      [transientFailure, wrapperFailure],
      wrapperFailure,
      resilientPolicy,
    );

    expect(decision).toMatchObject({
      status: 503,
      code: 'metapi_upstream_pool_exhausted',
      rewritten: true,
    });
  });

  it('still surfaces a genuine deterministic 422 verbatim after channel retries', () => {
    const priorRetryableFailure = failure(503, 'service unavailable');
    const deterministicPayload = {
      error: {
        type: 'invalid_request_error',
        code: 'unknown_parameter',
        message: 'unknown parameter: foo',
      },
    };
    const deterministicFailure = buildCanonicalUpstreamFailure({
      status: 422,
      message: 'unknown parameter: foo',
      protocol: 'responses',
      requestedModel: 'gpt-5.6',
      downstreamApiKeyId: 12,
      terminalScope: 'attempt_budget_exhausted',
      originalPayload: deterministicPayload,
    });

    expect(deterministicFailure.cause).toBe('request_invalid');
    expect(resolveAggregatedPublicTerminalFailure(
      [priorRetryableFailure],
      deterministicFailure,
      resilientPolicy,
    )).toMatchObject({
      status: 422,
      rewritten: false,
      message: 'unknown parameter: foo',
    });
  });

  it('preserves a Responses previous-response 404 when earlier channel failures exist', () => {
    const priorRetryableFailure = failure(401, 'expired upstream token');
    const continuationFailure = buildCanonicalUpstreamFailure({
      status: 404,
      message: 'previous_response_not_found',
      protocol: 'responses',
      requestedModel: 'gpt-5.6',
      downstreamApiKeyId: 12,
      originalPayload: {
        error: {
          type: 'invalid_request_error',
          code: 'previous_response_not_found',
          message: 'previous_response_not_found',
        },
      },
      terminalScope: 'attempt_budget_exhausted',
    });

    const decision = resolveAggregatedPublicTerminalFailure(
      [priorRetryableFailure],
      continuationFailure,
      resilientPolicy,
    );

    expect(decision).toMatchObject({
      status: 404,
      code: 'previous_response_not_found',
      rewritten: true,
    });
  });

  it('retains attempt-budget evidence on the canonical failure used for public aggregation', () => {
    const canonical = buildCanonicalUpstreamFailure({
      status: 401,
      message: 'expired upstream token',
      protocol: 'responses',
      requestedModel: 'gpt-5.6',
      downstreamApiKeyId: 12,
      terminalScope: 'attempt_budget_exhausted',
      attemptedChannelCount: 3,
      maxChannelAttempts: 3,
    });

    expect(canonical).toMatchObject({
      terminalScope: 'attempt_budget_exhausted',
      attemptedChannelCount: 3,
      maxChannelAttempts: 3,
    });
  });

  it('preserves the original upstream response outside the dedicated downstream key scope', () => {
    expect(resolvePublicTerminalFailure(failure(401, 'expired upstream token', 13), resilientPolicy)).toEqual({
      status: 401,
      type: 'upstream_error',
      code: undefined,
      message: 'expired upstream token',
      rewritten: false,
    });
  });

  it('preserves a non-JSON original payload when rewriting is disabled', () => {
    const canonical = buildCanonicalUpstreamFailure({
      status: 502,
      message: '<html>upstream unavailable</html>',
      protocol: 'responses',
      requestedModel: 'gpt-5.6',
      downstreamApiKeyId: 13,
      originalPayload: '<html>upstream unavailable</html>',
      terminalScope: 'attempt_budget_exhausted',
    });
    const decision = resolvePublicTerminalFailure(canonical, resilientPolicy);

    expect(decision.rewritten).toBe(false);
    expect(serializePublicTerminalFailure(decision, 'responses')).toBe('<html>upstream unavailable</html>');
  });

  it('does not collapse mixed failures outside the dedicated downstream key scope', async () => {
    const first = failure(401, 'expired token', 13);
    const last = failure(429, 'quota exceeded', 13);
    const { resolveAggregatedPublicTerminalFailure } = await import('./downstreamErrorPolicy.js');

    expect(resolveAggregatedPublicTerminalFailure([first, last], last, resilientPolicy)).toEqual({
      status: 429,
      type: 'upstream_error',
      code: undefined,
      message: 'quota exceeded',
      rewritten: false,
    });
  });

  it('does not rewrite post-commit or websocket failures', () => {
    const canonical = failure(401, 'expired upstream token');
    expect(resolvePublicTerminalFailure({ ...canonical, phase: 'postcommit' }, resilientPolicy).rewritten).toBe(false);
    expect(resolvePublicTerminalFailure({ ...canonical, transport: 'websocket' }, resilientPolicy).rewritten).toBe(false);
  });

  it('never serializes a failure as a successful 2xx response', () => {
    const cases = [
      failure(401, 'expired token'),
      failure(429, 'quota exceeded'),
      failure(502, 'invalid JSON response'),
      failure(504, 'upstream timeout'),
    ];
    for (const item of cases) {
      expect(resolvePublicTerminalFailure(item, resilientPolicy).status).toBeGreaterThanOrEqual(400);
    }
  });

  it('serializes Claude Messages terminal failures using Anthropic error shape', () => {
    const decision = resolvePublicTerminalFailure(failure(401, 'expired token'), resilientPolicy);

    expect(serializePublicTerminalFailure(decision, 'messages')).toEqual({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'All configured upstream channels are currently unavailable.',
      },
    });
  });

  it('keeps the legacy JSON error shape for Claude Messages when rewriting is off', () => {
    const decision = resolvePublicTerminalFailure(
      failure(401, 'expired token'),
      { mode: 'off', downstreamApiKeyIds: [] },
    );

    expect(serializePublicTerminalFailure(decision, 'messages')).toEqual({
      error: {
        type: 'upstream_error',
        message: 'expired token',
      },
    });
  });

  it('preserves original payload fields outside scope', () => {
    const canonical = buildCanonicalUpstreamFailure({
      status: 502,
      message: 'Upstream returned empty content',
      protocol: 'chat',
      requestedModel: 'gpt-5.6',
      downstreamApiKeyId: 13,
      originalPayload: {
        error: {
          message: 'Upstream returned empty content',
          request_id: 'req_123',
        },
        provider: 'deep-upstream',
      },
    });
    const decision = resolvePublicTerminalFailure(canonical, resilientPolicy);

    expect(serializePublicTerminalFailure(decision)).toEqual({
      error: {
        message: 'Upstream returned empty content',
        type: 'upstream_error',
        request_id: 'req_123',
      },
      provider: 'deep-upstream',
    });
  });

  it('classifies an exhausted channel pool separately from provider overload', () => {
    const decision = resolvePublicTerminalFailure(
      failure(503, 'No available channels after retries'),
      resilientPolicy,
    );

    expect(decision).toMatchObject({
      status: 503,
      code: 'metapi_no_available_channel',
      rewritten: true,
    });
  });

  it('rewrites an explicit routing exhaustion without requiring a selected channel', () => {
    const routingFailure = buildCanonicalRoutingFailure({
      protocol: 'responses',
      requestedModel: 'gpt-5.6',
      downstreamApiKeyId: 12,
      message: 'No available channels after retries',
    });

    expect(resolvePublicTerminalFailure(routingFailure, resilientPolicy)).toMatchObject({
      status: 503,
      code: 'metapi_no_available_channel',
    });
  });

  it('collapses mixed exhausted channel causes to a neutral pool-exhausted failure', () => {
    const aggregated = aggregateCanonicalFailures([
      failure(401, 'expired token'),
      failure(504, 'upstream timed out'),
    ]);

    expect(aggregated).toMatchObject({
      cause: 'upstream_pool_exhausted',
      originalStatus: 503,
    });
    expect(resolvePublicTerminalFailure(aggregated, resilientPolicy)).toMatchObject({
      status: 503,
      code: 'metapi_upstream_pool_exhausted',
    });
  });

  it('keeps a uniform timeout cause when every exhausted channel timed out', () => {
    const aggregated = aggregateCanonicalFailures([
      failure(504, 'first upstream timed out'),
      failure(408, 'second upstream timed out'),
    ]);

    expect(aggregated.cause).toBe('upstream_timeout');
    expect(resolvePublicTerminalFailure(aggregated, resilientPolicy).status).toBe(504);
  });

  it('does not let a post-commit stream failure enter pre-commit public aggregation', () => {
    const precommit = failure(401, 'expired token');
    const postcommit = {
      ...failure(502, 'stream interrupted'),
      phase: 'postcommit' as const,
      transport: 'sse' as const,
    };

    const aggregated = aggregateCanonicalFailures([precommit, postcommit]);
    expect(aggregated).toMatchObject({
      cause: 'upstream_auth',
      phase: 'precommit',
    });
  });

  it('does not reuse prior precommit failures to rewrite a websocket bridge fallback', async () => {
    const precommit = failure(401, 'expired token');
    const websocketFallback = {
      ...failure(401, 'expired token'),
      transport: 'websocket' as const,
    };
    const { resolveAggregatedPublicTerminalFailure } = await import('./downstreamErrorPolicy.js');

    expect(resolveAggregatedPublicTerminalFailure([precommit], websocketFallback, resilientPolicy)).toEqual({
      status: 401,
      type: 'upstream_error',
      code: undefined,
      message: 'expired token',
      rewritten: false,
    });
  });
});

describe('rewritten terminal failures keep upstream evidence', () => {
  it('nests the upstream body under upstream_error without changing the public contract', () => {
    // Decision: the neutral 502 is what the client routes on, but the upstream's own body
    // is what a human needs in order to see which upstream refused and why. Previously
    // every rewritten branch discarded it.
    const withPayload = buildCanonicalUpstreamFailure({
      status: 422,
      message: 'Upstream returned HTTP 422: openai_error',
      protocol: 'responses',
      requestedModel: 'gpt-5.6',
      downstreamApiKeyId: 12,
      terminalScope: 'attempt_budget_exhausted',
      originalPayload: { error: { message: 'relay failed', type: 'openai_error' } },
    });

    const decision = resolvePublicTerminalFailure(withPayload, resilientPolicy);
    expect(decision).toMatchObject({
      status: 502,
      code: 'metapi_invalid_upstream_response',
      rewritten: true,
    });

    const serialized = serializePublicTerminalFailure(decision, 'responses') as {
      error: { message: string; type: string; code?: string; upstream_error?: unknown };
    };
    // Public fields stay Metapi's own.
    expect(serialized.error.message).toBe('The upstream returned an invalid gateway response.');
    expect(serialized.error.code).toBe('metapi_invalid_upstream_response');
    // Evidence is preserved alongside, not in place of, the rewritten payload.
    expect(serialized.error.upstream_error).toEqual({
      error: { message: 'relay failed', type: 'openai_error' },
    });
  });

  it('omits the evidence key entirely when there is no upstream body', () => {
    const noPayload = buildCanonicalUpstreamFailure({
      status: 422,
      message: 'Upstream returned HTTP 422: openai_error',
      protocol: 'responses',
      requestedModel: 'gpt-5.6',
      downstreamApiKeyId: 12,
      terminalScope: 'attempt_budget_exhausted',
    });
    const serialized = serializePublicTerminalFailure(
      resolvePublicTerminalFailure(noPayload, resilientPolicy),
      'responses',
    ) as { error: Record<string, unknown> };
    expect('upstream_error' in serialized.error).toBe(false);
  });

  it('does not nest evidence for a passthrough (non-rewritten) decision', () => {
    // A passthrough decision serializes the upstream payload AS the response body; adding
    // a nested copy would duplicate it.
    const outOfScope = buildCanonicalUpstreamFailure({
      status: 422,
      message: 'Upstream returned HTTP 422: openai_error',
      protocol: 'responses',
      requestedModel: 'gpt-5.6',
      downstreamApiKeyId: 999,
      terminalScope: 'attempt_budget_exhausted',
      originalPayload: { error: { message: 'relay failed', type: 'openai_error' } },
    });
    const decision = resolvePublicTerminalFailure(outOfScope, resilientPolicy);
    expect(decision.rewritten).toBe(false);
    const serialized = serializePublicTerminalFailure(decision, 'responses') as {
      error: Record<string, unknown>;
    };
    expect('upstream_error' in serialized.error).toBe(false);
    expect(serialized.error.type).toBe('openai_error');
  });

  it('retains the last upstream body when mixed causes collapse to a pool-exhausted terminal', () => {
    // Mixed causes are the common shape once indeterminate retries are in play, because
    // the retry only continues while the rejection keeps changing.
    const first = failure(400, 'Upstream returned HTTP 400: rejected');
    const second = buildCanonicalUpstreamFailure({
      status: 422,
      message: 'Upstream returned HTTP 422: openai_error',
      protocol: 'responses',
      requestedModel: 'gpt-5.6',
      downstreamApiKeyId: 12,
      terminalScope: 'attempt_budget_exhausted',
      originalPayload: { error: { message: 'second channel refused', type: 'openai_error' } },
    });

    const aggregated = aggregateCanonicalFailures([first, second]);
    expect(aggregated).toMatchObject({ cause: 'upstream_pool_exhausted', originalStatus: 503 });
    expect(aggregated.originalPayload).toEqual({
      error: { message: 'second channel refused', type: 'openai_error' },
    });
  });
});
