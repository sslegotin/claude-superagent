# Agent map driven by lifecycle events

## Why

The map's dots are worked out by polling every 2 seconds, and a green dot flickers on a made-up schedule. So a busy worker and a stuck worker that's still "running" look the same. The point of the map is to spot the stuck one at a glance.

## Goals

- Dots follow each agent's lifecycle events (`turn.start`, `turn.complete`, `turn.step`, `tool.check`) as they happen, not 2 s later.
- A working dot is steady green and **blips** (goes dark for one animation frame) each time its agent makes a model request or a tool call. A running agent that does nothing stays steady and still.
- Each agent keeps a fixed seat in the grid from the moment it starts until its dot leaves the map. A new agent takes the lowest free seat, so dots don't shuffle when another agent finishes.

## Non-goals

- The ticket list, agent list, watchdog section and status line keep working exactly as they do now.
- No new dot colours or glyphs, and the legend stays the same.

## Anti-goals

- The board must never slow down or change an agent's work. Its hooks only record the event and pass it on with `next(e)`.

## Approaches considered

- **A. Same colours, driven by events:** faster and more accurate, but the blinking stays decorative.
- **B. A plus blips for real activity (chosen):** shows a stuck agent as a still dot, which is the reason the map exists.
- **C. New dot states** (spawning, thinking vs running a tool, idle): too much to read in a grid of tiny dots.

## Dot rules (B)

| What happened to the agent | Dot |
|---|---|
| first `turn.start` carrying its `agentId` (or a later one, after a pause) | green, appears immediately |
| `turn.step` or `tool.check` carrying its `agentId` | one blip within the next second |
| turn ended `answer`, list status `idle` or `waiting` | yellow, slow pulse as today |
| turn ended `error` or `aborted`, or list status `failed` | red |
| list status `completed` | blue, then gone after 2 min (as today) |
| list status `killed` | gone |

**My calls (please check):**

- **Fallback to polling:** the 2 s `$.agent.list()` poll stays as a backstop. It catches agents that started before the board loaded or after a reload, and teammates in their own terminal pane, which send no events here. These show steady dots without blips.
- **Status-file overrides stay on top:** a worker whose status file says `blocked` or `incomplete` is red, and one with `waiting_on` set is yellow. Without this, a worker that reports itself blocked and then ends its turn would show as done.
- **Agents known only from a status file** (demo, restarts) keep today's logic and today's flicker.
- **Router dot:** it blips on its own model requests and tool calls too (events with no `agentId`).
- **Watchdog dot:** unchanged.

## Constraints

- The engine for this is the mod API, not hooks in `settings.json`. Event names and fields are as in the engine's `index.d.ts` (Claude Code 2.1.322).
- The hooks that an agent's spawn was nested in don't hear that agent's `turn.start` or `turn.step`s. A board hook on `agent.spawn`, or on `tool.call` (which wraps the router's `Agent` call while it runs), would therefore go deaf to the agents it should watch. So the board hooks none of these. An agent appears on its first `turn.start`, which comes right after its spawn. Tool calls are heard on `tool.check`, which decides on a call without running it, so nothing is nested in it. A live run confirms this (see the plan).

## Left to the builder

- Where the seat and activity state lives (module state vs an atom) and how blips reach the 500 ms frame tick.
- The pure logic (seat assignment, dot from events plus list status plus status file) goes in `model.ts`, with tests next to the existing ones in `model.test.ts`.
