#!/usr/bin/env node
// Timing report for a run, from the files the setup already writes (all times from the real clock):
//   .job/dispatch.jsonl  the router's Agent calls (dispatch-log.cjs): when each worker / team member was started
//   .job/metrics.jsonl   the merger's records: when each ticket was merged, when a batch was delivered
//
//   node .claude/hooks/metrics.cjs [--batch <name>]
//
// Prints, per ticket: started, merged, minutes from start to merge, and how many times it was sent back
// (SendMessage to its agent). Then the run's wall time, the summed build time, and the most tickets that
// were being built at the same moment (the real parallel width).

const fs = require('fs');
const path = require('path');

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const read = f => { try { return fs.readFileSync(path.join(root, '.job', f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const batchArg = (() => { const i = process.argv.indexOf('--batch'); return i > 0 ? process.argv[i + 1] : null; })();

const dispatch = read('dispatch.jsonl');
const metrics = read('metrics.jsonl');
const ticketOf = line => (`${line.prompt || ''} ${line.description || ''}`.match(/tickets\/(\d{3})-|\bticket (\d{3})\b|\b(\d{3})\b/i) || []).slice(1).find(Boolean);

const tickets = new Map(); // NNN -> { start, merged, sentBack, agentIds:Set }
const get = n => { if (!tickets.has(n)) tickets.set(n, { start: null, merged: null, sentBack: 0, agentIds: new Set() }); return tickets.get(n); };

for (const d of dispatch) {
  if (d.tool === 'Agent' && (d.type === 'worker' || d.type === 'teammate')) {
    const n = ticketOf(d);
    if (!n) continue;
    const t = get(n);
    if (d.event === 'PreToolUse' && (!t.start || d.at < t.start)) t.start = d.at;
    if (d.event === 'PostToolUse' && d.agent_id) t.agentIds.add(d.agent_id);
  }
}
for (const d of dispatch) {
  if (d.tool !== 'SendMessage') continue;
  for (const t of tickets.values()) if (t.agentIds.has(d.to)) t.sentBack++;
}
for (const m of metrics) {
  if (m.event !== 'merged' || !m.ticket) continue;
  if (batchArg && m.batch !== batchArg) continue;
  const t = get(String(m.ticket));
  if (!t.merged || m.at > t.merged) t.merged = m.at;
}

const rows = [...tickets.entries()].filter(([, t]) => t.start || t.merged).sort(([a], [b]) => a.localeCompare(b));
const min = (a, b) => (Date.parse(b) - Date.parse(a)) / 60000;
const hhmm = iso => (iso ? new Date(iso).toISOString().slice(11, 16) : '  -  ');
console.log('ticket  started  merged  minutes  sent back');
let sum = 0;
for (const [n, t] of rows) {
  const m = t.start && t.merged ? min(t.start, t.merged) : null;
  if (m !== null) sum += m;
  console.log(`${n}     ${hhmm(t.start)}    ${hhmm(t.merged)}   ${m === null ? '   -' : String(Math.round(m)).padStart(4)}     ${t.sentBack}`);
}
const spans = rows.filter(([, t]) => t.start && t.merged).map(([, t]) => [Date.parse(t.start), Date.parse(t.merged)]);
if (spans.length) {
  const first = Math.min(...spans.map(s => s[0]));
  const last = Math.max(...spans.map(s => s[1]));
  let width = 0;
  for (const [s] of spans) width = Math.max(width, spans.filter(([a, b]) => a <= s && s < b).length);
  console.log(`\nwall time ${Math.round((last - first) / 60000)} min · summed build time ${Math.round(sum)} min · max parallel width ${width} · speed-up ${(sum / ((last - first) / 60000)).toFixed(1)}x`);
}
for (const m of metrics.filter(m => m.event === 'delivered' && (!batchArg || m.batch === batchArg))) console.log(`delivered ${m.batch} as ${m.how}: ${m.ref} at ${hhmm(m.at)}`);
