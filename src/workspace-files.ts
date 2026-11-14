/** Public WorkspaceFiles specialization: authorization and deployment caps remain in the original Remote service. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import { WorkspaceFiles, type Config, type WorkspaceFileScope, type WorkspaceFileRange, type WorkspaceByteReadOptions, type WorkspaceFileSearchRequest, type WorkspaceFileWatchFrame } from '@deepseek-ai/dsh-api-workspace-files'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import GuestFileSystem, { withGuestFsSession } from './wsl-fs.ts'
import type { SessionExecutionRegistry, SessionExecutionRecord } from './execution/registry.ts'
import type { WslExecutionBinding } from './app/wsl-world.ts'
import { guestWorkspaceSearch, GuestSearchError } from './wsl-tools.ts'
import { isOrdinarySession } from './execution/session-world.ts'

let owner: { registry: SessionExecutionRegistry; binding?: (record: SessionExecutionRecord) => WslExecutionBinding } | undefined
/** An obsolete Runtime's disposer cannot remove a newer metadata resolver. */
export function configureWorkspaceSessionRegistry(registry: SessionExecutionRegistry, binding?: (record: SessionExecutionRecord) => WslExecutionBinding): () => void {
  const value = { registry, binding }; owner = value
  return () => { if (owner === value) owner = undefined }
}

/** Runtime records authorize managed reads; only trusted native header lineage authorizes Host fallback, even before setup. */
export async function lookupWorkspaceSession(ctx: Context, sessionId: string, signal?: AbortSignal) {
  if (owner) {
    const found = await owner.registry.lookup(sessionId)
    if (found.kind === 'managed') return { ...found, binding: owner.binding?.(found.record) }
    if (found.kind === 'blocked') return found
    // An unconfigured Runtime cannot classify every historical or manually selected WSL Session.
    // Absence from its registry is not evidence that the Host filesystem is the correct identity.
  }
  return await isOrdinarySession(ctx, sessionId, signal) ? { kind: 'unmanaged' as const }
    : { kind: 'blocked' as const, code: 'SESSION_BINDING_MISSING' }
}

/** Routing is per request, not a global default filesystem and never an Agent activation. */
export default class SessionWorkspaceFiles extends WorkspaceFiles {
  private readonly route: AsyncLocalStorage<FileSystem>
  private readonly guest: GuestFileSystem
  private readonly searchLimits: Config['search']
  constructor(ctx: Context, config: Config) {
    const route = new AsyncLocalStorage<FileSystem>(), host = ctx.fs
    // Context.extend is public metadata shadowing; no existing service/object is modified.
    const routed = ctx.extend({ get fs() { return route.getStore() ?? host } })
    super(routed, config)
    this.route = route
    this.searchLimits = { ...config.search }
    this.guest = new GuestFileSystem(ctx.isolate('fs'))
  }
  private async dispatch<T>(scope: WorkspaceFileScope, work: (scope: WorkspaceFileScope) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    const found = await lookupWorkspaceSession(this.ctx, scope.sessionId, signal)
    signal?.throwIfAborted()
    if (!found || found.kind === 'blocked') throw new RemoteError('gateway/bad-request', 'Managed workspace identity is unavailable or stale', {})
    if (found.kind === 'unmanaged') return work(scope)
    return this.route.run(this.guest, () => withGuestFsSession(scope.sessionId,
      () => work({ ...scope, workspaceRoot: found.record.guestCwd })))
  }
  // Cordis traceable Services rebind method `this.ctx` to the caller. These owned entry closures
  // deliberately retain the provider's routed construction context; Gateway authorization remains external.
  override read = (workspaceFileScope: WorkspaceFileScope, path: string, range: WorkspaceFileRange, signal: AbortSignal) => {
    return this.dispatch(workspaceFileScope, trusted => super.read(trusted, path, range, signal), signal)
  }
  override readBytes = (workspaceFileScope: WorkspaceFileScope, path: string, options: WorkspaceByteReadOptions, signal: AbortSignal) => {
    return this.dispatch(workspaceFileScope, trusted => super.readBytes(trusted, path, options, signal), signal)
  }
  override stat = (workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal) => {
    return this.dispatch(workspaceFileScope, trusted => super.stat(trusted, path, signal), signal)
  }
  override list = (workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal) => {
    return this.dispatch(workspaceFileScope, trusted => super.list(trusted, path, signal), signal)
  }
  override search = (workspaceFileScope: WorkspaceFileScope, request: WorkspaceFileSearchRequest, signal: AbortSignal) => {
    return this.dispatch(workspaceFileScope, async trusted => {
      if (!this.route.getStore()) return super.search(trusted, request, signal)
      const found = await lookupWorkspaceSession(this.ctx, workspaceFileScope.sessionId, signal)
      if (found?.kind !== 'managed' || !found.binding) throw new RemoteError('workspace-file/search-failed', 'Managed guest search binding is unavailable', {})
      try { return await guestWorkspaceSearch({ ...found.binding, variables: () => ({}) }, request, signal, this.searchLimits) }
      catch (error) {
        if (!(error instanceof GuestSearchError)) throw error
        throw new RemoteError('workspace-file/search-failed', error.message, {}, { cause: error })
      }
    }, signal)
  }
  override changes = (workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): AsyncIterable<WorkspaceFileWatchFrame> => {
    const self = this
    return (async function* () {
      const found = await lookupWorkspaceSession(self.ctx, workspaceFileScope.sessionId, signal)
      if (!found || found.kind !== 'unmanaged') throw new RemoteError('gateway/bad-request', 'Managed guest filesystem change observation is unsupported', {})
      yield* self.hostChanges(workspaceFileScope, path, signal)
    })()
  }
  private hostChanges(scope: WorkspaceFileScope, path: string, signal: AbortSignal) { return super.changes(scope, path, signal) }
}
