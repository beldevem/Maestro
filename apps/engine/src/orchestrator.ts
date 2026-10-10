import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { codeHostFor } from './adapters/codehost/index.js';
import { pmFor } from './adapters/pm/index.js';
import type { CodingAgent } from './agents/coding-agent.js';
import { fixPrompt, pullRequestBody, ticketPrompt, workerSystemPrompt } from './agents/prompts.js';
import type { Store } from './db.js';
import { bus } from './events.js';
import { runGates } from './gates.js';
import { git } from './proc.js';
import type { SecretStore } from './secrets.js';
import type { Agent, AgentState, Project, Run, RunEventKind, Ticket } from './types.js';
import { branchName, checkReady, commitMessage, parseWorkflow, type Workflow } from './workflow.js';

export interface OrchestratorDeps {
  store: Store;
  secrets: SecretStore;
  agent: CodingAgent;
  reposDir: string;
  worktreesDir: string;
}

export class NotReadyError extends Error {
  constructor(readonly reasons: string[]) {
    super(`Ticket is not ready: ${reasons.join(' ')}`);
  }
}

const BASE_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'TodoWrite', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(ls:*)'];

export class Orchestrator {
  private readonly active = new Map<string, AbortController>();

  constructor(private readonly d: OrchestratorDeps) {}

  maxConcurrent(): number {
    return Number(this.d.store.getSetting('maxConcurrentRuns') ?? 3);
  }

  workerModel(agent: Agent): string {
    return agent.model || this.d.store.getSetting('model.worker') || 'claude-sonnet-5-5';
  }

  /** Assign a ticket to a worker and start the run in the background. Returns once the run exists. */
  async start(projectId: string, ticketKey: string, opts: { agentId?: string; force?: boolean } = {}): Promise<Run> {
    const { store } = this.d;
    const project = store.getProject(projectId);
    if (!project) throw new Error('Project not found.');
    const wf = parseWorkflow(project.workflowYaml);
    const pm = pmFor(project, store, this.d.secrets);
    const ticket = await pm.getTicket(ticketKey);
    if (!ticket) throw new Error(`Ticket ${ticketKey} not found.`);

    const reasons = checkReady(wf, ticket);
    if (reasons.length && !opts.force) throw new NotReadyError(reasons);
    if (this.active.size >= this.maxConcurrent()) throw new Error(`Already running ${this.active.size} tickets, the limit in Settings.`);
    if (store.listRuns(projectId).some((r) => r.ticketKey === ticketKey && r.status === 'running')) {
      throw new Error(`${ticketKey} is already being worked on.`);
    }

    const agent = opts.agentId
      ? store.getAgent(opts.agentId)
      : store.listAgents().find((a) => a.role === 'worker' && a.state === 'available');
    if (!agent) throw new Error('No worker agent is available. Add one on the Agents screen or wait for one to finish.');
    if (agent.state !== 'available') throw new Error(`${agent.name} is ${agent.state.replace('_', ' ')}.`);

    const codeHost = codeHostFor(project, this.d.secrets, this.d.reposDir);
    const repoPath = await codeHost.ensureRepo(project);
    if (wf.pull_before_start) await codeHost.syncBase(repoPath, wf.base_branch);
    const baseRef = await this.resolveBase(repoPath, wf.base_branch);

    let branch = branchName(wf.branch_pattern, ticket);
    if (await this.branchExists(repoPath, branch)) branch = `${branch}-${Date.now().toString(36)}`;

    const dir = join(this.d.worktreesDir, project.id);
    mkdirSync(dir, { recursive: true });
    const run = store.createRun({ projectId, agentId: agent.id, ticketKey: ticket.key, ticketTitle: ticket.title, branch, worktree: '' });
    const worktree = join(dir, run.id);
    await git(repoPath, ['worktree', 'add', '-b', branch, worktree, baseRef]);
    store.db.prepare('UPDATE runs SET worktree = ? WHERE id = ?').run(worktree, run.id);
    run.worktree = worktree;

    const controller = new AbortController();
    this.active.set(run.id, controller);
    this.publishRun(run);
    this.setAgent(agent.id, 'working', run.id, `On ${ticket.key}`);
    this.log(run.id, 'info', `${agent.name} picked up ${ticket.key} on branch ${branch} from ${baseRef}.`);

    void this.work({ project, wf, ticket, agent, run, repoPath, codeHost, pm, signal: controller.signal }).finally(() =>
      this.active.delete(run.id),
    );
    return run;
  }

  stop(runId: string): boolean {
    const c = this.active.get(runId);
    if (!c) return false;
    c.abort();
    return true;
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  private async work(ctx: {
    project: Project;
    wf: Workflow;
    ticket: Ticket;
    agent: Agent;
    run: Run;
    repoPath: string;
    codeHost: ReturnType<typeof codeHostFor>;
    pm: ReturnType<typeof pmFor>;
    signal: AbortSignal;
  }): Promise<void> {
    const { project, wf, ticket, agent, run, codeHost, pm, signal } = ctx;
    const { store } = this.d;
    let cost = 0;
    const tools = [
      ...BASE_TOOLS,
      ...wf.quality_gates.map((g) => `Bash(${g.run}:*)`),
      ...wf.allowed_commands.map((c) => `Bash(${c}:*)`),
    ];
    const anthropicKey = this.d.secrets.get('ANTHROPIC_API_KEY');
    const env: Record<string, string> = anthropicKey ? { ANTHROPIC_API_KEY: anthropicKey } : {};

    const finish = (status: Run['status'], agentState: AgentState, extra: Partial<Run> = {}, note = '') => {
      const updated = store.updateRun(run.id, { status, costUsd: cost, endedAt: new Date().toISOString(), ...extra });
      if (updated) this.publishRun(updated);
      this.setAgent(agent.id, agentState, agentState === 'blocked' ? run.id : null, note);
    };

    try {
      await pm.moveTicket(ticket.key, 'in_progress').catch((e) => this.log(run.id, 'error', `Could not move the ticket: ${e.message}`));

      let session: string | undefined;
      let summary = '';
      let prompt = ticketPrompt(ticket);
      let attempt = 0;
      let gateResults: Awaited<ReturnType<typeof runGates>>['results'] = [];

      for (;;) {
        this.setAgent(agent.id, attempt === 0 ? 'working' : 'working', run.id, attempt === 0 ? `On ${ticket.key}` : `Fixing ${ticket.key}, try ${attempt}`);
        const outcome = await this.d.agent.run({
          cwd: run.worktree,
          prompt,
          systemPrompt: workerSystemPrompt(project, wf),
          model: this.workerModel(agent),
          allowedTools: tools,
          resume: session,
          env,
          signal,
          maxBudgetUsd: Number(store.getSetting('budget.perRunUsd') ?? 0) || undefined,
          onMessage: (m) => this.log(run.id, m.kind === 'tool' ? 'tool' : 'agent', m.text),
        });
        cost += outcome.costUsd;
        store.updateRun(run.id, { costUsd: cost });
        if (signal.aborted) throw new Error('aborted');
        if (!outcome.ok) throw new Error(outcome.error ?? 'The agent stopped without finishing.');
        session = outcome.sessionId ?? session;
        summary = outcome.text || summary;

        this.setAgent(agent.id, 'running_checks', run.id, `Checking ${ticket.key}`);
        this.log(run.id, 'info', 'Running quality gates.');
        const gates = await runGates(wf, run.worktree, (g) =>
          this.log(run.id, 'gate', `${g.passed ? 'PASS' : 'FAIL'} ${g.name} (${Math.round(g.durationMs / 1000)}s): ${g.command}${g.passed ? '' : `\n${g.output}`}`),
          signal,
        );
        gateResults = gates.results;
        if (signal.aborted) throw new Error('aborted');
        if (gates.passed) break;

        attempt += 1;
        store.updateRun(run.id, { attempts: attempt });
        const failed = gates.results.at(-1)!;
        if (attempt > wf.max_fix_attempts) {
          const msg = `"${failed.name}" still fails after ${wf.max_fix_attempts} fix attempts.`;
          this.log(run.id, 'error', msg);
          await pm.comment(ticket.key, `Maestro: ${msg} The branch ${run.branch} has the work so far.`).catch(() => undefined);
          finish('blocked', 'blocked', { error: msg }, `Blocked on ${ticket.key}: ${failed.name} fails`);
          return;
        }
        prompt = fixPrompt(failed, attempt, wf.max_fix_attempts);
      }

      const status = await git(run.worktree, ['status', '--porcelain']);
      if (!status) {
        const msg = 'The agent finished without changing any files.';
        this.log(run.id, 'error', msg);
        finish('blocked', 'blocked', { error: msg }, `Blocked on ${ticket.key}: no changes`);
        return;
      }

      await git(run.worktree, ['add', '-A']);
      const identity = (await git(run.worktree, ['config', 'user.email']).catch(() => ''))
        ? []
        : ['-c', 'user.name=Maestro', '-c', 'user.email=maestro@localhost'];
      await git(run.worktree, [...identity, 'commit', '-m', commitMessage(wf, ticket)]);
      this.log(run.id, 'command', `Committed: ${commitMessage(wf, ticket)}`);

      await codeHost.pushBranch(run.worktree, run.branch);
      const pr = await codeHost.openPullRequest(project, {
        branch: run.branch,
        base: wf.base_branch,
        title: `${ticket.key}: ${ticket.title}`,
        body: pullRequestBody(ticket, summary, gateResults, wf),
        draft: wf.pull_request.draft,
      });
      this.log(run.id, 'info', pr.url ? `Opened pull request ${pr.url}` : `Branch ${run.branch} is ready for review in Maestro.`);

      await pm.moveTicket(ticket.key, 'in_review').catch((e) => this.log(run.id, 'error', `Could not move the ticket: ${e.message}`));
      await pm.comment(ticket.key, `Maestro: ${pr.url ? `pull request ${pr.url}` : `branch ${run.branch}`} is ready for review.`).catch(() => undefined);
      finish('in_review', 'available', { prUrl: pr.url });
    } catch (e) {
      const aborted = signal.aborted;
      const msg = aborted ? 'Stopped by you.' : e instanceof Error ? e.message : String(e);
      this.log(run.id, 'error', msg);
      finish(aborted ? 'stopped' : 'failed', 'available', { error: msg });
    }
  }

  private async resolveBase(repoPath: string, base: string): Promise<string> {
    for (const ref of [`origin/${base}`, base]) {
      if (await git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then(() => true, () => false)) return ref;
    }
    throw new Error(`Base branch "${base}" was not found in the repository.`);
  }

  private branchExists(repoPath: string, branch: string): Promise<boolean> {
    return git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
  }

  private setAgent(id: string, state: AgentState, runId: string | null, note: string): void {
    const a = this.d.store.updateAgent(id, { state, currentRunId: runId, note });
    if (a) bus.publish({ type: 'agent', agent: a });
  }

  private publishRun(run: Run): void {
    bus.publish({ type: 'run', run: this.d.store.getRun(run.id) ?? run });
  }

  private log(runId: string, kind: RunEventKind, message: string): void {
    bus.publish({ type: 'run_event', event: this.d.store.addEvent(runId, kind, message) });
  }

  /** Remove a finished run's worktree (the branch stays). */
  async cleanup(run: Run, project: Project): Promise<void> {
    if (this.active.has(run.id) || !existsSync(run.worktree)) return;
    const repoPath = await codeHostFor(project, this.d.secrets, this.d.reposDir).ensureRepo(project);
    await git(repoPath, ['worktree', 'remove', '--force', run.worktree]);
  }

  /** On startup, runs that were in flight when the engine stopped can't resume. */
  recover(): void {
    for (const run of this.d.store.listRuns().filter((r) => r.status === 'running')) {
      this.d.store.updateRun(run.id, { status: 'failed', error: 'Engine restarted during the run.', endedAt: new Date().toISOString() });
    }
    for (const a of this.d.store.listAgents()) {
      if (['working', 'running_checks', 'addressing_review'].includes(a.state)) this.d.store.updateAgent(a.id, { state: 'available', currentRunId: null, note: '' });
    }
  }
}
