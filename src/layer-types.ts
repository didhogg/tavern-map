import type { StContext } from './types'

export type LayerMapKind = 'image' | 'tiles'
export type LayerMapSource = 'fandom' | 'mapgenie' | 'manual'

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
}

export type LayerMapPackage = {
  id: string
  name: string
  kind: LayerMapKind
  source: LayerMapSource
  /** Image maps use the original pixel dimensions for aspect ratio. */
  width: number
  height: number
  /** Image maps only. Stored as a Blob so local images survive reloads. */
  image?: Blob
  imageType?: string
  tile?: LayerTileConfig
  /** Optional local tile blobs keyed as `z/y/x` (without extension). */
  tileFiles?: Record<string, Blob>
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
  markerCount: number
  regionCount: number
  categoryCount: number
  updatedAt: number
}

export type LayerView = {
  /** Normalized center x/y in 0..1. */
  cx: number
  cy: number
  /** Image: fit multiplier. Tiles: tile zoom. */
  zoom: number
}

export type LayerContextSnapshot = {
  mapName: string
  kind: LayerMapKind
  source: LayerMapSource
  currentPlace?: string
  category?: string
  region?: string
  note?: string
  links?: string[]
  visibleCategories?: string[]
  scaleNote?: string
  updatedAt: number
}

export type LayerChatState = {
  version: 1
  packageId?: string
  view?: LayerView
  selectedMarkerId?: string
  currentMarkerId?: string
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
    selectedRegionId:
      typeof value.selectedRegionId === 'string' ? value.selectedRegionId : undefined,
    currentRegionId:
      typeof value.currentRegionId === 'string' ? value.currentRegionId : undefined,
    hiddenCategories: Array.isArray(value.hiddenCategories)
      ? value.hiddenCategories.filter((id): id is string => typeof id === 'string')
      : [],
    showLabels: typeof value.showLabels === 'boolean' ? value.showLabels : true,
    showRegions: typeof value.showRegions === 'boolean' ? value.showRegions : true,
    notes,
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
  return {
    mapName: value.mapName,
    kind: value.kind === 'tiles' ? 'tiles' : 'image',
    source:
      value.source === 'mapgenie' || value.source === 'manual' ? value.source : 'fandom',
    currentPlace: typeof value.currentPlace === 'string' ? value.currentPlace : undefined,
    category: typeof value.category === 'string' ? value.category : undefined,
    region: typeof value.region === 'string' ? value.region : undefined,
    note: typeof value.note === 'string' ? value.note : undefined,
    links: Array.isArray(value.links)
      ? value.links.filter((link): link is string => typeof link === 'string')
      : undefined,
    visibleCategories: Array.isArray(value.visibleCategories)
      ? value.visibleCategories.filter((name): name is string => typeof name === 'string')
      : undefined,
    scaleNote: typeof value.scaleNote === 'string' ? value.scaleNote : undefined,
    updatedAt:
      typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : Date.now(),
  }
}

export function saveLayerState(ctx: StContext, state: LayerChatState): void {
  state.updatedAt = Date.now()
  if (!ctx.chatMetadata) return
  ctx.chatMetadata[LAYER_STATE_KEY] = state
  ctx.saveMetadataDebounced?.()
}
