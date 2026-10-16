# Changelog

## Unreleased (2026-10-12)

### Added
- **Users page and role-aware buttons.** Project Managers manage people from a Users page. Buttons a role can't use stay visible but inert, with a tooltip naming the role needed; Users and Settings appear in the menu only for those who can use them.
- **Usage by person.** Each spend-ledger entry records whose work it was: the worker's tokens count for whoever started the run, the chat and planner for whoever asked, the reviewer agent for Maestro. The Dashboard shows today's usage by person, Metrics a table per person (tokens with the ≈ € estimate, runs started, success rate), and runs show who started them. A Tech Lead can set an optional daily token budget per person (Settings → Workers and limits), which stops that person's new runs, chat and planning for the day.
- **Activity log.** Every change made through the API is recorded with the person behind it (logins and failed logins too; the reviewer agent as Maestro), with a few safe details and never a secret value. Runs record who started them and how (by hand, from chat, or by auto-assign, credited to whoever switched it on). An Activity page filters by person, project, kind of action and dates; Project Managers and Tech Leads see everyone's activity in their projects, a Developer their own.
- **Shared projects.** Projects have members; people see only the projects they belong to (Tech Leads see all), in every list, the chat and live updates. Project Managers add and remove members (Members tab) and manage people through `/api/users` (one-time passwords, resets, deactivation; Maestro always keeps one Project Manager). Chat conversations are private to their owner.
- **Roles and permissions.** Project Manager, Tech Lead and Developer, kept in one role table (`apps/engine/src/auth/policy.ts`). The engine checks every API route against it (a route without a rule is refused), and checks chat proposals again when confirmed. A Project Manager follows progress, edits tickets, chats and manages people but never starts AI work; a Tech Lead does everything technical but doesn't manage people; a Developer works on tickets and runs in their projects but doesn't merge or change settings. Live events only reach people who can see their project.
- **Accounts and login.** A first-run setup page creates the first account (Project Manager and Tech Lead, owning existing data); then email and password login, sessions in the database (7 days idle, 30 days at most, only a hash stored), lockout after 5 wrong passwords, a change-password page, forced change of one-time passwords, and `npm run user:reset -- <email>` for recovery. Every API route now needs a session, except setup, login and the health checks.
- **Browse…** for local-folder projects: a folder picker served by the engine (browsers never reveal a folder's full path) lists subfolders inside the allowed roots (`MAESTRO_BROWSE_ROOTS`, by default the mounted projects folder in Docker or your home folder), marks git repositories, fills the path and default branch, and warns when a folder isn't a git repository or is out of Maestro's sight.
- The Dashboard chat can be minimized or closed and reopened from any page, and keeps several conversations, each with its own project focus and model.
- Usage is measured in tokens. Every agent call records input, output and cache tokens; runs, backlog drafts, the spend ledger and metrics carry them, and the dashboard shows tokens with the breakdown on hover and a rough euro estimate in grey ("≈ €0 (local)" for free models). Usage from before this change shows "n/a".
- A "USD → EUR rate" setting (0.90 by default) for those estimates; no rate is fetched online.
- Model dropdowns everywhere a model is chosen (AI roles, workers, project overrides, the chat), filled from the provider: Claude's models, an OpenAI-compatible server's `/v1/models`, or a CLI's default. Each has a refresh button, loading and error states with Retry, and "Other model…" to type a name the provider doesn't list.
- The engine refuses a model the provider doesn't offer (roles, project overrides, workers, chat model). A server that can't be reached keeps the choice.
- `GET /api/ready`: 200 once the database answers, 503 while shutting down. The Docker health check uses it.
- Leveled logs (`MAESTRO_LOG_LEVEL`) as text or JSON (`MAESTRO_LOG_FORMAT=json`), with secrets masked.
- An "Operating it" section in the README.

### Changed
- **Budgets are in tokens.** Per run: 2,000,000 tokens; per project per day: 20,000,000 tokens (both editable, 0 for no limit; a project can override its daily one). An optional euro cap sits beside each, and whichever is reached first stops the run or pauses the project. On upgrade, dollar caps you had set move into the euro caps (USD × rate) and the token caps start at their defaults; the old $5 default per run, if you never changed it, is not carried over.
- Graceful shutdown on SIGTERM and SIGINT: loops stop, running agents stop, live-update streams close, the database closes; in-flight runs are recovered on the next start.
- Database schema changes are versioned with `PRAGMA user_version` and applied once, in order; SQLite waits up to 5 seconds on a lock instead of failing.
- Outbound calls time out (30 seconds for APIs, 15 minutes for a model reply).
- Every route validates its input (ticket start, agent actions and the metrics period were the last unchecked ones).
- Docker: the Node base image is pinned by digest, and compose gives the engine 20 seconds to stop.
- Dashboard: every page except the dashboard loads on demand (initial bundle 503 kB → 383 kB).
- Dashboard: role rows adapt to their panel's width, the phone menu fits without scrolling, light-theme green meets WCAG AA contrast, the code editors have labels, an empty runs table is hidden, and a worker shows which model "default" means.

### Fixed
- Switching a role's provider no longer keeps the previous provider's model (for example Claude with `qwen3-coder:30b`).
- A leading space in your own chat messages.
