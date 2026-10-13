import { StandardApiProviderAdapterBase } from './standardApiProvider.js';
import type { GetModelsOptions } from './base.js';
import { CLAUDE_DEFAULT_ANTHROPIC_VERSION } from '../oauth/claudeProvider.js';

function resolveOpenAiCompatibleBaseUrl(baseUrl: string): string | null {
  const normalized = (baseUrl || '').trim().replace(/\/+$/, '');
  const match = normalized.match(/^(.*)\/anthropic$/i);
  return match?.[1] || null;
}

export class ClaudeAdapter extends StandardApiProviderAdapterBase {
  readonly platformName = 'claude';

  async detect(url: string): Promise<boolean> {
    const normalized = (url || '').toLowerCase();
    return normalized.includes('api.anthropic.com') || normalized.includes('anthropic.com/v1');
  }

  async getModels(baseUrl: string, apiToken: string, _platformUserId?: number, options?: GetModelsOptions): Promise<string[]> {
    const contextSourceScope = options?.contextSourceScope;
    const openAiCompatibleBaseUrl = resolveOpenAiCompatibleBaseUrl(baseUrl);
    // An empty list from the /anthropic endpoint is the upstream's own answer
    // and is returned as such, rather than being replaced with a bare [] that
    // model refresh could not tell apart from a failed pull.
    let claudeEmptyList: string[] | null = null;
    try {
      const claudeModels = await this.fetchModelsFromStandardEndpoint({
        baseUrl,
        headers: {
          'x-api-key': apiToken,
          'anthropic-version': CLAUDE_DEFAULT_ANTHROPIC_VERSION,
        },
        contextSourceScope,
      });
      if (claudeModels.length > 0) return claudeModels;
      claudeEmptyList = claudeModels;
    } catch (error) {
      if (!openAiCompatibleBaseUrl) throw error;
    }

    if (!openAiCompatibleBaseUrl) return claudeEmptyList ?? [];

    try {
      return await this.fetchModelsFromStandardEndpoint({
        contextSourceScope,
        baseUrl: openAiCompatibleBaseUrl,
        headers: { Authorization: `Bearer ${apiToken}` },
      });
    } catch (error) {
      // The /anthropic endpoint already answered "no models"; a failing
      // OpenAI-compatible fallback does not turn that into a failed pull.
      if (claudeEmptyList) return claudeEmptyList;
      throw error;
    }
  }
}
