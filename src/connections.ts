import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { canonicalRoot, discover, inspectInstance } from './discovery.js';
import { GROUP_NAME, modelGroup } from './gateway.js';
import { editJson, equal, object, parseConfig, UserError, errorMessage } from './json.js';
import { readOptional, StateStore, type Change } from './store.js';
import type { Catalog, Connection, JsonObject, PluginState } from './types.js';

interface FileEditContext {
  state: PluginState;
  connection: Connection;
  paths: string[];
}

async function filePath(file: string): Promise<string> {
  return realpath(file).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return path.join(await realpath(path.dirname(file)), path.basename(file));
  });
}

function groups(content: string | null, file: string): JsonObject[] {
  const value = parseConfig(content ?? '[]', file);
  if (!Array.isArray(value) || !value.every(object)) {
    throw new UserError(`${file} 必须是模型组数组`, 409);
  }
  return value;
}

function groupIndex(list: JsonObject[]): number {
  const matches = list.flatMap((group, index) => group.name === GROUP_NAME ? [index] : []);
  if (matches.length > 1) throw new UserError('存在多个同名 Magpie (PinK) 模型组，请先整理', 409);
  return matches[0] ?? -1;
}

function settings(content: string | null, file: string): JsonObject {
  const value = parseConfig(content ?? '{}', file);
  if (!object(value)) throw new UserError(`${file} 必须是设置对象`, 409);
  return value;
}

function ownsFields(current: JsonObject, previous: JsonObject): boolean {
  return Object.keys(previous).every(key => equal(current[key], previous[key]));
}

export class ConnectionManager {
  constructor(
    readonly store: StateStore,
    private readonly catalog: () => Promise<Catalog>,
    private readonly configuredRoots: string[] = [],
  ) { }

  async initialize(): Promise<void> {
    await this.store.exclusive(async () => { await this.store.read(); });
  }

  async instances() {
    const state = await this.store.read();
    return discover([...this.configuredRoots, ...state.roots, ...state.connections.map(c => c.root)]);
  }

  async addRoot(input: string): Promise<void> {
    const root = await canonicalRoot(input);
    await this.store.exclusive(async () => {
      const state = await this.store.read();
      if (!state.roots.includes(root)) state.roots.push(root);
      await this.store.commit([], state);
    });
  }

  async list(): Promise<Connection[]> {
    const state = await this.store.read();
    return Promise.all(state.connections.map(async connection => {
      try {
        for (const managed of connection.models) {
          const content = await readOptional(managed.path);
          const list = groups(content, managed.path);
          const current = list[groupIndex(list)];
          if (!current || !ownsFields(current, managed.group)) {
            return { ...connection, error: '模型组已被手动修改或移除，自动同步已暂停' };
          }
        }
        return connection;
      } catch (error) {
        return { ...connection, error: errorMessage(error) };
      }
    }));
  }

  /** 为选中 Profile 建立连接
   *
   * 未选择的独立配置不会写入；同一连接内已经管理的 Profile 继续保留。
   */
  async connect(input: {
    instanceId: string;
    profileIds: string[];
    defaultModelId?: string;
  }): Promise<void> {
    const instance = (await this.instances()).find(item => item.id === input.instanceId);
    if (!instance || instance.error) throw new UserError(instance?.error || '找不到所选 PinK 实例');
    if (!input.profileIds.length) throw new UserError('请至少选择一个 Profile');
    if (input.profileIds.some(id => !instance.profiles.some(profile => profile.id === id))) {
      throw new UserError('Profile 已变化，请刷新后重试');
    }

    const catalog = await this.catalog();
    await this.store.exclusive(async () => {
      const state = await this.store.read();
      let connection = state.connections.find(item => item.id === instance.id);
      if (!connection) {
        connection = {
          id: instance.id, root: instance.root, profileIds: [], models: [], defaults: [], syncedAt: '',
        };
        state.connections.push(connection);
      }
      connection.profileIds = [...new Set([...connection.profileIds, ...input.profileIds])];
      const changes = await this.prepare({
        state, connection, catalog, defaultModelId: input.defaultModelId,
      });
      await this.store.commit(changes, state);
    });
  }

  async sync(id: string, defaultModelId?: string): Promise<void> {
    const catalog = await this.catalog();
    await this.store.exclusive(async () => {
      const state = await this.store.read();
      const connection = state.connections.find(item => item.id === id);
      if (!connection) throw new UserError('连接不存在', 404);
      const changes = await this.prepare({ state, connection, catalog, defaultModelId });
      await this.store.commit(changes, state);
    });
  }

  private async prepare(input: {
    state: PluginState;
    connection: Connection;
    catalog: Catalog;
    defaultModelId?: string;
  }): Promise<Change[]> {
    const { state, connection, catalog, defaultModelId } = input;
    if (defaultModelId !== undefined && !catalog.models.some(model => model.id === defaultModelId)) {
      throw new UserError('所选默认模型已不在 Magpie 目录中');
    }

    const instance = await inspectInstance(connection.root);
    if (instance.error) throw new UserError(instance.error, 409);
    const profiles = instance.profiles.filter(profile => connection.profileIds.includes(profile.id));
    if (profiles.length !== connection.profileIds.length) {
      throw new UserError('已连接的 Profile 被移除，请先断开后重新选择', 409);
    }
    const modelPaths = [...new Set(await Promise.all(
      profiles.map(profile => filePath(profile.modelsPath)),
    ))];
    const changes = await this.prepareModels({
      state, connection, paths: modelPaths, group: modelGroup(catalog),
    });

    if (defaultModelId !== undefined) {
      const settingPaths = [...new Set(await Promise.all(
        profiles.map(profile => filePath(profile.settingsPath)),
      ))];
      changes.push(...await this.prepareDefaults({
        state, connection, paths: settingPaths, modelId: defaultModelId,
      }));
    }

    connection.syncedAt = new Date().toISOString();
    delete connection.error;
    return changes;
  }

  /** 准备模型组改动，连同恢复信息交给外层事务统一提交 */
  private async prepareModels(input: FileEditContext & { group: JsonObject }): Promise<Change[]> {
    const { state, connection, paths, group: desired } = input;
    const changes: Change[] = [];

    for (const file of paths) {
      if (state.connections.some(other => other.id !== connection.id
        && other.models.some(item => item.path === file))) {
        throw new UserError('该模型配置已由另一个实例连接管理', 409);
      }
      const before = await readOptional(file);
      const list = groups(before, file);
      const index = groupIndex(list);
      const current = list[index];
      const managed = connection.models.find(item => item.path === file);
      if (!managed && current) throw new UserError('已有非本插件管理的同名模型组，请先重命名', 409);
      if (managed && (!current || !ownsFields(current, managed.group))) {
        throw new UserError('模型组已被手动修改或移除，已停止同步，请先核对配置', 409);
      }

      let after = before ?? '[]\n';
      if (managed) {
        managed.restoreWhole &&= before === managed.lastContent;
        for (const [key, value] of Object.entries(desired)) {
          if (!equal(current?.[key], value)) after = editJson(after, [index, key], value);
        }
        managed.group = desired;
        managed.lastContent = after;
      } else {
        const preferences = state.preferences?.[file];
        const group = preferences ? { ...desired, settings: preferences } : desired;
        after = editJson(after, [-1], group);
        connection.models.push({
          path: file, original: before, lastContent: after, group: desired, restoreWhole: true,
        });
      }
      changes.push({ path: file, before, after });
    }
    return changes;
  }

  /** 准备默认模型改动，并记录首次接管前的值 */
  private async prepareDefaults(input: FileEditContext & { modelId: string }): Promise<Change[]> {
    const { state, connection, paths, modelId } = input;
    const changes: Change[] = [];

    for (const file of paths) {
      if (state.connections.some(other => other.id !== connection.id
        && other.defaults.some(item => item.path === file))) {
        throw new UserError('该默认模型设置已由另一个实例管理', 409);
      }
      const before = await readOptional(file);
      const value = settings(before, file);
      let managed = connection.defaults.find(item => item.path === file);
      if (managed && value['chat.defaultModel'] !== managed.written) {
        throw new UserError('默认模型已被手动修改，已保留用户设置', 409);
      }

      const after = editJson(before ?? '{}\n', ['chat.defaultModel'], modelId);
      if (!managed) {
        managed = {
          path: file, original: before,
          hadValue: Object.hasOwn(value, 'chat.defaultModel'),
          previous: value['chat.defaultModel'],
          written: modelId, lastContent: after, restoreWhole: true,
        };
        connection.defaults.push(managed);
      } else {
        managed.restoreWhole &&= before === managed.lastContent;
        managed.written = modelId;
        managed.lastContent = after;
      }
      changes.push({ path: file, before, after });
    }
    return changes;
  }

  /** 撤销仍由插件持有的配置，保留手动编辑并返回具体冲突 */
  async disconnect(id: string): Promise<string[]> {
    return this.store.exclusive(async () => {
      const state = await this.store.read();
      const connection = state.connections.find(item => item.id === id);
      if (!connection) throw new UserError('连接不存在', 404);
      const changes: Change[] = [];
      const conflicts: string[] = [];
      const keptModels: Connection['models'] = [];

      for (const managed of connection.models) {
        const before = await readOptional(managed.path);
        const list = groups(before, managed.path);
        const index = groupIndex(list);
        if (index < 0) continue;

        const current = { ...list[index] };
        const preferences = current.settings;
        delete current.settings;
        if (!equal(current, managed.group)) {
          conflicts.push(`${managed.path}：模型组包含用户更改，已保留；请手动移除后再次断开`);
          keptModels.push(managed);
          continue;
        }
        // PinK 写入的推理档位属于该模型组的偏好，断开后保留到下次连接
        if (preferences !== undefined) {
          state.preferences ??= {};
          state.preferences[managed.path] = preferences;
        }
        const after = managed.restoreWhole && before === managed.lastContent
          ? managed.original
          : editJson(before!, [index], undefined);
        changes.push({ path: managed.path, before, after });
      }

      for (const managed of connection.defaults) {
        const before = await readOptional(managed.path);
        const value = settings(before, managed.path);
        if (value['chat.defaultModel'] !== managed.written) {
          // 外部修改已经替代插件的值，之后不再接管这个字段
          conflicts.push(`${managed.path}：默认模型已被用户更改，保留当前值`);
          continue;
        }
        const after = managed.restoreWhole && before === managed.lastContent
          ? managed.original
          : editJson(before!, ['chat.defaultModel'], managed.hadValue ? managed.previous : undefined);
        changes.push({ path: managed.path, before, after });
      }

      connection.models = keptModels;
      connection.defaults = [];
      if (keptModels.length) {
        connection.error = conflicts.join('\n');
      } else {
        state.connections = state.connections.filter(item => item.id !== id);
      }
      await this.store.commit(changes, state);
      return conflicts;
    });
  }
}
