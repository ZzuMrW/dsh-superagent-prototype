/** Standard Bash over the public DSH shell/subprocess seams. Jobs and ownership remain DSH's. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ShellExecutor, type ShellExecRequest, type ShellExecSpec, type ShellExecution, type ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { SubprocessHandle, SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ExecutionSnapshot } from './execution/target.ts'
import { freezeExecutionSnapshot } from './execution/target.ts'
import { SHELL_MONITOR, guestPython, SHELL_CANCEL, SHELL_CLEANUP, MAX_WSL_SHELL_INPUT_BYTES, WslShellInputTooLargeError, assertWslShellTextFits, serializeWslShellFrame, type WslShellPlan } from './infra/wsl-shell-transport.ts'
import { wslExecutionFor } from './app/wsl-world.ts'

/** Small trusted port supplied by the Session world, never inferred from host/global state. */
export interface WslShellBindingPort {
  snapshot?: ExecutionSnapshot
  guestCwd?: string
  env: Record<string, string | undefined>
  variables(): Record<string, string>
  mapPath?: (input: string, signal?: AbortSignal, cwd?: string) => Promise<string>
  assertCurrent?: () => void | Promise<void>
  /** Synchronous public policy resolution against this binding's exact live Session, never an ambient sourceActor. */
  resolveShellPolicy?: () => SandboxExecutionPolicy | undefined
  /** Owner is the Session/subprocess composition; read per-handle diagnostics at release, even across executor reloads. */
  ownExecution?: (handle: ShellExecution, diagnostics?: { cleanupError: () => unknown }) => () => void
  control?: (script: string, id: string) => Promise<string>
}
const cleanupFailures = new Map<string, unknown>()
const live = new Map<ShellExecution, string>()
const closedBindings = new WeakSet<WslShellBindingPort>()
const preparing = new Set<{ sessionId: string; cancel(): void; done: Promise<void> }>()
/** Guest process quiescence could not be confirmed; callers must retain their execution safety hold. */
export class WslShellCleanupUnconfirmedError extends AggregateError {
  readonly code = 'WSL_CLEANUP_UNCONFIRMED' as const
}
export function assertWslShellHealthy(sessionId: string | undefined): void {
  if (sessionId && cleanupFailures.has(sessionId)) throw new WslShellCleanupUnconfirmedError([cleanupFailures.get(sessionId)],
    `WSL shell guest cleanup not confirmed for Session ${sessionId}: ${String(cleanupFailures.get(sessionId))}`)
}
/** Operator recovery only, after independently verifying guest quiescence. */
export function clearWslShellFailure(sessionId: string): void { cleanupFailures.delete(sessionId) }
/** Call from the SUBPROCESS owning composition before disposing its transport, not on executor reload. */
export async function disposeWslShellExecutions(sessionId?: string): Promise<void> {
  const ids = sessionId === undefined ? new Set([...live.values(), ...[...preparing].map(entry => entry.sessionId), ...cleanupFailures.keys()]) : new Set([sessionId])
  for (const id of ids) { const binding = wslExecutionFor(id); if (binding) closedBindings.add(binding) }
  const pending = [...preparing].filter(entry => ids.has(entry.sessionId))
  for (const entry of pending) entry.cancel()
  const owned = [...live].filter(([, id]) => ids.has(id)).map(([execution]) => execution)
  for (const execution of owned) execution.kill()
  await Promise.all([...owned.map(execution => execution.done), ...pending.map(entry => entry.done)])
  // This is a quiescence barrier, not a command/result projection. A confirmed
  // nonzero/spawn/stale-identity failure must not masquerade as a surviving guest.
  const errors = [...ids].filter(id => cleanupFailures.has(id)).map(id => cleanupFailures.get(id))
  if (errors.length) throw new WslShellCleanupUnconfirmedError(errors, 'WSL shell guest cleanup not confirmed')
}
interface Config {
  timeoutMs?: number; maxTimeoutMs?: number; maxOutputBytes?: number; maxSpillBytes?: number
  graceMs?: number; wslPath?: string
}
const MAX_TIMER = 2_147_483_647
function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER) throw new Error(`WSL shell ${name} must be a positive bounded integer`)
  return value
}
const emptyReader: SubprocessOutputReader = { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }
function finalOutput(reader: SubprocessOutputReader) {
  const value = reader.readFrom(0)
  return { text: value.text, truncated: value.lossy, ...value.spillPath ? { spillPath: value.spillPath } : {} }
}
function checkedEnvironment(value: Record<string, string | undefined>): Record<string, string | undefined> {
  let rawLength = 0
  for (const key in value) if (Object.hasOwn(value, key)) {
    const entry = value[key]
    assertWslShellTextFits(key)
    if (entry !== undefined) assertWslShellTextFits(entry)
    rawLength += key.length + (entry?.length ?? 0)
    if (rawLength > MAX_WSL_SHELL_INPUT_BYTES) throw new WslShellInputTooLargeError()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || entry !== undefined && (typeof entry !== 'string' || entry.includes('\0'))) throw new Error('Invalid WSL execution environment')
  }
  return value
}

/** Public ShellExecutor over an explicit Session target, with streaming output and positively confirmed guest teardown. */
export default class SuperagentWslShell extends ShellExecutor {
  static inject = ['subprocess']
  static Config = z.object({ wslPath: z.string().default('wsl.exe'), timeoutMs: z.number().default(120000),
    maxTimeoutMs: z.number().default(600000), maxOutputBytes: z.number().default(64000),
    maxSpillBytes: z.number().default(67108864), graceMs: z.number().default(3000) })
  private readonly execution = new AsyncLocalStorage<string | undefined>()
  private readonly config: Required<Config>
  private readonly subprocess: SubprocessRuntime
  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.subprocess = ctx.subprocess
    this.config = { wslPath: config.wslPath ?? 'wsl.exe', timeoutMs: config.timeoutMs ?? 120000,
      maxTimeoutMs: config.maxTimeoutMs ?? 600000, maxOutputBytes: config.maxOutputBytes ?? 64000,
      maxSpillBytes: config.maxSpillBytes ?? 67108864, graceMs: config.graceMs ?? 3000 }
    for (const key of ['timeoutMs', 'maxTimeoutMs', 'maxOutputBytes', 'maxSpillBytes', 'graceMs'] as const) positive(key, this.config[key])
    if (!this.config.wslPath || this.config.wslPath.includes('\0')) throw new Error('Invalid WSL executable')
    ctx.on('tools/execute', (exec, next) => this.execution.run(exec.agent?.id, next))
  }
  private sessionId(request: Pick<ShellExecRequest, 'dshEnv'>): string | undefined {
    const managed = request.dshEnv?.DSH_SESSION_ID, active = this.execution.getStore()
    if (managed && active && managed !== active) throw new Error('WSL managed Session identity conflicts with the active execution')
    return managed ?? active
  }
  private binding(id: string | undefined): WslShellBindingPort & { snapshot: ExecutionSnapshot; guestCwd: string } {
    assertWslShellHealthy(id)
    const binding: WslShellBindingPort | undefined = wslExecutionFor(id)
    if (!id || !binding?.snapshot || !binding.guestCwd?.startsWith('/') || /[\x00-\x1f\x7f]/.test(binding.guestCwd)) throw new Error('This WSL Session has no active verified Superagent execution binding')
    if (closedBindings.has(binding)) throw new Error('WSL execution binding is disposing')
    freezeExecutionSnapshot(binding.snapshot.revision, binding.snapshot.target, binding.snapshot.environment)
    return binding as WslShellBindingPort & { snapshot: ExecutionSnapshot; guestCwd: string }
  }
  private policy(request: Pick<ShellExecRequest, 'sandboxPolicy'>, binding: WslShellBindingPort): void {
    // Core Bash leaves sandboxPolicy undefined for an unsandboxed executor. The
    // trusted Session owner must resolve its live override, not the global default.
    let policy = request.sandboxPolicy
    if (policy === undefined) {
      if (binding.resolveShellPolicy) {
        policy = binding.resolveShellPolicy()
        if (policy === undefined) throw new Error('WSL Bash requires a trusted live Session policy binding')
      } else if (this.ctx.get('sandboxPolicy') !== undefined) {
        // A global danger-full-access default cannot stand in for an unknown
        // Session override, just as a global read-only default cannot erase it.
        throw new Error('WSL Bash requires a trusted live Session policy binding; refusing global policy fallback')
      }
    }
    if (policy && policy.mode !== 'danger-full-access') throw new Error('WSL Bash does not implement sandbox enforcement; refusing a low-permission request')
  }
  resolve(request: ShellExecRequest): ShellExecSpec {
    const sessionId = this.sessionId(request)
    const binding = this.binding(sessionId)
    this.policy(request, binding)
    const timeoutMs = Math.min(positive('timeoutMs', request.timeoutMs ?? this.config.timeoutMs), this.config.maxTimeoutMs)
    return { ...request, command: request.command, workdir: request.workdir ?? binding.guestCwd,
      timeoutMs, onExpiry: request.onExpiry ?? 'kill', stdoutMaxBytes: positive('stdoutMaxBytes', request.stdoutMaxBytes ?? this.config.maxOutputBytes),
      dshEnv: { ...request.dshEnv, DSH_SESSION_ID: sessionId!, DSH_WSL_DISTRO: binding.snapshot.target.distro, DSH_WSL_USER: binding.snapshot.target.user },
      sandboxPolicy: request.sandboxPolicy }
  }
  private async control(plan: WslShellPlan, script: string, id: string): Promise<string> {
    const running = this.subprocess.spawn({ argv: guestPython(plan, script, id), cwd: plan.windowsCwd,
      graceMs: this.config.graceMs, signal: AbortSignal.timeout(10000),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } })
    const outcome = await running.done
    if (outcome.exitCode !== 0) throw new Error(`WSL shell control failed: ${running.collected.stderr?.readFrom(0).text}`)
    return running.collected.stdout?.readFrom(0).text ?? ''
  }
  async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    spec.signal?.throwIfAborted()
    if (spec.onExpiry !== 'kill' && spec.onExpiry !== 'none') throw new Error('Invalid WSL shell expiry policy')
    positive('timeoutMs', spec.timeoutMs); positive('stdoutMaxBytes', spec.stdoutMaxBytes)
    const expiresAt = spec.onExpiry === 'kill' ? performance.now() + spec.timeoutMs : undefined
    assertWslShellTextFits(spec.command)
    assertWslShellTextFits(spec.stdin ?? '')
    assertWslShellTextFits(spec.workdir)
    if (spec.command.length + (spec.stdin?.length ?? 0) + spec.workdir.length > MAX_WSL_SHELL_INPUT_BYTES) throw new WslShellInputTooLargeError()
    if (spec.command.includes('\0')) throw new Error('Invalid WSL shell command')
    const sessionId = this.sessionId(spec)
    const binding = this.binding(sessionId)
    this.policy(spec, binding)
    const snapshot = binding.snapshot
    const target = snapshot.target
    const id = randomUUID()
    let cause: 'timeout' | 'abort' | 'kill' | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const preparation = new AbortController()
    let cancel: (() => void) | undefined
    const stop = (why: NonNullable<typeof cause>) => {
      if (cause) return
      cause = why
      preparation.abort(why)
      cancel?.()
    }
    const abort = () => stop('abort')
    spec.signal?.addEventListener('abort', abort, { once: true })
    if (spec.signal?.aborted) abort()
    if (expiresAt !== undefined) {
      const remaining = expiresAt - performance.now()
      if (remaining <= 0) stop('timeout')
      else timer = setTimeout(() => stop('timeout'), remaining)
    }
    const detach = () => { if (timer) clearTimeout(timer); spec.signal?.removeEventListener('abort', abort) }
    let preparationFinished!: () => void
    const pendingPreparation = { sessionId: sessionId!, cancel: () => stop('kill'),
      done: new Promise<void>(resolve => { preparationFinished = resolve }) }
    preparing.add(pendingPreparation)
    let plan: WslShellPlan
    let frame: string
    try {
      const prepare = async () => {
        let cwd = spec.workdir
        if (binding.mapPath) cwd = await binding.mapPath(cwd, preparation.signal, binding.guestCwd)
        else if (!cwd.startsWith('/') || /[\\\0]/.test(cwd)) throw new Error('WSL workdir requires the trusted execution-world path mapper')
        await binding.assertCurrent?.()
        preparation.signal.throwIfAborted()
        this.policy(spec, binding)
        if (!cwd.startsWith('/') || /[\x00-\x1f\x7f]/.test(cwd)) throw new Error('Path mapper did not return an absolute guest workdir')
        const currentBinding: WslShellBindingPort | undefined = wslExecutionFor(sessionId)
        if (closedBindings.has(binding) || currentBinding !== binding || binding.snapshot !== snapshot) throw new Error('WSL execution binding changed during preparation')
        const controlled = { ...binding.env, ...snapshot.environment.set,
          ...Object.fromEntries(snapshot.environment.unset.map(key => [key, undefined])) }
        const protectedEnv = Object.fromEntries(Object.entries(controlled).filter(([key]) => /^(HOME|USER|LOGNAME|PATH|GIT_.*|GH_.*|GITHUB_TOKEN)$/i.test(key)))
        const env = checkedEnvironment({ NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat',
          ...controlled, ...spec.env, ...protectedEnv, ...binding.variables(), ...spec.dshEnv,
          DSH_SESSION_ID: sessionId!, DSH_WSL_DISTRO: target.distro, DSH_WSL_USER: target.user })
        // Encode tombstones explicitly: JSON.stringify otherwise silently drops undefined values.
        const guestEnv = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value ?? null]))
        const argv = [this.config.wslPath, '-d', target.distro, '-u', target.user, '-e', 'python3', '-c', SHELL_MONITOR, '--frame', id]
        plan = { distro: target.distro, linuxCwd: posix.normalize(cwd), windowsCwd: process.cwd(), env: {}, argv }
        frame = serializeWslShellFrame({ id, uid: target.uid, bootId: target.bootId, graceMs: this.config.graceMs,
          cwd: plan.linuxCwd, argv: ['bash', '--noprofile', '--norc', '-c', spec.command], env: guestEnv, stdin: spec.stdin ?? '' })
      }
      // Race cancellation even if a third-party mapper ignores its signal. Late preparation can never spawn.
      await Promise.race([prepare(), new Promise<never>((_, reject) => {
        const rejected = () => reject(preparation.signal.reason)
        if (preparation.signal.aborted) rejected()
        else preparation.signal.addEventListener('abort', rejected, { once: true })
      })])
      if (expiresAt !== undefined && performance.now() >= expiresAt) stop('timeout')
      preparation.signal.throwIfAborted()
    } catch (error) {
      detach()
      if (cause === 'timeout') return this.settledTimeout(spec)
      if (cause === 'abort') throw spec.signal?.reason ?? error
      if (cause === 'kill') throw new Error('WSL shell composition disposed during preparation')
      throw error
    } finally { preparing.delete(pendingPreparation); preparationFinished() }
    let processHandle: SubprocessHandle | undefined
    let failure: unknown
    let cleanupFailure: unknown
    let finished = false
    let transportClosed = false
    let stdoutOffset = 0, stderrOffset = 0
    let cancellation: Promise<void> | undefined
    const noteFailure = (error: unknown) => {
      cleanupFailure ??= error
      failure ??= error
      cleanupFailures.set(sessionId!, cleanupFailure)
    }
    const control = (script: string) => binding.control ? binding.control(script, id) : this.control(plan!, script, id)
    const stopGuest = () => {
      cancellation ??= Promise.resolve().then(() => control(SHELL_CANCEL)).then(() => {}, error => {
        noteFailure(error)
        // Last-resort host containment is not evidence of guest quiescence.
        processHandle?.terminate()
      })
    }
    const diagnostic = () => !finished ? '' : cleanupFailure !== undefined ? `\nWSL shell guest cleanup not confirmed: ${String(cleanupFailure)}\n`
      : failure !== undefined ? `\nWSL shell infrastructure failed: ${String(failure)}\n` : ''
    try {
      processHandle = this.subprocess.spawn({ argv: plan!.argv, cwd: plan!.windowsCwd, graceMs: this.config.graceMs,
        // Guest env, command, stdin and cwd NEVER enter the Windows environment or command line.
        stdio: { stdin: { data: frame! }, stdout: { maxBytes: spec.stdoutMaxBytes, spill: { maxBytes: this.config.maxSpillBytes } },
          stderr: { maxBytes: this.config.maxOutputBytes, spill: { maxBytes: this.config.maxSpillBytes } } } })
    } catch (error) { failure = error }
    const stdout = processHandle?.collected.stdout ?? emptyReader
    const stderr = processHandle?.collected.stderr ?? emptyReader
    const observedStderr: SubprocessOutputReader = { readFrom: from => {
      const end = stderr.readFrom(0).nextOffset
      const read = stderr.readFrom(Math.min(from, end))
      const note = Buffer.from(diagnostic())
      return { ...read, text: read.text + note.subarray(Math.max(0, from - end)).toString(), nextOffset: end + note.length }
    } }
    let projected: Promise<ShellRunResult> | undefined
    let releaseOwner: (() => void) | undefined
    const execution: ShellExecution = {
      status: 'running', exitCode: null, signal: null, done: Promise.resolve(),
      observed: { stdout, stderr: observedStderr },
      readOutput: () => {
        const out = stdout.readFrom(stdoutOffset), err = observedStderr.readFrom(stderrOffset)
        stdoutOffset = out.nextOffset; stderrOffset = err.nextOffset
        return { delta: out.text + (err.text ? `[stderr]\n${err.text}` : ''), lossy: out.lossy || err.lossy,
          ...out.spillPath ? { stdoutSpillPath: out.spillPath } : {}, ...err.spillPath ? { stderrSpillPath: err.spillPath } : {} }
      },
      kill: () => {
        if (finished || transportClosed || cause) return false
        stop('kill')
        return true
      },
      result: () => projected ??= execution.done.then(() => {
        if (failure !== undefined) throw failure
        return { exitCode: execution.exitCode, signal: execution.signal, timedOut: cause === 'timeout', aborted: cause === 'abort',
          timeoutMs: spec.timeoutMs, stdout: finalOutput(stdout), stderr: finalOutput(observedStderr) }
      }),
    }
    cancel = stopGuest
    if (cause) stopGuest()
    live.set(execution, sessionId!)
    const done = (async () => {
      if (processHandle) {
        try {
          const outcome = await processHandle.done
          execution.exitCode = outcome.exitCode; execution.signal = outcome.signal
        } catch (error) {
          // A provider rejection after our own cancellation is a terminal outcome, not a spawn failure.
          if (!cause) failure ??= error
        }
        transportClosed = true
        detach()
        await cancellation
        try {
          const raw = await control(SHELL_CLEANUP)
          if (raw) {
            const reply = JSON.parse(raw) as { error?: string }
            if (reply.error) failure ??= new Error(reply.error)
          }
        } catch (error) { noteFailure(error) }
      } else detach()
      if (cleanupFailure !== undefined) execution.exitCode = 1
      finished = true
      execution.status = cause || failure !== undefined || execution.signal !== null ? 'killed' : 'completed'
      live.delete(execution)
    })().catch(error => {
      // Shell done NEVER rejects, even when control/diagnostic infrastructure itself fails.
      noteFailure(error); detach(); finished = true; execution.status = 'killed'; execution.exitCode = 1; live.delete(execution)
    }).then(() => {
      try { releaseOwner?.() } catch (error) { failure ??= error; execution.status = 'killed' }
    })
    Object.defineProperty(execution, 'done', { value: done })
    if (!finished) {
      try { releaseOwner = binding.ownExecution?.(execution, { cleanupError: () => cleanupFailure }) } catch (error) {
        execution.kill(); await done; throw error
      }
    }
    return execution
  }
  private settledTimeout(spec: ShellExecSpec): ShellExecution {
    const result: ShellRunResult = { exitCode: null, signal: null, timedOut: true, aborted: false, timeoutMs: spec.timeoutMs,
      stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }
    const projected = Promise.resolve(result)
    return { status: 'killed', exitCode: null, signal: null, done: Promise.resolve(), observed: { stdout: emptyReader, stderr: emptyReader },
      readOutput: () => ({ delta: '', lossy: false }), kill: () => false, result: () => projected }
  }
}
