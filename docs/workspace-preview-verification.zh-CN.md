# 文件预览修复与验收（2026-11-16）

适用范围：此分支的 Windows→WSL 定制版，固定 DSH Desktop/SDK **0.2.2-rc.3**。基线为 `d14bfc8`。本次是源码修复与隔离验证，不是当前生产 profile 的升级、GitHub 推送或 GUI 视觉验收。

## 根因与正式修复

1. bundle 禁用原生 `workspace-files` Loader 行、以 Host-only 子路径替换服务后，连同该行的浏览器资源 provider 一并失去，因此右侧预览显示“文件资源服务不可用”。
2. 同一 Loader 行原本持有的生成式 Typert 严格契约也被撤回。只补浏览器 provider 后，Gateway 按预期拒绝降级，报 `its strict definition was withdrawn and SRC fallback is forbidden`。

正式代码在 [SessionWorkspaceFiles](<../src/workspace-files.ts>) 中与替代服务共同持有**原生 SDK 的同一份** TYPERT 贡献；Registry 保持严格校验、原子重复拒绝与 fiber 生命周期清理。没有创建第二个 Host 服务，也没有放开 SRC 回退、改变 Session lookup、权限或读文件大小限制。

浏览器入口在 [workspace-resources](<../src/client/workspace-resources.ts>) 中使用已固定版本 SDK 的公开 source export，**构建时打包**原生 provider 及小型协议/路径 helper，由主客户端插件持有一个 child fiber。不是运行时导入另一个 Harness Client 模块，没有复制或硬编码本机安装路径，也没有新增预览 DOM、样式、UI 控件或网络端点。机器配置后的主 Runtime/客户端行须已启用；不能把默认 inert 的 raw/source 包当作完整 GUI 部署。

## 路径结论：不能用安全放宽来掩盖跨环境链接

- Windows 原生会话应使用 Host 坐标，如 `C:/Users/<USER>/file.md`；受管 WSL 会话应使用其绑定发行版、用户下的 Linux 坐标。
- 会话中的 `/mnt/c/...` 字符串不是授权，也不证明某个发行版采用默认 `/mnt` automount。Windows 会话不应静默把它猜成盘符路径，受管 WSL 失败后更不能回退读取 Host。
- 本次保留原样路径及既有错误反馈，用真实 Host/WSL fixture 验证错误环境的路径会失败。**不声称所有历史跨环境 Markdown 链接已修复**；错误坐标的旧链接应改为正确环境下的路径。
- managed `changes/watch` 仍明确不支持；原生浏览器 provider 在观察不可用时回退到一次 stat，受管文件可显式重新读取。不得宣称 WSL 实时刷新已经恢复。

## 可复现的验证

在仓库安装已锁定依赖（不运行依赖安装脚本）后：

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec tsc --noEmit
pnpm exec vitest run tests/workspace-preview.spec.ts tests/workspace-files.spec.ts tests/client.spec.tsx tests/docs.spec.ts tests/bundle-patch.spec.ts
pnpm exec tsdown
node scripts/verify-client-artifact.mjs
```

如 WSL 的包管理器 shim 意外选择 Windows Node，应使用本机明确选定的 **Linux Node** 直接运行对应工具入口，不能把跨平台模块解析错误当作代码测试结果。

[专项测试](<../tests/workspace-preview.spec.ts>) 覆盖真实 Registry/Gateway、原生 browser provider 和真实 ResourceRegistry 的 `none→live→none` 状态、严格参数/多余字段拒绝、资源重复注册拒绝、卸载/重新启用、失效受管 Session、非 owner 拒绝与不回退 Host。Guest RPC 在该套件中使用可区分的受控 fixture，因此另做 Windows 实际文件验证。

[客户端产物检查](<../scripts/verify-client-artifact.mjs>) 只 materialize 构建后的模块 factory：确认一个 `dsh-superagent` 注册、原生 provider 已打包，运行时 externals 仅为 React、React DOM/JSX 与 Cordis 平台基线。无 DOM/renderer/screenshot，不冒充浏览器视觉结果。

### Windows 安装 SDK + 真实文件链路

先在 WSL 构建，然后用 **Windows 安装的 Electron/Node** 执行 [隔离验证脚本](<../scripts/verify-workspace-preview.mjs>)，显式提供下面的参数。脚本要求 Windows 平台，安装锚点必须是实际的 DSH CLI `package.json`，并检查包名和 0.2.2-rc.3 版本；不能用普通 Node 遍历 Desktop 的 ASAR。

```text
verify-workspace-preview.mjs --install-anchor=<Windows DSH CLI package.json> --distro=<registered distro> --user=<test user>
```

Electron 需设置 `ELECTRON_RUN_AS_NODE=1`，Desktop GUI 子系统的进程应重定向输出并等待退出。参数不是安装命令；不会启动另一台 DSH 服务。

脚本在唯一自有 Host temp 与 guest `/tmp` 目录创建带随机 owner 标记的文本/二进制 fixture，经 **真实安装 SDK → 严格 Gateway → 新构建 SessionWorkspaceFiles → 原生 Host FS／实际 WSL Python RPC** 读取。覆盖中文/空格、相对/绝对路径、参数拒绝、缺失文件、受管绑定失效、Gateway 授权拒绝、跨环境路径不猜测、原生 OS watch change、受管显式重读、卸载和重新启用。结束时独立尝试释放 Context、resolver 和两个 fixture 目录；清理失败会使进程失败，不能当通过。

本机该检查已通过，包含 `modelRequests=0`、`serversStarted=0`、`profileChanged=false`。**执行注册表为合成可信 fixture，不是完整 Runtime/历史 Session 迁移证明；已选用户的读测试不代表所有 UID、发行版或 OS 文件权限组合。** 此次没有模型、Source、GitHub、业务 DB、浏览器个人资料或认证令牌访问。

## 全量与审查边界

- 本轮实测：冻结锁离线安装、类型检查、构建、客户端产物检查均 exit 0；预览相关 5 个测试文件 **31/31** 通过；完整套件 **1528 passed / 1 known baseline Feishu failure（总计 1529）**；Windows 隔离真实文件/监听/重读与卸载重启用检查 exit 0。不是 full-suite green，也不是完整用户 GUI 验收。
- 完整测试套件已复现已知 Feishu consumer 的畸形 JSON/ready health 时序断言失败。已在基线 `d14bfc8` 的独立临时 worktree 运行同一测试并得到同一失败；未修改或跳过该断言来“刷绿”。这不是 full-suite green。
- 独立 Codex 审查两次在初始化阶段不可用，因此由主代理对完整 diff、生命周期、安全边界和 UI/UX 作了自审：没有新增自定义预览界面或样式，复用原有反馈；没有浏览器控制，当前用户页面的实际视觉效果未验证。

## 部署与退出外置补丁

本次源码合入**不自动替换当前运行的 Superagent**。现用版本和两个独立兼容补丁保持不动。

升级应按已有 [升级/回退流程](<../WSL-ADAPTER.md>)，先明确暂停并确认 quiescent、备份配置及一致 DB，再生成新的唯一输出目录中的单 tgz，通过 DSH 插件管理器安装；替换当前客户端须单独确认，处理 `restart-required` 并刷新页面。

部署包含此修复的构建前，先关闭此前的 **“文件预览兼容补丁”** 与 **“文件服务严格接口兼容补丁”**，否则会分别与内置 provider/契约发生重复注册。准备好可恢复的旧包与补丁状态；失败时通过插件管理器回退，而不是重开原生 Host 服务或修改网关的安全校验。新构建验证后再移除外置补丁，最后用正确环境路径在实际 GUI 复核文本、CSV、二进制预览和手动刷新。
