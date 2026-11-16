/**
 * Bundle the pinned SDK's browser provider at build time. The package's /client
 * export is a ModuleLoader script, not an ESM library, so use its public source
 * export instead. No runtime require of another Harness Client module is added.
 *
 * Keep this child fiber independent of the management UI's service dependencies:
 * its own native inject list waits for resources and remote.workspaceFiles, and
 * teardown releases file subscriptions and settles the shared change feeds.
 */
export { apply, inject } from '@deepseek-ai/dsh-api-workspace-files/src/client/index.ts'
