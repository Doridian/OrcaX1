import { signal } from '@preact/signals'
import { gcodeState, mqttConnected, serial, status, wsConnected } from '../state/printer'
import { ConfirmHost } from './Confirm'
import { Device } from './device/Device'
import { Settings } from './Settings'
import { Sidebar } from './Sidebar'
import { Workspace } from './Workspace'

export type Page = 'prepare' | 'preview' | 'device' | 'settings'
export const page = signal<Page>('prepare')
const PAGE_LABELS: Record<Page, string> = { prepare: 'Prepare', preview: 'Preview', device: 'Device', settings: 'Settings' }

function JobChip() {
  const s = status.value
  const st = gcodeState.value
  if (!mqttConnected.value || st === 'UNKNOWN') return null
  const pct = Number(s.mc_percent ?? 0)
  return (
    <span class="muted" title={s.subtask_name ?? ''}>
      {st === 'RUNNING' || st === 'PAUSE' ? `${st === 'PAUSE' ? 'Paused' : 'Printing'} ${pct}% · ${s.mc_remaining_time ?? 0} min left` : st.toLowerCase()}
    </span>
  )
}

export function App() {
  const sliceView = page.value === 'prepare' || page.value === 'preview'
  return (
    <div class="app">
      <div class="topbar">
        <div class="brand">Orca<span>X1</span></div>
        <div class="tabs">
          {(['prepare', 'preview', 'device', 'settings'] as Page[]).map((p) => (
            <button class={page.value === p ? 'active' : ''} onClick={() => (page.value = p)}>
              {PAGE_LABELS[p]}
            </button>
          ))}
        </div>
        <div class="spacer" />
        <JobChip />
        <div class="conn" title="daemon websocket / printer MQTT">
          <span class={`dot ${wsConnected.value ? 'on' : ''}`} /> daemon
          <span class={`dot ${mqttConnected.value ? 'on' : ''}`} /> printer{serial.value ? ` ${serial.value}` : ''}
        </div>
      </div>
      {page.value === 'device' && <Device />}
      {page.value === 'settings' && <Settings />}
      {/* Kept mounted so the 3D view survives tab switches. */}
      <div class="workspace" style={sliceView ? undefined : { display: 'none' }}>
        <Sidebar />
        <Workspace mode={page.value === 'preview' ? 'preview' : 'prepare'} />
      </div>
      <ConfirmHost />
    </div>
  )
}
