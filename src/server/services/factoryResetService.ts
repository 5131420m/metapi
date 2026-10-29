import { buildConfig, config } from '../config.js';
import { db, schema, switchRuntimeDatabase } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { updateBalanceRefreshCron, updateCheckinCron, updateLogCleanupSettings } from './checkinScheduler.js';
import { ensureDefaultSitesSeeded } from './defaultSiteSeedService.js';
import { startProxyLogRetentionService } from './proxyLogRetentionService.js';
import { invalidateSiteProxyCache } from './siteProxy.js';
import { discardCandyProbeResults } from './candyProbe/resultStore.js';
import { discardIdentityProbeResults } from './modelIdentityProbe/resultStore.js';
import { discardObservedClientIdentities } from './observedClientIdentity.js';
import {
  startModelAvailabilityProbeScheduler,
  stopModelAvailabilityProbeScheduler,
} from './modelAvailabilityProbeService.js';
import {
  startChannelRecoveryProbeScheduler,
  stopChannelRecoveryProbeScheduler,
} from './channelRecoveryProbeService.js';
import {
  startCandyProbeScheduler,
  stopCandyProbeScheduler,
} from './candyProbeScheduler.js';

export const FACTORY_RESET_ADMIN_TOKEN = 'change-me-admin-token';

type FactoryResetDependencies = {
  switchRuntimeDatabase?: typeof switchRuntimeDatabase;
  runSqliteMigrations?: () => Promise<void> | void;
  ensureDefaultSitesSeeded?: typeof ensureDefaultSitesSeeded;
};

type PreservedInfrastructureState = {
  authToken: string;
  proxyToken: string;
  systemProxyUrl: string;
  dbType: 'sqlite' | 'mysql' | 'postgres';
  dbUrl: string;
  dbSsl: boolean;
};

async function clearAllBusinessData() {
  await db.transaction(async (tx) => {
    await tx.delete(schema.routeChannels).run();
    await tx.delete(schema.tokenModelAvailability).run();
    await tx.delete(schema.modelAvailability).run();
    await tx.delete(schema.proxyLogs).run();
    await tx.delete(schema.proxyVideoTasks).run();
    await tx.delete(schema.proxyFiles).run();
    await tx.delete(schema.checkinLogs).run();
    await tx.delete(schema.accountTokens).run();
    await tx.delete(schema.accounts).run();
    await tx.delete(schema.tokenRoutes).run();
    await tx.delete(schema.sites).run();
    await tx.delete(schema.downstreamApiKeys).run();
    await tx.delete(schema.events).run();
    await tx.delete(schema.settings).run();
  });
}

function captureInfrastructureState(): PreservedInfrastructureState {
  return {
    authToken: config.authToken,
    proxyToken: config.proxyToken,
    systemProxyUrl: config.systemProxyUrl,
    dbType: config.dbType,
    dbUrl: config.dbUrl,
    dbSsl: config.dbSsl,
  };
}

function shouldPreserveExternalRuntime(state: PreservedInfrastructureState): boolean {
  return state.dbType !== 'sqlite' && !!state.dbUrl.trim();
}

function resetRuntimeConfigToInitialState(preserved: PreservedInfrastructureState) {
  const baseline = buildConfig(process.env);
  Object.assign(config, baseline);
  config.authToken = preserved.authToken || baseline.authToken || FACTORY_RESET_ADMIN_TOKEN;
  config.proxyToken = preserved.proxyToken || baseline.proxyToken;
  config.systemProxyUrl = preserved.systemProxyUrl || baseline.systemProxyUrl;
  if (shouldPreserveExternalRuntime(preserved)) {
    config.dbType = preserved.dbType;
    config.dbUrl = preserved.dbUrl;
    config.dbSsl = preserved.dbSsl;
  }
  config.logCleanupConfigured = false;
  config.logCleanupUsageLogsEnabled = config.proxyLogRetentionDays > 0;
  config.logCleanupProgramLogsEnabled = false;
  config.logCleanupRetentionDays = Math.max(1, Math.trunc(config.proxyLogRetentionDays || config.logCleanupRetentionDays || 30));
  updateCheckinCron(config.checkinCron);
  updateBalanceRefreshCron(config.balanceRefreshCron);
  updateLogCleanupSettings({
    cronExpr: config.logCleanupCron,
    usageLogsEnabled: config.logCleanupUsageLogsEnabled,
    programLogsEnabled: config.logCleanupProgramLogsEnabled,
    retentionDays: config.logCleanupRetentionDays,
  });
  startProxyLogRetentionService();
  // The probes read their enabled flags from config, and the reset just flipped them all
  // off — the running timers must actually stop, or a tick still fires against the reset
  // baseline (and the candy schedule's freshness-TTL override survives too).
  stopModelAvailabilityProbeScheduler();
  stopChannelRecoveryProbeScheduler();
  stopCandyProbeScheduler();
  // The reset baseline comes from buildConfig(process.env), which can turn the flags back
  // ON via environment variables. A stopped timer behind an enabled flag (or a running one
  // behind a disabled flag) would leave config and reality inconsistent until the next
  // restart, so each probe is restarted per the post-reset config: the availability probe
  // checks its own switch, the other two are started only when theirs is set.
  startModelAvailabilityProbeScheduler();
  if (config.channelRecoveryProbeEnabled) startChannelRecoveryProbeScheduler();
  if (config.candyProbeScheduleEnabled) startCandyProbeScheduler();
  invalidateSiteProxyCache();
}

async function restoreInfrastructureSettings(preserved: PreservedInfrastructureState): Promise<void> {
  await upsertSetting('auth_token', preserved.authToken || FACTORY_RESET_ADMIN_TOKEN);
  await upsertSetting('proxy_token', preserved.proxyToken);
  await upsertSetting('system_proxy_url', preserved.systemProxyUrl);

  if (shouldPreserveExternalRuntime(preserved)) {
    await upsertSetting('db_type', preserved.dbType);
    await upsertSetting('db_url', preserved.dbUrl);
    await upsertSetting('db_ssl', preserved.dbSsl);
    return;
  }

  await upsertSetting('db_type', config.dbType);
  await upsertSetting('db_url', config.dbUrl);
  await upsertSetting('db_ssl', config.dbSsl);
}

async function runDefaultSqliteMigrations() {
  const migrateModule = await import('../db/migrate.js');
  migrateModule.runSqliteMigrations();
}

export async function performFactoryReset(deps: FactoryResetDependencies = {}): Promise<void> {
  const switchRuntimeDatabaseImpl = deps.switchRuntimeDatabase ?? switchRuntimeDatabase;
  const runSqliteMigrationsImpl = deps.runSqliteMigrations ?? runDefaultSqliteMigrations;
  const ensureDefaultSitesSeededImpl = deps.ensureDefaultSitesSeeded ?? ensureDefaultSitesSeeded;
  const preserved = captureInfrastructureState();

  // Candy-probe verdicts live in memory and are persisted into `settings`. Clearing the
  // table alone would leave the old verdicts in the Map, and the next write would put them
  // back into the settings row of the freshly reset database; the persisted row is cleared
  // too, so a database swap cannot carry them across either.
  await discardCandyProbeResults();
  // Model fingerprint verdicts: same lifecycle, same reasoning.
  await discardIdentityProbeResults();
  // Observed client identities: in memory too, and debounced into `settings` the same way.
  await discardObservedClientIdentities();

  await clearAllBusinessData();
  resetRuntimeConfigToInitialState(preserved);
  await switchRuntimeDatabaseImpl(config.dbType, config.dbUrl, config.dbSsl);
  if (config.dbType === 'sqlite') {
    await runSqliteMigrationsImpl();
  }
  await clearAllBusinessData();
  await restoreInfrastructureSettings(preserved);
  await ensureDefaultSitesSeededImpl();
}
