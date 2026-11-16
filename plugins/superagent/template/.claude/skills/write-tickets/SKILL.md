---
name: write-tickets
description: Turn feature requests into tickets that workers can build in parallel without asking questions. Each feature gets its own folder with rd.md (the requirements) and eval.md (a concrete, pass/fail way to check the feature was built correctly, including browser checks for web apps). Tickets start as draft and only become ready after the user approves them, and a board shows which tickets can run at the same time and groups them into batches (one PR each). Use this skill whenever the user asks to write tickets, spec out or scope a feature, write requirements, a PRD or acceptance criteria, break a feature list into work items, or plan features before building them, even if they never say "ticket". Use it whenever the user lists one or more things they want built and wants them written down rather than coded right away.
---

# Write Tickets

Turn each feature the user asks for into a ticket: a folder holding two files.

- **rd.md**: the requirements. What to build and why, specific enough that someone could build it without asking follow-up questions.
- **eval.md**: the check. Concrete steps that anyone, human or agent, can run on the finished work to get a clear pass or fail on each requirement, without having to judge for themselves.

The two files work as a pair. rd.md says what "done" means. eval.md proves it. Every requirement in rd.md is covered by at least one check in eval.md, and every check names the requirements it covers.

Tickets are built later by agents that can't ask anyone anything: a worker for a `solo` ticket, an agent team for a `team` ticket, coordinated by the router (`.claude/agents/router.md`). Whatever you leave unclear, they will guess.

## Workflow

### 1. Split the request into features

One ticket per feature. A feature is the smallest piece that can be shipped and checked on its own and that is worth something to a user.

- "Add auth and a dashboard" is two tickets.
- "Add a button, and make the button save the form" is one ticket, because the button is useless without the saving.
- A large epic ("build a CRM") becomes several tickets. Tell the user how you split it, so they can merge or split tickets differently if they want.

If one ticket needs another to be done first, note it. It goes in the board's Runs column (steps 7 and 8).

### 2. Read the codebase first

Tickets based on the real code are much more useful than generic ones. Before writing, look at:

- The stack, plus the scripts in `package.json` / `Makefile` / `pyproject.toml` (dev server, build, lint, test commands). eval.md should use the project's real commands.
- The files, routes, components, data models and APIs the feature will touch. Name them in rd.md under Affected areas.
- Patterns already in use (state management, styling, data fetching, test framework). Requirements shouldn't conflict with these without a stated reason.
- Any project docs (README, AGENTS.md, CLAUDE.md, framework docs in `node_modules`) that affect how the feature must be built.
- The `## Conventions` section of `CLAUDE.md`, if there is one: how code is organised in this project (where features, routes, types and tests go). Tickets must fit it, and a ticket that needs to break a convention says so and why.

Keep this short. You're checking enough to write precise tickets, not auditing the whole repo.

### 3. Interview the user until nothing is left to guess

Workers can't ask questions later, so settle everything now. Interview the user about each feature, **one question at a time**. When there's a choice, offer the options (with your recommendation first) rather than an open question. Keep going until a worker could build the feature without making any decision that changes what the user sees or gets.

- Ask about anything that changes the feature's behaviour, look, data or limits: edge cases, empty and error states, permissions, what happens to existing data.
- Don't ask about things the code already answers, or about internal details a worker can pick sensibly. Decide those yourself and record them.
- If the user doesn't answer (they're away, or they say "you decide"), go with your recommended option and record it under "Decided by the ticket writer", asking them to confirm. Never leave a question open in a ticket.

### 4. Choose the location and number

Tickets go in `specs/tickets/` at the project root. The router and the other agents read them from there.

```
specs/tickets/
├── BOARD.md
├── 001-user-login/
│   ├── rd.md
│   └── eval.md
└── 002-task-board-drag-drop/
    ├── rd.md
    └── eval.md
```

Number tickets with three digits, continuing after the highest existing number, and give each a short kebab-case slug. Never renumber existing tickets.

### 5. Write rd.md

Use `templates/rd.md`. Rules:

- Line 3 is always `**Status:** draft`. Agents read it there.
- Every functional requirement is numbered (`**FR-n**`), says "must", and can be checked. "Fast" or "nice" isn't a requirement; "loads in under 1 s with 100 rows" is.
- Names other tickets depend on (tables, columns, functions, routes, events) are written exactly and marked as a contract.
- **Affected areas** names real files. Prefer **new files** over edits to shared ones, following the project's conventions (one folder per feature, types next to the feature, a migration file per ticket named after the ticket). That's what lets tickets run in parallel.
- **Do not touch** names files the worker must leave alone, and says which ticket owns them, as backticked paths (globs like `server/migrations/001-*.sql` work). The watchdog flags changes to them; it reads them from your text, so keep exceptions short and explicit.
- **Decisions made** separates what the user agreed from what you decided while they were away.

### 6. Write eval.md

Use `templates/eval.md`. Rules:

- **Setup** gives exact commands, including the ticket's own port and test account, so agents running at the same time don't collide. Follow the project's scheme in the router's "Ports and test accounts" section (for example port 3100+NNN and account `tNNN`).
- Every check has an ID (`E-n`), a **Type** (CLI, browser, API, test), literal **Steps** and a literal **Expected** result. Someone who has never seen the app must be able to tell pass from fail.
- Browser checks use the project's browser tool (see `.claude/agents/tester.md`). Say what to click and what must appear, not "check that it works".
- **Never use `eval` in a check** (e.g. `agent-browser eval "…"`): checks run in isolated worktrees, where Claude Code refuses any command containing `eval`. Use the browser tool's own commands, e.g. `agent-browser storage local set <key> <value>` to plant data, `get text` / `is visible` / `snapshot` to read the page.
- Add **Edge case checks** for the unusual cases from the interview.
- End with **Traceability** (every FR and NFR mapped to checks) and **Definition of done**.
- **Exit codes:** when a step pipes output (`npm test | tee out.txt`), make the check read the real command's status (`set -o pipefail`, or `echo ${PIPESTATUS[0]}`), not the pipe's.
- **State:** if a check depends on data an earlier check created, or changes data a later check needs, say so in its Steps, and give a reset step (e.g. delete the test database and re-run Setup step 2) so the check can be re-run on its own.

### 7. Plan for parallel work, and group into batches

Tickets are built in parallel where they can be, so plan for it before filling in the board.

1. **Ownership map.** List, per ticket, the files its Affected areas create or change. Files that two or more tickets change are **hotspots**.
2. **Hard waits vs overlaps.** For each pair of tickets that touch each other:
   - `waits for NNN: <reason>` only when the ticket **needs NNN's output**: its schema, its API, its component, behaviour it builds on. It can't start until NNN is done.
   - `overlaps NNN: <files>` when both only **change the same files** in different places (an extra route, a new field, a line in a list). Both run at once; whichever finishes later merges the other's work into its branch first. Use a hard wait for the same files only when both rewrite the same function or component.
3. **Hotspots.** When three or more tickets hang off one hotspot, consider a small **contract ticket** that goes first and sets up the shared shape (types, a route table, an empty component the others fill in), so the rest only add new files. Each extra ticket costs a full build and merge cycle, so don't do this for two tickets.
4. **Team or solo.** `team` only for one feature whose parts must be built **at the same time** and agree on a shared shape while building (a schema, the API that writes it, the UI that reads it). Everything else is `solo`. A team works in the main checkout, which blocks merges while it runs and allows only one team at a time, so use it sparingly.
5. **Batches.** Group the tickets into **batches**: a batch is what one run of the router builds and delivers as **one PR or one merge into `main`**. Usually one request is one batch. A batch must include every ticket its tickets wait for (unless that ticket is already done on `main`). Keep batches reviewable: suggest a split above about 6 to 8 tickets. Name each batch with a short kebab-case name (`boards-v2`).
6. **Measure.** For each batch, work out the **longest chain** (the most tickets that must run one after another) and the **width** (the most that can run at once). A batch whose chain is as long as the batch has no parallelism. Look again at the hard waits before accepting that.

### 8. Update the board

Add a row per ticket to `specs/tickets/BOARD.md` (create it from `templates/BOARD.md` if missing), with the columns `# | Title | Status | Mode | Runs | Batch`:

- **Status**: `draft`.
- **Mode**: `solo` or `team` (step 7.4).
- **Runs**: `alongside`, `waits for NNN: <reason>`, or `overlaps NNN: <files>` (step 7.2). Several entries are separated by `; `.
- **Batch**: the batch name (step 7.5).

### 9. Hand over to the user

Tell the user, briefly:
- how you split the request, and the tickets you wrote (number, title, mode)
- each batch: its tickets, its **longest chain** and **width** ("batch `boards-v2`: 007–010, chain 2, up to 3 at once"), and any hotspot you resolved with a contract ticket
- any decisions you made on their behalf, to confirm. This digest is what they can actually review, so keep it to the decisions, not the whole spec
- that all tickets are `draft`, and they become buildable once marked `ready`

## Marking tickets ready

Only when the user explicitly approves: a whole batch ("make batch boards-v2 ready") or specific tickets ("make 007 and 009 ready"):

1. Set line 3 of each ticket's rd.md to `**Status:** ready`.
2. Set the Status cell of the same rows in `specs/tickets/BOARD.md` to `ready`.
3. If they mark single tickets, check the batch still includes everything those tickets wait for, and say so if not.
4. Tell them what the router will do: which batch it runs, the order (what starts at once, what waits), and the decisions they confirm by approving.
5. Remind them to **commit** `specs/` (and any `.claude/` or `CLAUDE.md` changes) to `main` before starting the router with `claude --agent router --name router --permission-mode auto`. The router builds each batch on its own branch made from `main`.

Never mark a ticket ready on your own judgment, and never set `done`. Only the merger does that.
