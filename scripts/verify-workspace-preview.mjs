#!/usr/bin/env node
/** Isolated Windows SDK → strict Gateway → built adapter → real Host/WSL files.
 * No DSH server/profile, browser, credentials, model, Source or business DB is opened.
 * The execution registry is a synthetic trusted fixture, not a full Runtime claim.
 */
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--(install-anchor|distro|user)=(.+)$/.exec(arg);
  if (!match) throw new Error('Use --install-anchor=<DSH package.json> --distro=<registered distro> --user=<test user>');
  return [match[1], match[2]];
}));
assert.equal(process.platform, 'win32', 'Use the installed Windows Electron/Node runtime');
for (const key of ['install-anchor', 'distro', 'user']) assert.ok(options[key], 'Missing ' + key);
assert.ok(!options.distro.startsWith('-') && !/[\x00-\x1f\x7f/\\]/.test(options.distro), 'Invalid distro');
assert.ok(!options.user.startsWith('-') && !/[\s\x00-\x1f\x7f/:\\]/.test(options.user), 'Invalid user');
const installed = createRequire(resolve(options['install-anchor']));
const cli = installed('./package.json');
assert.equal(cli.name, '@deepseek-ai/dsh');
assert.equal(cli.version, '0.2.2-rc.5');
// Model Core's installed-peer resolution for this standalone verification process.
// There are no machine paths in the production adapter; the test anchor is explicit.
const builtRoot = new URL('../lib/', import.meta.url).href;
let resolvingInstalled = false;
function resolveInstalled(specifier) {
  const previous = resolvingInstalled;
  try { resolvingInstalled = true; return installed.resolve(specifier); }
  finally { resolvingInstalled = previous; }
}
const hooks = registerHooks({ resolve(specifier, context, next) {
  // Only redirect the candidate's own ESM peer imports. ASAR/CJS dependencies
  // retain their native resolution; require.resolve is never handed a file URL.
  if (!specifier.startsWith('@deepseek-ai/') || resolvingInstalled || !context.parentURL?.startsWith(builtRoot)) return next(specifier, context);
  return { url: pathToFileURL(resolveInstalled(specifier)).href, shortCircuit: true };
} });
const load = name => import(pathToFileURL(resolveInstalled(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { TypertRegistry } = await load('@deepseek-ai/dsh-typert-registry');
const { TypertGatewayService } = await load('@deepseek-ai/dsh-api-gateway');
const localModule = await load('@deepseek-ai/dsh-fs-local');
const LocalFileSystem = localModule.LocalFileSystem ?? localModule.default;
const { default: WorkspaceFiles, configureWorkspaceSessionRegistry } = await import('../lib/workspace-files.js');
const { configureGuestFsResolver } = await import('../lib/wsl-fs.js');
const token = randomUUID();
const prefix = 'dsh-preview-verification-';
const hostRoot = await mkdtemp(join(tmpdir(), prefix));
const guestRoot = '/tmp/' + prefix + token;
const ctx = new Context();
const controller = new AbortController();
const releases = [];

function python(script, payload = '', signal) {
  return new Promise((accept, reject) => {
    const child = spawn('wsl.exe', ['-d', options.distro, '-u', options.user, '--', 'python3', '-c', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', error = '', failure;
    const stop = () => { failure ??= new Error('WSL fixture RPC cancelled or timed out'); child.kill(); };
    const timer = setTimeout(stop, 30000);
    if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', data => { out += data; if (out.length > 2 * 1024 * 1024) stop(); });
    child.stderr.on('data', data => { error += data; if (error.length > 65536) stop(); });
    child.stdin.on('error', () => {});
    child.on('error', err => { failure ??= err; });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop);
      if (failure || code !== 0) reject(failure ?? new Error(error || 'WSL fixture RPC failed: ' + code));
      else accept(out);
    });
    child.stdin.end(payload);
  });
}

try {
  await writeFile(join(hostRoot, '中文 space.md'), 'host:' + token + '\n');
  await writeFile(join(hostRoot, 'binary.bin'), new Uint8Array([0, 1, 2, 255]));
  await python(`import os,json,sys\np=json.load(sys.stdin)\nos.mkdir(p['root'])\nopen(os.path.join(p['root'],'fixture-owner'),'w').write(p['token'])\nopen(os.path.join(p['root'],'中文 space.md'),'w',encoding='utf-8').write('guest:'+p['token']+'\\n')\nopen(os.path.join(p['root'],'binary.bin'),'wb').write(bytes([3,0,255]))\n`, JSON.stringify({ root: guestRoot, token }));
  await ctx.plugin(TypertRegistry);
  await ctx.plugin(LocalFileSystem, { cwd: hostRoot });
  ctx.provide('sandboxPolicy', { workspaceRoot: hostRoot });
  const headers = {
    native: { agentPreset: 'standard', cwd: hostRoot },
    managed: { agentPreset: 'wsl-dsh-superagent-worker', cwd: guestRoot },
    'managed-stale': { agentPreset: 'wsl-dsh-superagent-worker', cwd: guestRoot },
  };
  ctx.provide('sessions', { get: id => headers[id] ? { header: headers[id] } : undefined });
  ctx.provide('remoteAccess', { decide: () => ({ kind: 'deny', reason: 'fixture-denied' }) });
  releases.push(configureWorkspaceSessionRegistry({ lookup: async id => id === 'managed'
    ? { kind: 'managed', record: { guestCwd: guestRoot } }
    : id.startsWith('managed') ? { kind: 'blocked' } : { kind: 'unmanaged' } }));
  releases.push(configureGuestFsResolver(id => id === 'managed' ? {
    identity: 'preview-' + token, cwd: guestRoot,
    transport: (script, payload, signal) => python(script, payload, signal),
  } : undefined));
  await ctx.plugin(TypertGatewayService, {});
  const service = await ctx.plugin(WorkspaceFiles, { maxBytes: 4096, maxFileBytes: 8192 });
  const peer = { id: token, ctx, principal: { kind: 'owner' }, signal: controller.signal, interactions: 'none', dispose: async () => {} };
  const request = (method, id, args, selected = peer) => ctx.typertGateway.invoke({ namespace: 'workspaceFiles', method, args: { workspaceFileScopeId: id, ...args }, peer: selected });
  const hostText = await request('read', 'native', { path: '中文 space.md', range: {} });
  const guestText = await request('read', 'managed', { path: '中文 space.md', range: {} });
  let currentGuestText = guestText.text;
  assert.equal(hostText.text.trim(), 'host:' + token);
  assert.equal(guestText.text.trim(), 'guest:' + token);
  assert.equal(guestText.absolutePath, guestRoot + '/中文 space.md');
  assert.equal((await request('read', 'native', { path: join(hostRoot, '中文 space.md'), range: {} })).text, hostText.text);
  assert.equal((await request('read', 'managed', { path: guestRoot + '/中文 space.md', range: {} })).text, guestText.text);
  assert.deepEqual(Array.from((await request('readBytes', 'native', { path: 'binary.bin', options: {} })).data), [0, 1, 2, 255]);
  assert.deepEqual(Array.from((await request('readBytes', 'managed', { path: 'binary.bin', options: {} })).data), [3, 0, 255]);
  await assert.rejects(request('read', 'native', { path: 42, range: {} }), error => error.code === 'gateway/input-invalid');
  await assert.rejects(request('read', 'managed-stale', { path: '中文 space.md', range: {} }), /unavailable or stale/);
  await assert.rejects(request('read', 'managed', { path: '中文 space.md', range: {} }, { ...peer, principal: { kind: 'verification-non-owner' } }), error => error.code === 'remote-access/denied');
  await assert.rejects(request('read', 'native', { path: 'missing-' + token, range: {} }), error => error.code === 'workspace-file/not-found');
  // Do not silently reinterpret a WSL path in a native Windows Session.
  await assert.rejects(request('read', 'native', { path: guestRoot + '/中文 space.md', range: {} }), error => error.code === 'workspace-file/not-found');
  const watch = await ctx.typertGateway.stream({ namespace: 'workspaceFiles', method: 'changes', args: { workspaceFileScopeId: 'managed', path: '中文 space.md' }, peer });
  await assert.rejects(watch[Symbol.asyncIterator]().next(), error => error.code === 'workspace-file/watch-unsupported' && error.details?.path === '中文 space.md');
  // Native change observation remains functional; managed files retain explicit
  // reread rather than silently falling back to Host watchers.
  const nativeWatchControl = new AbortController();
  const nativeWatch = await ctx.typertGateway.stream({ namespace: 'workspaceFiles', method: 'changes', args: { workspaceFileScopeId: 'native', path: '中文 space.md' }, peer, signal: nativeWatchControl.signal });
  const nativeIterator = nativeWatch[Symbol.asyncIterator]();
  const nextNative = async () => {
    const timeout = setTimeout(() => nativeWatchControl.abort(), 10000);
    try { return await nativeIterator.next(); }
    finally { clearTimeout(timeout); }
  };
  try {
    assert.equal((await nextNative()).value.kind, 'ready');
    await writeFile(join(hostRoot, '中文 space.md'), 'host-updated:' + token + '\n');
    assert.equal((await nextNative()).value.kind, 'change');
  } finally { nativeWatchControl.abort(); await nativeIterator.return?.(); }
  await python(`import json,sys,os\np=json.load(sys.stdin)\nassert open(os.path.join(p['root'],'fixture-owner')).read()==p['token']\nopen(os.path.join(p['root'],'中文 space.md'),'w',encoding='utf-8').write('guest-reloaded:'+p['token']+'\\n')\n`, JSON.stringify({ root: guestRoot, token }));
  currentGuestText = (await request('read', 'managed', { path: '中文 space.md', range: {} })).text;
  assert.equal(currentGuestText.trim(), 'guest-reloaded:' + token);
  await service.dispose();
  await assert.rejects(request('read', 'native', { path: '中文 space.md', range: {} }), /strict definition was withdrawn/);
  await ctx.plugin(WorkspaceFiles, { maxBytes: 4096, maxFileBytes: 8192 });
  assert.equal((await request('read', 'managed', { path: '中文 space.md', range: {} })).text, currentGuestText);
  console.log(JSON.stringify({ passed: true, sdk: cli.version, platform: process.platform,
    checks: ['strict Gateway', 'real Windows/WSL text+binary', 'Unicode and spaces', 'relative+absolute paths', 'invalid args', 'stale binding', 'access denial', 'missing file', 'cross-world path not remapped', 'managed watch refusal', 'native watch change', 'managed explicit reread', 'unload+reenable'],
    modelRequests: 0, serversStarted: 0, profileChanged: false, syntheticExecutionRegistry: true, browserVisualVerified: false }));
} finally {
  controller.abort();
  const cleanupErrors = [];
  const attempt = async work => { try { await work(); } catch (error) { cleanupErrors.push(error); } };
  await attempt(() => ctx.fiber.dispose());
  for (const release of releases.reverse()) await attempt(release);
  await attempt(() => python(`import os,json,sys,shutil\np=json.load(sys.stdin);r=p['root']\nif os.path.exists(r):\n assert r.startswith('/tmp/dsh-preview-verification-') and not os.path.islink(r)\n assert open(os.path.join(r,'fixture-owner')).read()==p['token']\n shutil.rmtree(r)\n`, JSON.stringify({ root: guestRoot, token })));
  await attempt(async () => {
    assert.ok(hostRoot.startsWith(join(tmpdir(), prefix)));
    await rm(hostRoot, { recursive: true });
  });
  hooks.deregister();
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Preview fixture cleanup did not fully complete');
}
