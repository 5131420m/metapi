import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');
type ConfigModule = typeof import('../../config.js');
type SchedulerModule = typeof import('../../services/candyProbeScheduler.js');
type StoreModule = typeof import('../../services/candyProbe/resultStore.js');

/**
 * The candy-schedule runtime settings: persist, hydrate the config, and start/stop the
 * scheduler immediately. The toggle flipping a background probe that spends real upstream
 * quota is exactly the kind of switch that must not wait for a restart.
 */
describe('settings candy probe schedule wiring', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let config: ConfigModule['config'];
  let stopCandyProbeScheduler: SchedulerModule['stopCandyProbeScheduler'];
  let resetCandyProbeSchedulerForTests: SchedulerModule['resetCandyProbeSchedulerForTests'];
  let recordCandyProbeResult: StoreModule['recordCandyProbeResult'];
  let getCandyProbeSnapshots: StoreModule['getCandyProbeSnapshots'];
  let resetCandyProbeStoreForTests: StoreModule['resetCandyProbeStoreForTests'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-settings-candy-schedule-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const configModule = await import('../../config.js');
    const settingsRoutesModule = await import('./settings.js');
    const schedulerModule = await import('../../services/candyProbeScheduler.js');
    const storeModule = await import('../../services/candyProbe/resultStore.js');

    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;
    stopCandyProbeScheduler = schedulerModule.stopCandyProbeScheduler;
    resetCandyProbeSchedulerForTests = schedulerModule.resetCandyProbeSchedulerForTests;
    recordCandyProbeResult = storeModule.recordCandyProbeResult;
    getCandyProbeSnapshots = storeModule.getCandyProbeSnapshots;
    resetCandyProbeStoreForTests = storeModule.resetCandyProbeStoreForTests;

    app = Fastify();
    await app.register(settingsRoutesModule.settingsRoutes);
  });

  beforeEach(async () => {
    resetCandyProbeSchedulerForTests();
    resetCandyProbeStoreForTests();
    await db.delete(schema.settings).run();
    config.candyProbeScheduleEnabled = false;
    config.candyProbeScheduleRecheckHours = 12;
  });

  afterAll(async () => {
    resetCandyProbeSchedulerForTests();
    await app.close();
    delete process.env.DATA_DIR;
  });

  async function readSetting(key: string): Promise<unknown> {
    const row = await db.select()
      .from(schema.settings)
      .where(eq(schema.settings.key, key))
      .get();
    return row?.value ?? null;
  }

  /** The observable effect of start/stop: the freshness TTL the badges use. */
  async function currentFreshnessTtlMs(): Promise<number> {
    const checkedAt = new Date().toISOString();
    recordCandyProbeResult({
      channelId: 990001,
      routeId: null,
      model: 'gpt-5.4',
      fingerprint: 'generic_openai',
      verdict: 'pass',
      score: 1,
      total: 1,
      endpoint: null,
      actualModel: null,
      latencyMs: 1,
      checkedAt,
      reason: null,
      question: { id: 'candy-bag-reference', prompt: '', expected: '21' },
      samples: [{ index: 1, answer: '21', correct: true, note: null }],
      validSampleCount: 1,
      expectation: 'expected',
      config: { model: 'gpt-5.4', accountId: null, tokenId: null },
      trigger: 'schedule',
    });
    const snapshot = getCandyProbeSnapshots([990001])[String(990001)]!;
    return Date.parse(snapshot.expiresAt) - Date.parse(snapshot.checkedAt);
  }

  it('enables the schedule: persists, flips the config, and starts the scheduler', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { candyProbeScheduleEnabled: true },
    });
    expect(response.statusCode).toBe(200);

    expect(config.candyProbeScheduleEnabled).toBe(true);
    expect(await readSetting('candy_probe_schedule_enabled')).toBe('true');
    // Started means the badges' freshness horizon follows the recheck cadence, not the
    // flat default hour.
    expect(await currentFreshnessTtlMs()).toBeGreaterThan(12 * 60 * 60 * 1000);
  });

  it('disables the schedule and restores the default freshness horizon', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { candyProbeScheduleEnabled: true },
    });
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { candyProbeScheduleEnabled: false },
    });
    expect(response.statusCode).toBe(200);

    expect(config.candyProbeScheduleEnabled).toBe(false);
    expect(await readSetting('candy_probe_schedule_enabled')).toBe('false');
    expect(await currentFreshnessTtlMs()).toBe(60 * 60 * 1000);
  });

  it('persists the recheck cadence and rejects out-of-range values', async () => {
    const ok = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { candyProbeScheduleRecheckHours: 24 },
    });
    expect(ok.statusCode).toBe(200);
    expect(config.candyProbeScheduleRecheckHours).toBe(24);
    expect(await readSetting('candy_probe_schedule_recheck_hours')).toBe('24');

    const bad = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { candyProbeScheduleRecheckHours: 100 },
    });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.payload).message).toContain('1-72');
  });

  it('returns both fields from the runtime settings read-back', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { candyProbeScheduleEnabled: true, candyProbeScheduleRecheckHours: 48 },
    });

    const response = await app.inject({ method: 'GET', url: '/api/settings/runtime' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.candyProbeScheduleEnabled).toBe(true);
    expect(body.candyProbeScheduleRecheckHours).toBe(48);
  });

  it('applies imported schedule preferences immediately, like the toggle', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/backup/import',
      payload: {
        data: {
          version: '2.1',
          timestamp: Date.now(),
          type: 'preferences',
          preferences: {
            settings: [
              { key: 'candy_probe_schedule_enabled', value: true },
              { key: 'candy_probe_schedule_recheck_hours', value: 6 },
            ],
          },
        },
      },
    });
    expect(response.statusCode).toBe(200);

    // Imported preferences used to need a restart before the schedule followed them.
    expect(config.candyProbeScheduleEnabled).toBe(true);
    expect(config.candyProbeScheduleRecheckHours).toBe(6);
    // The scheduler really started: the freshness TTL follows the imported cadence.
    expect(await currentFreshnessTtlMs()).toBeGreaterThan(6 * 60 * 60 * 1000);
  });
});
