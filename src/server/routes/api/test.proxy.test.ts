import { zstdCompressSync } from 'node:zlib';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    fetch: (...args: unknown[]) => fetchMock(...args),
  };
});

describe('testRoutes proxy tester transport', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { testRoutes } = await import('./test.js');
    app = Fastify();
    await app.register(testRoutes);
  });

  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects proxy test paths outside the whitelist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/test/proxy',
      payload: {
        method: 'POST',
        path: '/api/accounts',
        requestKind: 'json',
        stream: false,
        jobMode: false,
        rawMode: false,
        jsonBody: {},
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: 'path is not allowed: /api/accounts',
        type: 'validation_error',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards raw json bodies without dropping unknown fields', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      object: 'response',
      output_text: 'ok',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/test/proxy',
      payload: {
        method: 'POST',
        path: '/v1/responses',
        requestKind: 'json',
        stream: false,
        jobMode: false,
        rawMode: true,
        forcedChannelId: 77,
        rawJsonText: JSON.stringify({
          model: 'gpt-4o-mini',
          include: ['reasoning.encrypted_content'],
          metadata: { source: 'playground' },
          custom_field: 'keep-me',
        }),
      },
    });

    expect(response.statusCode).toBe(200);
    const [url, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/responses$/);
    expect(requestInit.headers).toMatchObject({
      'x-metapi-tester-request': '1',
      'x-metapi-tester-forced-channel-id': '77',
    });
    expect(JSON.parse(String(requestInit.body))).toEqual({
      model: 'gpt-4o-mini',
      include: ['reasoning.encrypted_content'],
      metadata: { source: 'playground' },
      custom_field: 'keep-me',
      stream: false,
    });
  });

  it('translates legacy claude chat tests through the compatibility wrapper', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      type: 'message',
      content: [{ type: 'text', text: 'pong' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/test/chat',
      payload: {
        model: 'claude-3-7-sonnet',
        targetFormat: 'claude',
        forcedChannelId: 55,
        messages: [
          { role: 'system', content: 'be concise' },
          { role: 'user', content: 'ping' },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const [url, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/messages$/);
    expect(requestInit.headers).toMatchObject({
      'x-metapi-tester-request': '1',
      'x-metapi-tester-forced-channel-id': '55',
    });
    expect(JSON.parse(String(requestInit.body))).toEqual({
      model: 'claude-3-7-sonnet',
      stream: false,
      max_tokens: 4096,
      system: 'be concise',
      messages: [
        { role: 'user', content: 'ping' },
      ],
    });
  });

  it('accepts stream=true when creating proxy jobs and stores a pending job', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/test/proxy/jobs',
      payload: {
        method: 'POST',
        path: '/v1/chat/completions',
        requestKind: 'json',
        stream: true,
        jobMode: true,
        rawMode: false,
        jsonBody: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'ping' }] },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      status: 'pending',
    });
  });

  it('allows multipart proxy uploads to /v1/files', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'file_123',
      object: 'file',
      bytes: 8,
      filename: 'notes.md',
      purpose: 'assistants',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/test/proxy',
      payload: {
        method: 'POST',
        path: '/v1/files',
        requestKind: 'multipart',
        stream: false,
        jobMode: false,
        rawMode: false,
        multipartFields: {
          purpose: 'assistants',
        },
        multipartFiles: [
          {
            field: 'file',
            name: 'notes.md',
            mimeType: 'text/markdown',
            dataUrl: 'data:text/markdown;base64,IyBoZWxsbw==',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const [url, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit & { body?: { constructor?: { name?: string } } }];
    expect(url).toMatch(/\/v1\/files$/);
    expect(requestInit.body?.constructor?.name).toBe('FormData');
  });

  it('decodes zstd-compressed buffered proxy test responses', async () => {
    const payload = JSON.stringify({
      choices: [
        {
          message: {
            content: '你好，来自压缩响应',
          },
        },
      ],
    });
    fetchMock.mockResolvedValue(new Response(zstdCompressSync(Buffer.from(payload)), {
      status: 200,
      headers: {
        'content-encoding': 'zstd',
        'content-type': 'application/json; charset=utf-8',
      },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/test/proxy',
      payload: {
        method: 'POST',
        path: '/v1/chat/completions',
        requestKind: 'json',
        stream: false,
        jobMode: false,
        rawMode: false,
        jsonBody: {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'ping' }],
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      choices: [
        {
          message: {
            content: '你好，来自压缩响应',
          },
        },
      ],
    });
  });

  it('decodes zstd-compressed non-SSE stream fallback responses', async () => {
    const payload = JSON.stringify({
      choices: [
        {
          message: {
            content: '你好，来自流式回退',
          },
        },
      ],
    });
    fetchMock.mockResolvedValue(new Response(zstdCompressSync(Buffer.from(payload)), {
      status: 200,
      headers: {
        'content-encoding': 'zstd',
        'content-type': 'application/json; charset=utf-8',
      },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/test/proxy/stream',
      payload: {
        method: 'POST',
        path: '/v1/chat/completions',
        requestKind: 'json',
        stream: true,
        jobMode: false,
        rawMode: false,
        jsonBody: {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'ping' }],
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.payload).toBe(`data: ${payload}\n\ndata: [DONE]\n\n`);
  });

  it('encodes multiline non-SSE stream fallback responses as valid SSE', async () => {
    const payload = 'line one\nline two\n';
    fetchMock.mockResolvedValue(new Response(payload, {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
      },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/test/proxy/stream',
      payload: {
        method: 'POST',
        path: '/v1/chat/completions',
        requestKind: 'json',
        stream: true,
        jobMode: false,
        rawMode: false,
        jsonBody: {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'ping' }],
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.payload).toBe('data: line one\ndata: line two\ndata: \n\ndata: [DONE]\n\n');
  });

  it('sends a neutral identity by default instead of undici defaults', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const response = await app.inject({
      method: 'POST',
      url: '/api/test/proxy',
      payload: {
        method: 'POST',
        path: '/v1/chat/completions',
        requestKind: 'json',
        stream: false,
        jobMode: false,
        rawMode: false,
        jsonBody: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'ping' }] },
      },
    });
    expect(response.statusCode).toBe(200);
    // The body is untouched: the identity travels in a response header only.
    expect(response.json()).toEqual({ ok: true });
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = requestInit.headers as Record<string, string>;
    expect(headers['user-agent']).toBe('metapi-tester');
    // Blank values override undici's `accept: */*` / `accept-language: *`; every passthrough
    // filter drops empty values, so neither reaches the upstream.
    expect(headers.accept).toBe('');
    expect(headers['accept-language']).toBe('');
    const identity = JSON.parse(decodeURIComponent(String(response.headers['x-metapi-tester-identity'])));
    expect(identity).toEqual({ source: 'none', clientKind: 'generic', userAgent: 'metapi-tester', observedAt: null });
  });

  it('wears the observed client identity when asked, with a per-conversation session', async () => {
    const identityStore = await import('../../services/observedClientIdentity.js');
    const fixtures = await import('../../test-fixtures/observedClientIdentityFixtures.js');
    identityStore.resetObservedClientIdentityStoreForTests();
    identityStore.recordObservedClientIdentity({
      clientKind: 'claude_code',
      downstreamFormat: 'claude',
      headers: fixtures.CLAUDE_CODE_FIXTURE_HEADERS,
    });
    try {
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ type: 'message', content: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
      const send = (seed: string) => app.inject({
        method: 'POST',
        url: '/api/test/proxy',
        payload: {
          method: 'POST',
          path: '/v1/messages',
          requestKind: 'json',
          stream: false,
          jobMode: false,
          rawMode: false,
          forcedChannelId: 12,
          clientIdentity: 'observed',
          identitySessionSeed: seed,
          jsonBody: { model: 'claude-opus-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] },
        },
      });
      const first = await send('conversation-a');
      await send('conversation-a');
      await send('conversation-b');

      const sent = fetchMock.mock.calls.map((call) => (call[1] as RequestInit).headers as Record<string, string>);
      expect(sent[0]!['user-agent']).toBe('claude-cli/2.1.151 (external, cli)');
      expect(sent[0]!['x-app']).toBe('cli');
      expect(sent[0]!['x-stainless-os']).toBe('MacOS');
      // The tester markers and credentials are never replaced by the identity.
      expect(sent[0]![ 'x-metapi-tester-request']).toBe('1');
      expect(sent[0]!['x-metapi-tester-forced-channel-id']).toBe('12');
      expect(sent[0]!['user-agent']).not.toContain('undici');
      const session = sent[0]!['x-claude-code-session-id'];
      expect(session).toMatch(/^[0-9a-f-]{36}$/);
      expect(session).not.toBe(fixtures.CLAUDE_CODE_FIXTURE_HEADERS['x-claude-code-session-id']);
      expect(sent[1]!['x-claude-code-session-id']).toBe(session);
      expect(sent[2]!['x-claude-code-session-id']).not.toBe(session);

      const identity = JSON.parse(decodeURIComponent(String(first.headers['x-metapi-tester-identity'])));
      expect(identity).toMatchObject({
        source: 'observed',
        clientKind: 'claude_code',
        userAgent: 'claude-cli/2.1.151 (external, cli)',
      });
      // The request body is the user's, untouched by the identity.
      expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({
        model: 'claude-opus-5-5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
      });
    } finally {
      identityStore.resetObservedClientIdentityStoreForTests();
    }
  });

  it('falls back to the built-in identity when nothing was observed', async () => {
    const identityStore = await import('../../services/observedClientIdentity.js');
    identityStore.resetObservedClientIdentityStoreForTests();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ object: 'response' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const response = await app.inject({
      method: 'POST',
      url: '/api/test/proxy',
      payload: {
        method: 'POST',
        path: '/v1/responses',
        requestKind: 'json',
        stream: false,
        jobMode: false,
        rawMode: false,
        clientIdentity: 'observed',
        jsonBody: { model: 'gpt-5.4', input: 'ping' },
      },
    });
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['user-agent']).toBe('codex_cli_rs/0.165.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464');
    expect(headers.originator).toBe('codex_cli_rs');
    expect(JSON.parse(decodeURIComponent(String(response.headers['x-metapi-tester-identity']))).source).toBe('builtin');
  });

  it('cancels and releases SSE readers when stream forwarding fails', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const releaseLock = vi.fn();
    const read = vi.fn().mockRejectedValue(new Error('boom'));
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'text/event-stream; charset=utf-8',
      }),
      body: {
        getReader: () => ({
          read,
          cancel,
          releaseLock,
        }),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/test/proxy/stream',
      payload: {
        method: 'POST',
        path: '/v1/chat/completions',
        requestKind: 'json',
        stream: true,
        jobMode: false,
        rawMode: false,
        jsonBody: {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'ping' }],
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.payload).toContain('event: error');
    expect(response.payload).toContain('"message":"boom"');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });
});
