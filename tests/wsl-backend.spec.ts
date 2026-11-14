import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { executionStateDir, guestPath, WSL_CANCEL, WSL_RUNNER, wslArguments } from '../src/infra/wsl.ts'
import { resolveDeployment } from '../src/deployment.ts'
import { testDeployment } from './fixtures/deployment.ts'
const exec = promisify(execFile)
const machine = { stateDir: 'D:\\Agent State', wsl: { distro: 'Ubuntu-20.04', user: 'root', workRoot: '/root/workspace/tickets' } }
const payload = (id: string, argv: string[], extra = {}) => Buffer.from(JSON.stringify({ id, argv, cwd: '/', env: {}, timeoutMs: 5000, ...extra })).toString('base64')
it('keeps Host and guest paths separate and pins distro/user without shell quoting', () => {
  expect(executionStateDir(machine)).toBe('/mnt/d/Agent State/execution')
  expect(guestPath(machine, '\\\\wsl.localhost\\Ubuntu-20.04\\root\\a b')).toBe('/root/a b')
  expect(() => guestPath(machine, '\\\\wsl.localhost\\Other\\root')).toThrow()
  expect(wslArguments(machine, 'script', 'payload')).toEqual(['--distribution', 'Ubuntu-20.04', '--user', 'root', '--exec', 'python3', '-c', 'script', 'payload'])
})
it('resolves the Linux CLI through the probe and does not accept missing authentication', async () => {
  const deployed = testDeployment({ ...machine })
  const calls: string[][] = []
  const probe = async (argv: string[]) => {
    calls.push(argv)
    if (argv[0] === 'python3') return '/usr/bin/gh\n'
    throw new Error('gh: not logged in')
  }
  await expect(resolveDeployment(deployed, { repository: 'acme/widgets', cli: 'gh' }, probe)).rejects.toMatchObject({ code: 'agentCliSignedOut' })
  expect(calls[1]).toEqual(['/usr/bin/gh', 'api', 'user'])
})
describe.skipIf(process.platform === 'win32')('guest runner integration (same Python payload used by Windows transport)', () => {
  it('round-trips metacharacters, newlines, cwd and explicit environment removals', async () => {
    const id = randomUUID(), dir = mkdtempSync(join(tmpdir(), 'wsl quotes '))
    const literal = 'a b\n\"quotes\" \'single\' $(touch nope); `whoami`'
    try {
      const { stdout } = await exec('python3', ['-c', WSL_RUNNER, payload(id, ['python3', '-c', 'import json,os,sys; print(json.dumps([sys.argv[1],os.getcwd(),os.environ.get("REMOVE_ME"),os.environ["LITERAL"]]))', literal], { cwd: dir, env: { REMOVE_ME: null, LITERAL: literal } })], { env: { ...process.env, REMOVE_ME: 'ambient' } })
      expect(JSON.parse(stdout)).toEqual([literal, dir, null, literal])
      expect(existsSync('/tmp/dsh-superagent-' + id)).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('times out and kills a descendant before it can write a delayed marker', async () => {
    const id = randomUUID(), dir = mkdtempSync(join(tmpdir(), 'wsl-timeout-')), marker = join(dir, 'marker')
    try {
      await expect(exec('python3', ['-c', WSL_RUNNER, payload(id, ['python3', '-c', 'import subprocess,time,sys; subprocess.Popen(["python3","-c","import time,pathlib,sys; time.sleep(1); pathlib.Path(sys.argv[1]).write_text(\\\"survived\\\")",sys.argv[1]]); time.sleep(30)', marker], { timeoutMs: 100 })])).rejects.toMatchObject({ code: 124 })
      await new Promise(resolve => setTimeout(resolve, 1200))
      expect(existsSync(marker)).toBe(false)
      expect(existsSync('/tmp/dsh-superagent-' + id)).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('cancels via a nonce-specific sentinel and cleans its own directory', async () => {
    const id = randomUUID()
    const child = spawn('python3', ['-c', WSL_RUNNER, payload(id, ['python3', '-c', 'import time; time.sleep(30)'])], { stdio: 'ignore' })
    const done = new Promise<number | null>(resolve => child.once('exit', resolve))
    await exec('python3', ['-c', WSL_CANCEL, id])
    expect([124, 130, 143, 137]).toContain(await done)
    expect(existsSync('/tmp/dsh-superagent-' + id)).toBe(false)
  })
})
