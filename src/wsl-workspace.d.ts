/** Legacy FS declaration only; the owned shell consumes @deepseek-ai/dsh-shell's public types. */
declare module 'dsh-wsl-workspace/fs' {
  import type { Context } from '@deepseek-ai/cordis'
  /** Public workspace filesystem provider re-exported for the isolated WSL Session world. */
  export default class WslFileSystem {
    static Config: unknown
    constructor(ctx: Context, config: unknown)
  }
}
