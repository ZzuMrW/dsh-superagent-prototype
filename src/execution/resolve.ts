/** Read-only target resolution. Creating a prospective workspace is an explicit startup/apply operation. */
import { posix } from 'node:path'
import type { Machine } from '../deployment.ts'
import { runWsl } from '../infra/wsl.ts'
import { diagnoseGuest } from './probe.ts'
import { WorkspacePathMapper, pathKind } from './path-mapper.ts'
import { probeHostPath } from './host-path.ts'
import { ExecutionTargetError, type GuestIdentity, type ResolvedWorkspace } from './target.ts'
export interface ResolvedGuest { identity: GuestIdentity; workspace: ResolvedWorkspace; deploymentWorkspace: ResolvedWorkspace; path: string }
export async function resolveGuest(machine: Machine, workspace: string, signal: AbortSignal, prepare = false, onCleanupUnconfirmed?: (error: unknown) => void): Promise<ResolvedGuest> {
  if (!machine.wsl) throw new ExecutionTargetError('TARGET_NOT_WSL', 'An explicit guest is required')
  const state = await probeHostPath(machine.stateDir, signal)
  if (!state.directory || state.locality !== 'local' || !/^[A-Za-z]:[\\/]/.test(state.path)) throw new ExecutionTargetError('HOST_STATE_NOT_LOCAL', 'Host state must reside on a verified local Windows disk')
  const requested = { ...machine.wsl }
  const execute = (argv: string[], requestSignal: AbortSignal, expectedIdentity?: GuestIdentity) =>
    runWsl(machine, { argv, cwd: '/', signal: requestSignal, ...expectedIdentity ? { expectedIdentity } : {}, timeoutMs: 60_000 }).catch(error => {
      if ((error as { code?: unknown } | null)?.code === 'WSL_CLEANUP_UNCONFIRMED') onCleanupUnconfirmed?.(error)
      throw error
    })
  const diagnostic = await diagnoseGuest(requested, argv => execute(argv, signal), signal)
  if (diagnostic.missing.length) throw new ExecutionTargetError('TARGET_TOOLS_MISSING', `Required guest tools are missing: ${diagnostic.missing.join(', ')}`)
  const identity = diagnostic.identity
  const guest = (argv: string[], requestSignal: AbortSignal) => execute(argv, requestSignal, identity)
  const mapper = new WorkspacePathMapper(identity, { guest, host: probeHostPath })
  const verified = new Map<string, ResolvedWorkspace>()
  const mapWorkspace = async (input: string): Promise<ResolvedWorkspace> => {
    if (!['linux', 'windows-drive', 'wsl-unc'].includes(pathKind(input))) throw new ExecutionTargetError('WORKSPACE_PATH_INVALID', 'An absolute workspace coordinate is required')
    const coordinate = await mapper.guestPath(input, '/', signal)
    const guestPath = coordinate === '/' ? '/' : coordinate.replace(/\/+$/, '')
    const cached = verified.get(guestPath)
    if (cached) return cached.input === input ? cached : Object.freeze({ ...cached, input })
    if (prepare) {
      const facts = await mapper.facts(guestPath, '/', signal)
      if (!facts.exists) {
        // Verify an existing ancestor first; explicit apply must not mkdir into an unsupported/network storage world.
        let parent = posix.dirname(facts.path)
        while (!(await mapper.facts(parent, '/', signal)).exists) {
          const next = posix.dirname(parent)
          if (next === parent) throw new ExecutionTargetError('WORKSPACE_PARENT_MISSING', 'No existing workspace ancestor is available')
          parent = next
        }
        await mapper.workspace(parent, signal)
        await guest(['mkdir', '-p', '--', facts.path], signal)
      }
    }
    const resolved = Object.freeze({ ...await mapper.workspace(guestPath, signal), input })
    verified.set(guestPath, resolved)
    verified.set(resolved.guestPath, resolved)
    return resolved
  }
  const deploymentWorkspace = await mapWorkspace(requested.workRoot)
  const mapped = await mapWorkspace(workspace || requested.workRoot)
  // Rebuild PATH from verified guest-native tools, never inherit Windows interop PATH entries.
  const path = [...new Set([diagnostic.tools.git, diagnostic.tools.rg, diagnostic.tools.python3, diagnostic.tools.bash, ...Object.values(diagnostic.tools)].flatMap(value => value ? [value.slice(0, value.lastIndexOf('/'))] : []).concat(['/usr/local/bin', '/usr/bin', '/bin']))].join(':')
  return { identity, workspace: mapped, deploymentWorkspace, path }
}
