import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionContextFileSystem, apply as applyContext } from '../src/wsl-context.ts'
import { registerWslExecution, wslExecutionFor, type WslExecutionBinding } from '../src/app/wsl-world.ts'
import { freezeExecutionSnapshot, freezeTarget, environmentSnapshot } from '../src/execution/target.ts'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SkillRegistry, type SkillProvider } from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as wslTransport from '../src/infra/wsl.ts'
import { lookupWorkspaceSession } from '../src/workspace-files.ts'
import GuestFileSystem, { withGuestFsSession } from '../src/wsl-fs.ts'
import { Sessions, type SessionsHost } from '../src/app/sessions.ts'
import { configureGuestFsResolver } from '../src/wsl-fs.ts'
import type { ShellExecution } from '@deepseek-ai/dsh-shell'
import { SessionExecutionOwner, childWorkspace, masterWorkspace, sessionExecutionKey } from '../src/execution/session-world.ts'
import { MaintenanceGate } from '../src/execution/maintenance.ts'
import type { ExecutionSnapshot, ResolvedWorkspace } from '../src/execution/target.ts'

it('normalizes Core Host cwd before relative guest FS paths and resolves Shell policy for the exact live Session', async () => {
  const ctx = new Context(), id = 'core-paths', liveSession = { id }, agents = new Map([[id, { session: liveSession }]])
  const resolvePolicy = vi.fn(({ session }: { session: unknown }) => { expect(session).toBe(liveSession); return { mode: 'read-only' } })
  ctx.provide('agents', agents); ctx.provide('sandboxPolicy', { resolve: resolvePolicy })
  const snapshot = freezeExecutionSnapshot(1, freezeTarget({ distro: 'Test', user: 'selected', uid: 1000, home: '/home/selected', bootId: 'boot' },
    { input: '/custom/ticket', guestPath: '/custom/ticket', hostPath: '\\\\wsl.localhost\\Test\\custom\\ticket', storage: 'guest-local', evidence: { converter: 'wslpath', hostRegistration: 'verified' } }, 'generation', ''), environmentSnapshot({}))
  const record = { sessionId: id, role: 'worker', snapshot, guestCwd: '/custom/ticket', hostCwd: snapshot.target.workspace.hostPath }
  const sessions = new Sessions({ context: ctx, masterId: id, lifetime: new AbortController().signal,
    effects: { handle: () => {} }, store: { get: (key: string) => key === sessionExecutionKey(id) ? record : undefined, tickets: { get: () => undefined } },
    executionBinding: () => ({ snapshot, env: {}, machine: { stateDir: 'C:\\host-state', wsl: { distro: 'Test', user: 'selected', workRoot: '/custom' } } }) } as unknown as SessionsHost)
  const transport = vi.spyOn(wslTransport, 'runWsl').mockImplementation(async (_machine, request) => {
    expect(_machine.wsl?.user).toBe('selected')
    expect(request.expectedIdentity).toEqual({ uid: 1000, bootId: 'boot' })
    if (request.argv[0] === 'wslpath') { expect(request.argv).toEqual(['wslpath', '-a', '-u', 'F:\\ticket']); return '/media/custom-drive/ticket\n' }
    return JSON.stringify({ ok: true, value: JSON.parse(String(request.stdin)).path })
  })
  try {
    const found = await lookupWorkspaceSession(ctx, id)
    if (found.kind !== 'managed' || !found.binding) throw new Error('Expected managed test binding')
    const binding = found.binding, signal = new AbortController().signal
    expect(await binding.mapPath!('file.txt', signal, record.hostCwd)).toBe('/custom/ticket/file.txt')
    expect(await binding.mapPath!('file.txt', signal, 'F:\\ticket')).toBe('/media/custom-drive/ticket/file.txt')
    await expect(binding.mapPath!('file.txt', signal, '\\\\wsl.localhost\\Other\\custom\\ticket')).rejects.toMatchObject({ code: 'PATH_WRONG_DISTRO' })
    const fs = new GuestFileSystem(ctx.isolate('fs'))
    const target = await withGuestFsSession(id, () => fs.resolve('file.txt', { cwd: record.hostCwd, signal }))
    expect(fs.processPath(target)).toBe('/custom/ticket/file.txt')
    expect(binding.resolveShellPolicy!()).toEqual({ mode: 'read-only' })
    expect(resolvePolicy).toHaveBeenCalledExactlyOnceWith({ session: liveSession })
    agents.clear()
    expect(() => binding.resolveShellPolicy!()).toThrow('exact live Session')
  } finally { sessions.dispose(); transport.mockRestore() }
})

it('binds lifecycle filesystem reads outside tools/execute to the trusted user with accurate source coordinates', async () => {
  const calls: { path: string; op: string }[] = []
  const release = configureGuestFsResolver(id => id === 'selected' ? { identity: 'uid1000', cwd: '/guest/project',
    mapPath: path => path,
    transport: async (_script, payload) => {
      const request = JSON.parse(payload); calls.push(request)
      return JSON.stringify({ ok: true, value: request.op === 'resolve' ? request.path : request.op === 'text' ? 'selected instructions' : { type: 'file', version: 'v1', size: 21 } })
    } } : undefined)
  try {
    const fs = new SessionContextFileSystem(new Context(), 'selected', { machine: {} as never, env: {}, mapHostPath: async path => path })
    const global = await fs.resolve('/guest/UserB/.dsh/AGENTS.md')
    expect(await fs.readText(global)).toBe('selected instructions')
    expect(fs.processPath(global)).toBe('/guest/UserB/.dsh/AGENTS.md')
    expect(calls).toContainEqual(expect.objectContaining({ path: '/guest/UserB/.dsh/AGENTS.md', op: 'text' }))
    const project = await fs.resolve('/host/UserA/.dsh/default-workspace/AGENTS.md')
    expect(fs.processPath(project)).toBe('/host/UserA/.dsh/default-workspace/AGENTS.md')
    expect(calls.every(call => !call.path.startsWith('/host/UserA/.dsh/AGENTS.md'))).toBe(true)
  } finally { release() }
})

it('registers selected skills through an authorized plugin-minted Agent scope, not a driver context without skills injection', async () => {
  const root = new Context(), hooks = new Map<string, (...args: any[]) => any>()
  const skillFiber = root.plugin(SkillRegistry)
  await skillFiber
  let driverCtx!: Context
  const driverFiber = root.plugin({ name: 'test-driver-no-skills', apply: (ctx: Context) => { driverCtx = ctx } })
  await driverFiber
  let agentCtx!: Context
  const agent = { id: 'minter-agent', get ctx() { return agentCtx }, session: { snapshotEvents: () => [] },
    inbox: { nextStep: [], prepend: vi.fn(), remove: vi.fn() } } as unknown as Agent
  const driverScope = createScope(driverCtx, agent)
  agentCtx = driverScope.ctx
  expect(() => agentCtx.skills).toThrow('without inject')
  const snapshot = freezeExecutionSnapshot(1, freezeTarget({ distro: 'Test', user: 'selected', uid: 1000, home: '/owned/home', bootId: 'boot' },
    { input: '/owned/project', guestPath: '/owned/project', hostPath: '/owned/project', storage: 'guest-local', evidence: { converter: 'wslpath', hostRegistration: 'verified' } }, 'generation', ''), environmentSnapshot({}))
  const unbind = registerWslExecution(agent.id, { machine: {} as never, env: {}, snapshot, guestCwd: '/owned/project', hostCwd: '/owned/project',
    mapHostPath: async path => path, assertCurrent: () => {} })
  const reset = configureGuestFsResolver(id => id === agent.id ? { identity: 'selected-minter', cwd: '/owned/project',
    transport: async () => JSON.stringify({ ok: true, value: null }) } : undefined)
  const providerList = vi.spyOn(FileSystemSkillProvider.prototype, 'list').mockResolvedValue([{ name: 'selected-skill', description: 'selected',
    invocation: { modelInvocable: true, userInvocable: true }, source: 'project-dsh', provider: 'wsl-filesystem-minter-agent', rank: 100, locator: {} }])
  const ownerFiber = root.plugin({ name: 'test-owned-context', inject: ['skills'], apply: (ctx: Context) => {
    applyContext(ctx.extend({ on: (event: string, callback: (...args: any[]) => any) => { hooks.set(event, callback); return () => {} } }))
  } })
  try {
    await ownerFiber
    await hooks.get('agent/pre-step')!({ agent, signal: new AbortController().signal, messages: [], step: 2 }, async () => ({ kind: 'enter', messages: [] }))
    const skills = root.get('skills')!
    expect((await skills.list({ scope: agent, cwd: '/owned/project' })).map(skill => skill.name)).toEqual(['selected-skill'])
    expect(await skills.list({ scope: {}, cwd: '/owned/project' })).toEqual([])
    await ownerFiber.dispose()
    expect(await skills.list({ scope: agent, cwd: '/owned/project' })).toEqual([])
  } finally {
    unbind(); reset(); providerList.mockRestore()
    await ownerFiber.dispose(); await driverScope.dispose(); await driverFiber.dispose(); await skillFiber.dispose()
  }
})

it('runs public instruction rendering and filesystem skill provider through explicit selected-session RPC', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-world-')), project = join(dir, 'project'), home = join(dir, 'home')
  const ctx = new Context(), providers: SkillProvider[] = [], hooks = new Map<string, (...args: any[]) => any>()
  const signal = new AbortController().signal
  let unregister = () => {}, reset = () => {}
  try {
    await mkdir(join(project, '.git'), { recursive: true })
    await mkdir(join(project, '.dsh', 'skills', 'project-skill'), { recursive: true })
    await mkdir(join(home, '.agents', 'skills', 'user-skill'), { recursive: true })
    await mkdir(join(home, '.dsh'), { recursive: true })
    await writeFile(join(project, 'AGENTS.md'), 'PROJECT_SELECTED_USER_INSTRUCTION')
    await writeFile(join(home, '.dsh', 'AGENTS.md'), 'HOME_SELECTED_USER_INSTRUCTION')
    await writeFile(join(project, '.dsh', 'skills', 'project-skill', 'SKILL.md'), '---\nname: project-skill\ndescription: project selected\n---\nPROJECT_SKILL_BODY')
    await writeFile(join(home, '.agents', 'skills', 'user-skill', 'SKILL.md'), '---\nname: user-skill\ndescription: user selected\n---\nUSER_SKILL_BODY')
    const snapshot = freezeExecutionSnapshot(1, freezeTarget({ distro: 'Test', user: 'selected', uid: 1000, home, bootId: 'test' },
      { input: project, guestPath: project, hostPath: project, storage: 'guest-local', evidence: { converter: 'wslpath', hostRegistration: 'verified' } }, 'generation', ''), environmentSnapshot({}))
    unregister = registerWslExecution('context', { machine: {} as never, env: {}, snapshot, guestCwd: project, hostCwd: project,
      mapHostPath: async path => path, mapPath: async path => path, assertCurrent: () => {} })
    const paths: string[] = []
    reset = configureGuestFsResolver(id => id === 'context' ? { identity: 'explicit-selected', cwd: project,
      transport: async (script, payload, abort) => {
        paths.push(JSON.parse(payload).path)
        const child = spawn('python3', ['-c', script], { signal: abort, stdio: ['pipe', 'pipe', 'pipe'] })
        const data: Buffer[] = []; let stderr = ''
        const result = new Promise<string>((resolve, reject) => {
          child.stdout.on('data', chunk => data.push(chunk)); child.stderr.on('data', chunk => stderr += chunk)
          child.on('error', reject); child.on('close', code => code === 0 ? resolve(Buffer.concat(data).toString()) : reject(new Error(stderr)))
        })
        child.stdin.end(payload); return result
      } } : undefined)
    ctx.provide('skills', { registerProvider: (factory: any) => { providers.push(factory({ signal, invalidate: vi.fn() })); return vi.fn() } })
    const history: any[] = []
    const agent = { id: 'context', ctx, session: { surface: { nodes: [] }, snapshotEvents: () => history }, inbox: { nextStep: [], prepend: vi.fn(), replace: vi.fn(), remove: vi.fn() } }
    applyContext(ctx.extend({ on: (event: string, callback: (...args: any[]) => any) => { hooks.set(event, callback); return vi.fn() } }))
    const decision = await hooks.get('agent/pre-step')!({ agent, signal, messages: [], step: 1 }, async () => ({ kind: 'proceed', messages: [{ content: [], source: { kind: 'user' } }] }))
    const rendered = JSON.stringify(decision)
    expect(rendered).toContain('PROJECT_SELECTED_USER_INSTRUCTION')
    expect(rendered).toContain('HOME_SELECTED_USER_INSTRUCTION')
    expect(paths).toContain(join(home, '.dsh', 'AGENTS.md'))
    const listed = await providers[0]!.list({ cwd: project, signal })
    const candidates = 'candidates' in listed ? listed.candidates : listed
    expect(candidates.map(candidate => candidate.name)).toEqual(expect.arrayContaining(['project-skill', 'user-skill']))
    const loaded = await providers[0]!.get(candidates.find(candidate => candidate.name === 'user-skill')!, { cwd: project, signal })
    expect(loaded?.content).toBe('USER_SKILL_BODY')
    expect(paths).toContain(join(home, '.agents', 'skills', 'user-skill', 'SKILL.md'))
    const baseline = decision.messages.find((message: any) => message.source.kind === 'dsh-superagent-project-instructions')
    history.push({ type: 'user/message', data: baseline })
    const request = { agent, signal, messages: [], step: 2 }
    const proceed = async () => ({ kind: 'proceed', messages: [{ content: [], source: { kind: 'user' } }] })
    expect((await hooks.get('agent/pre-step')!(request, proceed)).messages).toHaveLength(1)
    await mkdir(join(project, 'nested'))
    await writeFile(join(project, 'nested', 'AGENTS.md'), 'NESTED_SELECTED_INSTRUCTION')
    hooks.get('tools/result')!({ agent, name: 'read', signal, arguments: { file_path: join(project, 'nested', 'file.txt') } }, { isError: false })
    const nested = await hooks.get('agent/pre-step')!(request, proceed)
    expect(JSON.stringify(nested)).toContain('NESTED_SELECTED_INSTRUCTION')
    expect(JSON.stringify(nested)).toContain('replaces all earlier workspace instruction baselines')
    const changed = nested.messages.find((message: any) => message.source.kind === 'dsh-superagent-project-instructions')
    expect(changed.source.files.map((file: any) => file.path)).toContain(join(project, 'nested', 'AGENTS.md'))
    history.push({ type: 'user/message', data: changed })
    await rm(join(project, 'nested', 'AGENTS.md'))
    const removed = await hooks.get('agent/pre-step')!(request, proceed)
    expect(JSON.stringify(removed)).not.toContain('NESTED_SELECTED_INSTRUCTION')
    expect(JSON.stringify(removed)).toContain('replaces all earlier workspace instruction baselines')
  } finally {
    unregister(); reset()
    if (dir.startsWith(join(tmpdir(), 'session-world-'))) await rm(dir, { recursive: true, force: true })
  }
}, 20000)

it('closes public Session admission and drains main/all ticket roots before completing final shutdown', async () => {
  const ctx = new Context(), drain = vi.fn(async () => {}), list = vi.fn((_caller: string) => [])
  const agents = new Map(['main', 'worker-old', 'worker-handoff'].map(id => [id, { id, status: 'idle', cancel: vi.fn(), whenIdle: async () => {} }]))
  ctx.provide('agents', agents)
  ctx.provide('jobs', { list })
  ctx.provide('subagents', { drainDescendants: drain })
  const sessions = new Sessions({ context: ctx, store: { tickets: { list: () => [{ id: 'old' }, { id: 'handoff' }] } },
    masterId: 'main', lifetime: AbortSignal.abort(), effects: { handle: () => {} } } as unknown as SessionsHost)
  try {
    const stopped = sessions.shutdownExecutions()
    expect(sessions.shutdownExecutions()).toBe(stopped)
    await expect(sessions.ensure('late', '/late', 'late', 'worker')).rejects.toThrow('admission is closed')
    await stopped
    expect(drain).toHaveBeenCalledExactlyOnceWith([...agents.values()])
    expect(list.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining(['main', 'worker-old', 'worker-handoff']))
  } finally { sessions.dispose() }
})

/** Real public SkillRegistry/fibers exercise ownership, disposal and same-name replacement without private state. */
async function contextLifecycleFixture(instructions = false) {
  const root = new Context(), hooks = new Map<string, (...args: any[]) => any>(), id = 'lifecycle-agent', history: any[] = []
  const skillsFiber = root.plugin(SkillRegistry); await skillsFiber
  let driverCtx!: Context
  const driverFiber = root.plugin({ name: 'lifecycle-driver', apply: (ctx: Context) => { driverCtx = ctx } }); await driverFiber
  let agentCtx!: Context
  const agent = { id, get ctx() { return agentCtx }, session: { snapshotEvents: () => history }, inbox: { nextStep: [], prepend: vi.fn(), remove: vi.fn() } } as unknown as Agent
  const driverScope = createScope(driverCtx, agent); agentCtx = driverScope.ctx
  const bindingReleases: (() => void)[] = [], instances = new Set<FileSystemSkillProvider>(), paths: string[] = []
  const setBinding = (generation: string, ports: Partial<WslExecutionBinding> = {}, uid = 1000) => {
    const snapshot = freezeExecutionSnapshot(1, freezeTarget({ distro: 'Test', user: 'selected', uid, home: '/owned/home', bootId: 'boot' },
      { input: '/owned/project', guestPath: '/owned/project', hostPath: '/owned/project', storage: 'guest-local', evidence: { converter: 'wslpath', hostRegistration: 'verified' } }, generation, ''), environmentSnapshot({}))
    bindingReleases.push(registerWslExecution(id, { machine: {} as never, env: {}, snapshot, guestCwd: '/owned/project', hostCwd: '/owned/project',
      mapHostPath: async path => path, mapPath: async path => path, assertCurrent: () => {}, ...ports }))
    return wslExecutionFor(id)!
  }
  const reset = configureGuestFsResolver(session => session === id ? { identity: `selected:${wslExecutionFor(id)?.snapshot?.target.generationId}`, cwd: '/owned/project',
    transport: async (_script, payload) => {
      const request = JSON.parse(payload); paths.push(request.path)
      let value: unknown = null
      if (instructions && request.path === '/owned/project/AGENTS.md') {
        const content = 'SELECTED_CONTEXT_BODY'
        if (request.op === 'resolve') value = request.path
        else if (request.op === 'bytes') value = { data: Buffer.from(content).toString('base64'), version: 'same-version' }
        else value = { type: 'file', size: content.length, version: 'same-version' }
      }
      return JSON.stringify({ ok: true, value })
    } } : undefined)
  const list = vi.spyOn(FileSystemSkillProvider.prototype, 'list').mockImplementation(async function (this: FileSystemSkillProvider) {
    instances.add(this)
    return [{ name: 'selected-skill', description: 'selected', invocation: { modelInvocable: true, userInvocable: true },
      source: 'project-dsh', provider: this.name, rank: 100, locator: {} }]
  })
  const originalRegister = SkillRegistry.prototype.registerProvider
  const register = vi.spyOn(SkillRegistry.prototype, 'registerProvider')
  const ownerFiber = root.plugin({ name: 'lifecycle-context', inject: ['skills'], apply: (ctx: Context) => {
    applyContext(ctx.extend({ on: (event: string, callback: (...args: any[]) => any) => { hooks.set(event, callback); return () => {} } }))
  } }); await ownerFiber
  const preStep = (selected = agent) => hooks.get('agent/pre-step')!({ agent: selected, signal: new AbortController().signal, messages: [], step: 2 },
    async () => ({ kind: 'enter', messages: [] })) as Promise<unknown>
  const catalog = (selected = agent) => root.get('skills')!.list({ scope: selected, cwd: '/owned/project' })
  const newAgent = () => {
    let scoped!: Context
    const next = { id, get ctx() { return scoped }, session: { snapshotEvents: () => [] }, inbox: { nextStep: [], prepend: vi.fn(), remove: vi.fn() } } as unknown as Agent
    scoped = createScope(driverCtx, next).ctx
    return next
  }
  return { root, agent, hooks, setBinding, preStep, catalog, register, originalRegister, instances, paths, history, newAgent,
    clearBinding: () => { bindingReleases.at(-1)?.() },
    dispose: async () => {
      for (const release of bindingReleases) release(); reset()
      await ownerFiber.dispose(); await driverScope.dispose(); await driverFiber.dispose(); await skillsFiber.dispose()
      list.mockRestore(); register.mockRestore()
    } }
}

it('replaces the same Agent context for a new binding owner, including an unchanged generation id', async () => {
  const fixture = await contextLifecycleFixture()
  let closed = false
  try {
    fixture.setBinding('same-generation', { assertCurrent: () => { if (closed) throw new Error('old Runtime admission is closed') } })
    await fixture.preStep(); expect((await fixture.catalog()).map(skill => skill.name)).toEqual(['selected-skill'])
    expect(fixture.register).toHaveBeenCalledTimes(1)
    closed = true
    fixture.setBinding('same-generation')
    await fixture.preStep(); expect((await fixture.catalog()).map(skill => skill.name)).toEqual(['selected-skill'])
    expect(fixture.register).toHaveBeenCalledTimes(2)
    fixture.setBinding('next-generation')
    await fixture.preStep(); expect((await fixture.catalog()).map(skill => skill.name)).toEqual(['selected-skill'])
    expect(fixture.register).toHaveBeenCalledTimes(3)
    expect(fixture.instances.size).toBe(3)
    expect(await fixture.root.get('skills')!.list({ scope: {}, cwd: '/owned/project' })).toEqual([])
    await fixture.preStep(); expect(fixture.register).toHaveBeenCalledTimes(3)
  } finally { await fixture.dispose() }
})

it('uses exact Agent identity and ignores a late disposed event from a former Agent with the same id', async () => {
  const fixture = await contextLifecycleFixture()
  try {
    fixture.setBinding('same-generation'); await fixture.preStep()
    const replacement = fixture.newAgent()
    await fixture.preStep(replacement)
    expect(await fixture.catalog()).toEqual([])
    expect((await fixture.catalog(replacement)).map(skill => skill.name)).toEqual(['selected-skill'])
    fixture.hooks.get('agent/disposed')!({ agent: fixture.agent })
    await fixture.preStep(replacement)
    expect(fixture.register).toHaveBeenCalledTimes(2)
    expect((await fixture.catalog(replacement)).map(skill => skill.name)).toEqual(['selected-skill'])
  } finally { await fixture.dispose() }
})

it('keeps public rendering unchanged while refreshing source generation metadata after a binding-owner replacement', async () => {
  const fixture = await contextLifecycleFixture(true)
  try {
    fixture.setBinding('generation-one')
    const first = await fixture.preStep() as { messages: any[] }
    const previous = first.messages.find(message => message.source.kind === 'dsh-superagent-project-instructions')
    expect(previous.source.generationId).toBe('generation-one')
    expect(JSON.stringify(previous.content)).toContain('SELECTED_CONTEXT_BODY')
    fixture.history.push({ type: 'user/message', data: previous })
    fixture.setBinding('generation-one')
    expect((await fixture.preStep() as { messages: unknown[] }).messages).toEqual([])
    fixture.setBinding('generation-two')
    const next = await fixture.preStep() as { messages: any[] }
    const current = next.messages.find(message => message.source.kind === 'dsh-superagent-project-instructions')
    expect(current.source.generationId).toBe('generation-two')
    expect(current.source.targetId).toBe(previous.source.targetId)
    expect(current.source.digest).toBe(previous.source.digest)
    expect(JSON.stringify(current.content)).toContain('SELECTED_CONTEXT_BODY')
    expect(fixture.register).toHaveBeenCalledTimes(3)
  } finally { await fixture.dispose() }
})

it('retires a deferred old initialization without waiting for a mapper that ignores cancellation or publishing it late', async () => {
  const fixture = await contextLifecycleFixture(), started = Promise.withResolvers<void>(), deferred = Promise.withResolvers<void>()
  try {
    fixture.setBinding('old-generation', { mapHostPath: async path => { started.resolve(); await deferred.promise; return path } })
    const old = fixture.preStep().then(() => undefined, error => error)
    await started.promise
    fixture.setBinding('new-generation')
    await fixture.preStep(); expect(fixture.register).toHaveBeenCalledTimes(1)
    deferred.resolve()
    expect(await old).toBeInstanceOf(Error)
    expect((await fixture.catalog()).map(skill => skill.name)).toEqual(['selected-skill'])
    await fixture.preStep(); expect(fixture.register).toHaveBeenCalledTimes(1)
  } finally { deferred.resolve(); await fixture.dispose() }
})

it('does not publish a replacement provider until the exact old public scope disposer finishes', async () => {
  const fixture = await contextLifecycleFixture(), started = Promise.withResolvers<void>(), cleanup = Promise.withResolvers<void>()
  const originalDispose = FileSystemSkillProvider.prototype.dispose
  let oldProvider: FileSystemSkillProvider | undefined
  const dispose = vi.spyOn(FileSystemSkillProvider.prototype, 'dispose').mockImplementation(async function (this: FileSystemSkillProvider) {
    if (this === oldProvider) { started.resolve(); await cleanup.promise }
    await originalDispose.call(this)
  })
  try {
    fixture.setBinding('old'); await fixture.preStep(); await fixture.catalog(); oldProvider = [...fixture.instances][0]!
    fixture.setBinding('new')
    let published = false
    const replacement = fixture.preStep().then(() => { published = true })
    await started.promise
    expect(published).toBe(false); expect(fixture.register).toHaveBeenCalledTimes(1)
    expect(await fixture.catalog()).toEqual([])
    cleanup.resolve(); await replacement
    expect(fixture.register).toHaveBeenCalledTimes(2)
    expect((await fixture.catalog()).map(skill => skill.name)).toEqual(['selected-skill'])
  } finally { cleanup.resolve(); dispose.mockRestore(); await fixture.dispose() }
})

it('keeps a late old touch tail from mutating or replacing the new owner context', async () => {
  const fixture = await contextLifecycleFixture(), started = Promise.withResolvers<void>(), deferred = Promise.withResolvers<void>()
  try {
    fixture.setBinding('old', { mapPath: async path => { started.resolve(); await deferred.promise; return path } })
    await fixture.preStep()
    fixture.hooks.get('tools/result')!({ agent: fixture.agent, name: 'read', signal: new AbortController().signal,
      arguments: { file_path: '/owned/project/nested/file.txt' } }, { isError: false })
    await started.promise
    fixture.setBinding('new'); await fixture.preStep()
    deferred.resolve()
    await Promise.resolve(); await Promise.resolve()
    fixture.paths.length = 0
    await fixture.preStep()
    expect(fixture.paths.some(path => path.includes('/nested'))).toBe(false)
    expect(fixture.register).toHaveBeenCalledTimes(2)
    expect((await fixture.catalog()).map(skill => skill.name)).toEqual(['selected-skill'])
  } finally { deferred.resolve(); await fixture.dispose() }
})

it('cleans a failed initialization before retry, without caching its rejected Promise or duplicate registration', async () => {
  const fixture = await contextLifecycleFixture(), started = Promise.withResolvers<void>(), cleanup = Promise.withResolvers<void>()
  const originalDispose = FileSystemSkillProvider.prototype.dispose
  let failedProvider: FileSystemSkillProvider | undefined
  const dispose = vi.spyOn(FileSystemSkillProvider.prototype, 'dispose').mockImplementation(async function (this: FileSystemSkillProvider) {
    failedProvider ??= this
    if (this === failedProvider) { started.resolve(); await cleanup.promise }
    await originalDispose.call(this)
  })
  fixture.register.mockImplementationOnce(function (this: SkillRegistry, create) {
    fixture.originalRegister.call(this, create)
    throw new Error('post-registration initialization failed')
  })
  try {
    fixture.setBinding('same-owner')
    const failed = fixture.preStep().then(() => undefined, error => error)
    await started.promise
    const retry = fixture.preStep()
    expect(fixture.register).toHaveBeenCalledTimes(1)
    expect(await fixture.catalog()).toEqual([])
    cleanup.resolve()
    expect(await failed).toMatchObject({ message: 'post-registration initialization failed' })
    await retry
    expect(fixture.register).toHaveBeenCalledTimes(2)
    expect((await fixture.catalog()).map(skill => skill.name)).toEqual(['selected-skill'])
  } finally { cleanup.resolve(); dispose.mockRestore(); await fixture.dispose() }
})

it('keeps missing bindings and another UID fail-closed across lifecycle retries', async () => {
  const fixture = await contextLifecycleFixture()
  try {
    fixture.setBinding('valid'); await fixture.preStep()
    fixture.clearBinding()
    await expect(fixture.preStep()).rejects.toThrow('verified managed Session execution binding')
    expect(await fixture.catalog()).toEqual([])
    fixture.setBinding('restored'); await fixture.preStep()
    fixture.setBinding('wrong-uid', {}, 1001)
    await expect(fixture.preStep()).rejects.toThrow('another execution target')
    await expect(fixture.preStep()).rejects.toThrow('another execution target')
    expect(await fixture.catalog()).toEqual([])
    expect(fixture.register).toHaveBeenCalledTimes(2)
  } finally { await fixture.dispose() }
})

const handle = (done = Promise.resolve(), error?: unknown) => ({ kill: vi.fn(), done,
  result: vi.fn(async () => { if (error) throw error; return {} }) }) as unknown as ShellExecution

describe('Session execution ownership', () => {
  it('closes admission synchronously and waits every generation owner', async () => {
    const owner = new SessionExecutionOwner(), first = handle(), second = handle()
    owner.own('master', first); owner.own('worker-old-generation', second)
    const stopped = owner.shutdown()
    expect(() => owner.own('late', handle())).toThrow('admission is closed')
    await stopped
    expect(first.kill).toHaveBeenCalledOnce(); expect(second.kill).toHaveBeenCalledOnce()
    expect(first.result).toHaveBeenCalledOnce(); expect(second.result).toHaveBeenCalledOnce()
  })
  it('reads cleanup closure at terminal release, preserving hold after provider unload', async () => {
    const gate = new MaintenanceGate(), record = vi.fn(), owner = new SessionExecutionOwner(gate, record)
    let failure: unknown
    const release = owner.own('worker-1', handle(), { cleanupError: () => failure })
    failure = new Error('unconfirmed')
    release()
    expect(record).toHaveBeenCalledWith(['worker-1'])
    expect(gate.blockers()).toEqual([{ code: 'guest-cleanup-unconfirmed', detail: 'worker-1' }])
    await expect(owner.shutdown()).rejects.toThrow('cleanup failed')
  })
  it('reports ordinary infrastructure rejection without writing a cleanup marker', async () => {
    const record = vi.fn(), owner = new SessionExecutionOwner(undefined, record)
    owner.own('worker', handle(Promise.resolve(), new Error('permission denied')), { cleanupError: () => undefined })
    await expect(owner.shutdown()).resolves.toBeUndefined()
    expect(record).not.toHaveBeenCalled()
  })
  it('releases admitted jobs when the owner releases normally', () => {
    const gate = new MaintenanceGate(), owner = new SessionExecutionOwner(gate)
    const release = owner.own('worker', handle())
    expect(gate.activityBlockers()).toHaveLength(1)
    release(); release()
    expect(gate.activityBlockers()).toEqual([])
  })
})

const root = (guestPath: string, hostPath: string) => ({ guestPath, hostPath }) as ResolvedWorkspace
it('keeps canonical Linux cwd and drive/UNC Host coordinates distinct', () => {
  expect(childWorkspace(root('/custom/work', 'D:\\work'), 'ticket-123')).toEqual({ guestCwd: '/custom/work/ticket-123', hostCwd: 'D:\\work\\ticket-123' })
  expect(masterWorkspace({ target: { workspace: root('/tickets', 'E:\\tickets') }, workspaces: {
    deployment: root('/home/u/default', '\\\\wsl.localhost\\Ubuntu\\home\\u\\default'), tickets: root('/tickets', 'E:\\tickets'),
  } } as ExecutionSnapshot)).toEqual({ guestCwd: '/home/u/default/.orchestrator', hostCwd: '\\\\wsl.localhost\\Ubuntu\\home\\u\\default\\.orchestrator' })
})
