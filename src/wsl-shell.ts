/** Standard bash's WSL executor; foreground promotion and job ownership remain DSH's responsibility. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { ShellExecRequest, ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'
import { randomUUID } from 'node:crypto'
import { guestPython, monitoredPlan, SHELL_CANCEL, SHELL_CLEANUP, type WslShellPlan } from './infra/wsl-shell-transport.ts'
import WslShellExecutor from 'dsh-wsl-workspace/shell'
import { wslCommand, wslExecutionFor } from './app/wsl-world.ts'

const cleanupFailures = new Map<string, unknown>()
/** Fail closed until an operator has explicitly confirmed guest cleanup for this Session. */
export function assertWslShellHealthy(sessionId: string | undefined): void {
  if (sessionId && cleanupFailures.has(sessionId)) throw new Error(`WSL shell guest cleanup not confirmed for Session ${sessionId}: ${String(cleanupFailures.get(sessionId))}`)
}
/** Recovery seam only: caller must first verify/restore guest process quiescence. */
export function clearWslShellFailure(sessionId: string): void { cleanupFailures.delete(sessionId) }
interface ShellTransportState {
  id: string; sessionId?: string; plan?: WslShellPlan; cancel?: Promise<void>
  detach?: () => void; error?: unknown; cancelled?: boolean; stopTransport?: () => void
}

/** Binds each managed Session's trusted guest environment and WSL identity to the public shell executor. */
export default class SuperagentWslShell extends WslShellExecutor {
  private readonly execution = new AsyncLocalStorage<string | undefined>()
  constructor(ctx: Context, config: unknown) {
    super(ctx, config)
    ctx.on('tools/execute', (exec, next) => this.execution.run(exec.agent?.id, next))
  }
  private readonly transports = new WeakMap<ShellExecSpec, ShellTransportState>()
  private noteFailure(state: ShellTransportState, error: unknown): void {
    state.error ??= error
    if (state.sessionId) cleanupFailures.set(state.sessionId, state.error)
  }

  override plan(spec: ShellExecSpec): WslShellPlan {
    const plan = super.plan(spec)
    const state = this.transports.get(spec)
    if (!state) return plan
    state.plan = plan
    return monitoredPlan(plan, state.id, this.config.graceMs)
  }

  private async control(plan: WslShellPlan, script: string, id: string): Promise<void> {
    const running = this.ctx.subprocess.spawn({ argv: guestPython(plan, script, id), cwd: plan.windowsCwd,
      env: plan.env, graceMs: this.config.graceMs, signal: AbortSignal.timeout(10_000),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } })
    const outcome = await running.done
    if (outcome.exitCode !== 0) throw new Error(`WSL shell control failed: ${running.collected.stderr?.readFrom(0).text}`)
  }

  override spawnSpec(plan: WslShellPlan, spec: ShellExecSpec, stdoutMaxBytes: number, signal?: AbortSignal) {
    const state = this.transports.get(spec)!
    const cancel = () => {
      state.cancelled = true
      state.cancel ??= this.control(state.plan!, SHELL_CANCEL, state.id).catch(error => { this.noteFailure(state, error); state.stopTransport?.() })
    }
    signal?.addEventListener('abort', cancel, { once: true })
    state.detach = () => signal?.removeEventListener('abort', cancel)
    if (signal?.aborted) cancel()
    // Vendor's fused timeout/caller signal requests guest cleanup, never terminates wsl.exe first.
    return super.spawnSpec(plan, spec, stdoutMaxBytes, undefined)
  }

  override spawnExecution(input: ShellExecSpec): ShellExecution {
    input.signal?.throwIfAborted()
    const spec = { ...input }
    const sessionId = input.dshEnv?.DSH_SESSION_ID ?? this.execution.getStore()
    assertWslShellHealthy(sessionId)
    const state: ShellTransportState = { id: randomUUID(), sessionId }
    this.transports.set(spec, state)
    let execution: ShellExecution
    try { execution = super.spawnExecution(spec) } catch (error) { state.detach?.(); throw error }
    const originalDone = execution.done
    const transportKill = execution.kill.bind(execution)
    let transportStopped = false
    state.stopTransport = () => {
      if (transportStopped) return
      transportStopped = true
      // Last-resort host containment only. It does NOT prove guest quiescence; sticky failure remains.
      execution.status = 'running'
      transportKill()
      execution.status = 'killed'
    }
    const result = execution.result.bind(execution)
    const readOutput = execution.readOutput.bind(execution)
    const stderr = execution.observed.stderr
    let finished = false
    let diagnosticRead = false
    const diagnostic = () => state.error === undefined ? '' : `\nWSL shell guest cleanup not confirmed: ${String(state.error)}\n`
    execution.readOutput = () => {
      const output = readOutput()
      const note = diagnosticRead ? '' : diagnostic()
      if (note) diagnosticRead = true
      return { ...output, delta: output.delta + (note ? `[stderr]${note}` : '') }
    }
    execution.observed.stderr = { readFrom: from => {
      if (!finished || state.error === undefined) return stderr.readFrom(from)
      const end = stderr.readFrom(0).nextOffset
      const read = stderr.readFrom(Math.min(from, end))
      const note = Buffer.from(diagnostic())
      return { ...read, text: read.text + note.subarray(Math.max(0, from - end)).toString(), nextOffset: end + note.length }
    } }
    const done = originalDone.then(async () => {
      if (state.cancelled) execution.status = 'killed'
      state.detach?.()
      await state.cancel
      try { await this.control(state.plan!, SHELL_CLEANUP, state.id) } catch (error) { this.noteFailure(state, error) }
      if (state.error !== undefined) { execution.status = 'killed'; execution.exitCode = 1 }
      finished = true
    })
    Object.defineProperty(execution, 'done', { value: done })
    execution.kill = () => {
      if (execution.status !== 'running') return false
      execution.status = 'killed'
      state.cancel ??= this.control(state.plan!, SHELL_CANCEL, state.id).catch(error => { this.noteFailure(state, error); state.stopTransport?.() })
      return true
    }
    let projected: ReturnType<ShellExecution['result']> | undefined
    execution.result = () => projected ??= (async () => {
      const output = await result()
      await done
      if (state.error) throw state.error
      // Vendor's unarmed ('none') projection omits caller-abort classification.
      return spec.onExpiry === 'none' && state.cancelled ? { ...output, aborted: true } : output
    })()
    return execution
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    const id = request.dshEnv?.DSH_SESSION_ID ?? this.execution.getStore()
    assertWslShellHealthy(id)
    const binding = wslExecutionFor(id)
    // These presets are deliberately not a general-purpose way around the host's execution policy.
    if (!binding?.machine.wsl) throw new Error('This WSL Session has no active Superagent execution binding')
    return super.resolve({ ...request, command: wslCommand(request.command, binding),
      dshEnv: { ...request.dshEnv, DSH_WSL_DISTRO: binding.machine.wsl.distro,
        ...binding.machine.wsl.user ? { DSH_WSL_USER: binding.machine.wsl.user } : {} } })
  }
}
