/** Type-only manual account refresh API. Host owns route registration and authorization. */
import type { AccountApplyResult, AccountRefreshResult } from './account-refresh.ts'

declare module './api.ts' {
  interface Api {
    'POST sources/:id/accounts/refresh': { response: AccountRefreshResult }
    'POST sources/:id/accounts/apply': { body: { planToken: string; confirmed: true }; response: AccountApplyResult }
  }
}
export type { AccountApplyResult, AccountRefreshResult }
