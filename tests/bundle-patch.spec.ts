/** The bundle's patch, read with the entry-list dialect DSH reads bundle patches with, and the agent preset it defines. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ROUTER_PRESET, WORKER_PRESET, WSL_ROUTER_PRESET, WSL_WORKER_PRESET } from '../src/app/sessions.ts'

interface Row { id?: string; name: string; disabled?: unknown; config?: Record<string, unknown> & { plugins?: Row[] } | Row[] }
/** The patch as DSH reads it: Cordis's include plugin parses `!!js` scalars, and applies the inserts to an entry list. */
async function patched(enabled = true): Promise<Row[]> {
  const cordis = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/cordis/package.json'))
  const include = cordis.resolve('@deepseek-ai/cordis-plugin-include')
  const { entryListSchema, applyEntryPatches } = await import(include) as {
    entryListSchema: unknown; applyEntryPatches(data: Row[], patches: unknown[], warn: (message: string) => void): Row[] }
  const yaml = await import(createRequire(include).resolve('js-yaml')) as { load(text: string, options: { schema: unknown }): unknown }
  const patches = yaml.load(readFileSync(join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema }) as unknown[]
  const warnings: string[] = []
  // Exact stock rows in dsh-web-app 0.2.2-rc.3; a separate row replaces each provider reversibly.
  const rows = applyEntryPatches([
    { id: 'workspace-files', name: '@deepseek-ai/dsh-api-workspace-files' },
    { id: 'file-reference-local', name: '@deepseek-ai/dsh-file-reference-local' },
  ], enabled ? patches : [], message => { warnings.push(message) })
  expect(warnings).toEqual([])
  return rows
}
/** Every plugin row of a preset, those inside groups too. */
const flat = (rows: readonly Row[]): Row[] => rows.flatMap(row => [row, ...Array.isArray(row.config) ? flat(row.config) : []])

/** A preset the patch defines, by its id. */
const presetOf = (rows: readonly Row[], id: string) => rows.map(row => row.config as { id?: string; order?: number; plugins: Row[] })
  .find(config => config?.id === id)!

it('keeps the raw library bootstrap and its sources inert until a configuration layer enables them', async () => {
  const rows = await patched()
  for (const id of ['dsh-superagent', 'dsh-superagent-github', 'dsh-superagent-feishu']) {
    expect(rows.find(row => row.id === id)?.disabled).toBe(true)
  }
})
it('defines the worker preset Executor Sessions run under, with a shell that moves long commands to the background', async () => {
  const rows = await patched()
  expect(rows.map(row => row.id)).toEqual(['workspace-files', 'file-reference-local', 'dsh-superagent', 'dsh-superagent-github', 'dsh-superagent-feishu', 'dsh-superagent-worker-preset',
    'dsh-superagent-router-preset', 'dsh-superagent-workspace-files', 'dsh-superagent-file-references', 'wsl-dsh-superagent-worker-preset', 'wsl-dsh-superagent-router-preset'])
  const preset = presetOf(rows, WORKER_PRESET)
  expect(preset.id).toBe(WORKER_PRESET)
  const plugins = flat(preset.plugins)
  const named = (name: string) => plugins.filter(row => row.name === name).map(row => row.config)
  expect(named('@deepseek-ai/dsh-bash-sandbox')).toEqual([{ timeoutMs: 5000, maxTimeoutMs: 5000 }])
  expect(named('@deepseek-ai/dsh-pwsh-sandbox')).toEqual([{ timeoutMs: 5000, maxTimeoutMs: 5000 }])
  expect(named('@deepseek-ai/dsh-tool-jobs')).toEqual([{ waitTimeoutMs: 5000, maxWaitTimeoutMs: 5000 }])
  expect(named('@deepseek-ai/dsh-tool-web')).toEqual([expect.objectContaining({ fetch: false })])
  // Spawned subagents run under standard, whose shell moves a command to the background only after 60 s; forked ones, which would run under
  // this preset, are left out.
  expect(named('@deepseek-ai/dsh-tool-subagent')).toEqual([expect.objectContaining({ provider: 'spawn', agentPreset: 'standard' })])
  // What a worker needs, and none of what asks a person, presents, plans, changes the profile, schedules, sets goals or runs workflows.
  for (const name of ['@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-fs-search', '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-skill',
    '@deepseek-ai/dsh-tool-todo', '@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-tool-subagent-control', '@deepseek-ai/dsh-compaction-basic',
    '@deepseek-ai/dsh-compaction-tool-result-pruner', '@deepseek-ai/dsh-agent-instructions']) expect(named(name).length).toBeGreaterThan(0)
  const names = plugins.map(row => row.name)
  for (const name of ['@deepseek-ai/dsh-tool-ask-user', '@deepseek-ai/dsh-tool-present', '@deepseek-ai/dsh-plan-mode', '@deepseek-ai/dsh-plugin-manager/tools',
    '@deepseek-ai/dsh-plugin-market/tools', '@deepseek-ai/dsh-tool-schedule', '@deepseek-ai/dsh-tool-goal', '@deepseek-ai/dsh-command-goal',
    '@deepseek-ai/dsh-tool-workflow', '@deepseek-ai/dsh-workflow-ptc']) expect(names).not.toContain(name)
})

it('defines the router preset the main Session runs under: the worker\'s 5-second shell and job waits, and only the tools it uses', async () => {
  const rows = await patched()
  const router = presetOf(rows, ROUTER_PRESET), worker = presetOf(rows, WORKER_PRESET)
  expect(router.order).toBe(91)
  const plugins = flat(router.plugins)
  const named = (preset: Row[], name: string) => preset.filter(row => row.name === name).map(row => row.config)
  for (const name of ['@deepseek-ai/dsh-bash-sandbox', '@deepseek-ai/dsh-pwsh-sandbox', '@deepseek-ai/dsh-tool-jobs']) {
    expect(named(plugins, name), name).toEqual(named(flat(worker.plugins), name))
  }
  // The tools its allow list keeps: skill, bash, read, read_image and the job tools; the file tools only read.
  for (const name of ['@deepseek-ai/dsh-tool-skill', '@deepseek-ai/dsh-skill-filesystem', '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-jobs',
    '@deepseek-ai/dsh-agent-instructions', '@deepseek-ai/dsh-time-context', '@deepseek-ai/dsh-compaction-basic',
    '@deepseek-ai/dsh-compaction-tool-result-pruner']) expect(named(plugins, name).length, name).toBeGreaterThan(0)
  expect(named(plugins, '@deepseek-ai/dsh-tool-fs')).toEqual([{ write: false, edit: false }])
  const names = plugins.map(row => row.name)
  for (const name of ['@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-tool-subagent-control', '@deepseek-ai/dsh-tool-web', '@deepseek-ai/dsh-tool-fs-search',
    '@deepseek-ai/dsh-tool-todo', '@deepseek-ai/dsh-tool-ask-user', '@deepseek-ai/dsh-tool-present', '@deepseek-ai/dsh-plan-mode',
    '@deepseek-ai/dsh-plugin-manager/tools', '@deepseek-ai/dsh-plugin-market/tools', '@deepseek-ai/dsh-tool-schedule', '@deepseek-ai/dsh-tool-goal',
    '@deepseek-ai/dsh-command-goal', '@deepseek-ai/dsh-tool-workflow', '@deepseek-ai/dsh-workflow-ptc']) expect(names, name).not.toContain(name)
})

it('keeps WSL tools in one isolated world, with standard names, 5-second jobs and a read-only router', async () => {
  const rows = await patched()
  for (const id of [WSL_WORKER_PRESET, WSL_ROUTER_PRESET]) {
    // workspace's host generator excludes these IDs and its client leaves these selected sessions alone.
    expect(id).toMatch(/^wsl-[a-z0-9-]+$/)
    const preset = presetOf(rows, id)
    const world = preset.plugins.find(row => row.id === 'wsl-world')!
    expect(world).toMatchObject({ isolate: { shell: true, fs: true } })
    const plugins = flat(preset.plugins)
    expect(plugins.filter(row => row.name === '@deepseek-ai/dsh-tool-bash')).toHaveLength(1)
    expect(plugins.some(row => row.name === '@deepseek-ai/dsh-tool-pwsh')).toBe(false)
    expect(plugins.find(row => row.name === 'dsh-superagent/wsl-shell')?.config).toEqual({ timeoutMs: 5000, maxTimeoutMs: 5000 })
    expect(plugins.find(row => row.name === '@deepseek-ai/dsh-tool-jobs')?.config).toEqual({ waitTimeoutMs: 5000, maxWaitTimeoutMs: 5000 })
    expect(plugins.find(row => row.name === 'dsh-superagent/wsl-tools')?.config).toEqual({ search: id === WSL_WORKER_PRESET })
    for (const name of ['@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-tool-workflow', '@deepseek-ai/dsh-agent-instructions', '@deepseek-ai/dsh-skill-filesystem'])
      expect(plugins.some(row => row.name === name), name).toBe(false)
    expect(preset.plugins.some(row => row.name === 'dsh-superagent/wsl-context')).toBe(false)
    expect(flat(world.config as Row[]).filter(row => row.name === 'dsh-superagent/wsl-context')).toEqual([
      { id: 'wsl-context', name: 'dsh-superagent/wsl-context', config: { maxBytes: 65536 } },
    ])
    if (id === WSL_WORKER_PRESET) expect(plugins.find(row => row.name === '@deepseek-ai/dsh-tool-fs')?.config).toEqual({ readImage: true })
    if (id === WSL_ROUTER_PRESET) expect(plugins.find(row => row.name === '@deepseek-ai/dsh-tool-fs')?.config)
      .toEqual({ readImage: true, write: false, edit: false })
  }
})

it('replaces each stock Host service once without competing active providers, and preserves unique preset identities', async () => {
  const rows = await patched()
  expect(rows.find(row => row.id === 'workspace-files')?.disabled).toBe(true)
  expect(rows.find(row => row.id === 'file-reference-local')?.disabled).toBe(true)
  for (const name of ['dsh-superagent/workspace-files', 'dsh-superagent/file-references', 'dsh-superagent', 'dsh-superagent/github-watch'])
    expect(rows.filter(row => row.name === name)).toHaveLength(1)
  expect(new Set(rows.map(row => row.id)).size).toBe(rows.length)
  const presets = rows.filter(row => row.name === '@deepseek-ai/dsh-agent-preset')
  expect(new Set(presets.map(row => (row.config as { id: string }).id)).size).toBe(4)
  // Removing this bundle means applying no overlay to the original web-app rows.
  const stock = [{ id: 'workspace-files', name: '@deepseek-ai/dsh-api-workspace-files' },
    { id: 'file-reference-local', name: '@deepseek-ai/dsh-file-reference-local' }]
  expect(await patched(false)).toEqual(stock)
})
