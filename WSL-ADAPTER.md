# Windows Host → WSL 本地适配

本分支是基于上游 `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` 的实验性本地适配，不是上游正式发行版。仅针对当前 DSH Desktop 0.2.2-rc.3、Node ≥24.9 和 dsh-wsl-workspace 0.7.13 验证。XINY11451 的 dsh-wsl-tool 可以继续供普通会话使用；本适配的管理会话使用标准 Bash/文件工具，不靠模型自行选择 `wsl-*` 名称。

搜索/图片辅助工具依赖 dsh-wsl-workspace 0.7.13 的内部构建文件路径；Shell/文件系统使用其公开入口。这不是跨版本稳定 API 承诺，升级该依赖时必须重新检查路径和工具契约。

## 范围

- DSH、管理面板、模型调用、SQLite 与锁仍位于 Windows Host。
- GitHub CLI、Git、prepare、工单命令在指定 WSL 发行版运行，不另起 Linux DSH。
- 工单和主 Session 的工作区放在发行版原生文件系统；不能用 `/mnt/<盘符>` 作为工作区根。
- 仅 GitHub。飞书不启用；WSL 执行器暂不支持子代理委派，停止失败会阻断后续执行，不把未释放的子代理当成已经结束。

## 路径和账号

`stateDir` 必须为本机 Windows 盘符绝对路径，不能为 UNC、`/foo` 或 `\foo`。SQLite/锁只由 Windows 进程读写。其 `execution` 子目录存放 Linux 侧使用的 shim/gitconfig，通过标准 `/mnt/<drive>` 映射访问；自定义 automount 根尚未支持。

`wsl.workRoot` 必须为发行版原生绝对路径，例如 `/home/<LINUX_USER>/worktrees`（替换用户占位符后使用）。主 Session 使用其 `.orchestrator` 子目录，不把 Windows 状态目录包装成不可访问的 drvfs UNC 工作区。

Shell、文件、搜索当前必须使用发行版默认用户。配置的 `wsl.user` 若与默认用户不同，启动应拒绝而不是悄悄混用身份。示例环境曾显式选择 root，但部署仍建议专用普通用户；不要为了安装自动更改发行版默认用户。

账号 wrapper 和命令黑名单不是安全沙箱。root 的 WSL 进程可以读取其有权限访问的 Linux/Windows 挂载文件。

## 安装与初始安全状态

源码仍只在 WSL 原仓库和 Git 分支中维护。先执行类型检查、测试与构建，再用 [本地打包脚本](<scripts/make-local-wsl-bundle.mjs>) 生成部署配置包；不要手工改写 Desktop profile 清单。

打包脚本必须在 WSL 内运行，只生成文件，不安装插件、不写 profile、不登录、不调用模型或 GitHub API。`--out` 选择稳定 Windows 本地目录对应的 `/mnt/<drive>/...`；本地目录安装可能链接该目录，安装后不能删除或移动它及其中的 tgz。生成的配置包依赖刚构建后的主包，并为本机提供 `stateDir` / WSL 目标；初始禁用 GitHub watcher。Desktop 的裸模块解析要求主包也是 profile 的直接依赖：先通过 `plugin_manager install_bundle` 安装主 tgz（主 runtime 默认禁用，不会接单），随后 `set_bundle` 停用主 bundle 层但保留依赖，再安装并启用本地配置包。不要同时启用两层重复的预设声明。以上均交给插件管理器，不长期链接 Linux `/root` UNC 源码目录。

安装后先请求同机管理 API `POST /orchestrator/api/executor/pause`（请求头 `x-orchestrator-request: 1`，JSON `{"paused":true}`），再读取 state 确认暂停；随后才启用 watcher 行、保存关闭的来源与执行配置。生成包不初始化业务 settings，必须显式设置 `maxWorkers=1`、空白名单和不自动合并；不能把上游默认并发当作单 worker。`observe` 不是只读模式；处理保持暂停时不应执行或发布任务。

身份验证只使用操作者在本地保存的 gh 登录态，不复制 Windows 模型密钥。单个账号可以验证 GitHub 读取和权限，但原型的 self 消息过滤意味着不能用同账号自 @ 冒充完整接单验收。真实评论/PR 测试需明确批准范围和身份。

## 源码检出中的 Windows 手动冒烟

以下脚本只在源码检出中运行，不是 npm 运行时包的安装步骤。先把所有占位符替换为本机测试值；不会自动登录或修改全局账号。使用 Windows Node，而不是在 Linux 内执行此脚本：

```powershell
$env:SUPERAGENT_TEST_DISTRO = '<WSL_DISTRO>'
$env:SUPERAGENT_TEST_USER = '<LINUX_USER>'
$env:SUPERAGENT_TEST_STATE_DIR = 'C:\Users\<WINDOWS_USER>\.dsh\state\superagent-probe'
$env:SUPERAGENT_TEST_WORK_ROOT = '/home/<LINUX_USER>/worktrees'
node --experimental-strip-types tests/wsl-host-smoke.mts
```

可选的 GitHub 检查仅查询权限，不创建评论、提交或 PR。需要显式指定测试仓库及选定的 CLI，并自行确认这个 CLI 的登录身份；不要把凭据填到这些参数中：

```powershell
$env:SUPERAGENT_TEST_REPOSITORY = '<GITHUB_OWNER>/<GITHUB_REPO>'
$env:SUPERAGENT_TEST_GH_CLI = '/home/<LINUX_USER>/.local/bin/gh-agent'
node --experimental-strip-types tests/wsl-host-smoke.mts --github-check
```

基础包的 runtime 和来源默认禁用；本地配置包只启用已配置的 runtime，来源仍关闭。这样首次安装不会因来源先于 orchestrator 启动而把等待状态误作启用失败。

## 验证层级

1. 类型检查和本地回归测试；保留上游飞书失败项，不改测试隐藏它。
2. 构建产物检查：三个 WSL 子路径齐全，主入口与 Shell 共用唯一的会话 binding registry。
3. Windows Host → WSL 的字面 argv/env/cwd、gh 读取、prepare/Git 身份隔离。
4. 实际标准 Bash/文件/搜索、后台任务输出、取消/超时和后代进程清理。
5. 当前客户端安装、主工作区创建、暂停状态及原 Windows 会话不受影响。
6. 独立批准后才做真实 GitHub 事件 → Ticket → 工作目录 → 交付验证。

“构建通过”“安装成功”“本地工具通过”不能替代第 6 项。尚未执行的层级必须如实标注。

## 停止和回滚

保持 processing 暂停，先等待任务停止，再在插件管理器停用本地配置 bundle。不得在工作 Session 仍使用其专用预设时删除相应预设。源码通过 Git 提交回溯；数据库若已发生迁移，回滚前应恢复与程序匹配的一致备份，不能用旧程序强开新数据库。

本适配不添加定时任务、自动重启、跨机同步、内网服务器访问或压测。公司双网络与 GitCode 适配需要另外审批和现场验证。
