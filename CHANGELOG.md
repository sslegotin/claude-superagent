# Changelog

## superagent-board 0.2.0 (2026-11-16)

- The agent map follows each agent's lifecycle as it happens. A working dot stays lit and blinks off once for each model request or tool call its agent makes, so an agent that's running but doing nothing shows as a still dot.
- Each agent keeps its seat on the map while it runs. A finished agent's status file colours its seat instead of adding a second dot. The watchdog's investigator stays off the worker seats.

## 0.1.0 (2026-11-16)

First release.

- `superagent` plugin: `/superagent:setup` installs the router/worker setup into a project, fills its project blocks interactively, self-tests the hooks, and upgrades it on re-run while keeping the project's filled-in blocks.
- `superagent-board` plugin: a live pane with tickets, agents, watchdog alerts and a blinking agent map.
