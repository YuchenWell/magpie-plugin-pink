export type JsonObject = Record<string, unknown>;

export interface Profile {
  id: string;
  name: string;
  modelsPath: string;
  settingsPath: string;
  inheritsModels: boolean;
}

export interface Instance {
  id: string;
  name: string;
  root: string;
  profiles: Profile[];
  error?: string;
}

export interface CatalogModel {
  id: string;
  name: string;
  context: number;
  output: number;
  tools: boolean;
  vision: boolean;
  efforts: string[];
}

export interface Catalog {
  baseUrl: string;
  key?: string;
  models: CatalogModel[];
}

export interface ModelsFile {
  path: string;
  original: string | null;
  lastContent: string;
  restoreWhole: boolean;
  group: JsonObject;
}

export interface DefaultFile {
  path: string;
  original: string | null;
  hadValue: boolean;
  previous?: unknown;
  written: string;
  lastContent: string;
  restoreWhole: boolean;
}

export interface Connection {
  id: string;
  root: string;
  profileIds: string[];
  models: ModelsFile[];
  defaults: DefaultFile[];
  syncedAt: string;
  error?: string;
}

export interface PluginState {
  version: 1;
  roots: string[];
  connections: Connection[];
  preferences?: Record<string, unknown>;
}

export interface PluginOptions {
  userDataDir?: string;
  profileIds?: string[];
}

export interface Launch {
  home: string;
  configDir: string;
  packageRoot: string;
  workerPath: string;
  executable?: string;
  generation: string;
  options: PluginOptions;
  parentPid: number;
}

export interface BridgeStatus {
  state: 'idle' | 'connected' | 'disconnected' | 'error';
  updatedAt: string;
  root?: string;
  appliedModel?: string;
  appliedDigest?: string;
  failedControl?: string;
  error?: string;
}
