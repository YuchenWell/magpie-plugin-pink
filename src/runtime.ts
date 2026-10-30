import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { object, UserError } from './json.js';
import type { Launch, PluginOptions } from './types.js';

export const PACKAGE_NAME = 'magpie-plugin-pink';
export const stateDirectory = (home: string) => path.join(home, '.config', 'magpie-pink');
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 同时检查进程和心跳，避免退出后的 PID 被其他程序复用 */
export function workerAlive(lease: unknown): boolean {
  return object(lease) && typeof lease.pid === 'number' && processAlive(lease.pid)
    && typeof lease.heartbeat === 'number' && Date.now() - lease.heartbeat < 30_000;
}

/** 读取同步器租约
 *
 * 文件缺失、不可读或 JSON 损坏时返回 undefined。
 */
export async function readWorkerLease(file: string) {
  return readFile(file, 'utf8')
    .then(text => JSON.parse(text))
    .catch(() => undefined);
}

/** 启动同步器，宿主退出后的最后一轮同步由子进程完成 */
export function spawnWorker(
  launch: Launch,
  launchPath: string,
  onError: (error: Error) => void,
): void {
  const child = spawn(launch.executable ?? process.execPath, [launch.workerPath, launchPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', onError);
  child.unref();
}

export async function launchConfig(packageRoot: string, options: PluginOptions): Promise<Launch> {
  const home = os.homedir();
  const configDir = await access(path.join(process.cwd(), 'plugins.json')).then(
    () => process.cwd(),
    () => path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'magpie'),
  );

  if (options.userDataDir !== undefined && typeof options.userDataDir !== 'string') {
    throw new UserError('userDataDir 必须是正式版 PinK 的数据目录');
  }
  if (options.profileIds !== undefined && (
    !Array.isArray(options.profileIds)
    || !options.profileIds.every(id => typeof id === 'string')
  )) {
    throw new UserError('profileIds 必须是 Profile ID 数组');
  }

  const workerPath = path.join(packageRoot, 'dist', 'worker.mjs');
  return {
    home, configDir, packageRoot, workerPath, options, parentPid: process.pid,
    executable: process.execPath,
    generation: digest([await readFile(workerPath, 'utf8'), options, configDir, packageRoot]),
  };
}

function barePackage(spec: string): string {
  const name = spec.replace(/^npm:/, '');
  const at = name.lastIndexOf('@');
  return at > 0 ? name.slice(0, at) : name;
}

function repository(spec: string): string {
  return spec.replace(/^git\+/, '').replace(/^github:/, '')
    .replace(/^https?:\/\/github\.com\//, '').split('#')[0]!.replace(/\.git$/, '');
}

/** 判断当前安装是否仍启用
 *
 * 插件列表不可读或格式无效时抛出错误，避免把未知状态当成已移除。
 */
export async function pluginEnabled(launch: Launch): Promise<boolean> {
  const data: unknown = JSON.parse(await readFile(path.join(launch.configDir, 'plugins.json'), 'utf8'));
  if (!object(data) || !Array.isArray(data.plugins)) throw new UserError('Magpie 插件列表不可读');
  let dependency = '';
  try {
    const pkg = JSON.parse(await readFile(path.join(launch.configDir, 'plugins', 'package.json'), 'utf8'));
    dependency = pkg.dependencies?.[PACKAGE_NAME] ?? '';
  } catch {
    // 依赖登记不是必需信息，本地目录安装可能没有这个文件
  }

  const own = await realpath(launch.packageRoot).catch(() => launch.packageRoot);
  for (const item of data.plugins) {
    if (!object(item) || typeof item.spec !== 'string') continue;
    const spec = item.spec;
    let match = barePackage(spec) === PACKAGE_NAME;
    if (dependency && repository(spec) === repository(dependency)) match = true;
    if (spec.startsWith('file:') || spec.startsWith('~') || spec.startsWith('.') || path.isAbsolute(spec)) {
      let local = spec.startsWith('file://') ? fileURLToPath(spec) : spec.replace(/^file:/, '');
      if (local.startsWith('~/')) local = path.join(launch.home, local.slice(2));
      const resolved = await realpath(path.resolve(launch.configDir, local)).catch(() => '');
      match = resolved === own;
    }
    if (match) return item.off !== true;
  }
  return false;
}
