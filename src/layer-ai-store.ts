import type { LayerAIPart, LayerPlaceAIFlags } from './layer-types'

/** Explicit per-item choices. Missing flags follow the current global defaults. */
export type LayerAIKind = 'place' | 'region' | 'road'

const STORAGE_KEY = 'tavern-map:layer-place-ai:v1'
const PARTS: LayerAIPart[] = ['source', 'wiki', 'note']

type StoreShape = {
  version: 1
  revision?: number
  maps: Record<string, Record<string, LayerPlaceAIFlags>>
}

function sanitizeFlags(value: unknown): LayerPlaceAIFlags | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  const flags: LayerPlaceAIFlags = {}
  for (const part of PARTS) {
    if (typeof item[part] === 'boolean') flags[part] = item[part]
  }
  return Object.keys(flags).length > 0 ? flags : undefined
}

function loadStore(): StoreShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { version: 1, maps: {} }
    const value = JSON.parse(raw) as Partial<StoreShape>
    return {
      version: 1,
      revision: typeof value.revision === 'number' ? value.revision : undefined,
      maps:
        value.maps && typeof value.maps === 'object'
          ? (value.maps as Record<string, Record<string, LayerPlaceAIFlags>>)
          : {},
    }
  } catch {
    return { version: 1, maps: {} }
  }
}

function saveStore(store: StoreShape): void {
  try {
    store.revision = (store.revision ?? 0) + 1
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch (error) {
    console.warn('[tavern-map] place AI flags save failed', error)
  }
}

export function loadPlaceAIFlags(mapId: string): Record<string, LayerPlaceAIFlags> {
  if (!mapId) return {}
  const stored = loadStore().maps[mapId]
  if (!stored || typeof stored !== 'object') return {}
  const result: Record<string, LayerPlaceAIFlags> = {}
  for (const [markerId, raw] of Object.entries(stored)) {
    if (!markerId) continue
    const flags = sanitizeFlags(raw)
    if (flags) result[markerId] = flags
  }
  return result
}

export function savePlaceAIFlags(
  mapId: string,
  flags: Record<string, LayerPlaceAIFlags>,
): void {
  if (!mapId) return
  const store = loadStore()
  const cleaned: Record<string, LayerPlaceAIFlags> = {}
  for (const [markerId, raw] of Object.entries(flags)) {
    if (!markerId) continue
    const value = sanitizeFlags(raw)
    if (value) cleaned[markerId] = value
  }
  if (JSON.stringify(store.maps[mapId] ?? {}) === JSON.stringify(cleaned)) return
  if (Object.keys(cleaned).length > 0) store.maps[mapId] = cleaned
  else delete store.maps[mapId]
  saveStore(store)
}

export function removePlaceAIFlags(mapId: string): void {
  if (!mapId) return
  const store = loadStore()
  if (!store.maps[mapId]) return
  delete store.maps[mapId]
  saveStore(store)
}

/** A change to a global content switch replaces the matching item choices across all packages. */
export function resetLayerAIFlags(changes: Map<LayerAIKind, Set<LayerAIPart>>): void {
  if (changes.size === 0) return
  const store = loadStore()
  let changed = false
  for (const [mapId, entries] of Object.entries(store.maps)) {
    if (!entries || typeof entries !== 'object') continue
    for (const [key, entry] of Object.entries(entries)) {
      const kind = key.startsWith('road:') ? 'road' : key.startsWith('region:') ? 'region' : 'place'
      const parts = changes.get(kind)
      if (!parts || !entry || typeof entry !== 'object') continue
      for (const part of parts) {
        if (typeof entry[part] !== 'boolean') continue
        delete entry[part]
        changed = true
      }
      if (Object.keys(entry).length === 0) delete entries[key]
    }
    if (Object.keys(entries).length === 0) delete store.maps[mapId]
  }
  if (changed) saveStore(store)
}

export function layerAIFlagsRevision(): number {
  return loadStore().revision ?? 0
}
