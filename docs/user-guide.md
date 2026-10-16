# Maestro user guide

Maestro hands the tickets of your projects to AI coding agents ("workers"). Each worker builds a ticket on its own branch, runs your quality gates and fixes what fails. A reviewer agent checks the work, and you approve it. This guide covers every screen and how to use it well. The last section maps every error Maestro can show to its fix.

- [1. Getting started](#1-getting-started)
- [2. Roles: who can do what](#2-roles-who-can-do-what)
- [3. People and project members](#3-people-and-project-members)
- [4. Connecting tools (Settings)](#4-connecting-tools-settings)
- [5. Creating a project](#5-creating-a-project)
- [6. Workers](#6-workers)
- [7. Tickets and the board](#7-tickets-and-the-board)
- [8. Runs: from ticket to review](#8-runs-from-ticket-to-review)
- [9. The planner](#9-the-planner)
- [10. Ask Maestro (chat)](#10-ask-maestro-chat)
- [11. Usage, tokens, € and budgets](#11-usage-tokens--and-budgets)
- [12. Activity, metrics and alerts](#12-activity-metrics-and-alerts)
- [13. Backups and recovery](#13-backups-and-recovery)
- [14. Good practice](#14-good-practice)
- [15. Troubleshooting](#15-troubleshooting)

---

## 1. Getting started

**Start Maestro** (Docker, from the Maestro folder):

```bash
cp .env.example .env      # set MAESTRO_DATA, PROJECTS_DIR, your uid/gid and git name
mkdir -p ~/.maestro
docker compose up -d --build
```

Open http://127.0.0.1:4800. `docker compose ps` should say `healthy`.

**First run.** With no accounts yet, Maestro shows **Set up Maestro**. Enter your name, email and a password of at least 12 characters, then click **Create account**. This first account:

- gets the **Project Manager** and **Tech Lead** roles, so it can do everything;
- becomes the owner of anything created before accounts existed.

**Logging in.** Use your email and password. Your session lasts 7 days without use, and 30 days at most. Five wrong passwords lock the account for 15 minutes.

**Your account.** Click your name at the bottom of the menu (the avatar at the top on a phone). From there, **Change password** logs your other browsers out, and **Log out** ends this session.

**First steps after setup**, in order:

1. **Settings → AI providers**: choose who does the work (section 4).
2. **Settings → Code hosts**: add a GitHub, GitLab or Bitbucket token, unless you only use local folders.
3. **Projects → New project**: create a project (section 5).
4. **Users**: add your team (section 3).

## 2. Roles: who can do what

A person can hold several roles. Roles apply to every project the person can see.

| | Project Manager | Tech Lead | Developer |
| --- | --- | --- | --- |
| Projects they see | Those they're a member of | All | Those they're a member of |
| Board, tickets, runs, pull requests, metrics | See | See | See |
| Token usage | Everyone's | Everyone's | Their projects |
| Create, edit, move tickets by hand | Yes | Yes | Yes |
| Ask the chat | Yes | Yes | Yes |
| Start, stop or guide runs; the planner | No | Yes | Yes |
| Approve or request changes | No | Yes | Yes |
| Merge | No | Yes | No |
| Create, edit, delete projects; workflow; connectors; budgets | No | Yes | No |
| AI providers, secrets, settings, workers | No | Yes | No |
| Add or delete users, roles, password resets, project members | Yes | No | No |
| Activity log | Everyone's | Everyone's | Their own |

What you see follows your role:

- **Buttons you can't use stay visible but inert.** Hovering one shows which role it needs.
- **Pages you can't use are left out of the menu.** Users is for Project Managers, Settings for Tech Leads.
- **The engine checks every request again,** so hiding a button is a convenience, not the only lock.

## 3. People and project members

**Users page** (Project Managers only):

- **Add user**: enter a name, an email, roles and, optionally, projects. Maestro shows a **one-time password once**. Copy it and give it to the person; at their first login they must choose their own.
- **Roles**: change what someone can do. When they lose a role, their sessions end.
- **Reset password**: gives a new one-time password and logs the person out everywhere.
- **Delete**: deactivates the account. The person can no longer log in and leaves all projects, but their activity and usage stay in the history. **Reactivate** brings the account back; add it to its projects again.

There are two safeguards:

- **Maestro always keeps one active Project Manager.** To step down, first give the role to someone else.
- **Nobody can delete their own account.**

**Members tab** (on each project): this lists who can see the project. Everyone can see the list; Project Managers add and remove people. Tech Leads see every project without being members. Removing someone hides the project from them at once.

**Chat conversations are private**: only the person who started a conversation sees it.

## 4. Connecting tools (Settings)

Settings is for Tech Leads. It opens with a **System check**: anything that could stop Maestro working, with a fix. Click **Check again** after fixing something. Settings then has six steps:

**AI providers.** Choose who does the work for each role (Workers, Reviewer, Planner, Chat):

- **Claude**: an Anthropic API key, or the Claude Code login on this machine.
- **An OpenAI-compatible API**: local models (Ollama, LM Studio, vLLM) or services (OpenAI, OpenRouter, Groq, Mistral…).
  - Choose a preset, check the base URL and add a key if the service needs one, then click **Test**.
  - Ollama in Docker: use `docker-compose.local-ai.yml` with `http://localhost:11434/v1`, or `http://host.docker.internal:11434/v1`.
- **A coding CLI** such as GitHub Copilot CLI. In Docker, install it with `EXTRA_NPM_CLIS` and rebuild.
- **Choosing models**: models are picked from the provider's own list (↻ refreshes it). Workers need a model with tool calling (for example `qwen3-coder`).

**Code hosts.** Add a token for GitHub, GitLab (`api` and `write_repository` scopes) or Bitbucket (username and app password). Local folders need none. Use **Test** to check a token.

**PM tools.** Add a Jira API token, or a Trello key and token. Projects without a PM tool keep their tickets in Maestro itself.

**Design and docs.** A Figma token lets workers see linked frames. Confluence uses the Jira account.

**Workers and limits.**

- **Tickets worked on at once**, across all projects.
- **Budget per run (tokens)** and **Daily budget per project (tokens)**, with optional **€ caps**.
- **Daily budget per person (tokens)**: optional.
- **USD → EUR rate**, used for the rough € estimate.
- **How long finished worktrees are kept.**

**Notifications.** Desktop notifications in this browser.

Secrets are stored in the system keychain or in `secrets.json` (mode 600). They are never sent back to the page, and only their names appear in the activity log.

## 5. Creating a project

**Projects → New project** (Tech Leads). The wizard has five steps:

1. **Basics**: a name, a description, and **Start from**, a template (Node API, Angular, Python) that fills the quality gates and best practices.
2. **Code host**: GitHub, GitLab or Bitbucket (enter `owner/name`), or **Local folder on this machine**.
   - Click **Browse…** to pick the folder. Folders with a **git** label are repositories; Maestro also fills in the current branch.
   - The folder must be a git repository with at least one commit. Otherwise run `git init` there and commit once.
   - In Docker, only folders under `PROJECTS_DIR` are visible.
3. **Tickets**: Jira, Trello, or Maestro.
4. **Design and docs**: Figma file, Confluence pages (optional).
5. **Review**, then **Create project**.

Each project then has these tabs:

| Tab | What it holds |
| --- | --- |
| Board | Tickets by status, New ticket, Plan backlog, Auto-assign |
| Knowledge | Context, requirements, best practices (every agent reads them), and project memory |
| Workflow | The YAML that drives runs: base branch, branch names, Definition of Ready and Done, quality gates, fix attempts, review rounds, auto-assign |
| Runs | Every run with usage and who started it; the project's daily budget; Remove finished worktrees |
| Chat | Questions about this project |
| Connectors | Code host, PM tool, design and docs; Test connections; Delete project |
| Members | Who can see the project |

**Tips**

- Write the **Knowledge** tab as if for a new teammate: what the product is, how the code is laid out, and what to avoid. Agents work much better with it.
- **Quality gates** are the commands that must pass (install, lint, test, build). Keep them fast and reliable.
- A project with runs still working can't be deleted: stop them first.

## 6. Workers

**Workers** lists each worker and its state: available, working, running checks, blocked or paused. A worker takes one ticket at a time.

- **Add worker** (Tech Leads): give it a name and, optionally, its own provider and model. Without them it uses the Workers role from Settings.
- **Pause** and **Resume** take a worker out of rotation and bring it back.
- **Mark unblocked** releases a worker after a problem.
- **Stop run** stops the worker's current run.

More workers means more tickets in parallel, up to **Tickets worked on at once**.

## 7. Tickets and the board

**New ticket**: give a title, a description and **acceptance criteria**, plus a size and labels. The Definition of Ready usually requires acceptance criteria, and a size of M or less.

- **Assign to agent** starts a run. A ticket that isn't ready shows why; **Start anyway** overrides that.
- **Auto-assign** (Tech Leads): Maestro hands ready tickets to free workers every 15 seconds. It respects dependencies and per-area limits, and these runs are credited to whoever turned auto-assign on.
- **Mark done**: for In review tickets in projects without a PM tool.
- Labels `area:<name>` keep two tickets of the same area from running at once (when the workflow says so).

## 8. Runs: from ticket to review

A run goes through these steps:

1. It creates a branch and a worktree from the latest base branch.
2. The worker implements the ticket.
3. The quality gates run; when one fails, the worker fixes it (up to `max_fix_attempts`).
4. It commits the work.
5. It opens a pull request on GitHub, GitLab or Bitbucket, or leaves the branch for review for a local folder.
6. The reviewer agent checks the work against the acceptance criteria and best practices. If it requests changes, the worker continues (up to `review.max_rounds`).
7. The ticket moves to **In review**, and you get an alert.

**The run page** shows a live log (agent messages, tools, gates), the changes, usage, who started the run, and reviews. From there you can:

- **Stop** a running run.
- **Request changes**: a worker picks up your points.
- **Send to the worker**: guidance for a blocked run, which then continues.
- **Mark done** or **Approve**.
- **Approve and merge** (local folders; Tech Leads only): merges into the base branch, only into a clean tree, and stops on conflicts.
- **Remove worktree**: the branch stays.

**Pull requests** lists everything in review: CI status, the reviewer's verdict, open comments and rounds. **Check now** refreshes it; otherwise it polls every minute.

**When a run is blocked**, read the last lines of its log. Common causes are a budget or turn limit, gates that keep failing, or a missing credential. Send guidance, or fix the cause and start the run again.

If the engine restarts during a run, the run is marked failed with its branch kept. A run that was addressing review feedback goes back to review.

## 9. The planner

**Plan backlog** on the Board (Tech Leads and Developers) reads the requirements and the code, then drafts small tickets with acceptance criteria, sizes, `area:` labels and dependencies. Edit the draft, then click **Create N tickets** to send them to the PM tool, or **Discard** it. The planner uses the Planner role's model.

## 10. Ask Maestro (chat)

On the Dashboard, the chat panel answers questions about any project, ticket, pull request or run that you can see. Controls:

- **New chat (+)** starts a conversation. The dropdown switches between conversations; ✎ renames one, and the bin deletes it.
- **Minimize (−)** shrinks the chat to a bar; **Close (×)** hides it. From any page, the round chat button or **Ask Maestro** in the menu opens it in a drawer. On a phone, it opens full screen.
- **Project focus**: limits the answer to one project, which also lets the assistant read that project's code.
- **Model**: the model for this conversation.
- **Add context**: attach a ticket, run or pull request.

**Proposals.** When you ask it to do something (create or move a ticket, assign one, plan, pause a worker), it proposes the action as a card. Nothing happens until you click **Confirm**. You are only offered what your role allows: a Project Manager never gets agent work proposed.

If a project's PM tool couldn't be reached, the answer says so under it.

## 11. Usage, tokens, € and budgets

Usage is measured in **tokens** (input, output and cache; hover over a number to see the split). Next to it, in grey, is a **rough € estimate**: the provider's price per million tokens × the USD → EUR rate in Settings. Local models show **≈ €0 (local)**.

You'll find usage on:

- **Dashboard**: Usage today, and **Usage today by person**.
- **Projects** and each project's **Runs** tab.
- **Each run**, and the **Metrics** page (with **Usage by person**: tokens, runs started, success rate).

**Whose tokens are they?**

- Worker tokens count for whoever started the run.
- Chat and planner tokens count for whoever asked.
- Reviewer-agent tokens count for **Maestro**.

**Budgets** stop work before it costs too much. Each is a token cap, with an optional € cap; whichever is reached first applies.

| Budget | Where | What happens |
| --- | --- | --- |
| Per run | Settings → Workers and limits | The run is blocked; give guidance or raise the budget to continue |
| Per project per day | Settings (default), project's Runs tab (override) | Nothing new starts in that project; auto-assign pauses until tomorrow |
| Per person per day | Settings | That person can't start runs, chat or plan until tomorrow |

## 12. Activity, metrics and alerts

- **Activity** records every change, with who did it and when: logins (and failed ones), tickets, runs, reviews, merges, settings, secrets (names only), users and members. Filter by person, project, kind of action and dates. Project Managers and Tech Leads see everyone's activity in their projects; Developers see their own.
- **Metrics** (per project or all, over all time or the last 7 or 30 days) shows: runs, success rate, time to review, cycle time, first-pass review rate, fix attempts, review rounds, usage per ticket and per person.
- **Alerts** tells you when something is blocked, failed, hit a budget, or is ready for review. Turn on desktop notifications in Settings → Notifications.

## 13. Backups and recovery

**What to back up**: the data folder (`MAESTRO_DATA`, by default `~/.maestro`), mainly `maestro.db` and `secrets.json`.

**Backing up safely**: stop Maestro, or use SQLite's backup, so you don't copy a database in the middle of a write.

```bash
docker compose stop
cp -p ~/.maestro/maestro.db* ~/.maestro/backups/
docker compose start
```

or, while it runs:

```bash
sqlite3 ~/.maestro/maestro.db ".backup '$HOME/.maestro/backups/maestro-$(date +%F).db'"
```

**Restoring**: stop Maestro, put the backup back as `maestro.db` (remove `maestro.db-wal` and `maestro.db-shm`), then start it again.

**A forgotten password.** A Project Manager can use **Reset password**. If nobody can log in, run this on the machine:

```bash
docker compose exec maestro npm run user:reset -- you@example.com
```

It prints a one-time password, unlocks the account and ends its sessions.

**Upgrades** apply database changes automatically at start. Maestro refuses to open a database made by a newer version.

## 14. Good practice

- **Small tickets with clear acceptance criteria** give the best results. Use the planner to split big ones.
- **Keep quality gates green on the base branch**, or every run starts by fixing them.
- **Review before merging**: the reviewer agent helps, but you decide.
- **Pick models that fit the job**: a strong coding model for workers, a careful one for the reviewer, and a fast one for the chat.
- **Set budgets** before turning on auto-assign.
- **For a team, put Maestro behind HTTPS** (a reverse proxy such as Caddy, or a tunnel) and add the host name to `MAESTRO_ALLOWED_HOSTS`. By default it answers only on this machine.

## 15. Troubleshooting

Each error in Maestro has a code. The message says what happened, followed by how to fix it. Settings → **System check** finds most setup problems up front.

| Code | What it means | What to do |
| --- | --- | --- |
| `unauthorized` | You're not logged in, or your session ended | Log in again |
| `bad_credentials` | Wrong email or password | Check them; after 5 failures the account locks for 15 minutes |
| `locked` | Too many wrong passwords | Wait 15 minutes, or ask a Project Manager to reset your password |
| `rate_limited` | Too many login attempts from your address | Wait 15 minutes |
| `password_change_required` | You logged in with a one-time password | Choose your own on the page that opens |
| `weak_password` / `same_password` | The new password is too short, or is unchanged | Use at least 12 characters, different from the old one |
| `email_taken` / `bad_email` / `bad_name` | Adding a user failed | Use another email, or fix the field |
| `already_set_up` | Setup is done | Log in instead |
| `forbidden` | Your role can't do this; the message names the role needed | Ask someone with that role |
| `not_found` | It doesn't exist, or it's in a project you aren't a member of | Ask a Project Manager to add you to the project |
| `invalid_input` / `invalid_request` | A field is missing or wrong; the message says which | Fix the field |
| `conflict` | It conflicts with the current state (for example the last Project Manager, or your own account) | Read the message; usually do something else first |
| `folder_missing` / `folder_relative` | The local folder doesn't exist (in Docker: inside the container), or isn't a full path | Use **Browse…**; in Docker, keep repositories under `PROJECTS_DIR` |
| `not_git_repo` | The folder isn't a git repository | Run `git init` there and make a first commit |
| `repo_missing` / `repo_invalid` | The repository name is empty or wrong | Use `owner/name` as in its URL |
| `credentials_missing` | The code host's token isn't set | Settings → Code hosts |
| `workflow_invalid` | The workflow YAML is wrong | Fix it on the Workflow tab |
| `project_busy` | Runs are still working in the project | Stop them, then delete |
| `ticket_not_found` | The ticket isn't in the PM tool any more | Refresh the board |
| `ticket_not_ready` | The ticket fails the Definition of Ready (listed) | Add what's missing, or **Start anyway** |
| `already_running` | The ticket already has a run | Open that run |
| `no_workers` / `no_free_worker` / `worker_busy` | There's no available worker | Add a worker, resume a paused one, or wait |
| `concurrency_limit` | Too many tickets at once | Wait, or raise **Tickets worked on at once** |
| `budget_reached` | The project's daily budget is used | Raise it on the Runs tab, or wait until tomorrow |
| `user_budget_reached` / `limit_reached` | Your daily budget is used | Wait until tomorrow, or ask a Tech Lead |
| `provider_auth` | The AI provider refused the key | Fix the key in Settings → AI providers |
| `model_not_found` | The provider doesn't have that model | Pick another model; with Ollama, `ollama pull <model>` |
| `tools_unsupported` | The model can't use tools, which workers need | Pick a model with tool calling |
| `context_too_long` | Too much text for the model | Use a model with a larger context, raise `num_ctx` (Ollama), or split the ticket |
| `rate_limited` (provider) | The AI provider is throttling | Wait, lower parallel tickets, or switch provider |
| `provider_unavailable` / `provider_rejected` / `provider_bad_answer` | The provider failed or answered oddly | Retry; check the base URL ends in `/v1`; check its logs |
| `ai_failed` | The AI call failed for another reason | Settings → AI providers → **Test** |
| `unreachable` | A service (AI provider, Jira, GitHub…) couldn't be reached | Check it's running and the address is right; in Docker use `host.docker.internal` or host networking for local services |
| `timeout` | A service didn't answer in time | Retry; a large local model may still be loading |
| `engine_unreachable` | The page can't reach Maestro's engine | `docker compose ps`; `docker compose logs maestro` |
| `disk_full` | No space left | Remove finished worktrees; free space (`docker system prune`) |
| `permission_denied` | Maestro can't read or write a file | In Docker, set `MAESTRO_UID`/`MAESTRO_GID` to the folder owner |
| `db_busy` | Another program holds the database | Run only one engine per data folder |
| `db_corrupt` | The database file is damaged | Restore a backup (section 13) |
| `secrets_unreadable` | `secrets.json` isn't valid JSON | Fix or remove it, then re-enter tokens in Settings |
| `internal` | An unexpected error | Retry; if it persists, check `docker compose logs maestro` |

**Maestro doesn't start.** Read `docker compose logs maestro`. Startup problems are written as one line saying what went wrong, then one starting "How to fix:". Common causes:

- the port is in use (set `MAESTRO_PORT`);
- the data folder isn't writable;
- the database is in use by another engine, or damaged;
- a broken `secrets.json`.
