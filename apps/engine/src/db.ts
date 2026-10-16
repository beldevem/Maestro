import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Agent, Alert, AlertKind, BacklogDraft, ChatActionStatus, ChatMessage, StoredChatAction, BacklogItem, Project, Review, Run, RunEvent, RunEventKind, SpendKind, Ticket } from './types.js';
import type { Usage } from './usage.js';
import { ROLES, type Role, type SessionUser } from './auth/roles.js';
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
  { table: 'chat_messages', column: 'model', ddl: 'ALTER TABLE chat_messages ADD COLUMN model TEXT' },
  { table: 'agents', column: 'provider', ddl: "ALTER TABLE agents ADD COLUMN provider TEXT NOT NULL DEFAULT ''" },
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

/**
 * Schema changes, in order. Each runs once, in a transaction, and moves `PRAGMA user_version` to its
 * position; each is also safe to run again, so databases from before versioning upgrade cleanly.
 * Add new changes at the end; never edit or reorder released ones.
 */
export const MIGRATIONS: ((db: DatabaseSync) => void)[] = [
  (db) => db.exec(SCHEMA),
  (db) => {
    for (const c of COLUMNS) addColumn(db, c.table, c.column, c.ddl);
  },
  // 3: spend is measured in tokens; dollar budgets become optional euro budgets beside new token budgets.
  (db) => {
    for (const table of ['spend', 'runs', 'backlog_drafts']) {
      for (const col of ['tokens_in', 'tokens_out', 'tokens_cache']) addColumn(db, table, col, `ALTER TABLE ${table} ADD COLUMN ${col} INTEGER`);
    }
    const get = (key: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined)?.value as string | undefined;
    const rate = Number(get('currency.eurPerUsd') ?? NaN);
    const eurPerUsd = Number.isFinite(rate) && rate > 0 ? rate : 0.9;
    const move = (from: string, to: string) => {
      const usd = Number(get(from) ?? NaN);
      if (Number.isFinite(usd) && usd > 0) db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(to, String(Math.round(usd * eurPerUsd * 100) / 100));
      db.prepare('DELETE FROM settings WHERE key = ?').run(from);
    };
    move('budget.perRunUsd', 'budget.perRunEur');
    move('budget.projectDailyUsd', 'budget.projectDailyEur');
    for (const r of db.prepare("SELECT key FROM settings WHERE key LIKE 'budget.daily.%'").all() as Row[]) {
      move(r.key, `budget.dailyEur.${(r.key as string).slice('budget.daily.'.length)}`);
    }
  },
  // 4: the Dashboard chat holds several conversations, each with its own project focus and model.
  (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS chat_threads (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, project_id TEXT, model TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    const first = db.prepare("SELECT content, created_at FROM chat_messages WHERE project_id = '' AND role = 'user' ORDER BY id LIMIT 1").get() as Row | undefined;
    const last = db.prepare("SELECT created_at FROM chat_messages WHERE project_id = '' ORDER BY id DESC LIMIT 1").get() as Row | undefined;
    if (last) {
      const id = randomUUID();
      const model = (db.prepare("SELECT value FROM settings WHERE key = 'chat.model'").get() as Row | undefined)?.value ?? null;
      db.prepare('INSERT INTO chat_threads (id, title, project_id, model, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)')
        .run(id, first ? titleFrom(first.content) : 'Conversation', model, first?.created_at ?? last.created_at, last.created_at);
      db.prepare("UPDATE chat_messages SET project_id = ? WHERE project_id = ''").run(threadKey(id));
      db.prepare("UPDATE chat_actions SET project_id = ? WHERE project_id = ''").run(threadKey(id));
    }
    db.prepare("DELETE FROM settings WHERE key = 'chat.model'").run();
  },
  // 5: accounts, sessions, shared projects, the audit log, and who did what on existing rows.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL,
        roles TEXT NOT NULL DEFAULT '[]', must_change_password INTEGER NOT NULL DEFAULT 0, failed_logins INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT, deactivated_at TEXT, daily_token_cap INTEGER, created_at TEXT NOT NULL, last_login_at TEXT, password_changed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL, user_agent TEXT
      );
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS project_members (
        project_id TEXT NOT NULL, user_id TEXT NOT NULL, added_by TEXT, added_at TEXT NOT NULL, PRIMARY KEY (project_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS project_members_user ON project_members(user_id);
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id TEXT NOT NULL, action TEXT NOT NULL,
        target_type TEXT, target_id TEXT, project_id TEXT, detail TEXT
      );
      CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log(at);
      CREATE INDEX IF NOT EXISTS audit_log_user ON audit_log(user_id);
    `);
    for (const [table, col] of [
      ['runs', 'started_by'], ['runs', 'run_trigger'], ['spend', 'user_id'], ['chat_threads', 'user_id'], ['chat_messages', 'user_id'],
      ['chat_actions', 'created_by'], ['manual_tickets', 'created_by'], ['backlog_drafts', 'created_by'],
    ]) addColumn(db, table, col, `ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
  },
];

/** Where a Dashboard conversation's messages and actions are kept (beside each project's own chat). */
export const threadKey = (threadId: string) => `chat:${threadId}`;

/** A conversation's title from its first question. */
export function titleFrom(question: string): string {
  const line = question.trim().split('\n')[0].replace(/\s+/g, ' ');
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line || 'New chat';
}

export interface ChatThread {
  id: string;
  title: string;
  /** The project in focus, or null for all projects. */
  projectId: string | null;
  /** The model chosen for this conversation, or null for the Chat role's default. */
  model: { provider: string; model: string } | null;
  createdAt: string;
  updatedAt: string;
  messages: number;
  /** Whose conversation it is. */
  userId: string | null;
}

function addColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
  if (!cols.some((r) => r.name === column)) db.exec(ddl);
}

function migrate(db: DatabaseSync): void {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (current > MIGRATIONS.length) throw new Error(`This database is from a newer Maestro (schema ${current}, this engine knows ${MIGRATIONS.length}). Update Maestro.`);
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      MIGRATIONS[v](db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Database migration ${v + 1} failed: ${(e as Error).message}`);
    }
  }
}

export interface Spent {
  usd: number;
  usage: Usage | null;
}
const SPEND_SUMS = 'COALESCE(SUM(usd), 0) AS usd, SUM(tokens_in) AS tin, SUM(tokens_out) AS tout, SUM(tokens_cache) AS tcache, COUNT(tokens_in) + COUNT(tokens_out) AS known';
function toSpent(r: Row): Spent {
  return { usd: r.usd ?? 0, usage: r.known ? { input: Number(r.tin ?? 0), output: Number(r.tout ?? 0), cache: Number(r.tcache ?? 0) } : null };
}

export interface AuditEntry {
  id: number;
  at: string;
  /** A user id, or "system" for Maestro itself. */
  userId: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  projectId: string | null;
  detail: Record<string, unknown> | null;
}

export interface UserRow extends SessionUser {
  passwordHash: string;
  failedLogins: number;
  lockedUntil: string | null;
  deactivatedAt: string | null;
  dailyTokenCap: number | null;
  createdAt: string;
  lastLoginAt: string | null;
}

function toUser(r: Row): UserRow {
  let roles: Role[] = [];
  try {
    roles = (JSON.parse(r.roles) as string[]).filter((x): x is Role => (ROLES as readonly string[]).includes(x));
  } catch {
    roles = [];
  }
  return {
    id: r.id, email: r.email, name: r.name, roles, mustChangePassword: !!r.must_change_password, passwordHash: r.password_hash,
    failedLogins: r.failed_logins ?? 0, lockedUntil: r.locked_until ?? null, deactivatedAt: r.deactivated_at ?? null,
    dailyTokenCap: r.daily_token_cap ?? null, createdAt: r.created_at, lastLoginAt: r.last_login_at ?? null,
  };
}

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    // Project data is yours alone: the database starts as 600, and SQLite gives its -wal and -shm files the same mode.
    if (!existsSync(file)) writeFileSync(file, '', { mode: 0o600 });
    for (const f of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    // Another connection (a second engine, a backup tool) may hold the lock for a moment: wait instead of failing.
    this.db.exec('PRAGMA busy_timeout = 5000;');
    migrate(this.db);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  /** The schema version this database is at (`PRAGMA user_version`). */
  schemaVersion(): number {
    return (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
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
    this.db.prepare('UPDATE chat_threads SET project_id = NULL WHERE project_id = ?').run(id);
    this.db.prepare('DELETE FROM project_members WHERE project_id = ?').run(id);
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
  createAgent(input: Pick<Agent, 'name' | 'role' | 'model'> & { provider?: string }): Agent {
    const a: Agent = { provider: '', ...input, id: randomUUID(), state: 'available', currentRunId: null, note: '' };
    this.db.prepare('INSERT INTO agents (id, name, role, provider, model, state, current_run_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.id, a.name, a.role, a.provider, a.model, a.state, null, '');
    return a;
  }
  updateAgent(id: string, patch: Partial<Omit<Agent, 'id'>>): Agent | undefined {
    const current = this.getAgent(id);
    if (!current) return undefined;
    const a = { ...current, ...patch };
    this.db.prepare('UPDATE agents SET name = ?, role = ?, provider = ?, model = ?, state = ?, current_run_id = ?, note = ? WHERE id = ?')
      .run(a.name, a.role, a.provider, a.model, a.state, a.currentRunId, a.note, id);
    return a;
  }
  deleteAgent(id: string): void {
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  }

  // Runs
  createRun(input: Pick<Run, 'projectId' | 'agentId' | 'ticketKey' | 'ticketTitle' | 'branch' | 'worktree'> & { area?: string | null; startedBy?: string | null; trigger?: Run['trigger'] }): Run {
    const r: Run = {
      ...input, area: input.area ?? null, startedBy: input.startedBy ?? null, trigger: input.trigger ?? 'manual', id: randomUUID(), status: 'running', attempts: 0, costUsd: 0, usage: null, prUrl: null, error: null,
      sessionId: null, baseRef: null, prNumber: null, reviewRounds: 0, checks: null, readyAt: null, startedAt: now(), endedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO runs (id, project_id, agent_id, ticket_key, ticket_title, branch, worktree, status, attempts, cost_usd, area, started_at, started_by, run_trigger)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
      )
      .run(r.id, r.projectId, r.agentId, r.ticketKey, r.ticketTitle, r.branch, r.worktree, r.status, r.area, r.startedAt, r.startedBy, r.trigger);
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
         base_ref = ?, pr_number = ?, review_rounds = ?, checks = ?, ready_at = ?, tokens_in = ?, tokens_out = ?, tokens_cache = ? WHERE id = ?`,
      )
      .run(r.agentId, r.status, r.attempts, r.costUsd, r.prUrl, r.error, r.endedAt, r.worktree, r.sessionId, r.baseRef, r.prNumber,
        r.reviewRounds, r.checks, r.readyAt, r.usage?.input ?? null, r.usage?.output ?? null, r.usage?.cache ?? null, id);
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
  createDraft(projectId: string, items: BacklogItem[], costUsd: number, usage: Usage | null = null): BacklogDraft {
    const d: BacklogDraft = {
      id: randomUUID(), projectId, status: 'draft', items, createdKeys: [], error: null, costUsd, usage, createdAt: now(), approvedAt: null,
    };
    this.db
      .prepare('INSERT INTO backlog_drafts (id, project_id, status, items, created_keys, cost_usd, tokens_in, tokens_out, tokens_cache, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(d.id, projectId, d.status, JSON.stringify(items), '[]', costUsd, usage?.input ?? null, usage?.output ?? null, usage?.cache ?? null, d.createdAt);
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
  addChatMessage(projectId: string, role: ChatMessage['role'], content: string, model: string | null = null, userId: string | null = null): ChatMessage {
    const createdAt = now();
    const res = this.db.prepare('INSERT INTO chat_messages (project_id, role, content, model, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?)').run(projectId, role, content, model, createdAt, userId);
    return { id: Number(res.lastInsertRowid), role, content, model, createdAt, actions: [] };
  }
  addChatAction(projectId: string, messageId: number, a: { type: string; summary: string; action: unknown }, createdBy: string | null = null): StoredChatAction {
    const x: StoredChatAction = { id: randomUUID(), type: a.type, summary: a.summary, action: a.action, state: 'pending', result: null, runId: null, createdAt: now() };
    this.db
      .prepare('INSERT INTO chat_actions (id, project_id, message_id, type, summary, action, status, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(x.id, projectId, messageId, x.type, x.summary, JSON.stringify(x.action), x.state, x.createdAt, createdBy);
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
    return rows.map((r) => ({ id: r.id, role: r.role, content: r.content, model: r.model ?? null, createdAt: r.created_at, actions: (actions.all(r.id) as Row[]).map(toChatAction) }));
  }
  clearChat(projectId: string): void {
    this.db.prepare('DELETE FROM chat_actions WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM chat_messages WHERE project_id = ?').run(projectId);
  }

  // Accounts
  countUsers(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as Row).n;
  }
  createUser(input: { email: string; name: string; passwordHash: string; roles: Role[]; mustChangePassword?: boolean }): UserRow {
    const id = randomUUID();
    this.db.prepare('INSERT INTO users (id, email, name, password_hash, roles, must_change_password, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.email.trim(), input.name.trim(), input.passwordHash, JSON.stringify(input.roles), input.mustChangePassword ? 1 : 0, now(), now());
    return this.getUser(id)!;
  }
  getUser(id: string): UserRow | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    return row ? toUser(row) : undefined;
  }
  getUserByEmail(email: string): UserRow | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim()) as Row | undefined;
    return row ? toUser(row) : undefined;
  }
  listUsers(): UserRow[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY deactivated_at IS NOT NULL, name COLLATE NOCASE').all() as Row[]).map(toUser);
  }
  updateUser(id: string, patch: Partial<{ name: string; email: string; roles: Role[]; passwordHash: string; mustChangePassword: boolean; failedLogins: number; lockedUntil: string | null; deactivatedAt: string | null; dailyTokenCap: number | null; lastLoginAt: string }>): UserRow | undefined {
    const cols: Record<string, string> = {
      name: 'name', email: 'email', roles: 'roles', passwordHash: 'password_hash', mustChangePassword: 'must_change_password', failedLogins: 'failed_logins',
      lockedUntil: 'locked_until', deactivatedAt: 'deactivated_at', dailyTokenCap: 'daily_token_cap', lastLoginAt: 'last_login_at',
    };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !cols[k]) continue;
      const value = k === 'roles' ? JSON.stringify(v) : k === 'mustChangePassword' ? (v ? 1 : 0) : v;
      this.db.prepare(`UPDATE users SET ${cols[k]} = ? WHERE id = ?`).run(value as string | number | null, id);
      if (k === 'passwordHash') this.db.prepare('UPDATE users SET password_changed_at = ? WHERE id = ?').run(now(), id);
    }
    return this.getUser(id);
  }
  /** At setup, the first account becomes the author of everything made before accounts existed. */
  claimUnowned(userId: string): void {
    for (const [table, col] of [
      ['runs', 'started_by'], ['spend', 'user_id'], ['chat_threads', 'user_id'], ['chat_actions', 'created_by'],
      ['manual_tickets', 'created_by'], ['backlog_drafts', 'created_by'],
    ]) this.db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} IS NULL`).run(userId);
    this.db.prepare("UPDATE chat_messages SET user_id = ? WHERE user_id IS NULL AND role = 'user'").run(userId);
    this.db.prepare("UPDATE runs SET run_trigger = 'manual' WHERE run_trigger IS NULL").run();
    const t = now();
    for (const p of this.listProjects()) this.db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?)').run(p.id, userId, userId, t);
  }

  // Activity log: who did what (never secret values)
  addAudit(e: { userId: string; action: string; targetType?: string | null; targetId?: string | null; projectId?: string | null; detail?: Record<string, unknown> | null }): void {
    this.db.prepare('INSERT INTO audit_log (at, user_id, action, target_type, target_id, project_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(now(), e.userId, e.action, e.targetType ?? null, e.targetId ?? null, e.projectId ?? null, e.detail && Object.keys(e.detail).length ? JSON.stringify(e.detail) : null);
  }
  /** Newest first; `before` is the id to continue below. */
  listAudit(f: { userId?: string; projectId?: string; projectIds?: Set<string>; action?: string; since?: string; until?: string; before?: number; limit?: number } = {}): AuditEntry[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.userId) where.push('user_id = ?') && args.push(f.userId);
    if (f.projectId) where.push('project_id = ?') && args.push(f.projectId);
    if (f.action) where.push('(action = ? OR action LIKE ?)') && args.push(f.action, `${f.action}.%`);
    if (f.since) where.push('at >= ?') && args.push(f.since);
    if (f.until) where.push('at < ?') && args.push(f.until);
    if (f.before) where.push('id < ?') && args.push(f.before);
    const rows = this.db.prepare(`SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...args, Math.min(f.limit ?? 100, 500) * (f.projectIds ? 4 : 1)) as Row[];
    return rows
      .map((r) => ({ id: r.id, at: r.at, userId: r.user_id, action: r.action, targetType: r.target_type ?? null, targetId: r.target_id ?? null, projectId: r.project_id ?? null, detail: r.detail ? JSON.parse(r.detail) : null }))
      .filter((e) => !f.projectIds || !e.projectId || f.projectIds.has(e.projectId))
      .slice(0, Math.min(f.limit ?? 100, 500));
  }

  // Project members
  isMember(projectId: string, userId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, userId);
  }
  memberProjectIds(userId: string): Set<string> {
    return new Set((this.db.prepare('SELECT project_id FROM project_members WHERE user_id = ?').all(userId) as Row[]).map((r) => r.project_id as string));
  }
  listMembers(projectId: string): { userId: string; addedBy: string | null; addedAt: string }[] {
    return (this.db.prepare('SELECT * FROM project_members WHERE project_id = ? ORDER BY added_at').all(projectId) as Row[]).map((r) => ({ userId: r.user_id, addedBy: r.added_by ?? null, addedAt: r.added_at }));
  }
  addMember(projectId: string, userId: string, addedBy: string | null): void {
    this.db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?)').run(projectId, userId, addedBy, now());
  }
  removeMember(projectId: string, userId: string): void {
    this.db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(projectId, userId);
  }

  // Sessions: only a hash of the cookie's id is stored
  createSession(idHash: string, userId: string, expiresAt: string, userAgent: string | null, at = now()): void {
    const t = at;
    this.db.prepare('INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)').run(idHash, userId, t, t, expiresAt, userAgent);
  }
  getSession(idHash: string): { userId: string; createdAt: string; lastSeenAt: string; expiresAt: string } | undefined {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(idHash) as Row | undefined;
    return r ? { userId: r.user_id, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at } : undefined;
  }
  touchSession(idHash: string, at = now()): void {
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(at, idHash);
  }
  deleteSession(idHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
  }
  /** Ends a user's sessions, except one (the browser that just changed its own password). */
  deleteUserSessions(userId: string, except?: string): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').run(userId, except ?? '');
  }
  pruneSessions(idleBefore: string): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?').run(now(), idleBefore);
  }

  // Dashboard conversations
  createThread(input: { title?: string; projectId?: string | null; model?: ChatThread['model']; userId?: string | null } = {}): ChatThread {
    const t = now();
    const id = randomUUID();
    this.db.prepare('INSERT INTO chat_threads (id, title, project_id, model, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.title ?? 'New chat', input.projectId ?? null, input.model ? JSON.stringify(input.model) : null, t, t, input.userId ?? null);
    return this.getThread(id)!;
  }
  getThread(id: string): ChatThread | undefined {
    const row = this.db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.project_id = 'chat:' || t.id) AS n FROM chat_threads t WHERE t.id = ?`).get(id) as Row | undefined;
    return row ? toThread(row) : undefined;
  }
  /** Most recent activity first; only one person's when `userId` is given (conversations are private). */
  listThreads(userId?: string): ChatThread[] {
    const where = userId ? 'WHERE t.user_id = ?' : '';
    return (this.db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.project_id = 'chat:' || t.id) AS n FROM chat_threads t ${where} ORDER BY t.updated_at DESC, t.rowid DESC`).all(...(userId ? [userId] : [])) as Row[]).map(toThread);
  }
  updateThread(id: string, patch: { title?: string; projectId?: string | null; model?: ChatThread['model']; touch?: boolean }): ChatThread | undefined {
    const cur = this.getThread(id);
    if (!cur) return undefined;
    const next = { ...cur, ...('title' in patch && patch.title !== undefined ? { title: patch.title } : {}), ...('projectId' in patch ? { projectId: patch.projectId ?? null } : {}), ...('model' in patch ? { model: patch.model ?? null } : {}) };
    this.db.prepare('UPDATE chat_threads SET title = ?, project_id = ?, model = ?, updated_at = ? WHERE id = ?')
      .run(next.title, next.projectId, next.model ? JSON.stringify(next.model) : null, patch.touch ? now() : cur.updatedAt, id);
    return this.getThread(id);
  }
  deleteThread(id: string): void {
    this.clearChat(threadKey(id));
    this.db.prepare('DELETE FROM chat_threads WHERE id = ?').run(id);
  }
  /** A proposal from a Dashboard conversation; only from one person's conversations when `userId` is given. */
  getThreadAction(actionId: string, userId?: string): StoredChatAction | undefined {
    const row = this.db.prepare("SELECT * FROM chat_actions WHERE id = ? AND project_id LIKE 'chat:%'").get(actionId) as Row | undefined;
    if (!row) return undefined;
    if (userId && this.getThread(String(row.project_id).slice('chat:'.length))?.userId !== userId) return undefined;
    return toChatAction(row);
  }

  // Spend ledger: every agent call's cost, so budgets and the overview don't depend on run rows alone
  addSpend(projectId: string, runId: string | null, kind: SpendKind, usd: number, usage: Usage | null = null): void {
    if (!(usd > 0) && !usage) return;
    this.db
      .prepare('INSERT INTO spend (project_id, run_id, kind, usd, tokens_in, tokens_out, tokens_cache, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(projectId, runId, kind, usd > 0 ? usd : 0, usage?.input ?? null, usage?.output ?? null, usage?.cache ?? null, now());
  }
  /** USD and tokens spent since a time; usage is null when no entry recorded tokens. */
  spendSince(projectId: string, sinceIso: string): Spent {
    const row = this.db.prepare(`SELECT ${SPEND_SUMS} FROM spend WHERE project_id = ? AND ts >= ?`).get(projectId, sinceIso) as Row;
    return toSpent(row);
  }
  spendByProject(sinceIso = ''): Map<string, Spent> {
    const rows = this.db.prepare(`SELECT project_id, ${SPEND_SUMS} FROM spend WHERE ts >= ? GROUP BY project_id`).all(sinceIso) as Row[];
    return new Map(rows.map((r) => [r.project_id, toSpent(r)]));
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
  return { id: r.id, name: r.name, role: r.role, provider: r.provider ?? '', model: r.model, state: r.state, currentRunId: r.current_run_id ?? null, note: r.note };
}
function toRun(r: Row): Run {
  return {
    id: r.id, projectId: r.project_id, agentId: r.agent_id, ticketKey: r.ticket_key, ticketTitle: r.ticket_title,
    branch: r.branch, worktree: r.worktree, status: r.status, attempts: r.attempts, costUsd: r.cost_usd, usage: usageOf(r),
    prUrl: r.pr_url ?? null, error: r.error ?? null, area: r.area ?? null, sessionId: r.session_id ?? null, baseRef: r.base_ref ?? null,
    prNumber: r.pr_number ?? null, reviewRounds: r.review_rounds ?? 0, checks: r.checks ?? null, readyAt: r.ready_at ?? null,
    startedAt: r.started_at, endedAt: r.ended_at ?? null, startedBy: r.started_by ?? null, trigger: r.run_trigger ?? null,
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
function toThread(r: Row): ChatThread {
  let model: ChatThread['model'] = null;
  try {
    model = r.model ? JSON.parse(r.model) : null;
  } catch {
    model = null;
  }
  return { id: r.id, title: r.title, projectId: r.project_id ?? null, model, createdAt: r.created_at, updatedAt: r.updated_at, messages: Number(r.n ?? 0), userId: r.user_id ?? null };
}
function toDraft(r: Row): BacklogDraft {
  return {
    id: r.id, projectId: r.project_id, status: r.status, items: JSON.parse(r.items), createdKeys: JSON.parse(r.created_keys),
    error: r.error ?? null, costUsd: r.cost_usd, usage: usageOf(r), createdAt: r.created_at, approvedAt: r.approved_at ?? null,
  };
}
/** Token columns as a usage, or null when none were recorded. */
function usageOf(r: Row): Usage | null {
  if (r.tokens_in === null && r.tokens_out === null && r.tokens_cache === null) return null;
  if (r.tokens_in === undefined) return null;
  return { input: Number(r.tokens_in ?? 0), output: Number(r.tokens_out ?? 0), cache: Number(r.tokens_cache ?? 0) };
}
function toTicket(r: Row): Ticket {
  return {
    key: r.key, title: r.title, description: r.description, acceptanceCriteria: r.acceptance_criteria,
    status: r.status, size: r.size ?? undefined, labels: JSON.parse(r.labels),
  };
}
