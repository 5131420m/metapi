import { OneApiAdapter } from './oneApi.js';
import type { GetModelsOptions } from './base.js';
import {
  confirmedEmptyModelList,
  isConfirmedEmptyModelList,
  looksLikeErrorEnvelope,
  unreadableModelListError,
} from './modelListEvidence.js';

export class OneHubAdapter extends OneApiAdapter {
  readonly platformName: string = 'one-hub';

  async detect(url: string): Promise<boolean> {
    const normalized = url.toLowerCase();
    return normalized.includes('onehub') || normalized.includes('one-hub');
  }

  /**
   * OneHub model discovery: try /v1/models first, fall back to /api/available_model.
   * The /api/available_model endpoint returns { data: { model_name: { price: ... }, ... } }
   * where the keys are model names.
   */
  override async getModels(
    baseUrl: string,
    apiToken: string,
    platformUserId?: number,
    options?: GetModelsOptions,
  ): Promise<string[]> {
    const contextSourceScope = options?.contextSourceScope;
    // Either endpoint answering with a well-formed empty list is the upstream's
    // own answer and is kept as evidence; if neither answered, the failure is
    // rethrown instead of being reported as "no models". See
    // modelListEvidence.ts.
    let sawConfirmedEmpty = false;
    let firstFailure: unknown = null;

    try {
      const openAiModels = await super.getModels(baseUrl, apiToken, platformUserId, options);
      if (openAiModels.length > 0) return openAiModels;
      sawConfirmedEmpty ||= isConfirmedEmptyModelList(openAiModels);
    } catch (error) {
      firstFailure ??= error;
    }

    const availableModelUrl = `${baseUrl}/api/available_model`;
    try {
      const res = await this.fetchJson<any>(availableModelUrl, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      // An error envelope has no `data`, and using the envelope itself as the
      // model map would turn its own keys ("success", "message") into model
      // names.
      const payload = looksLikeErrorEnvelope(res)
        ? null
        : (res?.data && typeof res.data === 'object' ? res.data : res);
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const models = Object.keys(payload).filter(Boolean);
        if (models.length > 0) return models;
        sawConfirmedEmpty = true;
      } else {
        firstFailure ??= unreadableModelListError(availableModelUrl, res);
      }
    } catch (error) {
      firstFailure ??= error;
    }

    if (!sawConfirmedEmpty && firstFailure) throw firstFailure;
    return confirmedEmptyModelList();
  }

  /**
   * OneHub user groups: /api/user_group_map returns { data: { group_name: ratio, ... } }
   */
  override async getUserGroups(baseUrl: string, accessToken: string): Promise<string[]> {
    try {
      const res = await this.fetchJson<any>(`${baseUrl}/api/user_group_map`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const source = res?.data || res;
      if (source && typeof source === 'object' && !Array.isArray(source)) {
        const groups = Object.keys(source).map((k) => k.trim()).filter(Boolean);
        if (groups.length > 0) return Array.from(new Set(groups));
      }
    } catch {}

    return super.getUserGroups(baseUrl, accessToken);
  }
}
