/** One-shot live Desktop probe. No model requests, business Tickets, external comments or pushes. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
export const name = 'superagent-wsl-live-probe';
export const inject = ['orchestrator', 'tools', 'sessionController', 'workspaceRegistry', 'permissionPresets'];
export async function apply(ctx, config) {
  const report = { startedAt: new Date().toISOString(), checks: [], passed: false, restored: false };
  const original = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
  const runtime = ctx.get('orchestrator');
  let agent, workspace, folder, release, rejectSteps;
  const jobs = [];
  let sequence = 0;
  async function call(tool, args) {
    const batch = await agent.ctx.tools.execute({ agent, signal: AbortSignal.timeout(20000), calls: [{ type: 'tool-call', id: 'probe-' + (++sequence), name: tool, arguments: JSON.stringify(args) }] });
    const result = batch.results[0]?.result;
    if (!result || result.isError) throw new Error(tool + ': ' + (result?.error?.message ?? 'no result'));
    if (result.value?.jobId) jobs.push(result.value.jobId);
    return result;
  }
  const text = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  try {
    await runtime.ready;
    assert(runtime.configured() && runtime.machine.wsl && runtime.store.settings().paused, 'Runtime must be configured and paused');
    const require = createRequire(import.meta.url);
    const root = dirname(require.resolve('dsh-superagent/package.json', { paths: [config.profileDir] }));
    const host = readFileSync(join(root, 'lib/index.js'), 'utf8');
    const line = host.split('\n').find(line => line.includes(' as registerWslExecution,'));
    assert(line, 'Shared binding import not found');
    const chunk = /from "(\.\/[^\"]+)"/.exec(line)?.[1];
    const register = /\b(\w+) as registerWslExecution\b/.exec(line)?.[1];
    const lookup = /\b(\w+) as wslExecutionFor\b/.exec(line)?.[1];
    assert(chunk && register && lookup);
    const shared = await import(pathToFileURL(join(root, 'lib', chunk)).href);
    assert(shared[lookup](runtime.masterId), 'Probe must use the exact live Host registry');
    const shellApi = await import(pathToFileURL(join(root, 'lib/wsl-shell.js')).href);
    const id = 'local-wsl-diagnostic-' + randomUUID();
    folder = posix.join(runtime.machine.wsl.workRoot, '.' + id);
    assert.equal(posix.dirname(folder), runtime.machine.wsl.workRoot);
    await runtime.commands.run('python3', ['-c', 'import os,sys;os.mkdir(sys.argv[1])', folder], '/');
    const unc = '\\\\wsl.localhost\\' + runtime.machine.wsl.distro + folder.replaceAll('/', '\\');
    workspace = await ctx.workspaceRegistry.create(unc);
    await ctx.sessionController.create({ sessionId: id, workspaceId: workspace.id, agentPreset: 'wsl-dsh-superagent-worker' });
    const resolved = await ctx.sessionController.resolveAgent(id);
    if ('error' in resolved) throw new Error(resolved.error.message ?? resolved.error.code);
    agent = resolved.agent;
    rejectSteps = agent.ctx.on('agent/pre-step', async (input, next) => input.agent.id === id ? { kind: 'reject' } : next(), { prepend: true });
    ctx.permissionPresets.set(agent.session, 'danger-full-access');
    await ctx.sessionController.rename({ sessionId: id, title: 'WSL bridge diagnostic — no model' });
    release = shared[register](id, runtime.setup.executionBinding);
    const file = posix.join(folder, 'probe.txt');
    await call('write', { file_path: file, content: 'bridge-signal=one\n' });
    assert(text(await call('read', { file_path: file })).includes('bridge-signal=one'));
    await call('edit', { file_path: file, old_string: 'one', new_string: 'two' });
    assert(text(await call('read', { file_path: file })).includes('bridge-signal=two'));
    report.checks.push('standard write/read/edit use the guest file');
    assert(text(await call('grep', { pattern: 'bridge-signal=two', path: folder })).includes('bridge-signal=two'));
    assert(text(await call('glob', { pattern: '*.txt', path: folder })).includes('probe.txt'));
    report.checks.push('standard grep/glob use the guest workspace');
    const bash = await call('bash', { description: 'Check Linux and isolated Git configuration', command: 'uname -s; git config --show-origin --get-all credential.https://github.com.helper', workdir: folder, timeoutMs: 5000 });
    assert.equal(bash.value.kind, 'foreground');
    assert.equal(bash.value.exitCode, 0);
    assert(bash.value.stdout.text.includes('Linux') && bash.value.stdout.text.includes('/usr/local/bin/gh'));
    report.checks.push('standard bash uses Linux and the agent Git helper');
    const background = await call('bash', { description: 'Exercise owned background cancellation', command: 'sleep 60', workdir: folder, run_in_background: true });
    assert(background.value.jobId);
    await call('job_kill', { job_id: background.value.jobId, reason: 'Owned bridge diagnostic finished' });
    const stopped = await call('job_output', { job_id: background.value.jobId, wait: true, timeout_ms: 5000 });
    assert(/killed|completed/.test(JSON.stringify(stopped.value)), 'Background job did not settle');
    shellApi.assertWslShellHealthy(id);
    report.checks.push('standard background job and job_kill settle without unconfirmed guest cleanup');
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'request/header').length, 0);
    report.modelRequests = 0;
    assert(Object.entries(original).every(([key, value]) => process.env[key] === value), 'Host environment changed');
    report.checks.push('Host PATH/Git environment unchanged and no model request admitted');
    report.passed = true;
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); }
  finally {
    try {
      if (agent) {
        for (const job of jobs) await call('job_kill', { job_id: job, reason: 'Owned diagnostic cleanup' }).catch(() => {});
        await ctx.workspaceRegistry.archiveSession(agent.id, { stopActivity: true });
      }
      release?.(); rejectSteps?.();
      if (workspace) await ctx.workspaceRegistry.delete(workspace.id);
      if (folder) await runtime.commands.run('python3', ['-c', 'import os,sys;p=sys.argv[1];f=os.path.join(p,"probe.txt");os.unlink(f) if os.path.exists(f) else None;os.rmdir(p)', folder], '/');
      report.restored = true;
    } catch (error) { report.cleanupError = error instanceof Error ? error.message : String(error); }
    report.finishedAt = new Date().toISOString();
    writeFileSync(config.reportPath, JSON.stringify(report, null, 2) + '\n');
  }
}
