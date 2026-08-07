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
    expect(stored.every((endpoint) => !!endpoint.cooldownUntil)).toBe(true);
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

  it('skips the site fallback while its independent AI API cooldown is active', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'fallback-cooling-site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      status: 'active',
      apiEndpointSiteFallbackEnabled: true,
      apiEndpointSiteFallbackCooldownUntil: '2099-01-01T00:00:00.000Z',
    }).returning().get();

    expect(await selectSiteApiEndpointTarget(site)).toBeNull();
  });

  it('records retryable site fallback failures in the independent AI API cooldown fields', async () => {
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
      cooldownUntil: '2026-03-31T12:05:00.000Z',
      failureReason: 'HTTP 502: Bad gateway',
    });
    expect(await db.select().from(schema.sites).where(eq(schema.sites.id, site.id)).get()).toMatchObject({
      apiEndpointSiteFallbackCooldownUntil: '2026-03-31T12:05:00.000Z',
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
    expect(failed?.apiEndpointSiteFallbackCooldownUntil).toBeTruthy();

    await db.update(schema.sites).set({ apiEndpointSiteFallbackCooldownUntil: null }).where(eq(schema.sites.id, site.id)).run();
    expect(await runWithSiteApiEndpointPool(site, async () => 'ok')).toBe('ok');
    expect(await db.select().from(schema.sites).where(eq(schema.sites.id, site.id)).get()).toMatchObject({
      apiEndpointSiteFallbackCooldownUntil: null,
      apiEndpointSiteFallbackLastFailureReason: null,
    });
  });

  it('records retryable failures with a 5-minute cooldown', async () => {
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

    const result = await recordSiteApiEndpointFailure(endpoint.id, {
      status: 502,
      message: 'Bad gateway',
    }, '2026-03-31T12:00:00.000Z');

    expect(result).toMatchObject({
      retryable: true,
      rotateToNextEndpoint: true,
      cooldownUntil: '2026-03-31T12:05:00.000Z',
      failureReason: 'HTTP 502: Bad gateway',
    });

    const stored = await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.id, endpoint.id))
      .get();
    expect(stored).toMatchObject({
      cooldownUntil: '2026-03-31T12:05:00.000Z',
      lastFailedAt: '2026-03-31T12:00:00.000Z',
      lastFailureReason: 'HTTP 502: Bad gateway',
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
      cooldownUntil: '2026-03-31T12:05:00.000Z',
      failureReason: 'HTTP 502: upstream temporarily unavailable',
    });
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
