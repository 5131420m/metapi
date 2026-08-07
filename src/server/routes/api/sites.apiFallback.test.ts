import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');

describe('sites API main AI fallback settings', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-sites-api-fallback-'));
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./sites.js');
    db = dbModule.db;
    schema = dbModule.schema;
    app = Fastify();
    await app.register(routesModule.sitesRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.siteApiEndpoints).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('creates sites with main AI fallback enabled by default', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sites',
      payload: { name: 'default-fallback', url: 'https://default.example.com', platform: 'new-api' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ apiEndpointSiteFallbackEnabled: true });
  });

  it('persists fallback disable and clears stale runtime cooldown state', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'toggle-fallback',
      url: 'https://toggle.example.com',
      platform: 'new-api',
      apiEndpointSiteFallbackEnabled: true,
      apiEndpointSiteFallbackCooldownUntil: '2099-01-01T00:00:00.000Z',
      apiEndpointSiteFallbackLastSelectedAt: '2026-01-01T00:00:00.000Z',
      apiEndpointSiteFallbackLastFailedAt: '2026-01-02T00:00:00.000Z',
      apiEndpointSiteFallbackLastFailureReason: 'HTTP 502',
    }).returning().get();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/sites/${site.id}`,
      payload: { apiEndpointSiteFallbackEnabled: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      apiEndpointSiteFallbackEnabled: false,
      apiEndpointSiteFallbackCooldownUntil: null,
      apiEndpointSiteFallbackLastFailureReason: null,
    });
    expect(await db.select().from(schema.sites).where(eq(schema.sites.id, site.id)).get()).toMatchObject({
      apiEndpointSiteFallbackEnabled: false,
      apiEndpointSiteFallbackCooldownUntil: null,
      apiEndpointSiteFallbackLastSelectedAt: null,
      apiEndpointSiteFallbackLastFailedAt: null,
      apiEndpointSiteFallbackLastFailureReason: null,
    });
  });

  it('rejects invalid fallback flags', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'invalid-fallback',
      url: 'https://invalid.example.com',
      platform: 'new-api',
    }).returning().get();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/sites/${site.id}`,
      payload: { apiEndpointSiteFallbackEnabled: 'sometimes' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'Invalid apiEndpointSiteFallbackEnabled value. Expected boolean.' });
  });
});
