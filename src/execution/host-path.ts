/** Host registration evidence uses real filesystem resolution and controlled local-disk inspection. */
import { realpath, stat } from 'node:fs/promises'
import { execFile, execFileSync } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { win32 } from 'node:path'
import { promisify } from 'node:util'
import type { HostPathFacts } from './path-mapper.ts'
const exec = promisify(execFile)
export async function probeHostPath(input: string, signal: AbortSignal): Promise<HostPathFacts> {
  signal.throwIfAborted()
  const path = await realpath(input), info = await stat(path)
  let locality: HostPathFacts['locality'] = 'unknown'
  if (process.platform === 'win32') {
    const drive = /^([A-Za-z]):[\\/]/.exec(path)?.[1]?.toUpperCase()
    if (drive) {
      // A drive letter alone does not establish locality: mapped SMB drives must fail closed.
      const script = `$d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}:'"; if($null -eq $d){exit 2}; Write-Output $d.DriveType`
      const { stdout } = await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { signal, timeout: 15_000, windowsHide: true, maxBuffer: 4096 })
      locality = stdout.trim() === '3' ? 'local' : stdout.trim() === '4' ? 'network' : 'unknown'
    } else if (/^\\\\(?!wsl(?:\.localhost|\$)\\)/i.test(path)) locality = 'network'
  }
  signal.throwIfAborted()
  return { path, exists: true, directory: info.isDirectory(), locality }
}
/** Check the nearest existing ancestor before Runtime creates a directory, lock or SQLite file. */
export function assertLocalHostStateSync(input: string): void {
  if (process.platform !== 'win32' || !/^[A-Za-z]:[\\/]/.test(input) || /[\x00-\x1f\x7f]/.test(input)) throw new Error('WSL Host state requires a local Windows disk')
  let ancestor = win32.resolve(input)
  for (;;) {
    try {
      const path = realpathSync(ancestor)
      if (!statSync(path).isDirectory()) throw new Error('Host state ancestor is not a directory')
      const drive = /^([A-Za-z]):[\\/]/.exec(path)?.[1]?.toUpperCase()
      if (!drive) throw new Error('Host state resolves outside a local Windows drive')
      const script = `$d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}:'"; if($null -eq $d){exit 2}; Write-Output $d.DriveType`
      const result = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 15_000, windowsHide: true, maxBuffer: 4096 })
      if (result.trim() !== '3') throw new Error('Host state is not on a verified local fixed disk')
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = win32.dirname(ancestor)
      if (parent === ancestor) throw error
      ancestor = parent
    }
  }
}
