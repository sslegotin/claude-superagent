#!/usr/bin/env node
// Dispatch ledger, declared in .claude/agents/router.md for PreToolUse and PostToolUse.
//
// Appends one JSON line per router action to .job/dispatch.jsonl in the main checkout, so the router's job
// list survives a context compaction or a restart, and timing metrics have real start times:
//   PreToolUse  Agent / SendMessage / TaskStop / CronCreate / CronDelete  -> what the router asked for
//   PostToolUse Agent                                                     -> the agent ID it got back
// Only the router's own calls are logged (no agent_id); teammates and subagents pass through the same hooks.
// Never blocks anything and never prints: a ledger failure must not stop the router.

const fs = require('fs');
const path = require('path');

let raw = '';
process.stdin.on('data', d => (raw += d)).on('end', () => {
  try {
    const e = JSON.parse(raw);
    if (e.agent_id) return;
    const i = e.tool_input || {};
    const line = { at: new Date().toISOString(), event: e.hook_event_name, tool: e.tool_name };
    if (e.tool_name === 'Agent') {
      Object.assign(line, { type: i.subagent_type, name: i.name, description: i.description, prompt: String(i.prompt || '').slice(0, 300) });
      if (e.hook_event_name === 'PostToolUse') {
        const out = JSON.stringify(e.tool_response ?? '');
        const id = out.match(/agent[_ ]?[Ii]d\W+([a-z0-9-]{6,})/) || out.match(/\b(a[0-9a-f]{16})\b/);
        line.agent_id = id ? id[1] : null;
        delete line.prompt;
      }
    } else if (e.tool_name === 'SendMessage') {
      Object.assign(line, { to: i.to ?? i.recipient, message: String(i.message ?? i.content ?? '').slice(0, 200) });
    } else if (e.tool_name === 'TaskStop') {
      line.task = i.task_id;
    } else {
      Object.assign(line, { cron: i.cron, prompt: i.prompt, id: i.id });
    }
    const dir = path.join(process.env.CLAUDE_PROJECT_DIR || e.cwd || process.cwd(), '.job');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'dispatch.jsonl'), JSON.stringify(line) + '\n');
  } catch {}
});
