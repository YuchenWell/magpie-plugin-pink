import { createHash } from 'node:crypto';
import { access, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { object, parseConfig, UserError, errorMessage } from './json.js';
import type { Instance, Profile } from './types.js';

/** 返回正式版 PinK 的默认数据目录 */
export function defaultRoot(options: {
  platform: string;
  home: string;
  env: NodeJS.ProcessEnv;
}): string {
  const { platform, home, env } = options;
  if (platform === 'win32') {
    return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), 'PinK');
  }
  if (platform === 'darwin') {
    return path.posix.join(home, 'Library', 'Application Support', 'PinK');
  }
  return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), 'PinK');
}

export function instanceId(root: string): string {
  const canonical = process.platform === 'win32' ? root.toLowerCase() : root;
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export async function canonicalRoot(input: string): Promise<string> {
  const expanded = input.startsWith('~/') ? path.join(os.homedir(), input.slice(2)) : input;
  if (!path.isAbsolute(expanded)) throw new UserError('请输入 PinK 数据目录的绝对路径');
  let root = await realpath(expanded).catch(() => {
    throw new UserError('数据目录不存在');
  });
  if (path.basename(root) === 'User') root = path.dirname(root);
  if (path.basename(root).toLowerCase() === 'pink-dev') {
    throw new UserError('本插件仅支持正式版 PinK，不支持 pink-dev');
  }
  await access(path.join(root, 'User')).catch(() => {
    throw new UserError('该目录下没有 User 文件夹，请选择正式版 PinK 的用户数据目录');
  });
  return root;
}

/** 解析 Profile 的本地目录
 *
 * 仅接受当前实例 profiles 目录内的位置，其他位置返回 undefined。
 */
export function profileLocation(userDir: string, location: unknown): string | undefined {
  let candidate: string;
  if (typeof location === 'string') {
    if (location.startsWith('file:')) {
      candidate = fileURLToPath(location);
    } else if (path.isAbsolute(location)) {
      candidate = location;
    } else {
      candidate = path.join(userDir, 'profiles', location);
    }
  } else if (object(location)) {
    if (typeof location.scheme === 'string' && location.scheme !== 'file') return;
    if (typeof location.fsPath === 'string') {
      candidate = location.fsPath;
    } else if (typeof location.path === 'string') {
      candidate = location.path;
      if (process.platform === 'win32' && /^\/[a-z]:/i.test(candidate)) candidate = candidate.slice(1);
    } else {
      return;
    }
  } else {
    return;
  }

  const base = path.join(userDir, 'profiles');
  const relative = path.relative(base, path.resolve(candidate));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
  return path.resolve(candidate);
}

export async function inspectInstance(root: string): Promise<Instance> {
  const userDir = path.join(root, 'User');
  const profiles: Profile[] = [{
    id: 'default', name: '默认 Profile',
    modelsPath: path.join(userDir, 'chatLanguageModels.json'),
    settingsPath: path.join(userDir, 'settings.json'),
    inheritsModels: false,
  }];
  const instance: Instance = { id: instanceId(root), root, name: 'PinK', profiles };
  try {
    const file = path.join(userDir, 'globalStorage', 'storage.json');
    const content = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '{}';
      throw error;
    });
    const storage = parseConfig(content, 'Profile 登记信息');
    const entries = object(storage) && Array.isArray(storage.userDataProfiles)
      ? storage.userDataProfiles : [];
    for (const entry of entries) {
      if (!object(entry)) continue;
      const directory = profileLocation(userDir, entry.location);
      if (!directory) continue;
      const exists = await access(directory).then(() => true, () => false);
      if (!exists) continue;

      const flags = object(entry.useDefaultFlags) ? entry.useDefaultFlags : {};
      const id = path.basename(directory);
      if (profiles.some(profile => profile.id === id)) continue;
      profiles.push({
        id,
        name: typeof entry.name === 'string' ? entry.name : id,
        modelsPath: path.join(flags.languageModels ? userDir : directory, 'chatLanguageModels.json'),
        settingsPath: path.join(flags.settings ? userDir : directory, 'settings.json'),
        inheritsModels: flags.languageModels === true,
      });
    }
  } catch (error) {
    instance.error = errorMessage(error);
  }
  return instance;
}

export async function discover(roots: string[]): Promise<Instance[]> {
  const found = new Map<string, Instance>();
  for (const candidate of roots) {
    try {
      const root = await canonicalRoot(candidate);
      const instance = await inspectInstance(root);
      found.set(instance.id, instance);
    } catch (error) {
      found.set(instanceId(candidate), {
        id: instanceId(candidate), name: 'PinK', root: candidate,
        profiles: [], error: errorMessage(error),
      });
    }
  }
  return [...found.values()];
}
