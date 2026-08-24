import { afterEach, describe, expect, it } from 'vitest';

import { config } from '../../config.js';
import {
  createNonStreamFailureAccumulator,
  resolveNonStreamTerminalFailure,
  resolveNonStreamTerminalScope,
} from './nonStreamSurface.js';

const originalPolicy = structuredClone(config.downstreamErrorPolicy);

afterEach(() => {
  config.downstreamErrorPolicy = structuredClone(originalPolicy);
});

describe('non-stream terminal failure surface', () => {
  it('rewrites an exhausted upstream auth failure for a dedicated downstream key', () => {
    config.downstreamErrorPolicy = {
      mode: 'resilient',
      downstreamApiKeyIds: [12],
    };

    expect(resolveNonStreamTerminalFailure({
      protocol: 'openai',
      requestedModel: 'gpt-5.6',
      status: 401,
      message: 'expired upstream credential',
      downstreamApiKeyId: 12,
      originalPayload: { error: { message: 'expired upstream credential' } },
      terminalScope: 'attempt_budget_exhausted',
    })).toEqual({
      status: 503,
      payload: { error: {
        message: 'All configured upstream channels are currently unavailable.',
        type: 'server_error',
        code: 'metapi_upstream_auth_exhausted',
      } },
    });
  });

  it('does not rewrite one upstream attempt without explicit exhaustion evidence', () => {
    config.downstreamErrorPolicy = {
      mode: 'resilient',
      downstreamApiKeyIds: [12],
    };
    const originalPayload = {
      error: {
        message: 'expired upstream credential',
        type: 'authentication_error',
      },
    };

    expect(resolveNonStreamTerminalFailure({
      protocol: 'openai',
      requestedModel: 'gpt-5.6',
      status: 401,
      message: 'expired upstream credential',
      downstreamApiKeyId: 12,
      originalPayload,
    })).toEqual({
      status: 401,
      payload: originalPayload,
    });
  });

  it('preserves the original payload outside the dedicated downstream key scope', () => {
    config.downstreamErrorPolicy = {
      mode: 'resilient',
      downstreamApiKeyIds: [12],
    };
    const originalPayload = { error: { message: 'quota exceeded', request_id: 'req_123' } };

    expect(resolveNonStreamTerminalFailure({
      protocol: 'openai',
      requestedModel: 'gpt-5.6',
      status: 429,
      message: 'quota exceeded',
      downstreamApiKeyId: 13,
      originalPayload,
    })).toEqual({ status: 429, payload: originalPayload });
  });

  it('preserves a plain-text upstream body when rewriting is disabled', () => {
    config.downstreamErrorPolicy = { mode: 'off', downstreamApiKeyIds: [] };

    expect(resolveNonStreamTerminalFailure({
      protocol: 'openai',
      requestedModel: 'gpt-5.6',
      status: 502,
      message: '<html>bad gateway</html>',
      downstreamApiKeyId: 12,
      originalPayload: '<html>bad gateway</html>',
    })).toEqual({ status: 502, payload: '<html>bad gateway</html>' });
  });

  it('keeps routing exhaustion non-2xx while neutralizing it for a dedicated key', () => {
    config.downstreamErrorPolicy = {
      mode: 'resilient',
      downstreamApiKeyIds: [12],
    };

    expect(resolveNonStreamTerminalFailure({
      protocol: 'openai',
      requestedModel: 'gpt-5.6',
      status: 503,
      message: 'No available channels after retries',
      downstreamApiKeyId: 12,
      cause: 'routing',
    })).toEqual({
      status: 503,
      payload: { error: {
        message: 'No upstream channel is currently available.',
        type: 'server_error',
        code: 'metapi_no_available_channel',
      } },
    });
  });
});

describe('non-stream terminal scope', () => {
  it('does not claim budget exhaustion on an unspent budget', () => {
    // A pinned channel reaches the terminal site with retryCount still 0, because
    // `canRetryChannelSelection()` refuses a forced channel before the loop can increment.
    // The old scope was inferred from that refusal and reported an exhausted budget.
    expect(resolveNonStreamTerminalScope({
      retryable: true,
      retryCount: 0,
      maxRetries: 3,
    })).toBe('attempt');
  });

  it('claims budget exhaustion only once the retry budget is actually spent', () => {
    expect(resolveNonStreamTerminalScope({
      retryable: true,
      retryCount: 3,
      maxRetries: 3,
    })).toBe('attempt_budget_exhausted');
  });

  it('keeps a mid-budget retryable failure scoped to the attempt', () => {
    expect(resolveNonStreamTerminalScope({
      retryable: true,
      retryCount: 1,
      maxRetries: 3,
    })).toBe('attempt');
  });

  it('never claims exhaustion for a failure that was never retryable', () => {
    expect(resolveNonStreamTerminalScope({
      retryable: false,
      retryCount: 3,
      maxRetries: 3,
    })).toBe('attempt');
  });

  it('relays the upstream error verbatim for a pinned channel instead of neutralizing it', () => {
    // The model tester pins a channel to see what that channel actually returned. Under
    // the old reverse-inferred scope this became a rewritten 503 for an opted-in key.
    config.downstreamErrorPolicy = {
      mode: 'resilient',
      downstreamApiKeyIds: [12],
    };
    const originalPayload = { error: { message: 'bad gateway', type: 'server_error' } };

    expect(resolveNonStreamTerminalFailure({
      protocol: 'openai',
      requestedModel: 'gpt-5.6',
      status: 502,
      message: 'bad gateway',
      downstreamApiKeyId: 12,
      originalPayload,
      terminalScope: resolveNonStreamTerminalScope({
        retryable: true,
        retryCount: 0,
        maxRetries: 3,
      }),
    })).toEqual({ status: 502, payload: originalPayload });
  });
});

describe('non-stream failure accumulator', () => {
  const resilientForKey12 = () => {
    config.downstreamErrorPolicy = {
      mode: 'resilient',
      downstreamApiKeyIds: [12],
    };
  };

  it('collapses mixed causes across channels into one pool-exhausted answer', () => {
    resilientForKey12();
    const acc = createNonStreamFailureAccumulator({
      protocol: 'openai',
      requestedModel: 'gpt-5.6',
      downstreamApiKeyId: 12,
    });

    // Channel A hit a rate limit, channel B an auth failure. Reporting only the last one
    // told the caller "auth" when the request actually died of two unrelated causes.
    acc.record({
      status: 429,
      message: 'rate limit exceeded',
      terminalScope: 'attempt_budget_exhausted',
    });

    expect(acc.resolveTerminal({
      status: 401,
      message: 'invalid api key',
      terminalScope: 'attempt_budget_exhausted',
    })).toEqual({
      status: 503,
      payload: { error: {
        message: 'All configured upstream channels are currently unavailable.',
        type: 'server_error',
        code: 'metapi_upstream_pool_exhausted',
      } },
    });
    expect(acc.recordedCount).toBe(2);
  });

  it('keeps the specific cause when every channel failed the same way', () => {
    resilientForKey12();
    const acc = createNonStreamFailureAccumulator({
      protocol: 'openai',
      requestedModel: 'gpt-5.6',
      downstreamApiKeyId: 12,
    });
    acc.record({
      status: 429,
      message: 'rate limit exceeded',
      terminalScope: 'attempt_budget_exhausted',
    });

    expect(acc.resolveTerminal({
      status: 429,
      message: 'rate limit exceeded',
      terminalScope: 'attempt_budget_exhausted',
    })).toEqual({
      status: 503,
      payload: { error: {
        message: 'All configured upstream channels are temporarily unavailable.',
        type: 'server_error',
        code: 'metapi_upstream_rate_limited',
      } },
    });
  });

  it('relays a single unexhausted attempt verbatim', () => {
    resilientForKey12();
    const acc = createNonStreamFailureAccumulator({
      protocol: 'openai',
      requestedModel: 'gpt-5.6',
      downstreamApiKeyId: 12,
    });
    const originalPayload = { error: { message: 'bad gateway', type: 'server_error' } };

    expect(acc.resolveTerminal({
      status: 502,
      message: 'bad gateway',
      originalPayload,
      terminalScope: resolveNonStreamTerminalScope({
        retryable: true,
        retryCount: 0,
        maxRetries: 3,
      }),
    })).toEqual({ status: 502, payload: originalPayload });
    expect(acc.recordedCount).toBe(1);
  });

  it('leaves a mixed-cause request untouched outside the opted-in key scope', () => {
    resilientForKey12();
    const acc = createNonStreamFailureAccumulator({
      protocol: 'openai',
      requestedModel: 'gpt-5.6',
      downstreamApiKeyId: 13,
    });
    const originalPayload = { error: { message: 'invalid api key' } };
    acc.record({ status: 429, message: 'rate limit exceeded', terminalScope: 'attempt_budget_exhausted' });

    expect(acc.resolveTerminal({
      status: 401,
      message: 'invalid api key',
      originalPayload,
      terminalScope: 'attempt_budget_exhausted',
    })).toEqual({ status: 401, payload: originalPayload });
  });

  it('keeps a determinate request defect verbatim even after several channels failed', () => {
    resilientForKey12();
    const acc = createNonStreamFailureAccumulator({
      protocol: 'openai',
      requestedModel: 'gpt-5.6',
      downstreamApiKeyId: 12,
    });
    const originalPayload = { error: { message: 'messages: missing required field' } };
    acc.record({ status: 429, message: 'rate limit exceeded', terminalScope: 'attempt_budget_exhausted' });

    // The caller's own malformed request must not be masked as a 503 just because the
    // aggregate saw mixed causes; a 4xx request defect is theirs to fix.
    expect(acc.resolveTerminal({
      status: 400,
      message: 'messages: missing required field',
      originalPayload,
      terminalScope: 'attempt',
    })).toEqual({ status: 400, payload: originalPayload });
  });
});
