/** Immutable credential-free guest generations. No active file or symlink is changed during staging. */
import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { Deployment } from '../deployment.ts'
import { agentVariables, credentialHelper, WORKER_COMMANDS } from '../infra/environment.ts'
import { runWsl } from '../infra/wsl.ts'
import { commandEnvironment, environmentSnapshot, freezeExecutionSnapshot, freezeTarget, type ExecutionSnapshot } from './target.ts'
import type { ResolvedGuest } from './resolve.ts'
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
const gitQuote = (s: string) => `"${s.replace(/[\\"]/g, c => `\\${c}`)}"`
export interface GuestGeneration { deployment: Deployment; snapshot: ExecutionSnapshot; directory: string }
export const STAGE_GENERATION = String.raw`
import os,sys,json,stat,subprocess,shutil
p=json.load(sys.stdin); home=p['home']; uid=os.getuid(); root=home
info=os.lstat(home)
if not stat.S_ISDIR(info.st_mode) or info.st_uid!=uid or os.path.realpath(home)!=home: raise RuntimeError('unsafe selected home')
for name in ['.local','state','dsh-superagent',p['deploymentId'],'generations']:
 root=os.path.join(root,name)
 try: os.mkdir(root,0o700)
 except FileExistsError: pass
 info=os.lstat(root)
 if not stat.S_ISDIR(info.st_mode) or info.st_uid!=uid: raise RuntimeError('unsafe generation parent')
 os.chmod(root,0o700)
directory=os.path.join(root,p['generationId']); os.mkdir(directory,0o700)
try:
 os.mkdir(directory+'/worker-bin',0o700)
 for name,body in p['files'].items():
  target=os.path.join(directory,name)
  with open(target,'x') as f: f.write(body)
  os.chmod(target,0o700 if name.startswith('worker-bin/') else 0o600)
  if name.startswith('worker-bin/'): subprocess.run(['sh','-n',target],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 env=os.environ.copy()
 for key in p['unset']: env.pop(key,None)
 env.update(p['set'])
 actual=subprocess.check_output(['git','config','-z','--show-origin','--get-all','credential.https://github.com.helper'],cwd=directory,env=env)
 expected=('file:'+directory+'/worker-gitconfig\0'+p['helper']+'\0').encode()
 if actual!=expected: raise RuntimeError('generation verification failed')
except BaseException:
 shutil.rmtree(directory)
 raise
print(directory)
`
/** Pure expected bytes shared by staging and same-generation recovery. */
export function guestEnvironmentFiles(deployment: Pick<Deployment, 'github'>, blocked: readonly string[], bin: string): Record<string, string> {
  const unshim = [`self=${quote(bin)}`, 'rest=', 'IFS=:', 'set -f',
    'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done', 'set +f', 'unset IFS', 'PATH=$rest', 'export PATH'].join('\n')
  const script = (body: string) => `#!/bin/sh\n# Immutable dsh-superagent generation; no credentials.\n${body}\n`
  const files: Record<string, string> = {
    'worker-bin/gh': script(`${unshim}\nexec ${quote(deployment.github.cli)} "$@"`),
    'worker-bin/lark-cli': script('echo "lark-cli unavailable in this execution target" >&2\nexit 1'),
    'worker-gitconfig': ['# Immutable dsh-superagent generation; no credentials.', '[user]', '\tuseConfigOnly = true',
      '[credential]', '\thelper =', '[credential "https://github.com"]', `\thelper = ${gitQuote(credentialHelper(deployment.github.cli))}`,
      '[url "https://github.com/"]', '\tinsteadOf = git@github.com:', '\tinsteadOf = ssh://git@github.com/',
      '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true', ''].join('\n'),
  }
  for (const name of blocked) {
    if (!/^[A-Za-z0-9_.+-]+$/.test(name) || name === '.' || name === '..') throw new Error('Invalid blocked command')
    if (!WORKER_COMMANDS.includes(name)) files[`worker-bin/${name}`] = script(`echo ${quote(`${name} is blocked in this installation`)} >&2\nexit 1`)
  }
  return files
}
export async function stageGuestGeneration(deployment: Deployment, guest: ResolvedGuest, deploymentId: string,
  revision: number, blocked: readonly string[], signal: AbortSignal): Promise<GuestGeneration> {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(deploymentId)) throw new Error('Invalid deployment ID')
  const generationId = randomUUID(), directory = posix.join(guest.identity.home, '.local/state/dsh-superagent', deploymentId, 'generations', generationId)
  const bin = posix.join(directory, 'worker-bin')
  const env = environmentSnapshot({ ...agentVariables(directory, 'posix'), HOME: guest.identity.home, GH_PROMPT_DISABLED: '1',
    PATH: [bin, ...guest.path.split(':').filter(p => !p.includes('/dsh-superagent/') && !/\.(exe|cmd|bat)$/i.test(p))].join(':') })
  const files = guestEnvironmentFiles(deployment, blocked, bin)
  await runWsl(deployment, { argv: ['python3', '-c', STAGE_GENERATION], cwd: '/', expectedIdentity: guest.identity,
    stdin: JSON.stringify({ home: guest.identity.home, deploymentId, generationId, files, ...env, helper: credentialHelper(deployment.github.cli) }), signal, timeoutMs: 60_000 })
  const snapshot = freezeExecutionSnapshot(revision, freezeTarget(guest.identity, guest.workspace, generationId, new Date().toISOString()), env,
    { deployment: guest.deploymentWorkspace, tickets: guest.workspace })
  return { deployment, snapshot, directory }
}
/** Verify current owned bytes and Git origin without repair, account switching or filesystem writes. */
export const VERIFY_GUEST_GENERATION = String.raw`
import os,sys,json,stat,hashlib,subprocess
p=json.load(sys.stdin); directory=p['directory']; uid=os.getuid()
if os.path.realpath(directory)!=directory: raise RuntimeError('generation coordinate changed')
for path in [directory,directory+'/worker-bin']:
 info=os.lstat(path)
 if not stat.S_ISDIR(info.st_mode) or info.st_uid!=uid or stat.S_IMODE(info.st_mode)!=0o700: raise RuntimeError('generation directory changed')
if set(os.listdir(directory))!={'worker-bin','worker-gitconfig'}: raise RuntimeError('generation inventory changed')
if set(os.listdir(directory+'/worker-bin'))!={name[11:] for name in p['files'] if name.startswith('worker-bin/')}: raise RuntimeError('shim inventory changed')
for name,expected in p['files'].items():
 path=os.path.join(directory,name); info=os.lstat(path)
 if not stat.S_ISREG(info.st_mode) or info.st_uid!=uid or info.st_size!=expected['bytes']: raise RuntimeError('generation file changed')
 if info.st_mode&0o022 or name.startswith('worker-bin/') and not info.st_mode&0o111: raise RuntimeError('generation mode changed')
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb') as f: data=f.read(expected['bytes']+1)
 if hashlib.sha256(data).hexdigest()!=expected['sha256']: raise RuntimeError('generation bytes changed')
actual=subprocess.check_output(['git','config','-z','--show-origin','--get-all','credential.https://github.com.helper'],cwd=directory)
expected=('file:'+directory+'/worker-gitconfig\0'+p['helper']+'\0').encode()
if actual!=expected: raise RuntimeError('generation helper origin changed')
`
export async function verifyGuestGeneration(stage: GuestGeneration, blocked: readonly string[], signal: AbortSignal): Promise<void> {
  const { snapshot, directory, deployment } = stage
  const prefix = posix.join(snapshot.target.home, '.local/state/dsh-superagent') + '/'
  const parts = directory.startsWith(prefix) ? directory.slice(prefix.length).split('/') : []
  if (parts.length !== 3 || parts[1] !== 'generations' || parts[2] !== snapshot.target.generationId) throw new Error('Unverified active generation')
  const files = guestEnvironmentFiles(deployment, blocked, posix.join(directory, 'worker-bin'))
  const expected = Object.fromEntries(Object.entries(files).map(([name, text]) => [name, { bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') }]))
  await runWsl(deployment, { argv: ['python3', '-c', VERIFY_GUEST_GENERATION], cwd: '/', env: commandEnvironment(snapshot.environment),
    expectedIdentity: snapshot.target, stdin: JSON.stringify({ directory, files: expected, helper: credentialHelper(deployment.github.cli) }), signal, timeoutMs: 60_000 })
}

export async function discardGuestGeneration(stage: GuestGeneration, signal: AbortSignal): Promise<void> {
  // Only a newly generated leaf is removed, never a parent or an active generation.
  if (!/^[a-f0-9-]{36}$/.test(stage.snapshot.target.generationId) || posix.basename(stage.directory) !== stage.snapshot.target.generationId) throw new Error('Invalid generation cleanup')
  await runWsl(stage.deployment, { argv: ['python3', '-c', 'import os,sys,shutil,stat\np=sys.argv[1]; s=os.lstat(p)\nif not stat.S_ISDIR(s.st_mode) or s.st_uid!=os.getuid(): raise RuntimeError("unsafe stage")\nshutil.rmtree(p)', stage.directory], cwd: '/',
    env: commandEnvironment(stage.snapshot.environment), expectedIdentity: stage.snapshot.target, signal, timeoutMs: 60_000 })
}
