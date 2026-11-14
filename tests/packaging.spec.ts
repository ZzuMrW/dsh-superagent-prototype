import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'

interface Options { out: string; 'state-dir': string; distro: string; user: string; 'work-root': string }
interface PackApi {
  parseOptions(argv: string[]): Options
  machinePatch(patch: string, options: Options): string
  resolveLocations(options: Options, convert: (mode: string, path: string) => string): { out: string; windowsOut: string }
  generateBundle(options: Options, dependencies: { sourceRoot: string; convert: (mode: string, path: string) => string;
    pack?: (stage: string, args: string[]) => void }): { tarball: string; stage: string }
}
const modulePath = resolve(import.meta.dirname, '../scripts/make-local-wsl-bundle.mjs')
const api = await import(modulePath) as PackApi
const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'))
const patch = readFileSync(resolve(import.meta.dirname, '../cordis.patch.yml'), 'utf8')
const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-pack-')); directories.push(dir)
  const source = join(dir, 'source'); mkdirSync(source)
  const out = join(dir, 'new artifacts $() ; space')
  const options: Options = { out, 'state-dir': 'C:\\local-state\\superagent', distro: 'Ubuntu-24.04', user: 'wang', 'work-root': '/home/wang/work' }
  const calls: [string, string][] = []
  const convert = (mode: string, path: string) => {
    calls.push([mode, path])
    if (mode === '-u') return out
    return 'E:\\build-artifacts\\new artifacts $() ; space'
  }
  const write = (file: string, content: string) => { const path = join(source, file); mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, content) }
  const localManifest = { ...manifest, files: ['lib', 'locale/*.json', 'cordis.patch.yml', 'docs', 'SETUP.md', 'WSL-ADAPTER.md', 'LICENSE'] }
  write('package.json', JSON.stringify(localManifest))
  write('cordis.patch.yml', patch)
  for (const name of ['index', 'client', 'wsl-shell', 'wsl-fs', 'wsl-tools', 'wsl-context', 'workspace-files', 'file-references']) {
    write('lib/' + name + '.js', name === 'client' ? 'window.__ModuleLoader__.load({id:"dsh-superagent"});' : 'export const fixture = true;')
    write('lib/' + name + '.d.ts', 'export declare const fixture: boolean;')
  }
  for (const file of ['docs/help.md', 'SETUP.md', 'WSL-ADAPTER.md', 'README.md', 'LICENSE', 'locale/en.json']) write(file, file.endsWith('.json') ? '{}' : 'Public resource')
  for (const file of ['lib/.env', 'lib/nested-main.tgz', 'docs/swap/file.swp', 'docs/.artifacts/private.md', 'docs/state/secret.db']) write(file, 'MUST NOT PACK')
  return { source, out, options, convert, calls, write }
}

it('preserves package/client identity and exports all public Host build entries without a workspace runtime dependency', () => {
  expect(manifest.name).toBe('dsh-superagent')
  expect(manifest.version).toBe('0.2.0-wsl.1')
  const build = readFileSync(resolve(import.meta.dirname, '../tsdown.config.ts'), 'utf8')
  expect(build).toContain('id: "dsh-superagent"')
  for (const name of ['wsl-context', 'workspace-files', 'file-references']) {
    expect(manifest.exports['./' + name]).toEqual({ types: './lib/' + name + '.d.ts', default: './lib/' + name + '.js' })
    expect(build).toContain(`'${name}': 'src/${name}.ts'`)
  }
  expect(manifest.files).toEqual(expect.arrayContaining(['docs', 'SETUP.md', 'WSL-ADAPTER.md', 'LICENSE']))
  for (const key of ['dependencies', 'peerDependencies', 'devDependencies']) {
    expect(manifest[key]).not.toHaveProperty('dsh-superagent')
    expect(manifest[key]).not.toHaveProperty('dsh-wsl-workspace')
  }
  expect(build).not.toContain('dsh-wsl-workspace')
})

it('strictly parses known, unique arguments and separates local SQLite state from artifact storage', () => {
  const valid = ['--out=E:\\artifacts\\new', '--state-dir=C:\\state', '--distro=Ubuntu', '--user=wang', '--work-root=/home/wang/work']
  expect(api.parseOptions(valid).out).toBe('E:\\artifacts\\new')
  for (const args of [valid.slice(1), [...valid, '--typo=x'], [...valid, valid[0]!], [...valid, '--out='],
    valid.map(value => value.startsWith('--user=') ? '--user=bad/user' : value),
    valid.map(value => value.startsWith('--state-dir=') ? '--state-dir=\\\\server\\share\\state' : value),
    valid.map(value => value.startsWith('--state-dir=') ? '--state-dir=C:\\state:stream' : value),
    valid.map(value => value.startsWith('--work-root=') ? '--work-root=relative/work' : value),
    valid.map(value => value.startsWith('--out=') ? '--out=relative' : value),
    valid.map(value => value.startsWith('--out=') ? '--out=/tmp/new\nline' : value)]) expect(() => api.parseOptions(args)).toThrow()
})

it('accepts Linux, local drive and same-distro WSL UNC workspace candidates with runtime-compatible target names', () => {
  const base = ['--out=E:\\artifacts\\new', '--state-dir=C:\\state', '--distro= Custom Linux 24.04 ', '--user= build.user ']
  for (const root of ['/home/build.user/work', '/a/../b', '/custom-automount/d/projects', 'D:\\project space', 'E:/projects',
    '\\\\wsl.localhost\\Custom Linux 24.04\\home\\build.user\\work', '\\\\WSL$\\custom linux 24.04\\home\\build.user\\work']) {
    const parsed = api.parseOptions([...base, '--work-root=' + root])
    expect(parsed).toMatchObject({ distro: 'Custom Linux 24.04', user: 'build.user', 'work-root': root })
    expect(api.machinePatch(patch, parsed)).toContain(JSON.stringify({ stateDir: 'C:\\state',
      wsl: { distro: 'Custom Linux 24.04', user: 'build.user', workRoot: root } }))
  }
  for (const root of ['relative', 'D:relative', '\\\\server\\share\\work', '\\\\wsl.localhost\\Wrong Distro\\home\\build.user',
    '\\\\wsl$\\Wrong Distro', '/home/work\ncontrol']) expect(() => api.parseOptions([...base, '--work-root=' + root])).toThrow()
  for (const distro of ['-Custom Linux', 'Custom/Linux', 'Custom\\Linux', 'Custom\nLinux', ' '])
    expect(() => api.parseOptions([...base.filter(arg => !arg.startsWith('--distro=')), '--distro=' + distro, '--work-root=/home/work'])).toThrow()
  for (const user of ['-build.user', 'build user', 'build/user', 'build:user', 'build\\user', 'build\nuser', ' '])
    expect(() => api.parseOptions([...base.filter(arg => !arg.startsWith('--user=')), '--user=' + user, '--work-root=/home/work'])).toThrow()
})

it('converts only artifact output using the generator distro real converter, never the target workspace', () => {
  const f = fixture()
  const locations = api.resolveLocations({ ...f.options, out: 'E:\\artifacts\\new' }, f.convert)
  expect(locations.out).toBe(f.out)
  expect(f.calls).toContainEqual(['-u', 'E:\\artifacts\\new'])
  expect(f.calls).toContainEqual(['-w', f.out])
  expect(f.calls.every(([, path]) => path === 'E:\\artifacts\\new' || path === f.out)).toBe(true)
  // The target may belong to another registered distro or a Windows-local mount. Only runtime diagnosis can map it.
  const calls: [string, string][] = []
  const outputOnly = (mode: string, path: string) => {
    if (path !== f.out) throw new Error('Unexpected target workspace conversion')
    calls.push([mode, path]); return 'E:\\build-artifacts\\new'
  }
  for (const workRoot of ['/custom-automount/d/projects', 'D:\\project space', '\\\\wsl.localhost\\Other Distro\\home\\build.user'])
    expect(api.resolveLocations({ ...f.options, distro: 'Other Distro', 'work-root': workRoot }, outputOnly).out).toBe(f.out)
  expect(calls).toHaveLength(6)
  // Artifacts may live on a normal Windows UNC share; SQLite state may not.
  expect(api.resolveLocations(f.options, () => '\\\\build-server\\artifacts\\new').windowsOut)
    .toBe('\\\\build-server\\artifacts\\new')
  expect(() => api.resolveLocations(f.options, () => '\\\\wsl.localhost\\Ubuntu\\home\\out')).toThrow(/Windows storage/)
})

it('embeds only machine deployment coordinates, enables one runtime, keeps every source disabled and never resumes processing', () => {
  const f = fixture(), generated = api.machinePatch(patch, f.options)
  expect(generated.match(/name: dsh-superagent\n/g)).toHaveLength(1)
  expect(generated.match(/name: dsh-superagent\/github-watch/g)).toHaveLength(1)
  expect(generated).toContain('disabled: false\n      config: ')
  expect(generated).toContain('"stateDir":"C:\\\\local-state\\\\superagent"')
  for (const id of ['dsh-superagent-github', 'dsh-superagent-feishu']) expect(generated.slice(generated.indexOf('    - id: ' + id)).split(/\n    - id:/)[0]).toContain('disabled: true')
  for (const forbidden of ['processing', 'account', 'token', 'credentials', 'model', 'login']) expect(generated.match(/      config: \{.*\}/)?.[0]).not.toContain(forbidden)
  expect(() => api.machinePatch(patch + '\n    - id: dsh-superagent\n      name: dsh-superagent\n', f.options)).toThrow(/exactly one/)
})

it('packs one self-contained tarball, retaining declarations/resources but no nested main, state or private artifacts', () => {
  const f = fixture()
  const result = api.generateBundle(f.options, { sourceRoot: f.source, convert: f.convert,
    pack: (stage, args) => { execFileSync('npm', [...args, '--json'], { cwd: stage, encoding: 'utf8', shell: false }) } })
  expect(readdirSync(f.out).filter(name => name.endsWith('.tgz'))).toEqual(['dsh-superagent-0.2.0-wsl.1.tgz'])
  const files = execFileSync('tar', ['-tzf', result.tarball], { encoding: 'utf8' }).trim().split('\n')
  for (const file of ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'lib/wsl-context.d.ts', 'lib/workspace-files.d.ts',
    'lib/file-references.d.ts', 'docs/help.md', 'SETUP.md', 'WSL-ADAPTER.md', 'LICENSE']) expect(files).toContain('package/' + file)
  expect(files.filter(file => file.endsWith('cordis.patch.yml'))).toHaveLength(1)
  expect(files.some(file => /\.tgz$|\.env$|\.swp$|\.db$|\.artifacts|node_modules/.test(file))).toBe(false)
  const packedManifest = JSON.parse(execFileSync('tar', ['-xOzf', result.tarball, 'package/package.json'], { encoding: 'utf8' }))
  expect(packedManifest.name).toBe('dsh-superagent')
  expect(packedManifest.dependencies).not.toHaveProperty('dsh-superagent')
  expect(packedManifest.dependencies).not.toHaveProperty('dsh-wsl-workspace')
  const packedPatch = execFileSync('tar', ['-xOzf', result.tarball, 'package/cordis.patch.yml'], { encoding: 'utf8' })
  expect(packedPatch).toBe(api.machinePatch(patch, f.options))
  expect(readFileSync(join(f.source, 'cordis.patch.yml'), 'utf8')).toBe(patch)
  expect(existsSync(join(f.out, 'desktop-wsl-profile'))).toBe(false)
}, 30000)

it('refuses overwrites and missing builds before creating owned output, with no writes to source/profile/state', () => {
  const f = fixture()
  mkdirSync(f.out); writeFileSync(join(f.out, 'sentinel'), 'unchanged')
  expect(() => api.generateBundle(f.options, { sourceRoot: f.source, convert: f.convert })).toThrow(/overwrite/)
  expect(readFileSync(join(f.out, 'sentinel'), 'utf8')).toBe('unchanged')
  const missing = fixture(); rmSync(join(missing.source, 'lib/wsl-context.js'))
  expect(() => api.generateBundle(missing.options, { sourceRoot: missing.source, convert: missing.convert })).toThrow(/Build output missing/)
  expect(existsSync(missing.out)).toBe(false)
  const nested = fixture()
  nested.write('package.json', JSON.stringify({ ...manifest, dependencies: { main: 'file:./main.tgz' } }))
  expect(() => api.generateBundle(nested.options, { sourceRoot: nested.source, convert: nested.convert })).toThrow(/local\/nested/)
  expect(existsSync(nested.out)).toBe(false)
  expect(() => api.resolveLocations(f.options, (mode, path) => path === f.options['work-root'] ? f.convert(mode, path) : 'C:\\local-state\\superagent\\new')).toThrow(/overlap/)
  expect(() => api.resolveLocations(f.options, (mode, path) => path === f.options['work-root'] ? f.convert(mode, path) : 'C:\\Users\\test\\.dsh\\new')).toThrow(/profile/)
})
