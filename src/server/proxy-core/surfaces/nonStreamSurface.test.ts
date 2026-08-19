import { afterEach, describe, expect, it } from 'vitest';

import { config } from '../../config.js';
import { resolveNonStreamTerminalFailure } from './nonStreamSurface.js';

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
