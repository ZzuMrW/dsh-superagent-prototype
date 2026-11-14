/** Real public subprocess provider and identical guest Python, translating only Windows wsl.exe argv. */
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { ShellExecution } from '@deepseek-ai/dsh-shell'
import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import type { Machine } from '../src/deployment.ts'
import { registerWslExecution } from '../src/app/wsl-world.ts'
import SuperagentWslShell, { assertWslShellHealthy, clearWslShellFailure, disposeWslShellExecutions, type WslShellBindingPort } from '../src/wsl-shell.ts'
import { MAX_WSL_SHELL_INPUT_BYTES, SHELL_CLEANUP, SHELL_MONITOR, serializeWslShellFrame, type WslShellFrame } from '../src/infra/wsl-shell-transport.ts'
import * as shellTransport from '../src/infra/wsl-shell-transport.ts'
import { environmentSnapshot, freezeExecutionSnapshot, freezeTarget } from '../src/execution/target.ts'
const linuxIt = it.skipIf(process.platform !== 'linux')
const disposers: (() => void | Promise<void>)[] = []
let serial = 0
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})
async function setup(options: { uid?: number; bootId?: string; mapPath?: WslShellBindingPort['mapPath']; env?: Record<string, string | undefined>; spawnError?: boolean; ownerControl?: boolean; failCleanup?: boolean; guestFrameCap?: number; assertCurrent?: WslShellBindingPort['assertCurrent']; resolveShellPolicy?: WslShellBindingPort['resolveShellPolicy'] } = {}) {
  const sessionId = `owned-public-shell-${++serial}`
  const target = freezeTarget({ distro: 'test-bound-distro', user: 'test-bound-user', uid: options.uid ?? process.getuid!(), home: '/root',
    bootId: options.bootId ?? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() },
    { input: '/tmp', guestPath: '/tmp', hostPath: String.raw`\\wsl.localhost\test-bound-distro\tmp`, storage: 'guest-local',
      evidence: { converter: 'wslpath', hostRegistration: 'verified' } }, 'generation-a', new Date().toISOString())
  const owners = new Set<ShellExecution>(), controls: string[] = []
  const diagnostics = new Map<ShellExecution, { cleanupError: () => unknown }>()
  const cleanupObservations: { status: ShellExecution['status']; error: unknown }[] = []
  let failCleanup = options.failCleanup ?? false
  const binding = { machine: { wsl: { distro: 'legacy-must-not-win', user: 'root' } } as Machine,
    snapshot: freezeExecutionSnapshot(3, target, environmentSnapshot({ HOME: '/root', USER: 'test-bound-user', LOGNAME: 'test-bound-user',
      PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/controlled/gitconfig', GIT_DIR: undefined, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, ...options.env })),
    guestCwd: '/tmp', env: {}, mapPath: options.mapPath, assertCurrent: options.assertCurrent, resolveShellPolicy: options.resolveShellPolicy, control: undefined as WslShellBindingPort['control'],
    ownExecution: (handle: ShellExecution, observation?: { cleanupError: () => unknown }) => {
      owners.add(handle)
      if (observation) diagnostics.set(handle, observation)
      return () => {
        cleanupObservations.push({ status: handle.status, error: observation?.cleanupError() })
        owners.delete(handle)
      }
    } }
  const ctx = new Context()
  new LocalSubprocessRuntime(ctx)
  const runtime = ctx.subprocess, spawn = runtime.spawn.bind(runtime)
  const requests: SubprocessSpawnSpec[] = []
  runtime.spawn = request => {
    requests.push(request)
    const split = request.argv.indexOf('-e')
    const argv = split < 0 ? [...request.argv] : request.argv.slice(split + 1)
    if (options.guestFrameCap && argv[2] === SHELL_MONITOR) argv[2] = SHELL_MONITOR.replace(`MAX_FRAME_BYTES=${MAX_WSL_SHELL_INPUT_BYTES}`, `MAX_FRAME_BYTES=${options.guestFrameCap}`)
    if (options.spawnError && argv[2] === SHELL_MONITOR) throw new Error('injected transport spawn failure')
    // Fault-inject stale guest facts and inherited environment via real Python, never alternate shell logic.
    return spawn({ ...request, argv, cwd: '/tmp', env: { ...request.env, DSH_STALE_TEST: 'stale', dsh_stale_lower: 'stale', GH_TOKEN: 'ambient-gh', GITHUB_TOKEN: 'ambient-github' } })
  }
  if (options.ownerControl) binding.control = async (script, id) => {
    controls.push(script)
    if (failCleanup && script === SHELL_CLEANUP) {
      failCleanup = false
      throw new Error('injected cleanup confirmation failure')
    }
    const handle = runtime.spawn({ argv: ['wsl.exe', '-d', target.distro, '-u', target.user, '-e', 'python3', '-c', script, id],
      cwd: '/tmp', graceMs: 100, signal: AbortSignal.timeout(10000),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } })
    const result = await handle.done
    if (result.exitCode !== 0) throw new Error(handle.collected.stderr!.readFrom(0).text)
    return handle.collected.stdout!.readFrom(0).text
  }
  const unbind = registerWslExecution(sessionId, binding, () => ({ DSH_TEST_CONTROLLED: 'trusted' }))
  disposers.push(unbind)
  const fiber = await ctx.plugin(SuperagentWslShell, { graceMs: 100, maxOutputBytes: 4096 })
  // Composition disposal must sequence guest confirmation before transport disposal;
  // Cordis effects in one fiber must not be assumed to execute sequentially.
  disposers.push(async () => { try { await disposeWslShellExecutions(sessionId) } finally { await ctx.fiber.dispose() } })
  const shell = ctx.shell
  const spec = (command: string, fields: Partial<Parameters<typeof shell.resolve>[0]> = {}) => shell.resolve({ command,
    dshEnv: { DSH_SESSION_ID: sessionId }, onExpiry: 'none', ...fields })
  return { sessionId, binding, ctx, shell, spec, requests, fiber, owners, controls, diagnostics, cleanupObservations }
}
function frame(request: SubprocessSpawnSpec) { return JSON.parse((request.stdio.stdin as { data: string }).data) }
async function ready(execution: Awaited<ReturnType<SuperagentWslShell['execute']>>) {
  await expect.poll(() => execution.observed.stdout.readFrom(0).text, { timeout: 5000 }).toContain('READY')
  const [, pid, nonce] = /READY (\d+) ([\w-]+)/.exec(execution.observed.stdout.readFrom(0).text)!
  return { pid: Number(pid), nonce }
}
const sleeping = `trap '' TERM; sleep 60 & echo "READY $! $DSH_SHELL_NONCE"; wait`

it('counts exact escaped UTF-8 JSON boundaries including quoted Unicode, lone surrogates and aggregate env', () => {
  expect(MAX_WSL_SHELL_INPUT_BYTES).toBe(64 * 1024 * 1024)
  const samples: Partial<WslShellFrame>[] = [
    { stdin: 'plain boundary' },
    { stdin: '\u0000\b\t\n\r\f"\\\u007f\u0080\u07ff\u0800\u2028\u2029雪😀\ud800', env: { 'quoted"雪key': '\udc00' } },
    { env: { FIRST: '雪"\\'.repeat(40), SECOND: '😀\u0001'.repeat(40) } },
  ]
  for (const sample of samples) {
    const payload: WslShellFrame = { id: 'nonce', uid: 1000, bootId: 'boot', graceMs: 100, cwd: '/tmp', argv: ['bash', '-c', 'true'], env: {}, stdin: '', ...sample }
    const expected = JSON.stringify(payload), exact = Buffer.byteLength(expected)
    expect(serializeWslShellFrame(payload, exact)).toBe(expected)
    const stringify = vi.spyOn(JSON, 'stringify')
    let error: unknown
    try { serializeWslShellFrame(payload, exact - 1) } catch (caught) { error = caught }
    const calls = stringify.mock.calls.length
    stringify.mockRestore()
    expect(error).toMatchObject({ code: 'WSL_SHELL_INPUT_TOO_LARGE' })
    expect(String(error)).toContain('64 MiB')
    expect(calls).toBe(0) // No oversized JSON was allocated merely to discover its size.
  }
})
linuxIt.each(['stdin', 'environment'] as const)('rejects oversized serialized %s before spawning, using the real serializer with a small test cap', async field => {
  const original = shellTransport.serializeWslShellFrame
  vi.spyOn(shellTransport, 'serializeWslShellFrame').mockImplementation(payload => original(payload, 4096))
  const { shell, spec, requests, sessionId } = await setup()
  const extra = field === 'stdin' ? { stdin: '雪"\\'.repeat(700) } : { env: { FIRST: '雪"'.repeat(450), SECOND: '雪"'.repeat(450) } }
  await expect(shell.execute(spec('echo MUST_NOT_RUN', extra))).rejects.toMatchObject({ code: 'WSL_SHELL_INPUT_TOO_LARGE' })
  expect(requests).toHaveLength(0)
  expect(() => assertWslShellHealthy(sessionId)).not.toThrow()
})
linuxIt('guest bounded read rejects an oversized frame and still positively confirms cleanup without starting the user command', async () => {
  const { shell, spec, requests, sessionId, cleanupObservations } = await setup({ guestFrameCap: 1024 })
  const execution = await shell.execute(spec('echo MUST_NOT_RUN', { stdin: 'x'.repeat(2000) }))
  await expect(execution.done).resolves.toBeUndefined()
  await expect(execution.result()).rejects.toThrow('WSL_SHELL_INPUT_TOO_LARGE')
  expect(execution.observed.stdout.readFrom(0).text).not.toContain('MUST_NOT_RUN')
  const request = requests.find(request => request.argv.includes(SHELL_MONITOR))!
  const nonce = frame(request).id
  expect(request.argv.at(-1)).toBe(nonce)
  expect(existsSync(`/tmp/dsh-shell-${nonce}`)).toBe(false)
  expect(cleanupObservations).toEqual([{ status: 'killed', error: undefined }])
  expect(() => assertWslShellHealthy(sessionId)).not.toThrow()
  await expect(disposeWslShellExecutions(sessionId)).resolves.toBeUndefined()
})

linuxIt('keeps long command, stdin, env and guest cwd in the frame, never on the Windows command line or environment', async () => {
  const { shell, spec, requests } = await setup()
  const input = '雪\u0000input\n'.repeat(40000)
  const command = `python3 -c 'import sys,os; print(len(sys.stdin.read())); print(os.environ["LARGE"]); print(os.getcwd())' #${' comment'.repeat(30000)}`
  const execution = await shell.execute(spec(command, { command, stdin: input, env: { LARGE: 'value with " quotes' } }))
  const result = await execution.result()
  expect(result.exitCode).toBe(0)
  expect(result.stdout.text).toBe(`${input.length}\nvalue with " quotes\n/tmp\n`)
  const request = requests.find(request => request.argv.includes(SHELL_MONITOR))!
  expect(request.argv).toEqual(['wsl.exe', '-d', 'test-bound-distro', '-u', 'test-bound-user', '-e', 'python3', '-c', SHELL_MONITOR, '--frame', frame(request).id])
  expect(request.argv.join(' ').length).toBeLessThan(10000)
  expect(request.env).toBeUndefined()
  expect(frame(request)).toMatchObject({ cwd: '/tmp', stdin: input, argv: ['bash', '--noprofile', '--norc', '-c', command] })
})
linuxIt('scrubs inherited harness/GitHub facts and protects controlled environment tombstones before managed env merges last', async () => {
  const { shell, spec } = await setup()
  const command = `python3 -c 'import os,json; print(json.dumps(dict(os.environ)))'`
  const execution = await shell.execute(spec(command, { command, env: { PATH: '/evil', HOME: '/evil', USER: 'root', LOGNAME: 'root',
    GIT_CONFIG_GLOBAL: '/evil/config', GIT_DIR: '/evil/git', GH_TOKEN: 'ordinary-gh', GITHUB_TOKEN: 'ordinary-github',
    CUSTOM: 'ordinary', DSH_TEST_CONTROLLED: 'ordinary' }, dshEnv: { DSH_SESSION_ID: `owned-public-shell-${serial}`, DSH_TEST_CONTROLLED: 'managed' } }))
  const result = await execution.result()
  const env = JSON.parse(result.stdout.text)
  expect(env).toMatchObject({ HOME: '/root', USER: 'test-bound-user', LOGNAME: 'test-bound-user', PATH: '/usr/bin:/bin',
    GIT_CONFIG_GLOBAL: '/controlled/gitconfig', CUSTOM: 'ordinary', DSH_TEST_CONTROLLED: 'managed' })
  for (const key of ['DSH_STALE_TEST', 'dsh_stale_lower', 'GH_TOKEN', 'GITHUB_TOKEN', 'GIT_DIR']) expect(env).not.toHaveProperty(key)
})
linuxIt.each(['uid', 'bootId'] as const)('refuses stale %s snapshots before running the user command, with done fulfilled and infrastructure result rejected', async field => {
  const { shell, spec, diagnostics, cleanupObservations } = await setup(field === 'uid' ? { uid: process.getuid!() + 1 } : { bootId: 'stale-boot-id' })
  const execution = await shell.execute(spec('echo USER_COMMAND_MUST_NOT_RUN'))
  await expect(execution.done).resolves.toBeUndefined()
  await expect(execution.result()).rejects.toThrow(/snapshot is stale/)
  expect(execution.observed.stdout.readFrom(0).text).not.toContain('USER_COMMAND_MUST_NOT_RUN')
  expect(execution.observed.stderr.readFrom(0).text).toContain('snapshot is stale')
  expect(diagnostics.get(execution)?.cleanupError()).toBeUndefined()
  expect(cleanupObservations).toEqual([{ status: 'killed', error: undefined }])
})
linuxIt.each(['stale-uid', 'stale-boot', 'spawn'] as const)('quiescence barrier succeeds for positively stopped %s failures while result preserves infrastructure rejection', async failure => {
  const options = failure === 'stale-uid' ? { uid: process.getuid!() + 1 } : failure === 'stale-boot' ? { bootId: 'stale-boot-id' } : { spawnError: true }
  const { shell, spec, sessionId, cleanupObservations } = await setup(options)
  const execution = await shell.execute(spec('echo MUST_NOT_RUN'))
  // Race shutdown against a published stale-identity handle, not only an already-finished one.
  await expect(disposeWslShellExecutions(sessionId)).resolves.toBeUndefined()
  await expect(execution.result()).rejects.toThrow(failure === 'spawn' ? 'injected transport spawn failure' : 'snapshot is stale')
  expect(() => assertWslShellHealthy(sessionId)).not.toThrow()
  expect(cleanupObservations.every(observation => observation.error === undefined)).toBe(true)
})
linuxIt('maps Windows/relative coordinates asynchronously through the bound mapper and uses Session cwd, not deployment root', async () => {
  const mapper = vi.fn(async (_input: string, _signal?: AbortSignal, _cwd?: string) => '/tmp')
  const { shell, spec } = await setup({ mapPath: mapper })
  const command = 'pwd'
  const resolved = spec(command, { command, workdir: String.raw`Q:\not-a-hardcoded-mount` })
  expect(mapper).not.toHaveBeenCalled()
  const execution = await shell.execute(resolved)
  expect((await execution.result()).stdout.text).toBe('/tmp\n')
  expect(mapper).toHaveBeenCalledWith(String.raw`Q:\not-a-hardcoded-mount`, expect.any(AbortSignal), '/tmp')
})
linuxIt('executes Core-style omitted-policy specs under the trusted Session danger override, not the global read-only fallback', async () => {
  const { ctx, shell, spec } = await setup({ resolveShellPolicy: () => ({ mode: 'danger-full-access', workspaceRoot: '/tmp' }) })
  const globalPolicy = vi.fn(() => ({ mode: 'read-only', workspaceRoot: '/global' }))
  ctx.provide('sandboxPolicy', { resolve: globalPolicy })
  const input = spec('printf SESSION_POLICY_OK')
  expect(input.sandboxPolicy).toBeUndefined()
  const execution = await shell.execute(input)
  expect((await execution.result()).stdout.text).toBe('SESSION_POLICY_OK')
  expect(globalPolicy).not.toHaveBeenCalled()
  expect(shell.sandboxMode).toBeUndefined()
})
linuxIt('rejects a Session permission downgrade during asynchronous preparation before native spawn', async () => {
  let finish!: (path: string) => void
  let restricted = false
  const { ctx, shell, spec, requests } = await setup({ mapPath: () => new Promise(resolve => { finish = resolve }),
    resolveShellPolicy: () => ({ mode: restricted ? 'read-only' : 'danger-full-access', workspaceRoot: '/tmp' }) })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: '/global' }) })
  const pending = shell.execute(spec('echo MUST_NOT_RUN'))
  restricted = true
  finish('/tmp')
  await expect(pending).rejects.toThrow(/does not implement sandbox/)
  expect(requests).toHaveLength(0)
})
linuxIt('honors the root-owned current-generation assertion before guest publication', async () => {
  const { shell, spec, requests } = await setup({ assertCurrent: async () => { throw new Error('binding generation is stale') } })
  await expect(shell.execute(spec('echo MUST_NOT_RUN'))).rejects.toThrow('binding generation is stale')
  expect(requests).toHaveLength(0)
})
linuxIt('preparation timeout publishes a settled empty handle and ignored late mapper completion cannot spawn', async () => {
  let finish!: (path: string) => void
  const { shell, spec, requests } = await setup({ mapPath: () => new Promise(resolve => { finish = resolve }) })
  const command = 'echo MUST_NOT_RUN'
  const execution = await shell.execute(spec(command, { command, workdir: 'relative', timeoutMs: 15, onExpiry: 'kill' }))
  expect((await execution.result())).toMatchObject({ timedOut: true, aborted: false, exitCode: null, stdout: { text: '' } })
  expect(execution.kill()).toBe(false)
  finish('/tmp')
  await delay(40)
  expect(requests).toHaveLength(0)
})
linuxIt('caller abort during preparation rejects execute promptly and never spawns a late command', async () => {
  let finish!: (path: string) => void
  const { shell, spec, requests } = await setup({ mapPath: () => new Promise(resolve => { finish = resolve }) })
  const abort = new AbortController(), command = 'echo MUST_NOT_RUN'
  const pending = shell.execute(spec(command, { command, workdir: 'relative', signal: abort.signal }))
  abort.abort(new Error('preparation cancelled'))
  await expect(pending).rejects.toThrow('preparation cancelled')
  finish('/tmp')
  await delay(40)
  expect(requests).toHaveLength(0)
})
linuxIt('composition disposal cancels unpublished preparation and closes the old binding against late spawns', async () => {
  let finish!: (path: string) => void
  const { shell, spec, requests, sessionId } = await setup({ mapPath: () => new Promise(resolve => { finish = resolve }) })
  const command = 'echo MUST_NOT_RUN'
  const pending = shell.execute(spec(command, { workdir: 'relative' }))
  const rejected = expect(pending).rejects.toThrow(/composition disposed/)
  await disposeWslShellExecutions(sessionId)
  await rejected
  finish('/tmp')
  await delay(40)
  expect(requests).toHaveLength(0)
  expect(() => spec('true')).toThrow(/disposing/)
})
linuxIt('preserves bounded collected tails, full spill paths, independent observers and consuming output cursors', async () => {
  const { shell, spec } = await setup()
  const execution = await shell.execute(spec(`python3 -c 'import sys;sys.stdout.write("x"*120000);sys.stderr.write("y"*100000)'`))
  await execution.done
  const result = await execution.result()
  expect(result.stdout.truncated).toBe(true)
  expect(result.stderr.truncated).toBe(true)
  expect(result.stdout.text).toHaveLength(4096)
  expect(result.stderr.text).toHaveLength(4096)
  expect(readFileSync(result.stdout.spillPath!, 'utf8')).toBe('x'.repeat(120000))
  expect(readFileSync(result.stderr.spillPath!, 'utf8')).toBe('y'.repeat(100000))
  const observed = execution.observed.stdout.readFrom(0)
  expect(observed.lossy).toBe(true)
  expect(execution.readOutput()).toMatchObject({ lossy: true, stdoutSpillPath: result.stdout.spillPath, stderrSpillPath: result.stderr.spillPath })
  expect(execution.readOutput().delta).toBe('')
  expect(execution.observed.stdout.readFrom(0)).toEqual(observed)
})
linuxIt.each(['timeout-first', 'abort-first'] as const)('reports mutually exclusive first-cause classification (%s)', async order => {
  const { shell, spec } = await setup()
  const abort = new AbortController(), command = sleeping
  const execution = await shell.execute(spec(command, { command, signal: abort.signal, onExpiry: 'kill', timeoutMs: order === 'timeout-first' ? 1200 : 5000 }))
  await ready(execution)
  if (order === 'timeout-first') await delay(1250)
  abort.abort()
  const result = await execution.result()
  expect(result.timedOut).toBe(order === 'timeout-first')
  expect(result.aborted).toBe(order === 'abort-first')
})
linuxIt('onExpiry none arms no command timer and outlives an executor-only reload, while old handle cleanup remains usable', async () => {
  const { shell, spec, fiber, ctx, owners, controls } = await setup({ ownerControl: true })
  const execution = await shell.execute(spec(sleeping, { command: sleeping, timeoutMs: 1 }))
  const { pid, nonce } = await ready(execution)
  expect(owners.has(execution)).toBe(true)
  await fiber.dispose()
  await delay(30)
  expect(execution.status).toBe('running')
  expect(existsSync(`/proc/${pid}`)).toBe(true)
  const replacement = await ctx.plugin(SuperagentWslShell, { graceMs: 100 })
  expect(ctx.shell).toBeDefined()
  execution.kill()
  await execution.done
  expect((await execution.result())).toMatchObject({ timedOut: false, aborted: false })
  expect(existsSync(`/proc/${pid}`)).toBe(false)
  expect(existsSync(`/tmp/dsh-shell-${nonce}`)).toBe(false)
  expect(owners.size).toBe(0)
  expect(controls).toHaveLength(2)
  await replacement.dispose()
})
linuxIt('composition owner retains and cancels old-generation handles across binding and executor handoff', async () => {
  const { shell, spec, ctx, sessionId, binding, owners, controls, fiber } = await setup({ ownerControl: true })
  const first = await shell.execute(spec(sleeping))
  const a = await ready(first)
  const next = { ...binding, snapshot: freezeExecutionSnapshot(4, { ...binding.snapshot.target, generationId: 'generation-b' }, binding.snapshot.environment) }
  disposers.push(registerWslExecution(sessionId, next))
  await fiber.dispose()
  await ctx.plugin(SuperagentWslShell, { graceMs: 100 })
  const second = await ctx.shell.execute(ctx.shell.resolve({ command: sleeping, onExpiry: 'none', dshEnv: { DSH_SESSION_ID: sessionId } }))
  const b = await ready(second)
  expect(owners.size).toBe(2)
  const owned = [...owners]
  for (const handle of owned) handle.kill()
  await Promise.all(owned.map(handle => handle.done))
  expect(owners.size).toBe(0)
  expect(controls).toHaveLength(4)
  for (const info of [a, b]) {
    expect(existsSync(`/proc/${info.pid}`)).toBe(false)
    expect(existsSync(`/tmp/dsh-shell-${info.nonce}`)).toBe(false)
  }
})
linuxIt('old-generation cleanup diagnostics survive executor handoff and sticky-map recovery for the composition owner', async () => {
  const { shell, spec, ctx, sessionId, binding, owners, fiber, diagnostics, cleanupObservations } = await setup({ ownerControl: true, failCleanup: true })
  const first = await shell.execute(spec(sleeping))
  const { pid, nonce } = await ready(first)
  const observation = diagnostics.get(first)!
  expect(observation.cleanupError()).toBeUndefined()
  const next = { ...binding, snapshot: freezeExecutionSnapshot(4, { ...binding.snapshot.target, generationId: 'generation-b' }, binding.snapshot.environment) }
  disposers.push(registerWslExecution(sessionId, next))
  await fiber.dispose()
  await ctx.plugin(SuperagentWslShell, { graceMs: 100 })
  try {
    first.kill()
    // Background owner observes diagnostics at release without needing result().
    await first.done
    expect(owners.size).toBe(0)
    expect(cleanupObservations).toHaveLength(1)
    expect(cleanupObservations[0]!.status).toBe('killed')
    expect(cleanupObservations[0]!.error).toBe(observation.cleanupError())
    expect(String(observation.cleanupError())).toContain('injected cleanup confirmation failure')
    expect(existsSync(`/proc/${pid}`)).toBe(false)
    expect(existsSync(`/tmp/dsh-shell-${nonce}/done`)).toBe(true)
    await expect(first.result()).rejects.toThrow('injected cleanup confirmation failure')
    expect(() => assertWslShellHealthy(sessionId)).toThrowError(expect.objectContaining({ code: 'WSL_CLEANUP_UNCONFIRMED' }))
    await expect(disposeWslShellExecutions(sessionId)).rejects.toMatchObject({ code: 'WSL_CLEANUP_UNCONFIRMED' })
    // A completed handle has left live; global shutdown must still retain its sticky uncertainty.
    await expect(disposeWslShellExecutions()).rejects.toMatchObject({ code: 'WSL_CLEANUP_UNCONFIRMED' })
  } finally {
    // Positive monitor completion, exact-nonce cleanup, then explicit test-only health recovery.
    await binding.control!(SHELL_CLEANUP, nonce!)
    clearWslShellFailure(sessionId)
  }
  // Per-handle observation is not a lookup in a reloadable module's global sticky map.
  expect(cleanupObservations[0]!.error).toBe(observation.cleanupError())
  expect(observation.cleanupError()).toBeInstanceOf(Error)
  expect(existsSync(`/tmp/dsh-shell-${nonce}`)).toBe(false)
})
linuxIt('composition teardown terminates and positively confirms guest descendants before disposing transport', async () => {
  const { shell, spec, ctx, sessionId } = await setup()
  const execution = await shell.execute(spec(sleeping))
  const { pid, nonce } = await ready(execution)
  await disposeWslShellExecutions(sessionId)
  await ctx.fiber.dispose()
  await execution.done
  expect(execution.status).toBe('killed')
  expect(existsSync(`/proc/${pid}`)).toBe(false)
  expect(existsSync(`/tmp/dsh-shell-${nonce}`)).toBe(false)
})
linuxIt('spawn failures publish a killed handle with never-rejecting done, lazy memoized result rejection, and incremental diagnostics', async () => {
  const { shell, spec, cleanupObservations } = await setup({ spawnError: true })
  const execution = await shell.execute(spec('true'))
  await expect(execution.done).resolves.toBeUndefined()
  expect(execution.status).toBe('killed')
  expect(execution.kill()).toBe(false)
  expect(execution.observed.stderr.readFrom(0).text).toContain('injected transport spawn failure')
  expect(execution.readOutput().delta).toContain('injected transport spawn failure')
  expect(execution.readOutput().delta).toBe('')
  const result = execution.result()
  expect(execution.result()).toBe(result)
  await expect(result).rejects.toThrow('injected transport spawn failure')
  expect(cleanupObservations).toEqual([])
})
