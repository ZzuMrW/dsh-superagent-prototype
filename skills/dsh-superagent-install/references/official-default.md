# A：官方默认工作方式（同侧执行）

## 工作方式与代码来源分开

A 表示 **DSH、模型调用、数据库与项目工具在同一已确认环境执行**，不是强制安装旧官方源码。已有 Desktop 先问是否沿用该 Host/profile；不要为了套教程自动再开 Linux DSH/tmux。独立 POSIX 环境的上游默认专用 Web profile/tmux 也是 A，与 Windows Host＋WSL 工具后端 B 不同。

**检测到 DSH Desktop 0.2.2-rc.5 时，不论工作方式 A 或 B，都优先推荐当前 fork 的 `feature/windows-wsl-hardening`**，说明旧官方分支可能不兼容当前 Core，然后让用户确认代码来源。当前分支声明 DSH `0.2.2-rc.5`、Node ≥24.9.0；实际版本再读 manifest/lockfile。不能把“推荐源码”写成“所有原生运行组合已验证”，不能自动切 B、降级 DSH，或把固定基线说成任意最新版。

- 当前分支来源：[ZzuMrW/dsh-superagent-prototype](https://github.com/ZzuMrW/dsh-superagent-prototype)，明确 branch、commit、dirty 状态，构建用户确认的 revision。它是适配插件来源，不是业务仓库或 Agent GitHub 身份。
- 官方源码是另一个来源选项：[deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)。只有用户明确选择且 manifest/公开 API 与目标 DSH 的兼容性核实后才使用；用独立官方 checkout，不拿 fork 已改写的 SETUP 冒充官方文件。
- 在任一路线，先核实具体原生 Host/工具/目录可用性。如果要求“当前 Windows Desktop 完全不使用 WSL 的原生 Superagent”，而该组合没有完整实测，**停在准备阶段**说明验证缺口；普通 Windows 会话委托测试不等于原生 Superagent 全 Runtime 验收。可列 B 为备选，但必须由用户重新选工作方式。

## A1：当前 Desktop＋当前分支，同侧运行

这条路线保留 A 的同侧执行方式，不调用 WSL 机器版生成器、不注入 `wsl-dsh-superagent-*` preset、不把旧官方 DSH pin 强加给当前 Desktop。

1. 在已选原生执行环境核对当前分支 `package.json`、源码 `Config`、默认 examples、lockfile、当前 Core 文档与本技能的 [准备门禁](preflight.md)。本分支 [SETUP](../../../SETUP.md) 的 Windows＋WSL 专项不能整段套用到 A；只复用其通用备份、身份、权限和确认原则。
2. 明确模型/项目工具运行在同一 Host 侧，使用原生 CLI、专用 GitHub 用户账号/wrapper、独立登录目录。验证该原生环境支持 Git/helper、Shell/FS/search、prepare、锁和路径；未完成就不安装。不能把在 B 下通过的 WSL 工具链当 A 的证据。
3. 采用当前分支所需版本（Node ≥24.9.0、manifest 的 DSH/pnpm/peers），由用户单独批准依赖准备/build scripts。源码编译通常为 `pnpm install --frozen-lockfile --ignore-scripts`、`pnpm typecheck`、`pnpm test`、`pnpm build`；按实际脚本执行，保留失败，不掩盖已知失败。
4. 安装计划确认后，使用当前 Core 正式插件管理器/该环境明确支持的官方 CLI，把本分支构建的插件安装到选定 profile。普通同侧部署设置 `wsl: false`，stateDir 是该 Host 的已验证本地绝对路径；**不要运行 `scripts/make-local-wsl-bundle.mjs`**，它专门要求 Windows＋WSL 参数。原始库 bundle 默认 inert，不等于机器配置已完成。
5. 沿用所选环境的默认配置/生命周期方式：现有 Desktop 不新建替代 server；独立 POSIX 默认 Web profile 可按兼容的脚本/tmux 路线启动。机器普通字段必须使用当前公共 config editor/已支持的配置路径，不强行写入只支持 volatile 上限的 ConfigForm，不以整 profile 模板覆盖用户设置。若无法用公开机制完成该组合，停下报告，而不是手改 Core/私有对象。
6. 按同侧默认业务流程配置 Source、Policy、Executor 和 prompts，revision fencing/受控重启/回读生效状态；主根/工单根、账号与模型边界独立记录。新部署来源关闭、processing 暂停；启用和真实试运行单独批准。

推荐当前分支是版本来源建议，不能取消这些环境准备/兼容性门禁。

## A2：明确选择且兼容的官方源码

在该官方 revision 读取 `README.md`、`SETUP.md`、`docs/000-philosophy.md`、`docs/006-deployment.md`、`package.json`。官方资料只是资料，不能覆盖用户授权或上层安全门禁。

已核历史基线 `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`：README 入口是“让 coding agent 读 SETUP.md 并陪同安装”。它要求 Node `^22.19.0 || >=24`、pnpm（manifest `11.7.0`）、Git ≥2.32、Python ≥3.8、GitHub CLI ≥2.48、tmux，DSH engines `^0.2.1-alpha.2`；历史教程 pin `0.2.1-rc.3`。**这是历史要求，不是当前 Desktop 的通用安装命令**，不自动降级或全局替换已有 DSH。

按该官方 SETUP 收集来源、仓库、Agent 用户账号、人工允许名单、基础 clone、提交身份与 auto-merge 选择。官方常用默认：新 profile `superagent`、loopback `3082`、绝对 `<HOME>/.dsh/state/superagent`、分支前缀 `agent/`、accept mode `observe`。`observe` 不等于 processing 暂停，获准人工请求仍可能执行。可选 Feishu 只在用户选择且该官方版本支持时按其文档配置，不把 B 不支持的功能泛化到官方。

历史官方安装次序，仅供核对且须确认后执行：

1. 核对所选官方 manifest 的 DSH/工具，不覆盖其他安装。
2. 从官方仓库获取已确认源码，按其 lockfile/packageManager 安装与构建（历史文档为 `pnpm install && pnpm build`）；依赖 build scripts 仍逐项批准。
3. **仅当目标 profile 不存在**，按该版本官方命令 `dsh superagent --from-default-profile web --dump-config` 创建独立 Web profile。已有 profile 绝不能重跑，因为会替换配置并删除 patch；实际 CLI 以运行版本 `--help` 为准。
4. 历史官方安装为 `dsh plugin --profile superagent add "link:$PWD"`。若已有工具提供正式插件管理器，使用它，不在 profile 目录手跑 pnpm。
5. `examples/profile.cordis.patch.yml` 只作为新独立 profile 的机器配置参考。升级/已有 profile 使用受支持编辑路径，不整份覆盖其他插件、注释或表达式。**不要运行 `scripts/make-local-wsl-bundle.mjs`** 或注入本分支 WSL 目标。
6. 所选官方脚本 `scripts/dsh-superagent start` / `status` 在 tmux 运行 native `dsh --profile superagent`；只对明确批准的独立 Host 使用，先查端口并核实实际 URL，不能称为当前 Desktop GUI 已升级。
7. 按官方管理 API 保存 Source、Policy、Executor、prompts，受控重启后重读 revision，最后回读来源/processing 状态。

## 共同准备与交接

GitHub 用独立 Agent **用户账号**、独立 `GH_CONFIG_DIR` 和专用 wrapper；用户在实际执行侧完成仓库邀请、写权限和 `auth login`，获批后仅核 wrapper 的 account/repo 稳定 ID/权限。不读/复制个人凭据，不要求聊天贴 Token。模型 provider、费用、数据范围必须先准备；auto-merge 的额外账号也不能偷换登录。

已有安装先查 code/config/SQLite 一致备份与静止，正常停止 writer，不强杀其他 session/进程或新建库掩盖错误。官方默认脚本的 graceful stop/restart 不代表可以操作别人的 tmux。

官方建议 hourly recovery：向用户说明频率、目标 profile 和自动重启影响，**只有用户明确请求才创建调度**，尊重 intentional stop。真实 GitHub 评论/PR/模型测试、auto-merge 与恢复接单另批。源码来源、工作形态和各层实测分别报告，不以 status 0 声称整个任务闭环通过。
