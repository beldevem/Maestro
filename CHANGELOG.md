# Changelog

## Unreleased (2026-10-12)

### Added
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
