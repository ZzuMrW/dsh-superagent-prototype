import { Context } from '@deepseek-ai/cordis'
import SessionFileReferences, { GUEST_FILE_REFERENCES } from '../src/file-references.ts'
import { LocalFileReferenceService } from '@deepseek-ai/dsh-file-reference-local'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceFiles as CoreWorkspaceFiles } from '@deepseek-ai/dsh-api-workspace-files'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionExecutionRegistry } from '../src/execution/registry.ts'
import { freezeTarget, freezeExecutionSnapshot, environmentSnapshot } from '../src/execution/target.ts'
import SessionWorkspaceFiles, { configureWorkspaceSessionRegistry } from '../src/workspace-files.ts'
import { configureGuestFsResolver } from '../src/wsl-fs.ts'

it('selected-user file-reference discovery preserves bounded ranking and never traverses symlink escapes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'file-reference-world-')), root = join(dir, 'project')
  try {
    await mkdir(join(root, 'nested'), { recursive: true }); await mkdir(join(dir, 'outside'))
    await writeFile(join(root, 'nested', 'deep.md'), 'not read by discovery'); await writeFile(join(root, '.hidden'), 'hidden')
    await writeFile(join(dir, 'outside', 'never-offer-secret'), 'secret')
    await symlink(join(dir, 'outside'), join(root, 'escape'))
    const list = async (query: string) => {
      const child = spawn('python3', ['-c', GUEST_FILE_REFERENCES], { stdio: ['pipe', 'pipe', 'pipe'] })
      let output = '', error = ''
      const result = new Promise<string>((resolve, reject) => {
        child.stdout.on('data', data => output += data); child.stderr.on('data', data => error += data)
        child.on('error', reject); child.on('close', code => code === 0 ? resolve(output) : reject(new Error(error)))
      })
      child.stdin.end(JSON.stringify({ root, query, excluded: ['.git'], maxEntries: 100, maxResults: 20 }))
      return JSON.parse(await result)
    }
    expect(await list('')).toEqual([{ path: 'nested', kind: 'directory' }])
    expect(await list('deep')).toEqual([{ path: 'nested/deep.md', kind: 'file' }])
    expect(await list('nested/')).toEqual([{ path: 'nested/deep.md', kind: 'file' }])
    expect(await list('escape/')).toEqual([])
    expect(await list('../outside/')).toEqual([])
    expect(await list('.hidden')).toEqual([{ path: '.hidden', kind: 'file' }])
  } finally { if (dir.startsWith(join(tmpdir(), 'file-reference-world-'))) await rm(dir, { recursive: true, force: true }) }
})

const disposers: (() => void)[] = []
afterEach(() => { for (const dispose of disposers.splice(0)) dispose() })
const scope = (id: string) => ({ sessionId: id as SessionId, workspaceRoot: 'C:\\host-user\\project' })
const signal = () => new AbortController().signal
const config = { maxBytes: 64, maxFileBytes: 128, maxLines: 10, maxEntries: 10,
  search: { maxResults: 10, maxEntries: 100, graceMs: 100, timeoutMs: 1000, stderrMaxBytes: 4096 } }
function setup() {
  const ctx = new Context(), host = { resolve: vi.fn(async () => ({ targetKey: FsTargetKey('host'), displayPath: 'host' })),
    lstat: vi.fn(async () => ({ type: 'file' })), stat: vi.fn(async () => ({ type: 'file', version: FsVersion('host-v'), size: 4 })),
    processPath: () => 'host', streamText: async () => (async function* () { yield 'host' })() }
  ctx.provide('fs', host)
  const registry = new SessionExecutionRegistry({ load: () => undefined, isManagedSession: id => id.startsWith('managed') })
  const target = freezeTarget({ distro: 'Ubuntu', user: 'worker', uid: 1000, home: '/home/worker', bootId: 'boot' },
    { input: '/project', guestPath: '/project', hostPath: '\\\\wsl.localhost\\Ubuntu\\project', storage: 'guest-local', evidence: { converter: 'wslpath', hostRegistration: 'verified' } }, 'generation', '')
  registry.register({ sessionId: 'managed', role: 'worker', guestCwd: '/project/ticket', hostCwd: '\\\\wsl.localhost\\Ubuntu\\project\\ticket',
    snapshot: freezeExecutionSnapshot(1, target, environmentSnapshot({})) })
  disposers.push(configureWorkspaceSessionRegistry(registry))
  const calls: object[] = []
  disposers.push(configureGuestFsResolver(id => id === 'managed' ? { identity: 'uid1000', cwd: '/project/ticket',
    transport: async (_script, payload) => {
      const request = JSON.parse(payload); calls.push(request)
      let value: unknown
      if (request.op === 'resolve') value = request.path
      else if (request.op === 'lstat' || request.op === 'stat') value = { type: request.path === '/project/ticket' ? 'directory' : 'file', version: 'guest-v', size: 5 }
      else if (request.op === 'range' || request.op === 'bytes') value = { data: request.op === 'bytes' || request.offset === 0 ? Buffer.from('guest').toString('base64') : '', version: 'guest-v' }
      else if (request.op === 'list') value = [{ name: 'file.txt', type: 'file', path: '/project/ticket/file.txt', size: 5 }]
      else throw new Error('Unexpected RPC')
      return JSON.stringify({ ok: true, value })
    } } : undefined))
  new SessionWorkspaceFiles(ctx, config)
  // Exercise the real public SDK traceable wrapper, not a raw constructed Service instance.
  return { files: ctx.get('workspaceFiles') as SessionWorkspaceFiles, host, calls, ctx }
}

describe('public WorkspaceFiles Session routing', () => {
  it('while Runtime is inert, delegates only metadata-proven native lineage and blocks cold WSL descendants', async () => {
    const { files, host, ctx } = setup()
    for (const dispose of disposers.splice(0)) dispose()
    const stat = vi.fn(async (id: string) => ({ header: id === 'ordinary' ? { agentPreset: 'standard' }
      : id === 'child' ? { agentPreset: 'standard', parentSession: 'managed-parent' }
      : { agentPreset: 'wsl-dsh-superagent-worker' } }))
    ctx.provide('sessionPersistence', { stat })
    expect((await files.read(scope('ordinary'), 'file', {}, signal())).text).toBe('host')
    host.resolve.mockClear()
    await expect(files.read(scope('child'), 'secret', {}, signal())).rejects.toThrow('unavailable or stale')
    expect(host.resolve).not.toHaveBeenCalled()
    expect(stat.mock.calls.map(call => call[0])).toEqual(['ordinary', 'child', 'managed-parent'])
  })
  it('with an unconfigured owner, requires trusted native lineage before every UI and FileRefs Host branch', async () => {
    const { files, host, calls, ctx } = setup()
    // Mirrors setup-not-yet-configured: the owner exists but has neither an execution record nor active WSL classification.
    disposers.push(configureWorkspaceSessionRegistry(new SessionExecutionRegistry({ load: () => undefined, isManagedSession: () => false })))
    const headers: Record<string, { agentPreset: string; parentSession?: string }> = {
      'manual-worker': { agentPreset: 'wsl-dsh-superagent-worker' },
      'known-master': { agentPreset: 'wsl-dsh-superagent-router' },
      'cold-descendant': { agentPreset: 'standard', parentSession: 'manual-worker' },
      'ordinary': { agentPreset: 'standard' },
    }
    const stat = vi.fn(async (id: string) => headers[id] ? { header: headers[id] } : undefined)
    ctx.provide('sessionPersistence', { stat })
    ctx.provide('agents', { list: () => [] })
    const refs = new SessionFileReferences(ctx)
    const nativeRefs = vi.spyOn(LocalFileReferenceService.prototype, 'list').mockResolvedValue([{ path: 'native-result', kind: 'file' }])
    try {
      for (const id of ['manual-worker', 'known-master', 'cold-descendant', 'missing-cold-record']) {
        const selected = scope(id)
        for (const request of [
          () => files.read(selected, 'secret', {}, signal()),
          () => files.stat(selected, 'secret', signal()),
          () => files.list(selected, '.', signal()),
          () => files.search(selected, { query: 'secret', excludedPaths: [], includeHidden: false, respectGitignore: true }, signal()),
          () => files.readBytes(selected, 'secret', {}, signal()),
          () => files.changes(selected, '.', signal())[Symbol.asyncIterator]().next(),
        ]) await expect(request()).rejects.toThrow(/unavailable|unsupported/)
        await expect(refs.list({ id } as Agent, 'secret', signal())).rejects.toThrow('unavailable or stale')
      }
      expect(host.resolve).not.toHaveBeenCalled()
      expect(host.lstat).not.toHaveBeenCalled()
      expect(host.stat).not.toHaveBeenCalled()
      expect(nativeRefs).not.toHaveBeenCalled()
      expect(calls).toEqual([])
      // An owner's negative registry result does not block a positively verified ordinary native Session.
      expect((await files.read(scope('ordinary'), 'file', {}, signal())).text).toBe('host')
      const native = { id: 'ordinary' } as Agent, abort = signal()
      expect(await refs.list(native, 'file', abort)).toEqual([{ path: 'native-result', kind: 'file' }])
      expect(nativeRefs).toHaveBeenCalledExactlyOnceWith(native, 'file', abort)
    } finally { nativeRefs.mockRestore() }
  })
  it('preserves all inherited Remote markers and streams without redecorating or patching objects', () => {
    const { files } = setup()
    expect(remoteMethods(files).map(marker => marker.method)).toEqual(['read', 'readBytes', 'stat', 'list', 'search', 'changes'])
    expect(remoteMethods(files).at(-1)?.mode).toBe('stream')
    const parameters = (method: Function) => Function.prototype.toString.call(method).match(/^[^(]*\(([^)]*)\)/)![1]!.split(',').map(name => name.trim())
    for (const marker of remoteMethods(files)) {
      const own = Object.getOwnPropertyDescriptor(files, marker.method)?.value as Function
      const inherited = Object.getOwnPropertyDescriptor(CoreWorkspaceFiles.prototype, marker.method)?.value as Function
      expect(typeof own).toBe('function') // Gateway Reflect.get finds the initialized owned closure, not a captured Base method.
      expect(parameters(own)).toEqual(parameters(inherited))
      expect(parameters(own)[0]).toBe('workspaceFileScope') // Public lookup parameter name survives SRC fallback reflection.
      expect(parameters(own).at(-1)).toBe('signal')
    }
  })
  it('keeps guest read/stat/list/bytes routing through the public caller-context Service wrapper', async () => {
    const { files, host, calls } = setup()
    const selected = scope('managed')
    expect((await files.read(selected, 'file.txt', {}, signal())).text).toBe('guest')
    expect(await files.stat(selected, 'file.txt', signal())).toMatchObject({ absolutePath: '/project/ticket/file.txt', version: 'guest-v' })
    expect((await files.list(selected, '.', signal())).entries).toEqual([{ name: 'file.txt', type: 'file', size: 5 }])
    expect(Buffer.from((await files.readBytes(selected, 'file.txt', {}, signal())).data).toString()).toBe('guest')
    expect(calls).toContainEqual(expect.objectContaining({ op: 'list', path: '/project/ticket' }))
    expect(host.resolve).not.toHaveBeenCalled()
    expect(host.stat).not.toHaveBeenCalled()
    expect(host.lstat).not.toHaveBeenCalled()
  })
  it('routes concurrent managed and ordinary Windows reads without a global default', async () => {
    const { files, host, calls, ctx } = setup()
    ctx.provide('sessions', { get: (id: string) => id === 'ordinary' ? { header: { agentPreset: 'standard' } } : undefined })
    const [guest, ordinary] = await Promise.all([files.read(scope('managed'), 'file.txt', {}, signal()), files.read(scope('ordinary'), 'file.txt', {}, signal())])
    expect(guest.text).toBe('guest'); expect(ordinary.text).toBe('host')
    expect(guest.absolutePath).toBe('/project/ticket/file.txt')
    expect(calls).toContainEqual(expect.objectContaining({ op: 'resolve', path: '/project/ticket' }))
    expect(host.resolve).toHaveBeenCalledTimes(2)
  })
  it('blocks missing managed metadata before Host dispatch and retains public byte/page caps', async () => {
    const { files, host } = setup()
    await expect(files.read(scope('managed-missing'), 'secret', {}, signal())).rejects.toThrow('unavailable or stale')
    expect(host.resolve).not.toHaveBeenCalled()
    await expect(files.read(scope('managed'), 'file', { limit: 11 }, signal())).rejects.toThrow('limit must be at most 10')
    await expect(files.readBytes(scope('managed'), 'file', { range: { length: 65 } }, signal())).rejects.toThrow('byte cap')
  })
  it('explicitly refuses guest change observation instead of Host watching', async () => {
    const { files } = setup()
    await expect(files.changes(scope('managed'), '.', signal())[Symbol.asyncIterator]().next()).rejects.toThrow('unsupported')
  })
})
