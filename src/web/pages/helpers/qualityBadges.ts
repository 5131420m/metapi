/**
 * Color tiers for the per-channel quality badges (first-byte / throughput / success
 * rate). One definition shared by the routes page and the proxy-log page so a latency
 * means the same colour everywhere.
 *
 * The first-byte cut-offs (<1s good, 1-3s warning, >=3s bad) were first introduced on
 * the proxy-log badges and are kept verbatim. The throughput tier boundary of 30 tps
 * matches the router's speed target (`SITE_RUNTIME_SPEED_TARGET_TPS`): at or above it
 * a channel is considered "full speed", so extra throughput stops buying a better tone.
 */

export type QualityTone = 'primary' | 'warning' | 'danger';

export function firstByteTone(ms: number): QualityTone {
  if (ms >= 3000) return 'danger';
  if (ms >= 1000) return 'warning';
  return 'primary';
}

export function tokensPerSecondTone(tps: number): QualityTone {
  if (tps < 10) return 'danger';
  if (tps < 30) return 'warning';
  return 'primary';
}

export function successRateTone(rate: number): QualityTone {
  if (rate < 0.85) return 'danger';
  if (rate < 0.95) return 'warning';
  return 'primary';
}

export function qualityToneColor(tone: QualityTone): string {
  if (tone === 'danger') return 'var(--color-danger)';
  if (tone === 'warning') return 'var(--color-warning)';
  return 'var(--color-primary)';
}

export function qualityToneBgColor(tone: QualityTone): string {
  return `color-mix(in srgb, ${qualityToneColor(tone)} 12%, transparent)`;
}
