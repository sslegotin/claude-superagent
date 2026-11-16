import { expect, test } from 'claude-code/testing'

import { applyEvents, blip, EMPTY_MAP, reconcile } from './map'
import type { RawAgent } from './model'
import type { MapState } from '../types'

const NOW = Date.parse('2026-11-16T12:00:00Z')
const agent = (id: string, status: string): RawAgent => ({ id, type: 'worker', status, description: '' })
const seats = (s: MapState) => Object.fromEntries(Object.entries(s.tracks).map(([id, t]) => [id, t.seat]))

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
  const again = applyEvents(EMPTY_MAP, [
    { kind: 'start', agentId: 'a', at: NOW },
    { kind: 'end', agentId: 'a', reason: 'error', at: NOW },
    { kind: 'start', agentId: 'a', at: NOW + 1 },
  ])
  expect(again.tracks.a?.phase).toBe('working')
  expect(applyEvents(EMPTY_MAP, [{ kind: 'end', agentId: 'x', reason: 'answer', at: NOW }]).tracks).toEqual({})
})

test('activity records the time; without an agent id it is the router', async () => {
  const s = applyEvents(EMPTY_MAP, [
    { kind: 'activity', agentId: 'a', at: NOW - 10 },
    { kind: 'activity', at: NOW - 5 },
    { kind: 'activity', agentId: 'a', at: NOW - 20 },
  ])
  expect(s.tracks.a).toMatchObject({ seat: 0, phase: 'working', lastActivity: NOW - 10 })
  expect(s.routerActivity).toBe(NOW - 5)
})

test('the agent list backs up events, and only its changes count', async () => {
  let s = reconcile(EMPTY_MAP, [agent('t', 'running')], NOW) // a teammate in its own pane: never heard
  expect(s.tracks.t?.phase).toBe('working')
  expect(s.tracks.t?.lastActivity).toBeUndefined()
  s = applyEvents(s, [{ kind: 'end', agentId: 't', reason: 'answer', at: NOW + 1 }])
  s = reconcile(s, [agent('t', 'running')], NOW + 2) // the list lags; an unchanged status doesn't undo the event
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

test('state functions never change their input', async () => {
  const before = applyEvents(EMPTY_MAP, [{ kind: 'start', agentId: 'a', at: NOW }])
  const copy = JSON.parse(JSON.stringify(before))
  applyEvents(before, [{ kind: 'end', agentId: 'a', reason: 'error', at: NOW }])
  reconcile(before, [agent('a', 'completed')], NOW)
  expect(before).toEqual(copy)
  expect(EMPTY_MAP).toEqual({ tracks: {} })
})
