/** Guest-only filesystem RPC. The transport MUST send payload through stdin, never argv. */
export const GUEST_FS_SCRIPT = String.raw`
import os, sys, json, stat, base64, hashlib, tempfile, fcntl, errno
class Failure(Exception):
    def __init__(self, code, message): self.code, self.message = code, message

def fail(code, message): raise Failure(code, message)
def version(s):
    return hashlib.sha256((q['identity'] + ':' + ':'.join(str(x) for x in (s.st_dev,s.st_ino,s.st_mode,s.st_size,s.st_mtime_ns,s.st_ctime_ns))).encode()).hexdigest()
def info(s, links=False):
    t = 'file' if stat.S_ISREG(s.st_mode) else 'directory' if stat.S_ISDIR(s.st_mode) else 'symlink' if links and stat.S_ISLNK(s.st_mode) else 'other'
    return dict(version=version(s),type=t,size=s.st_size)
def optional(path, links=False):
    try: return os.lstat(path) if links else os.stat(path)
    except FileNotFoundError: return None
def regular(s):
    if not stat.S_ISREG(s.st_mode): fail('FS_NOT_REGULAR_FILE','Not a regular file')
def text(data):
    if b'\0' in data: fail('FS_NOT_TEXT','NUL is not text')
    try: return data.decode('utf-8', errors='strict')
    except UnicodeError: fail('FS_NOT_TEXT','Invalid UTF-8')
def encode(s):
    try: data = s.encode('utf-8', errors='strict')
    except UnicodeError: fail('FS_NOT_TEXT','Invalid UTF-8')
    text(data)
    return data
def lf(s): return s.replace('\r\n','\n')
def read(path, cap, offset=0, window=False):
    # O_NONBLOCK makes FIFOs/devices fail type validation without hanging.
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as f:
        s = os.fstat(f.fileno()); regular(s)
        if not window and s.st_size > cap: fail('FS_TOO_LARGE','File exceeds byte limit')
        f.seek(offset)
        data = f.read(cap if window else cap+1)
        if len(data)>cap: fail('FS_TOO_LARGE','File exceeds byte limit')
        return data, s

def guard(path, expected):
    s = optional(path)
    if s: regular(s)
    if expected:
        if expected.get('kind') == 'createIfAbsent':
            if s is not None: fail('FS_NOT_OBSERVED','Target already exists')
        elif s is None or version(s) != expected['version']: fail('FS_STALE_VERSION','File version changed')
    return s

def fenced(path, request):
    # Recheck the exact canonical path at the guest boundary, including parent symlinks.
    if os.path.realpath(path) != path: fail('FS_STALE_VERSION','Target resolution changed')
    policy = request.get('policy')
    if not policy: return
    if policy['mode'] == 'read-only': fail('FS_SANDBOX_DENIED','File access denied under read-only mode')
    if policy['mode'] == 'workspace-write':
        roots = [os.path.realpath(x) for x in policy.get('roots',[])]
        if not any(os.path.commonpath([path,x]) == x for x in roots): fail('FS_SANDBOX_DENIED','File access denied under workspace-write mode')

def basis(path, cap):
    try: return lf(text(read(path, max(0,cap-1))[0]))
    except (OSError,Failure): return None

def publish(path, data, previous, expected, request, mode=None):
    fenced(path,request)
    # The same-directory stage and rename preserve atomic visibility and the original mode.
    fd, temp = tempfile.mkstemp(prefix='.dsh-fs-',dir=os.path.dirname(path))
    try:
        with os.fdopen(fd,'wb') as f:
            if mode is not None: os.fchmod(f.fileno(),mode)
            elif previous: os.fchmod(f.fileno(), stat.S_IMODE(previous.st_mode))
            else:
                mask = os.umask(0); os.umask(mask); os.fchmod(f.fileno(), 0o666 & ~mask)
            f.write(data); f.flush(); os.fsync(f.fileno())
        fresh = guard(path,expected)
        if previous is not None and (fresh is None or version(fresh) != version(previous)): fail('FS_STALE_VERSION','File changed during staging')
        if previous is None and fresh is not None: fail('FS_STALE_VERSION','File appeared during staging')
        fenced(path,request)
        if expected and expected.get('kind') == 'createIfAbsent':
            try: os.link(temp,path)
            except FileExistsError: fail('FS_NOT_OBSERVED','Target already exists')
            # Unlinking the staging hardlink changes ctime; only version the final link state.
            os.unlink(temp)
        else: os.replace(temp,path)
        return version(os.stat(path))
    finally:
        try: os.unlink(temp)
        except FileNotFoundError: pass

def errorcode(e):
    return {errno.ENOENT:'FS_NOT_FOUND',errno.ENOTDIR:'FS_NOT_DIRECTORY',errno.EACCES:'FS_PERMISSION_DENIED',errno.EPERM:'FS_PERMISSION_DENIED',errno.EISDIR:'FS_NOT_REGULAR_FILE',errno.EFBIG:'FS_TOO_LARGE',errno.ELOOP:'FS_STALE_VERSION'}.get(e.errno,'FS_IO_ERROR')

def move(q):
    source, destination = q['path'], q['destination']
    if not isinstance(destination,str) or not destination.startswith('/') or '\0' in destination: fail('FS_IO_ERROR','Invalid move destination')
    if source == destination: fail('FS_SAME_TARGET','Source and destination are identical')
    parents=[]
    try:
        for directory in sorted(set([os.path.dirname(source),os.path.dirname(destination)])):
            fd=os.open(directory,os.O_RDONLY | os.O_DIRECTORY); parents.append(fd); fcntl.flock(fd,fcntl.LOCK_EX)
        fenced(source,q); fenced(destination,q)
        src=guard(source,q.get('expectedSource'))
        if src is None: fail('FS_STALE_VERSION','Move source is absent')
        original=text(read(source,q['limit'])[0]); before=lf(original)
        content=q.get('content',original); data=encode(content)
        if len(data)>q['limit']: fail('FS_TOO_LARGE','Move content exceeds byte limit')
        dest=guard(destination,q.get('expectedDestination'))
        destBefore=basis(destination,q['limit']) if dest and len(data)<q['limit'] else None
        v=publish(destination,data,dest,q.get('expectedDestination'),q,stat.S_IMODE(src.st_mode))
        outcome=dict(sourceBefore=before,destination=dict(operation='update' if dest else 'create',version=v,before=destBefore,after=lf(content)))
        try:
            # A changed source after destination publication must be retained, never deleted silently.
            fresh=optional(source)
            if fresh is None or version(fresh)!=version(src): fail('FS_STALE_VERSION','Move source changed after publication')
            os.unlink(source); outcome['sourceDeleted']=True
        except (OSError,Failure) as e:
            outcome.update(sourceDeleted=False,sourceFailure=dict(code=e.code if isinstance(e,Failure) else errorcode(e),message=str(e)))
        return outcome
    finally:
        for fd in reversed(parents): os.close(fd)

def execute(q):
    op, path = q['op'], q['path']
    if not isinstance(path,str) or not path.startswith('/') or '\0' in path: fail('FS_IO_ERROR','An absolute guest path is required')
    if op == 'resolve': return os.path.realpath(path)
    if op in ('stat','lstat'):
        s = optional(path,op=='lstat'); return info(s,op=='lstat') if s else None
    if op in ('bytes','range','text'):
        data, s = read(path,q['cap'],q.get('offset',0),op=='range')
        return text(data) if op=='text' else dict(data=base64.b64encode(data).decode(),version=version(s))
    if op == 'list':
        result=[]
        with os.scandir(path) as entries:
            for e in entries:
                real=os.path.realpath(e.path); s=optional(real)
                item=dict(name=e.name,path=real,type='other')
                if s: item.update(info(s))
                result.append(item)
        return sorted(result,key=lambda e:e['name'])
    if op == 'move': return move(q)
    # flock on the parent directory coordinates independent RPC processes without persistent lock files.
    parent = os.open(os.path.dirname(path),os.O_RDONLY | os.O_DIRECTORY)
    try:
        fcntl.flock(parent,fcntl.LOCK_EX)
        fenced(path,q)
        s=guard(path,q.get('expected'))
        if op == 'delete':
            if s is None: fail('FS_STALE_VERSION','File is absent')
            before=basis(path,q['limit']); os.unlink(path); return dict(before=before)
        if op == 'write':
            data=encode(q['content']); before=basis(path,q['limit']) if s and len(data)<q['limit'] else None
            v=publish(path,data,s,q.get('expected'),q)
            return dict(operation='update' if s else 'create',version=v,before=before,after=lf(q['content']))
        if op == 'edit':
            if s is None: fail('FS_NOT_FOUND','File is absent')
            original=text(read(path,q['limit'])[0]); before=lf(original)
            old,new=lf(q['edit']['oldString']),lf(q['edit']['newString'])
            encode(old); encode(new)
            if not old: fail('FS_EDIT_NOT_FOUND','Search text must not be empty')
            count=before.count(old)
            if count==0: fail('FS_EDIT_NOT_FOUND','Search text not found')
            if count>1 and not q['edit']['replaceAll']: fail('FS_AMBIGUOUS_EDIT','Search text matches more than once')
            after=before.replace(old,new) if q['edit']['replaceAll'] else before.replace(old,new,1)
            # Preserve CRLF storage style; outcome text always uses LF.
            stored=after.replace('\n','\r\n') if '\r\n' in original and '\n' not in original.replace('\r\n','') else after
            data=encode(stored)
            if len(data)>q['limit']: fail('FS_TOO_LARGE','Edited file exceeds byte limit')
            v=publish(path,data,s,q.get('expected'),q)
            return dict(version=v,before=before,after=after)
        fail('FS_IO_ERROR','Unsupported operation')
    finally: os.close(parent)
try:
    q=json.load(sys.stdin); result=execute(q)
    print(json.dumps(dict(ok=True,value=result),ensure_ascii=True,separators=(',',':')))
except Failure as e: print(json.dumps(dict(ok=False,code=e.code,message=e.message)))
except OSError as e:
    code=errorcode(e)
    print(json.dumps(dict(ok=False,code=code,message=str(e))))
except (ValueError,KeyError,TypeError,UnicodeError) as e: print(json.dumps(dict(ok=False,code='FS_IO_ERROR',message=str(e))))
`
