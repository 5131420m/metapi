import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
});
