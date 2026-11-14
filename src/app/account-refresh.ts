/** Manual, credential-free account observation and confirmed maintenance application. No engine or database dependencies. */
import { randomUUID } from 'node:crypto'
import { SETUP_PROBLEMS, type SetupProblem } from '../setup.ts'
import { publicAccountBinding, sameAccountBinding, sameAccountIds, type AccountBinding, type AccountCursorPlan } from './account-binding.ts'

/** The probe adapter reports a sanitized setup code; only confirmed sign-out warrants a health hold. */
export class AccountProbeError extends Error {
  constructor(readonly code: SetupProblem['code'], readonly loginLost = false) { super(code) }
}

export interface AccountRevisions { sourceRevision: number; bindingRevision: number; runtimeInstance: string; environmentRevision?: number }
export interface AccountBlocker { code: string; detail?: string }
/** The host must enumerate ALL admission, assessment, dispatch, worker, reply/outbox and source-poll activity, not just load.running. */
export interface AccountBlockers { paused: boolean; items: AccountBlocker[]; hasHistory: boolean }
export type AccountRefreshError = 'probe-failed' | 'stale' | 'expired' | 'invalid-token' | 'confirmation-required'
  | 'busy' | 'pause-required' | 'repository-history' | 'stage-failed' | 'activation-failed'
export interface AccountRefreshFailure { ok: false; status: 'unavailable'; code: AccountRefreshError; setupCode?: SetupProblem['code']; blockers?: AccountBlocker[] }
export interface AccountObservation {
  ok: true
  status: 'unchanged' | 'changed'
  active: AccountBinding | null
  observed: AccountBinding
  checkedAt: string
  revisions: AccountRevisions
  blockers: AccountBlocker[]
  cursorPlan: 'preserve' | 'cutover'
  requiresConfirmation?: boolean
  confirmationReason?: 'health-recovery'
  /** Opaque, random, in-memory, single-use confirmation ticket. Never a GitHub token. */
  planToken?: string
  expiresAt?: string
}
export type AccountRefreshResult = AccountObservation | AccountRefreshFailure
export interface AccountApplySuccess {
  ok: true
  action: 'recovered' | 'applied'
  active: AccountBinding
  cursorPlan: AccountCursorPlan
  activation: 'active' | 'restart-pending'
}
export type AccountApplyResult = AccountApplySuccess | AccountRefreshFailure
export interface AccountRefreshPorts<SavedSource, Stage> {
  currentSavedSource(): SavedSource
  /** Read-only business GET probe. Must not log in, switch accounts, run setup, poll notifications or request an engine pass. */
  probe(currentSavedSource: SavedSource): Promise<AccountBinding>
  activeBinding(): AccountBinding | null
  revisions(): AccountRevisions
  blockers(): AccountBlockers
  /** A prior health hold requires explicit recovery even if the original binding is observed again.
   * Refresh never clears that hold; only a successful explicit host recovery/application may clear it.
   */
  requiresConfirmation?(): boolean
  /** Same-binding recovery may retain persistent backlog, but must reject real inflight work and ALL other safety holds.
   * Omitting this port falls back to strict blockers; never relax the ordinary identity/environment switch gate.
   */
  recoveryBlockers?(): AccountBlockers
  /** Readonly revalidate the currently accepted binding AND active generation/CLI/target, then clear only the account hold.
   * Host must recheck pause, stop guards, recovery blockers and cleanup marker after every await before clearing the hold.
   * Never stage, persist binding/generation/cursors, restart, request a pass or unpause. Throw without clearing on failure.
   */
  recoverAcceptedBinding?(candidate: AccountBinding): Promise<void>
  /** Exclude settings saves, account applications and new work for the entire callback; never kill existing work. */
  withMaintenance<T>(work: () => Promise<T>): Promise<T>
  /** Stage and verify an isolated environment. Do not change the active environment. Clean failed/abandoned stages. */
  stageEnvironment(candidate: AccountBinding): Promise<Stage>
  /** Release a prepared stage if a later safety recheck or commit refuses it. Idempotent; never alter active state. */
  discardStage?(stage: Stage): Promise<void>
  /** Atomically persist the accepted binding/revision and cursor plan, then activate the stage. Roll back on failure.
   * A cutover must use its cutoff as the new cursor baseline, never replay historical notifications.
   * Recheck quiescence and identity at activation; never auto-resume or restart/kill workers.
   */
  commitAndActivate(stage: Stage, cursorPlan: AccountCursorPlan): Promise<void | { activation: 'active' | 'restart-pending' }>
  /** Optional fail-closed operational health hold, NOT a settings mutation or engine pass. */
  healthHold?(reason: 'identity-drift' | 'login-lost'): void
}
interface Ticket { candidate: AccountBinding; active: AccountBinding | null; revisions: AccountRevisions; expires: number; reason?: 'health-recovery' }
const equalRevisions = (a: AccountRevisions, b: AccountRevisions) => a.sourceRevision === b.sourceRevision
  && a.bindingRevision === b.bindingRevision && a.runtimeInstance === b.runtimeInstance
  && (a.environmentRevision ?? 0) === (b.environmentRevision ?? 0)
const identityDrift = (a: AccountBinding, b: AccountBinding) => !sameAccountIds(a, b) || a.executionTarget !== b.executionTarget
const equalActive = (a: AccountBinding | null, b: AccountBinding | null) => a === null ? b === null : b !== null && sameAccountBinding(a, b)
const fail = (code: AccountRefreshError, blockers?: AccountBlocker[]): AccountRefreshFailure =>
  ({ ok: false, status: 'unavailable', code, ...blockers ? { blockers } : {} })

/** Owns short-lived observation tickets and serializes explicit account changes or exact-binding health recovery through host safety ports. */
export class AccountRefreshService<SavedSource, Stage> {
  private readonly tickets = new Map<string, Ticket>()
  constructor(private readonly ports: AccountRefreshPorts<SavedSource, Stage>, private readonly options: {
    now?: () => number; ttlMs?: number; maxTickets?: number
  } = {}) {}
  private now() { return (this.options.now ?? Date.now)() }
  private probeFailure(error: unknown): AccountRefreshFailure {
    if (error instanceof AccountProbeError && Object.hasOwn(SETUP_PROBLEMS, error.code)) {
      if (error.loginLost) this.ports.healthHold?.('login-lost')
      return { ...fail('probe-failed'), setupCode: error.code }
    }
    return fail('probe-failed')
  }
  private prune() {
    for (const [token, ticket] of this.tickets) if (ticket.expires <= this.now()) this.tickets.delete(token)
    while (this.tickets.size >= Math.max(1, this.options.maxTickets ?? 32)) this.tickets.delete(this.tickets.keys().next().value!)
  }
  private current(ticket: Ticket): AccountRefreshFailure | undefined {
    if (ticket.expires <= this.now()) return fail('expired')
    if (!equalRevisions(ticket.revisions, this.ports.revisions()) || !equalActive(ticket.active, this.ports.activeBinding())) return fail('stale')
  }
  private blockerSnapshot(recovery: boolean): AccountBlockers {
    return recovery && this.ports.recoveryBlockers ? this.ports.recoveryBlockers() : this.ports.blockers()
  }
  private blocked(candidate: AccountBinding, active: AccountBinding | null, recovery = false): AccountRefreshFailure | undefined {
    const blockers = this.blockerSnapshot(recovery)
    if (!blockers.paused) return fail('pause-required')
    if (blockers.items.length) return fail('busy', [...blockers.items])
    if (active && active.repositoryId !== candidate.repositoryId && blockers.hasHistory) return fail('repository-history')
  }
  async refresh(): Promise<AccountRefreshResult> {
    const revisions = { ...this.ports.revisions() }
    const rawActive = this.ports.activeBinding()
    const active = rawActive ? publicAccountBinding(rawActive) : null
    let observed: AccountBinding
    try { observed = publicAccountBinding(await this.ports.probe(this.ports.currentSavedSource())) }
    catch (error) { return this.probeFailure(error) }
    if (!equalRevisions(revisions, this.ports.revisions()) || !equalActive(active, this.ports.activeBinding())) return fail('stale')
    if (active && identityDrift(active, observed)) this.ports.healthHold?.('identity-drift')
    const same = active !== null && sameAccountBinding(active, observed)
    const recovery = same && this.ports.requiresConfirmation?.() === true
    const checkedAt = new Date(this.now()).toISOString()
    const blockers = this.blockerSnapshot(recovery)
    const items = [...blockers.items]
    if (!blockers.paused) items.push({ code: 'pause-required' })
    const forbidden = active !== null && active.repositoryId !== observed.repositoryId && blockers.hasHistory
    if (forbidden) items.push({ code: 'repository-history' })
    const result: AccountObservation = { ok: true, status: same ? 'unchanged' : 'changed', active, observed, checkedAt,
      revisions, blockers: items, cursorPlan: active && sameAccountIds(active, observed) ? 'preserve' : 'cutover',
      requiresConfirmation: !same || recovery, ...(recovery ? { confirmationReason: 'health-recovery' as const } : {}) }
    // Ordinary same identity remains observation only. A held identity gets a recovery ticket, never automatic recovery.
    if ((same && !recovery) || forbidden) return result
    this.prune()
    const token = randomUUID()
    const expires = this.now() + (this.options.ttlMs ?? 120_000)
    this.tickets.set(token, { candidate: { ...observed }, active: active ? { ...active } : null, revisions: { ...revisions }, expires,
      ...(recovery ? { reason: 'health-recovery' as const } : {}) })
    return { ...result, planToken: token, expiresAt: new Date(expires).toISOString() }
  }
  async apply(token: string, confirmed: boolean): Promise<AccountApplyResult> {
    if (confirmed !== true) return fail('confirmation-required')
    const ticket = this.tickets.get(token)
    if (!ticket) return fail('invalid-token')
    // Consume before the first await, so concurrent or retried requests cannot apply twice.
    this.tickets.delete(token)
    const invalid = this.current(ticket)
    if (invalid) return invalid
    const recovery = ticket.reason === 'health-recovery'
    if (recovery && (!ticket.active || !sameAccountBinding(ticket.active, ticket.candidate))) return fail('stale')
    return this.ports.withMaintenance(async (): Promise<AccountApplyResult> => {
      const invalid = this.current(ticket) ?? this.blocked(ticket.candidate, ticket.active, recovery)
      if (invalid) return invalid
      let observed: AccountBinding
      try { observed = publicAccountBinding(await this.ports.probe(this.ports.currentSavedSource())) }
      catch (error) { return this.probeFailure(error) }
      if (!sameAccountBinding(observed, ticket.candidate)) {
        if (identityDrift(observed, ticket.candidate)) this.ports.healthHold?.('identity-drift')
        return fail('stale')
      }
      const changed = this.current(ticket) ?? this.blocked(ticket.candidate, ticket.active, recovery)
      if (changed) return changed
      if (recovery) {
        if (!this.ports.recoverAcceptedBinding) return fail('activation-failed')
        // Recovery never stages or rewrites the accepted binding, generation, or cursor. Final GET still guards external drift.
        let finalObserved: AccountBinding
        try { finalObserved = publicAccountBinding(await this.ports.probe(this.ports.currentSavedSource())) }
        catch (error) { return this.probeFailure(error) }
        if (!sameAccountBinding(finalObserved, ticket.candidate)) {
          if (identityDrift(finalObserved, ticket.candidate)) this.ports.healthHold?.('identity-drift')
          return fail('stale')
        }
        const final = this.current(ticket) ?? this.blocked(ticket.candidate, ticket.active, true)
        if (final) return final
        try { await this.ports.recoverAcceptedBinding({ ...ticket.candidate }) }
        catch { return fail('activation-failed') }
        return { ok: true, action: 'recovered', active: { ...ticket.candidate }, cursorPlan: { kind: 'preserve' }, activation: 'active' }
      }
      let stage: Stage
      try { stage = await this.ports.stageEnvironment({ ...ticket.candidate }) }
      catch { return fail('stage-failed') }
      let activated = false
      try {
        // Staging may await subprocesses; verify external login/target again before committing.
        let finalObserved: AccountBinding
        try { finalObserved = publicAccountBinding(await this.ports.probe(this.ports.currentSavedSource())) }
        catch (error) { return this.probeFailure(error) }
        if (!sameAccountBinding(finalObserved, ticket.candidate)) {
          if (identityDrift(finalObserved, ticket.candidate)) this.ports.healthHold?.('identity-drift')
          return fail('stale')
        }
        const staged = this.current(ticket) ?? this.blocked(ticket.candidate, ticket.active)
        if (staged) return staged
        const cursorPlan: AccountCursorPlan = ticket.active && sameAccountIds(ticket.active, ticket.candidate)
          ? { kind: 'preserve' } : { kind: 'cutover', cutoff: new Date(this.now()).toISOString() }
        let activation: 'active' | 'restart-pending' = 'active'
        try { activation = (await this.ports.commitAndActivate(stage, cursorPlan))?.activation ?? 'active' }
        catch { return fail('activation-failed') }
        activated = true
        return { ok: true, action: 'applied', active: { ...ticket.candidate }, cursorPlan, activation }
      } finally {
        if (!activated) await this.ports.discardStage?.(stage).catch(() => {})
      }
    })
  }
}
