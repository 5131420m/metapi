import { describe, expect, it } from 'vitest';

import { applyCodexIdentity } from './codexIdentity.js';

describe('codex identity compatibility', () => {
  it('synthesizes matching header and client_metadata identity fields', () => {
    const result = applyCodexIdentity({
      mode: 'synthesize',
      body: {
        model: 'gpt-5.6-sol',
        input: [{ type: 'message', role: 'user', content: [] }],
      },
      headers: {
        authorization: 'Bearer [REDACTED]',
        session_id: 'session-from-header',
      },
      identityScopeKey: 'site:17',
      continuityKey: 'responses:proxy-key',
      turnKey: 'turn:1',
    });

    const metadata = result.body.client_metadata as Record<string, unknown>;
    expect(result.headers.authorization).toBe('Bearer [REDACTED]');
    expect(result.headers.session_id).toBe('session-from-header');
    expect(result.headers['x-codex-window-id']).toBe('session-from-header:0');
    expect(typeof result.headers['x-codex-turn-metadata']).toBe('string');
    expect(metadata.session_id).toBe('session-from-header');
    expect(metadata.thread_id).toBe('session-from-header');
    expect(metadata['x-codex-window-id']).toBe('session-from-header:0');
    expect(metadata['x-codex-installation-id']).toMatch(/^[0-9a-f-]{36}$/i);
    expect(metadata.turn_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(metadata['x-codex-turn-metadata']).toBe(result.headers['x-codex-turn-metadata']);

    const headerMetadata = JSON.parse(result.headers['x-codex-turn-metadata']!);
    expect(headerMetadata.session_id).toBe(metadata.session_id);
    expect(headerMetadata.thread_id).toBe(metadata.thread_id);
    expect(headerMetadata.turn_id).toBe(metadata.turn_id);
    expect(headerMetadata.window_id).toBe(metadata['x-codex-window-id']);
    expect(headerMetadata.installation_id).toBe(metadata['x-codex-installation-id']);
  });

  it('does not change the request when identity mode is off', () => {
    const body = { model: 'gpt-5.6-sol', input: [] };
    const headers = { authorization: 'Bearer [REDACTED]' };

    expect(applyCodexIdentity({
      mode: 'off',
      body,
      headers,
      identityScopeKey: 'site:17',
      continuityKey: 'responses:proxy-key',
      turnKey: 'turn:1',
    })).toEqual({ body, headers });
  });
});
