/** Runtime adapter for the pure account service; accepted identities and cursor cutovers share one DB transaction. */
import { randomUUID } from 'node:crypto'
import { KV } from '../kv.ts'
import { AccountProbeError, AccountRefreshService, type AccountBlocker, type AccountBlockers } from './account-refresh.ts'
import { publicAccountBinding, sameAccountBinding, type AccountBinding, type AcceptedAccountBinding, type AccountCursorPlan } from './account-binding.ts'
import { executionBindingTarget, type Setup, type SetupStage } from './setup.ts'
import type { Store } from './store.ts'
import { SetupError } from '../setup.ts'
import type { MaintenanceGate } from '../execution/maintenance.ts'
import { ExecutionTargetError } from '../execution/target.ts'
export interface AccountRuntimeHost {
  store: Store
  setup: Setup
  maintenance: MaintenanceGate
  busy(): AccountBlocker[]
  restart(): void
}
export function accountStoreBlockers(store: Store): AccountBlockers {
  const exists = (sql: string) => !!store.db.prepare(sql).get()
  const items: AccountBlocker[] = []
  if (store.tickets.open().length) items.push({ code: 'open-tickets' })
  if (exists('SELECT 1 FROM thread WHERE active IS NOT NULL LIMIT 1')) items.push({ code: 'business-backlog' })
  if (exists("SELECT 1 FROM outbox WHERE json_extract(value, '$.status') = 'pending' LIMIT 1")) items.push({ code: 'old-outbox' })
  if (exists("SELECT 1 FROM effect WHERE kind != 'notice' LIMIT 1")) items.push({ code: 'pending-business-effects' })
  const hasHistory = ['trigger', 'ticket', 'thread', 'outbox', 'decision'].some(table => exists(`SELECT 1 FROM ${table} LIMIT 1`))
  return { paused: store.settings().paused, items, hasHistory }
}
export function applyAccountCutover(store: Store, cutoff: string): void {
  if (!Number.isFinite(Date.parse(cutoff))) throw new Error('Invalid account cutoff')
  const previous = store.get(KV.github.cutoff)
  const at = previous && Date.parse(previous) > Date.parse(cutoff) ? previous : cutoff
  store.set(KV.github.cutoff, at)
  store.set(KV.github.since, at)
  store.set(KV.github.retries, {})
  for (const name of store.keys(KV.github.stream)) store.delete(name)
  // Do not reset CI revision counters: Trigger IDs remain globally unique across account cutovers.
  // A unique marker also distinguishes two cutovers in one clock tick (or after clock rollback).
  store.set(KV.github.ciBaseline, `${at}:${randomUUID()}`)
}
/** Bridges account observations to persisted bindings, strict environment cutovers, and readonly exact-binding health recovery. */
export class AccountRuntime {
  readonly service: AccountRefreshService<ReturnType<Store['settings']>, SetupStage>
  private readonly instance = randomUUID()
  private releaseHealth?: () => void
  constructor(private readonly host: AccountRuntimeHost) {
    const { store, setup, maintenance } = host
    this.service = new AccountRefreshService({
      currentSavedSource: () => store.settings(),
      probe: async settings => {
        try { return (await setup.observe(settings)).binding }
        catch (error) {
          if (error instanceof SetupError) {
            // The legacy resolver uses signedOut for every failed /user request; a network/abort/5xx is not confirmed sign-out.
            const confirmed = error.code === 'agentCliSignedOut' && /\bHTTP\s*401\b|bad credentials|not logged (?:in|into)|to get started with GitHub CLI|please run[^\n]*gh auth login/i.test(String(error.values.output ?? ''))
            throw new AccountProbeError(error.code, confirmed)
          }
          if (error instanceof ExecutionTargetError) {
            if (/MISMATCH|IDENTITY_CHANGED/.test(error.code)) this.hold('target-identity-drift')
            throw new AccountProbeError('environmentFailed')
          }
          throw error
        }
      },
      activeBinding: () => this.accepted(),
      requiresConfirmation: () => this.releaseHealth !== undefined,
      revisions: () => ({ sourceRevision: store.get(KV.settings.revision) ?? 0, bindingRevision: this.accepted()?.revision ?? 0,
        environmentRevision: store.get(KV.accounts.generation) ?? 0, runtimeInstance: this.instance }),
      blockers: () => this.blockers(),
      recoveryBlockers: () => this.recoveryBlockers(),
      recoverAcceptedBinding: candidate => this.recoverAcceptedBinding(candidate),
      withMaintenance: work => maintenance.exclusive('account-apply', work),
      stageEnvironment: async candidate => {
        try { return await setup.stage(store.settings(), candidate) }
        catch (error) { this.hold('stage-failed'); throw error }
      },
      discardStage: stage => {
        const activation = store.get(KV.accounts.activation)
        // A committed generation remains authoritative even when post-commit publication or restart failed.
        if (stage.snapshot && activation?.generationId === stage.snapshot.target.generationId || stage.directory && activation?.directory === stage.directory) return Promise.resolve()
        return setup.discard(stage)
      },
      commitAndActivate: async (stage, plan) => {
        try {
          const before = this.blockers()
          if (!before.paused || before.items.length) throw new Error('Account activation is not quiescent')
          const observed = await setup.observe(store.settings())
          const candidate = observed.binding
          if (stage.snapshot) {
            const current = observed.guest?.identity, pinned = stage.snapshot.target
            if (!current || current.uid !== pinned.uid || current.bootId !== pinned.bootId || current.home !== pinned.home
              || current.user !== pinned.user || current.distro.toLowerCase() !== pinned.distro.toLowerCase()) throw new Error('Guest identity changed after staging')
          }
          const staged = this.bindingForStage(stage, candidate)
          if (!sameAccountBinding(candidate, staged)) throw new Error('Account changed at activation')
          const final = this.blockers()
          if (!final.paused || final.items.length) throw new Error('Managed work changed during identity revalidation')
          // Legacy records with a known different repository cannot be adopted over historical state.
          const raw = store.get(KV.accounts.accepted)
          if (final.hasHistory && raw?.repository && raw.repository !== candidate.repository && raw.repositoryId !== candidate.repositoryId) throw new Error('Repository history belongs to another identity')
          this.persist(stage, candidate, plan)
          setup.activate(stage)
          this.releaseHealth?.(); this.releaseHealth = undefined
          // Keep all managed admissions closed until the controlled restart revalidates the committed generation.
          maintenance.hold('accounts-restart', { code: 'account-restart-pending' })
          host.restart()
          return { activation: 'restart-pending' as const }
        } catch (error) { this.hold('activation-failed'); throw error }
      },
      healthHold: reason => this.hold(reason),
    })
  }
  private bindingForStage(stage: SetupStage, observed: AccountBinding): AccountBinding {
    return { ...observed, accountId: stage.deployment.userId, repositoryId: stage.deployment.repoId,
      repository: stage.deployment.repository, login: stage.deployment.github.login, cli: stage.deployment.github.cli, noreply: stage.deployment.github.noreply,
      executionTarget: stage.snapshot ? executionBindingTarget(stage.snapshot.target, stage.snapshot.target.workspace, stage.snapshot.workspaces?.deployment) : observed.executionTarget }
  }
  deploymentId(): string {
    const { store } = this.host
    let id = store.get(KV.accounts.deploymentId)
    if (!id) { id = randomUUID(); store.set(KV.accounts.deploymentId, id) }
    return id
  }
  accepted(): AcceptedAccountBinding | null {
    const value = this.host.store.get(KV.accounts.accepted)
    if (!value) return null
    try {
      if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !Number.isFinite(Date.parse(value.acceptedAt))) return null
      return { ...publicAccountBinding(value), revision: value.revision, acceptedAt: value.acceptedAt }
    } catch { return null }
  }
  blockers(): AccountBlockers {
    const saved = accountStoreBlockers(this.host.store)
    const holds = this.host.maintenance.blockers().filter(item => item.code !== 'maintenance-active' && item.code !== 'account-health-hold')
    if (this.host.store.get(KV.runtime.executionCleanup) && !holds.some(item => item.code === 'guest-cleanup-unconfirmed')) holds.push({ code: 'guest-cleanup-unconfirmed', detail: 'Manual verification of guest execution cleanup is required' })
    return { ...saved, items: [...saved.items, ...this.host.maintenance.activityBlockers(), ...holds, ...this.host.busy()] }
  }
  /** Persistent work/inbox may wait; only true inflight activity and safety holds block same-generation recovery. */
  recoveryBlockers(): AccountBlockers {
    const saved = accountStoreBlockers(this.host.store)
    const holds = this.host.maintenance.blockers().filter(item => item.code !== 'maintenance-active' && item.code !== 'account-health-hold')
    if (this.host.store.get(KV.runtime.executionCleanup) && !holds.some(item => item.code === 'guest-cleanup-unconfirmed')) holds.push({ code: 'guest-cleanup-unconfirmed' })
    return { paused: saved.paused, hasHistory: saved.hasHistory,
      items: [...this.host.maintenance.activityBlockers(), ...holds, ...this.host.busy().filter(item => item.code !== 'managed-input-pending')] }
  }
  private async recoverAcceptedBinding(candidate: AccountBinding): Promise<void> {
    const { store, setup } = this.host
    const accepted = this.accepted(), release = this.releaseHealth
    const sourceRevision = store.get(KV.settings.revision), environmentRevision = store.get(KV.accounts.generation)
    const activation = store.get(KV.accounts.activation), snapshot = setup.currentExecutionSnapshot, generation = setup.currentEnvironmentGeneration
    const guard = () => {
      const blockers = this.recoveryBlockers(), current = this.accepted(), active = setup.currentEnvironmentGeneration
      if (!blockers.paused || blockers.items.length || !release || this.releaseHealth !== release || !accepted || !current
        || accepted.revision !== current.revision || !sameAccountBinding(candidate, accepted) || !sameAccountBinding(candidate, current)
        || !generation || !active || generation.directory !== active.directory || setup.currentExecutionSnapshot !== snapshot
        || store.get(KV.settings.revision) !== sourceRevision || store.get(KV.accounts.generation) !== environmentRevision
        || !activation || activation.bindingRevision !== accepted.revision || activation.revision !== environmentRevision
        || JSON.stringify(store.get(KV.accounts.activation)) !== JSON.stringify(activation)) throw new Error('Accepted environment recovery is not safe')
      if (snapshot) {
        if (activation.generationId !== snapshot.target.generationId || activation.revision !== snapshot.revision
          || JSON.stringify(store.get(KV.accounts.execution)) !== JSON.stringify(snapshot)) throw new Error('Active guest generation is not accepted')
      } else if (activation.directory !== generation.directory || store.get(KV.accounts.execution)) throw new Error('Active native generation is not accepted')
    }
    guard()
    await setup.verifyAcceptedEnvironment(candidate, store.settings())
    guard()
    // The only successful recovery mutation is this exact account hold's in-memory disposer.
    release!(); this.releaseHealth = undefined
  }
  hold(reason: string): void {
    this.releaseHealth = this.host.maintenance.hold('accounts', { code: 'account-health-hold', detail: reason })
  }
  acceptStartup(binding: AccountBinding): boolean {
    if (this.host.store.get(KV.runtime.executionCleanup)) return false
    const accepted = this.accepted()
    if (accepted && sameAccountBinding(accepted, binding)) return true
    if (!accepted && !accountStoreBlockers(this.host.store).hasHistory && !this.host.store.get(KV.accounts.accepted)) return true
    this.hold(accepted ? 'startup-identity-drift' : 'legacy-binding-confirmation-required')
    return false
  }
  commitStartup(stage: SetupStage, binding: AccountBinding): void {
    if (this.host.store.get(KV.runtime.executionCleanup)) throw new Error('Guest cleanup requires manual verification')
    this.persist(stage, binding, this.accepted() ? { kind: 'preserve' } : { kind: 'cutover', cutoff: new Date().toISOString() })
  }
  private persist(stage: SetupStage, binding: AccountBinding, plan: AccountCursorPlan): void {
    const { store } = this.host
    const priorRevision = store.get(KV.accounts.accepted)?.revision
    const revision = (Number.isSafeInteger(priorRevision) && priorRevision! >= 0 ? priorRevision! : 0) + 1
    if (!Number.isSafeInteger(revision)) throw new Error('Binding revision exhausted')
    store.atomic(() => {
      store.set(KV.accounts.accepted, { ...publicAccountBinding(binding), revision, acceptedAt: new Date().toISOString() })
      if (stage.snapshot) store.set(KV.accounts.execution, stage.snapshot)
      else store.delete(KV.accounts.execution)
      const environmentRevision = stage.snapshot?.revision ?? (store.get(KV.accounts.generation) ?? 0) + 1
      store.set(KV.accounts.generation, environmentRevision)
      store.set(KV.accounts.activation, { revision: environmentRevision, bindingRevision: revision,
        ...stage.directory ? { directory: stage.directory } : {}, ...stage.snapshot ? { generationId: stage.snapshot.target.generationId } : {} })
      if (plan.kind === 'cutover') applyAccountCutover(store, plan.cutoff)
    })
  }
}
