import { useMemo, useState } from 'preact/hooks'
import { BED_TYPES, type FilamentSlot } from '../slicer/profiles'
import { TABS, type Field } from '../slicer/schema'
import {
  canEditTray, EXTERNAL, nozzle, NOZZLE_TYPES, pendingNozzle, pendingTrays, setModel, trayName, trays,
} from '../state/hardware'
import { mqttConnected } from '../state/printer'
import { confirmNozzleEdit, confirmTrayEdit } from './hardwareEdits'
import {
  bundle, bundleError, currentProcess, filamentList, processList, processValue, sel, setProcessOverride, updateSel,
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
      <select class="full" value={cur?.model} onChange={(e) => setModel(e.currentTarget.value)}>
        {models.map((m) => <option value={m}>{m}</option>)}
      </select>
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

function FieldRow({ f }: { f: Field }) {
  // Keys absent from the preset use Orca's built-in default.
  const preset = currentProcess.value?.settings[f.key]
  const raw = processValue(f.key)
  const value = Array.isArray(raw) ? raw[0] ?? '' : raw ?? ''
  const changed = f.key in sel.value.processOverrides
  // Vector-stored scalars (per-variant) are written back with every entry set.
  const set = (v: string) => setProcessOverride(f.key, Array.isArray(preset) ? preset.map(() => v) : v)
  let control
  switch (f.type) {
    case 'bool':
      control = <input type="checkbox" checked={value === '1' || value === 'true'} onChange={(e) => set(e.currentTarget.checked ? '1' : '0')} />
      break
    case 'enum': {
      const opts = f.options.some(([v]) => v === value) ? f.options
        : [[value, value === '' ? '(Orca default)' : value] as [string, string], ...f.options]
      control = (
        <select class={changed ? 'changed' : ''} value={value} onChange={(e) => set(e.currentTarget.value)}>
          {opts.map(([v, l]) => <option value={v}>{l}</option>)}
        </select>
      )
      break
    }
    case 'number':
      control = (
        <>
          <input type="number" class={changed ? 'changed' : ''} value={value} placeholder="default" step={f.step ?? 'any'} min={f.min} max={f.max}
            onChange={(e) => set(e.currentTarget.value)} />
          <span class="unit">{f.unit ?? ''}</span>
        </>
      )
      break
    default:
      control = <input type="text" class={changed ? 'changed' : ''} value={value} onChange={(e) => set(e.currentTarget.value)} />
  }
  return (
    <div class="row">
      <label title={f.key}>{f.label}</label>
      <div class="control">
        {control}
        {changed && <button class="reset" title="Reset to preset" onClick={() => setProcessOverride(f.key, null)}>↺</button>}
      </div>
    </div>
  )
}

function AllSettings() {
  const [q, setQ] = useState('')
  const settings = currentProcess.value?.settings ?? {}
  const keys = Object.keys(settings).filter((k) => !q || k.includes(q.toLowerCase().replace(/\s+/g, '_'))).sort()
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
                  setProcessOverride(k, Array.isArray(settings[k]) ? t.split(';') : t)
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

function ProcessSection() {
  const [tab, setTab] = useState('quality')
  const s = sel.value
  const overrides = Object.keys(s.processOverrides).length
  const current = TABS.find((t) => t.id === tab)
  return (
    <div class="section">
      <h3>
        Process <span class="spacer" />
        {overrides > 0 && <button class="small" onClick={() => updateSel({ processOverrides: {} })} title="Discard all changes">Reset {overrides}</button>}
      </h3>
      <select class="full" value={s.process} onChange={(e) => updateSel({ process: e.currentTarget.value })}>
        {processList.value.map((p) => <option value={p.name}>{p.name}</option>)}
      </select>
      <div class="subtabs" style={{ marginTop: '8px' }}>
        {TABS.map((t) => <button class={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>{t.title}</button>)}
        <button class={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>All</button>
      </div>
      {current
        ? current.groups.map((g) => (
          <div>
            <div class="group-title">{g.title}</div>
            {g.fields.map((f) => <FieldRow f={f} />)}
          </div>
        ))
        : <AllSettings />}
    </div>
  )
}
