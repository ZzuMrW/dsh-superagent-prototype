/** Windows-host WSL transport. Payloads and optional child input are framed on stdin, never shell syntax. */
import { execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { posix, join } from 'node:path'
import type { Machine } from '../deployment.ts'

export type ExecutionMachine = Pick<Machine, 'stateDir' | 'wsl'>
/** Legacy mapping retained until callers have a verified execution-target mapping. */
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
export const MAX_WSL_INPUT_BYTES = 64 * 1024 * 1024
export const MAX_WSL_HEADER_BYTES = 8 * 1024 * 1024
export interface WslRequest {
  argv: string[]
  cwd: string
  env?: Record<string, string | undefined>
  stdin?: string | Uint8Array
  expectedIdentity?: { uid: number; bootId: string }
  signal: AbortSignal
  timeoutMs?: number
  maxBuffer?: number
}

/** Guest owns the deadline and child process tree; WNOWAIT prevents leader PID reuse during cleanup. */
export const WSL_RUNNER = String.raw`
import os,sys,json,base64,subprocess,signal,time,shutil,uuid,threading,ctypes,stat
arg=sys.argv[1]
framed=arg.startswith('frame:')
ident=str(uuid.UUID(arg[6:])) if framed else str(uuid.UUID(json.loads(base64.b64decode(arg))['id']))
root='/tmp/dsh-superagent-'+ident
os.makedirs(root,mode=0o700,exist_ok=True)
s=os.lstat(root)
if not stat.S_ISDIR(s.st_mode) or s.st_uid!=os.getuid(): raise RuntimeError('unsafe invocation directory')
os.chmod(root,0o700)
child=None; cancelled=False; timedout=False

def stop(signum=None,frame=None):
 global cancelled
 cancelled=True
signal.signal(signal.SIGTERM,stop)
signal.signal(signal.SIGHUP,stop)
def exact(n):
 data=bytearray()
 while len(data)<n:
  part=sys.stdin.buffer.read(min(65536,n-len(data)))
  if not part: raise ValueError('incomplete WSL input frame')
  data.extend(part)
 return bytes(data)
def group(sig):
 if child is not None:
  try: os.killpg(child.pid,sig)
  except ProcessLookupError: pass
def exited():
 return os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT) is not None
try:
 if ctypes.CDLL(None).prctl(36,1,0,0,0)!=0: raise RuntimeError('cannot establish guest subreaper')
 if framed:
  line=sys.stdin.buffer.readline(32)
  if not line.endswith(b'\n'): raise ValueError('invalid WSL input frame length')
  size=int(line)
  if size<1 or size>8388608: raise ValueError('WSL input header too large')
  p=json.loads(exact(size))
  length=p.get('stdinLength',0)
  if not isinstance(length,int) or length<0 or size+length>67108864: raise ValueError('WSL input too large')
  input_data=exact(length) if p.get('hasStdin') else None
 else:
  p=json.loads(base64.b64decode(arg)); input_data=None
 if str(uuid.UUID(p['id']))!=ident: raise ValueError('WSL invocation identity mismatch')
 expected=p.get('expectedIdentity')
 if expected is not None:
  with open('/proc/sys/kernel/random/boot_id') as f: boot=f.read().strip()
  if expected.get('uid')!=os.getuid() or expected.get('bootId')!=boot: raise RuntimeError('DSH_TARGET_IDENTITY_CHANGED')
 if cancelled or os.path.exists(root+'/cancel'): cancelled=True
 else:
  env=os.environ.copy()
  for k,v in p['env'].items():
   if v is None: env.pop(k,None)
   else: env[k]=v
  env['DSH_SUPERAGENT_RUN']=ident
  child=subprocess.Popen(p['argv'],cwd=p['cwd'],env=env,stdin=subprocess.PIPE if input_data is not None else subprocess.DEVNULL,start_new_session=True)
  with open(root+'/pid','w') as f: f.write(str(child.pid))
  os.chmod(root+'/pid',0o600)
  if input_data is not None:
   def feed():
    try: child.stdin.write(input_data); child.stdin.close()
    except (BrokenPipeError,OSError): pass
   threading.Thread(target=feed,daemon=True).start()
  deadline=time.monotonic()+p['timeoutMs']/1000
  while not exited():
   cancelled=cancelled or os.path.exists(root+'/cancel')
   timedout=time.monotonic()>=deadline
   if cancelled or timedout:
    group(signal.SIGTERM)
    end=time.monotonic()+2
    while not exited() and time.monotonic()<end: time.sleep(.01)
    break
   time.sleep(.01)
finally:
 group(signal.SIGKILL)
 if child is not None: child.wait()
 while True:
  with open('/proc/self/task/'+str(os.getpid())+'/children') as f: adopted=f.read().split()
  for pid in adopted:
   try: os.kill(int(pid),signal.SIGKILL)
   except ProcessLookupError: pass
  try: os.waitpid(-1,0)
  except ChildProcessError: break
 with open(root+'/done','w') as f: f.write(ident)
if timedout: sys.stderr.write('WSL command timed out\n'); sys.exit(124)
if cancelled or child is None: sys.stderr.write('WSL command cancelled\n'); sys.exit(130)
sys.exit(child.returncode if child.returncode>=0 else 128-child.returncode)
`
export const WSL_CANCEL = String.raw`
import os,sys,time,uuid,stat
ident=str(uuid.UUID(sys.argv[1])); root='/tmp/dsh-superagent-'+ident
os.makedirs(root,mode=0o700,exist_ok=True)
s=os.lstat(root)
if not stat.S_ISDIR(s.st_mode) or s.st_uid!=os.getuid(): raise RuntimeError('unsafe invocation directory')
with open(root+'/cancel','w') as f: f.write(ident)
os.chmod(root+'/cancel',0o600)
end=time.monotonic()+5
while not os.path.exists(root+'/done') and time.monotonic()<end: time.sleep(.025)
if not os.path.exists(root+'/done'): sys.stderr.write('guest cancellation unconfirmed\n'); sys.exit(1)
`
export const WSL_CLEANUP = String.raw`
import os,sys,time,uuid,shutil,stat
ident=str(uuid.UUID(sys.argv[1])); root='/tmp/dsh-superagent-'+ident
os.makedirs(root,mode=0o700,exist_ok=True)
s=os.lstat(root)
if not stat.S_ISDIR(s.st_mode) or s.st_uid!=os.getuid(): raise RuntimeError('unsafe invocation directory')
if not os.path.exists(root+'/done'):
 with open(root+'/cancel','w') as f: f.write(ident)
 end=time.monotonic()+5
 while not os.path.exists(root+'/done') and time.monotonic()<end: time.sleep(.025)
 if not os.path.exists(root+'/done'): sys.stderr.write('guest cleanup unconfirmed; nonce retained\n'); sys.exit(1)
with open(root+'/done') as f: done=f.read()
if done!=ident: raise RuntimeError('guest completion identity mismatch')
shutil.rmtree(root)
`
export function wslArguments(machine: ExecutionMachine, script: string, payload: string): string[] {
  if (!machine.wsl) throw new Error('WSL backend is not configured')
  return ['--distribution', machine.wsl.distro, '--user', machine.wsl.user, '--exec', 'python3', '-c', script, payload]
}
/** Construct a bounded stdin frame; null bytes and shell-looking text remain ordinary data. */
export function wslInputFrame(id: string, request: Omit<WslRequest, 'signal'>): Buffer {
  const input = request.stdin === undefined ? Buffer.alloc(0) : Buffer.from(request.stdin)
  const header = Buffer.from(JSON.stringify({ id, argv: request.argv, cwd: request.cwd,
    env: Object.fromEntries(Object.entries(request.env ?? {}).map(([key, value]) => [key, value ?? null])),
    timeoutMs: request.timeoutMs ?? 90_000, hasStdin: request.stdin !== undefined, stdinLength: input.length,
    ...request.expectedIdentity ? { expectedIdentity: request.expectedIdentity } : {} }))
  if (header.length > MAX_WSL_HEADER_BYTES || header.length + input.length > MAX_WSL_INPUT_BYTES) throw new Error('WSL input exceeds the transport limit')
  return Buffer.concat([Buffer.from(`${header.length}\n`), header, input])
}
/** Legacy guard stays until every file/search consumer is user-aware. */
export async function assertDefaultWslUser(machine: ExecutionMachine): Promise<void> {
  if (!machine.wsl) return
  const target = machine.wsl
  const user = await new Promise<string>((resolve, reject) => {
    execFile('wsl.exe', ['--distribution', target.distro, '--exec', 'id', '-un'],
      { windowsHide: true, encoding: 'utf8', timeout: 15_000 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()))
  })
  if (user !== target.user) throw new Error(`WSL user ${target.user} differs from the distribution default ${user}; this adapter requires one identity for shell, search and files`)
}
/** Explicit cleanup uncertainty must block callers rather than being mistaken for a successful cancellation. */
export class WslCleanupError extends Error {
  readonly code = 'WSL_CLEANUP_UNCONFIRMED'
}
function control(machine: ExecutionMachine, script: string, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('wsl.exe', wslArguments(machine, script, id), { windowsHide: true, timeout: 10_000, maxBuffer: 65536 },
      (error, _stdout, stderr) => error ? reject(new WslCleanupError(stderr.trim() || 'WSL guest cleanup was not confirmed')) : resolve())
  })
}
export async function runWsl(machine: ExecutionMachine, request: WslRequest): Promise<string> {
  request.signal.throwIfAborted()
  if (!machine.wsl) throw new Error('WSL backend is not configured')
  if (!request.argv.length || request.argv.some(value => typeof value !== 'string' || value.includes('\0')) || !request.cwd.startsWith('/') || request.cwd.includes('\0')) throw new Error('Invalid guest argv/cwd')
  if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0)) throw new Error('Invalid guest timeout')
  if (request.maxBuffer !== undefined && (!Number.isSafeInteger(request.maxBuffer) || request.maxBuffer <= 0)) throw new Error('Invalid guest output limit')
  const id = randomUUID(), frame = wslInputFrame(id, request)
  let child: ChildProcess | undefined, cancellation: Promise<void> | undefined
  const abort = () => {
    cancellation ??= control(machine, WSL_CANCEL, id).catch(() => { child?.kill(); child?.stdin?.destroy() })
  }
  request.signal.addEventListener('abort', abort, { once: true })
  let failure: unknown, output = ''
  try {
    output = await new Promise<string>((resolve, reject) => {
      child = execFile('wsl.exe', wslArguments(machine, WSL_RUNNER, 'frame:' + id), {
        windowsHide: true, encoding: 'utf8', maxBuffer: request.maxBuffer ?? 16 * 1024 * 1024,
        timeout: (request.timeoutMs ?? 90_000) + 15_000,
      }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve(stdout))
      child.stdin?.on('error', () => { /* The exit callback and positive cleanup classify broken input. */ })
      child.stdin?.end(frame)
      if (request.signal.aborted) abort()
    })
  } catch (error) {
    failure = error
    if (!request.signal.aborted && typeof (error as { code?: unknown })?.code !== 'number') abort()
  } finally {
    request.signal.removeEventListener('abort', abort)
    await cancellation
    try { await control(machine, WSL_CLEANUP, id) }
    catch (error) {
      throw new WslCleanupError(`${request.signal.aborted ? String(request.signal.reason) + '; ' : ''}WSL guest cleanup not confirmed`, { cause: error })
    }
  }
  request.signal.throwIfAborted()
  if (failure !== undefined) throw failure
  return output
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
