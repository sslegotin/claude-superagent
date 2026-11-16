# Agent map driven by lifecycle events: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The board's agent map shows each agent's dot from its lifecycle events, gives each agent a fixed seat, and blips a working dot once for each model request or tool call it makes.

**Architecture:** A new pure module `hooks/map.ts` holds the map's own state (seats, phase and last activity per agent id) and turns events plus the 2 s agent-list poll into dots. `register.tsx` buffers events from its hooks in module memory. The 500 ms frame tick drains the buffer into a `map` atom, the 2 s refresh reconciles that atom with `$.agent.list()`, and the pane renders the map from the atom. Everything else in the pane keeps reading the existing snapshot.

**Tech Stack:** TypeScript/TSX mod on the Claude Code mod engine (`claude-code`, `claude-code/testing`). Engine types are in `plugins/superagent-board/.claude-plugin/types/claude-code/index.d.ts`.

**Spec:** `docs/superpowers/specs/2026-11-16-agent-map-lifecycle-design.md`

## Global Constraints

- The ticket list, agent list, watchdog section, status line and legend don't change in look or behaviour.
- No new dot colours or glyphs: `DotState` stays `'working' | 'waiting' | 'blocked' | 'done' | 'free'`.
- Hooks only record and pass on. Each returns or yields `next(e)` unchanged and never awaits anything before calling it.
- Don't hook `agent.spawn` or `tool.call`. A spawn nested in a board hook would hide that agent's `turn.start` and `turn.step` from the board (spec, Constraints).
- Done dots fade after `DONE_FADE_MS = 2 * 60_000`, as today.
- Run all tests with `claude plugin test plugins/superagent-board` from the repo root.
- Work on a branch `agent-map-lifecycle`, not `main`.

## Review Focus

1. **The board reloads mid-batch:** the persisted `map` atom has tracks for agents that are gone. Expected: the next reconcile drops every track the agent list no longer has (Task 1, `reconcile drops agents the list no longer has`).
2. **An event arrives before the 2 s poll knows the agent:** a brand-new agent must not be dropped as "missing from the list". Expected: kept while heard within the last 5 s (same test).
3. **The watchdog's investigator runs as an agent:** its events arrive before the list says its type. Expected: it never takes a worker seat once the list names it `watchdog` (Task 1, `the watchdog investigator is not seated`).
4. **A teammate in its own terminal pane sends no events here:** expected: steady dot from list status, no blips (Task 1, `the agent list backs up events`).
5. **A burst of tool calls:** an agent calling tools every 100 ms. Expected: it blinks at about 1 Hz, staggered from its neighbours, and doesn't stay dark (Task 1, `a blip darkens one frame per event, staggered by seat`).

---

### Task 1: Map state from events and the agent list

**Files:**
- Create: `plugins/superagent-board/hooks/map.ts`
- Create: `plugins/superagent-board/hooks/map.test.ts`
- Modify: `plugins/superagent-board/types/index.d.ts` (add `MapTrack`, `MapState`)

**Interfaces:**
- Consumes: `RawAgent` from `hooks/model.ts` (`{ id, type, status, description, teammateId? }`).
- Produces (types in `types/index.d.ts`):
  ```ts
  export type MapTrack = {
    seat: number                                        // 0-based worker slot, fixed while the track lives
    phase: 'working' | 'waiting' | 'blocked' | 'done'
    lastActivity?: number                               // ms, last turn.step / tool.check
    lastEvent: number                                   // ms, last event or list change that touched it
    endedAt?: number                                    // ms, when it went done
    listStatus?: string                                 // last status the agent list gave, for edge-triggering
    type?: string                                       // agent type once the list names it
  }
  export type MapState = { tracks: Record<string, MapTrack>; routerActivity?: number }
  ```
- Produces (in `hooks/map.ts`):
  ```ts
  export type MapEvent =
    | { kind: 'start'; agentId: string; at: number }
    | { kind: 'activity'; agentId?: string; at: number }   // no agentId = the router (main loop)
    | { kind: 'end'; agentId: string; reason: 'answer' | 'aborted' | 'refusal' | 'error'; at: number }
  export const EMPTY_MAP: MapState                          // { tracks: {} }
  export const HEARD_GRACE_MS = 5_000
  export function applyEvents(state: MapState, events: MapEvent[]): MapState
  export function reconcile(state: MapState, list: RawAgent[], now: number): MapState
  export function blip(lastActivity: number | undefined, now: number, frame: number, seat: number): boolean // true = dark this frame
  ```
  Both state functions return a new object and never mutate their input.

Rules the functions implement:
- `applyEvents`, `start`: create the track at the lowest free seat if missing. Set phase to `working`, clear `endedAt`, set `lastEvent = at`.
- `applyEvents`, `activity` with an `agentId`: same as `start`, plus `lastActivity = max(lastActivity, at)`. Without an `agentId`: `routerActivity = max(routerActivity, at)`.
- `applyEvents`, `end`: `answer` gives phase `waiting`. `aborted`, `error` and `refusal` give `blocked`. Set `lastEvent = at`. An `end` for an unknown id is ignored.
- `reconcile`: for each list agent of type `watchdog`, delete its track. For other agents, act only when `status !== track.listStatus`:
  - `running` → `working`
  - `pending`, `waiting`, `idle` → `waiting`
  - `failed` → `blocked`
  - `completed` → `done` with `endedAt = now`
  - `killed` → delete
  - In each case store `listStatus` and `type`, and set `lastEvent = now`.
  - Don't create a track for an agent first seen as `completed` or `killed`.
- `reconcile`, deletions: delete tracks whose id isn't in the list and whose `lastEvent` is older than `HEARD_GRACE_MS`. Delete `done` tracks once `now - endedAt >= DONE_FADE_MS`.
- `blip`: dark when `lastActivity !== undefined && now - lastActivity < 1_000 && (frame + seat) % 2 === 0`.

- [ ] **Step 1: Branch**

Run: `git switch -c agent-map-lifecycle`
Expected: `Switched to a new branch 'agent-map-lifecycle'`

- [ ] **Step 2: Write the failing tests in `hooks/map.test.ts`** (`import { expect, test } from 'claude-code/testing'`, `NOW = Date.parse('2026-11-16T12:00:00Z')`)

```ts
test('an agent takes the lowest free seat and keeps it', async () => {
  let s = applyEvents(EMPTY_MAP, ['a', 'b', 'c'].map(id => ({ kind: 'start', agentId: id, at: NOW })))
  s = reconcile(s, [agent('a', 'running'), agent('b', 'killed'), agent('c', 'running')], NOW)
  expect(seats(s)).toEqual({ a: 0, c: 2 })
  s = applyEvents(s, [{ kind: 'start', agentId: 'd', at: NOW }])
  expect(seats(s)).toEqual({ a: 0, c: 2, d: 1 })
})

test('turn ends colour the dot, and a new turn turns it green again', async () => {
  const end = (reason: 'answer' | 'aborted' | 'refusal' | 'error') =>
    applyEvents(EMPTY_MAP, [{ kind: 'start', agentId: 'a', at: NOW }, { kind: 'end', agentId: 'a', reason, at: NOW }]).tracks.a?.phase
  expect(end('answer')).toBe('waiting')
  expect(end('error')).toBe('blocked')
  expect(end('aborted')).toBe('blocked')
  expect(end('refusal')).toBe('blocked')
  const again = applyEvents(EMPTY_MAP, [{ kind: 'start', agentId: 'a', at: NOW }, { kind: 'end', agentId: 'a', reason: 'error', at: NOW }, { kind: 'start', agentId: 'a', at: NOW + 1 }])
  expect(again.tracks.a?.phase).toBe('working')
  expect(applyEvents(EMPTY_MAP, [{ kind: 'end', agentId: 'x', reason: 'answer', at: NOW }]).tracks).toEqual({})
})

test('activity records the time; without an agent id it is the router', async () => {
  const s = applyEvents(EMPTY_MAP, [{ kind: 'activity', agentId: 'a', at: NOW - 10 }, { kind: 'activity', at: NOW - 5 }, { kind: 'activity', agentId: 'a', at: NOW - 20 }])
  expect(s.tracks.a).toMatchObject({ seat: 0, phase: 'working', lastActivity: NOW - 10 })
  expect(s.routerActivity).toBe(NOW - 5)
})

test('the agent list backs up events, and only its changes count', async () => {
  let s = reconcile(EMPTY_MAP, [agent('t', 'running')], NOW) // a teammate in its own pane: never heard
  expect(s.tracks.t).toMatchObject({ phase: 'working', lastActivity: undefined })
  s = applyEvents(s, [{ kind: 'end', agentId: 't', reason: 'answer', at: NOW + 1 }])
  s = reconcile(s, [agent('t', 'running')], NOW + 2) // the list lags; unchanged status doesn't undo the event
  expect(s.tracks.t?.phase).toBe('waiting')
  s = reconcile(s, [agent('t', 'completed')], NOW + 3)
  expect(s.tracks.t?.phase).toBe('done')
  expect(reconcile(s, [agent('t', 'completed')], NOW + 3 + 2 * 60_000).tracks.t).toBeUndefined()
  expect(reconcile(EMPTY_MAP, [agent('old', 'completed'), agent('k', 'killed')], NOW).tracks).toEqual({})
  expect(reconcile(EMPTY_MAP, [agent('f', 'failed')], NOW).tracks.f?.phase).toBe('blocked')
})

test('reconcile drops agents the list no longer has, but keeps one heard just now', async () => {
  const s = applyEvents(EMPTY_MAP, [{ kind: 'start', agentId: 'stale', at: NOW - 60_000 }, { kind: 'start', agentId: 'new', at: NOW - 1_000 }])
  expect(Object.keys(reconcile(s, [], NOW).tracks)).toEqual(['new'])
})

test('the watchdog investigator is not seated', async () => {
  const s = applyEvents(EMPTY_MAP, [{ kind: 'start', agentId: 'w', at: NOW }])
  expect(reconcile(s, [{ ...agent('w', 'running'), type: 'watchdog' }], NOW).tracks).toEqual({})
})

test('a blip darkens one frame per event, staggered by seat', async () => {
  const dark = (last: number | undefined, seat: number) => [0, 1, 2, 3].map(f => blip(last, NOW, f, seat))
  expect(dark(NOW - 100, 0)).toEqual([true, false, true, false])
  expect(dark(NOW - 100, 1)).toEqual([false, true, false, true])
  expect(dark(NOW - 1_500, 0)).toEqual([false, false, false, false])
  expect(dark(undefined, 0)).toEqual([false, false, false, false])
})
```

Helpers in the test file: `agent(id, status): RawAgent` → `{ id, type: 'worker', status, description: '' }`. `seats(s)` → `Object.fromEntries(Object.entries(s.tracks).map(([id, t]) => [id, t.seat]))`.

- [ ] **Step 3: Run the tests and see them fail**

Run: `claude plugin test plugins/superagent-board`
Expected: the new tests in `map.test.ts` fail (module `./map` not found). The existing tests pass.

- [ ] **Step 4: Add `MapTrack` and `MapState` to `types/index.d.ts`, and implement `hooks/map.ts`** to the rules above. Import `DONE_FADE_MS` from `model.ts` (export it there; it's currently a private `const`).

- [ ] **Step 5: Run the tests and see them pass**

Run: `claude plugin test plugins/superagent-board`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add plugins/superagent-board/hooks/map.ts plugins/superagent-board/hooks/map.test.ts plugins/superagent-board/hooks/model.ts plugins/superagent-board/types/index.d.ts docs/superpowers/specs/2026-11-16-agent-map-lifecycle-design.md docs/superpowers/plans/2026-11-16-agent-map-lifecycle.md
git commit -m "Add the agent map's own state, driven by lifecycle events"
```

---

### Task 2: Dots from map state, with status-file overrides

**Files:**
- Modify: `plugins/superagent-board/hooks/map.ts` (add `mapDots`)
- Modify: `plugins/superagent-board/hooks/model.ts:115-122` (set `id` on live agent views)
- Modify: `plugins/superagent-board/types/index.d.ts` (`AgentView.id?: string`)
- Test: `plugins/superagent-board/hooks/map.test.ts`

**Interfaces:**
- Consumes: `MapState` and `MapTrack` (Task 1). `AgentView` from `buildSnapshot` (`snap.agents`).
- Produces:
  ```ts
  /** One entry per worker slot in seat order (holes are 'free'), then agents known only from status files. */
  export function mapDots(state: MapState, views: AgentView[]): { dots: DotState[]; activity: (number | undefined)[]; seated: number }
  ```
  `AgentView.id` is the live agent's id from `$.agent.list()`. It's absent for views built from a status file alone.

Rules:
- Each track at index `seat` starts with `phase` as its dot.
- The view with the same `id` overrides it: `view.dot === 'blocked'` → `blocked`. Otherwise, `view.waitingOn` set while the phase is `working` → `waiting`.
- Seats with no track are `'free'`, up to the highest occupied seat.
- After the seats come `views.filter(v => !v.id).map(v => v.dot)` with `activity` undefined.
- `activity[i]` is the track's `lastActivity` only while its dot is `working`.
- `seated` is the number of seat slots: highest occupied seat + 1, or 0. Entries from `seated` on are file-only agents.

- [ ] **Step 1: Write the failing test**

```ts
test('map dots: seats in order with holes, status files override, file-only agents after', async () => {
  let s = applyEvents(EMPTY_MAP, ['a', 'b', 'c'].map(id => ({ kind: 'activity', agentId: id, at: NOW })))
  s = reconcile(s, [agent('a', 'running'), agent('c', 'running')], NOW + 6_000) // b is gone
  const views = [view({ id: 'a', dot: 'blocked' }), view({ id: 'c', dot: 'working', waitingOn: 'tester' }), view({ dot: 'done' })]
  expect(mapDots(s, views)).toEqual({ dots: ['blocked', 'free', 'waiting', 'done'], activity: [undefined, undefined, undefined, undefined], seated: 3 })
  expect(mapDots(s, []).activity).toEqual([NOW, undefined, NOW])
})
```

Helper: `view(p: Partial<AgentView>): AgentView` → `{ name: 'x', label: '', dot: 'working', ...p }`.

Also extend the existing test `live agents from the session win…` in `model.test.ts` with `expect(s.agents.map(a => a.id)).toEqual(['a1', 'a2', 'a3'])`.

- [ ] **Step 2: Run the tests and see them fail**

Run: `claude plugin test plugins/superagent-board`
Expected: the new test fails (`mapDots` isn't exported), and the extended model test fails (`id` undefined).

- [ ] **Step 3: Implement `mapDots` in `map.ts`, add `id?: string` to `AgentView`, and set `id: a.id` in `buildSnapshot`'s live-agent push**

- [ ] **Step 4: Run the tests and see them pass**

Run: `claude plugin test plugins/superagent-board`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/superagent-board/hooks plugins/superagent-board/types/index.d.ts
git commit -m "Work out map dots from seats, with status-file overrides"
```

---

### Task 3: Wire the hooks and draw the map from it

**Files:**
- Modify: `plugins/superagent-board/hooks/register.tsx`
- Modify: `plugins/superagent-board/types/index.d.ts` (`PluginState['superagent-board'].map: Shaped<MapState>`)
- Modify: `plugins/superagent-board/README.md` (the "Agent map" bullet)
- Test: `plugins/superagent-board/hooks/pane.test.tsx` (must still pass unchanged)

**Interfaces:**
- Consumes: `MapEvent`, `EMPTY_MAP`, `applyEvents`, `reconcile`, `blip` (Task 1). `mapDots` (Task 2). Existing `layoutMap`, `lit`, `MAP_INDENT`.
- Produces: nothing further.

What changes in `register.tsx`:
- **Atom:** `const mapState = atom({ plugin: 'superagent-board', key: 'map' } as const, EMPTY_MAP, { shape: 'map-1' })`.
- **Event buffer:** module-level `let pending: MapEvent[] = []`, plus a `record($, ev: Omit<MapEvent, 'at'>)` helper. It calls `void $.clock.now().then(at => { pending.push({ ...ev, at } as MapEvent) }).catch(() => {})` and is never awaited.
- **Hooks** (every one passes `e` on unchanged):
  - The existing `turn.start`: also `record({ kind: 'start', agentId })` when `e.agentId`.
  - The existing `turn.complete`: also `record({ kind: 'end', agentId, reason: e.reason })` when `agentId`.
  - New `on('turn.step', async function* ($, e, next) { record($, { kind: 'activity', agentId: e.agentId }); return yield* next(e) })`.
  - New `on('tool.check', async ($, e, next) => { if (e.tool_use_id) record($, { kind: 'activity', agentId: e.agentId }); return next(e) })`. Without a `tool_use_id`, it's a `$.tool.check` query, not a call.
- **Frame tick:** before its `hasBoard` check, if `pending.length`, swap the buffer for `[]` and `update($, mapState, s => applyEvents(s, drained))`.
- **Refresh:** `gather` also returns the raw `RawAgent[]` it read. After the snapshot update, `refresh` does `update($, mapState, s => reconcile(s, agents, snap.at))`.
- **Render (map only):**
  - `const m = await read($, mapState)`, `const { dots, activity } = mapDots(m, snap.agents)` and `rows = layoutMap(cols, dots)`.
  - For the cell at index `k = i * perRow + j`: a `'working'` cell with `k < seated` is lit when `!blip(activity[k], now, f, 2 + k)`. That means steady when its agent has made no request or call in the last second, which covers an agent never heard from. Every other cell, including file-only agents at `k >= seated`, keeps today's `lit(c, f, 2 + k)`.
  - `now` is `await $.clock.now()` read in the render.
  - Router dot: when `busy`, lit unless `blip(m.routerActivity, now, f, 0)`. When not busy, dim (as today).
- **README:** in the "Agent map" bullet, replace the blinking sentence with: *A working dot stays lit and blinks off once for every model request or tool call its agent makes, so an agent that's running but doing nothing stands out as a still dot; waiting dots pulse slowly, blocked dots blink together like an alarm, and the watchdog flashes a heartbeat every 2 seconds. Each agent keeps its place in the grid while it runs.*

- [ ] **Step 1: Make the changes above**

- [ ] **Step 2: Run the tests**

Run: `claude plugin test plugins/superagent-board`
Expected: all tests pass, including `the pane draws tickets, agents, watchdog alerts and the agent map` unchanged.

- [ ] **Step 3: Live check that the hooks hear subagents.** This confirms the spec's nesting constraint. Start `claude --plugin-dir plugins/superagent-board` in a throwaway git repo that has a `specs/tickets/BOARD.md` with one ready row. Open `/board` and ask Claude to run two background `general-purpose` agents that each run `ls` five times with a pause between.
Expected:
  - Two green dots appear in seats 1 and 2 within about a second of the Agent calls.
  - Each dot blinks off as its agent calls tools.
  - Each turns blue when its agent finishes and is gone after 2 minutes.
  - The router dot blinks off on its own tool calls.

  If the dots appear only after about 2 s and never blink, the hooks are not hearing the subagents' loops. Stop and report that, and don't work around it.

- [ ] **Step 4: Commit**

```bash
git add plugins/superagent-board
git commit -m "Drive the agent map from lifecycle events, blinking on each step"
```
