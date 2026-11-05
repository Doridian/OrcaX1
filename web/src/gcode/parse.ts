// G-code to preview geometry. Extrusion moves become line segments, grouped by
// layer in file order, so a layer range is a contiguous slice of the arrays.

export const FEATURES = [
  ['Outer wall', '#FF7D38'],
  ['Inner wall', '#FFE64D'],
  ['Overhang wall', '#1F1FFF'],
  ['Sparse infill', '#B03029'],
  ['Internal solid infill', '#9654CC'],
  ['Top surface', '#F04040'],
  ['Bottom surface', '#6699CC'],
  ['Bridge', '#4D80BA'],
  ['Gap infill', '#FFFFFF'],
  ['Ironing', '#FF8C69'],
  ['Skirt', '#00876E'],
  ['Brim', '#00876E'],
  ['Support', '#00FF00'],
  ['Support interface', '#008000'],
  ['Support transition', '#4CAF50'],
  ['Prime tower', '#B3E3AB'],
  ['Custom', '#5ED194'],
  ['Other', '#888888'],
] as const

const FEATURE_INDEX = new Map<string, number>(FEATURES.map(([n], i) => [n.toLowerCase(), i]))
const ALIASES: Record<string, string> = {
  'external perimeter': 'outer wall',
  perimeter: 'inner wall',
  'overhang perimeter': 'overhang wall',
  'internal infill': 'sparse infill',
  'solid infill': 'internal solid infill',
  'top solid infill': 'top surface',
  'bottom solid infill': 'bottom surface',
  'bridge infill': 'bridge',
  'internal bridge': 'bridge',
  'gap fill': 'gap infill',
  'support material': 'support',
  'support material interface': 'support interface',
  'wipe tower': 'prime tower',
  'skirt/brim': 'skirt',
}
export function featureIndex(name: string): number {
  const n = name.trim().toLowerCase()
  return FEATURE_INDEX.get(n) ?? FEATURE_INDEX.get(ALIASES[n] ?? '') ?? FEATURES.length - 1
}

export interface GcodePreview {
  /** xyz start, xyz end per segment */
  segments: Float32Array
  feature: Uint8Array
  tool: Uint8Array
  /** per segment: extrusion width estimate (mm) */
  layerStart: Uint32Array
  layerZ: Float32Array
  segmentCount: number
  layerCount: number
  /** "; key: value" header comments (time, filament...) */
  header: Record<string, string>
}

export function parseGcode(text: string): GcodePreview {
  let cap = 1 << 16
  let seg = new Float32Array(cap * 6)
  let feat = new Uint8Array(cap)
  let tool = new Uint8Array(cap)
  let n = 0
  const layerStart: number[] = []
  const layerZ: number[] = []
  const header: Record<string, string> = {}

  let x = 0, y = 0, z = 0, e = 0
  let absXYZ = true, absE = false
  let feature = FEATURES.length - 1
  let t = 0
  let pendingLayer = true
  let lastLayerZ = -1

  const grow = () => {
    cap *= 2
    const s2 = new Float32Array(cap * 6); s2.set(seg); seg = s2
    const f2 = new Uint8Array(cap); f2.set(feat); feat = f2
    const t2 = new Uint8Array(cap); t2.set(tool); tool = t2
  }
  const push = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    if (n >= cap) grow()
    if (pendingLayer || (z1 > lastLayerZ + 1e-4 && layerStart.length === 0)) {
      layerStart.push(n)
      layerZ.push(z1)
      lastLayerZ = z1
      pendingLayer = false
    }
    const o = n * 6
    seg[o] = x0; seg[o + 1] = y0; seg[o + 2] = z0; seg[o + 3] = x1; seg[o + 4] = y1; seg[o + 5] = z1
    feat[n] = feature
    tool[n] = t
    n++
  }

  let pos = 0
  const len = text.length
  while (pos < len) {
    let end = text.indexOf('\n', pos)
    if (end < 0) end = len
    let line = text.slice(pos, end)
    pos = end + 1
    if (line.length === 0) continue
    const c0 = line.charCodeAt(0)
    if (c0 === 59 /* ; */) {
      // Comments carry the structure.
      const body = line.slice(1).trim()
      if (body === 'CHANGE_LAYER' || body === 'LAYER_CHANGE') { pendingLayer = true; continue }
      if (body.startsWith('FEATURE:')) { feature = featureIndex(body.slice(8)); continue }
      if (body.startsWith('TYPE:')) { feature = featureIndex(body.slice(5)); continue }
      const colon = body.indexOf(':')
      if (colon > 0 && colon < 60 && layerStart.length === 0) {
        const key = body.slice(0, colon).trim()
        if (!(key in header)) header[key] = body.slice(colon + 1).trim()
      } else {
        const eq = body.indexOf(' = ')
        if (eq > 0 && eq < 60 && layerStart.length === 0) header[body.slice(0, eq).trim()] = body.slice(eq + 3).trim()
      }
      continue
    }
    const sc = line.indexOf(';')
    if (sc >= 0) line = line.slice(0, sc)
    line = line.trim()
    if (!line) continue
    const sp = line.indexOf(' ')
    const code = (sp < 0 ? line : line.slice(0, sp)).toUpperCase()
    if (code === 'G1' || code === 'G0' || code === 'G2' || code === 'G3') {
      let nx = x, ny = y, nz = z, de = 0, hasE = false, I = 0, J = 0
      const words = line.slice(sp + 1).split(' ')
      for (const w of words) {
        if (!w) continue
        const v = parseFloat(w.slice(1))
        switch (w.charCodeAt(0) & ~32) {
          case 88: nx = absXYZ ? v : x + v; break // X
          case 89: ny = absXYZ ? v : y + v; break // Y
          case 90: nz = absXYZ ? v : z + v; break // Z
          case 69: hasE = true; de = absE ? v - e : v; if (absE) e = v; break // E
          case 73: I = v; break
          case 74: J = v; break
        }
      }
      const extruding = hasE && de > 0 && code !== 'G0'
      if (extruding) {
        if (code === 'G2' || code === 'G3') {
          // Arc around (x+I, y+J), split into short chords.
          const cx = x + I, cy = y + J
          const r = Math.hypot(I, J)
          let a0 = Math.atan2(y - cy, x - cx)
          let a1 = Math.atan2(ny - cy, nx - cx)
          const cw = code === 'G2'
          if (cw && a1 >= a0) a1 -= 2 * Math.PI
          if (!cw && a1 <= a0) a1 += 2 * Math.PI
          const steps = Math.max(2, Math.min(64, Math.ceil(Math.abs(a1 - a0) * r / 0.5)))
          let px = x, py = y, pz = z
          for (let s = 1; s <= steps; s++) {
            const a = a0 + (a1 - a0) * (s / steps)
            const qx = s === steps ? nx : cx + r * Math.cos(a)
            const qy = s === steps ? ny : cy + r * Math.sin(a)
            const qz = z + (nz - z) * (s / steps)
            push(px, py, pz, qx, qy, qz)
            px = qx; py = qy; pz = qz
          }
        } else if (nx !== x || ny !== y || nz !== z) {
          push(x, y, z, nx, ny, nz)
        }
      }
      x = nx; y = ny; z = nz
    } else if (code === 'G90') absXYZ = true
    else if (code === 'G91') absXYZ = false
    else if (code === 'M82') absE = true
    else if (code === 'M83') absE = false
    else if (code === 'G92') {
      for (const w of line.slice(sp + 1).split(' ')) {
        const v = parseFloat(w.slice(1))
        switch (w.charCodeAt(0) & ~32) {
          case 69: e = v; break
          case 88: x = v; break
          case 89: y = v; break
          case 90: z = v; break
        }
      }
    } else if (code.charCodeAt(0) === 84 /* T */ && code.length <= 4) {
      const tv = parseInt(code.slice(1), 10)
      if (Number.isFinite(tv) && tv < 255) t = tv
    } else if (code === 'M620' || code === 'M621') {
      // Bambu filament change macros: "M620 S<n>A" selects tool n.
      const m = /S(\d+)/.exec(line)
      if (m && code === 'M620') { const tv = parseInt(m[1], 10); if (tv < 255) t = tv }
    }
  }
  return {
    segments: seg.slice(0, n * 6),
    feature: feat.slice(0, n),
    tool: tool.slice(0, n),
    layerStart: Uint32Array.from(layerStart),
    layerZ: Float32Array.from(layerZ),
    segmentCount: n,
    layerCount: layerStart.length,
    header,
  }
}
