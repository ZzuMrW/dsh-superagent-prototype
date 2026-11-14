/** 0.7.13 ships JavaScript public providers without declarations. Describe only the seam we consume. */
declare module 'dsh-wsl-workspace/shell' {
  import type { Context } from '@deepseek-ai/cordis'
  import type { ShellExecRequest, ShellExecSpec, ShellExecution, ShellRunResult } from '@deepseek-ai/dsh-shell'
  import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
  interface WslShellPlan {
    distro: string; linuxCwd: string; windowsCwd: string
    env: Record<string, string>; argv: string[]
  }
  /** Public workspace shell seam extended by Superagent to resolve Session-bound execution requests. */
  export default class WslShellExecutor {
    static inject: string[]
    static Config: unknown
    constructor(ctx: Context, config: unknown)
    protected ctx: Context
    config: { graceMs: number }
    resolve(request: ShellExecRequest): ShellExecSpec
    plan(spec: ShellExecSpec): WslShellPlan
    spawnSpec(plan: WslShellPlan, spec: ShellExecSpec, stdoutMaxBytes: number, signal?: AbortSignal): SubprocessSpawnSpec
    spawnExecution(spec: ShellExecSpec): ShellExecution
    execute(spec: ShellExecSpec): Promise<ShellExecution>
    start(spec: ShellExecSpec): ShellExecution
    run(spec: ShellExecSpec): Promise<ShellRunResult>
  }
}
declare module 'dsh-wsl-workspace/fs' {
  import type { Context } from '@deepseek-ai/cordis'
  /** Public workspace filesystem provider re-exported for the isolated WSL Session world. */
  export default class WslFileSystem {
    static Config: unknown
    constructor(ctx: Context, config: unknown)
  }
}
