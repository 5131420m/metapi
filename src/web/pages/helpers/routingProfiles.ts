export type RoutingWeights = {
  baseWeightFactor: number;
  valueScoreFactor: number;
  costWeight: number;
  balanceWeight: number;
  usageWeight: number;
  firstByteWeight: number;
  speedWeight: number;
  successWeight: number;
};

export type RoutingProfilePresetId = 'balanced' | 'cost' | 'quality' | 'speed' | 'durable' | 'custom';

/**
 * Presets are points in the 8-dimensional weight space. Component weights
 * (cost/balance/usage/firstByte/speed/success) are normalized to sum to 1 so a
 * preset reads as "how the value score is composed"; the base/valueScore pair
 * controls how much of the contribution comes from the static channel weight
 * versus that dynamic value score.
 *
 * The former `stable` preset was renamed to `quality`: it used to raise the
 * static-weight floor and balance weight while the formula had no success-rate
 * input at all, so the name promised something it never delivered. The
 * route-level `stable_first` routing strategy keeps its name — it is the one
 * that actually guarantees stability.
 */
export const ROUTING_PROFILE_PRESETS: Record<Exclude<RoutingProfilePresetId, 'custom'>, RoutingWeights> = {
  balanced: {
    baseWeightFactor: 0.4,
    valueScoreFactor: 0.6,
    costWeight: 0.3,
    balanceWeight: 0.15,
    usageWeight: 0.1,
    firstByteWeight: 0.2,
    speedWeight: 0.1,
    successWeight: 0.15,
  },
  cost: {
    baseWeightFactor: 0.35,
    valueScoreFactor: 0.65,
    costWeight: 0.75,
    balanceWeight: 0.1,
    usageWeight: 0.1,
    firstByteWeight: 0.05,
    speedWeight: 0,
    successWeight: 0,
  },
  quality: {
    baseWeightFactor: 0.3,
    valueScoreFactor: 0.7,
    costWeight: 0.1,
    balanceWeight: 0.05,
    usageWeight: 0,
    firstByteWeight: 0.3,
    speedWeight: 0.1,
    successWeight: 0.45,
  },
  speed: {
    baseWeightFactor: 0.25,
    valueScoreFactor: 0.75,
    costWeight: 0.05,
    balanceWeight: 0.05,
    usageWeight: 0,
    firstByteWeight: 0.35,
    speedWeight: 0.45,
    successWeight: 0.1,
  },
  durable: {
    baseWeightFactor: 0.5,
    valueScoreFactor: 0.5,
    costWeight: 0.15,
    balanceWeight: 0.4,
    usageWeight: 0.3,
    firstByteWeight: 0.05,
    speedWeight: 0,
    successWeight: 0.1,
  },
};

export const ROUTING_PROFILE_DESCRIPTIONS: Record<RoutingProfilePresetId, string> = {
  balanced: '均衡：成本仍是最大单项，首字/速度/成功率合计占价值分 45%，默认通用。',
  cost: '成本优先：单价主导（75%），软性劣化交给安全底线兜底，省钱场景。',
  quality: '质量优先：成功率与首字响应主导（75%），接受为少出错多花钱。',
  speed: '速度优先：首字与生成吞吐为王（80%），交互式聊天体感首选。',
  durable: '耐用优先：高余额与低频次优先（70%），均摊消耗、保活账号。',
  custom: '自定义：手动调配各分量权重。',
};

const EPSILON = 1e-6;

export function applyRoutingProfilePreset(presetId: Exclude<RoutingProfilePresetId, 'custom'>): RoutingWeights {
  return {
    ...ROUTING_PROFILE_PRESETS[presetId],
  };
}

function weightsAlmostEqual(a: RoutingWeights, b: RoutingWeights): boolean {
  return (
    Math.abs(a.baseWeightFactor - b.baseWeightFactor) <= EPSILON
    && Math.abs(a.valueScoreFactor - b.valueScoreFactor) <= EPSILON
    && Math.abs(a.costWeight - b.costWeight) <= EPSILON
    && Math.abs(a.balanceWeight - b.balanceWeight) <= EPSILON
    && Math.abs(a.usageWeight - b.usageWeight) <= EPSILON
    && Math.abs(a.firstByteWeight - b.firstByteWeight) <= EPSILON
    && Math.abs(a.speedWeight - b.speedWeight) <= EPSILON
    && Math.abs(a.successWeight - b.successWeight) <= EPSILON
  );
}

export function resolveRoutingProfilePreset(weights: RoutingWeights): RoutingProfilePresetId {
  if (weightsAlmostEqual(weights, ROUTING_PROFILE_PRESETS.balanced)) return 'balanced';
  if (weightsAlmostEqual(weights, ROUTING_PROFILE_PRESETS.cost)) return 'cost';
  if (weightsAlmostEqual(weights, ROUTING_PROFILE_PRESETS.quality)) return 'quality';
  if (weightsAlmostEqual(weights, ROUTING_PROFILE_PRESETS.speed)) return 'speed';
  if (weightsAlmostEqual(weights, ROUTING_PROFILE_PRESETS.durable)) return 'durable';
  return 'custom';
}
