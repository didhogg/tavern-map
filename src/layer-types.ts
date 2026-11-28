import { flushGlobalNotes, globalNotesSnapshot } from './notes-store'
import type { StContext } from './types'

export type LayerMapKind = 'image' | 'tiles'
export type LayerMapSource = 'fandom' | 'mapgenie' | 'manual'
export type LayerImageSource = 'package' | 'fandom-url' | 'local' | 'none'
export type LayerImageFit = 'stretch' | 'contain' | 'custom'
export type LayerTileOrder = 'zyx' | 'zxy' | 'unknown'

/** Normalized rectangle inside the logical map canvas (0..1). */
export type LayerImageRect = {
  x: number
  y: number
  w: number
  h: number
}

export type LayerGridConfig = {
  /** Grid origin in normalized map coordinates. */
  originX: number
  originY: number
  /** Cell size in normalized map coordinates. */
  cellW: number
  cellH: number
  /** User-facing scale: one cell equals this many units. */
  unitValue: number
  unitLabel: string
  /** Show grid lines when the calibration panel is closed. */
  visible?: boolean
}

export type LayerCategory = {
  id: string
  name: string
  groupId?: string
  color: string
  /** Original Map Genie icon slug, e.g. `atms` or `weapon_shop`. */
  icon?: string
  order?: number
}

export type LayerIconFrame = {
  x: number
  y: number
  width: number
  height: number
  pixelRatio?: number
}

export type LayerIconAtlas = {
  /** Original Map Genie icon-set atlas image, stored locally. */
  image: Blob
  /** Atlas frame keys such as `g.atms.a`. */
  frames: Record<string, LayerIconFrame>
  source?: string
}

export type LayerIconFont = {
  family: string
  /** Original Map Genie icon font, stored locally after import. */
  data: Blob
  /** CSS icon slug -> private-use glyph character. */
  glyphs: Record<string, string>
  source?: string
}

export type LayerCategoryGroup = {
  id: string
  name: string
  order?: number
}

export type LayerMarker = {
  id: string
  sourceId?: string
  name: string
  categoryId: string
  /** Normalized map coordinate, 0..1. Origin is always top-left after import. */
  x: number
  y: number
  description?: string
  regionId?: string
  sourceUrl?: string
  sourceTitle?: string
  /** Links imported with the source marker (always shown in place details). */
  sourceLinks?: LayerLink[]
  /** True for a user-created pin that is not part of the imported package. */
  custom?: boolean
  /** Links added to a user-created pin, stored with the map-level pin edits. */
  links?: LayerLink[]
  createdAt?: number
}

export type LayerRegion = {
  id: string
  name: string
  parentId?: string
  description?: string
  sourceLinks?: LayerLink[]
  properties?: Array<[string, string]>
  /** Optional label anchor; otherwise the polygon centroid is used. */
  labelX?: number
  labelY?: number
  /** Normalized polygons; each ring is a list of [x, y] points. */
  polygons: Array<Array<[number, number]>>
}

/** A road/street line from the map data: road layer, labels and "on road" context. */
export type LayerStreet = {
  id: string
  /** Empty when the source line has no name. */
  name: string
  type?: string
  /** Normalized polyline coordinates, [x, y] in 0..1. */
  points: Array<[number, number]>
  /** Original properties of the road feature, in source order (absent in packages imported before 0.9.0). */
  properties?: Array<[string, string]>
}

export type LayerLinkKind = 'wikipedia' | 'official' | 'review' | 'source' | 'custom'

export type LayerLink = {
  id: string
  kind: LayerLinkKind
  title: string
  url: string
  /** Optional text captured by the user or by a CORS-enabled fetch. */
  text?: string
  fetchedAt?: number
  status?: string
}

export type LayerPinPoint = {
  x: number
  y: number
}

export type LayerPinHistory = {
  /** Positions before the current one, oldest first. Maximum 10. */
  past: LayerPinPoint[]
  /** Positions undone and available for redo, oldest first. Maximum 10. */
  future: LayerPinPoint[]
}

export type LayerCustomPin = LayerMarker & {
  custom: true
  links: LayerLink[]
  createdAt: number
  updatedAt: number
}

export type LayerPinEdits = {
  version: 1
  /** Map marker id -> user-moved normalized coordinate. */
  overrides: Record<string, LayerPinPoint>
  customPins: LayerCustomPin[]
  /** Per-pin move history, including custom pins. */
  history: Record<string, LayerPinHistory>
  updatedAt: number
}

export type LayerAIPart = 'source' | 'wiki' | 'note'

/** Explicit per-item AI choices. A missing part follows its automatic scope. */
export type LayerPlaceAIFlags = Partial<Record<LayerAIPart, boolean>>

export type LayerTileConfig = {
  template: string
  /** Optional remote tile URL template for Map Genie high-resolution fallback. */
  remoteTemplate?: string
  minZoom: number
  maxZoom: number
  /** Tile index at minZoom for the top-left corner of the map. */
  xMin: number
  yMin: number
  /** Number of tiles across at minZoom (normally 1). */
  count: number
  backgroundColor?: string
  /**
   * `grid` maps normalized 0..1 to the imported tile bounds.
   * `webmercator` uses standard Web Mercator world coordinates (Map Genie).
   */
  projection?: 'grid' | 'webmercator'
  /** World-coordinate bounds used for the initial fit. */
  worldBounds?: {
    minX: number
    maxX: number
    minY: number
    maxY: number
  }
  /** How the local tile files name their axes (internal storage is always z/y/x). */
  order?: LayerTileOrder
  /** Zoom range actually present in the imported local tiles. */
  coverageMinZoom?: number
  coverageMaxZoom?: number
  /** Expected / missing tile counts for the covered zoom levels. */
  expectedCount?: number
  missingCount?: number
  setName?: string
  setIndex?: number
  setCount?: number
  /** Per-zoom tile bounds from mapData, used when rescanning a new tile folder. */
  boundsByZoom?: Record<
    string,
    { xMin: number; xMax: number; yMin: number; yMax: number }
  >
}

export type LayerMapPackage = {
  id: string
  name: string
  kind: LayerMapKind
  source: LayerMapSource
  /** Human-readable source label for imported third-party maps. */
  sourceLabel?: string
  /** Stable identity used to update the same map package on re-import. */
  sourceKey?: string
  sourceUrl?: string
  wikiBase?: string
  /** True after the user renamed the package; re-import must keep the name. */
  nameLocked?: boolean
  /** Image maps use the original pixel dimensions for aspect ratio. */
  width: number
  height: number
  /** Image maps only. Stored as a Blob so local images survive reloads. */
  image?: Blob
  imageType?: string
  imageName?: string
  imagePageUrl?: string
  imageWidth?: number
  imageHeight?: number
  imageBytes?: number
  imageSource?: LayerImageSource
  imageFit?: LayerImageFit
  imageRect?: LayerImageRect
  /** True after the user manually replaced or removed the image. */
  imageLocked?: boolean
  /** Small preview used by package management; never the only copy of the image. */
  thumbnail?: Blob
  dataBytes?: number
  tile?: LayerTileConfig
  /** Optional local tile blobs keyed as `z/y/x` (without extension). */
  tileFiles?: Record<string, Blob>
  /** Optional starting camera for a newly imported package. */
  defaultView?: LayerView
  /** Optional user calibration shared by all chats using this map package. */
  grid?: LayerGridConfig
  categories: LayerCategory[]
  groups: LayerCategoryGroup[]
  markers: LayerMarker[]
  regions: LayerRegion[]
  /** Optional named street lines, used to draw road labels. */
  streets?: LayerStreet[]
  /** Optional original Map Genie icon font for marker symbols. */
  iconFont?: LayerIconFont
  /** Original Map Genie icon-set atlas; takes priority over the font. */
  iconAtlas?: LayerIconAtlas
  attribution?: string
  createdAt: number
  updatedAt: number
}

export type LayerPackageMeta = {
  id: string
  name: string
  kind: LayerMapKind
  source: LayerMapSource
  sourceKey?: string
  markerCount: number
  regionCount: number
  streetCount?: number
  sourceLabel?: string
  remoteTiles?: boolean
  categoryCount: number
  descriptionCount?: number
  linkCount?: number
  hasImage?: boolean
  imageName?: string
  imagePageUrl?: string
  imageWidth?: number
  imageHeight?: number
  imageBytes?: number
  imageSource?: LayerImageSource
  tileCount?: number
  tileZoomMin?: number
  tileZoomMax?: number
  missingTiles?: number
  sizeBytes?: number
  fileCount?: number
  missingAsset?: 'image' | 'tiles' | null
  thumbnail?: Blob
  updatedAt: number
}

export type LayerView = {
  /** Normalized center x/y in 0..1. */
  cx: number
  cy: number
  /** Image: fit multiplier. Tiles: tile zoom. */
  zoom: number
}

export type LayerFavoritePlace = {
  key: string
  name: string
  category?: string
  region?: string
  x?: number
  y?: number
  note?: string
  sourceMaterial?: string
  wikiTexts?: Array<{ title: string; text: string }>
}

export type LayerNearbyPlace = {
  id: string
  name: string
  category?: string
  x: number
  y: number
  direction: string
  distancePercent: number
  /** Distance from the anchor in grid cells, when the map has a grid. */
  distanceCells?: number
  note?: string
  sourceMaterial?: string
  wikiTexts?: Array<{ title: string; text: string }>
}

export type LayerItineraryContextPoi = {
  id?: string
  name: string
  category?: string
  sourceMaterial?: string
  note?: string
  /** Distance along this leg from its start. */
  along?: string
  /** Perpendicular distance from the route centre line. */
  offset?: string
}

/** One stretch of a leg: along a named road, or straight where no road is followed. */
export type LayerItineraryContextPiece = {
  kind: 'road' | 'straight'
  name?: string
  type?: string
  distance: string
}

/** A road inside the leg's range that the leg does not travel on. */
export type LayerItineraryContextRoad = {
  name: string
  type?: string
  distance: string
}

export type LayerItineraryContextArea = {
  name: string
  note?: string
}

export type LayerItineraryContextLeg = {
  from: string
  to: string
  distance: string
  current?: boolean
  /** 'road' when the leg was planned to follow roads. */
  mode?: 'road' | 'straight'
  /** Stretches of a road-following leg in travel order. */
  route?: LayerItineraryContextPiece[]
  /** Roads in range of this leg; omitted when the leg's extras are hidden. */
  roads?: LayerItineraryContextRoad[]
  /** Areas in range of this leg; omitted when the leg's extras are hidden. */
  areas?: LayerItineraryContextArea[]
  pois: LayerItineraryContextPoi[]
}

export type LayerItineraryContext = {
  start: string
  destination: string
  total: string
  stops: string[]
  /** Present only when the user's position is on the route. */
  current?: {
    legIndex: number
    progress: number
    from: string
    to: string
    remaining: string
    /** Road the current position travels on, for a road-following leg. */
    road?: string
  }
  nextStop?: string
  /** Explicit arrival; older snapshots may have no progress information. */
  atDestination?: true
  legs: LayerItineraryContextLeg[]
}

export type LayerContextRoadNote = {
  name: string
  type?: string
  /** Why the road is included: 'near me', 'current leg', 'leg 2' … */
  tags: string[]
  /** The road note; empty when only the source is sent. */
  text: string
  /** The road's source fields from the map data, when allowed. */
  source?: string
}

export type LayerContextRoad = {
  /** Road identity (same name and type, or one unnamed line), for selecting it from lists. */
  key?: string
  /** Empty when the road line has no name. */
  name: string
  type?: string
  /** True when my position is on the road line, not just near it. */
  on: boolean
  distancePercent: number
  distanceCells?: number
  direction?: string
}

export type LayerContextSnapshot = {
  aiRevision?: string
  mapName: string
  /** Explicit "my position", only when the user placed it. */
  position?: {
    x: number
    y: number
    region?: string
    /** Enclosing areas of `region`, nearest first (declared parents, else containing polygons). */
    regionParents?: string[]
    /** Road nearest to my position (within the nearby radius), from the map's road lines. */
    road?: LayerContextRoad
  }
  currentPlace?: string
  currentX?: number
  currentY?: number
  category?: string
  region?: string
  /** Enclosing areas of the current place's `region`, nearest first. */
  regionParents?: string[]
  /** Area notes allowed into AI: my area and the areas around it; `other` = ticked area elsewhere. */
  areaNotes?: Array<{ name: string; text: string; other?: boolean }>
  areaSources?: Array<{ name: string; text: string; other?: boolean }>
  pinnedPlaces?: LayerFavoritePlace[]
  /** Road notes allowed into AI, each road once, with why it is included. */
  roadNotes?: LayerContextRoadNote[]
  note?: string
  /** User-edited source material, only when explicitly included. */
  sourceMaterial?: string
  /** Fetched wiki/source text explicitly checked for AI context. */
  wikiTexts?: Array<{ title: string; text: string }>
  nearby?: LayerNearbyPlace[]
  /** Roads inside the nearby radius, nearest first. */
  nearbyRoads?: LayerContextRoad[]
  nearbyAnchor?: 'my position' | 'at place' | 'view center'
  /** Completed itinerary and its current segment. Never a draft. */
  itinerary?: LayerItineraryContext
  nearbyScope?: 'view' | 'map' | 'radius'
  nearbyCoords?: boolean
  favorites?: LayerFavoritePlace[]
  /** Present only after the user calibrated a grid on this map package. */
  grid?: LayerGridConfig
  updatedAt: number
}

export type LayerItineraryStop = {
  id: string
  /** Present when the stop points at an existing place marker. */
  markerId?: string
  /** Snapshot name; live marker names take priority when the marker exists. */
  name: string
  x: number
  y: number
  /** The leg arriving at this stop follows the map's roads (chosen while planning). */
  snapRoad?: boolean
}

export type LayerItinerary = {
  version: 1
  packageId: string
  stops: LayerItineraryStop[]
  /** Whether this completed route is allowed into the AI scene block. */
  showToAI: boolean
  createdAt: number
  updatedAt: number
}

export type LayerUserPosition = {
  x: number
  y: number
  atPlaceId?: string
  nearbyRadius?: number
}

export type LayerChatState = {
  version: 1
  packageId?: string
  /** Per-map-package scene positions; switching packages must not erase them. */
  positionsByPackage?: Record<string, LayerUserPosition>
  /** Per-map-package camera view; switching packages must not erase it. */
  viewsByPackage?: Record<string, LayerView>
  /** Completed routes, one per map package, scoped to this chat. */
  itinerariesByPackage?: Record<string, LayerItinerary>
  view?: LayerView
  selectedMarkerId?: string
  currentMarkerId?: string
  /** The user's own scene position in normalized map coordinates. */
  userPosition?: { x: number; y: number }
  /** Marker the user has actually moved onto; only this place is "at place". */
  atPlaceId?: string
  /** Nearby radius as a fraction of the map span width. */
  nearbyRadius?: number
  selectedRegionId?: string
  /** Selected road: all lines with the same name and type, or one unnamed line. */
  selectedRoadKey?: string
  currentRegionId?: string
  hiddenCategories?: string[]
  showLabels?: boolean
  showRegions?: boolean
  /** Road line layer; off unless turned on. */
  showRoads?: boolean
  notes?: Record<string, string>
  links?: Record<string, LayerLink[]>
  /** Fetched/pasted text for imported source links, keyed `markerId:linkId`. */
  sourceLinkText?: Record<string, { text?: string; status?: string; fetchedAt?: number }>
  context?: LayerContextSnapshot
  updatedAt: number
}

export const LAYER_STATE_KEY = 'tavern-map-layer'

export const DEFAULT_LAYER_STATE: LayerChatState = {
  version: 1,
  showLabels: true,
  showRegions: true,
  notes: {},
  links: {},
  sourceLinkText: {},
  updatedAt: Date.now(),
}

export function loadLayerState(ctx: StContext): LayerChatState {
  const raw = ctx.chatMetadata?.[LAYER_STATE_KEY]
  if (!raw || typeof raw !== 'object' || (raw as LayerChatState).version !== 1) {
    return structuredClone(DEFAULT_LAYER_STATE)
  }
  const value = raw as Partial<LayerChatState>
  const view = value.view
  const validView =
    view &&
    Number.isFinite(view.cx) &&
    Number.isFinite(view.cy) &&
    Number.isFinite(view.zoom)
      ? { cx: view.cx, cy: view.cy, zoom: view.zoom }
      : undefined
  const notes =
    value.notes && typeof value.notes === 'object'
      ? Object.fromEntries(
          Object.entries(value.notes).filter(
            ([key, note]) => typeof key === 'string' && typeof note === 'string',
          ),
        )
      : {}
  const sourceLinkText: Record<string, { text?: string; status?: string; fetchedAt?: number }> =
    value.sourceLinkText && typeof value.sourceLinkText === 'object'
      ? Object.fromEntries(
          Object.entries(value.sourceLinkText)
            .filter(([key, entry]) => typeof key === 'string' && entry && typeof entry === 'object')
            .map(([key, entry]) => {
              const item = entry as { text?: unknown; status?: unknown; fetchedAt?: unknown }
              return [
                key,
                {
                  text: typeof item.text === 'string' ? item.text : undefined,
                  status: typeof item.status === 'string' ? item.status : undefined,
                  fetchedAt: typeof item.fetchedAt === 'number' ? item.fetchedAt : undefined,
                },
              ]
            }),
        )
      : {}
  const links: Record<string, LayerLink[]> =
    value.links && typeof value.links === 'object'
      ? Object.fromEntries(
          Object.entries(value.links)
            .filter(([key, list]) => typeof key === 'string' && Array.isArray(list))
            .map(([key, list]) => [
              key,
              (list as LayerLink[])
                .filter(
                  (link) =>
                    link &&
                    typeof link.id === 'string' &&
                    typeof link.title === 'string' &&
                    typeof link.url === 'string',
                )
                .map((link): LayerLink => ({
                  ...link,
                  kind:
                    link.kind === 'wikipedia' ||
                    link.kind === 'official' ||
                    link.kind === 'review' ||
                    link.kind === 'source'
                      ? link.kind
                      : 'custom',
                })),
            ]),
        )
      : {}
  return {
    ...structuredClone(DEFAULT_LAYER_STATE),
    ...value,
    version: 1,
    packageId: typeof value.packageId === 'string' ? value.packageId : undefined,
    positionsByPackage:
      value.positionsByPackage && typeof value.positionsByPackage === 'object'
        ? Object.fromEntries(
            Object.entries(value.positionsByPackage)
              .filter(
                ([key, entry]) =>
                  typeof key === 'string' &&
                  Boolean(entry) &&
                  typeof entry === 'object' &&
                  Number.isFinite((entry as LayerUserPosition).x) &&
                  Number.isFinite((entry as LayerUserPosition).y),
              )
              .map(([key, entry]) => {
                const position = entry as LayerUserPosition
                return [
                  key,
                  {
                    x: Math.min(1, Math.max(0, position.x)),
                    y: Math.min(1, Math.max(0, position.y)),
                    atPlaceId:
                      typeof position.atPlaceId === 'string' ? position.atPlaceId : undefined,
                    nearbyRadius:
                      typeof position.nearbyRadius === 'number' &&
                      Number.isFinite(position.nearbyRadius)
                        ? Math.min(0.8, Math.max(0.001, position.nearbyRadius))
                        : undefined,
                  },
                ]
              }),
          )
        : undefined,
    viewsByPackage:
      value.viewsByPackage && typeof value.viewsByPackage === 'object'
        ? Object.fromEntries(
            Object.entries(value.viewsByPackage)
              .filter(
                ([key, entry]) =>
                  typeof key === 'string' &&
                  Boolean(entry) &&
                  typeof entry === 'object' &&
                  Number.isFinite((entry as LayerView).cx) &&
                  Number.isFinite((entry as LayerView).cy) &&
                  Number.isFinite((entry as LayerView).zoom),
              )
              .map(([key, entry]) => {
                const view = entry as LayerView
                return [key, { cx: view.cx, cy: view.cy, zoom: view.zoom }]
              }),
          )
        : undefined,
    view: validView,
    selectedMarkerId:
      typeof value.selectedMarkerId === 'string' ? value.selectedMarkerId : undefined,
    currentMarkerId:
      typeof value.currentMarkerId === 'string' ? value.currentMarkerId : undefined,
    userPosition:
      value.userPosition &&
      Number.isFinite(value.userPosition.x) &&
      Number.isFinite(value.userPosition.y)
        ? { x: value.userPosition.x, y: value.userPosition.y }
        : undefined,
    atPlaceId: typeof value.atPlaceId === 'string' ? value.atPlaceId : undefined,
    itinerariesByPackage: validItineraries(value.itinerariesByPackage),
    nearbyRadius:
      typeof value.nearbyRadius === 'number' && Number.isFinite(value.nearbyRadius)
        ? Math.min(0.8, Math.max(0.001, value.nearbyRadius))
        : undefined,
    selectedRegionId:
      typeof value.selectedRegionId === 'string' ? value.selectedRegionId : undefined,
    selectedRoadKey:
      typeof value.selectedRoadKey === 'string' ? value.selectedRoadKey : undefined,
    currentRegionId:
      typeof value.currentRegionId === 'string' ? value.currentRegionId : undefined,
    hiddenCategories: Array.isArray(value.hiddenCategories)
      ? value.hiddenCategories.filter((id): id is string => typeof id === 'string')
      : [],
    showLabels: typeof value.showLabels === 'boolean' ? value.showLabels : true,
    showRegions: typeof value.showRegions === 'boolean' ? value.showRegions : true,
    showRoads: value.showRoads === true,
    notes: {
      ...Object.fromEntries(
        Object.entries(globalNotesSnapshot()).filter(([key]) => key.startsWith('layer:')),
      ),
      ...notes,
    },
    links,
    sourceLinkText,
    context: validContext(value.context),
    updatedAt:
      typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : Date.now(),
  }
}

function validItinerary(raw: unknown): LayerItinerary | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Partial<LayerItinerary>
  if (
    value.version !== 1 ||
    typeof value.packageId !== 'string' ||
    !value.packageId ||
    !Array.isArray(value.stops) ||
    value.stops.length < 2
  ) {
    return undefined
  }
  const stops: LayerItineraryStop[] = value.stops
    .filter((item): item is LayerItineraryStop => {
      if (!item || typeof item !== 'object') return false
      const stop = item as Partial<LayerItineraryStop>
      return (
        typeof stop.id === 'string' &&
        Boolean(stop.id) &&
        typeof stop.name === 'string' &&
        Boolean(stop.name.trim()) &&
        Number.isFinite(stop.x) &&
        Number.isFinite(stop.y)
      )
    })
    .map((stop) => ({
      id: stop.id,
      markerId: typeof stop.markerId === 'string' ? stop.markerId : undefined,
      name: stop.name.trim(),
      x: Math.min(1, Math.max(0, stop.x)),
      y: Math.min(1, Math.max(0, stop.y)),
      snapRoad: stop.snapRoad === true ? true : undefined,
    }))
  if (stops.length < 2) return undefined
  return {
    version: 1,
    packageId: value.packageId,
    stops,
    showToAI: value.showToAI !== false,
    createdAt:
      typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
        ? value.createdAt
        : Date.now(),
    updatedAt:
      typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : Date.now(),
  }
}

function validItineraries(value: unknown): Record<string, LayerItinerary> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const result: Record<string, LayerItinerary> = {}
  for (const [packageId, raw] of Object.entries(value)) {
    const itinerary = validItinerary(raw)
    if (packageId && itinerary) {
      result[packageId] = { ...itinerary, packageId }
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function validItineraryContext(raw: unknown): LayerItineraryContext | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Partial<LayerItineraryContext>
  if (
    typeof value.start !== 'string' ||
    typeof value.destination !== 'string' ||
    typeof value.total !== 'string' ||
    !Array.isArray(value.stops) ||
    !Array.isArray(value.legs)
  ) {
    return undefined
  }
  const stops = value.stops.filter((item): item is string => typeof item === 'string')
  const legs: LayerItineraryContextLeg[] = value.legs
    .filter((item): item is LayerItineraryContextLeg => {
      if (!item || typeof item !== 'object') return false
      return (
        typeof item.from === 'string' &&
        typeof item.to === 'string' &&
        typeof item.distance === 'string'
      )
    })
    .map((leg) => ({
      from: leg.from,
      to: leg.to,
      distance: leg.distance,
      current: leg.current === true ? true : undefined,
      mode: leg.mode === 'road' || leg.mode === 'straight' ? leg.mode : undefined,
      route: Array.isArray(leg.route)
        ? leg.route
            .filter(
              (piece): piece is LayerItineraryContextPiece =>
                Boolean(piece) &&
                (piece.kind === 'road' || piece.kind === 'straight') &&
                typeof piece.distance === 'string',
            )
            .map((piece) => ({
              kind: piece.kind,
              name: typeof piece.name === 'string' ? piece.name : undefined,
              type: typeof piece.type === 'string' && piece.type ? piece.type : undefined,
              distance: piece.distance,
            }))
        : undefined,
      roads: Array.isArray(leg.roads)
        ? leg.roads
            .filter(
              (road): road is LayerItineraryContextRoad =>
                Boolean(road) && typeof road.name === 'string' && typeof road.distance === 'string',
            )
            .map((road) => ({
              name: road.name,
              type: typeof road.type === 'string' && road.type ? road.type : undefined,
              distance: road.distance,
            }))
        : undefined,
      areas: Array.isArray(leg.areas)
        ? leg.areas
            .filter((area): area is LayerItineraryContextArea => Boolean(area) && typeof area.name === 'string')
            .map((area) => ({
              name: area.name,
              note: typeof area.note === 'string' ? area.note : undefined,
            }))
        : undefined,
      pois: Array.isArray(leg.pois)
        ? leg.pois
            .filter((poi): poi is LayerItineraryContextPoi => {
              if (!poi || typeof poi !== 'object') return false
              return typeof poi.name === 'string'
            })
            .map((poi) => ({
              id: typeof poi.id === 'string' ? poi.id : undefined,
              name: poi.name,
              category: typeof poi.category === 'string' ? poi.category : undefined,
              sourceMaterial: typeof poi.sourceMaterial === 'string' ? poi.sourceMaterial : undefined,
              note: typeof poi.note === 'string' ? poi.note : undefined,
              along: typeof poi.along === 'string' ? poi.along : undefined,
              offset: typeof poi.offset === 'string' ? poi.offset : undefined,
            }))
        : [],
    }))
  if (legs.length === 0) return undefined
  const current =
    value.current &&
    Number.isFinite(value.current.legIndex) &&
    Number.isFinite(value.current.progress) &&
    typeof value.current.from === 'string' &&
    typeof value.current.to === 'string' &&
    typeof value.current.remaining === 'string'
      ? {
          legIndex: value.current.legIndex,
          progress: value.current.progress,
          from: value.current.from,
          to: value.current.to,
          remaining: value.current.remaining,
          road: typeof value.current.road === 'string' ? value.current.road : undefined,
        }
      : undefined
  return {
    start: value.start,
    destination: value.destination,
    total: value.total,
    stops,
    current,
    nextStop: typeof value.nextStop === 'string' ? value.nextStop : undefined,
    atDestination: value.atDestination === true ? true : undefined,
    legs,
  }
}

function validContextRoad(raw: unknown): LayerContextRoad | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const road = raw as Partial<LayerContextRoad>
  if (typeof road.name !== 'string' || !Number.isFinite(road.distancePercent)) return undefined
  return {
    key: typeof road.key === 'string' && road.key ? road.key : undefined,
    name: road.name,
    type: typeof road.type === 'string' && road.type ? road.type : undefined,
    on: road.on === true,
    distancePercent: road.distancePercent as number,
    distanceCells: Number.isFinite(road.distanceCells) ? road.distanceCells : undefined,
    direction: typeof road.direction === 'string' && road.direction ? road.direction : undefined,
  }
}

function stringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const list = raw.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return list.length > 0 ? list : undefined
}

function validAreaContent(value: LayerContextSnapshot['areaNotes']): LayerContextSnapshot['areaNotes'] {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item.name === 'string' && typeof item.text === 'string')
      .map((item) => ({ name: item.name, text: item.text, other: item.other === true || undefined }))
    : undefined
}

function validPlaceDetails(value: LayerFavoritePlace[] | undefined): LayerFavoritePlace[] | undefined {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item.key === 'string' && typeof item.name === 'string')
    : undefined
}

function validContext(raw: unknown): LayerContextSnapshot | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Partial<LayerContextSnapshot>
  if (typeof value.mapName !== 'string' || !value.mapName) return undefined
  const position =
    value.position &&
    Number.isFinite(value.position.x) &&
    Number.isFinite(value.position.y)
      ? {
          x: value.position.x,
          y: value.position.y,
          region:
            typeof value.position.region === 'string' ? value.position.region : undefined,
          regionParents: stringList(value.position.regionParents),
          road: validContextRoad(value.position.road),
        }
      : undefined
  const nearby = Array.isArray(value.nearby)
    ? value.nearby
        .filter(
          (item): item is LayerNearbyPlace =>
            Boolean(item) &&
            typeof item.id === 'string' &&
            typeof item.name === 'string' &&
            Number.isFinite(item.x) &&
            Number.isFinite(item.y) &&
            typeof item.direction === 'string' &&
            Number.isFinite(item.distancePercent),
        )
        .map((item) => ({
          id: item.id,
          name: item.name,
          category: typeof item.category === 'string' ? item.category : undefined,
          x: item.x,
          y: item.y,
          direction: item.direction,
          distancePercent: item.distancePercent,
          distanceCells: Number.isFinite(item.distanceCells) ? item.distanceCells : undefined,
          note: typeof item.note === 'string' ? item.note : undefined,
          sourceMaterial:
            typeof item.sourceMaterial === 'string' && item.sourceMaterial.trim()
              ? item.sourceMaterial
              : undefined,
          wikiTexts: Array.isArray(item.wikiTexts)
            ? item.wikiTexts.filter(
                (wiki): wiki is { title: string; text: string } =>
                  Boolean(wiki) &&
                  typeof wiki.title === 'string' &&
                  typeof wiki.text === 'string',
              )
            : undefined,
        }))
    : undefined
  const grid = value.grid
    ? {
        originX: Number.isFinite(value.grid.originX) ? value.grid.originX : 0,
        originY: Number.isFinite(value.grid.originY) ? value.grid.originY : 0,
        cellW: Number.isFinite(value.grid.cellW) && value.grid.cellW > 0 ? value.grid.cellW : 0.05,
        cellH: Number.isFinite(value.grid.cellH) && value.grid.cellH > 0 ? value.grid.cellH : 0.05,
        unitValue:
          Number.isFinite(value.grid.unitValue) && value.grid.unitValue > 0
            ? value.grid.unitValue
            : 1,
        unitLabel:
          typeof value.grid.unitLabel === 'string' && value.grid.unitLabel.trim()
            ? value.grid.unitLabel.trim()
            : '格',
      }
    : undefined
  return {
    mapName: value.mapName,
    position,
    currentPlace: typeof value.currentPlace === 'string' ? value.currentPlace : undefined,
    currentX: Number.isFinite(value.currentX) ? value.currentX : undefined,
    currentY: Number.isFinite(value.currentY) ? value.currentY : undefined,
    category: typeof value.category === 'string' ? value.category : undefined,
    region: typeof value.region === 'string' ? value.region : undefined,
    regionParents: stringList(value.regionParents),
    roadNotes: Array.isArray(value.roadNotes)
      ? value.roadNotes
          .filter(
            (item): item is LayerContextRoadNote =>
              Boolean(item) &&
              typeof item.name === 'string' &&
              typeof item.text === 'string' &&
              Array.isArray(item.tags),
          )
          .map((item) => ({
            name: item.name,
            type: typeof item.type === 'string' && item.type ? item.type : undefined,
            tags: item.tags.filter((tag): tag is string => typeof tag === 'string'),
            text: item.text,
            source: typeof item.source === 'string' && item.source ? item.source : undefined,
          }))
      : undefined,
    areaNotes: validAreaContent(value.areaNotes),
    areaSources: validAreaContent(value.areaSources),
    pinnedPlaces: validPlaceDetails(value.pinnedPlaces),
    aiRevision: typeof value.aiRevision === 'string' ? value.aiRevision : undefined,
    note: typeof value.note === 'string' ? value.note : undefined,
    sourceMaterial:
      typeof value.sourceMaterial === 'string' && value.sourceMaterial.trim()
        ? value.sourceMaterial
        : undefined,
    wikiTexts: Array.isArray(value.wikiTexts)
      ? value.wikiTexts.filter(
          (item): item is { title: string; text: string } =>
            Boolean(item) &&
            typeof item.title === 'string' &&
            typeof item.text === 'string',
        )
      : undefined,
    nearby: nearby && nearby.length > 0 ? nearby : undefined,
    nearbyRoads: Array.isArray(value.nearbyRoads)
      ? value.nearbyRoads
          .map(validContextRoad)
          .filter((road): road is LayerContextRoad => Boolean(road))
      : undefined,
    itinerary: validItineraryContext(value.itinerary),
    nearbyAnchor:
      value.nearbyAnchor === 'my position' ||
      value.nearbyAnchor === 'at place' ||
      value.nearbyAnchor === 'view center'
        ? value.nearbyAnchor
        : undefined,
    nearbyScope:
      value.nearbyScope === 'view' ||
      value.nearbyScope === 'map' ||
      value.nearbyScope === 'radius'
        ? value.nearbyScope
        : undefined,
    nearbyCoords: value.nearbyCoords !== false,
    favorites: validPlaceDetails(value.favorites),
    grid,
    updatedAt:
      typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : Date.now(),
  }
}

export function saveLayerState(ctx: StContext, state: LayerChatState): void {
  state.updatedAt = Date.now()
  if (!ctx.chatMetadata) return
  // Notes are global; chat metadata keeps only chat-scoped view/selection/link state.
  ctx.chatMetadata[LAYER_STATE_KEY] = { ...state, notes: {} }
  void flushGlobalNotes()
  if (ctx.saveMetadata) {
    try {
      const result = ctx.saveMetadata()
      if (result && typeof result.catch === 'function') void result.catch(() => undefined)
    } catch {
      ctx.saveMetadataDebounced?.()
    }
  } else {
    ctx.saveMetadataDebounced?.()
  }
}
