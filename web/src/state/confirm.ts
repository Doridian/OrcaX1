// In-app confirmation dialog (rendered by ui/Confirm.tsx).
import { signal } from '@preact/signals'
import type { ComponentChildren } from 'preact'

export interface ConfirmRequest {
  title: string
  body?: ComponentChildren
  /** Label of the confirming button (default "OK"). */
  confirm?: string
  /** Label of the declining button (default "Cancel"). */
  cancel?: string
  /** Label of a third button between the two (e.g. Orca's "Discard" next to "Transfer" and "Cancel"). */
  alt?: string
  danger?: boolean
}

export type Choice = 'confirm' | 'alt' | 'cancel'

export const confirmRequest = signal<(ConfirmRequest & { resolve: (c: Choice) => void }) | null>(null)

/** Asks the user; resolves with the button picked ('cancel' when dismissed). A newer request cancels an open one. */
export function choose(req: ConfirmRequest): Promise<Choice> {
  return new Promise((resolve) => {
    confirmRequest.value?.resolve('cancel')
    confirmRequest.value = { ...req, resolve }
  })
}

/** Asks the user; resolves true if they confirm. */
export async function ask(req: ConfirmRequest): Promise<boolean> {
  return (await choose(req)) === 'confirm'
}
