/** Read-only account observation, staged immutable environments, and one execution-snapshot switch. */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'
import { UserError } from '../core/index.ts'
import { SETUP_FIELDS, resolveDeployment, resolveFeishuBot, workerProbe, type Deployment, type Machine } from '../deployment.ts'
import { agentVariables, applyEnvironment, credentialHelper, withoutDirectory, workerBin, workerGitConfig, workerEnvironmentFiles, verifyNativeEnvironmentFiles, writeEnvironment } from '../infra/environment.ts'
import { runWsl, assertDefaultWslUser } from '../infra/wsl.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import { sameAccountBinding, type AccountBinding } from './account-binding.ts'
import { commandEnvironment, environmentSnapshot, type ExecutionSnapshot, type GuestIdentity, type ResolvedWorkspace } from '../execution/target.ts'
import { executionTargetId } from '../execution/target.ts'
import { resolveGuest, type ResolvedGuest } from '../execution/resolve.ts'
import { stageGuestGeneration, discardGuestGeneration, verifyGuestGeneration, type GuestGeneration } from '../execution/env-generation.ts'

/** Stable world ID plus observed boot/user/HOME: a rebuilt guest must request an explicit preserve rebind. */
export const executionBindingTarget = (identity: GuestIdentity, workspace: ResolvedWorkspace, deploymentWorkspace = workspace): string =>
  JSON.stringify([executionTargetId(identity), workspace.guestPath, workspace.hostPath, identity.bootId, identity.home, identity.user,
    deploymentWorkspace.guestPath, deploymentWorkspace.hostPath])

export interface SetupStage {
  deployment: Deployment
  env: Readonly<Record<string, string | undefined>>
  snapshot?: ExecutionSnapshot
  guest?: GuestGeneration
  directory?: string
}
export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  /** Enabled only after the caller routes every managed capability through the verified snapshot. */
  readonly verifiedExecution?: boolean
  deploymentId?(): string
  environmentRevision?(): number
  acceptStartup?(binding: AccountBinding): boolean
  commitStartup?(stage: SetupStage, binding: AccountBinding): void
  onCleanupUnconfirmed?(): void
  restart(): void
}
const setupFields = (settings: Settings) => JSON.stringify(Object.entries(SETUP_FIELDS).map(([id, keys]) => keys.map(key => settings.sources[id]?.config[key] ?? '')))
export const setupChanged = (before: Settings, after: Settings): boolean => setupFields(before) !== setupFields(after)
/** Owns one immutable active environment, tracked readonly observations, verified stages, and explicit same-generation integrity checks. */
export class Setup {
  private active?: Readonly<SetupStage>
  problem?: SetupProblem
  feishuProblem?: SetupProblem
  private readonly path: string
  private readonly variables: Record<string, string | undefined>
  private restoreEnvironment?: () => void
  private readonly pending = new Set<Promise<unknown>>()
  private readonly cleanupErrors = new WeakSet<object>()
  private cleanupFailure(error: unknown): void {
    if ((error as { code?: unknown } | null)?.code !== 'WSL_CLEANUP_UNCONFIRMED' || !error || typeof error !== 'object' || this.cleanupErrors.has(error)) return
    this.cleanupErrors.add(error)
    this.host.onCleanupUnconfirmed?.()
  }
  private track<T>(work: () => Promise<T>): Promise<T> {
    const operation = (async () => { try { return await work() } catch (error) { this.cleanupFailure(error); throw error } })()
    this.pending.add(operation)
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation))
    return operation
  }
  /** Manual diagnostics may observe health holds, but cannot enter after shutdown has aborted the shared lifetime. */
  async trackDiagnostic<T>(work: () => Promise<T>): Promise<T> {
    this.host.lifetime.throwIfAborted()
    return this.track(work)
  }
  /** Includes manual readonly probes, which must remain usable under account health holds but still finish before shutdown. */
  async idle(): Promise<void> { while (this.pending.size) await Promise.allSettled([...this.pending]) }
  get currentExecutionSnapshot(): ExecutionSnapshot | undefined { return this.active?.snapshot }
  get currentEnvironmentGeneration(): { directory: string; revision?: number; generationId?: string } | undefined {
    const active = this.active, directory = active?.guest?.directory ?? active?.directory
    return active && directory ? { directory, ...active.snapshot ? { revision: active.snapshot.revision, generationId: active.snapshot.target.generationId } : {} } : undefined
  }
  get executionBinding(): { machine: Machine; env: Record<string, string | undefined>; snapshot?: ExecutionSnapshot } | undefined {
    if (!this.host.machine.wsl || !this.active) return undefined
    return { machine: this.host.machine, env: { ...this.active.env }, ...this.active.snapshot ? { snapshot: this.active.snapshot } : {} }
  }
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
  }
  get commandEnvironment(): Record<string, string | undefined> { return this.active ? { ...this.active.env } : this.host.machine.wsl ? {} : { ...this.variables, PATH: this.path } }
  get deployment(): Deployment {
    if (!this.active) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.active.deployment
  }
  configured(): boolean { return this.active !== undefined }
  /** No filesystem mutations, setup, login switching, notification poll or engine pass. */
  observe(settings: Settings, prepare = false): Promise<{ deployment: Deployment; binding: AccountBinding; guest?: ResolvedGuest }> {
    return this.track(() => this.observePrepared(settings, prepare))
  }
  private async observePrepared(settings: Settings, prepare: boolean): Promise<{ deployment: Deployment; binding: AccountBinding; guest?: ResolvedGuest }> {
    this.host.lifetime.throwIfAborted()
    const { machine, lifetime } = this.host
    const guest = machine.wsl && this.host.verifiedExecution
      ? await resolveGuest(machine, settings.executor.directory || machine.wsl.workRoot, lifetime, prepare, error => this.cleanupFailure(error)) : undefined
    if (machine.wsl && !this.host.verifiedExecution) await assertDefaultWslUser(machine)
    const deployment = await resolveDeployment(machine, settings.sources.github?.config, this.probe(guest))
    lifetime.throwIfAborted()
    const binding: AccountBinding = { accountId: deployment.userId, repositoryId: deployment.repoId, login: deployment.github.login,
      repository: deployment.repository, cli: deployment.github.cli, noreply: deployment.github.noreply,
      executionTarget: guest ? executionBindingTarget(guest.identity, guest.workspace, guest.deploymentWorkspace)
        : machine.wsl ? JSON.stringify(['legacy-wsl', machine.wsl.distro, machine.wsl.user, settings.executor.directory || machine.wsl.workRoot]) : 'native' }
    return { deployment, binding, ...guest ? { guest } : {} }
  }
  run(settings: Settings): Promise<boolean> { return this.track(() => this.runPrepared(settings)) }
  private async runPrepared(settings: Settings): Promise<boolean> {
    try {
      const observed = await this.observe(settings, true)
      if (this.host.acceptStartup && !this.host.acceptStartup(observed.binding)) {
        this.problem = new SetupError('environmentFailed', { output: 'The observed account or execution identity requires explicit confirmation' }).problem
        return false
      }
      const stage = await this.stage(settings, observed.binding, observed)
      let committed = false
      try { this.host.lifetime.throwIfAborted(); this.host.commitStartup?.(stage, observed.binding); committed = !!this.host.commitStartup; this.activate(stage) }
      catch (error) { if (!committed) await this.discard(stage); throw error }
      return true
    } catch (error) {
      if (!(error instanceof SetupError)) { this.problem = new SetupError('environmentFailed', { output: 'Execution environment could not be verified' }).problem; return false }
      this.problem = error.problem
      return false
    }
  }
  check(): void { if (this.configured() && !this.feishuProblem) throw new UserError('setupComplete'); this.restart() }
  restart(): void { setTimeout(this.host.restart, 0) }
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    const { machine } = this.host
    const check = block === 'source:feishu' ? resolveFeishuBot(machine, settings.sources.feishu?.config, this.probe()) : this.observe(settings)
    await check.catch((error: unknown) => { if (!(error instanceof SetupError) || error.place === block.slice(7)) throw error })
  }
  async blockCommands(_blocked: readonly string[]): Promise<void> {
    // Generations are immutable. A managed runtime must prepare and activate a complete replacement under maintenance.
    if (this.active) this.restart()
  }
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined }
  private probe(guest?: ResolvedGuest) {
    const { context, machine, lifetime } = this.host
    if (machine.wsl) return (argv: string[]) => runWsl(machine, { argv, cwd: '/', signal: lifetime, timeoutMs: 60_000,
      ...guest ? { expectedIdentity: guest.identity } : {}, env: { GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_ENTERPRISE_TOKEN: undefined, GITHUB_ENTERPRISE_TOKEN: undefined,
        GH_CONFIG_DIR: undefined, GH_HOST: undefined, XDG_CONFIG_HOME: undefined, ...guest ? { HOME: guest.identity.home } : {}, GH_PROMPT_DISABLED: '1' } }).catch(error => { this.cleanupFailure(error); throw error })
    return workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime)
  }
  stage(settings: Settings, candidate: AccountBinding, prepared?: Awaited<ReturnType<Setup['observe']>>): Promise<SetupStage> {
    return this.track(() => this.stagePrepared(settings, candidate, prepared))
  }
  private async stagePrepared(settings: Settings, candidate: AccountBinding, prepared?: Awaited<ReturnType<Setup['observe']>>): Promise<SetupStage> {
    this.host.lifetime.throwIfAborted()
    const { context, machine, lifetime } = this.host
    const observed = prepared ?? await this.observe(settings, true)
    if (!sameAccountBinding(candidate, observed.binding)) throw new Error('Account changed while staging')
    const feishu = await resolveFeishuBot(machine, settings.sources.feishu?.config, this.probe(observed.guest)).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.feishuProblem = error.problem
      return undefined
    })
    const deployment = { ...observed.deployment, ...feishu ? { feishu } : {} }
    if (observed.guest) {
      const guest = await stageGuestGeneration(deployment, observed.guest, this.host.deploymentId?.() ?? randomUUID(),
        (this.host.environmentRevision?.() ?? this.active?.snapshot?.revision ?? 0) + 1, settings.executor.blockedCommands, lifetime)
      return { deployment, env: Object.freeze(commandEnvironment(guest.snapshot.environment)), snapshot: guest.snapshot, guest }
    }
    if (machine.wsl) throw new SetupError('environmentFailed', { output: 'Verified execution capabilities must be enabled before WSL environment activation' })
    const directory = join(machine.stateDir, 'generations', randomUUID())
    await mkdir(directory, { recursive: true, mode: 0o700 })
    try {
      await writeEnvironment({ ...deployment, stateDir: directory }, settings.executor.blockedCommands)
      const env = Object.freeze({ ...agentVariables(directory), PATH: [workerBin(directory), this.path].join(process.platform === 'win32' ? ';' : ':') })
      // Verification is scoped to this stage, not the Host's currently active mutable process environment.
      const { execFile } = await import('node:child_process'), { promisify } = await import('node:util')
      let output = ''
      try { output = (await promisify(execFile)('git', ['config', '-z', '--show-origin', '--get-all', 'credential.https://github.com.helper'], { cwd: directory, env: { ...process.env, ...env }, signal: lifetime })).stdout }
      catch { lifetime.throwIfAborted(); throw new SetupError('gitTooOld') }
      const expected = [`file:${workerGitConfig(directory)}`, credentialHelper(deployment.github.cli), ''].join('\0')
      if (output !== expected) throw new SetupError('gitTooOld')
      environmentSnapshot(env)
      return { deployment, env, directory }
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
  }
  /** Readonly proof for same-binding recovery; no stage, activation, restart, environment mutation or repair is permitted. */
  verifyAcceptedEnvironment(candidate: AccountBinding, settings: Settings): Promise<void> {
    return this.track(async () => {
      this.host.lifetime.throwIfAborted()
      const active = this.active
      if (!active) throw new Error('No active environment can be verified')
      const deployment = active.deployment
      const current: AccountBinding = { accountId: deployment.userId, repositoryId: deployment.repoId, login: deployment.github.login,
        repository: deployment.repository, cli: deployment.github.cli, noreply: deployment.github.noreply,
        executionTarget: active.snapshot ? executionBindingTarget(active.snapshot.target, active.snapshot.target.workspace, active.snapshot.workspaces?.deployment) : 'native' }
      if (!sameAccountBinding(candidate, current)) throw new Error('Accepted and active environment identities differ')
      if (deployment.wsl) {
        if (!active.snapshot || !active.guest || active.guest.snapshot !== active.snapshot
          || JSON.stringify(active.env) !== JSON.stringify(commandEnvironment(active.snapshot.environment))) throw new Error('Active guest environment is not verifiable')
        await verifyGuestGeneration(active.guest, settings.executor.blockedCommands, this.host.lifetime)
      } else {
        const directory = active.directory
        if (!directory || resolve(dirname(directory)) !== resolve(join(this.host.machine.stateDir, 'generations'))
          || active.env.GIT_CONFIG_GLOBAL !== workerGitConfig(directory) || active.env.PATH?.split(delimiter)[0] !== workerBin(directory)) throw new Error('Active native generation is not verifiable')
        await verifyNativeEnvironmentFiles(directory, workerEnvironmentFiles(deployment, settings.executor.blockedCommands, workerBin(directory)))
        const { execFile } = await import('node:child_process'), { promisify } = await import('node:util')
        const { stdout } = await promisify(execFile)('git', ['config', '-z', '--show-origin', '--get-all', 'credential.https://github.com.helper'],
          { cwd: directory, env: { ...process.env, ...active.env }, signal: this.host.lifetime })
        if (stdout !== [`file:${workerGitConfig(directory)}`, credentialHelper(deployment.github.cli), ''].join('\0')) throw new Error('Active native helper origin changed')
      }
      const observed = await this.observe(settings)
      this.host.lifetime.throwIfAborted()
      if (this.active !== active || !sameAccountBinding(candidate, observed.binding)) throw new Error('Identity changed while validating the active environment')
    })
  }
  /** Synchronous non-throwing switch; callers persist the activation record before this single reference assignment. */
  activate(stage: SetupStage): void {
    this.restore()
    if (!stage.deployment.wsl && stage.directory) this.restoreEnvironment = applyEnvironment(agentVariables(stage.directory), stage.directory, this.path)
    const deployment = Object.freeze({ ...stage.deployment, github: Object.freeze({ ...stage.deployment.github }),
      ...stage.deployment.wsl ? { wsl: Object.freeze({ ...stage.deployment.wsl }) } : {},
      ...stage.deployment.feishu ? { feishu: Object.freeze({ ...stage.deployment.feishu }) } : {} })
    this.active = Object.freeze({ ...stage, deployment, env: Object.freeze({ ...stage.env }) })
    this.problem = undefined
  }
  discard(stage: SetupStage): Promise<void> { return this.track(() => this.discardPrepared(stage)) }
  private async discardPrepared(stage: SetupStage): Promise<void> {
    if (stage === this.active || stage.snapshot && stage.snapshot === this.active?.snapshot) return
    if (stage.guest) await discardGuestGeneration(stage.guest, AbortSignal.timeout(60_000))
    else if (stage.directory && stage.directory.startsWith(join(this.host.machine.stateDir, 'generations') + (process.platform === 'win32' ? '\\' : '/'))) await rm(stage.directory, { recursive: true, force: true })
  }
}
