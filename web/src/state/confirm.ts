// In-app confirmation dialog (rendered by ui/Confirm.tsx).
import { signal } from '@preact/signals'
import type { ComponentChildren } from 'preact'

export interface ConfirmRequest {
  title: string
  body?: ComponentChildren
  /** Label of the confirming button (default "OK"). */
  confirm?: string
  danger?: boolean
}

export const confirmRequest = signal<(ConfirmRequest & { resolve: (ok: boolean) => void }) | null>(null)

/** Asks the user; resolves true if they confirm. A newer request cancels an open one. */
export function ask(req: ConfirmRequest): Promise<boolean> {
  return new Promise((resolve) => {
    confirmRequest.value?.resolve(false)
    confirmRequest.value = { ...req, resolve }
  })
}
