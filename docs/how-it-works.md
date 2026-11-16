# How it works

## The pieces

| Agent | Runs where | Does |
|---|---|---|
| **router** | your session (`claude --agent router`) | Talks to you, runs one batch at a time, starts the other agents, checks every result against the ticket's `eval.md`, and asks you only when there's a decision. A hook stops it from editing anything itself. |
| **worker** | its own git worktree, made from the batch branch | Builds one `solo` ticket, has its own tester and reviewer check it, fixes what they find, merges the latest batch in, commits on its branch. |
| **teammate** | the main checkout | One member of an agent team for a `team` ticket. Members agree a `contract.md` (who owns which files), build their parts, and one integration owner runs the final full check. |
| **tester** | wherever its worker or team runs | Runs `eval.md` literally and returns PASS / FAIL / NOT RUN per check with evidence. |
| **reviewer** | same | Reads the diff against `rd.md`: missing requirements, out-of-scope changes, real bugs, convention breaks. |
| **merger** | the main checkout | All git integration: opens `batch/<name>`, merges one finished ticket at a time (lint, build, tests; rolls back on failure; never resolves conflicts), removes finished worktrees, delivers the batch. |
| **checker** | its own worktree of the batch | After each merge, uses the new feature and the flows around it like a newcomer; reports only breaks it saw twice. |
| **reproducer** | its own worktree | Makes a reported bug happen twice and fixes it on its own branch when the fix is small. |
| **watchdog** | short-lived | Investigates what a watchdog round flagged and tells the router what it means. |

## A batch, start to finish

```
you ⇄ router ──every 10 min (cron)──► check.cjs ──problems──► watchdog (investigates)
         │
         ├─ merger: open batch ─► batch/<name> branch (main checkout)
         ├─ solo ticket ─► worker (own worktree from the batch, own port and test data)
         │                    ├─ tester   (runs eval.md)
         │                    ├─ reviewer (checks the diff)
         │                    └─ merges the batch in before "ready"
         ├─ team ticket ─► teammates (named, main checkout, contract.md, one integration owner)
         ├─ passed ──────► merger (one at a time, into the batch) ─► checker (own worktree)
         ├─ bug ─────────► reproducer (one at a time, own worktree) ─► merger
         └─ batch done ──► you choose ─► merger: one PR, or one merge into main
```

1. **Tickets.** `/write-tickets` interviews you and writes `specs/tickets/NNN-slug/rd.md` (requirements) and `eval.md` (pass/fail checks), plus `specs/tickets/BOARD.md`. It plans for parallel work: which tickets truly wait for others, which only overlap in files, and groups them into batches. Tickets start as `draft`; you mark a batch `ready`.
2. **Start.** The router checks the batch is complete (everything its tickets wait for is done or in the batch), schedules the watchdog rounds, has the merger open `batch/<name>`, and starts every ticket that can run now, up to the worker cap.
3. **Build.** Workers build in parallel in their own worktrees, each with its own port and test data, so they never collide. A team ticket runs in the main checkout and holds it: no merge runs meanwhile.
4. **Check.** When an agent says it's done, the router runs `verify-results.cjs` on the committed results (every check has a result, cited evidence exists, a reviewer verdict is recorded), reads the evidence, and sends gaps back to the same agent, which still has its context.
5. **Merge.** The merger lands one ticket at a time on the batch branch and runs the project's checks; a failure rolls the merge back. A conflict goes back to the worker ("sync with the batch"). After each merge the checker walks the result, and tickets that waited on it start.
6. **Deliver.** When every ticket is done (or left out with a reason), the router asks: one PR, or one local merge into `main`. `main` is untouched until then.

## Keeping it on track

- Workers and team members write `.job/status*.json` as they go. The router rebuilds its job list from those files, `git worktree list` and its own `.job/dispatch.jsonl` after a restart or a context compaction, so it never starts a ticket twice.
- Every 10 minutes a cron job makes the router run `watchdog/check.cjs`, which flags agents that went quiet, run long, touch files their ticket forbids, wait on each other in a loop, or a stale merge lock, or the main app being down. The router starts the watchdog agent only when something is flagged.
- A worker can't stop until its work is committed and its results are complete, or it has said it's blocked or failed (`worker-stop.cjs`).
- A check that didn't run is never reported as passed. Only you can waive it ("not run, user chose to merge").

## What lives where in a project

| Path | Owner | On upgrade |
|---|---|---|
| `.claude/agents/`, `.claude/hooks/`, `.claude/watchdog/` (scripts), `.claude/skills/write-tickets/`, `.claude/README.md` | plugin | replaced; text between `<!-- PROJECT:<id> -->` markers is carried over; files you edited elsewhere are offered to you first |
| `.claude/settings.json`, `.claude/watchdog/rules.json`, `.gitignore` | shared | setup adds its keys and keeps yours |
| `.claude/superagent.json` | plugin | the installed version and file hashes; commit it |
| `CLAUDE.md`, `specs/` | you | never overwritten |
| `.claude/worktrees/`, `.job/` | runtime | git-ignored; never touched by setup |

The Claude Code behaviours this relies on, and how each was verified, are in [tested-facts.md](tested-facts.md).
