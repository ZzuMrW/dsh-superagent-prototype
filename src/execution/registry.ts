/** Trusted Session target records; lookup never activates an Agent or guesses a distro/user from a path. */
import { posix } from 'node:path'
import { ExecutionTargetError, freezeExecutionSnapshot, type ExecutionSnapshot } from './target.ts'

export interface SessionExecutionRecord {
  sessionId: string
  role: 'orchestrator' | 'worker'
  guestCwd: string
  hostCwd: string
  snapshot: ExecutionSnapshot
}
export type SessionTargetLookup = { kind: 'managed'; record: SessionExecutionRecord }
  | { kind: 'unmanaged' }
  | { kind: 'blocked'; code: string }
export interface SessionTargetStore {
  load(sessionId: string): SessionExecutionRecord | undefined | Promise<SessionExecutionRecord | undefined>
  isManagedSession(sessionId: string): boolean | Promise<boolean>
  isCurrent?(record: SessionExecutionRecord): boolean | Promise<boolean>
}
function freezeRecord(record: SessionExecutionRecord): SessionExecutionRecord {
  if (!record.sessionId || !record.guestCwd.startsWith('/') || !record.hostCwd || !['worker', 'orchestrator'].includes(record.role)) {
    throw new ExecutionTargetError('SESSION_BINDING_INVALID', 'A managed Session requires verified guest and Host coordinates')
  }
  return Object.freeze({ ...record, guestCwd: posix.normalize(record.guestCwd),
    snapshot: freezeExecutionSnapshot(record.snapshot.revision, record.snapshot.target, record.snapshot.environment, record.snapshot.workspaces) })
}
/** Registering an environment revision never grants permission to retarget an existing Session. */
export class SessionExecutionRegistry {
  private readonly records = new Map<string, SessionExecutionRecord>()
  constructor(private readonly store?: SessionTargetStore) {}
  register(input: SessionExecutionRecord): () => void {
    const record = freezeRecord(input), current = this.records.get(record.sessionId)
    if (current && (current.snapshot.target.id !== record.snapshot.target.id || current.guestCwd !== record.guestCwd || current.hostCwd !== record.hostCwd)) {
      throw new ExecutionTargetError('SESSION_TARGET_CONFLICT', 'Use a new Session instead of silently changing an existing execution world')
    }
    this.records.set(record.sessionId, record)
    return () => { if (this.records.get(record.sessionId) === record) this.records.delete(record.sessionId) }
  }
  async assertCurrent(record: SessionExecutionRecord): Promise<void> {
    if (this.store?.isCurrent && !await this.store.isCurrent(record)) throw new ExecutionTargetError('SESSION_BINDING_STALE', 'The execution binding must be revalidated before use')
  }
  async lookup(sessionId: string): Promise<SessionTargetLookup> {
    let record = this.records.get(sessionId)
    if (!record) {
      const stored = await this.store?.load(sessionId)
      if (stored) {
        if (stored.sessionId !== sessionId) return { kind: 'blocked', code: 'SESSION_BINDING_IDENTITY_MISMATCH' }
        try { record = freezeRecord(stored) } catch { return { kind: 'blocked', code: 'SESSION_BINDING_INVALID' } }
        this.records.set(sessionId, record)
      }
    }
    if (record) {
      try { await this.assertCurrent(record) }
      catch { return { kind: 'blocked', code: 'SESSION_BINDING_STALE' } }
      return { kind: 'managed', record }
    }
    return await this.store?.isManagedSession(sessionId) ? { kind: 'blocked', code: 'SESSION_BINDING_MISSING' } : { kind: 'unmanaged' }
  }
  list(): readonly SessionExecutionRecord[] { return [...this.records.values()] }
}
