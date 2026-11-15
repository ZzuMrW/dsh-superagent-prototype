# 安装前准备清单与就绪门禁

每项记录 `ready / pending / unknown`、非秘密证据、下一步及责任人。**required 项全部 ready，才可以请求最终安装确认**；缺失依赖、权限、网络方案或路径证据时，不进入安装配置阶段。未获准的网络检查仍为 unknown，不用安装授权推定同意联网。

## 两条路线共同准备

| 必需项 | 就绪证据 | 未完成时给用户的准备事项 |
| --- | --- | --- |
| 工作方式 | 用户明确选择 A 或 B，列出 Host/执行侧 | 解释区别，等选择，不按当前平台猜 |
| 网络方案 | 用户选择无跨网/获准代理/隔离交接，端点矩阵有批准 | 列网络、CA、镜像或人工交接准备；不自行搭桥 |
| 来源与 revision | 官方独立 checkout 或本分支 fork/revision、branch/dirty 清楚 | 新目录获取，保留已有改动，不 reset 覆盖 |
| 版本/依赖 | 所选 manifest、lockfile、packageManager 与实际版本相符 | 逐侧列缺项与安装/脚本授权，不能盲降全局 DSH |
| GitHub 身份 | 独立用户账号、专用执行侧 CLI、用户完成邀请/登录，获准只读 GET 确认稳定 account/repo ID 与写权限 | 用户创建账号/接受邀请/在正确终端登录；不贴 Token |
| 模型配置 | Host provider/model 可用性配置、费用/数据边界获准 | 用户在 Host 配置，不复制密钥，不默认付费推理 |
| 项目与 prepare | 目标 clone/分支/提交身份、目录和初始化方案清楚 | 用户准备合法基础 clone/依赖；空 prepare 仅空目录 |
| Policy | 来源、允许人工账号、主动模式、并发、auto-merge 已决定 | 保守最小列表/并发1；不把 observe 当暂停 |
| 目标 profile/生命周期 | 新建还是升级，真实 URL/配置来源/包层/活动已核对 | 现有 profile 不重新从模板创建，不启动替代服务冒充当前GUI |
| 备份与恢复选择 | code/config/SQLite 一致备份位置与维护/恢复授权 | 明确停机，正常关闭 writer或受支持在线 backup；不能只拷活库主文件漏 WAL |

只读版本命令可以使用实际环境中的 `node --version`、`pnpm --version`、`git --version`、`python3 --version`、`gh --version` 和 DSH 版本；不输出完整 env/credential 状态文件。实际登录检查必须使用已确认的专用 wrapper 和执行用户。已有 DSH 通过其公开管理/配置 API 获取信息；不为获得检查工具擅改 preset/profile。

## A 专项

- 工作形态和源码来源分开：Desktop 0.2.2-rc.3 在 A/B 都优先推荐当前分支；A 的具体原生运行组合未验证则停准备，不据此假称已适配、不自动改 B 或降级。依赖/版本以已选来源的 manifest 为准。
- 同侧 POSIX 独立 Web/tmux 是官方默认方案；已有 Desktop/profile 先确认是否沿用，不自动新开 Host。若批准新建独立 profile，再查端口/stateDir；已有 profile 禁止运行破坏性的 from-default-profile。
- Feishu/auto-merge 是独立选择，必须核实实际所选代码版本支持能力，凭据由用户准备；不要因沿用默认工作形态就宣称当前分支支持飞书。官方建议的 hourly recovery 单列，只有用户明确请求才创建。

## B 专项

- Windows Desktop 版本与当前 URL/profile；Windows 本地 stateDir 的实际 locality/realpath，不把映射网络盘或 WSL UNC 当本地盘。
- 选择并核实 WSL distro/user、实际 UID/HOME/boot identity。普通用户可用，root 非必须；不自动改默认 distro/user/mount，不碰 Docker。
- **非登录实际执行环境**中的 Linux 原生 Python/sh/bash/Git/rg/gh、wslpath；不能只通过 login shell 的 PATH 判断。缺 `rg` 等应停准备，经批准安装或建立可回滚、不覆盖既有文件的入口。
- 原生 Git 版本/工作区权限可用，原生 CLI 不能被 Host `.exe` 替代；账号 wrapper 与 Git 配置的归属正确。
- Host 可登记工作根，真实 wslpath/目录身份与所选 UID 读写可验证；Linux/Windows local-drive/same-distro UNC 分流正确，不硬编码 `/mnt`。
- 确认独立源码目录/revision、构建依赖、输出位置及单 tgz 方案均已准备就绪；输出不在 profile/state/credentials 下。实际构建与生成是最终安装计划确认后的执行步骤，不把“已有制品”当作首次准备门槛。若需要先作 build-only 检验，必须单独批准，且不安装插件、不触碰 profile/state。

## 现有安装的额外门禁

先通过只读方式找权威 managed master、全部历史/当前 workers、owner jobs/subtrees、cold inbox、effects/outbox/source poll；记录未知项。不能只看 open Ticket、queued 或 Agent idle：maintenance、冷 inbox、待清理/starting/external 后代也需考虑。能力无法安全核实时停下说明，不把 unknown 当0，不读 job output/清 inbox来“变空”。

显示当前 processing/Source 开关后，让用户选择维护期间是否暂停以及成功后保持暂停还是恢复原开关。原样恢复也须明确同意；失败一律保持安全状态并报告，不偷偷恢复。旧配置信息、用户未保存草稿与业务状态分开，不移除仍有活动消费者的预设。

暂停与关闭来源后复查静止，按所选路线正常停 writer/制作一致备份；已有清理未知 hold 不可清除。备份需匹配的代码、配置与数据库时点，不复制 credentials/keychain/个人浏览器资料。用户未选测试发行版不导出生产/其他发行版；清理 VM/目录另确认。

## 安装计划的最终确认模板

> 已选 `<A|B>`；Host=`<environment>`，执行侧=`<environment/user>`；网络=`<selected route>`。依赖/账号/模型/目录 required 项均 ready，证据与缺口如下。将安装 `<source@revision/version>` 到 `<profile>`，新增/修改 `<items>`，需要 `<restart/no new server>`，备份为 `<private backup>`。来源/processing 完成后保持 `<explicitly selected state>`。这不授权真实业务写、付费模型测试、auto-merge 或调度。是否按此计划执行？

只在明确确认后安装/配置；如果用户补充问题、要求“稍等”或改模式，重新收敛相应计划，不继续旧方案。
