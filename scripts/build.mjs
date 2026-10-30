import { build } from 'esbuild';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Magpie 的插件图标接受数据 URI，和 Agent 图标统一从本地资源生成
const icon = 'data:image/png;base64,' + (await readFile('assets/pink.png')).toString('base64');
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
if (manifest.magpie.icon !== icon) {
  manifest.magpie.icon = icon;
  await writeFile('package.json', JSON.stringify(manifest, null, 2) + '\n');
}

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/index.ts', 'src/worker.ts', 'src/cli.ts'],
  outdir: 'dist', outExtension: { '.js': '.mjs' },
  bundle: true, platform: 'node', format: 'esm', target: 'node22', mainFields: ['module', 'main'],
});
await build({
  entryPoints: ['src/pink.agent.ts'], outfile: 'dist/pink.agent.mjs',
  bundle: true, platform: 'neutral', format: 'esm', target: 'es2020',
  loader: { '.png': 'dataurl' },
});
const plugin = await import(pathToFileURL(path.resolve('dist/index.mjs')).href);
if (typeof plugin.default?.server !== 'function') throw new Error('缺少宿主入口');
