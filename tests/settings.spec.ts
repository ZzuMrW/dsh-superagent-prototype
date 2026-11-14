/** Concurrency, retry, and validation tests for settings saves, pause toggling, and policy synchronization. */
import { afterEach, expect, it, vi } from 'vitest'
import { UserError } from '../src/core/index.ts'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { Store } from '../src/app/store.ts'
import { hasUnconfirmedExecutionCleanup } from '../src/app/runtime.ts'
import { join } from 'node:path'
import { KV } from '../src/kv.ts'
import { Commands } from '../src/infra/commands.ts'
import * as transport from '../src/infra/wsl.ts'
import { Setup } from '../src/app/setup.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
let expectedFailedStop = false
afterEach(async () => {
  const owned = h; h = undefined
  if (!owned) return
  if (!expectedFailedStop) { await owned.stop(); return }
  expectedFailedStop = false
  // Only deliberate shutdown-fault tests use this cleanup; their rejection and durable marker are asserted explicitly.
  await owned.runtime.stop().catch(() => {})
  vi.restoreAllMocks()
  rmSync(owned.directory, { recursive: true, force: true })
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}
const model = { provider: 'worker-provider', model: 'worker-model' }

it('refuses a save of a block that another save changed during its model or account check, and saves nothing of it', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const llm = (h.ctx as unknown as { llm: { resolveCallConfig: ReturnType<typeof vi.fn> } }).llm
  const check = deferred<unknown>()
  llm.resolveCallConfig.mockImplementationOnce(() => check.promise)
  const executor = store.settings().executor
  const revision = store.blockRevision('executor')
  const slow = settings.save('executor', { ...executor, model, maxWorkers: 5 }, revision, 'panel')
  await settings.save('executor', { ...executor, maxWorkers: 2 }, revision, 'panel')
  check.resolve(model)
  await expect(slow).rejects.toThrow(SettingsConflict)
  expect(store.settings().executor).toMatchObject({ maxWorkers: 2, model: executor.model })
  // This case isolates optimistic concurrency; maintenance safety has its own tests below.
  vi.spyOn(h.runtime.accountRuntime, 'blockers').mockReturnValue({ paused: true, items: [], hasHistory: false })
  // An account check that a save of the same Source outruns is refused the same way.
  const accounts = deferred<void>()
  vi.spyOn(Setup.prototype, 'checkAccounts').mockImplementationOnce(() => accounts.promise)
  const github = settings.block('source:github')
  const value = github.value as { enabled: boolean; config: Record<string, unknown> }
  const moved = settings.save('source:github', { ...value, config: { ...value.config, cli: '/opt/bin/gh-other' } }, github.revision,
    'panel')
  await settings.save('source:github', { ...value, config: { ...value.config, pollSeconds: 90 } }, github.revision, 'panel')
  accounts.resolve()
  await expect(moved).rejects.toThrow(SettingsConflict)
  expect(store.settings().sources.github!.config).toMatchObject({ cli: value.config.cli, pollSeconds: 90 })
})

it('refuses a Policy sync that a Policy save outran, reports it on sync:feishu, and keeps the save', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const members = deferred<unknown>()
  vi.mocked(Commands.prototype.lark).mockImplementationOnce(() => members.promise as never)
  const syncing = settings.sync('feishu')
  const policy = store.settings().policy
  const rules = [{ id: 'docs', name: 'Docs', enabled: true, instruction: 'Fix docs' }]
  await settings.save('policy', { ...policy, rules }, store.blockRevision('policy'), 'panel')
  members.resolve({ users: [{ member_id: 'ou_alice', name: 'Alice' }, { member_id: 'ou_new', name: 'New' }], has_more: false })
  await expect(syncing).rejects.toThrow(SettingsConflict)
  expect(h.runtime.health['sync:feishu']).toMatchObject({ state: 'error',
    detail: expect.stringContaining('Policy changed during synchronization') })
  expect(store.settings().policy).toMatchObject({ rules, sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] } } })
})

it('keeps ordinary policy sync admission open while a queued identity writer still closes it and shares the same mutex', async () => {
  h = await startRuntime()
  const { runtime } = h, gate = runtime.maintenance
  await vi.waitFor(() => expect(runtime.health['sync:feishu']).toMatchObject({ state: 'ready' })); await runtime.idle()
  const entered = deferred<void>(), permitSync = deferred<void>(), identityEntered = deferred<void>(), permitIdentity = deferred<void>()
  const serialize = gate.serialize.bind(gate)
  vi.spyOn(gate, 'serialize').mockImplementationOnce(<T>(label: string, work: () => Promise<T>) => serialize(label, async () => {
    entered.resolve(); await permitSync.promise; return work()
  }))
  vi.mocked(Commands.prototype.lark).mockResolvedValueOnce({ users: [{ member_id: 'ou_alice', name: 'Alice' }, { member_id: 'ou_synced', name: 'Synced' }], has_more: false })
  const syncing = runtime.settings.sync('feishu')
  let identity: Promise<void> | undefined
  try {
    await entered.promise
    expect(gate.blockers()).toEqual([])
    expect(() => runtime.receive(feishu('998', '@bot owned sync admission request'))).not.toThrow()
    identity = gate.exclusive('owned-identity-writer', async () => { identityEntered.resolve(); await permitIdentity.promise })
    expect(gate.blockers()).toContainEqual({ code: 'maintenance-pending' })
    expect(() => runtime.receive(feishu('999', 'owned input during identity maintenance'))).toThrow('blocked by maintenance')
    permitSync.resolve(); await syncing; await identityEntered.promise
    expect(gate.blockers()).toContainEqual({ code: 'maintenance-active', detail: 'owned-identity-writer' })
  } finally {
    permitSync.resolve(); permitIdentity.resolve()
    await Promise.allSettled([syncing, identity])
  }
})

it('syncs a Policy part again after a failed sync, a minute later and then after a wait that doubles, until it succeeds', async () => {
  h = await startRuntime()
  const { settings } = h.runtime
  // The syncs the Runtime runs as it starts finish first.
  await vi.waitFor(() => expect(h!.runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
  await h.runtime.idle()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const lark = vi.mocked(Commands.prototype.lark)
    lark.mockRejectedValueOnce(new Error('network down')).mockRejectedValueOnce(new Error('network down'))
    await expect(settings.sync('feishu')).rejects.toThrow('network down')
    expect(h.runtime.health['sync:feishu']).toMatchObject({ state: 'error', detail: expect.stringContaining('network down') })
    const calls = () => lark.mock.calls.filter(([args]) => args.includes('+chat-members-list')).length
    const before = calls()
    await vi.advanceTimersByTimeAsync(60_000)
    // The first retry fails too, so the next waits two minutes.
    expect(calls()).toBe(before + 1)
    lark.mockResolvedValueOnce({ users: [{ member_id: 'ou_alice', name: 'Alice' }], has_more: false })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls()).toBe(before + 1)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(h!.runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
    expect(calls()).toBe(before + 2)
    // A success ends the retries.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(calls()).toBe(before + 2)
  } finally { vi.useRealTimers() }
})
it('records nothing for a pause that changes nothing, refuses a sync while setup waits, and names an unknown block', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const revision = store.blockRevision('pause')
  const inject = h.agents.get(h.runtime.masterId)!.inject
  inject.mockClear()
  expect(await settings.pause(false, 'panel')).toEqual({ paused: false })
  await h.runtime.idle()
  expect([store.blockRevision('pause'), inject.mock.calls.length, h.runtime.effects.pending('notice')]).toEqual([revision, 0, false])
  vi.spyOn(Setup.prototype, 'configured').mockReturnValue(false)
  await expect(settings.sync('feishu')).rejects.toThrow(new UserError('nothingToSync', { source: 'feishu' }))
  vi.mocked(Setup.prototype.configured).mockRestore()
  expect(() => settings.block('source:x')).toThrow(new UserError('unknownBlock', { block: 'source:x' }))
})


it('does not let old source PUT or executor target changes bypass paused maintenance', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const source = settings.block('source:github')
  const value = source.value as { enabled: boolean; config: Record<string, unknown> }
  const revision = store.get('settings-revision')
  const check = vi.spyOn(Setup.prototype, 'checkAccounts')
  await expect(settings.save('source:github', { ...value, config: { ...value.config, cli: '/owned-test-other-gh' } }, source.revision, 'panel')).rejects.toThrow(SettingsConflict)
  await expect(settings.save('executor', { ...store.settings().executor, directory: '/owned-test-other-world' }, store.blockRevision('executor'), 'panel')).rejects.toThrow(SettingsConflict)
  expect(check).not.toHaveBeenCalled()
  expect(store.get('settings-revision')).toBe(revision)
})

it('refuses explicit resume while account identity is held, without mutating pause state', async () => {
  h = await startRuntime()
  const { settings, store, maintenance } = h.runtime
  store.saveSettings({ ...store.settings(), paused: true })
  maintenance.hold('accounts', { code: 'account-health-hold' })
  await expect(settings.pause(false, 'panel')).rejects.toThrow('blocked by maintenance')
  expect(store.settings().paused).toBe(true)
})


it('wires HTTP observation and confirmed apply through a staged environment and accepted-binding transaction', async () => {
  h = await startRuntime()
  const { runtime } = h, { store, setup } = runtime
  await vi.waitFor(() => expect(runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
  await runtime.settings.pause(true, 'panel')
  await runtime.idle()
  const oldConfig = setup.commandEnvironment.GIT_CONFIG_GLOBAL!
  const oldContents = readFileSync(oldConfig, 'utf8')
  const beforeGeneration = readdirSync(join(h.directory, 'generations'))
  const beforeAccepted = store.get(KV.accounts.accepted)!
  store.set(KV.github.since, '2026-09-01T00:00:00Z')
  const original = h.subprocess.spawn.getMockImplementation()!
  h.subprocess.spawn.mockImplementation(spec => {
    if (spec.argv.includes('repos/acme/widgets')) {
      const text = JSON.stringify({ id: 42, name: 'renamed-owner/widgets', push: true })
      return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } } }
    }
    return original(spec)
  })
  const observation = await h.api('POST', 'sources/github/accounts/refresh')
  expect(observation).toMatchObject({ status: 200, body: { ok: true, status: 'changed', cursorPlan: 'preserve' } })
  expect(readdirSync(join(h.directory, 'generations'))).toEqual(beforeGeneration)
  expect(store.get(KV.accounts.accepted)).toEqual(beforeAccepted)
  expect(setup.commandEnvironment.GIT_CONFIG_GLOBAL).toBe(oldConfig)
  const application = await h.api('POST', 'sources/github/accounts/apply', { planToken: observation.body.planToken, confirmed: true })
  expect(application).toMatchObject({ status: 200, body: { ok: true, cursorPlan: { kind: 'preserve' } } })
  expect(store.get(KV.accounts.accepted)).toMatchObject({ repository: 'renamed-owner/widgets', repositoryId: '42', revision: beforeAccepted.revision + 1 })
  expect(store.get(KV.github.since)).toBe('2026-09-01T00:00:00Z')
  expect(setup.commandEnvironment.GIT_CONFIG_GLOBAL).not.toBe(oldConfig)
  expect(readFileSync(oldConfig, 'utf8')).toBe(oldContents)
  expect(store.settings().paused).toBe(true)
  expect(runtime.maintenance.blockers()).toContainEqual({ code: 'account-restart-pending' })
  expect(h.jobs.service.kill).not.toHaveBeenCalled()
})


it('refuses startup activation and account apply when a previous process left an unconfirmed cleanup marker', async () => {
  const marker = { code: 'guest-cleanup-unconfirmed' as const, at: '2026-10-01T00:00:00Z', sessionIds: ['old-owned-session'] }
  const run = vi.spyOn(Setup.prototype, 'run')
  h = await startRuntime(store => { store.set(KV.runtime.executionCleanup, marker) })
  expect(run).not.toHaveBeenCalled()
  expect(h.runtime.configured()).toBe(false)
  expect(h.runtime.health.runtime).toMatchObject({ state: 'error', detail: expect.stringContaining('manual verification') })
  expect(h.runtime.maintenance.blockers()).toContainEqual({ code: 'guest-cleanup-unconfirmed', detail: expect.any(String) })
  const store = h.runtime.store
  store.saveSettings({ ...store.settings(), paused: true })
  const observed = await h.api('POST', 'sources/github/accounts/refresh')
  expect(observed).toMatchObject({ status: 200, body: { ok: true, planToken: expect.any(String) } })
  expect(store.get(KV.runtime.executionCleanup)).toEqual(marker)
  expect(await h.api('POST', 'sources/github/accounts/apply', { planToken: observed.body.planToken, confirmed: true }))
    .toMatchObject({ status: 200, body: { ok: false, code: 'busy', blockers: expect.arrayContaining([{ code: 'guest-cleanup-unconfirmed', detail: expect.any(String) }]) } })
  expect(store.get(KV.runtime.executionCleanup)).toEqual(marker)
  expect(store.get(KV.accounts.accepted)).toBeUndefined()
})

it('recovers the accepted active environment over HTTP without changing queued replies, inbox, generation, cursors or settings', async () => {
  h = await startRuntime()
  const { runtime } = h
  await vi.waitFor(() => expect(runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
  await runtime.settings.pause(true, 'panel'); await runtime.idle()
  runtime.outbox.send({ id: 'owned-waiting-reply', kind: 'reply', text: 'owned pending reply', channel: { source: 'github', thread: 'github:1', address: { number: '1' } } })
  const agent = h.agents.get(runtime.masterId)!
  agent.inbox.nextTurn.push({ id: 'owned-idle-input', role: 'user', content: [{ type: 'text', text: 'pending user input' }], source: { kind: 'user' } } as never)
  runtime.store.set(KV.github.since, '2026-10-01T00:00:00Z')
  runtime.accountRuntime.hold('login-lost')
  expect(runtime.accountRuntime.blockers().items.map(item => item.code)).toEqual(expect.arrayContaining(['old-outbox', 'pending-business-effects', 'managed-input-pending']))
  expect(runtime.accountRuntime.recoveryBlockers().items).toEqual([])
  const dump = () => ['kv', 'ticket', 'thread', 'outbox', 'effect'].map(table => runtime.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
  const before = dump(), inbox = JSON.stringify(agent.inbox.nextTurn)
  const generation = runtime.setup.currentEnvironmentGeneration, config = readFileSync(runtime.setup.commandEnvironment.GIT_CONFIG_GLOBAL!, 'utf8')
  const stage = vi.spyOn(runtime.setup, 'stage'), activate = vi.spyOn(runtime.setup, 'activate'), restart = vi.spyOn(runtime.setup, 'restart'), pass = vi.spyOn(runtime.passes, 'request')
  const observed = await h.api('POST', 'sources/github/accounts/refresh')
  expect(observed).toMatchObject({ status: 200, body: { ok: true, status: 'unchanged', confirmationReason: 'health-recovery', blockers: [] } })
  expect(await h.api('POST', 'sources/github/accounts/apply', { planToken: observed.body.planToken, confirmed: true }))
    .toMatchObject({ status: 200, body: { ok: true, action: 'recovered', activation: 'active', cursorPlan: { kind: 'preserve' } } })
  expect(dump()).toEqual(before); expect(JSON.stringify(agent.inbox.nextTurn)).toBe(inbox)
  expect(runtime.setup.currentEnvironmentGeneration).toEqual(generation)
  expect(readFileSync(runtime.setup.commandEnvironment.GIT_CONFIG_GLOBAL!, 'utf8')).toBe(config)
  expect(runtime.maintenance.blockers()).toEqual([])
  expect(stage).not.toHaveBeenCalled(); expect(activate).not.toHaveBeenCalled(); expect(restart).not.toHaveBeenCalled(); expect(pass).not.toHaveBeenCalled()
  expect(runtime.store.settings().paused).toBe(true)
})

it('refuses recovery of an altered active shim and never repairs it or clears the hold', async () => {
  h = await startRuntime()
  const { runtime } = h
  await vi.waitFor(() => expect(runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
  await runtime.settings.pause(true, 'panel'); await runtime.idle()
  runtime.accountRuntime.hold('login-lost')
  const shim = join(runtime.setup.currentEnvironmentGeneration!.directory, 'worker-bin', 'gh')
  writeFileSync(shim, '#!/bin/sh\n# DO_NOT_EXPOSE_PRIVATE_CORRUPTION\nexit 1\n')
  const before = runtime.store.db.prepare('SELECT key,value FROM kv ORDER BY key').all()
  const stage = vi.spyOn(runtime.setup, 'stage'), restart = vi.spyOn(runtime.setup, 'restart')
  const observed = await h.api('POST', 'sources/github/accounts/refresh')
  const applied = await h.api('POST', 'sources/github/accounts/apply', { planToken: observed.body.planToken, confirmed: true })
  expect(applied).toMatchObject({ status: 200, body: { ok: false, code: 'activation-failed' } })
  expect(JSON.stringify(applied)).not.toContain('DO_NOT_EXPOSE_PRIVATE_CORRUPTION')
  expect(runtime.store.db.prepare('SELECT key,value FROM kv ORDER BY key').all()).toEqual(before)
  expect(readFileSync(shim, 'utf8')).toContain('DO_NOT_EXPOSE_PRIVATE_CORRUPTION')
  expect(runtime.maintenance.blockers()).toContainEqual({ code: 'account-health-hold', detail: 'login-lost' })
  expect(stage).not.toHaveBeenCalled(); expect(restart).not.toHaveBeenCalled()
})

it('tracks public readonly diagnostics in the Setup shutdown barrier and rejects new diagnostics after abort', async () => {
  h = await startRuntime()
  const finished = deferred<string>(), closed = vi.spyOn(h.runtime.store, 'close')
  const diagnostic = h.runtime.trackDiagnostic(() => finished.promise)
  const stopping = h.runtime.stop()
  expect(closed).not.toHaveBeenCalled()
  finished.resolve('owned diagnostic result')
  expect(await diagnostic).toBe('owned diagnostic result')
  await stopping
  expect(closed).toHaveBeenCalledOnce()
  const late = vi.fn(async () => 'must not run')
  await expect(h.runtime.trackDiagnostic(late)).rejects.toMatchObject({ name: 'AbortError' })
  expect(late).not.toHaveBeenCalled()
})

it('awaits owned execution shutdown before disposing Session guards or closing SQLite', async () => {
  h = await startRuntime()
  const finished = deferred<void>()
  vi.spyOn(h.runtime.sessions, 'shutdownExecutions').mockReturnValueOnce(finished.promise)
  const closed = vi.spyOn(h.runtime.store, 'close'), disposed = vi.spyOn(h.runtime.sessions, 'dispose')
  const stopped = h.runtime.stop()
  expect(closed).not.toHaveBeenCalled(); expect(disposed).not.toHaveBeenCalled()
  finished.resolve()
  await stopped
  expect(disposed).toHaveBeenCalledOnce(); expect(closed).toHaveBeenCalledOnce()
  expect(disposed.mock.invocationCallOrder[0]).toBeLessThan(closed.mock.invocationCallOrder[0]!)
})

it('persists a credential-free failure marker and rejects stop rather than swallowing unconfirmed execution cleanup', async () => {
  h = await startRuntime()
  expectedFailedStop = true
  vi.spyOn(h.runtime.sessions, 'shutdownExecutions').mockRejectedValueOnce(Object.assign(new Error('DO_NOT_PERSIST raw command stderr token=private'), { code: 'WSL_CLEANUP_UNCONFIRMED' }))
  const disposed = vi.spyOn(h.runtime.sessions, 'dispose')
  const masterId = h.runtime.masterId
  await expect(h.runtime.stop()).rejects.toThrow('manual verification')
  expect(disposed).not.toHaveBeenCalled()
  const reopened = new Store(join(h.directory, 'orchestrator.sqlite'))
  try {
    const marker = reopened.get(KV.runtime.executionCleanup)
    expect(marker).toEqual({ code: 'guest-cleanup-unconfirmed', at: expect.any(String), sessionIds: [masterId] })
    expect(JSON.stringify(marker)).not.toMatch(/DO_NOT_PERSIST|token=|stderr/)
  } finally { reopened.close() }
})

it.each(['barrier', 'executor', 'flush'] as const)('rejects ordinary %s shutdown failures without creating a guest-cleanup marker', async kind => {
  h = await startRuntime()
  expectedFailedStop = true
  if (kind === 'barrier') vi.spyOn(h.runtime.sessions, 'shutdownExecutions').mockRejectedValueOnce(new Error('ordinary result failure after cleanup'))
  if (kind === 'executor') vi.spyOn(h.runtime.executor, 'shutdown').mockRejectedValueOnce(new Error('ordinary cancellation failure'))
  if (kind === 'flush') vi.spyOn(h.ctx.sessionPersistence, 'flush').mockRejectedValueOnce(new Error('ordinary persistence failure'))
  const disposed = vi.spyOn(h.runtime.sessions, 'dispose')
  await expect(h.runtime.stop()).rejects.toThrow('Orchestrator shutdown failed')
  expect(disposed).toHaveBeenCalledOnce()
  const reopened = new Store(join(h.directory, 'orchestrator.sqlite'))
  try { expect(reopened.get(KV.runtime.executionCleanup)).toBeUndefined() } finally { reopened.close() }
})

it('recognizes explicit cleanup tags in cross-bundle error trees without treating general errors as unconfirmed', () => {
  expect(hasUnconfirmedExecutionCleanup({ errors: [new Error('ordinary'), { cause: { code: 'WSL_CLEANUP_UNCONFIRMED' } }] })).toBe(true)
  expect(hasUnconfirmedExecutionCleanup(new AggregateError([new Error('ordinary'), { code: 'EACCES' }], 'general failure'))).toBe(false)
  const cyclic: Record<string, unknown> = {}; cyclic.cause = cyclic
  expect(hasUnconfirmedExecutionCleanup(cyclic)).toBe(false)
})

it('persists Commands cleanup failures through the Runtime safety port before a later process can start', async () => {
  const realRun = Commands.prototype.run
  h = await startRuntime()
  expectedFailedStop = true
  const { runtime } = h, deployment = runtime.setup.deployment
  vi.spyOn(runtime.setup, 'deployment', 'get').mockReturnValue({ ...deployment, wsl: { distro: 'OwnedTest', user: 'selected', workRoot: '/work' } })
  vi.spyOn(transport, 'runWsl').mockRejectedValueOnce(Object.assign(new Error('DO_NOT_PERSIST command/token diagnostics'), { code: 'WSL_CLEANUP_UNCONFIRMED' }))
  await expect(realRun.call(runtime.commands, 'git', ['status'])).rejects.toThrow()
  const marker = runtime.store.get(KV.runtime.executionCleanup)
  expect(marker).toMatchObject({ code: 'guest-cleanup-unconfirmed', sessionIds: [runtime.masterId] })
  expect(JSON.stringify(marker)).not.toContain('DO_NOT_PERSIST')
  expect(runtime.maintenance.blockers()).toContainEqual({ code: 'guest-cleanup-unconfirmed', detail: expect.any(String) })
  await expect(runtime.stop()).rejects.toThrow('manual verification')
  const reopened = new Store(join(h.directory, 'orchestrator.sqlite'))
  try { expect(reopened.get(KV.runtime.executionCleanup)).toMatchObject({ code: 'guest-cleanup-unconfirmed', sessionIds: marker!.sessionIds }) } finally { reopened.close() }
})

it('never commits a delayed settings validation after the runtime stopped and closed its Store', async () => {
  h = await startRuntime()
  const { runtime } = h, current = runtime.store.settings().executor
  const revision = runtime.store.blockRevision('executor'), check = deferred<unknown>()
  const llm = (h.ctx as unknown as { llm: { resolveCallConfig: ReturnType<typeof vi.fn> } }).llm
  llm.resolveCallConfig.mockImplementationOnce(() => check.promise)
  const validation = runtime.settings.save('executor', { ...current, model }, revision, 'panel')
  const outcome = validation.then(() => undefined, error => error as Error)
  await runtime.stop()
  check.resolve(model)
  expect(await outcome).toMatchObject({ name: 'AbortError' })
  const reopened = new Store(join(h.directory, 'orchestrator.sqlite'))
  try { expect(reopened.blockRevision('executor')).toBe(revision) } finally { reopened.close() }
})

it('holds admission after a legacy environment save until controlled restart, leaving the old generation immutable', async () => {
  h = await startRuntime()
  const { runtime } = h, { store, setup } = runtime
  await vi.waitFor(() => expect(runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
  await runtime.settings.pause(true, 'panel'); await runtime.idle()
  const oldEnvironment = setup.commandEnvironment
  const oldConfig = readFileSync(oldEnvironment.GIT_CONFIG_GLOBAL!, 'utf8')
  const saved = await runtime.settings.save('executor', { ...store.settings().executor, blockedCommands: ['owned-test-denied'] }, store.blockRevision('executor'), 'panel')
  expect(saved.restarting).toBe(true)
  expect(runtime.maintenance.blockers()).toContainEqual({ code: 'settings-restart-pending' })
  expect(setup.commandEnvironment).toEqual(oldEnvironment)
  expect(readFileSync(oldEnvironment.GIT_CONFIG_GLOBAL!, 'utf8')).toBe(oldConfig)
  expect(store.settings().paused).toBe(true)
})
