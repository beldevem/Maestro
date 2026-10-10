# Maestro

A dashboard on your machine where you link projects to a code host and a PM tool, hand tickets to coding agents, and review the branches and pull requests they produce.

This is the MVP: Phases 0 and 1 of the plan, plus the board, agent states, chat and connector settings.

## What works now

- **Projects** linked to a GitHub repo or a local git folder. Each project has its own context, requirements and best practices, which every agent reads.
- **Tickets** live in the project's PM tool: Jira, Trello, or Maestro itself when you have no PM tool. You can create tickets from the board.
- **Workflow config** per project (YAML): base branch, branch naming, commit convention, Definition of Ready, quality gates, fix attempts and Definition of Done.
- **Worker agents** run on the Claude Agent SDK. Each ticket gets its own git worktree. When you assign a ticket, the worker:
  1. checks the Definition of Ready, then creates a branch from the latest base branch;
  2. implements the ticket;
  3. runs the quality gates, and if one fails, tries to fix it, up to `max_fix_attempts` times;
  4. commits the change;
  5. for GitHub, pushes and opens a draft PR; for a local folder, leaves the branch for you to review in Maestro;
  6. moves the ticket to "In review" and comments with the link.
- **Agents screen** shows each agent's live state: available, working on ticket, running checks, blocked, paused. You can pause, unblock or stop an agent.
- **Run view** shows a live activity log (agent messages, tool calls, gate results) and the diff.
- **Chat** per project answers questions using the project knowledge, its tickets, its runs and a read-only look at the code.
- **Settings** hold API keys and tokens, the default models, how many tickets run at once, and a budget per run.

## Not in the MVP yet

- Reviewer agent and the fix loop driven by PR comments (Phase 3).
- Planner that turns requirements into a backlog, and automatic assignment of every ready ticket (Phase 2).
- GitLab and Bitbucket adapters (the code host interface is ready for them).
- Design context from Figma for agents (the link is saved on the project).
- Secrets in the OS keychain. For now they are in `~/.maestro/secrets.json`, readable only by you.

## Requirements

- Node.js 22.22.3 or newer (Angular 22 needs it; Node 24 LTS works).
- git.
- Either an Anthropic API key (added in Settings) or Claude Code signed in on this machine.
- For GitHub projects: a fine-grained token with **Contents** and **Pull requests** read and write access to the repo.

## Run it

```bash
npm run setup     # install engine and dashboard dependencies
npm run build     # build the dashboard
npm start         # engine and dashboard on http://127.0.0.1:4800
```

During development, run the two halves separately and open http://localhost:4200:

```bash
npm run dev:engine
npm run dev:dashboard
```

Maestro keeps its database, clones and worktrees in `~/.maestro`. To use another folder, set `MAESTRO_HOME`. `MAESTRO_PORT` changes the port.

## First steps

1. Open **Settings** and add your Anthropic API key (skip this if you use Claude Code's login), plus the tokens for GitHub, Jira or Trello.
2. In **Projects**, create a project. Pick a code host (GitHub repo `owner/name`, or a local folder that is a git repo), then where its tickets live.
3. Fill in **Knowledge** and adjust the **Workflow** gates to match the repo's lint, test and build commands.
4. On the **Board**, create a ticket with acceptance criteria and a size, then **Assign to agent**.
5. Watch it on the run page or on **Agents**. Review the draft PR (or the diff for local projects) and merge it yourself.

## Layout

```
apps/engine      Node + TypeScript engine (Fastify, SQLite via node:sqlite, Claude Agent SDK)
  src/adapters/codehost   GitHub, local folder
  src/adapters/pm         Jira, Trello, manual
  src/agents              coding agent wrapper, prompts, chat assistant
  src/orchestrator.ts     assign ticket -> worktree -> agent -> gates -> commit -> PR
  src/server.ts           REST API and the live event stream
apps/dashboard   Angular 22 dashboard
```

## Tests

```bash
npm test
```

The engine tests run a whole worker run on a temporary git repo with a stand-in agent. They cover a failing gate, the fix, the commit on the ticket branch and the ticket moving to review, plus the blocked path and the API.

## Safety

- Agents only work inside their ticket's worktree. Every tool not on the allowlist is refused: file tools, the project's gate commands and `allowed_commands` are allowed.
- Agents never commit, push or merge. The engine commits after the gates pass and opens draft PRs only.
- Tokens are never sent to the dashboard. The GitHub token is passed per git command, not written into remotes.
- The engine listens on 127.0.0.1 only.
