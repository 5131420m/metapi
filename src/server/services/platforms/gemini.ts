import { StandardApiProviderAdapterBase, normalizePlatformBaseUrl } from './standardApiProvider.js';
import type { GetModelsOptions } from './base.js';
import {
  confirmedEmptyModelList,
  isConfirmedEmptyModelList,
  looksLikeErrorEnvelope,
  unreadableModelListError,
} from './modelListEvidence.js';

function stripModelPrefix(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  return trimmed.replace(/^models\//i, '');
}

function normalizeModelList(models: string[]): string[] {
  const deduped = new Set<string>();
  for (const model of models) {
    const normalized = stripModelPrefix(model);
    if (normalized) deduped.add(normalized);
  }
  return Array.from(deduped);
}

function isOpenAiCompatGeminiBase(baseUrl: string): boolean {
  return /\/openai(?:\/|$)/i.test(baseUrl);
}

function resolveGeminiOpenAiModelsUrl(baseUrl: string): string {
  const normalized = normalizePlatformBaseUrl(baseUrl);
  if (/\/models$/i.test(normalized)) return normalized;
  return `${normalized}/models`;
}

function resolveGeminiNativeModelsUrl(baseUrl: string, apiToken: string): string {
  const normalized = normalizePlatformBaseUrl(baseUrl);
  const withVersion = /\/v\d+(?:beta)?(?:\/|$)/i.test(normalized)
    ? normalized
    : `${normalized}/v1beta`;
  const listBase = /\/models$/i.test(withVersion)
    ? withVersion
    : `${withVersion}/models`;
  const separator = listBase.includes('?') ? '&' : '?';
  return `${listBase}${separator}key=${encodeURIComponent(apiToken)}`;
}

export class GeminiAdapter extends StandardApiProviderAdapterBase {
  readonly platformName: string = 'gemini';

  async detect(url: string): Promise<boolean> {
    const normalized = (url || '').toLowerCase();
    return (
      normalized.includes('generativelanguage.googleapis.com')
      || normalized.includes('googleapis.com/v1beta/openai')
      || normalized.includes('gemini.google.com')
    );
  }

  async getModels(
    baseUrl: string,
    apiToken: string,
    _platformUserId?: number,
    options?: GetModelsOptions,
  ): Promise<string[]> {
    const contextSourceScope = options?.contextSourceScope;
    const normalizedBase = normalizePlatformBaseUrl(baseUrl);
    // Several endpoint flavours are tried in turn. One of them answering with a
    // well-formed empty list is the upstream's own answer, so it is kept as
    // evidence; if none of them answered at all, the failure is rethrown rather
    // than reported as "no models". See modelListEvidence.ts.
    let sawConfirmedEmpty = false;
    let firstFailure: unknown = null;

    if (isOpenAiCompatGeminiBase(normalizedBase)) {
      try {
        const openAiModels = await this.fetchModelsFromStandardEndpoint({
          baseUrl: normalizedBase,
          headers: { Authorization: `Bearer ${apiToken}` },
          resolveUrl: resolveGeminiOpenAiModelsUrl,
          contextSourceScope,
        });
        if (openAiModels.length > 0) return normalizeModelList(openAiModels);
        sawConfirmedEmpty ||= isConfirmedEmptyModelList(openAiModels);
      } catch (error) {
        firstFailure ??= error;
      }
    }

    try {
      const res = await this.fetchJson<any>(resolveGeminiNativeModelsUrl(normalizedBase, apiToken));
      if (looksLikeErrorEnvelope(res)) {
        firstFailure ??= unreadableModelListError('gemini native models endpoint', res);
      } else if (Array.isArray(res?.models)) {
        const nativeModels = res.models
          .map((m: any) => String(m?.name || '').trim())
          .filter(Boolean);
        if (nativeModels.length > 0) return normalizeModelList(nativeModels);
        sawConfirmedEmpty = true;
      } else {
        firstFailure ??= unreadableModelListError('gemini native models endpoint', res);
      }
    } catch (error) {
      firstFailure ??= error;
    }

    if (!isOpenAiCompatGeminiBase(normalizedBase)) {
      try {
        const openAiModels = await this.fetchModelsFromStandardEndpoint({
          baseUrl: `${normalizedBase}/v1beta/openai`,
          headers: { Authorization: `Bearer ${apiToken}` },
          contextSourceScope,
        });
        if (openAiModels.length > 0) return normalizeModelList(openAiModels);
        sawConfirmedEmpty ||= isConfirmedEmptyModelList(openAiModels);
      } catch (error) {
        firstFailure ??= error;
      }
    }

    if (!sawConfirmedEmpty && firstFailure) throw firstFailure;
    return confirmedEmptyModelList();
  }
}
