/** Runtime account adapters use only owned temporary SQLite state and fake probes; never a login or business API. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountRuntime, accountStoreBlockers, applyAccountCutover } from '../src/app/account-runtime.ts'
import { Store } from '../src/app/store.ts'
import { Setup, executionBindingTarget } from '../src/app/setup.ts'
import type { SetupStage } from '../src/app/setup.ts'
import type { AccountBinding } from '../src/app/account-binding.ts'
import { MaintenanceGate } from '../src/execution/maintenance.ts'
import { KV } from '../src/kv.ts'
import { SetupError } from '../src/setup.ts'
import { Commands } from '../src/infra/commands.ts'
import * as transport from '../src/infra/wsl.ts'
import { ExecutionTargetError, environmentSnapshot, freezeExecutionSnapshot, freezeTarget } from '../src/execution/target.ts'
import { clampGithubSince } from '../src/sources/github.ts'
import { testDeployment } from './fixtures/deployment.ts'
const binding: AccountBinding = { accountId: '7', repositoryId: '42', login: 'agent-bot', repository: 'acme/widgets', cli: '/bin/false', noreply: '7+agent-bot@users.noreply.github.com', executionTarget: 'native' }
const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'account-runtime-owned-'))
  const store = new Store(join(directory, 'state.sqlite'))
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  store.saveSettings({ ...store.settings(), paused: true })
  store.set(KV.accounts.accepted, { ...binding, revision: 4, acceptedAt: '2026-09-01T00:00:00.000Z' })
  store.set(KV.accounts.generation, 4)
  store.set(KV.accounts.activation, { revision: 4, bindingRevision: 4, directory: '/owned-test-generation' })
  const maintenance = new MaintenanceGate(), restart = vi.fn()
  let observed = { ...binding }
  const observe = vi.fn(async () => ({ binding: { ...observed }, deployment: testDeployment({ userId: observed.accountId, repoId: observed.repositoryId, repository: observed.repository, github: { cli: observed.cli, login: observed.login, noreply: observed.noreply } }) }))
  const stage = vi.fn(async (): Promise<SetupStage> => ({ deployment: (await observe()).deployment, env: Object.freeze({ GIT_CONFIG_GLOBAL: '/stage/gitconfig' }) }))
  const activate = vi.fn(), discard = vi.fn(async () => {}), verify = vi.fn(async () => {})
  const setup = { observe, stage, activate, discard, verifyAcceptedEnvironment: verify, currentEnvironmentGeneration: { directory: '/owned-test-generation' } } as unknown as Setup
  const busy = vi.fn(() => [] as { code: string }[])
  const runtime = new AccountRuntime({ store, setup, maintenance, restart, busy })
  return { store, runtime, maintenance, restart, observe, stage, activate, discard, verify, busy, setObserved: (candidate: Partial<AccountBinding>) => { observed = { ...binding, ...candidate } } }
}
async function token(f: ReturnType<typeof fixture>) {
  const result = await f.runtime.service.refresh()
  expect(result.ok).toBe(true)
  if (!result.ok || !result.planToken) throw new Error('Expected confirmation ticket')
  return result.planToken
}
describe('runtime account ports', () => {
  it('refreshes without settings, cursor, accepted binding, environment or restart writes', async () => {
    const f = fixture()
    f.store.set(KV.github.since, '2026-09-01T00:00:00Z')
    const before = f.store.db.prepare('SELECT key,value FROM kv ORDER BY key').all()
    expect(await f.runtime.service.refresh()).toMatchObject({ ok: true, status: 'unchanged', cursorPlan: 'preserve' })
    expect(f.store.db.prepare('SELECT key,value FROM kv ORDER BY key').all()).toEqual(before)
    expect(f.stage).not.toHaveBeenCalled(); expect(f.restart).not.toHaveBeenCalled()
  })
  it('holds confirmed signout but not transient probe failure, and requires explicit recovery', async () => {
    const f = fixture()
    f.observe.mockRejectedValueOnce(new SetupError('repositoryUnreadable', { account: 'agent', repository: 'acme/widgets', output: 'transient' }))
    expect(await f.runtime.service.refresh()).toMatchObject({ ok: false, code: 'probe-failed', setupCode: 'repositoryUnreadable' })
    expect(f.maintenance.blockers()).toEqual([])
    f.observe.mockRejectedValueOnce(new SetupError('agentCliSignedOut', { output: 'dial tcp api.github.com: network unavailable (HTTP 503)' }))
    expect(await f.runtime.service.refresh()).toMatchObject({ ok: false, code: 'probe-failed' })
    expect(f.maintenance.blockers()).toEqual([])
    f.observe.mockRejectedValueOnce(new SetupError('agentCliNoAccount'))
    expect(await f.runtime.service.refresh()).toMatchObject({ ok: false, code: 'probe-failed' })
    expect(f.maintenance.blockers()).toEqual([])
    f.observe.mockRejectedValueOnce(new SetupError('agentCliSignedOut', { output: 'gh: Bad credentials (HTTP 401); private diagnostics must not escape' }))
    expect(await f.runtime.service.refresh()).toMatchObject({ ok: false, setupCode: 'agentCliSignedOut' })
    expect(f.maintenance.blockers()[0]?.code).toBe('account-health-hold')
    const planToken = await token(f)
    expect(f.maintenance.blockers()).not.toEqual([])
    expect(await f.runtime.service.apply(planToken, true)).toMatchObject({ ok: true, action: 'recovered', activation: 'active', cursorPlan: { kind: 'preserve' } })
    expect(f.verify).toHaveBeenCalledOnce()
    expect(f.stage).not.toHaveBeenCalled(); expect(f.activate).not.toHaveBeenCalled(); expect(f.restart).not.toHaveBeenCalled()
    expect(f.maintenance.blockers()).toEqual([])
    expect(f.store.settings().paused).toBe(true)
  })
  it('recovers the exact accepted binding with idle backlog/inbox while preserving every persistent row and generation', async () => {
    const f = fixture()
    f.store.db.prepare('INSERT INTO ticket(id,value) VALUES (?,?)').run('waiting', JSON.stringify({ id: 'waiting', assignments: [], undelivered: ['input-1'] }))
    f.store.db.prepare('INSERT INTO thread(key,value) VALUES (?,?)').run('github:1', JSON.stringify({ pending: ['trigger-1'] }))
    f.store.db.prepare('INSERT INTO outbox(id,value) VALUES (?,?)').run('old-reply', JSON.stringify({ status: 'pending' }))
    f.store.db.prepare('INSERT INTO effect(kind,key,value,seq,due,since) VALUES (?,?,?,?,?,?)').run('launch', 'waiting', '{}', 1, 0, '')
    f.store.set(KV.github.since, '2026-10-01T00:00:00Z'); f.store.set(KV.github.retries, { '1': { since: '2026-09-01T00:00:00Z', pr: false } })
    f.busy.mockReturnValue([{ code: 'managed-input-pending' }])
    f.runtime.hold('login-lost')
    expect(f.runtime.blockers().items.map(item => item.code)).toEqual(expect.arrayContaining(['open-tickets', 'business-backlog', 'old-outbox', 'pending-business-effects', 'managed-input-pending']))
    expect(f.runtime.recoveryBlockers().items).toEqual([])
    const dump = () => ['kv', 'ticket', 'thread', 'outbox', 'effect'].map(table => f.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
    const before = dump()
    expect(await f.runtime.service.apply(await token(f), true)).toMatchObject({ ok: true, action: 'recovered', activation: 'active', cursorPlan: { kind: 'preserve' } })
    expect(dump()).toEqual(before)
    expect(f.verify).toHaveBeenCalledOnce(); expect(f.stage).not.toHaveBeenCalled(); expect(f.restart).not.toHaveBeenCalled(); expect(f.activate).not.toHaveBeenCalled()
    expect(f.maintenance.blockers()).toEqual([])
  })
  it('never applies the relaxed recovery gate to a renamed binding or changed CLI/target', async () => {
    const f = fixture(); f.runtime.hold('login-lost'); f.busy.mockReturnValue([{ code: 'managed-input-pending' }])
    f.setObserved({ repository: 'acme/renamed' })
    expect(await f.runtime.service.apply(await token(f), true)).toMatchObject({ ok: false, code: 'busy' })
    expect(f.verify).not.toHaveBeenCalled(); expect(f.stage).not.toHaveBeenCalled()
  })
  it.each(['source', 'effect', 'job', 'turn', 'outbound'] as const)('still blocks exact recovery during real %s activity without cancelling it', async kind => {
    const f = fixture(), release = f.maintenance.admit(kind)
    f.runtime.hold('login-lost')
    expect(await f.runtime.service.apply(await token(f), true)).toMatchObject({ ok: false, code: 'busy' })
    expect(f.verify).not.toHaveBeenCalled(); expect(f.maintenance.activityBlockers()).toHaveLength(1)
    release()
  })
  it.each(['managed-turn', 'managed-job', 'managed-jobs-unavailable', 'managed-session-discovery-unavailable'])('fails closed recovery for %s rather than treating it as idle inbox', async code => {
    const f = fixture(); f.runtime.hold('login-lost'); f.busy.mockReturnValue([{ code }])
    expect(await f.runtime.service.apply(await token(f), true)).toMatchObject({ ok: false, code: 'busy' })
    expect(f.verify).not.toHaveBeenCalled()
  })
  it('keeps the account hold when active files cannot be verified, without any activation or KV write', async () => {
    const f = fixture(); f.runtime.hold('login-lost')
    f.verify.mockRejectedValueOnce(new Error('Unverifiable active configuration'))
    const before = f.store.db.prepare('SELECT key,value FROM kv ORDER BY key').all()
    expect(await f.runtime.service.apply(await token(f), true)).toMatchObject({ ok: false, code: 'activation-failed' })
    expect(f.store.db.prepare('SELECT key,value FROM kv ORDER BY key').all()).toEqual(before)
    expect(f.maintenance.blockers()).toContainEqual({ code: 'account-health-hold', detail: 'login-lost' })
    expect(f.stage).not.toHaveBeenCalled(); expect(f.restart).not.toHaveBeenCalled()
  })
  it('does not clear a replacement health hold or accept a missing activation record during recovery verification', async () => {
    const f = fixture(); f.runtime.hold('login-lost')
    f.verify.mockImplementationOnce(async () => { f.runtime.hold('identity-drift') })
    expect(await f.runtime.service.apply(await token(f), true)).toMatchObject({ ok: false, code: 'activation-failed' })
    expect(f.maintenance.blockers()).toContainEqual({ code: 'account-health-hold', detail: 'identity-drift' })
    f.store.delete(KV.accounts.activation)
    expect(await f.runtime.service.apply(await token(f), true)).toMatchObject({ ok: false, code: 'activation-failed' })
    expect(f.stage).not.toHaveBeenCalled()
  })
  it('holds confirmed target identity mismatch, but does not turn an unavailable target into identity drift', async () => {
    const f = fixture()
    f.observe.mockRejectedValueOnce(new ExecutionTargetError('TARGET_PROBE_FAILED', 'unavailable'))
    expect(await f.runtime.service.refresh()).toMatchObject({ ok: false, setupCode: 'environmentFailed' })
    expect(f.maintenance.blockers()).toEqual([])
    f.observe.mockRejectedValueOnce(new ExecutionTargetError('TARGET_USER_MISMATCH', 'confirmed mismatch'))
    expect(await f.runtime.service.refresh()).toMatchObject({ ok: false, setupCode: 'environmentFailed' })
    expect(f.maintenance.blockers()).toContainEqual({ code: 'account-health-hold', detail: 'target-identity-drift' })
  })
  it('refuses a guest boot or HOME change after staging without publishing or committing the old snapshot', async () => {
    const f = fixture()
    const identity = { distro: 'OwnedTest', user: 'selected', uid: 1000, home: '/home/selected', bootId: 'before-stage' }
    const workspace = { input: '/work', guestPath: '/work', hostPath: '\\\\wsl.localhost\\OwnedTest\\work', storage: 'guest-local' as const,
      evidence: { converter: 'wslpath' as const, hostRegistration: 'verified' as const, fileSystem: 'ext4' } }
    const snapshot = freezeExecutionSnapshot(1, freezeTarget(identity, workspace, 'owned-stage', '2026-10-01T00:00:00Z'), environmentSnapshot({ HOME: identity.home }))
    f.setObserved({ executionTarget: executionBindingTarget(snapshot.target, workspace) })
    const original = f.observe.getMockImplementation()!
    f.observe.mockImplementation(async () => ({ ...await original(), guest: { identity: { ...identity, bootId: 'after-stage', home: '/different-home' }, workspace, path: '/usr/bin' } }))
    f.stage.mockImplementationOnce(async () => ({ deployment: (await f.observe()).deployment, env: {}, snapshot }))
    expect(await f.runtime.service.apply(await token(f), true)).toMatchObject({ ok: false, code: 'activation-failed' })
    expect(f.store.get(KV.accounts.accepted)?.revision).toBe(4)
    expect(f.activate).not.toHaveBeenCalled(); expect(f.discard).toHaveBeenCalledOnce()
  })
  it('offers and applies a preserve rebind for the same account after a new guest boot or HOME', async () => {
    const f = fixture()
    const before = { distro: 'OwnedTest', user: 'selected', uid: 1000, home: '/home/selected', bootId: 'before-reboot' }
    const after = { ...before, bootId: 'after-reboot', home: '/home/new-selected' }
    const workspace = { input: '/work', guestPath: '/work', hostPath: '\\\\wsl.localhost\\OwnedTest\\work', storage: 'guest-local' as const,
      evidence: { converter: 'wslpath' as const, hostRegistration: 'verified' as const, fileSystem: 'ext4' } }
    f.store.set(KV.accounts.accepted, { ...binding, executionTarget: executionBindingTarget(before, workspace), revision: 4, acceptedAt: '2026-09-01T00:00:00Z' })
    f.store.set(KV.github.since, '2026-09-01T00:00:00Z')
    f.setObserved({ executionTarget: executionBindingTarget(after, workspace) })
    const original = f.observe.getMockImplementation()!
    f.observe.mockImplementation(async () => ({ ...await original(), guest: { identity: after, workspace, path: '/usr/bin' } }))
    const snapshot = freezeExecutionSnapshot(5, freezeTarget(after, workspace, 'new-guest-generation', '2026-10-01T00:00:00Z'), environmentSnapshot({ HOME: after.home }))
    f.stage.mockImplementationOnce(async () => ({ deployment: (await f.observe()).deployment, env: { HOME: after.home }, snapshot }))
    const observation = await f.runtime.service.refresh()
    expect(observation).toMatchObject({ ok: true, status: 'changed', cursorPlan: 'preserve', planToken: expect.any(String) })
    if (!observation.ok || !observation.planToken) throw new Error('Expected preserve rebind ticket')
    expect(await f.runtime.service.apply(observation.planToken, true)).toMatchObject({ ok: true, cursorPlan: { kind: 'preserve' } })
    expect(f.store.get(KV.accounts.execution)?.target).toMatchObject({ bootId: 'after-reboot', home: after.home })
    expect(f.store.get(KV.github.since)).toBe('2026-09-01T00:00:00Z')
    expect(f.store.settings().paused).toBe(true)
  })
  it('preserves notification and CI cursors for stable-ID repository/account renames', async () => {
    const f = fixture()
    f.store.set(KV.github.since, '2026-09-01T00:00:00Z')
    f.store.set(KV.github.ci(12), { fingerprint: 'old', revision: 19 })
    f.setObserved({ login: 'renamed-agent', repository: 'new-owner/widgets', noreply: '7+renamed-agent@users.noreply.github.com' })
    expect(await f.runtime.service.apply(await token(f), true)).toMatchObject({ ok: true, cursorPlan: { kind: 'preserve' } })
    expect(f.store.get(KV.accounts.accepted)).toMatchObject({ accountId: '7', repositoryId: '42', revision: 5, login: 'renamed-agent' })
    expect(f.store.get(KV.github.since)).toBe('2026-09-01T00:00:00Z')
    expect(f.store.get(KV.github.ci(12))?.revision).toBe(19)
    expect(f.activate).toHaveBeenCalledOnce(); expect(f.restart).toHaveBeenCalledOnce()
  })
  it('atomically commits cutover without resetting CI revisions, and never resumes', async () => {
    const f = fixture()
    f.store.set(KV.github.ci(12), { fingerprint: 'old', revision: 19 })
    f.store.set(KV.github.branchCi, { branch: 'main', failures: ['x'], revision: 40 })
    f.store.set(KV.github.stream('comments'), { since: '2000-01-01T00:00:00Z', started: {}, etag: 'private-old-account-etag' })
    f.store.set(KV.github.retries, { '12': { since: '2000-01-01T00:00:00Z', pr: false } })
    f.setObserved({ accountId: '8', login: 'new-agent' })
    const result = await f.runtime.service.apply(await token(f), true)
    expect(result).toMatchObject({ ok: true, cursorPlan: { kind: 'cutover' } })
    const cutoff = f.store.get(KV.github.cutoff)!
    expect(f.store.get(KV.github.since)).toBe(cutoff)
    expect(f.store.get(KV.github.retries)).toEqual({})
    expect(f.store.keys(KV.github.stream)).toEqual([])
    expect(f.store.get(KV.github.ciBaseline)).toMatch(new RegExp(`^${cutoff}:`))
    expect(f.store.get(KV.github.ci(12))?.revision).toBe(19)
    expect(f.store.get(KV.github.branchCi)?.revision).toBe(40)
    expect(f.store.settings().paused).toBe(true)
  })
  it('does not mistake a health hold for a manual pause', async () => {
    const f = fixture()
    f.store.saveSettings({ ...f.store.settings(), paused: false })
    f.setObserved({ accountId: '8' })
    const planToken = await token(f)
    expect(f.maintenance.blockers()).not.toEqual([])
    expect(await f.runtime.service.apply(planToken, true)).toMatchObject({ ok: false, code: 'pause-required' })
    expect(f.stage).not.toHaveBeenCalled()
  })
  it.each(['source', 'outbound', 'turn', 'job', 'effect'] as const)('refuses an in-flight %s without killing it', async kind => {
    const f = fixture()
    const release = f.maintenance.admit(kind)
    f.setObserved({ repository: 'acme/renamed' })
    expect(await f.runtime.service.apply(await token(f), true)).toMatchObject({ ok: false, code: 'busy', blockers: [{ code: `activity-${kind}` }] })
    expect(f.stage).not.toHaveBeenCalled(); expect(f.maintenance.activityBlockers()).toHaveLength(1)
    release()
  })
  it('blocks old pending outbox and business backlog, but not pure idle notices', () => {
    const f = fixture()
    f.store.db.prepare('INSERT INTO effect(kind,key,value,seq,due,since) VALUES (?,?,?,?,?,?)').run('notice', 'settings', '{}', 1, 0, '')
    expect(accountStoreBlockers(f.store).items).toEqual([])
    f.store.db.prepare('INSERT INTO outbox(id,value) VALUES (?,?)').run('old', JSON.stringify({ status: 'pending' }))
    expect(accountStoreBlockers(f.store).items).toContainEqual({ code: 'old-outbox' })
    f.store.db.prepare('INSERT INTO effect(kind,key,value,seq,due,since) VALUES (?,?,?,?,?,?)').run('relay', 'business', '{}', 2, 0, '')
    expect(accountStoreBlockers(f.store).items).toContainEqual({ code: 'pending-business-effects' })
  })
  it('requires startup confirmation for drift and for legacy state with history', () => {
    const f = fixture()
    expect(f.runtime.acceptStartup(binding)).toBe(true)
    expect(f.runtime.acceptStartup({ ...binding, accountId: '8' })).toBe(false)
    expect(f.store.get(KV.accounts.accepted)?.accountId).toBe('7')
    f.store.delete(KV.accounts.accepted)
    f.store.db.prepare('INSERT INTO trigger VALUES (?,?,?)').run('old', '{}', '')
    expect(f.runtime.acceptStartup(binding)).toBe(false)
  })
  it('never lets account refresh/recovery clear or bypass a persisted guest-cleanup failure', async () => {
    const f = fixture()
    const marker = { code: 'guest-cleanup-unconfirmed' as const, at: '2026-10-01T00:00:00Z', sessionIds: ['owned-test-session'] }
    f.store.set(KV.runtime.executionCleanup, marker)
    f.runtime.hold('login-lost')
    expect(f.runtime.acceptStartup(binding)).toBe(false)
    const planToken = await token(f)
    expect(f.store.get(KV.runtime.executionCleanup)).toEqual(marker)
    expect(await f.runtime.service.apply(planToken, true)).toMatchObject({ ok: false, code: 'busy', blockers: expect.arrayContaining([{ code: 'guest-cleanup-unconfirmed', detail: expect.any(String) }]) })
    expect(f.store.get(KV.runtime.executionCleanup)).toEqual(marker)
    expect(f.store.get(KV.accounts.accepted)?.revision).toBe(4)
    expect(f.stage).not.toHaveBeenCalled(); expect(f.activate).not.toHaveBeenCalled()
    expect(() => f.runtime.commitStartup({ deployment: testDeployment(), env: {} }, binding)).toThrow('manual verification')
  })
  it('forbids a truly different stable repository with history', async () => {
    const f = fixture()
    f.store.db.prepare('INSERT INTO trigger VALUES (?,?,?)').run('old', '{}', '')
    f.setObserved({ repositoryId: '99', repository: 'other/repo' })
    expect(await f.runtime.service.refresh()).toMatchObject({ ok: true, blockers: [{ code: 'repository-history' }] })
    expect(f.stage).not.toHaveBeenCalled()
  })
  it('stage failure retains accepted binding, blocks work, and never restarts', async () => {
    const f = fixture()
    f.setObserved({ repository: 'acme/renamed' })
    f.stage.mockRejectedValueOnce(new Error('stage failure'))
    expect(await f.runtime.service.apply(await token(f), true)).toMatchObject({ ok: false, code: 'stage-failed' })
    expect(f.store.get(KV.accounts.accepted)?.revision).toBe(4)
    expect(f.maintenance.blockers()[0]?.code).toBe('account-health-hold')
    expect(f.restart).not.toHaveBeenCalled()
  })
  it('does not discard a committed generation if post-commit publication fails', async () => {
    const f = fixture()
    f.setObserved({ repository: 'acme/renamed' })
    f.stage.mockImplementationOnce(async () => ({ deployment: (await f.observe()).deployment, env: {}, directory: '/owned-test-generation' }))
    f.activate.mockImplementationOnce(() => { throw new Error('publication failed') })
    expect(await f.runtime.service.apply(await token(f), true)).toMatchObject({ ok: false, code: 'activation-failed' })
    expect(f.store.get(KV.accounts.accepted)?.revision).toBe(5)
    expect(f.store.get(KV.accounts.activation)?.directory).toBe('/owned-test-generation')
    expect(f.discard).not.toHaveBeenCalled(); expect(f.restart).not.toHaveBeenCalled()
    expect(f.maintenance.blockers()[0]?.code).toBe('account-health-hold')
  })
  it('rolls back a failed activation record transaction without switching the environment', async () => {
    const f = fixture()
    f.setObserved({ repository: 'acme/renamed' })
    const write = f.store.set.bind(f.store)
    vi.spyOn(f.store, 'set').mockImplementation((name, value) => {
      if (name === KV.accounts.activation) throw new Error('DB refused activation')
      write(name, value)
    })
    expect(await f.runtime.service.apply(await token(f), true)).toMatchObject({ ok: false, code: 'activation-failed' })
    expect(f.store.get(KV.accounts.accepted)?.revision).toBe(4)
    expect(f.activate).not.toHaveBeenCalled(); expect(f.discard).toHaveBeenCalledOnce()
  })
})
describe('cutover lower bound', () => {
  it('clamps old checkpoints, retry cursors, fallback timestamps and overlap to the persisted cutoff', () => {
    const f = fixture(), cutoff = '2026-10-01T00:00:00.000Z'
    f.store.atomic(() => applyAccountCutover(f.store, cutoff))
    const ctx = { state: { get: f.store.get.bind(f.store), set: () => {}, keys: () => [] } }
    for (const value of ['2000-01-01T00:00:00Z', '2026-09-30T23:59:55.000Z', 'invalid']) expect(clampGithubSince(ctx, value)).toBe(cutoff)
    expect(clampGithubSince(ctx, '2026-10-02T00:00:00.000Z')).toBe('2026-10-02T00:00:00.000Z')
    const priorBaseline = f.store.get(KV.github.ciBaseline)
    f.store.atomic(() => applyAccountCutover(f.store, '2026-09-01T00:00:00.000Z'))
    expect(f.store.get(KV.github.cutoff)).toBe(cutoff)
    expect(f.store.get(KV.github.ciBaseline)).not.toBe(priorBaseline)
  })
})


describe('Commands snapshot environment getter', () => {
  it('reports only transport cleanup-unconfirmed errors through the safety callback and preserves it through withSignal', async () => {
    const report = vi.fn(), machine = testDeployment({ wsl: { distro: 'OwnedTest', user: 'selected', workRoot: '/work' } })
    const mocked = vi.spyOn(transport, 'runWsl')
    try {
      const commands = new Commands(() => machine, {}, new AbortController().signal, undefined, undefined, report)
      mocked.mockRejectedValueOnce(Object.assign(new Error('private command diagnostics'), { code: 'WSL_CLEANUP_UNCONFIRMED' }))
      await expect(commands.withSignal(new AbortController().signal).run('git', ['status'])).rejects.toThrow()
      expect(report).toHaveBeenCalledOnce()
      mocked.mockRejectedValueOnce(Object.assign(new Error('ordinary permissions failure'), { code: 'EACCES' }))
      await expect(commands.run('git', ['status'])).rejects.toThrow()
      mocked.mockRejectedValueOnce(Object.assign(new Error('ordinary target change'), { code: 'TARGET_USER_MISMATCH' }))
      await expect(commands.run('git', ['status'])).rejects.toThrow()
      expect(report).toHaveBeenCalledOnce()
    } finally { mocked.mockRestore() }
  })
  it('reads the replacement environment for each command and retains the getter through withSignal', async () => {
    let current = { DSH_OWNED_TEST_GENERATION: 'first' }
    const maintenance = new MaintenanceGate()
    const commands = new Commands(() => testDeployment(), () => current, new AbortController().signal, maintenance)
    const argv = ['-e', 'process.stdout.write(process.env.DSH_OWNED_TEST_GENERATION || "missing")']
    expect(await commands.run(process.execPath, argv)).toBe('first')
    current = { DSH_OWNED_TEST_GENERATION: 'second' }
    expect(await commands.withSignal(new AbortController().signal).run(process.execPath, argv)).toBe('second')
    expect(maintenance.activityBlockers()).toEqual([])
    maintenance.hold('accounts', { code: 'account-health-hold' })
    await expect(commands.run(process.execPath, argv)).rejects.toThrow('blocked by maintenance')
    expect(maintenance.activityBlockers()).toEqual([])
  })
})
