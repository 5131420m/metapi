import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from '../../config.js';

const fetchMock = vi.fn();
const selectChannelMock = vi.fn();
const selectNextChannelMock = vi.fn();
const recordSuccessMock = vi.fn();
const recordFailureMock = vi.fn();
const refreshModelsAndRebuildRoutesMock = vi.fn();
const reportProxyAllFailedMock = vi.fn();
const reportTokenExpiredMock = vi.fn();
const estimateProxyCostMock = vi.fn(async () => 0);
const shouldRetryProxyRequestMock = vi.fn();
const saveProxyVideoTaskMock = vi.fn();
const getProxyVideoTaskByPublicIdMock = vi.fn();
const deleteProxyVideoTaskByPublicIdMock = vi.fn();
const refreshProxyVideoTaskSnapshotMock = vi.fn();
const resolveProxyVideoTaskSiteMock = vi.fn();
let siteApiEndpointRows: Array<Record<string, unknown>> = [];
// Defaults to null so every existing test keeps the unauthenticated shape (no downstream
// key id, so the resilient policy never targets the failure). Only the aggregation test
// opts in.
let proxyAuthContext: unknown = null;

vi.mock('../../middleware/auth.js', () => ({
  getProxyAuthContext: () => proxyAuthContext,
}));

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    fetch: (...args: unknown[]) => fetchMock(...args),
  };
});

vi.mock('../../services/tokenRouter.js', () => ({
  tokenRouter: {
    selectChannel: (...args: unknown[]) => selectChannelMock(...args),
    selectNextChannel: (...args: unknown[]) => selectNextChannelMock(...args),
    recordSuccess: (...args: unknown[]) => recordSuccessMock(...args),
    recordFailure: (...args: unknown[]) => recordFailureMock(...args),
  },
}));

vi.mock('../../services/modelService.js', () => ({
  refreshModelsAndRebuildRoutes: (...args: unknown[]) => refreshModelsAndRebuildRoutesMock(...args),
}));

vi.mock('../../services/alertService.js', () => ({
  reportProxyAllFailed: (...args: unknown[]) => reportProxyAllFailedMock(...args),
  reportTokenExpired: (...args: unknown[]) => reportTokenExpiredMock(...args),
}));

vi.mock('../../services/alertRules.js', () => ({
  isTokenExpiredError: () => false,
}));

vi.mock('../../services/modelPricingService.js', () => ({
  estimateProxyCost: (arg: any) => estimateProxyCostMock(arg),
}));

vi.mock('../../services/proxyRetryPolicy.js', () => ({
  shouldAbortSameSiteEndpointFallback: () => false,
  shouldRetryProxyRequest: (...args: unknown[]) => shouldRetryProxyRequestMock(...args),
  RETRYABLE_TIMEOUT_PATTERNS: [/(request timed out|connection timed out|read timeout|\btimed out\b)/i],
}));

vi.mock('../../services/proxyVideoTaskStore.js', () => ({
  saveProxyVideoTask: (...args: unknown[]) => saveProxyVideoTaskMock(...args),
  getProxyVideoTaskByPublicId: (...args: unknown[]) => getProxyVideoTaskByPublicIdMock(...args),
  deleteProxyVideoTaskByPublicId: (...args: unknown[]) => deleteProxyVideoTaskByPublicIdMock(...args),
  refreshProxyVideoTaskSnapshot: (...args: unknown[]) => refreshProxyVideoTaskSnapshotMock(...args),
  resolveProxyVideoTaskSite: (...args: unknown[]) => resolveProxyVideoTaskSiteMock(...args),
}));

vi.mock('../../db/index.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            all: async () => siteApiEndpointRows,
          }),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          run: async () => undefined,
        }),
      }),
    }),
  },
  hasProxyLogStreamTimingColumns: async () => false,
  schema: {
    siteApiEndpoints: {
      id: {},
      siteId: {},
      sortOrder: {},
    },
  },
}));

describe('/v1/videos routes', () => {
  let app: FastifyInstance;

  const buildMultipartBody = (boundary: string) => Buffer.from(
    `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="model"\r\n\r\n`
      + `sora-2\r\n`
      + `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="prompt"\r\n\r\n`
      + `a cat walking\r\n`
      + `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="input_reference"; filename="cat.png"\r\n`
      + `Content-Type: image/png\r\n\r\n`
      + `pngdata\r\n`
      + `--${boundary}--\r\n`,
  );

  beforeAll(async () => {
    const { videosProxyRoute } = await import('./videos.js');
    app = Fastify();
    await app.register(videosProxyRoute);
  });

  beforeEach(() => {
    fetchMock.mockReset();
    selectChannelMock.mockReset();
    selectNextChannelMock.mockReset();
    recordSuccessMock.mockReset();
    recordFailureMock.mockReset();
    refreshModelsAndRebuildRoutesMock.mockReset();
    reportProxyAllFailedMock.mockReset();
    reportTokenExpiredMock.mockReset();
    estimateProxyCostMock.mockClear();
    shouldRetryProxyRequestMock.mockReset();
    saveProxyVideoTaskMock.mockReset();
    getProxyVideoTaskByPublicIdMock.mockReset();
    deleteProxyVideoTaskByPublicIdMock.mockReset();
    refreshProxyVideoTaskSnapshotMock.mockReset();
    resolveProxyVideoTaskSiteMock.mockReset();
    siteApiEndpointRows = [];
    proxyAuthContext = null;
    shouldRetryProxyRequestMock.mockReturnValue(false);

    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { id: 44, name: 'demo-site', url: 'https://upstream.example.com', platform: 'openai' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'sora-2',
    });
    selectNextChannelMock.mockReturnValue(null);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('creates an upstream video task and stores a local public id mapping', async () => {
    saveProxyVideoTaskMock.mockResolvedValue({
      publicId: 'vid_local_123',
      upstreamVideoId: 'vid_upstream_123',
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'vid_upstream_123',
      object: 'video',
      status: 'queued',
      model: 'sora-2',
      prompt: 'a cat walking',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/videos',
      payload: {
        model: 'sora-2',
        prompt: 'a cat walking',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(saveProxyVideoTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      upstreamVideoId: 'vid_upstream_123',
      requestedModel: 'sora-2',
      actualModel: 'sora-2',
      lastUpstreamStatus: 200,
      statusSnapshot: expect.objectContaining({
        id: 'vid_upstream_123',
        status: 'queued',
      }),
    }));
    expect(response.json()).toMatchObject({
      id: 'vid_local_123',
      object: 'video',
      status: 'queued',
    });
  });

  it('accepts multipart video create requests', async () => {
    saveProxyVideoTaskMock.mockResolvedValue({
      publicId: 'vid_local_456',
      upstreamVideoId: 'vid_upstream_456',
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'vid_upstream_456',
      object: 'video',
      status: 'queued',
      model: 'sora-2',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const boundary = 'metapi-video-boundary';
    const response = await app.inject({
      method: 'POST',
      url: '/v1/videos',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: buildMultipartBody(boundary),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 'vid_local_456',
      object: 'video',
      status: 'queued',
    });
  });

  it('stores the selected api endpoint base url for split-host video tasks', async () => {
    siteApiEndpointRows = [
      {
        id: 91,
        siteId: 44,
        url: 'https://api-videos.example.com',
        enabled: true,
        sortOrder: 0,
      },
    ];
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { id: 44, name: 'demo-site', url: 'https://panel.example.com', platform: 'openai' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'sora-2',
    });
    saveProxyVideoTaskMock.mockResolvedValue({
      publicId: 'vid_local_split',
      upstreamVideoId: 'vid_upstream_split',
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'vid_upstream_split',
      object: 'video',
      status: 'queued',
      model: 'sora-2',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/videos',
      payload: {
        model: 'sora-2',
        prompt: 'split-host create',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(saveProxyVideoTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      siteUrl: 'https://api-videos.example.com',
    }));
  });

  it('resolves local video ids back to the upstream task on GET', async () => {
    resolveProxyVideoTaskSiteMock.mockResolvedValue(null);
    getProxyVideoTaskByPublicIdMock.mockResolvedValue({
      publicId: 'vid_local_123',
      upstreamVideoId: 'vid_upstream_123',
      siteUrl: 'https://upstream.example.com',
      tokenValue: 'sk-demo',
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'vid_upstream_123',
      object: 'video',
      status: 'running',
      model: 'sora-2',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'GET',
      url: '/v1/videos/vid_local_123',
    });

    expect(response.statusCode).toBe(200);
    const [targetUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(targetUrl).toBe('https://upstream.example.com/v1/videos/vid_upstream_123');
    expect(refreshProxyVideoTaskSnapshotMock).toHaveBeenCalledWith('vid_local_123', expect.objectContaining({
      lastUpstreamStatus: 200,
      statusSnapshot: expect.objectContaining({
        id: 'vid_upstream_123',
        status: 'running',
      }),
    }));
    expect(response.json()).toMatchObject({
      id: 'vid_local_123',
      object: 'video',
      status: 'running',
    });
  });

  it('re-resolves account-backed video tasks through the site api endpoint pool on GET', async () => {
    siteApiEndpointRows = [
      {
        id: 91,
        siteId: 44,
        url: 'https://api-videos.example.com',
        enabled: true,
        sortOrder: 0,
      },
    ];
    resolveProxyVideoTaskSiteMock.mockResolvedValue({
      id: 44,
      name: 'demo-site',
      url: 'https://panel.example.com',
      platform: 'openai',
    });
    getProxyVideoTaskByPublicIdMock.mockResolvedValue({
      publicId: 'vid_local_456',
      upstreamVideoId: 'vid_upstream_456',
      siteUrl: 'https://panel.example.com',
      tokenValue: 'sk-demo',
      accountId: 33,
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'vid_upstream_456',
      object: 'video',
      status: 'queued',
      model: 'sora-2',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'GET',
      url: '/v1/videos/vid_local_456',
    });

    expect(response.statusCode).toBe(200);
    const [targetUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(targetUrl).toBe('https://api-videos.example.com/v1/videos/vid_upstream_456');
  });

  it('uses the persisted api base url when the backing site can no longer be resolved', async () => {
    resolveProxyVideoTaskSiteMock.mockResolvedValue(null);
    getProxyVideoTaskByPublicIdMock.mockResolvedValue({
      publicId: 'vid_local_fallback',
      upstreamVideoId: 'vid_upstream_fallback',
      siteUrl: 'https://api-fallback.example.com',
      tokenValue: 'sk-demo',
      accountId: 33,
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'vid_upstream_fallback',
      object: 'video',
      status: 'running',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'GET',
      url: '/v1/videos/vid_local_fallback',
    });

    expect(response.statusCode).toBe(200);
    const [targetUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(targetUrl).toBe('https://api-fallback.example.com/v1/videos/vid_upstream_fallback');
  });

  it('preserves retryable upstream failures after mapped GET retries exhaust', async () => {
    shouldRetryProxyRequestMock.mockReturnValue(true);
    siteApiEndpointRows = [
      {
        id: 91,
        siteId: 44,
        url: 'https://api-videos.example.com',
        enabled: true,
        sortOrder: 0,
      },
    ];
    resolveProxyVideoTaskSiteMock.mockResolvedValue({
      id: 44,
      name: 'demo-site',
      url: 'https://panel.example.com',
      platform: 'openai',
    });
    getProxyVideoTaskByPublicIdMock.mockResolvedValue({
      publicId: 'vid_local_retry_get',
      upstreamVideoId: 'vid_upstream_retry_get',
      siteUrl: 'https://api-videos.example.com',
      tokenValue: 'sk-demo',
      accountId: 33,
    });
    fetchMock.mockResolvedValue(new Response('temporary unavailable', {
      status: 502,
      headers: { 'content-type': 'text/plain' },
    }));

    const response = await app.inject({
      method: 'GET',
      url: '/v1/videos/vid_local_retry_get',
    });

    expect(response.statusCode).toBe(502);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toBe('temporary unavailable');
  });

  it('deletes the upstream task and local mapping on DELETE', async () => {
    getProxyVideoTaskByPublicIdMock.mockResolvedValue({
      publicId: 'vid_local_123',
      upstreamVideoId: 'vid_upstream_123',
      siteUrl: 'https://upstream.example.com',
      tokenValue: 'sk-demo',
    });
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/videos/vid_local_123',
    });

    expect(response.statusCode).toBe(204);
    expect(deleteProxyVideoTaskByPublicIdMock).toHaveBeenCalledWith('vid_local_123');
  });

  it('preserves retryable upstream failures after mapped DELETE retries exhaust', async () => {
    shouldRetryProxyRequestMock.mockReturnValue(true);
    siteApiEndpointRows = [
      {
        id: 91,
        siteId: 44,
        url: 'https://api-videos.example.com',
        enabled: true,
        sortOrder: 0,
      },
    ];
    resolveProxyVideoTaskSiteMock.mockResolvedValue({
      id: 44,
      name: 'demo-site',
      url: 'https://panel.example.com',
      platform: 'openai',
    });
    getProxyVideoTaskByPublicIdMock.mockResolvedValue({
      publicId: 'vid_local_retry_delete',
      upstreamVideoId: 'vid_upstream_retry_delete',
      siteUrl: 'https://api-videos.example.com',
      tokenValue: 'sk-demo',
      accountId: 33,
    });
    fetchMock.mockResolvedValue(new Response('temporary unavailable', {
      status: 502,
      headers: { 'content-type': 'text/plain' },
    }));

    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/videos/vid_local_retry_delete',
    });

    expect(response.statusCode).toBe(502);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toBe('temporary unavailable');
  });

  it('classifies a create failure on the summarized message while keeping the raw body for evidence', async () => {
    const rawBody = JSON.stringify({
      error: { message: 'bad response status code 422', type: 'validation_error' },
    });
    fetchMock.mockResolvedValue(new Response(rawBody, {
      status: 422,
      headers: { 'content-type': 'application/json' },
    }));

    await app.inject({
      method: 'POST',
      url: '/v1/videos',
      payload: { model: 'sora-2', prompt: 'a cat walking' },
    });

    // The retry predicate must judge the summarized message, not the raw envelope: a
    // relayed wrapper failure carrying a determinate-looking `type` would otherwise be
    // classified as the caller's fault and lose its channel retry.
    expect(shouldRetryProxyRequestMock).toHaveBeenCalledWith(
      422,
      'Upstream returned HTTP 422: bad response status code 422',
      rawBody,
    );
    // Channel health still classifies on the untouched body, matching the surfaces.
    expect(recordFailureMock).toHaveBeenCalledWith(11, expect.objectContaining({
      status: 422,
      errorText: rawBody,
    }));
  });

  it('passes both the summarized message and the raw body when polling a mapped task', async () => {
    siteApiEndpointRows = [
      { id: 91, siteId: 44, url: 'https://api-videos.example.com', enabled: true, sortOrder: 0 },
    ];
    resolveProxyVideoTaskSiteMock.mockResolvedValue({
      id: 44,
      name: 'demo-site',
      url: 'https://panel.example.com',
      platform: 'openai',
    });
    getProxyVideoTaskByPublicIdMock.mockResolvedValue({
      publicId: 'vid_local_args_get',
      upstreamVideoId: 'vid_upstream_args_get',
      siteUrl: 'https://api-videos.example.com',
      tokenValue: 'sk-demo',
      accountId: 33,
    });
    const rawBody = JSON.stringify({
      error: { message: 'openai_error', type: 'validation_error' },
    });
    fetchMock.mockResolvedValue(new Response(rawBody, {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }));

    await app.inject({ method: 'GET', url: '/v1/videos/vid_local_args_get' });

    expect(shouldRetryProxyRequestMock).toHaveBeenCalledWith(
      400,
      'Upstream returned HTTP 400: openai_error',
      rawBody,
    );
  });

  it('answers a mixed-cause multi-channel request from every attempt, not just the last', async () => {
    // Only this test authenticates: an opted-in downstream key is what puts the failure
    // in the resilient policy's scope, which is where aggregation becomes observable.
    const previousPolicy = structuredClone(config.downstreamErrorPolicy);
    config.downstreamErrorPolicy = { mode: 'resilient', downstreamApiKeyIds: [12] };
    proxyAuthContext = {
      token: 'sk-managed',
      source: 'managed',
      keyId: 12,
      keyName: 'dedicated',
      policy: {},
    };
    shouldRetryProxyRequestMock.mockReturnValue(true);
    selectNextChannelMock.mockReturnValue({
      channel: { id: 12, routeId: 22 },
      site: { id: 45, name: 'other-site', url: 'https://other.example.com', platform: 'openai' },
      account: { id: 34, username: 'other-user' },
      tokenName: 'default',
      tokenValue: 'sk-other',
      actualModel: 'sora-2',
    });
    // Channel A is rate limited, the rest are unauthenticated: two unrelated causes, so
    // relaying only the final attempt would report "auth" for a request that also died of
    // a rate limit. Each call must build a FRESH Response — a single instance can only be
    // read once, and the later attempts would then see an empty body (a different cause,
    // which would make this pass for the wrong reason).
    let attempt = 0;
    fetchMock.mockImplementation(async () => {
      attempt += 1;
      return attempt === 1
        ? new Response(JSON.stringify({ error: { message: 'rate limit exceeded' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        })
        : new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/videos',
        payload: { model: 'sora-2', prompt: 'a cat walking' },
      });

      expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: {
          message: 'All configured upstream channels are currently unavailable.',
          type: 'server_error',
          code: 'metapi_upstream_pool_exhausted',
        },
      });
    } finally {
      config.downstreamErrorPolicy = previousPolicy;
    }
  });

  it('keeps the specific cause when every channel failed the same way', async () => {
    const previousPolicy = structuredClone(config.downstreamErrorPolicy);
    config.downstreamErrorPolicy = { mode: 'resilient', downstreamApiKeyIds: [12] };
    proxyAuthContext = {
      token: 'sk-managed',
      source: 'managed',
      keyId: 12,
      keyName: 'dedicated',
      policy: {},
    };
    shouldRetryProxyRequestMock.mockReturnValue(true);
    selectNextChannelMock.mockReturnValue({
      channel: { id: 12, routeId: 22 },
      site: { id: 45, name: 'other-site', url: 'https://other.example.com', platform: 'openai' },
      account: { id: 34, username: 'other-user' },
      tokenName: 'default',
      tokenValue: 'sk-other',
      actualModel: 'sora-2',
    });
    // Fresh Response per call: reusing one instance leaves the body consumed after the
    // first read, and the resulting empty message infers a different cause.
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({
      error: { message: 'rate limit exceeded' },
    }), { status: 429, headers: { 'content-type': 'application/json' } }));

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/videos',
        payload: { model: 'sora-2', prompt: 'a cat walking' },
      });

      // One shared cause must keep its specific answer instead of collapsing into the
      // generic pool-exhausted one.
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: {
          message: 'All configured upstream channels are temporarily unavailable.',
          type: 'server_error',
          code: 'metapi_upstream_rate_limited',
        },
      });
    } finally {
      config.downstreamErrorPolicy = previousPolicy;
    }
  });

  describe('indeterminate 4xx channel retry', () => {
    // An unexplained 400/422 cannot be told apart from "this channel refuses a body a
    // sibling accepts" by looking at the response, so an opted-in key spends one more
    // channel to find out. `shouldRetryProxyRequest` returning false is not incidental
    // setup here: it is exactly how control reaches this path in production.
    const optIn = (overrides?: { includePayloadTooLarge?: boolean; maxAttempts?: number }) => {
      config.downstreamErrorPolicy = {
        mode: 'resilient',
        downstreamApiKeyIds: [12],
        indeterminateRetry: {
          enabled: true,
          includePayloadTooLarge: overrides?.includePayloadTooLarge ?? false,
          maxAttempts: overrides?.maxAttempts ?? 3,
        },
      };
      proxyAuthContext = {
        token: 'sk-managed',
        source: 'managed',
        keyId: 12,
        keyName: 'dedicated',
        policy: {},
      };
      shouldRetryProxyRequestMock.mockReturnValue(false);
      selectNextChannelMock.mockImplementation(() => ({
        channel: { id: 12, routeId: 22 },
        site: { id: 45, name: 'other-site', url: 'https://other.example.com', platform: 'openai' },
        account: { id: 34, username: 'other-user' },
        tokenName: 'default',
        tokenValue: 'sk-other',
        actualModel: 'sora-2',
      }));
    };

    // Fresh Response per call — a single instance has its body consumed after one read.
    const reply4xx = (bodies: string[], status = 400) => {
      let call = 0;
      fetchMock.mockImplementation(async () => {
        const body = bodies[Math.min(call, bodies.length - 1)];
        call += 1;
        return new Response(body, {
          status,
          headers: { 'content-type': 'application/json' },
        });
      });
    };

    const createVideo = () => app.inject({
      method: 'POST',
      url: '/v1/videos',
      payload: { model: 'sora-2', prompt: 'a cat walking' },
    });

    let previousPolicy: typeof config.downstreamErrorPolicy;

    beforeEach(() => {
      previousPolicy = structuredClone(config.downstreamErrorPolicy);
    });

    afterEach(() => {
      config.downstreamErrorPolicy = previousPolicy;
    });

    it('keeps the loop bound and the retry guard in step while spending the raised budget', async () => {
      // The raised budget has to reach the `while` bound, not just the guards. If a guard
      // authorizes a probe the loop then refuses, the handler falls out with nothing sent:
      // a hung socket in production, and — measured — a bogus empty 200 under `inject`.
      // So the fallthrough signature is a 200 where a failure was due, which is why this
      // asserts the upstream's own status rather than merely "some number came back".
      optIn();
      reply4xx([
        '{"error":{"message":"refused by channel one","type":"channel_one_refusal"}}',
        '{"error":{"message":"refused by channel two","type":"channel_two_refusal"}}',
        '{"error":{"message":"refused by channel three","type":"channel_three_refusal"}}',
        '{"error":{"message":"refused by channel four","type":"channel_four_refusal"}}',
      ]);

      const response = await createVideo();

      expect(response.statusCode).toBe(400);
      expect(response.body.length).toBeGreaterThan(0);
      // base retries (2) + feature budget (3), capped by MAX_TOTAL_CHANNEL_ATTEMPTS (4).
      expect(fetchMock.mock.calls.length).toBe(4);
    });

    it('still hands an unexplained 400 back to the caller once the probes are spent', async () => {
      // Spending channels must not change WHAT the caller is told: a 4xx that was never
      // explained still belongs to them verbatim, per the deterministic-request-failure
      // guard in downstreamErrorPolicy. The probe buys a second opinion, not a rewrite.
      optIn();
      reply4xx([
        '{"error":{"message":"refused by channel one","type":"channel_one_refusal"}}',
        '{"error":{"message":"refused by channel two","type":"channel_two_refusal"}}',
        '{"error":{"message":"refused by channel three","type":"channel_three_refusal"}}',
        '{"error":{"message":"refused by channel four","type":"channel_four_refusal"}}',
      ]);

      const response = await createVideo();

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { message: expect.stringContaining('refused by channel four') },
      });
    });

    it('stops probing once the same rejection repeats, instead of spending the budget', async () => {
      // A repeat proves the body is at fault, not the channel. Without signature dedup
      // this would burn all four attempts re-uploading a payload nobody will accept.
      optIn();
      reply4xx(['{"error":{"message":"refused everywhere","type":"same_refusal"}}']);

      const response = await createVideo();

      expect(fetchMock.mock.calls.length).toBe(2);
      expect(response.statusCode).toBe(400);
    });

    it('does not probe a 400 that names a request-shape defect', async () => {
      // `missing required` is determinate: every channel rejects it identically, so a
      // probe only re-uploads it. One attempt, answer straight back.
      optIn();
      reply4xx(['{"error":{"message":"messages: missing required field"}}']);

      const response = await createVideo();

      expect(fetchMock.mock.calls.length).toBe(1);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { message: expect.stringContaining('missing required field') },
      });
    });

    it('leaves 413 alone until the payload-size opt-in is set', async () => {
      // Retrying 413 re-uploads the whole body and the first upstream may already have
      // billed for it, so it needs its own switch rather than riding along with 400/422.
      optIn({ includePayloadTooLarge: false });
      reply4xx(['{"error":{"message":"request entity too large"}}'], 413);

      const response = await createVideo();

      expect(fetchMock.mock.calls.length).toBe(1);
      expect(response.statusCode).toBe(413);
    });

    it('probes 413 once the payload-size opt-in is set', async () => {
      optIn({ includePayloadTooLarge: true });
      reply4xx([
        '{"error":{"message":"too large for channel one","type":"channel_one_limit"}}',
        '{"error":{"message":"too large for channel two","type":"channel_two_limit"}}',
      ], 413);

      const response = await createVideo();

      expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
      expect(response.statusCode).toBe(413);
    });

    it('gives an out-of-scope key the unchanged single-attempt behaviour', async () => {
      // Same 400, same everything — only the key is not listed. The feature is a per-key
      // service level, so an unlisted key must see exactly the legacy shape.
      optIn();
      config.downstreamErrorPolicy = {
        ...config.downstreamErrorPolicy,
        downstreamApiKeyIds: [99],
      };
      reply4xx([
        '{"error":{"message":"refused by channel one","type":"channel_one_refusal"}}',
        '{"error":{"message":"refused by channel two","type":"channel_two_refusal"}}',
      ]);

      const response = await createVideo();

      expect(fetchMock.mock.calls.length).toBe(1);
      expect(response.statusCode).toBe(400);
    });

    it('does not let the raised budget inflate an ordinary retryable failure', async () => {
      // The raised ceiling belongs to the indeterminate path only. A 502 keeps the base
      // budget, or enabling a resilience feature would quietly hand every failure type an
      // extra upstream attempt.
      optIn();
      shouldRetryProxyRequestMock.mockReturnValue(true);
      fetchMock.mockImplementation(async () => new Response('bad gateway', {
        status: 502,
        headers: { 'content-type': 'text/plain' },
      }));

      const response = await createVideo();

      // base retries (2) + 1 = 3 attempts, NOT the raised 4.
      expect(fetchMock.mock.calls.length).toBe(3);
      // A rewritten pool answer, not the empty 200 that a loop fallthrough produces.
      expect(response.statusCode).toBe(503);
    });
  });
});
