import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { editJson, parseConfig } from '../src/json.js';
import { GROUP_NAME } from '../src/gateway.js';
import { ConnectionManager } from '../src/connections.js';
import { fixture } from './helpers.js';

const directories: string[] = [];
async function setup() {
  const test = await fixture();
  directories.push(test.directory);
  return test;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true })));
});

describe('配置连接与恢复', () => {
  it('保留 Windows 配置的 BOM 和 CRLF', async () => {
    const f = await setup();
    const original = '\uFEFF[\r\n  // 用户模型\r\n]\r\n';
    await writeFile(f.models, original);
    await f.connect();
    const connected = await readFile(f.models, 'utf8');
    expect(connected.startsWith('\uFEFF')).toBe(true);
    expect(connected.replaceAll('\r\n', '')).not.toContain('\n');
    await f.manager.disconnect(f.id);
    expect(await readFile(f.models, 'utf8')).toBe(original);
  });

  it('网关离线时保留已连接配置，断开不依赖网关', async () => {
    const f = await setup();
    await f.connect();
    const connected = await readFile(f.models, 'utf8');
    const offline = new ConnectionManager(f.store, async () => { throw new Error('offline'); });
    await expect(offline.sync(f.id)).rejects.toThrow('offline');
    expect(await readFile(f.models, 'utf8')).toBe(connected);
    await offline.disconnect(f.id);
    expect(await readFile(f.models, 'utf8').catch(() => null)).toBeNull();
  });

  it('保留 JSONC 注释及已有模型，重复连接幂等，断开后逐字恢复', async () => {
    const f = await setup();
    const original = '[\n  // 用户的模型\n  {"name":"Mine","vendor":"other","models":[]},\n]\n';
    await writeFile(f.models, original);
    await f.connect();
    const connected = await readFile(f.models, 'utf8');
    expect(connected).toContain('// 用户的模型');
    const list = parseConfig(connected, '') as Record<string, unknown>[];
    expect(list.map(group => group.name)).toEqual(['Mine', GROUP_NAME]);
    await f.connect();
    expect(await readFile(f.models, 'utf8')).toBe(connected);
    expect(await readFile(f.settings, 'utf8').catch(() => null)).toBeNull();
    expect(await f.manager.disconnect(f.id)).toEqual([]);
    expect(await readFile(f.models, 'utf8')).toBe(original);
    expect(await f.manager.list()).toEqual([]);
  });

  it('显式设置默认模型，并恢复原来的值与格式', async () => {
    const f = await setup();
    const original = '{\n  // 保留这个默认值\n  "chat.defaultModel": "mine",\n  "editor.fontSize": 15\n}\n';
    await writeFile(f.settings, original);
    await f.connect('example/model');
    expect(parseConfig(await readFile(f.settings, 'utf8'), '')).toMatchObject({
      'chat.defaultModel': 'example/model',
    });
    await f.manager.disconnect(f.id);
    expect(await readFile(f.settings, 'utf8')).toBe(original);
    expect(await readFile(f.models, 'utf8').catch(() => null)).toBeNull();
  });

  it('同步后断开也不会丢失用户新增的其他配置或注释', async () => {
    const f = await setup();
    await writeFile(f.models, '[]\n');
    await writeFile(f.settings, '{}\n');
    await f.connect('example/model');
    const mine = { vendor: 'other', name: 'Added later' };
    await writeFile(f.models, '// 连接后添加的注释\n' + editJson(await readFile(f.models, 'utf8'), [-1], mine));
    await writeFile(f.settings, editJson(await readFile(f.settings, 'utf8'), ['editor.fontSize'], 18));
    f.current.models.push({ ...f.current.models[0]!, id: 'example/new', name: 'New' });
    await f.manager.sync(f.id, 'example/new');
    await f.manager.disconnect(f.id);
    const models = await readFile(f.models, 'utf8');
    expect(models).toContain('// 连接后添加的注释');
    expect(parseConfig(models, '')).toEqual([mine]);
    expect(parseConfig(await readFile(f.settings, 'utf8'), '')).toEqual({ 'editor.fontSize': 18 });
  });

  it('断开移除模型组，下次连接恢复 PinK 的 reasoning 偏好', async () => {
    const f = await setup();
    await f.connect();
    await writeFile(f.models, editJson(await readFile(f.models, 'utf8'),
      [0, 'settings'], { 'example/model': { reasoningEffort: 'high' } }));
    f.current.models[0]!.name = 'Renamed';
    await f.manager.sync(f.id);
    expect(await readFile(f.models, 'utf8')).toContain('reasoningEffort');
    const conflicts = await f.manager.disconnect(f.id);
    expect(conflicts).toHaveLength(0);
    expect(await f.manager.list()).toEqual([]);
    await f.connect();
    expect(await readFile(f.models, 'utf8')).toContain('reasoningEffort');
  });

  it('用户手动修改模型端点后，自动同步和断开均不会覆盖', async () => {
    const f = await setup();
    await f.connect();
    const edited = editJson(await readFile(f.models, 'utf8'), [0, 'models', 0, 'url'], 'http://localhost:9999');
    await writeFile(f.models, edited);
    await expect(f.manager.sync(f.id)).rejects.toThrow('手动修改');
    expect((await f.manager.list())[0]?.error).toContain('手动修改');
    expect(await f.manager.disconnect(f.id)).toHaveLength(1);
    expect(await readFile(f.models, 'utf8')).toBe(edited);
  });

  it('用户删除组后不自动重新创建，断开清除所有权记录', async () => {
    const f = await setup();
    await f.connect();
    await writeFile(f.models, '[]');
    await expect(f.manager.sync(f.id)).rejects.toThrow('移除');
    await f.manager.disconnect(f.id);
    expect(await readFile(f.models, 'utf8')).toBe('[]');
    expect(await f.manager.list()).toEqual([]);
  });

  it('保留用户后来选择的默认模型', async () => {
    const f = await setup();
    await f.connect('example/model');
    await writeFile(f.settings, '{"chat.defaultModel":"user-selected"}');
    const conflicts = await f.manager.disconnect(f.id);
    expect(conflicts.join()).toContain('保留当前值');
    expect(await readFile(f.settings, 'utf8')).toContain('user-selected');
    expect(await f.manager.list()).toEqual([]);
  });

  it('拒绝接管现有同名组或覆盖损坏配置', async () => {
    const f = await setup();
    await writeFile(f.models, JSON.stringify([{ name: GROUP_NAME, vendor: 'customendpoint' }]));
    await expect(f.connect()).rejects.toThrow('非本插件');
    await writeFile(f.models, '[{broken');
    await expect(f.connect()).rejects.toThrow('语法错误');
    expect(await f.manager.list()).toEqual([]);
  });

  it('多 Profile 在写入前全部校验，不留下半连接状态', async () => {
    const f = await setup();
    const own = path.join(f.user, 'profiles', 'work');
    await mkdir(own, { recursive: true });
    await f.writeProfiles([{ name: 'Work', location: 'work' }]);
    await writeFile(path.join(own, 'chatLanguageModels.json'), 'invalid');
    await expect(f.connect(undefined, ['default', 'work'])).rejects.toThrow('语法错误');
    expect(await readFile(f.models, 'utf8').catch(() => null)).toBeNull();
  });

  it('继承默认模型的 Profile 只写一次共享配置，默认模型写入各自设置', async () => {
    const f = await setup();
    const own = path.join(f.user, 'profiles', 'work');
    await mkdir(own, { recursive: true });
    await f.writeProfiles([{ name: 'Work', location: 'work', useDefaultFlags: { languageModels: true } }]);
    await f.connect('example/model', ['default', 'work']);
    const state = await f.store.read();
    expect(state.connections[0]?.models).toHaveLength(1);
    expect(state.connections[0]?.defaults).toHaveLength(2);
    expect(await readFile(path.join(own, 'chatLanguageModels.json'), 'utf8').catch(() => null)).toBeNull();
    await f.manager.disconnect(f.id);
    expect(await readFile(path.join(own, 'settings.json'), 'utf8').catch(() => null)).toBeNull();
  });
});
