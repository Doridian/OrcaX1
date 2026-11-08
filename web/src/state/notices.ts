// Warnings shown above the process settings: Orca's "... Reset to X." message
// boxes from the process rules (state/processRules.tsx), and what a printer
// switch discarded (state/settings.ts).
import { signal } from '@preact/signals'

export interface Notice { id: number; text: string }
export const processNotices = signal<Notice[]>([])
let nextNotice = 1

export function notify(text: string) {
  if (!processNotices.value.some((n) => n.text === text)) processNotices.value = [...processNotices.value, { id: nextNotice++, text }]
}
export const clearNotices = () => { processNotices.value = [] }
export const dismissNotice = (id: number) => { processNotices.value = processNotices.value.filter((n) => n.id !== id) }
