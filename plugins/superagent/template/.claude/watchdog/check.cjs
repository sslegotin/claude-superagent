#!/usr/bin/env node
// Watchdog check: one round. The router runs it on its timer from the main checkout:
//
//   node .claude/watchdog/check.cjs
//
// Prints one JSON line per problem and nothing when all is well:
//   {"kind","who","ticket","detail","since_minutes","repeat"}
// Exit 0 after a completed round (with or without problems); exit 1 with a "watchdog-error" line if the
// round itself failed, so silence always means "checked, and healthy".
//
// Repeats: problems that need action (went-quiet, running-long, off-track, waiting-on-each-other,
// stale-merge-lock, malformed-status, inspection-error) are printed EVERY round while they last, with
// "repeat": true after the first time and "since_minutes" since first seen, so the router can tell
// "still stuck after a nudge". Problems that wait on a person (blocked, incomplete, no-status) repeat only
// after rules.rereport_minutes. .job/watchdog-state.json is rewritten every round; its time shows the last round.
//
// It reads status files written by the agents themselves:
//   <agent worktree>/.job/status.json       solo workers and the reproducer (agent-* worktrees, found via git)
//   .job/status-*.json                     team members in the main checkout
// Times come from the file system (file times, the worker's own commits, files it changed), never from the
// times an agent wrote: agents don't know the clock.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = process.cwd();
const HERE = path.join(ROOT, '.claude', 'watchdog');
const STATE = path.join(ROOT, '.job', 'watchdog-state.json');
const LOCK = path.join(ROOT, '.job', 'merge.lock');
const FINISHED = new Set(['done', 'reported', 'failed']);
const WAITS_ON_A_PERSON = new Set(['blocked', 'incomplete', 'no-status']);

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const tryJson = (file, fallback) => { try { return readJson(file); } catch { return fallback; } };
const gitRaw = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });

function loadRules() {
  return {
    interval_minutes: 10, quiet_minutes: 15, long_minutes: 60, rereport_minutes: 30,
    no_status_minutes: 10, lock_stale_minutes: 20, health_command: null, ignore: [],
    ...tryJson(path.join(HERE, 'rules.json'), {}),
  };
}

/** Paths in `git status --porcelain -z` output: staged, unstaged and untracked; renames give both names. */
function statusPaths(dir) {
  const out = gitRaw(dir, 'status', '--porcelain', '-z', '--untracked-files=all').split('\0');
  const paths = [];
  for (let i = 0; i < out.length; i++) {
    const e = out[i];
    if (!e) continue;
    const xy = e.slice(0, 2);
    paths.push(e.slice(3));
    if (xy[0] === 'R' || xy[0] === 'C') paths.push(out[++i]); // the original name follows a rename
  }
  return paths.filter(p => p && !p.startsWith('.job/'));
}

/** Files the worktree's own commits changed on top of its base. */
function committedPaths(dir, base) {
  return gitRaw(dir, 'diff', '--name-only', '-z', `${base}...HEAD`).split('\0').filter(Boolean);
}

/** Newest sign of life: the worker's own last commit, or any file it changed or added. */
function lastActivity(dir, base, changed) {
  let newest = 0;
  try { newest = Number(gitRaw(dir, 'log', '-1', '--format=%ct', `${base}..HEAD`).trim()) * 1000 || 0; } catch {}
  for (const p of changed.slice(0, 2000)) {
    try { newest = Math.max(newest, fs.statSync(path.join(dir, p)).mtimeMs); } catch {}
  }
  return newest;
}

/** Tickets the board already marks done: their workers are finished, whatever their status file says. */
function doneTickets() {
  const board = (() => { try { return fs.readFileSync(path.join(ROOT, 'specs', 'tickets', 'BOARD.md'), 'utf8'); } catch { return ''; } })();
  return new Set([...board.matchAll(/^\|\s*(\d{3})\s*\|[^|]*\|\s*done\s*\|/gm)].map(m => m[1]));
}

/**
 * Path patterns in a ticket's "## Do not touch" section (backticked tokens). These are read from prose, so a
 * match is a HINT: the wording may state exceptions (e.g. "specs/* except this ticket's folder").
 * Skipped: tokens inside the ticket's own folder, tokens that aren't relative paths ("/adapt-superagent").
 */
function doNotTouch(rdText, ticketDir) {
  const m = rdText.match(/^## Do not touch\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  if (!m) return [];
  return [...m[1].matchAll(/`([^`\s]+)`/g)].map(x => x[1])
    .filter(p => (p.includes('/') || p.includes('.')) && !p.startsWith('/') && !p.startsWith('-'))
    .filter(p => !(ticketDir && (p === ticketDir || p.startsWith(ticketDir + '/'))));
}
const globToRegex = g => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*') + '(/.*)?$');
const touches = (file, pattern, ticketDir) => !(ticketDir && file.startsWith(ticketDir + '/')) && globToRegex(pattern.replace(/\/$/, '')).test(file);

/**
 * The agents' worktrees: every worktree git knows whose folder is named agent-* (the name Claude Code gives the
 * worktrees it creates for `isolation: worktree`). Asking git finds them wherever they are: under this checkout's
 * .claude/worktrees/, or under the repository root's when the router runs in a dedicated worktree. Other
 * worktrees (a person's, another tool's) are never touched.
 */
function agentWorktrees() {
  let out = '';
  try { out = gitRaw(ROOT, 'worktree', 'list', '--porcelain'); } catch { return []; }
  return out.split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9))
    .filter(p => /^agent-/.test(path.basename(p)) && path.resolve(p) !== path.resolve(ROOT));
}

// Agent types that never keep a status file: a worktree of theirs without one is normal, not a problem.
const NO_STATUS_TYPES = new Set(['checker', 'tester', 'reviewer', 'merger', 'watchdog']);

/**
 * Who an agent worktree belongs to. The folder is agent-<id>, and <id> is the agent's ID, so look it up:
 * first in the router's dispatch log (.job/dispatch.jsonl, PostToolUse lines carry agent_id), then in Claude
 * Code's own record of its subagents (~/.claude/projects/<project>/<session>/subagents/agent-<id>.meta.json).
 * Returns { type, description, ticket, label }; label reads like "checker for ticket 003 (agent-a0282888)".
 */
let dispatchIndex = null;
const identities = new Map();
function identify(folder) {
  if (identities.has(folder)) return identities.get(folder);
  const id = folder.replace(/^agent-/, '');
  if (!dispatchIndex) {
    dispatchIndex = new Map();
    try {
      for (const line of fs.readFileSync(path.join(ROOT, '.job', 'dispatch.jsonl'), 'utf8').split('\n')) {
        if (!line) continue;
        try { const d = JSON.parse(line); if (d.agent_id) dispatchIndex.set(d.agent_id, { type: d.type, description: d.description }); } catch {}
      }
    } catch {}
  }
  let found = dispatchIndex.get(id);
  if (!found) {
    const projects = path.join(process.env.HOME || '', '.claude', 'projects');
    try {
      outer: for (const p of fs.readdirSync(projects)) {
        let sessions = [];
        try { sessions = fs.readdirSync(path.join(projects, p)); } catch { continue; }
        for (const sess of sessions) {
          const meta = path.join(projects, p, sess, 'subagents', `agent-${id}.meta.json`);
          if (fs.existsSync(meta)) { const m = tryJson(meta, {}); found = { type: m.agentType, description: m.description }; break outer; }
        }
      }
    } catch {}
  }
  const type = found?.type || 'agent';
  const ticket = (found?.description || '').match(/\b(\d{3})\b/)?.[1] || null;
  const what = ticket ? ` for ticket ${ticket}` : found?.description ? ` (${found.description})` : '';
  const result = { type, description: found?.description || null, ticket, label: `${type}${what} [${folder.slice(0, 14)}]` };
  identities.set(folder, result);
  return result;
}

function collectJobs(findings) {
  const jobs = [];
  for (const dir of agentWorktrees()) {
    const name = path.basename(dir);
    try {
      const file = path.join(dir, '.job', 'status.json');
      const born = fs.statSync(dir).birthtimeMs;
      let status = null;
      if (fs.existsSync(file)) {
        try { status = readJson(file); }
        catch { findings.push({ kind: 'malformed-status', who: identify(name).label, ticket: identify(name).ticket, detail: `${file} is not valid JSON` }); continue; }
      }
      const base = status?.base_branch || 'main';
      const changed = [...new Set([...statusPaths(dir), ...(() => { try { return committedPaths(dir, base); } catch { return []; } })()])];
      const fileTime = status ? fs.statSync(file).mtimeMs : 0;
      jobs.push({ where: dir, status, worktree: true, name, identity: identify(name), changed, createdMin: (Date.now() - born) / 60000, startedMs: born, updatedMs: Math.max(fileTime, lastActivity(dir, base, changed)) || undefined });
    } catch (e) {
      // The worktree vanished mid-round (cleanup) or git failed: report it, keep checking the others.
      if (fs.existsSync(dir)) findings.push({ kind: 'inspection-error', who: identify(name).label, ticket: identify(name).ticket, detail: String(e.message).split('\n')[0] });
    }
  }
  const mainJob = path.join(ROOT, '.job');
  for (const f of fs.existsSync(mainJob) ? fs.readdirSync(mainJob) : []) {
    if (!/^status-.+\.json$/.test(f)) continue;
    const file = path.join(mainJob, f);
    try {
      const st = fs.statSync(file);
      let status;
      try { status = readJson(file); }
      catch { findings.push({ kind: 'malformed-status', who: f.replace(/^status-|\.json$/g, ''), ticket: null, detail: `.job/${f} is not valid JSON` }); continue; }
      jobs.push({ where: ROOT, status, worktree: false, name: f, startedMs: st.birthtimeMs, updatedMs: st.mtimeMs });
    } catch (e) {
      if (fs.existsSync(file)) findings.push({ kind: 'inspection-error', who: f, ticket: null, detail: String(e.message).split('\n')[0] });
    }
  }
  return jobs;
}

function round(rules) {
  const problems = [];
  const add = (kind, who, ticket, detail) => {
    if (!rules.ignore.some(i => (i.kind ? i.kind === kind : true) && (i.who ? i.who === who : true) && (i.ticket ? i.ticket === ticket : true))) {
      problems.push({ kind, who, ticket: ticket ?? null, detail });
    }
  };
  const early = [];
  const done = doneTickets();
  const jobs = collectJobs(early).filter(j => !(j.status?.ticket && done.has(String(j.status.ticket))));
  for (const f of early) add(f.kind, f.who, f.ticket, f.detail);
  const byAgent = new Map();
  const teamTickets = new Map(); // ticket -> ticket_dir, for team members in the main checkout

  for (const j of jobs) {
    const s = j.status;
    if (!s) {
      const who = j.identity || { type: 'agent', ticket: null, label: j.name };
      if (j.worktree && j.createdMin > rules.no_status_minutes && !NO_STATUS_TYPES.has(who.type)) {
        add('no-status', who.label, who.ticket, `its worktree ${j.name} has no .job/status.json after ${Math.round(j.createdMin)} min`);
      }
      continue;
    }
    const who = s.agent || j.name;
    byAgent.set(who, s);
    if (FINISHED.has(s.phase)) continue;
    if (s.phase === 'incomplete') { add('incomplete', who, s.ticket, `stopped without finishing; missing: ${(s.missing || []).join('; ')}`); continue; }
    if (s.phase === 'blocked') { add('blocked', who, s.ticket, s.blocker || 'blocked, no reason given'); continue; }
    const quietMin = j.updatedMs ? (Date.now() - j.updatedMs) / 60000 : 0;
    const runMin = j.startedMs ? (Date.now() - j.startedMs) / 60000 : 0;
    if (quietMin > rules.quiet_minutes) add('went-quiet', who, s.ticket, `no activity for ${Math.round(quietMin)} min (phase: ${s.phase})`);
    if (runMin > rules.long_minutes) add('running-long', who, s.ticket, `running for ${Math.round(runMin)} min`);

    if (!s.ticket_dir) continue;
    if (!j.worktree) { teamTickets.set(String(s.ticket), s.ticket_dir); continue; } // checked once per team ticket below
    const rd = (() => { try { return fs.readFileSync(path.join(j.where, s.ticket_dir, 'rd.md'), 'utf8'); } catch { return ''; } })();
    const guarded = doNotTouch(rd, s.ticket_dir);
    const hits = j.changed.filter(f => guarded.some(p => touches(f, p, s.ticket_dir)));
    if (hits.length) add('off-track', who, s.ticket, `changed files its ticket's "Do not touch" names (a hint: check the wording for exceptions): ${hits.slice(0, 5).join(', ')}`);
  }

  // Team tickets share the main checkout: check its changes once per ticket, not once per member.
  if (teamTickets.size) {
    let changed = [];
    try { changed = statusPaths(ROOT); } catch (e) { add('inspection-error', 'main checkout', null, String(e.message).split('\n')[0]); }
    for (const [ticket, dir] of teamTickets) {
      const rd = (() => { try { return fs.readFileSync(path.join(ROOT, dir, 'rd.md'), 'utf8'); } catch { return ''; } })();
      const guarded = doNotTouch(rd, dir);
      const hits = changed.filter(f => guarded.some(p => touches(f, p, dir)));
      if (hits.length) add('off-track', `team ${ticket}`, ticket, `the main checkout has changes its "Do not touch" names (a hint: check the wording; see contract.md for who owns what): ${hits.slice(0, 5).join(', ')}`);
    }
  }

  // Agents waiting on each other in a loop.
  const seen = new Set();
  for (const start of byAgent.keys()) {
    const chain = [];
    let cur = start;
    while (cur && byAgent.has(cur) && !chain.includes(cur) && !FINISHED.has(byAgent.get(cur).phase)) { chain.push(cur); cur = byAgent.get(cur).waiting_on; }
    if (cur && chain.includes(cur)) {
      const cycle = chain.slice(chain.indexOf(cur));
      const key = [...cycle].sort().join('>');
      if (!seen.has(key)) { seen.add(key); add('waiting-on-each-other', cycle.join(' -> '), null, `${cycle.join(' -> ')} -> ${cur}`); }
    }
  }

  // A merge lock nobody released.
  if (fs.existsSync(LOCK)) {
    const ageMin = (Date.now() - fs.statSync(LOCK).mtimeMs) / 60000;
    if (ageMin > rules.lock_stale_minutes) {
      const lock = tryJson(LOCK, {});
      add('stale-merge-lock', lock.owner || 'merger', lock.ticket || null, `.job/merge.lock is ${Math.round(ageMin)} min old${lock.ticket ? ` (ticket ${lock.ticket})` : ''}; no merge should take that long`);
    }
  }

  if (rules.health_command) {
    try { execFileSync('sh', ['-c', rules.health_command], { cwd: ROOT, stdio: 'ignore', timeout: 20000 }); }
    catch { add('main-app-broken', 'main', null, `health check failed: ${rules.health_command}`); }
  }
  return problems;
}

function emit(problems, rules) {
  const state = tryJson(STATE, {});
  const now = Date.now();
  const next = {};
  for (const p of problems) {
    const key = `${p.kind}|${p.who}|${p.ticket}`;
    const prev = state[key] && typeof state[key] === 'object' ? state[key] : null;
    const first = prev?.first ?? now;
    const lastPrinted = prev?.printed ?? 0;
    const changedDetail = prev && prev.detail !== p.detail && WAITS_ON_A_PERSON.has(p.kind);
    const print = !prev || !WAITS_ON_A_PERSON.has(p.kind) || changedDetail || now - lastPrinted >= rules.rereport_minutes * 60000;
    next[key] = { first, printed: print ? now : lastPrinted, detail: p.detail };
    if (print) process.stdout.write(JSON.stringify({ ...p, since_minutes: Math.round((now - first) / 60000), repeat: !!prev }) + '\n');
  }
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, STATE);
}

try {
  const rules = loadRules();
  emit(round(rules), rules);
} catch (e) {
  process.stdout.write(JSON.stringify({ kind: 'watchdog-error', who: 'watchdog', ticket: null, detail: String(e.message).split('\n')[0] }) + '\n');
  process.exit(1);
}
