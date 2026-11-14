/** Session-local guest environment transport: no profile/process mutation or running WSL required. */
import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import type { Machine } from '../src/deployment.ts'
import { registerWslExecution, wslCommand, wslExecutionFor, wslWorkspacePath, orchestratorWorkspace } from '../src/app/wsl-world.ts'
import { Config, machineOf } from '../src/deployment.ts'

const machine = { stateDir: 'D:\\state', wsl: { distro: 'Ubuntu-20.04', user: 'root' } } as Machine
it('maps Linux workspaces to explicit UNC coordinates and refuses another distribution', () => {
  expect(wslWorkspacePath('/root/work/a b', 'Ubuntu-20.04')).toBe('\\\\wsl.localhost\\Ubuntu-20.04\\root\\work\\a b')
  expect(() => wslWorkspacePath('relative', 'Ubuntu-20.04')).toThrow()
  expect(() => wslWorkspacePath('\\\\wsl.localhost\\Other\\root', 'Ubuntu-20.04')).toThrow(/different/)
})
it('keeps Host state separate from the guest orchestrator workspace and refuses drvfs workspace roots', () => {
  const configured = machineOf(Config({ stateDir: 'D:\\state', wsl: { distro: 'Ubuntu-20.04', user: 'root', workRoot: '/root/workspace/superagent-tickets' } }))
  expect(orchestratorWorkspace(configured)).toBe('/root/workspace/superagent-tickets/.orchestrator')
  expect(orchestratorWorkspace({ stateDir: '/tmp/native' })).toBe('/tmp/native')
  expect(() => wslWorkspacePath('/mnt/d/state', 'Ubuntu-20.04')).toThrow(/distribution filesystem/)
  expect(() => machineOf(Config({ stateDir: '/state', wsl: configured.wsl }))).toThrow(/Windows drive/)
  expect(() => machineOf(Config({ stateDir: 'D:\\state', wsl: { ...configured.wsl, workRoot: '/mnt/d/work' } }))).toThrow(/distribution filesystem/)
})
it('isolates sessions, refreshes ticket variables per execution, unsets Host Git state and quotes shell input', () => {
  const original = process.env.PATH
  let ticket = 'one'
  const release = registerWslExecution('worker-a', { machine, env: { PATH: '/guest/bin:/usr/bin', GIT_CONFIG_GLOBAL: '/guest/git config', GIT_DIR: undefined } },
    () => ({ DSH_SUPERAGENT_TICKET: ticket }))
  const other = registerWslExecution('worker-b', { machine, env: { PATH: '/other/bin' } })
  try {
    const a = wslExecutionFor('worker-a')!
    expect(wslCommand("printf '%s' '$HOME'", a)).toContain("env -u 'GIT_DIR' 'PATH=/guest/bin:/usr/bin'")
    expect(wslCommand('true', a)).toContain("'GIT_CONFIG_GLOBAL=/guest/git config'")
    expect(wslCommand('true', a)).toContain("'DSH_SUPERAGENT_TICKET=one'")
    ticket = 'two'
    expect(wslCommand('true', a)).toContain("'DSH_SUPERAGENT_TICKET=two'")
    expect(wslCommand('true', wslExecutionFor('worker-b')!)).not.toContain('TICKET')
    expect(process.env.PATH).toBe(original)
  } finally { release(); other() }
  expect(wslExecutionFor('worker-a')).toBeUndefined()
})
it('old release cannot remove a replacement binding and rejects injected environment names', () => {
  const old = registerWslExecution('same', { machine, env: {} })
  const current = registerWslExecution('same', { machine, env: { 'X;id': 'bad' } })
  old()
  expect(() => wslCommand('true', wslExecutionFor('same')!)).toThrow(/Invalid/)
  current()
})
it.runIf(process.platform !== 'win32')('passes hostile-looking values literally through the Linux env boundary', () => {
  const value = `a'\"$(printf INJECTED)\nvalue`
  const dispose = registerWslExecution('quote', { machine, env: { PATH: '/usr/bin:/bin', TEST_VALUE: value } })
  try {
    const command = wslCommand(`printf '%s' "$TEST_VALUE"`, wslExecutionFor('quote')!)
    expect(execFileSync('/bin/bash', ['-c', command], { encoding: 'utf8' })).toBe(value)
  } finally { dispose() }
})
