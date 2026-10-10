# Maestro

A dashboard on your machine where you link projects to a code host and a PM tool, hand tickets to coding agents, and review the branches and pull requests they produce.

This covers Phases 0 to 3 of the plan: the board, worker agents, agent states, chat and connector settings, the planner and auto-assign, and the reviewer agent with its fix loop.

## What works now

- **Projects** linked to a GitHub, GitLab (cloud or self-managed) or Bitbucket Cloud repo, or a local git folder. Each project has its own context, requirements and best practices, which every agent reads.
- **Templates** for new projects (Node.js API in TypeScript, Angular app, Python) fill the quality gates, allowed commands and best practices; you can edit both after.
- **Tickets** live in the project's PM tool: Jira, Trello, or Maestro itself when you have no PM tool. You can create tickets from the board.
- **Workflow config** per project (YAML): base branch, branch naming, commit convention, Definition of Ready, quality gates, fix attempts and Definition of Done.
- **Docker sandbox for quality gates** (optional, off by default): with `sandbox.type: docker` in the workflow, each gate runs in a throwaway container from `sandbox.image`, with the worktree mounted, your user id, and optionally no network.
- **Worker agents** run on the Claude Agent SDK. Each ticket gets its own git worktree. When you assign a ticket, the worker:
  1. checks the Definition of Ready, then creates a branch from the latest base branch;
  2. implements the ticket;
  3. runs the quality gates, and if one fails, tries to fix it, up to `max_fix_attempts` times;
  4. commits the change;
  5. for GitHub, GitLab or Bitbucket, pushes and opens a draft pull (merge) request; for a local folder, leaves the branch for you to review in Maestro;
  6. moves the ticket to "In review" and comments with the link.
- **Agents screen** shows each agent's live state: available, working on ticket, running checks, blocked, paused. You can pause, unblock or stop an agent.
- **Run view** shows a live activity log (agent messages, tool calls, gate results) and the diff.
- **Reviewer agent** (Phase 3): once the gates pass, a reviewer agent (read-only, its own model setting) checks the change against the ticket's acceptance criteria, the best practices and the Definition of Done, and returns approve or changes requested with file and line comments. On GitHub it is posted as a real PR review (as a comment when GitHub refuses a self-approval). On changes requested the worker resumes in the same worktree and session, fixes, re-runs the gates and pushes to the same branch; then the reviewer looks again, up to `review.max_rounds` (default 2) before the ticket is blocked for you.
- **Your review**: on the run page you can request changes (a worker picks them up) or approve, which moves the ticket to done and removes the worktree. Open PRs are polled every minute for your review comments (line comments, "changes requested" reviews, or a comment mentioning @maestro), CI check status and merges; a merge finishes the ticket, closing the PR stops the run.
- **Blocked runs** can be helped from the run page: your guidance sends the run back to a worker, which resumes in the same worktree and session, and publishes the change once the gates pass.
- **Pull requests screen** lists every change in review with its CI status, the reviewer agent's verdict, open comments, rounds and cost.
- **Design context from Figma**: when a ticket links a Figma frame, the worker gets the frame's name, its parts and all its text in the prompt, plus a PNG export, under `.maestro/design/` in its worktree (never committed). UI tickets without a link get the project file's pages and frames.
- **Docs from Confluence**: list Confluence pages on the project (or link them in the requirements or a ticket) and the planner and workers get them as text in their context. It uses the Jira site and account when the PM tool is Jira, with the same Atlassian API token.
- **Project memory** in `.maestro/memory.md` in the repo: every agent reads it, workers end each ticket with a few learnings that Maestro appends to it (committed with the ticket's change), and you can edit it on the Knowledge tab (your edit is committed with the next ticket).
- **Planner** (Phase 2): "Plan backlog" on the board reads the requirements and the code (read-only) and drafts small tickets, each with acceptance criteria, a size, an `area:` label and dependencies. You edit the draft, then create the tickets in the PM tool in order. Dependencies are kept in Maestro and written into each ticket as "Depends on: KEY".
- **Auto-assign** (Phase 2): with the board toggle on (or `orchestration.auto_assign` in the workflow config), Maestro hands ready to-do tickets to free workers every 15 seconds and whenever a run ends. It skips tickets whose dependencies are not finished (`dependency_ready_when: done` or `in_review`), runs at most `max_parallel` tickets per project, and with `one_per_area` never runs two tickets with the same `area:` label at once. Blocked cards show "Waits on KEY".
- **Chat** per project answers questions using the project knowledge, its tickets, its runs and a read-only look at the code. Ask it to do something (create a ticket, assign or move one, plan the backlog, pause or resume an agent) and it proposes the action as a card; nothing runs until you click Confirm.
- **Mark done** on In review cards for projects without a PM tool.
- **Budgets**: a budget per run (cumulative over the run's agent calls; a run that spends it is blocked, and the reviewer step is skipped) and a daily budget per project (a default in Settings, an override on the project's Runs tab). At the daily budget nothing new starts and auto-assign pauses until tomorrow. Every agent call's cost goes into a spend ledger; the Projects screen shows spend today, over 7 days and in total.
- **Metrics** per project or across all, for all time or the last 7 or 30 days: runs, success rate, mean time to PR, mean cycle time, first-pass review rate, fix attempts and review rounds per run, cost per ticket, and a per-ticket table.
- **Alerts** when an agent is blocked, a run fails, a budget is reached or a change is ready for review: in the Alerts screen (with an unread count in the menu) and, if you turn them on in Settings, as desktop notifications from the browser.
- **Secrets in the system keychain** through `secret-tool` (libsecret: GNOME Keyring or KWallet) when it is installed, with no native npm module; otherwise in `~/.maestro/secrets.json`, readable only by you. Secrets already in the file move into the keychain on the first start that finds one. `MAESTRO_SECRETS=file` or `keychain` forces a choice.
- **Settings** hold API keys and tokens, the default models (worker, chat, planner), how many tickets run at once, and a budget per run.

## Not in the MVP yet

- Dependency links in Jira and Trello themselves: Maestro keeps dependencies in its own database and writes them into the ticket text.

## Requirements

- Node.js 22.22.3 or newer (Angular 22 needs it; Node 24 LTS works).
- git.
- Either an Anthropic API key (added in Settings) or Claude Code signed in on this machine.
- For GitHub projects: a fine-grained token with **Contents** and **Pull requests** read and write access to the repo.
- For GitLab projects: a personal or project access token with the `api` and `write_repository` scopes.
- For Bitbucket projects: your username and an app password with **Repositories** and **Pull requests** read and write.

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

Maestro keeps its database, clones and worktrees in `~/.maestro`. To use another folder, set `MAESTRO_HOME`. `MAESTRO_PORT` changes the port, `MAESTRO_ALLOWED_HOSTS` adds host names the engine answers to, and `MAESTRO_SECRETS=file|keychain` picks where secrets live.

## First steps

1. Open **Settings** and add your Anthropic API key (skip this if you use Claude Code's login), plus the tokens for your code host and PM tool. Set budgets, and turn on desktop notifications if you want them.
2. In **Projects**, create a project, from a template if one fits. Pick a code host (GitHub, GitLab, Bitbucket, or a local folder that is a git repo), where its tickets live, and optionally Figma and Confluence.
3. Fill in **Knowledge** (context, requirements, best practices) and check the **Workflow** gates match the repo's lint, test and build commands.
4. On the **Board**, press **Plan backlog** and edit the draft, or create tickets yourself. Then assign them, or turn on **Auto-assign**.
5. Follow runs on the run page, **Agents**, **Pull requests** and **Alerts**. The reviewer agent reviews each change first; then review it yourself (request changes or approve) or on the PR, and merge.

## Layout

```
apps/engine      Node + TypeScript engine (Fastify, SQLite via node:sqlite, Claude Agent SDK)
  src/adapters/codehost   GitHub, GitLab, Bitbucket, local folder
  src/adapters/pm         Jira, Trello, manual
  src/adapters/design     Figma
  src/adapters/docs       Confluence
  src/agents              coding agent wrapper, prompts, planner, reviewer, chat assistant
  src/orchestrator.ts     assign -> worktree -> worker -> gates -> commit -> PR -> reviewer -> fixes; auto-assign; PR polling
  src/budget.ts           daily and per-run budgets
  src/memory.ts           .maestro/memory.md
  src/metrics.ts          metrics from runs
  src/gates.ts            quality gates, optionally in Docker
  src/secrets.ts          keychain (secret-tool) or file
  src/templates.ts        project templates
  src/server.ts           REST API and the live event stream
apps/dashboard   Angular 22 dashboard
```

## Tests

```bash
npm test
```

The engine tests use stand-in agents and fake APIs, so they need no tokens or network. They run whole worker runs on temporary git repos (gates, fixes, commits, review rounds, your feedback, PR polling, blocked runs and restarts), and cover the planner, auto-assign, budgets and alerts, memory, metrics, every connector against its API's shapes, the keychain, the Docker sandbox, and the API's request guards.

## Safety

- Agents only work inside their ticket's worktree. Every tool not on the allowlist is refused: file tools, the project's gate commands and `allowed_commands` are allowed.
- Agents never commit, push or merge. The engine commits after the gates pass and opens draft PRs only.
- Tokens are never sent to the dashboard. Code host credentials are passed per git command, not written into remotes.
- The engine listens on 127.0.0.1 only, answers only to localhost host names (so a web page can't reach it through DNS rebinding), and refuses writes whose Origin is another site. Set `MAESTRO_ALLOWED_HOSTS` to add a host name.
- The live event stream is same-origin only, so other web pages can't read agent activity.
- Planner, reviewer and chat agents are read-only. Quality gates can run in a Docker container (`sandbox.type: docker`).
- Budgets cap what a run and a project can spend in a day.
