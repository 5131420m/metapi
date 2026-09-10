import { StandardApiProviderAdapterBase } from './standardApiProvider.js';
import type { GetModelsOptions } from './base.js';

export class OpenAiAdapter extends StandardApiProviderAdapterBase {
  readonly platformName = 'openai';

  async detect(url: string): Promise<boolean> {
    const normalized = (url || '').toLowerCase();
    return normalized.includes('api.openai.com');
  }

  async getModels(baseUrl: string, apiToken: string, _platformUserId?: number, options?: GetModelsOptions): Promise<string[]> {
    const contextSourceScope = options?.contextSourceScope;
    return this.fetchModelsFromStandardEndpoint({
      baseUrl,
      headers: { Authorization: `Bearer ${apiToken}` },
      contextSourceScope,
    });
  }
}
