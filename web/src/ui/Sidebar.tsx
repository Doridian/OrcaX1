import { useMemo, useState } from 'preact/hooks'
import { BED_TYPES, type FilamentSlot } from '../slicer/profiles'
import { isFilamentPicker, MODES, visibleIn, type Mode, type OptionDef, type OptionPage, type ProcessSchema } from '../slicer/schema'
import { processToggles } from '../slicer/toggles'
import {
  canEditTray, detectedModel, EXTERNAL, nozzle, NOZZLE_TYPES, pendingNozzle, pendingTrays, setModel, trayName, trays,
} from '../state/hardware'
import { mqttConnected } from '../state/printer'
import { confirmNozzleEdit, confirmTrayEdit } from './hardwareEdits'
import { ProcessNotices } from './ProcessNotices'
import {
  bundle, bundleError, currentPrinter, currentProcess, filamentList, processList, processScalar, processValue, sel, setProcessOverride,
  setProcessScalar, settingsMode, updateSel,
} from '../state/settings'

export function Sidebar() {
  return (
    <aside class="sidebar">
      {bundleError.value && <div class="section error">Failed to load profiles: {bundleError.value}</div>}
      {!bundle.value && !bundleError.value && <div class="section muted">Loading profiles…</div>}
      {bundle.value && (
        <>
          <PrinterSection />
          <FilamentSection />
          <ProcessSection />
        </>
      )}
    </aside>
  )
}

/** Puts a control back to its old value if the change was cancelled (the printer's state is authoritative). */
function revertUnless(el: HTMLInputElement | HTMLSelectElement, old: string, done: Promise<boolean>) {
  done.then((ok) => { if (!ok) el.value = old })
}

function PrinterSection() {
  const b = bundle.value!
  const s = sel.value
  const cur = b.printers.find((p) => p.name === s.printer)
  const models = [...new Set(b.printers.map((p) => p.model))]
  const diameters = [...new Set(b.printers.filter((p) => p.model === cur?.model).map((p) => Number(p.nozzle)))].sort((x, y) => x - y)
  const n = nozzle.value
  const online = mqttConnected.value
  const pend = pendingNozzle.value
  const nozzleType = n?.type ?? String((s.printerOverrides.nozzle_type as string[] | undefined)?.[0] ?? '')
  // While an edit is in flight, show what was sent.
  const shown = pend ?? { diameter: n?.diameter ?? Number(cur?.nozzle), type: nozzleType }
  const known = NOZZLE_TYPES.some(([v]) => v === shown.type)
  return (
    <div class="section">
      <h3>Printer</h3>
      {detectedModel.value
        ? <div class="fixed-value" title="Reported by the printer">{detectedModel.value}</div>
        : (
          <select class="full" value={cur?.model} title="The printer has not announced its model yet"
            onChange={(e) => setModel(e.currentTarget.value)}>
            {models.map((m) => <option value={m}>{m}</option>)}
          </select>
        )}
      <div class="row">
        <label title="Reported by the printer; changing it updates the printer">Nozzle</label>
        <div class="control">
          <select value={String(shown.diameter)} disabled={!n || !online || !!pend}
            onChange={(e) => revertUnless(e.currentTarget, String(shown.diameter), confirmNozzleEdit(+e.currentTarget.value, known ? nozzleType : 'hardened_steel'))}>
            {diameters.map((d) => <option value={String(d)}>{d} mm</option>)}
          </select>
        </div>
      </div>
      <div class="row">
        <label title="Reported by the printer; changing it updates the printer">Nozzle type</label>
        <div class="control">
          <select value={shown.type} disabled={!n || !online || !!pend}
            onChange={(e) => revertUnless(e.currentTarget, shown.type, confirmNozzleEdit(shown.diameter, e.currentTarget.value))}>
            {!known && <option value={shown.type}>{shown.type || '?'}</option>}
            {NOZZLE_TYPES.map(([v, l]) => <option value={v}>{l}</option>)}
          </select>
        </div>
      </div>
      {pend && <div class="muted small-text">Waiting for the printer to confirm the nozzle…</div>}
      {!n && <div class="muted small-text">Waiting for the printer to report its nozzle.</div>}
      <div class="row">
        <label>Plate type</label>
        <div class="control">
          <select value={s.bedType} onChange={(e) => updateSel({ bedType: e.currentTarget.value })}>
            {BED_TYPES.map((t) => <option value={t}>{t}</option>)}
          </select>
        </div>
      </div>
      <div class="row">
        <label>Nozzle flow</label>
        <div class="control">
          <select value={s.flow} onChange={(e) => updateSel({ flow: e.currentTarget.value as any })}>
            <option value="Standard">Standard</option>
            <option value="High Flow">High Flow</option>
          </select>
        </div>
      </div>
      <label class="check" title="Allow filaments with incompatible nozzle temperatures on one plate (Orca preference)">
        <input type="checkbox" checked={!!s.allowMixedTemps} onChange={(e) => updateSel({ allowMixedTemps: e.currentTarget.checked })} />
        Allow mixed nozzle temperatures
      </label>
    </div>
  )
}

function FilamentSection() {
  const s = sel.value
  const fils = filamentList.value
  const list = trays.value
  const online = mqttConnected.value
  const pend = pendingTrays.value
  const grouped = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const f of fils) {
      if (!f.filament_id) continue // the printer can only store presets with a Bambu filament id
      const v = f.vendor ?? 'Other'
      if (!m.has(v)) m.set(v, [])
      m.get(v)!.push(f.name)
    }
    return [...m.entries()].sort(([a], [b]) => (a === 'Bambu Lab' ? -1 : b === 'Bambu Lab' ? 1 : a === 'Generic' ? -1 : b === 'Generic' ? 1 : a.localeCompare(b)))
  }, [fils])

  // One group per AMS unit, then the external spool.
  const groups: { title: string; items: { f: FilamentSlot; i: number }[] }[] = []
  s.filaments.forEach((f, i) => {
    const title = f.tray === undefined ? 'Filaments' : f.tray === EXTERNAL ? 'External spool' : `AMS ${Math.floor(f.tray / 4) + 1}`
    const g = groups[groups.length - 1]
    if (g?.title === title) g.items.push({ f, i })
    else groups.push({ title, items: [{ f, i }] })
  })

  return (
    <div class="section">
      <h3>Filaments</h3>
      {!list && <div class="muted small-text">Waiting for the printer to report its AMS; showing the last known filaments.</div>}
      {list && !online && <div class="muted small-text">Printer offline; filaments can't be changed.</div>}
      {groups.map((g) => (
        <div class="filament-group">
          <div class="group-title">{g.title}</div>
          {g.items.map(({ f, i }) => {
            const t = list?.find((x) => x.id === f.tray)
            const editable = canEditTray(t) && !pend[t.id]
            const ext = f.tray === EXTERNAL
            return (
              <div class={`filament-slot${f.empty ? ' empty' : ''}`} title={trayName(f.tray)}>
                <span class="slot-num">{i + 1}</span>
                <span class="swatch" style={{ background: f.empty ? 'transparent' : f.color }}>
                  {editable && !f.empty && (
                    <input type="color" value={f.color}
                      onChange={(e) => revertUnless(e.currentTarget, f.color, confirmTrayEdit(t, f.preset, e.currentTarget.value))} />
                  )}
                </span>
                {f.empty && !ext
                  ? <span class="muted empty-label">Empty</span>
                  : (
                    <select value={f.empty ? '' : f.preset} disabled={!editable} title={f.preset}
                      onChange={(e) => revertUnless(e.currentTarget, f.empty ? '' : f.preset, confirmTrayEdit(t!, e.currentTarget.value, f.empty ? '#FFFFFF' : f.color))}>
                      {f.empty && <option value="">Not set</option>}
                      {!f.empty && !fils.some((x) => x.name === f.preset) && <option value={f.preset}>{f.preset} (incompatible)</option>}
                      {grouped.map(([vendor, names]) => (
                        <optgroup label={vendor}>{names.map((n) => <option value={n}>{n}</option>)}</optgroup>
                      ))}
                    </select>
                  )}
                {t && pend[t.id] && <span class="muted small-text" title="Waiting for the printer to confirm">…</span>}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function OptionRow({ k, def, label, disabled }: { k: string; def: OptionDef; label: string; disabled: boolean }) {
  const value = processScalar(k)
  const changed = k in sel.value.processOverrides
  const set = (v: string) => setProcessScalar(k, v)
  const cls = changed ? 'changed' : ''
  const off = disabled || !!def.readonly
  const unit = def.sidetext ? <span class="unit">{def.sidetext}</span> : null
  let control
  if (def.type === 'coBool') {
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
  } else if (def.type === 'coStrings' || def.multiline || def.full_width) {
    return (
      <div class="option-block" title={def.tooltip}>
        <label title={k}>{label}{changed && <button class="reset" title="Reset to preset" onClick={() => setProcessOverride(k, null)}>↺</button>}</label>
        <textarea class={cls} rows={def.type === 'coStrings' || def.full_width ? 5 : 2} value={value} disabled={off} spellcheck={false}
          onChange={(e) => set(e.currentTarget.value)} />
      </div>
    )
  } else if (def.type === 'coPercent') {
    control = <>
      <input type="number" class={cls} value={value.replace(/%$/, '')} step="any" min={def.min} max={def.max} disabled={off}
        onChange={(e) => set(e.currentTarget.value === '' ? '' : `${e.currentTarget.value}%`)} />
      <span class="unit">%</span>
    </>
  } else if (def.type === 'coInt' || def.type === 'coFloat') {
    const list = def.enum ? `opts-${k}` : undefined
    control = <>
      <input type="number" class={cls} value={value} step={def.type === 'coInt' ? 1 : 'any'} min={def.min} max={def.max} disabled={off} list={list}
        onChange={(e) => set(e.currentTarget.value)} />
      {list && <datalist id={list}>{def.enum!.map(([v, l]) => <option value={v}>{l}</option>)}</datalist>}
      {unit}
    </>
  } else {
    // coFloatOrPercent ("5" or "50%"), coString, and open enums.
    const list = def.enum ? `opts-${k}` : undefined
    control = <>
      <input type="text" class={cls} value={value} disabled={off} list={list} spellcheck={false} onChange={(e) => set(e.currentTarget.value.trim())} />
      {list && <datalist id={list}>{def.enum!.map(([v, l]) => <option value={v}>{l}</option>)}</datalist>}
      {unit}
    </>
  }
  return (
    <div class={`row${off ? ' disabled' : ''}`} title={def.tooltip}>
      <label title={`${def.tooltip ? def.tooltip + '\n\n' : ''}${k}`}>{label}</label>
      <div class="control">
        {control}
        {changed && <button class="reset" title="Reset to preset" onClick={() => setProcessOverride(k, null)}>↺</button>}
      </div>
    </div>
  )
}

/** Every key of the preset (and every override) as raw text. */
function RawSettings() {
  const [q, setQ] = useState('')
  const settings = currentProcess.value?.settings ?? {}
  const all = [...new Set([...Object.keys(settings), ...Object.keys(sel.value.processOverrides)])]
  const keys = all.filter((k) => !q || k.includes(q.toLowerCase().replace(/\s+/g, '_'))).sort()
  return (
    <div>
      <input type="text" placeholder="Filter keys…" value={q} onInput={(e) => setQ(e.currentTarget.value)} style={{ width: '100%', marginBottom: '6px' }} />
      {keys.slice(0, 300).map((k) => {
        const v = processValue(k)
        const text = Array.isArray(v) ? v.join(';') : v ?? ''
        const changed = k in sel.value.processOverrides
        return (
          <div class="row">
            <label title={k}>{k}</label>
            <div class="control">
              <input type="text" class={changed ? 'changed' : ''} value={text}
                onChange={(e) => {
                  const t = e.currentTarget.value
                  setProcessOverride(k, Array.isArray(v) ? t.split(';') : t)
                }} />
              {changed && <button class="reset" onClick={() => setProcessOverride(k, null)}>↺</button>}
            </div>
          </div>
        )
      })}
      {keys.length > 300 && <div class="muted small-text">{keys.length - 300} more; refine the filter.</div>}
    </div>
  )
}

interface ShownGroup { title: string; lines: { label?: string; tooltip?: string; keys: string[] }[] }

/** Groups of a page (or of every page when searching) with what Orca would hide removed. */
function shownGroups(schema: ProcessSchema, pages: OptionPage[], mode: Mode, hidden: Set<string>, query: string): ShownGroup[] {
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
          return k.includes(q.replace(/\s+/g, '_')) || [d.label, d.full_label, l.label, d.tooltip].some((t) => t?.toLowerCase().includes(q))
        }),
      })).filter((l) => l.keys.length > 0)
      if (lines.length) out.push({ title: q ? `${page.title} › ${g.title}` : g.title, lines })
    }
  }
  return out
}

function ProcessSection() {
  const b = bundle.value!
  const schema = b.processSchema
  const [tab, setTab] = useState(schema.pages[0]?.title ?? 'raw')
  const [query, setQuery] = useState('')
  const s = sel.value
  const mode = settingsMode.value
  const overrides = Object.keys(s.processOverrides).length
  const printer = currentPrinter.value?.settings ?? {}
  const { hidden, disabled } = processToggles(processScalar, printer)
  const searching = query.trim() !== ''
  const page = schema.pages.find((p) => p.title === tab)
  const groups = searching ? shownGroups(schema, schema.pages, mode, hidden, query) : page ? shownGroups(schema, [page], mode, hidden, '') : []
  return (
    <div class="section">
      <h3>
        Process <span class="spacer" />
        {overrides > 0 && <button class="small" onClick={() => updateSel({ processOverrides: {} })} title="Discard all changes">Reset {overrides}</button>}
      </h3>
      <select class="full" value={s.process} onChange={(e) => updateSel({ process: e.currentTarget.value })}>
        {processList.value.map((p) => <option value={p.name}>{p.name}</option>)}
      </select>
      <div class="process-tools">
        <input type="search" placeholder="Search settings…" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
        <div class="segmented" title="Which settings to show, as in Orca">
          {MODES.map(([l, m]) => <button class={mode === m ? 'active' : ''} onClick={() => { settingsMode.value = m }}>{l}</button>)}
        </div>
      </div>
      <ProcessNotices />
      {!searching && (
        <div class="subtabs">
          {schema.pages.map((p) => <button class={tab === p.title ? 'active' : ''} onClick={() => setTab(p.title)}>{p.title}</button>)}
          <button class={tab === 'raw' ? 'active' : ''} onClick={() => setTab('raw')} title="Every key of the preset as text">Raw</button>
        </div>
      )}
      {!searching && tab === 'raw'
        ? <RawSettings />
        : groups.length === 0
          ? <div class="muted small-text">{searching ? 'No matching settings' : 'Nothing to show'}{mode < 2 ? '; Expert shows more.' : '.'}</div>
          : groups.map((g) => (
            <div>
              <div class="group-title">{g.title}</div>
              {g.lines.map((l) => {
                const multi = l.label && (l.keys.length > 1 || l.label !== schema.options[l.keys[0]]?.label)
                return (
                  <div class={multi ? 'option-line' : undefined}>
                    {multi && <div class="line-title" title={l.tooltip}>{l.label}</div>}
                    {l.keys.map((k) => {
                      const d = schema.options[k]
                      return <OptionRow k={k} def={d} label={d.label ?? d.full_label ?? k} disabled={disabled.has(k)} />
                    })}
                  </div>
                )
              })}
            </div>
          ))}
    </div>
  )
}
