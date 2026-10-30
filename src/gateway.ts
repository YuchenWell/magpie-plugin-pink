import { object, UserError } from './json.js';
import type { Catalog, CatalogModel, JsonObject } from './types.js';

export const GROUP_NAME = 'Magpie (PinK)';

function tokenLimit(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

/** 读取 Magpie Agent SDK 写入的模型目录 */
export function catalogFromControl(value: JsonObject): Catalog {
  if (typeof value.gateway !== 'string' || typeof value.key !== 'string' || !value.key) {
    throw new UserError('Magpie 连接参数不完整');
  }
  const endpoint = new URL(value.gateway);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new UserError('Magpie 网关地址无效');
  }
  const v1 = value.gateway.replace(/\/+$/, '');
  if (!v1.endsWith('/v1') || !Array.isArray(value.models)) {
    throw new UserError('Magpie 模型目录格式无效');
  }

  const models: CatalogModel[] = [];
  for (const model of value.models) {
    if (!object(model) || typeof model.id !== 'string' || !model.id) continue;
    const context = Math.max(2, tokenLimit(model.context, 128000));
    models.push({
      id: model.id,
      name: typeof model.name === 'string' ? model.name : model.id,
      context,
      output: Math.min(tokenLimit(model.output, 8192), Math.max(1, Math.floor(context / 4))),
      tools: true,
      vision: model.images === true,
      efforts: Array.isArray(model.efforts)
        ? model.efforts.filter((effort): effort is string => typeof effort === 'string') : [],
    });
  }
  if (!models.length) throw new UserError('Magpie 暂无可用模型');
  return { baseUrl: v1.slice(0, -3), key: value.key, models };
}

export function modelGroup(catalog: Catalog): JsonObject {
  return {
    name: GROUP_NAME, vendor: 'customendpoint', apiType: 'chat-completions',
    models: catalog.models.map(model => ({
      id: model.id, name: model.name,
      url: `${catalog.baseUrl}/v1/chat/completions`,
      toolCalling: model.tools, vision: model.vision,
      contextWindow: model.context, maxOutputTokens: model.output,
      requestHeaders: { Authorization: `Bearer ${catalog.key ?? 'magpie-pink'}` },
      ...(model.efforts.length ? {
        supportsReasoningEffort: model.efforts, reasoningEffortFormat: 'chat-completions',
      } : {}),
    })),
  };
}
