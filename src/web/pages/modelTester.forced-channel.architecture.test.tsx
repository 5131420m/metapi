import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ModelTester forced channel architecture', () => {
  it('wires a fixed-channel selector through route decisions and tester envelopes', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/ModelTester.tsx'), 'utf8').replace(/\r\n/g, '\n');

    expect(source).toContain('固定通道');
    expect(source).toContain('api.getRouteDecision(inputs.model)');
    expect(source).toContain('forcedChannelId');
    expect(source).toContain('attachForcedChannelToEnvelope');
  });

  it('stamps the client identity on the same envelope path and reads back what was used', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/ModelTester.tsx'), 'utf8').replace(/\r\n/g, '\n');

    expect(source).toContain('客户端身份');
    expect(source).toContain('attachClientIdentityToEnvelope(attachForcedChannelToEnvelope(');
    expect(source).toContain('api.getObservedClientIdentities()');
    expect(source).toContain("parseTesterIdentityHeader(response.headers.get('x-metapi-tester-identity'))");
  });
});
