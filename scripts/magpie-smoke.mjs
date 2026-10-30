import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as createProbe } from 'node:net';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
const root = path.resolve(process.env.PINK_PLUGIN_PACKAGE || process.cwd());
const binary = process.env.MAGPIE_BIN;
const bun = process.env.MAGPIE_BUN;
if (!binary || !bun) throw new Error('请设置 MAGPIE_BIN 和 MAGPIE_BUN，指向官方 Magpie 与其 Bun');
const home = await mkdtemp(path.join(os.tmpdir(), 'pink-official-magpie-'));
const configDir = path.join(home, '.config', 'magpie');
const stateDir = path.join(home, '.config', 'magpie-pink');
let userDataDir;
if (process.platform === 'darwin') {
  userDataDir = path.join(home, 'Library', 'Application Support', 'PinK');
} else if (process.platform === 'win32') {
  userDataDir = path.join(home, 'AppData', 'PinK');
} else {
  userDataDir = path.join(home, '.config', 'PinK');
}
const user = path.join(userDataDir, 'User');
const models = path.join(user, 'chatLanguageModels.json');
const settings = path.join(user, 'settings.json');
const original = '{"chat.defaultModel":"original"}\n';
const providerId = 'pink-check-' + randomBytes(4).toString('hex');
const env = {
  ...process.env, HOME: home, USERPROFILE: home,
  APPDATA: path.join(home, 'AppData'), LOCALAPPDATA: path.join(home, 'LocalAppData'),
  XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
  XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'),
  MAGPIE_BUN: bun,
};
delete env.MAGPIE_ADDR;

async function freePort() {
  const probe = createProbe().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

const gatewayPort = await freePort();
const webPort = await freePort();
const upstream = createServer(async (request, response) => {
  for await (const _chunk of request) { /* 消费测试请求，不保存正文 */ }
  const data = request.method === 'POST' ? {
    id: 'pink-plugin-fixture', object: 'chat.completion', model: 'two',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'PINK_PLUGIN_OK' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 },
  } : { data: [{ id: 'one' }, { id: 'two' }] };
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(data));
}).listen(0, '127.0.0.1');
await once(upstream, 'listening');
let web;

async function stopWeb() {
  if (!web || web.exitCode !== null || web.signalCode !== null) return;
  const exited = once(web, 'exit');
  web.kill();
  const timeout = setTimeout(() => web.kill('SIGKILL'), 3000);
  await exited;
  clearTimeout(timeout);
}

async function cli(...args) {
  try {
    return await execute(binary, args, {
      env, cwd: configDir, timeout: 45000, maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`${args.join(' ')}: ${error.stderr || error.stdout || error.message}`);
  }
}

async function optional(file) {
  return readFile(file, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function until(check, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`${label}\n${await optional(path.join(stateDir, 'status.json'))}`);
}

let added = false;
try {
  await mkdir(configDir, { recursive: true });
  await mkdir(user, { recursive: true });
  await writeFile(settings, original);
  await writeFile(path.join(configDir, 'settings.json'), JSON.stringify({
    port: gatewayPort, noAccountDiscovery: true,
  }));
  await writeFile(path.join(configDir, 'providers.json'), JSON.stringify({ providers: [{
    id: providerId, name: 'Local test fixture', key: 'fixture-only',
    chat: `http://127.0.0.1:${upstream.address().port}/v1`, models: ['one', 'two'],
  }] }));
  await writeFile(path.join(configDir, 'plugins.json'), '{"plugins":[]}');
  await cli('plugin', 'add', root);
  added = true;
  await until(async () => !!await optional(path.join(stateDir, 'control.json')), '官方宿主未初始化插件');
  await cli('pink', `magpie/${providerId}/one`);
  await until(
    async () => (await optional(settings))?.includes(`${providerId}/one`),
    '原生 Agent 连接未落地',
  );
  assert.ok((await readFile(models, 'utf8')).includes('Bearer magpie-pink'));
  await cli('pink', `magpie/${providerId}/two`);
  await until(async () => (await optional(settings))?.includes(`${providerId}/two`), '原生模型切换未落地');

  web = spawn(binary, ['web', '--addr', `127.0.0.1:${webPort}`, '--no-open'], {
    env, cwd: configDir, stdio: 'ignore',
  });
  const endpoint = `http://127.0.0.1:${gatewayPort}`;
  await until(async () => {
    const list = await fetch(endpoint + '/v1/models', { signal: AbortSignal.timeout(500) })
      .then(response => response.json()).catch(() => null);
    return list?.data?.some(model => model.id === `${providerId}/two`);
  }, '隔离网关未就绪');
  const answer = await fetch(endpoint + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer magpie-pink' },
    body: JSON.stringify({
      model: `${providerId}/two`, stream: false,
      messages: [{ role: 'user', content: 'Local fixture validation' }],
    }),
    signal: AbortSignal.timeout(10000),
  }).then(response => response.json());
  assert.equal(answer.choices?.[0]?.message?.content, 'PINK_PLUGIN_OK');
  const usage = await fetch(endpoint + '/v1/magpie/usage/requests?agent=pink&period=all')
    .then(response => response.json());
  assert.equal(usage.calls, 1);
  assert.equal(usage.input, 21);
  assert.equal(usage.output, 7);
  assert.equal(usage.rows[0].agentName, 'PinK');
  await cli('pink', 'default');
  await until(async () => await optional(models) === null, '原生断开未恢复');
  assert.equal(await readFile(settings, 'utf8'), original);

  await cli('pink', `magpie/${providerId}/one`);
  await until(async () => !!await optional(models), '第二次连接失败');
  await cli('plugin', 'off', root);
  await until(async () => await optional(models) === null, '官方停用插件未恢复');
  await until(async () => await optional(path.join(stateDir, 'worker.json')) === null, '停用后同步器未退出');
  await cli('plugin', 'on', root);
  await cli('pink', `magpie/${providerId}/two`);
  await until(async () => !!await optional(models), '重新启用后连接失败');
  await cli('plugin', 'rm', root);
  added = false;
  await until(async () => await optional(models) === null, '官方移除插件未恢复');
  await until(async () => await optional(path.join(stateDir, 'worker.json')) === null, '移除后同步器未退出');
  assert.equal(await readFile(settings, 'utf8'), original);
  console.log('官方 Magpie：原生 Agent 生命周期、网关调用与 PinK 用量归属均通过（模拟上游）');
} finally {
  if (added) await cli('plugin', 'rm', root).catch(() => {});
  await writeFile(path.join(configDir, 'plugins.json'), '{"plugins":[]}').catch(() => {});
  await until(async () => await optional(path.join(stateDir, 'worker.json')) === null, '清理同步器')
    .catch(() => {});
  await stopWeb();
  await new Promise(resolve => upstream.close(resolve));
  await rm(home, { recursive: true, force: true });
}
