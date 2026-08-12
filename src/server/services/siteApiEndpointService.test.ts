import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type SiteApiEndpointServiceModule = typeof import('./siteApiEndpointService.js');

describe('siteApiEndpointService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let selectSiteApiEndpointTarget: SiteApiEndpointServiceModule['selectSiteApiEndpointTarget'];
  let recordSiteApiEndpointFailure: SiteApiEndpointServiceModule['recordSiteApiEndpointFailure'];
  let recordSiteApiEndpointSuccess: SiteApiEndpointServiceModule['recordSiteApiEndpointSuccess'];
  let recordSiteApiFallbackFailure: SiteApiEndpointServiceModule['recordSiteApiFallbackFailure'];
  let runWithSiteApiEndpointPool: SiteApiEndpointServiceModule['runWithSiteApiEndpointPool'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-site-api-endpoint-service-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const serviceModule = await import('./siteApiEndpointService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    selectSiteApiEndpointTarget = serviceModule.selectSiteApiEndpointTarget;
    recordSiteApiEndpointFailure = serviceModule.recordSiteApiEndpointFailure;
    recordSiteApiEndpointSuccess = serviceModule.recordSiteApiEndpointSuccess;
    recordSiteApiFallbackFailure = serviceModule.recordSiteApiFallbackFailure;
    runWithSiteApiEndpointPool = serviceModule.runWithSiteApiEndpointPool;
  });

  beforeEach(async () => {
    await db.delete(schema.siteApiEndpoints).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('returns a synthetic site-url fallback when the site has no configured api endpoints', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'panel-only-site',
      url: 'https://panel.example.com/',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const selected = await selectSiteApiEndpointTarget(site, '2026-03-31T12:00:00.000Z');

    expect(selected).toMatchObject({
      kind: 'site-fallback',
      siteId: site.id,
      endpointId: null,
      baseUrl: 'https://panel.example.com',
      configuredEndpointCount: 0,
    });
  });

  it('selects the least recently selected enabled endpoint when sort order is tied', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'pool-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    await db.insert(schema.siteApiEndpoints).values([
      {
        siteId: site.id,
        url: 'https://api-b.example.com',
        enabled: true,
        sortOrder: 1,
        lastSelectedAt: '2026-03-31T11:59:00.000Z',
      },
      {
        siteId: site.id,
        url: 'https://api-a.example.com/',
        enabled: true,
        sortOrder: 0,
        lastSelectedAt: '2026-03-31T11:00:00.000Z',
      },
    ]).run();

    const selected = await selectSiteApiEndpointTarget(site, '2026-03-31T12:00:00.000Z');

    expect(selected).toMatchObject({
      kind: 'endpoint',
      siteId: site.id,
      baseUrl: 'https://api-a.example.com',
      configuredEndpointCount: 2,
      endpoint: expect.objectContaining({
        url: 'https://api-a.example.com/',
        sortOrder: 0,
      }),
    });
  });

  it('prefers lower sortOrder before lastSelectedAt when selecting an enabled endpoint', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'ordered-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    await db.insert(schema.siteApiEndpoints).values([
      {
        siteId: site.id,
        url: 'https://api-secondary.example.com',
        enabled: true,
        sortOrder: 1,
        lastSelectedAt: '2026-03-31T11:00:00.000Z',
      },
      {
        siteId: site.id,
        url: 'https://api-primary.example.com',
        enabled: true,
        sortOrder: 0,
        lastSelectedAt: '2026-03-31T11:59:00.000Z',
      },
    ]).run();

    const selected = await selectSiteApiEndpointTarget(site, '2026-03-31T12:00:00.000Z');

    expect(selected).toMatchObject({
      kind: 'endpoint',
      siteId: site.id,
      baseUrl: 'https://api-primary.example.com',
      configuredEndpointCount: 2,
      endpoint: expect.objectContaining({
        url: 'https://api-primary.example.com',
        sortOrder: 0,
      }),
    });
  });

  it('skips disabled endpoints and endpoints that are still cooling down', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'filtered-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    await db.insert(schema.siteApiEndpoints).values([
      {
        siteId: site.id,
        url: 'https://api-disabled.example.com',
        enabled: false,
        sortOrder: 0,
      },
      {
        siteId: site.id,
        url: 'https://api-cooling.example.com',
        enabled: true,
        sortOrder: 1,
        cooldownUntil: '2026-03-31T12:05:00.000Z',
      },
      {
        siteId: site.id,
        url: 'https://api-ready.example.com',
        enabled: true,
        sortOrder: 2,
        cooldownUntil: '2026-03-31T11:55:00.000Z',
      },
    ]).run();

    const selected = await selectSiteApiEndpointTarget(site, '2026-03-31T12:00:00.000Z');

    expect(selected).toMatchObject({
      kind: 'endpoint',
      baseUrl: 'https://api-ready.example.com',
      configuredEndpointCount: 3,
    });
  });

  it('returns the site URL fallback when configured api endpoints are all unavailable', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'exhausted-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    await db.insert(schema.siteApiEndpoints).values([
      {
        siteId: site.id,
        url: 'https://api-disabled.example.com',
        enabled: false,
        sortOrder: 0,
      },
      {
        siteId: site.id,
        url: 'https://api-cooling.example.com',
        enabled: true,
        sortOrder: 1,
        cooldownUntil: '2026-03-31T12:05:00.000Z',
      },
    ]).run();

    const selected = await selectSiteApiEndpointTarget(site, '2026-03-31T12:00:00.000Z');

    expect(selected).toMatchObject({
      kind: 'site-fallback',
      siteId: site.id,
      endpointId: null,
      baseUrl: 'https://panel.example.com',
      configuredEndpointCount: 2,
      endpoint: null,
    });
  });

  it('rotates retryable endpoint failures to the site URL fallback', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'rotation-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    await db.insert(schema.siteApiEndpoints).values([
      { siteId: site.id, url: 'https://api-a.example.com', enabled: true, sortOrder: 0 },
      { siteId: site.id, url: 'https://api-b.example.com', enabled: true, sortOrder: 1 },
    ]).run();
    const attempted: string[] = [];

    const result = await runWithSiteApiEndpointPool(site, async (target) => {
      attempted.push(target.baseUrl);
      if (target.kind === 'endpoint') {
        throw new Error(target.baseUrl.includes('api-a')
          ? 'HTTP 502: temporary failure'
          : 'fetch failed');
      }
      return 'site-ok';
    });

    expect(result).toBe('site-ok');
    expect(attempted).toEqual([
      'https://api-a.example.com',
      'https://api-b.example.com',
      'https://panel.example.com',
    ]);
    const stored = await db.select().from(schema.siteApiEndpoints)
      .orderBy(asc(schema.siteApiEndpoints.sortOrder))
      .all();
    expect(stored.map((endpoint) => endpoint.cooldownUntil)).toEqual([null, null]);
  });

  it('does not rotate or fall back after a non-retryable endpoint failure', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'auth-failure-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    await db.insert(schema.siteApiEndpoints).values([
      { siteId: site.id, url: 'https://api-a.example.com', enabled: true, sortOrder: 0 },
      { siteId: site.id, url: 'https://api-b.example.com', enabled: true, sortOrder: 1 },
    ]).run();
    const attempted: string[] = [];

    await expect(runWithSiteApiEndpointPool(site, async (target) => {
      attempted.push(target.baseUrl);
      throw new Error('HTTP 401: Invalid token');
    })).rejects.toThrow('HTTP 401');

    expect(attempted).toEqual(['https://api-a.example.com']);
  });

  it('returns the site fallback error when the site also fails', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'all-failed-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-a.example.com',
      enabled: true,
      sortOrder: 0,
    }).run();

    await expect(runWithSiteApiEndpointPool(site, async (target) => {
      if (target.kind === 'endpoint') throw new Error('HTTP 502: pool failed');
      throw new Error('site fallback fetch failed');
    })).rejects.toThrow('site fallback fetch failed');
  });

  it('returns null when fallback is disabled and no configured endpoints are eligible', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'fallback-disabled-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
      apiEndpointSiteFallbackEnabled: false,
    }).returning().get();
    await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-cooling.example.com',
      enabled: true,
      cooldownUntil: '2099-01-01T00:00:00.000Z',
    }).run();

    expect(await selectSiteApiEndpointTarget(site)).toBeNull();
  });

  it('keeps the enabled site fallback eligible despite stale cooldown metadata', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'fallback-cooling-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
      apiEndpointSiteFallbackEnabled: true,
      apiEndpointSiteFallbackCooldownUntil: '2099-01-01T00:00:00.000Z',
    }).returning().get();

    expect(await selectSiteApiEndpointTarget(site)).toMatchObject({
      kind: 'site-fallback',
      siteId: site.id,
      baseUrl: 'https://panel.example.com',
    });
  });

  it('records site fallback failures without hard-cooling the primary site URL', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'fallback-failure-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
      apiEndpointSiteFallbackEnabled: true,
    }).returning().get();

    const result = await recordSiteApiFallbackFailure(site.id, {
      status: 502,
      message: 'Bad gateway',
    }, '2026-03-31T12:00:00.000Z');

    expect(result).toMatchObject({
      retryable: true,
      cooldownUntil: null,
      failureReason: 'HTTP 502: Bad gateway',
    });
    expect(await db.select().from(schema.sites).where(eq(schema.sites.id, site.id)).get()).toMatchObject({
      apiEndpointSiteFallbackCooldownUntil: null,
      apiEndpointSiteFallbackLastFailedAt: '2026-03-31T12:00:00.000Z',
      apiEndpointSiteFallbackLastFailureReason: 'HTTP 502: Bad gateway',
    });
  });

  it('records fallback failure and success state through the pool runner', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'fallback-runner-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
      apiEndpointSiteFallbackEnabled: true,
    }).returning().get();

    await expect(runWithSiteApiEndpointPool(site, async () => {
      throw new Error('HTTP 502: primary failed');
    })).rejects.toThrow('HTTP 502');
    const failed = await db.select().from(schema.sites).where(eq(schema.sites.id, site.id)).get();
    expect(failed?.apiEndpointSiteFallbackCooldownUntil).toBeNull();

    expect(await runWithSiteApiEndpointPool(site, async () => 'ok')).toBe('ok');
    expect(await db.select().from(schema.sites).where(eq(schema.sites.id, site.id)).get()).toMatchObject({
      apiEndpointSiteFallbackCooldownUntil: null,
      apiEndpointSiteFallbackLastFailureReason: null,
    });
  });

  it('requires three distinct request failures before cooling an endpoint for gateway 5xx', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'retryable-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-retryable.example.com',
      enabled: true,
      sortOrder: 0,
    }).returning().get();

    const first = await recordSiteApiEndpointFailure(endpoint.id, {
      status: 502,
      message: 'Bad gateway',
      requestScopeId: 'req-1',
    }, '2026-03-31T12:00:00.000Z');

    expect(first).toMatchObject({
      retryable: true,
      rotateToNextEndpoint: true,
      cooldownUntil: null,
      failureReason: 'HTTP 502: Bad gateway',
    });

    const duplicate = await recordSiteApiEndpointFailure(endpoint.id, {
      status: 502,
      message: 'Bad gateway',
      requestScopeId: 'req-1',
    }, '2026-03-31T12:00:10.000Z');
    expect(duplicate.cooldownUntil).toBeNull();

    const second = await recordSiteApiEndpointFailure(endpoint.id, {
      status: 503,
      message: 'Unavailable',
      requestScopeId: 'req-2',
    }, '2026-03-31T12:00:20.000Z');
    expect(second.cooldownUntil).toBeNull();

    const third = await recordSiteApiEndpointFailure(endpoint.id, {
      status: 504,
      message: 'Gateway timeout',
      requestScopeId: 'req-3',
    }, '2026-03-31T12:00:40.000Z');
    expect(third.cooldownUntil).toBe('2026-03-31T12:05:40.000Z');

    const stored = await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.id, endpoint.id))
      .get();
    expect(stored).toMatchObject({
      cooldownUntil: '2026-03-31T12:05:40.000Z',
      lastFailedAt: '2026-03-31T12:00:40.000Z',
      lastFailureReason: 'HTTP 504: Gateway timeout',
      consecutiveFailureCount: 3,
    });
  });

  it('counts concurrent gateway failures from distinct request scopes', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'concurrent-threshold-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-concurrent.example.com',
      enabled: true,
    }).returning().get();

    await Promise.all([
      recordSiteApiEndpointFailure(endpoint.id, { status: 503, message: 'busy', requestScopeId: 'scope-a' }, '2026-03-31T12:00:00.000Z'),
      recordSiteApiEndpointFailure(endpoint.id, { status: 503, message: 'busy', requestScopeId: 'scope-b' }, '2026-03-31T12:00:00.000Z'),
    ]);

    expect(await db.select().from(schema.siteApiEndpoints).where(eq(schema.siteApiEndpoints.id, endpoint.id)).get()).toMatchObject({
      consecutiveFailureCount: 2,
      cooldownUntil: null,
    });
  });

  it('parses retryable HTTP status codes from failure messages when no explicit status is provided', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'message-status-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-message-status.example.com',
      enabled: true,
      sortOrder: 0,
    }).returning().get();

    const result = await recordSiteApiEndpointFailure(endpoint.id, {
      message: 'HTTP 502: upstream temporarily unavailable',
    }, '2026-03-31T12:00:00.000Z');

    expect(result).toMatchObject({
      retryable: true,
      rotateToNextEndpoint: true,
      cooldownUntil: null,
      failureReason: 'HTTP 502: upstream temporarily unavailable',
    });
  });

  it('rotates without cooling or counting status 500, status 429, and synthetic first-byte timeout', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'non-address-failure-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api.example.com',
      enabled: true,
      sortOrder: 0,
    }).returning().get();

    const serverError = await recordSiteApiEndpointFailure(endpoint.id, {
      status: 500,
      message: 'Internal error',
      requestScopeId: 'req-500',
    }, '2026-03-31T12:00:00.000Z');
    expect(serverError).toMatchObject({ rotateToNextEndpoint: true, cooldownUntil: null });

    const rateLimit = await recordSiteApiEndpointFailure(endpoint.id, {
      status: 429,
      message: 'Rate limited',
      requestScopeId: 'req-429',
    }, '2026-03-31T12:00:10.000Z');
    expect(rateLimit).toMatchObject({ rotateToNextEndpoint: false, cooldownUntil: null });

    const firstByteTimeout = await recordSiteApiEndpointFailure(endpoint.id, {
      status: 408,
      message: 'first byte timeout (45s)',
      failureKind: 'first-byte-timeout',
      requestScopeId: 'req-first-byte',
    }, '2026-03-31T12:00:20.000Z');
    expect(firstByteTimeout).toMatchObject({ rotateToNextEndpoint: true, cooldownUntil: null });

    expect(await db.select().from(schema.siteApiEndpoints).where(eq(schema.siteApiEndpoints.id, endpoint.id)).get()).toMatchObject({
      cooldownUntil: null,
      consecutiveFailureCount: 0,
    });
  });

  it('immediately cools a custom endpoint after a clear DNS failure', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'dns-failure-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://missing.example.com',
      enabled: true,
      sortOrder: 0,
    }).returning().get();

    const result = await recordSiteApiEndpointFailure(endpoint.id, {
      message: 'getaddrinfo ENOTFOUND missing.example.com',
      requestScopeId: 'req-dns',
    }, '2026-03-31T12:00:00.000Z');

    expect(result.cooldownUntil).toBe('2026-03-31T12:05:00.000Z');
  });

  it('resets the gateway-failure streak after a successful endpoint request', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'streak-reset-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api.example.com',
      enabled: true,
      sortOrder: 0,
    }).returning().get();

    await recordSiteApiEndpointFailure(endpoint.id, {
      status: 502,
      message: 'Bad gateway',
      requestScopeId: 'req-1',
    }, '2026-03-31T12:00:00.000Z');
    await recordSiteApiEndpointSuccess(endpoint.id, '2026-03-31T12:00:10.000Z');

    expect(await db.select().from(schema.siteApiEndpoints).where(eq(schema.siteApiEndpoints.id, endpoint.id)).get()).toMatchObject({
      cooldownUntil: null,
      consecutiveFailureCount: 0,
      failureWindowStartedAt: null,
      lastFailureScopeId: null,
    });
  });

  it('stops at an exhausted request deadline without selecting or cooling another target', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'deadline-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    await db.insert(schema.siteApiEndpoints).values([
      { siteId: site.id, url: 'https://api-a.example.com', enabled: true, sortOrder: 0 },
      { siteId: site.id, url: 'https://api-b.example.com', enabled: true, sortOrder: 1 },
    ]).run();
    const attempted: string[] = [];

    await expect(runWithSiteApiEndpointPool(site, async (target, context) => {
      attempted.push(target.baseUrl);
      await new Promise<void>((_, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('aborted by deadline')), { once: true });
      });
      return 'unreachable';
    }, {
      deadlineAtMs: Date.now() + 20,
      timeoutMessage: 'model discovery timeout (12s)',
      requestScopeId: 'refresh-1',
    })).rejects.toThrow('model discovery timeout');

    expect(attempted).toEqual(['https://api-a.example.com']);
    const endpoints = await db.select().from(schema.siteApiEndpoints)
      .orderBy(asc(schema.siteApiEndpoints.sortOrder))
      .all();
    expect(endpoints.map((row) => row.cooldownUntil)).toEqual([null, null]);
  });

  it('records auth and validation failures without triggering cooldown rotation', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'non-retryable-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-auth.example.com',
      enabled: true,
      sortOrder: 0,
      cooldownUntil: '2026-03-31T11:00:00.000Z',
    }).returning().get();

    const result = await recordSiteApiEndpointFailure(endpoint.id, {
      status: 401,
      message: 'Invalid token',
    }, '2026-03-31T12:00:00.000Z');

    expect(result).toMatchObject({
      retryable: false,
      rotateToNextEndpoint: false,
      cooldownUntil: null,
      failureReason: 'HTTP 401: Invalid token',
    });

    const stored = await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.id, endpoint.id))
      .get();
    expect(stored).toMatchObject({
      cooldownUntil: null,
      lastFailedAt: '2026-03-31T12:00:00.000Z',
      lastFailureReason: 'HTTP 401: Invalid token',
    });
  });

  it('clears cooldown metadata and updates lastSelectedAt after a recorded success', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'success-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-success.example.com',
      enabled: true,
      sortOrder: 0,
      cooldownUntil: '2026-03-31T12:05:00.000Z',
      lastFailedAt: '2026-03-31T12:00:00.000Z',
      lastFailureReason: 'HTTP 502: Bad gateway',
    }).returning().get();

    await recordSiteApiEndpointSuccess(endpoint.id, '2026-03-31T12:01:00.000Z');

    const stored = await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.id, endpoint.id))
      .orderBy(asc(schema.siteApiEndpoints.id))
      .get();
    expect(stored).toMatchObject({
      cooldownUntil: null,
      lastSelectedAt: '2026-03-31T12:01:00.000Z',
      lastFailureReason: null,
    });
  });
});
