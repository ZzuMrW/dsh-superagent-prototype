/** Public ShellExecutor resolution uses only trusted per-Session facts, synchronously. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { Machine } from '../src/deployment.ts'
import SuperagentWslShell from '../src/wsl-shell.ts'
import { registerWslExecution } from '../src/app/wsl-world.ts'
import { environmentSnapshot, freezeExecutionSnapshot, freezeTarget } from '../src/execution/target.ts'
const disposers: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose() })
function setup(verified = true, resolveShellPolicy?: () => SandboxExecutionPolicy | undefined) {
  const target = freezeTarget({ distro: 'Ubuntu-20.04', user: 'worker', uid: 1000, home: '/home/worker', bootId: 'boot-a' },
    { input: '/home/worker/project', guestPath: '/home/worker/project', hostPath: String.raw`\\wsl.localhost\Ubuntu-20.04\home\worker\project`,
      storage: 'guest-local', evidence: { converter: 'wslpath', hostRegistration: 'verified' } }, 'generation-a', new Date().toISOString())
  const binding = { machine: { wsl: { distro: 'WRONG-LEGACY', user: 'root' } } as Machine, resolveShellPolicy,
    env: { PATH: '/guest/shims:/usr/bin', GIT_CONFIG_GLOBAL: '/guest/gitconfig', GIT_DIR: undefined },
    ...verified ? { snapshot: freezeExecutionSnapshot(1, target, environmentSnapshot({})), guestCwd: '/home/worker/project/ticket-a' } : {} }
  disposers.push(registerWslExecution('worker', binding, () => ({ DSH_SUPERAGENT_TICKET: 'ticket-a' })))
  const ctx = new Context()
  disposers.push(() => ctx.fiber.dispose())
  return { ctx, shell: new SuperagentWslShell(ctx, {}) }
}
it('resolves without wrapping the command, mapping paths, or changing standard Bash expiry semantics', () => {
  const { shell } = setup()
  const spec = shell.resolve({ command: 'git status', workdir: String.raw`D:\project`, timeoutMs: 5000, onExpiry: 'none',
    dshEnv: { DSH_SESSION_ID: 'worker' }, env: { CUSTOM: 'value' }, stdin: 'payload' })
  expect(spec).toMatchObject({ timeoutMs: 5000, onExpiry: 'none', workdir: String.raw`D:\project`,
    command: 'git status', stdin: 'payload', env: { CUSTOM: 'value' },
    dshEnv: { DSH_SESSION_ID: 'worker', DSH_WSL_DISTRO: 'Ubuntu-20.04', DSH_WSL_USER: 'worker' } })
  expect(spec).not.toBeInstanceOf(Promise)
  expect(shell.resolve({ command: 'pwd', dshEnv: { DSH_SESSION_ID: 'worker' } }).workdir).toBe('/home/worker/project/ticket-a')
  expect(shell.resolve({ command: 'pwd', timeoutMs: 900000, dshEnv: { DSH_SESSION_ID: 'worker' } }).timeoutMs).toBe(600000)
  expect(shell.sandboxMode).toBeUndefined()
})
it('refuses unbound or legacy-only Sessions rather than inheriting Windows/global defaults', () => {
  const { shell } = setup(false)
  expect(() => shell.resolve({ command: 'true', dshEnv: { DSH_SESSION_ID: 'worker' } })).toThrow(/no active verified/)
  expect(() => shell.resolve({ command: 'true', dshEnv: { DSH_SESSION_ID: 'unknown' } })).toThrow(/no active verified/)
})
it('allows unsandboxed danger-full-access, but explicitly rejects restricted policies', () => {
  const { shell } = setup()
  const request = { command: 'true', dshEnv: { DSH_SESSION_ID: 'worker' } }
  expect(() => shell.resolve({ ...request, sandboxPolicy: { mode: 'danger-full-access' } as never })).not.toThrow()
  for (const mode of ['read-only', 'workspace-write']) {
    expect(() => shell.resolve({ ...request, sandboxPolicy: { mode } as never })).toThrow(/does not implement sandbox/)
  }
})
it('honors the trusted live Session override when Core-style unsandboxed Bash omits sandboxPolicy', () => {
  const sessionPolicy = vi.fn((): SandboxExecutionPolicy => ({ mode: 'danger-full-access', workspaceRoot: '/guest/session' }))
  const { ctx, shell } = setup(true, sessionPolicy)
  const globalPolicy = vi.fn(() => ({ mode: 'read-only', workspaceRoot: '/global' }))
  ctx.provide('sandboxPolicy', { resolve: globalPolicy })
  const spec = shell.resolve({ command: 'true', dshEnv: { DSH_SESSION_ID: 'worker' } })
  expect(spec.sandboxPolicy).toBeUndefined() // Do not stamp a standing policy as an approved per-call override.
  expect(shell.sandboxMode).toBeUndefined() // Do not pretend to provide sandbox enforcement/escalation.
  expect(sessionPolicy).toHaveBeenCalledTimes(1)
  expect(globalPolicy).not.toHaveBeenCalled()
  expect(() => shell.resolve({ command: 'true', dshEnv: { DSH_SESSION_ID: 'worker' },
    sandboxPolicy: { mode: 'read-only', workspaceRoot: '/guest/session' } })).toThrow(/does not implement sandbox/)
})
it.each(['read-only', 'workspace-write'] as const)('never substitutes a global danger default for a restricted Session (%s)', mode => {
  const { ctx, shell } = setup(true, () => ({ mode, workspaceRoot: '/guest/session' }))
  const globalPolicy = vi.fn(() => ({ mode: 'danger-full-access', workspaceRoot: '/global' }))
  ctx.provide('sandboxPolicy', { resolve: globalPolicy })
  expect(() => shell.resolve({ command: 'true', dshEnv: { DSH_SESSION_ID: 'worker' } })).toThrow(/does not implement sandbox/)
  expect(globalPolicy).not.toHaveBeenCalled()
})
it('requires a trusted policy binding when policy service exists and refuses an empty Session resolver', () => {
  const missing = setup()
  const globalPolicy = vi.fn(() => ({ mode: 'danger-full-access', workspaceRoot: '/global' }))
  missing.ctx.provide('sandboxPolicy', { resolve: globalPolicy })
  expect(() => missing.shell.resolve({ command: 'true', dshEnv: { DSH_SESSION_ID: 'worker' } })).toThrow(/trusted live Session policy binding/)
  expect(globalPolicy).not.toHaveBeenCalled()
  const empty = setup(true, () => undefined)
  expect(() => empty.shell.resolve({ command: 'true', dshEnv: { DSH_SESSION_ID: 'worker' } })).toThrow(/trusted live Session policy binding/)
})
it('re-resolves Session permissions at execute instead of freezing a prior danger override', async () => {
  let mode: SandboxExecutionPolicy['mode'] = 'danger-full-access'
  const { shell } = setup(true, () => ({ mode, workspaceRoot: '/guest/session' }))
  const spec = shell.resolve({ command: 'true', dshEnv: { DSH_SESSION_ID: 'worker' } })
  mode = 'read-only'
  await expect(shell.execute(spec)).rejects.toThrow(/does not implement sandbox/)
})
it('rejects a forged managed Session identity conflicting with tools/execute context', async () => {
  const { ctx, shell } = setup()
  await expect(ctx.serial('tools/execute', { agent: { id: 'active-worker' } } as never,
    async () => shell.resolve({ command: 'true', dshEnv: { DSH_SESSION_ID: 'worker' } }))).rejects.toThrow(/identity conflicts/)
})
