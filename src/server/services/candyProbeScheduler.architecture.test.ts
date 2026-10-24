import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

/**
 * The candy probe is display-only BY CONSTRUCTION, and the schedule is the one caller
 * nobody watches. These rules keep that executable: the scheduler may read routing state
 * (it needs the cooldown classification to leave provider windows alone) but must never
 * write it, and must reach the upstream only through the probe service.
 */
describe('candy probe scheduler architecture boundaries', () => {
  it('never writes routing state: no cooldown, health or stickiness mutations', () => {
    const scheduler = readSource('./candyProbeScheduler.ts');
    expect(scheduler).not.toMatch(
      /recordProbeSuccess|recordProbeFailure|clearCooldown|clearStickyChannel|proxyChannelCoordinator/,
    );
  });

  it('reaches the upstream only through the probe service, not the endpoint flow directly', () => {
    const scheduler = readSource('./candyProbeScheduler.ts');
    expect(scheduler).not.toContain('executeEndpointFlow');
    expect(scheduler).not.toContain('dispatchRuntimeRequest');
    expect(scheduler).toContain('runChannelCandyProbe');
  });
});

/**
 * The probe's verdict stays display-only, but the probe REQUEST is a real request: it goes
 * through the site API endpoint pool (URL selection, endpoint success/failure records,
 * site concurrency lease). These rules pin the exact boundary — the pool yes, channel-level
 * routing/health state no — and guard the M1 regression (a forwarding proxy passed as a
 * base URL) at the source level.
 */
describe('candy probe service architecture boundaries', () => {
  it('touches the upstream only through the site API endpoint pool, never routing state', () => {
    const service = readSource('./candyProbeService.ts');
    // Allowed: the pool — URL selection, endpoint accounting, the site lease. The probe is
    // the request it stands in for, so its exchange outcome belongs in the pool's state.
    expect(service).toContain('runWithSiteApiEndpointPool');
    // Forbidden: channel-level routing and health state — a verdict must never feed
    // routing, cooldowns or stickiness.
    expect(service).not.toMatch(
      /recordProbeSuccess|recordProbeFailure|recordChannel\w*|clearCooldown|clearStickyChannel|tokenRouter\.(record|mark)/,
    );
    // Forbidden: a forwarding proxy as a base URL — endpointFlow's proxyUrl field is a
    // base-URL override; with one present the probe requested the proxy address itself.
    expect(service).not.toMatch(/executeEndpointFlow\(\{[\s\S]{0,400}proxyUrl:/);
  });
});
