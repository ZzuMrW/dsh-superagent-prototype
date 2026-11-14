#!/usr/bin/env node
/** Generate an installable local configuration bundle; never mutate the active DSH profile. */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

if (process.platform !== 'linux') throw new Error('Run this packaging script inside the WSL/Linux checkout, not Windows Node');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = Object.fromEntries(process.argv.slice(2).map(item => {
  const match = /^--([a-z-]+)=(.*)$/s.exec(item);
  if (!match) throw new Error('Use --out=... --state-dir=... --distro=... --user=... --work-root=...');
  return [match[1], match[2]];
}));
for (const name of ['out', 'state-dir', 'distro', 'user', 'work-root']) if (!options[name]) throw new Error('Missing --' + name);
if (!/^[A-Za-z]:[\\/]/.test(options['state-dir'])) throw new Error('state-dir must be a local Windows drive path');
if (!/^[A-Za-z0-9._-]+$/.test(options.distro) || !/^[A-Za-z0-9_-]+$/.test(options.user)) throw new Error('Invalid distro/user');
if (!options['work-root'].startsWith('/') || /^\/mnt\/[A-Za-z](?:\/|$)/.test(options['work-root'])) throw new Error('work-root must be on the guest native filesystem');
const out = resolve(options.out);
if (!/^\/mnt\/[A-Za-z]\//.test(out)) throw new Error('Use a stable Windows local output directory through /mnt/<drive>/... for Desktop installation');
if (existsSync(out)) throw new Error('Refuse to overwrite an existing output directory');
for (const file of ['lib/index.js', 'lib/client.js', 'lib/wsl-shell.js', 'lib/wsl-fs.js', 'lib/wsl-tools.js', 'WSL-ADAPTER.md']) {
  if (!existsSync(join(root, file))) throw new Error('Build output missing: ' + file);
}
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const config = { stateDir: options['state-dir'], wsl: { distro: options.distro, user: options.user, workRoot: options['work-root'] } };
const original = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
const anchor = '    - id: dsh-superagent\n      name: dsh-superagent\n';
if (original.split(anchor).length !== 2) throw new Error('Host entry changed; review packaging anchor');
const patch = original.replace(anchor, anchor + '      config: ' + JSON.stringify(config) + '\n')
  + '\n# Enable the configured runtime, but do not poll GitHub on first install.\n- id: dsh-superagent\n  disabled: false\n- id: dsh-superagent-github\n  disabled: true\n';
mkdirSync(out, { recursive: true });
execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', out], { cwd: root, stdio: 'inherit' });
const tarball = `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`;
if (!existsSync(join(out, tarball))) throw new Error('npm pack did not produce the expected tarball');
const bundle = join(out, 'desktop-wsl-profile');
mkdirSync(bundle);
mkdirSync(join(bundle, 'locale'));
copyFileSync(join(out, tarball), join(bundle, tarball));
copyFileSync(join(root, 'icon.svg'), join(bundle, 'icon.svg'));
writeFileSync(join(bundle, 'README.md'), '# Superagent WSL 本地桌面配置\n\n实验适配配置，不是上游正式发行版。Windows Host 管理工单和状态，WSL 执行命令。\n\n首次安装禁用 GitHub watcher；先暂停 processing，再配置账号、来源、单 worker 与最小白名单。飞书和子代理委派不启用。\n\n不得用同账号自 @ 冒充接单验收；实际 GitHub 评论、推送或 PR 验证需另行确认。不得复制模型密钥。\n\n适配主包包含 WSL-ADAPTER 说明；本地目录安装可能保留链接，请勿删除或移动此配置目录及内嵌 tgz。本配置包的发行版、用户和路径为生成时的本机配置，公司必须重新生成和验收。\n');
writeFileSync(join(bundle, 'cordis.patch.yml'), patch);
writeFileSync(join(bundle, 'package.json'), JSON.stringify({
  name: '@local/dsh-superagent-wsl-desktop', version: manifest.version, private: true, type: 'module',
  description: 'Local Windows Desktop configuration for Superagent WSL execution; starts with the GitHub watcher disabled.',
  license: 'MIT', engines: manifest.engines,
  exports: { './locale/*.json': './locale/*.json', './icon': './icon.svg' },
  files: ['cordis.patch.yml', 'locale', 'icon.svg', 'README.md', tarball],
  dependencies: { 'dsh-superagent': 'file:./' + tarball, 'dsh-wsl-workspace': '0.7.13' },
  dsh: { bundle: { patch: './cordis.patch.yml' } }
}, null, 2) + '\n');
for (const [language, title, description] of [
  ['zh', 'Superagent WSL 桌面配置', '本地实验适配配置：Windows 管理、WSL 执行。首次安装禁用 GitHub watcher；先暂停处理再配置来源。不会复制模型密钥，不启用飞书或自动合并。'],
  ['en', 'Superagent WSL desktop setup', 'Local experimental Windows Host / WSL execution configuration. The GitHub watcher starts disabled; pause processing before configuring sources. No model credentials are copied.']
]) writeFileSync(join(bundle, 'locale', language + '.json'), JSON.stringify({ meta: { title, description } }, null, 2) + '\n');
console.log('Configuration bundle:', bundle);
console.log('Only files were generated. Install using DSH plugin_manager; no profile, credentials or runtime state was modified.');
