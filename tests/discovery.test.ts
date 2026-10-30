import { afterEach, expect, it } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { canonicalRoot, defaultRoot, inspectInstance, profileLocation } from '../src/discovery.js';
import { fixture } from './helpers.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true })));
});

it('三个平台仅探测正式版，并尊重 XDG 和 APPDATA', () => {
  expect(defaultRoot({ platform: 'darwin', home: '/home/me', env: {} }))
    .toBe('/home/me/Library/Application Support/PinK');
  expect(defaultRoot({ platform: 'linux', home: '/home/me', env: {} })).toBe('/home/me/.config/PinK');
  expect(defaultRoot({ platform: 'linux', home: '/home/me', env: { XDG_CONFIG_HOME: '/custom' } }))
    .toBe('/custom/PinK');
  expect(defaultRoot({ platform: 'win32', home: 'C:\\Users\\me', env: { APPDATA: 'D:\\Config' } }))
    .toBe('D:\\Config\\PinK');
});

it('不允许 Profile 登记信息越过 profiles 目录', () => {
  const user = path.resolve('data', 'User');
  expect(profileLocation(user, '../../other')).toBeUndefined();
  expect(profileLocation(user, { scheme: 'vscode-remote', path: '/server/path' })).toBeUndefined();
  expect(profileLocation(user, 'work')).toBe(path.join(user, 'profiles', 'work'));
});

it('读取 Profile 继承标记，并忽略已删除的目录', async () => {
  const f = await fixture();
  directories.push(f.directory);
  await mkdir(path.join(f.user, 'profiles', 'work'), { recursive: true });
  await f.writeProfiles([
    { name: '工作', location: 'work', useDefaultFlags: { settings: true } },
    { name: '已删除', location: 'gone' },
  ]);
  const instance = await inspectInstance(f.root);
  expect(instance.profiles).toHaveLength(2);
  expect(instance.profiles[1]).toMatchObject({
    name: '工作', settingsPath: f.settings,
    modelsPath: path.join(f.user, 'profiles', 'work', 'chatLanguageModels.json'),
  });
});

it('自定义目录也拒绝 pink-dev', async () => {
  const f = await fixture();
  directories.push(f.directory);
  const dev = path.join(f.directory, 'pink-dev');
  await mkdir(path.join(dev, 'User'), { recursive: true });
  await expect(canonicalRoot(dev)).rejects.toThrow('不支持 pink-dev');
});
