/** Explicit observation/confirmation UI: never probes during mount or background polling. */
import { useEffect, useRef, useState } from 'react'
import type { AccountBinding } from '../app/account-binding.ts'
import type { AccountApplySuccess, AccountObservation, AccountRefreshFailure } from '../app/account-refresh.ts'
import type {} from '../app/account-refresh-api.ts'
import { Button, Icon, Modal } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Hint, KeyValues, When } from './widgets.tsx'

const BLOCKER_CODES = ['pause-required', 'repository-history', 'open-tickets', 'business-backlog', 'old-outbox',
  'pending-business-effects', 'managed-session-discovery-unavailable', 'managed-turn', 'managed-input-pending', 'managed-job',
  'managed-jobs-unavailable', 'guest-cleanup-unconfirmed', 'runtime-stopping', 'account-restart-pending', 'account-health-hold',
  'maintenance-active', 'maintenance-pending', 'activity-source', 'activity-outbound', 'activity-turn', 'activity-job',
  'activity-stopping', 'activity-effect', 'owner-jobs', 'pending-outbox', 'admission-inflight', 'reply-inflight',
  'target-mismatch'] as const

export function AccountRefresh({ id, revision, sensitiveDirty, disabled, reload }: {
  id: string; revision: number; sensitiveDirty: boolean; disabled?: boolean; reload: () => Promise<unknown>
}) {
  const { t, call, navigate } = usePanel()
  const [observation, setObservation] = useState<AccountObservation>()
  const [success, setSuccess] = useState<AccountApplySuccess>()
  const [error, setError] = useState<AccountRefreshFailure>()
  const [checkedAt, setCheckedAt] = useState<string>()
  const [confirming, setConfirming] = useState(false)
  const epoch = useRef(0)
  // Invalidate tickets and in-flight responses when the saved source or sensitive draft changes.
  // Preserve a completed action's receipt across the revision reload; it is not an unchanged probe result.
  useEffect(() => {
    epoch.current++; setObservation(undefined); setError(undefined); setConfirming(false)
    if (sensitiveDirty) setSuccess(undefined)
  }, [revision, sensitiveDirty])
  const failed = (code: AccountRefreshFailure['code']): AccountRefreshFailure => ({ ok: false, status: 'unavailable', code })
  const refresh = useAction(async () => {
    const current = epoch.current
    setError(undefined); setSuccess(undefined)
    try {
      const result = await call('POST sources/:id/accounts/refresh', { id })
      if (current !== epoch.current) return
      setCheckedAt(new Date().toISOString())
      if (result.ok) { setObservation(result); setCheckedAt(result.checkedAt) }
      else { setObservation(undefined); setError(result) }
    } catch { if (current === epoch.current) { setObservation(undefined); setError(failed('probe-failed')) } }
  })
  const apply = useAction(async () => {
    const planToken = observation?.planToken
    if (!planToken || sensitiveDirty || disabled) return
    const current = epoch.current
    try {
      const result = await call('POST sources/:id/accounts/apply', { id, body: { planToken, confirmed: true } })
      if (current !== epoch.current) return
      setConfirming(false)
      // Every apply attempt consumes its ticket. A success is an action receipt, never a fabricated unchanged observation.
      setObservation(undefined)
      if (!result.ok) { setSuccess(undefined); setError(result) }
      else { setSuccess(result); setError(undefined); await reload().catch(() => {}) }
    } catch { if (current === epoch.current) { setConfirming(false); setObservation(undefined); setError(failed('activation-failed')) } }
  })
  const blocked = disabled || sensitiveDirty || refresh.busy || apply.busy
  const recovering = observation?.confirmationReason === 'health-recovery'
  const applyLabel = t(recovering ? 'accountRefreshRecover' : 'accountRefreshApply')
  const blockers = observation?.blockers ?? error?.blockers ?? []
  const binding = (value: AccountBinding | null) => value ? <KeyValues rows={[
    [t('accountRefreshAccount'), `@${value.login} (${value.accountId})`],
    [t('accountRefreshRepository'), `${value.repository} (${value.repositoryId})`],
    [t('accountRefreshCli'), value.cli], [t('accountRefreshTarget'), value.executionTarget],
  ]} /> : <Hint>{t('accountRefreshNoActive')}</Hint>
  const executionLink = <Button size="sm" onClick={() => navigate({ page: 'execution' })}>{t('accountRefreshOpenExecution')}</Button>
  return <div className="dt-form">
    <div className="dt-row-buttons"><Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />}
      disabled={blocked} onClick={() => { void refresh.run() }}>{t('accountRefresh')}</Button>
      {checkedAt && <span className="dt-hint">{t('accountRefreshChecked')} <When at={checkedAt} /></span>}
    </div>
    <Hint>{t(sensitiveDirty ? 'accountRefreshUnsaved' : 'accountRefreshHint')}</Hint>
    {error && <p className="dt-error" role="alert">{t(`accountRefreshError.${error.code}`)}</p>}
    {observation && <div role="status">
      <strong>{t('accountRefreshActive')}</strong>{binding(observation.active)}
      <strong>{t('accountRefreshObserved')}</strong>{binding(observation.observed)}
      <Hint>{t(recovering ? 'accountRefreshRecoveryPending' : observation.status === 'unchanged' ? 'accountRefreshUnchanged' : 'accountRefreshChanged')}</Hint>
      {observation.planToken && <Hint>{t(observation.cursorPlan === 'preserve' ? 'accountRefreshPreserve'
        : 'accountRefreshCutover')}</Hint>}
    </div>}
    {blockers.length > 0 && <div role="status">
      <p className="dt-error">{t('accountRefreshBlockers', { count: blockers.length })}</p>
      <ul>{blockers.map((item, index) => {
        const code = BLOCKER_CODES.find(code => code === item.code)
        return <li key={index}>{t(code ? `accountRefreshBlocker.${code}` : 'accountRefreshBlocker.unknown')}</li>
      })}</ul>
      {executionLink}
    </div>}
    {error?.code === 'pause-required' && blockers.length === 0 && executionLink}
    {observation?.planToken && <Button variant="outline" size="sm" disabled={blocked || blockers.length > 0}
      onClick={() => setConfirming(true)}>{applyLabel}</Button>}
    {success && <div role="status">
      <strong>{t(success.action === 'recovered' ? 'accountRefreshRecovered' : 'accountRefreshApplied')}</strong>
      {binding(success.active)}
      <Hint>{t('accountRefreshStillPaused')}</Hint>
      <Hint>{t(success.action === 'recovered' ? 'accountRefreshRecoveryUnchanged'
        : success.activation === 'restart-pending' ? 'accountRefreshRestartPending' : 'accountRefreshEnvironmentActive')}</Hint>
      <Hint>{success.cursorPlan.kind === 'preserve' ? t('accountRefreshCursorPreserved')
        : t('accountRefreshCursorCutover', { cutoff: success.cursorPlan.cutoff })}</Hint>
      {executionLink}
    </div>}
    <Modal open={confirming} onClose={() => { if (!apply.busy) setConfirming(false) }} title={applyLabel}
      closeLabel={t('close')} description={t(recovering ? 'accountRefreshRecoveryConfirm' : 'accountRefreshConfirm')} footer={<>
        <Button disabled={apply.busy} onClick={() => setConfirming(false)}>{t('cancel')}</Button>
        <Button variant="primary" disabled={blocked || !observation?.planToken} onClick={() => { void apply.run() }}>{t('confirm')}</Button>
      </>} />
  </div>
}
