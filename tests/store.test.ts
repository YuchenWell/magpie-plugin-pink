import { afterEach, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readOptional } from '../src/store.js';
import { fixture } from './helpers.js';

const directories: string[] = [];
async function setup() {
  const f = await fixture();
  directories.push(f.directory);
  await mkdir(f.store.directory, { recursive: true });
  return f;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true })));
});

it('提交前发现并发编辑时拒绝写入', async () => {
  const f = await setup();
  await writeFile(f.models, 'user edit');
  await expect(f.store.exclusive(async () => f.store.commit([
    { path: f.models, before: 'old', after: 'new' },
  ], await f.store.read()))).rejects.toThrow('其他程序修改');
  expect(await readFile(f.models, 'utf8')).toBe('user edit');
  expect(await readOptional(f.store.journal)).toBeNull();
});

it('启动时回滚中途退出的多文件操作', async () => {
  const f = await setup();
  const changes = [
    { path: f.models, before: 'old models', after: 'new models' },
    { path: f.settings, before: null, after: 'new settings' },
  ];
  await writeFile(f.models, 'new models');
  await writeFile(f.store.journal, JSON.stringify({ changes }));
  await f.manager.initialize();
  expect(await readOptional(f.models)).toBe('old models');
  expect(await readOptional(f.settings)).toBeNull();
  expect(await readOptional(f.store.journal)).toBeNull();
});

it('完成写入但未清理日志时保留已经提交的内容', async () => {
  const f = await setup();
  await writeFile(f.models, 'new models');
  await writeFile(f.store.journal, JSON.stringify({ changes: [
    { path: f.models, before: 'old models', after: 'new models' },
  ] }));
  await f.manager.initialize();
  expect(await readOptional(f.models)).toBe('new models');
  expect(await readOptional(f.store.journal)).toBeNull();
});

it('恢复时不覆盖外部修改，并留下恢复日志', async () => {
  const f = await setup();
  await writeFile(f.models, 'user edited again');
  await writeFile(f.store.journal, JSON.stringify({ changes: [
    { path: f.models, before: 'old', after: 'new' },
  ] }));
  await expect(f.manager.initialize()).rejects.toThrow('外部修改');
  expect(await readOptional(f.models)).toBe('user edited again');
  expect(await readOptional(f.store.journal)).not.toBeNull();
});

it('活动进程持有配置锁时拒绝第二个写入者', async () => {
  const f = await setup();
  await writeFile(path.join(f.store.directory, 'operation.lock'), String(process.pid));
  await expect(f.manager.initialize()).rejects.toThrow('另一个配置操作');
});
