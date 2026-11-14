// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import type { AccountBinding } from '../src/app/account-binding.ts'
import type { AccountApplyResult, AccountRefreshResult } from '../src/app/account-refresh.ts'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, all, click, field, type, text, at, tab } from './fixtures/panel.tsx'

usePanel()
const active: AccountBinding = { accountId: '1', repositoryId: '10', login: 'old-bot', repository: 'acme/widgets', cli: '/usr/bin/gh',
  noreply: '1+old-bot@users.noreply.github.com', executionTarget: 'native' }
const observed: AccountBinding = { ...active, accountId: '2', login: 'new-bot' }
let observation: AccountRefreshResult
let application: AccountApplyResult
let requests: { url: string; method: string; body?: unknown }[]
beforeEach(() => {
  at({ page: 'settings', query: { group: 'source' } })
  requests = []
  observation = { ok: true, status: 'changed', active, observed, checkedAt: '2026-11-14T12:00:00Z',
    revisions: { sourceRevision: 0, bindingRevision: 0, runtimeInstance: 'runtime' }, blockers: [], cursorPlan: 'cutover',
    planToken: 'opaque-plan', expiresAt: '2026-11-14T12:02:00Z' }
  application = { ok: true, action: 'applied', activation: 'restart-pending', active: observed,
    cursorPlan: { kind: 'cutover', cutoff: '2026-11-14T12:01:00Z' } }
  const original = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.includes('/accounts/')) return original(url, init)
    requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify(url.endsWith('/refresh') ? observation : application), { status: 200 })
  }))
})

it('never probes on mount and disables refresh for unsaved sensitive fields, not unrelated drafts', async () => {
  await mount()
  expect(requests).toHaveLength(0)
  expect(all('button').filter(button => button.textContent === zh.accountRefresh)).toHaveLength(1)
  await type(field<HTMLInputElement>('智能体的 GitHub CLI'), '/opt/other-gh')
  const refresh = all('button').find(button => button.textContent === zh.accountRefresh)! as HTMLButtonElement
  expect(refresh.disabled).toBe(true)
  expect(text()).toContain(zh.accountRefreshUnsaved)
  await click(zh.discard)
  expect(refresh.disabled).toBe(false)
  await click('运行来源：GitHub')
  expect(refresh.disabled).toBe(false)
})

it('shows active versus observed and detection time, applies only after an explicit modal confirmation', async () => {
  await mount()
  await click(zh.accountRefresh)
  expect(requests).toEqual([{ url: '/orchestrator/api/sources/github/accounts/refresh', method: 'POST', body: undefined }])
  expect(text()).toContain(zh.accountRefreshActive)
  expect(text()).toContain('@old-bot (1)')
  expect(text()).toContain('@new-bot (2)')
  expect(text()).toContain(zh.accountRefreshChecked)
  expect(text()).toContain(zh.accountRefreshCutover)
  expect(requests).toHaveLength(1)
  await click(zh.accountRefreshApply)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(zh.accountRefreshConfirm)
  expect(requests).toHaveLength(1)
  await click(zh.confirm)
  expect(requests[1]).toEqual({ url: '/orchestrator/api/sources/github/accounts/apply', method: 'POST',
    body: { planToken: 'opaque-plan', confirmed: true } })
  expect(text()).toContain(zh.accountRefreshApplied)
  expect(text()).toContain(zh.accountRefreshStillPaused)
  expect(text()).toContain(zh.accountRefreshRestartPending)
  expect(text()).toContain('2026-11-14T12:01:00Z')
  expect(text()).not.toContain(zh.accountRefreshUnchanged)
  expect(text()).not.toContain('@old-bot (1)')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('reports unchanged without any apply action or automatic restart', async () => {
  observation = { ...observation, ok: true, status: 'unchanged', active, observed: active, checkedAt: '2026-11-14T12:00:00Z',
    revisions: { sourceRevision: 0, bindingRevision: 0, runtimeInstance: 'runtime' }, blockers: [], cursorPlan: 'preserve' }
  if (observation.ok) delete observation.planToken
  await mount()
  await click(zh.accountRefresh)
  expect(text()).toContain(zh.accountRefreshUnchanged)
  expect(text()).not.toContain(zh.accountRefreshApply)
  expect(requests).toHaveLength(1)
})

function recoveryObservation(): AccountRefreshResult {
  return { ok: true, status: 'unchanged', active, observed: active, checkedAt: '2026-11-14T12:00:00Z',
    revisions: { sourceRevision: 0, bindingRevision: 0, runtimeInstance: 'runtime' }, blockers: [], cursorPlan: 'preserve',
    requiresConfirmation: true, confirmationReason: 'health-recovery', planToken: 'recovery-plan' }
}

it('keeps an identical-account health hold pending until recovery is explicitly confirmed, and allows cancellation', async () => {
  observation = recoveryObservation()
  application = { ok: true, action: 'recovered', activation: 'active', active, cursorPlan: { kind: 'preserve' } }
  await mount()
  await click(zh.accountRefresh)
  expect(text()).toContain(zh.accountRefreshRecoveryPending)
  expect(text()).toContain(zh.accountRefreshPreserve)
  expect(text()).not.toContain(zh.accountRefreshChanged)
  expect(text()).not.toContain(zh.accountRefreshApply)
  expect(requests).toHaveLength(1)
  await click(zh.accountRefreshRecover)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(zh.accountRefreshRecoveryConfirm)
  await click(zh.cancel)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(requests).toHaveLength(1)
  expect(text()).toContain(zh.accountRefreshRecoveryPending)
  await click(zh.accountRefreshRecover)
  await click(zh.confirm)
  expect(requests[1]).toMatchObject({ method: 'POST', body: { planToken: 'recovery-plan', confirmed: true } })
  expect(text()).toContain(zh.accountRefreshRecovered)
  expect(text()).toContain(zh.accountRefreshStillPaused)
  expect(text()).toContain(zh.accountRefreshRecoveryUnchanged)
  expect(text()).toContain(zh.accountRefreshCursorPreserved)
  expect(text()).not.toContain(zh.accountRefreshUnchanged)
  expect(text()).not.toContain(zh.accountRefreshRestartPending)
  expect(text()).not.toContain(zh.accountRefreshRecover)
  expect(text()).not.toContain(zh.accountRefreshRecoveryPending)
})

it('shows recovery in English and blocks confirmation while business work remains', async () => {
  observation = recoveryObservation()
  if (observation.ok) observation.blockers = [{ code: 'owner-jobs' }]
  await mount(en)
  await click(en.accountRefresh)
  expect(text()).toContain(en.accountRefreshRecoveryPending)
  expect(text()).toContain(en.accountRefreshPreserve)
  expect((all('button').find(button => button.textContent === en.accountRefreshRecover) as HTMLButtonElement).disabled).toBe(true)
  expect(requests).toHaveLength(1)
})

it('shows probe and stale apply errors in the selected locale and discards consumed plans', async () => {
  await mount(en)
  observation = { ok: false, status: 'unavailable', code: 'probe-failed' }
  await click(en.accountRefresh)
  expect(text()).toContain(en['accountRefreshError.probe-failed'])
  observation = { ok: true, status: 'changed', active, observed, checkedAt: '2026-11-14T12:00:00Z',
    revisions: { sourceRevision: 0, bindingRevision: 0, runtimeInstance: 'runtime' }, blockers: [], cursorPlan: 'cutover', planToken: 'plan' }
  await click(en.accountRefresh)
  application = { ok: false, status: 'unavailable', code: 'stale' }
  await click(en.accountRefreshApply)
  await click(en.confirm)
  expect(text()).toContain(en['accountRefreshError.stale'])
  expect(text()).not.toContain(en.accountRefreshApply)
})

it('lists specific localized blockers without raw diagnostics and links to Execution to pause', async () => {
  if (observation.ok) observation.blockers = [{ code: 'pause-required' }, { code: 'open-tickets' },
    { code: 'guest-cleanup-unconfirmed', detail: 'SECRET_RAW_STDERR' }]
  await mount()
  await click(zh.accountRefresh)
  expect(text()).toContain(zh['accountRefreshBlocker.pause-required'])
  expect(text()).toContain(zh['accountRefreshBlocker.open-tickets'])
  expect(text()).toContain(zh['accountRefreshBlocker.guest-cleanup-unconfirmed'])
  expect(text()).not.toContain('SECRET_RAW_STDERR')
  await click(zh.accountRefreshOpenExecution)
  expect(tab(zh['tab.execution']).getAttribute('aria-selected')).toBe('true')
  expect(requests).toHaveLength(1)
})

it('keeps recovery available with existing backlog when the exact-binding recovery gate is clear', async () => {
  observation = recoveryObservation()
  application = { ok: true, action: 'recovered', activation: 'active', active, cursorPlan: { kind: 'preserve' } }
  await mount()
  await click(zh.accountRefresh)
  expect((all('button').find(button => button.textContent === zh.accountRefreshRecover) as HTMLButtonElement).disabled).toBe(false)
  await click(zh.accountRefreshRecover)
  await click(zh.confirm)
  expect(text()).toContain(zh.accountRefreshRecovered)
  expect(text()).toContain(zh.accountRefreshCursorPreserved)
  expect(text()).not.toContain(zh.accountRefreshCursorCutover)
})

it('reports specific final recovery blockers returned by apply instead of a false success', async () => {
  observation = recoveryObservation()
  application = { ok: false, status: 'unavailable', code: 'busy', blockers: [{ code: 'activity-effect' }, { code: 'target-mismatch' }] }
  await mount(en)
  await click(en.accountRefresh)
  await click(en.accountRefreshRecover)
  await click(en.confirm)
  expect(text()).toContain(en['accountRefreshBlocker.activity-effect'])
  expect(text()).toContain(en['accountRefreshBlocker.target-mismatch'])
  expect(text()).not.toContain(en.accountRefreshRecovered)
})

it('reports an immediately active application with its preserved cursor but never as an unchanged probe', async () => {
  application = { ok: true, action: 'applied', activation: 'active', active: observed, cursorPlan: { kind: 'preserve' } }
  await mount()
  await click(zh.accountRefresh)
  await click(zh.accountRefreshApply)
  await click(zh.confirm)
  expect(text()).toContain(zh.accountRefreshApplied)
  expect(text()).toContain(zh.accountRefreshEnvironmentActive)
  expect(text()).toContain(zh.accountRefreshCursorPreserved)
  expect(text()).not.toContain(zh.accountRefreshUnchanged)
  expect(text()).not.toContain(zh.accountRefreshRestartPending)
})

it('disables application when complete host blockers are present', async () => {
  if (observation.ok) observation.blockers = [{ code: 'pending-outbox' }, { code: 'repository-history' }]
  await mount()
  await click(zh.accountRefresh)
  expect(text()).toContain(zh['accountRefreshError.repository-history'])
  expect((all('button').find(button => button.textContent === zh.accountRefreshApply) as HTMLButtonElement).disabled).toBe(true)
  expect(requests).toHaveLength(1)
})
