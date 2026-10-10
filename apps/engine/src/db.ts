import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Agent, BacklogDraft, BacklogItem, Project, Review, Run, RunEvent, RunEventKind, Ticket } from './types.js';
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
CREATE TABLE IF NOT EXISTS ticket_deps (
  project_id TEXT NOT NULL, ticket_key TEXT NOT NULL, depends_on_key TEXT NOT NULL,
  PRIMARY KEY (project_id, ticket_key, depends_on_key)
);
`;

/** Columns added after the first release, for databases created before them. */
const COLUMNS: { table: string; column: string; ddl: string }[] = [
  { table: 'runs', column: 'area', ddl: 'ALTER TABLE runs ADD COLUMN area TEXT' },
  { table: 'runs', column: 'session_id', ddl: 'ALTER TABLE runs ADD COLUMN session_id TEXT' },
  { table: 'runs', column: 'base_ref', ddl: 'ALTER TABLE runs ADD COLUMN base_ref TEXT' },
  { table: 'runs', column: 'pr_number', ddl: 'ALTER TABLE runs ADD COLUMN pr_number INTEGER' },
  { table: 'runs', column: 'review_rounds', ddl: 'ALTER TABLE runs ADD COLUMN review_rounds INTEGER NOT NULL DEFAULT 0' },
  { table: 'runs', column: 'checks', ddl: 'ALTER TABLE runs ADD COLUMN checks TEXT' },
];

type Row = Record<string, any>;
const now = () => new Date().toISOString();

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
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
  createProject(input: Omit<Project, 'id' | 'createdAt' | 'workflowYaml'> & { workflowYaml?: string }): Project {
    const p: Project = { ...input, workflowYaml: input.workflowYaml || DEFAULT_WORKFLOW_YAML, id: randomUUID(), createdAt: now() };
    this.db
      .prepare(
        `INSERT INTO projects (id, name, description, code_host, pm, design, context, requirements, best_practices, workflow_yaml, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.name, p.description, JSON.stringify(p.codeHost), JSON.stringify(p.pm), JSON.stringify(p.design),
        p.context, p.requirements, p.bestPractices, p.workflowYaml, p.createdAt);
    return p;
  }
  updateProject(id: string, patch: Partial<Omit<Project, 'id' | 'createdAt'>>): Project | undefined {
    const current = this.getProject(id);
    if (!current) return undefined;
    const p = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE projects SET name = ?, description = ?, code_host = ?, pm = ?, design = ?, context = ?, requirements = ?,
         best_practices = ?, workflow_yaml = ? WHERE id = ?`,
      )
      .run(p.name, p.description, JSON.stringify(p.codeHost), JSON.stringify(p.pm), JSON.stringify(p.design),
        p.context, p.requirements, p.bestPractices, p.workflowYaml, id);
    return p;
  }
  deleteProject(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM manual_tickets WHERE project_id = ?').run(id);
    this.db.prepare('DELETE FROM backlog_drafts WHERE project_id = ?').run(id);
    this.db.prepare('DELETE FROM ticket_deps WHERE project_id = ?').run(id);
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
      sessionId: null, baseRef: null, prNumber: null, reviewRounds: 0, checks: null, startedAt: now(), endedAt: null,
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
  updateRun(id: string, patch: Partial<Omit<Run, 'id'>>): Run | undefined {
    const current = this.getRun(id);
    if (!current) return undefined;
    const r = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE runs SET agent_id = ?, status = ?, attempts = ?, cost_usd = ?, pr_url = ?, error = ?, ended_at = ?, worktree = ?, session_id = ?,
         base_ref = ?, pr_number = ?, review_rounds = ?, checks = ? WHERE id = ?`,
      )
      .run(r.agentId, r.status, r.attempts, r.costUsd, r.prUrl, r.error, r.endedAt, r.worktree, r.sessionId, r.baseRef, r.prNumber,
        r.reviewRounds, r.checks, id);
    return r;
  }
  addEvent(runId: string, kind: RunEventKind, message: string): RunEvent {
    const ts = now();
    const res = this.db.prepare('INSERT INTO run_events (run_id, ts, kind, message) VALUES (?, ?, ?, ?)').run(runId, ts, kind, message);
    return { id: Number(res.lastInsertRowid), runId, ts, kind, message };
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

  // Settings
  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return row?.value;
  }
  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  allSettings(): Record<string, string> {
    return Object.fromEntries((this.db.prepare('SELECT key, value FROM settings').all() as Row[]).map((r) => [r.key, r.value]));
  }
}

function toProject(r: Row): Project {
  return {
    id: r.id, name: r.name, description: r.description,
    codeHost: JSON.parse(r.code_host), pm: JSON.parse(r.pm), design: JSON.parse(r.design),
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
    prNumber: r.pr_number ?? null, reviewRounds: r.review_rounds ?? 0, checks: r.checks ?? null,
    startedAt: r.started_at, endedAt: r.ended_at ?? null,
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
