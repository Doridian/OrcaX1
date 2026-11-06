import { useEffect, useState } from 'preact/hooks'
import { deleteFile, downloadUrl, listFiles, startPrint, type FileEntry } from '../../api'
import { cmd, commandLog, gcodeState, isPrinting, mqttConnected, status } from '../../state/printer'
import { bundle, sel } from '../../state/settings'
import { ask } from '../../state/confirm'
import { EXTERNAL, trayColor } from '../../state/hardware'
import { confirmTrayEdit } from '../hardwareEdits'
import { fmtTime } from '../Workspace'
import { Camera } from './Camera'

export function Device() {
  return (
    <div class="device">
      <div style={{ display: 'grid', gap: '12px', alignContent: 'start' }}>
        <div class="card">
          <h2>Camera <span class="spacer" /><LightToggle /></h2>
          <Camera />
        </div>
        <Job />
        <Files />
      </div>
      <div style={{ display: 'grid', gap: '12px', alignContent: 'start' }}>
        {!mqttConnected.value && <div class="card warning">Printer not connected (MQTT). Controls are disabled.</div>}
        <Temps />
        <Ams />
        <Controls />
        <Log />
      </div>
    </div>
  )
}

function LightToggle() {
  const on = (status.value.lights_report ?? []).some((l: any) => l.node === 'chamber_light' && l.mode === 'on')
  // The bulb shows the light's reported state; clicking flips it.
  return (
    <button
      class={`small lightbulb${on ? ' on' : ''}`}
      aria-pressed={on}
      title={`Chamber light is ${on ? 'on' : 'off'} (click to turn ${on ? 'off' : 'on'})`}
      disabled={!mqttConnected.value}
      onClick={() => cmd.light('chamber_light', !on)}
    >
      <svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" /></svg>
    </button>
  )
}

const STAGES: Record<number, string> = {
  1: 'Auto bed leveling', 2: 'Heatbed preheating', 3: 'Vibration compensation', 4: 'Changing filament', 5: 'M400 pause',
  6: 'Paused (filament runout)', 7: 'Heating hotend', 8: 'Calibrating extrusion', 9: 'Scanning bed surface', 10: 'Inspecting first layer',
  11: 'Identifying build plate', 12: 'Calibrating micro lidar', 13: 'Homing toolhead', 14: 'Cleaning nozzle tip', 15: 'Checking extruder temperature',
  16: 'Paused by user', 17: 'Paused (front cover fell off)', 18: 'Calibrating micro lidar', 19: 'Calibrating extrusion flow', 20: 'Paused (nozzle temperature malfunction)',
  21: 'Paused (heatbed temperature malfunction)', 22: 'Filament unloading', 23: 'Paused (skipped step)', 24: 'Filament loading', 25: 'Calibrating motor noise',
  26: 'Paused (AMS lost)', 27: 'Paused (low speed of heatbreak fan)', 28: 'Paused (chamber temperature control error)', 29: 'Cooling chamber',
  30: 'Paused by G-code', 31: 'Motor noise showoff', 32: 'Paused (nozzle filament covered)', 33: 'Paused (cutter error)', 34: 'Paused (first layer error)',
  35: 'Paused (nozzle clog)',
}

function Job() {
  const s = status.value
  const st = gcodeState.value
  const pct = Number(s.mc_percent ?? 0)
  const stage = STAGES[Number(s.stg_cur)]
  const speedNames = ['', 'Silent', 'Standard', 'Sport', 'Ludicrous']
  const hms = (s.hms ?? []) as { attr: number; code: number }[]
  return (
    <div class="card job">
      <h2>Print job <span class="spacer" /><span class="muted">{st}</span></h2>
      <div><strong>{s.subtask_name || '—'}</strong></div>
      <div class="bar"><div style={{ width: `${pct}%` }} /></div>
      <dl class="kv">
        <dt>Progress</dt><dd>{pct}% · layer {s.layer_num ?? 0}/{s.total_layer_num ?? 0}</dd>
        <dt>Remaining</dt><dd>{fmtTime(Number(s.mc_remaining_time ?? 0) * 60)}</dd>
        {stage && <><dt>Stage</dt><dd>{stage}</dd></>}
        <dt>Speed</dt><dd>{speedNames[Number(s.spd_lvl)] ?? s.spd_lvl} ({s.spd_mag ?? 100}%)</dd>
        {Number(s.print_error) ? <><dt>Error</dt><dd class="error">0x{Number(s.print_error).toString(16).padStart(8, '0')}</dd></> : null}
      </dl>
      {hms.map((h) => (
        <div class="hms small-text">
          HMS {[h.attr >>> 16, h.attr & 0xffff, h.code >>> 16, h.code & 0xffff].map((v) => v.toString(16).padStart(4, '0').toUpperCase()).join('_')}{' '}
          <a href={`https://wiki.bambulab.com/en/x1/troubleshooting/hmscode/${[h.attr >>> 16, h.attr & 0xffff, h.code >>> 16, h.code & 0xffff].map((v) => v.toString(16).padStart(4, '0').toUpperCase()).join('_')}`} target="_blank" rel="noreferrer">wiki</a>
        </div>
      ))}
      <div class="btnrow">
        <button disabled={!mqttConnected.value || st !== 'RUNNING'} onClick={cmd.pause}>Pause</button>
        <button disabled={!mqttConnected.value || st !== 'PAUSE'} onClick={cmd.resume}>Resume</button>
        <button class="danger" disabled={!mqttConnected.value || !isPrinting.value} onClick={async () => { if (await ask({ title: 'Stop the current print?', body: 'The print is cancelled and cannot be resumed.', confirm: 'Stop print', danger: true })) cmd.stop() }}>Stop</button>
        <select disabled={!mqttConnected.value} value={String(s.spd_lvl ?? 2)} onChange={(e) => cmd.speed(+e.currentTarget.value)}>
          {[1, 2, 3, 4].map((l) => <option value={l}>{speedNames[l]}</option>)}
        </select>
      </div>
    </div>
  )
}

function TempBox({ label, cur, target, onSet }: { label: string; cur: any; target?: any; onSet?: (v: number) => void }) {
  const [v, setV] = useState('')
  return (
    <div class="temp">
      <div class="label">{label}</div>
      <div class="value">{cur != null ? Number(cur).toFixed(0) : '–'}°</div>
      {target != null && <div class="target">target {Number(target).toFixed(0)}°</div>}
      {onSet && (
        <form onSubmit={(e) => { e.preventDefault(); if (v !== '') { onSet(+v); setV('') } }}>
          <input type="number" min={0} max={320} value={v} placeholder="°C" onInput={(e) => setV(e.currentTarget.value)} disabled={!mqttConnected.value} />
          <button class="small" disabled={!mqttConnected.value || v === ''}>Set</button>
        </form>
      )}
    </div>
  )
}

function Temps() {
  const s = status.value
  return (
    <div class="card">
      <h2>Temperatures &amp; fans</h2>
      <div class="temps">
        <TempBox label="Nozzle" cur={s.nozzle_temper} target={s.nozzle_target_temper} onSet={(t) => cmd.gcode(`M104 S${t}`)} />
        <TempBox label="Bed" cur={s.bed_temper} target={s.bed_target_temper} onSet={(t) => cmd.gcode(`M140 S${t}`)} />
        <TempBox label="Chamber" cur={s.chamber_temper} />
      </div>
      <dl class="kv" style={{ marginTop: '8px' }}>
        <dt>Part fan</dt><dd><FanSlider p={1} speed={s.cooling_fan_speed} /></dd>
        <dt>Aux fan</dt><dd><FanSlider p={2} speed={s.big_fan1_speed} /></dd>
        <dt>Chamber fan</dt><dd><FanSlider p={3} speed={s.big_fan2_speed} /></dd>
        <dt>Heatbreak fan</dt><dd>{fanPct(s.heatbreak_fan_speed)}%</dd>
      </dl>
    </div>
  )
}

// The printer reports fan speeds in 16 steps (0-15).
const fanPct = (v: any) => Math.round((Number(v ?? 0) / 15) * 100)

// Shows the reported fan speed. While dragging, and after release until the
// printer reports a new speed (or a few seconds pass), it shows the chosen value.
function FanSlider({ p, speed }: { p: number; speed: any }) {
  const reported = fanPct(speed)
  const [pending, setPending] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  useEffect(() => { if (!dragging) setPending(null) }, [reported])
  useEffect(() => {
    if (pending === null || dragging) return
    const t = setTimeout(() => setPending(null), 5000)
    return () => clearTimeout(t)
  }, [pending, dragging])
  const shown = pending ?? reported
  return (
    <span class="fan-slider">
      <input
        type="range" min={0} max={100} step={5} value={shown}
        disabled={!mqttConnected.value}
        onInput={(e) => { setDragging(true); setPending(+e.currentTarget.value) }}
        onChange={(e) => {
          const pct = +e.currentTarget.value
          setDragging(false)
          setPending(pct)
          cmd.gcode(`M106 P${p} S${Math.round((pct / 100) * 255)}`)
        }}
      />
      <span class={pending !== null ? 'muted' : undefined}>{shown}%</span>
    </span>
  )
}

function Controls() {
  const [step, setStep] = useState(10)
  const dis = !mqttConnected.value || isPrinting.value
  const jog = (axis: string, d: number) => cmd.gcode(`M211 S\nM211 X1 Y1 Z1\nM1002 push_ref_mode\nG91\nG1 ${axis}${d} F${axis === 'Z' ? 600 : 3000}\nM1002 pop_ref_mode\nM211 R`, `jog ${axis}${d > 0 ? '+' : ''}${d}`)
  return (
    <div class="card">
      <h2>Control <span class="spacer" />
        <select value={String(step)} onChange={(e) => setStep(+e.currentTarget.value)}>
          {[0.1, 1, 10, 50].map((v) => <option value={v}>{v} mm</option>)}
        </select>
      </h2>
      <div class="jog">
        <span /><button disabled={dis} onClick={() => jog('Y', step)}>Y+</button><span />
        <span />
        <button disabled={dis} onClick={() => jog('Z', -step)} title="Bed up">Z−</button>
        <span />
        <button disabled={dis} onClick={() => jog('X', -step)}>X−</button>
        <button disabled={dis} onClick={() => cmd.gcode('G28', 'home')} title="Home all axes">⌂</button>
        <button disabled={dis} onClick={() => jog('X', step)}>X+</button>
        <span />
        <button disabled={dis} onClick={() => jog('Z', step)} title="Bed down">Z+</button>
        <span />
        <span /><button disabled={dis} onClick={() => jog('Y', -step)}>Y−</button><span />
      </div>
      <div class="btnrow">
        <button disabled={dis} onClick={() => cmd.gcode('M83\nG1 E10 F300')} title="Nozzle must be hot">Extrude 10 mm</button>
        <button disabled={dis} onClick={() => cmd.gcode('M83\nG1 E-10 F300')}>Retract 10 mm</button>
        <button disabled={dis} onClick={() => cmd.gcode('M84')}>Motors off</button>
        <button disabled={!mqttConnected.value} onClick={cmd.pushall}>Refresh status</button>
      </div>
      <GcodeConsole />
    </div>
  )
}

function GcodeConsole() {
  const [line, setLine] = useState('')
  return (
    <form class="row" style={{ marginTop: '8px' }} onSubmit={(e) => { e.preventDefault(); if (line.trim()) { cmd.gcode(line.replace(/\\n/g, '\n')); setLine('') } }}>
      <input type="text" style={{ flex: 1, fontFamily: 'ui-monospace, monospace' }} placeholder="G-code (\n for multiple lines)" value={line} onInput={(e) => setLine(e.currentTarget.value)} disabled={!mqttConnected.value} />
      <button disabled={!mqttConnected.value || !line.trim()}>Send</button>
    </form>
  )
}

function Ams() {
  const s = status.value
  const units = (s.ams?.ams ?? []) as any[]
  const trayNow = Number(s.ams?.tray_now ?? 255)
  const [edit, setEdit] = useState<{ ams: number; tray: number; t: any } | null>(null)
  const nozzleTemp = Number(s.nozzle_temper ?? 0)
  const load = (id: number, t: any) => {
    const target = Math.max(Number(t?.nozzle_temp_max ?? 220) - 10, 190)
    cmd.amsLoad(id, nozzleTemp, target)
  }
  const ext = s.vt_tray
  return (
    <div class="card">
      <h2>AMS <span class="spacer" />
        <button class="small" disabled={!mqttConnected.value || isPrinting.value} onClick={cmd.amsUnload}>Unload</button>
      </h2>
      {units.length === 0 && <div class="muted">No AMS reported.</div>}
      {units.map((u) => (
        <div class="ams-unit">
          <div class="head">
            <strong>AMS {Number(u.id) + 1}</strong>
            <span>humidity {u.humidity_raw != null ? `${u.humidity_raw}%` : `index ${u.humidity ?? '?'}`}</span>
            <span>{u.temp}°C</span>
          </div>
          <div class="trays">
            {[0, 1, 2, 3].map((i) => {
              const t = (u.tray ?? []).find((x: any) => Number(x.id) === i) ?? { id: String(i) }
              const id = Number(u.id) * 4 + i
              const empty = !t.tray_type
              return (
                <div class={`tray ${trayNow === id ? 'active' : ''}`} title={empty ? 'empty' : `${t.tray_sub_brands || t.tray_type} (${t.tray_info_idx})`}
                  onClick={() => setEdit({ ams: Number(u.id), tray: i, t })}>
                  <div class="spool" style={{ background: empty ? 'transparent' : trayColor(t), color: empty ? undefined : inkFor(trayColor(t)) }}>{empty ? '—' : t.tray_type}</div>
                  <div class="name">{empty ? 'Empty' : (t.tray_sub_brands || t.tray_type)}</div>
                  {!empty && Number(t.remain) >= 0 && <div class="muted small-text">{t.remain}%</div>}
                </div>
              )
            })}
          </div>
        </div>
      ))}
      {ext && (
        <div class="ams-unit">
          <div class="head"><strong>External spool</strong></div>
          <div class="trays">
            <div class={`tray ${trayNow === 254 ? 'active' : ''}`} onClick={() => setEdit({ ams: 255, tray: 254, t: ext })}>
              <div class="spool" style={{ background: ext.tray_type ? trayColor(ext) : 'transparent', color: ext.tray_type ? inkFor(trayColor(ext)) : undefined }}>{ext.tray_type || '—'}</div>
              <div class="name">{ext.tray_type ? ext.tray_sub_brands || ext.tray_type : 'Not set'}</div>
            </div>
          </div>
        </div>
      )}
      {edit && <TrayEditor {...edit} onClose={() => setEdit(null)} onLoad={() => { load(edit.ams === 255 ? 254 : edit.ams * 4 + edit.tray, edit.t); setEdit(null) }} />}
    </div>
  )
}

/** Readable label color on a filament swatch. */
function inkFor(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? '#000000aa' : '#ffffffcc'
}

function TrayEditor({ ams, tray, t, onClose, onLoad }: { ams: number; tray: number; t: any; onClose: () => void; onLoad: () => void }) {
  const b = bundle.value
  const fils = b ? b.filaments.filter((f) => f.compatible.includes(sel.value.printer) && f.filament_id) : []
  const id = ams === 255 ? EXTERNAL : ams * 4 + tray
  // Same preset the slicer shows for this tray.
  const current = sel.value.filaments.find((f) => f.tray === id && !f.empty)?.preset
  const [preset, setPreset] = useState(current ?? fils[0]?.name ?? '')
  const [color, setColor] = useState(t.tray_type ? trayColor(t) : '#FFFFFF')
  const save = async () => { if (await confirmTrayEdit({ id, amsId: ams, slot: tray }, preset, color)) onClose() }
  return (
    <div style={{ marginTop: '8px', borderTop: '1px solid var(--border)', paddingTop: '8px' }}>
      <div class="group-title">{ams === 255 ? 'External spool' : `AMS ${ams + 1} slot ${tray + 1}`}</div>
      <div class="filament-slot">
        <span class="swatch" style={{ background: color }}><input type="color" value={color} onInput={(e) => setColor(e.currentTarget.value)} /></span>
        <select value={preset} onChange={(e) => setPreset(e.currentTarget.value)}>
          {fils.map((f) => <option value={f.name}>{f.name}</option>)}
        </select>
      </div>
      <div class="btnrow">
        <button disabled={!mqttConnected.value} onClick={save}>Save to printer</button>
        <button disabled={!mqttConnected.value || isPrinting.value || !t.tray_type} onClick={onLoad}>Load</button>
        {ams !== 255 && <button disabled={!mqttConnected.value} onClick={() => cmd.amsRefreshRfid(ams, tray)}>Re-read RFID</button>}
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  )
}

function Files() {
  const [dir, setDir] = useState('')
  const [entries, setEntries] = useState<FileEntry[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const refresh = async () => {
    setErr(null)
    try { setEntries(await listFiles(dir)) } catch (e: any) { setErr(e?.message ?? String(e)); setEntries(null) }
  }
  useEffect(() => { refresh() }, [dir])
  const join = (n: string) => (dir ? `${dir}/${n}` : n)
  const print = async (path: string) => {
    if (!await ask({ title: `Print ${path}?`, body: 'Plate 1, with filaments mapped to AMS trays in file order.', confirm: 'Print' })) return
    try {
      await startPrint({ path, plate: 1, use_ams: true, ams_mapping: [], timelapse: false, bed_leveling: true, flow_cali: false, vibration_cali: false, layer_inspect: false, bed_type: 'auto' })
    } catch (e: any) { setErr(e?.message ?? String(e)) }
  }
  const sorted = [...(entries ?? [])].sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || b.mtime - a.mtime)
  return (
    <div class="card files">
      <h2>SD card <span class="muted">/{dir}</span><span class="spacer" />
        {dir && <button class="small" onClick={() => setDir(dir.split('/').slice(0, -1).join('/'))}>Up</button>}
        <button class="small" onClick={refresh}>Refresh</button>
      </h2>
      {err && <div class="error small-text">{err}</div>}
      <table>
        <tbody>
          {sorted.map((e) => (
            <tr>
              <td>{e.is_dir ? <a href="#" onClick={(ev) => { ev.preventDefault(); setDir(join(e.name)) }}>{e.name}/</a> : e.name}</td>
              <td class="num">{e.is_dir ? '' : `${(e.size / 1e6).toFixed(1)} MB`}</td>
              <td class="num muted">{e.mtime ? new Date(e.mtime * 1000).toLocaleString() : ''}</td>
              <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                {!e.is_dir && /\.3mf$/i.test(e.name) && <button class="small" disabled={!mqttConnected.value || isPrinting.value} onClick={() => print(join(e.name))}>Print</button>}{' '}
                {!e.is_dir && <a href={downloadUrl(join(e.name))}><button class="small">↓</button></a>}{' '}
                <button class="small danger" onClick={async () => { if (await ask({ title: `Delete ${join(e.name)}?`, confirm: 'Delete', danger: true })) { try { await deleteFile(join(e.name)); refresh() } catch (x: any) { setErr(String(x?.message ?? x)) } } }}>×</button>
              </td>
            </tr>
          ))}
          {entries && !entries.length && <tr><td class="muted">Empty</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

function Log() {
  return (
    <div class="card">
      <h2>Command log</h2>
      <div class="log">
        {commandLog.value.length === 0 && <div class="muted">No commands yet.</div>}
        {[...commandLog.value].reverse().map((l) => (
          <div class={l.ok === false ? 'error' : l.ok ? 'ok' : ''}>{new Date(l.t).toLocaleTimeString()} {l.text}</div>
        ))}
      </div>
    </div>
  )
}
