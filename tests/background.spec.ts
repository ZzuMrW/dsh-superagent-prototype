/** A worker's background work in DSH: waiting for its shell jobs and subagents, and stopping them. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, vi } from 'vitest'
import { stopSubagents, untilQuiet } from '../src/executor/background.ts'
import { jobRegistry } from './fixtures/host.ts'

/** A context with DSH's job registry and subagents, and an idle worker agent with one live subagent, `child-1`. */
function setup(waitForTreeWork: (agent: Agent) => Promise<boolean>) {
  const jobs = jobRegistry()
  const agent = { id: 'worker-t1', status: 'idle', whenIdle: async () => {}, inbox: { nextTurn: [], nextStep: [] }, cancel: vi.fn() } as unknown as
    Agent & { status: string; cancel: ReturnType<typeof vi.fn> }
  const subagents = { waitForTreeWork: vi.fn(waitForTreeWork),
    listDescendants: vi.fn(async (): Promise<({ kind: 'child'; id: string; activity: 'running' | 'inactive'; mode?: string } | { kind: 'diagnostic'; id: string; reason: string })[]> => [{ kind: 'child', id: 'child-1', activity: 'running' }]),
    drainDescendants: vi.fn() }
  const services: Record<string, unknown> = { jobs: jobs.service, subagents }
  const ctx = { get: (name: string) => services[name], agents: { get: () => agent } } as unknown as Context
  return { ctx, agent, jobs, subagents }
}

it('is not quiet when an end during the subagent check woke the worker, whose own idle looks again', async () => {
  const { ctx, agent, jobs } = setup(async () => {
    // The job settles meanwhile, and its end wakes the worker.
    jobs.end(id); (agent as { status: string }).status = 'running'
    return false
  })
  const id = jobs.run('worker-t1')
  expect(await untilQuiet(ctx, agent, new AbortController().signal)).toBe(false)
})

it('stops waiting for subagents that never settle once the host stops', async () => {
  let joining!: () => void
  const joined = new Promise<void>(resolve => { joining = resolve })
  const { ctx, agent } = setup(() => { joining(); return new Promise(() => {}) })
  const stop = new AbortController()
  const quiet = untilQuiet(ctx, agent, stop.signal)
  // The host stops while the wait for its subagents runs.
  await joined
  stop.abort()
  expect(await quiet).toBe(false)
})

it('looks at the jobs only when one ends, not at each output of a noisy one', async () => {
  const { ctx, agent, jobs } = setup(async () => false)
  const id = jobs.run('worker-t1')
  const stop = new AbortController()
  const quiet = untilQuiet(ctx, agent, stop.signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  const looked = jobs.service.list.mock.calls.length
  for (let line = 0; line < 100; line++) jobs.output(id)
  expect(jobs.service.list.mock.calls.length).toBe(looked)
  jobs.end(id)
  expect(await quiet).toBe(true)
})

it('joins a worker\'s subagents once for the looks that wait on them, as DSH cannot cancel the join', async () => {
  const { ctx, agent, subagents } = setup(() => new Promise(() => {}))
  for (let look = 0; look < 3; look++) {
    const stop = new AbortController()
    const quiet = untilQuiet(ctx, agent, stop.signal)
    stop.abort()
    expect(await quiet).toBe(false)
  }
  expect(subagents.waitForTreeWork).toHaveBeenCalledTimes(1)
})

it('fails a temporary handoff closed rather than permanently closing a resident tree or pretending interrupt releases it', async () => {
  const { ctx, agent, subagents } = setup(async () => false)
  await expect(stopSubagents(ctx, agent, true)).rejects.toThrow('worker delegation is unsupported')
  expect(subagents.listDescendants).toHaveBeenCalledWith(agent.id)
  expect(subagents.drainDescendants).not.toHaveBeenCalled()
  expect(agent.cancel).not.toHaveBeenCalled()
})
it('allows a stop when no descendant is resident, including an empty WSL worker catalog', async () => {
  const { ctx, agent, subagents } = setup(async () => false)
  subagents.listDescendants.mockResolvedValueOnce([])
  await expect(stopSubagents(ctx, agent)).resolves.toBeUndefined()
  subagents.listDescendants.mockResolvedValueOnce([{ kind: 'child', id: 'old-child', activity: 'inactive' }])
  await expect(stopSubagents(ctx, agent)).resolves.toBeUndefined()
  expect(subagents.drainDescendants).not.toHaveBeenCalled()
})
it('does not mistake a nonresident external run for a completed activation', async () => {
  const { ctx, agent, subagents } = setup(async () => false)
  subagents.listDescendants.mockResolvedValueOnce([{ kind: 'child', id: 'external-child', activity: 'inactive', mode: 'external' }])
  await expect(stopSubagents(ctx, agent)).rejects.toThrow('worker delegation is unsupported')
})
it('does not mistake an unreadable descendant branch for a safe temporary stop', async () => {
  const { ctx, agent, subagents } = setup(async () => false)
  subagents.listDescendants.mockResolvedValueOnce([{ kind: 'diagnostic', id: 'unknown-child', reason: 'unavailable' }])
  await expect(stopSubagents(ctx, agent)).rejects.toThrow('worker delegation is unsupported')
})
