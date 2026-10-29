import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVICES_DIR = fileURLToPath(new URL('.', import.meta.url));
const SERVER_ROOT = resolve(SERVICES_DIR, '..');

function readServerSource(relativePath: string): string {
  return readFileSync(resolve(SERVER_ROOT, relativePath), 'utf8');
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...listSourceFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) files.push(full);
  }
  return files;
}

/** Strip comments: doc comments name the functions they say a module must NOT call. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * One store of observed client identities, one writer, read-only consumers. These rules keep
 * the probes and the playground from learning from themselves, and keep the store neutral.
 */
describe('observed client identity architecture boundaries', () => {
  it('stays a neutral module', () => {
    const store = code(readServerSource('services/observedClientIdentity.ts'));
    expect(store).not.toMatch(/from\s+['"][^'"]*routes\//);
    expect(store).not.toMatch(/from\s+['"]fastify['"]/);
  });

  it('is written only by the shared surface bookkeeping', () => {
    const writers = listSourceFiles(SERVER_ROOT)
      .filter((file) => !file.endsWith(`${join('services', 'observedClientIdentity.ts')}`))
      .filter((file) => /\brecordObservedClientIdentity\s*\(/.test(code(readFileSync(file, 'utf8'))))
      .map((file) => relative(SERVER_ROOT, file).replace(/\\/g, '/'));
    expect(writers).toEqual(['proxy-core/surfaces/sharedSurface.ts']);
  });

  it('skips playground requests at the write point', () => {
    const shared = code(readServerSource('proxy-core/surfaces/sharedSurface.ts'));
    const start = shared.indexOf('export function recordSurfaceClientIdentityObservation');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = shared.slice(start, shared.indexOf('\nexport ', start + 10));
    expect(body).toContain('isTrustedTesterRequest');
    expect(body).toContain('hasTesterRequestMarker');
  });

  it('lets the consumers resolve identities but never record them', () => {
    for (const path of [
      'services/candyProbeService.ts',
      'services/modelIdentityProbeService.ts',
      'routes/api/test.ts',
    ]) {
      const source = code(readServerSource(path));
      expect(source, path).toMatch(/resolve(Sdk)?ClientIdentityProfile/);
      expect(source, path).not.toMatch(/recordObservedClientIdentity|recordSurfaceClientIdentityObservation/);
    }
  });

  it('keeps the fingerprint probe body exactly the SDK body', () => {
    // The reference bank was sampled under the SDK body; only the headers may follow real
    // traffic, so the probe must not read the observed body traits.
    const service = code(readServerSource('services/modelIdentityProbeService.ts'));
    expect(service).not.toContain('bodyTraits');
  });
});
