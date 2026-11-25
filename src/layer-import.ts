import type {
  LayerCategory,
  LayerCategoryGroup,
  LayerMapPackage,
  LayerLink,
  LayerMarker,
  LayerRegion,
  LayerTileConfig,
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
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
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

function wikiUrl(raw: string): string {
  if (/^https?:\/\//i.test(raw)) return raw
  const title = raw
    .replace(/^\/+/, '')
    .split('/')
    .map((part) => encodeURIComponent(part.replace(/\s+/g, '_')))
    .join('/')
  return `https://forgottenrealms.fandom.com/wiki/${title}`
}

function makeMarkerId(prefix: string, sourceId: string, index: number): string {
  return `${prefix}:${sourceId || index}`
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
      id: `source:${prefix}:${links.length}`,
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
  prefix: string,
): LayerLink[] | undefined {
  if (!sourceUrl) return undefined
  return [
    {
      id: `source:${prefix}:wiki`,
      kind: 'wikipedia',
      title: sourceTitle || sourceUrl,
      url: sourceUrl,
    },
  ]
}

function fandomCategories(raw: unknown[]): LayerCategory[] {
  const result: LayerCategory[] = []
  raw.forEach((item, index) => {
    const value = record(item)
    if (!value) return
    const id = idValue(value.id)
    const name = text(value.name) || text(value.title) || id
    if (!id || !name) return
    result.push({
      id,
      name,
      groupId: 'fandom',
      color: normalizeColor(value.color, colorFor(index)),
      order: index,
    })
  })
  return result
}

function fandomHeightBounds(raw: RawRecord): {
  width: number
  height: number
  minX: number
  minY: number
} {
  const bounds = array(raw.mapBounds)
  const first = array(bounds[0])
  const second = array(bounds[1])
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
  name: string
  image?: Blob
  imageType?: string
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
  const categories = fandomCategories(array(root.categories))
  const categoryIds = new Set(categories.map((category) => category.id))
  const groups: LayerCategoryGroup[] = [{ id: 'fandom', name: '地点', order: 0 }]
  const markers: LayerMarker[] = []

  markersRaw.forEach((item, index) => {
    const value = record(item)
    if (!value) return
    const position = array(value.position)
    const sourceX = numberValue(position[0])
    const sourceY = numberValue(position[1])
    if (sourceX == null || sourceY == null) return
    const sourceId = idValue(value.id) || String(index)
    const popup = record(value.popup)
    const name = cleanSourceText(popup?.title) || `地点 ${sourceId}`
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
    const rawLink = text(record(popup?.link)?.url)
    const sourceUrl = rawLink || name ? wikiUrl(rawLink || name) : undefined
    const nX = Math.min(1, Math.max(0, (sourceX - dimensions.minX) / dimensions.width))
    const rawY = (sourceY - dimensions.minY) / dimensions.height
    const nY = origin === 'bottom-left' ? 1 - rawY : rawY
    const sourceTitle = text(record(popup?.link)?.label) || undefined
    markers.push({
      id: makeMarkerId('fandom', sourceId, index),
      sourceId,
      name,
      categoryId,
      x: nX,
      y: Math.min(1, Math.max(0, nY)),
      description: cleanSourceText(popup?.description) || undefined,
      sourceUrl,
      sourceTitle,
      sourceLinks: fandomSourceLinks(sourceUrl, sourceTitle, sourceId),
    })
  })

  if (markers.length === 0) throw new Error('markers 中没有可用的 position')
  const now = Date.now()
  const packageId = `fandom-${hash(`${options.name}:${dimensions.width}x${dimensions.height}:${markers.length}`)}`
  return {
    id: packageId,
    name: options.name || 'Fandom 地图',
    kind: 'image',
    source: 'fandom',
    width: dimensions.width,
    height: dimensions.height,
    image: options.image,
    imageType: options.imageType,
    categories,
    groups,
    markers,
    regions: [],
    attribution: 'Fandom / 用户本地导入',
    createdAt: now,
    updatedAt: now,
  }
}

export type MapGenieImportOptions = {
  name: string
  tileTemplate: string
  tileSetIndex?: number
  tileFiles?: Record<string, Blob>
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
      order: numberValue(value?.order) ?? index,
    })
  })

  const tileSets = array(mapConfig?.tile_sets)
  const tileSetValue = record(tileSets[options.tileSetIndex ?? 0]) ?? record(tileSets[0])
  const minZoom = Math.max(0, numberValue(tileSetValue?.min_zoom) ?? 0)
  const maxZoom = Math.max(
    minZoom,
    numberValue(tileSetValue?.tiles_max_zoom) ?? numberValue(tileSetValue?.max_zoom) ?? minZoom,
  )
  const boundsRaw = record(tileSetValue?.bounds)
  const boundsAtMin = record(boundsRaw?.[String(minZoom)])
  const xBounds = record(boundsAtMin?.x)
  const yBounds = record(boundsAtMin?.y)
  const xMin = numberValue(xBounds?.min) ?? 0
  const yMin = numberValue(yBounds?.min) ?? 0
  const xMax = numberValue(xBounds?.max) ?? xMin
  const yMax = numberValue(yBounds?.max) ?? yMin
  const tileCount = Math.max(1, Math.round(Math.min(xMax - xMin + 1, yMax - yMin + 1)))
  const backgroundColor = text(tileSetValue?.background_color) || '#0a0f14'
  const tile: LayerTileConfig = {
    template: options.tileTemplate,
    minZoom,
    maxZoom,
    xMin,
    yMin,
    count: tileCount,
    backgroundColor,
    projection: 'webmercator',
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
  const bounds = xyBounds(worldPoints)
  tile.worldBounds = bounds
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
    regionFeatures.push({
      id: `mapgenie-region:${sourceId}`,
      name: text(value.title) || `区域 ${sourceId}`,
      parentId: idValue(value.parent_region_id) || undefined,
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
    const sourceId = idValue(value.id) || String(index)
    const rawX = numberValue(value.longitude)
    const rawY = numberValue(value.latitude)
    if (rawX == null || rawY == null) return
    const categoryValue = record(value.category)
    const categoryId = idValue(value.category_id) || idValue(categoryValue?.id) || 'uncategorized'
    if (!categories.some((category) => category.id === categoryId)) {
      categories.push({
        id: categoryId,
        name: text(categoryValue?.title) || categoryId || '未分类',
        groupId: idValue(categoryValue?.group_id) || undefined,
        color: normalizeColor(categoryValue?.color, colorFor(categories.length)),
        order: categories.length,
      })
    }
    const [x, y] = mercatorPoint(rawX, rawY)
    const regionSourceId = idValue(value.region_id)
    const sourceLinks = extractMarkdownLinks(value.description, sourceId)
    markers.push({
      id: makeMarkerId('mapgenie', sourceId, index),
      sourceId,
      name: cleanSourceText(value.title) || `地点 ${sourceId}`,
      categoryId,
      x,
      y,
      description: cleanSourceText(value.description) || undefined,
      regionId: regionSourceId ? regionIdBySource.get(regionSourceId) : undefined,
      sourceLinks: sourceLinks.length > 0 ? sourceLinks : undefined,
    })
  })

  if (markers.length === 0) throw new Error('locations 中没有可用坐标')
  const hasTileFiles = Boolean(options.tileFiles && Object.keys(options.tileFiles).length > 0)
  if (!hasTileFiles && !options.tileTemplate.trim()) {
    throw new Error('需要填写瓦片 URL 模板，或选择瓦片文件夹')
  }
  if (options.tileTemplate.trim() && (!/\{z\}/.test(options.tileTemplate) || !/\{y\}/.test(options.tileTemplate) || !/\{x\}/.test(options.tileTemplate))) {
    throw new Error('瓦片模板必须包含 {z}、{y}、{x}')
  }
  const now = Date.now()
  const title = text(map?.title) || options.name || 'Map Genie 地图'
  const packageId = `mapgenie-${hash(`${text(map?.id) || title}:${options.tileTemplate}`)}`
  return {
    id: packageId,
    name: options.name || title,
    kind: 'tiles',
    source: 'mapgenie',
    width: 1,
    height: 1,
    tile,
    tileFiles: options.tileFiles,
    categories,
    groups,
    markers,
    regions: regionFeatures,
    attribution: 'Map Genie / 用户本地快照',
    createdAt: now,
    updatedAt: now,
  }
}

type ParsedRegionFeature = {
  polygons: Array<Array<[number, number]>>
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

export function fallbackPackageName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || '本地地图包'
}
