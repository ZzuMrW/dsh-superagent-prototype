import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, writeFile, rm, stat, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createExecutionRuntime, TEMP_WRITE_CLEANUP, TEMP_WRITE_PROBE, type ExecutionDiagnosticAdapters, type ExecutionRuntimePorts } from '../src/app/execution-runtime.ts'
import { previewDeployment } from '../src/execution/preview.ts'
import { GUEST_IDENTITY_PROBE } from '../src/execution/probe.ts'
import type { DeploymentCandidate } from '../src/app/execution-api.ts'
import type { Machine } from '../src/deployment.ts'
import type { Settings } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'

const candidate: DeploymentCandidate = { stateDir: 'C:\\state', wsl: { distro: 'Ubuntu', user: 'agent', workRoot: '/work' }, executor: { directory: '/tickets', prepare: 'must-never-run', blockedCommands: ['gh'] } }
const identity = { distro: 'Ubuntu', reportedDistro: 'Ubuntu', user: 'agent', uid: 1000, home: '/home/agent', bootId: 'boot' }
const workspace = { input: '/tickets', guestPath: '/tickets', hostPath: '\\\\wsl.localhost\\Ubuntu\\tickets', storage: 'guest-local' as const, evidence: { converter: 'wslpath' as const, hostRegistration: 'verified' as const, fileSystem: 'ext4' } }
const saved = { sources: { github: { config: { repository: 'acme/repo', cli: '/usr/bin/gh' } } } } as unknown as Settings
let controller: AbortController, ports: ExecutionRuntimePorts, io: ExecutionDiagnosticAdapters
beforeEach(() => {
  controller = new AbortController()
  ports = { machine: { stateDir: 'C:\\old' } as Machine, savedSettings: vi.fn(() => saved), lifetime: controller.signal,
    track: vi.fn(work => work()), onCleanupUnconfirmed: vi.fn(), withWriteProbe: vi.fn(work => work()) }
  io = { platform: 'win32', host: vi.fn(async () => ({ path: 'C:\\state', exists: true, directory: true, locality: 'local' as const })),
    resolve: vi.fn(async () => ({ identity, workspace, deploymentWorkspace: { ...workspace, input: '/work', guestPath: '/work' }, path: '/usr/bin' })),
    run: vi.fn(async (_machine, request) => request.argv[2] === GUEST_IDENTITY_PROBE ? JSON.stringify({ ...identity, distro: undefined,
      tools: Object.fromEntries(['python3', 'sh', 'bash', 'git', 'wslpath', 'rg'].map(name => [name, '/usr/bin/' + name])) }) : request.argv[2] === TEMP_WRITE_PROBE || request.argv[2] === TEMP_WRITE_CLEANUP ? ''
      : JSON.stringify({ path: '/tickets', exists: true, directory: true, fileSystem: 'ext4', mountSource: '/dev/sda', device: '1', inode: '2' })),
    account: vi.fn(async () => ({ repository: 'acme/repo', github: { login: 'bot' } }) as never) }
})
describe('static preview boundary', () => {
  it('is pure, never prepares or declares ready and strictly rejects volatile/unknown fields', () => {
    const service = createExecutionRuntime(ports, io)
    expect(service.preview(candidate)).toMatchObject({ kind: 'static', valid: true, ready: false, prepare: { configured: true } })
    expect(service.preview({ ...candidate, promptMaxChars: { get() { throw Error('volatile read') } } })).toMatchObject({ valid: false, ready: false })
    expect(service.preview({ ...candidate, executor: { ...candidate.executor, model: null } })).toMatchObject({ valid: false })
    expect(ports.track).not.toHaveBeenCalled()
    for (const adapter of [io.host, io.run, io.resolve, io.account, ports.savedSettings]) expect(adapter).not.toHaveBeenCalled()
  })
  it('keeps native static available without claiming platform-wide diagnosis', async () => {
    const service = createExecutionRuntime(ports, { ...io, platform: 'linux' })
    expect(service.preview({ stateDir: '/tmp/state', wsl: false }).valid).toBe(true)
    expect(await service.diagnose({ candidate })).toMatchObject({ ready: false, status: 'blocked', checks: [{ code: 'DIAGNOSIS_UNSUPPORTED' }] })
    expect(io.run).not.toHaveBeenCalled()
  })
})
describe('explicit diagnosis boundaries', () => {
  it('defaults to business-read-only, passes prepare=false and never touches settings, environment or accounts', async () => {
    const env = { ...process.env }, before = JSON.stringify(saved)
    const result = await createExecutionRuntime(ports, io).diagnose({ candidate })
    expect(result).toMatchObject({ kind: 'diagnosis', status: 'local-verified', ready: false, restart: 'not-applied', workspace, mount: { fileSystem: 'ext4' } })
    expect(io.resolve).toHaveBeenCalledWith(expect.objectContaining({ stateDir: 'C:\\state', wsl: candidate.wsl }), '/tickets', expect.any(AbortSignal), false, expect.any(Function))
    expect(io.account).not.toHaveBeenCalled(); expect(ports.savedSettings).not.toHaveBeenCalled(); expect(ports.withWriteProbe).not.toHaveBeenCalled()
    expect(JSON.stringify(saved)).toBe(before); expect(process.env).toEqual(env)
    expect(ports.track).toHaveBeenCalledTimes(1)
    const argv = vi.mocked(io.run).mock.calls.map(([, request]) => request.argv)
    expect(argv.flat().join(' ')).not.toMatch(/must-never-run|mkdir|gitconfig|shim|notify|login/)
    expect(result.effects).toContain('transport-may-write-temporary-cancellation-state')
  })
  it('requires strict boolean opt-ins and rejects an entire ConfigForm object', async () => {
    for (const input of [{ candidate, network: 'true' }, { candidate, confirmWrite: 1 }, { candidate, unknown: true }, { candidate: { ...candidate, volatile: true } }]) {
      await expect(createExecutionRuntime(ports, io).diagnose(input)).rejects.toThrow()
    }
    expect(io.run).not.toHaveBeenCalled()
  })
  it('returns accurate missing-root evidence without creating or staging it', async () => {
    vi.mocked(io.resolve).mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'WORKSPACE_MISSING' }))
    const result = await createExecutionRuntime(ports, io).diagnose({ candidate, network: true, confirmWrite: true })
    expect(result).toMatchObject({ ready: false, status: 'blocked' })
    expect(result.checks.find(item => item.code === 'WORKSPACE_MISSING')?.detail).toContain('尚未创建')
    expect(io.account).not.toHaveBeenCalled(); expect(ports.withWriteProbe).not.toHaveBeenCalled(); expect(ports.onCleanupUnconfirmed).not.toHaveBeenCalled()
  })
  it('blocks identity drift and Windows-backed tools before claiming local verification', async () => {
    vi.mocked(io.resolve).mockResolvedValueOnce({ identity: { ...identity, bootId: 'new-boot' }, workspace, deploymentWorkspace: workspace, path: '/usr/bin' })
    const drift = await createExecutionRuntime(ports, io).diagnose({ candidate, network: true })
    expect(drift.status).toBe('blocked')
    expect(drift.checks.some(item => item.code === 'TARGET_IDENTITY_CHANGED')).toBe(true)
    expect(io.account).not.toHaveBeenCalled()
    vi.mocked(io.run).mockResolvedValueOnce(JSON.stringify({ ...identity, distro: undefined, tools: { git: '/mnt/c/git.exe' } }))
    const tools = await createExecutionRuntime(ports, io).diagnose({ candidate })
    expect(tools.status).toBe('blocked')
    expect(tools.checks.some(item => item.code === 'TARGET_TOOLS_MISSING')).toBe(true)
  })
  it('uses only saved source configuration for explicitly requested account GETs', async () => {
    vi.mocked(io.account).mockImplementationOnce(async (_machine, config, probe) => {
      expect(config).toEqual(saved.sources.github!.config)
      await probe(['/usr/bin/gh', 'api', 'user'])
      await probe(['/usr/bin/gh', 'api', 'repos/acme/repo', '--jq', '{id:.id}'])
      return { repository: 'acme/repo', github: { login: 'bot' } } as never
    })
    expect(await createExecutionRuntime(ports, io).diagnose({ candidate, network: true })).toMatchObject({ status: 'account-verified', ready: true, network: { login: 'bot' } })
    expect(vi.mocked(io.run).mock.calls.at(-1)![1].env).toMatchObject({ HOME: '/home/agent', GH_PROMPT_DISABLED: '1', GH_TOKEN: undefined, GH_CONFIG_DIR: undefined })
  })
  it('refuses mutating or arbitrary API calls even from the resolver', async () => {
    vi.mocked(io.account).mockImplementationOnce(async (_machine, _config, probe) => { await probe(['/usr/bin/gh', 'api', 'user', '-X', 'POST']); throw Error('unreachable') })
    const result = await createExecutionRuntime(ports, io).diagnose({ candidate, network: true })
    expect(result.ready).toBe(false)
    expect(result.checks.some(item => item.detail.includes('Only fixed GitHub GET'))).toBe(true)
    expect(vi.mocked(io.run).mock.calls.some(([, request]) => request.argv.includes('POST'))).toBe(false)
  })
  it('tracks cleanup to completion, runs temporary probes only with consent and always cleans on failure', async () => {
    vi.mocked(io.run).mockImplementation(async (_machine, request) => {
      if (request.argv[2] === GUEST_IDENTITY_PROBE) return JSON.stringify({ ...identity, distro: undefined, tools: Object.fromEntries(['python3','sh','bash','git','wslpath','rg'].map(name => [name, '/usr/bin/'+name])) })
      if (request.argv[2] === TEMP_WRITE_PROBE) { controller.abort(); throw Error('permission denied') }
      if (request.argv[2] === TEMP_WRITE_CLEANUP) { expect(request.signal.aborted).toBe(false); return '' }
      return JSON.stringify({ path: '/tickets', exists: true, directory: true, fileSystem: 'ext4', mountSource: '/dev/sda', device: '1', inode: '2' })
    })
    const result = await createExecutionRuntime(ports, io).diagnose({ candidate, confirmWrite: true })
    expect(result.ready).toBe(false); expect(ports.withWriteProbe).toHaveBeenCalledTimes(1)
    const calls = vi.mocked(io.run).mock.calls.map(([, request]) => request.argv)
    expect(calls.at(-1)?.[2]).toBe(TEMP_WRITE_CLEANUP)
    expect(calls.at(-1)?.[3]).toMatch(/^\/tickets\/\.dsh-deployment-probe-[a-f0-9-]+$/)
    expect(calls.at(-1)?.slice(5)).toEqual(['/tickets', '1', '2'])
    expect(calls.at(-1)?.slice(3)).toEqual(calls.at(-2)?.slice(3))
    expect(ports.onCleanupUnconfirmed).not.toHaveBeenCalled()
  })
  it('reports unconfirmed owned-probe cleanup without promoting ordinary permission errors to permanent markers', async () => {
    const execute = vi.mocked(io.run).getMockImplementation()!
    vi.mocked(io.run).mockImplementation(async (machine, request) => {
      if (request.argv[2] === TEMP_WRITE_CLEANUP) throw Object.assign(new Error('raw secret stderr'), { code: 'EACCES' })
      return execute(machine, request)
    })
    const result = await createExecutionRuntime(ports, io).diagnose({ candidate, confirmWrite: true })
    expect(result).toMatchObject({ status: 'blocked', ready: false, writeProbe: { cleanup: 'unconfirmed', bytes: 4096 } })
    expect(result.checks.some(check => check.code === 'WRITE_PROBE_CLEANUP_FAILED')).toBe(true)
    expect(ports.onCleanupUnconfirmed).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('raw secret stderr')
  })
  it('does not admit diagnostics after shutdown and marks only exact cleanup uncertainty', async () => {
    controller.abort()
    expect(() => createExecutionRuntime(ports, io).diagnose({ candidate })).toThrow()
    expect(ports.track).not.toHaveBeenCalled()
    controller = new AbortController(); ports.lifetime = controller.signal
    vi.mocked(io.host).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
    await createExecutionRuntime(ports, io).diagnose({ candidate })
    expect(ports.onCleanupUnconfirmed).not.toHaveBeenCalled()
    const error = Object.assign(new Error('uncertain'), { code: 'WSL_CLEANUP_UNCONFIRMED' })
    vi.mocked(io.run).mockRejectedValueOnce(error)
    await createExecutionRuntime(ports, io).diagnose({ candidate })
    expect(ports.onCleanupUnconfirmed).toHaveBeenCalledWith(error)
  })
  it('redacts raw CLI output, arbitrary error messages/codes and preserves safe permission/account blockers', async () => {
    const secret = 'ghp_TOP_SECRET_AUTHORIZATION_123456789'
    vi.mocked(io.account).mockRejectedValueOnce(new SetupError('agentCliSignedOut', { output: `Authorization: Bearer ${secret}` }))
    const account = await createExecutionRuntime(ports, io).diagnose({ candidate, network: true })
    expect(account.checks.some(check => check.code === 'agentCliSignedOut')).toBe(true)
    expect(JSON.stringify(account)).not.toContain(secret)
    vi.mocked(io.host).mockRejectedValueOnce(Object.assign(new Error(secret.repeat(1000)), { code: secret }))
    const untrusted = await createExecutionRuntime(ports, io).diagnose({ candidate })
    expect(JSON.stringify(untrusted)).not.toContain(secret)
    expect(untrusted.checks.find(check => check.status === 'blocked')?.detail.length).toBeLessThan(501)
    vi.mocked(io.host).mockRejectedValueOnce(Object.assign(new Error(secret), { code: 'EACCES' }))
    const denied = await createExecutionRuntime(ports, io).diagnose({ candidate })
    expect(denied.checks.some(check => check.code === 'EACCES' && check.detail.includes('Permission denied'))).toBe(true)
    expect(JSON.stringify(denied)).not.toContain(secret)
    expect(ports.onCleanupUnconfirmed).not.toHaveBeenCalled()
  })
  it('fails a requested write probe closed without a gated port', async () => {
    delete ports.withWriteProbe
    const result = await createExecutionRuntime(ports, io).diagnose({ candidate, confirmWrite: true })
    expect(result.checks.some(item => item.code === 'WRITE_PROBE_UNAVAILABLE')).toBe(true)
    expect(result.status).toBe('blocked')
  })
})

it('owned workspace probe cleans itself and refuses foreign nonce, symlinks, wrong roots and changed parent identity', async () => {
  const exec = promisify(execFile), parent = await mkdtemp(join(tmpdir(), 'candidate-workspace-'))
  const nonce = randomUUID(), root = join(parent, `.dsh-deployment-probe-${nonce}`), info = await stat(parent)
  const args = [root, nonce, parent, String(info.dev), String(info.ino)]
  try {
    await writeFile(join(parent, 'business'), 'untouched')
    await exec('python3', ['-c', TEMP_WRITE_PROBE, ...args])
    await exec('python3', ['-c', TEMP_WRITE_CLEANUP, ...args]) // absent is clean
    expect(await readdir(parent)).toEqual(['business'])
    await expect(exec('python3', ['-c', TEMP_WRITE_PROBE, ...args.slice(0, 4), 'wrong-inode'])).rejects.toThrow()
    expect(await readdir(parent)).toEqual(['business'])
    await mkdir(root, { mode: 0o700 })
    await writeFile(join(root, 'owner'), 'foreign-nonce')
    await writeFile(join(root, 'probe'), 'business-owned')
    await expect(exec('python3', ['-c', TEMP_WRITE_CLEANUP, ...args])).rejects.toThrow()
    expect(await readFile(join(root, 'probe'), 'utf8')).toBe('business-owned')
    await rm(root, { recursive: true, force: true })
    await symlink(parent, root, 'dir')
    await expect(exec('python3', ['-c', TEMP_WRITE_CLEANUP, ...args])).rejects.toThrow()
    await expect(exec('python3', ['-c', TEMP_WRITE_CLEANUP, parent, nonce, parent, String(info.dev), String(info.ino)])).rejects.toThrow()
    expect(await readFile(join(parent, 'business'), 'utf8')).toBe('untouched')
  } finally { await rm(parent, { recursive: true, force: true }) }
})
