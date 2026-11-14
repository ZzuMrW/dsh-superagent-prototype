# Windows Desktop → WSL：安装、升级与回滚

本分支基于官方上游 `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`，是实验研究适配，不是官方发行或生产部署承诺。固定验收组合：**DSH Desktop 0.2.2-rc.3、Node ≥24.9.0、dsh-superagent 0.2.0-wsl.1**；pnpm 版本见 [manifest](<package.json>)（11.7.0）。旧 `main` 无此适配，不能通吃所有 DSH/OS 版本。

## 运行边界和支持矩阵

- DSH Host、UI、模型调用、SQLite/锁留在 Windows；GitHub CLI、Git、prepare、受管主/worker 命令在显式 WSL distro/user 下运行。**不另起 Linux DSH、不新开第二服务。** 源代码仍在 WSL Git 仓库维护，不复制 Windows 开发副本。
- Shell、FS、search、context/skills、WorkspaceFiles 与 FileReference 使用本包自有适配和 DSH **public API**，不再依赖 dsh-wsl-workspace 的 private provider。普通会话可以保留原 WSL workspace/XINY 插件；它们不构成本适配的运行依赖。此前 37/0 peer 检查来自 Linux 开发 checkout，不是 ASAR Host；Host 实查为 36 个 peer 可 resolve，剩余 `@deepseek-ai/dsh-client-ui-slots` 为纯 type contract、无产物 JS 引用。两者都不等于漏洞审计或零漏洞。
- `stateDir` 必须是可靠 Windows **本地盘符**绝对路径，且要检查实际盘类型/realpath，不能因有盘符就把映射网络盘判为本地；SQLite 不放 UNC/network/guest 盘。
- `wsl.workRoot`/执行根可输入 Linux 绝对路径、Windows local drive 绝对路径、**同一 target distro** 的 `\\wsl.localhost\<WSL_DISTRO>\...`（或 `\\wsl$\...`）。真实 `wslpath` 转换支持自定义 automount，不能硬编码 `/mnt`，也不再一刀切 guest-only。不同 distro UNC、网络 UNC/任意 bind 或 network mounts 不在支持承诺内。
- 每个 workspace 仍须被 Windows Host `realpath/stat` 成功登记，并验证 Host/guest 指向同一目录；非默认 UID 的 guest 访问通过，不意味着 Host 一定能访问其私有目录。缺证据 fail closed，不回退到默认 distro/user/root。
- UID0/1000、guest-local/Windows local drive、自定义 `/windows` mount 及独立 Windows ticket override 的已测完整 Runtime 组合已通过；不是任意 bind/net mount 或所有用户/版本保证。候选代码内部已接通 special API `verifiedExecution:true`，不是部署授权，当前生产未部署。实际旧 v2 迁移、一致 DB 回滚、真实 GitHub 业务及浏览器视觉仍未验，详见验收摘要。
- managed `changes`/watch **明确 unsupported**，手动刷新可用，不叫 livewatch 完成。WSL managed 子代理、飞书、双机调度与 GitCode 本轮不开发。wrapper/禁用命令不是 OS sandbox，实际 OS 用户权限就是进程权限。

更多证据层级见 [阶段性验收记录](<WSL-VERIFICATION.md>)。

## 0. 检查、暂停与一致备份

以下都是**给操作者的模板，不表示本文已执行**。先替换占位符，不把账号、机器、业务路径、model 或证据写回公开仓库；不要复制凭据或把 Token 发给 Agent。

1. 确认当前 Desktop 确实为 0.2.2-rc.3、有效 profile、原包版本/启用层、受管 Session 预设、stateDir 和原安装制品位置。用 Core 插件管理器 `list_bundles` / `list_plugins` 取得真实 identifier；不重建现有 profile、不把整份模板覆盖用户 patch。
2. 在改动前先备份配置。暂停 processing，关闭来源入口，并回读确认。示例仅对**已经核对的本机原服务 URL**使用，不另启动服务：

   ```powershell
   $Api = 'http://127.0.0.1:<CURRENT_PORT>/orchestrator/api'
   $Headers = @{ 'x-orchestrator-request' = '1' }
   Invoke-RestMethod -Method Post -Uri "$Api/executor/pause" -Headers $Headers -ContentType 'application/json' -Body '{"paused":true}'
   Invoke-RestMethod -Uri "$Api/state" -Headers $Headers
   ```

3. 等待并确认 **全部** managed 主 Session、workers、owner jobs、受管子树、effects、reply/outbox、source polls、diagnostics/admissions 真正静止；必要的停止必须显式授权。`load.running=0`、队列为空或一次 kill 返回都不是后代已回收的证据。cleanup unconfirmed marker 必须人工核实，不能通过刷新、删 marker 或“强制继续”绕过。
4. 在暂停且 quiescent 后正常关闭相应 Host（关闭当前客户端也要先确认）；再备份 profile 和整个匹配的 state，确保 SQLite 连接已关闭。**在线仅复制主 `.sqlite` 文件可能遗漏 WAL，不是一致备份**；如不能停机，只能采用另经批准且验证过的 SQLite backup API 流程。
5. 下例只用于**已停止**的目标，备份根必须为新建的私有本地目录，不上传仓库，不将凭据内容外发：

   ```powershell
   $Profile = '<CURRENT_PROFILE_ABSOLUTE_PATH>'
   $State = '<CURRENT_LOCAL_WINDOWS_STATE_DIR>'
   $Backup = '<NEW_LOCAL_BACKUP_DIRECTORY>'
   if (!(Test-Path -LiteralPath $Profile) -or !(Test-Path -LiteralPath $State)) { throw '核对有效 profile/state 路径' }
   if (Test-Path -LiteralPath $Backup) { throw '备份目标已存在，停止' }
   New-Item -ItemType Directory -Path $Backup -ErrorAction Stop | Out-Null
   Copy-Item -LiteralPath $Profile -Destination "$Backup/profile" -Recurse -ErrorAction Stop
   Copy-Item -LiteralPath $State -Destination "$Backup/state" -Recurse -ErrorAction Stop
   ```

同时现场保存匹配的旧 tgz/code revision、有效机器 config、DSH 版本与备份时点。恢复演练不要覆盖唯一备份；当前生产客户端的实际替换需**另一次 User confirmation**。

## 1. 在 WSL 获取指定分支

新机器使用这个**个人 fork 的授权公开发布目的地**，不是业务账号/目标仓库；官方 credits 仍属于上游。旧 main 没有适配：

```bash
mkdir -p "$HOME/src"
git clone --branch feature/windows-wsl-hardening --single-branch \
  https://github.com/ZzuMrW/dsh-superagent-prototype.git \
  "$HOME/src/dsh-superagent-prototype"
cd "$HOME/src/dsh-superagent-prototype"
git branch --show-current
git rev-parse HEAD
node --version
pnpm --version
```

已有 WSL 原仓库应先检查 `git status --short` 与 branch、保留未提交改动；不要用上例覆盖已有目录，不盲目 reset/pull。Windows 不另存可编辑源码副本。Node 不满足 ≥24.9.0 或工具缺失时停止，安装另经批准。

操作者批准依赖与构建后，才在 WSL 源仓库运行（本文档编辑任务没有执行这些安装/构建命令）：

```bash
pnpm install --frozen-lockfile && pnpm typecheck
node node_modules/vitest/vitest.mjs run
```

先审查并记录失败；已知上游 Feishu 一项不能掩盖或称作 full-suite green。确认依赖/类型检查成功且测试结果已审查后，才另行构建：

```bash
pnpm build
```

`pnpm build` 只证明制品可构建，不证明账号/模型/业务闭环。发布前应由 Root 补最终复验数字，不引用历史计数作当前结果。

## 2. 生成机器版单包

实际 CLI 见 [生成器](<scripts/make-local-wsl-bundle.mjs>)。**五个参数全部必填**，每项只能一次，格式必须 `--key=value`。脚本在 WSL/Linux Node 内运行，读取已构建 `lib`；不安装、不写 profile/state、不登录、不访问 GitHub/模型、不修改 processing。

先由操作者创建并核对 Windows 制品**父目录**；`--out` 本身必须尚不存在。输出通过真实 `wslpath -u/-w` 映射到稳定 Windows storage，不固定 `/mnt/<drive>`，不能落在 guest-only UNC、profile、credentials 或与 state 重叠。保留制品目录，不把它作为临时目录随意移动或删除。

```bash
node scripts/make-local-wsl-bundle.mjs \
  '--out=C:\DSH-Releases\<NEW_RELEASE_DIRECTORY>' \
  '--state-dir=C:\DSH-State\<INSTANCE_NAME>' \
  '--distro=<WSL_DISTRO>' \
  '--user=<LINUX_USER>' \
  '--work-root=/home/<LINUX_USER>/worktrees'
```

也可将 `--out` 换为该 Windows 目录在本发行版的**真实** Linux mount 路径；`--work-root` 可换为 `C:\<LOCAL_WORKSPACE>` 或同 distro UNC。生成器做语法/输出位置检查，不代替 Runtime 的真实磁盘、身份和挂载诊断。不要把 source-code clone、artifact、state 和工单工作区混在一起。

输出仅有一个部署 tgz：`dsh-superagent-0.2.0-wsl.1.tgz`（目录内还保留 stage 和本地 npm cache）。单包含 runtime/client/resources、全部公开子路径和**唯一** `cordis.patch.yml`，不嵌主包依赖、不另造 `@local` 配置包。

- source/raw bundle 的 runtime 可以且默认 `disabled: true`，未配置，不可当作机器版直接开工。
- 生成机器版只把同一 runtime 改为启用并写入 stateDir/distro/user/workRoot；GitHub/Feishu watchers 仍默认 disabled。
- 包安装启用 ≠ 已配置好 Source/模型/prepare ≠ processing 已获恢复授权。

## 3. Core 插件管理器安装

在**已确认的 Windows 目标 profile**执行 Core 工具调用（JSON 是工具参数模板，不是 shell 命令）：

```json
{"action":"install_bundle","target":"C:\\DSH-Releases\\<NEW_RELEASE_DIRECTORY>\\dsh-superagent-0.2.0-wsl.1.tgz"}
```

检查 `application`、warnings、实际 bundle/plugin 配置与运行状态。若报告 `restart-required`/pending，只有经确认重启**现有目标 Host**后才算加载新代码；不能因页面还显示旧功能就反复安装，也不能承诺 HMR。不得手工改整个 profile 的 manifest/patch 或在其中跑 pnpm。

历史双层 linked 配置曾有裸模块解析失败，直接依赖安装是当时 workaround，**不是 DSH“主包必须 profile 直接依赖”的硬限制**；Core `dependencyClosure` 递归遍历 dependencies。本版以自包含单包消除旧双层歧义。

## 4. 首次配置、账号确认与显式恢复

1. 启动已有目标 Host 后立即回读 processing 暂停和来源关闭；不恢复旧 flags。任何 legacy history 无 accepted binding 时，必须在来源检查中明确接受 account/repo/CLI/execution target；不是凭登录名自动认领历史。
2. 区分 **watcher 插件行**与 **Source 的 enabled 设置**：默认 disabled 的 watcher 未注册 kind 时没有可编辑 Source 表单。旧实例须在升级前已保存 Source `enabled=false`；全新实例须确认尚无来源配置、setup 因缺仓库/CLI 等待。只有满足其中一种无轮询条件且 processing 暂停后，才用 Core 管理器列出并启用准确的 GitHub watcher 插件行（不启 Feishu），按实际结果处理 restart-required。若无法证明无轮询条件则停止，不用暂停 processing 代替关闭来源。注册表单后立即以 **Source 关闭**保存目标 GitHub `owner/repo`、独立 Agent CLI（Linux 绝对路径）；允许名单/机器人名单起初为空、主动模式 `off`、不自动合并。不要混淆 fork 发布目的地和业务 Source。
3. 核对 profile 默认/Router、Eval、Execution 三层 `<PROVIDER_ID>/<MODEL_ID>`；配置 `maxWorkers=1`、执行根、Agent 专用基础 clone 和 prepare。空 prepare 不复制仓库。worktree/凭据 helper 与 commit 署名分别核对，勿触碰个人登录。
4. 看 Deployment 静态预演及选择性诊断，修复阻断；配置变化需要重启的应明确安排重启。旧 target 不匹配必须拒绝，不迁 Windows 历史 Session 为 WSL；有历史且 repo ID 不同不能复用该 state，另建隔离实例需要另批。
5. 完成 [验收矩阵](<WSL-VERIFICATION.md>)、安全 hold 清零且 Root 允许 verified execution 后，操作者**显式**批准将已注册 GitHub Source 的 enabled 开启，再显式批准恢复 processing。注册 watcher 不等于批准轮询，暂停 processing 也不等于来源关闭。不要自动恢复备份中的旧 source/processing flag。
6. 真实账号登录/切号、GitHub 评论/PR/push、模型推理与接单闭环都须各自授权，不拿同账号自 @ 当完整接单测试；原型会过滤自身消息。

### 刷新账号与安全 hold

来源卡片按钮通过 `POST sources/:id/accounts/refresh` 发起观察；它内部只做业务 GET identity/权限及本地身份/路径探测，**不 stage、不改 settings/env/cursor、不 source poll、不请求 pass**。可产生 fail-closed account hold，但不会自动解除它。实际应用走 `POST sources/:id/accounts/apply`，携带一次性 `planToken` 与 `confirmed:true`；token/revision 过期或身份再次变化需重新刷新确认。

- **不同 binding/identity/target：** paused + 真正 quiescent，且无旧 open Tickets、business backlog、outbox/effects 等积压；准备隔离 generation，复核身份后原子接受并受控 restart，保持暂停。切账号 cutoff **T** 之后才收新通知，不回放旧数据；CI revision 不归零。repo ID 改变且有 history 拒绝同 state 迁移。
- **完全相同 accepted binding 的 health recovery（离线替身的真实 API 路由已验，不等同账号联网验收）：** 显式确认后 readonly 验证已有 generation/config/helper/CLI 与 target，保留持久待办、游标、binding/generation；只清 account hold，不 stage、不 restart、不 pass、不 unpause。Open backlog 本身不能把此恢复变成永久死路。真实 inflight、其他安全 hold 和 cleanup marker 仍严格阻断，不能据此放松普通切换门禁。
- **cleanup unconfirmed：** marker 持久化，账号刷新不会清除，不提供强制继续。人工核实未解决前保持安全 hold。Execution 状态独立显示安全 hold，并引导来源检查；不要靠 `health ready` 或缓存账号名判断可以运行。

### 静态预演与显式诊断

接口与副作用以 [API 类型](<src/app/execution-api.ts>)、[诊断实现](<src/app/execution-runtime.ts>) 和 [静态预演](<src/execution/preview.ts>) 为准；使用同机 API 前缀/请求头与既有服务，不另起服务：

| 操作 | 真实范围与限制 |
| --- | --- |
| `POST deployment/preview` | 纯静态：无 subprocess/FS/network/Store；即使 `valid=true` 也始终 `ready=false`，不保存候选值 |
| `POST deployment/diagnose` | 显式诊断；业务只读，检查目标/工具/映射/Host local disk；runner 可写 `/tmp` 临时取消标记，不等于物理零写 |
| `network:true` | 默认 false，单独同意的固定 GitHub GET；gh 可写缓存，不登录切号/发评论 |
| `confirmWrite:true` | 默认 false，单独同意且有维护门禁，在已有 verified workspace 内 owned 临时子目录做 4096-byte 写读及清理；cleanup 不确认即阻断 |

诊断不 prepare、不建 Ticket/Session、不请求 Model、不 source poll、不应用设置。`local-verified` 不是账号通过；即使诊断 `account-verified`/ready 也只是环境证据，不是模型或任务闭环完成。

## 升级旧 v2 双包与回滚

旧 `0.1.0-wsl.2`（v2）主包 + `@local` 配置层迁移，不能机械照抄旧流程：

1. 先完成检查、暂停、来源关闭、全树/effects/cleanup quiescence 和一致备份。保存旧 code tgz/linked 位置、配置层 identifier、依赖边及所用预设。
2. **先停用旧 `@local` 配置 bundle，不先删除 code。** 其旧 dependency 仍可能引用/固定同名主包，先查看 plugin manager 的依赖/移除预览；若不允许安全替换就停止，不用手改 manifest 绕过。
3. 在无活 Session 使用的前提下，由 Core 管理器按预览处理旧配置层依赖，再用机器版单 tgz 替换同名 `dsh-superagent`。只留一份有效 patch/runtime/预设声明，不能两层同时启用。不要删除仍被活 Session 使用的 preset，也不把旧 Windows Session 偷迁为 WSL。
4. 预览若报 `restart-required`，经确认正常重启现有 Host；回读实际版本、配置、binding 和安全 hold。不能声称热更新已完成，不自动恢复 sources/processing。
5. legacy history 若要求 accepted binding，明确确认后处理；旧 target 不匹配或 repo 历史不兼容则拒绝，勿清游标/删 DB 求通过。

**回滚：**保持暂停/来源关闭 → 确认 quiescence 与 cleanup → 正常停用/退出新 runtime → 经 Core 管理器恢复**匹配的旧 code + config**（旧双层只能一层生效）→ 在 Host 停止时恢复相同时点的一致 DB/state backup → 重启现有 Host 后回读验证。数据库向前迁移不能让旧程序强开；仅回滚源码/tgz 不够。不要盲目恢复整份 profile 覆盖后来无关改动，也不自动恢复旧 source/processing flags；恢复业务仍须单独明确同意。

本流程不自动安装依赖、不修改生产 profile、不创建定时巡检、不启动第二服务、不真实接单/发评论/push。双机/飞书/GitCode 的历史参考见 [脱敏手册](<docs/windows-wsl-two-host-account-isolation.zh-CN.md>)，不扩大本轮范围。
