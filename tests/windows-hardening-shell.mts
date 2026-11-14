/** Explicit Windows-only component acceptance. No argv translation, profile install, tools/jobs mocks, or model calls.
 * Bundle this entry alone (ESM, @deepseek-ai/* external to verified installed import entrypoints),
 * then run using installed Electron with ELECTRON_RUN_AS_NODE=1 and required DSH_SUPERAGENT_TEST_ROOT.
 * The root must be an existing local-drive windows-shell directory under a superagent-hardening- prefixed parent, with
 * .dsh-superagent-shell-test-root containing dsh-superagent-windows-shell-test-root-v1. No root default.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { ShellExecution } from '@deepseek-ai/dsh-shell'
import SuperagentWslShell, { assertWslShellHealthy, disposeWslShellExecutions } from '../src/wsl-shell.ts'
import { registerWslExecution } from '../src/app/wsl-world.ts'
import { environmentSnapshot, freezeExecutionSnapshot, freezeTarget } from '../src/execution/target.ts'
import { WorkspacePathMapper } from '../src/execution/path-mapper.ts'
import { runWsl } from '../src/infra/wsl.ts'

type Evidence = Record<string, unknown>
const results: { name: string; status: 'pass' | 'fail'; milliseconds: number; evidence?: Evidence; error?: string }[] = []
const configuredRoot = process.env.DSH_SUPERAGENT_TEST_ROOT
assert.ok(configuredRoot, 'DSH_SUPERAGENT_TEST_ROOT is required; no implicit test root is allowed')
assert.match(configuredRoot, /^[A-Za-z]:[\\/]/, 'Test root must be an absolute local Windows drive path, not UNC/device/relative')
assert.ok(!/[\x00-\x1f<>:"|?*]/.test(configuredRoot.slice(2)), 'Invalid Windows test-root coordinate')
const testRoot = win32.normalize(configuredRoot)
assert.equal(win32.basename(testRoot).toLowerCase(), 'windows-shell', 'Test root must use the owned windows-shell basename')
assert.ok(win32.basename(win32.dirname(testRoot)).toLowerCase().startsWith('superagent-hardening-'), 'Test root must use an owned superagent-hardening- parent')
// Preserve the historical positional argv shape, but argv never supplies/defaults the trusted root.
if (process.argv[2]) assert.equal(win32.normalize(process.argv[2]).toLowerCase(), testRoot.toLowerCase(), 'Positional root conflicts with DSH_SUPERAGENT_TEST_ROOT')
const distro = process.argv[3]!
const attempt = process.argv[4] ?? 'attempt-03'
const evidenceRoot = join(testRoot, 'evidence', attempt)
const rootMarker = '.dsh-superagent-shell-test-root'
const rootMarkerValue = 'dsh-superagent-windows-shell-test-root-v1'
let rootVerified = false
const started = new Date().toISOString()
const environmentBefore = { ...process.env }
const hostPathBefore = process.env.PATH ?? process.env.Path
function report() {
  assert.ok(rootVerified, 'Refusing evidence writes before test-root ownership verification')
  const payload = { scope: 'Windows public LocalSubprocessRuntime + candidate owned Shell component acceptance; NOT installed full Runtime acceptance',
    started, finished: new Date().toISOString(), runtime: { platform: process.platform, node: process.version, electron: process.versions.electron,
      executable: process.execPath, shellVersion: '0.2.2-rc.3', subprocessVersion: '0.2.2-rc.3' }, distro, results }
  mkdirSync(evidenceRoot, { recursive: true })
  writeFileSync(join(evidenceRoot, 'report.json'), JSON.stringify(payload, null, 2))
}
async function check(name: string, work: () => Promise<Evidence | void>) {
  const begin = performance.now()
  try {
    const evidence = await work()
    results.push({ name, status: 'pass', milliseconds: Math.round(performance.now() - begin), ...evidence ? { evidence } : {} })
    console.log('PASS ' + name)
  } catch (error) {
    const text = error instanceof Error ? error.stack ?? error.message : String(error)
    results.push({ name, status: 'fail', milliseconds: Math.round(performance.now() - begin), error: text })
    console.error('FAIL ' + name + '\n' + text)
  }
  report()
}
async function until(predicate: () => boolean, message: string, timeout = 12000) {
  const deadline = performance.now() + timeout
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(message)
    await delay(40)
  }
}
const digest = (input: string) => createHash('sha256').update(input).digest('hex')
async function fixture(user: string, expectedUid: number) {
  const machine = { stateDir: testRoot, wsl: { distro, user, workRoot: '/tmp' } }
  const rpc = (argv: string[], fields: Record<string, unknown> = {}) => runWsl(machine,
    { argv, cwd: '/', timeoutMs: 15000, maxBuffer: 1024 * 1024, signal: AbortSignal.timeout(25000), ...fields })
  const facts = JSON.parse(await rpc(['python3', '-c',
    'import os,pwd,json; p=pwd.getpwuid(os.getuid()); print(json.dumps({"uid":os.getuid(),"user":p.pw_name,"home":p.pw_dir,"bootId":open("/proc/sys/kernel/random/boot_id").read().strip(),"PATH":os.environ["PATH"]}))']))
  assert.equal(facts.uid, expectedUid)
  assert.equal(facts.user, user)
  assert.equal(facts.home, expectedUid === 0 ? '/root' : '/home/dsh-worker')
  const guestCwd = `/tmp/dsh-shell-acceptance-${randomUUID()}`
  await rpc(['python3', '-c', 'import os,sys;os.mkdir(sys.argv[1],0o700)', guestCwd])
  const hostCwd = (await rpc(['wslpath', '-a', '-w', guestCwd])).trim()
  assert.equal(statSync(hostCwd).isDirectory(), true)
  const target = freezeTarget({ distro: distro!, user, uid: expectedUid, home: facts.home, bootId: facts.bootId },
    { input: guestCwd, guestPath: guestCwd, hostPath: hostCwd, storage: 'guest-local', evidence: { converter: 'wslpath', hostRegistration: 'verified' } },
    'windows-test-' + randomUUID(), new Date().toISOString())
  const snapshot = freezeExecutionSnapshot(1, target, environmentSnapshot({ HOME: facts.home, USER: user, LOGNAME: user,
    PATH: '/usr/bin:/bin', GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GIT_DIR: undefined }))
  const mapper = new WorkspacePathMapper({ distro: distro! }, { guest: (argv, signal) => rpc(argv, { signal }),
    host: async () => { throw new Error('Host workspace diagnostics are not needed for guestPath mapping') } })
  const sessionId = 'windows-shell-' + randomUUID()
  const owned = new Set<ShellExecution>(), cleanupErrors: unknown[] = []
  const unbind = registerWslExecution(sessionId, { machine: machine as never, snapshot, guestCwd, hostCwd,
    env: {}, mapPath: (path, signal, cwd) => mapper.guestPath(path, cwd ?? guestCwd, signal ?? AbortSignal.timeout(15000)),
    control: (script, nonce) => rpc(['python3', '-c', script, nonce], { expectedIdentity: { uid: expectedUid, bootId: facts.bootId } }),
    ownExecution: (execution, diagnostics) => {
      owned.add(execution)
      return () => { if (diagnostics?.cleanupError() !== undefined) cleanupErrors.push(diagnostics.cleanupError()); owned.delete(execution) }
    } })
  const ctx = new Context()
  // This is the installed PUBLIC provider, on Windows, unmodified and with its real Win32 range backend.
  new LocalSubprocessRuntime(ctx)
  const fiber = await ctx.plugin(SuperagentWslShell, { graceMs: 250, maxOutputBytes: 4096 })
  const execute = (command: string, extra: Record<string, unknown> = {}) => ctx.shell.execute(ctx.shell.resolve({
    command, dshEnv: { DSH_SESSION_ID: sessionId }, onExpiry: 'none', timeoutMs: 1000, ...extra }))
  const verifyGone = async (pid: number, nonce: string) => {
    const state = JSON.parse(await rpc(['python3', '-c',
      'import os,sys,json;print(json.dumps({"pidExists":os.path.exists("/proc/"+sys.argv[1]),"nonceExists":os.path.exists("/tmp/dsh-shell-"+sys.argv[2])}))', String(pid), nonce]))
    assert.deepEqual(state, { pidExists: false, nonceExists: false })
    return state
  }
  const waitReady = async (execution: ShellExecution) => {
    await until(() => /READY (\d+) ([\w-]+)/.test(execution.observed.stdout.readFrom(0).text), 'Guest READY missing')
    const [, pid, nonce] = /READY (\d+) ([\w-]+)/.exec(execution.observed.stdout.readFrom(0).text)!
    return { pid: Number(pid), nonce: nonce! }
  }
  return { ctx, fiber, execute, rpc, target, sessionId, guestCwd, hostCwd, mapper, owned, cleanupErrors, waitReady, verifyGone,
    async dispose() {
      try {
        await disposeWslShellExecutions(sessionId)
        assertWslShellHealthy(sessionId)
        assert.equal(owned.size, 0)
        assert.equal(cleanupErrors.length, 0)
      } finally {
        await ctx.fiber.dispose()
        unbind()
        await rpc(['python3', '-c', 'import os,sys;os.rmdir(sys.argv[1])', guestCwd])
      }
    } }
}
const sleeping = `trap '' TERM; sleep 60 & echo "READY $! $DSH_SHELL_NONCE"; wait`
async function identitySuite(user: string, uid: number) {
  const f = await fixture(user, uid)
  try {
    await check(`${user}: explicit UID/home/boot/cwd and protected guest environment`, async () => {
      const execution = await f.execute(`python3 -c 'import os,pwd,json; p=pwd.getpwuid(os.getuid()); print(json.dumps({"uid":os.getuid(),"home":os.environ["HOME"],"canonicalHome":p.pw_dir,"user":os.environ["USER"],"cwd":os.getcwd(),"PATH":os.environ["PATH"],"githubInherited":any(k in os.environ for k in ["GH_TOKEN","GITHUB_TOKEN"]),"bootId":open("/proc/sys/kernel/random/boot_id").read().strip()}))'`,
        { env: { HOME: '/must-not-win', USER: 'must-not-win', PATH: 'C:\\must-not-win', GH_TOKEN: 'synthetic-not-a-credential' } })
      const result = await execution.result()
      assert.equal(result.exitCode, 0)
      const observed = JSON.parse(result.stdout.text)
      assert.deepEqual(observed, { uid, home: f.target.home, canonicalHome: f.target.home, user, cwd: f.guestCwd,
        PATH: '/usr/bin:/bin', githubInherited: false, bootId: f.target.bootId })
      return { ...observed, metadataCanonical: true, bootstrapBootMatchesSnapshot: true }
    })
    await check(`${user}: custom automount mapping uses real wslpath`, async () => {
      const mapped = await f.mapper.guestPath(testRoot, f.guestCwd, AbortSignal.timeout(15000))
      assert.match(mapped, /^\/windows\/d\//)
      const execution = await f.execute('pwd', { workdir: testRoot })
      assert.equal((await execution.result()).stdout.text.trim(), mapped)
      return { mapped, customAutomount: '/windows/' }
    })
    await check(`${user}: streaming before completion, independent cursors and >5s none background lifetime`, async () => {
      const start = performance.now()
      const execution = await f.execute('printf STREAM_ONE; sleep .4; printf STREAM_TWO; sleep 10', { timeoutMs: 10 })
      await until(() => execution.observed.stdout.readFrom(0).text.includes('STREAM_ONE'), 'First streaming output missing')
      assert.equal(execution.status, 'running')
      const first = execution.readOutput()
      assert.ok(first.delta.includes('STREAM_ONE'))
      await until(() => execution.observed.stdout.readFrom(0).text.includes('STREAM_TWO'), 'Second streaming output missing')
      await delay(Math.max(0, 5200 - (performance.now() - start)))
      assert.equal(execution.status, 'running')
      assert.ok(execution.observed.stdout.readFrom(0).text.includes('STREAM_ONE'))
      assert.equal(execution.kill(), true)
      assert.equal(execution.kill(), false)
      await execution.done
      const result = await execution.result()
      assert.equal(result.timedOut, false); assert.equal(result.aborted, false)
      assert.equal(execution.status, 'killed')
      assert.equal(execution.readOutput().delta, first.delta.includes('STREAM_TWO') ? '' : 'STREAM_TWO')
      assert.equal(execution.readOutput().delta, '')
      return { foregroundWaitMs: Math.round(performance.now() - start), statusAfterFiveSeconds: 'running', output: result.stdout.text }
    })
    await check(`${user}: large command and 512KiB stdin survive actual Windows argv boundary`, async () => {
      const input = 'x'.repeat(512 * 1024)
      const command = `python3 -c 'import sys,hashlib,json,os; x=sys.stdin.buffer.read(); print(json.dumps([len(x),hashlib.sha256(x).hexdigest(),os.environ["LITERAL"]]))' #${' long-comment-$HOME-quotes'.repeat(9000)}`
      const literal = `quote ' " $HOME\nsecond line`
      const execution = await f.execute(command, { stdin: input, env: { LITERAL: literal } })
      const result = await execution.result()
      assert.equal(result.exitCode, 0)
      assert.deepEqual(JSON.parse(result.stdout.text), [input.length, digest(input), literal])
      return { commandBytes: Buffer.byteLength(command), stdinBytes: input.length, digest: digest(input), windowsCommandLineContainsPayload: false }
    })
    await check(`${user}: manual kill reaps guest descendants and removes exact nonce`, async () => {
      const execution = await f.execute(sleeping)
      const { pid, nonce } = await f.waitReady(execution)
      assert.equal(execution.kill(), true)
      await execution.done
      const result = await execution.result()
      assert.equal(result.timedOut, false); assert.equal(result.aborted, false)
      return { ...await f.verifyGone(pid, nonce), status: execution.status }
    })
    await check(`${user}: real deadline is first-cause timeout with confirmed cleanup`, async () => {
      const execution = await f.execute(sleeping, { onExpiry: 'kill', timeoutMs: 2500 })
      const { pid, nonce } = await f.waitReady(execution)
      const result = await execution.result()
      assert.equal(result.timedOut, true); assert.equal(result.aborted, false)
      return { ...await f.verifyGone(pid, nonce), timedOut: result.timedOut, aborted: result.aborted }
    })
    await check(`${user}: caller abort under none is not classified as timeout`, async () => {
      const abort = new AbortController()
      const execution = await f.execute(sleeping, { signal: abort.signal, timeoutMs: 10 })
      const { pid, nonce } = await f.waitReady(execution)
      abort.abort(new Error('isolated acceptance cancellation'))
      const result = await execution.result()
      assert.equal(result.timedOut, false); assert.equal(result.aborted, true)
      return { ...await f.verifyGone(pid, nonce), timedOut: result.timedOut, aborted: result.aborted }
    })
    await check(`${user}: collected tails spill through public subprocess provider`, async () => {
      const execution = await f.execute(`python3 -c 'import sys;sys.stdout.write("x"*100000);sys.stderr.write("y"*80000)'`)
      const result = await execution.result()
      assert.equal(result.stdout.truncated, true); assert.equal(result.stderr.truncated, true)
      assert.equal(readFileSync(result.stdout.spillPath!, 'utf8'), 'x'.repeat(100000))
      assert.equal(readFileSync(result.stderr.spillPath!, 'utf8'), 'y'.repeat(80000))
      return { stdoutTailBytes: Buffer.byteLength(result.stdout.text), stderrTailBytes: Buffer.byteLength(result.stderr.text),
        stdoutSpillBytes: statSync(result.stdout.spillPath!).size, stderrSpillBytes: statSync(result.stderr.spillPath!).size }
    })
    await check(`${user}: executor-only reload preserves live process, composition teardown confirms guest exit`, async () => {
      const execution = await f.execute(sleeping)
      const { pid, nonce } = await f.waitReady(execution)
      await f.fiber.dispose()
      assert.equal(execution.status, 'running')
      assert.equal(f.owned.has(execution), true)
      await disposeWslShellExecutions(f.sessionId)
      await f.ctx.fiber.dispose()
      assert.equal(execution.status, 'killed')
      assert.equal(f.owned.size, 0)
      return { ...await f.verifyGone(pid, nonce), survivesExecutorReload: true, ownerCountAfterCompositionDispose: f.owned.size }
    })
  } finally { await f.dispose() }
}
async function main() {
  assert.equal(process.platform, 'win32', 'Acceptance MUST use real Windows, never Linux wsl argv translation')
  assert.ok(process.versions.electron, 'Use the verified installed Electron ASAR-aware runtime')
  assert.equal(distro, 'DSH-Superagent-Test', 'Refusing production/default distribution')
  assert.match(attempt, /^attempt-\d+$/, 'Refusing unsafe evidence directory')
  assert.equal(statSync(testRoot).isDirectory(), true)
  const canonicalRoot = realpathSync.native(testRoot)
  assert.match(canonicalRoot, /^[A-Za-z]:[\\/]/, 'Refusing a test root redirected to UNC/device storage')
  assert.equal(win32.normalize(canonicalRoot).toLowerCase(), testRoot.toLowerCase(), 'Refusing a redirected/noncanonical test root')
  const markerPath = join(testRoot, rootMarker)
  assert.equal(lstatSync(markerPath).isFile(), true, 'Owned test-root marker must be a regular file, not a link')
  assert.equal(readFileSync(markerPath, 'utf8').trim(), rootMarkerValue, 'Owned test-root marker is missing or invalid')
  rootVerified = true
  mkdirSync(join(testRoot, 'evidence'), { recursive: true })
  await check('installed public Windows runtime loads and manages an ordinary Host process', async () => {
    const ctx = new Context()
    new LocalSubprocessRuntime(ctx)
    try {
      const host = ctx.subprocess.spawn({ argv: [process.execPath, '-e', 'console.log("HOST_PUBLIC_RUNTIME_OK "+process.platform)'], cwd: testRoot,
        env: { ELECTRON_RUN_AS_NODE: '1' }, graceMs: 250, stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } })
      const outcome = await host.done
      assert.equal(outcome.exitCode, 0)
      assert.equal(await host.waitForExit(AbortSignal.timeout(10000)), true)
      const output = host.collected.stdout!.readFrom(0).text.trim()
      assert.equal(output, 'HOST_PUBLIC_RUNTIME_OK win32')
      const defaultGuest = ctx.subprocess.spawn({ argv: ['wsl.exe', '-d', distro, '-e', 'id', '-u'], cwd: testRoot,
        graceMs: 250, stdio: { stdin: 'ignore', stdout: { maxBytes: 32 }, stderr: { maxBytes: 4096 } } })
      assert.equal((await defaultGuest.done).exitCode, 0)
      assert.equal(defaultGuest.collected.stdout!.readFrom(0).text.trim(), '0')
      const warnings = ctx.logger.buffer.filter(message => message.type === 'warn').map(message => message.args.map(String).join(' '))
      assert.equal(warnings.some(message => /weaker process-tree containment|Win32 Job runner is unavailable/.test(message)), false,
        'Native Win32 Job backend not verified: ' + warnings.join('\n'))
      return { output, managedRangeExitConfirmed: true, provider: 'installed @deepseek-ai/dsh-subprocess-local@0.2.2-rc.3',
        nativeWin32FallbackWarning: false, providerWarnings: warnings, defaultTestDistroUidBeforeBindings: 0 }
    } finally { await ctx.fiber.dispose() }
  })
  if (results.some(result => result.status === 'fail')) throw new Error('Actual Windows public subprocess backend could not be verified; refusing fake fallback')
  for (const [user, uid] of [['root', 0], ['dsh-worker', 1000]] as const) {
    await check(`${user}: suite lifecycle`, async () => { await identitySuite(user, uid) })
  }
  await check('ordinary Host environment is unchanged by guest binding/command env', async () => {
    assert.deepEqual({ ...process.env }, environmentBefore)
    assert.equal(process.env.PATH ?? process.env.Path, hostPathBefore)
    const ctx = new Context()
    new LocalSubprocessRuntime(ctx)
    try {
      const host = ctx.subprocess.spawn({ argv: [process.execPath, '-e', 'console.log(JSON.stringify({platform:process.platform,path:process.env.PATH,guest:process.env.DSH_WSL_DISTRO??null}))'],
        cwd: testRoot, env: { ELECTRON_RUN_AS_NODE: '1' }, graceMs: 250,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 64000 }, stderr: { maxBytes: 4096 } } })
      assert.equal((await host.done).exitCode, 0)
      const observed = JSON.parse(host.collected.stdout!.readFrom(0).text)
      assert.deepEqual(observed, { platform: 'win32', path: hostPathBefore, guest: null })
      const guest = ctx.subprocess.spawn({ argv: ['wsl.exe', '-d', distro, '-e', 'id', '-u'], cwd: testRoot,
        graceMs: 250, stdio: { stdin: 'ignore', stdout: { maxBytes: 32 }, stderr: { maxBytes: 4096 } } })
      assert.equal((await guest.done).exitCode, 0)
      assert.equal(guest.collected.stdout!.readFrom(0).text.trim(), '0')
      return { environmentUnchanged: true, hostPathUnchanged: true, ordinaryHostProcessAfterBindings: 'win32', defaultTestDistroUidAfterBindings: 0 }
    } finally { await ctx.fiber.dispose() }
  })
  report()
  if (results.some(result => result.status === 'fail')) process.exitCode = 1
}
main().catch(error => {
  console.error(error)
  results.push({ name: 'fatal acceptance preparation', status: 'fail', milliseconds: 0, error: error instanceof Error ? error.stack : String(error) })
  if (rootVerified) report()
  process.exitCode = 1
})
