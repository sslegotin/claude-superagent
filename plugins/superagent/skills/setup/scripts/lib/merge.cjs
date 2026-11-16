// Merges for files the project and the setup share: .claude/settings.json, .claude/watchdog/rules.json, .gitignore.
// The setup adds or updates only its own keys; everything else in the project's files is kept.

const MARKETPLACE = 'superagent'
const MARKETPLACE_SOURCE = { source: { source: 'github', repo: 'sslegotin/claude-superagent' } }
const PLUGINS = ['superagent-board@superagent', 'superagent@superagent']
const LEGACY_MARKETPLACE = 'superagent-mods'
const LEGACY_PLUGIN = 'superagent-board@superagent-mods'
const GITIGNORE_HEADER = '# Added by the super-agent setup'
const GITIGNORE_ENTRIES = ['.claude/worktrees/', '.job/']

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function mergeSettings(settings) {
  const s = settings && typeof settings === 'object' ? settings : {}
  const changes = []
  s.env ??= {}
  if (s.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS !== '1') {
    s.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
    changes.push('env: turn on agent teams (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1)')
  }
  s.extraKnownMarketplaces ??= {}
  // A ref the project pinned (a branch, a tag or a reviewed commit's SHA) is the project's choice and stays;
  // moving it is an upgrade the project makes on purpose, not something a setup re-run does.
  const ref = s.extraKnownMarketplaces[MARKETPLACE]?.source?.ref
  const wanted = typeof ref === 'string' && ref ? { source: { ...MARKETPLACE_SOURCE.source, ref } } : MARKETPLACE_SOURCE
  if (!same(s.extraKnownMarketplaces[MARKETPLACE], wanted)) {
    s.extraKnownMarketplaces[MARKETPLACE] = wanted
    changes.push(`extraKnownMarketplaces: add "${MARKETPLACE}" (github sslegotin/claude-superagent${wanted === MARKETPLACE_SOURCE ? '' : ` at ${ref}`})`)
  }
  if (LEGACY_MARKETPLACE in s.extraKnownMarketplaces) {
    delete s.extraKnownMarketplaces[LEGACY_MARKETPLACE]
    changes.push(`extraKnownMarketplaces: remove the old local "${LEGACY_MARKETPLACE}"`)
  }
  s.enabledPlugins ??= {}
  for (const id of PLUGINS) {
    // Only add a missing entry: an explicit false is the user's choice and stays.
    if (!(id in s.enabledPlugins)) {
      s.enabledPlugins[id] = true
      changes.push(`enabledPlugins: enable ${id}`)
    }
  }
  if (LEGACY_PLUGIN in s.enabledPlugins) {
    delete s.enabledPlugins[LEGACY_PLUGIN]
    changes.push(`enabledPlugins: remove ${LEGACY_PLUGIN}`)
  }
  return { settings: s, changes }
}

// The project's values win; only keys the project lacks come from the template.
function mergeRules(project, template) {
  return { ...template, ...project }
}

function addGitignore(text) {
  const existing = new Set((text ?? '').split(/\r?\n/).map(l => l.trim()))
  const added = GITIGNORE_ENTRIES.filter(e => !existing.has(e) && !existing.has(e.replace(/\/$/, '')))
  if (added.length === 0) return { text: text ?? '', added }
  let out = text ?? ''
  if (out && !out.endsWith('\n')) out += '\n'
  if (out) out += '\n'
  out += `${GITIGNORE_HEADER}\n${added.join('\n')}\n`
  return { text: out, added }
}

module.exports = { mergeSettings, mergeRules, addGitignore, PLUGINS, MARKETPLACE }
