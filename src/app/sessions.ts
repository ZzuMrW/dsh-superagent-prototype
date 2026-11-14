/** Lifecycle, prompt/tool/skill decoration, message delivery, and budget retry tracking for orchestrator and worker DSH sessions. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { dirname, posix } from 'node:path'
import { z } from 'zod'
import { key, liveTicket, type Ticket } from '../core/index.ts'
import { mandateInstructions, ticketOfSession } from '../executor/dsh.ts'
import type { HealthEntry } from '../infra/health.ts'
import { AgentDelivery, messageId } from './delivery.ts'
import type { Effects } from './effects.ts'
import type { Variable } from './execution-environment.ts'
import { RetryHealth } from './retry-health.ts'
import { initializeRoleModel } from './role-models.ts'
import { bundledSkills } from './skill-files.ts'
import { SKILL_PREFIX, type PromptVersion, type Prompts } from './prompts.ts'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'
import type { RegisterTool, Tool } from './tools/tool.ts'
import { registerWslExecution, wslExecutionFor, type WslExecutionBinding } from './wsl-world.ts'
import { assertWslShellHealthy, disposeWslShellExecutions } from '../wsl-shell.ts'
import { SessionExecutionOwner, sessionExecutionKey, masterWorkspace } from '../execution/session-world.ts'
import { SessionExecutionRegistry, type SessionExecutionRecord } from '../execution/registry.ts'
import { WorkspacePathMapper, GUEST_PATH_FACTS, type GuestPathFacts } from '../execution/path-mapper.ts'
import { configureGuestFsResolver, withGuestFsSession } from '../wsl-fs.ts'
import { configureWorkspaceSessionRegistry } from '../workspace-files.ts'
import { runWsl } from '../infra/wsl.ts'
import { killJobs } from '../executor/background.ts'
import type { MaintenanceGate } from '../execution/maintenance.ts'
import { runningJobs } from '../executor/background.ts'

/** Host dependencies used by `Sessions`. */
export interface SessionsHost {
  /** DSH Cordis context: sessions, agents, persistence, and their events. */
  readonly context: Context
  readonly store: Pick<Store, 'tickets' | 'settings' | 'get' | 'set' | 'keys'>
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'compose' | 'skills'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'idle' | 'pending'>
  /** The `models` health entry, which reports managed sessions waiting on a model-budget retry. */
  readonly health: HealthEntry
  readonly masterId: string
  readonly lifetime: AbortSignal
  readonly maintenance?: MaintenanceGate
  /** Configured guest environment, read lazily after Setup completes. */
  executionBinding?(): WslExecutionBinding | undefined
  /** Persist only positively unconfirmed guest cleanup, never ordinary tool failures. */
  recordExecutionCleanup?(sessionIds?: readonly string[]): void
  closing(): boolean
  /** Execution environment variables for `ticket`, rendered into its worker's system prompt. */
  environment(ticket: Ticket): Variable[]
  /** Tools to register on the main Session (`ticket === undefined`) or on `ticket`'s worker Session. */
  tools(agent: Agent, ticket?: Ticket): Tool[]
}

/**
 * What Sessions registered for an agent it decorated: the releases of its prompt section, tools and skill scope, the scope
 * its skills are registered in, and the skills of one prompt revision; for a worker's subagent, only its tool limits.
 */
interface SessionBinding { disposers: (() => void)[]; scope?: Context; skills?: { revision: number; dispose: () => void }; subagent?: true; execution?: () => void }

/** The agent presets Executor Sessions and the main Session are created with, which the bundle's patch defines. */
export const WORKER_PRESET = 'dsh-superagent-worker', ROUTER_PRESET = 'dsh-superagent-router'
// The wsl- prefix opts out of workspace's browser auto-variant rebinding and host variant generation.
export const WSL_WORKER_PRESET = 'wsl-dsh-superagent-worker', WSL_ROUTER_PRESET = 'wsl-dsh-superagent-router'
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** DSH's agent preset registry selected `agentPreset` for a Session. */
    'agent-preset/selected'(sessionId: string, agentPreset: string): void
  }
}
/**
 * The DSH tools an Executor Session works with: files, search, the shell and its jobs, the web, skills, its todo list and
 * subagents. It gets no other tool the profile has, whenever it was registered: none that asks or shows a person something,
 * changes the profile, schedules work or starts goals outside the worker slots, the pause and a person's hold, starts or
 * messages other Sessions, or edits documents.
 */
const WORK_TOOLS = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'pwsh', 'job_output', 'job_list', 'job_kill', 'web_search',
  'web_fetch', 'skill', 'todo_write', 'subagent', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent']
/** What the main Session is told when it would wait: what it waits for comes to it, and a waiting step holds back the next. */
const NO_WAIT = 'Reports, follow_up notices, new candidates and a background job\'s end with its output arrive by themselves as messages; '
  + 'end the turn instead of waiting for them.'
/** What a main Session under `standard` is told when its command would wait the shell's default. */
const DEFAULT_WAIT = 'This shell waits up to 60 seconds by default: pass timeoutMs of at most 30000, or run_in_background, '
  + 'as a waiting step holds back new candidates.'
/** `sleep` at a command position: the start, after ; & | ( { ! ` or a newline, or after a keyword or a command that runs it. */
const SLEEP = /(?:^|[;&|({!`\n]|\b(?:do|then|else|elif|if|while|until|time|exec|nohup|command|env)\s)\s*(?:\S*\/)?sleep\b/
/**
 * The main Session's guard: it refuses a bash command that runs sleep or asks to hold the step longer than 30 seconds, and a
 * job wait longer than 5 seconds. Under `standard`, as a main Session created before the router preset runs, the shell holds
 * a command 60 seconds and a job wait lasts 30 seconds by default, so a command needs a timeout or the background, and a
 * job wait its timeout; the router preset ends both after 5 seconds.
 */
function noWait({ name, arguments: input }: { name: string; arguments: unknown }, routed: () => boolean): string | undefined {
  const args = (input ?? {}) as { command?: unknown; timeoutMs?: unknown; run_in_background?: unknown; wait?: unknown; timeout_ms?: unknown }
  if (name === 'bash') {
    const sleeps = typeof args.command === 'string' && SLEEP.test(args.command)
    if (sleeps || typeof args.timeoutMs === 'number' && args.timeoutMs > 30_000) return NO_WAIT
    if (args.timeoutMs === undefined && args.run_in_background !== true && !routed()) return DEFAULT_WAIT
  }
  if (name === 'job_output' && args.wait === true && (typeof args.timeout_ms === 'number' ? args.timeout_ms > 5_000 : !routed())) return NO_WAIT
  return undefined
}

/**
 * Creates and decorates orchestrator and worker DSH `Agent` sessions with role models, system prompt sections from `Prompts`, runtime skills, and restricted tool sets.
 * `Runtime`, `DshExecutor`, `MasterAssessor`, `Settings`, and management routes/tools use it to ensure sessions, deliver deduplicated messages via `AgentDelivery`, and process ordered `relay` and `notice` effects.
 * Feeds session events into `RetryHealth` to report model budget waits on the `models` `HealthEntry`, and durably records which prompt revisions each session has worked under in `Store` (`KV.sessions.prompts`) to authorize prompt version reads.
 */
export class Sessions {
  private readonly agentDelivery: AgentDelivery
  /** Decorated agents mapped to their registered disposers and skill scope until the agent is disposed or `Sessions.dispose()` runs. */
  private readonly bindings = new Map<Agent, SessionBinding>()
  private readonly retryHealth = new RetryHealth()
  private readonly ctx: Context
  private readonly executions: SessionExecutionOwner
  private readonly executionIds = new Set<string>()
  private shutdownPromise?: Promise<void>
  private disposed = false
  readonly executionRegistry: SessionExecutionRegistry
  private readonly releaseGuestResolver: () => void
  private readonly releaseWorkspaceRegistry: () => void
  private readonly turns = new Map<string, () => void>()
  /** Registers ordered `relay` and `notice` effect handlers that deliver to the main Session. */
  constructor(private readonly host: SessionsHost) {
    this.ctx = host.context
    this.executions = new SessionExecutionOwner(host.maintenance, ids => host.recordExecutionCleanup?.(ids))
    this.executionRegistry = new SessionExecutionRegistry({
      load: id => host.store.get(sessionExecutionKey(id)),
      isManagedSession: id => !!host.executionBinding?.()?.machine.wsl && (id === host.masterId || !!host.store.tickets.get(ticketOfSession(id) ?? '')),
      isCurrent: record => {
        const current = host.executionBinding?.()?.snapshot
        return !!current && current.target.id === record.snapshot.target.id && current.target.generationId === record.snapshot.target.generationId
      },
    })
    this.releaseWorkspaceRegistry = configureWorkspaceSessionRegistry(this.executionRegistry, record => this.executionFor(record))
    this.releaseGuestResolver = configureGuestFsResolver(async id => {
      if (!id) return undefined
      const found = await this.executionRegistry.lookup(id)
      if (found.kind !== 'managed') return undefined
      const binding = this.executionFor(found.record)
      return { identity: `${found.record.snapshot.target.id}:${found.record.snapshot.target.generationId}`, cwd: found.record.guestCwd,
        assertCurrent: binding.assertCurrent,
        mapPath: (input, cwd) => binding.mapPath!(input, undefined, cwd),
        transport: (script, payload, signal, maxBytes) => this.dispatchGuest(found.record, ['python3', '-c', script], payload, signal, maxBytes) }
    })
    this.agentDelivery = new AgentDelivery(host.context)
    // Deliver relays and notices to the main Session in the order they were queued.
    host.effects.handle('relay', ({ text }, requestId) => this.prompt(host.masterId, requestId, text, 'steer'), { ordered: true })
    host.effects.handle('notice', ({ value, summary }, name) => this.inject(name, value, summary), { ordered: true })
  }
  /** Subscribes to host agent and session events so newly created sessions are decorated and model-budget retries are reflected in health. Call once at startup. */
  install(): void {
    const ctx = this.ctx
    ctx.on('agent/pre-step', ({ agent }, next) => {
      if (!this.managed(agent.id)) return next()
      this.executions.assertOpen()
      return withGuestFsSession(agent.id, next)
    })
    ctx.on('tools/execute', (execution, next) => {
      const id = execution.agent?.id
      if (!id || !this.managed(id)) return next()
      this.executions.assertOpen()
      const release = this.host.maintenance?.admit('effect', `${id}/${execution.name}`)
      return withGuestFsSession(id, async () => { try { return await next() } finally { release?.() } })
    })
    ctx.on('agent/disposed', ({ agent }) => {
      this.release(agent)
      this.retryHealth.clear(agent.id); this.updateModelHealth()
    })
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      const binding = agent && agent.session === session ? this.bindings.get(agent) : undefined
      if (!agent || !binding || binding.subagent) return
      this.retryHealth.observe(agent.id, event)
      this.updateModelHealth()
    })
    ctx.on('agent/created', async ({ agent }) => { if (!this.disposed && !this.host.closing()) await this.decorate(agent); return undefined })
    // Opening a Session in DSH's Web UI before its first turn may select the default preset for it: select ours again. After
    // its first turn DSH refuses any selection, which leaves it as it is.
    ctx.inject(['agentPresets'], child => {
      child.on('agent-preset/selected', (sessionId, preset) => {
        if (this.disposed || this.host.closing()) return
        const ticketId = ticketOfSession(sessionId), agent = ctx.agents.get(sessionId as SessionId)
        const ours = sessionId === this.host.masterId ? this.preset('orchestrator') : ticketId && this.host.store.tickets.get(ticketId) ? this.preset('worker') : undefined
        if (!ours || preset === ours || !agent) return
        const presets = child.get('agentPresets') as { select(agent: Agent, preset: string): Promise<string> }
        presets.select(agent, ours).catch(() => {})
      })
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (this.managed(agent.id)) {
        this.turns.get(agent.id)?.(); this.turns.delete(agent.id)
        if (status === 'running') {
          try { this.executions.assertOpen(); const release = this.host.maintenance?.admit('turn', agent.id); if (release) this.turns.set(agent.id, release) }
          catch { agent.cancel({ kind: 'user' }, { keepInbox: true }) }
        }
      }
      if (status === 'idle' && !this.host.closing()) { this.retryHealth.clear(agent.id); this.updateModelHealth() }
    })
  }
  /** Resolves or creates session `id` in workspace `cwd`, initializes its role model, decorates it with prompts/skills/tools, sets `danger-full-access` permissions, and renames it to `title`. */
  async ensure(id: string, cwd: string, title: string, role: 'orchestrator' | 'worker'): Promise<Agent> {
    this.executions.assertOpen()
    const ctx = this.ctx
    const execution = this.host.executionBinding?.()
    if (execution?.machine.wsl) assertWslShellHealthy(id)
    let workspaceCwd = cwd
    let record: SessionExecutionRecord | undefined
    if (execution?.machine.wsl) {
      const snapshot = execution.snapshot
      if (!snapshot) throw new Error('WSL Session requires a verified execution snapshot')
      const header = ctx.get('sessions')?.get(id as SessionId)?.header
        ?? (await ctx.get('sessionPersistence')?.stat?.(id as SessionId, { signal: this.host.lifetime }))?.header
      if (header && header.agentPreset !== this.preset(role)) throw new Error('Existing Session was not created in this managed WSL world; create a new Session instead of migrating it')
      const master = masterWorkspace(snapshot)
      const provisional: SessionExecutionRecord = { sessionId: id, role, snapshot, guestCwd: snapshot.target.workspace.guestPath, hostCwd: snapshot.target.workspace.hostPath }
      const mapped = this.executionFor(provisional)
      const requested = role === 'orchestrator' ? master.guestCwd : await mapped.mapPath!(cwd, this.host.lifetime)
      const facts = JSON.parse(await this.dispatchGuest(provisional, ['python3', '-c', GUEST_PATH_FACTS, requested])) as GuestPathFacts
      if (!facts.exists || !facts.directory || !facts.path?.startsWith('/')) throw new Error('Managed Session workspace must be an existing canonical guest directory')
      const guestCwd = facts.path
      const hostCwd = (await this.dispatchGuest(provisional, ['wslpath', '-a', '-w', guestCwd])).trim()
      if (!hostCwd || !/^(?:[A-Za-z]:[\\/]|\\\\(?:wsl\.localhost|wsl\$)\\)/i.test(hostCwd)) throw new Error('Guest workspace has no registerable Host coordinate')
      record = { sessionId: id, role, snapshot, guestCwd, hostCwd }
      const stored = this.host.store.get(sessionExecutionKey(id))
      if (stored && (stored.snapshot.target.id !== snapshot.target.id || stored.guestCwd !== guestCwd || stored.hostCwd !== hostCwd)) throw new Error('Existing Session belongs to another execution target; create a new Session')
      // Metadata is persisted before activation; UI cold reads never load models or resolve Agents.
      this.host.store.set(sessionExecutionKey(id), record)
      this.executionRegistry.register(record)
      workspaceCwd = hostCwd
    }
    let result = await ctx.sessionController.resolveAgent(id as SessionId)
    if ('error' in result && result.error.code === 'session/not-found') {
      const workspace = await ctx.workspaceRegistry.create(workspaceCwd)
      // A Session keeps the preset it was created with, one of the bundle's own (cordis.patch.yml).
      await ctx.sessionController.create({ sessionId: id as SessionId, workspaceId: workspace.id,
        agentPreset: this.preset(role) })
      result = await ctx.sessionController.resolveAgent(id as SessionId)
    }
    if ('error' in result) throw result.error
    if (execution?.machine.wsl) {
      const presets = ctx.get('agentPresets') as { presetForSession(session: Agent['session']): string | null; select(agent: Agent, preset: string): Promise<string> }
      const wanted = this.preset(role)
      if (result.agent.session.header.agentPreset !== wanted) throw new Error('Existing Session was not created in this managed WSL world; create a new Session instead of migrating it')
      if (presets.presetForSession(result.agent.session) !== wanted) await presets.select(result.agent, wanted)
      // Never silently reuse a historical Windows workspace with a new WSL execution backend.
      const retainedCwd = result.agent.session.header.cwd
      if (!retainedCwd) throw new Error('WSL Session has no workspace')
      const retainedGuest = await this.executionFor(record!).mapPath!(retainedCwd, this.host.lifetime)
      if (posix.normalize(retainedGuest) !== record!.guestCwd) {
        throw new Error('Existing WSL Session belongs to a different workspace; use a fresh state directory instead of silently reusing it')
      }
    }
    const settings = this.host.store.settings()
    await initializeRoleModel(ctx, result.agent, role === 'orchestrator' ? settings.eval.model : settings.executor.model)
    await this.decorate(result.agent)
    ctx.permissionPresets.set(result.agent.session, 'danger-full-access')
    await ctx.sessionController.rename({ sessionId: id as SessionId, title })
    return result.agent
  }
  /** Returns whether `sessionId` already holds the message delivered under `requestId`, or `false` if the session does not exist. */
  async holds(sessionId: string, requestId: string): Promise<boolean> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    return !('error' in result) && await this.agentDelivery.holds(result.agent, key(requestId))
  }
  /** Deliver a message once per request id: to the next turn, the current one, or `inject`ed with its label without waking the agent. */
  async prompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    this.executions.assertOpen()
    if (this.host.executionBinding?.()?.machine.wsl) assertWslShellHealthy(sessionId)
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    if ('error' in result) throw result.error
    await this.agentDelivery.send(result.agent, key(requestId), text, mode, this.host.lifetime, authorize, accepted)
  }
  /** The id of the message `prompt` delivers under `requestId`, which DSH's inbox events name it by. */
  promptedId(requestId: string): MessageId { return messageId(key(requestId)) }
  /** Enqueues a steering relay to the main Session; relays are durable and retried by `Effects` until delivered, at most once per `requestId`. */
  relay(requestId: string, text: string): void { this.host.effects.enqueue('relay', requestId, { text }) }
  /** Enqueues a durable background notice for injection into the main Session; a new notice with the same `name` replaces a still-waiting notice of that `name`. */
  notify(name: string, value: Record<string, unknown>, summary: string): void { this.host.effects.enqueue('notice', name, { value, summary }) }
  /** Waits for currently runnable `notice` effects to settle and returns `'injected'` if notice `name` has reached the main Session or `'pending'` if it is still queued. */
  async delivery(name: string): Promise<'injected' | 'pending'> {
    await this.host.effects.idle('notice')
    return this.host.effects.pending('notice', name) ? 'pending' : 'injected'
  }
  /** Injects a notice into the main Session without waking it; no-op if the main Session does not exist yet. */
  private async inject(name: string, value: Record<string, unknown>, summary: string): Promise<void> {
    const resolved = await this.ctx.sessionController.resolveAgent(this.host.masterId as SessionId)
    if ('error' in resolved) return
    // Deduplicate by notice name and payload hash so retries are idempotent while updated payloads still deliver.
    const text = JSON.stringify(value)
    await this.agentDelivery.send(resolved.agent, `notice:${name}:${key(text)}`, text, { inject: summary }, this.host.lifetime)
  }
  /** Returns the current prompt revision, the active prompt revision of each loaded Session, and whether the main Session still has a pending `'prompts'` notice. */
  status() {
    const { store, prompts, effects } = this.host
    const sessions = store.keys(KV.sessions.prompts).flatMap(name => {
      const sessionId = name.slice(KV.sessions.prompts.prefix.length), revision = store.get(name)?.at(-1)
      return this.ctx.agents.get(sessionId as SessionId) && revision !== undefined ? [{ sessionId, revision }] : []
    })
    return { revision: prompts.current().revision, sessions, notificationPending: effects.pending('notice', 'prompts') }
  }
  /** Busy inspection is non-mutating and includes historical owners' jobs left for a person. */
  maintenanceBlockers(): { code: string; detail?: string }[] {
    const blockers: { code: string; detail?: string }[] = []
    const ids = new Set<string>([this.host.masterId, ...[...this.bindings.keys()].map(agent => agent.id)])
    try { for (const name of this.host.store.keys(KV.sessions.prompts)) ids.add(name.slice(KV.sessions.prompts.prefix.length)) }
    catch { blockers.push({ code: 'managed-session-discovery-unavailable' }) }
    for (const id of ids) {
      const agent = this.ctx.agents.get(id as SessionId)
      if (agent && agent.status !== 'idle') blockers.push({ code: 'managed-turn', detail: id })
      const pending = [...agent?.inbox?.nextTurn ?? [], ...agent?.inbox?.nextStep ?? []].some(message => {
        const source = message.source as { kind: string; form?: string; plugin?: string }
        return !(source.form === 'notice' && (source.kind === 'dsh-superagent' || source.kind === 'plugin' && source.plugin === 'dsh-superagent'))
      })
      if (pending) blockers.push({ code: 'managed-input-pending', detail: id })
      try { for (const job of runningJobs(this.ctx, id)) blockers.push({ code: 'managed-job', detail: `${id}/${job.id}` }) }
      catch { blockers.push({ code: 'managed-jobs-unavailable', detail: id }) }
    }
    return blockers
  }
  /** Returns the prompt version a Session runs under (the one bound on its latest model request, or the current version). */
  promptVersion(sessionId: string): PromptVersion {
    const revision = this.host.store.get(KV.sessions.prompts(sessionId))?.at(-1)
    return revision === undefined ? this.host.prompts.current() : this.host.prompts.version(revision)
  }
  /** Whether a Session is authorized to read `revision` (its active revision or any revision it previously ran under). */
  mayRead(sessionId: string, revision: number): boolean {
    return revision === this.promptVersion(sessionId).revision || (this.host.store.get(KV.sessions.prompts(sessionId)) ?? []).includes(revision)
  }
  /** Returns a tool registrar for `agent` that renders tool output as JSON text and attaches `output.image` as an image when present. */
  private registerTool(agent: Agent, binding: SessionBinding): RegisterTool {
    return (name, description, schema, execute) => {
      binding.disposers.push(agent.ctx.tools.register({ name, description, parameters: z.toJSONSchema(schema),
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => {
          const text = { type: 'text' as const, text: JSON.stringify(value) }
          const image = value && typeof value === 'object' && 'image' in value ? (value as { image: never }).image : undefined
          return image ? [text, { type: 'image' as const, attachment: image }] : [text]
        } },
        execute: (args, execution) => execute(schema.parse(args), execution.signal) }))
    }
  }
  /** Returns `sessionId`'s active model-budget retry state (`{ model_retry }`) for status listings, or `{}` when not waiting on one. */
  modelRetry(sessionId: string | undefined) {
    const retry = sessionId ? this.retryHealth.get(sessionId) : undefined
    return retry ? { model_retry: retry } : {}
  }
  private updateModelHealth(): void {
    const retries = this.retryHealth.list()
    this.host.health.set(retries.length
      ? { state: 'error', detail: retries.slice(0, 5).map(item => `${item.sessionId}: ${item.provider} is over its model budget; retried ${item.attempts} times, waiting since ${item.since}; the model and retry policy are unchanged`).join('; ') + (retries.length > 5 ? `; ${retries.length - 5} more Sessions` : ''), at: retries.at(-1)!.lastAt }
      : { state: 'ready', detail: 'No managed Session is waiting on a model budget retry' })
  }
  private managed(id: string): boolean {
    if (this.disposed) return false
    if (id === this.host.masterId || this.executionIds.has(id) || [...this.bindings.keys()].some(agent => agent.id === id)) return true
    return !this.host.closing() && !!this.host.store.tickets.get(ticketOfSession(id) ?? '')
  }
  private ticketOf(agent: Agent): Ticket | undefined {
    const ticketId = ticketOfSession(agent.id)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  private preset(role: 'orchestrator' | 'worker'): string {
    return this.host.executionBinding?.()?.machine.wsl
      ? role === 'worker' ? WSL_WORKER_PRESET : WSL_ROUTER_PRESET
      : role === 'worker' ? WORKER_PRESET : ROUTER_PRESET
  }
  /** All guest calls use immutable machine identity, including independent control calls during teardown. */
  private async dispatchGuest(record: SessionExecutionRecord, argv: string[], stdin?: string, signal?: AbortSignal, maxBuffer?: number, cleanup = false): Promise<string> {
    if (!cleanup) { this.executions.assertOpen(); await this.executionRegistry.assertCurrent(record) }
    const target = record.snapshot.target, configured = this.host.executionBinding?.()?.machine
    if (!configured) throw new Error('Managed execution machine is unavailable')
    const machine = { ...configured, wsl: { ...configured.wsl!, distro: target.distro, user: target.user } }
    try {
      return await runWsl(machine, { argv, cwd: cleanup ? '/' : record.guestCwd, stdin,
        env: { ...record.snapshot.environment.set, ...Object.fromEntries(record.snapshot.environment.unset.map(key => [key, undefined])) },
        expectedIdentity: { uid: target.uid, bootId: target.bootId },
        signal: cleanup ? AbortSignal.timeout(15000) : AbortSignal.any([this.host.lifetime, signal ?? AbortSignal.timeout(90000)]),
        timeoutMs: cleanup ? 10000 : 90000, maxBuffer })
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'WSL_CLEANUP_UNCONFIRMED') this.executions.unconfirmed(record.sessionId, error)
      throw error
    }
  }
  private shellPolicyFor(sessionId: string) {
    const session = this.ctx.agents.get(sessionId as SessionId)?.session
    const policy = this.ctx.get('sandboxPolicy')
    if (!session || !policy) throw new Error('WSL shell policy requires this exact live Session and its sandbox policy service')
    return policy.resolve({ session })
  }
  private executionFor(record: SessionExecutionRecord): WslExecutionBinding {
    const execution = this.host.executionBinding?.()
    if (!execution) throw new Error('Managed execution binding is unavailable')
    const mapper = new WorkspacePathMapper(record.snapshot.target, {
      guest: (argv, signal) => this.dispatchGuest(record, argv, undefined, signal),
      host: async () => { throw new Error('Session path mapping cannot register a new workspace root') },
    })
    return { ...execution, snapshot: record.snapshot, guestCwd: record.guestCwd, hostCwd: record.hostCwd,
      lifetime: this.host.lifetime, onCleanupUnconfirmed: error => this.executions.unconfirmed(record.sessionId, error ?? new Error('Guest cleanup unconfirmed')),
      assertCurrent: async () => { this.executions.assertOpen(); await this.executionRegistry.assertCurrent(record) },
      resolveShellPolicy: () => this.shellPolicyFor(record.sessionId),
      mapPath: async (input, signal = this.host.lifetime, cwd = record.guestCwd) => {
        signal.throwIfAborted()
        // Core workingDirectory supplies Host coordinates even inside a managed WSL preset.
        // Map that trusted per-call base through this pinned target before resolving any relative input.
        const guestBase = await mapper.guestPath(cwd, record.guestCwd, signal)
        signal.throwIfAborted()
        return mapper.guestPath(input, guestBase, signal)
      },
      mapHostPath: async (guestPath, signal) => (await this.dispatchGuest(record, ['wslpath', '-a', '-w', guestPath], undefined, signal)).trim(),
      control: (script, id) => this.dispatchGuest(record, ['python3', '-c', script, id], undefined, undefined, 65536, true),
      ownExecution: (handle, diagnostics) => this.executions.own(record.sessionId, handle, diagnostics) }
  }
  private bindExecution(agent: Agent, binding: SessionBinding, ticket?: Ticket): void {
    const execution = this.host.executionBinding?.()
    if (!execution?.machine.wsl) return
    const record = this.host.store.get(sessionExecutionKey(agent.id))
    if (!record) return // A managed but unverified Session stays blocked; never install a deployment-global cwd.
    binding.execution?.()
    this.executionRegistry.register(record)
    this.executionIds.add(agent.id)
    binding.execution = registerWslExecution(agent.id, this.executionFor(record), () => ticket
      ? Object.fromEntries(this.host.environment(this.host.store.tickets.get(ticket.id) ?? ticket).map(item => [item.key, item.value])) : {})
  }
  private async decorate(agent: Agent): Promise<void> {
    const previous = this.bindings.get(agent)
    if (previous) { if (!previous.subagent) this.bindExecution(agent, previous, this.ticketOf(agent)); return }
    const host = this.host
    const master = agent.id === host.masterId
    const ticket = master ? undefined : this.ticketOf(agent)
    if (!master && !ticket) { await this.limitSubagent(agent); return }
    const binding: SessionBinding = { disposers: [] }
    this.bindings.set(agent, binding)
    this.bindExecution(agent, binding, ticket)
    binding.disposers.push(agent.ctx.tools.guard(execution => {
      if (!wslExecutionFor(agent.id) || !['bash', 'pwsh', 'write', 'edit', 'subagent', 'workflow'].includes(execution.name)) return undefined
      try { assertWslShellHealthy(agent.id); return undefined }
      catch (error) { return error instanceof Error ? error.message : String(error) }
    }))
    this.retryHealth.restore(agent.id, agent.session.snapshotEvents())
    if (agent.status === 'idle') this.retryHealth.clear(agent.id)
    this.updateModelHealth()
    // Disable variable interpolation so literal ${{ ... }} expressions in team prompts are preserved.
    binding.disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-superagent-policy', order: 9999, interpolate: false, text: context => {
      const version = this.promptFor(agent, context.signal !== undefined)
      const current = ticket && host.store.tickets.get(ticket.id)
      const composed = host.prompts.compose(version.config, master ? 'orchestrator' : 'worker', current ? host.environment(current) : undefined)
      return `[dsh-superagent prompt revision ${version.revision}]\n${composed}\n${current ? mandateInstructions(current.mandate) : ''}`
    }, ...(master ? { complete: true } : {}) }))
    // A recreated skill scope (e.g. after the skills service restarts) starts empty, so reset `binding.skills` before rebinding.
    const skillScope = agent.ctx.inject(['skills'], scope => {
      binding.scope = scope
      binding.skills = undefined
      this.bindSkills(binding, host.prompts.current())
    })
    binding.disposers.push(() => { skillScope.dispose().catch((error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release a skill scope: %s', String(error)) }) })
    await skillScope
    // Bail out if the agent was disposed while awaiting the skill scope.
    if (this.bindings.get(agent) !== binding) return
    const register = this.registerTool(agent, binding)
    for (const tool of host.tools(agent, ticket)) register(tool.name, tool.description, tool.schema, tool.execute)
    if (master) {
      binding.disposers.push(agent.ctx.tools.restrict({ allow: ['skill', 'bash', 'read', 'read_image', 'job_output', 'job_list', 'job_kill'] }),
        agent.ctx.tools.guard(execution => noWait(execution, () => this.routed(agent))))
    } else {
      // An Executor Session keeps the profile's work tools it has, which DSH requires to be known; its own tools are not masked.
      binding.disposers.push(...this.workOnly(agent, ticket!.id))
    }
  }
  /**
   * Whether a Session runs the router preset: as DSH's preset registry last selected it, read through the session projection
   * on a DSH whose registry has no `presetForSession`, else as it was created; `standard`, the safer caps, when unreadable.
   */
  private routed(agent: Agent): boolean {
    try {
      const presets = this.ctx.get('agentPresets') as { presetForSession?: (session: Agent['session']) => string | null } | undefined
      const projections = this.ctx.get('sessionProjections') as { stateOf?: (session: Agent['session'], key: string) => unknown } | undefined
      const selected = typeof presets?.presetForSession === 'function' ? presets.presetForSession(agent.session)
        : projections?.stateOf?.(agent.session, 'agentPreset')
      const preset = selected ?? agent.session.header.agentPreset
      return typeof preset === 'string' && [ROUTER_PRESET, WSL_ROUTER_PRESET].includes(preset)
    } catch { return false }
  }
  /**
   * An Executor Session's tools: only the profile's work tools, which DSH requires to be known, and none once its ticket
   * ended. A failed or blocked worker keeps its tools, so a person may continue it in its Session; only automated input waits
   * (see the executor). Read inherited tools through the parent scope, which includes the preset's tools. The global view
   * misses preset tools; the agent's own view also includes local tools such as subagent, which restrict refuses to name.
   */
  private workOnly(agent: Agent, ticketId: string): (() => void)[] {
    const store = this.host.store
    const parent = scopeParentOf(agent)
    const allow = WORK_TOOLS.filter(name => agent.ctx.tools.get(name, parent))
    return [agent.ctx.tools.restrict({ allow }), agent.ctx.tools.guard(execution => {
      if (wslExecutionFor(agent.id) && (execution.name === 'subagent' || execution.name.startsWith('subagent_') || execution.name === 'workflow')) {
        return 'WSL workers do not support delegation on this DSH release; complete the authorized ticket in this Session'
      }
      const current = store.tickets.get(ticketId)
      return !current || !liveTicket(current) ? 'Ticket ended; new work needs a new authorized ticket' : undefined
    })]
  }
  /**
   * A subagent of an Executor Session, or of one of its subagents, which runs under DSH's `standard` preset with the worker's
   * permissions, gets the same work tools as the worker, and none once the worker's ticket ended. Any other agent is left as
   * it is.
   */
  private async limitSubagent(agent: Agent): Promise<void> {
    let parent = agent.session.header.parentSession
    // Up the subagents' parents to the worker, which are loaded while their subagents run.
    for (let depth = 0; parent !== undefined && ticketOfSession(parent) === undefined && depth < 8; depth++) {
      parent = this.ctx.agents.get(parent)?.session.header.parentSession
    }
    const ticketId = parent === undefined ? undefined : ticketOfSession(parent)
    if (ticketId === undefined || !this.host.store.tickets.get(ticketId)) return
    const execution = parent === undefined ? undefined : wslExecutionFor(parent)
    if (execution?.machine.wsl) {
      const presets = this.ctx.get('agentPresets') as { select(agent: Agent, preset: string): Promise<string> }
      await presets.select(agent, WSL_WORKER_PRESET)
    }
    const binding: SessionBinding = { disposers: this.workOnly(agent, ticketId), subagent: true }
    this.bindings.set(agent, binding)
    if (execution) {
      this.executionIds.add(agent.id)
      binding.execution = registerWslExecution(agent.id, { ...execution,
        resolveShellPolicy: () => this.shellPolicyFor(agent.id),
        ownExecution: (handle, diagnostics) => this.executions.own(agent.id, handle, diagnostics) }, execution.variables)
    }
  }
  /** Register the skills of a prompt version in the agent's skill scope, in place of an earlier version's. */
  private bindSkills(binding: SessionBinding, version: PromptVersion): void {
    const { scope, skills: previous } = binding
    if (!scope || previous?.revision === version.revision) return
    previous?.dispose()
    const disposers: (() => void)[] = []
    for (const [name, content] of this.host.prompts.skills(version.config)) {
      const bundled = name === 'feishu' || name === 'github' ? bundledSkills[name] : undefined
      const body = version.config.skills[name] ?? ''
      const description = bundled?.description ?? (body.replace(/\s+/g, ' ').slice(0, 120) || 'Custom dsh-superagent operational skill.')
      disposers.push(scope.skills.register({ name: `${SKILL_PREFIX}${name}`, description, content, source: 'runtime',
        ...(bundled ? { resourceBase: { kind: 'directory' as const, path: dirname(bundled.path) } } : {}) }))
    }
    binding.skills = { revision: version.revision, dispose: () => { disposers.forEach(dispose => dispose()) } }
  }
  /** Return the current prompt version, updating the agent's skills and recording the revision in Store when bound to a model request. */
  private promptFor(agent: Agent, bind: boolean): PromptVersion {
    const version = this.host.prompts.current()
    if (!bind) return version
    const binding = this.bindings.get(agent)
    if (binding) this.bindSkills(binding, version)
    const { store } = this.host
    const revisions = store.get(KV.sessions.prompts(agent.id)) ?? []
    const bound = [...revisions.filter(revision => revision !== version.revision), version.revision]
    if (revisions.at(-1) !== version.revision) store.set(KV.sessions.prompts(agent.id), bound)
    return version
  }
  /** Releases registrations for `agent` in reverse order (LIFO); disposing its skill scope releases its skills as well. */
  private release(agent: Agent): void {
    const binding = this.bindings.get(agent)
    if (!binding) return
    this.bindings.delete(agent)
    binding.skills?.dispose()
    binding.execution?.()
    for (const dispose of binding.disposers.splice(0).reverse()) {
      try { dispose() } catch (error) { this.ctx.logger.warn('dsh-superagent could not release what it registered for a Session: %s', String(error)) }
    }
  }
  /** Close admission before any awaited teardown; this barrier must precede subprocess and Store disposal. */
  shutdownExecutions(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.executions.close()
    let discoveryError: unknown
    let workers: string[] = []
    try { workers = this.host.store.tickets.list().map(ticket => `worker-${ticket.id}`) } catch (error) { discoveryError = error }
    const ids = new Set([this.host.masterId, ...this.executionIds, ...this.executions.ids(),
      ...workers, ...[...this.bindings.keys()].map(agent => agent.id)])
    // Calling (not awaiting) the shell helper closes preparation synchronously, before Root handles are killed.
    const shells = [...ids].map(id => disposeWslShellExecutions(id))
    const owners = this.executions.shutdown()
    this.shutdownPromise = (async () => {
      const roots = [...ids].map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => !!agent)
      const subagents = this.ctx.get('subagents') as { drainDescendants?(roots: readonly Agent[]): Promise<void>;
        listDescendants?(id: SessionId): Promise<readonly unknown[]> } | undefined
      const drain = Promise.resolve().then(async () => {
        if (!subagents || !roots.length) return
        if (subagents.drainDescendants) return subagents.drainDescendants(roots)
        if (!subagents.listDescendants) throw new Error('Managed descendant discovery is unavailable during final shutdown')
        for (const root of roots) if ((await subagents.listDescendants(root.id)).length) throw new Error('Resident descendants cannot be safely drained on this DSH release')
      })
      const critical = [owners, ...shells, drain]
      const work = [...critical,
        ...roots.map(async agent => {
          agent.cancel({ kind: 'user' }, { keepInbox: true })
          if (agent.status !== 'idle') await agent.whenIdle()
        }),
        ...[...ids].map(id => killJobs(this.ctx, id, 'dsh-superagent stopped'))]
      const results = await Promise.allSettled(work)
      for (const release of this.turns.values()) release(); this.turns.clear()
      const errors = results.slice(0, critical.length).filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason)
      if (discoveryError !== undefined) errors.push(discoveryError)
      for (const id of ids) try { assertWslShellHealthy(id) } catch (error) { this.executions.unconfirmed(id, error); errors.push(error) }
      for (const root of roots) if (root.status !== 'idle') errors.push(new Error(`Managed turn remains after shutdown: ${root.id}`))
      for (const id of ids) {
        try { if (runningJobs(this.ctx, id).length) errors.push(new Error(`Managed jobs remain after shutdown: ${id}`)) }
        catch (error) { errors.push(error) }
      }
      // Kill/cancel errors with positive idle/job/cleanup evidence above are ordinary operation failures, not uncertainty.
      if (errors.length) {
        const error = Object.assign(new AggregateError(errors, 'Managed Session shutdown failed'), { code: 'WSL_CLEANUP_UNCONFIRMED' })
        for (const id of ids) this.executions.unconfirmed(id, error)
        throw error
      }
    })()
    return this.shutdownPromise
  }
  /** Releases prompt sections, skills, and tools registered by `Sessions` across all decorated agents. */
  dispose(): void {
    this.disposed = true
    this.releaseGuestResolver(); this.releaseWorkspaceRegistry()
    for (const release of this.turns.values()) release(); this.turns.clear()
    for (const agent of [...this.bindings.keys()]) this.release(agent)
  }
}
