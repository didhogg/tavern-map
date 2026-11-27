import type {
  LayerCustomPin,
  LayerLink,
  LayerLinkKind,
  LayerMarker,
  LayerPinEdits,
  LayerPinHistory,
  LayerPinPoint,
} from './layer-types'

/**
 * Map-level pin edits.
 *
 * Imported package data is never rewritten. Moved positions and custom pins
 * are kept in this separate store so re-importing a map, switching chats, or
 * closing the layer panel cannot lose or duplicate user annotations.
 */
const STORAGE_KEY = 'tavern-map:layer-pins:v1'
export const MAX_PIN_HISTORY = 10

export const CUSTOM_PIN_CATEGORY_ID = 'tavern-map:custom-pin'
export const CUSTOM_PIN_GROUP_ID = 'tavern-map:custom-pin-group'
export const CUSTOM_PIN_COLOR = '#e9a15b'

type StoreShape = {
  version: 1
  maps: Record<string, unknown>
}

function point(value: unknown): LayerPinPoint | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as { x?: unknown; y?: unknown }
  if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) return undefined
  return {
    x: Math.min(1, Math.max(0, candidate.x as number)),
    y: Math.min(1, Math.max(0, candidate.y as number)),
  }
}

function pointList(value: unknown): LayerPinPoint[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => point(item))
    .filter((item): item is LayerPinPoint => Boolean(item))
    .slice(-MAX_PIN_HISTORY)
}

function link(value: unknown): LayerLink | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Partial<LayerLink>
  if (
    typeof item.id !== 'string' ||
    typeof item.title !== 'string' ||
    typeof item.url !== 'string'
  ) {
    return undefined
  }
  const kinds: LayerLinkKind[] = ['wikipedia', 'official', 'review', 'source', 'custom']
  return {
    id: item.id,
    kind: kinds.includes(item.kind as LayerLinkKind) ? (item.kind as LayerLinkKind) : 'custom',
    title: item.title,
    url: item.url,
    text: typeof item.text === 'string' ? item.text : undefined,
    fetchedAt: typeof item.fetchedAt === 'number' ? item.fetchedAt : undefined,
    status: typeof item.status === 'string' ? item.status : undefined,
  }
}

function customPin(value: unknown): LayerCustomPin | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Partial<LayerMarker> & {
    links?: unknown
    createdAt?: unknown
    updatedAt?: unknown
  }
  const coords = point(item)
  if (
    !coords ||
    typeof item.id !== 'string' ||
    !item.id ||
    typeof item.name !== 'string' ||
    !item.name.trim() ||
    typeof item.categoryId !== 'string' ||
    !item.categoryId
  ) {
    return undefined
  }
  return {
    id: item.id,
    name: item.name.trim(),
    categoryId: item.categoryId,
    x: coords.x,
    y: coords.y,
    custom: true,
    links: Array.isArray(item.links)
      ? item.links
          .map((entry) => link(entry))
          .filter((entry): entry is LayerLink => Boolean(entry))
      : [],
    description: typeof item.description === 'string' ? item.description : undefined,
    sourceId: typeof item.sourceId === 'string' ? item.sourceId : undefined,
    sourceUrl: typeof item.sourceUrl === 'string' ? item.sourceUrl : undefined,
    sourceTitle: typeof item.sourceTitle === 'string' ? item.sourceTitle : undefined,
    createdAt:
      typeof item.createdAt === 'number' && Number.isFinite(item.createdAt)
        ? item.createdAt
        : Date.now(),
    updatedAt:
      typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt)
        ? item.updatedAt
        : Date.now(),
  }
}

function history(value: unknown): LayerPinHistory | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as { past?: unknown; future?: unknown }
  return {
    past: pointList(item.past),
    future: pointList(item.future),
  }
}

function loadStore(): StoreShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { version: 1, maps: {} }
    const value = JSON.parse(raw) as Partial<StoreShape>
    return {
      version: 1,
      maps:
        value.maps && typeof value.maps === 'object'
          ? (value.maps as Record<string, unknown>)
          : {},
    }
  } catch {
    return { version: 1, maps: {} }
  }
}

function saveStore(store: StoreShape): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch (error) {
    console.warn('[tavern-map] pin edits save failed', error)
  }
}

function sanitize(value: unknown): LayerPinEdits {
  const empty = emptyPinEdits()
  if (!value || typeof value !== 'object') return empty
  const item = value as Partial<LayerPinEdits>
  const overrides: Record<string, LayerPinPoint> = {}
  if (item.overrides && typeof item.overrides === 'object') {
    for (const [id, raw] of Object.entries(item.overrides)) {
      const coords = point(raw)
      if (id && coords) overrides[id] = coords
    }
  }
  const customPins = Array.isArray(item.customPins)
    ? item.customPins
        .map((raw) => customPin(raw))
        .filter((pin): pin is LayerCustomPin => Boolean(pin))
    : []
  const histories: Record<string, LayerPinHistory> = {}
  if (item.history && typeof item.history === 'object') {
    for (const [id, raw] of Object.entries(item.history)) {
      const entry = history(raw)
      if (id && entry && (entry.past.length > 0 || entry.future.length > 0)) {
        histories[id] = entry
      }
    }
  }
  return {
    version: 1,
    overrides,
    customPins,
    history: histories,
    updatedAt:
      typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt)
        ? item.updatedAt
        : Date.now(),
  }
}

export function emptyPinEdits(): LayerPinEdits {
  return {
    version: 1,
    overrides: {},
    customPins: [],
    history: {},
    updatedAt: Date.now(),
  }
}

export function loadPinEdits(mapId: string): LayerPinEdits {
  if (!mapId) return emptyPinEdits()
  const store = loadStore()
  return sanitize(store.maps[mapId])
}

export function savePinEdits(mapId: string, edits: LayerPinEdits): void {
  if (!mapId) return
  const store = loadStore()
  edits.updatedAt = Date.now()
  store.maps[mapId] = sanitize(edits)
  saveStore(store)
}

export function removePinEdits(mapId: string): void {
  if (!mapId) return
  const store = loadStore()
  delete store.maps[mapId]
  saveStore(store)
}
