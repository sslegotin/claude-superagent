#!/usr/bin/env node
// Stop hook declared in .claude/agents/worker.md (fires as SubagentStop).
//
// A worker may stop only when its ticket is really handed over, or when it has honestly
// marked itself blocked or failed. It runs in the worker's worktree (input.cwd), and checks:
//   1. .job/status.json exists and names the ticket folder
//   2. phase "blocked" or "failed": allow (the final message says why)
//   3. otherwise:
//      - nothing is left uncommitted (except .job/)
//      - the branch has its own commits on top of its base (the batch branch), or is already
//        merged into it
//      - the COMMITTED results are complete: verify-results.cjs at HEAD (every check has a
//        result line, cited evidence exists and isn't empty, a reviewer verdict is recorded)
// FAIL or NOT RUN results don't block here; the router judges them.
// It blocks at most once (stop_hook_active), so a stuck worker cannot loop forever. On the
// second stop it records phase "incomplete" so the router and the watchdog can see it.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
// verify-results.cjs sits next to this file. If it's missing, fall back to "results.md is committed" rather than crash
// (a crashing Stop hook lets the worker stop unchecked).
let verify;
try { ({ verify } = require('./verify-results.cjs')); } catch {
  verify = ({ ticketDir, cwd }) => {
    try { execFileSync('git', ['cat-file', '-e', `HEAD:${ticketDir}/results.md`], { cwd, stdio: 'ignore' }); return { missing: [] }; }
    catch { return { missing: [`${ticketDir}/results.md committed in HEAD (verify-results.cjs is missing next to this hook)`] }; }
  };
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const ok = (cwd, ...args) => { try { git(cwd, ...args); return true; } catch { return false; } };
const block = reason => process.stdout.write(JSON.stringify({ decision: 'block', reason }));

let raw = '';
process.stdin.on('data', d => (raw += d)).on('end', () => {
  let input;
  try { input = JSON.parse(raw); } catch { return; } // never trap a worker on a hook bug
  const cwd = input.cwd || process.cwd();
  const statusFile = path.join(cwd, '.job', 'status.json');

  let status = null;
  try { status = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch {}

  const missing = [];
  if (!status || !status.ticket_dir) {
    missing.push('.job/status.json with "ticket_dir" and "base_branch" (see "Status file" in your instructions)');
  } else if (status.phase === 'blocked' || status.phase === 'failed') {
    return; // an honest stop: the final message must say what is blocking or what failed
  } else {
    const base = status.base_branch || 'main';
    try {
      const dirty = git(cwd, 'status', '--porcelain', '--', '.', ':(exclude).job');
      if (dirty) missing.push('a commit of all your changes (git status is not clean)');
      const ahead = Number(git(cwd, 'rev-list', '--count', `${base}..HEAD`));
      if (!ahead && !ok(cwd, 'merge-base', '--is-ancestor', 'HEAD', base)) {
        missing.push(`at least one commit on your branch on top of ${base}`);
      }
    } catch (e) {
      missing.push(`a working git state (git failed: ${String(e.message).split('\n')[0]})`);
    }
    const r = verify({ ticketDir: status.ticket_dir, rev: 'HEAD', cwd });
    for (const m of r.missing) missing.push(m);
  }

  if (!missing.length) return;

  if (input.stop_hook_active) {
    // Second attempt: let it stop, but leave an honest trace.
    try {
      const next = { ...(status || {}), phase: 'incomplete', missing };
      fs.mkdirSync(path.dirname(statusFile), { recursive: true });
      fs.writeFileSync(statusFile, JSON.stringify(next, null, 2) + '\n');
    } catch {}
    return;
  }
  block(
    `Not ready to stop. Missing: ${missing.join('; ')}. ` +
    `Finish these, or if you truly cannot, set "phase" to "blocked" (with a "blocker") or "failed" in .job/status.json and say in your final message what you need or what failed.`
  );
});
