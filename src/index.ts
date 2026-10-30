import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bridge } from './bridge.js';
import {
  launchConfig, pluginEnabled, readWorkerLease, spawnWorker, stateDirectory, workerAlive,
} from './runtime.js';
import { replaceFile } from './store.js';
import type { PluginOptions } from './types.js';

let started: Promise<void> | undefined;

async function start(options: PluginOptions = {}) {
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const launch = await launchConfig(packageRoot, options);
  const directory = stateDirectory(launch.home);
  const leasePath = path.join(directory, 'worker.json');
  const launchPath = path.join(directory, 'launch.json');
  const existing = await readWorkerLease(leasePath);
  if (workerAlive(existing) && existing.configDir !== launch.configDir) {
    throw new Error('另一个 Magpie 配置正在管理 PinK，请先从原配置断开');
  }

  const bridge = new Bridge(launch);
  await bridge.initialize().catch(error => bridge.report(error));
  await replaceFile(launchPath, JSON.stringify(launch));

  let checking = false;
  async function ensureWorker() {
    if (checking) return;
    checking = true;
    try {
      if (!await pluginEnabled(launch)) return;
      const lease = await readWorkerLease(leasePath);
      if (workerAlive(lease)) return;
      // 临时 CLI 可能留下已退出的 parentPid，由存活宿主接管启动信息
      await replaceFile(launchPath, JSON.stringify(launch));
      spawnWorker(launch, launchPath, error => {
        void bridge.report(error);
      });
    } finally {
      checking = false;
    }
  }

  await ensureWorker();
  const timer = setInterval(() => {
    void ensureWorker().catch(error => bridge.report(error));
  }, 1000);
  timer.unref();
}

export default {
  id: 'pink',
  server: async (_input: unknown, options?: PluginOptions) => {
    started ??= start(options).catch(error => {
      started = undefined;
      throw error;
    });
    await started;
    return {};
  },
};
