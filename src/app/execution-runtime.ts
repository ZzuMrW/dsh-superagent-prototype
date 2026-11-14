/** Explicit diagnostics adapter: no Store, private Runtime context, setup/stage or business capability. */
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { z } from 'zod'
import { resolveDeployment, type Machine } from '../deployment.ts'
import { probeHostPath } from '../execution/host-path.ts'
import { WorkspacePathMapper } from '../execution/path-mapper.ts'
import { previewDeployment } from '../execution/preview.ts'
import { diagnoseGuest } from '../execution/probe.ts'
import { resolveGuest } from '../execution/resolve.ts'
import { runWsl, type WslRequest } from '../infra/wsl.ts'
import type { Settings } from '../policy.ts'
import { SETUP_PROBLEMS } from '../setup.ts'
import type { DeploymentCandidate, DeploymentDiagnosis } from './execution-api.ts'

const targetSchema = z.object({ distro: z.string(), user: z.string(), workRoot: z.string() }).strict()
const candidateSchema = z.object({ stateDir: z.string(), wsl: z.union([z.literal(false), targetSchema]),
  executor: z.object({ directory: z.string().default(''), prepare: z.string().default(''), blockedCommands: z.array(z.string()).default([]) }).strict().default({ directory: '', prepare: '', blockedCommands: [] }),
}).strict()
export const deploymentDiagnoseSchema = z.object({ candidate: candidateSchema, network: z.boolean().default(false), confirmWrite: z.boolean().default(false) }).strict()
export interface ExecutionRuntimePorts {
  machine: Machine
  savedSettings(): Settings
  lifetime: AbortSignal
  /** Must reject late admission after Runtime shutdown; all cleanup stays inside this tracked operation. */
  track<T>(work: () => Promise<T>): Promise<T>
  onCleanupUnconfirmed(error: unknown): void
  /** Mutating diagnostics must not bypass health/maintenance gates. Missing port fails closed. */
  withWriteProbe?<T>(work: () => Promise<T>): Promise<T>
}
/** Public low-level adapters permit isolated tests without actual WSL, filesystem or network. */
export interface ExecutionDiagnosticAdapters {
  platform: string
  host: typeof probeHostPath
  resolve: typeof resolveGuest
  run(machine: Machine, request: WslRequest): Promise<string>
  account: typeof resolveDeployment
}
const adapters: ExecutionDiagnosticAdapters = { platform: process.platform, host: probeHostPath, resolve: resolveGuest, run: runWsl, account: resolveDeployment }
const DIAGNOSTIC_DETAILS: Record<string, string> = {
  WORKSPACE_MISSING: '工作根目录尚未创建；需显式应用配置后再诊断。 Workspace has not been created; explicit application is required.',
  ENOENT: 'The configured path or executable does not exist; explicit application may be required.',
  EACCES: 'Permission denied while diagnosing the configured path or executable.',
  EPERM: 'The diagnostic operation was not permitted.',
  ABORT_ERR: 'The diagnostic was cancelled or timed out.',
  HOST_STATE_NOT_LOCAL: 'Host state must be an existing directory on a verified local Windows disk.',
  HOST_WORKSPACE_NOT_LOCAL: 'The Host workspace is not on a verified local disk.',
  HOST_WORKSPACE_UNREGISTERABLE: 'The existing workspace cannot be registered by the Host.',
  HOST_WORKSPACE_IDENTITY_CHANGED: 'The Host workspace storage identity changed.',
  HOST_GUEST_IDENTITY_MISMATCH: 'Host registration and guest execution do not address the same directory.',
  TARGET_IDENTITY_CHANGED: 'The guest identity changed during diagnosis; retry against a stable target.',
  TARGET_PROBE_FAILED: 'The selected distribution, Linux user, UID, HOME and tools could not be verified.',
  TARGET_DISTRO_MISMATCH: 'The transport reached a different distribution.',
  TARGET_USER_MISMATCH: 'The transport reached a different Linux user.',
  TARGET_TOOLS_MISSING: 'Required guest-native tools are missing; inspect the tools listed in this result.',
  TARGET_DISTRO_INVALID: 'The requested distribution name is invalid.',
  TARGET_USER_INVALID: 'The requested Linux user is invalid.',
  WORKSPACE_PATH_INVALID: 'An absolute supported workspace coordinate is required.',
  WORKSPACE_NOT_DIRECTORY: 'The workspace root is not a directory.',
  WORKSPACE_FILESYSTEM_UNSUPPORTED: 'The workspace filesystem is not supported.',
  PATH_WRONG_DISTRO: 'The workspace coordinate belongs to another distribution.',
  PATH_NETWORK_UNSUPPORTED: 'Network workspace coordinates are not supported.',
  PATH_UNMAPPED: 'The selected guest could not map the workspace coordinate.',
  PATH_DIAGNOSIS_FAILED: 'The workspace path could not be diagnosed.',
  PATH_DIAGNOSIS_INVALID: 'The guest returned incomplete path evidence.',
  WRITE_PROBE_UNAVAILABLE: 'A gated write-probe port is required; no write probe was started.',
  WRITE_PROBE_ROOT_UNSAFE: 'The filesystem root cannot be used for a temporary write probe.',
  WRITE_PROBE_CLEANUP_FAILED: 'Temporary probe cleanup was not confirmed. Inspect only the owned diagnostic directory shown in this result; no business files were removed.',
  NETWORK_PROBE_REJECTED: 'Only fixed GitHub GET diagnostics are allowed.',
  WSL_CLEANUP_UNCONFIRMED: 'Guest cleanup could not be confirmed; manual verification is required.',
  DIAGNOSIS_FAILED: 'The diagnostic failed. Inspect the local diagnostic log; raw command output is not exposed here.',
}
/** Never expose CLI stderr, credential-bearing SetupError values, arbitrary error messages or arbitrary codes. */
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && (Object.hasOwn(DIAGNOSTIC_DETAILS, code) || Object.hasOwn(SETUP_PROBLEMS, code))) return code
  if (error instanceof Error && error.name === 'AbortError') return 'ABORT_ERR'
  const stderr = (error as { stderr?: unknown } | null)?.stderr
  if (typeof stderr === 'string' && /PermissionError:|permission denied|access is denied/i.test(stderr)) return 'EACCES'
  return 'DIAGNOSIS_FAILED'
}
const detailOf = (error: unknown): string => {
  const code = codeOf(error)
  return (DIAGNOSTIC_DETAILS[code] ?? (SETUP_PROBLEMS[code as keyof typeof SETUP_PROBLEMS]?.[1] ?? DIAGNOSTIC_DETAILS.DIAGNOSIS_FAILED!).replace(/\{[^}]*\}/g, 'the configured resource')).slice(0, 500)
}

/** Every file operation is confined to an owned child of the already verified, existing workspace. */
const TEMP_PROBE_HEADER = String.raw`
import os,sys,stat,json,uuid
root,nonce,parent,device,inode=sys.argv[1:]
if str(uuid.UUID(nonce))!=nonce or parent=='/' or not parent.startswith('/') or os.path.realpath(parent)!=parent: raise RuntimeError('unsafe diagnostic parent')
name='.dsh-deployment-probe-'+nonce
if root!=os.path.join(parent,name): raise RuntimeError('invalid diagnostic root')
pfd=os.open(parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
ps=os.fstat(pfd)
if str(ps.st_dev)!=device or str(ps.st_ino)!=inode: raise RuntimeError('workspace identity changed')
def opened():
 fd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=pfd)
 s=os.fstat(fd)
 if s.st_uid!=os.getuid(): os.close(fd); raise RuntimeError('foreign diagnostic directory')
 return fd,s
def cleanup(fd,expected,require_owner):
 if require_owner:
  ofd=os.open('owner',os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
  with os.fdopen(ofd) as f:
   s=os.fstat(f.fileno())
   if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or s.st_size>64 or f.read(65)!=nonce: raise RuntimeError('foreign diagnostic owner')
 if set(os.listdir(fd))-{'owner','probe'}: raise RuntimeError('foreign diagnostic contents')
 for child in ['probe','owner']:
  try:
   s=os.stat(child,dir_fd=fd,follow_symlinks=False)
   if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid(): raise RuntimeError('foreign diagnostic file')
   os.unlink(child,dir_fd=fd)
  except FileNotFoundError: pass
 current=os.stat(name,dir_fd=pfd,follow_symlinks=False)
 if not stat.S_ISDIR(current.st_mode) or (current.st_dev,current.st_ino)!=(expected.st_dev,expected.st_ino): raise RuntimeError('diagnostic ownership changed')
 os.rmdir(name,dir_fd=pfd)
`
/** Two known files, 4 KiB payload, no prepare and no workspace/root creation. */
export const TEMP_WRITE_PROBE = TEMP_PROBE_HEADER + String.raw`
os.mkdir(name,0o700,dir_fd=pfd)
fd,info=opened()
try:
 ofd=os.open('owner',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
 with os.fdopen(ofd,'w') as f: f.write(nonce)
 wfd=os.open('probe',os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
 with os.fdopen(wfd,'w+b') as f:
  f.write(b'dshprobe'*512); f.flush(); f.seek(0)
  if f.read(4097)!=b'dshprobe'*512: raise RuntimeError('readback mismatch')
 print(json.dumps({'bytes':4096,'scope':'owned-workspace-child'}))
finally:
 try: cleanup(fd,info,False)
 finally: os.close(fd); os.close(pfd)
`
/** Outer finally also handles cancellation before inner cleanup; missing is clean, foreign is never removed. */
export const TEMP_WRITE_CLEANUP = TEMP_PROBE_HEADER + String.raw`
try:
 try: fd,info=opened()
 except FileNotFoundError: sys.exit(0)
 try: cleanup(fd,info,True)
 finally: os.close(fd)
finally: os.close(pfd)
`
export function createExecutionRuntime(ports: ExecutionRuntimePorts, io: ExecutionDiagnosticAdapters = adapters) {
  const cleanupErrors = new WeakSet<object>()
  const cleanupFailure = (error: unknown) => {
    if (codeOf(error) !== 'WSL_CLEANUP_UNCONFIRMED' || !error || typeof error !== 'object' || cleanupErrors.has(error)) return
    cleanupErrors.add(error); ports.onCleanupUnconfirmed(error)
  }
  const preview = (candidate: unknown) => previewDeployment(candidate)
  const diagnose = (input: unknown): Promise<DeploymentDiagnosis> => {
    ports.lifetime.throwIfAborted()
    return ports.track(async () => {
      ports.lifetime.throwIfAborted()
      const request = deploymentDiagnoseSchema.parse(input), config = request.candidate
      const result: DeploymentDiagnosis = { kind: 'diagnosis', status: 'blocked', ready: false, static: preview(config), checks: [], effects: [], restart: 'not-applied' }
      const pass = (code: string, detail: string) => result.checks.push({ code, status: 'passed', detail })
      const blocked = (code: string, detail: string) => result.checks.push({ code, status: 'blocked', detail })
      if (!result.static.valid) { blocked('CONFIG_INVALID', 'Resolve the static blockers first'); return result }
      if (io.platform !== 'win32' || !config.wsl) { blocked('DIAGNOSIS_UNSUPPORTED', 'This diagnostic adapter supports only Windows Host → WSL; static preview is available for native mode'); return result }
      const machine: Machine = { ...ports.machine, stateDir: config.stateDir, wsl: config.wsl }
      const signal = AbortSignal.any([ports.lifetime, AbortSignal.timeout(120_000)])
      const run = async (argv: string[], requestSignal = signal, identity = result.guest?.identity, env?: Record<string, string | undefined>) => {
        try { return await io.run(machine, { argv, cwd: '/', signal: requestSignal, timeoutMs: 20_000, maxBuffer: 1024 * 1024, ...identity ? { expectedIdentity: identity } : {}, ...env ? { env } : {} }) }
        catch (error) { cleanupFailure(error); throw error }
      }
      result.effects.push('business-read-only', 'transport-may-write-temporary-cancellation-state')
      const check = async (name: string, work: () => Promise<void>) => {
        try { signal.throwIfAborted(); await work(); signal.throwIfAborted(); pass(name, 'Verified by an explicit diagnostic') }
        catch (error) { cleanupFailure(error); blocked(codeOf(error), detailOf(error)) }
      }
      await check('host-state-locality', async () => {
        result.hostState = await io.host(machine.stateDir, signal)
        if (!result.hostState.exists || !result.hostState.directory || result.hostState.locality !== 'local' || !/^[A-Za-z]:[\\/]/.test(result.hostState.path)) throw Object.assign(new Error('Host state must be an existing local Windows directory; a missing directory requires explicit application'), { code: 'HOST_STATE_NOT_LOCAL' })
      })
      await check('guest-identity-tools', async () => {
        result.guest = await diagnoseGuest(config.wsl as Exclude<DeploymentCandidate['wsl'], false>, argv => run(argv), signal)
        if (result.guest.missing.length) throw Object.assign(new Error(`Missing guest-native tools: ${result.guest.missing.join(', ')}`), { code: 'TARGET_TOOLS_MISSING' })
      })
      if (!result.checks.some(check => check.status === 'blocked')) await check('workspace-mapping-registration', async () => {
        const guest = await io.resolve(machine, config.executor.directory || config.wsl && config.wsl.workRoot || '', signal, false, cleanupFailure)
        const observed = result.guest!.identity
        if (guest.identity.distro.toLowerCase() !== observed.distro.toLowerCase() || guest.identity.user !== observed.user || guest.identity.uid !== observed.uid
          || guest.identity.home !== observed.home || guest.identity.bootId !== observed.bootId) throw Object.assign(new Error('The guest identity changed during diagnosis; retry against a stable target'), { code: 'TARGET_IDENTITY_CHANGED' })
        result.workspace = guest.workspace; result.deploymentWorkspace = guest.deploymentWorkspace
        const mapper = new WorkspacePathMapper(guest.identity, { guest: (argv, requestSignal) => run(argv, requestSignal, guest.identity), host: io.host })
        result.mount = await mapper.facts(guest.workspace.guestPath, '/', signal)
      })
      const locallyVerified = !result.checks.some(check => check.status === 'blocked')
      if (request.network && locallyVerified) await check('github-get', async () => {
        result.effects.push('github-cli-may-write-cache')
        const identity = result.guest!.identity
        const deployment = await io.account(machine, ports.savedSettings().sources.github?.config, argv => {
          // Resolver issues fixed /user and /repos GET probes plus local executable checks; never login/switch.
          if (argv[1] === 'api' && !(argv.length === 3 && argv[2] === 'user' || argv.length === 5 && /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(argv[2]!) && argv[3] === '--jq')) throw Object.assign(new Error('Only fixed GitHub GET diagnostics are allowed'), { code: 'NETWORK_PROBE_REJECTED' })
          return run(argv, signal, identity, { HOME: identity.home, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_ENTERPRISE_TOKEN: undefined, GITHUB_ENTERPRISE_TOKEN: undefined,
            GH_CONFIG_DIR: undefined, GH_HOST: undefined, XDG_CONFIG_HOME: undefined, GH_PROMPT_DISABLED: '1' })
        })
        result.network = { repository: deployment.repository, login: deployment.github.login }
      })
      else result.checks.push({ code: 'github-get', status: 'skipped', detail: request.network ? 'Local diagnosis must pass first' : 'Network access was not requested; account readiness is not verified' })
      if (request.confirmWrite && locallyVerified) await check('temporary-write', async () => {
        if (!ports.withWriteProbe) throw Object.assign(new Error('A gated write-probe port is required'), { code: 'WRITE_PROBE_UNAVAILABLE' })
        await ports.withWriteProbe(async () => {
          signal.throwIfAborted()
          const parent = result.workspace!.guestPath
          if (parent === '/') throw Object.assign(new Error('Unsafe probe root'), { code: 'WRITE_PROBE_ROOT_UNSAFE' })
          const nonce = randomUUID(), root = posix.join(parent, `.dsh-deployment-probe-${nonce}`)
          const args = [root, nonce, parent, result.mount!.device, result.mount!.inode]
          result.effects.push('owned-workspace-child-write-probe-4096-bytes')
          result.writeProbe = { directory: root, bytes: 4096, cleanup: 'unconfirmed' }
          try { await run(['python3', '-c', TEMP_WRITE_PROBE, ...args]) }
          finally {
            try { await run(['python3', '-c', TEMP_WRITE_CLEANUP, ...args], AbortSignal.timeout(15_000)); result.writeProbe.cleanup = 'confirmed' }
            catch (error) {
              if (codeOf(error) === 'WSL_CLEANUP_UNCONFIRMED') throw error
              throw Object.assign(new Error('Temporary write probe cleanup was not confirmed'), { code: 'WRITE_PROBE_CLEANUP_FAILED' })
            }
          }
        })
      })
      else result.checks.push({ code: 'temporary-write', status: 'skipped', detail: request.confirmWrite ? 'Local diagnosis must pass first' : 'No temporary write probe was requested' })
      if (!result.checks.some(check => check.status === 'blocked')) {
        result.status = result.network ? 'account-verified' : 'local-verified'
        result.ready = !!result.network
      }
      return result
    })
  }
  return { preview, diagnose }
}
export type ExecutionRuntime = ReturnType<typeof createExecutionRuntime>
