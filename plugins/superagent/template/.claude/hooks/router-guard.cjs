#!/usr/bin/env node
// PreToolUse guard declared in .claude/agents/router.md.
//
// The router keeps Write/Edit/Bash in its tool list only because agent-team teammates
// cannot have a tool their lead lacks. This hook makes "the router never builds or edits
// anything itself" a hard rule:
//   - Calls from teammates and subagents carry an agent_id and are always allowed.
//   - The router's own calls (no agent_id) may not Write/Edit/NotebookEdit, and may only
//     run the read-only Bash commands matched below.
// Verified on Claude Code 2.1.323: the lead's own calls arrive with agent_id = null,
// a teammate's arrive with agent_id set.

const READ_ONLY_BASH = [
  /^git (status|log|diff|show|rev-parse|merge-base|ls-files)( [^\s]+)*$/,
  /^git worktree list( --porcelain)?$/,
  /^gh pr (view|list|status|checks)( [^\s]+)*$/,
  /^ls( [^\s]+)*$/,
  /^pwd$/,
  /^node \.claude\/watchdog\/check\.cjs$/, // the router's watchdog round (one round, prints problems)
  /^node \.claude\/hooks\/verify-results\.cjs [^\s]+( --rev [^\s]+)?( --cwd [^\s]+)?$/, // check a ticket's committed results
];

// `git branch` lists branches only in these forms. A bare name after any flag (e.g. `git branch -v x`) would CREATE
// a branch, so names are allowed only as patterns after --list, or as the commit of --merged/--no-merged/--contains.
function readOnlyGitBranch(cmd) {
  const t = cmd.split(/\s+/);
  if (t[0] !== 'git' || t[1] !== 'branch') return false;
  let listing = false;
  for (let i = 2; i < t.length; i++) {
    const a = t[i];
    if (['-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--show-current'].includes(a)) continue;
    if (a === '--list' || a === '-l') { listing = true; continue; }
    if (['--merged', '--no-merged', '--contains', '--no-contains'].includes(a)) {
      if (t[i + 1] && !t[i + 1].startsWith('-')) i++;
      continue;
    }
    if (listing && !a.startsWith('-')) continue; // a --list pattern
    return false;
  }
  return true;
}
const SHELL_OPERATORS = /[;&|<>`$\\\n\r]|\(|\)/; // no chaining, redirection, substitution or escapes
const RISKY_FLAGS = /(^| )--(output|ext-diff|exec|upload-pack|textconv)\b|(^| )-o\b/;

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
}

let raw = '';
process.stdin.on('data', d => (raw += d)).on('end', () => {
  let input;
  try { input = JSON.parse(raw); } catch { return deny('router-guard: could not read the hook input, so the call was blocked.'); }
  if (input.agent_id) return; // a teammate or subagent: not the router

  const tool = input.tool_name;
  if (tool === 'Bash') {
    const cmd = String(input.tool_input?.command ?? '').trim();
    const ok = !SHELL_OPERATORS.test(cmd) && !RISKY_FLAGS.test(cmd) && (READ_ONLY_BASH.some(re => re.test(cmd)) || readOnlyGitBranch(cmd));
    if (ok) return;
    return deny(`The router only runs read-only commands (git status/log/diff/show/branch/worktree list, gh pr view/list/status/checks, ls, pwd, node .claude/watchdog/check.cjs, node .claude/hooks/verify-results.cjs <ticket> [--rev <rev>]), one at a time without shell operators. Blocked: ${cmd.slice(0, 200)}. Hand any real work to the right agent.`);
  }
  return deny(`The router never builds or edits anything itself (${tool} blocked). Hand this to a worker, teammate, merger or reproducer.`);
});
