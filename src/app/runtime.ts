/** Application composition root and lifecycle manager for dsh-superagent. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { mkdirSync } from 'node:fs'
import { join, posix } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, key, reasonText, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import { runWsl } from '../infra/wsl.ts'
import { orchestratorWorkspace } from './wsl-world.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, triggerMessage, workerSessionId } from '../executor/dsh.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { AccountRuntime } from './account-runtime.ts'
import { MaintenanceGate } from '../execution/maintenance.ts'
import { assertLocalHostStateSync } from '../execution/host-path.ts'
import { SettingsConflict } from './settings.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()
/** Cross-bundle errors are structural; ordinary shutdown/result failures are not proof of an orphaned guest process. */
export function hasUnconfirmedExecutionCleanup(error: unknown): boolean {
  const seen = new Set<object>()
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== 'object' || seen.has(value)) return false
    seen.add(value)
    const record = value as { code?: unknown; cause?: unknown; errors?: unknown }
    return record.code === 'WSL_CLEANUP_UNCONFIRMED' || visit(record.cause) || Array.isArray(record.errors) && record.errors.some(visit)
  }
  return visit(error)
}

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime extends Service implements SourceHost {
  readonly maintenance = new MaintenanceGate()
  readonly accountRuntime: AccountRuntime
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private cleanupFault = false
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void) {
    super(ctx, 'orchestrator')
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    if (machine.wsl) assertLocalHostStateSync(machine.stateDir)
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      if (store.get(KV.runtime.executionCleanup)) this.maintenance.hold('guest-cleanup-safety', {
        code: 'guest-cleanup-unconfirmed', detail: 'Manual verification of guest execution cleanup is required' })
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart, verifiedExecution: true, onCleanupUnconfirmed: () => this.recordExecutionCleanup(),
         deploymentId: () => this.accountRuntime.deploymentId(), environmentRevision: () => store.get(KV.accounts.generation) ?? 0,
         acceptStartup: binding => this.accountRuntime.acceptStartup(binding),
         commitStartup: (stage, binding) => this.accountRuntime.commitStartup(stage, binding) })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, () => setup.commandEnvironment, this.lifetime, this.maintenance, () => setup.currentExecutionSnapshot, () => this.recordExecutionCleanup())
      const board = this.board
      const effects = this.effects = new Effects(store, board, undefined, this.maintenance)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
        lifetime: this.lifetime, maintenance: this.maintenance, recordExecutionCleanup: ids => this.recordExecutionCleanup(ids),
        closing: () => this.closing(), environment, executionBinding: () => setup.executionBinding,
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.accountRuntime = new AccountRuntime({ store, setup, maintenance: this.maintenance,
        busy: () => this.sessions.maintenanceBlockers(), restart: () => setup.restart() })
      this.settings = new Settings({ maintenance: this.maintenance,
        checkEnvironmentChange: async candidate => {
          const blockers = this.accountRuntime.blockers()
          if (!blockers.paused || blockers.items.length) throw new SettingsConflict('Pause and drain managed work before changing execution accounts or environment')
          const accepted = this.accountRuntime.accepted()
          const currentGithub = store.settings().sources.github?.config, nextGithub = candidate.sources.github?.config
          const githubIdentityChanged = currentGithub?.repository !== nextGithub?.repository || currentGithub?.cli !== nextGithub?.cli
          if (accepted && blockers.hasHistory && githubIdentityChanged) {
            const observed = await setup.observe(candidate)
            if (accepted.repositoryId !== observed.binding.repositoryId) throw new SettingsConflict('Repository history belongs to another stable repository ID')
          }
        }, store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine,
        executionSnapshot: () => setup.currentExecutionSnapshot, lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ maintenance: this.maintenance, store, effects, sources, commands, paused: () => this.paused() })
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
          // Notify the main Session only about domain events it did not initiate itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // Notify the ticket's conversations whenever it ends via a pull request.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended && setup.configured()) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
          }
        } })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ maintenance: this.maintenance, engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { maintenance: this.maintenance, store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.ready = this.initialize()
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> {
    const holds = this.maintenance.blockers().filter(item => item.code !== 'maintenance-active')
    return holds.length ? { ...this.board.all, execution: { state: 'paused', detail: holds.map(item => item.code).join(', ') } } : this.board.all
  }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused || this.maintenance.blockers().length > 0 }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    if (this.store.get(KV.runtime.executionCleanup)) {
      this.runtimeHealth.set({ state: 'error', detail: 'Guest execution cleanup is unconfirmed; manual verification is required before startup', at: now() })
      return
    }
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    if (this.closing()) return
    this.sessions.install()
    this.executor.install()
    const snapshot = this.setup.currentExecutionSnapshot
    if (this.machine.wsl && !snapshot) throw new Error('A verified execution snapshot is required before starting the orchestrator Session')
    const masterWorkspace = this.machine.wsl && snapshot ? posix.join(snapshot.workspaces?.deployment.guestPath ?? snapshot.target.workspace.guestPath, '.orchestrator')
      : orchestratorWorkspace(this.machine)
    if (this.machine.wsl && snapshot) await runWsl(this.machine, { argv: ['mkdir', '-p', '--', masterWorkspace], cwd: '/', expectedIdentity: snapshot.target, signal: this.lifetime, timeoutMs: 60_000 })
    await this.sessions.ensure(this.masterId, masterWorkspace, 'dsh-superagent orchestrator', 'orchestrator')
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, machine, masterId, ready, sourceLinks, setup, passes } = this
    return { accounts: this.accountRuntime.service, maintenance: this.maintenance, lifetime: this.lifetime,
      trackDiagnostic: work => this.trackDiagnostic(work), recordExecutionCleanup: ids => this.recordExecutionCleanup(ids),
      accountBlockers: () => this.accountRuntime.blockers(),
      store, sources, prompts, sessions, settings, engine, executor, machine, masterId, ready, sourceLinks,
      get health() { return runtime.health },
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog() }
  }
  /** Readonly deployment diagnostics share Setup's shutdown barrier, without bypassing the runtime lifetime. */
  async trackDiagnostic<T>(work: () => Promise<T>): Promise<T> {
    this.lifetime.throwIfAborted()
    if (this.closing()) throw new Error('Orchestrator is stopping')
    return this.setup.trackDiagnostic(work)
  }
  /** Public safety port for Commands and Session transports; persist only IDs, never command text or diagnostics. */
  recordExecutionCleanup(sessionIds: readonly string[] = [this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))]): void {
    this.cleanupFault = true
    this.maintenance.hold('guest-cleanup-safety', { code: 'guest-cleanup-unconfirmed', detail: 'Manual verification of guest execution cleanup is required' })
    this.runtimeHealth.set({ state: 'error', detail: 'Guest execution cleanup is unconfirmed; manual verification is required', at: now() })
    const previous = this.store.get(KV.runtime.executionCleanup)
    this.store.set(KV.runtime.executionCleanup, { code: 'guest-cleanup-unconfirmed', at: now(), sessionIds: [...new Set([...(previous?.sessionIds ?? []), ...sessionIds])] })
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true
    this.maintenance.hold('shutdown', { code: 'runtime-stopping' })
    const ids = [...new Set([this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))])]
    const passes = this.passes.stop()
    // Begin closing Session admission/preparation before aborting the runtime transport. Attach rejection handling immediately.
    let executions: Promise<boolean>
    try { executions = this.sessions.shutdownExecutions().then(() => true, error => {
      if (hasUnconfirmedExecutionCleanup(error)) this.cleanupFault = true
      return false
    }) } catch (error) {
      if (hasUnconfirmedExecutionCleanup(error)) this.cleanupFault = true
      executions = Promise.resolve(false)
    }
    this.stopped.abort()
    let failed = this.cleanupFault, retainLock = false
    try {
      this.assessor.stop()
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      const drained = await Promise.allSettled([passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      for (const result of drained) if (result.status === 'rejected') {
        failed = true
        if (hasUnconfirmedExecutionCleanup(result.reason)) this.cleanupFault = true
      }
      try { await this.executor.shutdown() } catch (error) {
        failed = true
        if (hasUnconfirmedExecutionCleanup(error)) this.cleanupFault = true
      }
      await this.setup.idle()
      await this.maintenance.idle()
      // This result is inspected and propagated, never hidden in an allSettled drain.
      if (!await executions || this.cleanupFault) failed = true
      if (!this.cleanupFault) {
        this.executor.dispose()
        this.sessions.dispose()
        await this.ctx.sessionPersistence.flush()
      }
    } catch (error) {
      failed = true
      if (hasUnconfirmedExecutionCleanup(error)) this.cleanupFault = true
    } finally {
      if (!await executions || this.cleanupFault) failed = true
      await this.setup.idle()
      if (this.cleanupFault) failed = true
      try { this.setup.restore() } catch (error) {
        failed = true
        if (hasUnconfirmedExecutionCleanup(error)) this.cleanupFault = true
      }
      if (this.cleanupFault) { try { this.recordExecutionCleanup(ids) } catch { retainLock = true } }
      await this.maintenance.idle()
      for (const dispose of this.disposers.reverse()) { try { dispose() } catch { /* Session admission remains closed. */ } }
      try { this.store.close() } finally {
        // If the failure marker cannot be persisted, retain this process's lock rather than permit an unsafe remount.
        if (!retainLock) await this.releaseLock?.().catch(() => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock') })
      }
    }
    if (failed) throw new Error(this.cleanupFault ? retainLock
      ? 'Guest cleanup is unconfirmed and its safety marker could not be saved; the state lock is retained for manual verification'
      : 'Guest execution cleanup is unconfirmed; manual verification is required before startup'
      : 'Orchestrator shutdown failed')
  }
}
