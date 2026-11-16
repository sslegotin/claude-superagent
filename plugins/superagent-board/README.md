# superagent-board

A live pane for the router/worker "super-agent" setup in Claude Code. It shows:

- **Tickets** from `specs/tickets/BOARD.md`, each with its phase, a progress bar, its runtime and the agent's latest note. At most 10 are listed: the first unfinished ones, topped up at the front with the most recently finished. Drafts are summarised in one line.
- **Agents**: every running worker, team member, merger, checker or reproducer, with how long ago it last reported
- **Watchdog**: open alerts, or "all quiet" with the time of the last round
- **Agent map**: one dot per agent, movie-style. The router and the watchdog come first, then the workers in a 3×5 grid that grows by columns when more agents run, as far as the pane's width allows. Green means working, yellow waiting or quiet, red blocked, blue done, and `·` a free slot. The dots follow each agent's lifecycle as it happens and blink like status LEDs while the pane is open: a working dot stays lit and blinks off once for every model request or tool call its agent makes, so an agent that's running but doing nothing stands out as a still dot; waiting dots pulse slowly, blocked dots blink together like an alarm, and the watchdog flashes a heartbeat every 2 seconds. Each agent keeps its place in the grid while it runs.
- A one-line summary in the status line: `▣ 1/5 done · 2 running · ⚠ 1`

It only reads files the setup already writes (`specs/tickets/BOARD.md`, `.claude/worktrees/*/.job/status.json`, `.job/status-*.json`, `.job/watchdog-state.json`), plus the session's own agent list. It never writes anything.

## Install

`/superagent:setup` enables it for the project (in `.claude/settings.json`) and offers to install it. By hand:

```
claude plugin marketplace add sslegotin/claude-superagent
claude plugin install superagent-board@superagent --scope project
```

Each person who works on the project installs it once on their machine; the project's settings only enable it.

## Use

The pane opens by itself when the terminal is wide enough (about 144 columns). `/board` opens or closes it at any width.

To try a local copy: `claude --plugin-dir <path to this folder>`. Tests: `claude plugin test <path to this folder>`.
