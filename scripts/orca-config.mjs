// Reads OrcaSlicer's option definitions (src/libslic3r/PrintConfig.cpp), so
// the web UI shows the same options, labels, tooltips, enums and units as the
// Orca version the engine is built from. The settings tab layouts (Tab.cpp)
// are read by orca-tabs.mjs.

/** Reads a C++ string literal sequence ("a" "b" ...) starting at s[i]; returns [text, end]. */
export function readStrings(s, i) {
  let out = ''
  let any = false
  for (;;) {
    while (/\s/.test(s[i])) i++
    if (s[i] !== '"') break
    any = true
    i++
    while (s[i] !== '"') {
      if (s[i] === '\\') {
        const c = s[++i]
        out += c === 'n' ? '\n' : c === 't' ? '\t' : c
      } else out += s[i]
      i++
    }
    i++
  }
  return any ? [out, i] : [null, i]
}

/** Text of a string expression: "x", L("x"), _L("x"), L_CONTEXT("x", "ctx"). */
export function stringExpr(expr) {
  const m = /^\s*(?:L|_L|_u8L|L_CONTEXT)?\s*\(?/.exec(expr)
  const [text] = readStrings(expr, m ? m[0].length : 0)
  return text
}

const NUM = (x) => {
  const v = Number(String(x).trim().replace(/(?<=\d|\.)f$/, ''))
  return Number.isFinite(v) ? v : undefined
}

/** Orca's serialization of a number (%g-like, no trailing zeros). */
const fmt = (n) => String(Number(n.toPrecision(12)))

/** Parses `{ "key", value }` enum maps: enum type -> (constant -> key). */
function parseEnumMaps(src) {
  const maps = {}
  for (const m of src.matchAll(/t_config_enum_values\s+s_keys_map_(\w+)\s*(?:=\s*)?\{([\s\S]*?)\n\};/g)) {
    const map = {}
    for (const e of m[2].matchAll(/\{\s*"([^"]*)"\s*,\s*(?:int\()?\s*([\w:]+)\s*\)?\s*\}/g)) map[e[2].replace(/^.*::/, '')] ??= e[1]
    maps[m[1]] = map
  }
  return maps
}

/** Splits a C++ argument list at top-level commas. */
export function splitArgs(s) {
  const out = []
  let depth = 0, cur = '', str = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (str) { cur += c; if (c === '\\') cur += s[++i]; else if (c === '"') str = false; continue }
    if (c === '"') str = true
    if ('({['.includes(c)) depth++
    if (')}]'.includes(c)) depth--
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = '' } else cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** Default value in preset JSON form, from `new ConfigOptionX(args)`. Undefined when it can't be read. */
function parseDefault(cls, args, enumMaps, constants = {}) {
  const a = splitArgs(args.replace(/^\s*\{([\s\S]*)\}\s*$/, '$1')).map((x) => constants[x] ?? x)
  const strs = () => a.map((x) => stringExpr(x) ?? (/^std::string\(\)$/.test(x) ? '' : null))
  const base = cls.replace(/Nullable$/, '')
  switch (base) {
    case 'ConfigOptionBool': return a[0] === 'true' || a[0] === '1' ? '1' : '0'
    case 'ConfigOptionInt':
    case 'ConfigOptionFloat': { const n = NUM(a[0]); return n === undefined ? undefined : fmt(n) }
    case 'ConfigOptionPercent': { const n = NUM(a[0]); return n === undefined ? undefined : `${fmt(n)}%` }
    case 'ConfigOptionFloatOrPercent': {
      const n = NUM(a[0])
      return n === undefined ? undefined : `${fmt(n)}${a[1] === 'true' ? '%' : ''}`
    }
    case 'ConfigOptionString': return a.length === 0 ? '' : (strs()[0] ?? undefined)
    case 'ConfigOptionBools': return a.map((x) => (x === 'true' || x === '1' ? '1' : '0'))
    case 'ConfigOptionInts':
    case 'ConfigOptionFloats': {
      const v = a.map(NUM)
      return v.some((x) => x === undefined) ? undefined : v.map(fmt)
    }
    case 'ConfigOptionPercents': {
      const v = a.map(NUM)
      return v.some((x) => x === undefined) ? undefined : v.map((x) => `${fmt(x)}%`)
    }
    case 'ConfigOptionStrings': {
      const v = strs()
      return v.some((x) => x === null) ? undefined : v
    }
    case 'ConfigOptionEnumsGeneric': {
      // { ZHopType::zhtSlope, ... }: one enum value per extruder/variant.
      const v = a.map((x) => { const m = /^(\w+)\s*::\s*(\w+)$/.exec(x); return m ? enumMaps[m[1]]?.[m[2]] : undefined })
      return v.some((x) => x === undefined) ? undefined : v
    }
    default: {
      const e = /^ConfigOptionEnum<(\w+)>$/.exec(cls)
      if (e) return enumMaps[e[1]]?.[a[0]?.replace(/^.*::/, '')]
      return undefined
    }
  }
}

/** Top-level statements of C++ code, comments removed. */
function statements(code) {
  const out = []
  let cur = '', depth = 0
  for (let i = 0; i < code.length; i++) {
    const c = code[i]
    if (c === '"') {
      const j = i
      for (i++; i < code.length && code[i] !== '"'; i++) if (code[i] === '\\') i++
      cur += code.slice(j, i + 1)
      continue
    }
    if (c === '/' && code[i + 1] === '/') { while (i < code.length && code[i] !== '\n') i++; cur += ' '; continue }
    if (c === "'") { const j = i; for (i++; i < code.length && code[i] !== "'"; i++) if (code[i] === '\\') i++; cur += code.slice(j, i + 1); continue }
    if (c === '/' && code[i + 1] === '*') {
      const e = code.indexOf('*/', i + 2)
      i = e < 0 ? code.length : e + 1
      cur += ' '
      continue
    }
    if ('({['.includes(c)) depth++
    if (')}]'.includes(c)) depth--
    if (c === ';' && depth === 0) { out.push(cur.trim()); cur = '' } else cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

const VECTOR_TYPES = new Set(['coFloats', 'coInts', 'coStrings', 'coPercents', 'coFloatsOrPercents', 'coPoints', 'coBools', 'coEnums', 'coPointsGroups', 'coIntsGroups'])
const MODES = { comSimple: 0, comAdvanced: 1, comExpert: 2, comDevelop: 3 }

/**
 * Option definitions from PrintConfig.cpp: key -> { type, label, full_label,
 * tooltip, sidetext, min, max, mode, enum, gui_type, multiline, default, ... }.
 */
export function parseOptionDefs(src, constants = {}) {
  const enumMaps = parseEnumMaps(src)
  const defs = {}
  const named = {} // C++ variable name -> def (e.g. def_top_fill_pattern)
  // One block per `def = this->add("key", coType);`
  const starts = [...src.matchAll(/(?:auto\s+(\w+)\s*=\s*)?def\s*=\s*this->add(?:_nullable)?\("([A-Za-z0-9_]+)",\s*(co\w+)\)\s*;/g)]
  for (let n = 0; n < starts.length; n++) {
    const m = starts[n]
    const key = m[2]
    if (defs[key]) continue // first definition wins (later ones are other printer technologies)
    const end = n + 1 < starts.length ? starts[n + 1].index : src.length
    const body = src.slice(m.index + m[0].length, end)
    const d = { type: m[3], vector: VECTOR_TYPES.has(m[3]) }
    const values = [], labels = []
    for (const st of statements(body)) {
      const sm = /^def->([a-z_]+)\s*(\.(?:push|emplace)_back\(|=|\()([\s\S]*)$/.exec(st)
      if (!sm) continue
      const [, field, op] = sm
      // Drop the closing paren of a call.
      const ex = (op === '=' ? sm[3] : sm[3].replace(/\)\s*$/, '')).trim()
      if (op.endsWith('_back(')) {
        const text = stringExpr(ex)
        if (field === 'enum_values') values.push(text)
        else if (field === 'enum_labels') labels.push(text)
        continue
      }
      if (field === 'set_default_value') {
        const nm = /^new\s+([\w<>:]+)\s*([({])([\s\S]*)[)}]$/.exec(ex)
        if (nm) {
          const v = parseDefault(nm[1], nm[3], enumMaps, constants)
          if (v !== undefined) d.default = v
        }
        continue
      }
      if (op !== '=') continue
      const ref = /^(\w+)->(\w+)$/.exec(ex)
      if (ref && named[ref[1]]) {
        const src2 = named[ref[1]]
        if (ref[2] === 'enum_values' && src2.enum) values.push(...src2.enum.map(([v]) => v))
        else if (ref[2] === 'enum_labels' && src2.enum) labels.push(...src2.enum.map(([, l]) => l))
        else if (src2[ref[2]] !== undefined) d[ref[2]] = src2[ref[2]]
        continue
      }
      if (field === 'enum_values' || field === 'enum_labels') {
        const list = /^\{([\s\S]*)\}$/.exec(ex)
        if (list) (field === 'enum_values' ? values : labels).push(...splitArgs(list[1]).map(stringExpr))
        continue
      }
      switch (field) {
        case 'label': case 'full_label': case 'tooltip': case 'sidetext': case 'category': case 'ratio_over': {
          const t = stringExpr(ex)
          if (t !== null) d[field] = t
          break
        }
        case 'min': case 'max': case 'max_literal': {
          const v = NUM(ex.replace(/^\(\w+\)/, ''))
          if (v !== undefined) d[field] = v
          break
        }
        case 'mode': if (ex in MODES) d.mode = MODES[ex]; break
        case 'gui_type': d.gui_type = ex.replace(/^.*::/, ''); break
        case 'multiline': case 'full_width': case 'readonly': d[field] = ex === 'true'; break
        case 'enum_keys_map': {
          const em = /ConfigOptionEnum<(\w+)>/.exec(ex)
          if (em) d.enum_type = em[1]
          break
        }
      }
    }
    if (values.length) d.enum = values.map((v, i) => [v, labels[i] ?? v])
    else if (labels.length && d.enum_type && enumMaps[d.enum_type]) {
      // Labels without values: the values are the enum map's keys, in order.
      const keys = Object.values(enumMaps[d.enum_type])
      d.enum = labels.map((l, i) => [keys[i], l])
    }
    defs[key] = d
    if (m[1]) named[m[1]] = d
  }
  return defs
}
