import { afterEach, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Bridge } from '../src/bridge.js';
import { agent, connect } from '../src/pink.agent.js';
import { pluginEnabled } from '../src/runtime.js';
import { parseConfig } from '../src/json.js';
import { fixture } from './helpers.js';
import type { Launch } from '../src/types.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const f = await fixture();
  directories.push(f.directory);
  const configDir = path.join(f.directory, 'magpie');
  await mkdir(configDir);
  const launch: Launch = {
    home: f.directory, configDir, packageRoot: f.directory,
    workerPath: '', generation: 'test', parentPid: process.pid,
    options: { userDataDir: f.root },
  };
  const plugins = path.join(configDir, 'plugins.json');
  await writeFile(plugins, JSON.stringify({ plugins: [{ spec: f.directory }] }));
  const bridge = new Bridge(launch);
  await bridge.initialize();
  const choose = async (id = 'example/model', models = ['example/model', 'example/other']) => {
    const catalog = models.map(id => ({ id, name: id, context: 200000, output: 8192, images: true }));
    await writeFile(bridge.control, JSON.stringify({
      model: 'magpie/' + id,
      ...connect({
        gateway: { v1: 'http://127.0.0.1:3425/v1', key: 'magpie-pink' },
        model: { id },
        models: catalog,
      }),
    }));
  };
  return { ...f, launch, plugins, bridge, choose };
}

it('Agent 声明使用原生列表与自己的控制文件，不声明页面或共享 User-Agent', () => {
  expect(agent.id).toBe('pink');
  expect(agent.prefix).toBe('magpie/');
  expect(agent).not.toHaveProperty('ua');
  expect(agent).not.toHaveProperty('page');
});

it('原生选择同步模型与默认值，断开后恢复', async () => {
  const f = await setup();
  await writeFile(f.settings, '{"chat.defaultModel":"original"}\n');
  await f.choose();
  expect(await f.bridge.reconcile()).toBe(true);
  expect(parseConfig(await readFile(f.settings, 'utf8'), '')).toMatchObject({
    'chat.defaultModel': 'example/model',
  });
  expect(await readFile(f.models, 'utf8')).toContain('Bearer magpie-pink');
  await f.choose('example/other');
  await f.bridge.reconcile();
  expect((await f.bridge.status()).appliedModel).toBe('magpie/example/other');
  await writeFile(f.bridge.control, '{}');
  expect(await f.bridge.reconcile()).toBe(false);
  expect(await readFile(f.settings, 'utf8')).toBe('{"chat.defaultModel":"original"}\n');
  expect(await readFile(f.models, 'utf8').catch(() => null)).toBeNull();
});

it('目录同步保留用户自己设置的默认模型', async () => {
  const f = await setup();
  await f.choose();
  await f.bridge.reconcile();
  await writeFile(f.settings, '{"chat.defaultModel":"user-choice"}');
  await f.choose('example/model', ['example/model', 'example/other', 'example/new']);
  await f.bridge.reconcile();
  expect(await readFile(f.models, 'utf8')).toContain('example/new');
  expect(await readFile(f.settings, 'utf8')).toContain('user-choice');
});

it('首次连接失败会撤回原生模型选择，显式重试可以恢复', async () => {
  const f = await setup();
  await writeFile(f.models, '[broken');
  await f.choose();
  expect(await f.bridge.reconcile()).toBe(false);
  expect((await f.bridge.status()).state).toBe('error');
  expect(JSON.parse(await readFile(f.bridge.control, 'utf8')).model).toBeUndefined();
  await f.bridge.reconcile();
  expect((await f.bridge.status()).state).toBe('error');
  await writeFile(f.models, '[]');
  await f.choose();
  expect(await f.bridge.reconcile()).toBe(true);
  expect((await f.bridge.status()).state).toBe('connected');
});

it('切换失败回退到上次成功模型，不覆盖 PinK 的手动更改', async () => {
  const f = await setup();
  await f.choose();
  await f.bridge.reconcile();
  const modified = '{"chat.defaultModel":"user-choice"}';
  await writeFile(f.settings, modified);
  await f.choose('example/other');
  await f.bridge.reconcile();
  expect(JSON.parse(await readFile(f.bridge.control, 'utf8')).model).toBe('magpie/example/model');
  expect(await readFile(f.settings, 'utf8')).toBe(modified);
  expect((await f.bridge.status()).state).toBe('error');
});

it('停用或移除插件时恢复，即使控制文件已经损坏', async () => {
  const f = await setup();
  await f.choose();
  await f.bridge.reconcile();
  await writeFile(f.bridge.control, '{bad');
  await writeFile(f.plugins, JSON.stringify({ plugins: [{ spec: f.directory, off: true }] }));
  expect(await f.bridge.reconcile()).toBe(false);
  expect(await readFile(f.models, 'utf8').catch(() => null)).toBeNull();
  expect((await f.bridge.status()).state).toBe('disconnected');
});

it('插件列表不可读时不视为卸载，不动已有配置', async () => {
  const f = await setup();
  await f.choose();
  await f.bridge.reconcile();
  const before = await readFile(f.models, 'utf8');
  await writeFile(f.plugins, '{bad');
  await expect(f.bridge.reconcile()).rejects.toThrow();
  expect(await readFile(f.models, 'utf8')).toBe(before);
});

it('支持带版本的 npm 安装标识', async () => {
  const f = await setup();
  await writeFile(f.plugins, JSON.stringify({ plugins: [{ spec: 'magpie-plugin-pink@0.1.0' }] }));
  expect(await pluginEnabled(f.launch)).toBe(true);
  await writeFile(f.plugins, JSON.stringify({ plugins: [] }));
  expect(await pluginEnabled(f.launch)).toBe(false);
});
