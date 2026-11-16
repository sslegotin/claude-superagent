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
  if (!same(s.extraKnownMarketplaces[MARKETPLACE], MARKETPLACE_SOURCE)) {
    s.extraKnownMarketplaces[MARKETPLACE] = MARKETPLACE_SOURCE
    changes.push(`extraKnownMarketplaces: add "${MARKETPLACE}" (github sslegotin/claude-superagent)`)
  }
  if (LEGACY_MARKETPLACE in s.extraKnownMarketplaces) {
    delete s.extraKnownMarketplaces[LEGACY_MARKETPLACE]
    changes.push(`extraKnownMarketplaces: remove the old local "${LEGACY_MARKETPLACE}"`)
  }
  s.enabledPlugins ??= {}
  for (const id of PLUGINS) {
    if (s.enabledPlugins[id] !== true) {
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
