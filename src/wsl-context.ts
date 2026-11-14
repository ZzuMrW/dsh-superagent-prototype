/** Selected-user project instructions and skills through public DSH discovery/rendering and provider contracts. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { createHash } from 'node:crypto'
import { dirname, basename, join, relative, resolve, posix } from 'node:path'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { renderAgentInstructions, type Config as InstructionConfig, type LoadedInstructionFile, type InstructionFile } from '@deepseek-ai/dsh-agent-instructions'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import type { SkillLookupOptions } from '@deepseek-ai/dsh-skill'
import GuestFileSystem, { withGuestFsSession } from './wsl-fs.ts'
import { wslExecutionFor, type WslExecutionBinding } from './app/wsl-world.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Accurate selected-user baseline metadata; no Host-user path aliases appear in its content or sources. */
    'dsh-superagent-project-instructions': { kind: 'dsh-superagent-project-instructions'; form: 'instructions'; digest: string;
      targetId: string; generationId: string; files: { path: string; version?: string }[] }
  }
}

/** Host coordinates are path-algebra/presentation only; every actual read is selected-user RPC. */
export class SessionContextFileSystem extends GuestFileSystem {
  private readonly coordinates = new Map<string, string>()
  constructor(ctx: Context, private readonly sessionId: string, private readonly world: WslExecutionBinding) { super(ctx.isolate('fs')) }
  private run<T>(work: () => T): T { return withGuestFsSession(this.sessionId, work) }
  private async coordinate(target: FsTarget, signal?: AbortSignal): Promise<FsTarget> {
    const known = this.coordinates.get(String(target.targetKey))
    if (known) return { ...target, displayPath: known }
    const path = super.processPath(target)
    if (!this.world.mapHostPath) throw new Error('Instruction filesystem requires the verified Host path mapper')
    const host = await this.world.mapHostPath(path, signal)
    this.coordinates.set(String(target.targetKey), host)
    return { ...target, displayPath: host }
  }
  override resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }) {
    return this.run(async () => this.coordinate(await super.resolve(path, opts), opts?.signal))
  }
  override processPath(target: FsTarget): string {
    const host = this.coordinates.get(String(target.targetKey))
    if (!host) throw new Error('Instruction target lacks a verified Host coordinate')
    return host
  }
  override fileUrl(target: FsTarget): string { return 'file://' + super.processPath(target).split('/').map(encodeURIComponent).join('/') }
  override stat(...args: Parameters<GuestFileSystem['stat']>) { return this.run(() => super.stat(...args)) }
  override lstat(...args: Parameters<GuestFileSystem['lstat']>) { return this.run(() => super.lstat(...args)) }
  override readText(...args: Parameters<GuestFileSystem['readText']>) { return this.run(() => super.readText(...args)) }
  override readBytes(...args: Parameters<GuestFileSystem['readBytes']>) { return this.run(() => super.readBytes(...args)) }
  override readByteRange(...args: Parameters<GuestFileSystem['readByteRange']>) { return this.run(() => super.readByteRange(...args)) }
  override streamText(...args: Parameters<GuestFileSystem['streamText']>) {
    const self = this
    return this.run(async () => {
      const stream = await super.streamText(...args)
      return (async function* () {
        const iterator = stream[Symbol.asyncIterator]()
        try { for (;;) { const next = await self.run(() => iterator.next()); if (next.done) break; yield next.value } }
        finally { await self.run(() => iterator.return?.()) }
      })()
    })
  }
  override listDir(...args: Parameters<GuestFileSystem['listDir']>) {
    return this.run(async () => Promise.all((await super.listDir(...args)).map(async entry => ({ ...entry, target: await this.coordinate(entry.target, args[1]) }))))
  }
}
interface Entry { binding: WslExecutionBinding; fs: SessionContextFileSystem; dshHome: string; agentsHome: string;
  touched: Set<string>; overflow?: boolean; invalidate?: () => void; assertOwner(): void; dispose(): Promise<void> }
/** One owned binding incarnation; asynchronous touches never replace its initialization or ownership slot. */
interface ContextSlot {
  agent: Agent
  binding: NonNullable<ReturnType<typeof wslExecutionFor>>
  cancel: AbortController
  ready?: Promise<Entry>
  touch: Promise<void>
  scope?: Scope
  retired: boolean
  retirement?: Promise<void>
}
export const name = 'superagent-wsl-context'
export const inject = ['agents', 'workingDirectory', 'skills']
const sourceKind = 'dsh-superagent-project-instructions' as const
const digestOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Core's exported discoverBaselineInstructionFiles does direct Node I/O; this owned discovery never does. */
async function discoverSelectedInstructions(entry: Entry, cwd: string, config: InstructionConfig, signal: AbortSignal): Promise<InstructionFile[]> {
  const fs = entry.fs, files: InstructionFile[] = []
  const exists = async (path: string): Promise<boolean> => {
    const info = await fs.lstat(path, undefined, signal)
    if (info?.type !== 'symlink') return info !== undefined
    return await fs.stat(await fs.resolve(path, { signal }), signal) !== undefined
  }
  let projectRoot = resolve(cwd)
  for (let depth = 0; depth < 256; depth++) {
    let marker = false
    for (const name of config.projectRootMarkers ?? ['.git']) {
      if (!name || /[\\/\x00-\x1f]/.test(name) || name === '..') throw new Error('Instruction project markers must be direct directory entries')
      if (await exists(join(projectRoot, name))) { marker = true; break }
    }
    const parent = dirname(projectRoot)
    if (marker || parent === projectRoot) break
    projectRoot = parent
    if (depth === 255) throw new Error('Instruction project ancestry exceeded 256 directories')
  }
  for (const [home, label] of [[entry.dshHome, entry.binding.snapshot!.environment.set.DSH_HOME ? '$DSH_HOME' : '~/.dsh'],
    [entry.agentsHome, entry.binding.snapshot!.environment.set.DSH_AGENTS_HOME ? '$DSH_AGENTS_HOME' : '~/.agents']]) {
    const absolutePath = join(home!, 'AGENTS.md')
    if (await exists(absolutePath)) files.push({ absolutePath, displayPath: `${label}/AGENTS.md` })
  }
  const chain: string[] = []
  for (let path = resolve(cwd); ; path = dirname(path)) {
    chain.unshift(path)
    if (path === projectRoot) break
    if (path === dirname(path)) throw new Error('Instruction project root does not contain the Session cwd')
  }
  const candidates = [...config.instructionFileCandidates ?? ['AGENTS.md', 'CLAUDE.md'],
    ...config.localInstructionFileCandidates ?? ['AGENTS.local.md', 'CLAUDE.local.md']]
  for (const directory of chain) for (const name of candidates) {
    if (!name || name === '.' || name === '..' || /[\\/\x00-\x1f]/.test(name)) throw new Error('Instruction candidates must be direct file names')
    const absolutePath = join(directory, name)
    if (await exists(absolutePath)) files.push({ absolutePath, displayPath: relative(projectRoot, absolutePath).replaceAll('\\', '/') })
  }
  return files
}

/** Bounded, version-checked reads; rendering is exactly DSH's public renderer, never edited prompt prose. */
export async function selectedInstructionBaseline(entry: Entry, config: InstructionConfig, signal: AbortSignal): Promise<LoadedInstructionFile[]> {
  if (entry.overflow) throw new Error('Selected-user instruction discovery exceeded 128 touched directories; refusing an incomplete baseline')
  const found = new Map<string, InstructionFile>()
  for (const cwd of [entry.binding.hostCwd!, ...entry.touched]) {
    const files = await discoverSelectedInstructions(entry, cwd, config, signal)
    for (const file of files) found.set(file.absolutePath, file)
  }
  const loaded: LoadedInstructionFile[] = [], seen = new Map<string, Set<string>>()
  const cap = config.maxSourceBytes ?? 1048576
  for (const file of found.values()) {
    signal.throwIfAborted()
    const target = await entry.fs.resolve(file.absolutePath, { signal }), before = await entry.fs.stat(target, signal)
    if (before?.type !== 'file' || before.size !== undefined && before.size > cap) continue
    const bytes = await entry.fs.readBytes(target, signal, cap), after = await entry.fs.stat(target, signal)
    if (!after || before.version !== after.version) throw new Error('Instruction source changed while reading; retry the step')
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (content.includes('\0')) throw new Error('Instruction source is not UTF-8 text')
    const directory = dirname(file.absolutePath)
    const group = directory === entry.dshHome || directory === entry.agentsHome ? 'user-global'
      : `${directory}:${(config.localInstructionFileCandidates ?? ['AGENTS.local.md', 'CLAUDE.local.md']).includes(basename(file.absolutePath)) ? 'local' : 'base'}`
    const digest = digestOf(content.trim()), grouped = seen.get(group) ?? new Set<string>()
    if (grouped.has(digest)) continue
    grouped.add(digest); seen.set(group, grouped)
    loaded.push({ ...file, content, version: before.version })
  }
  return loaded
}

/** Install inside the WSL preset, replacing its Host instruction/skill filesystem plugins. */
export function apply(ctx: Context, config: InstructionConfig = { maxBytes: 65536 }): void {
  const entries = new Map<string, ContextSlot>()
  const retirements = new Map<string, Promise<void>>()
  const authorities = new WeakMap<Agent, { targetId: string; guestCwd: string; hostCwd: string }>()
  const replaced = () => new Error('Project context execution binding was replaced or disposed')
  const assertOwner = (slot: ContextSlot): void => {
    if (slot.retired || slot.cancel.signal.aborted || entries.get(slot.agent.id) !== slot || wslExecutionFor(slot.agent.id) !== slot.binding) throw replaced()
  }
  const retire = (slot: ContextSlot): Promise<void> => {
    if (slot.retirement) return slot.retirement
    slot.retired = true
    slot.cancel.abort(replaced())
    // Preparation cannot create a scope after retirement; all actual registrations are synchronous after assertOwner.
    const previous = retirements.get(slot.agent.id)
    const cleanup = Promise.resolve().then(() => slot.scope?.dispose())
    const barrier = Promise.all([previous, cleanup]).then(() => {})
    slot.retirement = barrier
    retirements.set(slot.agent.id, barrier)
    void barrier.then(() => { if (retirements.get(slot.agent.id) === barrier) retirements.delete(slot.agent.id) }, () => {
      // Retain an unconfirmed public-scope disposer failure as a fail-closed admission barrier.
    })
    return barrier
  }
  const forget = (slot: ContextSlot): void => { if (entries.get(slot.agent.id) === slot) entries.delete(slot.agent.id) }
  const createEntry = async (slot: ContextSlot, barrier: Promise<void> | undefined): Promise<Entry> => {
      await barrier
      assertOwner(slot)
      const { agent, binding } = slot
      if (!binding.snapshot || !binding.hostCwd || !binding.mapHostPath) throw new Error('Project context requires a verified managed Session execution binding')
      await binding.assertCurrent?.()
      assertOwner(slot)
      const signal = binding.lifetime ? AbortSignal.any([slot.cancel.signal, binding.lifetime]) : slot.cancel.signal
      const home = binding.snapshot.target.home
      const configuredHome = async (key: 'DSH_HOME' | 'DSH_AGENTS_HOME', fallback: string) => {
        const requested = binding.snapshot!.environment.set[key]
        if (!requested) return fallback
        if (!binding.mapPath) throw new Error('Custom guest instruction homes require a verified path mapper')
        return binding.mapPath(requested, signal, home)
      }
      const [guestDshHome, guestAgentsHome] = await Promise.all([configuredHome('DSH_HOME', home + '/.dsh'), configuredHome('DSH_AGENTS_HOME', home + '/.agents')])
      const [dshHome, agentsHome] = await Promise.all([binding.mapHostPath(guestDshHome, signal), binding.mapHostPath(guestAgentsHome, signal)])
      assertOwner(slot)
      // Driver-minted agent.ctx is a routing context, not a grant to this plugin's injected services.
      // Mint an owned registration scope from the authorized plugin context, keyed to the exact Agent.
      const scope = createScope(ctx, agent)
      slot.scope = scope
      const base = scope.ctx
      const fs = new SessionContextFileSystem(base, agent.id, binding)
      const entry: Entry = { binding, fs, dshHome, agentsHome, touched: new Set(), assertOwner: () => assertOwner(slot), dispose: () => scope.dispose() }
      const trusted = base.extend({ fs, get: (key: string, strict?: boolean) => key === 'fs' ? fs : base.get(key, strict) })
      let provider: FileSystemSkillProvider | undefined
      let release: (() => void) | undefined
      // Own cleanup before registration so a factory/public-registration failure cannot leave an unawaited provider.
      base.effect(() => async () => { release?.(); await provider?.dispose() }, 'selected-user skill provider')
      release = base.skills.registerProvider(control => {
        entry.invalidate = control.invalidate
        provider = new FileSystemSkillProvider(trusted, control, { providerName: `wsl-filesystem-${agent.id}`, dshHome, agentsHome, watch: false })
        const selected = provider
        const options = async (input: SkillLookupOptions): Promise<SkillLookupOptions> => {
          assertOwner(slot)
          await binding.assertCurrent?.(); assertOwner(slot); input.signal?.throwIfAborted()
          const signals = [slot.cancel.signal, ...binding.lifetime ? [binding.lifetime] : [], ...input.signal ? [input.signal] : []]
          return { ...input, signal: AbortSignal.any(signals), cwd: input.cwd === undefined || input.cwd === binding.guestCwd ? binding.hostCwd : input.cwd }
        }
        return { name: selected.name,
          list: async input => { const value = await selected.list(await options(input)); assertOwner(slot); return value },
          get: async (candidate, input) => { const value = await selected.get(candidate, await options(input)); assertOwner(slot); return value } }
      })
      assertOwner(slot)
      return entry
  }
  const initialize = async (agent: Agent): Promise<Entry> => {
    const binding = wslExecutionFor(agent.id), previous = entries.get(agent.id)
    if (!binding?.snapshot || !binding.hostCwd || !binding.guestCwd || !binding.mapHostPath) {
      if (previous) { forget(previous); await retire(previous) }
      throw new Error('Project context requires a verified managed Session execution binding')
    }
    const authority = { targetId: binding.snapshot.target.id, guestCwd: binding.guestCwd, hostCwd: binding.hostCwd }
    const established = authorities.get(agent)
    if (established && (established.targetId !== authority.targetId || established.guestCwd !== authority.guestCwd || established.hostCwd !== authority.hostCwd)) {
      if (previous) { forget(previous); await retire(previous) }
      throw new Error('Existing project context belongs to another execution target; create a new Session instead of migrating it')
    }
    authorities.set(agent, authority)
    let slot = previous
    if (!slot || slot.agent !== agent || slot.binding !== binding || slot.retired) {
      if (slot) void retire(slot).catch(() => {}) // The retained barrier below is awaited before any replacement registration.
      slot = { agent, binding, cancel: new AbortController(), touch: Promise.resolve(), retired: false }
      entries.set(agent.id, slot)
      const current = slot, barrier = retirements.get(agent.id)
      const invalidated = new Promise<never>((_, reject) => {
        current.cancel.signal.addEventListener('abort', () => reject(current.cancel.signal.reason), { once: true })
      })
      current.ready = Promise.race([createEntry(current, barrier), invalidated]).catch(async error => {
        forget(current)
        try { await retire(current) }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'Project context scope cleanup failed') }
        throw error
      })
    }
    const entry = await slot.ready!
    await slot.touch
    assertOwner(slot)
    return entry
  }
  ctx.on('tools/result', (execution, result) => {
    if (result.isError || execution.signal.aborted || !execution.agent || !['read', 'write', 'edit'].includes(execution.name)) return
    const input = execution.arguments as { file_path?: unknown }
    if (typeof input?.file_path !== 'string') return
    const filePath = input.file_path
    const slot = entries.get(execution.agent.id)
    if (!slot || slot.agent !== execution.agent || slot.retired || wslExecutionFor(execution.agent.id) !== slot.binding) return
    // A touch belongs to this owner only; it cannot overwrite a replacement entry after any awaited mapping.
    const next = slot.touch.then(async () => {
      const entry = await slot.ready!
      assertOwner(slot)
      const timeout = AbortSignal.timeout(30000)
      const signal = AbortSignal.any([slot.cancel.signal, timeout, ...entry.binding.lifetime ? [entry.binding.lifetime] : []])
      const guest = await entry.binding.mapPath!(filePath, signal)
      assertOwner(slot)
      const root = entry.binding.guestCwd!
      if (guest !== root && !guest.startsWith(root.replace(/\/$/, '') + '/')) return
      const cwd = await entry.binding.mapHostPath!(posix.dirname(guest), signal)
      assertOwner(slot)
      entry.touched.add(cwd); entry.overflow = entry.touched.size > 128; entry.invalidate?.()
    })
    slot.touch = next
    void next.catch(error => {
      forget(slot)
      void retire(slot).catch(cleanup => ctx.logger.warn('Selected-user project context scope cleanup failed: %s', String(cleanup)))
      if (wslExecutionFor(slot.agent.id) === slot.binding) ctx.logger.warn('Selected-user project instruction touch failed: %s', String(error))
    })
  })
  ctx.on('agent/pre-step', async (request, next) => {
    const entry = await initialize(request.agent), decision = await next()
    entry.assertOwner()
    await entry.binding.assertCurrent?.(); entry.assertOwner(); request.signal.throwIfAborted()
    entry.invalidate?.()
    if (config.maxBytes <= 0 || !Number.isFinite(config.maxBytes)) return decision
    const files = await selectedInstructionBaseline(entry, config, request.signal)
    entry.assertOwner()
    const digest = digestOf(files.map(file => ({ path: file.absolutePath, version: file.version, content: file.content })))
    const history = request.agent.session.snapshotEvents?.() ?? []
    const last = history.filter(event => event.type === 'user/message' && event.data.source.kind === sourceKind).at(-1)
    const visible = last?.type === 'user/message' ? last.data : undefined
    const pending = request.agent.inbox.nextStep.filter(message => message.source.kind === sourceKind)
    const claimed = [...request.messages, ...(decision.kind === 'reject' ? [] : decision.messages)].findLast(message => message.source.kind === sourceKind)
    const previous = claimed ?? visible
    const sameWorld = (message: UserMessage): boolean => message.source.kind === sourceKind
      && message.source.targetId === entry.binding.snapshot!.target.id && message.source.generationId === entry.binding.snapshot!.target.generationId
    if (previous?.source.kind === sourceKind && previous.source.digest === digest && sameWorld(previous) || !files.length && !previous) return decision
    const rendered = renderAgentInstructions(files, { maxBytes: config.maxBytes, replacePreviousBaseline: previous !== undefined })
    const desired: UserMessage = pending.find(message => message.source.kind === sourceKind && message.source.digest === digest && sameWorld(message))
      ?? createUserMessage({ content: [{ type: 'text', text: rendered.text }], source: { kind: sourceKind, form: 'instructions', digest,
        targetId: entry.binding.snapshot!.target.id, generationId: entry.binding.snapshot!.target.generationId,
        files: files.map(file => ({ path: file.absolutePath, version: file.version })) } })
    for (const message of pending) request.agent.inbox.remove(message.id)
    if (decision.kind === 'reject' || request.step === 1 && !decision.messages.length) {
      request.agent.inbox.prepend('next-step', desired); return decision
    }
    const at = decision.messages.findLastIndex(message => request.messages.includes(message))
    return { ...decision, messages: decision.messages.toSpliced(at + 1, 0, desired) }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const slot = entries.get(agent.id)
    if (!slot || slot.agent !== agent) return
    forget(slot)
    void retire(slot).catch(error => ctx.logger.warn('Selected-user project context scope cleanup failed: %s', String(error)))
  })
  ctx.effect(() => async () => {
    const retiring = [...entries.values()].map(retire)
    entries.clear()
    const results = await Promise.allSettled([...retiring, ...retirements.values()])
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason)
    if (failures.length) throw new AggregateError(failures, 'Selected-user project context teardown failed')
  }, 'selected-user project context ownership')
}
