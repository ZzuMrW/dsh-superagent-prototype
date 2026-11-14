/** Public FileSystem conformance over a real Python stdin transport, no WSL/profile mutation. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import GuestFileSystem, { configureGuestFsResolver, withGuestFsSession, type GuestFsTransport } from '../src/wsl-fs.ts'

let dir: string, fs: GuestFileSystem, dispose: () => void, identity: string
const transport: GuestFsTransport = async (script, payload, signal, maxBytes = 1024 * 1024) => {
  const child = spawn('python3', ['-c', script], { stdio: ['pipe','pipe','pipe'], signal })
  const buffers: Buffer[] = []; let size = 0, stderr = ''
  const result = new Promise<string>((resolve, reject) => {
    child.stdout.on('data', (data: Buffer) => { size += data.length; if (size > maxBytes) { child.kill(); reject(new Error('output overflow')) } else buffers.push(data) })
    child.stderr.on('data', data => stderr += data)
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve(Buffer.concat(buffers).toString('utf8')) : reject(new Error(stderr || `Python exit ${code}`)))
  })
  child.stdin.end(payload)
  return result
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'public-guest-fs-')); identity = 'machine:distro:uid=1000'
  fs = new GuestFileSystem(new Context())
  dispose = configureGuestFsResolver(async id => id === 'bound' ? { identity, cwd: dir, transport } : undefined)
})
afterEach(async () => { dispose(); if (dir.startsWith(join(tmpdir(), 'public-guest-fs-'))) await rm(dir, { recursive: true, force: true }) })
const session = <T>(work: () => T) => withGuestFsSession('bound', work)
it('fails closed outside an explicit trusted session and for stale-world targets', async () => {
  await expect(fs.resolve('x')).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  const target = await session(() => fs.resolve('x'))
  identity = 'other-machine:distro:uid=1000'
  await expect(session(() => fs.stat(target))).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
})
it('keeps opaque identity stable across aliases/atomic rewrite and ignores displayPath tampering', async () => session(async () => {
  const target = await fs.resolve('x')
  await fs.writeText(target, 'one')
  await symlink('x', join(dir, 'alias'))
  expect((await fs.resolve('alias')).targetKey).toBe(target.targetKey)
  await fs.writeText({ ...target, displayPath: '/not-authoritative' }, 'two')
  expect((await fs.resolve('x')).targetKey).toBe(target.targetKey)
  expect(await fs.readText(target)).toBe('two')
  expect(await fs.lstat('alias')).toMatchObject({ type: 'symlink' })
  expect(fs.processPath(target)).toBe(join(dir, 'x'))
  expect(fs.fileUrl(target)).toContain('file:///')
}))
it('provides actual metadata, normalized guards, literal edits, patches and deletion', async () => session(async () => {
  const target = await fs.resolve('x')
  const written = await fs.writeText(target, 'hello\r\n', { kind: 'createIfAbsent' })
  expect(written.operation).toBe('create')
  expect((await fs.stat(target))?.version).toBe(written.version)
  const edited = await fs.editText(target, { oldString: 'hello', newString: 'world', replaceAll: false }, { version: written.version })
  expect(edited.after).toBe('world\n')
  await expect(fs.writeText(target, 'stale', { kind: 'replaceIfVersion', version: written.version })).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  const patched = await fs.patchText(target, [{ oldLines: ['world'], newLines: ['patched'], lineNumber: 1, isEndOfFile: false }], { version: edited.version })
  expect(patched.after).toBe('patched\n')
  expect((await fs.listDir(await fs.resolve('.'))).map(e => e.name)).toEqual(['x'])
  expect(await fs.deleteFile(target, { version: patched.version })).toMatchObject({ before: 'patched\n' })
  expect(await fs.stat(target)).toBeUndefined()
}))
it('streams bounded UTF8 windows across multibyte boundaries and rejects bad text', async () => session(async () => {
  const target = await fs.resolve('large')
  const text = 'a'.repeat(65535) + '😀' + 'λ'.repeat(80000)
  await writeFile(join(dir, 'large'), text)
  let combined = ''
  for await (const chunk of await fs.streamText(target)) combined += chunk
  expect(combined).toBe(text)
  expect((await fs.readByteRange(target, { offset: 65535, length: 4 })).length).toBe(4)
  await expect(fs.readBytes(target, undefined, 16)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  await writeFile(join(dir, 'large'), Buffer.from([0xf0,0x80]))
  await expect(fs.readText(target)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  await expect((async () => { for await (const _ of await fs.streamText(target)) { /* drain */ } })()).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  await expect(fs.writeText(target, '\ud800')).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  await expect(fs.writeText(target, '\0')).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
}))
it('moves and patches through the same public provider, retaining source mode and guards', async () => session(async () => {
  const source = await fs.resolve('source'), destination = await fs.resolve('destination')
  const written = await fs.writeText(source, 'before\r\n')
  const moved = await fs.moveFile(source, destination, { hunks: [{ oldLines: ['before'], newLines: ['after'], lineNumber: 1, isEndOfFile: false }], expectedSource: { version: written.version }, expectedDestination: { kind: 'createIfAbsent' } })
  expect(moved).toMatchObject({ sourceBefore: 'before\n', sourceDeleted: true, destination: { after: 'after\n' } })
  expect(await fs.readText(destination)).toBe('after\r\n')
  expect(await fs.stat(source)).toBeUndefined()
}))
it('propagates cancellation and sandbox denials without falling back to host I/O', async () => session(async () => {
  const target = await fs.resolve('x'), controller = new AbortController(); controller.abort()
  await expect(fs.stat(target, controller.signal)).rejects.toMatchObject({ code: 'FS_ABORTED' })
  await expect(fs.writeText(target, 'denied', undefined, undefined, { mode: 'read-only', workspaceRoot: dir })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  expect(await fs.stat(target)).toBeUndefined()
}))
it('checks deployment freshness at binding and again immediately before transport dispatch', async () => {
  const assertCurrent = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('deployment replaced'))
  const send = vi.fn(transport)
  const owner = configureGuestFsResolver(() => ({ identity, cwd: dir, transport: send, assertCurrent }))
  try {
    await expect(session(() => fs.resolve('x'))).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    expect(assertCurrent).toHaveBeenCalledTimes(2)
    expect(send).not.toHaveBeenCalled()
  } finally { owner() }
})
it('supports asynchronous trusted path mapping and identity-owned resolver disposal', async () => {
  const newer = configureGuestFsResolver(async id => id === 'bound' ? { identity, cwd: dir, transport, mapPath: async () => join(dir, 'mapped') } : undefined)
  dispose()
  try { expect((await session(() => fs.resolve('C:\\opaque'))).displayPath).toBe(join(dir, 'mapped')) } finally { newer() }
})
