import { render } from 'preact'
import { App } from './ui/App'
import { connectPrinter } from './state/printer'
import { initSettings } from './state/settings'
import './styles.css'

initSettings()
connectPrinter()
render(<App />, document.getElementById('app')!)

if (import.meta.env.DEV) {
  // Debug handle for the browser console / automated tests.
  Promise.all([import('./state/slice'), import('./state/project'), import('./state/settings')]).then(([slice, project, settings]) => {
    ;(window as any).__orcax1 = { ...slice, ...project, ...settings }
  })
}
