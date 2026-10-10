import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { codeHostFor, missingCredentials, type CodeHostAdapter } from './adapters/codehost/index.js';
import { DESIGN_DIR, designContextFor } from './adapters/design/index.js';
import { docsContextFor } from './adapters/docs/index.js';
import { pmFor } from './adapters/pm/index.js';
import type { CodingAgent } from './agents/coding-agent.js';
import { fixPrompt, pullRequestBody, reviewFixPrompt, ticketPrompt, workerSystemPrompt } from './agents/prompts.js';
import { runReviewer } from './agents/reviewer.js';
import type { Store } from './db.js';
import { bus } from './events.js';
import { runGates, type GateResult } from './gates.js';
import { appendLearnings, extractLearnings, MEMORY_FILE, readMemoryFile, writeMemoryFile } from './memory.js';
import { git } from './proc.js';
import type { SecretStore } from './secrets.js';
import { budgetState, perRunCap, startOfToday, usd } from './budget.js';
import type { Agent, AgentState, AlertKind, Project, Review, ReviewComment, Run, RunEventKind, SpendKind, Ticket } from './types.js';
import { blockedBy, branchName, checkReady, commitMessage, parseWorkflow, ticketArea, type Workflow } from './workflow.js';

export interface OrchestratorDeps {
  store: Store;
  secrets: SecretStore;
  agent: CodingAgent;
  reposDir: string;
  worktreesDir: string;
  /** Override the code host, for tests. */
  codeHostFor?: (project: Project) => CodeHostAdapter;
  /** Override fetch for design and docs connectors, for tests. */
  fetch?: typeof fetch;
}

export class NotReadyError extends Error {
  constructor(readonly reasons: string[]) {
    super(`Ticket is not ready: ${reasons.join(' ')}`);
  }
}

/** What gets committed: everything except fetched design files. */
const CHANGE_PATHS = ['--', '.', `:(exclude)${DESIGN_DIR}`];
/** What counts as the worker having changed something: not the memory Maestro writes itself. */
const CODE_PATHS = [...CHANGE_PATHS, `:(exclude)${MEMORY_FILE}`];

const BASE_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'TodoWrite', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(ls:*)'];

interface RunCtx {
  runId: string;
  project: Project;
  wf: Workflow;
  ticket: Ticket;
  agent: Agent;
  worktree: string;
  repoPath: string;
  codeHost: CodeHostAdapter;
  pm: ReturnType<typeof pmFor>;
  signal: AbortSignal;
  env: Record<string, string>;
  /** Confluence pages for the project and ticket, as text. */
  docs: string | null;
  /** .maestro/memory.md as the worker starts. */
  memory: string;
}

export class Orchestrator {
  private readonly active = new Map<string, AbortController>();
  private ticking: Promise<Run[]> | null = null;
  private polling = false;
  private tickAgain = false;
  /** Starts between their checks and their run existing: counted so concurrent starts can't share a worker or a slot. */
  private readonly starting = new Set<string>();

  /** Runs working now plus starts being set up. */
  private busy(): number {
    return this.active.size + this.starting.size;
  }

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
    if (!this.d.codeHostFor) {
      const missing = missingCredentials(project, this.d.secrets);
      if (missing) throw new Error(missing);
    }
    const budget = budgetState(store, projectId);
    if (budget.over) throw new Error(`${project.name} has reached its daily budget of ${usd(budget.cap)}. Raise it on the Runs tab or wait until tomorrow.`);

    // From here to the reservation there is no await, so two starts can't both pass these checks.
    const startKey = `${projectId}:${ticket.key}`;
    if (this.busy() >= this.maxConcurrent()) throw new Error(`Already running ${this.busy()} tickets, the limit in Settings.`);
    if (this.starting.has(startKey) || store.listRuns(projectId).some((r) => r.ticketKey === ticket.key && ['running', 'reviewing'].includes(r.status))) {
      throw new Error(`${ticketKey} is already being worked on.`);
    }
    const agent = opts.agentId
      ? store.getAgent(opts.agentId)
      : store.listAgents().find((a) => a.role === 'worker' && a.state === 'available');
    if (!agent) throw new Error('No worker agent is available. Add one on the Agents screen or wait for one to finish.');
    if (agent.state !== 'available') throw new Error(`${agent.name} is ${agent.state.replace('_', ' ')}.`);
    this.starting.add(startKey);
    this.setAgent(agent.id, 'working', null, `Preparing ${ticket.key}`);
    try {
      return await this.setUpRun(project, wf, pm, ticket, agent);
    } catch (e) {
      this.setAgent(agent.id, 'available', null, '');
      throw e;
    } finally {
      this.starting.delete(startKey);
    }
  }

  private async setUpRun(project: Project, wf: Workflow, pm: ReturnType<typeof pmFor>, ticket: Ticket, agent: Agent): Promise<Run> {
    const { store } = this.d;
    const projectId = project.id;
    const codeHost = this.host(project);
    const repoPath = await codeHost.ensureRepo(project);
    if (wf.pull_before_start) await codeHost.syncBase(repoPath, wf.base_branch, project);
    const baseRef = await this.resolveBase(repoPath, wf.base_branch, project.codeHost.provider === 'local');

    let branch = branchName(wf.branch_pattern, ticket);
    if (await this.branchExists(repoPath, branch)) branch = `${branch}-${Date.now().toString(36)}`;

    const dir = join(this.d.worktreesDir, project.id);
    mkdirSync(dir, { recursive: true });
    const run = store.createRun({
      projectId, agentId: agent.id, ticketKey: ticket.key, ticketTitle: ticket.title, branch, worktree: '', area: ticketArea(ticket),
    });
    const worktree = join(dir, run.id);
    await git(repoPath, ['worktree', 'add', '-b', branch, worktree, baseRef]);
    Object.assign(run, store.updateRun(run.id, { worktree, baseRef }));

    this.publishRun(run);
    this.setAgent(agent.id, 'working', run.id, `On ${ticket.key}`);
    this.log(run.id, 'info', `${agent.name} picked up ${ticket.key} on branch ${branch} from ${baseRef}.`);
    this.launch(run.id, (signal) =>
      this.work({ runId: run.id, project, wf, ticket, agent, worktree, repoPath, codeHost, pm, signal, env: this.agentEnv(), docs: null, memory: '' }),
    );
    return run;
  }

  /** The board toggle (setting autoAssign.<projectId>) wins over the workflow's orchestration.auto_assign. */
  autoAssignEnabled(project: Project, wf: Workflow = parseWorkflow(project.workflowYaml)): boolean {
    const toggle = this.d.store.getSetting(`autoAssign.${project.id}`);
    return toggle === undefined ? wf.orchestration.auto_assign : toggle === 'true';
  }

  /**
   * Assigns ready, unblocked to-do tickets to free workers for every project with auto-assign on.
   * Never throws; overlapping calls run once more after the current pass instead of in parallel.
   */
  tick(): Promise<Run[]> {
    if (this.ticking) {
      this.tickAgain = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      const started: Run[] = [];
      do {
        this.tickAgain = false;
        let projects: Project[] = [];
        try {
          projects = this.d.store.listProjects();
        } catch (e) {
          console.error(`Auto-assign could not list projects: ${e instanceof Error ? e.message : String(e)}`);
        }
        for (const run of this.d.store.listRuns().filter((r) => r.status === 'in_review')) {
          try {
            await this.addressPending(run.id);
          } catch (e) {
            console.error(`Could not hand feedback on ${run.ticketKey} to a worker: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        for (const project of projects) {
          try {
            started.push(...(await this.assignReady(project)));
          } catch (e) {
            console.error(`Auto-assign for "${project.name}" failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } while (this.tickAgain);
      return started;
    })().finally(() => (this.ticking = null));
    return this.ticking;
  }

  private async assignReady(project: Project): Promise<Run[]> {
    const { store } = this.d;
    const wf = parseWorkflow(project.workflowYaml);
    if (!this.autoAssignEnabled(project, wf)) return [];
    const { max_parallel, one_per_area, dependency_ready_when } = wf.orchestration;
    const budget = budgetState(store, project.id);
    if (budget.over) {
      if (!store.hasAlertSince(project.id, 'budget', startOfToday())) {
        this.alert(project.id, null, 'budget', `${project.name} reached its daily budget of ${usd(budget.cap)}; auto-assign is paused until tomorrow.`);
      }
      return [];
    }

    const running = store.listRuns(project.id).filter((r) => r.status === 'running' || r.status === 'reviewing');
    let slots = Math.min(max_parallel - running.length, this.maxConcurrent() - this.busy(), this.freeWorkers());
    if (slots <= 0) return [];

    const tickets = await pmFor(project, store, this.d.secrets).listTickets();
    const blocked = blockedBy(tickets, store.dependencies(project.id), dependency_ready_when);
    const busyKeys = new Set(running.map((r) => r.ticketKey));
    const busyAreas = new Set(running.map((r) => r.area).filter(Boolean));
    const started: Run[] = [];

    for (const ticket of tickets) {
      if (slots <= 0) break;
      if (ticket.status !== 'todo' || busyKeys.has(ticket.key)) continue;
      if (checkReady(wf, ticket).length || blocked.get(ticket.key)?.length) continue;
      const area = ticketArea(ticket);
      if (one_per_area && area && busyAreas.has(area)) continue;
      try {
        started.push(await this.start(project.id, ticket.key));
        slots -= 1;
        if (area) busyAreas.add(area);
      } catch (e) {
        console.error(`Auto-assign could not start ${ticket.key}: ${e instanceof Error ? e.message : String(e)}`);
        if (this.freeWorkers() === 0 || this.busy() >= this.maxConcurrent()) break;
      }
    }
    return started;
  }

  private freeWorkers(): number {
    return this.d.store.listAgents().filter((a) => a.role === 'worker' && a.state === 'available').length;
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

  /** Runs `fn` as the run's background work, so it counts toward the limit and can be stopped. */
  private launch(runId: string, fn: (signal: AbortSignal) => Promise<void>): void {
    const controller = new AbortController();
    this.active.set(runId, controller);
    void fn(controller.signal).finally(() => {
      this.active.delete(runId);
      void this.tick();
    });
  }

  private async work(ctx: RunCtx): Promise<void> {
    const { project, wf, ticket, codeHost, pm } = ctx;
    const { store } = this.d;
    try {
      await pm.moveTicket(ticket.key, 'in_progress').catch((e) => this.log(ctx.runId, 'error', `Could not move the ticket: ${e.message}`));
      const design = await designContextFor(project, ticket, ctx.worktree, this.d.secrets, this.d.fetch).catch((e) => {
        this.log(ctx.runId, 'error', `No design context: ${e.message}`);
        return null;
      });
      if (design) this.log(ctx.runId, 'info', `Design context from Figma is in ${DESIGN_DIR}/.`);
      ctx.docs = await this.docsFor(ctx);
      const memoryEdited = this.applyPendingMemory(ctx);
      ctx.memory = readMemoryFile(ctx.worktree);
      const done = await this.implement(ctx, ticketPrompt(ticket, design), false);
      if (!done) return;

      if (!(await this.hasChanges(ctx))) {
        this.block(ctx, 'The agent finished without changing any files.', `Blocked on ${ticket.key}: no changes`);
        return;
      }
      done.summary = this.recordLearnings(ctx, done.summary);
      await this.commit(ctx, commitMessage(wf, ticket));
      if (memoryEdited) store.deleteSetting(`memory.${project.id}`);
      await this.publish(ctx, done.summary, done.gates);
      await this.reviewLoop(ctx);
    } catch (e) {
      this.fail(ctx, e);
    }
  }

  /** Pushes the branch, opens the pull request (or leaves the branch for review in Maestro) and moves the ticket to review. */
  private async publish(ctx: RunCtx, summary: string, gates: GateResult[]): Promise<void> {
    const { project, wf, ticket, codeHost, pm } = ctx;
    const run = this.run(ctx);
    await codeHost.pushBranch(ctx.worktree, run.branch, project);
    const pr = await codeHost.openPullRequest(project, {
      branch: run.branch,
      base: wf.base_branch,
      title: `${ticket.key}: ${ticket.title}`,
      body: pullRequestBody(ticket, summary, gates, wf),
      draft: wf.pull_request.draft,
    });
    this.d.store.updateRun(ctx.runId, { prUrl: pr.url, prNumber: pr.number, readyAt: new Date().toISOString() });
    this.log(ctx.runId, 'info', pr.url ? `Opened pull request ${pr.url}` : `Branch ${run.branch} is ready for review in Maestro.`);
    await pm.moveTicket(ticket.key, 'in_review').catch((e) => this.log(ctx.runId, 'error', `Could not move the ticket: ${e.message}`));
    await pm.comment(ticket.key, `Maestro: ${pr.url ? `pull request ${pr.url}` : `branch ${run.branch}`} is ready for review.`).catch(() => undefined);
  }

  /**
   * Has the worker carry out `prompt`, then runs the quality gates and asks for fixes until they pass.
   * Returns null when the run was blocked because the gates kept failing.
   */
  private async implement(ctx: RunCtx, firstPrompt: string, addressing: boolean): Promise<{ summary: string; gates: GateResult[] } | null> {
    const { project, wf, ticket, agent, signal } = ctx;
    const { store } = this.d;
    const tools = [
      ...BASE_TOOLS,
      ...wf.quality_gates.map((g) => `Bash(${g.run}:*)`),
      ...wf.allowed_commands.map((c) => `Bash(${c}:*)`),
    ];
    let prompt = firstPrompt;
    let tries = 0;
    let summary = '';

    for (;;) {
      const over = this.budgetStop(ctx);
      if (over) {
        this.block(ctx, over, `Budget reached on ${ticket.key}`, 'budget');
        return null;
      }
      const what = addressing ? 'Addressing review on' : tries === 0 ? 'On' : 'Fixing';
      this.setAgent(agent.id, addressing ? 'addressing_review' : 'working', ctx.runId, `${what} ${ticket.key}${tries ? `, try ${tries}` : ''}`);
      const outcome = await this.d.agent.run({
        cwd: ctx.worktree,
        prompt,
        systemPrompt: workerSystemPrompt(project, wf, { docs: ctx.docs, memory: ctx.memory }),
        model: this.workerModel(agent),
        allowedTools: tools,
        resume: this.run(ctx).sessionId ?? undefined,
        env: ctx.env,
        signal,
        maxBudgetUsd: this.budgetLeft(ctx),
        onMessage: (m) => this.log(ctx.runId, m.kind === 'tool' ? 'tool' : 'agent', m.text),
      });
      this.addCost(ctx, outcome.costUsd);
      if (signal.aborted) throw new Error('aborted');
      if (outcome.sessionId) store.updateRun(ctx.runId, { sessionId: outcome.sessionId });
      // Hitting a limit is recoverable (raise the budget, or give guidance and it continues), so it blocks rather than fails.
      if (!outcome.ok && /error_max_budget_usd/.test(outcome.error ?? '')) {
        this.block(ctx, this.budgetStop(ctx) ?? 'The agent stopped at its budget for this step.', `Budget reached on ${ticket.key}`, 'budget');
        return null;
      }
      if (!outcome.ok && /error_max_turns/.test(outcome.error ?? '')) {
        this.block(ctx, 'The agent used all its turns before finishing. Give it guidance to continue.', `Out of turns on ${ticket.key}`);
        return null;
      }
      if (!outcome.ok) throw new Error(outcome.error ?? 'The agent stopped without finishing.');
      summary = outcome.text || summary;

      this.setAgent(agent.id, 'running_checks', ctx.runId, `Checking ${ticket.key}`);
      this.log(ctx.runId, 'info', 'Running quality gates.');
      const gates = await runGates(wf, ctx.worktree, (g) =>
        this.log(ctx.runId, 'gate', `${g.passed ? 'PASS' : 'FAIL'} ${g.name} (${Math.round(g.durationMs / 1000)}s): ${g.command}${g.passed ? '' : `\n${g.output}`}`),
        signal,
      );
      if (signal.aborted) throw new Error('aborted');
      if (gates.passed) return { summary, gates: gates.results };

      tries += 1;
      store.updateRun(ctx.runId, { attempts: this.run(ctx).attempts + 1 });
      const failed = gates.results.at(-1)!;
      if (tries > wf.max_fix_attempts) {
        this.block(ctx, `"${failed.name}" still fails after ${wf.max_fix_attempts} fix attempts.`, `Blocked on ${ticket.key}: ${failed.name} fails`);
        return null;
      }
      prompt = fixPrompt(failed, tries, wf.max_fix_attempts);
    }
  }

  private async hasChanges(ctx: RunCtx): Promise<boolean> {
    return !!(await git(ctx.worktree, ['status', '--porcelain', ...CODE_PATHS]));
  }

  /** Puts your pending memory edit into the worktree, so it is committed with this ticket. */
  private applyPendingMemory(ctx: RunCtx): boolean {
    const pending = this.d.store.getSetting(`memory.${ctx.project.id}`);
    if (pending === undefined) return false;
    writeMemoryFile(ctx.worktree, pending);
    this.log(ctx.runId, 'info', `Your edit to ${MEMORY_FILE} goes into this ticket's commit.`);
    return true;
  }

  /** Takes the Learnings section off the worker's reply and adds it to the memory file. */
  private recordLearnings(ctx: RunCtx, reply: string): string {
    const { summary, learnings } = extractLearnings(reply);
    if (learnings.length) {
      const before = readMemoryFile(ctx.worktree);
      const after = appendLearnings(before, ctx.ticket.key, learnings);
      if (after !== before) {
        writeMemoryFile(ctx.worktree, after);
        this.log(ctx.runId, 'info', `Added to ${MEMORY_FILE}:\n${learnings.map((l) => `- ${l}`).join('\n')}`);
      }
    }
    return summary;
  }

  private async commit(ctx: RunCtx, message: string): Promise<void> {
    await git(ctx.worktree, ['add', '-A', ...CHANGE_PATHS]);
    const identity = (await git(ctx.worktree, ['config', 'user.email']).catch(() => ''))
      ? []
      : ['-c', 'user.name=Maestro', '-c', 'user.email=maestro@localhost'];
    await git(ctx.worktree, [...identity, 'commit', '-m', message]);
    this.log(ctx.runId, 'command', `Committed: ${message}`);
  }

  /** The reviewer agent reviews; on changes the worker fixes and it reviews again, up to review.max_rounds. */
  private async reviewLoop(ctx: RunCtx): Promise<void> {
    const { project, wf, ticket, agent, codeHost, signal } = ctx;
    const { store } = this.d;
    if (!wf.review.enabled) return this.toInReview(ctx);

    for (let round = 1; ; round++) {
      const over = this.budgetStop(ctx);
      if (over) {
        this.log(ctx.runId, 'info', `${over} Skipping the reviewer agent; this waits for your review.`);
        return this.toInReview(ctx);
      }
      this.publishRun(store.updateRun(ctx.runId, { status: 'reviewing' })!);
      this.setAgent(agent.id, 'waiting_review', ctx.runId, `Waiting for review of ${ticket.key}`);
      this.log(ctx.runId, 'info', 'The reviewer agent is reviewing the change.');

      let result: Awaited<ReturnType<typeof runReviewer>>;
      try {
        result = await runReviewer(
          this.d.agent,
          {
            cwd: ctx.worktree, model: store.getSetting('model.reviewer') || 'claude-opus-5-5', env: ctx.env, signal, maxBudgetUsd: this.budgetLeft(ctx),
            onMessage: (m) => m.kind === 'agent' && this.log(ctx.runId, 'agent', `Reviewer: ${m.text}`),
          },
          project, wf, ticket, this.run(ctx).baseRef ?? wf.base_branch, readMemoryFile(ctx.worktree), store.listReviews(ctx.runId),
        );
      } catch (e) {
        if (signal.aborted) throw e;
        this.addCost(ctx, (e as { costUsd?: number }).costUsd ?? 0, 'reviewer');
        this.log(ctx.runId, 'error', `The reviewer agent failed, so this waits for your review: ${(e as Error).message}`);
        return this.toInReview(ctx);
      }
      this.addCost(ctx, result.costUsd, 'reviewer');
      const review = store.addReview({
        runId: ctx.runId, source: 'agent', verdict: result.verdict, summary: result.summary, comments: result.comments,
        costUsd: result.costUsd, addressed: result.verdict === 'approve',
      });
      this.publishReview(review);
      this.log(ctx.runId, 'info', `Reviewer: ${result.verdict === 'approve' ? 'approved' : `requested ${result.comments.length || ''} changes`.replace('  ', ' ')}. ${result.summary}`);
      await this.postReview(ctx, review);

      if (result.verdict === 'approve') return this.toInReview(ctx);
      store.updateRun(ctx.runId, { reviewRounds: this.run(ctx).reviewRounds + 1 });
      if (round > wf.review.max_rounds) {
        this.block(ctx, `The reviewer still requests changes after ${wf.review.max_rounds} review rounds.`, `Blocked on ${ticket.key}: review not passing`);
        return;
      }
      if (!(await this.addressFeedback(ctx, [review]))) return;
    }
  }

  /** The worker fixes the feedback in the same worktree and session, then commits and pushes to the same branch. */
  private async addressFeedback(ctx: RunCtx, feedback: Review[]): Promise<boolean> {
    const { store } = this.d;
    this.publishRun(store.updateRun(ctx.runId, { status: 'running', endedAt: null })!);
    const done = await this.implement(ctx, reviewFixPrompt(feedback), true);
    if (!done) return false;
    done.summary = this.recordLearnings(ctx, done.summary);
    store.markReviewsAddressed(feedback.map((f) => f.id));
    if (!this.run(ctx).readyAt) {
      // Blocked before its first review: this is the ticket's first commit and the change still has to be published.
      if (!(await this.hasChanges(ctx))) {
        this.block(ctx, 'The worker still changed no files.', `Blocked on ${ctx.ticket.key}: no changes`);
        return false;
      }
      await this.commit(ctx, commitMessage(ctx.wf, ctx.ticket));
      await this.publish(ctx, done.summary, done.gates);
    } else if (await git(ctx.worktree, ['status', '--porcelain', ...CHANGE_PATHS])) {
      await this.commit(ctx, ctx.wf.commit_convention === 'conventional'
        ? `fix: address review feedback [${ctx.ticket.key}]`
        : `Address review feedback [${ctx.ticket.key}]`);
      await ctx.codeHost.pushBranch(ctx.worktree, this.run(ctx).branch, ctx.project);
    } else {
      this.log(ctx.runId, 'info', 'The worker changed no files for this feedback; see its reply above.');
    }
    if (done.summary) this.log(ctx.runId, 'info', `Worker on the feedback: ${done.summary}`);
    return true;
  }

  private async postReview(ctx: RunCtx, review: Review): Promise<void> {
    const prNumber = this.run(ctx).prNumber;
    if (!prNumber || !ctx.codeHost.postReview) return;
    try {
      const commitSha = await git(ctx.worktree, ['rev-parse', 'HEAD']);
      const posted = await ctx.codeHost.postReview(ctx.project, prNumber, { verdict: review.verdict, summary: review.summary, comments: review.comments, commitSha });
      this.log(ctx.runId, 'info', `Posted the review on the pull request.${posted.note ? ` ${posted.note}` : ''}`);
    } catch (e) {
      this.log(ctx.runId, 'error', `Could not post the review on the pull request: ${(e as Error).message}`);
    }
  }

  /** Waiting for you (or the PR). The worker is free for other tickets meanwhile. */
  private toInReview(ctx: RunCtx): void {
    const run = this.d.store.updateRun(ctx.runId, { status: 'in_review', endedAt: new Date().toISOString() })!;
    this.publishRun(run);
    this.setAgent(ctx.agent.id, 'available', null, '');
    this.alert(ctx.project.id, ctx.runId, 'ready', `${ctx.ticket.key} is ready for your review${run.prUrl ? ` (${run.prUrl})` : ''}.`);
  }

  private block(ctx: RunCtx, msg: string, note: string, kind: AlertKind = 'blocked'): void {
    this.alert(ctx.project.id, ctx.runId, kind, `${ctx.ticket.key} is blocked: ${msg}`);
    this.log(ctx.runId, 'error', msg);
    void ctx.pm.comment(ctx.ticket.key, `Maestro: ${msg} The branch ${this.run(ctx).branch} has the work so far.`).catch(() => undefined);
    this.publishRun(this.d.store.updateRun(ctx.runId, { status: 'blocked', error: msg, endedAt: new Date().toISOString() })!);
    this.setAgent(ctx.agent.id, 'blocked', ctx.runId, note);
  }

  private fail(ctx: RunCtx, e: unknown): void {
    const aborted = ctx.signal.aborted;
    const msg = aborted ? 'Stopped by you.' : e instanceof Error ? e.message : String(e);
    this.log(ctx.runId, 'error', msg);
    if (!aborted) this.alert(ctx.project.id, ctx.runId, 'failed', `${ctx.ticket.key} failed: ${msg}`);
    this.publishRun(this.d.store.updateRun(ctx.runId, { status: aborted ? 'stopped' : 'failed', error: msg, endedAt: new Date().toISOString() })!);
    this.setAgent(ctx.agent.id, 'available', null, '');
  }

  private run(ctx: RunCtx): Run {
    return this.d.store.getRun(ctx.runId)!;
  }

  private addCost(ctx: RunCtx, amount: number, kind: SpendKind = 'worker'): void {
    if (!amount) return;
    this.d.store.updateRun(ctx.runId, { costUsd: this.run(ctx).costUsd + amount });
    this.d.store.addSpend(ctx.project.id, ctx.runId, kind, amount);
  }

  /** Why the run must not spend more, or null. */
  private budgetStop(ctx: RunCtx): string | null {
    const perRun = perRunCap(this.d.store);
    const spent = this.run(ctx).costUsd;
    if (perRun > 0 && spent >= perRun) return `This run reached its budget of ${usd(perRun)} (Settings).`;
    const daily = budgetState(this.d.store, ctx.project.id);
    if (daily.over) return `${ctx.project.name} reached its daily budget of ${usd(daily.cap)}.`;
    return null;
  }

  /** What the next agent call may spend: the smaller of what is left for the run and for the project today. */
  private budgetLeft(ctx: RunCtx): number | undefined {
    const perRun = perRunCap(this.d.store);
    const left = Math.min(perRun > 0 ? perRun - this.run(ctx).costUsd : Infinity, budgetState(this.d.store, ctx.project.id).remaining);
    return Number.isFinite(left) ? Math.max(0.01, left) : undefined;
  }

  private alert(projectId: string | null, runId: string | null, kind: AlertKind, message: string): void {
    bus.publish({ type: 'alert', alert: this.d.store.addAlert({ projectId, runId, kind, message }) });
  }

  /** Builds what a run needs from the stored run, for work that resumes after the run first went to review. */
  private async contextFor(run: Run, agent: Agent, signal: AbortSignal): Promise<RunCtx> {
    const { store } = this.d;
    const project = store.getProject(run.projectId);
    if (!project) throw new Error('Project not found.');
    const wf = parseWorkflow(project.workflowYaml);
    const pm = pmFor(project, store, this.d.secrets);
    const ticket = (await pm.getTicket(run.ticketKey).catch(() => undefined)) ?? {
      key: run.ticketKey, title: run.ticketTitle, description: '', acceptanceCriteria: '', status: 'in_review' as const, labels: [],
    };
    const codeHost = this.host(project);
    const repoPath = await codeHost.ensureRepo(project);
    if (!existsSync(run.worktree)) {
      await git(repoPath, ['worktree', 'prune']);
      await git(repoPath, ['worktree', 'add', run.worktree, run.branch]);
    }
    const ctx: RunCtx = {
      runId: run.id, project, wf, ticket, agent, worktree: run.worktree, repoPath, codeHost, pm, signal, env: this.agentEnv(), docs: null,
      memory: readMemoryFile(run.worktree),
    };
    ctx.docs = await this.docsFor(ctx);
    return ctx;
  }

  private async docsFor(ctx: RunCtx): Promise<string | null> {
    const docs = await docsContextFor(ctx.project, this.d.secrets, `${ctx.ticket.description}\n${ctx.ticket.acceptanceCriteria}`, this.d.fetch).catch((e) => {
      this.log(ctx.runId, 'error', `No Confluence docs: ${e.message}`);
      return null;
    });
    if (docs) this.log(ctx.runId, 'info', 'Added the Confluence docs to the worker\'s context.');
    return docs;
  }

  private host(project: Project): CodeHostAdapter {
    return this.d.codeHostFor?.(project) ?? codeHostFor(project, this.d.secrets, this.d.reposDir);
  }

  private agentEnv(): Record<string, string> {
    const key = this.d.secrets.get('ANTHROPIC_API_KEY');
    return key ? { ANTHROPIC_API_KEY: key } : {};
  }

  /** Hands feedback from you or the PR to a worker: the run's own worker if it is free, otherwise any free one. */
  async addressPending(runId: string): Promise<boolean> {
    const { store } = this.d;
    const run = store.getRun(runId);
    if (!run || run.status !== 'in_review' || this.active.has(runId)) return false;
    const pending = store.pendingFeedback(runId);
    if (!pending.length || this.busy() >= this.maxConcurrent()) return false;
    const workers = store.listAgents().filter((a) => a.role === 'worker' && a.state === 'available');
    const agent = workers.find((a) => a.id === run.agentId) ?? workers[0];
    if (!agent) return false;

    if (agent.id !== run.agentId) store.updateRun(runId, { agentId: agent.id });
    this.setAgent(agent.id, 'addressing_review', runId, `Addressing review on ${run.ticketKey}`);
    this.launch(runId, async (signal) => {
      let ctx: RunCtx | undefined;
      try {
        ctx = await this.contextFor(run, agent, signal);
        const who = [...new Set(pending.map((p) => p.author ?? (p.source === 'human' ? 'you' : 'a reviewer')))].join(', ');
        this.log(runId, 'info', `${agent.name} is addressing feedback from ${who}.`);
        if (await this.addressFeedback(ctx, pending)) await this.reviewLoop(ctx);
      } catch (e) {
        if (ctx) this.fail(ctx, e);
        else {
          this.log(runId, 'error', (e as Error).message);
          this.setAgent(agent.id, 'available', null, '');
        }
      }
    });
    return true;
  }

  /** Approved by you or merged: the ticket is done and the worktree goes (the branch stays). */
  async complete(runId: string, how: 'approved' | 'merged'): Promise<Run> {
    const { store } = this.d;
    const run = store.getRun(runId);
    if (!run) throw new Error('Run not found.');
    if (this.active.has(runId)) throw new Error('This run is still working; stop it first.');
    if (!['in_review', 'blocked'].includes(run.status)) throw new Error(`A run that is ${run.status.replace('_', ' ')} can't be completed.`);
    const project = store.getProject(run.projectId);
    if (!project) throw new Error('Project not found.');
    const pm = pmFor(project, store, this.d.secrets);
    await pm.moveTicket(run.ticketKey, 'done').catch((e) => this.log(runId, 'error', `Could not move the ticket: ${e.message}`));
    await pm.comment(run.ticketKey, `Maestro: ${how === 'merged' ? 'the pull request was merged' : 'approved'}; done.`).catch(() => undefined);
    store.markReviewsAddressed(store.pendingFeedback(runId).map((r) => r.id));
    const updated = store.updateRun(runId, { status: 'done', error: null, endedAt: new Date().toISOString() })!;
    this.publishRun(updated);
    const agent = store.getAgent(run.agentId);
    if (agent?.currentRunId === runId) this.setAgent(agent.id, 'available', null, '');
    this.log(runId, 'info', how === 'merged' ? 'The pull request was merged. Ticket done.' : 'Approved by you. Ticket done.');
    await this.cleanup(updated, project).catch(() => undefined);
    return updated;
  }

  /**
   * Local folders only: merges the run's branch into the base branch, then finishes the run.
   * With the base checked out it merges only into a clean working tree and aborts on conflicts;
   * otherwise it moves the base forward only when that is a fast-forward. Your files are never left half-merged.
   */
  async mergeLocal(runId: string): Promise<Run> {
    const { store } = this.d;
    const run = store.getRun(runId);
    if (!run) throw new Error('Run not found.');
    const project = store.getProject(run.projectId);
    if (!project) throw new Error('Project not found.');
    if (project.codeHost.provider !== 'local') throw new Error('Merge the pull request on the code host; Maestro finishes the ticket when it sees the merge.');
    if (this.active.has(runId) || run.status !== 'in_review') throw new Error('Only a run that is waiting for review can be merged.');
    const base = parseWorkflow(project.workflowYaml).base_branch;
    const repoPath = await this.host(project).ensureRepo(project);
    const current = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (current === base) {
      if (await git(repoPath, ['status', '--porcelain', '--untracked-files=no'])) {
        throw new Error(`${base} has uncommitted changes in ${repoPath}; commit or stash them, then merge again.`);
      }
      const identity = (await git(repoPath, ['config', 'user.email']).catch(() => '')) ? [] : ['-c', 'user.name=Maestro', '-c', 'user.email=maestro@localhost'];
      try {
        await git(repoPath, [...identity, 'merge', '--no-ff', '-m', `Merge ${run.ticketKey}: ${run.ticketTitle}`, run.branch]);
      } catch (e) {
        await git(repoPath, ['merge', '--abort']).catch(() => undefined);
        throw new Error(`The branch does not merge cleanly into ${base}; merge it yourself. ${(e as Error).message.split('\n').slice(-1)[0]}`);
      }
    } else {
      try {
        await git(repoPath, ['fetch', '.', `${run.branch}:${base}`]);
      } catch {
        throw new Error(`${base} has moved on since this branch started and is not checked out here; merge ${run.branch} yourself.`);
      }
    }
    this.log(runId, 'info', `Merged ${run.branch} into ${base}.`);
    return this.complete(runId, 'merged');
  }

  /** Your review in Maestro: approve completes the run; changes requested go to a worker. */
  async humanReview(runId: string, input: { verdict: 'approve' | 'changes_requested'; summary: string; comments: ReviewComment[] }): Promise<Review> {
    const { store } = this.d;
    const run = store.getRun(runId);
    if (!run) throw new Error('Run not found.');
    if (this.active.has(runId) || !['in_review', 'blocked'].includes(run.status)) {
      throw new Error('Only a run that is waiting for review or blocked can be reviewed.');
    }
    const review = store.addReview({ runId, source: 'human', ...input, author: 'you', addressed: input.verdict === 'approve' });
    this.publishReview(review);
    if (input.verdict === 'approve') {
      await this.complete(runId, 'approved');
      return review;
    }
    if (run.status === 'blocked') this.unblock(run, 'You gave the worker guidance; it picks the run up again.');
    void this.tick();
    return review;
  }

  /** New feedback on a blocked run sends it back to a worker. */
  private unblock(run: Run, message: string): void {
    const { store } = this.d;
    this.publishRun(store.updateRun(run.id, { status: 'in_review', error: null })!);
    const agent = store.getAgent(run.agentId);
    if (agent?.state === 'blocked' && agent.currentRunId === run.id) this.setAgent(agent.id, 'available', null, '');
    this.log(run.id, 'info', message);
  }

  /** Checks open PRs for merges, closes, CI status and new feedback. Never throws. */
  async pollPullRequests(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const { store } = this.d;
    try {
      // Blocked runs too: you may merge, close or comment on their PR to get them moving.
      for (const run of store.listRuns().filter((r) => ['in_review', 'blocked'].includes(r.status) && r.prNumber && !this.active.has(r.id))) {
        try {
          const project = store.getProject(run.projectId);
          if (!project || !parseWorkflow(project.workflowYaml).review.poll_pull_requests) continue;
          const codeHost = this.host(project);
          if (!codeHost.pullRequestStatus) continue;
          const status = await codeHost.pullRequestStatus(project, run.prNumber!);
          if (status.checks !== run.checks) this.publishRun(store.updateRun(run.id, { checks: status.checks })!);
          if (status.state === 'merged') {
            await this.complete(run.id, 'merged');
            continue;
          }
          if (status.state === 'closed') {
            this.log(run.id, 'info', 'The pull request was closed without merging.');
            this.publishRun(store.updateRun(run.id, { status: 'stopped', error: 'Pull request closed without merging.' })!);
            continue;
          }
          for (const f of status.feedback) {
            if (store.hasExternalReview(run.id, f.externalId)) continue;
            const review = store.addReview({
              runId: run.id, source: 'github', verdict: f.verdict, author: f.author, externalId: f.externalId,
              summary: f.file ? '' : f.body, comments: f.file ? [{ file: f.file, line: f.line, body: f.body }] : [],
              addressed: f.verdict !== 'changes_requested',
            });
            this.publishReview(review);
            this.log(run.id, 'info', `New ${f.verdict === 'changes_requested' ? 'change request' : 'review'} from ${f.author} on the pull request.`);
          }
          if (run.status === 'blocked' && store.pendingFeedback(run.id).length) {
            this.unblock(run, 'A change request on the pull request sends the run back to a worker.');
          }
        } catch (e) {
          console.error(`Polling the pull request of ${run.ticketKey} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } finally {
      this.polling = false;
    }
    await this.tick();
  }

  /** A local folder's own branch is the truth (you may have unpushed commits); a clone follows its remote. */
  private async resolveBase(repoPath: string, base: string, preferLocal: boolean): Promise<string> {
    for (const ref of preferLocal ? [base, `origin/${base}`] : [`origin/${base}`, base]) {
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

  private publishReview(review: Review): void {
    bus.publish({ type: 'review', review });
  }

  private log(runId: string, kind: RunEventKind, message: string): void {
    bus.publish({ type: 'run_event', event: this.d.store.addEvent(runId, kind, message) });
  }

  /** Remove a finished run's worktree (the branch stays). */
  async cleanup(run: Run, project: Project): Promise<void> {
    if (this.active.has(run.id) || !existsSync(run.worktree)) return;
    const repoPath = await this.host(project).ensureRepo(project);
    await git(repoPath, ['worktree', 'remove', '--force', run.worktree]);
  }

  /**
   * Removes the worktrees of finished runs (failed, stopped, done) that ended more than `days` ago, or all of them with 0.
   * Branches stay. Returns how many were removed.
   */
  async cleanupFinished(days = Number(this.d.store.getSetting('worktrees.keepDays') ?? 3), projectId?: string): Promise<number> {
    const { store } = this.d;
    if (days < 0) return 0;
    const before = Date.now() - days * 86_400_000;
    let removed = 0;
    for (const run of store.listAllRuns(projectId)) {
      if (!['failed', 'stopped', 'done'].includes(run.status) || !run.worktree || !existsSync(run.worktree)) continue;
      if (run.endedAt && new Date(run.endedAt).getTime() > before) continue;
      const project = store.getProject(run.projectId);
      if (!project) continue;
      try {
        await this.cleanup(run, project);
        removed += 1;
      } catch (e) {
        console.error(`Could not remove the worktree of ${run.ticketKey}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return removed;
  }

  /** On startup, runs that were in flight when the engine stopped can't resume. */
  recover(): void {
    for (const run of this.d.store.listAllRuns().filter((r) => r.status === 'running')) {
      if (run.readyAt) {
        // It was addressing feedback on a published change: the change stands, and the feedback is still pending, so it is picked up again.
        this.d.store.updateRun(run.id, { status: 'in_review' });
        this.log(run.id, 'info', 'The engine restarted while a worker was addressing feedback; it will be picked up again.');
      } else {
        this.d.store.updateRun(run.id, { status: 'failed', error: 'Engine restarted during the run.', endedAt: new Date().toISOString() });
      }
    }
    for (const run of this.d.store.listRuns().filter((r) => r.status === 'reviewing')) {
      this.d.store.updateRun(run.id, { status: 'in_review' });
      this.log(run.id, 'info', 'The engine restarted during the review; this now waits for your review.');
    }
    for (const a of this.d.store.listAgents()) {
      if (['working', 'running_checks', 'addressing_review', 'waiting_review'].includes(a.state)) this.d.store.updateAgent(a.id, { state: 'available', currentRunId: null, note: '' });
    }
  }
}
