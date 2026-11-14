/** Immutable execution-world contracts shared by commands, filesystem and managed Session routing. */
import { createHash } from 'node:crypto'

export const EXECUTION_CONTRACT_VERSION = 1 as const
export interface RequestedWslTarget { distro: string; user: string; workRoot: string }
export interface GuestIdentity {
  distro: string
  user: string
  uid: number
  home: string
  bootId: string
}
export interface ResolvedWorkspace {
  input: string
  guestPath: string
  hostPath: string
  storage: 'guest-local' | 'windows-local'
  evidence: { converter: 'wslpath'; hostRegistration: 'verified'; hostLocality?: 'local'; fileSystem?: string }
}
export interface ResolvedExecutionTarget extends GuestIdentity {
  kind: 'wsl'
  contractVersion: typeof EXECUTION_CONTRACT_VERSION
  id: string
  generationId: string
  workspace: ResolvedWorkspace
  verifiedAt: string
}
/** Explicit unsets survive JSON persistence; an omitted key must not silently inherit credentials. */
export interface ExecutionEnvironment { set: Readonly<Record<string, string>>; unset: readonly string[] }
export interface ExecutionSnapshot {
  revision: number
  target: ResolvedExecutionTarget
  environment: ExecutionEnvironment
  /** Preserve the deployment's master root when the ticket-directory override points elsewhere. */
  workspaces?: Readonly<{ deployment: ResolvedWorkspace; tickets: ResolvedWorkspace }>
}
/** Typed target/configuration failure suitable for a capability report. */
export class ExecutionTargetError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
export function validateRequestedTarget(input: RequestedWslTarget): RequestedWslTarget {
  const distro = input.distro.trim(), user = input.user.trim(), workRoot = input.workRoot.trim()
  if (!distro || distro.startsWith('-') || /[\x00-\x1f\x7f/\\]/.test(distro)) throw new ExecutionTargetError('TARGET_DISTRO_INVALID', 'A registered WSL distribution name is required')
  if (!user || user.startsWith('-') || /[\s\x00-\x1f\x7f/:\\]/.test(user)) throw new ExecutionTargetError('TARGET_USER_INVALID', 'An existing Linux username is required')
  if (!workRoot || /[\x00-\x1f\x7f]/.test(workRoot) || !(workRoot.startsWith('/') || /^[A-Za-z]:[\\/]/.test(workRoot) || /^\\\\(?:wsl\.localhost|wsl\$)\\/i.test(workRoot))) throw new ExecutionTargetError('WORKSPACE_PATH_INVALID', 'An absolute workspace path is required')
  return { distro, user, workRoot }
}
export function executionTargetId(identity: Pick<GuestIdentity, 'distro' | 'uid'>): string {
  if (!Number.isSafeInteger(identity.uid) || identity.uid < 0) throw new ExecutionTargetError('TARGET_UID_INVALID', 'The guest must report a valid UID')
  return 'wsl:' + createHash('sha256').update(JSON.stringify([identity.distro.toLowerCase(), identity.uid])).digest('hex')
}
export function freezeTarget(identity: GuestIdentity, workspace: ResolvedWorkspace, generationId: string, verifiedAt: string): ResolvedExecutionTarget {
  if (!identity.home.startsWith('/') || !identity.bootId || !generationId) throw new ExecutionTargetError('TARGET_IDENTITY_INCOMPLETE', 'Guest identity and generation must be verified before use')
  if (!workspace.guestPath.startsWith('/') || workspace.evidence.hostRegistration !== 'verified') throw new ExecutionTargetError('WORKSPACE_UNVERIFIED', 'The Host workspace coordinate has not been verified')
  return Object.freeze({ distro: identity.distro, user: identity.user, uid: identity.uid, home: identity.home, bootId: identity.bootId,
    kind: 'wsl', contractVersion: EXECUTION_CONTRACT_VERSION,
    id: executionTargetId(identity), generationId, verifiedAt,
    workspace: Object.freeze({ ...workspace, evidence: Object.freeze({ ...workspace.evidence }) }) })
}
export function environmentSnapshot(values: Record<string, string | undefined>): ExecutionEnvironment {
  const set: Record<string, string> = {}, unset: string[] = []
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new ExecutionTargetError('ENVIRONMENT_KEY_INVALID', 'Invalid execution environment key')
    if (value === undefined) { unset.push(key); continue }
    if (/(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|AUTHORIZATION)/i.test(key)) throw new ExecutionTargetError('ENVIRONMENT_SECRET_REJECTED', 'Credentials must not be persisted in an execution generation')
    set[key] = value
  }
  return Object.freeze({ set: Object.freeze(set), unset: Object.freeze(unset.sort()) })
}
export function commandEnvironment(environment: ExecutionEnvironment): Record<string, string | undefined> {
  return { ...environment.set, ...Object.fromEntries(environment.unset.map(key => [key, undefined])) }
}
export function freezeExecutionSnapshot(revision: number, target: ResolvedExecutionTarget, environment: ExecutionEnvironment, workspaces?: ExecutionSnapshot['workspaces']): ExecutionSnapshot {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new ExecutionTargetError('BINDING_REVISION_INVALID', 'Invalid execution binding revision')
  const pinned = freezeTarget(target, target.workspace, target.generationId, target.verifiedAt)
  if (target.contractVersion !== EXECUTION_CONTRACT_VERSION || target.id !== pinned.id) throw new ExecutionTargetError('TARGET_CONTRACT_INVALID', 'Stored execution target identity does not match its verified fields')
  const roots = workspaces ? Object.freeze({
    deployment: freezeTarget(target, workspaces.deployment, target.generationId, target.verifiedAt).workspace,
    tickets: freezeTarget(target, workspaces.tickets, target.generationId, target.verifiedAt).workspace,
  }) : undefined
  if (roots && (roots.tickets.guestPath !== pinned.workspace.guestPath || roots.tickets.hostPath !== pinned.workspace.hostPath)) throw new ExecutionTargetError('WORKSPACE_SNAPSHOT_CONFLICT', 'Ticket roots must match the verified execution workspace')
  return Object.freeze({ revision, target: pinned, environment: environmentSnapshot(commandEnvironment(environment)), ...roots ? { workspaces: roots } : {} })
}
