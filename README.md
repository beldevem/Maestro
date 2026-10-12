# Maestro

A dashboard on your machine where you link projects to a code host and a PM tool, hand tickets to coding agents, and review the branches and pull requests they produce.

It covers the whole plan: the board and worker agents, the planner and auto-assign, the reviewer agent and its fix loop, design and docs context, GitHub, GitLab, Bitbucket and local code hosts, chat that proposes actions, project memory, budgets and alerts, metrics, keychain secrets, templates and an optional Docker sandbox.

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
- **Your review**: on the run page you can request changes (a worker picks them up) or approve, which moves the ticket to done and removes the worktree. For local folders, **Approve and merge** merges the branch into the base branch for you: only into a clean working tree, aborting on conflicts, or as a fast-forward when the base isn't checked out. Open PRs are polled every minute for your review comments (line comments, "changes requested" reviews, or a comment mentioning @maestro), CI check status and merges; a merge finishes the ticket, closing the PR stops the run.
- **Blocked runs** can be helped from the run page: your guidance sends the run back to a worker, which resumes in the same worktree and session, and publishes the change once the gates pass.
- **Pull requests screen** lists every change in review with its CI status, the reviewer agent's verdict, open comments, rounds and cost.
- **Design context from Figma**: when a ticket links a Figma frame, the worker gets the frame's name, its parts and all its text in the prompt, plus a PNG export, under `.maestro/design/` in its worktree (never committed). UI tickets without a link get the project file's pages and frames.
- **Docs from Confluence**: list Confluence pages on the project (or link them in the requirements or a ticket) and the planner and workers get them as text in their context. It uses the Jira site and account when the PM tool is Jira, with the same Atlassian API token.
- **Project memory** in `.maestro/memory.md` in the repo: every agent reads it, workers end each ticket with a few learnings that Maestro appends to it (committed with the ticket's change), and you can edit it on the Knowledge tab (your edit is committed with the next ticket).
- **Planner** (Phase 2): "Plan backlog" on the board reads the requirements and the code (read-only) and drafts small tickets, each with acceptance criteria, a size, an `area:` label and dependencies. You edit the draft, then create the tickets in the PM tool in order. Dependencies are kept in Maestro and written into each ticket as "Depends on: KEY".
- **Auto-assign** (Phase 2): with the board toggle on (or `orchestration.auto_assign` in the workflow config), Maestro hands ready to-do tickets to free workers every 15 seconds and whenever a run ends. It skips tickets whose dependencies are not finished (`dependency_ready_when: done` or `in_review`), runs at most `max_parallel` tickets per project, and with `one_per_area` never runs two tickets with the same `area:` label at once. Blocked cards show "Waits on KEY".
- **Chat** per project answers questions using the project knowledge, its tickets, its runs and a read-only look at the code. Ask it to do something (create a ticket, assign or move one, plan the backlog, pause or resume an agent) and it proposes the action as a card; nothing runs until you click Confirm. The conversation and what happened to each proposal are kept per project.
- **Mark done** on In review cards for projects without a PM tool.
- **Budgets**: a budget per run (cumulative over the run's agent calls; a run that spends it is blocked, and the reviewer step is skipped) and a daily budget per project (a default in Settings, an override on the project's Runs tab). At the daily budget nothing new starts and auto-assign pauses until tomorrow. Every agent call's cost goes into a spend ledger; the Projects screen shows spend today, over 7 days and in total.
- **Worktree clean-up**: worktrees of failed, stopped and done runs are removed after a few days (Settings; branches stay), or at once from the project's Runs tab.
- **Metrics** per project or across all, for all time or the last 7 or 30 days: runs, success rate, mean time to PR, mean cycle time, first-pass review rate, fix attempts and review rounds per run, cost per ticket, and a per-ticket table.
- **Alerts** when an agent is blocked, a run fails, a budget is reached or a change is ready for review: in the Alerts screen (with an unread count in the menu) and, if you turn them on in Settings, as desktop notifications from the browser.
- **Secrets in the system keychain** through `secret-tool` (libsecret: GNOME Keyring or KWallet) when it is installed, with no native npm module; otherwise in `~/.maestro/secrets.json`, readable only by you. Secrets already in the file move into the keychain on the first start that finds one. `MAESTRO_SECRETS=file` or `keychain` forces a choice.
- **Settings** hold API keys and tokens, the default models (worker, chat, planner), how many tickets run at once, and a budget per run.

## Known limits

- Dependencies live in Maestro's database and are written into the ticket text ("Depends on: KEY"). On Jira they are also added as "Blocks" links; Trello has no links.
- Pull requests are polled every minute (there are no webhooks on a local machine), so a merge or a comment shows up within about a minute.
- GitLab and Bitbucket are tested against their API shapes, not yet against live accounts.
- Workers run the code and tests they write, as the quality gates need. Use the Docker sandbox (`sandbox.type: docker`) for repositories or tickets you don't fully trust.
- The keychain needs `secret-tool` (on Ubuntu: `sudo apt install libsecret-tools`); without it secrets stay in `~/.maestro/secrets.json`.

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

## Run it in Docker

```bash
cp .env.example .env      # then fill it in: your uid/gid, data folder, projects folder, API key, git name
mkdir -p ~/.maestro       # the data folder must exist (MAESTRO_DATA)
docker compose up -d --build
```

Open http://127.0.0.1:4800. The port is published on 127.0.0.1 only; inside the container the engine listens on all interfaces, and its Host and Origin checks still refuse anything but localhost.

```bash
docker compose logs -f    # follow the engine log
docker compose ps         # status, including the health check
docker compose down       # stop (data stays)
```

- **Data**: the folder in `MAESTRO_DATA` (by default you'd use `~/.maestro`), mounted at the same path as on the host. It holds the database, clones, worktrees and `secrets.json`; folders are 700 and files 600. Don't run the engine on the host at the same time with the same folder.
- **Local-folder projects**: `PROJECTS_DIR` is mounted at the same path as on the host, so projects under it work as they do outside Docker. Folders elsewhere aren't visible to the container.
- **Claude**: set `ANTHROPIC_API_KEY` in `.env`, or use your Claude Code login by mounting `~/.claude/.credentials.json` read-only (the commented line in `docker-compose.yml`; a git-ignored `docker-compose.override.yml` is a good place for it). The login is copied into the private config folder at start.
- **Secrets**: there is no system keychain in a container, so keys saved in Settings go to `$MAESTRO_DATA/secrets.json` (mode 600). Keys saved in a keychain by an engine on the host aren't visible to the container. Tokens can also come from `.env`.
- **Files you own**: the container runs as `MAESTRO_UID:MAESTRO_GID`, so commits, worktrees and files in your repositories are yours. `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` set who Maestro's commits are from.
- **Quality gates** run inside the container, which has Node 24 and git. Projects that need other tools (Python, Java...) need an image built on top of this one.
- **Docker gate sandbox** (opt-in): `docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up -d --build` with `DOCKER_GID` set. This mounts the Docker socket, which is root-equivalent access to this machine; only use it if you accept that.

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
- Agents load no settings files: a repository's `.claude/settings.json` could add hooks or permission rules that widen the tool allowlist, and an agent can write that file in its own worktree. The repo's `CLAUDE.md` is given to agents as text instead.
- Planner, reviewer and chat agents are read-only. Quality gates can run in a Docker container (`sandbox.type: docker`).
- Budgets cap what a run and a project can spend in a day.
