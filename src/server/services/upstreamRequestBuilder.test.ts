import { describe, expect, it } from 'vitest';

import {
  buildClaudeCountTokensUpstreamRequest,
  buildUpstreamEndpointRequest,
} from './upstreamRequestBuilder.js';

describe('upstreamRequestBuilder', () => {
  it('normalizes single-message OpenAI requests to structured responses input', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'responses',
      modelName: 'upstream-gpt',
      stream: false,
      tokenValue: 'sk-test',
      sitePlatform: 'sub2api',
      siteUrl: 'https://example.com',
      openaiBody: {
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hello' }],
      },
      downstreamFormat: 'openai',
    });

    expect(request.path).toBe('/v1/responses');
    expect(request.headers.accept).toBe('application/json');
    expect(request.body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ]);
    expect(request.body.store).toBe(false);
  });

  it('forces store=false for sub2api native responses passthrough bodies', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'responses',
      modelName: 'upstream-gpt',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'sub2api',
      siteUrl: 'https://example.com',
      openaiBody: {},
      downstreamFormat: 'responses',
      responsesOriginalBody: {
        model: 'gpt-5.2',
        input: 'hello',
        store: true,
      },
    });

    expect(request.path).toBe('/v1/responses');
    expect(request.headers.accept).toBe('text/event-stream');
    expect(request.body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ]);
    expect(request.body.stream).toBe(true);
    expect(request.body.store).toBe(false);
  });

  it('removes replayed encrypted reasoning from sub2api Responses input while preserving tools and messages', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'responses',
      modelName: 'upstream-gpt',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'sub2api',
      siteUrl: 'https://example.com',
      openaiBody: {},
      downstreamFormat: 'responses',
      responsesOriginalBody: {
        model: 'gpt-5.2',
        input: [
          { type: 'reasoning', encrypted_content: 'foreign-blob' },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        ],
        tools: [{ type: 'function', name: 'terminal', parameters: { type: 'object' } }],
        tool_choice: 'auto',
      },
    });

    expect(request.body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    ]);
    expect(request.body.tools).toEqual([
      { type: 'function', name: 'terminal', parameters: { type: 'object' } },
    ]);
    expect(request.body.tool_choice).toBe('auto');
    expect(request.body.store).toBe(false);
  });

  it('preserves Responses Lite additional_tools in native Responses passthrough bodies', () => {
    const additionalTools = {
      type: 'additional_tools',
      role: 'developer',
      tools: [
        {
          type: 'custom',
          name: 'exec',
          description: 'Run JavaScript code',
          format: {
            type: 'grammar',
            syntax: 'lark',
            definition: 'start: SOURCE',
          },
        },
        {
          type: 'function',
          name: 'wait',
          parameters: {
            type: 'object',
            properties: {
              cell_id: { type: 'string' },
            },
            required: ['cell_id'],
          },
        },
        {
          type: 'namespace',
          name: 'collaboration',
        },
      ],
    };

    const request = buildUpstreamEndpointRequest({
      endpoint: 'responses',
      modelName: 'gpt-5.6-sol',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'sub2api',
      siteUrl: 'https://example.com',
      openaiBody: {},
      downstreamFormat: 'responses',
      responsesOriginalBody: {
        model: 'gpt-5.6-sol',
        input: [
          additionalTools,
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Read README.md' }],
          },
        ],
        tool_choice: 'auto',
      },
    });

    expect(request.path).toBe('/v1/responses');
    expect(request.body.input).toEqual([
      additionalTools,
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Read README.md' }],
      },
    ]);
    expect(request.body.tool_choice).toBe('auto');
    expect(request.body.store).toBe(false);
  });

  it('overrides downstream Accept so responses transport mode wins', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'responses',
      modelName: 'upstream-gpt',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'openai',
      siteUrl: 'https://example.com',
      openaiBody: {
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hello' }],
      },
      downstreamFormat: 'openai',
      downstreamHeaders: {
        accept: 'application/json',
      },
    });

    expect(request.headers.accept).toBe('text/event-stream');
  });

  it('applies the same Responses safeguards to the new-api platform alias', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'responses',
      modelName: 'upstream-gpt',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'new-api',
      siteUrl: 'https://example.com',
      openaiBody: {},
      downstreamFormat: 'responses',
      responsesOriginalBody: {
        model: 'gpt-5.2',
        input: [{ type: 'reasoning', encrypted_content: 'foreign-blob' }],
      },
    });

    expect(request.body.input).toEqual([]);
    expect(request.body.store).toBe(false);
  });

  it('applies a sub2api-style allowlist to generic passthrough headers', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'chat',
      modelName: 'upstream-gpt',
      stream: false,
      tokenValue: 'sk-test',
      sitePlatform: 'sub2api',
      siteUrl: 'https://example.com',
      openaiBody: {
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hello' }],
      },
      downstreamFormat: 'openai',
      downstreamHeaders: {
        accept: 'application/json',
        'accept-language': 'zh-CN',
        'user-agent': 'client-ua/1.0',
        originator: 'codex_cli_rs',
        session_id: 'session-123',
        conversation_id: 'conversation-123',
        'x-codex-turn-state': 'turn-state',
        'x-codex-turn-metadata': 'turn-metadata',
        origin: 'https://client.example',
        referer: 'https://client.example/chat',
        'x-forwarded-for': '203.0.113.1',
        'x-real-ip': '203.0.113.2',
        version: '0.202.0',
        'x-test-header': 'drop-me',
      },
    });

    expect(request.headers.accept).toBe('application/json');
    expect(request.headers['accept-language']).toBe('zh-CN');
    expect(request.headers['user-agent']).toBe('client-ua/1.0');
    expect(request.headers.originator).toBe('codex_cli_rs');
    expect(request.headers.session_id).toBe('session-123');
    expect(request.headers.conversation_id).toBe('conversation-123');
    expect(request.headers['x-codex-turn-state']).toBe('turn-state');
    expect(request.headers['x-codex-turn-metadata']).toBe('turn-metadata');

    expect(request.headers.origin).toBeUndefined();
    expect(request.headers.referer).toBeUndefined();
    expect(request.headers['x-forwarded-for']).toBeUndefined();
    expect(request.headers['x-real-ip']).toBeUndefined();
    expect(request.headers.version).toBeUndefined();
    expect(request.headers['x-test-header']).toBeUndefined();
  });

  it('flattens reasoning.effort to reasoning_effort on responses→chat fallback', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'chat',
      modelName: 'upstream-gpt',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'sub2api',
      siteUrl: 'https://example.com',
      openaiBody: {
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hello' }],
        reasoning: { effort: 'high' },
      },
      downstreamFormat: 'responses',
    });

    expect(request.path).toBe('/v1/chat/completions');
    expect(request.body.reasoning_effort).toBe('high');
    expect(request.body.reasoning).toBeUndefined();
  });

  it('preserves reasoning_effort on native chat requests (no flatten)', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'chat',
      modelName: 'upstream-gpt',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'sub2api',
      siteUrl: 'https://example.com',
      openaiBody: {
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hello' }],
        reasoning_effort: 'high',
      },
      downstreamFormat: 'openai',
    });

    expect(request.body.reasoning_effort).toBe('high');
    expect(request.body.reasoning).toBeUndefined();
  });

  it('forwards x-codex-* headers on responses endpoint regardless of platform', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'responses',
      modelName: 'gpt-5.2',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'new-api',
      siteUrl: 'https://example.com',
      openaiBody: {
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hello' }],
      },
      downstreamFormat: 'responses',
      downstreamHeaders: {
        'x-codex-window-id': 'window-abc',
        'x-codex-turn-state': 'turn-state',
        'x-client-request-id': 'req-123',
        'x-codex-beta-features': 'feature-1',
        'x-test-header': 'drop-me',
      },
    });

    expect(request.headers['x-codex-window-id']).toBe('window-abc');
    expect(request.headers['x-codex-turn-state']).toBe('turn-state');
    expect(request.headers['x-codex-beta-features']).toBe('feature-1');
    expect(request.headers['x-client-request-id']).toBeUndefined();
    expect(request.headers['x-test-header']).toBeUndefined();
  });

  it('forwards x-codex-* headers on responses→chat fallback', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'chat',
      modelName: 'gpt-5.2',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'new-api',
      siteUrl: 'https://example.com',
      openaiBody: {
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hello' }],
      },
      downstreamFormat: 'responses',
      downstreamHeaders: {
        'x-codex-window-id': 'window-abc',
        'x-codex-turn-state': 'turn-state',
        'x-client-request-id': 'req-123',
      },
    });

    expect(request.headers['x-codex-window-id']).toBe('window-abc');
    expect(request.headers['x-codex-turn-state']).toBe('turn-state');
    expect(request.headers['x-client-request-id']).toBeUndefined();
  });

  it('does not forward x-codex-* headers on native chat requests', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'chat',
      modelName: 'gpt-5.2',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'new-api',
      siteUrl: 'https://example.com',
      openaiBody: {
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hello' }],
      },
      downstreamFormat: 'openai',
      downstreamHeaders: {
        'x-codex-window-id': 'window-abc',
        'x-client-request-id': 'req-123',
      },
    });

    expect(request.headers['x-codex-window-id']).toBeUndefined();
    expect(request.headers['x-client-request-id']).toBeUndefined();
  });

  it('drops responses-style continuation fields before proxying Claude count_tokens upstream', () => {
    const request = buildClaudeCountTokensUpstreamRequest({
      modelName: 'claude-opus-4-6',
      tokenValue: 'sk-test',
      sitePlatform: 'claude',
      claudeBody: {
        model: 'claude-opus-4-6',
        max_tokens: 256,
        previous_response_id: 'resp_prev_1',
        prompt_cache_key: 'cache-key-1',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(request.body).toMatchObject({
      model: 'claude-opus-4-6',
      messages: [{ role: 'user' }],
    });
    expect(request.body).not.toHaveProperty('previous_response_id');
    expect(request.body).not.toHaveProperty('prompt_cache_key');
    expect(request.body).not.toHaveProperty('max_tokens');
    expect(request.body).not.toHaveProperty('maxTokens');
  });

  it('merges body betas with existing anthropic-beta headers for Claude count_tokens', () => {
    const request = buildClaudeCountTokensUpstreamRequest({
      modelName: 'claude-opus-4-6',
      tokenValue: 'sk-test',
      sitePlatform: 'claude',
      claudeBody: {
        model: 'claude-opus-4-6',
        betas: ['beta-from-body'],
        messages: [{ role: 'user', content: 'hello' }],
      },
      downstreamHeaders: {
        'anthropic-beta': 'header-beta',
      },
    });

    expect(request.headers['anthropic-beta']).toContain('header-beta');
    expect(request.headers['anthropic-beta']).toContain('beta-from-body');
  });
});
