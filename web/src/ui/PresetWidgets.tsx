// Read-only views of the options Orca edits with a custom widget instead of a
// plain field (create_line_with_widget in Tab.cpp): the bed shape, the
// filament's compatible printers and process profiles, and the ramming
// parameters. None of them can be changed here: the bed belongs to the printer
// model, compatibility to the system preset, and ramming is unused on Bambu
// Lab printers (see RammingView).
import type { ComponentChildren } from 'preact'
import type { OptionLine, SettingsSchema } from '../slicer/schema'
import type { RawAccess } from '../state/presetSettings'

interface WidgetProps { line: OptionLine; schema: SettingsSchema; raw: RawAccess; compatiblePrinters?: string[] }

const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? v.split(',') : [])
const num = (n: number) => String(Math.round(n * 100) / 100)

function Row({ label, tip, children }: { label: string; tip?: string; children: ComponentChildren }) {
  return (
    <div class="row disabled" title={tip}>
      <label title={tip}>{label}</label>
      <div class="control widget-value">{children}</div>
    </div>
  )
}

/** BedShapePanel's summary: a rectangle's size and origin, else the outline's point count. */
export function bedShapeText(points: string[]): string {
  const pts = points.map((p) => p.split('x').map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite))
  if (!pts.length) return 'Not set'
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const rect = pts.length === 4 && pts.every(([x, y]) => (x === x0 || x === x1) && (y === y0 || y === y1))
  // Orca's bed origin is where (0, 0) sits relative to the first corner.
  const origin = `${num(-pts[0][0])}, ${num(-pts[0][1])}`
  return rect
    ? `Rectangle ${num(x1 - x0)} × ${num(y1 - y0)} mm, origin ${origin}`
    : `Custom outline of ${pts.length} points, ${num(x1 - x0)} × ${num(y1 - y0)} mm`
}

export interface Ramming { lineWidth: number; step: number; speeds: number[] }

/** RammingPanel's format: line width %, step %, then the volumetric speed every 0.25 s; after '|' the chart's handles. */
export function parseRamming(text: string): Ramming | null {
  const nums = (text.split('|')[0] ?? '').trim().split(/\s+/).map(Number).filter(Number.isFinite)
  if (nums.length < 2) return null
  return { lineWidth: nums[0], step: nums[1], speeds: nums.slice(2) }
}

function RammingView({ text }: { text: string }) {
  const r = parseRamming(text)
  if (!r) return <span class="muted">{text || 'Not set'}</span>
  const time = r.speeds.length * 0.25, volume = r.speeds.reduce((a, s) => a + s * 0.25, 0)
  return <>
    <span>{r.speeds.length ? `${num(time)} s, ${num(volume)} mm³` : 'No ramming'}; line width {num(r.lineWidth)}%, step {num(r.step)}%</span>
    {r.speeds.length > 0 && <span class="muted small-text">Speeds every 0.25 s (mm³/s): {r.speeds.map(num).join(', ')}</span>}
  </>
}

const RAMMING_NOTE = 'Ramming shapes the filament tip before a tool change on single-extruder multi-material printers with the '
  + 'Prusa-style wipe tower. Bambu Lab printers always use Orca\'s Bambu wipe tower, which cuts the filament and does not read '
  + 'these parameters, so Orca\'s ramming chart is shown here read-only.'

/** Renders a widget line, or null for an unknown one (then shown as plain fields). */
export function PresetWidget({ line, schema, raw, compatiblePrinters }: WidgetProps) {
  const k = line.keys[0]
  const def = schema.options[k]
  const label = line.label ?? def?.label ?? k
  const tip = `${def?.tooltip ? def.tooltip + '\n\n' : ''}${k}`
  const v = raw.get(k) ?? def?.default
  switch (k) {
    case 'printable_area':
      return <Row label={label} tip={`Part of the printer model\n\n${tip}`}>{bedShapeText(list(v))}</Row>
    case 'compatible_printers': {
      const names = compatiblePrinters ?? list(v)
      return (
        <Row label={label} tip={`Fixed by the system preset; only the X1-series printers are bundled.\n\n${tip}`}>
          {names.length ? names.map((n) => <span>{n}</span>) : <span>All</span>}
        </Row>
      )
    }
    case 'compatible_prints': {
      const names = list(v)
      return (
        <Row label={label} tip={`Fixed by the system preset\n\n${tip}`}>
          {names.length ? names.map((n) => <span>{n}</span>) : <span>All</span>}
        </Row>
      )
    }
    case 'filament_ramming_parameters':
      return (
        <Row label={label} tip={`${RAMMING_NOTE}\n\n${tip}`}>
          <RammingView text={list(v)[0] ?? ''} />
        </Row>
      )
  }
  return null
}
