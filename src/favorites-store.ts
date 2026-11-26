/**
 * Global place favorites. Favorites are intentionally not chat-scoped:
 * the user can star a place once and keep managing it across chats.
 */
export type FavoritePlace = {
  key: string
  kind: 'layer' | 'real'
  mapId?: string
  mapName?: string
  markerId?: string
  name: string
  category?: string
  x?: number
  y?: number
  lat?: number
  lng?: number
  address?: string
  note?: string
  savedAt: number
}

const STORAGE_KEY = 'tavern-map:favorites:v1'

function load(): FavoritePlace[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return []
    return value.filter(
      (item): item is FavoritePlace =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as FavoritePlace).key === 'string' &&
        typeof (item as FavoritePlace).name === 'string',
    )
  } catch {
    return []
  }
}

function save(items: FavoritePlace[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
  } catch {
    // Favorites are non-critical; keep in-memory UI usable.
  }
}

export function listFavorites(): FavoritePlace[] {
  return load().sort((a, b) => b.savedAt - a.savedAt)
}

export function findFavorite(key: string): FavoritePlace | undefined {
  return load().find((item) => item.key === key)
}

export function isFavorite(key: string): boolean {
  return Boolean(findFavorite(key))
}

export function setFavorite(place: FavoritePlace): FavoritePlace[] {
  const items = load().filter((item) => item.key !== place.key)
  items.push({ ...place, savedAt: Date.now() })
  save(items)
  return items
}

export function removeFavorite(key: string): FavoritePlace[] {
  const items = load().filter((item) => item.key !== key)
  save(items)
  return items
}

export function toggleFavorite(place: FavoritePlace): boolean {
  if (isFavorite(place.key)) {
    removeFavorite(place.key)
    return false
  }
  setFavorite(place)
  return true
}

export function layerFavoriteKey(packageId: string, markerId: string): string {
  return `layer:${packageId}:${markerId}`
}

export function realFavoriteKey(placeKeyValue: string): string {
  return `real:${placeKeyValue}`
}
