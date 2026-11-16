---
name: setup
description: Install, set up, adapt, configure or upgrade the router/worker super-agent setup in this project. Copies the agents, hooks, watchdog and write-tickets skill into .claude/, fills every project block (how to install, run, lint, build and test the project, ports and test data, how to verify work in a browser, CLI or API), writes the project's Conventions, turns on agent teams and the board mod, and self-tests the scripts. Asks only what the repo can't answer. Re-run it to upgrade to a newer plugin version, or after the project's stack or commands change.
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/setup/scripts/install.cjs *)
---

# Set up the super-agent in this project

This installs a router/worker setup: one router session hands ready tickets to workers in their own git worktrees, checks their results, and delivers each batch as one PR or one merge. The agents are copied into the project's `.claude/`, where their hooks work, and filled in with this project's real commands.

The script below does everything mechanical (copying, merging settings, carrying filled blocks across upgrades, the manifest). Your part is everything that needs judgment: reading the project, asking the user, filling the blocks, and resolving conflicts.

The script, always called with the project's root:
```
node ${CLAUDE_PLUGIN_ROOT}/skills/setup/scripts/install.cjs plan   --project <root>
node ${CLAUDE_PLUGIN_ROOT}/skills/setup/scripts/install.cjs apply  --project <root> [--take <file>]... [--blocks <json file>] [--backup]
node ${CLAUDE_PLUGIN_ROOT}/skills/setup/scripts/install.cjs verify --project <root>
```
Each prints one JSON object. `{"error": …}` with exit 2 means it refused and wrote nothing; exit 1 means an unexpected failure. Tell the user why in plain words. `apply` checks every input before it writes anything, so a refusal never leaves a half-done install.

What each block needs, with examples per project type, is in `${CLAUDE_PLUGIN_ROOT}/skills/setup/blocks.md`. Read it before filling anything.

Ask the user with AskUserQuestion, **one question at a time**, with your recommendation as the first option. Never ask what the repo already answers.

## 1. Preflight

- The project root is `git rev-parse --show-toplevel`. If this isn't a git repository, offer to run `git init -b main` and make a first commit; each batch is built on a branch made from `main`, so at least one commit must exist.
- If that root is an agent's worktree (a path under `.claude/worktrees/`), stop: setup runs in the project's own checkout.
- `node --version` must work (the hooks and the watchdog are Node scripts).
- `git status --porcelain .claude CLAUDE.md`: if there are uncommitted changes, say so in one line and suggest committing first, so an upgrade is easy to review and undo. Don't block on it.

## 2. Plan

Run `plan`. First check two things it reports:
- `mainBranch: false`: the agents build every batch from a branch called `main`, and this repository has none (often it's `master`). Explain that, and offer to rename the current default branch (`git branch -m <branch> main`); run it only on a yes. If they'd rather not, stop: the setup would fail at the first batch.
- `batchRunning: true`: a batch is in progress (the checkout is on `batch/…`, or a merge lock exists). Changes now would land on the batch branch and disturb the running agents. Recommend finishing or stopping the batch first, and continue only if the user insists.

Then tell the user in two or three lines what will happen, using `mode`:
- `fresh`: a new install. List roughly what gets added.
- `upgrade` (from `from` to `to`): files replaced, filled blocks carried over, new blocks to fill (`blocks.<file>.new`), files that will be removed.
- `current`: already on this version. If the plan still lists files to add or replace, settings or `.gitignore` changes (e.g. someone deleted a hook), say so and run `apply`. Otherwise offer to re-check the blocks against the project (step 6 onwards) in case its commands changed.
- `downgrade`: the plugin on this machine is older than the setup already installed (someone upgraded it on another machine). Don't apply. Tell the user to update the plugin (`/plugin marketplace update superagent`) and run setup again.
- `adopt`: the setup was copied in by hand before this plugin existed (no `.claude/superagent.json`). See step 4.

Also mention `settings` changes and `gitignore` entries in one line each.

**Blocks the new version drops.** `blocks.<file>.droppedFilled` lists blocks that hold project text but no longer exist in the new version (a block was renamed or split). `apply` refuses until each is handled. Show the user the text, propose the new block it belongs in, and on their OK pass it with `--blocks` plus `--drop <file>:<old id>`; if it's no longer needed, pass only `--drop`.

## 3. Files the project edited (upgrade)

`edited` lists files changed outside their blocks since they were installed. For each one, show the user the difference between their file and the new version (`diff` the project file against `${CLAUDE_PLUGIN_ROOT}/template/<file>`) and ask:
- **Keep mine** (recommended when the change is project-specific): nothing to do; the file stays, and it will be offered again next upgrade.
- **Take the new version**: pass `--take <file>` to apply. Its block text is carried over; the edit outside blocks is lost.
- **Move it into a block** (often the best choice when the edit is a project rule): take the new version, then add the rule to the block it belongs in, so later upgrades carry it without asking.
- **Merge by hand**: after apply, edit the file yourself to combine both, show the user the result.

## 4. Adopt a hand-installed setup

The old agents have their project text written straight into the prompt, without block markers. Before applying:
1. For each agent file in `replace`, compare the project's version with the template's. Find the project-specific text (commands, ports, test accounts, flows, the project line, the worker cap, the merger's checks) and map it to block ids, using `blocks.md`.
2. **Print the mapping in your message before asking anything**, file by file: one line per block (`file → block id: first words of the text`). Then list any other change they made outside what maps to a block: it will not survive unless you fold it into a block, so say which block you'd put it in, or that you'd drop it. Only then ask whether to apply, and don't refer to a mapping the user hasn't seen.
3. Write the mapping to a JSON file outside the repository (e.g. in your scratchpad): `{"<file>": {"<block id>": "<text>"}}`. Block text for a multi-line block starts and ends with a newline.
4. Run `apply --backup --blocks <that file>`. The old files are copied to `.job/superagent-backup/<time>/` first; tell the user where.

`legacy` lists leftovers from hand installs: `.claude/skills/adapt-superagent/` (replaced by this command) and `.claude/mods/` (the board mod now comes from the plugin marketplace). Offer to delete them; delete only on a yes.

## 5. Apply

Run `apply` with the flags from steps 3 and 4. Report what it wrote, kept and removed in a few lines.

## 6. Learn the project

Skip what an upgrade doesn't need: only blocks that are unfilled (`verify` lists them) or that the user wants to revisit need this.

Read, briefly:
- `package.json` / `Makefile` / `pyproject.toml` / `Cargo.toml` / `go.mod`: install, run, lint, build and test commands
- README, CLAUDE.md, AGENTS.md: how the project is run and checked
- what kind of project it is: a web app (dev server and pages), an API (server, no UI), a CLI, a TUI, a library, or a mix
- where test data lives (database files, fixtures, data folders), and whether two copies can run at once without clashing (ports, database files, caches)
- `git remote -v` and `gh auth status`: delivering a batch as a PR needs a remote and `gh` signed in

### A project with no code yet

Don't guess silently:
1. Ask the user for the stack and the shape of the app (web app, API, CLI…).
2. Decide the **command contract** the first ticket must create: install, run (with the port and data location taken from the environment, so several agents can run at once), lint, build and test. Write it in `CLAUDE.md` under "Project contract", marked as planned.
3. Fill the blocks from that contract.
4. Tell the user that the first ticket must create the project skeleton with exactly those commands, and that the rest waits for it. After that ticket is merged, run `/superagent:setup` again so the blocks match what was built.

## 7. Ask what the repo can't answer

Typical questions:
- **Verification** (web apps): which browser tool the agents use. Recommend `agent-browser` (a CLI, works from Bash, one session per agent); if it isn't installed, say how. For CLIs, TUIs and APIs, propose the commands you'd use and confirm.
- **Core flows** the checker walks after every merge (propose them from the README and routes).
- **Max parallel workers** (recommend 3).
- **Conventions** (below).
- Anything you couldn't determine, like how to create a test account.

Don't ask how batches are delivered: the router asks "one PR or one local merge" when each batch is done. Only record in `merger-checks` whether a PR is possible here.

## 8. Fill the blocks

Replace the text between each block's markers, keeping the markers, following `blocks.md`: the isolation scheme, the same commands everywhere, no `eval`, no browser wording for projects without a UI, the router's project line as one sentence.

**Conventions.** Make sure `CLAUDE.md` has a `## Conventions` section: 5 to 10 concrete, checkable rules for how code is organised here, which tickets, workers and the reviewer follow. Never overwrite an existing section; offer additions instead. The default, unless the user wants otherwise:
- **Match the existing codebase.** Follow the patterns already in use; make the smallest change that meets the ticket; no new abstraction without a second user.
- Concrete rules derived from SOLID and decoupling, written for this stack: one responsibility per module; each feature in its own folder (UI, API route, types and tests together); features don't import each other's internals, only their public entry point; shared code goes in one shared place, added on purpose; dependencies point one way (UI → API client → server), never back.
- Rules that let tickets run in parallel: new features add new files rather than editing shared ones; one migration file per ticket, named after the ticket; lists every feature extends (route tables, menus) take one line per feature.

Derive the rules from the code when there is code, propose them for a new project, and ask the user to confirm or override. If they want a different standard (strict SOLID, a layered architecture), write that instead.

Then set `health_command` in `.claude/watchdog/rules.json` to a command that exits 0 when the main app is healthy (e.g. `curl -sf http://localhost:3000 >/dev/null`), or leave it `null` if nothing long-running needs checking.

## 9. Verify

Run `verify`. It must report `"ok": true`: no unfilled blocks, and every self-test passing (the router guard denies the router and lets agents through; the watchdog check runs; `verify-results` reports a missing ticket as incomplete). If a self-test fails, find out why and fix it before going on, and tell the user.

Also run the project's lint and build once, exactly as written in the blocks, to confirm they work.

## 10. The board mod

The board pane is enabled for this project in `.claude/settings.json`, but each person installs it once on their machine. Offer to run:
```
claude plugin install superagent-board@superagent --scope project
```
Run it only if the user says yes. It changes their Claude Code installation, not the project.

## 11. Hand over

Tell the user, briefly: what you filled in, the decisions they made, anything you left for them, and the next steps:
1. Open this folder in Claude Code once and accept the trust prompt. Hooks in agent files don't run in untrusted folders.
2. Commit `.claude/`, `CLAUDE.md` and `specs/` to `main`. Each batch is built on a branch made from it.
3. Write tickets with `/write-tickets`, and mark a batch ready.
4. Start the router: `claude --agent router --name router --permission-mode auto`, then "run <batch>".
5. To upgrade later: update the plugin (`/plugin update superagent@superagent` or `/plugin marketplace update superagent`), then run `/superagent:setup` again.
