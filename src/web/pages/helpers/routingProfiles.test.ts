import { describe, expect, it } from 'vitest';
import {
  ROUTING_PROFILE_DESCRIPTIONS,
  ROUTING_PROFILE_PRESETS,
  applyRoutingProfilePreset,
  resolveRoutingProfilePreset,
} from './routingProfiles.js';

describe('routingProfiles', () => {
  it('applies every preset by id', () => {
    for (const presetId of Object.keys(ROUTING_PROFILE_PRESETS) as Array<keyof typeof ROUTING_PROFILE_PRESETS>) {
      const applied = applyRoutingProfilePreset(presetId);
      expect(applied).toEqual(ROUTING_PROFILE_PRESETS[presetId]);
    }
  });

  it('resolves known profiles by exact weights', () => {
    expect(resolveRoutingProfilePreset(ROUTING_PROFILE_PRESETS.balanced)).toBe('balanced');
    expect(resolveRoutingProfilePreset(ROUTING_PROFILE_PRESETS.cost)).toBe('cost');
    expect(resolveRoutingProfilePreset(ROUTING_PROFILE_PRESETS.quality)).toBe('quality');
    expect(resolveRoutingProfilePreset(ROUTING_PROFILE_PRESETS.speed)).toBe('speed');
    expect(resolveRoutingProfilePreset(ROUTING_PROFILE_PRESETS.durable)).toBe('durable');
  });

  it('keeps every preset component weight sum normalized to 1', () => {
    for (const preset of Object.values(ROUTING_PROFILE_PRESETS)) {
      const componentSum = preset.costWeight
        + preset.balanceWeight
        + preset.usageWeight
        + preset.firstByteWeight
        + preset.speedWeight
        + preset.successWeight;
      expect(Math.abs(componentSum - 1)).toBeLessThanOrEqual(1e-6);
    }
  });

  it('returns custom when weights do not match presets', () => {
    const preset = resolveRoutingProfilePreset({
      baseWeightFactor: 0.61,
      valueScoreFactor: 0.39,
      costWeight: 0.22,
      balanceWeight: 0.41,
      usageWeight: 0.37,
      firstByteWeight: 0,
      speedWeight: 0,
      successWeight: 0,
    });
    expect(preset).toBe('custom');
  });

  it('reports a description for every preset id including custom', () => {
    const descriptions = ROUTING_PROFILE_DESCRIPTIONS;
    expect(descriptions.balanced).toBeTruthy();
    expect(descriptions.cost).toBeTruthy();
    expect(descriptions.quality).toBeTruthy();
    expect(descriptions.speed).toBeTruthy();
    expect(descriptions.durable).toBeTruthy();
    expect(descriptions.custom).toBeTruthy();
  });
});
