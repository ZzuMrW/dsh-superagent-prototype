/** Manual Windows Node smoke. Explicit environment parameters prevent accidentally testing another deployment. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { runWsl, assertDefaultWslUser } from '../src/infra/wsl.ts'
if (process.platform !== 'win32') throw new Error('Run this manual transport test with Windows Node')
const required = (name: string): string => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Set ${name} to the intended local test configuration`)
  return value
}
const machine = { stateDir: required('SUPERAGENT_TEST_STATE_DIR'), wsl: {
  distro: required('SUPERAGENT_TEST_DISTRO'), user: required('SUPERAGENT_TEST_USER'),
  workRoot: required('SUPERAGENT_TEST_WORK_ROOT'),
} }
const before = { ...process.env }
const literal = 'a b\n"quoted" \'single\' $(touch NOPE); `whoami`'
const run = (argv: string[], options: Record<string, unknown> = {}) => runWsl(machine, { argv, cwd: '/', signal: AbortSignal.timeout(10_000), ...options })
const output = JSON.parse(await run(['python3', '-c', 'import os,pwd,json,sys; print(json.dumps([pwd.getpwuid(os.getuid()).pw_name,sys.argv[1],os.environ.get("GH_TOKEN"),os.environ.get("LITERAL")]))', literal], { env: { GH_TOKEN: undefined, LITERAL: literal } }))
assert.deepEqual(output, [machine.wsl.user, literal, null, literal])
console.log('PASS Windows Host -> explicitly configured guest argv/env transport')
let timeoutError: unknown
try { await run(['python3', '-c', 'import time; time.sleep(30)'], { timeoutMs: 100 }) } catch (error) { timeoutError = error }
assert.equal((timeoutError as { code: number }).code, 124)
console.log('PASS guest-owned timeout')
const controller = new AbortController()
const marker = '/tmp/dsh-superagent-smoke-' + randomUUID()
const code = 'import subprocess,sys,time; subprocess.Popen(["python3","-c",sys.argv[2],sys.argv[1]]);time.sleep(30)'
const childCode = 'import pathlib,sys,time;time.sleep(2);pathlib.Path(sys.argv[1]).write_text("survived")'
const work = run(['python3', '-c', code, marker, childCode], { signal: controller.signal })
const timer = setTimeout(() => controller.abort(new Error('smoke cancellation')), 500)
try { await assert.rejects(work, /smoke cancellation/) } finally { clearTimeout(timer) }
await new Promise(resolve => setTimeout(resolve, 2300))
assert.equal((await run(['python3', '-c', 'import os,sys;print(os.path.exists(sys.argv[1]))', marker])).trim(), 'False')
console.log('PASS abort kills guest descendant before delayed marker')
await assertDefaultWslUser(machine)
console.log('PASS shell/search use the same default Linux identity')
if (process.argv.includes('--github-check')) {
  const repository = required('SUPERAGENT_TEST_REPOSITORY')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('SUPERAGENT_TEST_REPOSITORY must be owner/name')
  const cli = process.env.SUPERAGENT_TEST_GH_CLI?.trim() || 'gh'
  const permission = JSON.parse(await run([cli, 'api', `repos/${repository}`, '--jq', '{repository:.full_name,push:.permissions.push}']))
  assert.equal(permission.repository, repository)
  assert.equal(permission.push, true)
  console.log('PASS Windows Host -> selected Linux gh -> repository permissions (read-only API)')
}
assert([...new Set([...Object.keys(before), ...Object.keys(process.env)])].every(key => process.env[key] === before[key]), 'Host environment changed')
console.log('PASS Host process environment unchanged')
