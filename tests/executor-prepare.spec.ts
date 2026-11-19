import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { DshExecutor, type ExecutorHost } from '../src/executor/dsh.ts'
import type { Ticket } from '../src/core/index.ts'
import { environmentSnapshot, freezeExecutionSnapshot, freezeTarget } from '../src/execution/target.ts'
import type { WslRequest } from '../src/infra/wsl.ts'

const transport = vi.hoisted(() => ({ run: vi.fn(async (_machine: unknown, _request: WslRequest) => ''), fs: vi.fn(async () => '') }))
vi.mock('../src/infra/wsl.ts', async original => ({ ...await original<typeof import('../src/infra/wsl.ts')>(), runWsl: transport.run, guestFs: transport.fs }))
afterEach(() => { vi.clearAllMocks(); transport.run.mockImplementation(async () => '') })

function fixture(gitConfig = '/home/worker/generations/current/worker-gitconfig') {
  const target = freezeTarget({ distro: 'Ubuntu', user: 'worker', uid: 1000, home: '/home/worker', bootId: 'verified-boot' },
    { input: '/tickets', guestPath: '/tickets', hostPath: '\\\\wsl.localhost\\Ubuntu\\tickets', storage: 'guest-local', evidence: { converter: 'wslpath', hostRegistration: 'verified' } }, 'current', '')
  const snapshot = freezeExecutionSnapshot(3, target, environmentSnapshot({ GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_CONFIG_DIR: undefined,
    PATH: '/home/worker/generations/current/worker-bin:/usr/bin:/bin', HOME: '/home/worker' }))
  const host = { machine: { stateDir: 'D:\\state', wsl: { distro: 'Ubuntu', user: 'worker', workRoot: '/tickets' } },
    executionSnapshot: vi.fn(() => snapshot), lifetime: new AbortController().signal, context: {},
    effects: { handle: vi.fn() }, store: { settings: () => ({ executor: { prepare: 'mkdir -p "$DSH_SUPERAGENT_DIR"' } }) },
    environment: () => [{ key: 'DSH_SUPERAGENT_DIR', value: '/tickets/new' }, { key: 'GIT_CONFIG_GLOBAL', value: '/wrong' }, { key: 'GH_TOKEN', value: 'must-be-cleared' }],
  } as unknown as ExecutorHost
  const executor = new DshExecutor(host) as unknown as { prepareDirectory(ticket: Ticket): Promise<void> }
  const ticket = { execution: { directory: '/tickets/new' } } as Ticket
  return { host, executor, ticket, snapshot }
}

it('uses the current generation for prepare and directory verification, preserving credential tombstones and UID/boot identity', async () => {
  const { executor, ticket, snapshot } = fixture()
  await executor.prepareDirectory(ticket)
  expect(transport.run).toHaveBeenCalledTimes(2) // No legacy PATH/config discovery RPC.
  const prepare = transport.run.mock.calls[0]![1]
  expect(prepare.argv.slice(0, 2)).toEqual(['sh', '-c'])
  expect(prepare.env).toMatchObject({ ...snapshot.environment.set, DSH_SUPERAGENT_DIR: '/tickets/new' })
  expect(prepare.env).toHaveProperty('GH_TOKEN', undefined)
  expect(prepare.env).toHaveProperty('GITHUB_TOKEN', undefined)
  expect(prepare.expectedIdentity).toBe(snapshot.target)
  const verify = transport.run.mock.calls[1]![1]
  expect(verify.argv[0]).toBe('git')
  expect(verify.env?.GIT_CONFIG_GLOBAL).toBe(snapshot.environment.set.GIT_CONFIG_GLOBAL)
  expect(verify.expectedIdentity).toBe(snapshot.target)
})

it.each(['missing', 'different-user'] as const)('fails closed before filesystem or command effects with a %s snapshot', async variant => {
  const { executor, host, ticket, snapshot } = fixture()
  vi.mocked(host.executionSnapshot!).mockReturnValue(variant === 'missing' ? undefined : { ...snapshot, target: { ...snapshot.target, user: 'another-user' } })
  await expect(executor.prepareDirectory(ticket)).rejects.toThrow('current verified execution snapshot')
  expect(transport.run).not.toHaveBeenCalled()
  expect(transport.fs).not.toHaveBeenCalled()
})

it('allows a real noninteractive Git credential lookup through the generation helper without personal config or GitHub access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'superagent-prepare-auth-'))
  try {
    const config = join(root, 'worker-gitconfig'), helper = join(root, 'helper')
    await writeFile(helper, '#!/bin/sh\nprintf "username=fixture-agent\\npassword=fixture-only\\n"\n', { mode: 0o700 })
    await writeFile(config, `[credential]\n\thelper =\n[credential "https://github.com"]\n\thelper = !${helper}\n`)
    const { executor, host, ticket, snapshot } = fixture(config)
    // Use the actual prepare request environment, but run only a local Git credential protocol fixture.
    const run = promisify(execFile)
    transport.run.mockImplementation(async (_machine, request) => {
      if (request.argv[0] !== 'sh') return ''
      const env: NodeJS.ProcessEnv = { ...process.env, ...request.env, PATH: '/usr/bin:/bin', HOME: root }
      for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key]
      const result = await run('sh', ['-c', 'printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill'], { cwd: root, env })
      expect(result.stdout).toContain('username=fixture-agent')
      return ''
    })
    expect(snapshot.environment.set.GIT_CONFIG_GLOBAL).toBe(config)
    await executor.prepareDirectory(ticket)
    expect(host.executionSnapshot).toHaveBeenCalled()
  } finally { await rm(root, { recursive: true, force: true }) }
})
