import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ConnectionManager } from './connections.js';
import { canonicalRoot, defaultRoot, inspectInstance } from './discovery.js';
import { catalogFromControl } from './gateway.js';
import { editJson, errorMessage, object, UserError } from './json.js';
import { digest, pluginEnabled, stateDirectory } from './runtime.js';
import { readOptional, replaceFile, StateStore } from './store.js';
import type { BridgeStatus, Catalog, Launch } from './types.js';

export class Bridge {
  readonly directory: string;
  readonly control: string;
  readonly statusPath: string;
  private readonly store: StateStore;
  private readonly manager: ConnectionManager;
  private catalog?: Catalog;

  constructor(readonly launch: Launch) {
    this.directory = stateDirectory(launch.home);
    this.control = path.join(this.directory, 'control.json');
    this.statusPath = path.join(this.directory, 'status.json');
    this.store = new StateStore(this.directory);
    this.manager = new ConnectionManager(this.store, async () => {
      if (!this.catalog) throw new UserError('尚未收到 Magpie 模型目录');
      return this.catalog;
    });
  }

  async status(): Promise<BridgeStatus> {
    const text = await readOptional(this.statusPath);
    if (!text) return { state: 'idle', updatedAt: '' };
    return JSON.parse(text) as BridgeStatus;
  }

  private async publish(status: Omit<BridgeStatus, 'updatedAt'>): Promise<void> {
    const previous = await this.status();
    if (digest({ ...previous, updatedAt: '' }) === digest({ ...status, updatedAt: '' })) return;

    const updated = { ...status, updatedAt: new Date().toISOString() };
    await replaceFile(this.statusPath, JSON.stringify(updated, null, 2));
  }

  private async instance() {
    const root = await canonicalRoot(this.launch.options.userDataDir ?? defaultRoot({
      platform: process.platform, home: this.launch.home, env: process.env,
    }));
    const instance = await inspectInstance(root);
    if (instance.error) throw new UserError(instance.error);
    return instance;
  }

  /** 发现正式版后才创建标记，让原生 Agent 列表显示 PinK */
  async initialize(): Promise<void> {
    await this.manager.initialize();
    const instance = await this.instance();
    await mkdir(path.join(this.directory, 'detected'), { recursive: true, mode: 0o700 });

    // 不覆盖 Magpie 正在管理的控制文件
    if (await readOptional(this.control) === null) {
      await replaceFile(this.control, '{}\n');
    }
    return this.publish({ ...(await this.status()), root: instance.root });
  }

  async restore(): Promise<string[]> {
    const conflicts: string[] = [];
    for (const connection of await this.manager.list()) {
      conflicts.push(...await this.manager.disconnect(connection.id));
    }
    await this.publish({
      state: conflicts.length ? 'error' : 'disconnected',
      ...(conflicts.length ? { error: conflicts.join('\n') } : {}),
    });
    return conflicts;
  }

  /** 将原生 Agent 选择同步到 PinK 配置
   *
   * 应用失败时回退到最近成功的模型，并返回该模型是否存在；断开分支返回 false。
   */
  async reconcile(): Promise<boolean> {
    const enabled = await pluginEnabled(this.launch);
    if (!enabled) {
      await this.restore();
      return false;
    }

    const before = await readOptional(this.control);
    const current: unknown = JSON.parse(before ?? '{}');
    if (!object(current)) throw new UserError('Agent 控制文件格式无效');
    const selected = typeof current.model === 'string' ? current.model : '';
    const wantsConnection = selected.startsWith('magpie/')
      && typeof current.key === 'string' && !!current.key;
    const status = await this.status();
    const controlDigest = digest(before);

    if (!wantsConnection) {
      if (status.failedControl === controlDigest) return false;
      await this.restore();
      return false;
    }
    if (status.failedControl === controlDigest) return !!status.appliedModel;

    try {
      this.catalog = catalogFromControl(current);
      const model = selected.slice('magpie/'.length);
      if (!this.catalog.models.some(item => item.id === model)) throw new UserError('所选模型不在目录中');
      const instance = await this.instance();
      const profileIds = this.launch.options.profileIds ?? instance.profiles.map(profile => profile.id);
      const desired = digest([model, this.catalog, instance.root, profileIds]);
      if (status.state === 'connected' && status.appliedDigest === desired) return true;

      // 范围变化先由用户断开，避免新目录失败后旧连接已经被拆除
      for (const previous of await this.manager.list()) {
        if (previous.id !== instance.id
          || digest([...previous.profileIds].sort()) !== digest([...profileIds].sort())) {
          throw new UserError('请先断开 PinK，再调整数据目录或 Profile 范围');
        }
      }

      await this.manager.addRoot(instance.root);
      await this.manager.connect({
        instanceId: instance.id, profileIds,
        defaultModelId: status.appliedModel === selected ? undefined : model,
      });
      await this.publish({
        state: 'connected', root: instance.root, appliedModel: selected, appliedDigest: desired,
      });
      return true;
    } catch (error) {
      // 失败时原生列表退回上次成功的模型，不把新选择长期显示为已应用
      if (before !== null && await readOptional(this.control) === before) {
        await replaceFile(this.control, editJson(before, ['model'], status.appliedModel));
      }
      await this.publish({
        ...status, state: 'error', error: errorMessage(error),
        failedControl: digest(await readOptional(this.control)),
      });
      return !!status.appliedModel;
    }
  }

  async report(error: unknown): Promise<void> {
    await this.publish({ ...(await this.status()), state: 'error', error: errorMessage(error) });
  }
}
