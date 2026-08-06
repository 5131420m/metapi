import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { requireInsertedRowId } from '../db/insertHelpers.js';
import { formatUtcSqlDateTime } from './localTimeService.js';

type HeadersLike = Headers | Record<string, unknown> | null | undefined;

export type ProxyDebugCaptureOptions = {
  enabled: boolean;
  captureHeaders: boolean;
  captureBodies: boolean;
  captureStreamChunks: boolean;
  targetSessionId: string;
  targetClientKind: string;
  targetModel: string;
  retentionHours: number;
  maxBodyBytes: number;
};

export type ProxyDebugTraceSession = {
  traceId: number;
  options: ProxyDebugCaptureOptions;
};

let lastPruneAtMs = 0;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

type TruncatedDebugPreview = {
  __metapiTruncated: true;
  preview: string;
  originalBytes: number;
  storedBytes: number;
  summary?: Record<string, unknown>;
};

function summarizeDebugPayload(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  const input = Array.isArray(body.input) ? body.input : undefined;
  const tools = Array.isArray(body.tools) ? body.tools : undefined;
  if (!input && !tools && body.model === undefined) return undefined;

  const inputTypeCounts: Record<string, number> = {};
  let functionCallCount = 0;
  let functionCallOutputCount = 0;
  let reasoningCount = 0;
  let encryptedReasoningCount = 0;
  for (const item of input || []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const type = String((item as Record<string, unknown>).type || 'unknown');
    inputTypeCounts[type] = (inputTypeCounts[type] || 0) + 1;
    if (type === 'function_call') functionCallCount += 1;
    if (type === 'function_call_output') functionCallOutputCount += 1;
    if (type === 'reasoning') {
      reasoningCount += 1;
      if (Object.prototype.hasOwnProperty.call(item, 'encrypted_content')) {
        encryptedReasoningCount += 1;
      }
    }
  }

  const toolTypes: Record<string, number> = {};
  const toolNames: string[] = [];
  for (const tool of tools || []) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) continue;
    const record = tool as Record<string, unknown>;
    const type = String(record.type || 'unknown');
    toolTypes[type] = (toolTypes[type] || 0) + 1;
    const name = typeof record.name === 'string'
      ? record.name
      : record.function && typeof record.function === 'object'
        ? (record.function as Record<string, unknown>).name
        : undefined;
    if (typeof name === 'string' && name.trim()) toolNames.push(name.trim());
  }

  return {
    model: typeof body.model === 'string' ? body.model : undefined,
    stream: typeof body.stream === 'boolean' ? body.stream : undefined,
    store: typeof body.store === 'boolean' ? body.store : undefined,
    inputCount: input?.length,
    inputTypeCounts,
    functionCallCount,
    functionCallOutputCount,
    reasoningCount,
    encryptedReasoningCount,
    toolCount: tools?.length,
    toolTypes,
    toolNames: [...new Set(toolNames)].slice(0, 100),
    toolChoice: typeof body.tool_choice === 'string' ? body.tool_choice : undefined,
  };
}

function buildTruncatedDebugPreview(
  text: string,
  maxBytes: number,
  originalBytes: number,
  summary?: Record<string, unknown>,
): string {
  const source = Buffer.from(text, 'utf8');
  const safeMaxBytes = Math.max(0, maxBytes);
  const marker = '\n\n... [metapi middle truncated; see summary] ...\n\n';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const contentBytes = Math.max(0, safeMaxBytes - markerBytes);
  const headBytes = Math.floor(contentBytes / 2);
  const tailBytes = Math.max(0, contentBytes - headBytes);
  const truncated = Buffer.concat([
    source.subarray(0, headBytes),
    Buffer.from(marker, 'utf8'),
    tailBytes > 0 ? source.subarray(Math.max(headBytes, source.length - tailBytes)) : Buffer.alloc(0),
  ]).subarray(0, safeMaxBytes).toString('utf8');
  const payload: TruncatedDebugPreview = {
    __metapiTruncated: true,
    preview: truncated,
    originalBytes,
    storedBytes: maxBytes,
    ...(summary ? { summary } : {}),
  };
  return JSON.stringify(payload, null, 2);
}

function stringifyDebugValue(value: unknown, maxBytes: number): string | null {
  if (value == null) return null;

  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }

  if (!text) return null;
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) {
    return text;
  }

  return buildTruncatedDebugPreview(text, maxBytes, buffer.length, summarizeDebugPayload(value));
}

function normalizeHeadersValue(value: HeadersLike): Record<string, unknown> | null {
  if (!value) return null;

  const headerEntries = value as { entries?: unknown; get?: unknown };
  if (typeof headerEntries.get === 'function' && typeof headerEntries.entries === 'function') {
    return Object.fromEntries(
      [...headerEntries.entries.call(value) as Iterable<[string, string]>]
        .sort((left, right) => left[0].localeCompare(right[0])),
    );
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const entries = Object.entries(value)
    .filter(([key]) => !!key)
    .sort((left, right) => left[0].localeCompare(right[0]));
  return Object.fromEntries(entries);
}

function normalizeLimit(rawLimit: number | undefined): number {
  const parsed = Number(rawLimit || 20);
  if (!Number.isFinite(parsed)) return 20;
  return Math.max(1, Math.min(200, Math.trunc(parsed)));
}

function asNormalizedText(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function getCaptureOptions(): ProxyDebugCaptureOptions {
  return {
    enabled: config.proxyDebugTraceEnabled,
    captureHeaders: config.proxyDebugCaptureHeaders,
    captureBodies: config.proxyDebugCaptureBodies,
    captureStreamChunks: config.proxyDebugCaptureStreamChunks,
    targetSessionId: (config.proxyDebugTargetSessionId || '').trim(),
    targetClientKind: (config.proxyDebugTargetClientKind || '').trim(),
    targetModel: (config.proxyDebugTargetModel || '').trim(),
    retentionHours: Math.max(1, Math.trunc(config.proxyDebugRetentionHours || 24)),
    maxBodyBytes: Math.max(1024, Math.trunc(config.proxyDebugMaxBodyBytes || 262_144)),
  };
}

function serializeHeaders(value: HeadersLike, maxBytes: number): string | null {
  return stringifyDebugValue(normalizeHeadersValue(value), maxBytes);
}

export function normalizeProxyDebugResponseHeaders(value: HeadersLike): Record<string, unknown> | null {
  return normalizeHeadersValue(value);
}

export function getProxyDebugCaptureOptions(): ProxyDebugCaptureOptions {
  return getCaptureOptions();
}

export function shouldTraceProxyDebugRequest(input: {
  clientKind?: string | null;
  sessionId?: string | null;
  requestedModel?: string | null;
}, options = getCaptureOptions()): boolean {
  if (!options.enabled) return false;

  const targetSessionId = options.targetSessionId;
  if (targetSessionId && (input.sessionId || '').trim() !== targetSessionId) {
    return false;
  }

  const targetClientKind = asNormalizedText(options.targetClientKind);
  if (targetClientKind && asNormalizedText(input.clientKind) !== targetClientKind) {
    return false;
  }

  const targetModel = asNormalizedText(options.targetModel);
  if (targetModel && asNormalizedText(input.requestedModel) !== targetModel) {
    return false;
  }

  return true;
}

export async function deleteExpiredProxyDebugTraces(retentionHours = config.proxyDebugRetentionHours): Promise<number> {
  const normalizedRetentionHours = Math.max(1, Math.trunc(Number(retentionHours || 24)));
  const cutoff = formatUtcSqlDateTime(new Date(Date.now() - (normalizedRetentionHours * 60 * 60 * 1000)));
  const result = await db
    .delete(schema.proxyDebugTraces)
    .where(lt(schema.proxyDebugTraces.createdAt, cutoff))
    .run();
  return Number(result.changes || 0);
}

async function pruneProxyDebugTracesIfNeeded(nowMs = Date.now(), retentionHours = config.proxyDebugRetentionHours): Promise<void> {
  if (nowMs - lastPruneAtMs < PRUNE_INTERVAL_MS) return;
  lastPruneAtMs = nowMs;
  try {
    await deleteExpiredProxyDebugTraces(retentionHours);
  } catch (error) {
    console.warn('[proxy-debug] failed to prune expired traces', error);
  }
}

export async function createProxyDebugTrace(input: {
  downstreamPath: string;
  clientKind?: string | null;
  sessionId?: string | null;
  traceHint?: string | null;
  requestedModel?: string | null;
  downstreamApiKeyId?: number | null;
  requestHeaders?: HeadersLike;
  requestBody?: unknown;
  maxBodyBytes?: number;
}) {
  const now = formatUtcSqlDateTime(new Date());
  const maxBodyBytes = Math.max(1024, Math.trunc(input.maxBodyBytes || config.proxyDebugMaxBodyBytes || 262_144));
  await pruneProxyDebugTracesIfNeeded(Date.now(), config.proxyDebugRetentionHours);

  const inserted = await db.insert(schema.proxyDebugTraces).values({
    downstreamPath: input.downstreamPath,
    clientKind: input.clientKind ?? null,
    sessionId: input.sessionId ?? null,
    traceHint: input.traceHint ?? null,
    requestedModel: input.requestedModel ?? null,
    downstreamApiKeyId: input.downstreamApiKeyId ?? null,
    requestHeadersJson: serializeHeaders(input.requestHeaders, maxBodyBytes),
    requestBodyJson: stringifyDebugValue(input.requestBody, maxBodyBytes),
    createdAt: now,
    updatedAt: now,
  }).run();

  return {
    id: requireInsertedRowId(inserted, 'failed to create proxy debug trace'),
    createdAt: now,
  };
}

export async function startProxyDebugTraceSession(input: {
  downstreamPath: string;
  clientKind?: string | null;
  sessionId?: string | null;
  traceHint?: string | null;
  requestedModel?: string | null;
  downstreamApiKeyId?: number | null;
  requestHeaders?: HeadersLike;
  requestBody?: unknown;
}): Promise<ProxyDebugTraceSession | null> {
  const options = getCaptureOptions();
  if (!shouldTraceProxyDebugRequest(input, options)) {
    return null;
  }

  const trace = await createProxyDebugTrace({
    downstreamPath: input.downstreamPath,
    clientKind: input.clientKind ?? null,
    sessionId: input.sessionId ?? null,
    traceHint: input.traceHint ?? null,
    requestedModel: input.requestedModel ?? null,
    downstreamApiKeyId: input.downstreamApiKeyId ?? null,
    requestHeaders: options.captureHeaders ? input.requestHeaders : null,
    requestBody: options.captureBodies ? input.requestBody : null,
    maxBodyBytes: options.maxBodyBytes,
  });

  return {
    traceId: trace.id,
    options,
  };
}

export async function updateProxyDebugTraceSelection(traceId: number, input: {
  stickySessionKey?: string | null;
  stickyHitChannelId?: number | null;
  selectedChannelId?: number | null;
  selectedRouteId?: number | null;
  selectedAccountId?: number | null;
  selectedSiteId?: number | null;
  selectedSitePlatform?: string | null;
}) {
  const now = formatUtcSqlDateTime(new Date());
  await db.update(schema.proxyDebugTraces).set({
    stickySessionKey: input.stickySessionKey ?? null,
    stickyHitChannelId: input.stickyHitChannelId ?? null,
    selectedChannelId: input.selectedChannelId ?? null,
    selectedRouteId: input.selectedRouteId ?? null,
    selectedAccountId: input.selectedAccountId ?? null,
    selectedSiteId: input.selectedSiteId ?? null,
    selectedSitePlatform: input.selectedSitePlatform ?? null,
    updatedAt: now,
  }).where(eq(schema.proxyDebugTraces.id, traceId)).run();
}

export async function updateProxyDebugTraceCandidates(traceId: number, input: {
  endpointCandidates?: unknown;
  endpointRuntimeState?: unknown;
  decisionSummary?: unknown;
}) {
  const now = formatUtcSqlDateTime(new Date());
  await db.update(schema.proxyDebugTraces).set({
    endpointCandidatesJson: stringifyDebugValue(input.endpointCandidates, config.proxyDebugMaxBodyBytes),
    endpointRuntimeStateJson: stringifyDebugValue(input.endpointRuntimeState, config.proxyDebugMaxBodyBytes),
    decisionSummaryJson: stringifyDebugValue(input.decisionSummary, config.proxyDebugMaxBodyBytes),
    updatedAt: now,
  }).where(eq(schema.proxyDebugTraces.id, traceId)).run();
}

export async function insertProxyDebugAttempt(input: {
  traceId: number;
  attemptIndex: number;
  endpoint: string;
  requestPath: string;
  targetUrl: string;
  runtimeExecutor?: string | null;
  requestHeaders?: HeadersLike;
  requestBody?: unknown;
  responseStatus?: number | null;
  responseHeaders?: HeadersLike;
  responseBody?: unknown;
  rawErrorText?: string | null;
  recoverApplied?: boolean;
  downgradeDecision?: boolean;
  downgradeReason?: string | null;
  memoryWrite?: unknown;
  maxBodyBytes?: number;
}) {
  const now = formatUtcSqlDateTime(new Date());
  const maxBodyBytes = Math.max(1024, Math.trunc(input.maxBodyBytes || config.proxyDebugMaxBodyBytes || 262_144));
  const inserted = await db.insert(schema.proxyDebugAttempts).values({
    traceId: input.traceId,
    attemptIndex: input.attemptIndex,
    endpoint: input.endpoint,
    requestPath: input.requestPath,
    targetUrl: input.targetUrl,
    runtimeExecutor: input.runtimeExecutor ?? null,
    requestHeadersJson: serializeHeaders(input.requestHeaders, maxBodyBytes),
    requestBodyJson: stringifyDebugValue(input.requestBody, maxBodyBytes),
    responseStatus: input.responseStatus ?? null,
    responseHeadersJson: serializeHeaders(input.responseHeaders, maxBodyBytes),
    responseBodyJson: stringifyDebugValue(input.responseBody, maxBodyBytes),
    rawErrorText: input.rawErrorText ?? null,
    recoverApplied: input.recoverApplied === true,
    downgradeDecision: input.downgradeDecision === true,
    downgradeReason: input.downgradeReason ?? null,
    memoryWriteJson: stringifyDebugValue(input.memoryWrite, maxBodyBytes),
    createdAt: now,
  }).run();

  return {
    id: requireInsertedRowId(inserted, 'failed to create proxy debug attempt'),
    createdAt: now,
  };
}

export async function updateProxyDebugAttempt(traceId: number, attemptIndex: number, input: {
  downgradeDecision?: boolean;
  downgradeReason?: string | null;
  rawErrorText?: string | null;
}) {
  await db.update(schema.proxyDebugAttempts).set({
    ...(input.downgradeDecision !== undefined ? { downgradeDecision: input.downgradeDecision } : {}),
    ...(input.downgradeReason !== undefined ? { downgradeReason: input.downgradeReason } : {}),
    ...(input.rawErrorText !== undefined ? { rawErrorText: input.rawErrorText } : {}),
  }).where(and(
    eq(schema.proxyDebugAttempts.traceId, traceId),
    eq(schema.proxyDebugAttempts.attemptIndex, attemptIndex),
  )).run();
}

export async function finalizeProxyDebugTrace(traceId: number, input: {
  finalStatus?: string | null;
  finalHttpStatus?: number | null;
  finalUpstreamPath?: string | null;
  finalResponseHeaders?: HeadersLike;
  finalResponseBody?: unknown;
  maxBodyBytes?: number;
}) {
  const now = formatUtcSqlDateTime(new Date());
  const maxBodyBytes = Math.max(1024, Math.trunc(input.maxBodyBytes || config.proxyDebugMaxBodyBytes || 262_144));
  await db.update(schema.proxyDebugTraces).set({
    finalStatus: input.finalStatus ?? null,
    finalHttpStatus: input.finalHttpStatus ?? null,
    finalUpstreamPath: input.finalUpstreamPath ?? null,
    finalResponseHeadersJson: serializeHeaders(input.finalResponseHeaders, maxBodyBytes),
    finalResponseBodyJson: stringifyDebugValue(input.finalResponseBody, maxBodyBytes),
    updatedAt: now,
  }).where(eq(schema.proxyDebugTraces.id, traceId)).run();
}

export async function listProxyDebugTraces(input: { limit?: number }) {
  const limit = normalizeLimit(input.limit);
  return await db.select({
    id: schema.proxyDebugTraces.id,
    createdAt: schema.proxyDebugTraces.createdAt,
    downstreamPath: schema.proxyDebugTraces.downstreamPath,
    clientKind: schema.proxyDebugTraces.clientKind,
    sessionId: schema.proxyDebugTraces.sessionId,
    requestedModel: schema.proxyDebugTraces.requestedModel,
    selectedChannelId: schema.proxyDebugTraces.selectedChannelId,
    finalStatus: schema.proxyDebugTraces.finalStatus,
    finalHttpStatus: schema.proxyDebugTraces.finalHttpStatus,
    finalUpstreamPath: schema.proxyDebugTraces.finalUpstreamPath,
  }).from(schema.proxyDebugTraces)
    .orderBy(desc(schema.proxyDebugTraces.createdAt), desc(schema.proxyDebugTraces.id))
    .limit(limit)
    .all();
}

export async function getProxyDebugTraceDetail(traceId: number) {
  const trace = await db.select().from(schema.proxyDebugTraces)
    .where(eq(schema.proxyDebugTraces.id, traceId))
    .get();
  if (!trace) return null;

  const attempts = await db.select().from(schema.proxyDebugAttempts)
    .where(eq(schema.proxyDebugAttempts.traceId, traceId))
    .orderBy(asc(schema.proxyDebugAttempts.attemptIndex), asc(schema.proxyDebugAttempts.id))
    .all();

  return {
    trace,
    attempts,
  };
}

export async function findLatestProxyDebugTrace(input: {
  sessionId?: string | null;
  clientKind?: string | null;
  requestedModel?: string | null;
}) {
  const conditions = [
    input.sessionId ? eq(schema.proxyDebugTraces.sessionId, input.sessionId) : null,
    input.clientKind ? eq(schema.proxyDebugTraces.clientKind, input.clientKind) : null,
    input.requestedModel ? eq(schema.proxyDebugTraces.requestedModel, input.requestedModel) : null,
  ].filter((condition): condition is NonNullable<typeof condition> => condition !== null);

  let query = db.select().from(schema.proxyDebugTraces);
  if (conditions.length === 1) {
    query = query.where(conditions[0]) as typeof query;
  } else if (conditions.length > 1) {
    query = query.where(and(...conditions)) as typeof query;
  }
  return await query
    .orderBy(desc(schema.proxyDebugTraces.createdAt), desc(schema.proxyDebugTraces.id))
    .get();
}
