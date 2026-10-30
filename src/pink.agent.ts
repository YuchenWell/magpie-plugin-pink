import icon from '../assets/pink.png';

interface Model {
  id: string;
  name?: string;
  context?: number;
  output?: number;
  images?: boolean;
  efforts?: string[];
}

export const agent = {
  id: 'pink',
  name: 'PinK',
  icon,
  config: '~/.config/magpie-pink/control.json',
  dir: '~/.config/magpie-pink/detected',
  format: 'json',
  model: 'model',
  prefix: 'magpie/',
};

/** 将原生 Agent 的选择交给同步器，不在受限运行时访问文件系统 */
export function connect(input: {
  gateway: { v1: string; key: string };
  model: Model;
  models: Model[];
}) {
  return {
    gateway: input.gateway.v1,
    key: input.gateway.key,
    models: input.models,
    revision: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  };
}
