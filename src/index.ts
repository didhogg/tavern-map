import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'

import { setWorkerUrl } from 'maplibre-gl'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url&no-inline'
import { MapUI } from './ui'
import type { StContext } from './types'

// MapLibre v6 resolves its worker relative to import.meta.url. A bundler moves
// the entry file, so point it at the worker asset Vite emits for us.
setWorkerUrl(maplibreWorkerUrl)

const BOOT_FLAG = '__tavernMapBooted'
const MAX_CONTEXT_RETRIES = 100
const RETRY_DELAY_MS = 200

type TavernWindow = Window & {
  SillyTavern?: { getContext?: () => StContext }
  __tavernMapBooted?: boolean
  __tavernMapUI?: MapUI
}

function readContext(): StContext | null {
  const api = (window as TavernWindow).SillyTavern
  try {
    const context = api?.getContext?.()
    if (context?.eventSource && context.extensionSettings) return context
  } catch (error) {
    console.warn('[tavern-map] getContext failed', error)
  }
  return null
}

function boot(attempt = 0): void {
  const target = window as TavernWindow
  if (target[BOOT_FLAG]) return

  const context = readContext()
  if (!context) {
    if (attempt < MAX_CONTEXT_RETRIES) {
      window.setTimeout(() => boot(attempt + 1), RETRY_DELAY_MS)
    } else {
      console.error('[tavern-map] SillyTavern context unavailable; extension did not start')
    }
    return
  }

  target[BOOT_FLAG] = true
  try {
    target.__tavernMapUI = new MapUI(context)
  } catch (error) {
    target[BOOT_FLAG] = false
    console.error('[tavern-map] failed to mount UI', error)
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => boot(), { once: true })
} else {
  boot()
}
