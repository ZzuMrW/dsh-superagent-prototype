/** Explicit server-side preview and diagnosis of a whitelisted draft; never saves or applies configuration. */
import { useEffect, useRef, useState } from 'react'
import type { DeploymentCandidate, DeploymentDiagnosis, DeploymentPreview } from '../app/execution-api.ts'
import { Button } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText } from './text.ts'
import { Hint, KeyValues, Section } from './widgets.tsx'

export type CandidateMachine = Pick<DeploymentCandidate, 'stateDir' | 'wsl'>
export const candidateMachine = (value: unknown): CandidateMachine => {
  const config = value as { stateDir?: unknown; wsl?: { distro?: unknown; user?: unknown; workRoot?: unknown } | false } | undefined
  const str = (value: unknown) => typeof value === 'string' ? value : ''
  return { stateDir: str(config?.stateDir), wsl: config?.wsl ? { distro: str(config.wsl.distro), user: str(config.wsl.user), workRoot: str(config.wsl.workRoot) } : false }
}
export function ExecutionPreview({ machine, executor }: { machine: CandidateMachine; executor?: DeploymentCandidate['executor'] }) {
  const { t, call } = usePanel()
  const [network, setNetwork] = useState(false), [confirmWrite, setConfirmWrite] = useState(false)
  const [busy, setBusy] = useState(false), running = useRef(false)
  const [error, setError] = useState<string>()
  const [response, setResponse] = useState<{ key: string; value: DeploymentPreview | DeploymentDiagnosis }>()
  const key = JSON.stringify([machine, executor, network, confirmWrite]), current = useRef(key)
  current.current = key
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const run = async (diagnose: boolean) => {
    if (running.current) return
    running.current = true; setBusy(true); setError(undefined)
    const requestKey = key
    try {
      // Deployment config edits use the current machine draft + explicitly saved Executor block, never the full volatile form value.
      const saved = executor ?? (await call('GET settings')).blocks.executor.value
      const candidate: DeploymentCandidate = { ...candidateMachine(machine), executor: { directory: saved.directory ?? '', prepare: saved.prepare ?? '', blockedCommands: [...(saved.blockedCommands ?? [])] } }
      const value = diagnose ? await call('POST deployment/diagnose', { body: { candidate, network, confirmWrite } })
        : await call('POST deployment/preview', { body: candidate })
      if (mounted.current && current.current === requestKey) setResponse({ key: requestKey, value })
    } catch (failure) { if (mounted.current && current.current === requestKey) setError(errorText(failure)) }
    finally { running.current = false; if (mounted.current) setBusy(false) }
  }
  const result = response?.value, stale = response && response.key !== key
  const preview = result?.kind === 'diagnosis' ? result.static : result
  return <Section title={t('executionPreviewTitle')}>
    <Hint>{t(executor ? 'executionPreviewDraft' : 'executionPreviewSavedExecutor')}</Hint>
    <Hint>{t('executionPreviewSafety')}</Hint>
    <KeyValues rows={[[t('deploymentStateDir'), machine.stateDir], [t('executionTargetDistro'), machine.wsl ? machine.wsl.distro : t('executionNative')],
      [t('executionTargetUser'), machine.wsl ? machine.wsl.user : '—'], [t('executionWorkRoot'), machine.wsl ? machine.wsl.workRoot : '—']]} />
    <label className="dt-switch-row"><input type="checkbox" checked={network} disabled={busy} onChange={event => setNetwork(event.target.checked)} />{t('executionPreviewNetwork')}</label>
    <label className="dt-switch-row"><input type="checkbox" checked={confirmWrite} disabled={busy} onChange={event => setConfirmWrite(event.target.checked)} />{t('executionPreviewWrite')}</label>
    <div className="dt-row-buttons" aria-busy={busy}>
      <Button variant="outline" disabled={busy} onClick={() => { void run(false) }}>{t('executionPreviewStatic')}</Button>
      <Button variant="outline" disabled={busy} onClick={() => { void run(true) }}>{t('executionPreviewDiagnose')}</Button>
      {busy && <span role="status">{t('loading')}</span>}
    </div>
    {error && <><p className="dt-error" role="alert">{error}</p><Hint>{t('executionPreviewUnavailable')}</Hint></>}
    {stale && <p className="dt-hint" role="status">{t('executionPreviewStale')}</p>}
    {preview && <div className="dt-form" aria-label={t('executionPreviewResult')}>
      <p role="status">{t(result?.kind === 'diagnosis' ? result.status === 'blocked' ? 'executionPreviewBlocked'
        : result.status === 'account-verified' ? 'executionPreviewAccountVerified' : 'executionPreviewLocalVerified'
        : preview.valid ? 'executionPreviewSyntaxValid' : 'executionPreviewBlocked')}</p>
      <Hint>{t('executionPreviewNotApplied')}</Hint>
      <KeyValues rows={[[t('executionPreviewWorkspace'), preview.paths.workspaceInput], [t('prepareCommand'), preview.prepare.configured ? t('executionPreviewPrepareNotRun') : t('executionPreviewEmptyPrepare')],
        [t('blockedCommands'), preview.blockedCommands.join(', ') || '—']]} />
      <ul className="dt-changes">{[...preview.blockers, ...preview.warnings].map((finding, index) => <li key={index}><code>{finding.code}</code> · {finding.field} · {finding.detail}</li>)}</ul>
      {result?.kind === 'diagnosis' ? <>
        <ul className="dt-changes">{result.checks.map((check, index) => <li key={index}><code>{check.code}</code> · {t(`executionCheck.${check.status}`)} · {check.detail}</li>)}</ul>
        {result.guest && <KeyValues rows={[[t('executionTargetDistro'), result.guest.identity.distro], [t('executionTargetUser'), `${result.guest.identity.user} (UID ${result.guest.identity.uid})`],
          ['HOME', result.guest.identity.home], ...Object.entries(result.guest.tools).map(([name, path]) => [name, path ?? '—'] as [string, string])]} />}
        {result.writeProbe && <><KeyValues rows={[[t('executionPreviewProbeDirectory'), `${result.writeProbe.directory} · ${result.writeProbe.bytes}`]]} />
          <p className={result.writeProbe.cleanup === 'unconfirmed' ? 'dt-error' : 'dt-hint'}>{t(result.writeProbe.cleanup === 'confirmed' ? 'executionPreviewProbeCleaned' : 'executionPreviewProbeUnclean')}</p></>}
        {result.network && <KeyValues rows={[[t('deploymentRepository'), result.network.repository], [t('deploymentAgent'), `@${result.network.login}`]]} />}
        {result.guest?.warnings.length ? <Hint>{result.guest.warnings.join(', ')}</Hint> : null}
        <KeyValues rows={[[t('executionPreviewHostState'), result.hostState ? `${result.hostState.path} (${result.hostState.locality})` : '—'],
          [t('executionPreviewDeploymentGuest'), result.deploymentWorkspace?.guestPath ?? '—'], [t('executionPreviewDeploymentHost'), result.deploymentWorkspace?.hostPath ?? '—'],
          [t('executionPreviewGuestPath'), result.workspace?.guestPath ?? '—'], [t('executionPreviewHostPath'), result.workspace?.hostPath ?? '—'],
          [t('executionPreviewMount'), result.mount ? `${result.mount.fileSystem} · ${result.mount.mountSource}` : '—'],
          [t('executionPreviewActualEffects'), result.effects.join(', ') || '—']]} />
      </> : <Hint>{t('executionPreviewRequired', { checks: preview.requiredChecks.join(', ') })}</Hint>}
      <Hint>{t('executionPreviewPlan', { effects: preview.plannedEffects.join(', ') })}</Hint>
    </div>}
  </Section>
}
