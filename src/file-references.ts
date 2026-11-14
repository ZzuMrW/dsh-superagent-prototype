/** Public file-reference specialization: managed completion never traverses the Windows Host filesystem. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LocalFileReferenceService, DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES, DEFAULT_FILE_SEARCH_MAX_ENTRIES, DEFAULT_FILE_SEARCH_MAX_RESULTS,
  type Config } from '@deepseek-ai/dsh-file-reference-local'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference'
import { lookupWorkspaceSession } from './workspace-files.ts'
import { runWsl } from './infra/wsl.ts'

/** Bounded selected-user BFS and ranking. Symlinks are neither offered nor traversed, including path-query ancestors. */
export const GUEST_FILE_REFERENCES = String.raw`
import os,sys,json,posixpath,stat
p=json.load(sys.stdin); root=p['root']; query=p['query'].replace('\\','/'); excluded=set(p['excluded']); cap=p['maxEntries']; limit=p['maxResults']; entries=[]
def children(path,top=False):
 try:
  with os.scandir(path) as scan:
   result=[]
   for child in scan:
    result.append(child)
    if len(result)>=cap: break
  return sorted(result,key=lambda entry:entry.name)
 except OSError:
  if top: raise
  return []
def admit(base,relative,fragment=None,top=False):
 for child in children(base,top):
  if child.is_symlink(): continue
  name=child.name; path=relative+name
  if fragment is not None and name.startswith('.') and not fragment.startswith('.'): continue
  if child.is_dir(follow_symlinks=False):
   if name in excluded: continue
   entries.append({'path':path,'kind':'directory'})
   if fragment is None: directories.append((child.path,path+'/',depth+1))
  elif child.is_file(follow_symlinks=False): entries.append({'path':path,'kind':'file'})
  if len(entries)>=cap: break
slash=query.rfind('/')
if query=='' or slash>=0:
 directory='' if slash<0 else query[:slash+1]; needle='' if slash<0 else query[slash+1:]; parts=[part for part in directory.split('/') if part not in ('','.')]
 if directory.startswith('/') or any(part=='..' or part in excluded or ':' in part for part in parts): print('[]');sys.exit(0)
 current=root
 for part in parts:
  current=posixpath.join(current,part)
  try: mode=os.lstat(current).st_mode
  except OSError: print('[]');sys.exit(0)
  if not stat.S_ISDIR(mode) or stat.S_ISLNK(mode): print('[]');sys.exit(0)
 admit(current,directory,needle,top=not parts)
else:
 needle=query; directories=[(root,'',0)]; cursor=0
 while cursor<len(directories) and len(entries)<cap:
  base,relative,depth=directories[cursor];cursor+=1
  if depth>256: raise RuntimeError('File-reference discovery exceeded 256 directories of depth')
  admit(base,relative,top=cursor==1)
 if not query.startswith('.') and '/.' not in query: entries=[entry for entry in entries if not any(part.startswith('.') for part in entry['path'].split('/'))]
def score(entry):
 path=entry['path'].lower(); name=path.rsplit('/',1)[-1]; n=needle.lower(); bonus=25 if entry['kind']=='directory' else 0
 if n=='': return 0
 if name==n: return 1000+bonus
 if name.startswith(n): return 900+bonus
 if n in name: return 700+bonus
 if n in path: return 500+bonus
 offset=0;gap=0
 for char in n:
  found=path.find(char,offset)
  if found<0: return None
  gap+=found-offset;offset=found+1
 return 300+max(0,100-gap)+bonus
ranked=[(score(entry),entry) for entry in entries];ranked=[pair for pair in ranked if pair[0] is not None]
ranked.sort(key=lambda pair:(-pair[0],0 if pair[1]['kind']=='directory' else 1,0 if needle=='' else len(pair[1]['path']),pair[1]['path']))
print(json.dumps([entry for _,entry in ranked[:limit]],ensure_ascii=True))
`

/** Original native search/prompt lifecycle remains untouched; only trusted managed Session discovery is replaced. */
export default class SessionFileReferences extends LocalFileReferenceService {
  private readonly guestConfig: Required<Config>
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, config)
    this.guestConfig = { maxResults: config.maxResults ?? DEFAULT_FILE_SEARCH_MAX_RESULTS,
      maxEntries: config.maxEntries ?? DEFAULT_FILE_SEARCH_MAX_ENTRIES,
      excludedDirectories: config.excludedDirectories ?? [...DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES] }
  }
  override async list(agent: Agent, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    signal.throwIfAborted()
    const found = await lookupWorkspaceSession(this.ctx, agent.id, signal)
    if (found.kind === 'unmanaged') return super.list(agent, query, signal)
    if (found.kind !== 'managed' || !found.binding?.snapshot) throw new Error('Managed file-reference execution binding is unavailable or stale')
    const binding = found.binding, snapshot = binding.snapshot!
    if (query.includes('\0') || this.guestConfig.maxEntries > 50000 || this.guestConfig.maxResults > 2000) throw new Error('Managed file-reference discovery requires valid text and bounded limits (50000 entries, 2000 results)')
    await binding.assertCurrent?.()
    const combined = binding.lifetime ? AbortSignal.any([signal, binding.lifetime]) : signal
    const machine = { ...binding.machine, wsl: { ...binding.machine.wsl!, distro: snapshot.target.distro, user: snapshot.target.user } }
    let raw: string
    try {
      raw = await runWsl(machine, { argv: ['python3', '-c', GUEST_FILE_REFERENCES], cwd: found.record.guestCwd,
        stdin: JSON.stringify({ root: found.record.guestCwd, query, excluded: this.guestConfig.excludedDirectories,
          maxEntries: this.guestConfig.maxEntries, maxResults: this.guestConfig.maxResults }),
        expectedIdentity: { uid: snapshot.target.uid, bootId: snapshot.target.bootId }, env: binding.env,
        signal: combined, timeoutMs: 30000, maxBuffer: 2 * 1024 * 1024 })
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'WSL_CLEANUP_UNCONFIRMED') binding.onCleanupUnconfirmed?.(error)
      throw error
    }
    combined.throwIfAborted(); await binding.assertCurrent?.()
    let entries: FileReferenceCandidate[]
    try { entries = JSON.parse(raw) as FileReferenceCandidate[] }
    catch (cause) { throw new Error('Invalid selected-user file-reference response', { cause }) }
    if (!Array.isArray(entries) || entries.length > this.guestConfig.maxResults || entries.some(entry => typeof entry?.path !== 'string'
      || !entry.path || entry.path.includes('\0') || entry.path.startsWith('/') || entry.path.split('/').includes('..') || !['directory', 'file'].includes(entry.kind))) {
      throw new Error('Selected-user file-reference response violates its bounded relative-path contract')
    }
    return entries
  }
}
