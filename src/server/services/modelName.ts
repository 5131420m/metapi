export function normalizeFullSourceModelName(
  modelNameRaw: string | null | undefined,
): string {
  return String(modelNameRaw || '').trim();
}

export function normalizeModelRouteName(
  modelNameRaw: string | null | undefined,
): string {
  const normalized = normalizeFullSourceModelName(modelNameRaw).toLowerCase();
  if (!normalized) return '';

  const slashIndex = normalized.lastIndexOf('/');
  if (slashIndex >= 0 && slashIndex < normalized.length - 1) {
    return normalized.slice(slashIndex + 1);
  }

  return normalized;
}

export function normalizeDiscoveredModelNames(models: string[]): string[] {
  const normalizedModels: string[] = [];
  const seen = new Set<string>();

  for (const rawModel of models) {
    if (typeof rawModel !== 'string') continue;
    const modelName = normalizeFullSourceModelName(rawModel);
    if (!modelName || seen.has(modelName)) continue;
    seen.add(modelName);
    normalizedModels.push(modelName);
  }

  return normalizedModels;
}

export function areModelRouteAliasesEquivalent(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const normalizedLeft = normalizeModelRouteName(left);
  const normalizedRight = normalizeModelRouteName(right);
  return !!normalizedLeft && normalizedLeft === normalizedRight;
}
