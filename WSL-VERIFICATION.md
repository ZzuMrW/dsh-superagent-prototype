# Windows Desktop → WSL 阶段性验收摘要（脱敏版）

更新日期：2026-11-15。官方上游基线 `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`。账号、业务项目、机器、路径、模型与证据使用占位符，不公开个人原始报告。**实现、primitive 测试、完整 Runtime 验收、安装及生产部署是不同层级，不能互相代替。**

## 当前 hardening 分支状态

固定目标：DSH Desktop **0.2.2-rc.3**，Node **≥24.9.0**，单包 **dsh-superagent 0.2.0-wsl.1**；不是所有版本/所有 OS 的兼容保证。此前 37/0 peer 结果仅来自 Linux 开发 checkout，不是 ASAR Host 验收；ASAR Host 实查 36 个 peer 可 resolve，剩余 `@deepseek-ai/dsh-client-ui-slots` 仅为 type contract、无产物 JS 引用。不能写成 37 个 Host peer 全部 resolve；这些检查不等于漏洞审计或零漏洞。

单包生成器、metadata/exports/唯一 patch 已实施；source 仍由 Root 总集成。source/raw runtime 默认 disabled；机器版单 tgz 只启 configured runtime，GitHub/Feishu watcher 默认 disabled。不再“主包 + @local 配置包”两层。当前客户端未因此被替换，**不能宣称已部署生产**；候选代码内部已接通 special API `verifiedExecution:true` 用于隔离完整 Runtime 测试；这不是部署授权；guest-local/Windows local drive、自定义 mount 及独立 Windows ticket override 的已测完整 Runtime 组合已通过，仍不代表所有挂载/用户/版本，当前生产未部署。

sourceDate：**2026-11-15**，以下为 Root 提供的本轮隔离实机验收摘要，不是文档编辑者重新执行或生产部署。环境：Windows Host / Electron **44.7** / Node **24.21** / 独立 Ubuntu **24** 测试发行版，UID **0/1000**，自定义 automount root **`/windows`**。全程 **modelRequests=0、离线 gh 替身、Source=false、paused=true**；不据此推断真实账号联网、模型或业务闭环。

| 层级/项目 | 当前证据与结论 |
| --- | --- |
| Windows Host → guest-local 完整 Runtime | 真 Runtime 自动 `master.ensure`、Core relative read/read_image/Bash（隐式 Session policy）、context/project instructions、skills、FileReference、GUI `ctx.get` 均通过；不是仅 primitive。UID0/1000 测试不代表任意用户/发行版都支持 |
| 自有 public adapters / Shell | 自有公开适配链及 Shell 22 + cap 2 专项通过；不依赖 WSL workspace private provider，不把专项计数当作全套 Runtime 矩阵 |
| 坐标、自定义 mount 与 Windows local drive | `/windows` 自定义 mount 环境已实测；Windows drive machine workRoot 的真实 Runtime 已通过自动主 Session、Core read/read_image/Bash、指令/skills、UI/FileReference 及 Peer Remote 路由，Guest cwd 为真实 `/windows/<drive>/…`；独立 Windows ticket override 已通过真实 PUT、明确确认 rebind、preserve 游标及重启：ticket root 为 Windows-local，deployment/master root 保持 guest-local。Windows 9p 权限不能用 ext4 的 Unix 0600 隔离结果替代 |
| Host workspace / 权限与 provenance | 实测覆盖 Host 登记与 guest 路由；UID1000 访问 root-owned 0600 文件在 Core/UI/Remote 均拒绝，forged scope 拒绝，unbound WSL preset fail closed |
| Host SQLite | Runtime 状态留在 Windows 本地盘；UNC/network 不支持，一致备份/回滚仍单独验收，不由工具链通过推断 |
| 静态预演/显式诊断 | 独立诊断/opt-in 契约保留；不能从 Runtime 工具链结果推断完整诊断 API/UI 矩阵，不拿 static valid 当 ready |
| 账号刷新/确认 apply（离线替身，真实 API 路由） | same refresh 无业务状态修改；same-binding health recovery 保持游标/generation；changed account ID 经明确 apply、cutoff/受控 restart 后仍 paused，均通过。不是实际 GitHub 登录/权限联网验收 |
| Session policy / cleanup 安全 hold | Session read-only Bash 拒绝；完整实机测试 profile 的 global 默认实际为 workspace-write，Session 为 danger-full-access，global 未改（global read-only 仅属于独立组件证据，不混为该 profile 实测）；cleanup marker 持久、刷新不清除、无强制继续的边界保留，不能用 queue=0 推断所有 cleanup 故障场景通过 |
| managed changes/watch | **unsupported**；手动刷新可用，不宣称 livewatch 完成 |
| 单包安装/生命周期 | fresh CLI 安装、disable、明确 re-enable、remove、restart 已验；disable 后 stock composition 恢复，restart 后仍为 stock、bundle 不自动 re-enable；remove 后 stock composition 恢复。明确 re-enable 后仍 paused=true / Source=false；与真实旧 v2 迁移及 DB 回滚分开验收。pnpm 11 remove 使用 `--config.ignore-scripts=true`（不接受 `--ignore-scripts`），add 仍用 `--ignore-scripts` |
| Cold Session / 未完成迁移回滚 | 经公开 Agents handle → flush → dispose 后确认 cold；合成 metadata fixture 下 UI read/search、Peer Remote 保持 selected UID，root-owned 0600 拒绝，无激活/零模型。**不是实际历史 Session 迁移；真实旧 v2 双包迁移和一致 DB backup 回滚仍未完全证实**，当前生产未替换 |
| 普通 Windows Session 不回归 | 真实 Core read、pwsh、UI read、FileReference 通过；不从 guest 测试推断 |
| GitHub 真实事件→Ticket→模型→PR/回复 | 本轮没有真实接单、评论、PR 或 push，模型请求为0，不宣称业务闭环通过 |
| 双机/飞书/子代理/GitCode/OS sandbox | 本轮不开发，不提供任意 bind/net mounts、所有版本或系统沙箱支持保证 |

Root 最新回归为 **1511 passed / 1 known Feishu failure**，类型检查与 build 均 exit 0；不是 full-suite green。已知失败在 [Feishu consumer 断言](<tests/sources.spec.ts#L1090-L1098>)：后续 ready 覆盖畸形 JSON health 的原遗留时序，本轮未改断言。tested revision 与现场恢复确认由 Root 最后补；本文档编辑只重跑文档测试/静态检查，不冒充执行这些实机或全套回归。

同一 Master Agent / 同一 preset 在内部 Runtime 重启换 generation 后，指令与技能已按新 binding owner 重建公开 scope；实机确认来源标记匹配新 generation、权限不变、root-owned 0600 仍拒绝、零模型。旧初始化、touch 与注销的竞态另有公开 SkillRegistry 回归覆盖。

本轮实机验收曾发现并修复 POSIX Git config、Router read_image、traceable Service 的 Host 回退、Host cwd 规范化、Shell 的 Session policy 接缝、skills registration scope minter，以及同 Agent 跨 Runtime 的旧 owner 缓存；上表记录的是修复后重跑范围，不隐去先前失败，也不据此提前勾绿未完成矩阵。

## 账号与诊断验收边界

- 来源卡片刷新按钮只查询实际 identity/权限，不 stage、不改 settings/env/cursor、不 source poll、不 pass；不自动解除 hold。不同 identity/target 的 apply 要显式确认且 paused + 真正 quiescent、无旧业务积压。换账号 cutoff T，不重放旧通知，CI revision 不归零；repo ID 不同且有 history 不允许同 state 迁移。
- **完全相同 accepted binding** 的 health recovery 要只读复验既有 generation/config/helper/CLI，保留持久待办/游标/generation，仅清 account hold，不 stage/restart/pass/unpause。Open backlog 不是此恢复的永久阻断；真实 inflight、cleanup marker 和其他安全 hold 仍严格阻断。本轮已在离线替身的真实 API 路由验证此恢复；不据此放松不同绑定切换门禁，亦不等同真实账号联网验收。
- cleanup unconfirmed marker 持久且刷新账号不清除，无强制继续；Execution 状态独立显示安全 hold 并引导来源检查。
- `deployment/preview` 无任何外部执行，始终 ready=false。`deployment/diagnose` 业务只读但 runner 可写 `/tmp` 取消标记；gh GET 可写缓存。network 和 owned workspace 内 4 KiB 写探针分别默认 false、分别明确同意。无 prepare/Ticket/Session/Model/source poll，不将 local pass 宣称为账号/模型/任务闭环。

接口依据：[API](<src/app/execution-api.ts>)、[诊断](<src/app/execution-runtime.ts>)、[静态预演](<src/execution/preview.ts>)；安装升级回滚见 [操作流程](<WSL-ADAPTER.md>)。

## 历史示例环境记录（2026-11-14；不是当前单包结果）

以下保留旧版示例技术验收范围，不扩大来源证据，也不代表读者或当前客户端通过：

- 旧组合为 Desktop 0.2.2-rc.3、dsh-wsl-workspace 0.7.13、主包 0.1.0-wsl.2 + 本地配置层；普通会话保留 dsh-wsl-tool 2.2.6。Windows 管理 UI/模型/SQLite，WSL 执行，未另起 Linux DSH。
- 状态坐标示意为 `C:\Users\<WINDOWS_USER>\.dsh\state\superagent-wsl` 和 `/home/<LINUX_USER>/worktrees`；主 Session 为 guest root 的 `.orchestrator`。示例曾使用管理员身份，不是安装要求。
- 当时类型检查/tsdown 构建和 shell/fs/tools 三个子路径通过；Host 与 Shell 共用 session binding registry，释放后拒绝执行。
- Windows Node 实际调用 wsl.exe，字面 argv/env/cwd 通过；取消/超时回收后代，Host 环境未变。
- 对 `<GITHUB_OWNER>/<GITHUB_REPO>` 的认证和仓库权限 GET 通过，不是 Git push 证据。runtime 当时 setup 无错误、health ready，创建 WSL 主工作区。
- 无模型诊断会话使用标准工具完成合成文件 write/read/edit、grep/glob、Bash/Linux Git helper、后台 job_output/job_kill 与 cleanup；Host PATH/Git 未变，modelRequests=0。临时会话归档、测试文件及注册清理、诊断 bundle 卸载；不是业务 Ticket。
- 本地原始报告摘要曾为 `passed=true`、`restored=true`、`modelRequests=0`；原始业务报告不公开。模型目录 API 可访问，不证明推理/provider/工具组合。
- 当时安全快照为 processing 暂停、GitHub 来源关闭、maxWorkers=1、白名单空、running=0/queued=0；不是实时运行状态，也不授予恢复业务权限。

### 历史回归与安装经验

旧阶段全量 **1234 项：1233 通过、1 失败**；失败为上游 Feishu consumer 的畸形 JSON/ready 状态覆盖断言，Feishu 未启用。没有为全绿而修改断言。取消协议的 Linux LocalSubprocessRuntime 测试不冒充 Windows 实机测试，旧 Desktop 标准工具验证单独进行。以上数量**不是当前分支总集成结果**。

旧 linked 配置层曾遇裸模块解析失败，以主包直接依赖安装作为 workaround；**不能据此说 DSH 硬性要求主包是 profile 直接依赖**。Core dependencyClosure 递归依赖。本版单包不需要旧双层技巧，不同时启用重复 preset/runtime。

旧记录未证明 GitHub 真实消息→Ticket→模型→PR/回复、Git push、双机排他路由/精确 SHA、非默认 UID/custom mount、公司网络证书/GitCode，也没有浏览器视觉验收。本轮新增完整 Runtime 与 cold 等证据仅更新当前矩阵，不倒写扩大旧报告；浏览器视觉验收仍未完成。

后续记录 `<TEST_ISSUE_URL>`、`<REQUEST_COMMENT_URL>`、`<AGENT_REPLY_URL>`、`<TESTED_COMMIT_SHA>` 与 `<VERIFICATION_TIME>`；公开前脱敏。没有因此添加巡检、自动恢复、自动合并、服务器访问或压测，不复制模型密钥、不接收聊天 Token。

完整 47 节安全/双机场景参考仍保留于 [脱敏手册](<docs/windows-wsl-two-host-account-isolation.zh-CN.md>)，不是当前实施重点。
