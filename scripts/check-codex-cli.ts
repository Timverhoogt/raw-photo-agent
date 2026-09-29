// Verifies that an installed Codex CLI still understands the flags and feature
// names the photo agent passes to it. Usage: node scripts/check-codex-cli.ts
// Set RPA_CODEX_BIN to check a binary that is not first on PATH.
import { execFileSync } from 'node:child_process';
import {
  CODEX_DISABLED_FEATURES, CODEX_ENABLED_FEATURE, CODEX_MIN_VERSION,
  buildCodexArgs, isSupportedCodexVersion, parseCodexVersion,
} from '../src/demo/agent.ts';

const binary = process.env.RPA_CODEX_BIN ?? 'codex';
const run = (...args: string[]) => execFileSync(binary, args, { encoding: 'utf8', timeout: 30_000 });
const problems: string[] = [];

const versionText = run('--version').trim();
const version = parseCodexVersion(versionText);
if (!version) problems.push(`Cannot parse a version from "${versionText}".`);
else if (!isSupportedCodexVersion(version)) problems.push(`${versionText} is older than the tested ${CODEX_MIN_VERSION}.`);

const features = new Set(run('features', 'list').split('\n').map(line => line.trim().split(/\s+/)[0]).filter(Boolean));
for (const feature of [...CODEX_DISABLED_FEATURES, CODEX_ENABLED_FEATURE]) {
  if (!features.has(feature)) problems.push(`Unknown feature: ${feature}`);
}

const help = run('exec', '--help');
const args = buildCodexArgs({ model: 'm', cwd: '/', schemaPath: '/s', outputPath: '/o', images: ['/i'] });
for (const flag of new Set(args.filter(arg => arg.startsWith('--')))) {
  if (!help.includes(flag)) problems.push(`\`codex exec\` no longer documents ${flag}`);
}

if (problems.length) {
  process.stderr.write(`${versionText}: incompatible\n${problems.map(p => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`${versionText}: compatible (${CODEX_DISABLED_FEATURES.length + 1} features, ${new Set(args.filter(a => a.startsWith('--'))).size} flags)\n`);
