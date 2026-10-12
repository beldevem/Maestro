import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Agent, Alert, AlertKind, BacklogDraft, ChatActionStatus, ChatMessage, StoredChatAction, BacklogItem, Project, Review, Run, RunEvent, RunEventKind, SpendKind, Ticket } from './types.js';
import { DEFAULT_WORKFLOW_YAML } from './workflow.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  code_host TEXT NOT NULL, pm TEXT NOT NULL, design TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '', requirements TEXT NOT NULL DEFAULT '', best_practices TEXT NOT NULL DEFAULT '',
  workflow_yaml TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'available', current_run_id TEXT, note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_id TEXT NOT NULL, ticket_key TEXT NOT NULL,
  ticket_title TEXT NOT NULL, branch TEXT NOT NULL, worktree TEXT NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, pr_url TEXT, error TEXT,
  started_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, ts TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id);
CREATE TABLE IF NOT EXISTS manual_tickets (
  project_id TEXT NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'todo', size TEXT,
  labels TEXT NOT NULL DEFAULT '[]', seq INTEGER NOT NULL, PRIMARY KEY (project_id, key)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS backlog_drafts (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', items TEXT NOT NULL,
  created_keys TEXT NOT NULL DEFAULT '[]', error TEXT, cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, approved_at TEXT
);
CREATE INDEX IF NOT EXISTS backlog_drafts_project ON backlog_drafts(project_id);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, source TEXT NOT NULL, verdict TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
  comments TEXT NOT NULL DEFAULT '[]', author TEXT, external_id TEXT, addressed INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_run ON reviews(run_id);
CREATE TABLE IF NOT EXISTS spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, run_id TEXT, kind TEXT NOT NULL, usd REAL NOT NULL, ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS spend_project_ts ON spend(project_id, ts);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, run_id TEXT, kind TEXT NOT NULL, message TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_project ON chat_messages(project_id);
CREATE TABLE IF NOT EXISTS chat_actions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, message_id INTEGER NOT NULL, type TEXT NOT NULL, summary TEXT NOT NULL,
  action TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result TEXT, run_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_deps (
  project_id TEXT NOT NULL, ticket_key TEXT NOT NULL, depends_on_key TEXT NOT NULL,
  PRIMARY KEY (project_id, ticket_key, depends_on_key)
);
`;

/** Columns added after the first release, for databases created before them. */
const COLUMNS: { table: string; column: string; ddl: string }[] = [
  { table: 'projects', column: 'docs', ddl: `ALTER TABLE projects ADD COLUMN docs TEXT NOT NULL DEFAULT '{"provider":"none","settings":{}}'` },
  { table: 'runs', column: 'area', ddl: 'ALTER TABLE runs ADD COLUMN area TEXT' },
  { table: 'runs', column: 'session_id', ddl: 'ALTER TABLE runs ADD COLUMN session_id TEXT' },
  { table: 'runs', column: 'base_ref', ddl: 'ALTER TABLE runs ADD COLUMN base_ref TEXT' },
  { table: 'runs', column: 'pr_number', ddl: 'ALTER TABLE runs ADD COLUMN pr_number INTEGER' },
  { table: 'runs', column: 'review_rounds', ddl: 'ALTER TABLE runs ADD COLUMN review_rounds INTEGER NOT NULL DEFAULT 0' },
  { table: 'runs', column: 'checks', ddl: 'ALTER TABLE runs ADD COLUMN checks TEXT' },
  { table: 'runs', column: 'ready_at', ddl: 'ALTER TABLE runs ADD COLUMN ready_at TEXT' },
];

type Row = Record<string, any>;
const now = () => new Date().toISOString();

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    // Project data is yours alone: the database starts as 600, and SQLite gives its -wal and -shm files the same mode.
    if (!existsSync(file)) writeFileSync(file, '', { mode: 0o600 });
    for (const f of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    for (const c of COLUMNS) {
      const cols = this.db.prepare(`PRAGMA table_info(${c.table})`).all() as Row[];
      if (!cols.some((r) => r.name === c.column)) this.db.exec(c.ddl);
    }
  }

  // Projects
  listProjects(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Row[]).map(toProject);
  }
  getProject(id: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return row ? toProject(row) : undefined;
  }
  createProject(input: Omit<Project, 'id' | 'createdAt' | 'workflowYaml' | 'docs'> & { workflowYaml?: string; docs?: Project['docs'] }): Project {
    const p: Project = {
      ...input, docs: input.docs ?? { provider: 'none', settings: {} }, workflowYaml: input.workflowYaml || DEFAULT_WORKFLOW_YAML,
      id: randomUUID(), createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO projects (id, name, description, code_host, pm, design, docs, context, requirements, best_practices, workflow_yaml, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.name, p.description, JSON.stringify(p.codeHost), JSON.stringify(p.pm), JSON.stringify(p.design), JSON.stringify(p.docs),
        p.context, p.requirements, p.bestPractices, p.workflowYaml, p.createdAt);
    return p;
  }
  updateProject(id: string, patch: Partial<Omit<Project, 'id' | 'createdAt'>>): Project | undefined {
    const current = this.getProject(id);
    if (!current) return undefined;
    const p = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE projects SET name = ?, description = ?, code_host = ?, pm = ?, design = ?, docs = ?, context = ?, requirements = ?,
         best_practices = ?, workflow_yaml = ? WHERE id = ?`,
      )
      .run(p.name, p.description, JSON.stringify(p.codeHost), JSON.stringify(p.pm), JSON.stringify(p.design), JSON.stringify(p.docs),
        p.context, p.requirements, p.bestPractices, p.workflowYaml, id);
    return p;
  }
  /** Removes the project and everything Maestro recorded for it (the repository and PM tool are not touched). */
  deleteProject(id: string): void {
    this.db.prepare('DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)').run(id);
    this.db.prepare('DELETE FROM reviews WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)').run(id);
    this.db.prepare('DELETE FROM runs WHERE project_id = ?').run(id);
    this.db.prepare('DELETE FROM alerts WHERE project_id = ?').run(id);
    this.db.prepare('DELETE FROM spend WHERE project_id = ?').run(id);
    this.clearChat(id);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM manual_tickets WHERE project_id = ?').run(id);
    this.db.prepare('DELETE FROM backlog_drafts WHERE project_id = ?').run(id);
    this.db.prepare('DELETE FROM ticket_deps WHERE project_id = ?').run(id);
    this.db.prepare("DELETE FROM settings WHERE key LIKE '%.' || ?").run(id);
  }

  // Agents
  listAgents(): Agent[] {
    return (this.db.prepare('SELECT * FROM agents ORDER BY name').all() as Row[]).map(toAgent);
  }
  getAgent(id: string): Agent | undefined {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Row | undefined;
    return row ? toAgent(row) : undefined;
  }
  createAgent(input: Pick<Agent, 'name' | 'role' | 'model'>): Agent {
    const a: Agent = { ...input, id: randomUUID(), state: 'available', currentRunId: null, note: '' };
    this.db.prepare('INSERT INTO agents (id, name, role, model, state, current_run_id, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(a.id, a.name, a.role, a.model, a.state, null, '');
    return a;
  }
  updateAgent(id: string, patch: Partial<Omit<Agent, 'id'>>): Agent | undefined {
    const current = this.getAgent(id);
    if (!current) return undefined;
    const a = { ...current, ...patch };
    this.db.prepare('UPDATE agents SET name = ?, role = ?, model = ?, state = ?, current_run_id = ?, note = ? WHERE id = ?')
      .run(a.name, a.role, a.model, a.state, a.currentRunId, a.note, id);
    return a;
  }
  deleteAgent(id: string): void {
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  }

  // Runs
  createRun(input: Pick<Run, 'projectId' | 'agentId' | 'ticketKey' | 'ticketTitle' | 'branch' | 'worktree'> & { area?: string | null }): Run {
    const r: Run = {
      ...input, area: input.area ?? null, id: randomUUID(), status: 'running', attempts: 0, costUsd: 0, prUrl: null, error: null,
      sessionId: null, baseRef: null, prNumber: null, reviewRounds: 0, checks: null, readyAt: null, startedAt: now(), endedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO runs (id, project_id, agent_id, ticket_key, ticket_title, branch, worktree, status, attempts, cost_usd, area, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      )
      .run(r.id, r.projectId, r.agentId, r.ticketKey, r.ticketTitle, r.branch, r.worktree, r.status, r.area, r.startedAt);
    return r;
  }
  getRun(id: string): Run | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return row ? toRun(row) : undefined;
  }
  listRuns(projectId?: string): Run[] {
    const rows = projectId
      ? this.db.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC').all(projectId)
      : this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 200').all();
    return (rows as Row[]).map(toRun);
  }
  /** Every run, oldest first (listRuns caps the all-projects list for the dashboard). */
  listAllRuns(projectId?: string): Run[] {
    const rows = projectId
      ? this.db.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY started_at').all(projectId)
      : this.db.prepare('SELECT * FROM runs ORDER BY started_at').all();
    return (rows as Row[]).map(toRun);
  }
  updateRun(id: string, patch: Partial<Omit<Run, 'id'>>): Run | undefined {
    const current = this.getRun(id);
    if (!current) return undefined;
    const r = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE runs SET agent_id = ?, status = ?, attempts = ?, cost_usd = ?, pr_url = ?, error = ?, ended_at = ?, worktree = ?, session_id = ?,
         base_ref = ?, pr_number = ?, review_rounds = ?, checks = ?, ready_at = ? WHERE id = ?`,
      )
      .run(r.agentId, r.status, r.attempts, r.costUsd, r.prUrl, r.error, r.endedAt, r.worktree, r.sessionId, r.baseRef, r.prNumber,
        r.reviewRounds, r.checks, r.readyAt, id);
    return r;
  }
  addEvent(runId: string, kind: RunEventKind, message: string): RunEvent {
    const ts = now();
    const res = this.db.prepare('INSERT INTO run_events (run_id, ts, kind, message) VALUES (?, ?, ?, ?)').run(runId, ts, kind, message);
    return { id: Number(res.lastInsertRowid), runId, ts, kind, message };
  }
  /** Latest notable events across all runs, newest first, with the run's ticket and project. */
  recentEvents(limit = 20): (RunEvent & { ticketKey: string; projectId: string })[] {
    const rows = this.db
      .prepare(
        `SELECT e.*, r.ticket_key, r.project_id FROM run_events e JOIN runs r ON r.id = e.run_id
         WHERE e.kind IN ('info', 'error', 'command') ORDER BY e.id DESC LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((e) => ({ id: e.id, runId: e.run_id, ts: e.ts, kind: e.kind, message: e.message, ticketKey: e.ticket_key, projectId: e.project_id }));
  }
  listEvents(runId: string): RunEvent[] {
    return (this.db.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY id').all(runId) as Row[]).map((e) => ({
      id: e.id, runId: e.run_id, ts: e.ts, kind: e.kind, message: e.message,
    }));
  }

  // Manual tickets (projects with no PM tool)
  listManualTickets(projectId: string): Ticket[] {
    return (this.db.prepare('SELECT * FROM manual_tickets WHERE project_id = ? ORDER BY seq').all(projectId) as Row[]).map(toTicket);
  }
  getManualTicket(projectId: string, key: string): Ticket | undefined {
    const row = this.db.prepare('SELECT * FROM manual_tickets WHERE project_id = ? AND key = ?').get(projectId, key) as Row | undefined;
    return row ? toTicket(row) : undefined;
  }
  createManualTicket(projectId: string, prefix: string, t: Omit<Ticket, 'key' | 'status' | 'url'>): Ticket {
    const { n } = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM manual_tickets WHERE project_id = ?').get(projectId) as { n: number };
    const ticket: Ticket = { ...t, key: `${prefix}-${n}`, status: 'todo' };
    this.db
      .prepare(
        `INSERT INTO manual_tickets (project_id, key, title, description, acceptance_criteria, status, size, labels, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(projectId, ticket.key, ticket.title, ticket.description, ticket.acceptanceCriteria, ticket.status,
        ticket.size ?? null, JSON.stringify(ticket.labels), n);
    return ticket;
  }
  setManualTicketStatus(projectId: string, key: string, status: Ticket['status']): void {
    this.db.prepare('UPDATE manual_tickets SET status = ? WHERE project_id = ? AND key = ?').run(status, projectId, key);
  }

  // Reviews (from the reviewer agent, from you in Maestro, or polled from the code host)
  addReview(input: Omit<Review, 'id' | 'createdAt' | 'addressed' | 'costUsd' | 'author' | 'externalId'> & Partial<Pick<Review, 'addressed' | 'costUsd' | 'author' | 'externalId'>>): Review {
    const r: Review = { addressed: false, costUsd: 0, author: null, externalId: null, ...input, id: randomUUID(), createdAt: now() };
    this.db
      .prepare(
        `INSERT INTO reviews (id, run_id, source, verdict, summary, comments, author, external_id, addressed, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.runId, r.source, r.verdict, r.summary, JSON.stringify(r.comments), r.author, r.externalId, r.addressed ? 1 : 0, r.costUsd, r.createdAt);
    return r;
  }
  listReviews(runId: string): Review[] {
    return (this.db.prepare('SELECT * FROM reviews WHERE run_id = ? ORDER BY created_at, rowid').all(runId) as Row[]).map(toReview);
  }
  hasExternalReview(runId: string, externalId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM reviews WHERE run_id = ? AND external_id = ?').get(runId, externalId);
  }
  /** Feedback from you or the code host that no worker has dealt with yet. */
  pendingFeedback(runId: string): Review[] {
    return this.listReviews(runId).filter((r) => !r.addressed && r.source !== 'agent' && r.verdict === 'changes_requested');
  }
  markReviewsAddressed(ids: string[]): void {
    const stmt = this.db.prepare('UPDATE reviews SET addressed = 1 WHERE id = ?');
    for (const id of ids) stmt.run(id);
  }

  // Backlog drafts from the planner
  createDraft(projectId: string, items: BacklogItem[], costUsd: number): BacklogDraft {
    const d: BacklogDraft = {
      id: randomUUID(), projectId, status: 'draft', items, createdKeys: [], error: null, costUsd, createdAt: now(), approvedAt: null,
    };
    this.db
      .prepare('INSERT INTO backlog_drafts (id, project_id, status, items, created_keys, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(d.id, projectId, d.status, JSON.stringify(items), '[]', costUsd, d.createdAt);
    return d;
  }
  getDraft(id: string): BacklogDraft | undefined {
    const row = this.db.prepare('SELECT * FROM backlog_drafts WHERE id = ?').get(id) as Row | undefined;
    return row ? toDraft(row) : undefined;
  }
  listDrafts(projectId: string): BacklogDraft[] {
    return (this.db.prepare('SELECT * FROM backlog_drafts WHERE project_id = ? ORDER BY created_at DESC, rowid DESC').all(projectId) as Row[]).map(toDraft);
  }
  updateDraft(id: string, patch: Partial<Pick<BacklogDraft, 'status' | 'items' | 'createdKeys' | 'error' | 'approvedAt'>>): BacklogDraft | undefined {
    const current = this.getDraft(id);
    if (!current) return undefined;
    const d = { ...current, ...patch };
    this.db.prepare('UPDATE backlog_drafts SET status = ?, items = ?, created_keys = ?, error = ?, approved_at = ? WHERE id = ?')
      .run(d.status, JSON.stringify(d.items), JSON.stringify(d.createdKeys), d.error, d.approvedAt, id);
    return d;
  }

  // Ticket dependencies (kept here because not every PM tool has links)
  addDependency(projectId: string, ticketKey: string, dependsOnKey: string): void {
    this.db.prepare('INSERT OR IGNORE INTO ticket_deps (project_id, ticket_key, depends_on_key) VALUES (?, ?, ?)').run(projectId, ticketKey, dependsOnKey);
  }
  /** ticket key -> keys it depends on */
  dependencies(projectId: string): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const r of this.db.prepare('SELECT ticket_key, depends_on_key FROM ticket_deps WHERE project_id = ? ORDER BY rowid').all(projectId) as Row[]) {
      map.set(r.ticket_key, [...(map.get(r.ticket_key) ?? []), r.depends_on_key]);
    }
    return map;
  }

  // Chat with the project's assistant, kept so the conversation and proposed actions survive reloads
  addChatMessage(projectId: string, role: ChatMessage['role'], content: string): ChatMessage {
    const createdAt = now();
    const res = this.db.prepare('INSERT INTO chat_messages (project_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(projectId, role, content, createdAt);
    return { id: Number(res.lastInsertRowid), role, content, createdAt, actions: [] };
  }
  addChatAction(projectId: string, messageId: number, a: { type: string; summary: string; action: unknown }): StoredChatAction {
    const x: StoredChatAction = { id: randomUUID(), type: a.type, summary: a.summary, action: a.action, state: 'pending', result: null, runId: null, createdAt: now() };
    this.db
      .prepare('INSERT INTO chat_actions (id, project_id, message_id, type, summary, action, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(x.id, projectId, messageId, x.type, x.summary, JSON.stringify(x.action), x.state, x.createdAt);
    return x;
  }
  getChatAction(projectId: string, id: string): StoredChatAction | undefined {
    const row = this.db.prepare('SELECT * FROM chat_actions WHERE project_id = ? AND id = ?').get(projectId, id) as Row | undefined;
    return row ? toChatAction(row) : undefined;
  }
  /** Moves an action out of pending; returns false when it was not pending any more (so it runs at most once). */
  claimChatAction(id: string, state: ChatActionStatus): boolean {
    return this.db.prepare("UPDATE chat_actions SET status = ? WHERE id = ? AND status = 'pending'").run(state, id).changes === 1;
  }
  finishChatAction(id: string, state: ChatActionStatus, result: string, runId: string | null = null): void {
    this.db.prepare('UPDATE chat_actions SET status = ?, result = ?, run_id = ? WHERE id = ?').run(state, result, runId, id);
  }
  listChat(projectId: string, limit = 100): ChatMessage[] {
    const rows = (this.db.prepare('SELECT * FROM chat_messages WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(projectId, limit) as Row[]).reverse();
    const actions = this.db.prepare('SELECT * FROM chat_actions WHERE message_id = ? ORDER BY rowid');
    return rows.map((r) => ({ id: r.id, role: r.role, content: r.content, createdAt: r.created_at, actions: (actions.all(r.id) as Row[]).map(toChatAction) }));
  }
  clearChat(projectId: string): void {
    this.db.prepare('DELETE FROM chat_actions WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM chat_messages WHERE project_id = ?').run(projectId);
  }

  // Spend ledger: every agent call's cost, so budgets and the overview don't depend on run rows alone
  addSpend(projectId: string, runId: string | null, kind: SpendKind, usd: number): void {
    if (usd > 0) this.db.prepare('INSERT INTO spend (project_id, run_id, kind, usd, ts) VALUES (?, ?, ?, ?, ?)').run(projectId, runId, kind, usd, now());
  }
  spendSince(projectId: string, sinceIso: string): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(usd), 0) AS total FROM spend WHERE project_id = ? AND ts >= ?').get(projectId, sinceIso) as Row;
    return row.total;
  }
  spendByProject(sinceIso = ''): Map<string, number> {
    const rows = this.db.prepare('SELECT project_id, SUM(usd) AS total FROM spend WHERE ts >= ? GROUP BY project_id').all(sinceIso) as Row[];
    return new Map(rows.map((r) => [r.project_id, r.total]));
  }

  // Alerts
  addAlert(input: { projectId: string | null; runId: string | null; kind: AlertKind; message: string }): Alert {
    const createdAt = now();
    const res = this.db.prepare('INSERT INTO alerts (project_id, run_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.projectId, input.runId, input.kind, input.message, createdAt);
    return { ...input, id: Number(res.lastInsertRowid), read: false, createdAt };
  }
  listAlerts(limit = 50): Alert[] {
    return (this.db.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map((r) => ({
      id: r.id, projectId: r.project_id ?? null, runId: r.run_id ?? null, kind: r.kind, message: r.message, read: !!r.read, createdAt: r.created_at,
    }));
  }
  hasAlertSince(projectId: string, kind: AlertKind, sinceIso: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM alerts WHERE project_id = ? AND kind = ? AND created_at >= ?').get(projectId, kind, sinceIso);
  }
  markAlertsRead(ids?: number[]): void {
    if (!ids) this.db.prepare('UPDATE alerts SET read = 1').run();
    else for (const id of ids) this.db.prepare('UPDATE alerts SET read = 1 WHERE id = ?').run(id);
  }

  // Settings
  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return row?.value;
  }
  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }
  allSettings(): Record<string, string> {
    return Object.fromEntries((this.db.prepare('SELECT key, value FROM settings').all() as Row[]).map((r) => [r.key, r.value]));
  }
}

function toProject(r: Row): Project {
  return {
    id: r.id, name: r.name, description: r.description,
    codeHost: JSON.parse(r.code_host), pm: JSON.parse(r.pm), design: JSON.parse(r.design), docs: JSON.parse(r.docs),
    context: r.context, requirements: r.requirements, bestPractices: r.best_practices,
    workflowYaml: r.workflow_yaml, createdAt: r.created_at,
  };
}
function toAgent(r: Row): Agent {
  return { id: r.id, name: r.name, role: r.role, model: r.model, state: r.state, currentRunId: r.current_run_id ?? null, note: r.note };
}
function toRun(r: Row): Run {
  return {
    id: r.id, projectId: r.project_id, agentId: r.agent_id, ticketKey: r.ticket_key, ticketTitle: r.ticket_title,
    branch: r.branch, worktree: r.worktree, status: r.status, attempts: r.attempts, costUsd: r.cost_usd,
    prUrl: r.pr_url ?? null, error: r.error ?? null, area: r.area ?? null, sessionId: r.session_id ?? null, baseRef: r.base_ref ?? null,
    prNumber: r.pr_number ?? null, reviewRounds: r.review_rounds ?? 0, checks: r.checks ?? null, readyAt: r.ready_at ?? null,
    startedAt: r.started_at, endedAt: r.ended_at ?? null,
  };
}
function toChatAction(r: Row): StoredChatAction {
  return {
    id: r.id, type: r.type, summary: r.summary, action: JSON.parse(r.action), state: r.status, result: r.result ?? null,
    runId: r.run_id ?? null, createdAt: r.created_at,
  };
}
function toReview(r: Row): Review {
  return {
    id: r.id, runId: r.run_id, source: r.source, verdict: r.verdict, summary: r.summary, comments: JSON.parse(r.comments),
    author: r.author ?? null, externalId: r.external_id ?? null, addressed: !!r.addressed, costUsd: r.cost_usd, createdAt: r.created_at,
  };
}
function toDraft(r: Row): BacklogDraft {
  return {
    id: r.id, projectId: r.project_id, status: r.status, items: JSON.parse(r.items), createdKeys: JSON.parse(r.created_keys),
    error: r.error ?? null, costUsd: r.cost_usd, createdAt: r.created_at, approvedAt: r.approved_at ?? null,
  };
}
function toTicket(r: Row): Ticket {
  return {
    key: r.key, title: r.title, description: r.description, acceptanceCriteria: r.acceptance_criteria,
    status: r.status, size: r.size ?? undefined, labels: JSON.parse(r.labels),
  };
}
