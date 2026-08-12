import { z } from 'zod';
import cron from 'node-cron';
import { isIP } from 'node:net';

const backupExportTypeSchema = z.enum(['all', 'accounts', 'preferences']);
const migrationDialectSchema = z.enum(['sqlite', 'mysql', 'postgres']);

const finiteNumber = z.coerce.number().finite();
const nonNegativeNumber = finiteNumber.min(0);
const positiveNumber = finiteNumber.gt(0);
const cronExpression = z.string().refine((value) => cron.validate(value));
const runtimeSettingsPayloadSchema = z.object({
  proxyToken: z.string().optional(),
  systemProxyUrl: z.string().optional(),
  payloadRules: z.unknown().optional(),
  modelAvailabilityProbeEnabled: z.boolean().optional(),
  channelRecoveryProbeEnabled: z.boolean().optional(),
  codexUpstreamWebsocketEnabled: z.boolean().optional(),
  responsesCompactFallbackToResponsesEnabled: z.boolean().optional(),
  disableCrossProtocolFallback: z.boolean().optional(),
  proxySessionChannelConcurrencyLimit: nonNegativeNumber.optional(),
  proxySessionChannelQueueWaitMs: nonNegativeNumber.optional(),
  proxyDebugTraceEnabled: z.boolean().optional(),
  proxyDebugCaptureHeaders: z.boolean().optional(),
  proxyDebugCaptureBodies: z.boolean().optional(),
  proxyDebugCaptureStreamChunks: z.boolean().optional(),
  proxyDebugTargetSessionId: z.string().optional(),
  proxyDebugTargetClientKind: z.string().optional(),
  proxyDebugTargetModel: z.string().optional(),
  proxyDebugRetentionHours: positiveNumber.optional(),
  proxyDebugMaxBodyBytes: finiteNumber.min(1024).optional(),
  checkinCron: cronExpression.optional(),
  checkinScheduleMode: z.enum(['cron', 'interval']).optional(),
  checkinIntervalHours: finiteNumber.min(1).max(24).optional(),
  balanceRefreshCron: cronExpression.optional(),
  logCleanupCron: cronExpression.optional(),
  logCleanupUsageLogsEnabled: z.boolean().optional(),
  logCleanupProgramLogsEnabled: z.boolean().optional(),
  logCleanupRetentionDays: positiveNumber.optional(),
  webhookUrl: z.string().optional(),
  barkUrl: z.string().optional(),
  webhookEnabled: z.boolean().optional(),
  barkEnabled: z.boolean().optional(),
  serverChanEnabled: z.boolean().optional(),
  serverChanKey: z.string().optional(),
  telegramEnabled: z.boolean().optional(),
  telegramApiBaseUrl: z.string().optional(),
  telegramBotToken: z.string().optional(),
  telegramChatId: z.string().optional(),
  telegramUseSystemProxy: z.boolean().optional(),
  telegramMessageThreadId: z.union([z.string(), z.number()]).optional(),
  smtpEnabled: z.boolean().optional(),
  smtpHost: z.string().optional(),
  smtpPort: positiveNumber.optional(),
  smtpSecure: z.boolean().optional(),
  smtpUser: z.string().optional(),
  smtpPass: z.string().optional(),
  smtpFrom: z.string().optional(),
  smtpTo: z.string().optional(),
  notifyCooldownSec: nonNegativeNumber.optional(),
  adminIpAllowlist: z.union([z.array(z.string()), z.string()]).optional(),
  routingFallbackUnitCost: positiveNumber.optional(),
  proxyFirstByteTimeoutSec: nonNegativeNumber.optional(),
  tokenRouterFailureCooldownMaxSec: positiveNumber.optional(),
  routingWeights: z.record(z.string(), z.unknown()).optional(),
  proxyErrorKeywords: z.union([z.array(z.string()), z.string()]).optional(),
  proxyEmptyContentFailEnabled: z.boolean().optional(),
  downstreamErrorPolicy: z.record(z.string(), z.unknown()).optional(),
  globalBlockedBrands: z.array(z.string()).optional(),
  globalAllowedModels: z.array(z.string()).optional(),
}).passthrough().superRefine((value, ctx) => {
  if (value.proxyToken !== undefined) {
    const proxyToken = value.proxyToken.trim();
    if (!proxyToken.startsWith('sk-') || proxyToken.length < 6) {
      ctx.addIssue({ code: 'custom', path: ['proxyToken'], message: 'invalid proxy token' });
    }
  }
  if (value.adminIpAllowlist !== undefined) {
    const entries = Array.isArray(value.adminIpAllowlist)
      ? value.adminIpAllowlist
      : value.adminIpAllowlist.split(/[\n,]+/);
    for (const entry of entries.map((item) => item.trim()).filter(Boolean)) {
      const [address, prefix, ...rest] = entry.split('/');
      const valid = rest.length === 0
        && isIP(address) === 4
        && (prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) >= 0 && Number(prefix) <= 32));
      if (!valid) {
        ctx.addIssue({ code: 'custom', path: ['adminIpAllowlist'], message: `管理端 IP 白名单格式无效：${entry}` });
        break;
      }
    }
  }
});

const systemProxyTestPayloadSchema = z.object({
  proxyUrl: z.string().optional(),
}).passthrough();

const databaseMigrationPayloadSchema = z.object({
  dialect: migrationDialectSchema,
  connectionString: z.string().trim().min(1),
  overwrite: z.boolean().optional(),
  ssl: z.boolean().optional(),
}).passthrough();

const backupWebdavConfigPayloadSchema = z.object({
  enabled: z.boolean().optional(),
  fileUrl: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  clearPassword: z.boolean().optional(),
  exportType: backupExportTypeSchema.optional(),
  autoSyncEnabled: z.boolean().optional(),
  autoSyncCron: z.string().optional(),
}).passthrough();

const backupWebdavExportPayloadSchema = z.object({
  type: backupExportTypeSchema.optional(),
}).passthrough();

const backupImportPayloadSchema = z.object({
  data: z.record(z.string(), z.unknown()),
}).passthrough();

export type BackupWebdavConfigPayload = z.output<typeof backupWebdavConfigPayloadSchema>;
export type BackupWebdavExportPayload = z.output<typeof backupWebdavExportPayloadSchema>;
export type BackupImportPayload = z.output<typeof backupImportPayloadSchema>;
export type DatabaseMigrationPayload = z.output<typeof databaseMigrationPayloadSchema>;
export type RuntimeSettingsPayload = z.output<typeof runtimeSettingsPayloadSchema>;
export type SystemProxyTestPayload = z.output<typeof systemProxyTestPayloadSchema>;

function normalizeSettingsPayloadInput(input: unknown): unknown {
  return input === undefined ? {} : input;
}

function formatSettingsPayloadError(error: z.ZodError): string {
  const firstIssue = error.issues[0];
  const firstPath = firstIssue?.path[0];
  const runtimeMessages: Record<string, string> = {
    channelRecoveryProbeEnabled: '渠道恢复探针开关格式无效：需要 boolean',
    codexUpstreamWebsocketEnabled: 'Codex 上游 WebSocket 开关格式无效：需要 boolean',
    responsesCompactFallbackToResponsesEnabled: 'Compact 回退到 Responses 开关格式无效：需要 boolean',
    disableCrossProtocolFallback: '跨协议回退开关格式无效：需要 boolean',
    proxySessionChannelConcurrencyLimit: '会话通道并发上限必须是大于等于 0 的整数',
    proxySessionChannelQueueWaitMs: '会话通道排队等待时间必须是大于等于 0 的整数毫秒',
    proxyDebugTraceEnabled: '代理调试追踪开关格式无效：需要 boolean',
    proxyDebugCaptureHeaders: '代理调试请求头采集格式无效：需要 boolean',
    proxyDebugCaptureBodies: '代理调试请求体采集格式无效：需要 boolean',
    proxyDebugCaptureStreamChunks: '代理调试流式分片采集格式无效：需要 boolean',
    proxyDebugRetentionHours: '代理调试保留时长必须是大于等于 1 的整数小时',
    proxyDebugMaxBodyBytes: '代理调试抓取体积上限必须是大于等于 1024 的整数字节',
    checkinScheduleMode: '签到方式无效：仅支持 cron 或 interval',
    checkinCron: '签到 Cron 表达式无效',
    balanceRefreshCron: '余额刷新 Cron 表达式无效',
    logCleanupCron: '日志清理 Cron 表达式无效',
    checkinIntervalHours: '签到间隔必须是 1 到 24 的整数小时',
    logCleanupRetentionDays: '日志清理保留天数必须是大于等于 1 的整数',
    smtpPort: 'SMTP 端口无效',
    notifyCooldownSec: '告警冷静期必须是大于等于 0 的数字（秒）',
    routingFallbackUnitCost: '无价模型默认单价必须是大于 0 的数字',
    proxyFirstByteTimeoutSec: '首字超时必须是大于等于 0 的数字（秒）',
    tokenRouterFailureCooldownMaxSec: '路由失败冷却上限必须是大于 0 的数字（秒）',
    globalBlockedBrands: 'globalBlockedBrands must be an array of strings',
    globalAllowedModels: 'globalAllowedModels must be an array of strings',
    proxyToken: '下游访问令牌必须以 sk- 开头且至少 6 位（含 sk-）',
    adminIpAllowlist: '管理端 IP 白名单格式无效',
  };
  if (typeof firstPath === 'string' && runtimeMessages[firstPath]) {
    if (firstPath === 'adminIpAllowlist' && firstIssue?.message) {
      return firstIssue.message;
    }
    return runtimeMessages[firstPath];
  }
  if (firstPath === 'exportType') {
    return 'Invalid exportType. Expected all/accounts/preferences.';
  }
  if (firstPath === 'type') {
    return 'Invalid type. Expected all/accounts/preferences.';
  }
  if (firstPath === 'proxyUrl') {
    return '系统代理地址格式无效：需要 string';
  }
  if (firstPath === 'dialect') {
    return 'Invalid dialect. Expected sqlite/mysql/postgres.';
  }
  if (firstPath === 'connectionString') {
    return 'Invalid connectionString. Expected non-empty string.';
  }
  if (firstPath === 'overwrite') {
    return 'Invalid overwrite. Expected boolean.';
  }
  if (firstPath === 'ssl') {
    return 'Invalid ssl. Expected boolean.';
  }
  if (firstPath === 'data') {
    return '导入数据格式错误：需要 JSON 对象';
  }
  if (firstPath === 'webhookEnabled') {
    return 'Webhook 开关格式无效：需要 boolean';
  }
  if (firstPath === 'modelAvailabilityProbeEnabled') {
    return '批量测活开关格式无效：需要 boolean';
  }
  if (firstPath === 'barkEnabled') {
    return 'Bark 开关格式无效：需要 boolean';
  }
  if (firstPath === 'serverChanEnabled') {
    return 'Server 酱开关格式无效：需要 boolean';
  }
  if (firstPath === 'telegramEnabled') {
    return 'Telegram 开关格式无效：需要 boolean';
  }
  if (firstPath === 'telegramUseSystemProxy') {
    return 'Telegram 使用系统代理格式无效：需要 boolean';
  }
  if (firstPath === 'smtpEnabled') {
    return 'SMTP 开关格式无效：需要 boolean';
  }
  if (firstPath === 'smtpSecure') {
    return 'SMTP 安全连接格式无效：需要 boolean';
  }
  if (firstPath === 'logCleanupUsageLogsEnabled') {
    return '自动清理使用日志格式无效：需要 boolean';
  }
  if (firstPath === 'logCleanupProgramLogsEnabled') {
    return '自动清理程序日志格式无效：需要 boolean';
  }
  return 'Invalid settings payload.';
}

export function parseRuntimeSettingsPayload(input: unknown):
{ success: true; data: RuntimeSettingsPayload } | { success: false; error: string } {
  const result = runtimeSettingsPayloadSchema.safeParse(normalizeSettingsPayloadInput(input));
  if (!result.success) {
    return {
      success: false,
      error: formatSettingsPayloadError(result.error),
    };
  }
  return {
    success: true,
    data: result.data,
  };
}

export function parseSystemProxyTestPayload(input: unknown):
{ success: true; data: SystemProxyTestPayload } | { success: false; error: string } {
  const result = systemProxyTestPayloadSchema.safeParse(normalizeSettingsPayloadInput(input));
  if (!result.success) {
    return {
      success: false,
      error: formatSettingsPayloadError(result.error),
    };
  }
  return {
    success: true,
    data: result.data,
  };
}

export function parseDatabaseMigrationPayload(input: unknown):
{ success: true; data: DatabaseMigrationPayload } | { success: false; error: string } {
  const result = databaseMigrationPayloadSchema.safeParse(normalizeSettingsPayloadInput(input));
  if (!result.success) {
    return {
      success: false,
      error: formatSettingsPayloadError(result.error),
    };
  }
  return {
    success: true,
    data: result.data,
  };
}

export function parseBackupWebdavConfigPayload(input: unknown):
{ success: true; data: BackupWebdavConfigPayload } | { success: false; error: string } {
  const result = backupWebdavConfigPayloadSchema.safeParse(normalizeSettingsPayloadInput(input));
  if (!result.success) {
    return {
      success: false,
      error: formatSettingsPayloadError(result.error),
    };
  }
  return {
    success: true,
    data: result.data,
  };
}

export function parseBackupImportPayload(input: unknown):
{ success: true; data: BackupImportPayload } | { success: false; error: string } {
  const result = backupImportPayloadSchema.safeParse(normalizeSettingsPayloadInput(input));
  if (!result.success) {
    return {
      success: false,
      error: formatSettingsPayloadError(result.error),
    };
  }
  return {
    success: true,
    data: result.data,
  };
}

export function parseBackupWebdavExportPayload(input: unknown):
{ success: true; data: BackupWebdavExportPayload } | { success: false; error: string } {
  const result = backupWebdavExportPayloadSchema.safeParse(normalizeSettingsPayloadInput(input));
  if (!result.success) {
    return {
      success: false,
      error: formatSettingsPayloadError(result.error),
    };
  }
  return {
    success: true,
    data: result.data,
  };
}
