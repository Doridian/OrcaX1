// Filament and printer settings dialogs: Orca's Filament and Printer settings
// tabs, editing slicer-only overrides on top of the selected presets.
import { signal } from '@preact/signals'
import { useEffect, useRef, useState } from 'preact/hooks'
import { inputShaperTypes } from '../slicer/printerRules'
import { filamentToggles, printerToggles } from '../slicer/presetToggles'
import { PRINTER_OPTIONS_WITH_VARIANT_2 } from '../slicer/profiles'
import { MODES, type OptionLine, type SettingsSchema } from '../slicer/schema'
import type { Toggles } from '../slicer/toggles'
import { trayName } from '../state/hardware'
import { filamentAccess, filamentScalar, presetNotices, printerAccess, printerScalar, SILENT, type SettingsAccess } from '../state/presetSettings'
import { bundle, currentPrinter, sel, settingsMode } from '../state/settings'
import { OptionGroups, shownGroups } from './OptionRow'
import { PresetWidget } from './PresetWidgets'
import { RawSettings } from './RawSettings'

type Editing = { kind: 'printer' } | { kind: 'filament'; index: number }

/** The settings dialog that is open, if any. */
export const editing = signal<Editing | null>(null)

export const openFilamentSettings = (index: number) => { presetNotices.value = []; editing.value = { kind: 'filament', index } }
export const openPrinterSettings = () => { presetNotices.value = []; editing.value = { kind: 'printer' } }

const isTrue = (v: string) => v === '1' || v === 'true'

/**
 * The printer tab as Orca builds it for the current values: with silent mode
 * on, each machine limit gets a second "Silent" value next to the "Normal"
 * one (TabPrinter's append_option_line), and the input shaper types are the
 * ones the firmware flavour offers (update_input_shaper_menu).
 */
function printerView(schema: SettingsSchema, toggles: Toggles): { schema: SettingsSchema; toggles: Toggles } {
  const options = { ...schema.options }
  const shaper = options.input_shaping_type
  if (shaper?.enum) {
    const allowed = inputShaperTypes(printerScalar('gcode_flavor'))
    options.input_shaping_type = { ...shaper, enum: shaper.enum.filter(([v]) => allowed.includes(v)) }
  }
  if (!isTrue(printerScalar('silent_mode'))) return { schema: { ...schema, options }, toggles }
  const hidden = new Set(toggles.hidden), disabled = new Set(toggles.disabled)
  const pair = (l: OptionLine): OptionLine => {
    const k = l.keys[0]
    if (l.keys.length !== 1 || !PRINTER_OPTIONS_WITH_VARIANT_2.has(k) || !options[k]) return l
    const s = k + SILENT
    options[s] = options[k]
    if (hidden.has(k)) hidden.add(s)
    if (disabled.has(k)) disabled.add(s)
    return { ...l, label: l.label ?? options[k].label, keys: [k, s], labels: { [k]: 'Normal', [s]: 'Silent' } }
  }
  const pages = schema.pages.map((p) => ({ ...p, groups: p.groups.map((g) => ({ ...g, lines: g.lines.map(pair) })) }))
  return { schema: { pages, options }, toggles: { ...toggles, hidden, disabled } }
}

export function PresetSettingsHost() {
  const e = editing.value
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (e && !ref.current?.open) ref.current?.showModal() }, [e])
  if (!e) return null
  const close = () => { ref.current?.close(); editing.value = null }

  let title: string, subtitle: string, note: string
  let access: SettingsAccess | null
  let toggles: Toggles & { locked?: Set<string> }
  let compatiblePrinters: string[] | undefined
  if (e.kind === 'filament') {
    const slot = sel.value.filaments[e.index]
    access = filamentAccess(e.index)
    title = `Filament ${e.index + 1}${slot?.tray !== undefined ? ` · ${trayName(slot.tray)}` : ''}`
    subtitle = slot?.preset ?? ''
    note = 'Changes here are used for slicing only. The printer keeps the tray\'s filament preset, and changing the tray\'s filament discards them.'
    toggles = filamentToggles((k) => filamentScalar(e.index, k), printerScalar)
    compatiblePrinters = bundle.value?.filaments.find((f) => f.name === slot?.preset)?.compatible
  } else {
    access = printerAccess.value
    title = 'Printer settings'
    subtitle = currentPrinter.value?.name ?? ''
    note = 'Changes here are used for slicing only and are not sent to the printer. Nozzle and model follow what the printer reports.'
    toggles = printerToggles(printerScalar)
  }
  let schema = access?.schema
  if (access && e.kind === 'printer') ({ schema, toggles } = printerView(access.schema, toggles))

  return (
    <dialog ref={ref} class="settings-dialog" onClose={() => { editing.value = null }}>
      <header>
        <span>{title}</span>
        <span class="muted subtitle" title={subtitle}>{subtitle}</span>
        <span class="spacer" />
        {access && access.count > 0 && (
          <button class="small" onClick={access.resetAll} title="Discard all changes to this preset">Reset {access.count}</button>
        )}
        <button class="small" onClick={close} title="Close">✕</button>
      </header>
      <div class="body">
        <p class="muted small-text">{note}</p>
        {presetNotices.value.length > 0 && (
          <div class="process-notices">
            {presetNotices.value.map((text, i) => (
              <div class="process-notice" role="status">
                <span class="pre-line">{text}</span>
                <button class="reset" title="Dismiss" onClick={() => { presetNotices.value = presetNotices.value.filter((_, j) => j !== i) }}>✕</button>
              </div>
            ))}
          </div>
        )}
        {access && schema
          ? <SettingsTabs key={`${e.kind}-${e.kind === 'filament' ? e.index : ''}`} schema={schema} access={access} toggles={toggles}
            compatiblePrinters={compatiblePrinters} />
          : <div class="muted">This filament slot no longer exists.</div>}
      </div>
    </dialog>
  )
}

function SettingsTabs({ schema, access, toggles, compatiblePrinters }: {
  schema: SettingsSchema
  access: SettingsAccess
  toggles: Toggles & { locked?: Set<string> }
  compatiblePrinters?: string[]
}) {
  const [tab, setTab] = useState(schema.pages[0]?.title ?? '')
  const [query, setQuery] = useState('')
  const mode = settingsMode.value
  const searching = query.trim() !== ''
  const raw = !searching && tab === 'raw'
  const page = schema.pages.find((p) => p.title === tab) ?? schema.pages[0]
  const groups = shownGroups(schema, searching ? schema.pages : page ? [page] : [], mode, toggles.hidden, query)
  // Pages with nothing to show in this mode are left out, as in Orca.
  const pages = schema.pages.filter((p) => p === page || shownGroups(schema, [p], mode, toggles.hidden, '').length > 0)
  return <>
    <div class="process-tools">
      <input type="search" placeholder="Search settings…" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
      <div class="segmented" title="Which settings to show, as in Orca">
        {MODES.map(([l, m]) => <button class={mode === m ? 'active' : ''} onClick={() => { settingsMode.value = m }}>{l}</button>)}
      </div>
    </div>
    {!searching && (
      <div class="subtabs">
        {pages.map((p) => <button class={!raw && page === p ? 'active' : ''} onClick={() => setTab(p.title)}>{p.title}</button>)}
        <button class={raw ? 'active' : ''} onClick={() => setTab('raw')} title="Every key of the preset as text">Raw</button>
      </div>
    )}
    {raw
      ? <RawSettings raw={access.raw} />
      : groups.length === 0
        ? <div class="muted small-text">{searching ? 'No matching settings' : 'Nothing to show'}{mode < 2 ? '; Expert shows more.' : '.'}</div>
        : <OptionGroups schema={schema} groups={groups} access={access} disabled={toggles.disabled} nullLocked={toggles.locked}
          widget={(line) => <PresetWidget line={line} schema={schema} raw={access.raw} compatiblePrinters={compatiblePrinters} />} />}
  </>
}
