import { useMemo, useState } from 'preact/hooks'
import { BED_TYPES, type FilamentSlot } from '../slicer/profiles'
import { MODES } from '../slicer/schema'
import { processToggles } from '../slicer/toggles'
import {
  canEditTray, detectedModel, EXTERNAL, nozzle, NOZZLE_TYPES, pendingNozzle, pendingTrays, setModel, trayName, trays,
} from '../state/hardware'
import { mqttConnected } from '../state/printer'
import { confirmNozzleEdit, confirmTrayEdit } from './hardwareEdits'
import { ProcessNotices } from './ProcessNotices'
import { RawSettings } from './RawSettings'
import type { RawAccess } from '../state/presetSettings'
import { OptionGroups, shownGroups, type OptionAccess } from './OptionRow'
import { openFilamentSettings, openPrinterSettings, PresetSettingsHost } from './PresetSettings'
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
          <PresetSettingsHost />
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
      <h3>
        Printer <span class="spacer" />
        <button class={`small${Object.keys(s.printerOverrides).some((k) => k !== 'nozzle_type') ? ' modified' : ''}`} onClick={openPrinterSettings}
          title="Orca's printer settings (slicer-only changes)">Settings…</button>
      </h3>
      {detectedModel.value
        ? <div class="fixed-value" title="Reported by the printer">{detectedModel.value}</div>
        : (
          <select class="full" value={cur?.model} title="The printer has not announced its model yet"
            onChange={(e) => revertUnless(e.currentTarget, cur?.model ?? '', setModel(e.currentTarget.value))}>
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
                {!f.empty && (
                  <button class={`icon-btn${f.overrides ? ' modified' : ''}`} onClick={() => openFilamentSettings(i)}
                    title={f.overrides ? `Filament settings (${Object.keys(f.overrides).length} changed for slicing)` : 'Filament settings (slicer-only changes)'}>⚙</button>
                )}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

/** Every key of the preset (and every override) as raw text. */
/** The process keys for the Raw tab: stored, overridden, or defined by the tab (unset ones show Orca's default). */
const processRaw: RawAccess = {
  keys: () => [...new Set([...Object.keys(currentProcess.value?.settings ?? {}), ...Object.keys(sel.value.processOverrides),
    ...Object.keys(bundle.value?.processSchema.options ?? {})])].sort(),
  get: (k) => processValue(k) ?? bundle.value?.processSchema.options[k]?.default,
  changed: (k) => k in sel.value.processOverrides,
  set: setProcessOverride,
}

/** Process settings as the option editors read and write them. */
const processAccess: OptionAccess = {
  value: processScalar,
  set: setProcessScalar,
  changed: (k) => k in sel.value.processOverrides,
  reset: (k) => setProcessOverride(k, null),
  vectorsAsLists: true,
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
        ? <RawSettings raw={processRaw} />
        : groups.length === 0
          ? <div class="muted small-text">{searching ? 'No matching settings' : 'Nothing to show'}{mode < 2 ? '; Expert shows more.' : '.'}</div>
          : <OptionGroups schema={schema} groups={groups} access={processAccess} disabled={disabled} />}
    </div>
  )
}
