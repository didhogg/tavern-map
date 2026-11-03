import type { StContext } from './types'

export const PROMPT_KEY = 'tavern-map-scene'

let warned = false

export function syncPrompt(ctx: StContext, text: string, enabled: boolean, depth: number): void {
  if (typeof ctx.setExtensionPrompt !== 'function') {
    if (!warned) {
      warned = true
      console.warn('[tavern-map] setExtensionPrompt is unavailable; prompt injection disabled')
    }
    return
  }
  ctx.setExtensionPrompt(
    PROMPT_KEY,
    enabled ? text : '',
    ctx.extension_prompt_types?.IN_CHAT ?? 1,
    depth,
    false,
    ctx.extension_prompt_roles?.SYSTEM ?? 0,
    () => enabled,
  )
}

export function clearPrompt(ctx: StContext): void {
  if (typeof ctx.setExtensionPrompt !== 'function') return
  ctx.setExtensionPrompt(PROMPT_KEY, '', 0, 0, false, 0)
}
