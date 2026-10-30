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

/** 同步配置至宿主退出，停用或移除时先完成恢复 */
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
      let enabled: boolean | undefined;
      try {
        enabled = await pluginEnabled(launch);
        // 停用或移除先恢复配置；更新接力必须有活跃宿主
        if (enabled && next.generation !== launch.generation) {
          await unlink(leasePath);
          if (processAlive(next.parentPid)) {
            spawnWorker(next, launchPath, error => {
              void bridge.report(error);
            });
          }
          break;
        }
        await bridge.reconcile();
      } catch (error) {
        await bridge.report(error);
      }
      // 先处理宿主退出前留下的操作，再结束后台进程
      if (enabled === false || !processAlive(next.parentPid)) break;
      await delay(500);
    }
  } finally {
    const owner = await readWorkerLease(leasePath);
    if (owner?.nonce === nonce) await unlink(leasePath);
  }
}

run().catch(() => { process.exitCode = 1; });
