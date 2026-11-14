/** Private standard-shell transport. Nonces scope cancellation to one guest process group. */
export const SHELL_MONITOR = String.raw`
import os,sys,json,base64,subprocess,signal,time,ctypes
p=json.loads(base64.b64decode(sys.argv[1]))
root='/tmp/dsh-shell-'+p['id']
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
try:
 if not os.path.exists(root+'/cancel'):
  env=os.environ.copy(); env['DSH_SHELL_NONCE']=p['id']
  child=subprocess.Popen(p['argv'],env=env,start_new_session=True)
  with open(root+'/pid','w') as f: f.write(str(child.pid))
  while not exited():
   if cancelled or os.path.exists(root+'/cancel'):
    cancelled=True
    group(signal.SIGTERM)
    end=time.monotonic()+p['graceMs']/1000
    while not exited() and time.monotonic()<end: time.sleep(.01)
    break
   time.sleep(.01)
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
 with open(root+'/done','w') as f: f.write('done')
sys.exit(130 if cancelled or child is None else (child.returncode if child.returncode>=0 else 128-child.returncode))
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
shutil.rmtree(root)
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
