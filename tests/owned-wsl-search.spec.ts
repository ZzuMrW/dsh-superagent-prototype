/** Guest search always uses the bound execution identity and public fixed rg argv builders. */
import { describe, expect, it, vi } from 'vitest'
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
  it('honors the owning runtime lifetime, not only the tool caller signal', async () => {
    const lifetime = new AbortController(), target = { ...binding(), lifetime: lifetime.signal }
    lifetime.abort(new Error('world stopped'))
    const transport = vi.fn<GuestSearchTransport>(async () => '')
    await expect(guestGlob(target, { pattern: '*' }, signal(), SEARCH_CAPS, transport)).rejects.toThrow('world stopped')
    expect(transport).not.toHaveBeenCalled()
  })
})
