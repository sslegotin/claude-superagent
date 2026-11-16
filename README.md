# claude-superagent

A router/worker setup for [Claude Code](https://claude.com/claude-code). You talk to one **router** session; it hands ready tickets to **workers**, each in its own context window and git worktree, checks every result against the ticket's pass/fail checks, merges finished work into a batch branch, and delivers the batch as one PR or one merge. It comes to you only when there's a decision to make.

It follows the router/worker design of DeepSeek's [super-agent prototype](https://github.com/deepseek-ai/dsh-superagent-prototype), rebuilt for Claude Code's subagents, agent teams, worktrees and hooks.

This repository is a Claude Code plugin marketplace with two plugins:

| Plugin | What it gives you |
|---|---|
| `superagent` | `/superagent:setup`: installs the setup into a project, fills it in for that project by reading it and asking you what it can't tell, self-tests it, and upgrades it later. |
| `superagent-board` | A live pane for the router's session: tickets with progress, running agents, watchdog alerts, and a blinking dot map of every agent. |

## Requirements

- Claude Code with agent teams (setup turns on `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` for the project)
- `git` and `node` (18 or newer) in the project
- For web apps, a browser tool agents can drive from the shell, such as [agent-browser](https://github.com/vercel-labs/agent-browser)

## Install

In Claude Code:

```
/plugin marketplace add sslegotin/claude-superagent
/plugin install superagent@superagent
```

Then, in your project (a git repository with at least one commit):

```
/superagent:setup
```

Setup copies the agents, hooks, watchdog and the `write-tickets` skill into `.claude/`, works out how to install, run, lint, build and test the project, asks you about anything else (how to check work, how many workers at once, the code conventions agents follow), and verifies the result. It offers to install the board pane too.

Open the project in Claude Code once and **accept the trust prompt**: hooks inside agent files don't run in untrusted folders.

## Use

1. **Write tickets:** `/write-tickets <what you want built>`. It interviews you, then writes `specs/tickets/NNN-slug/rd.md` and `eval.md` and a board that groups tickets into batches that can be built in parallel.
2. **Mark a batch ready**, and commit `.claude/`, `CLAUDE.md` and `specs/` to `main`.
3. **Start the router:**
   ```
   claude --agent router --name router --permission-mode auto
   ```
   and tell it "run <batch>".
4. Answer its questions. Everything else happens on the branch `batch/<name>`; `main` isn't touched until you choose to open one PR or merge the batch.
5. Timings afterwards: `node .claude/hooks/metrics.cjs --batch <name>`.

## Upgrade

Update the plugin (`/plugin marketplace update superagent`), then run `/superagent:setup` again in the project. Files are replaced with the new version; the project-specific text between `<!-- PROJECT:<id> -->` markers is carried over, and any file you changed outside those markers is shown to you with a diff before anything happens to it.

A project may pin the marketplace to a reviewed commit, so plugin updates reach it only when someone moves the pin: set `"ref"` to the commit's full SHA in `extraKnownMarketplaces.superagent.source` of `.claude/settings.json` (needs Claude Code 2.1.324 or later). The setup keeps that ref on every re-run; to upgrade, move it to the new commit first.

## Uninstall

Delete from the project: `.claude/agents/{router,worker,teammate,tester,reviewer,merger,checker,reproducer,watchdog}.md`, `.claude/hooks/`, `.claude/watchdog/`, `.claude/skills/write-tickets/`, `.claude/README.md`, `.claude/superagent.json`, and from `.claude/settings.json` the `superagent` marketplace, the two `@superagent` plugin entries and `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` (unless you use agent teams otherwise). The `.claude/worktrees/` and `.job/` lines in `.gitignore` can stay. Then `/plugin uninstall superagent@superagent` and `/plugin uninstall superagent-board@superagent`.

## More

- [How it works](docs/how-it-works.md): the agents, a batch from start to finish, and what lives where.
- [Tested facts](docs/tested-facts.md): the Claude Code behaviours this setup depends on, each verified in live runs.

## Development

```
node --test 'tests/*.test.cjs'          # installer, template and privacy checks
claude plugin test plugins/superagent-board
claude plugin validate .
```

## Licence

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
