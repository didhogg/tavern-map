import type {
  LayerCategory,
  LayerCategoryGroup,
  LayerImageSource,
  LayerLink,
  LayerMapPackage,
  LayerMarker,
  LayerRegion,
  LayerStreet,
  LayerTileConfig,
  LayerTileOrder,
  LayerView,
} from './layer-types'

const PALETTE = [
  '#e6b56a',
  '#78c6c0',
  '#e78282',
  '#8ab4f8',
  '#c792ea',
  '#9ccc65',
  '#ffb74d',
  '#4dd0e1',
  '#f06292',
  '#a1887f',
  '#90a4ae',
  '#dce775',
  '#ff8a65',
  '#7986cb',
  '#4db6ac',
  '#ba68c8',
  '#fdd835',
  '#81c784',
  '#64b5f6',
  '#e57373',
]

type RawRecord = Record<string, unknown>

function record(value: unknown): RawRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RawRecord)
    : undefined
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function idValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function hash(value: string): string {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(36)
}

function dataBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length
  } catch {
    return 0
  }
}

function colorFor(index: number): string {
  return PALETTE[index % PALETTE.length]
}

function normalizeColor(value: unknown, fallback: string): string {
  const raw = text(value)
  if (/^#[0-9a-f]{3,8}$/i.test(raw)) return raw
  if (/^[0-9a-f]{3,8}$/i.test(raw)) return `#${raw}`
  return fallback
}

/** Remove the most common wiki/markdown noise from imported descriptions. */
export function cleanSourceText(value: unknown): string {
  const raw = text(value)
  if (!raw) return ''
  return raw
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\r\n?/g, '\n')
    .trim()
}

export const DEFAULT_WIKI_BASE = 'forgottenrealms.fandom.com'

export function normalizeWikiBase(value: string | undefined): string {
  const raw = text(value)
  if (!raw) return DEFAULT_WIKI_BASE
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
    return url.hostname.toLowerCase() || DEFAULT_WIKI_BASE
  } catch {
    return raw.replace(/^https?:\/\//i, '').split('/')[0]?.toLowerCase() || DEFAULT_WIKI_BASE
  }
}

function encodeWikiTitle(value: string): string {
  return value
    .trim()
    .replace(/^\/+/, '')
    .split('/')
    .map((part) => encodeURIComponent(part.replace(/\s+/g, '_')))
    .join('/')
}

export function wikiUrl(raw: string, wikiBase = DEFAULT_WIKI_BASE): string {
  const value = raw.trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  if (value.startsWith('/')) return `https://${normalizeWikiBase(wikiBase)}${value}`
  const [title, hash] = value.split('#', 2)
  const suffix = hash ? `#${encodeWikiTitle(hash)}` : ''
  return `https://${normalizeWikiBase(wikiBase)}/wiki/${encodeWikiTitle(title)}${suffix}`
}

function makeMarkerId(prefix: string, sourceId: string, index: number): string {
  return `${prefix}:${sourceId || index}`
}

function stableSourceId(value: RawRecord, name: string, x: number, y: number, index: number): string {
  return (
    idValue(value.id) ||
    `pos-${hash(`${name}:${x.toFixed(3)}:${y.toFixed(3)}:${index}`)}`
  )
}

function xyBounds(points: Array<[number, number]>): {
  minX: number
  maxX: number
  minY: number
  maxY: number
} {
  if (points.length === 0) {
    return { minX: 0, maxX: 1, minY: 0, maxY: 1 }
  }
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const [x, y] of points) {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  const spanX = maxX - minX
  const spanY = maxY - minY
  const padX = spanX > 0 ? spanX * 0.025 : 0.5
  const padY = spanY > 0 ? spanY * 0.025 : 0.5
  return {
    minX: minX - padX,
    maxX: maxX + padX,
    minY: minY - padY,
    maxY: maxY + padY,
  }
}

function mercatorX(lng: number): number {
  return (lng + 180) / 360
}

function mercatorY(lat: number): number {
  const clamped = Math.min(85.05112878, Math.max(-85.05112878, lat))
  const rad = (clamped * Math.PI) / 180
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2
}

function mercatorPoint(lng: number, lat: number): [number, number] {
  return [mercatorX(lng), mercatorY(lat)]
}

function extractMarkdownLinks(value: unknown, prefix: string): LayerLink[] {
  const source = text(value)
  if (!source) return []
  const seen = new Set<string>()
  const links: LayerLink[] = []
  const regex = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g
  for (const match of source.matchAll(regex)) {
    const title = match[1].trim()
    const url = match[2].trim()
    if (!title || !url || seen.has(url)) continue
    seen.add(url)
    links.push({
      id: `source:${prefix}:link:${links.length}`,
      kind: 'source',
      title,
      url,
    })
  }
  return links
}

function fandomSourceLinks(
  sourceUrl: string | undefined,
  sourceTitle: string | undefined,
  description: string | undefined,
  prefix: string,
): LayerLink[] | undefined {
  const links: LayerLink[] = []
  if (sourceUrl) {
    links.push({
      id: `source:${prefix}:wiki`,
      kind: 'wikipedia',
      title: sourceTitle || sourceUrl,
      url: sourceUrl,
    })
  }
  for (const link of extractMarkdownLinks(description, prefix)) {
    if (links.some((item) => item.url === link.url)) continue
    links.push(link)
  }
  return links.length > 0 ? links : undefined
}

function fandomCategories(raw: unknown[]): LayerCategory[] {
  const result: LayerCategory[] = []
  raw.forEach((item, index) => {
    const value = record(item)
    if (!value) return
    const id = idValue(value.id)
    const name = text(value.name) || text(value.title) || id
    if (!id || !name) return
    const order = numberValue(value.listId) ?? numberValue(value.order) ?? index
    result.push({
      id,
      name,
      groupId: 'fandom',
      color: normalizeColor(value.color, colorFor(index)),
      order,
    })
  })
  return result.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

function fandomHeightBounds(raw: RawRecord): {
  width: number
  height: number
  minX: number
  minY: number
} {
  const bounds = raw.mapBounds
  let first: unknown[] = []
  let second: unknown[] = []
  if (Array.isArray(bounds)) {
    first = array(bounds[0])
    second = array(bounds[1])
  } else {
    const value = record(bounds)
    first = array(value?.min ?? value?.[0])
    second = array(value?.max ?? value?.[1])
  }
  const width = numberValue(second[0]) ?? numberValue(raw.width) ?? 3000
  const height = numberValue(second[1]) ?? numberValue(raw.height) ?? 4524
  const minX = numberValue(first[0]) ?? 0
  const minY = numberValue(first[1]) ?? 0
  return {
    width: Math.max(1, width - minX),
    height: Math.max(1, height - minY),
    minX,
    minY,
  }
}

export type FandomImportOptions = {
  name?: string
  wikiBase?: string
  sourceUrl?: string
  sourceKey?: string
  image?: Blob
  imageType?: string
  imageName?: string
  imagePageUrl?: string
  imageWidth?: number
  imageHeight?: number
  imageSource?: LayerImageSource
}

export function parseFandomPackage(
  raw: unknown,
  options: FandomImportOptions,
): LayerMapPackage {
  const root = record(raw)
  if (!root) throw new Error('JSON 不是对象')
  const markersRaw = array(root.markers)
  if (markersRaw.length === 0) throw new Error('没有找到 markers 数组')
  const dimensions = fandomHeightBounds(root)
  const origin = text(root.origin) === 'top-left' ? 'top-left' : 'bottom-left'
  const coordinateOrder = text(root.coordinateOrder) === 'yx' ? 'yx' : 'xy'
  const categories = fandomCategories(array(root.categories))
  const categoryIds = new Set(categories.map((category) => category.id))
  const groups: LayerCategoryGroup[] = [{ id: 'fandom', name: '地点', order: 0 }]
  const markers: LayerMarker[] = []
  const wikiBase = normalizeWikiBase(options.wikiBase)

  markersRaw.forEach((item, index) => {
    const value = record(item)
    if (!value) return
    const position = array(value.position)
    const rawA = numberValue(position[0])
    const rawB = numberValue(position[1])
    if (rawA == null || rawB == null) return
    const sourceX = coordinateOrder === 'yx' ? rawB : rawA
    const sourceY = coordinateOrder === 'yx' ? rawA : rawB
    const popup = record(value.popup)
    const name = cleanSourceText(popup?.title) || `地点 ${index + 1}`
    const sourceId = stableSourceId(value, name, sourceX, sourceY, index)
    const categoryId = idValue(value.categoryId) || 'uncategorized'
    if (!categoryIds.has(categoryId)) {
      categoryIds.add(categoryId)
      categories.push({
        id: categoryId,
        name: categoryId === 'uncategorized' ? '未分类' : categoryId,
        groupId: 'fandom',
        color: colorFor(categories.length),
        order: categories.length,
      })
    }
    const link = record(popup?.link)
    const rawLink = text(link?.url)
    const sourceTitle = text(link?.label) || rawLink || undefined
    const sourceUrl = rawLink ? wikiUrl(rawLink, wikiBase) : undefined
    const description = cleanSourceText(popup?.description) || undefined
    const nX = Math.min(1, Math.max(0, (sourceX - dimensions.minX) / dimensions.width))
    const rawY = (sourceY - dimensions.minY) / dimensions.height
    const nY = origin === 'bottom-left' ? 1 - rawY : rawY
    markers.push({
      id: makeMarkerId('fandom', sourceId, index),
      sourceId,
      name,
      categoryId,
      x: nX,
      y: Math.min(1, Math.max(0, nY)),
      description,
      sourceUrl,
      sourceTitle,
      sourceLinks: fandomSourceLinks(sourceUrl, sourceTitle, description, sourceId),
    })
  })

  if (markers.length === 0) throw new Error('markers 中没有可用的 position')
  const now = Date.now()
  const sourceKey =
    options.sourceKey ||
    `fandom:${wikiBase}:${text(root.mapImage) || options.name || 'map'}:${dimensions.width}x${dimensions.height}`
  const packageId = `fandom-${hash(sourceKey)}`
  return {
    id: packageId,
    name: options.name || 'Fandom 地图',
    kind: 'image',
    source: 'fandom',
    sourceKey,
    sourceUrl: options.sourceUrl,
    wikiBase,
    width: dimensions.width,
    height: dimensions.height,
    image: options.image,
    imageType: options.imageType,
    imageName: options.imageName,
    imagePageUrl: options.imagePageUrl,
    imageWidth: options.imageWidth,
    imageHeight: options.imageHeight,
    imageBytes: options.image?.size,
    imageSource: options.image ? options.imageSource ?? 'package' : 'none',
    imageFit: options.image ? 'stretch' : undefined,
    categories,
    groups,
    markers,
    regions: [],
    dataBytes: dataBytes({ categories, groups, markers, regions: [] }),
    attribution: `${wikiBase} / 本地导入`,
    createdAt: now,
    updatedAt: now,
  }
}

export type MapGenieTileBounds = {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

export type MapGenieTileSetInfo = {
  index: number
  id: string
  name: string
  pattern: string
  minZoom: number
  maxZoom: number
  order: LayerTileOrder
  prefix: string
  boundsByZoom: Record<string, MapGenieTileBounds>
  backgroundColor?: string
}

function tileOrderFromPattern(pattern: string): LayerTileOrder {
  const z = pattern.indexOf('{z}')
  const x = pattern.indexOf('{x}')
  const y = pattern.indexOf('{y}')
  if (z < 0 || x < 0 || y < 0) return 'unknown'
  if (x < y) return 'zxy'
  if (y < x) return 'zyx'
  return 'unknown'
}

function tilePrefixFromPattern(pattern: string): string {
  const index = pattern.indexOf('{z}')
  return index > 0 ? pattern.slice(0, index).replace(/^\/+/, '') : ''
}

function mapGenieRemoteTemplate(pattern: string): string | undefined {
  const value = pattern.trim()
  if (!value) return undefined
  if (/^https?:\/\//i.test(value)) return value
  return `https://tiles.mapgenie.io/games/${value.replace(/^\/+/, '')}`
}

function boundsForTileSet(value: RawRecord | undefined): Record<string, MapGenieTileBounds> {
  const result: Record<string, MapGenieTileBounds> = {}
  const bounds = record(value?.bounds)
  if (!bounds) return result
  for (const [zoom, rawZoom] of Object.entries(bounds)) {
    const zoomValue = record(rawZoom)
    const x = record(zoomValue?.x)
    const y = record(zoomValue?.y)
    const xMin = numberValue(x?.min)
    const xMax = numberValue(x?.max)
    const yMin = numberValue(y?.min)
    const yMax = numberValue(y?.max)
    if (xMin == null || xMax == null || yMin == null || yMax == null) continue
    result[zoom] = { xMin, xMax, yMin, yMax }
  }
  return result
}

export function mapGenieTileSets(raw: unknown): MapGenieTileSetInfo[] {
  const outer = record(raw)
  if (!outer) return []
  const root = record(outer.mapData) ?? outer
  const mapConfig = record(root.mapConfig)
  const tileSets = array(mapConfig?.tile_sets)
  return tileSets.flatMap((item, index) => {
    const value = record(item)
    if (!value) return []
    const pattern = text(value.pattern)
    const minZoom = Math.max(0, numberValue(value.min_zoom) ?? 0)
    const maxZoom = Math.max(
      minZoom,
      numberValue(value.tiles_max_zoom) ?? numberValue(value.max_zoom) ?? minZoom,
    )
    return [{
      index,
      id: idValue(value.id) || String(index),
      name: text(value.name) || `瓦片组 ${index + 1}`,
      pattern,
      minZoom,
      maxZoom,
      order: tileOrderFromPattern(pattern),
      prefix: tilePrefixFromPattern(pattern),
      boundsByZoom: boundsForTileSet(value),
      backgroundColor: text(value.background_color) || undefined,
    }]
  })
}

export function mapGenieMapInfo(raw: unknown): {
  title: string
  id: string
  slug: string
  tileSets: MapGenieTileSetInfo[]
} {
  const outer = record(raw)
  const root = record(outer?.mapData) ?? outer
  const map = record(root?.map)
  return {
    title: text(map?.title),
    id: idValue(map?.id),
    slug: text(map?.slug),
    tileSets: mapGenieTileSets(raw),
  }
}

export type MapGenieImportOptions = {
  name?: string
  tileTemplate?: string
  tileSetIndex?: number
  tileFiles?: Record<string, Blob>
  tileOrder?: LayerTileOrder
  tilePattern?: string
  tileStats?: { expected: number; missing: number }
  sourceKey?: string
  sourceUrl?: string
  sourceLabel?: string
}

export function parseMapGeniePackage(
  raw: unknown,
  options: MapGenieImportOptions,
): LayerMapPackage {
  const outer = record(raw)
  if (!outer) throw new Error('JSON 不是对象')
  const root = record(outer.mapData) ?? outer
  const locationsRaw = array(root.locations)
  if (locationsRaw.length === 0) throw new Error('没有找到 locations 数组')
  const regionsRaw = array(root.regions)
  const streetsRaw = featureList(root.streets ?? root.roads)
  const map = record(root.map)
  const mapConfig = record(root.mapConfig)
  const groupsRaw = array(root.groups)
  const categoriesRaw = root.categories

  const groups: LayerCategoryGroup[] = []
  groupsRaw.forEach((item, index) => {
    const value = record(item)
    const id = idValue(value?.id)
    const name = text(value?.title)
    if (!id || !name) return
    groups.push({ id, name, order: numberValue(value?.order) ?? index })
  })

  const categoryValues = Array.isArray(categoriesRaw)
    ? categoriesRaw
    : categoriesRaw && typeof categoriesRaw === 'object'
      ? Object.values(categoriesRaw)
      : []
  const categories: LayerCategory[] = []
  categoryValues.forEach((item, index) => {
    const value = record(item)
    const id = idValue(value?.id)
    const name = text(value?.title) || text(value?.name)
    if (!id || !name) return
    categories.push({
      id,
      name,
      groupId: idValue(value?.group_id) || undefined,
      color: normalizeColor(value?.color, colorFor(index)),
      icon: text(value?.icon) || undefined,
      order: numberValue(value?.order) ?? index,
    })
  })

  const tileSets = array(mapConfig?.tile_sets)
  const tileSetIndex = options.tileSetIndex ?? 0
  const tileSetValue = record(tileSets[tileSetIndex]) ?? record(tileSets[0])
  const minZoom = Math.max(0, numberValue(tileSetValue?.min_zoom) ?? 0)
  const maxZoom = Math.max(
    minZoom,
    numberValue(tileSetValue?.tiles_max_zoom) ?? numberValue(tileSetValue?.max_zoom) ?? minZoom,
  )
  const boundsByZoom = boundsForTileSet(tileSetValue)
  const boundsAtMin = boundsByZoom[String(minZoom)]
  const xMin = boundsAtMin?.xMin ?? 0
  const yMin = boundsAtMin?.yMin ?? 0
  const xMax = boundsAtMin?.xMax ?? xMin
  const yMax = boundsAtMin?.yMax ?? yMin
  const tileCount = Math.max(1, Math.round(Math.min(xMax - xMin + 1, yMax - yMin + 1)))
  const backgroundColor =
    text(tileSetValue?.background_color) ||
    text(record(tileSets[0])?.background_color) ||
    '#0a0f14'
  const tileFileKeys = Object.keys(options.tileFiles ?? {})
  let coverageMin: number | undefined
  let coverageMax: number | undefined
  for (const key of tileFileKeys) {
    const zoom = Number(key.split('/')[0])
    if (!Number.isFinite(zoom)) continue
    coverageMin = coverageMin == null ? zoom : Math.min(coverageMin, zoom)
    coverageMax = coverageMax == null ? zoom : Math.max(coverageMax, zoom)
  }
  const tile: LayerTileConfig = {
    template: options.tileTemplate?.trim() ?? '',
    remoteTemplate: mapGenieRemoteTemplate(text(tileSetValue?.pattern)),
    minZoom,
    maxZoom,
    xMin,
    yMin,
    count: tileCount,
    backgroundColor: backgroundColor.startsWith('#') ? backgroundColor : `#${backgroundColor}`,
    projection: 'webmercator',
    order: options.tileOrder ?? 'unknown',
    coverageMinZoom: coverageMin,
    coverageMaxZoom: coverageMax,
    expectedCount: options.tileStats?.expected,
    missingCount: options.tileStats?.missing,
    setName: text(tileSetValue?.name) || undefined,
    setIndex: tileSetIndex,
    setCount: tileSets.length,
    boundsByZoom,
  }

  const worldPoints: Array<[number, number]> = []
  for (const item of locationsRaw) {
    const value = record(item)
    const lng = numberValue(value?.longitude)
    const lat = numberValue(value?.latitude)
    if (lng != null && lat != null) worldPoints.push(mercatorPoint(lng, lat))
  }
  for (const item of regionsRaw) {
    const regionValue = record(item)
    if (!regionValue) continue
    for (const feature of parseRegionFeatures(regionValue)) {
      for (const ring of feature.polygons) {
        for (const [lng, lat] of ring) worldPoints.push(mercatorPoint(lng, lat))
      }
    }
  }
  const streets = parseStreetFeatures(streetsRaw)
  for (const street of streets) {
    for (const point of street.points) worldPoints.push(point)
  }
  const explicitWorldBounds = record(root.worldBounds)
  const worldMinX = numberValue(explicitWorldBounds?.minX)
  const worldMinY = numberValue(explicitWorldBounds?.minY)
  const worldMaxX = numberValue(explicitWorldBounds?.maxX)
  const worldMaxY = numberValue(explicitWorldBounds?.maxY)
  tile.worldBounds =
    worldMinX != null && worldMinY != null && worldMaxX != null && worldMaxY != null
      ? { minX: worldMinX, minY: worldMinY, maxX: worldMaxX, maxY: worldMaxY }
      : xyBounds(worldPoints)
  const regionFeatures: LayerRegion[] = []
  regionsRaw.forEach((item, index) => {
    const value = record(item)
    if (!value) return
    const sourceId = idValue(value.id) || String(index)
    const features = parseRegionFeatures(value)
    if (features.length === 0) return
    const polygons = features.flatMap((feature) =>
      feature.polygons.map((ring) => ring.map(([lng, lat]) => mercatorPoint(lng, lat))),
    )
    const labelLng = numberValue(value.label_longitude) ?? numberValue(value.labelLongitude)
    const labelLat = numberValue(value.label_latitude) ?? numberValue(value.labelLatitude)
    const label = labelLng != null && labelLat != null ? mercatorPoint(labelLng, labelLat) : undefined
    regionFeatures.push({
      id: `mapgenie-region:${sourceId}`,
      name: text(value.title) || `区域 ${sourceId}`,
      parentId: idValue(value.parent_region_id) || undefined,
      labelX: label?.[0],
      labelY: label?.[1],
      polygons,
    })
  })

  const regionIdBySource = new Map<string, string>()
  regionsRaw.forEach((item, index) => {
    const value = record(item)
    const sourceId = idValue(value?.id) || String(index)
    regionIdBySource.set(sourceId, `mapgenie-region:${sourceId}`)
  })

  const markers: LayerMarker[] = []
  locationsRaw.forEach((item, index) => {
    const value = record(item)
    if (!value) return
    const rawX = numberValue(value.longitude)
    const rawY = numberValue(value.latitude)
    if (rawX == null || rawY == null) return
    const name = cleanSourceText(value.title) || `地点 ${index + 1}`
    const sourceId = stableSourceId(value, name, rawX, rawY, index)
    const categoryValue = record(value.category)
    const categoryId = idValue(value.category_id) || idValue(categoryValue?.id) || 'uncategorized'
    if (!categories.some((category) => category.id === categoryId)) {
      categories.push({
        id: categoryId,
        name: text(categoryValue?.title) || categoryId || '未分类',
        groupId: idValue(categoryValue?.group_id) || undefined,
        color: normalizeColor(categoryValue?.color, colorFor(categories.length)),
        icon: text(categoryValue?.icon) || undefined,
        order: categories.length,
      })
    }
    const [x, y] = mercatorPoint(rawX, rawY)
    const regionSourceId = idValue(value.region_id)
    const description = cleanSourceText(value.description) || undefined
    const sourceLinks = extractMarkdownLinks(value.description, sourceId)
    markers.push({
      id: makeMarkerId('mapgenie', sourceId, index),
      sourceId,
      name,
      categoryId,
      x,
      y,
      description,
      regionId: regionSourceId ? regionIdBySource.get(regionSourceId) : undefined,
      sourceLinks: sourceLinks.length > 0 ? sourceLinks : undefined,
    })
  })

  if (markers.length === 0) throw new Error('locations 中没有可用坐标')
  const now = Date.now()
  const title = text(map?.title) || options.name || 'Map Genie 地图'
  const sourceKey =
    options.sourceKey ||
    `mapgenie:${text(map?.id) || text(map?.slug) || title}:${idValue(tileSetValue?.id) || tileSetIndex}`
  const packageId = `mapgenie-${hash(sourceKey)}`
  return {
    id: packageId,
    name: options.name || title,
    kind: 'tiles',
    source: 'mapgenie',
    sourceLabel: options.sourceLabel || text(root.sourceLabel) || undefined,
    defaultView: parseLayerView(root.defaultView),
    sourceKey,
    sourceUrl: options.sourceUrl,
    width: 1,
    height: 1,
    tile,
    tileFiles: options.tileFiles,
    categories,
    groups,
    markers,
    regions: regionFeatures,
    streets: streets.length > 0 ? streets : undefined,
    dataBytes: dataBytes({ categories, groups, markers, regions: regionFeatures, streets }),
    attribution: text(root.attribution) || 'Map Genie / 用户本地快照',
    createdAt: now,
    updatedAt: now,
  }
}

/** GeoJSON road data: a feature array or a FeatureCollection. */
function featureList(value: unknown): unknown[] {
  const collection = record(value)
  return collection && Array.isArray(collection.features) ? collection.features : array(value)
}

/** First non-empty property among common GeoJSON / OSM road keys. */
function firstProperty(properties: Record<string, unknown> | undefined, keys: string[]): unknown {
  for (const key of keys) {
    const value = properties?.[key]
    if (value != null && text(value)) return value
  }
  return undefined
}

const STREET_NAME_KEYS = ['Name', 'name', 'NAME', 'title', 'Title', 'label', 'Label']
const STREET_TYPE_KEYS = ['Type', 'type', 'TYPE', 'highway', 'class', 'kind', 'fclass', 'road_type']

function parseStreetFeatures(raw: unknown[]): LayerStreet[] {
  const result: LayerStreet[] = []
  raw.forEach((item, featureIndex) => {
    const feature = record(item)
    if (!feature) return
    const properties = record(feature.properties)
    // Unnamed lines are still roads: kept for the road layer and "on road" context.
    const name = cleanSourceText(firstProperty(properties, STREET_NAME_KEYS)) ?? ''
    const type = text(firstProperty(properties, STREET_TYPE_KEYS)) || undefined
    const geometry = record(feature.geometry)
    const geometryType = text(geometry?.type)
    if (!geometry || (geometryType !== 'LineString' && geometryType !== 'MultiLineString')) {
      return
    }
    const lines =
      geometryType === 'LineString'
        ? [geometry.coordinates]
        : array(geometry.coordinates)
    const sourceId =
      idValue(properties?.fid) || idValue(properties?.id) || idValue(feature.id) || String(featureIndex)
    lines.forEach((lineRaw, lineIndex) => {
      const points: Array<[number, number]> = []
      for (const pointRaw of array(lineRaw)) {
        const point = array(pointRaw)
        const lng = numberValue(point[0])
        const lat = numberValue(point[1])
        if (lng != null && lat != null) points.push(mercatorPoint(lng, lat))
      }
      if (points.length < 2) return
      result.push({
        id: `mapgenie-street:${sourceId}:${lineIndex}`,
        name,
        type,
        points,
      })
    })
  })
  return result
}

type ParsedRegionFeature = {
  polygons: Array<Array<[number, number]>>
}

function parseLayerView(value: unknown): LayerView | undefined {
  const view = record(value)
  const cx = numberValue(view?.cx)
  const cy = numberValue(view?.cy)
  const zoom = numberValue(view?.zoom)
  if (cx == null || cy == null || zoom == null) return undefined
  return {
    cx: Math.min(1, Math.max(0, cx)),
    cy: Math.min(1, Math.max(0, cy)),
    zoom: Math.max(0, zoom),
  }
}

function parseRegionFeatures(value: RawRecord): ParsedRegionFeature[] {
  const features = array(value.features)
  const result: ParsedRegionFeature[] = []
  for (const featureItem of features) {
    const feature = record(featureItem)
    if (!feature) continue
    const geometry = record(feature.geometry)
    const type = text(geometry?.type)
    const coordinates = geometry?.coordinates
    if (!geometry || !coordinates) continue
    if (type === 'Polygon') {
      const rings = polygonRings(coordinates)
      if (rings.length > 0) result.push({ polygons: rings })
    } else if (type === 'MultiPolygon') {
      for (const polygon of array(coordinates)) {
        const rings = polygonRings(polygon)
        if (rings.length > 0) result.push({ polygons: rings })
      }
    }
  }
  return result
}

function polygonRings(value: unknown): Array<Array<[number, number]>> {
  const rings: Array<Array<[number, number]>> = []
  for (const ringRaw of array(value)) {
    const ring: Array<[number, number]> = []
    for (const pointRaw of array(ringRaw)) {
      const point = array(pointRaw)
      const x = numberValue(point[0])
      const y = numberValue(point[1])
      if (x != null && y != null) ring.push([x, y])
    }
    if (ring.length >= 3) rings.push(ring)
  }
  return rings
}

export function detectPackageJsonKind(raw: unknown): 'fandom' | 'mapgenie' | 'unknown' {
  const outer = record(raw)
  if (!outer) return 'unknown'
  const root = record(outer.mapData) ?? outer
  if (Array.isArray(root.markers) && root.markers.length > 0) return 'fandom'
  if (
    Array.isArray(root.locations) ||
    record(root.mapConfig) ||
    record(root.map)
  ) {
    return 'mapgenie'
  }
  return 'unknown'
}

export function fallbackPackageName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || '本地地图包'
}
