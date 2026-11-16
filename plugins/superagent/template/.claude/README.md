# Super-agent setup (router + workers) for Claude Code

One agent you talk to (the **router**) hands ready tickets to **workers**, each in its own context window and git worktree. It checks their results against the ticket's `eval.md` and comes to you only when there's a choice to make. The design follows DeepSeek's "super-agent" router/worker prototype ([deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)), rebuilt for Claude Code.

Installed and kept up to date by the `superagent` plugin (`/superagent:setup`). Edit only the text between `<!-- PROJECT:… -->` markers in the agents; setup carries it over on upgrades, and asks before replacing any other change you made.

## What's here

| Path | What it is |
|---|---|
| `agents/router.md` | The main session you talk to. Opus, high effort. Runs one batch at a time, starts agents and checks results; a hook stops it from editing anything itself. |
| `agents/watchdog.md` | Short-lived investigator. Every 10 min the router runs `watchdog/check.cjs` on a timer (CronCreate); when it flags an agent as stuck, drifting or broken, the router starts the watchdog to look into it. |
| `agents/worker.md` | Builds one solo ticket in its own worktree (made from the batch branch), with tester + reviewer, syncs with the batch and commits on its branch. |
| `agents/teammate.md` | One member of an agent team for a `team` ticket, in the main checkout. One member is the integration owner and runs the final check on the combined work. |
| `agents/tester.md` | Runs a ticket's `eval.md` checks exactly as written. |
| `agents/reviewer.md` | Reviews a diff against the ticket's `rd.md`. |
| `agents/merger.md` | All git integration: opens the batch branch, merges each finished ticket into it (lint, build, tests; rolls back on failure; never resolves conflicts), removes finished worktrees, and delivers the batch as one PR or one merge into `main`. |
| `agents/checker.md` | After each merge, walks the app like a first-time user in its own worktree of the batch, and reports confirmed breaks and the revision it checked. |
| `agents/reproducer.md` | Reproduces a bug twice and fixes it on its own branch when the fix is small. |
| `skills/write-tickets/` | Turns feature requests into `specs/tickets/NNN-slug/{rd.md, eval.md}` plus `BOARD.md`, planned for parallel work (hard waits vs overlaps) and grouped into batches. |
| `hooks/router-guard.cjs` | Blocks the router's own Write/Edit and non-read-only Bash. Teammates and subagents are not affected. |
| `hooks/worker-stop.cjs` | Won't let a worker stop until its work is committed and its committed results are complete, or it has marked itself blocked or failed. |
| `hooks/verify-results.cjs` | Checks a ticket's committed results: every check has a result, cited evidence exists, a reviewer verdict is recorded. Used by the stop hook, the router and the merger. |
| `hooks/dispatch-log.cjs` | Logs every agent the router starts, messages or stops to `.job/dispatch.jsonl`, so the router can rebuild its job list after a restart. |
| `hooks/metrics.cjs` | Timing report for a run: per-ticket start-to-merge minutes, times sent back, wall time and the real parallel width. |
| `watchdog/` | The check script, its thresholds (`rules.json`) and its judgment rules (`rules.md`). |
| `settings.json` | Setup adds: agent teams on (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), the `superagent` marketplace, and the board mod enabled for this project. Your other settings are kept. |
| `superagent.json` | Setup's record of the installed version and files, used to upgrade safely. Commit it. |
| Board mod (`superagent-board` plugin) | A live pane for the router's session: tickets with phase and progress, running agents, watchdog alerts, and a blinking dot map of every agent. Enabled for this project in `settings.json`; each person installs it once with `claude plugin install superagent-board@superagent --scope project`. `/board` shows or hides it. |

## Install into a project

1. Install the plugin: `/plugin marketplace add sslegotin/claude-superagent`, then `/plugin install superagent@superagent`.
2. Open the project in Claude Code and **accept the trust prompt**. Hooks inside agent files are skipped in untrusted folders.
3. Run `/superagent:setup`. It copies this folder in, reads the project, asks what it can't tell, fills in every project block (commands, ports, test accounts, how to verify work) and the `## Conventions` section of `CLAUDE.md`, and self-tests the scripts. It also adds `.claude/worktrees/` and `.job/` to `.gitignore`.
4. **New project with no code yet?** That works too. `git init` and make a first commit. `/superagent:setup` will ask for the stack and write a planned command contract into `CLAUDE.md`, and your first ticket creates the skeleton to match it. Re-run `/superagent:setup` after that ticket is merged.
5. Needs `node` (for the hooks and the watchdog script) and `git`. Web apps also need a browser tool the agents can drive from Bash, such as `agent-browser`.

## Use it

1. **Write tickets.** `/write-tickets <what you want built>`, or point it at a PRD. It interviews you one question at a time, then writes draft tickets and the board, grouped into **batches** (one batch = one PR), with each batch's longest chain and parallel width.
2. **Mark a batch ready.** "Make batch boards-v2 ready" (or single tickets). Only `ready` tickets get built.
3. **Commit to main.** Each batch is built on its own branch made from `main`, so `.claude/`, `CLAUDE.md` and `specs/` must be committed there first.
4. **Start the router:**
   ```
   claude --agent router --name router --permission-mode auto
   ```
   Then tell it which batch to run ("run boards-v2"), or just "go".
5. Answer its questions when it asks. Everything else (building, testing, reviewing, merging, checking, chasing bugs) happens without you, on the branch `batch/<name>`; `main` isn't touched.
6. **Deliver.** When the batch is done, the router asks: one PR, or one merge into `main`.
7. **Timings:** `node .claude/hooks/metrics.cjs --batch <name>` shows how long each ticket took and how many ran at once.

## How it works

```
you ⇄ router ──every 10 min (cron)──► check.cjs ──problems──► watchdog (investigates)
         │
         ├─ merger: open batch ─► batch/<name> branch (main checkout)
         ├─ solo ticket ─► worker (own worktree from the batch, port, test account)
         │                    ├─ tester   (runs eval.md)
         │                    ├─ reviewer (checks the diff)
         │                    └─ syncs with the batch before "ready"
         ├─ team ticket ─► teammates (named, main checkout, contract.md, one integration owner)
         ├─ passed ──────► merger (one at a time, into the batch) ─► checker (own worktree)
         ├─ bug ─────────► reproducer (one at a time, own worktree) ─► merger
         └─ batch done ──► you choose ─► merger: one PR, or one merge into main
```

- The router checks every result against `eval.md` itself and sends fixes back to the same worker, which still has its context.
- Workers and team members keep `.job/status*.json` up to date. The watchdog reads these files; the router reads them and `.job/dispatch.jsonl` to resume after a restart.
- While a team ticket works in the main checkout, no merge runs (and vice versa); only one team at a time.
- A check that didn't run is never reported as passed.

## Facts this setup relies on (tested on Claude Code 2.1.323)

- A subagent gets the tools in its own `tools:` list, even ones the router lacks.
- A **teammate can't have a tool its lead lacks**. That's why the router keeps Write/Edit/Bash, with `router-guard.cjs` blocking them for the router alone (the hook sees `agent_id` only on teammate and subagent calls).
- Frontmatter hooks run only in trusted folders. A subagent's `Stop` hook fires as `SubagentStop`, with `cwd` set to its worktree.
- Starting an agent **with a `name`** makes it a teammate while agent teams are on. Every other agent is started without one.
- The router's `Agent(...)` list limits agent types for the **whole session**: an agent type missing from it can't be started by any worker either. That's why `tester` and `reviewer` are on it.
- Agent worktrees are named `agent-<id>` and created under the **repository root's** `.claude/worktrees/`, even when the router runs in another worktree, from the router's checkout's **current** branch (the batch branch during a run; the docs say the default branch, but a live test showed otherwise). A worktree whose agent changed nothing is removed automatically. The watchdog, the router and the board find agent worktrees through git (`agent-*` only) and leave every other worktree alone.
- **Running from a dedicated worktree** (recommended in a repository where people or other tools also work): create one, e.g. `git worktree add .worktrees/superagent main`, and start the router there. Batches switch only that checkout; your main checkout is never touched.
- A background agent can't stay alive for long: it is pushed to hand back its report, and a Monitor expires after 30 minutes. So the watchdog runs on the router's CronCreate timer (DeepSeek's design: a watchdog driven by timed messages), not as a long-lived agent.
- The helper scripts are `.cjs`, so they still run when the project's `package.json` says `"type": "module"`.
- Agents don't know the clock, so the watchdog and the board take times from the files themselves, not from what agents write.
