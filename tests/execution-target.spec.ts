/** Pure execution-world contracts and maintenance admission; no WSL/profile changes. */
import { describe, expect, it } from 'vitest'
import { commandEnvironment, environmentSnapshot, executionTargetId, freezeExecutionSnapshot, freezeTarget, validateRequestedTarget } from '../src/execution/target.ts'
import { MaintenanceGate } from '../src/execution/maintenance.ts'
import { SessionExecutionRegistry } from '../src/execution/registry.ts'
import { previewDeployment } from '../src/execution/preview.ts'
import { diagnoseGuest } from '../src/execution/probe.ts'

const identity = { distro: 'Example Distro', user: 'developer', uid: 1000, home: '/home/developer', bootId: 'boot-one' }
const workspace = { input: '/home/developer/work', guestPath: '/home/developer/work', hostPath: '\\\\wsl.localhost\\Example Distro\\home\\developer\\work',
  storage: 'guest-local' as const, evidence: { converter: 'wslpath' as const, hostRegistration: 'verified' as const, fileSystem: 'ext4' } }
const target = () => freezeTarget(identity, workspace, 'generation-one', 'checked')
const record = () => ({ sessionId: 'managed', role: 'worker' as const, guestCwd: '/home/developer/work/ticket',
  hostCwd: '\\\\wsl.localhost\\Example Distro\\home\\developer\\work\\ticket', snapshot: freezeExecutionSnapshot(1, target(), environmentSnapshot({ PATH: '/usr/bin', GH_TOKEN: undefined })) })

describe('execution targets', () => {
  it('uses actual distro/UID identity, supports registered names with spaces and freezes copied data', () => {
    expect(validateRequestedTarget({ distro: 'Example Distro', user: 'developer', workRoot: 'D:\\code' }).distro).toBe('Example Distro')
    expect(() => validateRequestedTarget({ distro: '--bad', user: 'developer', workRoot: '/work' })).toThrow()
    const frozen = target()
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(frozen.workspace.evidence)).toBe(true)
    expect(executionTargetId({ distro: 'EXAMPLE DISTRO', uid: 1000 })).toBe(frozen.id)
    expect(executionTargetId({ distro: identity.distro, uid: 1001 })).not.toBe(frozen.id)
  })
  it('retains explicit unset semantics across JSON while refusing persisted credentials', () => {
    const snapshot = environmentSnapshot({ PATH: '/guest/bin', GH_TOKEN: undefined, GIT_DIR: undefined })
    expect(commandEnvironment(JSON.parse(JSON.stringify(snapshot)))).toEqual({ PATH: '/guest/bin', GH_TOKEN: undefined, GIT_DIR: undefined })
    expect(() => environmentSnapshot({ GH_TOKEN: 'must-not-persist' })).toThrow(/Credentials/)
    expect(() => environmentSnapshot({ 'X;exec': 'bad' })).toThrow(/Invalid/)
  })
  it('does not accept a forged persisted target identity', () => {
    expect(() => freezeExecutionSnapshot(1, { ...target(), id: 'forged' }, environmentSnapshot({}))).toThrow(/identity/)
  })
})

describe('trusted Session records', () => {
  it('does not let an old disposer remove a newer binding or retarget an existing Session', async () => {
    const registry = new SessionExecutionRegistry()
    const old = registry.register(record()), next = registry.register(record())
    old()
    expect((await registry.lookup('managed')).kind).toBe('managed')
    expect(() => registry.register({ ...record(), guestCwd: '/other' })).toThrow(/new Session/)
    next()
    expect((await registry.lookup('managed')).kind).toBe('unmanaged')
  })
  it('loads cold metadata without activation and refuses missing or stale managed targets', async () => {
    let current = true
    const registry = new SessionExecutionRegistry({ load: id => id === 'managed' ? record() : undefined,
      isManagedSession: id => id !== 'ordinary', isCurrent: () => current })
    expect((await registry.lookup('managed')).kind).toBe('managed')
    current = false
    expect(await registry.lookup('managed')).toEqual({ kind: 'blocked', code: 'SESSION_BINDING_STALE' })
    expect(await registry.lookup('missing')).toEqual({ kind: 'blocked', code: 'SESSION_BINDING_MISSING' })
    expect(await registry.lookup('ordinary')).toEqual({ kind: 'unmanaged' })
  })
})

describe('maintenance gate', () => {
  it('keeps in-flight work visible, rejects new admission and owns health holds exactly', () => {
    const gate = new MaintenanceGate(), done = gate.admit('job', 'owned-job')
    const old = gate.hold('identity', { code: 'identity-drift' })
    const fresh = gate.hold('identity', { code: 'login-lost' })
    old()
    expect(() => gate.admit('turn')).toThrow()
    expect(gate.activityBlockers()).toEqual([{ code: 'activity-job', detail: 'owned-job' }])
    expect(gate.blockers()).toEqual([{ code: 'login-lost' }])
    done(); fresh()
    expect(gate.snapshot()).toEqual({ blocked: [], activities: [] })
  })
  it('serializes applications and releases after failures without cancelling work', async () => {
    const gate = new MaintenanceGate(), events: string[] = []
    let release!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    const first = gate.exclusive('first', async () => { events.push('first'); expect(() => gate.admit('turn')).toThrow(); await wait; throw new Error('expected') })
    const second = gate.exclusive('second', async () => { events.push('second'); return 2 })
    await Promise.resolve(); release()
    await expect(first).rejects.toThrow('expected')
    await expect(second).resolves.toBe(2)
    expect(events).toEqual(['first', 'second'])
    expect(gate.blockers()).toEqual([])
  })
  it('waits for activity settlement but not persistent health holds', async () => {
    const gate = new MaintenanceGate(), release = gate.admit('source', 'late-read')
    gate.hold('health', { code: 'repair-required' })
    let settled = false
    const idle = gate.idle().then(() => { settled = true })
    await Promise.resolve(); expect(settled).toBe(false)
    release(); await idle
    expect(settled).toBe(true); expect(gate.blockers()).toEqual([{ code: 'repair-required' }])
  })
  it('serializes ordinary metadata without closing admission, while queued identity maintenance still closes it', async () => {
    const gate = new MaintenanceGate()
    let release!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    const ordinary = gate.serialize('policy-sync', async () => { await wait })
    const finishRead = gate.admit('source'); finishRead()
    expect(gate.blockers()).toEqual([])
    const identity = gate.exclusive('account-apply', async () => {})
    expect(() => gate.admit('source')).toThrow()
    release(); await ordinary; await identity; await gate.idle()
    expect(gate.blockers()).toEqual([])
  })
  it('closes admission synchronously and waits for queued applications too', async () => {
    const gate = new MaintenanceGate()
    let release!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    const application = gate.exclusive('pending', async () => { await wait })
    expect(() => gate.admit('effect')).toThrow()
    let idle = false
    const joined = gate.idle().then(() => { idle = true })
    await Promise.resolve(); expect(idle).toBe(false)
    release(); await application; await joined
    expect(idle).toBe(true)
  })
})

describe('static deployment preview', () => {
  it('allows user/drive candidates but never claims diagnostic readiness or executes prepare', () => {
    const result = previewDeployment({ stateDir: 'C:\\state', wsl: { distro: identity.distro, user: 'other-user', workRoot: 'D:\\project' },
      executor: { directory: '', prepare: 'echo secret-is-not-echoed-here' } })
    expect(result.valid).toBe(true)
    expect(result.ready).toBe(false)
    expect(result.paths.workspaceKind).toBe('windows-drive')
    expect(result.requiredChecks).toContain('guest-identity')
    expect(JSON.stringify(result)).not.toContain('secret-is-not-echoed-here')
  })
  it('rejects network state, another distro and unrecognized credential fields', () => {
    const wrong = previewDeployment({ stateDir: '\\\\server\\share', wsl: { distro: identity.distro, user: identity.user, workRoot: '/work' } })
    expect(wrong.valid).toBe(false)
    expect(wrong.blockers.some(item => item.code === 'HOST_STATE_NOT_LOCAL_DRIVE')).toBe(true)
    const cross = previewDeployment({ stateDir: 'C:\\state', wsl: { distro: identity.distro, user: identity.user, workRoot: '/work' },
      executor: { directory: '\\\\wsl.localhost\\Other\\work' } })
    expect(cross.blockers.some(item => item.code === 'PATH_WRONG_DISTRO')).toBe(true)
    expect(previewDeployment({ stateDir: 'C:\\state', wsl: false, token: 'must-not-echo' }).valid).toBe(false)
  })
})

describe('explicit guest diagnostics', () => {
  const requested = { distro: identity.distro, user: identity.user, workRoot: workspace.guestPath }
  const response = { reportedDistro: identity.distro, user: identity.user, uid: identity.uid,
    home: identity.home, bootId: identity.bootId, tools: { python3: '/usr/bin/python3', sh: '/usr/bin/sh', bash: '/usr/bin/bash', git: '/windows/c/git.exe', wslpath: '/init', rg: null } }
  it('records the selected UID and refuses Windows executables as guest tools', async () => {
    const result = await diagnoseGuest(requested, async () => JSON.stringify(response), new AbortController().signal)
    expect(result.identity.uid).toBe(1000)
    expect(result.missing).toEqual(['git', 'rg'])
    expect(result.tools.git).toBeNull()
  })
  it('does not accept another distro or user and does not expose arbitrary probe output', async () => {
    const signal = new AbortController().signal
    await expect(diagnoseGuest(requested, async () => JSON.stringify({ ...response, user: 'default-user' }), signal)).rejects.toMatchObject({ code: 'TARGET_USER_MISMATCH' })
    await expect(diagnoseGuest(requested, async () => JSON.stringify({ ...response, reportedDistro: 'Other' }), signal)).rejects.toMatchObject({ code: 'TARGET_DISTRO_MISMATCH' })
    await expect(diagnoseGuest(requested, async () => { throw new Error('sensitive-details-must-not-echo') }, signal)).rejects.toThrow('could not be verified')
  })
})
