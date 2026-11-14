/** Session-owned execution lifecycle survives shell-provider reloads and retains per-handle cleanup diagnostics. */
import type { ShellExecution } from '@deepseek-ai/dsh-shell'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Immutable header lineage is trusted provenance, unlike a path or a caller-provided scope root. */
export async function isOrdinarySession(ctx: Context, id: string, signal?: AbortSignal): Promise<boolean> {
  const seen = new Set<string>()
  for (let depth = 0; depth < 64; depth++) {
    signal?.throwIfAborted()
    if (seen.has(id)) return false
    seen.add(id)
    const live = ctx.get('sessions')?.get(id as SessionId)?.header
    const header = live ?? (await ctx.get('sessionPersistence')?.stat(id as SessionId, { signal }))?.header
    if (!header || header.agentPreset === 'wsl-dsh-superagent-worker' || header.agentPreset === 'wsl-dsh-superagent-router') return false
    if (!header.parentSession) return true
    id = header.parentSession
  }
  return false
}
import type { MaintenanceGate } from './maintenance.ts'
import { family } from '../kv.ts'
import type { SessionExecutionRecord } from './registry.ts'
import { posix, win32 } from 'node:path'
import type { ExecutionSnapshot, ResolvedWorkspace } from './target.ts'

/** Pure child coordinates derive only from a verified canonical root, never raw Windows input. */
export function childWorkspace(root: ResolvedWorkspace, ...parts: string[]): { guestCwd: string; hostCwd: string } {
  if (parts.some(part => !part || part === '..' || /[\\/\x00-\x1f]/.test(part))) throw new Error('Invalid managed workspace child name')
  return { guestCwd: posix.join(root.guestPath, ...parts), hostCwd: win32.join(root.hostPath, ...parts) }
}
/** Master root is the verified deployment root, independent of the ticket directory override. */
export function masterWorkspace(snapshot: ExecutionSnapshot): { guestCwd: string; hostCwd: string } {
  return childWorkspace(snapshot.workspaces?.deployment ?? snapshot.target.workspace, '.orchestrator')
}

/** Metadata-only lookup is safe before an Agent/model has been activated. */
export const sessionExecutionKey = family<SessionExecutionRecord>('session-execution:')

/** Root ownership outlives an individual executor generation; only explicit recovery may remove health holds. */
export class SessionExecutionOwner {
  private readonly handles = new Map<ShellExecution, { id: string; cleanupError?: () => unknown; releaseActivity?: () => void }>()
  private readonly failures = new Map<string, unknown>()
  private closed = false
  constructor(private readonly maintenance?: MaintenanceGate, private readonly record?: (ids: readonly string[]) => void) {}
  assertOpen(): void { if (this.closed) throw new Error('Managed Session execution admission is closed'); this.maintenance?.assertOpen() }
  unconfirmed(id: string, error: unknown): void {
    this.failures.set(id, error)
    this.maintenance?.hold(`session-cleanup:${id}`, { code: 'guest-cleanup-unconfirmed', detail: id })
    this.record?.([id])
  }
  own(id: string, handle: ShellExecution, diagnostics?: { cleanupError: () => unknown }): () => void {
    this.assertOpen()
    const entry = { id, cleanupError: diagnostics?.cleanupError, releaseActivity: this.maintenance?.admit('job', id) }
    this.handles.set(handle, entry)
    return () => {
      if (this.handles.get(handle) !== entry) return
      this.handles.delete(handle)
      try { const error = entry.cleanupError?.(); if (error !== undefined) this.unconfirmed(id, error) }
      finally { entry.releaseActivity?.() }
    }
  }
  close(): void { this.closed = true }
  ids(): string[] { return [...new Set([...this.handles.values()].map(value => value.id).concat([...this.failures.keys()]))] }
  async shutdown(): Promise<void> {
    this.close()
    const handles = [...this.handles.keys()], errors: unknown[] = []
    for (const handle of handles) try { handle.kill() } catch { /* Completion and positive cleanup below, not kill's return, prove quiescence. */ }
    const results = await Promise.allSettled(handles.map(async handle => {
      const entry = this.handles.get(handle)
      try { await handle.done }
      catch (error) { if (entry) this.unconfirmed(entry.id, error); throw error }
      try { await handle.result() }
      catch (error) {
        // A completed trusted provider with explicit cleanup diagnostics can report an ordinary spawn/identity failure.
        if (entry?.cleanupError && entry.cleanupError() === undefined) return
        if (entry) this.unconfirmed(entry.id, error)
        throw error
      }
    }))
    for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
    for (const [handle, entry] of this.handles) {
      try { const error = entry.cleanupError?.(); if (error !== undefined) this.unconfirmed(entry.id, error) }
      catch (error) { this.unconfirmed(entry.id, error) }
      this.handles.delete(handle); entry.releaseActivity?.()
    }
    errors.push(...this.failures.values())
    if (errors.length) throw Object.assign(new AggregateError(errors, 'Managed Session execution cleanup failed'), { code: 'WSL_CLEANUP_UNCONFIRMED' })
  }
}
