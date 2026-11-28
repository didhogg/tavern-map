import {
  DEFAULT_WIKI_BASE,
  cleanSourceText,
  detectPackageJsonKind,
  fallbackPackageName,
  mapGenieMapInfo,
  normalizeWikiBase,
  parseFandomPackage,
  parseMapGeniePackage,
  type MapGenieTileSetInfo,
} from './layer-import'
import {
  formatBytes,
  imageAspectNote,
  imageResolutionNote,
  isPlaceholderName,
  isSupportedImageName,
  makeLayerThumbnail,
  normalizeImageName,
  readLayerImage,
} from './layer-image'
import type {
  LayerImageSource,
  LayerLink,
  LayerMapPackage,
  LayerMapSource,
  LayerTileOrder,
} from './layer-types'
import { isZipCandidate, readZip } from './layer-zip'
import {
  countBackupParts,
  isBackupFilePath,
  readBackupBundle,
  type BackupContents,
  type BackupPart,
} from './layer-backup'

export type LayerSourceFile = {
  path: string
  name: string
  blob: Blob
}

export type LayerSourceBundle = {
  label: string
  source: 'zip' | 'folder' | 'files'
  files: LayerSourceFile[]
}

export type LayerProgressEvent = {
  step: string
  detail?: string
  done?: number
  total?: number
}

export type LayerProgressReporter = (event: LayerProgressEvent) => void

export type LayerImageMatch =
  | 'manifest'
  | 'mapImage'
  | 'only'
  | 'fuzzy'
  | 'local'
  | 'downloaded'
  | 'none'

export type LayerImageChoice = {
  path: string
  name: string
  blob: Blob
  width: number
  height: number
  bytes: number
  placeholder: boolean
  source: LayerImageSource
  matched: LayerImageMatch
}

export type LayerDataCandidate = {
  path: string
  kind: 'fandom' | 'mapgenie'
  label: string
}

export type LayerImportNotice = {
  tone: 'info' | 'warning'
  text: string
}

export type LayerTileStats = {
  count: number
  expected: number
  missing: number
  minZoom?: number
  maxZoom?: number
  order: LayerTileOrder
  hasBounds: boolean
  setName: string
  setCount: number
}

export type LayerImportStats = {
  markerCount: number
  regionCount: number
  streetCount?: number
  categoryCount: number
  groupCount: number
  descriptionCount: number
  linkCount: number
  linkMarkerCount: number
  width: number
  height: number
  image?: {
    name: string
    width: number
    height: number
    bytes: number
    source: LayerImageSource
    placeholder: boolean
    match: LayerImageMatch
  }
  tiles?: LayerTileStats
  sizeBytes: number
  fileCount: number
}

export type LayerImportPreview = {
  pkg: LayerMapPackage
  stats: LayerImportStats
  notices: LayerImportNotice[]
  sourceLabel: string
  sourceUrl?: string
  imagePageUrl?: string
  imageDownloadError?: string
  imageChoices: LayerImageChoice[]
  /** Filename specified by the source map JSON, used for matching notices. */
  targetImageName?: string
  selectedImagePath?: string
  autoImagePath?: string
  dataPath: string
  dataCandidates: LayerDataCandidate[]
  bundle: LayerSourceBundle | null
  canAttachData: boolean
  /** Set when the bundle is a Tavern Map backup package. */
  backup?: BackupContents & { counts: Record<BackupPart, number> }
}

export type AnalyzeOptions = {
  signal?: AbortSignal
  onProgress?: LayerProgressReporter
  dataPath?: string
  name?: string
  wikiBase?: string
  tileUrl?: string
  tileSetIndex?: number
}

type Manifest = {
  name?: string
  source?: LayerMapSource
  data?: string
  image?: string
  tiles?: string
  tilePattern?: string
  tileUrl?: string
  tileSet?: number
  wiki?: string
  sourceUrl?: string
  sourceLabel?: string
}

type ManifestResult = {
  manifest?: Manifest
  path?: string
  baseDir: string
  error?: string
}

const IMAGE_FILE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif'])

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('导入已取消', 'AbortError')
}

function isJsonFile(file: LayerSourceFile): boolean {
  return file.path.toLowerCase().endsWith('.json')
}

function isImageFile(file: LayerSourceFile): boolean {
  return isSupportedImageName(file.name)
}

function nameOfPath(path: string): string {
  return path.split('/').pop() ?? path
}

function dirOfPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index >= 0 ? path.slice(0, index) : ''
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+/g, '/')
}

function joinPath(base: string, value: string): string {
  const normalized = normalizePath(value)
  if (!base) return normalized
  if (normalized.startsWith(`${base}/`)) return normalized
  return normalizePath(`${base}/${normalized}`)
}

function matchesPath(file: LayerSourceFile, wanted: string | undefined): boolean {
  if (!wanted) return false
  const normalized = normalizePath(wanted)
  return (
    file.path === normalized ||
    file.path.endsWith(`/${normalized}`) ||
    file.name === nameOfPath(normalized)
  )
}

export function filesToBundle(files: File[], label?: string): LayerSourceBundle {
  const mapped = files.map((file) => {
    const relative =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    return {
      path: normalizePath(relative),
      name: file.name,
      blob: file,
    }
  })
  const firstPath = mapped[0]?.path ?? ''
  const root = firstPath.includes('/') ? firstPath.split('/')[0] : ''
  return {
    label: label || root || fallbackPackageName(mapped[0]?.name ?? '本地地图包'),
    source: 'files',
    files: mapped,
  }
}

export async function zipToBundle(
  file: File,
  options: Pick<AnalyzeOptions, 'signal' | 'onProgress'> = {},
): Promise<LayerSourceBundle> {
  const entries = await readZip(file, {
    signal: options.signal,
    shouldRead: (path) => isZipCandidate(path) || isBackupFilePath(path),
    onProgress: (done, total, path) => {
      options.onProgress?.({
        step: '读取压缩包',
        detail: path,
        done,
        total,
      })
    },
  })
  const roots = new Set(
    entries
      .map((entry) => normalizePath(entry.path).split('/')[0])
      .filter(Boolean),
  )
  const allNested = entries.every((entry) => normalizePath(entry.path).includes('/'))
  const rootLabel = allNested && roots.size === 1 ? [...roots][0] : ''
  return {
    label: fallbackPackageName(rootLabel || file.name),
    source: 'zip',
    files: entries.map((entry) => ({
      path: normalizePath(entry.path),
      name: entry.name,
      blob: entry.blob,
    })),
  }
}

function readFileEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject)
  })
}

function readDirectoryEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    reader.readEntries(resolve, reject)
  })
}

async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  result: LayerSourceFile[],
  signal: AbortSignal | undefined,
): Promise<void> {
  abortIfNeeded(signal)
  const path = prefix ? `${prefix}/${entry.name}` : entry.name
  if (entry.isFile) {
    const file = await readFileEntry(entry as FileSystemFileEntry)
    result.push({ path: normalizePath(path), name: file.name, blob: file })
    return
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    for (;;) {
      const entries = await readDirectoryEntries(reader)
      if (entries.length === 0) break
      for (const child of entries) {
        await walkEntry(child, path, result, signal)
      }
    }
  }
}

export async function bundleFromDrop(
  transfer: DataTransfer,
  options: Pick<AnalyzeOptions, 'signal' | 'onProgress'> = {},
): Promise<LayerSourceBundle | undefined> {
  const items = Array.from(transfer.items ?? [])
  const entries = items
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => Boolean(entry))
  if (entries.length > 0) {
    const files: LayerSourceFile[] = []
    for (const entry of entries) {
      await walkEntry(entry, '', files, options.signal)
    }
    if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
      return zipToBundle(files[0].blob as File, options)
    }
    const root = entries.length === 1 ? entries[0].name : ''
    return {
      label: root || fallbackPackageName(files[0]?.name ?? '拖入的地图包'),
      source: 'folder',
      files,
    }
  }
  const files = Array.from(transfer.files ?? [])
  if (files.length === 0) return undefined
  if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
    return zipToBundle(files[0], options)
  }
  return filesToBundle(files)
}

function readManifest(bundle: LayerSourceBundle): ManifestResult {
  const candidates = bundle.files
    .filter((file) => file.name.toLowerCase() === 'manifest.json')
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length)
  const file = candidates[0]
  if (!file) return { baseDir: '' }
  const baseDir = dirOfPath(file.path)
  return {
    // Parse is done by the caller because Blob.text() is async.
    baseDir,
    path: file.path,
  }
}

async function parseManifest(bundle: LayerSourceBundle): Promise<ManifestResult> {
  const result = readManifest(bundle)
  if (!result.path) return result
  const file = bundle.files.find((item) => item.path === result.path)
  if (!file) return result
  try {
    const raw = JSON.parse(await file.blob.text()) as Record<string, unknown>
    const manifest: Manifest = {}
    if (typeof raw.name === 'string') manifest.name = raw.name.trim()
    if (raw.source === 'fandom' || raw.source === 'mapgenie' || raw.source === 'manual') {
      manifest.source = raw.source
    }
    if (typeof raw.data === 'string') manifest.data = raw.data
    if (typeof raw.image === 'string') manifest.image = raw.image
    if (typeof raw.tiles === 'string') manifest.tiles = raw.tiles
    if (typeof raw.tilePattern === 'string') manifest.tilePattern = raw.tilePattern
    if (typeof raw.tileUrl === 'string') manifest.tileUrl = raw.tileUrl
    if (typeof raw.tileSet === 'number') manifest.tileSet = raw.tileSet
    if (typeof raw.wiki === 'string') manifest.wiki = raw.wiki
    if (typeof raw.sourceUrl === 'string') manifest.sourceUrl = raw.sourceUrl
    if (typeof raw.sourceLabel === 'string') manifest.sourceLabel = raw.sourceLabel.trim()
    return { ...result, manifest }
  } catch (error) {
    return {
      ...result,
      error: `manifest.json 读取失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function cleanPackageName(value: string): string {
  let result = value
    .replace(/\.(zip|json)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  result = result.replace(/^(fandom|mapgenie|tavernmap|tavern map|sample)\s+/i, '')
  result = result.replace(/\s+(sample|export|snapshot)$/i, '')
  if (/^[a-z0-9\s]+$/i.test(result)) {
    result = result.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
  }
  return result || '本地地图包'
}

function isGenericPackageLabel(value: string): boolean {
  return /^(map|mapdata|map data|data|tiles|images?|map image|package|地图|地图包|本地地图包)$/i.test(
    value.trim(),
  )
}

function imagePackageName(choice: LayerImageChoice, folderLabel: string): string {
  const fileStem = choice.name.replace(/\.[^.]+$/, '')
  const cleanFolder = isGenericPackageLabel(folderLabel) ? '' : folderLabel
  if (/^(map[-_ ]?image|image|map|底图)$/i.test(fileStem)) {
    return cleanFolder || '本地底图'
  }
  return cleanPackageName(fileStem)
}

function absoluteFandomHost(value: string | undefined): string | undefined {
  const raw = value?.trim()
  if (!raw || !/^https?:\/\//i.test(raw)) return undefined
  try {
    const url = new URL(raw)
    return url.hostname.toLowerCase().endsWith('.fandom.com') ? url.hostname.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

function resolveWikiBase(
  bundle: LayerSourceBundle,
  manifest: Manifest | undefined,
  raw: Record<string, unknown>,
): string {
  if (manifest?.wiki) return normalizeWikiBase(manifest.wiki)
  const fromSourceUrl = absoluteFandomHost(manifest?.sourceUrl)
  if (fromSourceUrl) return fromSourceUrl
  for (const item of Array.isArray(raw.markers) ? raw.markers : []) {
    const marker = item && typeof item === 'object' ? (item as Record<string, unknown>) : undefined
    const popup = marker?.popup && typeof marker.popup === 'object'
      ? (marker.popup as Record<string, unknown>)
      : undefined
    const link = popup?.link && typeof popup.link === 'object'
      ? (popup.link as Record<string, unknown>)
      : undefined
    const host = absoluteFandomHost(typeof link?.url === 'string' ? link.url : undefined)
    if (host) return host
  }
  const haystack = [
    bundle.label,
    typeof raw.mapImage === 'string' ? raw.mapImage : '',
    typeof raw.description === 'string' ? raw.description : '',
  ]
    .join(' ')
    .toLowerCase()
  if (/waterdeep|forgotten realms|forgottenrealms|toril|dungeons?\s*&?\s*dragons?|d&d/.test(haystack)) {
    return 'forgottenrealms.fandom.com'
  }
  if (/cyberpunk|night city/.test(haystack)) return 'cyberpunk.fandom.com'
  return DEFAULT_WIKI_BASE
}

async function probeImageFiles(
  files: LayerSourceFile[],
  options: AnalyzeOptions,
): Promise<{ choices: LayerImageChoice[]; warnings: string[] }> {
  const choices: LayerImageChoice[] = []
  const warnings: string[] = []
  let done = 0
  for (const file of files) {
    abortIfNeeded(options.signal)
    done += 1
    options.onProgress?.({
      step: '读取图片',
      detail: file.name,
      done,
      total: files.length,
    })
    try {
      const info = await readLayerImage(file.blob, file.name)
      choices.push({
        path: file.path,
        name: file.name,
        blob: file.blob,
        width: info.width,
        height: info.height,
        bytes: info.bytes,
        placeholder: info.placeholder,
        source: 'package',
        matched: 'none',
      })
    } catch (error) {
      warnings.push(
        `${file.name} 无法读取：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return { choices, warnings }
}

function chooseBestImage(
  choices: LayerImageChoice[],
  mapImage: string,
  manifestImage: string | undefined,
): { choice?: LayerImageChoice; warning?: string } {
  if (choices.length === 0) return {}
  const wanted = normalizeImageName(mapImage)
  const wantedStem = wanted.replace(/\.[^.]+$/, '')
  for (const choice of choices) {
    if (
      manifestImage &&
      (choice.path === normalizePath(manifestImage) ||
        choice.path.endsWith(`/${normalizePath(manifestImage)}`))
    ) {
      choice.matched = 'manifest'
    }
    else if (wanted && normalizeImageName(choice.name) === wanted) choice.matched = 'mapImage'
    else if (wantedStem && normalizeImageName(choice.name).includes(wantedStem)) {
      choice.matched = 'fuzzy'
    }
  }
  if (choices.length === 1 && choices[0].matched === 'none') choices[0].matched = 'only'
  const score = (choice: LayerImageChoice): number => {
    const matched =
      choice.matched === 'manifest'
        ? 0
        : choice.matched === 'mapImage'
          ? 1
          : choice.matched === 'fuzzy'
            ? 2
            : choice.matched === 'only'
              ? 3
              : 6
    return matched + (choice.placeholder ? 10 : 0)
  }
  choices.sort((a, b) => {
    const byScore = score(a) - score(b)
    if (byScore !== 0) return byScore
    return b.width * b.height - a.width * a.height
  })
  const best = choices[0]
  if (best.matched === 'none') best.matched = 'fuzzy'
  if (
    !mapImage &&
    choices.length > 1 &&
    choices.some((choice) => choice.matched === 'mapImage' || choice.matched === 'manifest')
  ) {
    return { choice: best }
  }
  if (wanted && best.matched === 'fuzzy' && !normalizeImageName(best.name).includes(wantedStem)) {
    return {
      choice: best,
      warning: `没有找到 mapImage 指定的「${mapImage}」，已选择包内最接近的图片「${best.name}」。`,
    }
  }
  return { choice: best }
}

type TileParts = {
  z: number
  u: number
  v: number
}

function tileParts(path: string): TileParts | undefined {
  const normalized = normalizePath(path)
  const segments = normalized.split('/')
  const fileName = segments.pop() ?? ''
  const extension = fileName.split('.').pop()?.toLowerCase() ?? ''
  if (!IMAGE_FILE_EXTENSIONS.has(extension)) return undefined
  const stem = fileName.slice(0, Math.max(0, fileName.length - extension.length - 1))
  if (!/^\d+$/.test(stem)) return undefined
  const numeric = [...segments.filter((segment) => /^\d+$/.test(segment)), stem]
  if (numeric.length < 3) return undefined
  const last = numeric.slice(-3).map(Number)
  if (!last.every((value) => Number.isInteger(value) && value >= 0)) return undefined
  return { z: last[0], u: last[1], v: last[2] }
}

export function isTileImagePath(path: string): boolean {
  return Boolean(tileParts(path))
}

function detectTileOrder(
  parts: TileParts[],
  tileSet: MapGenieTileSetInfo,
): LayerTileOrder {
  if (tileSet.order !== 'unknown') return tileSet.order
  let zyx = 0
  let zxy = 0
  for (const item of parts) {
    const bounds = tileSet.boundsByZoom[String(item.z)]
    if (!bounds) continue
    if (
      item.u >= bounds.xMin &&
      item.u <= bounds.xMax &&
      item.v >= bounds.yMin &&
      item.v <= bounds.yMax
    ) {
      zxy += 1
    }
    if (
      item.v >= bounds.xMin &&
      item.v <= bounds.xMax &&
      item.u >= bounds.yMin &&
      item.u <= bounds.yMax
    ) {
      zyx += 1
    }
  }
  if (zyx === 0 && zxy === 0) return 'zyx'
  return zyx >= zxy ? 'zyx' : 'zxy'
}

function tileStatsFor(
  parts: TileParts[],
  tileSet: MapGenieTileSetInfo,
): { expected: number; missing: number; hasBounds: boolean } {
  const actualByZoom = new Map<number, number>()
  for (const item of parts) {
    actualByZoom.set(item.z, (actualByZoom.get(item.z) ?? 0) + 1)
  }
  let expected = 0
  let missing = 0
  let hasBounds = false
  for (const [zoom, actual] of actualByZoom) {
    const bounds = tileSet.boundsByZoom[String(zoom)]
    if (!bounds) {
      expected += actual
      continue
    }
    hasBounds = true
    const expectedAtZoom =
      Math.max(0, bounds.xMax - bounds.xMin + 1) * Math.max(0, bounds.yMax - bounds.yMin + 1)
    expected += expectedAtZoom
    missing += Math.max(0, expectedAtZoom - actual)
  }
  return { expected, missing, hasBounds }
}

function tileFileKey(z: number, u: number, v: number, order: LayerTileOrder): string {
  if (order === 'zxy') return `${z}/${v}/${u}`
  return `${z}/${u}/${v}`
}

export type LayerTileScan = {
  tileFiles?: Record<string, Blob>
  order: LayerTileOrder
  stats?: LayerTileStats
  warnings: string[]
}

export function scanTileFiles(
  files: LayerSourceFile[],
  tileSet: MapGenieTileSetInfo,
  setCount = 1,
): LayerTileScan {
  const warnings: string[] = []
  const candidates = files
    .filter(isImageFile)
    .flatMap((file) => {
      const parts = tileParts(file.path)
      return parts ? [{ file, parts }] : []
    })
  if (candidates.length === 0) {
    return {
      order: tileSet.order,
      warnings: ['没有找到 z/x/y 结构的瓦片图片；地点和区域仍可导入。'],
    }
  }
  const order = detectTileOrder(candidates.map((item) => item.parts), tileSet)
  const tileFiles: Record<string, Blob> = {}
  const acceptedParts: TileParts[] = []
  const preferredPrefix = tileSet.prefix.replace(/\/+$/, '')
  const preferred = preferredPrefix
    ? candidates.filter((item) => normalizePath(item.file.path).includes(preferredPrefix))
    : []
  const selected = preferred.length > 0 ? preferred : candidates
  for (const item of selected) {
    tileFiles[tileFileKey(item.parts.z, item.parts.u, item.parts.v, order)] = item.file.blob
    acceptedParts.push(item.parts)
  }
  const stats = tileStatsFor(acceptedParts, tileSet)
  const zoomValues = acceptedParts.map((item) => item.z)
  const minZoom = zoomValues.length ? Math.min(...zoomValues) : undefined
  const maxZoom = zoomValues.length ? Math.max(...zoomValues) : undefined
  if (stats.missing > 0) {
    warnings.push(
      `已覆盖的缩放层级内缺 ${stats.missing.toLocaleString('zh-CN')} 张瓦片，缺块会显示占位。`,
    )
  }
  if (tileSet.order === 'unknown') {
    warnings.push(
      stats.hasBounds
        ? `pattern 没有写明 {z}/{x}/{y} 或 {z}/{y}/{x}，已按 bounds 推断为 ${order === 'zxy' ? '{z}/{x}/{y}' : '{z}/{y}/{x}'}。`
        : `pattern 没有写明瓦片顺序，已按 Map Genie 常见的 {z}/{y}/{x} 读取。`,
    )
  }
  return {
    tileFiles,
    order,
    stats: {
      count: acceptedParts.length,
      expected: stats.expected,
      missing: stats.missing,
      minZoom,
      maxZoom,
      order,
      hasBounds: stats.hasBounds,
      setName: tileSet.name,
      setCount,
    },
    warnings,
  }
}

function scanTiles(
  bundle: LayerSourceBundle,
  tileSets: MapGenieTileSetInfo[],
  manifest: Manifest | undefined,
): {
  tileFiles?: Record<string, Blob>
  tileSet?: MapGenieTileSetInfo
  order: LayerTileOrder
  stats?: LayerTileStats
  warnings: string[]
} {
  if (tileSets.length === 0) {
    return { order: 'unknown', warnings: ['mapData 里没有 tile_sets，无法读取瓦片顺序。'] }
  }
  let tileSetIndex = manifest?.tileSet ?? 0
  if (tileSetIndex < 0 || tileSetIndex >= tileSets.length) tileSetIndex = 0
  if (manifest?.tileSet == null) {
    let bestIndex = 0
    let bestCount = -1
    for (const tileSet of tileSets) {
      const prefix = tileSet.prefix.replace(/\/+$/, '')
      const count = prefix
        ? bundle.files.filter(
            (file) =>
              isImageFile(file) &&
              normalizePath(file.path).includes(prefix),
          ).length
        : 0
      if (count > bestCount) {
        bestCount = count
        bestIndex = tileSet.index
      }
    }
    if (bestCount > 0) tileSetIndex = bestIndex
  }
  const tileSet = tileSets[tileSetIndex] ?? tileSets[0]
  return {
    ...scanTileFiles(bundle.files, tileSet, tileSets.length),
    tileSet,
  }
}

function buildStats(
  pkg: LayerMapPackage,
  tileStats: LayerTileStats | undefined,
  choice: LayerImageChoice | undefined,
): LayerImportStats {
  const linkCount = pkg.markers.reduce(
    (total, marker) => total + (marker.sourceLinks?.length ?? 0),
    0,
  )
  const linkMarkerCount = pkg.markers.reduce(
    (total, marker) => total + (marker.sourceLinks?.length ? 1 : 0),
    0,
  )
  const descriptionCount = pkg.markers.reduce(
    (total, marker) => total + (marker.description ? 1 : 0),
    0,
  )
  const imageBytes = pkg.image?.size ?? 0
  const tileBytes = Object.values(pkg.tileFiles ?? {}).reduce(
    (total, blob) => total + blob.size,
    0,
  )
  return {
    markerCount: pkg.markers.length,
    regionCount: pkg.regions.length,
    streetCount: pkg.streets?.length ?? 0,
    categoryCount: pkg.categories.length,
    groupCount: pkg.groups.length,
    descriptionCount,
    linkCount,
    linkMarkerCount,
    width: pkg.width,
    height: pkg.height,
    image: choice
      ? {
          name: choice.name,
          width: choice.width,
          height: choice.height,
          bytes: choice.bytes,
          source: choice.source,
          placeholder: choice.placeholder,
          match: choice.matched,
        }
      : undefined,
    tiles: tileStats,
    sizeBytes:
      (pkg.dataBytes ?? 0) +
      imageBytes +
      tileBytes +
      (pkg.thumbnail?.size ?? 0),
    fileCount:
      ((pkg.dataBytes ?? 0) > 0 ? 1 : 0) +
      (pkg.image ? 1 : 0) +
      Object.keys(pkg.tileFiles ?? {}).length,
  }
}

function backupTileStats(pkg: LayerMapPackage): LayerTileStats | undefined {
  const keys = Object.keys(pkg.tileFiles ?? {})
  if (pkg.kind !== 'tiles' || keys.length === 0) return undefined
  const zooms = keys.map((key) => Number(key.split('/')[0])).filter(Number.isFinite)
  return {
    count: keys.length,
    expected: pkg.tile?.expectedCount ?? keys.length,
    missing: pkg.tile?.missingCount ?? 0,
    minZoom: zooms.length ? Math.min(...zooms) : undefined,
    maxZoom: zooms.length ? Math.max(...zooms) : undefined,
    order: pkg.tile?.order ?? 'zyx',
    hasBounds: Boolean(pkg.tile?.boundsByZoom),
    setName: pkg.tile?.setName ?? '',
    setCount: pkg.tile?.setCount ?? 1,
  }
}

/** A backup is the stored package itself: no re-parsing, no image matching. */
function backupPreview(
  bundle: LayerSourceBundle,
  backup: BackupContents,
  options: AnalyzeOptions,
): LayerImportPreview {
  const pkg = backup.pkg
  if (options.name?.trim()) pkg.name = options.name.trim()
  const exported = new Date(backup.manifest.exportedAt)
  return {
    pkg,
    stats: buildStats(pkg, backupTileStats(pkg), undefined),
    notices: [
      {
        tone: 'info',
        text: `Tavern Map 备份包${Number.isNaN(exported.getTime()) ? '' : `，${exported.toLocaleString('zh-CN')} 导出`}。地图内容按导出时原样恢复。`,
      },
    ],
    sourceLabel: 'Tavern Map 备份包',
    sourceUrl: pkg.sourceUrl,
    imageChoices: [],
    dataPath: backup.manifest.data,
    dataCandidates: [],
    bundle,
    canAttachData: false,
    backup: { ...backup, counts: countBackupParts(backup.personal) },
  }
}

async function applyChoice(
  preview: LayerImportPreview,
  choice: LayerImageChoice,
  source: LayerImageSource,
): Promise<LayerImportPreview> {
  const pkg = preview.pkg
  pkg.image = choice.blob
  pkg.imageType = choice.blob.type || 'image/jpeg'
  pkg.imageName = choice.name
  pkg.imageWidth = choice.width
  pkg.imageHeight = choice.height
  pkg.imageBytes = choice.bytes
  pkg.imageSource = source
  if (source === 'local') pkg.imagePageUrl = undefined
  pkg.imageFit = 'stretch'
  pkg.imageRect = undefined
  pkg.imageLocked = source === 'local' || choice.path !== preview.autoImagePath
  pkg.thumbnail = await makeLayerThumbnail(choice.blob)
  if (pkg.source === 'manual' && pkg.markers.length === 0) {
    pkg.width = choice.width
    pkg.height = choice.height
  }
  preview.selectedImagePath = choice.path
  preview.stats = buildStats(pkg, preview.stats.tiles, choice)
  preview.notices = preview.notices.filter((notice) => !IMAGE_NOTICE_PATTERN.test(notice.text))
  preview.notices.push(
    ...imageNotices(pkg, choice, preview.imageChoices, preview.targetImageName),
  )
  return preview
}

export async function selectPreviewImage(
  preview: LayerImportPreview,
  path: string,
): Promise<LayerImportPreview> {
  const choice = preview.imageChoices.find((item) => item.path === path)
  if (!choice) return preview
  return applyChoice(preview, choice, choice.source === 'local' ? 'local' : choice.source)
}

export async function useLocalImage(
  preview: LayerImportPreview,
  file: File,
): Promise<LayerImportPreview> {
  const info = await readLayerImage(file, file.name)
  const choice: LayerImageChoice = {
    path: `local:${file.name}:${file.size}:${file.lastModified}`,
    name: file.name,
    blob: file,
    width: info.width,
    height: info.height,
    bytes: info.bytes,
    placeholder: info.placeholder,
    source: 'local',
    matched: 'local',
  }
  preview.imageChoices = [
    choice,
    ...preview.imageChoices.filter((item) => item.source !== 'local'),
  ]
  return applyChoice(preview, choice, 'local')
}

export function removePreviewImage(preview: LayerImportPreview): LayerImportPreview {
  const pkg = preview.pkg
  pkg.image = undefined
  pkg.imageType = undefined
  pkg.imageName = undefined
  pkg.imagePageUrl = undefined
  pkg.imageWidth = undefined
  pkg.imageHeight = undefined
  pkg.imageBytes = undefined
  pkg.imageSource = 'none'
  pkg.imageFit = undefined
  pkg.imageRect = undefined
  pkg.imageLocked = true
  pkg.thumbnail = undefined
  preview.selectedImagePath = undefined
  preview.stats = buildStats(pkg, preview.stats.tiles, undefined)
  preview.notices = preview.notices.filter((notice) => !IMAGE_NOTICE_PATTERN.test(notice.text))
  if (pkg.kind === 'image') {
    preview.notices.push({
      tone: 'info',
      text: '已移除底图。先导入点位后，可以在地图顶栏的“底图”里随时补回来。',
    })
  }
  return preview
}

function createImageOnlyPackage(choice: LayerImageChoice, name: string): LayerMapPackage {
  const now = Date.now()
  return {
    id: `manual-${now.toString(36)}`,
    name,
    kind: 'image',
    source: 'manual',
    sourceKey: `manual:${choice.name}:${choice.width}x${choice.height}`,
    width: choice.width,
    height: choice.height,
    image: choice.blob,
    imageType: choice.blob.type || 'image/jpeg',
    imageName: choice.name,
    imageWidth: choice.width,
    imageHeight: choice.height,
    imageBytes: choice.bytes,
    imageSource: choice.source,
    imageFit: 'stretch',
    imageLocked: true,
    thumbnail: undefined,
    categories: [],
    groups: [],
    markers: [],
    regions: [],
    dataBytes: 0,
    attribution: '本地图片 / 无地点数据',
    createdAt: now,
    updatedAt: now,
  }
}

const IMAGE_NOTICE_PATTERN =
  /没有可用底图|底图下载|占位图|没有找到 mapImage|没有文件名完全匹配|包内有 \d+ 张图片|包内只有这一张|图片比例|图片比画布|图片服务器|JSON 已读取|已匹配 mapImage|当前使用|图片比画布小/

function imageNotices(
  pkg: LayerMapPackage,
  choice: LayerImageChoice | undefined,
  choices: LayerImageChoice[],
  targetImageName: string | undefined,
): LayerImportNotice[] {
  const notices: LayerImportNotice[] = []
  if (!choice) {
    notices.push({
      tone: 'warning',
      text: '包内没有可用底图。可以先导入点位，之后在地图顶栏的“底图”里补图。',
    })
    return notices
  }
  if (choice.placeholder) {
    notices.push({
      tone: 'warning',
      text: '这张图看起来是占位图，不是原始地图。可以先用它验证点位，建议换成本地原图。',
    })
  }
  if (targetImageName) {
    const matched =
      choice.matched === 'mapImage' ||
      choice.matched === 'manifest' ||
      choice.matched === 'downloaded'
    if (matched) {
      notices.push({
        tone: 'info',
        text: `已匹配 mapImage 指定的底图「${targetImageName}」。`,
      })
    } else if (choices.length === 1) {
      notices.push({
        tone: 'info',
        text: `包内只有这一张图片，文件名与 mapImage「${targetImageName}」不一致，已自动使用它。`,
      })
    } else {
      notices.push({
        tone: 'info',
        text: `没有文件名完全匹配 mapImage「${targetImageName}」；当前使用「${choice.name}」。`,
      })
    }
  }
  if (choices.length > 1) {
    notices.push({
      tone: 'info',
      text: `可选图片有 ${choices.length} 张，当前使用「${choice.name}」。可以在预览里换图。`,
    })
  }
  const aspect = imageAspectNote(pkg)
  if (aspect) {
    notices.push({
      tone: 'info',
      text: `${aspect}，默认铺满画布；地点对不上时可在导入后使用“对齐底图”。`,
    })
  }
  const resolution = imageResolutionNote(pkg)
  if (resolution) notices.push({ tone: 'info', text: resolution })
  return notices
}

function noticeForImage(
  notices: LayerImportNotice[],
  pkg: LayerMapPackage,
  choice: LayerImageChoice | undefined,
  mapImage: string,
  choices: LayerImageChoice[],
): void {
  notices.push(...imageNotices(pkg, choice, choices, mapImage || undefined))
}

async function analyzeFandom(
  bundle: LayerSourceBundle,
  raw: Record<string, unknown>,
  dataPath: string,
  manifestResult: ManifestResult,
  options: AnalyzeOptions,
): Promise<LayerImportPreview> {
  const manifest = manifestResult.manifest
  const notices: LayerImportNotice[] = []
  if (manifestResult.error) notices.push({ tone: 'info', text: manifestResult.error })
  const wikiBase = options.wikiBase
    ? normalizeWikiBase(options.wikiBase)
    : resolveWikiBase(bundle, manifest, raw)
  const mapImage = typeof raw.mapImage === 'string'
    ? raw.mapImage.trim().replace(/^File:/i, '').trim()
    : ''
  const imageFiles = bundle.files.filter(isImageFile)
  const probed = await probeImageFiles(imageFiles, options)
  for (const warning of probed.warnings) notices.push({ tone: 'warning', text: warning })
  const chosen = chooseBestImage(probed.choices, mapImage, manifest?.image)
  const choice = chosen.choice
  const folderName = cleanPackageName(bundle.label)
  const mapImageName = mapImage
    ? cleanPackageName(mapImage.replace(/\.[^.]+$/, ''))
    : ''
  const name =
    options.name?.trim() ||
    manifest?.name ||
    (isGenericPackageLabel(bundle.label) && mapImageName ? mapImageName : folderName)
  const sourceUrl =
    manifest?.sourceUrl ||
    (mapImage
      ? wikiPageUrl(wikiBase, `File:${mapImage}`)
      : undefined)
  const pkg = parseFandomPackage(raw, {
    name,
    wikiBase,
    sourceUrl,
    image: choice?.blob,
    imageType: choice?.blob.type,
    imageName: choice?.name,
    imagePageUrl: mapImage ? wikiPageUrl(wikiBase, `File:${mapImage}`) : undefined,
    imageWidth: choice?.width,
    imageHeight: choice?.height,
    imageSource: choice ? 'package' : 'none',
  })
  if (choice) {
    pkg.thumbnail = await makeLayerThumbnail(choice.blob)
  }
  if (mapImage && wikiBase) {
    pkg.attribution = `${wikiBase} / 本地导入`
  }
  const autoImagePath = choice?.path
  const stats = buildStats(pkg, undefined, choice)
  noticeForImage(notices, pkg, choice, mapImage, probed.choices)
  return {
    pkg,
    stats,
    notices,
    sourceLabel: 'Fandom 图片地图',
    sourceUrl,
    imagePageUrl: pkg.imagePageUrl,
    imageChoices: probed.choices,
    targetImageName: mapImage || undefined,
    selectedImagePath: choice?.path,
    autoImagePath,
    dataPath,
    dataCandidates: [],
    bundle,
    canAttachData: true,
  }
}

async function analyzeMapGenie(
  bundle: LayerSourceBundle,
  raw: Record<string, unknown>,
  dataPath: string,
  manifestResult: ManifestResult,
  options: AnalyzeOptions,
): Promise<LayerImportPreview> {
  const manifest = manifestResult.manifest
  const notices: LayerImportNotice[] = []
  if (manifestResult.error) notices.push({ tone: 'info', text: manifestResult.error })
  const info = mapGenieMapInfo(raw)
  const scanned = scanTiles(bundle, info.tileSets, {
    ...manifest,
    tileSet: options.tileSetIndex ?? manifest?.tileSet,
  })
  const hasRemoteTileTemplate = Boolean(
    options.tileUrl?.trim() || manifest?.tileUrl?.trim() || scanned.tileSet?.pattern,
  )
  for (const warning of scanned.warnings) {
    if (hasRemoteTileTemplate && warning.startsWith('没有找到 z/x/y')) continue
    notices.push({ tone: 'warning', text: warning })
  }
  if (scanned.tileSet && info.tileSets.length > 1) {
    notices.push({
      tone: 'info',
      text: `找到 ${info.tileSets.length} 个瓦片组，已使用「${scanned.tileSet.name}」。`,
    })
  }
  const name = options.name?.trim() || manifest?.name || cleanPackageName(info.title || bundle.label)
  const pkg = parseMapGeniePackage(raw, {
    name,
    tileTemplate: options.tileUrl?.trim() || manifest?.tileUrl || '',
    tileSetIndex: scanned.tileSet?.index,
    tileFiles: scanned.tileFiles,
    tileOrder: scanned.order,
    tilePattern: scanned.tileSet?.pattern || manifest?.tilePattern,
    tileStats: scanned.stats
      ? { expected: scanned.stats.expected, missing: scanned.stats.missing }
      : undefined,
    sourceUrl: manifest?.sourceUrl,
    sourceLabel: manifest?.sourceLabel,
  })
  pkg.dataBytes = pkg.dataBytes ?? 0
  const stats = buildStats(pkg, scanned.stats, undefined)
  if (
    (!scanned.tileFiles || Object.keys(scanned.tileFiles).length === 0) &&
    !pkg.tile?.template
  ) {
    notices.push({
      tone: 'warning',
      text: '没有找到本地瓦片。地点、区域和说明仍可导入，之后可以在“底图”里补瓦片。',
    })
  }
  return {
    pkg,
    stats,
    notices,
    sourceLabel: manifest?.sourceLabel || 'Map Genie 瓦片地图',
    sourceUrl: manifest?.sourceUrl,
    imageChoices: [],
    dataPath,
    dataCandidates: [],
    bundle,
    canAttachData: false,
  }
}

function dataCandidateLabel(path: string, kind: 'fandom' | 'mapgenie'): string {
  return `${kind === 'fandom' ? 'Fandom' : 'Map Genie'} · ${nameOfPath(path)}`
}

export async function analyzeBundle(
  bundle: LayerSourceBundle,
  options: AnalyzeOptions = {},
): Promise<LayerImportPreview> {
  abortIfNeeded(options.signal)
  const backup = await readBackupBundle(bundle.files)
  if (backup) return backupPreview(bundle, backup, options)
  const manifestResult = await parseManifest(bundle)
  const manifest = manifestResult.manifest
  const jsonFiles = bundle.files
    .filter(isJsonFile)
    .filter((file) => file.name.toLowerCase() !== 'manifest.json')
    .sort((a, b) => {
      const priority = (file: LayerSourceFile): number => {
        const name = file.name.toLowerCase()
        if (name === 'map.json' || name === 'mapdata.json') return 0
        if (name.includes('mapdata')) return 1
        if (name.includes('map')) return 2
        return 3
      }
      return priority(a) - priority(b) || a.path.localeCompare(b.path)
    })
  const candidates: Array<{ file: LayerSourceFile; raw: Record<string, unknown>; kind: 'fandom' | 'mapgenie' }> = []
  const invalid: string[] = []
  for (const file of jsonFiles) {
    abortIfNeeded(options.signal)
    options.onProgress?.({ step: '读取 JSON', detail: file.path })
    try {
      const text = await file.blob.text()
      const raw = JSON.parse(text) as unknown
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        invalid.push(`${file.path}：JSON 顶层不是对象`)
        continue
      }
      const kind = detectPackageJsonKind(raw)
      if (kind === 'unknown') {
        invalid.push(`${file.path}：既不像 Fandom markers，也不像 Map Genie locations`)
        continue
      }
      candidates.push({ file, raw: raw as Record<string, unknown>, kind })
    } catch (error) {
      invalid.push(`${file.path}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const manifestData = manifest?.data
    ? candidates.find((candidate) => matchesPath(candidate.file, joinPath(manifestResult.baseDir, manifest.data!)))
    : undefined
  const selected =
    (options.dataPath
      ? candidates.find((candidate) => candidate.file.path === options.dataPath)
      : undefined) ||
    manifestData ||
    candidates[0]
  const dataCandidates: LayerDataCandidate[] = candidates.map((candidate) => ({
    path: candidate.file.path,
    kind: candidate.kind,
    label: dataCandidateLabel(candidate.file.path, candidate.kind),
  }))
  if (!selected) {
    const imageFiles = bundle.files.filter(isImageFile)
    const standaloneImages = imageFiles.filter((file) => !tileParts(file.path))
    if (imageFiles.length > 0 && standaloneImages.length === 0) {
      throw new Error(
        '只找到瓦片图片，没有 mapData JSON。请选择包含 mapdata.json 的整个地图包，或同时选择 mapData JSON 和瓦片文件夹。',
      )
    }
    if (standaloneImages.length > 0) {
      const probed = await probeImageFiles(standaloneImages, options)
      const chosen = chooseBestImage(probed.choices, '', manifest?.image)
      const choice = chosen.choice
      if (!choice) {
        throw new Error(invalid[0] || '没有找到可用的 JSON 或图片')
      }
      if (bundle.source === 'files' && bundle.files.length === 1) {
        choice.source = 'local'
        choice.matched = 'local'
      }
      const name =
        options.name?.trim() ||
        manifest?.name ||
        imagePackageName(choice, cleanPackageName(bundle.label))
      const pkg = createImageOnlyPackage(choice, name)
      pkg.thumbnail = await makeLayerThumbnail(choice.blob)
      const notices: LayerImportNotice[] = [
        {
          tone: 'info',
          text: '只识别到底图，没有地点数据。可以先导入底图，之后关联 Fandom JSON。',
        },
      ]
      if (invalid.length > 0) {
        notices.push({
          tone: 'warning',
          text: `包内的 JSON 没有用于导入：${invalid[0]}`,
        })
      }
      if (choice.placeholder) {
        notices.push({
          tone: 'warning',
          text: '这张图看起来是占位图，不是原始地图。',
        })
      }
      return {
        pkg,
        stats: buildStats(pkg, undefined, choice),
        notices,
        sourceLabel: '图片底图（无地点数据）',
        sourceUrl: manifest?.sourceUrl,
        imageChoices: probed.choices,
        selectedImagePath: choice.path,
        autoImagePath: choice.path,
        dataPath: '',
        dataCandidates: [],
        bundle,
        canAttachData: true,
      }
    }
    throw new Error(
      invalid[0] ||
        '没有找到可识别的 map.json / mapdata.json，也没有图片。请选择完整的 Fandom 或 Map Genie 地图包。',
    )
  }
  if (selected.kind === 'fandom') {
    const preview = await analyzeFandom(
      bundle,
      selected.raw,
      selected.file.path,
      manifestResult,
      options,
    )
    preview.dataCandidates = dataCandidates
    if (dataCandidates.length > 1) {
      preview.notices.push({
        tone: 'info',
        text: `包内有 ${dataCandidates.length} 个地图 JSON，已使用 ${nameOfPath(selected.file.path)}。`,
      })
    }
    if (invalid.length > 0) {
      preview.notices.push({
        tone: 'warning',
        text: `另外 ${invalid.length} 个 JSON 没有用于导入：${invalid[0]}`,
      })
    }
    return preview
  }
  const preview = await analyzeMapGenie(
    bundle,
    selected.raw,
    selected.file.path,
    manifestResult,
    options,
  )
  preview.dataCandidates = dataCandidates
  if (dataCandidates.length > 1) {
    preview.notices.push({
      tone: 'info',
      text: `包内有 ${dataCandidates.length} 个地图 JSON，已使用 ${nameOfPath(selected.file.path)}。`,
    })
  }
  if (invalid.length > 0) {
    preview.notices.push({
      tone: 'warning',
      text: `另外 ${invalid.length} 个 JSON 没有用于导入：${invalid[0]}`,
    })
  }
  return preview
}

function imageDownloadReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/Failed to fetch|NetworkError|Load failed|fetch failed/i.test(message)) {
    return '图片服务器拒绝浏览器读取（可能是 Cloudflare / CORS 或网络拦截）'
  }
  if (/HTTP 403/.test(message)) return 'Fandom 图片服务器返回 403（Cloudflare 拒绝）'
  if (/HTTP 404/.test(message)) return 'Fandom 上没有找到这张图片'
  return message
}

function apiUrl(host: string, params: Record<string, string>): string {
  const url = new URL(`https://${host}/api.php`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  url.searchParams.set('format', 'json')
  url.searchParams.set('formatversion', '2')
  url.searchParams.set('origin', '*')
  return url.toString()
}

async function fetchJson<T>(
  url: string,
  signal: AbortSignal | undefined,
): Promise<T> {
  const response = await fetch(url, { signal, credentials: 'omit' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return (await response.json()) as T
}

async function fetchBlobWithProgress(
  url: string,
  signal: AbortSignal | undefined,
  onProgress: LayerProgressReporter | undefined,
): Promise<Blob> {
  const response = await fetch(url, { signal, credentials: 'omit' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType && !/^image\//i.test(contentType) && !contentType.includes('octet-stream')) {
    throw new Error(`服务器返回的不是图片（${contentType.split(';')[0]}）`)
  }
  const total = Number(response.headers.get('content-length') ?? 0) || undefined
  if (!response.body) {
    const blob = await response.blob()
    onProgress?.({ step: '下载底图', done: total, total })
    return blob
  }
  const reader = response.body.getReader()
  const chunks: ArrayBuffer[] = []
  let done = 0
  for (;;) {
    abortIfNeeded(signal)
    const { done: finished, value } = await reader.read()
    if (finished) break
    if (!value) continue
    const copy = new ArrayBuffer(value.byteLength)
    new Uint8Array(copy).set(value)
    chunks.push(copy)
    done += value.byteLength
    onProgress?.({ step: '下载底图', done, total })
  }
  const blob = new Blob(chunks, { type: contentType || 'image/jpeg' })
  return blob
}

function wikiPageUrl(host: string, title: string): string {
  const safe = title
    .replace(/\s+/g, '_')
    .replace(/%20/g, '_')
    .replace(/[^A-Za-z0-9_\-./:()'!~*]/g, (character) =>
      encodeURIComponent(character),
    )
  return `https://${host}/wiki/${safe}`
}

function pageTitleFromUrl(url: URL): string | undefined {
  const queryTitle = url.searchParams.get('title')
  if (queryTitle?.trim()) return queryTitle.trim().replace(/_/g, ' ')
  const match = url.pathname.match(/\/wiki\/(.+)$/)
  if (!match) return undefined
  try {
    return decodeURIComponent(match[1]).replace(/_/g, ' ')
  } catch {
    return match[1].replace(/_/g, ' ')
  }
}

type RevisionResponse = {
  error?: { info?: string }
  query?: {
    pages?: Array<{
      title?: string
      missing?: boolean
      invalid?: boolean
      revisions?: Array<{ slots?: { main?: { content?: string; contentmodel?: string } } }>
    }>
  }
}

type ParseResponse = {
  error?: { info?: string }
  parse?: { wikitext?: string; title?: string }
}

type ImageInfoResponse = {
  error?: { info?: string }
  query?: {
    pages?: Array<{
      title?: string
      missing?: boolean
      imageinfo?: Array<{ url?: string; width?: number; height?: number; descriptionurl?: string }>
    }>
  }
}

async function pageJson(
  host: string,
  title: string,
  signal: AbortSignal | undefined,
): Promise<{ title: string; raw: Record<string, unknown> } | undefined> {
  const revision = await fetchJson<RevisionResponse>(
    apiUrl(host, {
      action: 'query',
      prop: 'revisions',
      rvprop: 'content',
      rvslots: 'main',
      redirects: '1',
      titles: title,
    }),
    signal,
  ).catch(() => undefined)
  const page = revision?.query?.pages?.[0]
  const content = page?.revisions?.[0]?.slots?.main?.content
  if (content) {
    try {
      const raw = JSON.parse(content) as unknown
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return { title: page?.title || title, raw: raw as Record<string, unknown> }
      }
    } catch {
      // Not a JSON map page; let the parse API try.
    }
  }
  const parsed = await fetchJson<ParseResponse>(
    apiUrl(host, {
      action: 'parse',
      page: title,
      prop: 'wikitext',
      redirects: '1',
    }),
    signal,
  ).catch(() => undefined)
  const wikitext = parsed?.parse?.wikitext
  if (wikitext) {
    try {
      const raw = JSON.parse(wikitext) as unknown
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return { title: parsed?.parse?.title || title, raw: raw as Record<string, unknown> }
      }
    } catch {
      // Keep the original error below.
    }
  }
  return undefined
}

export async function fetchFandomMap(
  rawUrl: string,
  options: Pick<AnalyzeOptions, 'signal' | 'onProgress'> = {},
): Promise<LayerImportPreview> {
  let url: URL
  try {
    url = new URL(rawUrl.trim())
  } catch {
    throw new Error('请输入完整的 Fandom 地图页面 URL')
  }
  if (/mapgenie\.io$/i.test(url.hostname)) {
    throw new Error(
      'Map Genie 页面 URL 不能直接解析。请选择本地的 mapdata.json 或整个地图包。',
    )
  }
  if (!url.hostname.toLowerCase().endsWith('.fandom.com')) {
    throw new Error('目前只支持 Fandom Wiki 的 Map: 页面 URL')
  }
  const host = url.hostname.toLowerCase()
  const rawTitle = pageTitleFromUrl(url)
  if (!rawTitle) throw new Error('这个 URL 里没有地图页面标题')
  const titleCandidates = /^map:/i.test(rawTitle)
    ? [rawTitle]
    : [`Map:${rawTitle}`, rawTitle]
  let found: { title: string; raw: Record<string, unknown> } | undefined
  let lastError = ''
  for (const title of titleCandidates) {
    options.onProgress?.({ step: '读取 Fandom 页面', detail: title })
    try {
      found = await pageJson(host, title, options.signal)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    if (found) break
  }
  if (!found) {
    throw new Error(
      lastError ||
        `没有在这个 Wiki 上找到 Map 页面「${rawTitle}」。可以确认页面地址是否以 /wiki/Map: 开头。`,
    )
  }
  if (detectPackageJsonKind(found.raw) !== 'fandom') {
    throw new Error('这个页面是 Map 页面，但内容不是 Fandom 的 markers JSON。')
  }
  const mapImageRaw = typeof found.raw.mapImage === 'string' ? found.raw.mapImage.trim() : ''
  const mapImage = mapImageRaw.replace(/^File:/i, '').trim()
  const pageTitle = found.title.replace(/^Map:/i, '')
  const sourceUrl = wikiPageUrl(host, found.title)
  let choice: LayerImageChoice | undefined
  let imageDownloadError = ''
  const imagePageUrl = mapImage
    ? wikiPageUrl(host, `File:${mapImage}`)
    : undefined
  if (mapImage) {
    options.onProgress?.({ step: '读取 Fandom 图片信息', detail: mapImage })
    try {
      const info = await fetchJson<ImageInfoResponse>(
        apiUrl(host, {
          action: 'query',
          prop: 'imageinfo',
          iiprop: 'url|size',
          titles: `File:${mapImage}`,
        }),
        options.signal,
      )
      const image = info.query?.pages?.[0]?.imageinfo?.[0]
      if (!image?.url) throw new Error('Fandom 页面没有找到这张图片')
      options.onProgress?.({ step: '下载底图', detail: mapImage })
      const blob = await fetchBlobWithProgress(image.url, options.signal, options.onProgress)
      const probed = await readLayerImage(blob, mapImage)
      choice = {
        path: `fandom:${mapImage}`,
        name: mapImage,
        blob,
        width: probed.width || image.width || 1,
        height: probed.height || image.height || 1,
        bytes: blob.size,
        placeholder: isPlaceholderName(mapImage),
        source: 'fandom-url',
        matched: 'downloaded',
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      imageDownloadError = imageDownloadReason(error)
    }
  }
  const notices: LayerImportNotice[] = []
  if (imageDownloadError) {
    notices.push({
      tone: 'warning',
      text: `JSON 已读取，底图需要本地选择。图片下载失败：${imageDownloadError}`,
    })
  } else if (!mapImage) {
    notices.push({ tone: 'info', text: '这个 Map 页面没有指定 mapImage，可以手动选择本地底图。' })
  }
  const pkg = parseFandomPackage(found.raw, {
    name: pageTitle || cleanPackageName(host.replace(/\.fandom\.com$/, '')),
    wikiBase: host,
    sourceUrl,
    image: choice?.blob,
    imageType: choice?.blob.type,
    imageName: choice?.name,
    imagePageUrl,
    imageWidth: choice?.width,
    imageHeight: choice?.height,
    imageSource: choice ? 'fandom-url' : 'none',
  })
  pkg.attribution = `${host} / Fandom 页面`
  pkg.imagePageUrl = imagePageUrl
  if (choice) pkg.thumbnail = await makeLayerThumbnail(choice.blob)
  const stats = buildStats(pkg, undefined, choice)
  if (choice) {
    if (choice.placeholder) {
      notices.push({
        tone: 'warning',
        text: 'Fandom 返回的图片看起来是占位图，建议换成本地原图。',
      })
    }
    const aspect = imageAspectNote(pkg)
    if (aspect) {
      notices.push({
        tone: 'info',
        text: `${aspect}，默认铺满画布；地点对不上时可在导入后使用“对齐底图”。`,
      })
    }
  }
  return {
    pkg,
    stats,
    notices,
    sourceLabel: 'Fandom 页面',
    sourceUrl,
    imagePageUrl,
    imageDownloadError: imageDownloadError || undefined,
    imageChoices: choice ? [choice] : [],
    targetImageName: mapImage || undefined,
    selectedImagePath: choice?.path,
    autoImagePath: choice?.path,
    dataPath: found.title,
    dataCandidates: [],
    bundle: null,
    canAttachData: false,
  }
}

export function previewSummary(preview: LayerImportPreview): string {
  const { stats } = preview
  return `${stats.markerCount.toLocaleString('zh-CN')} 地点 · ${stats.categoryCount.toLocaleString('zh-CN')} 分类 · ${formatBytes(stats.sizeBytes)}`
}

export function linkCountForMarkers(markers: LayerMapPackage['markers']): number {
  return markers.reduce((total: number, marker) => total + (marker.sourceLinks?.length ?? 0), 0)
}

export function sourceLinksFor(marker: LayerMapPackage['markers'][number]): LayerLink[] {
  return marker.sourceLinks ?? []
}

export function cleanImportText(value: string): string {
  return cleanSourceText(value)
}
