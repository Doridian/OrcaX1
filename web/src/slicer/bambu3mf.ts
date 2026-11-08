// Post-processing of the engine's printable 3MF so it matches what Bambu
// Studio sends: plate thumbnails (shown on the printer screen) and the
// slice_info details the firmware reads (printer model id, per-filament tray
// info, time/weight prediction).
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { renameParts } from '../model/project3mf'
import type { ProfileBundle, Selection } from './profiles'

export interface PlateInfo {
  index: number // 0-based
  statistics: any
  thumbnail?: Blob
  thumbnailSmall?: Blob
}

const xmlEscape = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!)

function setMeta(block: string, key: string, value: string): string {
  const re = new RegExp(`(<metadata key="${key}" value=")[^"]*("/>)`)
  if (re.test(block)) return block.replace(re, `$1${xmlEscape(value)}$2`)
  return block.replace(/(<plate>\s*\n?)/, `$1    <metadata key="${key}" value="${xmlEscape(value)}"/>\n`)
}

/** `names`: part names in the engine export (manifest ids) → display names (see renameParts). */
export async function finalizeBambu3mf(bytes: Uint8Array, bundle: ProfileBundle, sel: Selection, plates: PlateInfo[], names: Record<string, string> = {}): Promise<Uint8Array> {
  const files = unzipSync(bytes)
  const printer = bundle.printers.find((p) => p.name === sel.printer)
  const modelId = bundle.models.find((m) => m.name === printer?.model)?.model_id ?? ''

  for (const p of plates) {
    const n = p.index + 1
    if (p.thumbnail && !files[`Metadata/plate_${n}.png`]) files[`Metadata/plate_${n}.png`] = new Uint8Array(await p.thumbnail.arrayBuffer())
    if (p.thumbnailSmall && !files[`Metadata/plate_${n}_small.png`]) files[`Metadata/plate_${n}_small.png`] = new Uint8Array(await p.thumbnailSmall.arrayBuffer())
  }

  const si = files['Metadata/slice_info.config']
  if (si) {
    let xml = strFromU8(si)
    xml = xml.replace(/<plate>[\s\S]*?<\/plate>/g, (block) => {
      const idx = Number(/<metadata key="index" value="(\d+)"/.exec(block)?.[1] ?? '1') - 1
      const info = plates.find((p) => p.index === idx)
      const st = info?.statistics
      block = setMeta(block, 'printer_model_id', modelId)
      if (st?.timeSeconds?.normal != null) block = setMeta(block, 'prediction', String(Math.round(st.timeSeconds.normal)))
      if (st?.filament?.totalMassG != null) block = setMeta(block, 'weight', st.filament.totalMassG.toFixed(2))
      if (st?.timeSeconds?.firstLayer != null) block = setMeta(block, 'first_layer_time', st.timeSeconds.firstLayer.toFixed(2))
      if (!/<filament /.test(block) && st) {
        const used: number[] = st.printingExtruders ?? []
        const lines = used.map((i) => {
          const slot = sel.filaments[i]
          const preset = bundle.filaments.find((f) => f.name === slot?.preset)
          const m = st.filament?.lengthMmByExtruder?.[i] ?? 0
          const g = st.filament?.massGByExtruder?.[i] ?? 0
          return `    <filament id="${i + 1}" tray_info_idx="${xmlEscape(preset?.filament_id ?? '')}" type="${xmlEscape(preset?.type ?? '')}" color="${xmlEscape(slot?.color ?? '#FFFFFF')}" used_m="${(m / 1000).toFixed(2)}" used_g="${g.toFixed(2)}" />`
        })
        block = block.replace('</plate>', `${lines.join('\n')}\n  </plate>`)
      }
      return block
    })
    files['Metadata/slice_info.config'] = strToU8(xml)
  }

  const ms = files['Metadata/model_settings.config']
  if (ms) {
    let xml = strFromU8(ms)
    xml = xml.replace(/<plate>[\s\S]*?<\/plate>/g, (block) => {
      const n = Number(/<metadata key="plater_id" value="(\d+)"/.exec(block)?.[1] ?? '1')
      if (!files[`Metadata/plate_${n}.png`] || /thumbnail_file/.test(block)) return block
      return block.replace(/(<metadata key="gcode_file"[^>]*\/>)/, `$1\n    <metadata key="thumbnail_file" value="Metadata/plate_${n}.png"/>`)
    })
    files['Metadata/model_settings.config'] = strToU8(renameParts(xml, names))
  }

  // G-code is incompressible-ish text; level 6 keeps zipping fast.
  return zipSync(files, { level: 6 })
}
