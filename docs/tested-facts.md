# Claude Code behaviour this setup relies on

Each fact below was checked in live runs on Claude Code 2.1.323 to 2.1.325 (November 2026), in throwaway repositories, because the docs were silent, ambiguous or wrong about it. If a newer Claude Code version changes one of them, the part of the setup named after it needs another look.

| # | Fact | What the setup does about it |
|---|---|---|
| 1 | A **subagent** gets the tools in its own definition, even ones the agent that started it lacks. | Workers, the merger and the reproducer have the tools they need; the router doesn't have to. |
| 2 | A **teammate** (agent teams) gets only its definition's tools **that its lead also has**, plus SendMessage. | The router keeps Write, Edit and Bash so its teammates can build, and a hook takes them away from the router alone (fact 4). |
| 3 | **Frontmatter hooks** in agent files run only in a **trusted folder**; otherwise they are skipped silently. Hooks in `settings.json` run either way. | Setup's hand-over and the README say: open the project once and accept the trust prompt. |
| 4 | The lead's own frontmatter hooks **also run for its teammates**. The lead's calls arrive with `agent_id` missing; teammates' and subagents' calls carry one. | `router-guard.cjs` denies Write, Edit and non-read-only Bash only when `agent_id` is missing, i.e. for the router itself. |
| 5 | A subagent's `Stop` hook fires as **`SubagentStop`**, with `cwd` set to its worktree, and can block with `{"decision":"block"}`. A second firing has `stop_hook_active: true`. `CLAUDE_PROJECT_DIR` is the main project root. | `worker-stop.cjs` keeps a worker going until its work is committed and its results are complete, and gives up on the second stop. |
| 6 | The main agent's **`Agent(type, …)` list limits agent types for the whole session**: a type missing from it can't be started by any agent. | `tester` and `reviewer` are on the router's list (workers start them); the router's prompt forbids starting them itself. |
| 7 | **Background agents can't keep themselves alive.** An agent that ends its turn to wait gets hand-back nudges and is ended; a Monitor expires after 30 minutes without the agent being told. | Workers run their tester and reviewer in the foreground and have no Monitor tool; the watchdog runs on a timer instead (fact 8). |
| 8 | A **`CronCreate`** job fires in an `--agent` session while background agents run (when the session is idle). | The router schedules a `watchdog round` every 10 minutes and deletes it when the batch is delivered. |
| 9 | `isolation: worktree` branches from the **current HEAD of the checkout the session runs in**, not from the default branch. A worktree whose agent changed nothing is removed automatically. | Workers start from the batch branch by themselves; they still merge the batch in before reporting, since other tickets land meanwhile. |
| 10 | Agent worktrees are created under the **repository root's** `.claude/worktrees/agent-<id>`, even when the session runs in another worktree. | The router, the watchdog and the board find agent worktrees through git and count only `agent-*` ones, leaving every other worktree alone. |
| 11 | In an isolated worktree, Claude Code **refuses any command containing `eval`**, and no permission setting lifts it. | No agent prompt or ticket check uses `eval`; browser checks use the tool's own commands. |
| 12 | Helper scripts named `.js` break when the project's `package.json` says `"type": "module"`, and a crashing hook lets everything through. | All scripts are `.cjs`, and `/superagent:setup` self-tests them in the project. |
| 13 | Agents invent timestamps (e.g. `00:00:00Z`). | The watchdog and the board judge freshness by file modification times, not by times agents write. |
| 14 | A teammate may report success for a write a hook actually blocked. | The router checks every result itself (`verify-results.cjs`, the evidence files) instead of trusting reports. |
