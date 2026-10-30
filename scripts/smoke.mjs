import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const home = await mkdtemp(path.join(os.tmpdir(), 'pink-plugin-smoke-'));
const configDir = path.join(home, '.config', 'magpie');
const stateDir = path.join(home, '.config', 'magpie-pink');
const userDataDir = path.join(home, 'PinK');
const user = path.join(userDataDir, 'User');
const control = path.join(stateDir, 'control.json');
const settings = path.join(user, 'settings.json');
const modelFile = path.join(user, 'chatLanguageModels.json');
const original = '{\n  // 原来的默认模型\n  "chat.defaultModel": "original"\n}\n';
const { connect } = await import(pathToFileURL(path.join(root, 'dist', 'pink.agent.mjs')));
const hosts = [];

async function optional(file) {
  return readFile(file, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`等待失败：${label}\n${await optional(path.join(stateDir, 'status.json'))}`);
}

async function plugin(on) {
  await writeFile(path.join(configDir, 'plugins.json'), JSON.stringify({
    plugins: on ? [{ spec: root, options: { userDataDir } }] : [],
  }));
}

async function startHost() {
  const source = `
    const entry = await import(process.argv[1]);
    await entry.default.server({}, JSON.parse(process.argv[2]));
    console.log('READY');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source,
    pathToFileURL(path.join(root, 'dist', 'index.mjs')).href, JSON.stringify({ userDataDir })], {
    cwd: configDir, env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hosts.push(child);
  await new Promise((resolve, reject) => {
    let errors = '';
    const timeout = setTimeout(() => reject(new Error('宿主启动超时')), 10000);
    child.stderr.on('data', data => { errors += data; });
    child.once('error', reject);
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`宿主提前退出 ${code}: ${errors}`));
    });
    child.stdout.on('data', data => {
      if (String(data).includes('READY')) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  await until(async () => !!await optional(path.join(stateDir, 'worker.json')), '同步器启动');
  return child;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function choose(id = 'demo/model') {
  const models = ['demo/model', 'demo/other'].map(id => ({
    id, name: id, context: 128000, output: 8192,
  }));
  await writeFile(control, JSON.stringify({
    model: 'magpie/' + id,
    ...connect({
      gateway: { v1: 'http://127.0.0.1:3425/v1', key: 'magpie-pink' },
      model: models.find(model => model.id === id),
      models,
    }),
  }));
  await until(async () => (await optional(modelFile))?.includes('Bearer magpie-pink'), '连接落地');
  await until(async () => (await optional(settings))?.includes(id), '所选默认模型落地');
}

try {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(manifest.magpie.page, undefined);
  assert.equal(manifest.magpie.panels, undefined);
  await mkdir(configDir, { recursive: true });
  await mkdir(user, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  // 遗留记录指向一个仍活着的其他进程，也应凭过期心跳恢复
  await writeFile(path.join(stateDir, 'worker.json'), JSON.stringify({
    pid: process.pid, nonce: 'stale', configDir, heartbeat: 0,
  }));
  await writeFile(settings, original);
  await plugin(true);
  const first = await startHost();
  const second = await startHost();
  await choose();
  const currentSettings = JSON.parse(
    await readFile(settings, 'utf8').then(text => text.replace(/\/\/[^\n]*/g, '')),
  );
  assert.equal(currentSettings['chat.defaultModel'], 'demo/model');

  // 一个宿主退出不影响另一个；最后一个退出时不得留下后台进程
  await stop(first);
  await choose('demo/other');
  const connectedModels = await readFile(modelFile, 'utf8');
  const connectedSettings = await readFile(settings, 'utf8');
  const lastWorker = JSON.parse(await readFile(path.join(stateDir, 'worker.json'), 'utf8'));
  await stop(second);
  await until(async () => await optional(path.join(stateDir, 'worker.json')) === null
    && !processAlive(lastWorker.pid), '插件仍启用时，最后一个宿主退出后同步器应退出', 5000);
  assert.equal(await readFile(modelFile, 'utf8'), connectedModels);
  assert.equal(await readFile(settings, 'utf8'), connectedSettings);

  execFileSync(process.execPath, [path.join(root, 'dist', 'cli.mjs'), 'restore'], {
    cwd: configDir, env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 10000,
  });
  assert.equal(await optional(modelFile), null);
  assert.equal(await readFile(settings, 'utf8'), original);

  const third = await startHost();
  await choose();
  const transient = await startHost();
  await stop(transient);
  const launchPath = path.join(stateDir, 'launch.json');
  await until(async () => {
    const lease = await optional(path.join(stateDir, 'worker.json'));
    const launch = JSON.parse(await readFile(launchPath, 'utf8'));
    return lease && processAlive(JSON.parse(lease).pid) && launch.parentPid === third.pid;
  }, '临时宿主退出后，由仍活跃的宿主接管', 5000);
  await choose('demo/other');
  const oldLease = JSON.parse(await readFile(path.join(stateDir, 'worker.json'), 'utf8'));
  await delay(1200);
  assert.equal(JSON.parse(await readFile(path.join(stateDir, 'worker.json'), 'utf8')).nonce,
    oldLease.nonce, '接管后不得反复启动同步器');

  const next = JSON.parse(await readFile(launchPath, 'utf8'));
  next.generation += '-updated';
  await writeFile(launchPath, JSON.stringify(next));
  await until(async () => {
    const lease = await optional(path.join(stateDir, 'worker.json'));
    return lease && JSON.parse(lease).nonce !== oldLease.nonce;
  }, '宿主存活时完成更新接力');
  await writeFile(control, '{}');
  await until(async () => await optional(modelFile) === null, '重启后的断开恢复');
  assert.equal(await readFile(settings, 'utf8'), original);

  await choose();
  await plugin(false);
  await stop(third);
  await until(async () => await optional(modelFile) === null, '移除插件后的配置恢复');
  await until(
    async () => await optional(path.join(stateDir, 'worker.json')) === null,
    '移除后的同步器退出',
  );
  assert.equal(await readFile(settings, 'utf8'), original);
  console.log('纯插件打包、宿主退出、双宿主接管、重启、断开与移除恢复检查通过');
} finally {
  await plugin(false).catch(() => {});
  await writeFile(control, '{}').catch(() => {});
  await Promise.all(hosts.map(stop));
  await until(async () => await optional(path.join(stateDir, 'worker.json')) === null, '清理同步器')
    .catch(() => {});
  await rm(home, { recursive: true, force: true });
}
