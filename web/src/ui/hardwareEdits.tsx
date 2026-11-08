// Confirmation step for changes that are written to the printer.
import { ask } from '../state/confirm'
import { editNozzle, editTray, NOZZLE_TYPES, trayName, type Tray } from '../state/hardware'
import { bundle, describeChanges, sel, setPrinter } from '../state/settings'

const short = (preset: string) => preset.replace(/ @.*$/, '')

function Spool({ color, preset }: { color?: string; preset?: string }) {
  return (
    <span class="spool-chip">
      <span class="swatch" style={{ background: color ?? 'transparent' }} />
      <span>{preset ? short(preset) : 'Not set'}</span>
      {color && <span class="muted small-text">{color}</span>}
    </span>
  )
}

/** Asks, then sends a tray's filament to the printer. Resolves true if it was sent. */
export async function confirmTrayEdit(t: Pick<Tray, 'id' | 'amsId' | 'slot'>, preset: string, color: string): Promise<boolean> {
  color = color.toUpperCase()
  const cur = sel.value.filaments.find((f) => f.tray === t.id)
  const ok = await ask({
    title: `Change ${trayName(t.id)}?`,
    confirm: 'Update printer',
    body: (
      <>
        <div class="change-row">
          <Spool color={cur && !cur.empty ? cur.color : undefined} preset={cur && !cur.empty ? cur.preset : undefined} />
          <span class="muted">→</span>
          <Spool color={color} preset={preset} />
        </div>
        <p class="muted small-text">The printer stores this for the tray, so its screen and every slicer will show it.</p>
      </>
    ),
  })
  return ok && editTray(t, preset, color)
}

/** Asks, then tells the printer which nozzle is installed. Resolves true if it was sent. */
export async function confirmNozzleEdit(diameter: number, type: string): Promise<boolean> {
  const label = (NOZZLE_TYPES.find(([v]) => v === type)?.[1] ?? type).toLowerCase()
  // The printer's answer switches the printer preset without asking (state/hardware.ts), so say now what that drops.
  const cur = bundle.value?.printers.find((p) => p.name === sel.value.printer)
  const next = bundle.value?.printers.find((p) => p.model === cur?.model && Number(p.nozzle) === diameter)
  const lost = next && next.name !== cur?.name ? describeChanges(setPrinter(next.name, {}, false)) : ''
  const ok = await ask({
    title: 'Change the nozzle?',
    confirm: 'Update printer',
    body: (
      <>
        <p>Tell the printer a <strong>{diameter} mm {label}</strong> nozzle is installed.</p>
        <p class="muted small-text">This must match the hotend that is actually fitted. The slicer switches presets once the printer confirms.</p>
        {lost && <p class="small-text">Switching to "{next!.name}" discards your {lost}.</p>}
      </>
    ),
  })
  return ok && editNozzle(diameter, type)
}
