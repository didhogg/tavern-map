export type LatLng = { lat: number; lng: number }

export type Place = {
  id: string
  name: string
  category?: string
  address?: string
  lat: number
  lng: number
  distanceM?: number
}

export type WikiCandidate = {
  pageId: number
  title: string
  dist: number
  lang: string
}

export type WikiPage = {
  pageId: number
  title: string
  extract: string
  url: string
  lang: string
  fetchedAt: number
  revId?: number
}

export type MapState = {
  version: 1
  enabled: boolean
  center: LatLng
  zoom: number
  place?: Place
  nearby: Place[]
  wiki: WikiCandidate[]
  stars: WikiPage[]
  updatedAt: number
}

export type Settings = {
  enabled: boolean
  provider: 'osm'
  wikiLangs: string[]
  radiusM: number
  maxNearby: number
  maxWikiChars: number
  tokenBudget: number
  depth: number
}

/** A minimal subset of the SillyTavern context used by this extension. */
export type StContext = {
  eventSource: {
    on(name: string, handler: (...args: unknown[]) => void): void
    removeListener?(name: string, handler: (...args: unknown[]) => void): void
    off?(name: string, handler: (...args: unknown[]) => void): void
  }
  /** @deprecated snake_case alias kept for older SillyTavern builds. */
  event_types?: Record<string, string>
  eventTypes?: Record<string, string>
  extensionSettings: Record<string, unknown>
  saveSettingsDebounced?: () => void
  chatMetadata?: Record<string, unknown>
  saveMetadataDebounced?: () => void
  setExtensionPrompt?: (
    key: string,
    value: string,
    position: number,
    depth: number,
    scan: boolean,
    role: number,
    filter?: (() => boolean) | null,
  ) => void
  extension_prompt_types?: Record<string, number>
  extension_prompt_roles?: Record<string, number>
  chat?: unknown[]
  [key: string]: unknown
}
