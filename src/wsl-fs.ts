/** Public guest filesystem provider; no UNC or host filesystem operations occur here. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { FileSystem, FsError, FsTargetKey, FS_ERROR_CODES, type FsTarget, type FsInfo, type FsPathInfo, type FsDirEntry, type FsWriteIntent, type FsWriteOutcome, type FsEditRequest, type FsEditOutcome, type FsVersion, type FsDeleteOutcome, type FsMoveOutcome } from '@deepseek-ai/dsh-fs'
import { applyHunks, type PatchHunk } from '@deepseek-ai/dsh-fs-patch'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { GuestFsExecution, GuestFsResolver } from './execution/guest-fs-types.ts'
import { GUEST_FS_SCRIPT } from './infra/guest-fs.ts'
export type { GuestFsExecution, GuestFsTransport, GuestFsResolver } from './execution/guest-fs-types.ts'

const sessions = new AsyncLocalStorage<string | undefined>()
let resolver: { resolve: GuestFsResolver } | undefined
/** Bind only trusted session facts. An old owner's disposer cannot clear a newer resolver. */
export function configureGuestFsResolver(value: GuestFsResolver): () => void {
  const owner = { resolve: value }
  resolver = owner
  return () => { if (resolver === owner) resolver = undefined }
}
/** Explicit trusted Session entrypoint for UI reads outside tools/execute. */
export function withGuestFsSession<T>(sessionId: string, work: () => T): T { return sessions.run(sessionId, work) }
interface StoredTarget { identity: string; path: string }
interface BoundTarget extends StoredTarget { execution: GuestFsExecution }
const HARD_CAP = 64 * 1024 * 1024
const CHUNK = 64 * 1024
const aborted = (signal?: AbortSignal): void => { if (signal?.aborted) throw new FsError('Guest filesystem operation aborted', 'FS_ABORTED') }
const normalize = (s: string): string => s.replace(/\r\n/g, '\n')
async function assertCurrent(execution: GuestFsExecution): Promise<void> {
  try { await execution.assertCurrent?.() }
  catch (cause) { if (cause instanceof FsError) throw cause; throw new FsError('Guest filesystem execution binding is no longer current', 'FS_PERMISSION_DENIED', { cause }) }
}
const validText = (s: string): void => { if (s.includes('\0') || Buffer.from(s, 'utf8').toString('utf8') !== s) throw new FsError('Expected valid UTF-8 text without NUL', 'FS_NOT_TEXT') }
function bound(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0 || n > HARD_CAP) throw new FsError('Invalid or excessive byte limit', 'FS_TOO_LARGE')
  return n
}

/** Filesystem primitives execute as the bound Linux user; Host paths are coordinates, never an alternate authority. */
export default class GuestFileSystem extends FileSystem {
  private readonly targets = new Map<string, StoredTarget>()
  private readonly limit: number
  constructor(ctx: Context, config: { diffBasisMaxBytes?: number } = {}) {
    super(ctx)
    this.limit = bound(config.diffBasisMaxBytes ?? 10 * 1024 * 1024)
    ctx.on('tools/execute', (exec, next) => sessions.run(exec.agent?.id, next))
  }
  private async execution(signal?: AbortSignal): Promise<GuestFsExecution> {
    aborted(signal)
    // Undefined session must not authorize filesystem access, even if a resolver has a fallback.
    const id = sessions.getStore()
    const value = id === undefined ? undefined : await resolver?.resolve(id)
    if (!value?.identity || !value.cwd || !value.transport) throw new FsError('No trusted guest filesystem execution binding', 'FS_PERMISSION_DENIED')
    await assertCurrent(value)
    aborted(signal)
    return value
  }
  private target(execution: GuestFsExecution, path: string): FsTarget {
    const key = 'guest-fs:' + createHash('sha256').update(JSON.stringify([execution.identity, path])).digest('hex')
    this.targets.set(key, { identity: execution.identity, path })
    return { targetKey: FsTargetKey(key), displayPath: path }
  }
  private stored(target: FsTarget): StoredTarget {
    const value = this.targets.get(String(target.targetKey))
    if (!value) throw new FsError('Unknown guest filesystem target identity', 'FS_PERMISSION_DENIED')
    return value
  }
  private async binding(target: FsTarget, signal?: AbortSignal): Promise<BoundTarget> {
    const stored = this.stored(target), execution = await this.execution(signal)
    if (stored.identity !== execution.identity) throw new FsError('Target belongs to a different guest execution binding', 'FS_PERMISSION_DENIED')
    return { ...stored, execution }
  }
  private async path(execution: GuestFsExecution, input: string, cwd?: string): Promise<string> {
    if (!input.trim() || input.includes('\0')) throw new FsError('Expected a nonempty guest path', 'FS_NOT_FOUND')
    const path = execution.mapPath ? await execution.mapPath(input, cwd) : posix.resolve(cwd ?? execution.cwd, input)
    if (!path.startsWith('/') || path.includes('\0') || (!execution.mapPath && /\\|^[A-Za-z]:/.test(input))) throw new FsError('Path is outside the guest execution world', 'FS_PERMISSION_DENIED')
    return path
  }
  private async rpc<T>(execution: GuestFsExecution, op: string, path: string, fields: object = {}, signal?: AbortSignal, maxBytes = 1024 * 1024): Promise<T> {
    aborted(signal)
    await assertCurrent(execution)
    aborted(signal)
    let raw: string
    try { raw = await execution.transport(GUEST_FS_SCRIPT, JSON.stringify({ op, path, identity: execution.identity, ...fields }), signal, maxBytes) }
    catch (error) { aborted(signal); if (error instanceof FsError) throw error; throw new FsError('Guest filesystem transport failed', 'FS_IO_ERROR', { cause: error }) }
    aborted(signal)
    if (Buffer.byteLength(raw) > maxBytes) throw new FsError('Guest filesystem response exceeds byte limit', 'FS_TOO_LARGE')
    let reply: { ok: boolean; value: T; code?: unknown; message?: unknown }
    try { reply = JSON.parse(raw) } catch (cause) { throw new FsError('Invalid guest filesystem RPC response', 'FS_IO_ERROR', { cause }) }
    if (!reply.ok) {
      const code = FS_ERROR_CODES.find(code => code === reply.code) ?? 'FS_IO_ERROR'
      throw new FsError(typeof reply.message === 'string' ? reply.message : 'Guest filesystem failure', code)
    }
    return reply.value
  }
  async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const execution = await this.execution(opts?.signal)
    const real = await this.rpc<string>(execution, 'resolve', await this.path(execution, path, opts?.cwd), {}, opts?.signal)
    return this.target(execution, real)
  }
  processPath(target: FsTarget): string { return this.stored(target).path }
  fileUrl(target: FsTarget): string { return 'file://' + this.processPath(target).split('/').map(encodeURIComponent).join('/') }
  contains(parent: FsTarget, child: FsTarget): boolean {
    const a = this.stored(parent), b = this.stored(child)
    return a.identity === b.identity && (a.path === b.path || b.path.startsWith(a.path === '/' ? '/' : a.path + '/'))
  }
  // Host mapping is deliberately not guessed synchronously. The root's world mapper owns it.
  async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const b = await this.binding(target, signal)
    return await this.rpc<FsInfo | null>(b.execution, 'stat', b.path, {}, signal) ?? undefined
  }
  async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const e = await this.execution(signal)
    return await this.rpc<FsPathInfo | null>(e, 'lstat', await this.path(e, path, opts?.cwd), {}, signal) ?? undefined
  }
  async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const b = await this.binding(target, signal)
    return this.rpc(b.execution, 'text', b.path, { cap: this.limit }, signal, this.limit * 6 + 4096)
  }
  private async bytes(target: FsTarget, cap: number, offset: number | undefined, signal?: AbortSignal): Promise<{ bytes: Uint8Array; version: FsVersion }> {
    bound(cap)
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) throw new FsError('Invalid byte offset', 'FS_IO_ERROR')
    const b = await this.binding(target, signal)
    const result = await this.rpc<{ data: string; version: FsVersion }>(b.execution, offset === undefined ? 'bytes' : 'range', b.path, { cap, offset }, signal, Math.ceil(cap * 4 / 3) + 4096)
    const bytes = Buffer.from(result.data, 'base64')
    if (bytes.length > cap) throw new FsError('Read exceeded byte limit', 'FS_TOO_LARGE')
    return { bytes, version: result.version }
  }
  async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> { return (await this.bytes(target, maxBytes, undefined, signal)).bytes }
  async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> { return (await this.bytes(target, range.length, range.offset, signal)).bytes }
  async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const initial = await this.stat(target, signal)
    if (!initial) throw new FsError('File is absent', 'FS_NOT_FOUND')
    if (initial.type !== 'file') throw new FsError('Not a regular file', 'FS_NOT_REGULAR_FILE')
    const self = this
    return (async function* () {
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      let offset = 0
      for (;;) {
        aborted(signal)
        const { bytes, version } = await self.bytes(target, CHUNK, offset, signal)
        if (version !== initial.version) throw new FsError('File changed while streaming', 'FS_STALE_VERSION')
        let chunk: string
        try { chunk = decoder.decode(bytes, { stream: bytes.length !== 0 }) }
        catch (cause) { throw new FsError('Invalid UTF-8', 'FS_NOT_TEXT', { cause }) }
        if (chunk.includes('\0')) throw new FsError('NUL is not text', 'FS_NOT_TEXT')
        if (chunk) yield chunk
        if (!bytes.length) break
        offset += bytes.length
      }
    })()
  }
  async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const b = await this.binding(target, signal)
    const result = await this.rpc<Array<Omit<FsDirEntry, 'target'> & { path: string }>>(b.execution, 'list', b.path, {}, signal, 16 * 1024 * 1024)
    return result.map(({ path, ...entry }) => ({ ...entry, target: this.target(b.execution, path) }))
  }
  override get sandboxMode(): SandboxMode | undefined {
    return (this.ctx.get('sandboxPolicy') as { defaultMode?: SandboxMode } | undefined)?.defaultMode
  }
  private async policy(execution: GuestFsExecution, perCall?: SandboxExecutionPolicy): Promise<object | undefined> {
    const service = this.ctx.get('sandboxPolicy') as { resolve(): SandboxExecutionPolicy } | undefined
    const policy = perCall ?? service?.resolve()
    if (!policy) return undefined
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode)) throw new FsError('Unknown filesystem policy', 'FS_SANDBOX_DENIED')
    const roots = policy.mode === 'workspace-write' && policy.workspaceRoot ? [await this.path(execution, policy.workspaceRoot), '/tmp'] : []
    return { mode: policy.mode, roots }
  }
  async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsWriteOutcome> {
    validText(content)
    const b = await this.binding(target, signal)
    return this.rpc(b.execution, 'write', b.path, { content, expected, limit: this.limit, policy: await this.policy(b.execution, sandboxPolicy) }, signal, Buffer.byteLength(content) * 6 + this.limit * 6 + 4096)
  }
  async editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsEditOutcome> {
    validText(edit.oldString); validText(edit.newString)
    const b = await this.binding(target, signal)
    return this.rpc(b.execution, 'edit', b.path, { edit, expected, limit: this.limit, policy: await this.policy(b.execution, sandboxPolicy) }, signal, this.limit * 12 + 4096)
  }
  async patchText(target: FsTarget, hunks: readonly PatchHunk[], expected?: { version: FsVersion }, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsEditOutcome> {
    const info = await this.stat(target, signal)
    if (!info || (expected && expected.version !== info.version)) throw new FsError('File version changed', 'FS_STALE_VERSION')
    const original = await this.readText(target, signal), before = normalize(original)
    const result = applyHunks(before, hunks)
    if (!result.ok) throw new FsError('Patch hunk did not match', 'FS_PATCH_MISMATCH')
    const after = result.after
    const stored = original.includes('\r\n') && !original.replace(/\r\n/g, '').includes('\n') ? after.replace(/\n/g, '\r\n') : after
    const outcome = await this.writeText(target, stored, { kind: 'replaceIfVersion', version: info.version }, signal, sandboxPolicy)
    return { version: outcome.version, before, after }
  }
  async deleteFile(target: FsTarget, expected?: { version: FsVersion }, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsDeleteOutcome> {
    const b = await this.binding(target, signal)
    return this.rpc(b.execution, 'delete', b.path, { expected, limit: this.limit, policy: await this.policy(b.execution, sandboxPolicy) }, signal, this.limit * 6 + 4096)
  }
  async moveFile(source: FsTarget, destination: FsTarget, options: { hunks?: readonly PatchHunk[]; expectedSource?: { version: FsVersion }; expectedDestination?: FsWriteIntent }, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsMoveOutcome> {
    if (source.targetKey === destination.targetKey) throw new FsError('Move source and destination are identical', 'FS_SAME_TARGET')
    const a = await this.binding(source, signal), b = await this.binding(destination, signal)
    if (a.identity !== b.identity) throw new FsError('Cross-world move is not permitted', 'FS_PERMISSION_DENIED')
    let content: string | undefined, expectedSource = options.expectedSource
    if (options.hunks) {
      const info = await this.stat(source, signal)
      if (!info || (expectedSource && info.version !== expectedSource.version)) throw new FsError('Move source version changed', 'FS_STALE_VERSION')
      const original = await this.readText(source, signal), result = applyHunks(normalize(original), options.hunks)
      if (!result.ok) throw new FsError('Patch hunk did not match', 'FS_PATCH_MISMATCH')
      content = original.includes('\r\n') && !original.replace(/\r\n/g, '').includes('\n') ? result.after.replace(/\n/g, '\r\n') : result.after
      expectedSource = { version: info.version }
    }
    return this.rpc(a.execution, 'move', a.path, { destination: b.path, content, expectedSource, expectedDestination: options.expectedDestination, limit: this.limit, policy: await this.policy(a.execution, sandboxPolicy) }, signal, this.limit * 18 + 4096)
  }
}
