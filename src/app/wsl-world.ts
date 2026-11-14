/** Per-session WSL execution bindings. No process environment or profile state is changed. */
import type { Machine } from '../deployment.ts'
import { posix } from 'node:path'

/** SQLite stays on the Host; the orchestrator Session needs an ext4 guest workspace. */
export const orchestratorWorkspace = (machine: Pick<Machine, 'stateDir' | 'wsl'>): string =>
  machine.wsl ? posix.join(machine.wsl.workRoot, '.orchestrator') : machine.stateDir

export interface WslExecutionBinding { machine: Machine; env: Record<string, string | undefined> }
interface BoundExecution extends WslExecutionBinding { variables: () => Record<string, string> }
const bindings = new Map<string, BoundExecution>()

export function registerWslExecution(id: string, binding: WslExecutionBinding, variables: () => Record<string, string> = () => ({})): () => void {
  const value = { ...binding, variables }
  bindings.set(id, value)
  return () => { if (bindings.get(id) === value) bindings.delete(id) }
}
export const wslExecutionFor = (id: string | undefined): BoundExecution | undefined => id === undefined ? undefined : bindings.get(id)
const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

/** Use env inside Linux, after the login shell: WSLENV /p must not reinterpret Git paths or PATH. */
export function wslCommand(command: string, binding: BoundExecution): string {
  const env = { ...binding.env, ...binding.variables() }
  const args: string[] = []
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid WSL execution environment key: ${key}`)
    if (value === undefined) args.push('-u', quote(key))
  }
  for (const [key, value] of Object.entries(env)) if (value !== undefined) args.push(quote(`${key}=${value}`))
  return `env ${args.join(' ')} bash -c ${quote(command)}`
}

/** DSH's Windows workspace registry must receive Windows coordinates, never a bare Linux root. */
export function wslWorkspacePath(path: string, distro: string): string {
  if (!distro || /[\\/\0]/.test(distro)) throw new Error('Invalid WSL distribution')
  if (/^\\\\(?:wsl\.localhost|wsl\$)\\/i.test(path)) {
    const actual = path.split('\\')[3]
    if (actual?.toLowerCase() !== distro.toLowerCase()) throw new Error('Session workspace belongs to a different WSL distribution')
    return wslWorkspacePath('/' + path.split('\\').slice(4).join('/'), distro)
  }
  if (!path.startsWith('/') || path.includes('\0')) throw new Error('WSL session workspace must be an absolute Linux path or WSL UNC path')
  if (/^\/mnt\/[A-Za-z](?:\/|$)/.test(path)) throw new Error('WSL session workspaces must be in the distribution filesystem, not /mnt/<drive>')
  return `\\\\wsl.localhost\\${distro}${path.replace(/\//g, '\\')}`
}
