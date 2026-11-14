/** Default-user preflight must inspect identity without silently changing Linux user settings. */
import { beforeEach, expect, it, vi } from 'vitest'
const execute = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: execute }))
import { assertDefaultWslUser } from '../src/infra/wsl.ts'
const target = { stateDir: 'D:/state', wsl: { distro: 'Ubuntu-20.04', user: 'root', workRoot: '/root/work' } }
beforeEach(() => { execute.mockReset() })
it('accepts one identity and probes the default without a user override', async () => {
  execute.mockImplementation((_file, _args, _options, callback) => callback(null, 'root\n'))
  await assertDefaultWslUser(target)
  expect(execute).toHaveBeenCalledWith('wsl.exe', ['--distribution', 'Ubuntu-20.04', '--exec', 'id', '-un'],
    expect.objectContaining({ timeout: 15000, windowsHide: true }), expect.any(Function))
})
it('refuses mixed shell/search identities instead of changing the distro default', async () => {
  execute.mockImplementation((_file, _args, _options, callback) => callback(null, 'ordinary-user\n'))
  await expect(assertDefaultWslUser(target)).rejects.toThrow(/differs from the distribution default/)
  expect(execute).toHaveBeenCalledTimes(1)
})
it('surfaces a failed identity probe without guessing', async () => {
  execute.mockImplementation((_file, _args, _options, callback) => callback(new Error('WSL unavailable')))
  await expect(assertDefaultWslUser(target)).rejects.toThrow('WSL unavailable')
})
it('does not probe or alter native deployments', async () => {
  await assertDefaultWslUser({ stateDir: '/tmp/native' })
  expect(execute).not.toHaveBeenCalled()
})
