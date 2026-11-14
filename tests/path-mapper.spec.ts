/** Path plans use the selected guest's converter and verified Host coordinates, not a hard-coded mount prefix. */
import { expect, it } from 'vitest'
import { pathKind, WorkspacePathMapper, type HostPathFacts, type PathMappingProbe } from '../src/execution/path-mapper.ts'

function fixture() {
  const calls: string[][] = []
  let exists = true, directory = true, fs = 'ext4', hostExists = true
  let locality: HostPathFacts['locality'] = 'local'
  let canonicalHost: string | undefined
  const probe: PathMappingProbe = {
    guest: async argv => {
      calls.push(argv)
      if (argv[0] === 'wslpath' && argv[2] === '-u') return '/windows/d/project with spaces\n'
      if (argv[0] === 'wslpath' && argv[2] === '-w') return argv[3]!.startsWith('/windows/')
        ? 'D:\\project with spaces\n' : '\\\\wsl.localhost\\Example Distro' + argv[3]!.replaceAll('/', '\\') + '\n'
      return JSON.stringify({ path: argv[3], exists, directory, fileSystem: fs, mountSource: '/dev/example', device: '1', inode: '101' })
    },
    host: async path => ({ path: canonicalHost ?? path, exists: hostExists, directory: true, locality }),
  }
  return { calls, mapper: new WorkspacePathMapper({ distro: 'Example Distro' }, probe),
    set: (values: { exists?: boolean; directory?: boolean; fs?: string; hostExists?: boolean; locality?: HostPathFacts['locality']; canonicalHost?: string }) => {
      exists = values.exists ?? exists; directory = values.directory ?? directory; fs = values.fs ?? fs
      hostExists = values.hostExists ?? hostExists; locality = values.locality ?? locality; canonicalHost = values.canonicalHost
    } }
}
const signal = () => new AbortController().signal
it('classifies input without filesystem or process side effects', () => {
  expect(['D:\\code', '/home/developer/code', '\\\\wsl.localhost\\Distro\\home', '\\\\server\\share', 'relative', 'bad\0path'].map(pathKind))
    .toEqual(['windows-drive', 'linux', 'wsl-unc', 'network-unc', 'relative', 'invalid'])
})
it('uses actual custom automount conversion and registers a Windows workspace by its drive path', async () => {
  const f = fixture(); f.set({ fs: '9p' })
  const result = await f.mapper.workspace('D:\\project with spaces', signal())
  expect(result.guestPath).toBe('/windows/d/project with spaces')
  expect(result.hostPath).toBe('D:\\project with spaces')
  expect(result.storage).toBe('windows-local')
  expect(result.evidence.hostLocality).toBe('local')
  expect(f.calls[0]).toEqual(['wslpath', '-a', '-u', 'D:\\project with spaces'])
  expect(JSON.stringify(f.calls)).not.toContain('/mnt/')
})
it('keeps native guest workspaces and validates same-distro UNC aliases', async () => {
  const f = fixture()
  const result = await f.mapper.workspace('\\\\wsl$\\Example Distro\\home\\developer\\project', signal())
  expect(result.guestPath).toBe('/home/developer/project')
  expect(result.storage).toBe('guest-local')
  await expect(f.mapper.workspace('\\\\wsl.localhost\\Other\\home', signal())).rejects.toMatchObject({ code: 'PATH_WRONG_DISTRO' })
})
it('does not pretend missing, wrong-kind or Host-inaccessible directories are ready', async () => {
  const f = fixture(); f.set({ exists: false })
  await expect(f.mapper.workspace('/home/developer/new', signal())).rejects.toMatchObject({ code: 'WORKSPACE_MISSING' })
  f.set({ exists: true, directory: false })
  await expect(f.mapper.workspace('/home/developer/file', signal())).rejects.toMatchObject({ code: 'WORKSPACE_NOT_DIRECTORY' })
  f.set({ directory: true, hostExists: false })
  await expect(f.mapper.workspace('/home/developer/private', signal())).rejects.toMatchObject({ code: 'HOST_WORKSPACE_UNREGISTERABLE' })
})
it('refuses network or unknown disks and unrecognized guest filesystems', async () => {
  const f = fixture(); f.set({ locality: 'network' })
  await expect(f.mapper.workspace('D:\\project', signal())).rejects.toMatchObject({ code: 'HOST_WORKSPACE_NOT_LOCAL' })
  f.set({ locality: 'unknown' })
  await expect(f.mapper.workspace('D:\\project', signal())).rejects.toMatchObject({ code: 'HOST_WORKSPACE_NOT_LOCAL' })
  f.set({ locality: 'local', fs: 'nfs4' })
  await expect(f.mapper.workspace('/network/project', signal())).rejects.toMatchObject({ code: 'WORKSPACE_FILESYSTEM_UNSUPPORTED' })
})
it('does not follow a Host reparse coordinate into another storage world', async () => {
  const f = fixture(); f.set({ canonicalHost: '\\\\server\\share' })
  await expect(f.mapper.workspace('D:\\project', signal())).rejects.toMatchObject({ code: 'HOST_WORKSPACE_NOT_LOCAL' })
  f.set({ canonicalHost: '\\\\wsl.localhost\\Other\\home\\developer\\project' })
  await expect(f.mapper.workspace('/home/developer/project', signal())).rejects.toThrow(/another/)
})
