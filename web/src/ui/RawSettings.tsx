// The Raw tab of the process, filament and printer settings: every key the
// preset stores (or the user overrode), edited as the text Orca writes, with
// lists joined by ';'.
import { useState } from 'preact/hooks'
import type { RawAccess } from '../state/presetSettings'

const LIMIT = 300

export function RawSettings({ raw }: { raw: RawAccess }) {
  const [q, setQ] = useState('')
  const filter = q.toLowerCase().replace(/\s+/g, '_')
  const keys = raw.keys().filter((k) => !filter || k.includes(filter))
  return (
    <div>
      <input type="text" placeholder="Filter keys…" value={q} onInput={(e) => setQ(e.currentTarget.value)} style={{ width: '100%', marginBottom: '6px' }} />
      {keys.slice(0, LIMIT).map((k) => {
        const v = raw.get(k)
        const text = Array.isArray(v) ? v.join(';') : v ?? ''
        const changed = raw.changed(k)
        return (
          <div class="row">
            <label title={k}>{k}</label>
            <div class="control">
              <input type="text" class={changed ? 'changed' : ''} value={text} spellcheck={false}
                onChange={(e) => {
                  const t = e.currentTarget.value
                  raw.set(k, Array.isArray(v) ? t.split(';') : t)
                }} />
              {changed && <button class="reset" title="Reset to preset" onClick={() => raw.set(k, null)}>↺</button>}
            </div>
          </div>
        )
      })}
      {keys.length > LIMIT && <div class="muted small-text">{keys.length - LIMIT} more; refine the filter.</div>}
    </div>
  )
}
