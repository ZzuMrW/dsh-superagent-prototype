# Windows Desktop → WSL 阶段性验收摘要（脱敏版）

记录日期：2026-11-14。上游基线为 `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`。本文保留一次示例环境技术验收的范围和限制；账号、项目、机器路径及业务证据链接不公开，统一使用占位符。它不代表读者环境已经通过，也不是当前实例的实时运行状态。

## 验证环境与安装结构

- DSH Desktop：0.2.2-rc.3；dsh-wsl-workspace：0.7.13。
- 示例环境同时保留 dsh-wsl-tool 2.2.6，但本适配使用标准 Bash/文件工具的 WSL world。
- 该次技术验收使用主包 0.1.0-wsl.2 与本地配置 bundle；代码包保留为 profile 的直接依赖，主 bundle 层关闭，仅启用携带机器配置的一层，避免重复声明。
- Windows 宿主管理 UI、模型和 SQLite；WSL 运行命令。没有为此启动第二个 Linux DSH 或替换 Windows 客户端。
- 示例坐标为 `C:\Users\<WINDOWS_USER>\.dsh\state\superagent-wsl` 和 `/home/<LINUX_USER>/worktrees`。它们只是脱敏配置示意，必须替换为现场值。
- 主 Session 使用 guest workRoot 的 `.orchestrator` 子目录；数据库与锁留在本机 Windows 盘。配置目录应位于稳定 Windows 制品位置 `<WINDOWS_RELEASE_DIR>/desktop-wsl-profile`，不能安装后移动或删除。
- 示例曾使用管理员身份；这不是部署要求，公司环境应按批准方案选择专用普通用户及相应隔离。

## 当时已验证

1. 类型检查、tsdown 构建通过，shell/fs/tools 三个 WSL 子路径齐全。
2. 构建产物中的 Host 与 Shell 共用同一个会话 binding registry；释放后该会话不能继续执行。
3. Windows Node 实际调用 wsl.exe，字面 argv、换行/env 与 cwd 传递正确；guest 超时/取消回收后代，Host 环境未变。
4. 对 `<GITHUB_OWNER>/<GITHUB_REPO>` 的认证和仓库权限检查通过。该项只调用只读 API，不以它替代真实 Git push 验收。
5. runtime 的 setup 无错误、health ready，并实际创建 WSL 主工作区。
6. 实际 Desktop 内使用无模型诊断会话和标准工具流水线验证：
   - write/read/edit 操作合成文件；
   - grep/glob 搜索同一 guest 文件；
   - Bash 在 Linux 中运行，Git 使用隔离的 Agent helper；
   - 后台任务、job_kill/job_output 正常结算且无未确认的 guest cleanup；
   - Host PATH/Git 环境不变，诊断会话的模型请求数为 0。
7. 临时诊断会话已归档，临时工作区注册和测试文件移除，诊断 bundle 卸载。它不是业务 Ticket，不代表真实 GitHub 接单。
8. 模型目录 API 可访问；该次技术诊断没有执行模型推理，不能据此宣称所有 provider、模型与工具调用组合均已兼容。

示例环境曾保存本地诊断报告，摘要为 `passed=true`、`restored=true`、`modelRequests=0`；原始报告不随公开源码发布。

## 回归范围

该阶段全量结果为 1234 项中 1233 通过、1 项失败。保留失败属于上游飞书 consumer 的畸形 JSON/ready 状态覆盖断言，飞书没有启用。没有为获取全绿而修改该断言或掩盖失败。

取消协议测试使用真实 LocalSubprocessRuntime，在 Linux 翻译 Windows argv 边界；它们不冒充 Windows 实机测试。实际 Desktop 标准工具验证另行进行。公开分支整理后的最新测试结果应以对应提交的运行记录为准，不把历史数量当作持续集成保证。

## 该次验收时的安全快照

- runtime ready、setup 无问题；
- processing 暂停、GitHub 来源关闭；
- maxWorkers=1、请求者白名单为空；
- running=0、queued=0。

这不是当前任何机器的实时状态，也不是建议照搬已有实例的配置。没有因此增加定时任务、自动合并、跨机同步、服务器访问或压测；没有复制模型密钥或在聊天中接收 Token。

## 未由该次技术验收证明的能力

- GitHub 真实消息 → Ticket → 模型执行 → PR/回复的完整业务闭环；
- Git push 的真实写入身份与权限；
- 双机排他接单、自动开发测试路由和精确业务 SHA 固定；
- 非默认 Linux 用户、自定义 automount、公司 API/证书/网络、GitCode 和内网压测；
- 当前客户端的视觉、主题和控制台状态（无浏览器控制，不宣称完成视觉验收）。

后续业务试运行应另存 `<TEST_ISSUE_URL>`、`<REQUEST_COMMENT_URL>`、`<AGENT_REPLY_URL>` 与 `<TESTED_COMMIT_SHA>` 等现场证据，不在公开模板中填写真实项目链接。账号切换必须核对来源实际使用的 Agent 入口；不能用同账号自 @ 冒充接单验收。

## 安装经验

Desktop 裸模块解析要求主包是 profile 的直接依赖。先安装默认不运行的主包，关闭主 bundle 层，再安装携带明确机器配置的本地配置层。只启用一套预设声明，检查实际 `application`、warnings 与 runtime 健康，不据历史失败日志判断最终状态。

实现说明见 [WSL 适配说明](<WSL-ADAPTER.md>)；部署和账号隔离流程见 [双机配置手册](<docs/windows-wsl-two-host-account-isolation.zh-CN.md>)。本摘要不授予代码出境、生产上线或服务器操作权限。
