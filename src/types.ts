export type LatLng = { lat: number; lng: number }

export type RouteProfile = 'foot' | 'driving' | 'transit'

export type Place = {
  id: string
  name: string
  /** Chinese name from OSM name:zh when available. */
  nameZh?: string
  category?: string
  address?: string
  lat: number
  lng: number
  distanceM?: number
  /** Full OSM tags when the place came from Overpass/OSM. */
  tags?: Record<string, string>
  openingHours?: string
  website?: string
  cuisine?: string
}

export type WikiCandidate = {
  pageId: number
  title: string
  dist: number
  lang: string
  lat?: number
  lng?: number
}

export type WikiPage = {
  pageId: number
  title: string
  extract: string
  url: string
  lang: string
  lat?: number
  lng?: number
  fetchedAt: number
  revId?: number
}

export type StarredWiki = WikiPage & {
  note: string
  savedAt: number
  /** Whether the prompt receives the intro or the full plaintext. */
  contextMode: 'intro' | 'full'
  fullText?: string
  /** Language chosen for the prompt when it differs from the starred page. */
  aiLang?: string
  aiTitle?: string
  aiExtract?: string
  aiFullText?: string
}

export type SavedPlace = Place & {
  note: string
  savedAt: number
}

export type WikiRef = {
  lang: string
  pageId: number
  title: string
  lat?: number
  lng?: number
}

export type MapView = {
  center: LatLng
  zoom: number
}

export type ItineraryStep = {
  instruction: string
  name?: string
  /** Exact OSM road/path name for this segment, when available. */
  road?: string
  distance: number
  duration: number
}

export type RoutePoi = {
  id: string
  name: string
  nameZh?: string
  category?: string
  address?: string
  lat: number
  lng: number
  distanceM?: number
  cuisine?: string
  openingHours?: string
}

export type PoiBrief = {
  id: string
  name: string
  nameZh?: string
  category?: string
  address?: string
  distanceM?: number
  cuisine?: string
  openingHours?: string
  addedAt: number
}

export type RouteItinerary = {
  from: { id?: string; name: string; lat: number; lng: number }
  to: { id?: string; name: string; lat: number; lng: number }
  distance: number
  duration: number
  profile: RouteProfile
  steps: ItineraryStep[]
  /** Named POIs found within the route corridor. */
  pois?: RoutePoi[]
  fallback?: boolean
  showToAI: boolean
  updatedAt: number
}

export type MapState = {
  version: 1
  enabled: boolean
  center: LatLng
  zoom: number
  /** Last map camera position, which can differ from the selected marker. */
  view?: MapView
  place?: Place
  nearby: Place[]
  wiki: WikiCandidate[]
  stars: StarredWiki[]
  savedPlaces: SavedPlace[]
  poiBriefs: PoiBrief[]
  poiAllToAI: boolean
  lastTab?: 'nearby' | 'wiki' | 'saved' | 'route'
  lastWiki?: WikiRef
  lastWikiMode?: 'intro' | 'full'
  wikiOpen?: boolean
  itinerary?: RouteItinerary
  updatedAt: number
}

export type Settings = {
  enabled: boolean
  provider: 'osm'
  wikiLangs: string[]
  radiusM: number
  maxNearby: number
  depth: number
  showPois: boolean
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
