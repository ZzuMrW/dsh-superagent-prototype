/** Deployment preview/diagnosis wire contracts. Host owns route authorization and registration. */
import type { DeploymentPreview, DeploymentPreviewInput } from '../execution/preview.ts'
import type { GuestDiagnostic } from '../execution/probe.ts'
import type { GuestPathFacts, HostPathFacts } from '../execution/path-mapper.ts'
import type { ResolvedWorkspace } from '../execution/target.ts'

export type DeploymentCandidate = DeploymentPreviewInput
export interface DeploymentDiagnoseRequest { candidate: DeploymentCandidate; network?: boolean; confirmWrite?: boolean }
export interface DiagnosticCheck { code: string; status: 'passed' | 'blocked' | 'skipped'; detail: string }
export interface DeploymentDiagnosis {
  kind: 'diagnosis'
  status: 'local-verified' | 'account-verified' | 'blocked'
  /** Environment evidence only; never implies configuration was saved/applied or prepare was executed. */
  ready: boolean
  static: DeploymentPreview
  checks: DiagnosticCheck[]
  guest?: GuestDiagnostic
  hostState?: HostPathFacts
  workspace?: ResolvedWorkspace
  deploymentWorkspace?: ResolvedWorkspace
  mount?: GuestPathFacts
  network?: { repository: string; login: string }
  writeProbe?: { directory: string; bytes: number; cleanup: 'confirmed' | 'unconfirmed' }
  effects: string[]
  restart: 'not-applied'
}
declare module './api.ts' {
  interface Api {
    'POST deployment/preview': { body: DeploymentCandidate; response: DeploymentPreview }
    'POST deployment/diagnose': { body: DeploymentDiagnoseRequest; response: DeploymentDiagnosis }
  }
}
export type { DeploymentPreview }
