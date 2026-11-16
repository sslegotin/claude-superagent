#!/usr/bin/env node
// Checks a ticket's results as they are COMMITTED (not as they sit in a working tree).
//
//   node .claude/hooks/verify-results.cjs <ticket_dir> [--rev <rev>] [--cwd <dir>]
//
//   <ticket_dir>  e.g. specs/tickets/007-allowed-moves
//   --rev         the commit or branch to read (default HEAD); WORKTREE reads the files on disk (team tickets)
//   --cwd         the repository or worktree to read from (default: current directory)
//
// Result lines may be plain ("E-3 | PASS | …"), list items ("- E-3 | PASS | …") or table rows ("| E-3 | PASS | …").
//
// Structural checks (exit 1 if any fails; the handover is incomplete):
//   - eval.md and results.md exist in that revision
//   - every check E-n named in eval.md has a result line: E-n | PASS | FAIL | NOT RUN | …
//   - every evidence file a result cites (evidence/…) exists in that revision and is not empty
//   - a reviewer verdict is recorded (APPROVE or CHANGES NEEDED, or a "Reviewer" section the user waived:
//     "not run, user chose to merge")
// Outcome (reported, never a reason to fail here: the router decides):
//   - which checks FAILED, which were NOT RUN, and which NOT RUN ones carry the user's waiver
//     ("not run, user chose to merge")
//
// Prints a short report, then one JSON line: {"ok", "missing", "failed", "notRun", "waived", "verdict"}.
// Used by the worker's Stop hook, by the router (allowed by its guard) and by the merger.

const { execFileSync } = require('child_process');
const path = require('path');

function parseArgs(argv) {
  const out = { ticketDir: null, rev: 'HEAD', cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rev') out.rev = argv[++i];
    else if (argv[i] === '--cwd') out.cwd = argv[++i];
    else if (!out.ticketDir) out.ticketDir = argv[i];
  }
  return out;
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
// --rev WORKTREE reads the files on disk instead of a commit: for a team ticket, whose work the merger commits later.
const fs = require('fs');
const show = (cwd, rev, file) => {
  if (rev === 'WORKTREE') { try { return fs.readFileSync(path.join(cwd, file), 'utf8'); } catch { return null; } }
  try { return git(cwd, 'show', `${rev}:${file}`); } catch { return null; }
};
const size = (cwd, rev, file) => {
  if (rev === 'WORKTREE') { try { return fs.statSync(path.join(cwd, file)).size; } catch { return -1; } }
  try { return Number(git(cwd, 'cat-file', '-s', `${rev}:${file}`).trim()); } catch { return -1; }
};

/** Check IDs that eval.md defines as headings: "### E-3: …" (also E-3a). */
function checkIds(evalText) {
  return [...new Set([...evalText.matchAll(/^#{2,4}\s+(E-\d+[a-z]?)\b/gm)].map(m => m[1]))];
}

/** Result lines in results.md: "E-3 | PASS | …" or table rows "| E-3 | PASS | …". The first line per ID wins. */
function results(resultsText) {
  const map = new Map();
  for (const line of resultsText.split('\n')) {
    const m = line.match(/^\s*(?:[-*]\s+|\|\s*)?(E-\d+[a-z]?)\s*\|\s*(PASS|FAIL|NOT RUN)\b([^\n]*)$/i);
    if (m && !map.has(m[1])) map.set(m[1], { result: m[2].toUpperCase(), rest: m[3] });
  }
  return map;
}

function verify({ ticketDir, rev = 'HEAD', cwd = process.cwd() }) {
  const report = { ok: true, missing: [], failed: [], notRun: [], waived: [], verdict: null };
  const miss = what => { report.ok = false; report.missing.push(what); };
  if (!ticketDir) { miss('a ticket folder argument'); return report; }
  const dir = ticketDir.replace(/\/+$/, '');

  const evalText = show(cwd, rev, `${dir}/eval.md`);
  const resultsText = show(cwd, rev, `${dir}/results.md`);
  if (evalText === null) miss(`${dir}/eval.md in ${rev}`);
  if (resultsText === null) miss(`${dir}/results.md committed in ${rev}`);
  if (evalText === null || resultsText === null) return report;

  const ids = checkIds(evalText);
  const got = results(resultsText);
  for (const id of ids) {
    const r = got.get(id);
    if (!r) { miss(`a result line for ${id}`); continue; }
    if (r.result === 'FAIL') report.failed.push(id);
    if (r.result === 'NOT RUN') (/user chose to merge/i.test(r.rest) ? report.waived : report.notRun).push(id);
    // Evidence the line cites must exist in this revision and not be empty.
    for (const m of r.rest.matchAll(/(?:^|[\s`(])((?:\.\/)?evidence\/[^\s`),;|]+)/g)) {
      const file = path.posix.join(dir, m[1].replace(/^\.\//, '').replace(/[:.,]+$/, ''));
      const bytes = size(cwd, rev, file);
      if (bytes < 0) miss(`evidence file ${file} (cited by ${id}) in ${rev}`);
      else if (bytes === 0) miss(`non-empty evidence file ${file} (cited by ${id})`);
    }
  }

  const verdict = resultsText.match(/\b(APPROVE|CHANGES NEEDED)\b/);
  const reviewSection = resultsText.match(/^#+\s*Reviewer[^\n]*\n([\s\S]*?)(?=^#|(?![\s\S]))/im);
  if (verdict) report.verdict = verdict[1];
  else if (reviewSection && /user chose to merge/i.test(reviewSection[1])) report.verdict = 'WAIVED BY USER';
  else miss('a reviewer verdict (APPROVE or CHANGES NEEDED) in results.md');
  return report;
}

module.exports = { verify, checkIds, results };

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const r = verify(args);
  const lines = [];
  lines.push(r.ok ? `OK: ${args.ticketDir} at ${args.rev} is complete.` : `INCOMPLETE: ${args.ticketDir} at ${args.rev}`);
  for (const m of r.missing) lines.push(`  missing: ${m}`);
  if (r.failed.length) lines.push(`  FAIL: ${r.failed.join(', ')}`);
  if (r.notRun.length) lines.push(`  NOT RUN (no waiver): ${r.notRun.join(', ')}`);
  if (r.waived.length) lines.push(`  NOT RUN, waived by the user: ${r.waived.join(', ')}`);
  lines.push(`  reviewer verdict: ${r.verdict ?? 'none'}`);
  process.stdout.write(lines.join('\n') + '\n' + JSON.stringify(r) + '\n');
  process.exit(r.ok ? 0 : 1);
}
