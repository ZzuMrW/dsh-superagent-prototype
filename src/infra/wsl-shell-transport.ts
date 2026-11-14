/** Private standard-shell transport. Nonces scope cancellation to one guest process group. */
/** Total UTF-8 serialized input limit, matching the bounded runWsl API transport. */
export const MAX_WSL_SHELL_INPUT_BYTES = 64 * 1024 * 1024
/** The framed guest request exceeds the bounded transport budget and must be shortened before any process starts. */
export class WslShellInputTooLargeError extends RangeError {
  readonly code = 'WSL_SHELL_INPUT_TOO_LARGE' as const
  constructor(limit = MAX_WSL_SHELL_INPUT_BYTES) {
    super(`WSL shell input frame exceeds ${limit} bytes (64 MiB production maximum); shorten command, stdin, or environment`)
  }
}
/** O(1) raw lower-bound guard before scanning an individual caller-owned string. */
export function assertWslShellTextFits(value: unknown, limit = MAX_WSL_SHELL_INPUT_BYTES): asserts value is string {
  if (typeof value !== 'string') throw new TypeError('WSL shell input fields must be strings')
  if (value.length > limit) throw new WslShellInputTooLargeError(limit)
}
export interface WslShellFrame {
  id: string; uid: number; bootId: string; graceMs: number; cwd: string
  argv: string[]; env: Record<string, string | null>; stdin: string
}
/** Count exact JSON escaped UTF-8 bytes BEFORE allocating JSON. Smaller caps are for pure-helper tests only. */
export function serializeWslShellFrame(frame: WslShellFrame, limit = MAX_WSL_SHELL_INPUT_BYTES): string {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_WSL_SHELL_INPUT_BYTES) throw new RangeError('Invalid WSL shell frame limit')
  let bytes = 0
  const add = (count: number) => {
    if (count > limit - bytes) throw new WslShellInputTooLargeError(limit)
    bytes += count
  }
  const text = (value: string) => {
    add(2)
    if (value.length > limit - bytes) throw new WslShellInputTooLargeError(limit)
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index)
      if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) add(2)
      else if (code < 32) add(6)
      else if (code < 128) add(1)
      else if (code < 2048) add(2)
      else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { add(4); index++ }
      else if (code >= 0xd800 && code <= 0xdfff) add(6) // JSON's well-formed lone-surrogate escape.
      else add(3)
    }
  }
  const count = (value: unknown): void => {
    if (value === null) { add(4); return }
    if (typeof value === 'string') { text(value); return }
    if (typeof value === 'number' && Number.isFinite(value)) { add(String(value).length); return }
    if (typeof value === 'boolean') { add(value ? 4 : 5); return }
    if (typeof value !== 'object' || 'toJSON' in value) throw new TypeError('Invalid WSL shell frame value')
    if (Array.isArray(value)) {
      add(2)
      for (let index = 0; index < value.length; index++) { if (index) add(1); count(value[index]) }
      return
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Invalid WSL shell frame object')
    add(2)
    let first = true
    for (const key in value) if (Object.hasOwn(value, key)) {
      if (!first) add(1)
      first = false
      text(key); add(1); count((value as Record<string, unknown>)[key])
    }
  }
  count(frame)
  return JSON.stringify(frame)
}
export const SHELL_MONITOR = String.raw`
import os,sys,json,base64,subprocess,signal,time,ctypes,tempfile,uuid
MAX_FRAME_BYTES=${MAX_WSL_SHELL_INPUT_BYTES}
# The small out-of-band nonce makes even a rejected frame positively cleanable.
# Production uses stdin framing; base64 argv remains solely for legacy protocol tests.
framed=sys.argv[1]=='--frame'
p=None if framed else json.loads(base64.b64decode(sys.argv[1]))
ident=str(uuid.UUID(sys.argv[2])) if framed else str(uuid.UUID(p['id']))
root='/tmp/dsh-shell-'+ident
os.makedirs(root,mode=0o700,exist_ok=True)
# Adopt and reap grandchildren rather than leaving zombies with WSL's init.
if ctypes.CDLL(None).prctl(36,1,0,0,0)!=0: raise RuntimeError('cannot establish guest subreaper')
child=None
cancelled=False
def stop(signum=None,frame=None):
 global cancelled
 cancelled=True
signal.signal(signal.SIGTERM,stop)
signal.signal(signal.SIGHUP,stop)
def exited():
 # WNOWAIT reserves the leader PID until group cleanup, preventing PID/PGID reuse.
 return os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT) is not None
def group(sig):
 if child is not None:
  try: os.killpg(child.pid,sig)
  except ProcessLookupError: pass
failure=None
inputfile=None
commandfile=None
try:
 if framed:
  raw=sys.stdin.buffer.read(MAX_FRAME_BYTES+1)
  if len(raw)>MAX_FRAME_BYTES: raise ValueError('WSL_SHELL_INPUT_TOO_LARGE: shell input frame exceeds 64 MiB; shorten command, stdin, or environment')
  p=json.loads(raw)
  if p.get('id')!=ident: raise ValueError('WSL shell frame nonce mismatch')
  with open('/proc/sys/kernel/random/boot_id') as f: boot=f.read().strip()
  if os.getuid()!=p['uid'] or boot!=p['bootId']: raise RuntimeError('WSL guest UID or boot snapshot is stale')
 if not os.path.exists(root+'/cancel'):
  env=os.environ.copy()
  if framed:
   # Never inherit stale harness facts or ambient GitHub credentials from WSL interop.
   env={k:v for k,v in env.items() if not k.upper().startswith('DSH_') and k.upper() not in ('GH_TOKEN','GITHUB_TOKEN')}
   for k,v in p['env'].items():
    if v is None: env.pop(k,None)
    else: env[k]=v
   inputfile=tempfile.TemporaryFile()
   inputfile.write(p.get('stdin','').encode('utf-8')); inputfile.seek(0)
   # Linux also caps each argv element (~128KiB). Read an anonymous script fd
   # inside Bash, preserving ordinary stdin/$0 and non-sourced command semantics.
   commandfile=tempfile.TemporaryFile()
   commandfile.write(p['argv'][-1].encode('utf-8')); commandfile.seek(0)
  env['DSH_SHELL_NONCE']=p['id']
  argv=p['argv'][:-1]+['eval -- "$(< /proc/self/fd/'+str(commandfile.fileno())+')"'] if framed else p['argv']
  child=subprocess.Popen(argv,env=env,cwd=p.get('cwd'),stdin=inputfile if framed else None,
   pass_fds=(commandfile.fileno(),) if framed else (),start_new_session=True)
  with open(root+'/pid','w') as f: f.write(str(child.pid))
  while not exited():
   if cancelled or os.path.exists(root+'/cancel'):
    cancelled=True
    group(signal.SIGTERM)
    end=time.monotonic()+p['graceMs']/1000
    while not exited() and time.monotonic()<end: time.sleep(.01)
    break
   time.sleep(.01)
except Exception as e:
 failure=str(e)
 sys.stderr.write('WSL shell preparation failed: '+failure+'\n')
finally:
 group(signal.SIGKILL)
 if child is not None: child.wait()
 # Killed group members (including double-fork/setsid descendants) are adopted here.
 # These are our unreaped children, so their PIDs cannot be recycled during signalling.
 while True:
  with open('/proc/self/task/'+str(os.getpid())+'/children') as f: adopted=f.read().split()
  for pid in adopted:
   try: os.kill(int(pid),signal.SIGKILL)
   except ProcessLookupError: pass
  try: os.waitpid(-1,0)
  except ChildProcessError: break
 if inputfile is not None: inputfile.close()
 if commandfile is not None: commandfile.close()
 with open(root+'/done','w') as f: f.write(json.dumps({'error':failure}) if framed else 'done')
sys.exit(125 if failure else (130 if cancelled or child is None else (child.returncode if child.returncode>=0 else 128-child.returncode)))
`

/** Cancel only this nonce's monitor; never signal a saved/reusable PID from a second process. */
export const SHELL_CANCEL = String.raw`
import os,sys,signal,time,uuid
ident=str(uuid.UUID(sys.argv[1])); root='/tmp/dsh-shell-'+ident
os.makedirs(root,mode=0o700,exist_ok=True)
with open(root+'/cancel','w') as f: f.write(ident)
# The sentinel also handles cancellation before the monitor starts.
end=time.monotonic()+5
while not os.path.exists(root+'/done') and time.monotonic()<end: time.sleep(.025)
if not os.path.exists(root+'/done'):
 sys.stderr.write('guest cancellation was not confirmed by monitor\n'); sys.exit(1)
`
export const SHELL_CLEANUP = String.raw`
import os,shutil,sys,uuid,time
ident=str(uuid.UUID(sys.argv[1])); root='/tmp/dsh-shell-'+ident
# Transport exit is not guest exit. An absent nonce directory is not positive confirmation either.
if not os.path.exists(root+'/done'):
 os.makedirs(root,mode=0o700,exist_ok=True)
 with open(root+'/cancel','w') as f: f.write(ident)
 end=time.monotonic()+5
 while not os.path.exists(root+'/done') and time.monotonic()<end: time.sleep(.025)
 if not os.path.exists(root+'/done'):
  sys.stderr.write('guest cleanup was not confirmed by monitor; nonce retained\n'); sys.exit(1)
with open(root+'/done') as f: result=f.read()
shutil.rmtree(root)
if result!='done': sys.stdout.write(result)
`

export interface WslShellPlan {
  distro: string
  linuxCwd: string
  windowsCwd: string
  env: Record<string, string>
  argv: string[]
}
export function guestPython(plan: WslShellPlan, script: string, payload: string): string[] {
  const split = plan.argv.indexOf('-e')
  if (split < 0) throw new Error('WSL shell plan has no guest executable boundary')
  return [...plan.argv.slice(0, split + 1), 'python3', '-c', script, payload]
}
export function monitoredPlan(plan: WslShellPlan, id: string, graceMs: number): WslShellPlan {
  const argv = plan.argv.slice(plan.argv.indexOf('-e') + 1)
  const payload = Buffer.from(JSON.stringify({ id, argv, graceMs })).toString('base64')
  return { ...plan, argv: guestPython(plan, SHELL_MONITOR, payload) }
}
