/** Setup snapshot tests inject all guest/CLI ports; no actual WSL, login, network or profile access. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as deployment from '../src/deployment.ts'
import * as resolve from '../src/execution/resolve.ts'
import * as generation from '../src/execution/env-generation.ts'
import * as transport from '../src/infra/wsl.ts'
import * as hostPaths from '../src/execution/host-path.ts'
import { GUEST_IDENTITY_PROBE } from '../src/execution/probe.ts'
import { GUEST_PATH_FACTS } from '../src/execution/path-mapper.ts'
import { Setup, executionBindingTarget } from '../src/app/setup.ts'
import { commandEnvironment, environmentSnapshot, executionTargetId, freezeExecutionSnapshot, freezeTarget } from '../src/execution/target.ts'
import { SettingsSchema } from '../src/policy.ts'
import { testDeployment, testMachine } from './fixtures/deployment.ts'
vi.mock('../src/execution/resolve.ts', () => ({ resolveGuest: vi.fn() }))
vi.mock('../src/execution/env-generation.ts', () => ({ stageGuestGeneration: vi.fn(), discardGuestGeneration: vi.fn(async () => {}) }))
vi.mock('../src/infra/wsl.ts', async original => ({ ...await original<object>(), assertDefaultWslUser: vi.fn(async () => {}) }))
const identity = { distro: 'TestDistro', user: 'selected', uid: 1000, home: '/home/selected', bootId: 'owned-test-boot' }
const workspace = { input: '/work', guestPath: '/work', hostPath: '\\\\wsl.localhost\\TestDistro\\work', storage: 'guest-local' as const,
  evidence: { converter: 'wslpath' as const, hostRegistration: 'verified' as const, fileSystem: 'ext4' } }
const guest = { identity, workspace, deploymentWorkspace: workspace, path: '/usr/bin:/bin' }
const machine = testMachine({ stateDir: 'D:\\owned-test-state', wsl: { distro: identity.distro, user: identity.user, workRoot: '/work' } })
const settings = SettingsSchema.parse({ sources: { github: { enabled: true, config: { repository: 'acme/widgets', cli: 'gh' } } } })
function stage(id: string, revision: number) {
  const snapshot = freezeExecutionSnapshot(revision, freezeTarget(identity, workspace, id, '2026-10-01T00:00:00Z'), environmentSnapshot({ HOME: identity.home, GH_TOKEN: undefined, PATH: `/${id}/worker-bin:/usr/bin`, GIT_CONFIG_GLOBAL: `/${id}/worker-gitconfig` }))
  return { deployment: testDeployment({ ...machine, feishu: undefined }), snapshot, directory: `${identity.home}/${id}` }
}
beforeEach(() => {
  vi.mocked(resolve.resolveGuest).mockResolvedValue(guest)
  vi.spyOn(deployment, 'resolveDeployment').mockResolvedValue(testDeployment({ ...machine, feishu: undefined }))
  vi.spyOn(deployment, 'resolveFeishuBot').mockResolvedValue(undefined)
  vi.mocked(generation.stageGuestGeneration).mockImplementation(async () => stage('generation-one', 1))
})
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })
function fixture(verifiedExecution = true, accepted = true) {
  const commitStartup = vi.fn(), restart = vi.fn(), cleanup = vi.fn()
  const setup = new Setup({ context: { subprocess: {} } as never, machine, lifetime: new AbortController().signal,
    verifiedExecution, deploymentId: () => 'owned-deployment', environmentRevision: () => 4,
    acceptStartup: () => accepted, commitStartup, restart, onCleanupUnconfirmed: cleanup })
  return { setup, commitStartup, restart, cleanup }
}
describe('Setup execution snapshots', () => {
  it('observes accounts with readonly mapping and does not create a generation', async () => {
    const { setup, commitStartup } = fixture()
    const observed = await setup.observe(settings)
    expect(resolve.resolveGuest).toHaveBeenCalledWith(machine, '/work', expect.any(AbortSignal), false, expect.any(Function))
    expect(observed.binding).toMatchObject({ accountId: '7', repositoryId: '42', executionTarget: JSON.stringify([executionTargetId(identity), '/work', workspace.hostPath, identity.bootId, identity.home, identity.user, '/work', workspace.hostPath]) })
    expect(generation.stageGuestGeneration).not.toHaveBeenCalled(); expect(commitStartup).not.toHaveBeenCalled()
    expect(setup.currentExecutionSnapshot).toBeUndefined()
  })
  it('stages and verifies before committing and publishing one immutable snapshot', async () => {
    const { setup, commitStartup } = fixture()
    commitStartup.mockImplementation(() => { expect(setup.currentExecutionSnapshot).toBeUndefined() })
    expect(await setup.run(settings)).toBe(true)
    expect(resolve.resolveGuest).toHaveBeenCalledWith(machine, '/work', expect.any(AbortSignal), true, expect.any(Function))
    expect(generation.stageGuestGeneration).toHaveBeenCalledWith(expect.anything(), guest, 'owned-deployment', 5, [], expect.any(AbortSignal))
    const first = setup.currentExecutionSnapshot!
    expect(Object.isFrozen(first)).toBe(true)
    expect(setup.executionBinding).toEqual({ machine, snapshot: first, env: commandEnvironment(first.environment) })
    const before = setup.commandEnvironment
    const observed = await setup.observe(settings)
    vi.mocked(generation.stageGuestGeneration).mockResolvedValueOnce(stage('generation-two', 6))
    const prepared = await setup.stage(settings, observed.binding)
    expect(setup.currentExecutionSnapshot).toBe(first)
    setup.activate(prepared)
    expect(setup.currentExecutionSnapshot?.target.generationId).toBe('generation-two')
    expect(before.PATH).toBe('/generation-one/worker-bin:/usr/bin')
    expect(setup.commandEnvironment.PATH).toBe('/generation-two/worker-bin:/usr/bin')
    setup.commandEnvironment.PATH = 'a caller cannot mutate the active environment'
    expect(setup.commandEnvironment.PATH).toBe('/generation-two/worker-bin:/usr/bin')
  })
  it('publishes selected-user guest-native paths and keeps the master root separate from a Windows ticket alias', async () => {
    const ticketRoot = { ...workspace, input: 'Z:\\owned-ticket-alias', guestPath: '/data/tickets', hostPath: '\\\\wsl.localhost\\TestDistro\\data\\tickets' }
    const selected = { ...guest, workspace: ticketRoot, deploymentWorkspace: workspace }
    vi.mocked(resolve.resolveGuest).mockResolvedValue(selected)
    const directory = `${identity.home}/.local/state/dsh-superagent/owned-deployment/generations/owned-generation`
    const snapshot = freezeExecutionSnapshot(5, freezeTarget(identity, ticketRoot, 'owned-generation', '2026-10-01T00:00:00Z'),
      environmentSnapshot({ HOME: identity.home, GIT_CONFIG_GLOBAL: `${directory}/worker-gitconfig`, PATH: `${directory}/worker-bin:/usr/bin`, GH_TOKEN: undefined }),
      { deployment: workspace, tickets: ticketRoot })
    vi.mocked(generation.stageGuestGeneration).mockResolvedValue({ deployment: testDeployment({ ...machine, feishu: undefined }), snapshot, directory })
    const { setup } = fixture()
    // Supply the already-validated Windows Host value directly: this test runner itself uses POSIX isAbsolute().
    expect(await setup.run({ ...settings, executor: { ...settings.executor, directory: ticketRoot.input } })).toBe(true)
    expect(setup.currentExecutionSnapshot?.target).toMatchObject({ uid: 1000, user: 'selected', home: identity.home, workspace: { guestPath: '/data/tickets' } })
    expect(setup.currentExecutionSnapshot?.workspaces?.deployment.guestPath).toBe('/work')
    expect(setup.executionBinding?.env.GIT_CONFIG_GLOBAL).toBe(`${directory}/worker-gitconfig`)
    expect(setup.executionBinding?.env.GIT_CONFIG_GLOBAL).not.toContain('/mnt/')
    expect(transport.assertDefaultWslUser).not.toHaveBeenCalled()
  })
  it('does not stage or publish an unaccepted startup identity', async () => {
    const { setup, commitStartup } = fixture(true, false)
    expect(await setup.run(settings)).toBe(false)
    expect(setup.configured()).toBe(false)
    expect(setup.problem?.code).toBe('environmentFailed')
    expect(generation.stageGuestGeneration).not.toHaveBeenCalled(); expect(commitStartup).not.toHaveBeenCalled()
  })
  it('keeps the old snapshot on failed staging and cleans only abandoned stages', async () => {
    const { setup } = fixture()
    expect(await setup.run(settings)).toBe(true)
    const before = setup.currentExecutionSnapshot
    const observed = await setup.observe(settings)
    vi.mocked(generation.stageGuestGeneration).mockRejectedValueOnce(new Error('verification failed'))
    await expect(setup.stage(settings, observed.binding)).rejects.toThrow('verification failed')
    expect(setup.currentExecutionSnapshot).toBe(before)
    const active = { deployment: setup.deployment, env: setup.commandEnvironment, snapshot: before, guest: stage('generation-one', 1) }
    await setup.discard(active)
    expect(generation.discardGuestGeneration).not.toHaveBeenCalled()
  })
  it('keeps committed files on post-DB publication failure rather than pretending rollback', async () => {
    const { setup, commitStartup } = fixture()
    vi.spyOn(setup, 'activate').mockImplementationOnce(() => { throw new Error('publication failed') })
    expect(await setup.run(settings)).toBe(false)
    expect(commitStartup).toHaveBeenCalledOnce()
    expect(generation.discardGuestGeneration).not.toHaveBeenCalled()
    expect(setup.configured()).toBe(false)
  })
  it('waits for readonly observations during shutdown even though account health holds permit them', async () => {
    const { setup } = fixture()
    let finish!: (value: typeof guest) => void
    vi.mocked(resolve.resolveGuest).mockImplementationOnce(() => new Promise(ready => { finish = ready }))
    const observation = setup.observe(settings)
    let idleFinished = false
    const idle = setup.idle().then(() => { idleFinished = true })
    await Promise.resolve()
    expect(idleFinished).toBe(false)
    finish(guest)
    await observation; await idle
    expect(idleFinished).toBe(true)
  })
  it('reports only real transport cleanup-unconfirmed errors, without class-identity assumptions', async () => {
    const { setup, cleanup } = fixture()
    vi.mocked(resolve.resolveGuest).mockRejectedValueOnce(Object.assign(new Error('private diagnostics'), { code: 'WSL_CLEANUP_UNCONFIRMED' }))
    await expect(setup.observe(settings)).rejects.toThrow()
    expect(cleanup).toHaveBeenCalledOnce()
    vi.mocked(resolve.resolveGuest).mockRejectedValueOnce(Object.assign(new Error('ordinary permissions failure'), { code: 'EACCES' }))
    await expect(setup.observe(settings)).rejects.toThrow()
    expect(cleanup).toHaveBeenCalledOnce()
    await setup.idle()
  })
  it('retains the legacy default-user guard until snapshot capabilities are explicitly enabled', async () => {
    const { setup } = fixture(false)
    expect(await setup.run(settings)).toBe(false)
    expect(transport.assertDefaultWslUser).toHaveBeenCalled()
    expect(resolve.resolveGuest).not.toHaveBeenCalled()
    expect(generation.stageGuestGeneration).not.toHaveBeenCalled()
    expect(setup.configured()).toBe(false)
  })
})


function resolutionPorts(network = false) {
  const existing = new Set(['/', '/owned'])
  const host = vi.spyOn(hostPaths, 'probeHostPath').mockImplementation(async path => ({ path, exists: true, directory: true, locality: path.startsWith('D:') ? 'local' : 'unknown' }))
  const run = vi.spyOn(transport, 'runWsl').mockImplementation(async (_machine, request) => {
    const argv = request.argv
    if (argv[2] === GUEST_IDENTITY_PROBE) return JSON.stringify({ reportedDistro: identity.distro, user: identity.user, uid: identity.uid, home: identity.home, bootId: identity.bootId,
      tools: { python3: '/usr/bin/python3', sh: '/usr/bin/sh', bash: '/usr/bin/bash', git: '/opt/verified-git/bin/git', wslpath: '/usr/bin/wslpath', rg: '/usr/bin/rg' } })
    expect(request.expectedIdentity).toEqual(identity)
    if (argv[0] === 'mkdir') { existing.add(argv.at(-1)!); return '' }
    if (argv[2] === GUEST_PATH_FACTS) {
      const path = argv[3]!
      return JSON.stringify({ path, exists: existing.has(path), directory: existing.has(path), fileSystem: network ? 'nfs' : 'ext4', mountSource: '/dev/owned-test', device: '1', inode: path })
    }
    if (argv[0] === 'wslpath' && argv[2] === '-w') {
      const slash = String.fromCharCode(92)
      return network ? slash + slash + 'network-server' + slash + 'share' : slash + slash + 'wsl.localhost' + slash + identity.distro + argv[3]!.replaceAll('/', slash)
    }
    throw new Error('Unexpected fake resolution request')
  })
  return { host, run, existing }
}
describe('actual execution resolution adapter with fake readonly ports', () => {
  it('retains cleanup-unconfirmed evidence before a diagnostic adapter sanitizes the transport failure', async () => {
    const { resolveGuest: actual } = await vi.importActual<typeof import('../src/execution/resolve.ts')>('../src/execution/resolve.ts')
    const f = resolutionPorts(), report = vi.fn()
    const error = Object.assign(new Error('raw private transport diagnostics'), { code: 'WSL_CLEANUP_UNCONFIRMED' })
    f.run.mockRejectedValueOnce(error)
    await expect(actual(machine, '/work', new AbortController().signal, false, report)).rejects.toMatchObject({ code: 'TARGET_PROBE_FAILED' })
    expect(report).toHaveBeenCalledExactlyOnceWith(error)
    f.run.mockRejectedValueOnce(Object.assign(new Error('ordinary target failure'), { code: 'EACCES' }))
    await expect(actual(machine, '/work', new AbortController().signal, false, report)).rejects.toMatchObject({ code: 'TARGET_PROBE_FAILED' })
    expect(report).toHaveBeenCalledOnce()
  })
  it('never creates a prospective workspace during readonly refresh', async () => {
    const { resolveGuest: actual } = await vi.importActual<typeof import('../src/execution/resolve.ts')>('../src/execution/resolve.ts')
    const f = resolutionPorts()
    await expect(actual(machine, '/owned/new-root', new AbortController().signal)).rejects.toMatchObject({ code: 'WORKSPACE_MISSING' })
    expect(f.run.mock.calls.some(([, request]) => request.argv[0] === 'mkdir')).toBe(false)
    expect(f.existing.has('/owned/new-root')).toBe(false)
  })
  it('verifies the existing Host-registerable ancestor before explicit mkdir and pins the selected identity', async () => {
    const { resolveGuest: actual } = await vi.importActual<typeof import('../src/execution/resolve.ts')>('../src/execution/resolve.ts')
    const f = resolutionPorts()
    const value = await actual(machine, '/owned/new-root', new AbortController().signal, true)
    expect(value.identity).toEqual(identity)
    expect(value.workspace.guestPath).toBe('/owned/new-root')
    expect(value.workspace.evidence.hostRegistration).toBe('verified')
    expect(value.path.split(':')[0]).toBe('/opt/verified-git/bin')
    const mkdirOrder = f.run.mock.invocationCallOrder[f.run.mock.calls.findIndex(([, request]) => request.argv[0] === 'mkdir' && request.argv.at(-1) === '/owned/new-root')]!
    const parentHostOrder = f.host.mock.invocationCallOrder[f.host.mock.calls.findIndex(([path]) => path.endsWith('owned'))]!
    expect(parentHostOrder).toBeLessThan(mkdirOrder)
  })
  it('keeps the deployment/master root separate from a ticket override and fingerprints both', async () => {
    const { resolveGuest: actual } = await vi.importActual<typeof import('../src/execution/resolve.ts')>('../src/execution/resolve.ts')
    const f = resolutionPorts()
    f.existing.add('/owned/deployment'); f.existing.add('/owned/tickets')
    const selected = { ...machine, wsl: { ...machine.wsl!, workRoot: '/owned/deployment' } }
    const value = await actual(selected, '/owned/tickets', new AbortController().signal)
    expect(value.deploymentWorkspace.guestPath).toBe('/owned/deployment')
    expect(value.workspace.guestPath).toBe('/owned/tickets')
    const before = executionBindingTarget(value.identity, value.workspace, value.deploymentWorkspace)
    expect(executionBindingTarget(value.identity, value.workspace, { ...value.deploymentWorkspace, guestPath: '/another-deployment-root' })).not.toBe(before)
  })
  it('reuses mapping evidence when deployment and ticket roots are the same normalized path', async () => {
    const { resolveGuest: actual } = await vi.importActual<typeof import('../src/execution/resolve.ts')>('../src/execution/resolve.ts')
    const f = resolutionPorts()
    f.existing.add('/work')
    const value = await actual(machine, '/work/', new AbortController().signal)
    expect(value.deploymentWorkspace.guestPath).toBe('/work')
    expect(value.workspace.guestPath).toBe('/work')
    expect(f.run.mock.calls.filter(([, request]) => request.argv[0] === 'wslpath' && request.argv[2] === '-w' && request.argv[3] === '/work')).toHaveLength(1)
  })
  it('rejects a network or unsupported ancestor before creating any root', async () => {
    const { resolveGuest: actual } = await vi.importActual<typeof import('../src/execution/resolve.ts')>('../src/execution/resolve.ts')
    const f = resolutionPorts(true)
    await expect(actual(machine, '/owned/new-root', new AbortController().signal, true)).rejects.toMatchObject({ code: 'HOST_WORKSPACE_UNREGISTERABLE' })
    expect(f.run.mock.calls.some(([, request]) => request.argv[0] === 'mkdir')).toBe(false)
  })
})
