// @vitest-environment jsdom
// The Deployment settings and the Plugin Manager page.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { PluginConfig } from '../src/client/deployment.tsx'
import { expect, it, onTestFinished, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, find, tab, click, type, text, field, at, translator } from './fixtures/panel.tsx'
import { server, problemOf, fakeForm } from './fixtures/panel-server.ts'

usePanel()
/** Match Core's volatile-only form projection rather than inventing writable ordinary machine fields. */
function volatileForm(writable = true, accept = true) {
  const value = fakeForm(writable, accept)
  value.publish({ value: { promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 } })
  return value
}
it('saves this machine\'s settings in the Deployment settings through DSH\'s configuration form, without a restart', async () => {
  const { form: editable, mutations } = volatileForm()
  server.form = editable
  await mount()
  await click(tab(zh['tab.settings']))
  await click(find(zh['settingsGroup.deployment'], '.dt-settings-link'))
  expect(text()).toContain('/srv/dsh-superagent')
  // Accounts are on the Source settings; the Plugin Manager page, where those are not at hand, shows them here.
  expect(text()).not.toContain('@agent-bot')
  for (const moved of ['仓库克隆', '工单 worktree 目录', '禁用的命令']) expect(text()).not.toContain(moved)
  expect(text()).toContain(zh.deploymentIntro)
  // A limit applies at once, so a draft of one says only that it is unsaved, even while Assignments run.
  await type(field<HTMLInputElement>(zh.deploymentContextTimeout), '20000')
  expect(document.querySelector('.dt-savebar')?.textContent).toBe(`${zh.draftKept}${zh.discard}${zh.save}`)
  await click(zh.save)
  expect(mutations).toEqual([{ revision: 1, ops: [{ op: 'set', path: ['admissionContextTimeoutMs'], value: 20000 }] }])
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh.saved)
  expect(text()).not.toContain(zh.savedRestarting)
  expect(field<HTMLInputElement>(zh.deploymentContextTimeout).value).toBe('20000')
})

it('keeps a refused Deployment change as a draft, and shows the settings read-only without a writable form', async () => {
  const refusing = volatileForm(true, false)
  server.form = refusing.form
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await type(field<HTMLInputElement>(zh.deploymentPromptMaxChars), '200000')
  await click(zh.save)
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(zh.deploymentRefused)
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).value).toBe('200000')
  server.form = volatileForm(false).form
  await remount()
  expect(text()).toContain(zh.deploymentReadOnly)
  const section = (name: string) => find(name, '.dt-section-name').closest('section')!
  expect(section(zh.deploymentLimits).textContent).toContain(zh.deploymentReadOnly)
  expect(section(zh.deploymentMachine).textContent).not.toContain(zh.deploymentReadOnly)
  server.form = undefined
  await remount()
  expect(text()).toContain('这个 DSH 版本不提供配置表单')
  expect(section(zh.deploymentLimits).textContent).toContain(zh.deploymentNoForms)
  expect(section(zh.deploymentMachine).textContent).not.toContain(zh.deploymentNoForms)
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars)).toMatchObject({ disabled: true, value: '100000' })
  expect(all('button').some(button => button.textContent === '保存')).toBe(false)
})

it('merges a Deployment draft into the values another page saved meanwhile, and writes only what it changed', async () => {
  const { form: shared, mutations } = volatileForm()
  server.form = shared
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await type(field<HTMLInputElement>(zh.deploymentContextPages), '20')
  // The Plugin Manager page saves another field of the same entry meanwhile.
  await act(async () => { await shared.mutate([{ op: 'set', path: ['promptMaxChars'], value: 50000 }], 1) })
  expect(text()).toContain('设置已在别处修改，你的修改已合并到最新版本')
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).value).toBe('50000')
  await click(zh.save)
  expect(mutations.at(-1)).toEqual({ revision: 2, ops: [{ op: 'set', path: ['admissionContextMaxPages'], value: 20 }] })
  expect(shared.getSnapshot().value).toMatchObject({ admissionContextMaxPages: 20, promptMaxChars: 50000 })
})

it('renders the Deployment page with the derived accounts in the Plugin Manager, and no summary', async () => {
  let container = document.createElement('div')
  let root = createRoot(container)
  onTestFinished(() => { act(() => { root.unmount() }); container.remove() })
  // Remount from scratch on each render to match Plugin Manager page navigation.
  const render = async (view: 'page' | 'summary') => {
    act(() => { root.unmount() }); container.remove()
    container = document.createElement('div'); document.body.append(container)
    root = createRoot(container)
    const form = server.form
    await act(async () => { root.render(<PluginConfig t={translator(zh)} view={view} form={form && { state: form.getSnapshot(),
      mutate: form.mutate }} />) })
    await settle()
  }
  await render('summary')
  expect(container.textContent).toBe('')
  server.form = volatileForm().form
  server.setup = { ...server.setup, machine: { ...server.setup.machine,
    wsl: { distro: 'Plugin Distro', user: 'plugin-user', workRoot: '/home/plugin-user/work' } } }
  await render('page')
  expect(field<HTMLInputElement>(zh.executionTargetDistro)).toMatchObject({ value: 'Plugin Distro', readOnly: true })
  expect(field<HTMLInputElement>(zh.executionTargetUser).value).toBe('plugin-user')
  expect(field<HTMLInputElement>(zh.executionWorkRoot).value).toBe('/home/plugin-user/work')
  for (const fact of ['acme/widgets', '@agent-bot', 'Widgets Bot', '账号在 dsh-superagent 面板的来源设置里修改。']) expect(text()).toContain(fact)
  server.setup = { ...server.setup, problem: problemOf('repositoryUnset'), accounts: null }
  await render('page')
  expect(text()).toContain('部署检查未通过：GitHub 来源没有设置监听的仓库。')
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).disabled).toBe(false)
  expect(field<HTMLInputElement>(zh.deploymentStateDir)).toMatchObject({ value: server.setup.machine.stateDir, readOnly: true })
  expect(server.form?.getSnapshot().value).not.toHaveProperty('stateDir')
  expect(text()).toContain(zh.executionMachineRestart)
  server.down = true
  await render('page')
  expect(text()).toContain(zh.hostNotRunning)
})

it('tells a dsh-superagent that is starting from a browser that cannot write on the Deployment page', async () => {
  const { form: shared, publish } = volatileForm()
  server.form = shared
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  const limit = () => field<HTMLInputElement>(zh.deploymentPromptMaxChars)
  expect(limit().disabled).toBe(false)
  // While dsh-superagent restarts, DSH stops serving its entry; the values come back editable once it is served again.
  await act(async () => { publish({ status: 'unavailable' }) })
  expect(text()).toContain(zh.deploymentUnavailable)
  expect(limit().disabled).toBe(true)
  await act(async () => { publish({ status: 'ready' }) })
  expect(limit().disabled).toBe(false)
  await act(async () => { publish({ status: 'ready', writable: false }) })
  expect(text()).toContain(zh.deploymentReadOnly)
})

it('renders effective WSL coordinates read-only with a real volatile-only snapshot and never saves on mount', async () => {
  const projected = volatileForm(); server.form = projected.form
  server.setup = { ...server.setup, machine: { ...server.setup.machine, stateDir: 'D:\\agent-state',
    wsl: { distro: 'Example Distro', user: 'developer', workRoot: '/home/developer/projects' } } }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  for (const [label, value] of [[zh.deploymentStateDir, 'D:\\agent-state'], [zh.executionTargetDistro, 'Example Distro'],
    [zh.executionTargetUser, 'developer'], [zh.executionWorkRoot, '/home/developer/projects']])
    expect(field<HTMLInputElement>(label!)).toMatchObject({ value, readOnly: true, disabled: false })
  const mode = all('input[type="checkbox"]')[0] as HTMLInputElement
  expect(mode).toMatchObject({ checked: true, disabled: true })
  expect(text()).toContain(zh.executionMachineRestart)
  expect(projected.mutations).toEqual([])
  expect(server.requests.filter(request => request.method !== 'GET')).toEqual([])
  expect(document.querySelector('.dt-savebar')).toBeNull()
  await type(field(zh.deploymentContextPages), '25')
  await click(zh.save)
  expect(projected.mutations).toEqual([{ revision: 1, ops: [{ op: 'set', path: ['admissionContextMaxPages'], value: 25 }] }])
})

it('keeps false native mode and updates effective machine coordinates without losing a limit draft', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true }); onTestFinished(() => { vi.useRealTimers() })
  const projected = volatileForm(); server.form = projected.form
  // Unsupported ordinary fields in a foreign form cannot override the effective Runtime machine.
  projected.publish({ value: { ...projected.form.getSnapshot().value, stateDir: 'D:\\ignored', wsl: { distro: 'Wrong', user: 'root', workRoot: '/wrong' } } })
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  expect((all('input[type="checkbox"]')[0] as HTMLInputElement).checked).toBe(false)
  expect(field<HTMLInputElement>(zh.deploymentStateDir).value).toBe('/srv/dsh-superagent')
  await type(field(zh.deploymentPromptMaxChars), '200000')
  server.setup = { ...server.setup, machine: { ...server.setup.machine, stateDir: 'D:\\new-state',
    wsl: { distro: 'New Distro', user: 'worker', workRoot: '/home/worker/work' } } }
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000) }); await settle()
  expect(field<HTMLInputElement>(zh.deploymentStateDir).value).toBe('D:\\new-state')
  expect(field<HTMLInputElement>(zh.executionTargetUser).value).toBe('worker')
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).value).toBe('200000')
  expect(projected.mutations).toEqual([])
})

it('rebases loading to ready and preserves explicit empty or zero values instead of refilling them', async () => {
  const projected = volatileForm(); server.form = projected.form
  projected.publish({ status: 'loading', value: { promptMaxChars: 0, admissionContextMaxPages: '' } })
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars)).toMatchObject({ disabled: true, value: '100000' })
  await act(async () => { projected.publish({ status: 'ready' }) })
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars)).toMatchObject({ disabled: false, value: '0' })
  expect(field<HTMLInputElement>(zh.deploymentContextPages).value).toBe('')
  expect(field<HTMLInputElement>(zh.deploymentContextTimeout).value).toBe('15000')
  await type(field(zh.deploymentPromptMaxChars), '')
  await act(async () => { projected.publish({ value: { promptMaxChars: 50000, admissionContextMaxPages: 20 }, revision: 2 }) })
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).value).toBe('')
  expect(field<HTMLInputElement>(zh.deploymentContextPages).value).toBe('20')
  expect(projected.mutations).toEqual([])
})

it('does not submit a retained limits draft while the form is read-only or unavailable', async () => {
  const projected = volatileForm(); server.form = projected.form
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await type(field(zh.deploymentPromptMaxChars), '200000')
  for (const state of [{ status: 'ready' as const, writable: false }, { status: 'unavailable' as const }]) {
    await act(async () => { projected.publish(state) })
    expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).value).toBe('200000')
    expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).disabled).toBe(true)
    expect(document.querySelector('.dt-savebar')).toBeNull()
    await act(async () => { document.querySelector<HTMLFormElement>('form.dt-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await settle()
    expect(projected.mutations).toEqual([])
  }
  expect(find(zh.deploymentLimits, '.dt-section-name').closest('section')!.textContent).toContain(zh.deploymentUnavailable)
  expect(find(zh.deploymentMachine, '.dt-section-name').closest('section')!.textContent).not.toContain(zh.deploymentUnavailable)
  await act(async () => { projected.publish({ status: 'ready', writable: true }) })
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).value).toBe('200000')
  await click(zh.save)
  expect(projected.mutations).toEqual([{ revision: 1, ops: [{ op: 'set', path: ['promptMaxChars'], value: 200000 }] }])
})

it('reads the state every second after a setup check, until dsh-superagent stopped answering and answers again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset'), accounts: null }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await click(zh.setupCheck)
  const second = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(1000) }); await settle() }
  server.down = true
  await second()
  expect(text()).toContain(zh['setup.agentCliUnset'])
  server.down = false
  server.setup = { ...server.setup, problem: null }
  await second()
  expect(text()).not.toContain(zh['setup.agentCliUnset'])
  // Once it answers, the state is read every five seconds again.
  const reads = server.requests.filter(request => request.path === 'state').length
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) }); await settle()
  expect(server.requests.filter(request => request.path === 'state')).toHaveLength(reads)
})

it('ends a restart that never stopped answering after half a minute, and reads the state every five seconds again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset'), accounts: null }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await click(zh.setupCheck)
  const reads = () => server.requests.filter(request => request.path === 'state').length
  const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }); await settle() }
  const before = reads()
  await advance(10_000)
  expect(reads() - before).toBeGreaterThanOrEqual(8)
  // The restart ends at 30 s; the state is read at once, then every five seconds.
  await advance(21_000)
  const ended = reads()
  await advance(3_000)
  expect(reads()).toBe(ended)
  await advance(2_000)
  expect(reads()).toBe(ended + 1)
})
