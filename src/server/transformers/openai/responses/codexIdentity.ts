import { createHash, randomUUID } from 'node:crypto';

export type CodexIdentityMode = 'off' | 'synthesize';

type CodexIdentityInput = {
  mode: CodexIdentityMode;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  identityScopeKey: string;
  continuityKey?: string | null;
  turnKey?: string | null;
};

type CodexIdentityResult = Pick<CodexIdentityInput, 'body' | 'headers'>;

type CodexClientMetadata = Record<string, unknown>;

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getHeader(headers: Record<string, string>, name: string): string {
  const normalizedName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalizedName) return asTrimmedString(value);
  }
  return '';
}

function uuidFromSeed(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function parseJsonRecord(value: string): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function resolveMetadata(body: Record<string, unknown>): CodexClientMetadata {
  return body.client_metadata && typeof body.client_metadata === 'object' && !Array.isArray(body.client_metadata)
    ? { ...(body.client_metadata as CodexClientMetadata) }
    : {};
}

export function applyCodexIdentity(input: CodexIdentityInput): CodexIdentityResult {
  if (input.mode !== 'synthesize') {
    return { body: input.body, headers: input.headers };
  }

  const body = { ...input.body };
  const headers = { ...input.headers };
  const metadata = resolveMetadata(body);
  const headerTurnMetadata = parseJsonRecord(getHeader(headers, 'x-codex-turn-metadata'));
  const continuityKey = asTrimmedString(input.continuityKey);
  const identityScopeKey = asTrimmedString(input.identityScopeKey) || 'metapi';
  const sessionId = (
    getHeader(headers, 'session_id')
    || getHeader(headers, 'session-id')
    || asTrimmedString(metadata.session_id)
    || asTrimmedString(headerTurnMetadata.session_id)
    || (continuityKey ? uuidFromSeed(`metapi:codex:session:${identityScopeKey}:${continuityKey}`) : randomUUID())
  );
  const threadId = (
    getHeader(headers, 'thread-id')
    || getHeader(headers, 'thread_id')
    || asTrimmedString(metadata.thread_id)
    || asTrimmedString(headerTurnMetadata.thread_id)
    || sessionId
  );
  const installationId = (
    asTrimmedString(metadata['x-codex-installation-id'])
    || asTrimmedString(headerTurnMetadata.installation_id)
    || uuidFromSeed(`metapi:codex:installation:${identityScopeKey}`)
  );
  const windowId = (
    getHeader(headers, 'x-codex-window-id')
    || asTrimmedString(metadata['x-codex-window-id'])
    || asTrimmedString(headerTurnMetadata.window_id)
    || `${sessionId}:0`
  );
  const turnId = (
    asTrimmedString(metadata.turn_id)
    || asTrimmedString(headerTurnMetadata.turn_id)
    || (asTrimmedString(input.turnKey)
      ? uuidFromSeed(`metapi:codex:turn:${identityScopeKey}:${input.turnKey}`)
      : randomUUID())
  );
  const turnMetadata = {
    ...headerTurnMetadata,
    installation_id: installationId,
    session_id: sessionId,
    thread_id: threadId,
    turn_id: turnId,
    window_id: windowId,
    request_kind: asTrimmedString(headerTurnMetadata.request_kind) || 'turn',
  };
  const serializedTurnMetadata = JSON.stringify(turnMetadata);

  headers.session_id = sessionId;
  headers['x-codex-window-id'] = windowId;
  headers['x-codex-turn-metadata'] = serializedTurnMetadata;
  metadata.session_id = sessionId;
  metadata.thread_id = threadId;
  metadata.turn_id = turnId;
  metadata['x-codex-installation-id'] = installationId;
  metadata['x-codex-window-id'] = windowId;
  metadata['x-codex-turn-metadata'] = serializedTurnMetadata;
  body.client_metadata = metadata;

  return { body, headers };
}
