# dsh-superagent

> Windows→WSL 实验适配分支，目标为 DSH Desktop 0.2.2-rc.3，不是上游正式发行版。先读 [WSL 适配说明](<WSL-ADAPTER.md>)、[双机配置与账号隔离手册](<docs/windows-wsl-two-host-account-isolation.zh-CN.md>)及[阶段性验收摘要](<WSL-VERIFICATION.md>)。以下保留上游项目介绍；不能把模板、历史示例或单机验证当作所有部署的完成状态。

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Windows Desktop + WSL setup

For this branch, follow the [adapter setup](<WSL-ADAPTER.md>). The code package is installed as a direct dependency but its raw bundle stays disabled; enable only the generated machine-configuration bundle. The raw bundle disables its runtime and sources; the generated configuration enables the runtime with its GitHub watcher off. Keep processing paused until accounts, policy and worktree preparation are validated. Do not enable both bundle layers or start a second Linux instance against the same repository by accident.

The [two-host handbook](<docs/windows-wsl-two-host-account-isolation.zh-CN.md>) is a sanitized template: replace every project, account, machine, path and model placeholder. It contains no transferable credentials or private project evidence.

## Upstream setup reference

The following setup flow belongs to the upstream prototype, not the Windows Desktop adapter procedure. Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Development

`pnpm check` runs the typecheck, the tests and the build. The adapter targets GitHub mode only. A known upstream Feishu event-consumer assertion remains documented in the [validation summary](<WSL-VERIFICATION.md>); it is not suppressed or reported as a green full suite. Inspect test failures before running a separate build.

## License

[MIT](LICENSE)
