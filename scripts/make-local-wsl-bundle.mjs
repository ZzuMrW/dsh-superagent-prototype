#!/usr/bin/env node
/** Build one machine-configured tarball in a new owned directory. Never activate it or write a profile/state. */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, resolve, join, relative, isAbsolute, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keys = ['out', 'state-dir', 'distro', 'user', 'work-root'];
const clean = value => typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
const drivePath = value => /^[A-Za-z]:[\\/]/.test(value);
const uncPath = value => /^\\\\[^\\]+\\[^\\]+/.test(value);
const windowsArtifactPath = value => drivePath(value) || uncPath(value) && !/^\\\\(?:wsl\$|wsl\.localhost)\\/i.test(value);

export function parseOptions(argv) {
  const options = Object.create(null);
  for (const item of argv) {
    const match = /^--([a-z-]+)=(.*)$/s.exec(item);
    if (!match || !keys.includes(match[1])) throw new Error('Use only --out=... --state-dir=... --distro=... --user=... --work-root=...');
    if (Object.hasOwn(options, match[1])) throw new Error('Duplicate --' + match[1]);
    if (!clean(match[2])) throw new Error('Empty or control-character option: ' + match[1]);
    options[match[1]] = match[2];
  }
  for (const key of keys) if (!options[key]) throw new Error('Missing --' + key);
  // SQLite runtime state must be local Windows storage; build artifacts have no SQLite restriction.
  if (!drivePath(options['state-dir']) || /(^|[\\/])\.\.([\\/]|$)|[<>"|?*]/.test(options['state-dir']) || options['state-dir'].slice(2).includes(':'))
    throw new Error('state-dir must be an absolute local Windows drive path, not UNC/device/relative storage');
  // Match runtime target syntax, without pretending to diagnose registration, identity or filesystem locality here.
  options.distro = options.distro.trim(); options.user = options.user.trim(); options['work-root'] = options['work-root'].trim();
  if (!options.distro || options.distro.startsWith('-') || /[\x00-\x1f\x7f/\\]/.test(options.distro)) throw new Error('Invalid registered WSL distribution name');
  if (!options.user || options.user.startsWith('-') || /[\s\x00-\x1f\x7f/:\\]/.test(options.user)) throw new Error('Invalid Linux username');
  const workRoot = options['work-root'];
  if (/^\\\\/.test(workRoot)) {
    const wsl = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(\\.*)?$/i.exec(workRoot);
    if (!wsl || wsl[1].toLowerCase() !== options.distro.toLowerCase()) throw new Error('work-root must not be network or wrong-distro UNC storage');
  } else if (!workRoot.startsWith('/') && !drivePath(workRoot)) throw new Error('work-root must be an absolute Linux, local drive or same-distro WSL UNC candidate');
  if (!isAbsolute(options.out) && !windowsArtifactPath(options.out)) throw new Error('out must be an absolute Windows path or its real WSL mount path');
  return options;
}

/** No shell: wslpath receives each user path as one argv item, including spaces and shell metacharacters. */
export function systemPathConverter(mode, path) {
  return execFileSync('wslpath', [mode, path], { encoding: 'utf8' }).trim();
}
export function resolveLocations(options, convert = systemPathConverter) {
  const out = resolve(windowsArtifactPath(options.out) ? convert('-u', options.out) : options.out);
  const windowsOut = convert('-w', out);
  if (!windowsArtifactPath(windowsOut)) throw new Error('Output must map through real wslpath to stable Windows storage, not the distro filesystem');
  const parent = realpathSync(dirname(out));
  // Reject symlink aliases back into the guest or a protected profile/state location.
  const physicalOut = join(parent, relative(dirname(out), out));
  const physicalWindows = convert('-w', physicalOut);
  if (!windowsArtifactPath(physicalWindows)) throw new Error('Output parent does not map to Windows storage');
  const parts = physicalWindows.toLowerCase().split(/[\\/]+/);
  if (parts.some(part => ['.dsh', '.credentials', '.artifacts-state'].includes(part))) throw new Error('Output cannot be inside a profile/credentials directory');
  const state = win32.normalize(options['state-dir']).toLowerCase(), artifact = win32.normalize(physicalWindows).toLowerCase();
  const nested = (base, target) => target === base || target.startsWith(base.replace(/[\\/]$/, '') + '\\');
  if (nested(state, artifact) || nested(artifact, state)) throw new Error('Artifact output and runtime state directories must not overlap');
  for (const key of ['DSH_PROFILE_DIR', 'DSH_HOME', 'DSH_AGENTS_HOME']) {
    const profile = process.env[key];
    if (!profile) continue;
    if (windowsArtifactPath(profile) && nested(win32.normalize(profile).toLowerCase(), artifact)
      || isAbsolute(profile) && (physicalOut === resolve(profile) || physicalOut.startsWith(resolve(profile) + '/')))
      throw new Error('Output cannot be inside a profile or instruction/skill home');
  }
  if (existsSync(out)) throw new Error('Refuse to overwrite an existing output directory');
  return { out, windowsOut: physicalWindows };
}

export function machinePatch(original, options) {
  const anchor = '    - id: dsh-superagent\n      name: dsh-superagent\n';
  if (original.split(anchor).length !== 2) throw new Error('Expected exactly one runtime declaration');
  const start = original.indexOf(anchor), next = original.indexOf('    - id:', start + anchor.length);
  const row = original.slice(start, next < 0 ? original.length : next);
  if (!/^      disabled: true$/m.test(row) || /^      config:/m.test(row)) throw new Error('Source runtime must be unconfigured and disabled');
  const config = { stateDir: options['state-dir'], wsl: { distro: options.distro, user: options.user, workRoot: options['work-root'] } };
  const configured = row.replace('      disabled: true', '      disabled: false\n      config: ' + JSON.stringify(config));
  const patch = original.slice(0, start) + configured + original.slice(start + row.length);
  for (const id of ['dsh-superagent-github', 'dsh-superagent-feishu']) {
    const source = patch.slice(patch.indexOf('    - id: ' + id + '\n')).split(/\n    - id:/)[0];
    if (!/^      disabled: true$/m.test(source)) throw new Error('Source must remain disabled: ' + id);
  }
  return patch;
}

function inventory(sourceRoot, manifest) {
  const result = new Set(['package.json']);
  const forbidden = path => path.split('/').some(part => part.startsWith('.') || /^(?:node_modules|state|swap)$/i.test(part)) || /\.(?:tgz|swp|swo|sqlite(?:-wal|-shm)?|db|env)$/i.test(path);
  function add(path) {
    if (forbidden(path)) return;
    const absolute = resolve(sourceRoot, path), rel = relative(sourceRoot, absolute);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Manifest path escapes package: ' + path);
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) throw new Error('Refuse symlink in package resources: ' + path);
    if (info.isDirectory()) for (const name of readdirSync(absolute)) add(path + '/' + name);
    else if (info.isFile()) result.add(path);
  }
  for (const pattern of manifest.files ?? []) {
    if (pattern.endsWith('/*.json')) {
      const dir = pattern.slice(0, -7);
      for (const name of readdirSync(join(sourceRoot, dir))) if (name.endsWith('.json')) add(dir + '/' + name);
    } else {
      if (/[*?!]/.test(pattern)) throw new Error('Unsupported package resource glob: ' + pattern);
      if (!existsSync(join(sourceRoot, pattern))) throw new Error('Package resource missing: ' + pattern);
      add(pattern);
    }
  }
  for (const file of ['README.md', 'LICENSE']) if (existsSync(join(sourceRoot, file))) add(file);
  return [...result].sort();
}

export function generateBundle(options, { sourceRoot = root, convert = systemPathConverter, pack } = {}) {
  const locations = resolveLocations(options, convert);
  const manifest = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8'));
  if (manifest.name !== 'dsh-superagent' || manifest.version !== '0.2.0-wsl.5') throw new Error('Unexpected package identity/version');
  if (manifest.dependencies?.['dsh-superagent'] || manifest.dependencies?.['dsh-wsl-workspace']) throw new Error('A single bundle cannot nest a main bundle or workspace adapter');
  if (Object.values(manifest.dependencies ?? {}).some(value => /^(?:file:|link:|workspace:)/.test(value))) throw new Error('A release tarball cannot depend on local/nested packages');
  const files = inventory(sourceRoot, manifest);
  for (const file of ['cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'lib/wsl-shell.js', 'lib/wsl-fs.js', 'lib/wsl-tools.js', 'lib/wsl-context.js', 'lib/workspace-files.js', 'lib/file-references.js',
    'lib/wsl-context.d.ts', 'lib/workspace-files.d.ts', 'lib/file-references.d.ts'])
    if (!files.includes(file)) throw new Error('Build output missing: ' + file);
  const patch = machinePatch(readFileSync(join(sourceRoot, 'cordis.patch.yml'), 'utf8'), options);
  // Exclusive mkdir is the final race-safe no-overwrite guard; only this new directory is ever written.
  mkdirSync(locations.out);
  const stage = join(locations.out, 'package'); mkdirSync(stage);
  for (const file of files) {
    const target = join(stage, file); mkdirSync(dirname(target), { recursive: true });
    if (file === 'cordis.patch.yml') writeFileSync(target, patch, { flag: 'wx' });
    else copyFileSync(join(sourceRoot, file), target, 1 /* COPYFILE_EXCL */);
  }
  const args = ['pack', '--ignore-scripts', '--cache', join(locations.out, '.npm-cache'), '--pack-destination', locations.out];
  if (pack) pack(stage, args);
  else execFileSync('npm', args, { cwd: stage, stdio: 'inherit', shell: false });
  const tarball = join(locations.out, 'dsh-superagent-' + manifest.version + '.tgz');
  if (!existsSync(tarball)) throw new Error('npm pack did not produce the expected single tarball');
  return { ...locations, tarball, stage };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.platform !== 'linux') throw new Error('Run this script inside the WSL/Linux checkout, not Windows Node');
  const result = generateBundle(parseOptions(process.argv.slice(2)));
  console.log('Single self-contained tarball:', result.tarball);
  console.log('Windows artifact directory:', result.windowsOut);
  console.log('Only a new owned output directory was written. No install, profile, login, credentials, GitHub, model or processing state was changed.');
}
