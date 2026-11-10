import { effect } from '@preact/signals'
import { render } from 'preact'
import { App } from './ui/App'
import { Login } from './ui/Login'
import { auth, refreshAuth } from './state/auth'
import { connectPrinter, disconnectPrinter } from './state/printer'
import { initHardwareSync } from './state/hardware'
import { initSettings } from './state/settings'
import { initAutosave } from './state/autosave'
import { initProcessRules } from './state/processRules'
import './styles.css'

function Root() {
  const a = auth.value
  if (!a) return <div class="login"><div class="muted">Connecting…</div></div>
  return a.authenticated ? <App /> : <Login />
}

initSettings()
initAutosave()
initHardwareSync()
initProcessRules()
effect(() => {
  if (auth.value?.authenticated) connectPrinter()
  else disconnectPrinter()
})
const boot = () => refreshAuth().catch(() => setTimeout(boot, 2000))
boot()
render(<Root />, document.getElementById('app')!)

// The service worker serves a small "printer is off" page (outlet.html) when
// the printer doesn't answer; see sw.template.js. Not in dev: Vite serves
// sources, not the built page it caches.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register(new URL('sw.js', document.baseURI)).catch((e) => console.warn('service worker:', e))
}

if (import.meta.env.DEV) {
  // Debug handle for the browser console / automated tests.
  Promise.all([import('./state/slice'), import('./state/project'), import('./state/settings'), import('./state/printer'), import('./state/hardware'), import('./state/projectFile'), import('./state/volumes')]).then(([slice, project, settings, printer, hardware, projectFile, volumes]) => {
    ;(window as any).__orcax1 = { ...slice, ...project, ...settings, ...printer, ...hardware, ...projectFile, ...volumes }
  })
}
