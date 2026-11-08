// Editors for Orca settings tab options, shared by the process, filament and
// printer settings. Each tab supplies an OptionAccess to read and write values.
import { isFilamentPicker, visibleIn, type Mode, type OptionDef, type OptionLine, type OptionPage, type SettingsSchema } from '../slicer/schema'
import { sel } from '../state/settings'

export interface OptionAccess {
  /** Effective value (override, preset or Orca default) for the active variant, as text. */
  value(key: string): string
  set(key: string, value: string): void
  changed(key: string): boolean
  reset(key: string): void
  /** Why the option is read-only here, if it is. */
  locked?(key: string): string | null
  /** For "nil"-able options: the value used while unset. */
  inherited?(key: string): string
  /**
   * Vector options are whole lists, one entry per line (process settings).
   * Otherwise a vector holds one value per filament/extruder/variant and the row edits the active one.
   */
  vectorsAsLists?: boolean
}

// Unset: "nil", or no value at all (Orca's default for the ironing overrides is nil).
const isNil = (v: string) => v === 'nil' || v === ''

interface RowProps {
  k: string
  def: OptionDef
  label: string
  access: OptionAccess
  disabled?: boolean
  /** Full-width editor (G-code, notes). */
  wide?: boolean
  /** Orca's "override" checkbox: unchecked stores "nil" and shows the inherited value. */
  nullable?: boolean
  /** The override checkbox is disabled. */
  nullLocked?: boolean
}

export function OptionRow({ k, def, label, access, disabled = false, wide, nullable, nullLocked }: RowProps) {
  const raw = access.value(k)
  const unset = nullable && isNil(raw)
  const value = unset ? (access.inherited?.(k) ?? '') : raw
  const changed = access.changed(k)
  const lockedWhy = access.locked?.(k) ?? null
  const set = (v: string) => access.set(k, v)
  const cls = changed ? 'changed' : ''
  const off = disabled || !!def.readonly || !!lockedWhy || !!unset
  const unit = def.sidetext ? <span class="unit">{def.sidetext}</span> : null
  const reset = changed && !lockedWhy && <button class="reset" title="Reset to preset" onClick={() => access.reset(k)}>↺</button>
  const tip = `${lockedWhy ? lockedWhy + '\n\n' : ''}${def.tooltip ? def.tooltip + '\n\n' : ''}${k}`
  const check = nullable && (
    <input type="checkbox" class="override-check" checked={!unset} disabled={disabled || nullLocked || !!lockedWhy}
      title={unset ? 'Use a filament-specific value' : 'Use the inherited value'}
      onChange={(e) => set(e.currentTarget.checked ? (access.inherited?.(k) || def.enum?.[0]?.[0] || '0') : 'nil')} />
  )
  // The type of the value edited: a list, or one element of a vector.
  const t = access.vectorsAsLists && def.vector ? (def.type === 'coStrings' ? 'text-list' : 'list') : def.type.replace(/s$/, '')
  let control
  if (t === 'coBool') {
    control = <input type="checkbox" checked={value === '1' || value === 'true'} disabled={off} onChange={(e) => set(e.currentTarget.checked ? '1' : '0')} />
  } else if (isFilamentPicker(def)) {
    const n = sel.value.filaments.length
    const opts: [string, string][] = [['0', 'Default'], ...sel.value.filaments.map((f, i) => [String(i + 1), `${i + 1}: ${f.preset.replace(/ @.*$/, '')}`] as [string, string])]
    if (Number(value) > n) opts.push([value, `${value} (no such filament)`])
    control = (
      <select class={cls} value={value} disabled={off} onChange={(e) => set(e.currentTarget.value)}>
        {opts.map(([v, l]) => <option value={v}>{l}</option>)}
      </select>
    )
  } else if (def.enum && !def.gui_type?.endsWith('_enum_open')) {
    const opts = def.enum.some(([v]) => v === value) ? def.enum : [[value, value] as [string, string], ...def.enum]
    control = (
      <select class={cls} value={value} disabled={off} onChange={(e) => set(e.currentTarget.value)}>
        {opts.map(([v, l]) => <option value={v}>{l}</option>)}
      </select>
    )
  } else if (wide || t === 'text-list' || def.multiline || def.full_width) {
    return (
      <div class="option-block" title={def.tooltip}>
        <label title={tip}>{check}{label}{reset}</label>
        <textarea class={cls} rows={wide || def.full_width || t === 'text-list' ? 5 : 2} value={value} disabled={off} spellcheck={false}
          onChange={(e) => set(e.currentTarget.value)} />
      </div>
    )
  } else if (t === 'coPercent') {
    control = <>
      <input type="number" class={cls} value={value.replace(/%$/, '')} step="any" min={def.min} max={def.max} disabled={off}
        onChange={(e) => set(e.currentTarget.value === '' ? '' : `${e.currentTarget.value}%`)} />
      <span class="unit">%</span>
    </>
  } else if (t === 'coInt' || t === 'coFloat') {
    const list = def.enum ? `opts-${k}` : undefined
    control = <>
      <input type="number" class={cls} value={value} step={t === 'coInt' ? 1 : 'any'} min={def.min} max={def.max} disabled={off} list={list}
        onChange={(e) => set(e.currentTarget.value)} />
      {list && <datalist id={list}>{def.enum!.map(([v, l]) => <option value={v}>{l}</option>)}</datalist>}
      {unit}
    </>
  } else {
    // coFloatOrPercent ("5" or "50%"), strings, points, and open enums.
    const list = def.enum ? `opts-${k}` : undefined
    control = <>
      <input type="text" class={cls} value={value} disabled={off} list={list} spellcheck={false} onChange={(e) => set(e.currentTarget.value.trim())} />
      {list && <datalist id={list}>{def.enum!.map(([v, l]) => <option value={v}>{l}</option>)}</datalist>}
      {unit}
    </>
  }
  return (
    <div class={`row${off ? ' disabled' : ''}`} title={def.tooltip}>
      <label title={tip}>{check}{label}</label>
      <div class="control">
        {control}
        {reset}
      </div>
    </div>
  )
}

export interface ShownGroup { title: string; lines: OptionLine[] }

/** Groups of a page (or of every page when searching) with what Orca would hide removed. */
export function shownGroups(schema: SettingsSchema, pages: OptionPage[], mode: Mode, hidden: Set<string>, query: string): ShownGroup[] {
  const q = query.trim().toLowerCase()
  const out: ShownGroup[] = []
  for (const page of pages) {
    for (const g of page.groups) {
      const lines = g.lines.map((l) => ({
        ...l,
        keys: l.keys.filter((k) => {
          const d = schema.options[k]
          if (!d || !visibleIn(d, mode) || hidden.has(k)) return false
          if (!q) return true
          return k.includes(q.replace(/\s+/g, '_')) || [d.label, d.full_label, l.label, l.labels?.[k], d.tooltip].some((t) => t?.toLowerCase().includes(q))
        }),
      })).filter((l) => l.keys.length > 0)
      if (lines.length) out.push({ title: q ? `${page.title} › ${g.title}` : g.title, lines })
    }
  }
  return out
}

/** Renders option groups as Orca lays them out: single options, and titled lines of several. */
export function OptionGroups({ schema, groups, access, disabled, nullLocked }: {
  schema: SettingsSchema
  groups: ShownGroup[]
  access: OptionAccess
  disabled: Set<string>
  nullLocked?: Set<string>
}) {
  return <>
    {groups.map((g) => (
      <div>
        <div class="group-title">{g.title}</div>
        {g.lines.map((l) => {
          const multi = l.label && (l.keys.length > 1 || l.label !== schema.options[l.keys[0]]?.label)
          return (
            <div class={multi ? 'option-line' : undefined}>
              {multi && <div class="line-title" title={l.tooltip}>{l.label}</div>}
              {l.keys.map((k) => {
                const d = schema.options[k]
                return (
                  <OptionRow k={k} def={d} label={l.labels?.[k] ?? d.label ?? d.full_label ?? (multi ? '' : k)} access={access} disabled={disabled.has(k)}
                    wide={l.wide} nullable={l.nullable || d.nullable} nullLocked={nullLocked?.has(k)} />
                )
              })}
            </div>
          )
        })}
      </div>
    ))}
  </>
}
