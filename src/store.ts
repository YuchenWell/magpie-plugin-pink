import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { object, UserError } from './json.js';
import type { PluginState } from './types.js';

export interface Change {
  path: string;
  before: string | null;
  after: string | null;
}

export async function readOptional(file: string): Promise<string | null> {
  return readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

/** 通过同目录的临时文件替换目标文件
 *
 * 保留已有文件权限，新文件仅当前用户可读写；content 为 null 时删除目标文件。
 */
export async function replaceFile(file: string, content: string | null): Promise<void> {
  if (content === null) {
    await unlink(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return;
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const mode = await stat(file).then(info => info.mode & 0o777, () => 0o600);
  const temporary = `${file}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporary, content, { mode, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

const emptyState = (): PluginState => ({ version: 1, roots: [], connections: [] });

export class StateStore {
  readonly file: string;
  readonly journal: string;
  private readonly lock: string;

  constructor(readonly directory: string) {
    this.file = path.join(directory, 'state.json');
    this.journal = path.join(directory, 'pending.json');
    this.lock = path.join(directory, 'operation.lock');
  }

  async read(): Promise<PluginState> {
    const text = await readOptional(this.file);
    if (text === null) return emptyState();
    const value: unknown = JSON.parse(text);
    if (
      !object(value)
      || value.version !== 1
      || !Array.isArray(value.roots)
      || !value.roots.every(root => typeof root === 'string')
      || !Array.isArray(value.connections)
      || !value.connections.every(connection =>
        object(connection)
        && typeof connection.id === 'string'
        && typeof connection.root === 'string'
        && Array.isArray(connection.profileIds)
        && Array.isArray(connection.models)
        && Array.isArray(connection.defaults))
    ) {
      throw new UserError('插件状态文件格式无效，已停止写入；请保留状态目录以便恢复', 409);
    }
    return value as unknown as PluginState;
  }

  /** 串行执行跨进程写入，并在开始前处理上次未完成的事务 */
  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let handle;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        handle = await open(this.lock, 'wx', 0o600);
        await handle.writeFile(String(process.pid));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const pid = Number(await readOptional(this.lock));
        let stale = false;
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (probe) {
            stale = (probe as NodeJS.ErrnoException).code === 'ESRCH';
          }
        }
        if (stale && attempt === 0) {
          await unlink(this.lock);
        } else {
          throw new UserError('另一个配置操作正在执行，请稍后重试', 409);
        }
      }
    }
    if (!handle) throw new UserError('无法获取配置锁', 409);

    try {
      await this.recover();
      return await operation();
    } finally {
      await handle.close();
      await unlink(this.lock);
    }
  }

  private async rollback(changes: Change[]): Promise<string[]> {
    const conflicts: string[] = [];
    for (const change of [...changes].reverse()) {
      try {
        const current = await readOptional(change.path);
        if (current === change.before) continue;
        if (current !== change.after) {
          conflicts.push(change.path);
          continue;
        }
        await replaceFile(change.path, change.before);
      } catch {
        conflicts.push(change.path);
      }
    }
    return conflicts;
  }

  private async recover(): Promise<void> {
    const text = await readOptional(this.journal);
    if (text === null) return;
    const saved: unknown = JSON.parse(text);
    if (!object(saved) || !Array.isArray(saved.changes)
      || !saved.changes.every(change =>
        object(change)
        && typeof change.path === 'string'
        && (change.before === null || typeof change.before === 'string')
        && (change.after === null || typeof change.after === 'string'))) {
      throw new UserError('恢复日志损坏，已停止配置写入', 409);
    }

    const changes = saved.changes as Change[];
    const written = await Promise.all(changes.map(async change =>
      await readOptional(change.path) === change.after));
    const committed = written.every(Boolean);
    if (!committed) {
      const conflicts = await this.rollback(changes);
      if (conflicts.length) {
        throw new UserError(`未完成事务包含外部修改，需手动核对恢复日志：${this.journal}`, 409);
      }
    }
    await unlink(this.journal);
  }

  /** 将配置文件和连接状态作为同一个可恢复操作提交 */
  async commit(changes: Change[], state: PluginState): Promise<void> {
    const before = await readOptional(this.file);
    const after = JSON.stringify(state, null, 2) + '\n';
    const effective = [...changes, { path: this.file, before, after }]
      .filter(change => change.before !== change.after);
    if (!effective.length) return;
    if (new Set(effective.map(change => change.path)).size !== effective.length) {
      throw new UserError('配置路径重复，已停止写入', 409);
    }
    for (const change of effective) {
      if (await readOptional(change.path) !== change.before) {
        throw new UserError('配置已被其他程序修改，请刷新后重试', 409);
      }
    }

    await replaceFile(this.journal, JSON.stringify({ version: 1, changes: effective }, null, 2));
    try {
      for (const change of effective) {
        if (await readOptional(change.path) !== change.before) {
          throw new UserError('写入期间配置发生变化，已停止操作', 409);
        }
        await replaceFile(change.path, change.after);
      }
      await unlink(this.journal);
    } catch (error) {
      const conflicts = await this.rollback(effective);
      if (conflicts.length) {
        throw new UserError(`配置回滚需手动核对，请保留恢复日志：${this.journal}`, 409);
      }
      await unlink(this.journal);
      throw error;
    }
  }
}
