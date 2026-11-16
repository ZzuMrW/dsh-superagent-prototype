# dsh-superagent

> Windows→WSL 实验适配分支，目标为 DSH Desktop 0.2.2-rc.3，不是上游正式发行版。先读 [WSL 适配说明](<WSL-ADAPTER.md>)、[双机配置与账号隔离手册](<docs/windows-wsl-two-host-account-isolation.zh-CN.md>)及[阶段性验收摘要](<WSL-VERIFICATION.md>)。以下保留上游项目介绍；不能把模板、历史示例或单机验证当作所有部署的完成状态。

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](<https://www.deepseek.com/en/harness/>). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](<docs/000-philosophy.md>) explains the principle and what it asks of the operator.

## Guided installation skill

Read [the installation skill](<skills/dsh-superagent-install/SKILL.md>) before choosing an installation path. It asks whether to use **official default deployment** or **Windows DSH Desktop + WSL execution**, then asks about cross-network access and checks dependencies, dedicated GitHub credentials, model/data boundaries and workspace readiness. Only a confirmed, ready environment proceeds to installation. Working style and code source are separate decisions: Desktop 0.2.2-rc.3 users are guided to this branch in either style because older upstream code may not support the current Core; the user confirms the source, and unverified native combinations stop at preparation rather than silently switching to WSL. Explicit compatible upstream-source installations still use that upstream revision's own guidance. The WSL style builds this branch as one plugin bundle. No current profile, business switches, network settings or schedules change merely by reading the skill.

## Windows Desktop + WSL setup

**Use this fork and this branch, not old `main` (which has no Windows→WSL adaptation):**

```bash
mkdir -p "$HOME/src"
git clone --branch feature/windows-wsl-hardening --single-branch \
  https://github.com/ZzuMrW/dsh-superagent-prototype.git \
  "$HOME/src/dsh-superagent-prototype"
```

Create the parent directory first; do not overwrite an existing checkout. This is the authorized public fork destination, not a business account or Source repository. Maintain source code in WSL only; do not copy a Windows development checkout.

Follow [SETUP](<SETUP.md>) and the [complete install/upgrade/rollback procedure](<WSL-ADAPTER.md>). The pinned acceptance target is **DSH Desktop 0.2.2-rc.3, Node ≥24.9.0, dsh-superagent 0.2.0-wsl.1**; not arbitrary versions. Build in WSL, then use the generator's real CLI to produce **one self-contained machine tgz** with one patch. Its configured runtime is enabled, watchers remain disabled; the unconfigured raw/source bundle runtime stays disabled. There is no separate main + `@local` configuration bundle. Historical linked-resolution workarounds were not a Core direct-dependency restriction; Core dependencyClosure traverses dependencies recursively.

UI patch **0.2.0-wsl.2** fixes deployment-value echoing: stateDir/WSL coordinates are read-only effective Runtime values; only the three volatile limits use DSH ConfigForm writes. The preview uses the effective machine coordinates. This patch does not add an ordinary-configuration editor or migrate any data.

The branch also restores the stock browser file resource provider and strict WorkspaceFiles contract alongside its Host-only replacement. See [file-preview verification and migration](<docs/workspace-preview-verification.zh-CN.md>): no Host/WSL path guessing or SRC downgrade, managed livewatch remains unsupported, and existing external compatibility bridges must be disabled before deploying this change. A source merge is not a production upgrade or browser visual acceptance.

Before installation, inspect/back up the existing profile, pause and confirm all managed workers/main Session/owner jobs/subtrees/effects and cleanup are quiescent, then take a consistent SQLite backup. Install the tgz through Core `plugin_manager`, never overwrite the whole user profile. Handle legacy binding confirmation, Source/allowlist/model/prepare/maxWorkers explicitly and keep processing paused. `restart-required` means a real confirmed restart, not HMR; replacing the current production client needs separate User confirmation. Do not auto-restore old source/processing flags or start a second Linux DSH/service.

The adapter owns public Shell/FS/search/context/skills/WorkspaceFiles/FileReference adapters; existing ordinary WSL workspace/XINY plugins may remain but no private provider is required. The tested UID0/1000 guest-local and Windows-local-drive full-Runtime combinations, including custom automount and a separate Windows ticket-root override, have passed in an isolated environment. This does not establish arbitrary user/mount/OS compatibility; actual old-v2 migration, consistent-DB rollback, live GitHub business closure and browser visual acceptance remain unverified. Candidate code has internally connected `verifiedExecution:true` for isolated full-Runtime testing; this is not deployment authorization, and production remains unchanged. Managed changes/watch is unsupported (manual refresh works). See the [honest support matrix](<WSL-VERIFICATION.md>)—local checks do not establish account/model/task closure. The earlier 37/0 peer result belongs to the Linux development checkout, not the ASAR Host: Host inspection resolved 36 peers; `@deepseek-ai/dsh-client-ui-slots` is the remaining type-only contract with no emitted JS reference. Neither result is a vulnerability audit or zero-vulnerability claim.

The [two-host handbook](<docs/windows-wsl-two-host-account-isolation.zh-CN.md>) is a sanitized template: replace every project, account, machine, path and model placeholder. It contains no transferable credentials or private project evidence.

## Assisted setup

Ask your coding agent:

> Read SETUP.md and WSL-ADAPTER.md on this branch, inspect my existing setup, and propose installation with me. Do not install, log in, start business processing or replace my current client without explicit confirmation.

[SETUP](<SETUP.md>) requires one question at a time and confirmation before execution. Double-host routing, Feishu, managed subagents and GitCode are not developed in this round; the old handbook remains reference, not an instruction to deploy another service. The numbered Deployment guide retains an explicitly labelled upstream/Linux reference.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](<docs/000-philosophy.md>)
- [001 Domain model](<docs/001-domain.md>)
- [002 Authorization](<docs/002-authorization.md>)
- [003 Execution](<docs/003-execution.md>)
- [004 Prompts](<docs/004-prompts.md>)
- [005 Panel](<docs/005-panel.md>)
- [006 Deployment](<docs/006-deployment.md>): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](<docs/007-architecture.md>)
- [008 Cookbook](<docs/008-cookbook.md>): adding a Source

## Development

`pnpm check` runs the typecheck, the tests and the build. The adapter targets GitHub mode only. A known upstream Feishu event-consumer assertion remains documented in the [validation summary](<WSL-VERIFICATION.md>); it is not suppressed or reported as a green full suite. Inspect test failures before running a separate build.

## License

[MIT](<LICENSE>)
