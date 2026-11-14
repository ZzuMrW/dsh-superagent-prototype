/** Explicit guest diagnostics; the caller owns transport and consent for any temporary transport state. */
import { z } from 'zod'
import { ExecutionTargetError, validateRequestedTarget, type GuestIdentity, type RequestedWslTarget } from './target.ts'

export const GUEST_IDENTITY_PROBE = String.raw`
import os,pwd,json,shutil
u=pwd.getpwuid(os.getuid())
with open('/proc/sys/kernel/random/boot_id') as f: boot=f.read().strip()
tools={}
for name in ['python3','sh','bash','git','wslpath','rg']:
 p=shutil.which(name)
 tools[name]=os.path.realpath(p) if p else None
print(json.dumps({'reportedDistro':os.environ.get('WSL_DISTRO_NAME',''),'user':u.pw_name,'uid':u.pw_uid,'home':u.pw_dir,'bootId':boot,'tools':tools}))
`
const result = z.object({ reportedDistro: z.string(), user: z.string().min(1), uid: z.number().int().nonnegative(),
  home: z.string().startsWith('/'), bootId: z.string().min(1), tools: z.record(z.string(), z.string().nullable()) }).strict()
export interface GuestDiagnostic { identity: GuestIdentity; tools: Readonly<Record<string, string | null>>; missing: string[]; warnings: string[] }
export type GuestDiagnosticProbe = (argv: string[], signal: AbortSignal) => Promise<string>
/** A configured user is canonicalized by UID, never replaced with the distro default. */
export async function diagnoseGuest(requested: RequestedWslTarget, probe: GuestDiagnosticProbe, signal: AbortSignal,
  requiredTools: readonly string[] = ['python3', 'sh', 'bash', 'git', 'wslpath', 'rg']): Promise<GuestDiagnostic> {
  const target = validateRequestedTarget(requested)
  let response: z.infer<typeof result>
  try { response = result.parse(JSON.parse(await probe(['python3', '-c', GUEST_IDENTITY_PROBE], signal))) }
  catch { signal.throwIfAborted(); throw new ExecutionTargetError('TARGET_PROBE_FAILED', 'The selected guest identity and tools could not be verified') }
  if (response.reportedDistro && response.reportedDistro.toLowerCase() !== target.distro.toLowerCase()) throw new ExecutionTargetError('TARGET_DISTRO_MISMATCH', 'The transport reached a different distribution')
  if (response.user !== target.user && String(response.uid) !== target.user) throw new ExecutionTargetError('TARGET_USER_MISMATCH', 'The transport reached a different Linux user')
  const tools = Object.fromEntries(Object.entries(response.tools).map(([name, path]) =>
    [name, path && path.startsWith('/') && !/\.(?:exe|cmd|bat)$/i.test(path) ? path : null]))
  return {
    identity: Object.freeze({ distro: target.distro, user: response.user, uid: response.uid, home: response.home, bootId: response.bootId }),
    tools: Object.freeze(tools), missing: requiredTools.filter(name => !tools[name]),
    warnings: response.uid === 0 ? ['ROOT_IS_NOT_A_SANDBOX'] : [],
  }
}
