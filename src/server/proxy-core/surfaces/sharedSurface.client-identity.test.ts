import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_CODE_FIXTURE_HEADERS,
  CODEX_RESPONSES_FIXTURE_HEADERS,
} from '../../test-fixtures/observedClientIdentityFixtures.js';

const recordObservedClientIdentityMock = vi.fn();

vi.mock('../../services/observedClientIdentity.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/observedClientIdentity.js')>(
    '../../services/observedClientIdentity.js',
  );
  return {
    ...actual,
    recordObservedClientIdentity: (...args: unknown[]) => recordObservedClientIdentityMock(...args),
  };
});

describe('recordSurfaceClientIdentityObservation', () => {
  beforeEach(() => {
    recordObservedClientIdentityMock.mockReset();
  });

  it('records real Claude Code and Codex traffic', async () => {
    const { recordSurfaceClientIdentityObservation } = await import('./sharedSurface.js');
    recordSurfaceClientIdentityObservation({
      clientContext: { clientKind: 'claude_code' },
      downstreamFormat: 'claude',
      headers: CLAUDE_CODE_FIXTURE_HEADERS,
      clientIp: '192.168.123.10',
      body: { stream: true },
    });
    recordSurfaceClientIdentityObservation({
      clientContext: { clientKind: 'codex' },
      downstreamFormat: 'responses',
      headers: CODEX_RESPONSES_FIXTURE_HEADERS,
      clientIp: '192.168.123.10',
      body: { stream: true },
    });
    expect(recordObservedClientIdentityMock).toHaveBeenCalledTimes(2);
    expect(recordObservedClientIdentityMock.mock.calls[0]![0]).toMatchObject({
      clientKind: 'claude_code',
      downstreamFormat: 'claude',
    });
    expect(recordObservedClientIdentityMock.mock.calls[1]![0]).toMatchObject({
      clientKind: 'codex',
      downstreamFormat: 'responses',
    });
  });

  it('never learns from the playground, trusted or not', async () => {
    const { recordSurfaceClientIdentityObservation } = await import('./sharedSurface.js');
    const testerHeaders = { ...CLAUDE_CODE_FIXTURE_HEADERS, 'x-metapi-tester-request': '1' };
    recordSurfaceClientIdentityObservation({
      clientContext: { clientKind: 'claude_code' },
      downstreamFormat: 'claude',
      headers: testerHeaders,
      clientIp: '127.0.0.1',
    });
    recordSurfaceClientIdentityObservation({
      clientContext: { clientKind: 'claude_code' },
      downstreamFormat: 'claude',
      headers: testerHeaders,
      clientIp: '10.0.0.5',
    });
    expect(recordObservedClientIdentityMock).not.toHaveBeenCalled();
  });

  it('skips generic clients, probes and unsupported formats', async () => {
    const { recordSurfaceClientIdentityObservation } = await import('./sharedSurface.js');
    recordSurfaceClientIdentityObservation({
      clientContext: { clientKind: 'generic' },
      downstreamFormat: 'openai',
      headers: { 'user-agent': 'curl/8' },
    });
    recordSurfaceClientIdentityObservation({
      clientContext: { clientKind: 'candy_probe' as any },
      downstreamFormat: 'claude',
      headers: CLAUDE_CODE_FIXTURE_HEADERS,
    });
    recordSurfaceClientIdentityObservation({
      clientContext: { clientKind: 'gemini_cli' },
      downstreamFormat: 'gemini',
      headers: { 'user-agent': 'GeminiCLI/0.31.0' },
    });
    recordSurfaceClientIdentityObservation({
      clientContext: null,
      downstreamFormat: 'claude',
      headers: CLAUDE_CODE_FIXTURE_HEADERS,
    });
    expect(recordObservedClientIdentityMock).not.toHaveBeenCalled();
  });

  it('never throws into the request path', async () => {
    const { recordSurfaceClientIdentityObservation } = await import('./sharedSurface.js');
    recordObservedClientIdentityMock.mockImplementation(() => {
      throw new Error('boom');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => recordSurfaceClientIdentityObservation({
      clientContext: { clientKind: 'codex' },
      downstreamFormat: 'openai',
      headers: CODEX_RESPONSES_FIXTURE_HEADERS,
    })).not.toThrow();
    warn.mockRestore();
  });
});
