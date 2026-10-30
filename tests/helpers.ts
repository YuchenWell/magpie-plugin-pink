import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConnectionManager } from '../src/connections.js';
import { instanceId } from '../src/discovery.js';
import { StateStore } from '../src/store.js';
import type { Catalog } from '../src/types.js';

export const catalog: Catalog = {
  baseUrl: 'http://127.0.0.1:3425',
  models: [{
    id: 'example/model', name: 'Example', context: 128000, output: 8192,
    tools: true, vision: true, efforts: ['low', 'high'],
  }],
};

export async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pink-plugin-'));
  const root = path.join(directory, 'PinK');
  const user = path.join(root, 'User');
  await mkdir(user, { recursive: true });
  const store = new StateStore(path.join(directory, 'plugin-state'));
  const current = structuredClone(catalog);
  const manager = new ConnectionManager(store, async () => current, [root]);
  const models = path.join(user, 'chatLanguageModels.json');
  const settings = path.join(user, 'settings.json');
  const id = instanceId(await realpath(root));
  const connect = (defaultModelId?: string, profileIds = ['default']) =>
    manager.connect({ instanceId: id, profileIds, defaultModelId });
  const writeProfiles = async (entries: unknown[]) => {
    await mkdir(path.join(user, 'globalStorage'), { recursive: true });
    await writeFile(path.join(user, 'globalStorage', 'storage.json'),
      JSON.stringify({ userDataProfiles: entries }));
  };
  return { directory, root, user, store, manager, current, models, settings, id, connect, writeProfiles };
}
