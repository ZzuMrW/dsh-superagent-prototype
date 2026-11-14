/** Windows-host WSL argv transport. No shell interpolation and no mutation of the Host environment. */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { posix, join } from 'node:path'
import type { Machine } from '../deployment.ts'

export type ExecutionMachine = Pick<Machine, 'stateDir' | 'wsl'>
export function guestPath(machine: ExecutionMachine, path: string): string {
  if (!machine.wsl) return path
  if (path.startsWith('/')) return path
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(path)
  if (drive) return `/mnt/${drive[1]!.toLowerCase()}/${drive[2]!.replaceAll('\\', '/')}`
  const unc = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(\\.*)?$/i.exec(path)
  if (unc && unc[1]!.toLowerCase() === machine.wsl.distro.toLowerCase()) return (unc[2] ?? '\\').replaceAll('\\', '/')
  throw new Error(`Cannot map path into WSL ${machine.wsl.distro}: ${path}`)
}
export const executionStateDir = (machine: ExecutionMachine): string => machine.wsl ? posix.join(guestPath(machine, machine.stateDir), 'execution') : machine.stateDir
export const executionPath = (machine: ExecutionMachine, ...parts: string[]): string => (machine.wsl ? posix.join : join)(executionStateDir(machine), ...parts)

export interface WslRequest {
  argv: string[]
  cwd: string
  env?: Record<string, string | undefined>
  signal: AbortSignal
  timeoutMs?: number
  maxBuffer?: number
}
/** Encoded payload keeps cwd/env/argv out of shell syntax. The guest owns timeout and process-group cleanup. */
export const WSL_RUNNER = String.raw`
import os,sys,json,base64,subprocess,signal,time,tempfile,shutil
p=json.loads(base64.b64decode(sys.argv[1]))
root='/tmp/dsh-superagent-'+p['id']
os.makedirs(root,mode=0o700,exist_ok=True)
os.chmod(root,0o700)
child=None
try:
 env=os.environ.copy()
 for k,v in p['env'].items():
  if v is None: env.pop(k,None)
  else: env[k]=v
 if os.path.exists(root+'/cancel'): sys.exit(130)
 env['DSH_SUPERAGENT_RUN']=p['id']
 child=subprocess.Popen(p['argv'],cwd=p['cwd'],env=env,stdin=subprocess.DEVNULL,start_new_session=True)
 with open(root+'/pid','w') as f: f.write(str(child.pid))
 os.chmod(root+'/pid',0o600)
 deadline=time.monotonic()+p['timeoutMs']/1000
 while child.poll() is None:
  if os.path.exists(root+'/cancel') or time.monotonic()>=deadline:
   try: os.killpg(child.pid,signal.SIGTERM)
   except ProcessLookupError: pass
   try: child.wait(timeout=2)
   except subprocess.TimeoutExpired:
    try: os.killpg(child.pid,signal.SIGKILL)
    except ProcessLookupError: pass
    child.wait()
   sys.stderr.write('WSL command cancelled or timed out\n')
   sys.exit(124)
  time.sleep(.025)
 sys.exit(child.returncode if child.returncode>=0 else 128-child.returncode)
finally:
 if child is not None:
  # Also stop descendants which outlived the direct command.
  try: os.killpg(child.pid,signal.SIGKILL)
  except ProcessLookupError: pass
 shutil.rmtree(root,ignore_errors=True)
`
export const WSL_CANCEL = String.raw`
import os,sys,signal,time
root='/tmp/dsh-superagent-'+sys.argv[1]
os.makedirs(root,mode=0o700,exist_ok=True)
os.chmod(root,0o700)
try:
 with open(root+'/cancel','w') as f: f.write(sys.argv[1])
 os.chmod(root+'/cancel',0o600)
 # If the transport died, the monitor may have died too. Never trust a reused PID: verify this invocation's nonce in /proc.
 with open(root+'/pid') as f: pid=int(f.read())
 for sig in (signal.SIGTERM,signal.SIGKILL):
  with open('/proc/'+str(pid)+'/environ','rb') as f: tagged=('DSH_SUPERAGENT_RUN='+sys.argv[1]).encode() in f.read().split(b'\0')
  if not tagged: break
  os.killpg(pid,sig)
  time.sleep(.1)
except (FileNotFoundError,ProcessLookupError): pass
`
export function wslArguments(machine: ExecutionMachine, script: string, payload: string): string[] {
  if (!machine.wsl) throw new Error('WSL backend is not configured')
  return ['--distribution', machine.wsl.distro, '--user', machine.wsl.user, '--exec', 'python3', '-c', script, payload]
}
/** File/search providers use the distro default user; refuse a split-identity deployment. */
export async function assertDefaultWslUser(machine: ExecutionMachine): Promise<void> {
  if (!machine.wsl) return
  const target = machine.wsl
  const user = await new Promise<string>((resolve, reject) => {
    execFile('wsl.exe', ['--distribution', target.distro, '--exec', 'id', '-un'],
      { windowsHide: true, encoding: 'utf8', timeout: 15_000 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()))
  })
  if (user !== target.user) throw new Error(`WSL user ${target.user} differs from the distribution default ${user}; this adapter requires one identity for shell, search and files`)
}
export async function runWsl(machine: ExecutionMachine, request: WslRequest): Promise<string> {
  request.signal.throwIfAborted()
  const id = randomUUID()
  const env = Object.fromEntries(Object.entries(request.env ?? {}).map(([key, value]) => [key, value ?? null]))
  const payload = Buffer.from(JSON.stringify({ id, argv: request.argv, cwd: request.cwd, env, timeoutMs: request.timeoutMs ?? 90_000 })).toString('base64')
  let cancel: Promise<void> | undefined
  const abort = () => { cancel ??= new Promise<void>(resolve => {
    execFile('wsl.exe', wslArguments(machine, WSL_CANCEL, id), { windowsHide: true, timeout: 10_000 }, () => resolve())
  }) }
  request.signal.addEventListener('abort', abort, { once: true })
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile('wsl.exe', wslArguments(machine, WSL_RUNNER, payload), {
        windowsHide: true, encoding: 'utf8', maxBuffer: request.maxBuffer ?? 16 * 1024 * 1024,
        // Guest timeout is authoritative. This bounds a broken transport without normally killing it before cleanup.
        timeout: (request.timeoutMs ?? 90_000) + 15_000,
      }, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }))
        else resolve(stdout)
      })
      if (request.signal.aborted) abort()
    })
    request.signal.throwIfAborted()
    return output
  } catch (error) {
    // A maxBuffer or broken transport must also request guest cleanup.
    if (!request.signal.aborted && !(typeof (error as { code?: unknown })?.code === 'number')) abort()
    if (request.signal.aborted) throw request.signal.reason
    throw error
  } finally {
    request.signal.removeEventListener('abort', abort)
    if (cancel) {
      await cancel
      // An abort racing a successful completion can create its sentinel after the monitor already removed the directory.
      await new Promise<void>(resolve => {
        const cleanup = 'import shutil,sys,uuid; ident=str(uuid.UUID(sys.argv[1])); shutil.rmtree("/tmp/dsh-superagent-"+ident,ignore_errors=True)'
        execFile('wsl.exe', wslArguments(machine, cleanup, id), { windowsHide: true, timeout: 10_000 }, () => resolve())
      })
    }
  }
}

export async function resolveWslExecutable(machine: ExecutionMachine, name: string, probe: (argv: string[]) => Promise<string>): Promise<string> {
  if (name.includes('/') && !name.startsWith('/')) throw new Error('CLI must be a command name or Linux absolute path')
  const program = `import os,sys,shutil\np=shutil.which(sys.argv[1])\nif not p or not os.path.isfile(p): sys.exit(1)\nprint(os.path.abspath(p))`
  const path = (await probe(['python3', '-c', program, name])).trim()
  if (!path.startsWith('/') || path.includes('\n')) throw new Error(`Cannot resolve ${name} in ${machine.wsl?.distro}`)
  return path
}

export async function guestFs(machine: ExecutionMachine, operation: 'exists' | 'mkdir' | 'rmdir', path: string, signal: AbortSignal): Promise<boolean> {
  const script = `import os,sys\nop,p=sys.argv[1:]\nif op=='exists': print('1' if os.path.exists(p) else '0')\nelif op=='mkdir': os.makedirs(p,exist_ok=True)\nelse: os.rmdir(p)`
  return (await runWsl(machine, { argv: ['python3', '-c', script, operation, path], cwd: '/', signal })).trim() === '1'
}
