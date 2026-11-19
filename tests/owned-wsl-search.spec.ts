/** Guest search always uses the bound execution identity and public fixed rg argv builders. */
import { describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { guestGlob, guestGrep, guestWorkspaceSearch, SEARCH_CAPS, type GuestSearchTransport, type WslSearchBinding } from '../src/wsl-tools.ts'
import { environmentSnapshot, freezeExecutionSnapshot, freezeTarget } from '../src/execution/target.ts'
import { testDeployment } from './fixtures/deployment.ts'
const signal = () => new AbortController().signal
function binding(uid = 1000): WslSearchBinding {
  const identity = { distro: 'ExampleDistro', user: uid ? 'developer' : 'root', uid, home: '/home/developer', bootId: 'boot' }
  const workspace = { input: '/home/developer/work', guestPath: '/home/developer/work', hostPath: '\\\\wsl.localhost\\ExampleDistro\\home\\developer\\work', storage: 'guest-local' as const,
    evidence: { converter: 'wslpath' as const, hostRegistration: 'verified' as const, fileSystem: 'ext4' } }
  return { machine: testDeployment(), env: {}, variables: () => ({ DSH_SUPERAGENT_TICKET: 'owned-test' }), guestCwd: workspace.guestPath,
    snapshot: freezeExecutionSnapshot(1, freezeTarget(identity, workspace, 'generation-one', 'checked'), environmentSnapshot({
      PATH: '/usr/local/bin:/usr/bin', GIT_CONFIG_GLOBAL: '/home/developer/.local/state/superagent/generation-one/gitconfig', GH_TOKEN: undefined,
    })) }
}
const match = (path: string, text = 'needle\n', line = 1) => JSON.stringify({ type: 'match', data: { path: { text: path }, lines: { text }, line_number: line } })
describe('owned guest search', () => {
  it('maps Windows input through the selected target and never uses Host rg', async () => {
    const target = binding(), map = target.mapPath = vi.fn(async () => '/windows/d/Project')
    const calls: Parameters<GuestSearchTransport>[] = []
    const transport: GuestSearchTransport = async (machine, request) => { calls.push([machine, request]); return '/windows/d/Project/src/A.ts\n' }
    const result = await guestGlob(target, { pattern: '*.ts', path: 'D:\\Project' }, signal(), SEARCH_CAPS, transport)
    expect(map).toHaveBeenCalledWith('D:\\Project', expect.any(AbortSignal), target.guestCwd)
    expect(calls[0]![0].wsl).toMatchObject({ distro: 'ExampleDistro', user: 'developer' })
    expect(calls[0]![1].argv[0]).toBe('rg')
    expect(calls[0]![1].argv.at(-1)).toBe('/windows/d/Project')
    expect(calls[0]![1].expectedIdentity).toEqual({ uid: 1000, bootId: 'boot' })
    expect(calls[0]![1].env?.GH_TOKEN).toBeUndefined()
    expect(result.paths).toEqual(['../../../windows/d/Project/src/A.ts'])
  })
  it('keeps Linux case-sensitive paths and exposes no incomplete raw result as success', async () => {
    const target = binding()
    const result = await guestGrep(target, { pattern: 'needle' }, signal(), SEARCH_CAPS,
      async () => match('/home/developer/work/Upper/File.ts') + '\n' + match('/home/developer/work/upper/file.ts', 'other\n', 2))
    expect(result.matches.map(value => value.path)).toEqual(['Upper/File.ts', 'upper/file.ts'])
    const overflow = async () => { throw Object.assign(new Error('buffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: 'partial' }) }
    await expect(guestGrep(target, { pattern: 'needle' }, signal(), SEARCH_CAPS, overflow)).rejects.toMatchObject({ code: 'SEARCH_OUTPUT_LIMIT' })
  })
  it('recognizes rg no-match, but does not hide permission or blocked-shim stderr', async () => {
    const none = async () => { throw { code: 1, stderr: '', stdout: '' } }
    expect(await guestGlob(binding(), { pattern: '*.missing' }, signal(), SEARCH_CAPS, none)).toMatchObject({ paths: [], total: 0, truncated: false })
    const denied = async () => { throw { code: 2, stderr: 'permission denied' } }
    await expect(guestGrep(binding(), { pattern: 'needle' }, signal(), SEARCH_CAPS, denied)).rejects.toMatchObject({ code: 'SEARCH_FAILED' })
    const blocked = async () => { throw { code: 1, stderr: 'command blocked' } }
    await expect(guestGlob(binding(), { pattern: '*' }, signal(), SEARCH_CAPS, blocked)).rejects.toMatchObject({ code: 'SEARCH_FAILED' })
  })
  it('spills complete capped results to a guest generation via stdin', async () => {
    const calls: Parameters<GuestSearchTransport>[] = []
    const transport: GuestSearchTransport = async (machine, request) => {
      calls.push([machine, request])
      return request.argv[0] === 'rg' ? 'a.ts\nb.ts\nc.ts\n' : '/home/developer/.local/state/superagent/generation-one/search-results/result.txt\n'
    }
    const result = await guestGlob(binding(), { pattern: '*.ts' }, signal(), { ...SEARCH_CAPS, maxPaths: 2 }, transport)
    expect(result.paths).toEqual(['a.ts', 'b.ts']); expect(result.total).toBe(3); expect(result.truncated).toBe(true)
    expect(result.spill).toMatch(/^\/home\/developer\//)
    expect(JSON.parse(calls[1]![1].stdin as string).content).toBe('a.ts\nb.ts\nc.ts')
    expect(calls[1]![1].argv).not.toContain('a.ts\nb.ts\nc.ts')
  })
  it('caps both line content and presentation metadata from the same retained items', async () => {
    const records = Array.from({ length: 20 }, (_, i) => match(`folder/file-${i}.ts`, 'x'.repeat(2048) + '\n', i + 1)).join('\n')
    const transport: GuestSearchTransport = async (_machine, request) => request.argv[0] === 'rg' ? records : '/results/owned.txt\n'
    const result = await guestGrep(binding(), { pattern: 'x' }, signal(), { ...SEARCH_CAPS, maxLineBytes: 64, maxMetaBytes: 400 }, transport)
    expect(result.total).toBe(20); expect(result.truncated).toBe(true)
    expect(result.matches.length).toBeLessThan(20)
    expect(result.matches.every(item => item.line.length < 2048)).toBe(true)
  })
  it('refuses missing/stale identity and records only genuine cleanup uncertainty', async () => {
    const transport = vi.fn<GuestSearchTransport>(async () => '')
    await expect(guestGlob({ ...binding(), snapshot: undefined }, { pattern: '*' }, signal(), SEARCH_CAPS, transport)).rejects.toMatchObject({ code: 'SEARCH_TARGET_UNAVAILABLE' })
    const stale = binding(); stale.assertCurrent = () => { throw new Error('stale') }
    await expect(guestGlob(stale, { pattern: '*' }, signal(), SEARCH_CAPS, transport)).rejects.toMatchObject({ code: 'SEARCH_FAILED' })
    expect(transport).not.toHaveBeenCalled()
    const target = binding(), recorded = target.onCleanupUnconfirmed = vi.fn()
    const error = Object.assign(new Error('unconfirmed'), { code: 'WSL_CLEANUP_UNCONFIRMED' })
    await expect(guestGlob(target, { pattern: '*' }, signal(), SEARCH_CAPS, async () => { throw error })).rejects.toBe(error)
    expect(recorded).toHaveBeenCalledTimes(1)
  })
  it('implements the workspace file search contract without Host discovery', async () => {
    const calls: Parameters<GuestSearchTransport>[] = []
    const transport: GuestSearchTransport = async (machine, request) => {
      calls.push([machine, request]); return JSON.stringify({ paths: ['src/A.ts', 'src/deep/B.ts', 'other.ts'], incomplete: false })
    }
    const result = await guestWorkspaceSearch(binding(), { query: 'src', excludedPaths: ['node[modules]'], includeHidden: true, respectGitignore: false }, signal(), undefined, transport)
    expect(result).toEqual({ matches: [{ path: 'src', type: 'directory' }], truncated: false, incomplete: false })
    const payload = JSON.parse(calls[0]![1].stdin as string)
    expect(payload.argv).toContain('--hidden'); expect(payload.argv).toContain('--no-ignore')
    expect(payload.argv).toContain('--glob=!node\\[modules\\]')
    expect(payload).toMatchObject({ stderrMaxBytes: 65536, graceMs: 3000 })
    expect(calls[0]![0].wsl?.user).toBe('developer')
    expect(calls[0]![1].argv[0]).toBe('python3')
  })
  it('bounds workspace matches and refuses discovery paths outside the relative contract', async () => {
    const request = { query: '.ts', excludedPaths: [], includeHidden: false, respectGitignore: true }
    const result = await guestWorkspaceSearch(binding(), request, signal(), { maxResults: 1, maxEntries: 100, timeoutMs: 1000 },
      async () => JSON.stringify({ paths: ['deep/b.ts', 'a.ts'], incomplete: true }))
    expect(result).toEqual({ matches: [{ path: 'a.ts', type: 'file' }], truncated: true, incomplete: true })
    await expect(guestWorkspaceSearch(binding(), request, signal(), undefined,
      async () => JSON.stringify({ paths: ['../outside.ts'], incomplete: false }))).rejects.toMatchObject({ code: 'SEARCH_INVALID_OUTPUT' })
  })
  it.skipIf(process.platform !== 'linux').each([
    { name: 'returns the file and its parent at the exact scan budget', paths: ['foo/foo.txt'], query: 'foo', maxEntries: 1, maxResults: 10,
      expected: { matches: [{ path: 'foo', type: 'directory' }, { path: 'foo/foo.txt', type: 'file' }], truncated: false, incomplete: false } },
    { name: 'truncates only after including inferred directories', paths: ['foo/foo.txt'], query: 'foo', maxEntries: 1, maxResults: 1,
      expected: { matches: [{ path: 'foo', type: 'directory' }], truncated: true, incomplete: false } },
    { name: 'marks an extra listed file incomplete independently of result truncation', paths: ['foo/foo.txt', 'foo/second.txt'], query: 'foo', maxEntries: 1, maxResults: 10,
      expected: { matches: [{ path: 'foo', type: 'directory' }, { path: 'foo/foo.txt', type: 'file' }], truncated: false, incomplete: true } },
    { name: 'charges nonmatching files against the scan budget', paths: ['a.txt', 'foo/foo.txt'], query: 'foo', maxEntries: 1, maxResults: 10,
      expected: { matches: [], truncated: false, incomplete: true } },
    { name: 'matches all inferred parents for path queries', paths: ['foo/bar/foo.txt'], query: 'foo/bar', maxEntries: 1, maxResults: 10,
      expected: { matches: [{ path: 'foo/bar', type: 'directory' }, { path: 'foo/bar/foo.txt', type: 'file' }], truncated: false, incomplete: false } },
    { name: 'deduplicates shared parents without spending scan budget', paths: ['foo/first.txt', 'foo/second.txt'], query: 'FOO', maxEntries: 2, maxResults: 10,
      expected: { matches: [{ path: 'foo', type: 'directory' }], truncated: false, incomplete: false } },
  ])('$name', async ({ paths, query, maxEntries, maxResults, expected }) => {
    const root = mkdtempSync(join(tmpdir(), 'owned-wsl-search-'))
    try {
      for (const path of paths) {
        const file = join(root, path)
        mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, '')
      }
      const transport: GuestSearchTransport = async (_machine, request) => {
        const child = spawnSync(request.argv[0]!, request.argv.slice(1), { cwd: root, input: request.stdin, encoding: 'utf8', timeout: 10000 })
        if (child.error) throw child.error
        expect(child.status, child.stderr).toBe(0)
        return child.stdout
      }
      const result = await guestWorkspaceSearch({ ...binding(), guestCwd: root },
        { query, excludedPaths: [], includeHidden: false, respectGitignore: false }, signal(),
        { maxEntries, maxResults, timeoutMs: 10000 }, transport)
      expect(result).toEqual(expected)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('honors native configured scan and result caps without an undocumented adapter clamp', async () => {
    const paths = Array.from({ length: 2001 }, (_, index) => `foo-${index}.txt`)
    const transport = vi.fn<GuestSearchTransport>(async () => JSON.stringify({ paths, incomplete: false }))
    const result = await guestWorkspaceSearch(binding(), { query: 'foo', excludedPaths: [], includeHidden: false, respectGitignore: true }, signal(),
      { maxEntries: 100001, maxResults: 2001, timeoutMs: 1000 }, transport)
    expect(result.matches).toHaveLength(2001)
    expect(result.truncated).toBe(false)
    expect(JSON.parse(transport.mock.calls[0]![1].stdin as string).maxEntries).toBe(100001)
  })
  it('forwards configured workspace diagnostic and termination budgets to the guest enumerator', async () => {
    const transport = vi.fn<GuestSearchTransport>(async () => JSON.stringify({ paths: [], incomplete: false }))
    await guestWorkspaceSearch(binding(), { query: 'foo', excludedPaths: [], includeHidden: false, respectGitignore: true }, signal(),
      { maxEntries: 1, maxResults: 10, timeoutMs: 1234, stderrMaxBytes: 9876, graceMs: 4321 }, transport)
    const request = transport.mock.calls[0]![1]
    expect(request.timeoutMs).toBe(1234)
    expect(JSON.parse(request.stdin as string)).toMatchObject({ maxEntries: 1, stderrMaxBytes: 9876, graceMs: 4321 })
    expect(request.argv[2]).toContain("if len(stderr)>q['stderrMaxBytes']: del stderr[:-q['stderrMaxBytes']]")
    expect(request.argv[2]).toContain("p.wait(timeout=q['graceMs']/1000)")
  })
  it.each([
    { stderrMaxBytes: 0 }, { stderrMaxBytes: -1 }, { stderrMaxBytes: 1.5 }, { stderrMaxBytes: Infinity },
    { graceMs: 0 }, { graceMs: -1 }, { graceMs: 1.5 }, { graceMs: NaN },
  ])('rejects invalid workspace process budgets %j before transport', async budgets => {
    const transport = vi.fn<GuestSearchTransport>(async () => '')
    await expect(guestWorkspaceSearch(binding(), { query: 'foo', excludedPaths: [], includeHidden: false, respectGitignore: true }, signal(),
      { maxEntries: 1, maxResults: 10, timeoutMs: 1000, ...budgets }, transport)).rejects.toMatchObject({ code: 'SEARCH_INVALID_ARGS' })
    expect(transport).not.toHaveBeenCalled()
  })
  it('honors the owning runtime lifetime, not only the tool caller signal', async () => {
    const lifetime = new AbortController(), target = { ...binding(), lifetime: lifetime.signal }
    lifetime.abort(new Error('world stopped'))
    const transport = vi.fn<GuestSearchTransport>(async () => '')
    await expect(guestGlob(target, { pattern: '*' }, signal(), SEARCH_CAPS, transport)).rejects.toThrow('world stopped')
    expect(transport).not.toHaveBeenCalled()
  })
})
