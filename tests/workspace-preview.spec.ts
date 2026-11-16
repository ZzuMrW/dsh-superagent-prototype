/** In-process Client provider → real strict Gateway → Session-routed WorkspaceFiles regressions.
 * No DOM, replacement server, credentials, model or live profile is used here. */
import { Context } from '@deepseek-ai/cordis'
import { TypertRegistry, type TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import { TYPERT as NATIVE_TYPERT } from '@deepseek-ai/dsh-api-workspace-files/typert'
import { ResourceRegistry } from '@deepseek-ai/dsh-client-resources/src/client/resources.ts'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { PeerScope, PeerId } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SessionWorkspaceFiles, { configureWorkspaceSessionRegistry } from '../src/workspace-files.ts'
import { SessionExecutionRegistry } from '../src/execution/registry.ts'
import { freezeTarget, freezeExecutionSnapshot, environmentSnapshot } from '../src/execution/target.ts'
import { configureGuestFsResolver } from '../src/wsl-fs.ts'
import * as workspaceResources from '../src/client/workspace-resources.ts'

const TYPERT = NATIVE_TYPERT as TypertContribution
const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const signal = () => new AbortController().signal
const config = { maxBytes: 64, maxFileBytes: 128, maxLines: 10, maxEntries: 10,
  search: { maxResults: 10, maxEntries: 100, graceMs: 100, timeoutMs: 1000, stderrMaxBytes: 4096 } }
async function setup() {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  const hostPaths: string[] = []
  const host = {
    resolve: vi.fn(async (path: string) => { hostPaths.push(path); return { targetKey: FsTargetKey(path), displayPath: path } }),
    lstat: vi.fn(async () => ({ type: 'file' })),
    stat: vi.fn(async () => ({ type: 'file', version: FsVersion('host-v'), size: 4 })),
    processPath: (target: { displayPath: string }) => target.displayPath,
    streamText: vi.fn(async () => (async function* () { yield 'host' })()),
    readBytes: vi.fn(async () => new TextEncoder().encode('host')),
    watch: vi.fn(async () => async () => {}), contains: () => true,
  }
  const headers: Record<string, { agentPreset: string; cwd: string }> = {
    ordinary: { agentPreset: 'standard', cwd: 'C:\\host-user\\project' },
    managed: { agentPreset: 'wsl-dsh-superagent-worker', cwd: '\\\\wsl.localhost\\Ubuntu\\project\\ticket' },
  }
  ctx.provide('fs', host as never)
  ctx.provide('sandboxPolicy', { workspaceRoot: 'C:\\host-user\\project' } as never)
  ctx.provide('sessions', { get: (id: string) => headers[id] ? { header: headers[id] } : undefined } as never)
  ctx.provide('remoteAccess', { decide: vi.fn(() => ({ kind: 'deny', reason: 'test-denied' })) } as never)
  await ctx.plugin(TypertRegistry)
  // Reproduce the exact withdrawal history observed when the stock Loader row disappears.
  const stock = ctx.typert.register(TYPERT)
  await stock()
  expect(ctx.typert.local.get('workspaceFiles/read')).toBeUndefined()
  expect(ctx.typert.local.hasSeen('workspaceFiles/read')).toBe(true)
  const registry = new SessionExecutionRegistry({ load: () => undefined, isManagedSession: id => id.startsWith('managed') })
  const target = freezeTarget({ distro: 'Ubuntu', user: 'worker', uid: 1000, home: '/home/worker', bootId: 'boot' },
    { input: '/project', guestPath: '/project', hostPath: '\\\\wsl.localhost\\Ubuntu\\project', storage: 'guest-local', evidence: { converter: 'wslpath', hostRegistration: 'verified' } }, 'generation', '')
  registry.register({ sessionId: 'managed', role: 'worker', guestCwd: '/project/ticket', hostCwd: '\\\\wsl.localhost\\Ubuntu\\project\\ticket',
    snapshot: freezeExecutionSnapshot(1, target, environmentSnapshot({})) })
  cleanup.push(configureWorkspaceSessionRegistry(registry))
  const guestPaths: string[] = []
  cleanup.push(configureGuestFsResolver(id => id === 'managed' ? { identity: 'uid1000', cwd: '/project/ticket',
    transport: async (_script, payload) => {
      const request = JSON.parse(payload); guestPaths.push(request.path)
      const value = request.op === 'resolve' ? request.path
        : request.op === 'stat' || request.op === 'lstat' ? { type: 'file', version: 'guest-v', size: 5 }
        : request.op === 'range' || request.op === 'bytes' ? { data: request.op === 'bytes' || request.offset === 0 ? Buffer.from('guest').toString('base64') : '', version: 'guest-v' }
        : undefined
      if (value === undefined) throw new Error('Unexpected guest operation: ' + request.op)
      return JSON.stringify({ ok: true, value })
    } } : undefined))
  await ctx.plugin(TypertGatewayService, {})
  const service = await ctx.plugin(SessionWorkspaceFiles, config)
  const peer: PeerScope = { id: 'test-preview' as PeerId, ctx, principal: { kind: 'owner' }, signal: signal(), interactions: 'none', dispose: async () => {} }
  const call = (method: string, id: string, args: Record<string, unknown>) => ctx.typertGateway.invoke({ namespace: 'workspaceFiles', method, args: { workspaceFileScopeId: id, ...args }, peer })
  return { ctx, service, peer, call, host, hostPaths, guestPaths }
}

describe('strict WorkspaceFiles replacement contract', () => {
  it('restores every native descriptor after withdrawal and uses the active specialization', async () => {
    const { ctx, call, host, guestPaths } = await setup()
    for (const descriptor of TYPERT.invocations) {
      const actual = ctx.typert.local.get(`${descriptor.namespace}/${descriptor.method}`)
      expect(actual?.id).toBe(descriptor.id)
      expect(actual?.parameters).toEqual(descriptor.parameters)
      expect(actual?.result).toBe(descriptor.result)
      expect(actual?.mode).toBe(descriptor.mode)
    }
    expect(await call('read', 'ordinary', { path: 'file.txt', range: {} })).toMatchObject({ text: 'host' })
    host.resolve.mockClear()
    expect(await call('read', 'managed', { path: 'file.txt', range: {} })).toMatchObject({ text: 'guest', absolutePath: '/project/ticket/file.txt' })
    expect(guestPaths).toContain('/project/ticket/file.txt')
    expect(host.resolve).not.toHaveBeenCalled()
  })
  it('rejects invalid wire fields and values before entering either filesystem', async () => {
    const { call, host, guestPaths } = await setup()
    for (const args of [
      { path: 42, range: {} }, { path: 'file', range: { offset: '1' } },
      { path: 'file', range: {}, untrusted: true },
    ]) await expect(call('read', 'managed', args)).rejects.toMatchObject({ code: expect.stringMatching(/^gateway\//) })
    expect(host.resolve).not.toHaveBeenCalled()
    expect(guestPaths).toEqual([])
    await expect(call('read', 'managed', { path: 'file', range: { limit: 11 } })).rejects.toThrow('limit must be at most 10')
    expect(guestPaths).toEqual([])
  })
  it('keeps stale managed Session and access-denied requests out of the Host', async () => {
    const { ctx, call, peer, host, guestPaths } = await setup()
    await expect(call('read', 'managed-missing', { path: 'secret', range: {} })).rejects.toMatchObject({ code: expect.stringMatching(/^gateway\//) })
    await expect(ctx.typertGateway.invoke({ namespace: 'workspaceFiles', method: 'read',
      args: { workspaceFileScopeId: 'managed', path: 'secret', range: {} },
      peer: { ...peer, principal: { kind: 'preview-test-non-owner' } as never } })).rejects.toMatchObject({ code: 'remote-access/denied' })
    expect(host.resolve).not.toHaveBeenCalled()
    expect(guestPaths).toEqual([])
  })
  it('withdraws owned descriptors on unload and never weakens to SRC fallback', async () => {
    const { ctx, service, call } = await setup()
    expect(() => ctx.typert.register(TYPERT)).toThrow(/already registered/)
    expect(await call('read', 'ordinary', { path: 'file', range: {} })).toMatchObject({ text: 'host' })
    await service.dispose()
    expect(ctx.typert.local.get('workspaceFiles/read')).toBeUndefined()
    expect(ctx.typert.local.hasSeen('workspaceFiles/read')).toBe(true)
    await expect(call('read', 'ordinary', { path: 'file', range: {} })).rejects.toThrow('strict definition was withdrawn')
    await ctx.plugin(SessionWorkspaceFiles, config)
    expect(await call('read', 'ordinary', { path: 'file', range: {} })).toMatchObject({ text: 'host' })
  })
  it('preserves requested execution-world paths instead of guessing drive mappings', async () => {
    const { call, hostPaths, guestPaths } = await setup()
    const windows = 'C:\\Users\\test\\file.md'
    await call('read', 'ordinary', { path: windows, range: {} })
    expect(hostPaths).toContain(windows)
    hostPaths.length = 0
    // A guest mount path belongs to its managed binding, including non-default automount layouts.
    await call('read', 'managed', { path: '/mnt/c/Users/test/file.md', range: {} })
    expect(guestPaths).toContain('/mnt/c/Users/test/file.md')
    expect(hostPaths).toEqual([])
  })
})

it('registers the native browser file provider once, forwards metadata through Gateway and releases it', async () => {
  const { ctx: host, call } = await setup()
  const browser = new Context()
  cleanup.push(() => browser.fiber.dispose())
  let provider: { protocol: string; open: (address: string, options: { signal: AbortSignal }) => AsyncIterable<{ ok: boolean; value?: unknown }> } | undefined
  const release = vi.fn(), register = vi.fn(value => { if (provider) throw new Error('duplicate file provider'); provider = value; return () => { provider = undefined; release() } })
  browser.provide('resources', { register } as never)
  const remote = {
    workspaceFiles: { stat: async (id: string, path: string) => ({ ok: true, value: await call('stat', id, { path }) }) },
    // A terminal business failure in managed changes is intentionally non-retrying.
    // The native provider must perform its one-shot stat fallback and not hang.
    $stream: () => ({ async *[Symbol.asyncIterator]() { throw new Error('managed observation unsupported') }, dispose: async () => {} }),
  }
  browser.provide('remote', remote as never)
  // The generated Remote carrier publishes the namespace as its own traced
  // service; an ordinary JS property alone does not satisfy Cordis injection.
  browser.provide('remote.workspaceFiles', remote.workspaceFiles as never)
  // Mount the exact child plugin used in production, including its native
  // runtime inject list, rather than calling the provider body directly.
  expect(workspaceResources.inject).toEqual(['resources', 'remote', 'remote.workspaceFiles'])
  const fiber = await browser.plugin(workspaceResources)
  expect(register).toHaveBeenCalledTimes(1)
  const frames = []
  for await (const frame of provider!.open('dsh-resource://file/session/managed/file.txt', { signal: signal() })) frames.push(frame)
  expect(frames).toEqual([{ ok: true, value: { absolutePath: '/project/ticket/file.txt', version: 'guest-v', bytes: 5 } }])
  expect(host.typert.local.get('workspaceFiles/stat')).toBeDefined()
  await fiber.dispose()
  expect(release).toHaveBeenCalledTimes(1)
  expect(provider).toBeUndefined()
})


it('moves a real resource registry from unavailable to loaded and back on provider disposal', async () => {
  const { call } = await setup()
  const browser = new Context()
  cleanup.push(() => browser.fiber.dispose())
  const resources = new ResourceRegistry(browser)
  browser.provide('resources', resources)
  const remote = {
    workspaceFiles: { stat: async (id: string, path: string) => ({ ok: true, value: await call('stat', id, { path }) }) },
    $stream: () => ({ async *[Symbol.asyncIterator]() { throw new Error('managed watch unsupported') }, dispose: async () => {} }),
  }
  browser.provide('remote', remote as never)
  browser.provide('remote.workspaceFiles', remote.workspaceFiles as never)
  const source = resources.source('dsh-resource://file/session/managed/file.txt')
  expect(source.getSnapshot().status).toBe('none')
  let unsubscribe = () => {}
  const loaded = new Promise<void>(resolve => {
    unsubscribe = source.subscribe(() => {
      if (source.getSnapshot().status === 'live') resolve()
    })
  })
  cleanup.push(() => unsubscribe())
  const fiber = await browser.plugin(workspaceResources)
  await loaded
  expect(source.getSnapshot()).toMatchObject({ status: 'live', value: { absolutePath: '/project/ticket/file.txt' } })
  expect(() => resources.register({ protocol: 'file', async *open() {} })).toThrow('already has a provider')
  await fiber.dispose()
  expect(source.getSnapshot().status).toBe('none')
})
