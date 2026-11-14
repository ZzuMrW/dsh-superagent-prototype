/** Static deployment preview. No subprocess, filesystem, network or Store access is performed here. */
import { z } from 'zod'
import { pathKind } from './path-mapper.ts'
import { validateRequestedTarget } from './target.ts'

const target = z.object({ distro: z.string(), user: z.string(), workRoot: z.string() }).strict()
const candidate = z.object({
  stateDir: z.string(), wsl: z.union([z.literal(false), target]),
  executor: z.object({ directory: z.string().default(''), prepare: z.string().default(''), blockedCommands: z.array(z.string()).default([]) }).strict().default({ directory: '', prepare: '', blockedCommands: [] }),
}).strict()
export type DeploymentPreviewInput = z.input<typeof candidate>
export interface PreviewFinding { code: string; field: string; detail: string }
export interface DeploymentPreview {
  kind: 'static'
  ready: false
  valid: boolean
  mode: 'native' | 'wsl' | 'invalid'
  requestedTarget: { distro: string; user: string } | null
  paths: { stateDir: string; workspaceInput: string; workspaceKind: string }
  prepare: { configured: boolean; characters: number }
  blockedCommands: string[]
  blockers: PreviewFinding[]
  warnings: PreviewFinding[]
  requiredChecks: string[]
  plannedEffects: string[]
}
export function previewDeployment(value: unknown): DeploymentPreview {
  const parsed = candidate.safeParse(value)
  if (!parsed.success) return { kind: 'static', ready: false, valid: false, mode: 'invalid', requestedTarget: null,
    paths: { stateDir: '', workspaceInput: '', workspaceKind: 'invalid' }, prepare: { configured: false, characters: 0 }, blockedCommands: [],
    blockers: parsed.error.issues.map(issue => ({ code: 'CONFIG_INVALID', field: issue.path.join('.'), detail: 'The candidate configuration does not match the deployment schema' })),
    warnings: [], requiredChecks: [], plannedEffects: [] }
  const config = parsed.data, blockers: PreviewFinding[] = [], warnings: PreviewFinding[] = []
  const add = (code: string, field: string, detail: string) => blockers.push({ code, field, detail })
  const input = config.executor.directory.trim() || (config.wsl ? config.wsl.workRoot.trim() : '')
  const kind = input ? pathKind(input) : 'inherited-native'
  if (config.wsl) {
    try { validateRequestedTarget(config.wsl) }
    catch { add('TARGET_CONFIG_INVALID', 'wsl', 'A valid distribution, existing Linux user and absolute workspace are required') }
    if (pathKind(config.stateDir) !== 'windows-drive') add('HOST_STATE_NOT_LOCAL_DRIVE', 'stateDir', 'Host state requires an absolute local Windows drive coordinate')
    if (!['linux', 'windows-drive', 'wsl-unc'].includes(kind)) add('WORKSPACE_PATH_INVALID', 'executor.directory', 'A workspace must use a guest, local Windows drive or same-distro UNC absolute coordinate')
    if (kind === 'wsl-unc') {
      const distro = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)/i.exec(input)?.[1]
      if (distro?.toLowerCase() !== config.wsl.distro.trim().toLowerCase()) add('PATH_WRONG_DISTRO', 'executor.directory', 'The workspace belongs to another WSL distribution')
    }
    warnings.push({ code: 'DIAGNOSIS_REQUIRED', field: 'wsl', detail: 'Static validity does not verify the user, mount, Host registration or local disk' })
  } else if (!['linux', 'windows-drive', 'wsl-unc', 'network-unc'].includes(pathKind(config.stateDir))) {
    add('HOST_STATE_PATH_INVALID', 'stateDir', 'An absolute Host state path is required')
  }
  if (!config.executor.prepare.trim()) warnings.push({ code: 'EMPTY_WORKSPACE', field: 'executor.prepare', detail: 'An empty prepare command creates an empty ticket directory; it does not clone a repository' })
  else warnings.push({ code: 'PREPARE_NOT_EXECUTED', field: 'executor.prepare', detail: 'The prepare command has not been executed or claimed to be safe by this preview' })
  return {
    kind: 'static', ready: false, valid: blockers.length === 0, mode: config.wsl ? 'wsl' : 'native',
    requestedTarget: config.wsl ? { distro: config.wsl.distro.trim(), user: config.wsl.user.trim() } : null,
    paths: { stateDir: config.stateDir, workspaceInput: input, workspaceKind: kind },
    prepare: { configured: !!config.executor.prepare.trim(), characters: config.executor.prepare.length },
    blockedCommands: [...config.executor.blockedCommands], blockers, warnings,
    requiredChecks: config.wsl ? ['guest-identity', 'guest-tools', 'workspace-mapping', 'host-registration', 'host-state-locality'] : ['host-state'],
    plannedEffects: ['create-verified-environment-generation', 'possibly-create-work-root', 'possibly-restart-managed-runtime'],
  }
}
