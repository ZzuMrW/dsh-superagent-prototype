/** Standard search tools over the explicit guest world, using only public DSH search helpers. */
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { posix } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { WorkspaceFileSearchRequest, WorkspaceFileSearchResult } from '@deepseek-ai/dsh-api-workspace-files'
import { buildGlobCommand, buildGrepCommand, parseGlobArgs, parseGrepArgs, parseGrepMatches, formatGrepMatches,
  presentGlobCall, presentGlobResult, presentGrepCall, presentGrepResult, previewLine, type GrepMatch } from '@deepseek-ai/dsh-tool-fs-search'
import { commandEnvironment } from './execution/target.ts'
import { runWsl, type ExecutionMachine, type WslRequest } from './infra/wsl.ts'
import { wslExecutionFor, type WslExecutionBinding } from './app/wsl-world.ts'

export const inject = ['tools', 'systemPrompt']
export const Config = s.object({ search: s.boolean().default(false) })
export interface WslSearchBinding extends WslExecutionBinding { variables(): Record<string, string> }
export interface GuestSearchCaps { maxPaths: number; maxMatches: number; maxLineBytes: number; maxMetaBytes: number; rawBytes: number; timeoutMs: number }
export const SEARCH_CAPS: GuestSearchCaps = Object.freeze({ maxPaths: 100, maxMatches: 250, maxLineBytes: 1024, maxMetaBytes: 32768, rawBytes: 8 * 1024 * 1024, timeoutMs: 30000 })
export type GuestSearchTransport = (machine: ExecutionMachine, request: WslRequest) => Promise<string>
export interface GlobValue { paths: string[]; total: number; truncated: boolean; spill?: string }
export interface GrepValue { matches: GrepMatch[]; total: number; truncated: boolean; spill?: string }
/** An unreadable target or incomplete raw capture is an error, never an apparently empty successful search. */
export class GuestSearchError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
const SAVE_RESULT = String.raw`
import os,sys,json,stat,tempfile,uuid
q=json.load(sys.stdin); parent=q['parent']
if not parent.startswith('/') or os.path.realpath(parent)!=parent: raise ValueError('unverified result parent')
s=os.stat(parent)
if not stat.S_ISDIR(s.st_mode) or s.st_uid!=os.getuid() or stat.S_IMODE(s.st_mode)&0o077: raise ValueError('result parent must be private and owned')
root=parent+'/search-results'
try: os.mkdir(root,0o700)
except FileExistsError: pass
s=os.lstat(root)
if not stat.S_ISDIR(s.st_mode) or s.st_uid!=os.getuid(): raise ValueError('unsafe result directory')
os.chmod(root,0o700)
fd,path=tempfile.mkstemp(prefix='result-',suffix='.txt',dir=root)
try:
 with os.fdopen(fd,'w',encoding='utf-8',newline='') as f: f.write(q['content'])
 print(path)
except BaseException:
 os.unlink(path); raise
`
function grouped(matches: readonly GrepMatch[]) {
  const files: { path: string; matches: { lineNumber: number; line: string }[] }[] = []
  const index = new Map<string, { lineNumber: number; line: string }[]>()
  for (const item of matches) {
    let entries = index.get(item.path)
    if (!entries) { entries = []; index.set(item.path, entries); files.push({ path: item.path, matches: entries }) }
    entries.push({ lineNumber: item.lineNumber, line: item.line })
  }
  return files
}
const globMeta = (value: GlobValue) => ({ shape: 'paths' as const, paths: value.paths, total: value.total, truncated: value.truncated })
const grepMeta = (value: GrepValue) => ({ shape: 'matches' as const, files: grouped(value.matches), total: value.total, truncated: value.truncated })
function bounded<T>(items: T[], limit: number, meta: (items: T[], truncated: boolean) => unknown, bytes: number): T[] {
  const retained = items.slice(0, limit)
  while (retained.length && Buffer.byteLength(JSON.stringify(meta(retained, retained.length < items.length))) > bytes) retained.pop()
  return retained
}
function relativePath(path: string, cwd: string): string {
  return posix.isAbsolute(path) ? posix.relative(cwd, path) || '.' : path.replace(/^\.\//, '')
}
function signalFor(binding: WslSearchBinding, signal: AbortSignal): AbortSignal {
  return binding.lifetime ? AbortSignal.any([binding.lifetime, signal]) : signal
}
async function command(binding: WslSearchBinding, argv: string[], cwd: string, signal: AbortSignal,
  caps: GuestSearchCaps, transport: GuestSearchTransport, stdin?: string): Promise<string> {
  signal.throwIfAborted()
  const snapshot = binding.snapshot
  if (!snapshot || !binding.guestCwd) throw new GuestSearchError('SEARCH_TARGET_UNAVAILABLE', 'No verified guest search binding')
  await binding.assertCurrent?.()
  signal.throwIfAborted()
  const target = snapshot.target
  const machine = { ...binding.machine, wsl: { distro: target.distro, user: target.user, workRoot: target.workspace.guestPath } }
  try {
    return await transport(machine, { argv, cwd, signal, stdin, timeoutMs: caps.timeoutMs, maxBuffer: caps.rawBytes,
      expectedIdentity: { uid: target.uid, bootId: target.bootId },
      env: { ...commandEnvironment(snapshot.environment), ...binding.env, ...binding.variables(), GH_TOKEN: undefined, GITHUB_TOKEN: undefined } })
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'WSL_CLEANUP_UNCONFIRMED') binding.onCleanupUnconfirmed?.(error)
    throw error
  }
}
async function targetPath(binding: WslSearchBinding, input: string | undefined, signal: AbortSignal): Promise<string> {
  if (!binding.snapshot || !binding.guestCwd) throw new GuestSearchError('SEARCH_TARGET_UNAVAILABLE', 'No verified guest search binding')
  if (input === undefined) return '.'
  if (binding.mapPath) return binding.mapPath(input, signal, binding.guestCwd)
  if (posix.isAbsolute(input)) return posix.normalize(input)
  if (/^[A-Za-z]:|^\\\\/.test(input)) throw new GuestSearchError('SEARCH_PATH_UNMAPPED', 'Host search paths require a verified guest mapper')
  return posix.resolve(binding.guestCwd, input)
}
async function search(binding: WslSearchBinding, argv: string[], signal: AbortSignal, caps: GuestSearchCaps, transport: GuestSearchTransport): Promise<string> {
  try { return await command(binding, ['rg', ...argv], binding.guestCwd!, signal, caps, transport) }
  catch (error) {
    signal.throwIfAborted()
    const status = error as { code?: unknown; stderr?: unknown; stdout?: unknown }
    if (status.code === 1 && !String(status.stderr ?? '').trim()) return String(status.stdout ?? '')
    if (status.code === 'WSL_CLEANUP_UNCONFIRMED') throw error
    if (status.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new GuestSearchError('SEARCH_OUTPUT_LIMIT', 'Guest search output exceeded its raw limit; narrow the query')
    if (error instanceof GuestSearchError) throw error
    throw new GuestSearchError('SEARCH_FAILED', `Guest search failed: ${String(status.stderr ?? '').trim().slice(-2048) || 'verify the target permissions and Linux ripgrep installation'}`)
  }
}
async function spill(binding: WslSearchBinding, content: string, signal: AbortSignal, caps: GuestSearchCaps, transport: GuestSearchTransport): Promise<string | undefined> {
  const config = binding.snapshot?.environment.set.GIT_CONFIG_GLOBAL
  if (!config?.startsWith('/')) return undefined
  try {
    const path = (await command(binding, ['python3', '-c', SAVE_RESULT], binding.guestCwd!, signal, caps, transport,
      JSON.stringify({ parent: posix.dirname(config), content }))).trim()
    return path.startsWith('/') && !path.includes('\n') ? path : undefined
  } catch (error) {
    signal.throwIfAborted()
    if ((error as { code?: unknown })?.code === 'WSL_CLEANUP_UNCONFIRMED') throw error
    return undefined
  }
}
export async function guestGlob(binding: WslSearchBinding, args: { pattern: string; path?: string }, signal: AbortSignal,
  caps: GuestSearchCaps = SEARCH_CAPS, transport: GuestSearchTransport = runWsl): Promise<GlobValue> {
  signal = signalFor(binding, signal)
  const input = parseGlobArgs(args), path = await targetPath(binding, input.path, signal)
  const raw = await search(binding, buildGlobCommand({ ...input, path }), signal, caps, transport)
  const all = raw.split('\n').filter(Boolean).map(value => relativePath(value, binding.guestCwd!))
  const paths = bounded(all, caps.maxPaths, (items, truncated) => globMeta({ paths: items, total: all.length, truncated }), caps.maxMetaBytes)
  const truncated = paths.length < all.length
  const saved = truncated ? await spill(binding, all.join('\n'), signal, caps, transport) : undefined
  signal.throwIfAborted()
  return { paths, total: all.length, truncated, ...saved ? { spill: saved } : {} }
}
export async function guestGrep(binding: WslSearchBinding, args: { pattern: string; path?: string; include?: string }, signal: AbortSignal,
  caps: GuestSearchCaps = SEARCH_CAPS, transport: GuestSearchTransport = runWsl): Promise<GrepValue> {
  signal = signalFor(binding, signal)
  const input = parseGrepArgs(args), path = await targetPath(binding, input.path, signal)
  const raw = await search(binding, buildGrepCommand({ ...input, path }), signal, caps, transport)
  const all = parseGrepMatches(raw).map(item => ({ ...item, path: relativePath(item.path, binding.guestCwd!), line: previewLine(item.line, caps.maxLineBytes) }))
  const matches = bounded(all, caps.maxMatches, (items, truncated) => grepMeta({ matches: items, total: all.length, truncated }), caps.maxMetaBytes)
  const truncated = matches.length < all.length
  const saved = truncated ? await spill(binding, `Found ${all.length} matches\n\n${formatGrepMatches(all)}`, signal, caps, transport) : undefined
  signal.throwIfAborted()
  return { matches, total: all.length, truncated, ...saved ? { spill: saved } : {} }
}
const WORKSPACE_ENUMERATE = String.raw`
import os,sys,json,subprocess,threading
q=json.load(sys.stdin); paths=[]; incomplete=False; stderr=bytearray()
p=subprocess.Popen(['rg']+q['argv'],cwd=q['cwd'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
def errors():
 while True:
  part=p.stderr.read(4096)
  if not part: break
  stderr.extend(part)
  if len(stderr)>q['stderrMaxBytes']: del stderr[:-q['stderrMaxBytes']]
t=threading.Thread(target=errors,daemon=True); t.start()
try:
 pending=bytearray(); total=0; stopped=False
 while not stopped:
  chunk=os.read(p.stdout.fileno(),65536)
  if not chunk: break
  pending.extend(chunk)
  if len(pending)>1048576: incomplete=True; break
  while b'\0' in pending:
   value,_,pending=pending.partition(b'\0'); total+=len(value)
   if len(paths)>=q['maxEntries'] or total>q['maxBytes']: incomplete=True; stopped=True; break
   paths.append(value.decode('utf-8','strict'))
 if incomplete:
  p.terminate()
  try: p.wait(timeout=q['graceMs']/1000)
  except subprocess.TimeoutExpired: p.kill()
 code=p.wait(); t.join(timeout=1)
 if not incomplete and code not in (0,1,2): raise RuntimeError('guest file discovery failed')
 print(json.dumps({'paths':paths,'incomplete':incomplete or code==2},ensure_ascii=True))
finally:
 if p.poll() is None: p.kill(); p.wait()
`
export interface WorkspaceSearchCaps { maxResults: number; maxEntries: number; timeoutMs: number; stderrMaxBytes?: number; graceMs?: number }
/** The standard workspace search contract: listed files and inferred directories, never a Host rg process. */
export async function guestWorkspaceSearch(binding: WslSearchBinding, request: WorkspaceFileSearchRequest, signal: AbortSignal,
  limits: WorkspaceSearchCaps = { maxResults: 512, maxEntries: 100000, timeoutMs: 30000 }, transport: GuestSearchTransport = runWsl): Promise<WorkspaceFileSearchResult> {
  signal = signalFor(binding, signal); signal.throwIfAborted()
  if (!binding.snapshot || !binding.guestCwd) throw new GuestSearchError('SEARCH_TARGET_UNAVAILABLE', 'No verified workspace search binding')
  const query = request.query.trim()
  if (!query || query.includes('\0')) throw new GuestSearchError('SEARCH_INVALID_ARGS', 'A nonempty workspace query is required')
  for (const path of request.excludedPaths) if (!path || path.includes('\0') || posix.isAbsolute(path) || path.split('/').includes('..')) throw new GuestSearchError('SEARCH_INVALID_ARGS', 'Exclusions must be literal workspace-relative names or paths')
  const { maxEntries, maxResults } = limits
  const stderrMaxBytes = limits.stderrMaxBytes ?? 65536, graceMs = limits.graceMs ?? 3000
  if (![maxEntries, maxResults, limits.timeoutMs, stderrMaxBytes, graceMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new GuestSearchError('SEARCH_INVALID_ARGS', 'Workspace search limits must be positive integers')
  const exclude = (path: string) => `--glob=!${path.includes('/') ? '/' : ''}${path.replace(/[\\*?\[\]{}!]/g, '\\$&')}`
  const argv = ['--files', '--sort=path', '--null', '--path-separator=/', ...request.includeHidden ? ['--hidden'] : [],
    ...request.respectGitignore ? [] : ['--no-ignore'], ...['.git', '.svn', '.hg', '.bzr', '.jj', '.sl', ...request.excludedPaths].map(exclude)]
  const raw = await command(binding, ['python3', '-c', WORKSPACE_ENUMERATE], binding.guestCwd, signal,
    { ...SEARCH_CAPS, timeoutMs: limits.timeoutMs }, transport, JSON.stringify({ cwd: binding.guestCwd, argv, maxEntries, maxBytes: 1024 * 1024, stderrMaxBytes, graceMs }))
  let data: { paths: string[]; incomplete: boolean }
  try {
    data = JSON.parse(raw) as typeof data
    if (!Array.isArray(data.paths) || data.paths.some(path => typeof path !== 'string') || typeof data.incomplete !== 'boolean') throw new Error('invalid')
  } catch { throw new GuestSearchError('SEARCH_INVALID_OUTPUT', 'The guest returned invalid workspace discovery data') }
  const needle = query.toLowerCase(), byPath = query.includes('/'), entries = new Map<string, 'file' | 'directory'>()
  const admit = (path: string, kind: 'file' | 'directory') => {
    const value = byPath ? path : posix.basename(path)
    if (value.toLowerCase().includes(needle)) entries.set(path, kind)
  }
  for (const listed of data.paths.slice(0, maxEntries)) {
    const path = listed.replace(/^\.\//, '')
    if (!path || posix.isAbsolute(path) || path.split('/').includes('..')) throw new GuestSearchError('SEARCH_INVALID_OUTPUT', 'Guest discovery escaped its workspace-relative contract')
    admit(path, 'file')
    let parent = posix.dirname(path)
    while (parent !== '.' && parent !== '/') { admit(parent, 'directory'); parent = posix.dirname(parent) }
  }
  const matches = [...entries].map(([path, type]) => ({ path, type })).sort((a, b) => a.path.split('/').length - b.path.split('/').length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  signal.throwIfAborted()
  return { matches: matches.slice(0, maxResults), truncated: matches.length > maxResults, incomplete: data.incomplete || data.paths.length > maxEntries }
}
const recovery = (value: { truncated: boolean; spill?: string }) => !value.truncated ? '' : value.spill
  ? `\n\nFull result stored at: ${value.spill}. Use read to inspect it.` : '\n\nThe complete result could not be saved; narrow the query to see more.'
export async function apply(ctx: Context, config: { search: boolean }): Promise<void> {
  if (!config.search) return
  const binding = (id: string | undefined): WslSearchBinding => {
    const value = wslExecutionFor(id)
    if (!value?.snapshot || !value.guestCwd) throw new GuestSearchError('SEARCH_TARGET_UNAVAILABLE', 'No verified guest search binding')
    return value
  }
  const glob = defineTool({ name: 'glob', description: 'Find guest files matching a glob, including hidden/ignored files, in modification-time order. Returns up to 100 paths and a guest recovery file when capped.',
    parameters: { pattern: { type: 'string', required: true, description: 'Glob pattern to match file paths.' }, path: { type: 'string', description: 'Optional guest, same-distro UNC or local Windows path.' } },
    timeoutMs: SEARCH_CAPS.timeoutMs, isConcurrencySafe: () => true,
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      paths: { type: 'array', required: true, items: { type: 'string' } }, total: { type: 'integer', required: true }, truncated: { type: 'boolean', required: true }, spill: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: (value.total ? value.paths.join('\n') : 'No files found') + (value.truncated ? `\n(Showing ${value.paths.length} of ${value.total} paths)` : '') + recovery(value) }],
      presentationMeta: (_args, value) => globMeta(value) },
    execute: (args, exec) => guestGlob(binding(exec.agent?.id), args, exec.signal), presentCall: presentGlobCall, presentResult: presentGlobResult })
  const grep = defineTool({ name: 'grep', description: 'Search guest file contents with ripgrep syntax. Returns bounded matches grouped by file and a guest recovery file when capped.',
    parameters: { pattern: { type: 'string', required: true, description: 'Ripgrep regular expression.' }, path: { type: 'string', description: 'Guest file/directory, same-distro UNC or local Windows path.' }, include: { type: 'string', description: 'One file glob, not a list or negation.' } },
    timeoutMs: SEARCH_CAPS.timeoutMs, isConcurrencySafe: () => true,
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      matches: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, lineNumber: { type: 'integer', required: true }, line: { type: 'string', required: true } } } },
      total: { type: 'integer', required: true }, truncated: { type: 'boolean', required: true }, spill: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: (value.total ? `Found ${value.matches.length} of ${value.total} matches\n\n${formatGrepMatches(value.matches)}` : 'No matches found') + recovery(value) }],
      presentationMeta: (_args, value) => grepMeta(value) },
    execute: (args, exec) => guestGrep(binding(exec.agent?.id), args, exec.signal), presentCall: presentGrepCall, presentResult: presentGrepResult })
  ctx.tools.register(glob); ctx.tools.register(grep)
  ctx.systemPrompt.section({ name: 'tool:glob', order: ctx.systemPrompt.getSectionOrder('TOOL_GLOB'), text: ({ scope }) => ctx.tools.get('glob', scope) === glob ? 'Use glob, not shell find, to discover guest files by path pattern.' : '' })
  ctx.systemPrompt.section({ name: 'tool:grep', order: ctx.systemPrompt.getSectionOrder('TOOL_GREP'), text: ({ scope }) => ctx.tools.get('grep', scope) === grep ? 'Use grep, not shell grep or rg, to search guest contents; use read for surrounding context.' : '' })
}
