import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVICES_DIR = fileURLToPath(new URL('.', import.meta.url));
const SERVER_ROOT = resolve(SERVICES_DIR, '..');

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
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

/**
 * The model fingerprint probe is display-only by construction, and it wraps a young
 * third-party SDK. These rules make both boundaries executable.
 */
describe('model identity probe architecture boundaries', () => {
  it('touches the upstream only through the site API endpoint pool, never routing state', () => {
    const service = readSource('./modelIdentityProbeService.ts');
    expect(service).toContain('runWithSiteApiEndpointPool');
    expect(service).not.toMatch(
      /recordProbeSuccess|recordProbeFailure|recordChannel\w*|clearCooldown|clearStickyChannel|proxyChannelCoordinator|tokenRouter\.(record|mark)/,
    );
    // A forwarding proxy is not a base URL (the candy probe's M1 regression).
    expect(service).not.toMatch(/executeEndpointFlow\(\{[\s\S]{0,400}proxyUrl:/);
  });

  it('imports lmfpd-sdk only from the detector adapter', () => {
    const offenders = listSourceFiles(SERVER_ROOT)
      .filter((file) => /from\s+['"]lmfpd-sdk['"]/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SERVER_ROOT, file).replace(/\\/g, '/'));
    expect(offenders).toEqual(['services/modelIdentityProbe/detector.ts']);
  });

  it('never uses the SDK HTTP path: keys must not leave through it', () => {
    // Comments are stripped: the adapter's doc comment names these to say they are NOT used.
    const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const path of ['./modelIdentityProbe/detector.ts', './modelIdentityProbeService.ts']) {
      expect(code(readSource(path))).not.toMatch(/\.detect\(|requestSample|DetectConfig/);
    }
  });

  it('keeps the route a thin adapter', () => {
    const route = readFileSync(resolve(SERVER_ROOT, 'routes/api/modelIdentityProbe.ts'), 'utf8');
    expect(route).not.toMatch(/executeEndpointFlow|dispatchRuntimeRequest|insertProxyLog|lmfpd-sdk|modelIdentityProbe\//);
  });
});
