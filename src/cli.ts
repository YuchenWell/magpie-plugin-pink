import os from 'node:os';
import path from 'node:path';
import { Bridge } from './bridge.js';
import { errorMessage } from './json.js';
import { readWorkerLease, stateDirectory, workerAlive } from './runtime.js';
import { readOptional, replaceFile } from './store.js';
import type { Launch } from './types.js';

async function main() {
  const directory = stateDirectory(os.homedir());
  const launchText = await readOptional(path.join(directory, 'launch.json'));
  if (!launchText) throw new Error('插件尚未启动，请先在 Magpie 安装并启用');
  const launch: Launch = JSON.parse(launchText);
  const bridge = new Bridge(launch);

  if (process.argv[2] === 'status') {
    const lease = await readWorkerLease(path.join(directory, 'worker.json'));
    const status = { ...await bridge.status(), workerRunning: workerAlive(lease) };
    console.log(JSON.stringify(status, null, 2));
  } else if (process.argv[2] === 'restore') {
    // 控制文件只由插件使用，显式恢复也能清理损坏的控制记录
    await replaceFile(bridge.control, '{}\n');
    const conflicts = await bridge.restore();
    if (conflicts.length) throw new Error(conflicts.join('\n'));
    console.log('已恢复 PinK 配置');
  } else {
    throw new Error('用法：status 或 restore');
  }
}

main().catch(error => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
