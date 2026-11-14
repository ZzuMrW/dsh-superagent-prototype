/** Verify the public shell seam receives trusted guest env without invoking WSL or a profile. */
import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Machine } from '../src/deployment.ts'
vi.mock('dsh-wsl-workspace/shell', () => ({ default: class {
  resolve(request: Record<string, unknown>) { return request }
} }))
import SuperagentWslShell from '../src/wsl-shell.ts'
import { registerWslExecution } from '../src/app/wsl-world.ts'

it('resolves guest environment, user and distro without changing standard bash timeout/background semantics', () => {
  const dispose = registerWslExecution('worker', { machine: { wsl: { distro: 'Ubuntu-20.04', user: 'root' } } as Machine,
    env: { PATH: '/guest/shims:/usr/bin', GIT_CONFIG_GLOBAL: '/guest/gitconfig', GIT_DIR: undefined } }, () => ({ DSH_SUPERAGENT_TICKET: 'ticket-a' }))
  try {
    const shell = new SuperagentWslShell({ on: vi.fn() } as unknown as Context, {})
    const request = { command: 'git status', workdir: '/root/project', timeoutMs: 5000, onExpiry: 'none' as const,
      dshEnv: { DSH_SESSION_ID: 'worker' } }
    const spec = shell.resolve(request)
    expect(spec).toMatchObject({ timeoutMs: 5000, onExpiry: 'none', workdir: '/root/project',
      dshEnv: { DSH_WSL_DISTRO: 'Ubuntu-20.04', DSH_WSL_USER: 'root' } })
    expect(spec.command).toContain("'PATH=/guest/shims:/usr/bin'")
    expect(spec.command).toContain("-u 'GIT_DIR'")
    expect(spec.command).toContain("'DSH_SUPERAGENT_TICKET=ticket-a'")
  } finally { dispose() }
})
it('refuses unbound sessions instead of inheriting Windows/global execution state', () => {
  const shell = new SuperagentWslShell({ on: vi.fn() } as unknown as Context, {})
  expect(() => shell.resolve({ command: 'true', dshEnv: { DSH_SESSION_ID: 'unknown' } })).toThrow(/no active/)
})
