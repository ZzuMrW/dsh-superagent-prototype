# SETUP — Windows Desktop + WSL hardening 分支

本文件是本分支的新机器安装、升级与交接入口；不是自动实施授权。固定验收目标为 **DSH Desktop 0.2.2-rc.3、Node ≥24.9.0、dsh-superagent 0.2.0-wsl.1**。旧 `main` 没有本适配，不承诺其他 DSH/OS 版本通用。完整步骤、命令和回滚见 [Windows→WSL 操作流程](<WSL-ADAPTER.md>)；证据与待验收矩阵见 [验收记录](<WSL-VERIFICATION.md>)。

## 1. 先问清并只读检查

- 每次只问一个缺失的问题；收齐后给出完整计划，再等明确确认。跳过问题不等于同意。
- 确认目标 Windows Desktop/profile、现有版本/包层、是否已有业务历史、独立备份位置、目标 distro/user 和工作根目录。实际替换当前生产客户端须**另一次 User confirmation**。
- 读有效 profile 的信息，不重建、不覆盖其 patch，不在 profile 中执行包管理命令。记录已启用的旧 `@local` 配置层、旧代码依赖、活动 Session 的预设及代码/配置版本。
- 使用现有工具检查 Windows Desktop 版本、Windows 与 WSL Node、Git/Python/GitHub CLI 等；缺依赖只列为待办，不自动安装。源代码仍在 WSL 维护，不复制一份 Windows 开发副本。
- 账号/路径/模型/证据用现场占位符；不要求把 Token、凭据文件或原始业务日志发到聊天。

## 2. 计划必须列出的安全边界

1. 先检查并备份当前 profile 配置；暂停 processing，关闭来源入口，并确认主 Session、全部 worker、owner jobs、受管子树、effects/outbox/source poll 真正静止且 cleanup 已确认。`running=0` 或点击暂停不是充分证据。
2. 在 quiescent 状态下按批准步骤正常关闭原 Host，制作 SQLite 一致备份及匹配的代码/config；不能在线只复制一个 SQLite 主文件而漏掉 WAL。
3. 在 WSL 检出个人 fork 的指定分支，构建并生成**一个自包含 tgz**，不再安装“主包 + @local 配置包”两层。
4. 由 Core `plugin_manager` 安装机器版 tgz；不手改整个用户 profile，不删仍有活 Session 使用的预设。安装结果若为 `restart-required`，安排确认后的重启，不能宣称 HMR 已生效。
5. 配置来源、允许名单、三层模型、prepare、执行根目录和 `maxWorkers=1`；来源与 processing 不自动恢复。首次接管 legacy history 必须明确接受实际账号/repo/执行目标 binding。
6. 静态预演和显式诊断不等于业务闭环。候选代码内部已接通 `verifiedExecution:true` 用于隔离完整 Runtime 测试，不是部署授权；guest-local/Windows local drive、自定义 mount 及独立 Windows ticket override 的已测完整 Runtime 组合已通过；实际旧 v2 迁移、一致 DB 回滚、真实 GitHub 业务及浏览器视觉仍未验，当前生产未部署。所有所需矩阵验收完成后，才让操作者另行确认恢复，不绕过确认或安全门禁。

## 3. 需收集的首次配置

| 类别 | 必须确认 |
| --- | --- |
| 来源 | `<GITHUB_OWNER>/<GITHUB_REPO>`、独立 Agent CLI 绝对路径、实际账号与稳定 account/repo ID；来源起初关闭 |
| Policy | 起初空允许名单/机器人名单，之后只加入获准人工账号；主动接单 `off`，不自动合并 |
| 模型 | profile 默认/Router、Eval、Execution 的 `<PROVIDER_ID>/<MODEL_ID>` 与获准数据范围 |
| 执行 | distro、user、实际 UID/HOME、Windows 本地 stateDir、workRoot、Agent 专用基础 clone、prepare、并发 1 |
| 验收 | 允许的本地诊断、单独的网络 GET 同意、单独的 4 KiB 临时写探针同意；真实业务测试另批 |
| 回滚 | 对应旧 tgz/code、配置与同一时点一致 DB backup；恢复后仍暂停、来源关闭 |

空 prepare 不会克隆仓库；`off`/`observe` 不阻断获准人工明确 @，不能替代 processing 暂停。账号 wrapper、禁用命令与独立 worktree 不是 OS sandbox。

## 4. 升级、切账号与故障处理

- 旧 v2 双包升级：先停用旧 `@local` 配置层，**不要先删旧 code**；确认依赖关系及同名 `dsh-superagent` 的替换计划，再安装单包。详见 [升级与回滚](<WSL-ADAPTER.md#升级旧-v2-双包与回滚>)。
- 来源卡片“刷新账号”只观察 identity/权限，不 stage、不改 settings/env/cursor，也不自动解除 hold。不同 identity/target 必须明确 apply，paused + 真正 quiescent，且无旧业务积压；换账号以 cutoff T 开始，不回放旧通知，不把 CI revision 清零。
- 完全相同 accepted binding 的 health recovery 是独立只读验证路径：验证既有 generation/config/helper/CLI，只清 account hold，不 stage/restart/pass/unpause；保留持久待办、游标与 generation。真实 inflight、其他安全 hold、cleanup marker 仍阻断。不要为消除 Open backlog 而删库。
- cleanup unconfirmed 持久保留，刷新账号不清除，没有“强制继续”。执行状态卡独立显示安全 hold，并跳转来源检查。
- 不迁移 Windows 历史 Session 为 WSL；旧 target 不匹配就拒绝；不同 repo ID 且有历史不能沿用同一 state。

## 5. 交接报告

报告安装制品/目标版本、`application`/warnings、重启是否完成、暂停/来源/安全 hold 状态、备份位置（仅现场保留）、实测通过/失败/跳过/待验收。不要用本地 pass 代替账号、模型或 GitHub 接单闭环，不宣称全 suite green；已有 Feishu 一项历史失败保留。

本轮不启动第二个 Linux DSH/第二服务、不创建定时巡检、不登录切号、不真实接单/评论/PR/push、不自动恢复旧来源或 processing flag。双机、飞书、子代理、GitCode 本轮不开发；[47 节脱敏手册](<docs/windows-wsl-two-host-account-isolation.zh-CN.md>)保留为参考，上游纯 Linux Web 方式仅见 [历史部署参考](<docs/006-deployment.md>)，不能混用。
