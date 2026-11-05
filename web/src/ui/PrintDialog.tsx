import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { mqttConnected, status } from '../state/printer'
import { currentPlate, objects } from '../state/project'
import { bundle, sel } from '../state/settings'
import { finalizeBambu3mf, type PlateInfo } from '../slicer/bambu3mf'
import type { Progress } from '../slicer/engine'
import { exportPrintable, plates } from '../state/slice'
import { uploadFile, startPrint } from '../api'
import { trayColor } from './Sidebar'
import { sceneView } from './Workspace'

interface Tray { id: number; label: string; color: string; type: string }

function trays(): Tray[] {
  const st = status.value
  const out: Tray[] = []
  for (const unit of st.ams?.ams ?? []) {
    for (const t of unit.tray ?? []) {
      if (!t.tray_type) continue
      out.push({ id: Number(unit.id) * 4 + Number(t.id), label: `AMS ${Number(unit.id) + 1} slot ${Number(t.id) + 1}`, color: trayColor(t), type: String(t.tray_type) })
    }
  }
  if (st.vt_tray?.tray_type) out.push({ id: 254, label: 'External spool', color: trayColor(st.vt_tray), type: String(st.vt_tray.tray_type) })
  return out
}

function colorDist(a: string, b: string) {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const x = p(a), y = p(b)
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
}

/** Engine export + Bambu metadata (thumbnails, slice_info) for the printer. */
async function buildPrintable(onProgress?: (p: Progress) => void): Promise<Uint8Array> {
  const raw = await exportPrintable(onProgress)
  const colors = sel.value.filaments.map((f) => f.color)
  const infos: PlateInfo[] = []
  for (const p of plates.value) {
    const list = objects.value.filter((o) => o.plate === p.plateIndex)
    const info: PlateInfo = { index: p.plateIndex, statistics: p.statistics }
    if (sceneView && list.length) {
      info.thumbnail = await sceneView.thumbnail(list, colors, 512)
      info.thumbnailSmall = await sceneView.thumbnail(list, colors, 128)
    }
    infos.push(info)
  }
  return finalizeBambu3mf(raw, bundle.value!, sel.value, infos)
}

export function PrintDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal() }, [])

  const usedPlates = [...new Set(objects.value.map((o) => o.plate))].sort((a, b) => a - b)
  const [plate, setPlate] = useState(usedPlates.includes(currentPlate.value) ? currentPlate.value : usedPlates[0] ?? 0)
  const fils = sel.value.filaments
  const used = [...new Set(objects.value.filter((o) => o.plate === plate).map((o) => o.filament))].sort((a, b) => a - b)
  // Prime tower / supports can use filaments not assigned to objects; the slice stats know.
  const sliced = plates.value.find((p) => p.plateIndex === plate)
  const printing: number[] = sliced?.statistics?.printingExtruders ?? used
  const needed = [...new Set([...used, ...printing])].sort((a, b) => a - b)

  const available = trays()
  const auto = useMemo(() => {
    const m: Record<number, number> = {}
    const taken = new Set<number>()
    for (const i of needed) {
      const f = fils[i]
      if (!f) continue
      const type = f.preset.match(/(PLA|PETG|ABS|ASA|TPU|PA|PC|PET|PVA|HIPS)/i)?.[1]?.toUpperCase()
      const cands = available
        .filter((t) => !taken.has(t.id))
        .sort((a, b) => (Number(b.type.toUpperCase().startsWith(type ?? '~')) - Number(a.type.toUpperCase().startsWith(type ?? '~'))) || colorDist(a.color, f.color) - colorDist(b.color, f.color))
      if (cands[0]) { m[i] = cands[0].id; taken.add(cands[0].id) }
    }
    return m
  }, [plate, available.map((t) => t.id + t.color).join(), fils.map((f) => f.color + f.preset).join()])
  const [mapping, setMapping] = useState<Record<number, number>>({})
  const effective = { ...auto, ...mapping }

  const baseName = (objects.value.find((o) => o.plate === plate)?.name ?? 'print').replace(/[^\w.\- ]+/g, '_').slice(0, 60)
  const [name, setName] = useState(baseName)
  const [opts, setOpts] = useState({ bed_leveling: true, flow_cali: false, timelapse: false, vibration_cali: false, layer_inspect: false, use_ams: available.some((t) => t.id !== 254) })
  const [phase, setPhase] = useState<string | null>(null)
  const [pct, setPct] = useState(0)
  const [err, setErr] = useState<string | null>(null)

  const download = async () => {
    setErr(null)
    try {
      setPhase('Exporting…')
      const bytes = await buildPrintable()
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `${name}.gcode.3mf`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
      setPhase(null)
    } catch (e: any) { setErr(e?.message ?? String(e)); setPhase(null) }
  }

  const send = async (andPrint: boolean) => {
    setErr(null)
    try {
      setPhase('Slicing / exporting…')
      const bytes = await buildPrintable((p) => setPct(p.percent ?? 0))
      const path = `orcax1/${name}.gcode.3mf`
      setPhase('Uploading to printer…')
      await uploadFile(path, bytes, (f) => setPct(Math.round(f * 100)))
      if (andPrint) {
        setPhase('Starting print…')
        const ams_mapping = fils.map((_, i) => (needed.includes(i) ? (effective[i] ?? -1) : -1))
        const useAms = opts.use_ams && needed.every((i) => effective[i] !== undefined && effective[i] !== 254)
        await startPrint({
          path,
          plate: plate + 1,
          use_ams: useAms,
          ams_mapping: useAms ? ams_mapping : [],
          timelapse: opts.timelapse,
          bed_leveling: opts.bed_leveling,
          flow_cali: opts.flow_cali,
          vibration_cali: opts.vibration_cali,
          layer_inspect: opts.layer_inspect,
          bed_type: 'auto',
        })
      }
      setPhase(null)
      onClose()
    } catch (e: any) { setErr(e?.message ?? String(e)); setPhase(null) }
  }

  const check = (k: keyof typeof opts, label: string) => (
    <label class="check"><input type="checkbox" checked={opts[k]} onChange={(e) => setOpts({ ...opts, [k]: e.currentTarget.checked })} /> {label}</label>
  )

  return (
    <dialog ref={ref} onClose={onClose}>
      <header>Send to printer</header>
      <div class="body">
        {!mqttConnected.value && <div class="warning">The printer is not connected; you can still download the file.</div>}
        <div class="row"><label>File name</label><div class="control"><input type="text" value={name} onInput={(e) => setName(e.currentTarget.value)} /><span class="unit">.gcode.3mf</span></div></div>
        {usedPlates.length > 1 && (
          <div class="row"><label>Plate to print</label><div class="control">
            <select value={String(plate)} onChange={(e) => { setPlate(+e.currentTarget.value); setMapping({}) }}>
              {usedPlates.map((p) => <option value={p}>Plate {p + 1}</option>)}
            </select>
          </div></div>
        )}
        <div class="group-title">Filament mapping</div>
        {available.length === 0 && <div class="muted small-text">No AMS or external spool information from the printer.</div>}
        <div class="mapping">
          {needed.map((i) => (
            <>
              <span class="swatch" style={{ background: fils[i]?.color }} />
              <span title={fils[i]?.preset}>{i + 1}: {fils[i]?.preset.replace(/ @.*$/, '')}</span>
              <span>→</span>
              <select value={String(effective[i] ?? '')} onChange={(e) => setMapping({ ...mapping, [i]: +e.currentTarget.value })}>
                <option value="">(none)</option>
                {available.map((t) => <option value={t.id}>{t.label}: {t.type}</option>)}
              </select>
            </>
          ))}
        </div>
        <div class="group-title">Options</div>
        {check('use_ams', 'Use AMS')}
        {check('bed_leveling', 'Bed leveling')}
        {check('flow_cali', 'Flow dynamics calibration')}
        {check('vibration_cali', 'Vibration compensation calibration')}
        {check('layer_inspect', 'First layer inspection')}
        {check('timelapse', 'Timelapse')}
        {phase && (
          <>
            <div class="muted" style={{ marginTop: '8px' }}>{phase}</div>
            <div class="progress"><div style={{ width: `${pct}%` }} /></div>
          </>
        )}
        {err && <div class="error">{err}</div>}
      </div>
      <footer>
        <button onClick={() => ref.current?.close()} disabled={!!phase}>Cancel</button>
        <button onClick={download} disabled={!!phase}>Download</button>
        <button onClick={() => send(false)} disabled={!!phase}>Upload only</button>
        <button class="primary" onClick={() => send(true)} disabled={!!phase || !mqttConnected.value}>Print</button>
      </footer>
    </dialog>
  )
}
