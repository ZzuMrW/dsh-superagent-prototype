/** Maps one explicit execution target through its real guest converter and Host registration checks. */
import { posix } from 'node:path'
import { ExecutionTargetError, type GuestIdentity, type ResolvedWorkspace } from './target.ts'

export type PathKind = 'linux' | 'windows-drive' | 'wsl-unc' | 'network-unc' | 'relative' | 'invalid'
export interface GuestPathFacts { path: string; exists: boolean; directory: boolean; fileSystem: string; mountSource: string; device: string; inode: string }
export interface HostPathFacts { path: string; exists: boolean; directory: boolean; locality: 'local' | 'network' | 'unknown' }
export interface PathMappingProbe {
  guest(argv: string[], signal: AbortSignal): Promise<string>
  host(path: string, signal: AbortSignal): Promise<HostPathFacts>
}
export function pathKind(path: string): PathKind {
  if (!path || /[\x00-\x1f\x7f]/.test(path)) return 'invalid'
  if (/^[A-Za-z]:[\\/]/.test(path)) return 'windows-drive'
  if (/^\\\\(?:wsl\.localhost|wsl\$)\\/i.test(path)) return 'wsl-unc'
  if (/^\\\\/.test(path)) return 'network-unc'
  if (path.startsWith('/')) return 'linux'
  return 'relative'
}
function uncGuestPath(path: string, distro: string): string {
  const match = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(\\.*)?$/i.exec(path)
  if (!match || match[1]!.toLowerCase() !== distro.toLowerCase()) throw new ExecutionTargetError('PATH_WRONG_DISTRO', 'Workspace coordinate belongs to another WSL distribution')
  return (match[2] ?? '\\').replaceAll('\\', '/')
}
export const GUEST_PATH_FACTS = String.raw`
import os,sys,json,re,stat
p=os.path.realpath(sys.argv[1]); fs=''; source=''; selected=''
try: info=os.stat(p)
except FileNotFoundError: info=None
def decode(s): return re.sub(r'\\([0-7]{3})',lambda m:chr(int(m.group(1),8)),s)
with open('/proc/self/mountinfo') as f:
 for line in f:
  left,right=line.rstrip().split(' - ',1); parts=left.split(); point=decode(parts[4])
  if (p==point or p.startswith(point.rstrip('/')+'/')) and len(point)>=len(selected):
   selected=point; fields=right.split(); fs=fields[0]; source=decode(fields[1])
print(json.dumps({'path':p,'exists':info is not None,'directory':stat.S_ISDIR(info.st_mode) if info else False,'fileSystem':fs,'mountSource':source,'device':str(info.st_dev) if info else '', 'inode':str(info.st_ino) if info else ''}))
`
/** No persistent state is mutated. The caller supplies a guest probe already bound to distro/user. */
export class WorkspacePathMapper {
  constructor(private readonly identity: Pick<GuestIdentity, 'distro'>, private readonly probe: PathMappingProbe) {}
  async guestPath(input: string, cwd: string, signal: AbortSignal): Promise<string> {
    const kind = pathKind(input)
    if (kind === 'invalid') throw new ExecutionTargetError('PATH_INVALID', 'A path without control characters is required')
    if (kind === 'network-unc') throw new ExecutionTargetError('PATH_NETWORK_UNSUPPORTED', 'Network workspace coordinates are not supported')
    if (kind === 'wsl-unc') return posix.normalize(uncGuestPath(input, this.identity.distro))
    if (kind === 'linux') return posix.normalize(input)
    if (kind === 'relative') {
      if (!cwd.startsWith('/')) throw new ExecutionTargetError('PATH_BASE_INVALID', 'Relative paths require a verified guest base')
      return posix.resolve(cwd, input)
    }
    const mapped = (await this.probe.guest(['wslpath', '-a', '-u', input], signal)).trim()
    if (!mapped.startsWith('/') || /[\x00-\x1f\x7f]/.test(mapped)) throw new ExecutionTargetError('PATH_UNMAPPED', 'The selected distribution did not return a valid guest path')
    return posix.normalize(mapped)
  }
  async facts(input: string, cwd: string, signal: AbortSignal): Promise<GuestPathFacts> {
    const path = await this.guestPath(input, cwd, signal)
    let value: GuestPathFacts
    try { value = JSON.parse(await this.probe.guest(['python3', '-c', GUEST_PATH_FACTS, path], signal)) as GuestPathFacts }
    catch { throw new ExecutionTargetError('PATH_DIAGNOSIS_FAILED', 'The guest path could not be diagnosed') }
    if (!value.path?.startsWith('/') || typeof value.exists !== 'boolean' || typeof value.directory !== 'boolean' || typeof value.fileSystem !== 'string' || typeof value.mountSource !== 'string' || typeof value.device !== 'string' || typeof value.inode !== 'string') {
      throw new ExecutionTargetError('PATH_DIAGNOSIS_INVALID', 'The guest returned incomplete path evidence')
    }
    return value
  }
  /** Workspace roots must exist before Host registration; prospective roots are a preview, not a verified target. */
  async workspace(input: string, signal: AbortSignal): Promise<ResolvedWorkspace> {
    if (!['linux', 'windows-drive', 'wsl-unc'].includes(pathKind(input))) throw new ExecutionTargetError('WORKSPACE_PATH_INVALID', 'Workspace roots require an absolute guest, drive or same-distro UNC path')
    const facts = await this.facts(input, '/', signal)
    if (!facts.exists) throw new ExecutionTargetError('WORKSPACE_MISSING', 'The workspace root does not exist; explicit application must prepare it first')
    if (!facts.directory) throw new ExecutionTargetError('WORKSPACE_NOT_DIRECTORY', 'The workspace root is not a directory')
    const hostPath = (await this.probe.guest(['wslpath', '-a', '-w', facts.path], signal)).trim()
    const hostKind = pathKind(hostPath)
    let storage: ResolvedWorkspace['storage']
    if (hostKind === 'windows-drive') storage = 'windows-local'
    else if (hostKind === 'wsl-unc') {
      uncGuestPath(hostPath, this.identity.distro)
      if (!['ext2', 'ext3', 'ext4', 'btrfs', 'xfs', 'tmpfs', 'overlay'].includes(facts.fileSystem)) throw new ExecutionTargetError('WORKSPACE_FILESYSTEM_UNSUPPORTED', 'The guest filesystem is outside the supported local filesystem matrix')
      storage = 'guest-local'
    } else throw new ExecutionTargetError('HOST_WORKSPACE_UNREGISTERABLE', 'No supported Host workspace coordinate is available')
    let host: HostPathFacts
    try { host = await this.probe.host(hostPath, signal) }
    catch { throw new ExecutionTargetError('HOST_WORKSPACE_UNREGISTERABLE', 'The Host cannot register this guest workspace coordinate') }
    if (!host.exists || !host.directory) throw new ExecutionTargetError('HOST_WORKSPACE_UNREGISTERABLE', 'The Host coordinate must resolve to an existing directory')
    if (storage === 'windows-local' && (host.locality !== 'local' || pathKind(host.path) !== 'windows-drive')) throw new ExecutionTargetError('HOST_WORKSPACE_NOT_LOCAL', 'The Windows workspace must resolve to a verified local disk')
    if (storage === 'guest-local') {
      if (pathKind(host.path) !== 'wsl-unc' || posix.normalize(uncGuestPath(host.path, this.identity.distro)) !== posix.normalize(facts.path)) {
        throw new ExecutionTargetError('HOST_WORKSPACE_IDENTITY_CHANGED', 'The Host resolved a different workspace storage world')
      }
    }
    const reverse = await this.facts(host.path, '/', signal)
    if (!facts.device || !facts.inode || !reverse.exists || facts.device !== reverse.device || facts.inode !== reverse.inode) {
      throw new ExecutionTargetError('HOST_GUEST_IDENTITY_MISMATCH', 'Host registration and guest execution do not address the same directory')
    }
    return Object.freeze({ input, guestPath: facts.path, hostPath: host.path, storage,
      evidence: Object.freeze({ converter: 'wslpath', hostRegistration: 'verified',
        ...storage === 'windows-local' ? { hostLocality: 'local' as const } : {}, fileSystem: facts.fileSystem }) })
  }
}
