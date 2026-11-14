/** Manual build-artifact test: validates the shared registry used by Host and WSL shell entries. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
const host = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const shellEntry = readFileSync(new URL('../lib/wsl-shell.js', import.meta.url), 'utf8')
const line = host.split('\n').find(line => line.includes(' as registerWslExecution,'))
assert(line, 'Host build does not import its execution registry from a shared chunk')
const chunk = /from "(\.\/[^\"]+)"/.exec(line)?.[1]
const exported = /\b(\w+) as registerWslExecution\b/.exec(line)?.[1]
assert(chunk && exported)
assert(shellEntry.includes(chunk), 'Host and shell entries do not share the same registry module')
const shared = await import(new URL('../lib/' + chunk.slice(2), import.meta.url).href)
const { default: Shell } = await import(new URL('../lib/wsl-shell.js', import.meta.url).href)
const ctx = new Context()
const shell = new Shell(ctx, { timeoutMs: 5000, maxTimeoutMs: 600000, maxOutputBytes: 64000,
  maxSpillBytes: 67108864, graceMs: 100, loginShell: false, distro: 'Ubuntu-20.04', wslPath: 'wsl.exe' })
const release = shared[exported]('built-registry-probe', {
  machine: { stateDir: '/not-used', wsl: { distro: 'Ubuntu-20.04', user: 'root', workRoot: '/root/workspace/test' } },
  env: { DSH_REGISTRY_PROBE: 'shared-build-module' }
})
try {
  const spec = shell.resolve({ command: 'true', workdir: '/tmp', dshEnv: { DSH_SESSION_ID: 'built-registry-probe' } })
  assert(spec.command.includes('DSH_REGISTRY_PROBE=shared-build-module'))
  assert.equal(spec.dshEnv.DSH_WSL_USER, 'root')
} finally { release(); await ctx.fiber.dispose() }
assert.throws(() => shell.resolve({ command: 'true', workdir: '/tmp', dshEnv: { DSH_SESSION_ID: 'built-registry-probe' } }), /no active Superagent/)
console.log('PASS: built Host and shell entries share one live binding registry; disposal removes the binding.')
