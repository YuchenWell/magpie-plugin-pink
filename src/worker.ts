import { randomUUID } from 'node:crypto';
import { open, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Bridge } from './bridge.js';
import {
  pluginEnabled, processAlive, readWorkerLease, spawnWorker, stateDirectory, workerAlive,
} from './runtime.js';
import { replaceFile } from './store.js';
import type { Launch } from './types.js';

/** 尝试取得同步器租约；已有活跃持有者时返回 false */
async function claimLease(leasePath: string, launch: Launch, nonce: string): Promise<boolean> {
  let handle;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      handle = await open(leasePath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({
        pid: process.pid, nonce, configDir: launch.configDir, heartbeat: Date.now(),
      }));
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = await readWorkerLease(leasePath);
      if (workerAlive(owner)) return false;
      if (!owner && Date.now() - (await stat(leasePath)).mtimeMs < 5000) return false;
      await unlink(leasePath).catch(() => undefined);
    }
  }
  return !!handle;
}

/** 运行独立同步进程
 *
 * 宿主退出后继续观察断开操作，避免 Magpie 强制结束宿主时漏掉配置恢复。
 */
async function run() {
  const launchPath = process.argv[2];
  if (!launchPath) throw new Error('缺少启动参数');
  const launch: Launch = JSON.parse(await readFile(launchPath, 'utf8'));
  const bridge = new Bridge(launch);
  const leasePath = path.join(stateDirectory(launch.home), 'worker.json');
  const nonce = randomUUID();
  if (!await claimLease(leasePath, launch, nonce)) return;

  let stopped = false;
  process.once('SIGTERM', () => { stopped = true; });
  process.once('SIGINT', () => { stopped = true; });

  try {
    while (!stopped) {
      const owner = JSON.parse(await readFile(leasePath, 'utf8'));
      if (owner.nonce !== nonce) break;
      if (Date.now() - owner.heartbeat > 5000) {
        await replaceFile(leasePath, JSON.stringify({ ...owner, heartbeat: Date.now() }));
      }

      const next: Launch = JSON.parse(await readFile(launchPath, 'utf8'));
      if (next.generation !== launch.generation) {
        // CLI 的临时宿主可能已经退出，更新时由旧同步器完成接力
        await unlink(leasePath);
        spawnWorker(next, launchPath, error => {
          void bridge.report(error);
        });
        break;
      }

      let enabled: boolean | undefined;
      try {
        enabled = await pluginEnabled(launch);
        await bridge.reconcile();
      } catch (error) {
        await bridge.report(error);
      }
      // 启用期间继续观察 CLI 的连接操作；无法读取配置且宿主已退出时停止
      if (enabled === false) break;
      if (enabled === undefined && !processAlive(next.parentPid)) break;
      await delay(500);
    }
  } finally {
    const owner = await readWorkerLease(leasePath);
    if (owner?.nonce === nonce) await unlink(leasePath);
  }
}

run().catch(() => { process.exitCode = 1; });
