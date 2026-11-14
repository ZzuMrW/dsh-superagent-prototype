/** Pass scheduling, coalescing, and runtime health reporting. */
import { expect, it, vi } from 'vitest'
import { Passes } from '../src/app/passes.ts'
import type { Trigger } from '../src/core/index.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { MaintenanceGate } from '../src/execution/maintenance.ts'

function passes(closing = () => false, maintenance?: MaintenanceGate) {
  const health = new HealthBoard().claim('runtime', { state: 'starting', detail: '' })
  const engine = { receive: vi.fn(() => 'stored' as const), evaluateDue: vi.fn() }
  const effects = { kick: vi.fn(), idle: vi.fn(async () => {}) }
  const value = new Passes({ engine, effects, health, lifetime: new AbortController().signal, configured: () => true, closing, maintenance })
  return { passes: value, engine, effects, health }
}
const trigger = { id: 't1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_1' }], actor: { source: 'feishu', id: 'ou_a' }, human: true,
  at: '2026-10-01T00:00:00.000Z', text: 'hi', meta: {} } as Trigger

it('reports a failed pass as an error of the runtime, which the next pass that succeeds clears', async () => {
  const h = passes()
  h.engine.evaluateDue.mockImplementationOnce(() => { throw new Error('database is locked') })
  h.passes.request()
  await h.passes.idle()
  expect(h.health.get()).toMatchObject({ state: 'error', detail: 'A pass failed: Error: database is locked' })
  h.passes.request()
  await h.passes.idle()
  expect(h.health.get()).toMatchObject({ state: 'ready', detail: 'Orchestrator is ready' })
})

it('runs the passes asked for during a pass as one pass after it', async () => {
  const h = passes()
  await Promise.all([h.passes.pump(), h.passes.pump(), h.passes.pump(), h.passes.pump()])
  expect([h.engine.evaluateDue.mock.calls.length, h.effects.kick.mock.calls.length]).toEqual([2, 2])
  await h.passes.pump()
  expect(h.engine.evaluateDue).toHaveBeenCalledTimes(3)
})

it('refuses a Trigger while dsh-superagent stops, before the Engine stores anything, and starts a pass for one it stored', async () => {
  let closing = true
  const h = passes(() => closing)
  expect(() => h.passes.receive(trigger)).toThrow('Orchestrator is stopping')
  expect(h.engine.receive).not.toHaveBeenCalled()
  closing = false
  expect(h.passes.receive(trigger)).toBe('stored')
  await h.passes.idle()
  expect(h.engine.evaluateDue).toHaveBeenCalledOnce()
})

it('starts no timer once stopped, as a start-up that ends after a stop asks', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    const h = passes()
    await h.passes.stop()
    h.passes.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.engine.evaluateDue).not.toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})

it('blocks intake and new passes during repair without clearing the existing runtime error', async () => {
  const gate = new MaintenanceGate(), h = passes(() => false, gate)
  const release = gate.hold('account', { code: 'account-repair' })
  h.health.set({ state: 'error', detail: 'keep this failure', at: 'checked' })
  expect(() => h.passes.receive(trigger)).toThrow()
  h.passes.request(); await h.passes.pump(); await h.passes.idle()
  expect(h.engine.receive).not.toHaveBeenCalled(); expect(h.engine.evaluateDue).not.toHaveBeenCalled()
  expect(h.health.get()).toMatchObject({ state: 'error', detail: 'keep this failure' })
  release(); await h.passes.pump()
  expect(h.engine.evaluateDue).toHaveBeenCalledOnce()
})

it('accounts for a whole pass and releases its admission after a failure', async () => {
  const gate = new MaintenanceGate(), h = passes(() => false, gate)
  h.engine.evaluateDue.mockImplementation(() => {
    expect(gate.activityBlockers()).toEqual([{ code: 'activity-effect', detail: 'orchestration-pass' }])
    throw new Error('expected')
  })
  await expect(h.passes.pump()).rejects.toThrow('expected')
  expect(gate.activityBlockers()).toEqual([])
})
