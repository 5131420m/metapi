import { describe, expect, it } from 'vitest';
import { shouldAbortSameSiteEndpointFallback, shouldRetryProxyRequest } from './proxyRetryPolicy.js';

describe('proxyRetryPolicy', () => {
  it('retries on rate limit and server errors', () => {
    expect(shouldRetryProxyRequest(429, 'rate limit')).toBe(true);
    expect(shouldRetryProxyRequest(500, 'internal error')).toBe(true);
    expect(shouldRetryProxyRequest(503, 'service unavailable')).toBe(true);
  });

  it('retries on model unsupported messages from upstream', () => {
    expect(
      shouldRetryProxyRequest(400, '{"error":"当前 API 不支持所选模型 claude-sonnet-4-5-20250929","type":"error"}'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(400, '{"error":{"message":"unsupported model: claude-3"}}'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(404, '{"error":{"message":"The model `gpt-4.1` does not exist"}}'),
    ).toBe(true);
  });

  it('does not retry obvious request-shape errors that will fail on every channel', () => {
    expect(
      shouldRetryProxyRequest(400, '{"error":{"message":"invalid request body"}}'),
    ).toBe(false);
    expect(
      shouldRetryProxyRequest(422, '{"error":{"message":"unprocessable"}}'),
    ).toBe(false);
    expect(
      shouldRetryProxyRequest(404, '{"error":{"message":"not found"}}'),
    ).toBe(false);
  });

  it('keeps retrying channel-local compatibility and auth failures', () => {
    expect(
      shouldRetryProxyRequest(401, '{"error":{"message":"invalid access token"}}'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(403, '{"error":{"message":"forbidden"}}'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(400, 'Unsupported legacy protocol: /v1/chat/completions is not supported. Please use /v1/responses.'),
    ).toBe(true);
  });

  it('does not retry client-side timeout validation errors', () => {
    expect(
      shouldRetryProxyRequest(400, '{"error":{"message":"timeout must be <= 60"}}'),
    ).toBe(false);
    expect(
      shouldRetryProxyRequest(400, '{"error":{"message":"invalid timeout parameter"}}'),
    ).toBe(false);
  });

  it('retries relayed upstream wrapper failures carried on a deterministic 4xx status', () => {
    expect(
      shouldRetryProxyRequest(422, 'Upstream returned HTTP 422: openai_error'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(422, 'Upstream returned HTTP 422: bad response status code 422'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(400, 'Upstream returned HTTP 400: Mistral Console requires at least one message'),
    ).toBe(true);
  });

  it('recovers wrapper markers from the raw body when the summary dropped error.type', () => {
    // summarizeUpstreamError() keeps error.message and DISCARDS error.type/code,
    // so the only channel-local evidence survives in the raw upstream body.
    const summarized = 'Upstream returned HTTP 422: request could not be completed';
    const raw = '{"error":{"message":"request could not be completed","type":"bad_response_status_code"}}';

    expect(shouldRetryProxyRequest(422, summarized)).toBe(false);
    expect(shouldRetryProxyRequest(422, summarized, raw)).toBe(true);
  });

  it('keeps request-shape errors terminal even when a wrapper marker is present', () => {
    // NON_RETRYABLE_REQUEST_PATTERNS is matched first and only against the summary,
    // so a genuinely malformed request is never retried across channels.
    expect(
      shouldRetryProxyRequest(400, 'Upstream returned HTTP 400: unknown parameter: foo', '{"error":{"type":"openai_error"}}'),
    ).toBe(false);
    expect(
      shouldRetryProxyRequest(422, 'Upstream returned HTTP 422: invalid request body', '{"error":{"type":"openai_error"}}'),
    ).toBe(false);
  });

  it('does not treat an unrelated vendor mention as a console constraint', () => {
    expect(
      shouldRetryProxyRequest(400, '{"error":{"message":"messages[0].role is invalid"}}'),
    ).toBe(false);
  });

  it('leaves an unexplained 4xx terminal unless indeterminate retry was requested', () => {
    // Default behaviour is unchanged: a 400/422 with no marker either way stays terminal,
    // so the ordinary routing path never gains an attempt from this feature.
    expect(shouldRetryProxyRequest(400, 'Upstream returned HTTP 400: rejected')).toBe(false);
    expect(shouldRetryProxyRequest(422, 'Upstream returned HTTP 422: rejected')).toBe(false);
  });

  it('retries an unexplained 400/422 when indeterminate retry is allowed', () => {
    expect(
      shouldRetryProxyRequest(400, 'Upstream returned HTTP 400: rejected', null, {
        allowIndeterminateRetry: true,
      }),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(422, 'Upstream returned HTTP 422: rejected', null, {
        allowIndeterminateRetry: true,
      }),
    ).toBe(true);
  });

  it('keeps 413 out of indeterminate retry unless payload-too-large is opted in', () => {
    expect(
      shouldRetryProxyRequest(413, 'Upstream returned HTTP 413: too large', null, {
        allowIndeterminateRetry: true,
      }),
    ).toBe(false);
    expect(
      shouldRetryProxyRequest(413, 'Upstream returned HTTP 413: too large', null, {
        allowIndeterminateRetry: true,
        includePayloadTooLarge: true,
      }),
    ).toBe(true);
  });

  it('keeps determinate request-shape errors terminal even with indeterminate retry on', () => {
    // The request-shape patterns are evaluated BEFORE the indeterminate branch: a body
    // that announces itself as malformed would fail identically on every channel, so
    // retrying only re-uploads it.
    expect(
      shouldRetryProxyRequest(400, 'Upstream returned HTTP 400: invalid json', null, {
        allowIndeterminateRetry: true,
      }),
    ).toBe(false);
    expect(
      shouldRetryProxyRequest(422, 'Upstream returned HTTP 422: missing required parameter model', null, {
        allowIndeterminateRetry: true,
      }),
    ).toBe(false);
    expect(
      shouldRetryProxyRequest(400, 'Upstream returned HTTP 400: validation failed', null, {
        allowIndeterminateRetry: true,
      }),
    ).toBe(false);
  });

  it('does not extend indeterminate retry to 404', () => {
    // 404 is a determinate "not here" answer and has its own model-unavailable handling.
    expect(
      shouldRetryProxyRequest(404, 'Upstream returned HTTP 404: not found', null, {
        allowIndeterminateRetry: true,
      }),
    ).toBe(false);
  });

  it('aborts same-site endpoint fallback on rate-limit and quota responses', () => {
    expect(
      shouldAbortSameSiteEndpointFallback(429, '{"error":{"message":"rate limit exceeded"}}'),
    ).toBe(true);
    expect(
      shouldAbortSameSiteEndpointFallback(429, '{"error":{"message":"quota exceeded"}}'),
    ).toBe(true);
    expect(
      shouldAbortSameSiteEndpointFallback(429, '{"error":{"message":"too many requests"}}'),
    ).toBe(true);
  });
});
