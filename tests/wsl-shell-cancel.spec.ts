/** Real nodeprocess service and guest protocol; only the Windows wsl.exe argv boundary is translated. */
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import SuperagentWslShell, { assertWslShellHealthy, clearWslShellFailure } from '../src/wsl-shell.ts'
import { SHELL_CANCEL, SHELL_CLEANUP, SHELL_MONITOR } from '../src/infra/wsl-shell-transport.ts'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { registerWslExecution } from '../src/app/wsl-world.ts'
import type { Machine } from '../src/deployment.ts'
import type { ShellExecSpec } from '@deepseek-ai/dsh-shell'
const linuxIt = it.skipIf(process.platform !== 'linux')

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup(failCleanup = false, faults: { cancelFailure?: boolean; frozenGuest?: boolean; detachedGuest?: boolean } = {}) {
  const guestHandles: SubprocessHandle[] = []
  const ctx = new Context()
  contexts.push(ctx)
  new LocalSubprocessRuntime(ctx)
  // Keep every vendor implementation method, including spawnExecution and deadline; just emulate wsl.exe -e on Linux.
  const runtime = ctx.subprocess
  const spawn = runtime.spawn.bind(runtime)
  runtime.spawn = spec => {
    const split = spec.argv.indexOf('-e')
    let argv = split < 0 ? spec.argv : spec.argv.slice(split + 1)
    if (faults.cancelFailure && argv[2] === SHELL_CANCEL) {
      argv = ['python3', '-c', 'import sys; sys.stderr.write("cancel unavailable"); sys.exit(7)']
    }
    if ((faults.frozenGuest || faults.detachedGuest) && argv[2] === SHELL_MONITOR) {
      // Two REAL nodeprocess ranges emulate Windows transport death with a still-live guest monitor.
      // SIGSTOP is fault injection only; the monitor and user command are the production Python protocol.
      let frozen = SHELL_MONITOR.replace('child=None', "with open(root+'/monitor-test-pid','w') as f: f.write(str(os.getpid()))\nchild=None")
      if (faults.frozenGuest) frozen = frozen.replace('  while not exited():', '  os.kill(os.getpid(),signal.SIGSTOP)\n  while not exited():')
      guestHandles.push(spawn({ ...spec, argv: ['python3', '-c', frozen, argv[3]!], cwd: '/tmp' }))
      const id = JSON.parse(Buffer.from(argv[3]!, 'base64').toString()).id as string
      const bridge = `import os,time,sys\nroot='/tmp/dsh-shell-'+sys.argv[1]\nend=time.monotonic()+3\nwhile not os.path.exists(root+'/pid') and time.monotonic()<end: time.sleep(.01)\ntime.sleep(.05)\nwith open(root+'/monitor-test-pid') as f: monitor=f.read()\nprint('READY '+monitor+' '+sys.argv[1],flush=True)\n${faults.frozenGuest ? 'sys.exit(9)' : 'time.sleep(60)'}`
      argv = ['python3', '-c', bridge, id]
    }
    if (failCleanup && argv[2] === SHELL_CLEANUP) {
      failCleanup = false
      argv = ['python3', '-c', 'import sys; sys.stderr.write("cleanup unavailable"); sys.exit(7)']
    }
    return spawn({ ...spec, argv, cwd: '/tmp' })
  }
  const shell = new SuperagentWslShell(ctx, { timeoutMs: 120000, maxTimeoutMs: 600000,
    maxOutputBytes: 64000, maxSpillBytes: 67108864, graceMs: 100, loginShell: false, distro: 'test', wslPath: 'wsl.exe' })
  const spec = (command: string, extra: Partial<ShellExecSpec> = {}): ShellExecSpec => ({ command, workdir: '/tmp',
    timeoutMs: 5000, onExpiry: 'none', stdoutMaxBytes: 64000, sandboxPolicy: undefined, ...extra })
  return { shell, spec, runtime, guestHandles }
}
async function ready(execution: ReturnType<SuperagentWslShell['start']>) {
  await expect.poll(() => execution.observed.stdout.readFrom(0).text, { timeout: 5000 }).toContain('READY')
  const text = execution.observed.stdout.readFrom(0).text
  const [_, child, nonce] = /READY (\d+) ([\w-]+)/.exec(text)!
  return { child: Number(child), nonce: nonce! }
}
function gone(pid: number) { return !existsSync(`/proc/${pid}`) }
const command = `trap '' TERM; sleep 60 & echo "READY $! $DSH_SHELL_NONCE"; wait`

linuxIt('standard ShellExecution.kill cancels the guest group, reaps descendants and keeps independent output readers', async () => {
  const { shell, spec } = await setup()
  const execution = await shell.execute(spec(command))
  const { child, nonce } = await ready(execution)
  expect(execution.readOutput().delta).toContain('READY')
  expect(execution.observed.stdout.readFrom(0).text).toContain('READY')
  expect(execution.kill()).toBe(true)
  expect(execution.kill()).toBe(false)
  await execution.done
  expect(execution.status).toBe('killed')
  expect(gone(child)).toBe(true)
  expect(existsSync(`/tmp/dsh-shell-${nonce}`)).toBe(false)
  expect(execution.kill()).toBe(false)
}, 10000)

linuxIt.each(['timeout', 'abort', 'abort-none'] as const)('vendor %s signal cancels guest before transport completion', async cause => {
  const { shell, spec } = await setup()
  const abort = new AbortController()
  const execution = shell.start(spec(command, { onExpiry: cause === 'abort-none' ? 'none' : 'kill', timeoutMs: cause === 'timeout' ? 1000 : 5000, signal: abort.signal }))
  const { child, nonce } = await ready(execution)
  if (cause !== 'timeout') abort.abort()
  const result = await execution.result()
  expect(result.timedOut).toBe(cause === 'timeout')
  expect(result.aborted).toBe(cause !== 'timeout')
  expect(execution.status).toBe('killed')
  expect(gone(child)).toBe(true)
  expect(existsSync(`/tmp/dsh-shell-${nonce}`)).toBe(false)
}, 10000)

linuxIt.each(['sleep 60', 'setsid sleep 60'])('normal completion reaps background descendants (%s) before done', async background => {
  const { shell, spec } = await setup()
  const execution = shell.start(spec(`${background} & echo "READY $! $DSH_SHELL_NONCE"; sleep .1`))
  const { child, nonce } = await ready(execution)
  await execution.done
  expect((await execution.result()).exitCode).toBe(0)
  expect(gone(child)).toBe(true)
  expect(existsSync(`/tmp/dsh-shell-${nonce}`)).toBe(false)
})

linuxIt('nonce cancellation never touches a concurrent guest invocation', async () => {
  const { shell, spec } = await setup()
  const first = shell.start(spec(command))
  const second = shell.start(spec(command))
  try {
    const a = await ready(first)
    const b = await ready(second)
    expect(a.nonce).not.toBe(b.nonce)
    first.kill()
    await first.done
    expect(gone(a.child)).toBe(true)
    expect(gone(b.child)).toBe(false)
    expect(second.status).toBe('running')
    second.kill()
    await second.done
    expect(gone(b.child)).toBe(true)
  } finally {
    first.kill(); second.kill()
    await Promise.all([first.done, second.done])
  }
}, 10000)

linuxIt('background cleanup failure is observable and blocks subsequent Session work until explicit recovery', async () => {
  const { shell, spec, runtime } = await setup(true)
  const sessionId = 'cleanup-failure-test'
  const dispose = registerWslExecution(sessionId, { machine: { wsl: { distro: 'test', user: 'root' } } as Machine, env: {} })
  const execution = shell.start(spec('echo "READY $$ $DSH_SHELL_NONCE"; sleep .1', { dshEnv: { DSH_SESSION_ID: sessionId } }))
  const { nonce } = await ready(execution)
  try {
    // A background consumer need never call result().
    await execution.done
    expect(execution.status).toBe('killed')
    expect(execution.exitCode).toBe(1)
    const observed = execution.observed.stderr.readFrom(0)
    expect(observed.text).toContain('guest cleanup not confirmed')
    expect(observed.text).toContain('cleanup unavailable')
    expect(execution.observed.stderr.readFrom(observed.nextOffset).text).toBe('')
    expect(execution.readOutput().delta).toContain('guest cleanup not confirmed')
    expect(execution.readOutput().delta).toBe('')
    expect(() => assertWslShellHealthy(sessionId)).toThrow(/cleanup not confirmed/)
    expect(() => assertWslShellHealthy('different-session')).not.toThrow()
    expect(() => shell.resolve({ command: 'true', dshEnv: { DSH_SESSION_ID: sessionId } })).toThrow(/cleanup not confirmed/)
    await expect(execution.result()).rejects.toThrow('cleanup unavailable')
  } finally {
    // Explicit recovery verifies guest completion, cleans its exact nonce directory, then clears sticky health.
    const cleanup = runtime.spawn({ argv: ['python3', '-c', SHELL_CLEANUP, nonce], cwd: '/tmp', graceMs: 100,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } })
    expect((await cleanup.done).exitCode).toBe(0)
    expect(existsSync(`/tmp/dsh-shell-${nonce}`)).toBe(false)
    clearWslShellFailure(sessionId)
    dispose()
  }
  expect(() => assertWslShellHealthy(sessionId)).not.toThrow()
}, 10000)

linuxIt('failed cancel control falls back to bounded transport termination without clearing sticky failure', async () => {
  const { shell, spec, guestHandles } = await setup(false, { cancelFailure: true, detachedGuest: true })
  const sessionId = 'cancel-control-failure'
  const execution = shell.start(spec(command, { dshEnv: { DSH_SESSION_ID: sessionId } }))
  const { nonce } = await ready(execution)
  const child = Number(readFileSync(`/tmp/dsh-shell-${nonce}/pid`, 'utf8'))
  try {
    execution.kill()
    // The user command sleeps 60s. Returning inside this bounded race proves fallback actually terminates transport.
    await Promise.race([execution.done, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('transport fallback did not settle')), 8000)
      execution.done.then(() => clearTimeout(timer))
    })])
    expect(execution.status).toBe('killed')
    expect(execution.observed.stderr.readFrom(0).text).toContain('cancel unavailable')
    expect(() => assertWslShellHealthy(sessionId)).toThrow(/cleanup not confirmed/)
    expect(gone(child)).toBe(true)
    expect(existsSync(`/tmp/dsh-shell-${nonce}`)).toBe(false)
  } finally {
    await Promise.all(guestHandles.map(handle => handle.done))
    clearWslShellFailure(sessionId)
  }
}, 15000)

linuxIt('dead transport cannot delete an active nonce or claim guest completion without monitor confirmation', async () => {
  const { shell, spec, runtime, guestHandles } = await setup(false, { frozenGuest: true })
  const sessionId = 'dead-transport-live-guest'
  const execution = shell.start(spec(command, { dshEnv: { DSH_SESSION_ID: sessionId } }))
  const { child: monitor, nonce } = await ready(execution)
  const root = `/tmp/dsh-shell-${nonce}`
  const child = Number(readFileSync(`${root}/pid`, 'utf8'))
  try {
    await execution.done
    expect(execution.status).toBe('killed')
    expect(execution.observed.stderr.readFrom(0).text).toContain('nonce retained')
    expect(() => assertWslShellHealthy(sessionId)).toThrow(/cleanup not confirmed/)
    expect(existsSync(root)).toBe(true)
    expect(existsSync(`${root}/done`)).toBe(false)
    expect(existsSync(`${root}/cancel`)).toBe(true)
    expect(gone(child)).toBe(false)
  } finally {
    // Restore the real monitor; it must consume the retained sentinel and reap its real process group.
    process.kill(monitor, 'SIGCONT')
    await Promise.all(guestHandles.map(handle => handle.done))
    expect(gone(child)).toBe(true)
    const cleanup = runtime.spawn({ argv: ['python3', '-c', SHELL_CLEANUP, nonce], cwd: '/tmp', graceMs: 100,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } })
    expect((await cleanup.done).exitCode).toBe(0)
    expect(existsSync(root)).toBe(false)
    clearWslShellFailure(sessionId)
  }
}, 15000)

linuxIt('confirmed monitor completion preserves an ordinary nonzero command exit', async () => {
  const { shell, spec } = await setup()
  const execution = shell.start(spec('exit 7'))
  const result = await execution.result()
  expect(result.exitCode).toBe(7)
  expect(result.aborted).toBe(false)
  expect(result.timedOut).toBe(false)
  expect(execution.status).toBe('completed')
  expect(execution.observed.stderr.readFrom(0).text).not.toContain('cleanup not confirmed')
})

linuxIt('pre-aborted execution refuses to spawn a guest command', async () => {
  const { shell, spec } = await setup()
  const abort = new AbortController()
  abort.abort(new Error('already cancelled'))
  expect(() => shell.start(spec('sleep 60', { signal: abort.signal }))).toThrow('already cancelled')
})

linuxIt('onExpiry none keeps the same live handle past its foreground wait and preserves stdin/output', async () => {
  const { shell, spec } = await setup()
  const execution = await shell.execute(spec('read line; sleep .15; printf "%s" "$line"', { timeoutMs: 10, stdin: 'input-value\n' }))
  const result = await execution.result()
  expect(result.stdout.text).toBe('input-value')
  expect(result.timedOut).toBe(false)
  expect(result.aborted).toBe(false)
  expect(execution.status).toBe('completed')
  expect(execution.result()).toBe(execution.result())
})

linuxIt('immediate cancellation cannot race monitor startup into starting a user command', async () => {
  const { shell, spec } = await setup()
  const execution = shell.start(spec('sleep 60'))
  expect(execution.kill()).toBe(true)
  await execution.done
  expect((await execution.result()).exitCode).toBe(130)
})
