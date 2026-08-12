import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { RETRYABLE_TIMEOUT_PATTERNS } from './proxyRetryPolicy.js';

const ROTATABLE_STATUS_CODES = new Set([408, 500, 502, 503, 504]);
const GATEWAY_FAILURE_STATUS_CODES = new Set([502, 503, 504]);
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403, 404, 422]);
const IMMEDIATE_COOLDOWN_PATTERNS = [
  /\benotfound\b/i,
  /\beai_again\b/i,
  /\beconnrefused\b/i,
  /\behostunreach\b/i,
  /\benetunreach\b/i,
  /socket hang up/i,
  /\beconnreset\b/i,
];
const AMBIGUOUS_NETWORK_FAILURE_PATTERNS = [
  /network error/i,
  /fetch failed/i,
];

export const SITE_API_ENDPOINT_COOLDOWN_MS = 5 * 60 * 1000;
export const SITE_API_ENDPOINT_FAILURE_WINDOW_MS = 60 * 1000;
export const SITE_API_ENDPOINT_FAILURE_THRESHOLD = 3;

type SiteRow = typeof schema.sites.$inferSelect;
type SiteApiEndpointRow = typeof schema.siteApiEndpoints.$inferSelect;

export interface SiteApiEndpointTarget {
  kind: 'site-fallback' | 'endpoint';
  siteId: number;
  endpointId: number | null;
  baseUrl: string;
  configuredEndpointCount: number;
  endpoint: SiteApiEndpointRow | null;
}

export type SiteApiEndpointFailureKind = 'first-byte-timeout' | 'request-deadline-exhausted';

export interface SiteApiEndpointFailureInput {
  status?: number | null;
  message?: string | null;
  error?: unknown;
  failureKind?: SiteApiEndpointFailureKind | null;
  requestScopeId?: string | null;
}

export interface SiteApiEndpointFailureDisposition {
  retryable: boolean;
  rotateToNextEndpoint: boolean;
  cooldownMode: 'none' | 'immediate' | 'threshold';
  failureReason: string;
}

export interface RecordedSiteApiEndpointFailure extends SiteApiEndpointFailureDisposition {
  cooldownUntil: string | null;
}

export interface RecordedSiteApiFallbackFailure extends SiteApiEndpointFailureDisposition {
  cooldownUntil: string | null;
}

export class SiteApiEndpointRequestError extends Error {
  readonly status: number | null;
  readonly rawErrText: string | null;
  readonly firstByteLatencyMs: number | null;
  readonly failureKind: SiteApiEndpointFailureKind | null;

  constructor(message: string, options?: {
    status?: number | null;
    rawErrText?: string | null;
    firstByteLatencyMs?: number | null;
    failureKind?: SiteApiEndpointFailureKind | null;
    cause?: unknown;
  }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'SiteApiEndpointRequestError';
    this.status = typeof options?.status === 'number' ? options.status : null;
    this.rawErrText = typeof options?.rawErrText === 'string' && options.rawErrText.trim()
      ? options.rawErrText
      : null;
    this.firstByteLatencyMs = typeof options?.firstByteLatencyMs === 'number' && Number.isFinite(options.firstByteLatencyMs)
      ? options.firstByteLatencyMs
      : null;
    this.failureKind = options?.failureKind ?? null;
  }
}

export interface SiteApiEndpointOperationContext {
  signal: AbortSignal;
}

export interface SiteApiEndpointPoolOptions {
  deadlineAtMs?: number;
  timeoutMessage?: string;
  requestScopeId?: string;
}

export function normalizeSiteApiEndpointBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

function toIsoTimestamp(now?: string | Date): string {
  if (typeof now === 'string' && now.trim()) return now;
  if (now instanceof Date) return now.toISOString();
  return new Date().toISOString();
}

function compareNullableTimeAsc(left?: string | null, right?: string | null): number {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  return left.localeCompare(right);
}

function isEndpointCoolingDown(endpoint: SiteApiEndpointRow, nowIso: string): boolean {
  return !!endpoint.cooldownUntil && endpoint.cooldownUntil > nowIso;
}

function extractFailureMessage(input: SiteApiEndpointFailureInput): string {
  const direct = typeof input.message === 'string' ? input.message.trim() : '';
  if (direct) return direct;
  return input.error instanceof Error ? input.error.message.trim() : '';
}

function formatFailureReason(status: number | null, message: string): string {
  if (status && message) {
    if (message.match(new RegExp(`^HTTP\\s+${status}\\b`, 'i'))) return message;
    return `HTTP ${status}: ${message}`;
  }
  if (status) return `HTTP ${status}`;
  return message || 'endpoint failure';
}

function parseStatusFromFailureMessage(message: string): number | null {
  const matched = message.match(/\bHTTP\s+(\d{3})\b/i);
  if (!matched) return null;
  const status = Number.parseInt(matched[1] || '', 10);
  return Number.isFinite(status) ? status : null;
}

export function classifySiteApiEndpointFailure(
  input: SiteApiEndpointFailureInput,
): SiteApiEndpointFailureDisposition {
  const message = extractFailureMessage(input);
  const status = typeof input.status === 'number'
    ? input.status
    : parseStatusFromFailureMessage(message);
  const failureReason = formatFailureReason(status, message);

  if (input.failureKind === 'request-deadline-exhausted') {
    return { retryable: false, rotateToNextEndpoint: false, cooldownMode: 'none', failureReason };
  }
  if (input.failureKind === 'first-byte-timeout') {
    return { retryable: true, rotateToNextEndpoint: true, cooldownMode: 'none', failureReason };
  }

  if (status !== null) {
    if (status === 429) {
      return { retryable: false, rotateToNextEndpoint: false, cooldownMode: 'none', failureReason };
    }
    if (GATEWAY_FAILURE_STATUS_CODES.has(status)) {
      return { retryable: true, rotateToNextEndpoint: true, cooldownMode: 'threshold', failureReason };
    }
    if (ROTATABLE_STATUS_CODES.has(status)) {
      return { retryable: true, rotateToNextEndpoint: true, cooldownMode: 'none', failureReason };
    }
    if (NON_RETRYABLE_STATUS_CODES.has(status)) {
      return { retryable: false, rotateToNextEndpoint: false, cooldownMode: 'none', failureReason };
    }
  }

  if (IMMEDIATE_COOLDOWN_PATTERNS.some((pattern) => pattern.test(message))) {
    return { retryable: true, rotateToNextEndpoint: true, cooldownMode: 'immediate', failureReason };
  }
  if (AMBIGUOUS_NETWORK_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) {
    return { retryable: true, rotateToNextEndpoint: true, cooldownMode: 'threshold', failureReason };
  }
  if (RETRYABLE_TIMEOUT_PATTERNS.some((pattern) => pattern.test(message))) {
    return { retryable: true, rotateToNextEndpoint: true, cooldownMode: 'immediate', failureReason };
  }

  return { retryable: false, rotateToNextEndpoint: false, cooldownMode: 'none', failureReason };
}

export async function selectSiteApiEndpointTarget(
  site: SiteRow,
  now?: string | Date,
  excludedEndpointIds: ReadonlySet<number> = new Set(),
): Promise<SiteApiEndpointTarget | null> {
  const nowIso = toIsoTimestamp(now);
  const endpoints = await db.select().from(schema.siteApiEndpoints)
    .where(eq(schema.siteApiEndpoints.siteId, site.id))
    .orderBy(asc(schema.siteApiEndpoints.sortOrder), asc(schema.siteApiEndpoints.id))
    .all();

  let storedSite: SiteRow | undefined;
  if (schema.sites?.id) {
    try {
      storedSite = await db.select().from(schema.sites).where(eq(schema.sites.id, site.id)).get();
    } catch {
      // Some embedded/test database adapters expose only the endpoint query shape.
    }
  }
  const currentSite = storedSite || site;
  const fallbackEnabled = currentSite.apiEndpointSiteFallbackEnabled !== false;
  const buildFallbackTarget = (): SiteApiEndpointTarget | null => {
    if (!fallbackEnabled) return null;
    const baseUrl = normalizeSiteApiEndpointBaseUrl(currentSite.url);
    if (!baseUrl) return null;
    return {
      kind: 'site-fallback',
      siteId: currentSite.id,
      endpointId: null,
      baseUrl,
      configuredEndpointCount: endpoints.length,
      endpoint: null,
    };
  };

  if (endpoints.length === 0) return buildFallbackTarget();

  const eligible = endpoints
    .filter((endpoint) => (
      (endpoint.enabled ?? true)
      && !isEndpointCoolingDown(endpoint, nowIso)
      && !excludedEndpointIds.has(endpoint.id)
    ))
    .sort((left, right) => {
      const sortOrder = (left.sortOrder ?? 0) - (right.sortOrder ?? 0);
      if (sortOrder !== 0) return sortOrder;
      const selectionOrder = compareNullableTimeAsc(left.lastSelectedAt, right.lastSelectedAt);
      if (selectionOrder !== 0) return selectionOrder;
      return (left.id ?? 0) - (right.id ?? 0);
    });

  const selected = eligible[0];
  if (!selected) return buildFallbackTarget();

  return {
    kind: 'endpoint',
    siteId: site.id,
    endpointId: selected.id,
    baseUrl: normalizeSiteApiEndpointBaseUrl(selected.url),
    configuredEndpointCount: endpoints.length,
    endpoint: selected,
  };
}

export async function resolveSiteApiBaseUrl(
  site: SiteRow,
  now?: string | Date,
): Promise<string | null> {
  const target = await selectSiteApiEndpointTarget(site, now);
  return target?.baseUrl || null;
}

export async function requireSiteApiBaseUrl(
  site: SiteRow,
  now?: string | Date,
): Promise<string> {
  const baseUrl = await resolveSiteApiBaseUrl(site, now);
  if (baseUrl) return baseUrl;
  throw new Error('当前站点的 API 请求地址均不可用');
}

export async function recordSiteApiEndpointFailure(
  endpointId: number,
  input: SiteApiEndpointFailureInput,
  now?: string | Date,
): Promise<RecordedSiteApiEndpointFailure> {
  const nowIso = toIsoTimestamp(now);
  const nowMs = Date.parse(nowIso);
  const disposition = classifySiteApiEndpointFailure(input);
  let current: SiteApiEndpointRow | undefined;
  try {
    current = await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.id, endpointId))
      .get();
  } catch {
    current = undefined;
  }

  let consecutiveFailureCount = 0;
  let failureWindowStartedAt: string | null = null;
  let lastFailureScopeId: string | null = null;
  let cooldownUntil: string | null = null;

  if (disposition.cooldownMode === 'immediate') {
    cooldownUntil = new Date(nowMs + SITE_API_ENDPOINT_COOLDOWN_MS).toISOString();
  } else if (disposition.cooldownMode === 'threshold') {
    const scopeId = input.requestScopeId?.trim() || null;
    if (scopeId && current) {
      const windowStartIso = new Date(nowMs - SITE_API_ENDPOINT_FAILURE_WINDOW_MS).toISOString();
      const updateResult = await db.update(schema.siteApiEndpoints).set({
        consecutiveFailureCount: sql<number>`case
          when ${schema.siteApiEndpoints.failureWindowStartedAt} is null
            or ${schema.siteApiEndpoints.failureWindowStartedAt} < ${windowStartIso}
          then 1
          else coalesce(${schema.siteApiEndpoints.consecutiveFailureCount}, 0) + 1
        end`,
        failureWindowStartedAt: sql<string>`case
          when ${schema.siteApiEndpoints.failureWindowStartedAt} is null
            or ${schema.siteApiEndpoints.failureWindowStartedAt} < ${windowStartIso}
          then ${nowIso}
          else ${schema.siteApiEndpoints.failureWindowStartedAt}
        end`,
        lastFailureScopeId: scopeId,
        lastFailedAt: nowIso,
        lastFailureReason: disposition.failureReason,
        updatedAt: nowIso,
      }).where(and(
        eq(schema.siteApiEndpoints.id, endpointId),
        or(
          isNull(schema.siteApiEndpoints.lastFailureScopeId),
          ne(schema.siteApiEndpoints.lastFailureScopeId, scopeId),
        ),
      )).run();
      const incremented = Number(updateResult.changes || 0) > 0;
      const row = incremented
        ? await db.select().from(schema.siteApiEndpoints).where(eq(schema.siteApiEndpoints.id, endpointId)).get()
        : current;
      const rowWindowMs = row.failureWindowStartedAt ? Date.parse(row.failureWindowStartedAt) : Number.NaN;
      consecutiveFailureCount = row.consecutiveFailureCount ?? 0;
      failureWindowStartedAt = row.failureWindowStartedAt ?? null;
      lastFailureScopeId = row.lastFailureScopeId ?? null;
      if (Number.isFinite(rowWindowMs)
        && nowMs - rowWindowMs <= SITE_API_ENDPOINT_FAILURE_WINDOW_MS
        && consecutiveFailureCount >= SITE_API_ENDPOINT_FAILURE_THRESHOLD) {
        cooldownUntil = new Date(nowMs + SITE_API_ENDPOINT_COOLDOWN_MS).toISOString();
        await db.update(schema.siteApiEndpoints).set({ cooldownUntil, updatedAt: nowIso })
          .where(eq(schema.siteApiEndpoints.id, endpointId)).run();
      }
      return { ...disposition, cooldownUntil };
    }
    const existingWindowMs = current?.failureWindowStartedAt
      ? Date.parse(current.failureWindowStartedAt)
      : Number.NaN;
    const inWindow = Number.isFinite(existingWindowMs)
      && nowMs - existingWindowMs <= SITE_API_ENDPOINT_FAILURE_WINDOW_MS;
    failureWindowStartedAt = inWindow ? current?.failureWindowStartedAt ?? nowIso : nowIso;
    consecutiveFailureCount = inWindow ? current?.consecutiveFailureCount ?? 0 : 0;
    if (!scopeId || scopeId !== current?.lastFailureScopeId) {
      consecutiveFailureCount += 1;
      lastFailureScopeId = scopeId;
    } else {
      lastFailureScopeId = current?.lastFailureScopeId ?? null;
    }
    if (consecutiveFailureCount >= SITE_API_ENDPOINT_FAILURE_THRESHOLD) {
      cooldownUntil = new Date(nowMs + SITE_API_ENDPOINT_COOLDOWN_MS).toISOString();
    }
  }

  await db.update(schema.siteApiEndpoints).set({
    cooldownUntil,
    consecutiveFailureCount,
    failureWindowStartedAt,
    lastFailureScopeId,
    lastFailedAt: nowIso,
    lastFailureReason: disposition.failureReason,
    updatedAt: nowIso,
  }).where(eq(schema.siteApiEndpoints.id, endpointId)).run();

  return { ...disposition, cooldownUntil };
}

export async function recordSiteApiEndpointSuccess(
  endpointId: number,
  now?: string | Date,
): Promise<void> {
  const nowIso = toIsoTimestamp(now);
  await db.update(schema.siteApiEndpoints).set({
    cooldownUntil: null,
    consecutiveFailureCount: 0,
    failureWindowStartedAt: null,
    lastFailureScopeId: null,
    lastSelectedAt: nowIso,
    lastFailureReason: null,
    updatedAt: nowIso,
  }).where(eq(schema.siteApiEndpoints.id, endpointId)).run();
}

export async function recordSiteApiFallbackFailure(
  siteId: number,
  input: SiteApiEndpointFailureInput,
  now?: string | Date,
): Promise<RecordedSiteApiFallbackFailure> {
  const nowIso = toIsoTimestamp(now);
  const disposition = classifySiteApiEndpointFailure(input);
  const cooldownUntil = null;
  if (schema.sites?.id) {
    await db.update(schema.sites).set({
      apiEndpointSiteFallbackCooldownUntil: null,
      apiEndpointSiteFallbackLastFailedAt: nowIso,
      apiEndpointSiteFallbackLastFailureReason: disposition.failureReason,
      updatedAt: nowIso,
    }).where(eq(schema.sites.id, siteId)).run();
  }
  return { ...disposition, cooldownUntil };
}

export async function recordSiteApiFallbackSuccess(
  siteId: number,
  now?: string | Date,
): Promise<void> {
  const nowIso = toIsoTimestamp(now);
  if (!schema.sites?.id) return;
  await db.update(schema.sites).set({
    apiEndpointSiteFallbackCooldownUntil: null,
    apiEndpointSiteFallbackLastSelectedAt: nowIso,
    apiEndpointSiteFallbackLastFailureReason: null,
    updatedAt: nowIso,
  }).where(eq(schema.sites.id, siteId)).run();
}

function buildDeadlineError(options: SiteApiEndpointPoolOptions): SiteApiEndpointRequestError {
  return new SiteApiEndpointRequestError(options.timeoutMessage || 'request deadline exhausted', {
    failureKind: 'request-deadline-exhausted',
  });
}

export async function runWithSiteApiEndpointPool<T>(
  site: SiteRow,
  operation: (target: SiteApiEndpointTarget, context: SiteApiEndpointOperationContext) => Promise<T>,
  options: SiteApiEndpointPoolOptions = {},
): Promise<T> {
  const attemptedEndpointIds = new Set<number>();
  let attemptedSiteFallback = false;
  let lastError: unknown;
  const requestScopeId = options.requestScopeId || randomUUID();

  while (true) {
    if (options.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs) {
      throw buildDeadlineError(options);
    }
    const target = await selectSiteApiEndpointTarget(site, undefined, attemptedEndpointIds);
    if (!target) {
      if (lastError) throw normalizePoolTerminalError(lastError);
      throw new Error('当前站点的 API 请求地址均不可用');
    }
    if (target.endpointId && attemptedEndpointIds.has(target.endpointId)) {
      if (lastError) throw normalizePoolTerminalError(lastError);
      throw new Error('当前站点的 API 请求地址均不可用');
    }
    if (target.kind === 'site-fallback') {
      if (attemptedSiteFallback) {
        if (lastError) throw normalizePoolTerminalError(lastError);
        throw new Error('主站点 API 请求地址不可用');
      }
      attemptedSiteFallback = true;
    }

    try {
      const controller = new AbortController();
      const remainingMs = options.deadlineAtMs !== undefined
        ? Math.max(0, options.deadlineAtMs - Date.now())
        : null;
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
      const deadlinePromise = remainingMs !== null
        ? new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(() => {
            const deadlineError = buildDeadlineError(options);
            controller.abort(deadlineError);
            reject(deadlineError);
          }, remainingMs);
        })
        : null;
      let result: T;
      try {
        const operationPromise = operation(target, { signal: controller.signal });
        result = deadlinePromise
          ? await Promise.race([operationPromise, deadlinePromise])
          : await operationPromise;
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
      }

      if (target.endpointId) {
        try {
          await recordSiteApiEndpointSuccess(target.endpointId);
        } catch (error) {
          console.warn('[siteApiEndpointService] failed to record endpoint success', error);
        }
      } else {
        try {
          await recordSiteApiFallbackSuccess(target.siteId);
        } catch (error) {
          console.warn('[siteApiEndpointService] failed to record site fallback success', error);
        }
      }
      return result;
    } catch (error) {
      lastError = error;
      if (error instanceof SiteApiEndpointRequestError && error.failureKind === 'request-deadline-exhausted') {
        throw error;
      }
      const failureInput: SiteApiEndpointFailureInput = {
        status: error instanceof SiteApiEndpointRequestError ? error.status : undefined,
        message: error instanceof Error ? error.message : String(error ?? ''),
        error,
        failureKind: error instanceof SiteApiEndpointRequestError ? error.failureKind : null,
        requestScopeId,
      };
      if (!target.endpointId) {
        await recordSiteApiFallbackFailure(target.siteId, failureInput);
        if (error instanceof SiteApiEndpointRequestError) {
          throw error;
        }
        throw new SiteApiEndpointRequestError(failureInput.message || 'upstream request failed', {
          status: failureInput.status,
          rawErrText: failureInput.message,
          failureKind: failureInput.failureKind,
          cause: error,
        });
      }

      const recordedFailure = await recordSiteApiEndpointFailure(target.endpointId, failureInput);
      if (!recordedFailure.rotateToNextEndpoint) throw error;
      attemptedEndpointIds.add(target.endpointId);
    }
  }
}

function normalizePoolTerminalError(error: unknown): SiteApiEndpointRequestError {
  if (error instanceof SiteApiEndpointRequestError) return error;
  const message = error instanceof Error ? error.message : String(error ?? 'upstream request failed');
  return new SiteApiEndpointRequestError(message, {
    status: parseStatusFromFailureMessage(message),
    rawErrText: message,
    cause: error,
  });
}
