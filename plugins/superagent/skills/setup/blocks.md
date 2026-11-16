# Project blocks

Every project-specific part of the agents sits between two markers:

```
<!-- PROJECT:<id> -->
…this project's text…
<!-- /PROJECT:<id> -->
```

Replace only the text between the markers, and keep the markers: an upgrade finds the blocks by them and carries their text into the new version of each file. A block still holding `(not filled in yet: run /superagent:setup)` is unfilled.

Write plain instructions in the style of the surrounding prompt, with real commands and paths. Keep the parts that apply to this project and drop the rest.

## Rules for all blocks

- **Isolation.** Two agents running the project at the same time must never share a port, a database or data folder, or a test account. Pick one scheme, write it in `router-ports`, and write the matching specifics in each agent's run block.
- **Same commands everywhere.** Lint, build and test commands are identical in `worker-run`, `teammate-run`, `tester-run` and `merger-checks`.
- **No `eval`.** Agents in worktrees can't run any command containing `eval`. Never prescribe one; name the tool's own commands instead (for agent-browser: `storage local set|get`, `get text @ref`, `is visible @ref`, `snapshot`, `cookies`).
- **Build and run output outside the worktree** for agents that must leave it clean (the checker): e.g. `go build -o /tmp/<agent>/app`.
- **No UI, no browser wording.** For a CLI, library or API, the run blocks use commands or HTTP calls only.

The scheme that works well for web apps (main checkout on 3000):

| Agent | Where | Port | Test account |
|---|---|---|---|
| Team members, merger | main checkout | 3000 | `tNNN-<member>` |
| Solo worker on ticket NNN | own worktree | 3100+NNN (002 → 3102) | `tNNN` |
| Reproducer | own worktree | 3090 | `t090` |
| Checker | own worktree | 3080 | `t000` |

For a CLI or library: no ports; each agent uses its own data directory, e.g. `$TMPDIR/<agent>-NNN`. For an API: like the web app, plus its own database file or schema per agent.

## router-project

One sentence naming the project and what it is. It completes "You are the router for this project." Example: `Acme, a Next.js page builder.`

## router-ports

The isolation scheme for every agent, plus the **run settings line** the router adds to a worker's prompt. Web app example:

```
- Team tickets: the main checkout on port 3000; each member its own test account `tNNN-<member>`; checks that need an empty or global state run once, in the team's final pass.
- Solo worker on ticket NNN: its own worktree on port 3100+NNN (ticket 002 → 3102), test account `tNNN`. Run settings line: `Port 3102. Test account t002.`
- Reproducer: its own worktree on port 3090, test account `t090`.
- Checker: its own worktree on port 3080, test account `t000`.
```

CLI example: `Each agent keeps its test data in its own folder: solo worker on ticket NNN uses /tmp/<project>-agents/NNN. Run settings line: "Data folder /tmp/<project>-agents/002."`

## router-cap

How many solo workers may run at once. Ask the user; recommend 3. Example: `At most 3 solo workers run at once. Start more tickets only as earlier ones finish.`

## worker-run

How a worker sets up, runs and checks the project in its worktree. Node web app example:

```
- Install: `npm install`
- Run: `PORT=<your port> npm run dev -- -p <your port>` as a background job. Never use port 3000 (the main checkout's).
- Lint / build / tests: `npm run lint`, `npm run build`, `npm test`
- Test data: use only your test account and your own database file (`data/app-<NNN>.db`), never the main checkout's.
```

CLI example: install, build to `/tmp/<project>-agents/NNN/bin`, run commands against your data folder; nothing runs in the background.

## teammate-run

How team members run the project together in the main checkout. Node web app example:

```
- The team shares one dev server on port 3000. The integration owner starts it and tells the others; nobody else restarts it without telling everyone.
- Lint / build / tests: `npm run lint`, `npm run build`, `npm test`
- Test data: use only your own test account (`tNNN-<your name>`).
```

## tester-run

How checks are run. Keep the parts that apply.

Web app (agent-browser):
```
- Use your own browser session: `agent-browser --session tester-NNN open http://localhost:<port>/...`, then `snapshot`, `click @ref`, `fill @ref "text"`, `screenshot <ticket>/evidence/E-n.png`.
- Read the snapshot to judge what a user would see. Don't trust the URL alone.
- Never run `agent-browser eval`. Use its own commands: `storage local set|get`, `get text @ref`, `is visible @ref`, `snapshot`, `cookies`.
```

CLI: run the commands in eval.md with the project's test data folder; evidence is the exact output (trimmed) and the exit code.

API: `curl -s -w '\n%{http_code}'` against `http://localhost:<port>`; evidence is the status code and the relevant part of the body.

TUI: drive it in tmux (`tmux new-session -d -s tester-NNN …`, `send-keys`, `capture-pane -p`); evidence is the captured pane.

## checker-run

How the checker runs and walks the project in its own worktree, and **the core flows to walk after every merge** (ask the user to confirm them). Web app example:

```
- Run: `npm install`, then start your own server on port 3080 as a background job (never 3000: that's the main checkout's), and stop it when you're done.
- Browser: `agent-browser --session checker-<revision> open/snapshot/click/fill/screenshot`. Test account `t000`, in a fresh database each run. Never run `agent-browser eval`.
- Core flows to walk after every merge: sign up, edit a page, publish, open the published site, dashboard.
```

CLI example: build into `/tmp/<project>-checker/<revision>/`, then run the commands documented in the README against a fresh temp folder.

## reproducer-run

How the reproducer runs the project in its own worktree. Web app example:

```
- Run: `npm install`, then `npm run dev -- -p 3090` as a background job. Port 3090, test account `t090`.
- Browser: `agent-browser --session reproducer open/snapshot/click/fill/upload/screenshot`. Never run `agent-browser eval`.
```

CLI example: build from your worktree and run the reported command against a temp folder.

## merger-checks

The checks the merger runs after every merge, and what delivery is possible. Example:

```
- Verify with: `npm run lint`, `npm run build`, `npm test` (all must exit 0; `npm install` first if package.json changed)
- Main branch: `main`. Remote for PRs: `origin` (PRs need `gh` signed in)
```

If the project has no remote, or `gh` isn't signed in, say so here (`No remote: deliver batches by local merge only.`), so the router offers only what works.
