import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentModel, modelSelectionProjectionDefinition, type Agent, type ModelSelectionProjectionState } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import { initializeRoleModel } from '../src/app/role-models.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); vi.restoreAllMocks() })
function fixture() {
  const ctx = new Context(); contexts.push(ctx)
  const resolve = vi.fn(async value => value)
  const flush = vi.fn(async () => {})
  ctx.reflect.provide('llm', { resolveCallConfig: resolve })
  ctx.reflect.provide('sessionPersistence', { flush })
  const session = Session.create(SessionId('role-model'))
  const host = { provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') }
  const state = (): ModelSelectionProjectionState => session.snapshotEvents().reduce<ModelSelectionProjectionState>(
    (value, event) => modelSelectionProjectionDefinition.apply(value, event), { lastUsed: null, pending: null })
  const model = new AgentModel(state, session, host)
  const select = vi.spyOn(model, 'select')
  const agent = { ctx, session, model } as unknown as Agent
  return { ctx, agent, host, resolve, flush, select }
}
it('seeds the Agent-owned model before step preparation without changing the Host default', async () => {
  const { ctx, agent, host, flush, select } = fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker-provider', model: 'worker-model' })
  expect(select).toHaveBeenCalledExactlyOnceWith({ provider: 'worker-provider', model: 'worker-model' })
  expect(agent.model.current()).toEqual({ provider: 'worker-provider', model: 'worker-model' })
  expect(host).toEqual({ provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') })
  expect(agent.session.snapshotEvents().filter(event => event.type === 'model/selection')).toHaveLength(1)
  expect(flush).toHaveBeenCalledOnce()
})
it('preserves explicit effort and lets a later selection win without changing a captured step', async () => {
  const { ctx, agent } = fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'one', reasoningEffort: 'low' })
  const prepared = agent.model.current()
  agent.model.select({ provider: 'manual', model: 'two' })
  expect(prepared).toEqual({ provider: 'worker', model: 'one', reasoningEffort: 'low' })
  expect(agent.model.current()).toEqual({ provider: 'manual', model: 'two' })
})
it.each(['header', 'selection'])('preserves a resumed Session with existing %s', async kind => {
  const { ctx, agent, resolve, select } = fixture()
  const existing = { provider: 'existing', model: 'keep' }
  if (kind === 'header') agent.session.append('request/header', { header: { config: existing }, reason: 'initial' })
  else agent.session.append('model/selection', existing)
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'new' })
  expect(resolve).not.toHaveBeenCalled()
  expect(select).not.toHaveBeenCalled()
})
it('inherits the Host when unset and fails unavailable routes before recording a selection', async () => {
  const { ctx, agent, resolve, select } = fixture()
  await initializeRoleModel(ctx, agent, null)
  expect(agent.model.current()).toMatchObject({ provider: 'host', model: 'default' })
  resolve.mockRejectedValueOnce(new Error('unknown provider'))
  await expect(initializeRoleModel(ctx, agent, { provider: 'unknown', model: 'x' })).rejects.toThrow('unknown provider')
  expect(select).not.toHaveBeenCalled()
  expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(false)
})
