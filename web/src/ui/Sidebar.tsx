import { useMemo, useState } from 'preact/hooks'
import { BED_TYPES, filamentForTray, type FilamentSlot } from '../slicer/profiles'
import { TABS, type Field } from '../slicer/schema'
import { status } from '../state/printer'
import {
  bundle, bundleError, currentProcess, filamentList, processList, processValue, sel, setFilaments,
  setPrinter, setProcessOverride, updateSel,
} from '../state/settings'
import { objects, touch } from '../state/project'

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

function PrinterSection() {
  const b = bundle.value!
  const s = sel.value
  return (
    <div class="section">
      <h3>Printer</h3>
      <select class="full" value={s.printer} onChange={(e) => setPrinter(e.currentTarget.value)}>
        {b.printers.map((p) => <option value={p.name}>{p.name}</option>)}
      </select>
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

function trayList(): { id: number; label: string; tray: any }[] {
  const st = status.value
  const out: { id: number; label: string; tray: any }[] = []
  for (const unit of st.ams?.ams ?? []) {
    for (const tray of unit.tray ?? []) {
      if (!tray.tray_type) continue
      const id = Number(unit.id) * 4 + Number(tray.id)
      out.push({ id, label: `AMS ${Number(unit.id) + 1}-${Number(tray.id) + 1}`, tray })
    }
  }
  if (st.vt_tray?.tray_type) out.push({ id: 254, label: 'External', tray: st.vt_tray })
  return out
}

export function trayColor(tray: any): string {
  const c = String(tray?.tray_color ?? '').slice(0, 6)
  return /^[0-9a-fA-F]{6}$/.test(c) ? `#${c.toUpperCase()}` : '#888888'
}

function FilamentSection() {
  const s = sel.value
  const fils = filamentList.value
  const trays = trayList()
  const grouped = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const f of fils) {
      const v = f.vendor ?? 'Other'
      if (!m.has(v)) m.set(v, [])
      m.get(v)!.push(f.name)
    }
    return [...m.entries()].sort(([a], [b]) => (a === 'Bambu Lab' ? -1 : b === 'Bambu Lab' ? 1 : a === 'Generic' ? -1 : b === 'Generic' ? 1 : a.localeCompare(b)))
  }, [fils])

  const update = (i: number, patch: Partial<FilamentSlot>) =>
    setFilaments(s.filaments.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  const remove = (i: number) => {
    setFilaments(s.filaments.filter((_, j) => j !== i))
    // Objects on the removed slot fall back to slot 1; later slots shift down.
    objects.value = objects.value.map((o) => (o.filament === i ? { ...o, filament: 0, rev: o.rev + 1 } : o.filament > i ? { ...o, filament: o.filament - 1, rev: o.rev + 1 } : o))
    touch()
  }
  const syncFromAms = () => {
    const b = bundle.value!
    const slots: FilamentSlot[] = trays.map(({ tray }) => {
      const preset = filamentForTray(b, s.printer, String(tray.tray_info_idx ?? ''), String(tray.tray_type ?? ''))
      return { preset: preset?.name ?? s.filaments[0].preset, color: trayColor(tray) }
    })
    if (slots.length) setFilaments(slots)
  }

  return (
    <div class="section">
      <h3>
        Filaments <span class="spacer" />
        <button class="small" disabled={!trays.length} onClick={syncFromAms} title="Replace the list with what is loaded in the AMS">Sync AMS</button>
        <button class="small" disabled={s.filaments.length >= 16} onClick={() => setFilaments([...s.filaments, { ...s.filaments[s.filaments.length - 1] }])}>+</button>
      </h3>
      {s.filaments.map((f, i) => (
        <div class="filament-slot">
          <span class="slot-num">{i + 1}</span>
          <span class="swatch" style={{ background: f.color }}>
            <input type="color" value={f.color} onInput={(e) => update(i, { color: e.currentTarget.value.toUpperCase() })} />
          </span>
          <select value={f.preset} onChange={(e) => update(i, { preset: e.currentTarget.value })} title={f.preset}>
            {!fils.some((x) => x.name === f.preset) && <option value={f.preset}>{f.preset} (incompatible)</option>}
            {grouped.map(([vendor, names]) => (
              <optgroup label={vendor}>{names.map((n) => <option value={n}>{n}</option>)}</optgroup>
            ))}
          </select>
          <button class="small icon" disabled={s.filaments.length <= 1} onClick={() => remove(i)} title="Remove">×</button>
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
