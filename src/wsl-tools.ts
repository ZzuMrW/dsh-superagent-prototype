/** Pinned 0.7.13 ancillary providers; no workspace host apply, preset generation, or profile mutation. */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'

export const inject = ['tools', 'fs']
export const Config = s.object({ search: s.boolean().default(false) })
export async function apply(ctx: Context, config: { search: boolean }): Promise<void> {
  const require = createRequire(import.meta.url)
  const manifest = require('dsh-wsl-workspace/package.json') as { version: string }
  if (manifest.version !== '0.7.13') throw new Error('WSL ancillary providers require dsh-wsl-workspace 0.7.13; revalidate before upgrading')
  const root = dirname(require.resolve('dsh-wsl-workspace/package.json'))
  for (const file of ['wsl-image-tool.js', ...config.search ? ['wsl-search.js'] : []]) {
    const plugin = await import(pathToFileURL(join(root, 'lib', file)).href)
    await ctx.plugin(plugin)
  }
}
