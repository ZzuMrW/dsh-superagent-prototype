import { describe, expect, it, vi } from 'vitest'
import { DshExecutor, type ExecutorHost } from '../src/executor/dsh.ts'
function fixture() {
  const drainDescendants = vi.fn(async () => {})
  const agent = { id: 'worker-ticket', status: 'idle' }
  const host = {
    context: { get: (name: string) => name === 'subagents' ? { drainDescendants, listDescendants: async () => [] } : undefined,
      agents: new Map([['worker-ticket', agent]]) },
    store: { tickets: { list: () => [{ id: 'ticket' }] } },
    effects: { handle: vi.fn() }, lifetime: new AbortController().signal,
    health: { get: vi.fn(), set: vi.fn() },
  } as unknown as ExecutorHost
  const executor = new DshExecutor(host)
  const barrier = executor as unknown as { track(id: string, work: Promise<void>): void; stopped(id: string): Promise<void> }
  return { executor, barrier, drainDescendants, agent }
}
describe('failed background stop is a sticky launch/delivery barrier', () => {
  it('rejects after the stop Promise disappeared, and clears only after a new successful stop', async () => {
    const { barrier } = fixture()
    barrier.track('ticket', Promise.reject(new Error('resident release unsupported')))
    await expect(barrier.stopped('ticket')).rejects.toThrow('refusing new work')
    await expect(barrier.stopped('ticket')).rejects.toThrow('refusing new work')
    barrier.track('ticket', Promise.resolve())
    await expect(barrier.stopped('ticket')).resolves.toBeUndefined()
  })
  it('does not let a concurrent successful stop erase another failed stop', async () => {
    const { barrier } = fixture()
    let fail!: (reason: Error) => void
    barrier.track('ticket', new Promise<void>((_resolve, reject) => { fail = reject }))
    barrier.track('ticket', Promise.resolve())
    fail(new Error('stop failed'))
    await expect(barrier.stopped('ticket')).rejects.toThrow('refusing new work')
    barrier.track('ticket', Promise.resolve())
    await expect(barrier.stopped('ticket')).resolves.toBeUndefined()
  })
  it('rejects final teardown when descendant drain fails instead of swallowing the error', async () => {
    const { executor, drainDescendants } = fixture()
    drainDescendants.mockRejectedValueOnce(new Error('drain failed'))
    await expect(executor.shutdown()).rejects.toThrow('Worker shutdown failed')
  })
  it('uses the irreversible exact-root drain only during real Host teardown', async () => {
    const { executor, drainDescendants, agent } = fixture()
    await executor.shutdown()
    expect(drainDescendants).toHaveBeenCalledExactlyOnceWith([agent])
  })
})
