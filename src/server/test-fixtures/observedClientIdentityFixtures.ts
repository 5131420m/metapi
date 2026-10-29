/**
 * Downstream request headers of real CLI traffic, sanitized from the debian box's debug
 * traces (#461 Claude Code on /v1/messages, #463 Codex on /v1/responses, #464 Codex on
 * /v1/chat/completions). Credentials are replaced; everything else is verbatim, including
 * the fields the identity store must drop.
 */

export const CLAUDE_CODE_FIXTURE_HEADERS: Record<string, string> = {
  accept: 'text/event-stream',
  'accept-encoding': 'identity',
  'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24',
  'anthropic-dangerous-direct-browser-access': 'true',
  'anthropic-version': '2023-06-01',
  authorization: 'Bearer sk-secret-downstream',
  connection: 'keep-alive',
  'content-length': '768819',
  'content-type': 'application/json',
  host: '192.168.123.2:4000',
  'user-agent': 'claude-cli/2.1.151 (external, cli)',
  'x-app': 'cli',
  'x-claude-code-session-id': '3ffd96b8-3eaa-4cc5-ba87-fa8caad9334d',
  'x-stainless-arch': 'arm64',
  'x-stainless-lang': 'js',
  'x-stainless-os': 'MacOS',
  'x-stainless-package-version': '0.112.1',
  'x-stainless-retry-count': '2',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': 'v26.3.0',
  'x-stainless-timeout': '600',
};

export const CODEX_RESPONSES_FIXTURE_HEADERS: Record<string, string> = {
  accept: 'text/event-stream',
  'accept-encoding': 'gzip',
  authorization: 'Bearer sk-secret-downstream',
  connection: 'Keep-Alive',
  'content-type': 'application/json',
  host: '192.168.123.2:4000',
  originator: 'codex_cli_rs',
  'session-id': '764219db-0af7-50c5-a85a-c45508de6d1b',
  'user-agent': 'codex_cli_rs/0.114.0 (Mac OS 14.2.0; x86_64) vscode/1.111.0',
};

export const CODEX_CHAT_FIXTURE_HEADERS: Record<string, string> = {
  'accept-encoding': 'gzip',
  authorization: 'Bearer sk-secret-downstream',
  'content-type': 'application/json',
  host: '192.168.123.2:4000',
  originator: 'codex_cli_rs',
  'user-agent': 'codex_cli_rs/0.114.0 (Mac OS 14.2.0; x86_64) vscode/1.111.0',
};

/** Body shape of the real Codex responses request (#463), content replaced. */
export const CODEX_RESPONSES_FIXTURE_BODY: Record<string, unknown> = {
  instructions: '',
  stream: true,
  reasoning: { effort: 'medium' },
  parallel_tool_calls: true,
  include: ['reasoning.encrypted_content'],
  model: 'gpt-5.6-luna',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
  store: false,
  prompt_cache_key: '764219db-0af7-50c5-a85a-c45508de6d1b',
};

/** Body shape of the real Claude request (#461): no top-level system, no metadata. */
export const CLAUDE_CODE_FIXTURE_BODY: Record<string, unknown> = {
  model: 'claude-opus-5-5',
  max_tokens: 65536,
  stream: true,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
};
