export type LatLng = { lat: number; lng: number }

export type RouteProfile = 'foot' | 'driving' | 'transit'
export type LegMode = 'manual' | 'snap' | RouteProfile
export type RoutePoint = [number, number]
export type RealStop = { id?: string; name: string; lat: number; lng: number }
export type RealLeg = {
  mode: LegMode
  guide: RoutePoint[]
  line?: RoutePoint[]
  steps?: ItineraryStep[]
  distance?: number
  duration?: number
  fallback?: boolean
  departure?: number
  arrival?: number
  pois?: RoutePoi[]
  poisInRange?: RoutePoi[]
}
export type RealRouteDraft = { stops: RealStop[]; legs: RealLeg[]; departure?: number; pendingGuide?: RoutePoint[] }
export type RealPlacePart = 'source' | 'wiki' | 'note'

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

export type PlaceNote = {
  note: string
  name: string
  nameZh?: string
  lat: number
  lng: number
  updatedAt: number
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
  /** Timestamp of the last user-initiated marker move; map panning must not overwrite it. */
  centerUpdatedAt?: number
}

export type ItineraryStep = {
  instruction: string
  name?: string
  /** Exact OSM road/path name for this segment, when available. */
  road?: string
  distance: number
  duration: number
  /** POIs within the route corridor for this leg. */
  pois?: RoutePoi[]
}

export type RoutePoi = {
  id: string
  name: string
  nameZh?: string
  category?: string
  address?: string
  lat: number
  lng: number
  /** Distance from this route leg. */
  distanceM?: number
  /** Distance along this route leg from its start. */
  alongM?: number
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
  fallback?: boolean
  plan?: RealRouteDraft
  progress?: number
  showToAI: boolean
  updatedAt: number
}

export type MapState = {
  version: 1
  enabled: boolean
  center: LatLng
  zoom: number
  /** Timestamp of the last user-initiated marker move; map panning must not overwrite it. */
  centerUpdatedAt?: number
  /** Last map camera position, which can differ from the selected marker. */
  view?: MapView
  place?: Place
  nearby: Place[]
  wiki: WikiCandidate[]
  stars: StarredWiki[]
  savedPlaces: SavedPlace[]
  /** Notes for any place, independent of favorites. Keyed by placeKey. */
  placeNotes?: Record<string, PlaceNote>
  poiBriefs: PoiBrief[]
  poiAllToAI: boolean
  lastTab?: 'nearby' | 'wiki' | 'saved' | 'route'
  /** Last top-level map mode, preserved across closing/reopening the panel. */
  lastMapMode?: 'real' | 'layer'
  lastWiki?: WikiRef
  lastWikiMode?: 'intro' | 'full'
  wikiOpen?: boolean
  itinerary?: RouteItinerary
  routeDraft?: RealRouteDraft
  viewedPlace?: Place
  positionCleared?: boolean
  updatedAt: number
}

export type Settings = {
  enabled: boolean
  provider: 'osm'
  wikiLangs: string[]
  wikiDisplayLang?: string
  wikiDisplayMode: 'intro' | 'full'
  radiusM: number
  maxNearby: number
  depth: number
  showPois: boolean
  /** Show POIs attached to each route leg. */
  showRoutePois: boolean
  /** Corridor width for route POIs, in metres. */
  routePoiRadiusM: number
  realRouteMax: number
  realRouteCurrentOnly: boolean
  realRouteSource: boolean
  realRouteNote: boolean
  realSourceAI: boolean
  realWikiAI: boolean
  realNearbyCoords: boolean
  realNearbyNotes: boolean
  realNearbySource: boolean
  realNearbyWiki: boolean
  realFavoriteType: boolean
  realFavoriteCoords: boolean
  realFavoriteSource: boolean
  realFavoriteWiki: boolean
  /** Include the real-world OSM map scene block in AI context. */
  realMapContext: boolean
  /** Include the imported layer-map scene block in AI context. */
  layerMapContext: boolean
  /** Real-map AI content switches. */
  realNoteAI: boolean
  realNearbyAI: boolean
  realNearbyType: boolean
  realNearbyDistance: boolean
  realFavoritesAI: boolean
  realFavoriteNote: boolean
  /** Layer-map AI content switches. */
  layerAIRevision: number
  layerSourceAI: boolean
  layerWikiAI: boolean
  layerNoteAI: boolean
  layerRegionNoteAI: boolean
  layerRegionSourceAI: boolean
  layerNearbyAI: boolean
  layerNearbyName: boolean
  layerNearbyType: boolean
  layerNearbyDirection: boolean
  layerNearbyCoords: boolean
  layerNearbyNotes: boolean
  layerNearbySource: boolean
  layerNearbyWiki: boolean
  layerNearbyMax: number
  /** Corridor width for each itinerary leg, as a fraction of map width. */
  layerItineraryPoiRadius: number
  /** Maximum number of corridor places shown per itinerary leg. */
  layerItineraryPoiMax: number
  /** Show places, roads and areas along the itinerary. */
  layerItineraryPoisShow: boolean
  /** Only the leg I am on (or the first leg before setting off). */
  layerItineraryPoisCurrentOnly: boolean
  layerItineraryPoiSource: boolean
  layerItineraryPoiNotes: boolean
  /** Show notes for areas in the itinerary range. */
  layerItineraryRegionNotes: boolean
  /** Notes of roads near my position (on it or in the nearby radius). */
  layerRoadNoteNearby: boolean
  /** Notes of the roads of the itinerary leg I am on. */
  layerRoadNoteCurrentLeg: boolean
  /** Notes of the roads of every itinerary leg. */
  layerRoadNoteAllLegs: boolean
  /** Also send the road's source fields (for the roads chosen by the three switches above). */
  layerRoadSourceAI: boolean
  layerFavoritesAI: boolean
  layerFavoriteType: boolean
  layerFavoriteCoords: boolean
  layerFavoriteNote: boolean
  layerFavoriteSource: boolean
  layerFavoriteWiki: boolean
  layerAutoExpandWiki: boolean
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
  saveMetadata?: () => void | Promise<void>
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
