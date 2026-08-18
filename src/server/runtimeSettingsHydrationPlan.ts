import type { DownstreamErrorPolicyConfig } from './services/downstreamErrorPolicy.js';

export type RuntimeSettingsHydrationPlan = {
  settingsMap: Map<string, string>;
  normalizedSettings: Array<{ key: string; value: unknown }>;
};

function parseSettingFromMap<T>(settingsMap: Map<string, string>, key: string): T | undefined {
  const raw = settingsMap.get(key);
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function planRuntimeSettingsHydration(
  settingsMap: Map<string, string>,
  existingDownstreamApiKeyIds: Set<number>,
  parseDownstreamErrorPolicyConfig: (value: unknown) => DownstreamErrorPolicyConfig,
): RuntimeSettingsHydrationPlan {
  const plannedMap = new Map(settingsMap);
  const normalizedSettings: Array<{ key: string; value: unknown }> = [];
  const downstreamErrorPolicy = parseSettingFromMap<unknown>(plannedMap, 'downstream_error_policy');
  if (downstreamErrorPolicy === undefined) {
    return { settingsMap: plannedMap, normalizedSettings };
  }

  try {
    const parsed = parseDownstreamErrorPolicyConfig(downstreamErrorPolicy);
    if (parsed.mode !== 'cpa-hermes-resilient') {
      return { settingsMap: plannedMap, normalizedSettings };
    }
    const downstreamApiKeyIds = parsed.downstreamApiKeyIds.filter((id) => existingDownstreamApiKeyIds.has(id));
    if (downstreamApiKeyIds.length === parsed.downstreamApiKeyIds.length) {
      return { settingsMap: plannedMap, normalizedSettings };
    }
    const normalized: DownstreamErrorPolicyConfig = downstreamApiKeyIds.length > 0
      ? { mode: 'cpa-hermes-resilient', downstreamApiKeyIds }
      : { mode: 'off', downstreamApiKeyIds: [] };
    normalizedSettings.push({ key: 'downstream_error_policy', value: normalized });
    plannedMap.set('downstream_error_policy', JSON.stringify(normalized));
  } catch {
    // Invalid persisted values are left unchanged for the runtime parser to ignore safely.
  }

  return { settingsMap: plannedMap, normalizedSettings };
}

export async function commitRuntimeSettingsHydration(input: {
  settingsMap: Map<string, string>;
  existingDownstreamApiKeyIds: Set<number>;
  parseDownstreamErrorPolicyConfig: (value: unknown) => DownstreamErrorPolicyConfig;
  persist: (setting: { key: string; value: unknown }) => Promise<unknown>;
  publish: (settingsMap: Map<string, string>) => void;
}): Promise<RuntimeSettingsHydrationPlan> {
  const plan = planRuntimeSettingsHydration(
    input.settingsMap,
    input.existingDownstreamApiKeyIds,
    input.parseDownstreamErrorPolicyConfig,
  );
  for (const normalized of plan.normalizedSettings) {
    await input.persist(normalized);
  }
  input.publish(plan.settingsMap);
  return plan;
}
