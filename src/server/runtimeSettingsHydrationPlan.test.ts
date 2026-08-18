import { describe, expect, it } from 'vitest';

import { parseDownstreamErrorPolicyConfig } from './services/downstreamErrorPolicy.js';
import {
  commitRuntimeSettingsHydration,
  planRuntimeSettingsHydration,
} from './runtimeSettingsHydrationPlan.js';

describe('planRuntimeSettingsHydration', () => {
  it('plans stale downstream policy cleanup without mutating the input map', () => {
    const originalPolicy = {
      mode: 'cpa-hermes-resilient',
      downstreamApiKeyIds: [17, 18],
    };
    const settingsMap = new Map([
      ['downstream_error_policy', JSON.stringify(originalPolicy)],
    ]);

    const result = planRuntimeSettingsHydration(
      settingsMap,
      new Set([18]),
      parseDownstreamErrorPolicyConfig,
    );

    expect(JSON.parse(settingsMap.get('downstream_error_policy') || '{}')).toEqual(originalPolicy);
    expect(JSON.parse(result.settingsMap.get('downstream_error_policy') || '{}')).toEqual({
      mode: 'cpa-hermes-resilient',
      downstreamApiKeyIds: [18],
    });
    expect(result.normalizedSettings).toEqual([{
      key: 'downstream_error_policy',
      value: { mode: 'cpa-hermes-resilient', downstreamApiKeyIds: [18] },
    }]);
  });

  it('plans disabling a resilient policy whose key references are all stale', () => {
    const result = planRuntimeSettingsHydration(
      new Map([['downstream_error_policy', JSON.stringify({
        mode: 'cpa-hermes-resilient',
        downstreamApiKeyIds: [17],
      })]]),
      new Set(),
      parseDownstreamErrorPolicyConfig,
    );

    expect(JSON.parse(result.settingsMap.get('downstream_error_policy') || '{}')).toEqual({
      mode: 'off',
      downstreamApiKeyIds: [],
    });
  });

  it('does not publish planned runtime settings when normalization persistence fails', async () => {
    let published = false;

    await expect(commitRuntimeSettingsHydration({
      settingsMap: new Map([['downstream_error_policy', JSON.stringify({
        mode: 'cpa-hermes-resilient',
        downstreamApiKeyIds: [17],
      })]]),
      existingDownstreamApiKeyIds: new Set(),
      parseDownstreamErrorPolicyConfig,
      persist: async () => {
        throw new Error('database unavailable');
      },
      publish: () => {
        published = true;
      },
    })).rejects.toThrow('database unavailable');

    expect(published).toBe(false);
  });
});
