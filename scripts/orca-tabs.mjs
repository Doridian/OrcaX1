// Reads the layout of OrcaSlicer's filament and printer settings tabs
// (TabFilament::build and TabPrinter::build_fff in src/slic3r/GUI/Tab.cpp).
//
// Unlike TabPrint::build, these are not a flat list of append calls: they use
// helper lambdas, loops over key lists, Option variables with relabelled
// options, helper member functions and (for the printer) pages that are built
// per extruder. This is a small statement interpreter for the subset of C++
// those functions use. Anything it does not understand that looks like it adds
// options to the tab is an error, so a new Orca version that changes the
// layout fails the build instead of silently losing settings.

import { parseOptionDefs, readStrings, splitArgs, stringExpr } from './orca-config.mjs'

/** Source without comments, with `#if 0` / `#if 1 ... #else` resolved. */
function preprocess(src) {
  let out = ''
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '"' || c === "'") {
      const j = i
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++
      out += src.slice(j, i + 1)
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2)
      out += src.slice(i, e < 0 ? src.length : e).replace(/[^\n]/g, '')
      i = e < 0 ? src.length : e + 1
      out += ' '
    } else out += c
  }
  // Preprocessor: keep the live branch of #if 0 / #if 1; leave other conditionals as they are.
  const lines = out.split('\n')
  const res = []
  const stack = [] // { live, decided } for #if 0/1, null for other conditionals
  const live = () => stack.every((s) => s === null || s.live)
  for (const l of lines) {
    const t = l.trim()
    let m
    if ((m = /^#\s*if\s+([01])\b/.exec(t))) { stack.push({ live: m[1] === '1' }); continue }
    if (/^#\s*if/.test(t)) { stack.push(null); if (live()) res.push(l); continue }
    if (/^#\s*else\b/.test(t)) {
      const s = stack[stack.length - 1]
      if (s) s.live = !s.live
      else if (live()) res.push(l)
      continue
    }
    if (/^#\s*endif\b/.test(t)) { const s = stack.pop(); if (s === null && live()) res.push(l); continue }
    if (live()) res.push(l)
  }
  return res.join('\n')
}

/** Index just past the bracket matching the one at s[i]. */
function matchBracket(s, i) {
  let depth = 0
  for (; i < s.length; i++) {
    const c = s[i]
    if (c === '"' || c === "'") { for (i++; i < s.length && s[i] !== c; i++) if (s[i] === '\\') i++; continue }
    if ('({['.includes(c)) depth++
    else if (')}]'.includes(c) && --depth === 0) return i + 1
  }
  throw new Error('unbalanced brackets')
}

/** Body (between the braces) of the member function Class::name, or null. */
function functionBody(src, qualified) {
  const m = new RegExp(`\\n[\\w:<>\\s*&]*\\b${qualified.replace(/:/g, '\\:')}\\s*\\(`).exec(src)
  if (!m) return null
  const paren = m.index + m[0].length - 1
  const open = src.indexOf('{', matchBracket(src, paren))
  return src.slice(open + 1, matchBracket(src, open) - 1)
}

/** Top-level statements: split at `;`, and after a `{...}` block that closes at depth 0. */
function statements(code) {
  const out = []
  let start = 0, depth = 0, braceStart = -1
  for (let i = 0; i < code.length; i++) {
    const c = code[i]
    if (c === '"' || c === "'") { for (i++; i < code.length && code[i] !== c; i++) if (code[i] === '\\') i++; continue }
    if ('({['.includes(c)) { if (depth === 0 && c === '{') braceStart = i; depth++ }
    else if (')}]'.includes(c)) {
      depth--
      if (depth === 0 && c === '}' && braceStart >= 0) {
        // A block statement (if/for/{...}) ends here; an initializer or lambda ends at the following `;`.
        const head = code.slice(start, braceStart).trim()
        if (head === '' || /^(if|for|else|while|do)\b/.test(head)) {
          out.push(code.slice(start, i + 1).trim())
          start = i + 1
        }
        braceStart = -1
      }
    } else if (c === ';' && depth === 0) {
      out.push(code.slice(start, i).trim())
      start = i + 1
    }
  }
  if (code.slice(start).trim()) out.push(code.slice(start).trim())
  return out.filter((s) => s !== '')
}

/** `(...)` at s[i] (after whitespace): [inside, rest]. */
function parenGroup(s) {
  const i = s.indexOf('(')
  const e = matchBracket(s, i)
  return [s.slice(i + 1, e - 1), s.slice(e).trim()]
}

const unblock = (s) => (s.startsWith('{') && s.endsWith('}') ? s.slice(1, -1) : s)

// Statements that add something to the tab.
const LAYOUT = /add_options_page|new_optgroup|append_single_option_line|append_option|append_line|get_option\s*\(|create_line_with_widget|\bOption\b/

/**
 * Runs the body of `Class::fn`, appending to `pages`.
 * opts.conds: condition text -> boolean, for `if`s around layout code.
 * opts.vars: values of string variables used as page titles.
 * opts.counters: loop variables of counting `for` loops, run once with 0 (one extruder).
 */
function runFunction(src, cls, fn, opts, pages = []) {
  const body = functionBody(src, `${cls}::${fn}`)
  if (body === null) throw new Error(`${cls}::${fn} not found in Tab.cpp`)
  // Member functions of this tab class that add layout, so calls to them are followed.
  const members = new Set()
  for (const m of src.matchAll(new RegExp(`\\n[\\w:<>\\s*&]*\\b${cls}::(\\w+)\\s*\\(`, 'g'))) {
    const b = functionBody(src, `${cls}::${m[1]}`)
    if (b && /add_options_page|new_optgroup/.test(b)) members.add(m[1])
  }
  const ctx = {
    where: `${cls}::${fn}`, pages, page: null, groups: {}, lines: {}, options: {},
    lists: {}, vars: { ...opts.vars }, lambdas: {}, lastIf: null,
  }
  const run = (code) => { for (const st of statements(code)) exec(st) }
  const relevant = (s) => LAYOUT.test(s) || Object.keys(ctx.lambdas).some((n) => new RegExp(`\\b${n}\\s*\\(`).test(s))
    || [...members].some((n) => new RegExp(`\\b${n}\\s*\\(`).test(s))
  const fail = (st, why = 'unrecognized layout statement') => {
    throw new Error(`${ctx.where}: ${why}: ${st.replace(/\s+/g, ' ').slice(0, 200)}`)
  }

  /** Value of a string expression: literals, L("..."), variables, joined with +. */
  const str = (expr, st) => {
    let out = ''
    for (const part of splitPlus(expr)) {
      const p = part.trim()
      const lit = stringExpr(p)
      if (lit !== null) out += lit
      else if (p in ctx.vars) out += ctx.vars[p]
      else fail(st, `can't evaluate "${p}"`)
    }
    return out
  }
  /** Key of an option reference: optgroup->get_option("key"[, i]) or an Option variable. */
  const optionRef = (expr, st) => {
    const g = /^\w+->get_option\s*\(([\s\S]*)\)$/.exec(expr.trim())
    if (g) return { key: str(splitArgs(g[1])[0], st) }
    if (expr.trim() in ctx.options) return ctx.options[expr.trim()]
    return { key: str(expr, st) }
  }
  const group = (v, st) => ctx.groups[v.replace(/\.get\(\)$/, '')] ?? fail(st, `unknown option group ${v}`)
  const pushLine = (g, line) => { if (line.keys.length) g.lines.push(line) }
  /** A one-option line, carrying an Option variable's label or size overrides. */
  const single = (ref, extra = {}) => {
    if (ref.synthetic) return { keys: [] } // GUI-only options (extruders_count): nothing to store
    const line = { keys: [ref.key], ...extra }
    if (ref.label) line.labels = { [ref.key]: ref.label }
    if (ref.wide) line.wide = true
    return line
  }

  function exec(st) {
    let m
    // Control flow.
    if (/^if\s*\(/.test(st) || /^else\b/.test(st)) {
      let take
      let rest
      if (/^else\b/.test(st)) {
        rest = st.replace(/^else\s*/, '')
        if (/^if\s*\(/.test(rest)) {
          if (ctx.lastIf === false) return exec(rest)
          if (ctx.lastIf === null && relevant(rest)) fail(st, 'else-branch of an unevaluated if')
          return
        }
        if (ctx.lastIf === null) { if (relevant(rest)) fail(st, 'else-branch of an unevaluated if'); return }
        take = !ctx.lastIf
        ctx.lastIf = null
      } else {
        const [cond, r] = parenGroup(st)
        rest = r
        const c = cond.replace(/\s+/g, ' ').trim()
        if (!relevant(rest)) { ctx.lastIf = c in opts.conds ? opts.conds[c] : null; return }
        if (!(c in opts.conds)) fail(st, `unknown condition "${c}"`)
        take = opts.conds[c]
        ctx.lastIf = take
      }
      if (take) run(unblock(rest))
      return
    }
    ctx.lastIf = null
    if (/^for\s*\(/.test(st)) {
      const [head, rest] = parenGroup(st)
      if (!relevant(rest)) return
      const body = unblock(rest)
      // Range-for: the single `:` (not part of `::`) separates the variable from the list.
      if ((m = /^[\w:&\s<>]*?(\w+)\s*(?<!:):(?!:)\s*([\s\S]+)$/.exec(head)) && !head.includes(';')) {
        const src2 = m[2].trim()
        const list = src2.startsWith('{') ? splitArgs(src2.slice(1, -1)).map((x) => str(x, st)) : ctx.lists[src2]
        if (!list) fail(st, `unknown list ${src2}`)
        for (const v of list) { ctx.vars[m[1]] = v; run(body) }
        delete ctx.vars[m[1]]
        return
      }
      if ((m = /^\s*auto\s+(\w+)\s*=/.exec(head)) && opts.counters?.includes(m[1])) {
        ctx.vars[m[1]] = '0'
        run(body)
        return
      }
      fail(st, 'unsupported loop')
    }
    if (st.startsWith('{')) return run(unblock(st))

    // Pages and groups.
    if ((m = /^(?:(?:auto|PageShp)\s+)?\w+\s*=\s*add_options_page\s*\(([\s\S]*)\)$/.exec(st))) {
      ctx.page = { title: str(splitArgs(m[1])[0], st), groups: [] }
      pages.push(ctx.page)
      return
    }
    if ((m = /^(?:(?:auto|ConfigOptionsGroupShp)\s+)?(\w+)\s*=\s*page->new_optgroup\s*\(([\s\S]*)\)$/.exec(st))) {
      const g = { title: str(splitArgs(m[2])[0], st), lines: [] }
      ctx.page.groups.push(g)
      ctx.groups[m[1]] = g
      return
    }
    // String lists: const std::vector<std::string> axes{ "x", "y" } / = { ... }
    if ((m = /^(?:const\s+)?std::vector<std::string>\s+(\w+)\s*=?\s*(\{[\s\S]*\})$/.exec(st))) {
      ctx.lists[m[1]] = splitArgs(m[2].slice(1, -1)).map((x) => str(x, st))
      return
    }
    // Option variables.
    if ((m = /^Option\s+(\w+)\s*\(\s*def\s*,\s*"(\w+)"\s*\)$/.exec(st))) {
      ctx.options[m[1]] = { key: m[2], synthetic: true }
      return
    }
    if ((m = /^(?:(?:Option|auto)\s+)?(\w+)\s*=\s*(\w+->get_option\s*\([\s\S]*\))$/.exec(st))) {
      ctx.options[m[1]] = optionRef(m[2], st)
      return
    }
    if ((m = /^(\w+)\.opt\.(\w+)\s*=\s*([\s\S]+)$/.exec(st))) {
      const o = ctx.options[m[1]] ?? fail(st, `unknown option variable ${m[1]}`)
      if (m[2] === 'label' || m[2] === 'full_label') o.label = str(m[3], st)
      else if ((m[2] === 'full_width' || m[2] === 'is_code') && m[3].trim() === 'true') o.wide = true
      return
    }
    // Lines.
    if ((m = /^(?:(?:Line|auto)\s+)?(\w+)\s*=\s*(?:Line\s*)?\{([\s\S]*)\}$/.exec(st))) {
      const [label, tooltip] = splitArgs(m[2]).map((a) => stringExpr(a))
      ctx.lines[m[1]] = { ...(label ? { label } : {}), ...(tooltip ? { tooltip } : {}), keys: [] }
      return
    }
    if ((m = /^(\w+)\.append_option\s*\(([\s\S]*)\)$/.exec(st))) {
      const line = ctx.lines[m[1]] ?? fail(st, `unknown line ${m[1]}`)
      const ref = optionRef(m[2], st)
      if (!ref.synthetic) {
        line.keys.push(ref.key)
        if (ref.label) line.labels = { ...line.labels, [ref.key]: ref.label }
      }
      return
    }
    if ((m = /^(\w+)->append_line\s*\(\s*(\w+)\s*\)$/.exec(st))) {
      pushLine(group(m[1], st), ctx.lines[m[2]] ?? fail(st, `unknown line ${m[2]}`))
      return
    }
    if ((m = /^(\w+)->append_single_option_line\s*\(([\s\S]*)\)$/.exec(st))) {
      pushLine(group(m[1], st), single(optionRef(splitArgs(m[2])[0], st)))
      return
    }
    if ((m = /^create_line_with_widget\s*\(([\s\S]*)\)$/.exec(st))) {
      const a = splitArgs(m[1])
      pushLine(group(a[0], st), { keys: [str(a[1], st)], widget: true })
      return
    }
    // TabPrinter::append_option_line(optgroup, key, path): one option, labelled with its full label.
    if ((m = /^append_option_line\s*\(([\s\S]*)\)$/.exec(st))) {
      const a = splitArgs(m[1])
      pushLine(group(a[0], st), { keys: [str(a[1], st)], fullLabel: true })
      return
    }
    // Helper lambdas that add a single option line to a group, e.g. the
    // "Setting Overrides" page's append_retraction_option, which puts an
    // "override" checkbox next to the option (the value can be nil).
    if ((m = /^auto\s+(\w+)\s*=\s*\[[^\]]*\]\s*\(/.exec(st))) {
      const g = /(\w+)->append_line\s*\(\s*line\s*\)/.exec(st)
      if (g && /create_single_option_line/.test(st)) ctx.lambdas[m[1]] = { group: g[1], nullable: /near_label_widget/.test(st) }
      return
    }
    if ((m = /^(\w+)\s*\(([\s\S]*)\)$/.exec(st)) && ctx.lambdas[m[1]]) {
      const l = ctx.lambdas[m[1]]
      pushLine(group(l.group, st), { keys: [str(splitArgs(m[2])[0], st)], ...(l.nullable ? { nullable: true } : {}) })
      return
    }
    // Calls to member functions that build pages (add_filament_overrides_page(), build_kinematics_page(), ...).
    if ((m = /^(?:(?:auto|PageShp)\s+\w+\s*=\s*)?(\w+)\s*\([\s\S]*\)$/.exec(st)) && members.has(m[1])) {
      runFunction(src, cls, m[1], opts, pages)
      return
    }
    if (/^\w+(->|\.)(m_on_change|edit_custom_gcode|label_width|label_path)\s*=/.test(st)) return
    if (relevant(st)) fail(st)
  }

  run(body)
  return pages
}

/** Splits at top-level `+`. */
function splitPlus(s) {
  const out = []
  let depth = 0, cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '"') { const [, e] = readStrings(s, i); cur += s.slice(i, e); i = e - 1; continue }
    if ('({['.includes(c)) depth++
    if (')}]'.includes(c)) depth--
    if (c === '+' && depth === 0) { out.push(cur); cur = '' } else cur += c
  }
  out.push(cur)
  return out
}

/** Pages built by any Tab.cpp member function (e.g. 'TabPrint', 'build'). */
export function parseTabFunction(tabSrc, cls, fn, opts = { conds: {} }) {
  return runFunction(preprocess(tabSrc), cls, fn, opts)
}

/** Filament settings tab: TabFilament::build(). */
export function parseFilamentTab(tabSrc) {
  return runFunction(preprocess(tabSrc), 'TabFilament', 'build', { conds: {} })
}

// Desktop Orca inserts the per-extruder, "Motion ability" and "Multimaterial"
// pages between its fixed pages (TabPrinter::build_unregular_pages). For a
// Marlin-flavour printer with one extruder (the X1) the order is:
const PRINTER_PAGE_ORDER = ['Basic information', 'Machine G-code', 'Multimaterial', 'Extruder', 'Motion ability', 'Notes']

/** Printer settings tab: TabPrinter::build_fff() for a single-extruder printer without silent mode. */
export function parsePrinterTab(tabSrc) {
  const pages = runFunction(preprocess(tabSrc), 'TabPrinter', 'build_fff', {
    conds: {
      // build_fff calls build_unregular_pages(true).
      from_initial_build: true,
      'existed_page < n_before_extruders && (is_marlin_flavor || from_initial_build)': true,
      // Bambu presets have silent_mode off: one column of machine limits.
      m_use_silent_mode: false,
    },
    // One extruder: Orca names its page "Extruder".
    vars: { page_name: 'Extruder' },
    counters: ['extruder_idx'],
  })
  const titles = pages.map((p) => p.title)
  if (titles.length !== PRINTER_PAGE_ORDER.length || PRINTER_PAGE_ORDER.some((t) => !titles.includes(t))) {
    throw new Error(`TabPrinter pages changed: ${titles.join(', ')} (expected ${PRINTER_PAGE_ORDER.join(', ')})`)
  }
  return PRINTER_PAGE_ORDER.map((t) => pages.find((p) => p.title === t))
}

/** Pages plus the definitions of every option they show; fails on options PrintConfig.cpp doesn't define. */
function withDefs(pages, defs, what) {
  const options = {}
  const missing = []
  for (const p of pages) for (const g of p.groups) for (const l of g.lines) {
    for (const k of l.keys) {
      const d = defs[k]
      if (!d) { missing.push(k); continue }
      const { category, enum_type, ...rest } = d
      options[k] = rest
    }
    if (l.fullLabel) {
      delete l.fullLabel
      const d = defs[l.keys[0]]
      if (d?.full_label) l.label = d.full_label
    }
  }
  if (missing.length) throw new Error(`${what} tab options without a definition: ${missing.join(', ')}`)
  if (!Object.keys(options).length) throw new Error(`${what} tab: no options found`)
  return { pages, options }
}

/**
 * The filament "Setting Overrides" options (filament_retraction_length, ...)
 * are declared in a loop in PrintConfigDef::init_fff_params: each copies the
 * printer option without the "filament_" prefix, as a nullable vector ("nil"
 * means "use the printer's value").
 */
function addFilamentOverrideDefs(src, defs) {
  const list = /filament_extruder_override_keys\s*=\s*\{([\s\S]*?)\};/.exec(src)
  const loop = /for\s*\(\s*auto\s*&\s*opt_key\s*:\s*filament_extruder_override_keys\s*\)\s*\{([\s\S]*?)\n    \}/.exec(src)
  if (!list || !loop) throw new Error('PrintConfig.cpp: filament_extruder_override_keys not found')
  // Keys the loop puts in Simple mode (the rest are Advanced).
  const simple = new Set([...(/if\s*\(([^)]*)\)\s*def->mode\s*=\s*comSimple/.exec(loop[1])?.[1] ?? '').matchAll(/"(\w+)"/g)].map((m) => m[1]))
  if (!simple.size) throw new Error('PrintConfig.cpp: filament override modes not found')
  for (const key of [...list[1].matchAll(/"(\w+)"/g)].map((m) => m[1])) {
    const raw = defs[key.replace(/^filament_/, '')]
    if (!raw) throw new Error(`PrintConfig.cpp: ${key} overrides an unknown option`)
    const { mode, category, readonly, ...rest } = raw
    defs[key] = { ...rest, vector: true, nullable: true, mode: simple.has(key) ? 0 : 1 }
  }
}

/**
 * The per-axis machine limits (machine_max_speed_x, ...) are declared in a
 * loop over an AxisDefault table in PrintConfigDef::init_fff_params.
 */
function addMachineLimitDefs(src, defs) {
  const block = /std::vector<AxisDefault>\s+axes\s*\{([\s\S]*?)\};\s*for\s*\(\s*const\s+AxisDefault\s*&\s*axis\s*:\s*axes\s*\)\s*\{([\s\S]*?)\n        \}/.exec(src)
  if (!block) throw new Error('PrintConfig.cpp: machine limit axes not found')
  const fields = /struct\s+AxisDefault\s*\{([\s\S]*?)\}/.exec(src)?.[1].match(/\w+(?=\s*;)/g) ?? []
  const rows = [...block[1].matchAll(/\{\s*"(\w)"\s*,\s*((?:\{[^}]*\}\s*,?\s*)+)\}/g)].map((m) => ({
    name: m[1],
    ...Object.fromEntries([...m[2].matchAll(/\{([^}]*)\}/g)].map((v, i) => [fields[i + 1], v[1].split(',').map((x) => String(Number(x.trim().replace(/\.$/, ''))))])),
  }))
  const adds = [...block[2].matchAll(/def\s*=\s*this->add\("(\w+)"\s*\+\s*axis\.name,\s*(co\w+)\)\s*;([\s\S]*?)(?=def\s*=\s*this->add|$)/g)]
  if (rows.length !== 4 || adds.length < 3) throw new Error('PrintConfig.cpp: machine limit axes changed')
  for (const [, prefix, type, body] of adds) {
    for (const axis of rows) {
      const upper = axis.name.toUpperCase()
      const d = { type, vector: true, mode: /def->mode\s*=\s*comSimple/.test(body) ? 0 : 1 }
      for (const f of ['full_label', 'tooltip']) {
        const m = new RegExp(`def->${f}\\s*=\\s*\\(boost::format\\("([^"]*)"\\)`).exec(body)
        if (m) d[f] = m[1].replace('%1%', upper)
      }
      const side = /def->sidetext\s*=\s*L\(\s*(?:u8)?"([^"]*)"\s*\)/.exec(body)
      if (side) d.sidetext = side[1]
      const min = /def->min\s*=\s*([\d.]+)/.exec(body)
      if (min) d.min = Number(min[1])
      const dflt = /ConfigOptionFloats\(axis\.(\w+)\)/.exec(body)
      if (dflt && axis[dflt[1]]) d.default = axis[dflt[1]]
      defs[prefix + axis.name] ??= d
    }
  }
}

/** Filament and printer settings tabs with option definitions. */
export function presetSettingsSchemas(printConfigSrc, tabSrc, constantsSrc = '') {
  const constants = Object.fromEntries([...constantsSrc.matchAll(/^#define\s+(\w+)\s+(\S+)/gm)].map((m) => [m[1], m[2]]))
  const defs = parseOptionDefs(printConfigSrc, constants)
  addFilamentOverrideDefs(printConfigSrc, defs)
  addMachineLimitDefs(printConfigSrc, defs)
  return {
    filamentSchema: withDefs(parseFilamentTab(tabSrc), defs, 'Filament'),
    printerSchema: withDefs(parsePrinterTab(tabSrc), defs, 'Printer'),
  }
}
