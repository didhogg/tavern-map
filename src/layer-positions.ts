import type { StContext } from './types'
import type { LayerUserPosition, LayerView } from './layer-types'

const STORAGE_KEY = 'tavern-map:layer-positions:v1'
const REAL_STORAGE_KEY = 'tavern-map:real-positions:v1'

type PositionStore = {
  positions: Record<string, Record<string, LayerUserPosition>>
  views?: Record<string, Record<string, LayerView>>
  lastPackage: Record<string, string>
}

function loadStore(): PositionStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { positions: {}, lastPackage: {} }
    const value = JSON.parse(raw) as Partial<PositionStore>
    return {
      positions:
        value.positions && typeof value.positions === 'object'
          ? (value.positions as Record<string, Record<string, LayerUserPosition>>)
          : {},
      views:
        value.views && typeof value.views === 'object'
          ? (value.views as Record<string, Record<string, LayerView>>)
          : {},
      lastPackage:
        value.lastPackage && typeof value.lastPackage === 'object'
          ? (value.lastPackage as Record<string, string>)
          : {},
    }
  } catch {
    return { positions: {}, lastPackage: {} }
  }
}

function saveStore(value: PositionStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // localStorage is a fallback only; chat metadata remains the primary copy.
  }
}

export function layerPositionChatKey(ctx: StContext): string {
  const withGetter = ctx as StContext & { getCurrentChatId?: () => unknown }
  try {
    const value = withGetter.getCurrentChatId?.()
    if (typeof value === 'string' && value.trim()) return value
  } catch {
    // Fall through to chatId / default.
  }
  if (typeof ctx.chatId === 'string' && ctx.chatId.trim()) return ctx.chatId
  return 'default'
}

export function storedLayerPosition(
  ctx: StContext,
  packageId: string,
): LayerUserPosition | undefined {
  const chatKey = layerPositionChatKey(ctx)
  const store = loadStore()
  const value =
    store.positions[chatKey]?.[packageId] ??
    (chatKey === 'default' ? store.positions['*']?.[packageId] : undefined)
  if (!value) return undefined
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return undefined
  return {
    x: Math.min(1, Math.max(0, value.x)),
    y: Math.min(1, Math.max(0, value.y)),
    atPlaceId: typeof value.atPlaceId === 'string' ? value.atPlaceId : undefined,
    nearbyRadius:
      typeof value.nearbyRadius === 'number' && Number.isFinite(value.nearbyRadius)
        ? Math.min(0.8, Math.max(0.001, value.nearbyRadius))
        : undefined,
  }
}

export function saveStoredLayerPosition(ctx: StContext, packageId: string, position?: LayerUserPosition): void {
  const store = loadStore()
  const chatKey = layerPositionChatKey(ctx)
  const positions = store.positions[chatKey] ?? (store.positions[chatKey] = {})
  if (position) {
    positions[packageId] = position
    const fallback = store.positions['*'] ?? (store.positions['*'] = {})
    fallback[packageId] = position
    store.lastPackage['*'] = packageId
  } else {
    delete positions[packageId]
    if (chatKey === 'default') delete store.positions['*']?.[packageId]
  }
  store.lastPackage[chatKey] = packageId
  saveStore(store)
}

export function storedLayerView(ctx: StContext, packageId: string): LayerView | undefined {
  const chatKey = layerPositionChatKey(ctx)
  const store = loadStore()
  const specific = store.views?.[chatKey]?.[packageId]
  const fallback = store.views?.['*']?.[packageId]
  const value = specific ?? fallback
  if (!value || !Number.isFinite(value.cx) || !Number.isFinite(value.cy) || !Number.isFinite(value.zoom)) {
    return undefined
  }
  return { cx: value.cx, cy: value.cy, zoom: value.zoom }
}

export function saveStoredLayerView(ctx: StContext, packageId: string, view: LayerView): void {
  const store = loadStore()
  const chatKey = layerPositionChatKey(ctx)
  const views = store.views ?? (store.views = {})
  views[chatKey] ??= {}
  views[chatKey][packageId] = { cx: view.cx, cy: view.cy, zoom: view.zoom }
  views['*'] ??= {}
  views['*'][packageId] = { cx: view.cx, cy: view.cy, zoom: view.zoom }
  saveStore(store)
}

export function removeStoredLayerPackage(_ctx: StContext, packageId: string): void {
  const store = loadStore()
  for (const positions of Object.values(store.positions)) delete positions[packageId]
  for (const views of Object.values(store.views ?? {})) delete views[packageId]
  for (const [chatKey, last] of Object.entries(store.lastPackage)) {
    if (last === packageId) delete store.lastPackage[chatKey]
  }
  saveStore(store)
}

export function storedLastLayerPackage(ctx: StContext): string | undefined {
  const chatKey = layerPositionChatKey(ctx)
  const store = loadStore()
  return store.lastPackage[chatKey] ?? (chatKey === 'default' ? store.lastPackage['*'] : undefined)
}

export type StoredRealPosition = {
  lat: number
  lng: number
  zoom?: number
  updatedAt?: number
}

type RealPositionStore = Record<string, StoredRealPosition>

function loadRealStore(): RealPositionStore {
  try {
    const raw = localStorage.getItem(REAL_STORAGE_KEY)
    if (!raw) return {}
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' ? (value as RealPositionStore) : {}
  } catch {
    return {}
  }
}

export function storedRealPosition(ctx: StContext): StoredRealPosition | undefined {
  const chatKey = layerPositionChatKey(ctx)
  const store = loadRealStore()
  const specific = store[chatKey]
  const fallback = store['*']
  const value =
    specific && fallback
      ? (fallback.updatedAt ?? 0) > (specific.updatedAt ?? 0)
        ? fallback
        : specific
      : specific ?? fallback
  if (
    !value ||
    !Number.isFinite(value.lat) ||
    !Number.isFinite(value.lng) ||
    Math.abs(value.lat) > 90 ||
    Math.abs(value.lng) > 180
  ) {
    return undefined
  }
  return {
    lat: value.lat,
    lng: value.lng,
    zoom: typeof value.zoom === 'number' && Number.isFinite(value.zoom) ? value.zoom : undefined,
    updatedAt:
      typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : undefined,
  }
}

export function saveStoredRealPosition(ctx: StContext, position: StoredRealPosition): void {
  if (
    !Number.isFinite(position.lat) ||
    !Number.isFinite(position.lng) ||
    Math.abs(position.lat) > 90 ||
    Math.abs(position.lng) > 180
  ) {
    return
  }
  const store = loadRealStore()
  const chatKey = layerPositionChatKey(ctx)
  const value = { ...position, updatedAt: position.updatedAt ?? Date.now() }
  store[chatKey] = value
  store['*'] = value
  try {
    localStorage.setItem(REAL_STORAGE_KEY, JSON.stringify(store))
  } catch {
    // Fallback only.
  }
}
