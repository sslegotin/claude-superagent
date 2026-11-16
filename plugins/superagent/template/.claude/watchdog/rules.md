# Watchdog rules

Every round (on the router's timer) the router runs `node .claude/watchdog/check.cjs`, which
applies the thresholds below and prints what it flags. The router then starts the watchdog
agent to look into each flag, using the judgment rules below. The router can ask for changes
("stop pinging about ticket 004, it's slow on purpose"); the watchdog makes them here or in
`rules.json` and says in one line what changed.

## Thresholds (rules.json)
- `interval_minutes`: how often the router runs a round (its cron job; reschedule it after changing this).
- `quiet_minutes`: an agent whose status file hasn't changed for this long has "gone quiet".
- `long_minutes`: an agent running longer than this is "running long".
- `rereport_minutes`: problems that wait on a person (`blocked`, `incomplete`, `no-status`) are repeated only after this long, or when their detail changes. Problems that need action (`went-quiet`, `running-long`, `off-track`, `waiting-on-each-other`, `stale-merge-lock`, `malformed-status`, `inspection-error`) are printed every round while they last, with `"repeat": true` and `since_minutes`, so the router can tell "still stuck after a nudge".
- `no_status_minutes`: a worktree without a status file after this long is reported.
- `lock_stale_minutes`: a `.job/merge.lock` older than this is reported as `stale-merge-lock`.
- `health_command`: a shell command that exits 0 when the main app is healthy, or `null` to skip.
- `ignore`: entries like `{"kind": "running-long", "who": "worker-004"}` to silence a known case. Keep them narrow (always name the `kind`) and remove them once the case is over.

## Judgment rules
- Check long tasks: before reporting "running long", look at the agent's last status note and
  its latest commits. If it's clearly progressing, say so in the report rather than raising an alarm.
- Ping quiet agents: for "went quiet", check whether its worktree changed recently (`git status`,
  file times). If the files are still moving, it's just not updating its status. Mention that.
- Off track: the match is read from prose, so first check the ticket's wording for an exception (e.g. "specs/* except
  this ticket's folder") or a range ("001-*.sql to 003-*.sql"). Report the exact files and the line they break, or
  say it's a false match. Never judge whether a real violation was justified; that's the router's call.
- Waiting on each other: name every agent in the loop and what each one waits for.
- Report only what the router can act on. Healthy rounds produce no message.
