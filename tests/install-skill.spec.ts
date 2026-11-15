import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const home = resolve(root, 'skills/dsh-superagent-install')
const read = (name: string) => readFileSync(resolve(home, name), 'utf8')
const skill = read('SKILL.md')
const official = read('references/official-default.md')
const wsl = read('references/windows-wsl.md')
const network = read('references/network-and-accounts.md')
const preflight = read('references/preflight.md')
const documents = ['SKILL.md', ...readdirSync(resolve(home, 'references')).map(name => 'references/' + name)]

it('ships a bounded discoverable skill with a complete local reference graph', () => {
  expect(skill).toMatch(/^---\nname: dsh-superagent-install\ndescription: .+\n---\n/)
  expect(skill.split('\n').length).toBeLessThan(160)
  expect(documents).toHaveLength(5)
  for (const name of documents) {
    const content = read(name)
    expect(Buffer.byteLength(content)).toBeLessThan(16000)
    for (const match of content.matchAll(/\[[^\]]+\]\(<?([^\s)>]+)>?\)/g)) {
      const target = match[1]!
      if (/^https?:/.test(target) || target.startsWith('#')) continue
      expect(existsSync(resolve(dirname(resolve(home, name)), target.split('#')[0]!)), name + ': ' + target).toBe(true)
    }
  }
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  expect(manifest.files).toContain('skills')
  expect(readFileSync(resolve(root, 'README.md'), 'utf8')).toContain('skills/dsh-superagent-install/SKILL.md')
})

it('requires explicit mode and network selection before preparation and installation confirmation', () => {
  const headings = ['## 1.', '## 2.', '## 3.', '## 4.', '## 5.', '## 6.'].map(heading => skill.indexOf(heading))
  expect(headings.every((at, index) => at >= 0 && (!index || at > headings[index - 1]!))).toBe(true)
  for (const required of ['官方默认', 'Windows DSH 客户端＋WSL 后端', '跨网不等于双机', '跳过/空答案不是同意', '任一必需项为 pending/unknown', '明确确认']) expect(skill).toContain(required)
  expect(preflight).toContain('实际构建与生成是最终安装计划确认后的执行步骤')
  expect(preflight).toContain('单独批准')
})

it('keeps official native setup distinct from the branch-built Windows adapter', () => {
  expect(official).toContain('工作方式与代码来源分开')
  expect(skill).toContain('无论选择 A 还是 B，都优先推荐当前')
  expect(official).toContain('独立官方 checkout')
  expect(official).toContain('https://github.com/deepseek-ai/dsh-superagent-prototype')
  expect(official).toContain('dsh plugin --profile superagent add "link:$PWD"')
  expect(official).toContain('scripts/dsh-superagent start')
  expect(official).toContain('已有 profile 绝不能重跑')
  expect(official).toContain('不要运行 `scripts/make-local-wsl-bundle.mjs`')
  expect(wsl).toContain('--branch feature/windows-wsl-hardening')
  expect(wsl).toContain('https://github.com/ZzuMrW/dsh-superagent-prototype.git')
  for (const flag of ['--out=', '--state-dir=', '--distro=', '--user=', '--work-root=']) expect(wsl).toContain(flag)
  expect(wsl).toContain('plugin_manager.install_bundle')
  expect(wsl).toContain('不启动 Linux DSH/tmux')
})

it('does not deadlock first-time preparation or fresh Source registration', () => {
  expect(preflight).not.toContain('先完成独立新目录源码构建、生成单 tgz')
  expect(wsl).toContain('全新实例则确认没有 Source 配置且 setup 因缺 repo/CLI 等待')
  expect(wsl).toContain('先确认 processing 暂停')
  expect(wsl).toContain('kind 注册后立即以 Source 关闭状态保存')
})

it('retains per-side accounts, model and cross-network authorization boundaries', () => {
  for (const required of ['无跨网', '同机受控代理/VPN/证书', '隔离网/双机/人工中转', 'pending / unknown', '专用 GH_CONFIG_DIR/wrapper', '用户在自己的终端', '网络可达'])
    expect(network + '\n' + skill).toContain(required)
  expect(network).toContain('不使用 `--insecure`')
  expect(network).toContain('没有批准且可验证的连接/人工交接方案就停在准备阶段')
  expect(network).toContain('GitHub 权限不等于允许把内网源码公开')
  expect(skill).toContain('必须单列并经用户明确请求，不能自动创建')
  expect(wsl).toContain('Host 模型密钥留在 Host')
})

it('documents identity, path, upgrade and verification failure stops rather than guessing success', () => {
  for (const required of ['非登录实际执行环境', 'Linux 原生', 'Windows 本地盘符绝对路径', 'wslpath', 'root 不是安装要求', '只读配置', 'restart-required', 'bundle-in-use']) expect(wsl).toContain(required)
  for (const required of ['cold inbox', '不能只看', 'unknown 当0', '恢复原样', '失败一律保持安全状态']) {
    if (required === '恢复原样') expect(preflight).toContain('原样恢复也须明确同意')
    else expect(preflight).toContain(required)
  }
  expect(skill).toContain('缺浏览器控制')
  expect(network).toContain('真实模型/业务写操作')
})
