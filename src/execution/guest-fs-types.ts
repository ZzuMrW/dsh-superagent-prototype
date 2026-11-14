/** Trusted execution ports. None of these facts may be inferred from a model path. */
export type GuestFsTransport = (script: string, payload: string, signal?: AbortSignal, maxBytes?: number) => Promise<string>
export interface GuestFsExecution {
  /** Stable machine + distro + explicit user identity, including deployment generation if applicable. */
  identity: string
  cwd: string
  transport: GuestFsTransport
  /** Fail closed when the trusted deployment/session generation is no longer current. */
  assertCurrent?: () => void | Promise<void>
  /** Translate host/UNC inputs, rejecting a different distribution. Return an absolute guest path. */
  mapPath?: (path: string, cwd?: string) => string | Promise<string>
  mapHostPath?: (hostPath: string) => string | undefined
}
export type GuestFsResolver = (sessionId: string | undefined) => GuestFsExecution | undefined | Promise<GuestFsExecution | undefined>
