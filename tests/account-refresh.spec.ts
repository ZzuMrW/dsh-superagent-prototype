import { describe, expect, it, vi } from 'vitest'
import type { AccountBinding } from '../src/app/account-binding.ts'
import { AccountProbeError, AccountRefreshService, type AccountRefreshPorts, type AccountRevisions,
  type AccountBlockers } from '../src/app/account-refresh.ts'

const binding = (patch: Partial<AccountBinding> = {}): AccountBinding => ({ accountId: '1', repositoryId: '10', login: 'bot',
  repository: 'acme/widgets', cli: '/usr/bin/gh', noreply: '1+bot@users.noreply.github.com', executionTarget: 'wsl:Ubuntu:worker:/work', ...patch })
function fixture() {
  let now = 1_800_000_000_000
  let active: AccountBinding | null = binding()
  let observed = binding()
  const source = { enabled: true, config: { repository: 'acme/widgets', cli: 'gh' } }
  const revisions: AccountRevisions = { sourceRevision: 1, bindingRevision: 1, runtimeInstance: 'runtime-1', environmentRevision: 1 }
  const blockers: AccountBlockers = { paused: true, items: [], hasHistory: true }
  const ports: AccountRefreshPorts<typeof source, AccountBinding> = {
    currentSavedSource: () => source, activeBinding: () => active, revisions: () => revisions, blockers: () => blockers,
    probe: vi.fn(async () => observed), withMaintenance: vi.fn(async work => work()),
    stageEnvironment: vi.fn(async candidate => candidate), commitAndActivate: vi.fn(async stage => { active = stage; revisions.bindingRevision++ }),
    healthHold: vi.fn(), discardStage: vi.fn(async () => {}), recoverAcceptedBinding: vi.fn(async () => {}),
  }
  const service = new AccountRefreshService(ports, { now: () => now, ttlMs: 1000 })
  return { service, ports, revisions, blockers, source, observed: (next: AccountBinding) => { observed = next },
    active: (next: AccountBinding | null) => { active = next }, advance: () => { now += 1000 } }
}
async function token(f: ReturnType<typeof fixture>) {
  f.observed(binding({ accountId: '2', login: 'new-bot' }))
  const result = await f.service.refresh()
  expect(result).toMatchObject({ ok: true, status: 'changed', cursorPlan: 'cutover' })
  if (!result.ok || !result.planToken) throw new Error('Expected a plan ticket')
  return result.planToken
}

describe('manual read-only observation', () => {
  it('probes saved config, exposes active/observed, and does nothing for an unchanged binding', async () => {
    const f = fixture()
    expect(await f.service.refresh()).toMatchObject({ ok: true, status: 'unchanged', active: binding(), observed: binding(),
      revisions: f.revisions, cursorPlan: 'preserve' })
    expect(f.ports.probe).toHaveBeenCalledWith(f.source)
    expect(f.ports.stageEnvironment).not.toHaveBeenCalled()
    expect(f.ports.commitAndActivate).not.toHaveBeenCalled()
    expect(f.ports.withMaintenance).not.toHaveBeenCalled()
    expect(f.ports.healthHold).not.toHaveBeenCalled()
  })
  it('does not issue a confirmation ticket for ordinary unchanged observations', async () => {
    const f = fixture()
    const result = await f.service.refresh()
    expect(result).toMatchObject({ status: 'unchanged', requiresConfirmation: false })
    expect(result.ok && result.planToken).toBeUndefined()
  })
  it('requires explicit recovery of a held but identical binding without historical replay', async () => {
    const f = fixture()
    let held = true
    f.ports.requiresConfirmation = () => held
    vi.mocked(f.ports.recoverAcceptedBinding!).mockImplementation(async () => { held = false })
    const result = await f.service.refresh()
    expect(result).toMatchObject({ status: 'unchanged', requiresConfirmation: true, confirmationReason: 'health-recovery',
      cursorPlan: 'preserve', active: binding(), observed: binding() })
    if (!result.ok || !result.planToken) throw new Error('Expected recovery ticket')
    expect(held).toBe(true)
    expect(f.ports.stageEnvironment).not.toHaveBeenCalled()
    expect(f.ports.commitAndActivate).not.toHaveBeenCalled()
    expect(await f.service.apply(result.planToken, false)).toMatchObject({ code: 'confirmation-required' })
    expect(held).toBe(true)
    expect(await f.service.apply(result.planToken, true)).toMatchObject({ ok: true, action: 'recovered', activation: 'active', cursorPlan: { kind: 'preserve' } })
    expect(f.ports.recoverAcceptedBinding).toHaveBeenCalledWith(binding())
    expect(f.ports.stageEnvironment).not.toHaveBeenCalled()
    expect(f.ports.commitAndActivate).not.toHaveBeenCalled()
    expect(f.revisions).toEqual({ sourceRevision: 1, bindingRevision: 1, runtimeInstance: 'runtime-1', environmentRevision: 1 })
    expect(held).toBe(false)
    const recovered = await f.service.refresh()
    expect(recovered.ok && recovered.planToken).toBeUndefined()
    expect(recovered).toMatchObject({ status: 'unchanged', requiresConfirmation: false })
  })
  it('retains a same-binding hold when recovery is busy or paused processing is required', async () => {
    const f = fixture()
    f.ports.requiresConfirmation = () => true
    f.blockers.items = [{ code: 'owner-jobs' }]
    const busy = await f.service.refresh()
    if (!busy.ok || !busy.planToken) throw new Error('Expected blocked recovery ticket')
    expect(busy).toMatchObject({ status: 'unchanged', confirmationReason: 'health-recovery', blockers: f.blockers.items })
    expect(await f.service.apply(busy.planToken, true)).toMatchObject({ code: 'busy' })
    f.blockers.items = []
    f.blockers.paused = false
    const unpaused = await f.service.refresh()
    if (!unpaused.ok || !unpaused.planToken) throw new Error('Expected blocked recovery ticket')
    expect(await f.service.apply(unpaused.planToken, true)).toMatchObject({ code: 'pause-required' })
    expect(f.ports.commitAndActivate).not.toHaveBeenCalled()
    expect(f.ports.requiresConfirmation()).toBe(true)
  })
  it('retains recovery holds after failed activation', async () => {
    const f = fixture()
    f.ports.requiresConfirmation = () => true
    vi.mocked(f.ports.recoverAcceptedBinding!).mockRejectedValue(new Error('activation failed'))
    const result = await f.service.refresh()
    if (!result.ok || !result.planToken) throw new Error('Expected recovery ticket')
    expect(await f.service.apply(result.planToken, true)).toMatchObject({ code: 'activation-failed' })
    expect(f.ports.requiresConfirmation()).toBe(true)
  })
  it('recovers an exact accepted binding with persistent backlog without staging or rewriting any cursor', async () => {
    const f = fixture()
    f.ports.requiresConfirmation = () => true
    f.blockers.items = [{ code: 'open-tickets' }, { code: 'business-backlog' }, { code: 'old-outbox' }, { code: 'managed-input-pending' }]
    f.ports.recoveryBlockers = () => ({ ...f.blockers, items: [] })
    const result = await f.service.refresh()
    expect(result).toMatchObject({ status: 'unchanged', confirmationReason: 'health-recovery', blockers: [] })
    if (!result.ok || !result.planToken) throw new Error('Expected recovery ticket')
    expect(await f.service.apply(result.planToken, true)).toEqual({ ok: true, action: 'recovered', activation: 'active',
      active: binding(), cursorPlan: { kind: 'preserve' } })
    expect(f.ports.recoverAcceptedBinding).toHaveBeenCalledTimes(1)
    expect(f.ports.stageEnvironment).not.toHaveBeenCalled()
    expect(f.ports.commitAndActivate).not.toHaveBeenCalled()
    expect(f.ports.probe).toHaveBeenCalledTimes(3)
  })
  it.each(['activity-turn', 'owner-jobs', 'activity-effect', 'activity-source', 'guest-cleanup-unconfirmed', 'runtime-stopping', 'target-mismatch'])(
    'never bypasses real recovery blocker %s', async code => {
      const f = fixture()
      f.ports.requiresConfirmation = () => true
      f.blockers.items = [{ code: 'open-tickets' }]
      f.ports.recoveryBlockers = () => ({ ...f.blockers, items: [{ code }] })
      const result = await f.service.refresh()
      if (!result.ok || !result.planToken) throw new Error('Expected blocked recovery ticket')
      expect(result.blockers).toEqual([{ code }])
      expect(await f.service.apply(result.planToken, true)).toMatchObject({ code: 'busy', blockers: [{ code }] })
      expect(f.ports.recoverAcceptedBinding).not.toHaveBeenCalled()
      expect(f.ports.stageEnvironment).not.toHaveBeenCalled()
    })
  it('does not relax the ordinary switch gate when a recovery blocker port exists', async () => {
    const f = fixture()
    f.ports.requiresConfirmation = () => true
    f.blockers.items = [{ code: 'open-tickets' }]
    f.ports.recoveryBlockers = () => ({ ...f.blockers, items: [] })
    const planToken = await token(f)
    expect(await f.service.apply(planToken, true)).toMatchObject({ code: 'busy', blockers: [{ code: 'open-tickets' }] })
    expect(f.ports.recoverAcceptedBinding).not.toHaveBeenCalled()
  })
  it('fails closed without a recovery port, never falling through to full stage/apply', async () => {
    const f = fixture()
    f.ports.requiresConfirmation = () => true
    delete f.ports.recoverAcceptedBinding
    const result = await f.service.refresh()
    if (!result.ok || !result.planToken) throw new Error('Expected recovery ticket')
    expect(await f.service.apply(result.planToken, true)).toMatchObject({ code: 'activation-failed' })
    expect(f.ports.stageEnvironment).not.toHaveBeenCalled()
    expect(f.ports.commitAndActivate).not.toHaveBeenCalled()
  })
  it('rechecks external identity, final revisions and recovery blockers before clearing the hold', async () => {
    const f = fixture()
    f.ports.requiresConfirmation = () => true
    const result = await f.service.refresh()
    if (!result.ok || !result.planToken) throw new Error('Expected recovery ticket')
    vi.mocked(f.ports.probe).mockResolvedValueOnce(binding()).mockResolvedValueOnce(binding({ accountId: 'wrong' }))
    expect(await f.service.apply(result.planToken, true)).toMatchObject({ code: 'stale' })
    expect(f.ports.recoverAcceptedBinding).not.toHaveBeenCalled()
    expect(f.ports.stageEnvironment).not.toHaveBeenCalled()
  })
  it('invalidates a recovery ticket when revision or final inflight state changes', async () => {
    const f = fixture()
    f.ports.requiresConfirmation = () => true
    const result = await f.service.refresh()
    if (!result.ok || !result.planToken) throw new Error('Expected recovery ticket')
    let probes = 0
    vi.mocked(f.ports.probe).mockImplementation(async () => {
      if (++probes === 2) f.blockers.items = [{ code: 'activity-effect' }]
      return binding()
    })
    expect(await f.service.apply(result.planToken, true)).toMatchObject({ code: 'busy' })
    expect(f.ports.recoverAcceptedBinding).not.toHaveBeenCalled()
    f.blockers.items = []
    const next = await f.service.refresh()
    if (!next.ok || !next.planToken) throw new Error('Expected recovery ticket')
    f.revisions.environmentRevision = 99
    expect(await f.service.apply(next.planToken, true)).toMatchObject({ code: 'stale' })
    expect(f.ports.recoverAcceptedBinding).not.toHaveBeenCalled()
  })
  it('strips unknown probe fields including secrets from observations and tickets', async () => {
    const f = fixture()
    f.observed({ ...binding({ cli: '/opt/gh' }), token: 'ghp_secret', stderr: 'secret' } as AccountBinding)
    const result = await f.service.refresh()
    expect(JSON.stringify(result)).not.toContain('secret')
    if (!result.ok || !result.planToken) throw new Error('Expected ticket')
    await f.service.apply(result.planToken, true)
    expect(JSON.stringify(vi.mocked(f.ports.stageEnvironment).mock.calls)).not.toContain('secret')
  })
  it('reports network failure safely without a permanent health hold', async () => {
    const f = fixture()
    vi.mocked(f.ports.probe).mockRejectedValue(new Error('GH_TOKEN=secret'))
    expect(await f.service.refresh()).toEqual({ ok: false, status: 'unavailable', code: 'probe-failed' })
    expect(f.ports.healthHold).not.toHaveBeenCalled()
    expect(f.ports.commitAndActivate).not.toHaveBeenCalled()
  })
  it('holds only confirmed sign-out and returns a sanitized setup code', async () => {
    const f = fixture()
    vi.mocked(f.ports.probe).mockRejectedValue(new AccountProbeError('agentCliSignedOut', true))
    expect(await f.service.refresh()).toMatchObject({ ok: false, setupCode: 'agentCliSignedOut' })
    expect(f.ports.healthHold).toHaveBeenCalledWith('login-lost')
  })
  it('blocks different repository IDs with history but not canonical repository renames', async () => {
    const f = fixture()
    f.observed(binding({ repositoryId: '20' }))
    expect(await f.service.refresh()).toMatchObject({ status: 'changed', blockers: [{ code: 'repository-history' }] })
    const forbidden = await f.service.refresh()
    expect(forbidden.ok && forbidden.planToken).toBeUndefined()
    f.observed(binding({ repository: 'new/widgets' }))
    const renamed = await f.service.refresh()
    expect(renamed.ok && renamed.cursorPlan).toBe('preserve')
    expect(renamed.ok && renamed.planToken).toBeTruthy()
  })
  it('rejects a stale probe if source changes while GET is pending', async () => {
    const f = fixture()
    vi.mocked(f.ports.probe).mockImplementation(async () => { f.revisions.sourceRevision++; return binding() })
    expect(await f.service.refresh()).toMatchObject({ ok: false, code: 'stale' })
  })
})

describe('explicit maintenance application', () => {
  it('requires confirmation and consumes an opaque ticket exactly once', async () => {
    const f = fixture(), planToken = await token(f)
    expect(planToken).toMatch(/^[a-f0-9-]{36}$/)
    expect(await f.service.apply(planToken, false)).toMatchObject({ code: 'confirmation-required' })
    const results = await Promise.all([f.service.apply(planToken, true), f.service.apply(planToken, true)])
    expect(results[0]).toMatchObject({ ok: true, active: { accountId: '2' }, cursorPlan: { kind: 'cutover' } })
    expect(results[1]).toMatchObject({ code: 'invalid-token' })
    expect(f.ports.commitAndActivate).toHaveBeenCalledTimes(1)
    expect(f.ports.healthHold).toHaveBeenCalledWith('identity-drift')
  })
  it.each(['sourceRevision', 'bindingRevision', 'environmentRevision', 'runtimeInstance'] as const)('rejects changed %s', async key => {
    const f = fixture(), planToken = await token(f)
    if (key === 'runtimeInstance') f.revisions.runtimeInstance = 'runtime-2'
    else f.revisions[key] = 99
    expect(await f.service.apply(planToken, true)).toMatchObject({ code: 'stale' })
    expect(f.ports.stageEnvironment).not.toHaveBeenCalled()
  })
  it('rejects TTL expiration without activating', async () => {
    const f = fixture(), planToken = await token(f)
    f.advance()
    expect(await f.service.apply(planToken, true)).toMatchObject({ code: 'expired' })
    expect(f.ports.commitAndActivate).not.toHaveBeenCalled()
  })
  it('requires pause and honors all host blockers, even with no running workers', async () => {
    const f = fixture(), first = await token(f)
    f.blockers.paused = false
    expect(await f.service.apply(first, true)).toMatchObject({ code: 'pause-required' })
    f.blockers.paused = true
    f.blockers.items = [{ code: 'pending-outbox' }, { code: 'admission-inflight' }, { code: 'owner-jobs' }]
    expect(await f.service.apply(await token(f), true)).toMatchObject({ code: 'busy', blockers: f.blockers.items })
    expect(f.ports.commitAndActivate).not.toHaveBeenCalled()
  })
  it('preserves cursor for CLI/login metadata changes with identical IDs', async () => {
    const f = fixture()
    f.observed(binding({ cli: '/opt/gh', login: 'renamed', noreply: '1+renamed@users.noreply.github.com' }))
    const result = await f.service.refresh()
    if (!result.ok || !result.planToken) throw new Error('Expected ticket')
    expect(await f.service.apply(result.planToken, true)).toMatchObject({ ok: true, cursorPlan: { kind: 'preserve' } })
    expect(f.ports.healthHold).not.toHaveBeenCalled()
  })
  it('allows first accepted binding or a history-free new repository with a fresh cutoff', async () => {
    const f = fixture()
    f.active(null)
    const planToken = await token(f)
    expect(await f.service.apply(planToken, true)).toMatchObject({ ok: true, cursorPlan: { kind: 'cutover', cutoff: '2027-01-15T08:00:00.000Z' } })
  })
  it('rechecks inside maintenance and after staging', async () => {
    const f = fixture(), planToken = await token(f)
    vi.mocked(f.ports.stageEnvironment).mockImplementation(async candidate => { f.blockers.items = [{ code: 'reply-inflight' }]; return candidate })
    expect(await f.service.apply(planToken, true)).toMatchObject({ code: 'busy' })
    expect(f.ports.commitAndActivate).not.toHaveBeenCalled()
  })
  it('refuses external login drift between refresh and apply', async () => {
    const f = fixture(), planToken = await token(f)
    f.observed(binding({ accountId: '3' }))
    expect(await f.service.apply(planToken, true)).toMatchObject({ code: 'stale' })
    expect(f.ports.stageEnvironment).not.toHaveBeenCalled()
  })
  it('rejects identity drift during staging and cleans the abandoned stage', async () => {
    const f = fixture(), planToken = await token(f)
    vi.mocked(f.ports.stageEnvironment).mockImplementation(async candidate => { f.observed(binding({ accountId: '3' })); return candidate })
    expect(await f.service.apply(planToken, true)).toMatchObject({ code: 'stale' })
    expect(f.ports.commitAndActivate).not.toHaveBeenCalled()
    expect(f.ports.discardStage).toHaveBeenCalledTimes(1)
  })
  it('keeps the ticket immutable even when a service caller mutates its observation', async () => {
    const f = fixture()
    f.observed(binding({ accountId: '2' }))
    const result = await f.service.refresh()
    if (!result.ok || !result.planToken) throw new Error('Expected ticket')
    result.observed.accountId = 'injected'
    result.revisions.sourceRevision = 99
    expect(await f.service.apply(result.planToken, true)).toMatchObject({ ok: true, active: { accountId: '2' } })
  })
  it('reports normal applications and accurately preserves the host restart-pending receipt', async () => {
    const f = fixture(), planToken = await token(f)
    vi.mocked(f.ports.commitAndActivate).mockResolvedValue({ activation: 'restart-pending' })
    expect(await f.service.apply(planToken, true)).toMatchObject({ ok: true, action: 'applied', activation: 'restart-pending',
      cursorPlan: { kind: 'cutover' } })
    expect(f.ports.recoverAcceptedBinding).not.toHaveBeenCalled()
  })
  it('contains stage and activation errors without exposing subprocess output', async () => {
    const f = fixture()
    vi.mocked(f.ports.stageEnvironment).mockRejectedValueOnce(new Error('secret'))
    expect(await f.service.apply(await token(f), true)).toMatchObject({ code: 'stage-failed' })
    vi.mocked(f.ports.commitAndActivate).mockRejectedValueOnce(new Error('secret'))
    expect(await f.service.apply(await token(f), true)).toEqual({ ok: false, status: 'unavailable', code: 'activation-failed' })
  })
})
