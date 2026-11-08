import { useEffect, useRef, useState } from 'preact/hooks'
import { EXTERNAL, trayName } from '../state/hardware'
import { mqttConnected } from '../state/printer'
import { currentPlate, objects, partNames } from '../state/project'
import { bundle, sel } from '../state/settings'
import { finalizeBambu3mf, type PlateInfo } from '../slicer/bambu3mf'
import type { Progress } from '../slicer/engine'
import { exportPrintable, plates } from '../state/slice'
import { uploadFile, startPrint } from '../api'
import { sceneView } from './Workspace'

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
  return finalizeBambu3mf(raw, bundle.value!, sel.value, infos, partNames(objects.value))
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

  // Slots mirror the printer's trays, so the mapping is fixed: slot i prints from its tray.
  const problems: string[] = []
  for (const i of needed) {
    const f = fils[i]
    if (!f) problems.push(`Filament ${i + 1} doesn't exist.`)
    else if (f.tray === undefined) problems.push(`Filament ${i + 1} isn't linked to a printer tray yet (waiting for the printer).`)
    else if (f.empty) problems.push(`Filament ${i + 1} (${trayName(f.tray)}) is empty.`)
  }
  const external = needed.filter((i) => fils[i]?.tray === EXTERNAL)
  if (external.length && external.length !== needed.length) problems.push('The external spool and AMS trays can\'t be used in the same print.')
  const useAms = !external.length

  const baseName = (objects.value.find((o) => o.plate === plate)?.name ?? 'print').replace(/[^\w.\- ]+/g, '_').slice(0, 60)
  const [name, setName] = useState(baseName)
  const [opts, setOpts] = useState({ bed_leveling: true, flow_cali: false, timelapse: false, vibration_cali: false, layer_inspect: false })
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
        const ams_mapping = fils.map((f, i) => (needed.includes(i) ? f.tray ?? -1 : -1))
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
            <select value={String(plate)} onChange={(e) => setPlate(+e.currentTarget.value)}>
              {usedPlates.map((p) => <option value={p}>Plate {p + 1}</option>)}
            </select>
          </div></div>
        )}
        <div class="group-title">Filaments</div>
        <div class="mapping">
          {needed.map((i) => (
            <>
              <span class="swatch" style={{ background: fils[i]?.empty ? 'transparent' : fils[i]?.color }} />
              <span title={fils[i]?.preset}>{i + 1}: {fils[i]?.preset.replace(/ @.*$/, '')}</span>
              <span>→</span>
              <span>{trayName(fils[i]?.tray)}</span>
            </>
          ))}
        </div>
        {problems.map((p) => <div class="warning small-text">{p}</div>)}
        <div class="group-title">Options</div>
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
        <button class="primary" onClick={() => send(true)} disabled={!!phase || !mqttConnected.value || problems.length > 0}>Print</button>
      </footer>
    </dialog>
  )
}
