// Filament and printer settings dialogs: Orca's Filament and Printer settings
// tabs, editing slicer-only overrides on top of the selected presets.
import { signal } from '@preact/signals'
import { useEffect, useRef, useState } from 'preact/hooks'
import { filamentToggles, printerToggles } from '../slicer/presetToggles'
import { MODES, type SettingsSchema } from '../slicer/schema'
import type { Toggles } from '../slicer/toggles'
import { trayName } from '../state/hardware'
import { filamentAccess, filamentScalar, printerAccess, printerScalar, type SettingsAccess } from '../state/presetSettings'
import { currentPrinter, sel, settingsMode } from '../state/settings'
import { OptionGroups, shownGroups } from './OptionRow'

type Editing = { kind: 'printer' } | { kind: 'filament'; index: number }

/** The settings dialog that is open, if any. */
export const editing = signal<Editing | null>(null)

export const openFilamentSettings = (index: number) => { editing.value = { kind: 'filament', index } }
export const openPrinterSettings = () => { editing.value = { kind: 'printer' } }

export function PresetSettingsHost() {
  const e = editing.value
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (e && !ref.current?.open) ref.current?.showModal() }, [e])
  if (!e) return null
  const close = () => { ref.current?.close(); editing.value = null }

  let title: string, subtitle: string, note: string
  let access: SettingsAccess | null
  let toggles: Toggles & { locked?: Set<string> }
  if (e.kind === 'filament') {
    const slot = sel.value.filaments[e.index]
    access = filamentAccess(e.index)
    title = `Filament ${e.index + 1}${slot?.tray !== undefined ? ` · ${trayName(slot.tray)}` : ''}`
    subtitle = slot?.preset ?? ''
    note = 'Changes here are used for slicing only. The printer keeps the tray\'s filament preset, and changing the tray\'s filament discards them.'
    toggles = filamentToggles((k) => filamentScalar(e.index, k), printerScalar)
  } else {
    access = printerAccess.value
    title = 'Printer settings'
    subtitle = currentPrinter.value?.name ?? ''
    note = 'Changes here are used for slicing only and are not sent to the printer. Nozzle and model follow what the printer reports.'
    toggles = printerToggles(printerScalar)
  }

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
        {access
          ? <SettingsTabs key={`${e.kind}-${e.kind === 'filament' ? e.index : ''}`} schema={access.schema} access={access} toggles={toggles} />
          : <div class="muted">This filament slot no longer exists.</div>}
      </div>
    </dialog>
  )
}

function SettingsTabs({ schema, access, toggles }: { schema: SettingsSchema; access: SettingsAccess; toggles: Toggles & { locked?: Set<string> } }) {
  const [tab, setTab] = useState(schema.pages[0]?.title ?? '')
  const [query, setQuery] = useState('')
  const mode = settingsMode.value
  const searching = query.trim() !== ''
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
        {pages.map((p) => <button class={page === p ? 'active' : ''} onClick={() => setTab(p.title)}>{p.title}</button>)}
      </div>
    )}
    {groups.length === 0
      ? <div class="muted small-text">{searching ? 'No matching settings' : 'Nothing to show'}{mode < 2 ? '; Expert shows more.' : '.'}</div>
      : <OptionGroups schema={schema} groups={groups} access={access} disabled={toggles.disabled} nullLocked={toggles.locked} />}
  </>
}
