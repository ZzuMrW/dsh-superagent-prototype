// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { InfoTip, Modal, SegmentedTabs } from '../src/client/controls.tsx'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

it.each([
  { host: 'root', overlay: '', resolvedTop: '0px', anchorTop: 100, expectedTop: 52 },
  { host: 'root', overlay: '', resolvedTop: '0px', anchorTop: 40, expectedTop: 68 },
  { host: 'root', overlay: '20px', resolvedTop: '20px', anchorTop: 100, expectedTop: 52 },
  { host: 'root', overlay: '68px', resolvedTop: '68px', anchorTop: 100, expectedTop: 128 },
  { host: 'root', overlay: 'calc(var(--dsh-frame-top-clearance) + 20px)', resolvedTop: '68px', anchorTop: 100, expectedTop: 128 },
  { host: 'body', overlay: 'calc(var(--dsh-frame-top-clearance) + 20px)', resolvedTop: '68px', anchorTop: 100, expectedTop: 128 },
  { host: 'body', overlay: '68px', resolvedTop: '68px', anchorTop: 10, expectedTop: 68 },
  { host: 'body', overlay: '8px', resolvedTop: '8px', anchorTop: 0, expectedTop: 28 },
  { host: 'root', overlay: '68px', resolvedTop: '68px', anchorTop: 116, expectedTop: 68 },
  { host: 'root', overlay: '', resolvedTop: 'auto', anchorTop: 100, expectedTop: 52 },
])('positions tooltips using browser-resolved top: $host $overlay at $anchorTop', async ({ host, overlay, resolvedTop, anchorTop, expectedTop }) => {
  const owner = host === 'root' ? document.documentElement : document.body
  const previousStyle = owner.getAttribute('style')
  owner.style.setProperty('--dsh-frame-top-clearance', '48px')
  if (overlay) owner.style.setProperty('--dsh-frame-overlay-top', overlay)
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const computedStyle = window.getComputedStyle.bind(window)
  const styles = vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
    const style = computedStyle(element)
    if (element.getAttribute('role') === 'tooltip') {
      expect((element as HTMLElement).style.top).toBe('var(--dsh-frame-overlay-top, 0px)')
      expect((element as HTMLElement).style.visibility).toBe('hidden')
      style.top = resolvedTop
    }
    return style
  })
  const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.getAttribute('role') === 'tooltip'
      ? new DOMRect(0, 0, 100, 40) : new DOMRect(100, anchorTop, 20, 20)
  })
  try {
    await act(async () => { root.render(<InfoTip text='Details' />) })
    await act(async () => { container.querySelector('button')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    const tooltip = document.querySelector<HTMLElement>('[role=tooltip]')!
    expect(tooltip.parentElement).toBe(document.body)
    expect(tooltip.style.top).toBe(`${expectedTop}px`)
    expect(tooltip.style.left).toBe('60px')
    expect(tooltip.style.visibility).toBe('visible')
  } finally {
    act(() => { root.unmount() })
    container.remove(); bounds.mockRestore(); styles.mockRestore()
    if (previousStyle === null) owner.removeAttribute('style')
    else owner.setAttribute('style', previousStyle)
  }
})

it('imports no DSH client runtime package, only React and type declarations', () => {
  const dir = join(process.cwd(), 'src/client')
  for (const name of readdirSync(dir)) {
    const source = readFileSync(join(dir, name), 'utf8')
    for (const match of source.matchAll(/^import (type )?[^'"]*from '(@deepseek-ai\/[^']+)'/gm)) expect({ name, from: match[2], typeOnly: !!match[1] }).toMatchObject({ typeOnly: true })
    expect(source).not.toContain('dsh-client-ui-primitives\'')
  }
})

it('imports each module of the panel only from modules that do not import it back', () => {
  const dir = join(process.cwd(), 'src/client')
  const graph = new Map(readdirSync(dir).filter(name => /\.tsx?$/.test(name)).map(name => [name, [...readFileSync(join(dir, name), 'utf8')
    .matchAll(/^import [^'"]*from '\.\/([\w-]+\.tsx?)'/gm)].map(match => match[1]!)]))
  const done = new Set<string>(), cycles: string[] = []
  const visit = (name: string, path: string[]): void => {
    if (path.includes(name)) { cycles.push([...path.slice(path.indexOf(name)), name].join(' → ')); return }
    if (done.has(name)) return
    for (const next of graph.get(name) ?? []) visit(next, [...path, name])
    done.add(name)
  }
  for (const name of graph.keys()) visit(name, [])
  expect(cycles).toEqual([])
})

it('describes the management API in a module the panel can bundle, which imports types only', () => {
  const source = readFileSync(join(process.cwd(), 'src/app/api.ts'), 'utf8')
  expect([...source.matchAll(/^import (type )?/gm)].every(match => match[1])).toBe(true)
})

it('closes the dialog on Escape and returns focus to the opener', async () => {
  function Harness() {
    const [open, setOpen] = useState(false)
    return <><button type="button" onClick={() => setOpen(true)}>open</button><Modal open={open} onClose={() => setOpen(false)} title="Title" closeLabel="Close">body</Modal></>
  }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<Harness />) })
  const opener = container.querySelector('button')!
  opener.focus()
  await act(async () => { opener.click() })
  expect(document.activeElement?.getAttribute('role')).toBe('dialog')
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(opener)
  act(() => { root.unmount() })
})

it('keeps the focus inside the dialog when its parent re-renders, and Tab and Shift+Tab wrap within it', async () => {
  let rerender = () => {}
  function Harness() {
    const [, setCount] = useState(0)
    rerender = () => setCount(count => count + 1)
    // Pass a new inline onClose on each render (as polling parents do) to verify the effect does not reset focus.
    return <Modal open onClose={() => {}} title="Title" closeLabel="Close" footer={<button type="button">last</button>}><input aria-label="first field" /></Modal>
  }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<Harness />) })
  const field = document.querySelector<HTMLInputElement>('[aria-label="first field"]')!
  field.focus()
  await act(async () => { rerender() })
  expect(document.activeElement).toBe(field)
  const [close, , last] = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button, [role="dialog"] input')]
  const tab = (shiftKey = false) => act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, cancelable: true })) })
  last!.focus(); await tab()
  expect(document.activeElement).toBe(close)
  await tab(true)
  expect(document.activeElement).toBe(last)
  act(() => { root.unmount() })
})

it('moves the tab selection with arrow keys and wraps at the ends', async () => {
  const seen: string[] = []
  function Harness() {
    const [value, setValue] = useState<'a' | 'b' | 'c'>('a')
    return <SegmentedTabs label="pages" value={value} onChange={next => { seen.push(next); setValue(next) }} items={(['a', 'b', 'c'] as const).map(item => ({ value: item, label: item, id: `t-${item}`, panelId: 'p' }))} />
  }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<Harness />) })
  const list = container.querySelector('[role="tablist"]')!
  await act(async () => { list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
  await act(async () => { list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })) })
  expect(seen).toEqual(['c', 'a'])
  expect(container.querySelector('[aria-selected="true"]')?.textContent).toBe('a')
  act(() => { root.unmount() })
})
