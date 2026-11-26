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
  order?: number
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
}

export type LayerRegion = {
  id: string
  name: string
  parentId?: string
  /** Normalized polygons; each ring is a list of [x, y] points. */
  polygons: Array<Array<[number, number]>>
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
  /** Optional user calibration shared by all chats using this map package. */
  grid?: LayerGridConfig
  categories: LayerCategory[]
  groups: LayerCategoryGroup[]
  markers: LayerMarker[]
  regions: LayerRegion[]
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
  note?: string
}

export type LayerContextSnapshot = {
  mapName: string
  /** Explicit "my position", only when the user placed it. */
  position?: {
    x: number
    y: number
    region?: string
  }
  currentPlace?: string
  currentX?: number
  currentY?: number
  category?: string
  region?: string
  note?: string
  /** User-edited source material, only when explicitly included. */
  sourceMaterial?: string
  /** Fetched wiki/source text explicitly checked for AI context. */
  wikiTexts?: Array<{ title: string; text: string }>
  nearby?: LayerNearbyPlace[]
  nearbyAnchor?: 'my position' | 'at place' | 'view center'
  nearbyScope?: 'view' | 'map' | 'radius'
  nearbyCoords?: boolean
  favorites?: LayerFavoritePlace[]
  /** Present only after the user calibrated a grid on this map package. */
  grid?: LayerGridConfig
  updatedAt: number
}

export type LayerChatState = {
  version: 1
  packageId?: string
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
  currentRegionId?: string
  hiddenCategories?: string[]
  showLabels?: boolean
  showRegions?: boolean
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
    nearbyRadius:
      typeof value.nearbyRadius === 'number' && Number.isFinite(value.nearbyRadius)
        ? Math.min(0.8, Math.max(0.001, value.nearbyRadius))
        : undefined,
    selectedRegionId:
      typeof value.selectedRegionId === 'string' ? value.selectedRegionId : undefined,
    currentRegionId:
      typeof value.currentRegionId === 'string' ? value.currentRegionId : undefined,
    hiddenCategories: Array.isArray(value.hiddenCategories)
      ? value.hiddenCategories.filter((id): id is string => typeof id === 'string')
      : [],
    showLabels: typeof value.showLabels === 'boolean' ? value.showLabels : true,
    showRegions: typeof value.showRegions === 'boolean' ? value.showRegions : true,
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
          note: typeof item.note === 'string' ? item.note : undefined,
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
    favorites: Array.isArray(value.favorites)
      ? value.favorites.filter(
          (item): item is LayerFavoritePlace =>
            Boolean(item) && typeof item.key === 'string' && typeof item.name === 'string',
        )
      : undefined,
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
