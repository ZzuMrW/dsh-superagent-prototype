/** Credential-free accepted GitHub identity. Persist only through the host's binding store port. */
export interface AccountBinding {
  accountId: string
  repositoryId: string
  login: string
  repository: string
  /** Resolved executable, not a shell command or credential. */
  cli: string
  noreply: string
  /** Credential-free execution target identity (native or distribution/user/root). */
  executionTarget: string
}
export interface AcceptedAccountBinding extends AccountBinding {
  acceptedAt: string
  revision: number
}
export type AccountCursorPlan = { kind: 'preserve' } | { kind: 'cutover'; cutoff: string }
export const sameAccountIds = (a: AccountBinding, b: AccountBinding): boolean =>
  a.accountId === b.accountId && a.repositoryId === b.repositoryId
export const sameAccountBinding = (a: AccountBinding, b: AccountBinding): boolean =>
  sameAccountIds(a, b) && a.login === b.login && a.repository === b.repository && a.cli === b.cli
    && a.noreply === b.noreply && a.executionTarget === b.executionTarget

/** Copy the public allowlist: never forward arbitrary probe/deployment output or gh secrets. */
export function publicAccountBinding(value: AccountBinding): AccountBinding {
  const { accountId, repositoryId, login, repository, cli, noreply, executionTarget } = value
  if (![accountId, repositoryId, login, repository, cli, noreply, executionTarget].every(item => typeof item === 'string' && item.length > 0)) {
    throw new Error('Invalid account binding')
  }
  return { accountId, repositoryId, login, repository, cli, noreply, executionTarget }
}
