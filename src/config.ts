import { mkdirSync, cpSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function getPaths(root = projectRoot) {
  const runtime = join(root, '.runtime');
  return {
    root, runtime, bridgeDir: join(runtime, 'bridge'),
    exportRoot: join(runtime, 'renders'), database: join(runtime, 'runs.sqlite'),
    pluginSource: join(root, 'plugin', 'RawPhotoAgent.lrplugin'),
    pluginInstall: join(runtime, 'RawPhotoAgent.lrplugin'),
  };
}

export function preparePlugin(root = projectRoot) {
  const paths = getPaths(root);
  if (!existsSync(join(paths.pluginSource, 'Info.lua'))) throw new Error('Lightroom plugin source is missing.');
  for (const dir of [paths.runtime, paths.bridgeDir, paths.exportRoot, paths.pluginInstall]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Never replace configuration or runtime state with source copies.
  for (const name of readdirSync(paths.pluginSource)) {
    if (name === 'config.json' || name === 'runtime' || name === 'tests') continue;
    cpSync(join(paths.pluginSource, name), join(paths.pluginInstall, name), { recursive: true });
  }
  writeFileSync(join(paths.pluginInstall, 'config.json'), JSON.stringify({
    bridgeDir: paths.bridgeDir, exportRoot: paths.exportRoot,
  }, null, 2), { mode: 0o600 });
  return paths;
}
