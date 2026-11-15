// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { previewDeployment } from '../src/execution/preview.ts'
import type { DeploymentDiagnosis } from '../src/app/execution-api.ts'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, all, click, field, type, text, at, settle } from './fixtures/panel.tsx'
import { fakeForm, server } from './fixtures/panel-server.ts'

usePanel()
let requests: { url: string; body: unknown }[]
let fail: boolean
let hold: ((response: Response) => void) | undefined
let delayed: boolean
beforeEach(() => {
  at({ page: 'settings', query: { group: 'execution' } })
  requests = []; fail = false; hold = undefined; delayed = false
  const original = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.includes('/deployment/')) return original(url, init)
    const body = JSON.parse(String(init?.body)); requests.push({ url, body })
    if (delayed) return new Promise<Response>(resolve => { hold = resolve })
    if (fail) return new Response(JSON.stringify({ error: 'diagnostic unavailable' }), { status: 503 })
    const value = url.endsWith('/preview') ? previewDeployment(body) : { kind: 'diagnosis', status: 'local-verified', ready: false,
      static: previewDeployment(body.candidate), checks: [{ code: 'github-get', status: 'skipped', detail: 'Not requested' }], effects: ['business-read-only'], restart: 'not-applied' } satisfies DeploymentDiagnosis
    return new Response(JSON.stringify(value), { status: 200 })
  }))
})

it('never diagnoses on mount, defaults network/write off and previews the current unsaved Executor draft', async () => {
  await mount()
  expect(requests).toHaveLength(0)
  expect(all('input[type="checkbox"]').map(input => (input as HTMLInputElement).checked)).toEqual([false, false])
  await type(field('准备命令'), 'NEVER EXECUTE THIS')
  await type(field(zh.executionDirectory), 'C:\\candidate')
  await click(zh.executionPreviewStatic)
  expect(requests[0]?.url).toBe('/orchestrator/api/deployment/preview')
  expect(requests[0]?.body).toMatchObject({ executor: { directory: 'C:\\candidate', prepare: 'NEVER EXECUTE THIS' } })
  expect(Object.keys(requests[0]!.body as object).sort()).toEqual(['executor', 'stateDir', 'wsl'])
  expect(text()).toContain(zh.executionPreviewSyntaxValid)
  expect(text()).toContain(zh.executionPreviewNotApplied)
  expect(text()).toContain(zh.executionPreviewPrepareNotRun)
  expect(requests).toHaveLength(1)
  await click(zh.executionPreviewDiagnose)
  expect(requests[1]?.body).toMatchObject({ network: false, confirmWrite: false })
  expect(text()).toContain(zh.executionPreviewLocalVerified)
  expect(text()).not.toContain(zh.executionPreviewAccountVerified)
})

it('uses explicit checkbox opt-ins and retains readable configuration and result after errors', async () => {
  await mount(en)
  await click(en.executionPreviewStatic)
  await click(all('input[type="checkbox"]')[0]!)
  await click(all('input[type="checkbox"]')[1]!)
  await type(field('Prepare command'), 'retain this unsaved draft')
  fail = true
  await click(en.executionPreviewDiagnose)
  expect(requests[1]?.body).toMatchObject({ network: true, confirmWrite: true })
  expect(text()).toContain('diagnostic unavailable')
  expect(text()).toContain(en.executionPreviewUnavailable)
  expect(text()).not.toContain('Correct Host stateDir')
  expect(text()).not.toContain('enable the management layer')
  expect(field<HTMLTextAreaElement>(en.prepareCommand).value).toBe('retain this unsaved draft')
  expect(text()).toContain(en.executionPreviewStale)
  expect(field<HTMLInputElement>(en.executionDirectory).value).toBe('')
  expect(text()).toContain(en.executionPreviewNotApplied)
})

it('disables duplicate requests while busy and discards responses for an edited draft', async () => {
  await mount()
  delayed = true
  await click(zh.executionPreviewStatic)
  const button = all('button').find(element => element.textContent === zh.executionPreviewStatic) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  await click(button)
  expect(requests).toHaveLength(1)
  await type(field('准备命令'), 'changed while pending')
  await act(async () => { hold!(new Response(JSON.stringify(previewDeployment(requests[0]!.body)), { status: 200 })) })
  await settle()
  expect(button.disabled).toBe(false)
  expect(text()).not.toContain(zh.executionPreviewSyntaxValid)
  expect(field<HTMLTextAreaElement>('准备命令').value).toBe('changed while pending')
})

it('previews effective read-only deployment coordinates, never ordinary fields from a volatile ConfigForm', async () => {
  at({ page: 'settings', query: { group: 'deployment' } })
  const configForm = fakeForm()
  configForm.publish({ value: { promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 } })
  server.form = configForm.form
  server.setup = { ...server.setup, machine: { ...server.setup.machine, stateDir: 'D:\\effective-state',
    wsl: { distro: 'EffectiveDistro', user: 'effective-user', workRoot: '/effective-root' } } }
  await mount()
  expect(requests).toHaveLength(0)
  for (const label of [zh.deploymentStateDir, zh.executionTargetDistro, zh.executionTargetUser, zh.executionWorkRoot])
    expect(field<HTMLInputElement>(label).readOnly).toBe(true)
  const useWsl = all('label').find(label => label.textContent?.includes(zh.executionUseWsl))!.querySelector('input')!
  expect(useWsl).toMatchObject({ disabled: true, checked: true })
  await type(field(zh.deploymentContextPages), '30')
  await click(zh.executionPreviewStatic)
  expect(configForm.mutations).toHaveLength(0)
  expect(requests[0]?.body).toMatchObject({ stateDir: 'D:\\effective-state', wsl: { distro: 'EffectiveDistro', user: 'effective-user', workRoot: '/effective-root' } })
  expect(requests[0]?.body).not.toHaveProperty('promptMaxChars')
  expect(text()).toContain(zh.executionPreviewSyntaxValid)
  expect(text()).toContain(zh.executionPreviewSavedExecutor)
  expect(field<HTMLInputElement>(zh.deploymentStateDir).value).toBe('D:\\effective-state')
})
