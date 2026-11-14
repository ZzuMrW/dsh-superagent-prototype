/** Real Python RPC behavior, confined to an owned temporary directory. No users/profiles/network. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile, chmod, stat, symlink, readdir, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GUEST_FS_SCRIPT } from '../src/infra/guest-fs.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'guest-fs-test-')) })
afterEach(async () => { if (dir.startsWith(join(tmpdir(), 'guest-fs-test-'))) await rm(dir, { recursive: true, force: true }) })
async function rpc(op: string, path: string, fields: object = {}) {
  const child = spawn('python3', ['-c', GUEST_FS_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout.setEncoding('utf8').on('data', chunk => out += chunk)
  child.stderr.setEncoding('utf8').on('data', chunk => err += chunk)
  const done = new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(err))) })
  child.stdin.end(JSON.stringify({ op, path, identity: 'test-distro:uid', limit: 1024 * 1024, ...fields }))
  await done
  return JSON.parse(out)
}
describe('guest Python filesystem RPC', () => {
  it('atomically writes via stdin, retains mode, returns stable guards and no staging artifacts', async () => {
    const path = join(dir, 'file'), content = 'λ'.repeat(200_000)
    await writeFile(path, 'before\r\n'); await chmod(path, 0o640)
    const initial = await rpc('stat', path)
    const written = await rpc('write', path, { content, expected: { kind: 'replaceIfVersion', version: initial.value.version } })
    expect(written.value).toMatchObject({ operation: 'update', before: 'before\n', after: content })
    expect((await stat(path)).mode & 0o777).toBe(0o640)
    expect(await readFile(path, 'utf8')).toBe(content)
    expect((await rpc('write', path, { content: 'lost', expected: { kind: 'replaceIfVersion', version: initial.value.version } })).code).toBe('FS_STALE_VERSION')
    expect(await readdir(dir)).toEqual(['file'])
  })
  it('matches normalized literal text, preserves CRLF and rejects ambiguous or stale edits', async () => {
    const path = join(dir, 'file'); await writeFile(path, 'one\r\none\r\n')
    expect((await rpc('edit', path, { edit: { oldString: 'one', newString: 'two', replaceAll: false } })).code).toBe('FS_AMBIGUOUS_EDIT')
    const result = await rpc('edit', path, { edit: { oldString: 'one\n', newString: 'two\n', replaceAll: true } })
    expect(result.value).toMatchObject({ before: 'one\none\n', after: 'two\ntwo\n' })
    expect(await readFile(path, 'utf8')).toBe('two\r\ntwo\r\n')
    expect((await rpc('edit', path, { expected: { version: 'stale' }, edit: { oldString: 'not there', newString: '', replaceAll: false } })).code).toBe('FS_STALE_VERSION')
  })
  it('honors create guards concurrently without overwriting a winning writer', async () => {
    const path = join(dir, 'new')
    const result = await Promise.all(['a','b','c'].map(content => rpc('write', path, { content, expected: { kind: 'createIfAbsent' } })))
    expect(result.filter(x => x.ok)).toHaveLength(1)
    expect(result.filter(x => x.code === 'FS_NOT_OBSERVED')).toHaveLength(2)
    expect(await readdir(dir)).toEqual(['new'])
  })
  it('rejects NUL/invalid UTF8 and directories; raw byte windows stay bounded', async () => {
    const path = join(dir, 'binary'); await writeFile(path, Buffer.from([0xff,0,1,2,3]))
    expect((await rpc('text', path, { cap: 100 })).code).toBe('FS_NOT_TEXT')
    expect((await rpc('bytes', path, { cap: 4 })).code).toBe('FS_TOO_LARGE')
    expect(Buffer.from((await rpc('range', path, { cap: 2, offset: 3 })).value.data, 'base64')).toEqual(Buffer.from([2,3]))
    expect((await rpc('text', dir, { cap: 100 })).code).toBe('FS_NOT_REGULAR_FILE')
    expect((await rpc('write', path, { content: '\u0000' })).code).toBe('FS_NOT_TEXT')
    expect((await rpc('write', path, { content: '\ud800' })).code).toBe('FS_NOT_TEXT')
  })
  it('seeks a bounded byte range in a multi-gigabyte sparse file without buffering its prefix', async () => {
    const path = join(dir, 'sparse'); await writeFile(path, ''); await truncate(path, 4 * 1024 * 1024 * 1024)
    const range = await rpc('range', path, { cap: 8, offset: 4 * 1024 * 1024 * 1024 - 4 })
    expect(Buffer.from(range.value.data, 'base64')).toEqual(Buffer.alloc(4))
    expect((await rpc('bytes', path, { cap: 16 })).code).toBe('FS_TOO_LARGE')
  })
  it('separates lstat symlinks from canonical identities and lists stable metadata', async () => {
    await writeFile(join(dir, 'z'), 'text'); await symlink('z', join(dir, 'a'))
    expect((await rpc('lstat', join(dir, 'a'))).value.type).toBe('symlink')
    expect((await rpc('resolve', join(dir, 'a'))).value).toBe(join(dir, 'z'))
    const entries = (await rpc('list', dir)).value
    expect(entries.map((x: { name: string }) => x.name)).toEqual(['a','z'])
    expect(entries[0].path).toBe(entries[1].path)
    expect((await rpc('stat', join(dir, 'absent'))).value).toBeNull()
  })
  it('moves with two guards while carrying source mode and preserving the destination on stale failure', async () => {
    const path = join(dir, 'source'), destination = join(dir, 'dest')
    await writeFile(path, 'source\r\n'); await chmod(path, 0o750)
    const initial = (await rpc('stat', path)).value
    const moved = await rpc('move', path, { destination, expectedSource: { version: initial.version }, expectedDestination: { kind: 'createIfAbsent' } })
    expect(moved.value).toMatchObject({ sourceDeleted: true, sourceBefore: 'source\n', destination: { operation: 'create', after: 'source\n' } })
    expect(await readFile(destination, 'utf8')).toBe('source\r\n')
    expect((await stat(destination)).mode & 0o777).toBe(0o750)
    await writeFile(path, 'changed')
    expect((await rpc('move', path, { destination, expectedSource: { version: initial.version } })).code).toBe('FS_STALE_VERSION')
    expect(await readFile(destination, 'utf8')).toBe('source\r\n')
  })
  it('enforces sandbox at the guest without host-side fallback', async () => {
    const path = join(dir, 'file'); await writeFile(path, 'safe')
    expect((await rpc('write', path, { content: 'bad', policy: { mode: 'read-only' } })).code).toBe('FS_SANDBOX_DENIED')
    expect((await rpc('write', path, { content: 'bad', policy: { mode: 'workspace-write', roots: [join(dir, 'other')] } })).code).toBe('FS_SANDBOX_DENIED')
    expect(await readFile(path, 'utf8')).toBe('safe')
  })
})
