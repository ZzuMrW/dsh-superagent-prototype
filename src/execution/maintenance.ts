/** Admission gate for managed work; probes can observe it without cancelling or mutating existing work. */
export type ManagedActivity = 'source' | 'outbound' | 'turn' | 'job' | 'stopping' | 'effect'
export interface MaintenanceBlocker { code: string; detail?: string }
/** Managed work was not admitted; this error does not stop work already in flight. */
export class MaintenanceBlockedError extends Error {
  constructor(readonly blockers: readonly MaintenanceBlocker[]) { super('Managed execution is blocked by maintenance or unresolved health') }
}
/** One process-local gate owns admissions and serializes explicit environment applications. */
export class MaintenanceGate {
  private readonly holds = new Map<string, { reason: MaintenanceBlocker }>()
  private readonly activities = new Map<symbol, { kind: ManagedActivity; label?: string }>()
  private maintenance?: { label: string }
  private tail: Promise<void> = Promise.resolve()
  private exclusiveCount = 0
  private admissionClosers = 0
  private readonly idleWaiters = new Set<() => void>()
  private notifyIdle(): void {
    if (this.activities.size || this.exclusiveCount) return
    const waiters = [...this.idleWaiters]; this.idleWaiters.clear()
    for (const resolve of waiters) resolve()
  }
  /** Await outside exclusive(): holds do not delay, but admitted work and queued applications must settle. */
  idle(): Promise<void> {
    if (!this.activities.size && !this.exclusiveCount) return Promise.resolve()
    return new Promise(resolve => { this.idleWaiters.add(resolve) })
  }

  blockers(): MaintenanceBlocker[] {
    return [...this.holds.values()].map(value => ({ ...value.reason }))
      .concat(this.maintenance ? [{ code: 'maintenance-active', detail: this.maintenance.label }]
        : this.admissionClosers ? [{ code: 'maintenance-pending' }] : [])
  }
  assertOpen(): void {
    const blockers = this.blockers()
    if (blockers.length) throw new MaintenanceBlockedError(blockers)
  }
  /** An old disposer cannot clear a replacement health hold. */
  hold(id: string, reason: MaintenanceBlocker): () => void {
    const value = { reason: { ...reason } }
    this.holds.set(id, value)
    return () => { if (this.holds.get(id) === value) this.holds.delete(id) }
  }
  /** Record an admitted operation before it begins; completion must release it in finally. */
  admit(kind: ManagedActivity, label?: string): () => void {
    this.assertOpen()
    const token = Symbol(kind)
    this.activities.set(token, { kind, label })
    return () => { this.activities.delete(token); this.notifyIdle() }
  }
  activityBlockers(): MaintenanceBlocker[] {
    return [...this.activities.values()].map(activity => ({ code: `activity-${activity.kind}`, ...activity.label ? { detail: activity.label } : {} }))
  }
  snapshot() {
    return { blocked: this.blockers(), activities: [...this.activities.values()].map(value => ({ ...value })) }
  }
  /** Metadata commits share the writer mutex without pretending that safe policy sync is environment maintenance. */
  serialize<T>(label: string, work: () => Promise<T>): Promise<T> { return this.exclusive(label, work, false) }
  /** Queued applications re-check their revisions after acquiring this gate; no force/cancel path exists. */
  async exclusive<T>(label: string, work: () => Promise<T>, closeAdmission = true): Promise<T> {
    this.exclusiveCount++
    if (closeAdmission) this.admissionClosers++
    const previous = this.tail
    let release!: () => void
    const next = new Promise<void>(resolve => { release = resolve })
    this.tail = previous.then(() => next)
    await previous
    const owner = { label }
    if (closeAdmission) this.maintenance = owner
    try { return await work() }
    finally {
      if (this.maintenance === owner) this.maintenance = undefined
      if (closeAdmission) this.admissionClosers--
      this.exclusiveCount--; release(); this.notifyIdle()
    }
  }
}
