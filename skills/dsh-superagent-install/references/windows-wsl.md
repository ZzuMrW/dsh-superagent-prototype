# B：Windows DSH 客户端＋WSL 后端

## 进程与凭据边界

- Windows 运行现有 DSH Desktop Host、管理 UI、模型 provider、SQLite/锁；不启动 Linux DSH/tmux 或替代 Web 服务。
- WSL 的**明确 distro/user**运行 Git、GitHub CLI、prepare、Shell/FS/search 与项目指令/skills，不能猜默认 distro/root。用户可选已有普通 Linux 用户；记录实际 UID/HOME，root 不是安装要求，也不是 sandbox。
- GitHub 专用 CLI/登录由用户在选定 WSL 用户中准备；Host 模型密钥留在 Host。不得复制生产发行版、Docker 发行版、个人账号配置或凭据来“准备测试”。

当前分支目标：DSH Desktop `0.2.2-rc.3`、Node ≥`24.9.0`、本仓库 manifest/lockfile 指定 pnpm 和 peers。本次 UI 修补版本为 `0.2.0-wsl.2`；实际安装时重新读 manifest 与 compatibility 文档，不外推所有版本兼容。完整操作参考本分支 [SETUP](../../../SETUP.md)、[Windows→WSL 操作流程](../../../WSL-ADAPTER.md)、[验收边界](../../../WSL-VERIFICATION.md)。

## 必须先通过的准备检查

1. Windows：确认真正当前 profile/安装目录/版本和正在连接的 GUI URL，不使用历史硬编码端口；准备可写本地盘 stateDir、独立制品父目录与备份目录。
2. WSL：确认指定发行版和用户存在；在**该用户非登录实际执行环境**检查 Python、sh、bash、Git、`wslpath`、Linux 原生 `rg` 和 `gh`/专用 wrapper。`bash -l` 可见不代表 `wsl --exec` 可见。不能静默调用 `rg.exe`/`git.exe`/`gh.exe` 或回退默认用户；缺工具/PATH 入口先报准备项，经明确批准后才安装/建立不覆盖的入口。
3. 工作目录：stateDir 是 Windows Host 数据库目录，必须真实 Windows 本地盘符绝对路径，不能填 `/root/...`、WSL UNC 或网络映射盘。源码 clone、制品、数据库、部署主根和 ticket root 分开。
4. WSL 工作根候选可为 Linux 绝对路径、Windows 本地盘路径或**同 distro** WSL UNC。用实际 `wslpath` 加 Host realpath/stat 与目录身份验证，自定义 automount 不能猜成 `/mnt/<drive>`。同机 Host 可读不等于选定 UID 可读；Host 也必须能登记该目录。
5. 基础 clone、prepare、人工允许名单、Host provider/model 与专用 GitHub 稳定 ID/仓库权限已准备好。空 prepare 仅建空目录，不会 clone。

任一未就绪就停在准备阶段，给操作者动作清单，不靠“装上去再说”补前置条件。

## 从当前分支构建一个正式插件

源码只在 WSL 维护，不另建 Windows 可编辑副本。新目录示意如下；路径和 revision 由用户确认，不能覆盖已有 checkout：

```sh
git clone --branch feature/windows-wsl-hardening --single-branch \
  https://github.com/ZzuMrW/dsh-superagent-prototype.git \
  "$HOME/src/dsh-superagent-prototype"
```

这里的个人 fork 是适配插件的发布来源，**不是业务仓库或 GitHub Agent 身份**。已有目录先看 branch、commit、dirty 状态；不自动 reset/pull 或丢弃用户改动。优先构建已确认、完整发布的 revision。

批准依赖准备与构建后，在该 WSL checkout 执行：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
pnpm build
```

依赖如确实需要 build scripts，停下让用户单独批准准确包/脚本。记录全部测试结果；已知历史失败也不改断言掩盖，不能写成 full-suite green。

由用户先创建核对 Windows 制品父目录，`--out` 自身必须不存在。读取实际脚本参数后生成机器版：

```sh
node scripts/make-local-wsl-bundle.mjs \
  '--out=C:\DSH-Releases\<NEW_RELEASE_DIRECTORY>' \
  '--state-dir=C:\DSH-State\<INSTANCE_NAME>' \
  '--distro=<WSL_DISTRO>' \
  '--user=<LINUX_USER>' \
  '--work-root=/home/<LINUX_USER>/worktrees'
```

五项均必填，使用 `--key=value`。输出采用真实 `wslpath` 转换；没有固定盘符 mount 假设。检查包清单只有一个本包/唯一 patch，不含嵌套主包、凭据、state、个人配置或 `.artifacts`。**根据当前 manifest/version 和实际输出取 tgz 名称**，不盲用旧文档的文件名。

安装计划获确认且已有部署真正静止/备份后，在**目标 Windows profile**通过 Core `plugin_manager.install_bundle` 安装这个 tgz。不手写整个 profile 的 manifest/patch，不在 profile 中运行 pnpm，不再新增 `@local` 配置壳或补丁外挂。默认机器包注册 runtime、watcher 默认 disabled；Source 是否业务开启还由保存设置决定，两者不同。

## 配置、绑定与启动门禁

- 本分支部署页读取 stateDir/WSL 的**有效只读配置**；Core ConfigForm 只保存三个 volatile 上限。不能在此把普通路径保存成空值，也不能把用户草稿当已经生效。修改机器层需另列迁移计划并使用当前 Core 公共 config editor/受支持安装路径，不借易误用的整 profile 覆盖实现。
- 当前 native/WSL Session、主根和工单根不静默迁移。变更 ticket root 优先使用 Executor 的目录设置；更换 stateDir 是数据库迁移，不能当普通工作目录变更。
- saved Source 初始关闭、processing 暂停、人工允许名单最小、`maxWorkers=1`；模型和 prepare 由用户确认。readonly preview/diagnose 不调用 prepare/模型，也不创建工单。
- GitHub kind 未注册时可能没有可保存的 Source 卡片。先确认 processing 暂停；旧实例须回读 saved Source=false，全新实例则确认没有 Source 配置且 setup 因缺 repo/CLI 等待。满足对应条件并获批后，才启用准确的 GitHub **插件注册入口**；kind 注册后立即以 Source 关闭状态保存所需字段并回读。这不等于业务来源开启。UI 的“未安装”可能只是 kind 未注册，先检查 bundle/row 状态，不反复安装或擅自启业务。
- 刷新账号只观察；首次 legacy 接管/不同 account ID、repo ID 或执行目标要展示计划并明确 apply。说明 `cutover`/`preserve` 和旧事件处理。旧库有历史且 repo ID 不同不得原地换仓库。cleanup unconfirmed 不由刷新清除。
- 安装结果 `applied`/warnings/实际配置分开看；若返回 `restart-required` 或出现旧缓存导出与磁盘字节不一致的诊断，记录原因、让用户完整重启现有 Host 后验证，不重试碰运气。若仅 Client 资源改变，也不要无证据承诺 HMR；要求刷新当前页并明确视觉验收范围。

旧双层升级应先静止备份，停用旧配置层、保留回滚制品，再替换主包。同 ID/name 行可能触发 Core `bundle-in-use` 清理保护：不要为了卸载停用壳而关掉新版活跃同名行、改私有对象或手删文件；停用保留并报告，确需离线移除则另规划确认维护。

当前适配不承诺 managed livewatch、WSL managed 子代理/飞书、GitCode/GHES、跨机调度、通用网络挂载或 OS sandbox。跨网选择不能绕开这些边界，详见 [网络与账号准备](network-and-accounts.md)。
