import type {
  LayerImageFit,
  LayerImageRect,
  LayerImageSource,
  LayerMapPackage,
  LayerPackageMeta,
  LayerTileConfig,
} from './layer-types'

const DB_NAME = 'tavern-map-layer'
const DB_VERSION = 1
const PACKAGE_STORE = 'packages'
const META_STORE = 'meta'

let databasePromise: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(PACKAGE_STORE)) {
          db.createObjectStore(PACKAGE_STORE, { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'id' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Layer map IndexedDB open failed'))
    })
  }
  return databasePromise
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Layer map IndexedDB request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Layer map IndexedDB transaction failed'))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Layer map IndexedDB transaction aborted'))
  })
}

function encodedBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length
  } catch {
    return 0
  }
}

function packageDataBytes(pkg: LayerMapPackage): number {
  if (typeof pkg.dataBytes === 'number' && Number.isFinite(pkg.dataBytes) && pkg.dataBytes > 0) {
    return pkg.dataBytes
  }
  if (
    !pkg.markers.length &&
    !pkg.categories.length &&
    !pkg.regions.length &&
    !pkg.streets?.length
  ) {
    return 0
  }
  return encodedBytes({
    categories: pkg.categories,
    groups: pkg.groups,
    markers: pkg.markers,
    regions: pkg.regions,
    streets: pkg.streets,
  })
}

function tileBytes(pkg: LayerMapPackage): number {
  let bytes = 0
  for (const blob of Object.values(pkg.tileFiles ?? {})) bytes += blob.size
  return bytes
}

function tileZoomRange(pkg: LayerMapPackage): { min?: number; max?: number } {
  const keys = Object.keys(pkg.tileFiles ?? {})
  if (keys.length === 0) {
    return {
      min: pkg.tile?.coverageMinZoom,
      max: pkg.tile?.coverageMaxZoom,
    }
  }
  let min = Infinity
  let max = -Infinity
  for (const key of keys) {
    const zoom = Number(key.split('/')[0])
    if (!Number.isFinite(zoom)) continue
    min = Math.min(min, zoom)
    max = Math.max(max, zoom)
  }
  return Number.isFinite(min) ? { min, max } : {}
}

export function layerMeta(pkg: LayerMapPackage): LayerPackageMeta {
  const dataBytes = packageDataBytes(pkg)
  const tileCount = Object.keys(pkg.tileFiles ?? {}).length
  const imageBytes = pkg.image?.size ?? pkg.imageBytes ?? 0
  const zoom = tileZoomRange(pkg)
  const hasImage = Boolean(pkg.image)
  const missingAsset: LayerPackageMeta['missingAsset'] =
    pkg.kind === 'image' && !hasImage
      ? 'image'
      : pkg.kind === 'tiles' && tileCount === 0 && !pkg.tile?.template
        ? 'tiles'
        : null
  const linkCount = pkg.markers.reduce(
    (total, marker) => total + (marker.sourceLinks?.length ?? 0),
    0,
  )
  const descriptionCount = pkg.markers.reduce(
    (total, marker) => total + (marker.description ? 1 : 0),
    0,
  )
  return {
    id: pkg.id,
    name: pkg.name,
    kind: pkg.kind,
    source: pkg.source,
    sourceKey: pkg.sourceKey,
    markerCount: pkg.markers.length,
    regionCount: pkg.regions.length,
    sourceLabel: pkg.sourceLabel,
    remoteTiles: Boolean(pkg.tile?.template),
    categoryCount: pkg.categories.length,
    descriptionCount,
    linkCount,
    hasImage,
    imageName: pkg.imageName,
    imageWidth: pkg.imageWidth,
    imageHeight: pkg.imageHeight,
    imageBytes,
    imageSource: pkg.imageSource,
    tileCount,
    tileZoomMin: zoom.min,
    tileZoomMax: zoom.max,
    missingTiles: pkg.tile?.missingCount,
    sizeBytes:
      dataBytes +
      imageBytes +
      tileBytes(pkg) +
      (pkg.thumbnail?.size ?? 0),
    fileCount:
      (dataBytes > 0 ? 1 : 0) +
      (hasImage ? 1 : 0) +
      tileCount,
    missingAsset,
    thumbnail: pkg.thumbnail,
    updatedAt: pkg.updatedAt,
  }
}

export async function listLayerPackages(): Promise<LayerPackageMeta[]> {
  try {
    const db = await openDatabase()
    const transaction = db.transaction(META_STORE, 'readonly')
    const result = await requestResult(transaction.objectStore(META_STORE).getAll())
    return (result as LayerPackageMeta[]).sort((a, b) => b.updatedAt - a.updatedAt)
  } catch (error) {
    console.warn('[tavern-map] layer package list failed', error)
    return []
  }
}

export async function getLayerPackage(id: string): Promise<LayerMapPackage | undefined> {
  try {
    const db = await openDatabase()
    const transaction = db.transaction(PACKAGE_STORE, 'readonly')
    return await requestResult(
      transaction.objectStore(PACKAGE_STORE).get(id) as IDBRequest<LayerMapPackage | undefined>,
    )
  } catch (error) {
    console.warn('[tavern-map] layer package read failed', error)
    return undefined
  }
}

export type StorageEstimate = {
  supported: boolean
  usage: number
  quota: number
  available: number
}

export async function estimateLayerStorage(): Promise<StorageEstimate> {
  try {
    const estimate = await navigator.storage?.estimate?.()
    const usage = estimate?.usage ?? 0
    const quota = estimate?.quota ?? 0
    if (!quota) return { supported: false, usage, quota, available: 0 }
    return {
      supported: true,
      usage,
      quota,
      available: Math.max(0, quota - usage),
    }
  } catch {
    return { supported: false, usage: 0, quota: 0, available: 0 }
  }
}

export class StorageQuotaError extends Error {
  needed: number
  usage: number
  quota: number

  constructor(needed: number, usage: number, quota: number) {
    super('浏览器存储空间不足')
    this.name = 'StorageQuotaError'
    this.needed = needed
    this.usage = usage
    this.quota = quota
  }
}

export function isQuotaError(error: unknown): boolean {
  if (error instanceof StorageQuotaError) return true
  if (error instanceof DOMException) {
    return (
      error.name === 'QuotaExceededError' ||
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      /quota/i.test(error.message)
    )
  }
  return error instanceof Error && /quota|storage space/i.test(error.message)
}

export async function ensureLayerStorage(neededBytes: number): Promise<void> {
  const estimate = await estimateLayerStorage()
  if (!estimate.supported) return
  // Leave a small working margin for the metadata clone and the transaction.
  const margin = 2 * 1024 * 1024
  if (neededBytes + margin > estimate.available) {
    throw new StorageQuotaError(neededBytes, estimate.usage, estimate.quota)
  }
}

export async function putLayerPackage(
  pkg: LayerMapPackage,
  signal?: AbortSignal,
): Promise<void> {
  const db = await openDatabase()
  const transaction = db.transaction([PACKAGE_STORE, META_STORE], 'readwrite')
  const abort = (): void => {
    try {
      transaction.abort()
    } catch {
      // The transaction may already have committed.
    }
  }
  signal?.addEventListener('abort', abort, { once: true })
  transaction.objectStore(PACKAGE_STORE).put(pkg)
  transaction.objectStore(META_STORE).put(layerMeta(pkg))
  try {
    await transactionDone(transaction)
  } catch (error) {
    if (signal?.aborted) throw new DOMException('导入已取消', 'AbortError')
    if (isQuotaError(error)) {
      const estimate = await estimateLayerStorage()
      throw new StorageQuotaError(
        (pkg.image?.size ?? 0) + tileBytes(pkg),
        estimate.usage,
        estimate.quota,
      )
    }
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}

function sameLegacyIdentity(current: LayerMapPackage, incoming: LayerMapPackage): boolean {
  if (current.source !== incoming.source || current.kind !== incoming.kind) return false
  if (current.width !== incoming.width || current.height !== incoming.height) return false
  if (current.markers.length !== incoming.markers.length) return false
  const currentFirst = current.markers[0]?.sourceId ?? ''
  const incomingFirst = incoming.markers[0]?.sourceId ?? ''
  const currentLast = current.markers[current.markers.length - 1]?.sourceId ?? ''
  const incomingLast = incoming.markers[incoming.markers.length - 1]?.sourceId ?? ''
  if (currentFirst !== incomingFirst || currentLast !== incomingLast) return false
  if (current.kind === 'tiles') {
    const currentSet = current.tile?.setIndex ?? 0
    const incomingSet = incoming.tile?.setIndex ?? 0
    if (currentSet !== incomingSet) return false
  }
  return true
}

async function findExistingPackage(pkg: LayerMapPackage): Promise<LayerMapPackage | undefined> {
  const direct = await getLayerPackage(pkg.id)
  if (direct) return direct
  if (!pkg.sourceKey) return undefined
  const metas = await listLayerPackages()
  for (const meta of metas) {
    if (meta.sourceKey === pkg.sourceKey) {
      const found = await getLayerPackage(meta.id)
      if (found) return found
    }
  }
  // 0.4.0 packages predate sourceKey. Match them by stable content identity so
  // re-import updates the old row instead of creating a duplicate.
  for (const meta of metas) {
    if (meta.sourceKey) continue
    if (meta.source !== pkg.source || meta.kind !== pkg.kind) continue
    const found = await getLayerPackage(meta.id)
    if (found && sameLegacyIdentity(found, pkg)) return found
  }
  return undefined
}

export type SaveImportedResult = {
  pkg: LayerMapPackage
  existing?: LayerMapPackage
  updated: boolean
}

/**
 * Save an imported package. Existing local customizations win over the source:
 * a renamed package keeps its name, and a manually replaced/removed image stays
 * put even when the same source is imported again.
 */
export async function saveImportedPackage(
  pkg: LayerMapPackage,
  signal?: AbortSignal,
): Promise<SaveImportedResult> {
  const existing = await findExistingPackage(pkg)
  if (existing) {
    pkg.id = existing.id
    pkg.createdAt = existing.createdAt
    if (existing.nameLocked) {
      pkg.name = existing.name
      pkg.nameLocked = true
    }
    if (existing.grid) pkg.grid = existing.grid
    if (existing.iconFont && !pkg.iconFont) {
      pkg.iconFont = existing.iconFont
      pkg.dataBytes = (pkg.dataBytes ?? 0) + existing.iconFont.data.size
    }
    if (existing.iconAtlas && !pkg.iconAtlas) {
      pkg.iconAtlas = existing.iconAtlas
      pkg.dataBytes = (pkg.dataBytes ?? 0) + existing.iconAtlas.image.size
    }
    if (existing.imageLocked) {
      pkg.image = existing.image
      pkg.imageType = existing.imageType
      pkg.imageName = existing.imageName
      pkg.imagePageUrl = existing.imagePageUrl
      pkg.imageWidth = existing.imageWidth
      pkg.imageHeight = existing.imageHeight
      pkg.imageBytes = existing.imageBytes
      pkg.imageSource = existing.imageSource
      pkg.imageFit = existing.imageFit
      pkg.imageRect = existing.imageRect
      pkg.thumbnail = existing.thumbnail
      pkg.imageLocked = true
    }
  }
  pkg.updatedAt = Date.now()
  await putLayerPackage(pkg, signal)
  return { pkg, existing, updated: Boolean(existing) }
}

function mergeOptional<T extends object>(current: T, patch: Partial<T>): T {
  const next: T = { ...current, ...patch }
  for (const key of Object.keys(patch) as Array<keyof T>) {
    if (patch[key] === undefined) delete next[key]
  }
  return next
}

export async function updateLayerPackage(
  id: string,
  patch: Partial<LayerMapPackage>,
): Promise<LayerMapPackage | undefined> {
  const current = await getLayerPackage(id)
  if (!current) return undefined
  const next = mergeOptional(current, patch)
  next.id = current.id
  next.createdAt = current.createdAt
  next.updatedAt = Date.now()
  await putLayerPackage(next)
  return next
}

export async function renameLayerPackage(
  id: string,
  name: string,
): Promise<LayerMapPackage | undefined> {
  const trimmed = name.trim()
  if (!trimmed) return undefined
  return updateLayerPackage(id, { name: trimmed, nameLocked: true })
}

export type LayerImagePatch = {
  image: Blob
  imageType?: string
  imageName?: string
  imagePageUrl?: string
  imageWidth?: number
  imageHeight?: number
  imageBytes?: number
  imageSource?: LayerImageSource
  imageFit?: LayerImageFit
  imageRect?: LayerImageRect
  thumbnail?: Blob
  imageLocked?: boolean
  width?: number
  height?: number
}

export async function setLayerImage(
  id: string,
  patch: LayerImagePatch,
): Promise<LayerMapPackage | undefined> {
  return updateLayerPackage(id, {
    image: patch.image,
    imageType: patch.imageType,
    imageName: patch.imageName,
    imagePageUrl: patch.imagePageUrl,
    imageWidth: patch.imageWidth,
    imageHeight: patch.imageHeight,
    imageBytes: patch.imageBytes ?? patch.image.size,
    imageSource: patch.imageSource ?? 'local',
    imageFit: patch.imageFit ?? 'stretch',
    imageRect: patch.imageRect,
    thumbnail: patch.thumbnail,
    imageLocked: patch.imageLocked ?? true,
    width: patch.width,
    height: patch.height,
  })
}

export async function removeLayerImage(id: string): Promise<LayerMapPackage | undefined> {
  return updateLayerPackage(id, {
    image: undefined,
    imageType: undefined,
    imageName: undefined,
    imagePageUrl: undefined,
    imageWidth: undefined,
    imageHeight: undefined,
    imageBytes: undefined,
    imageSource: 'none',
    imageFit: undefined,
    imageRect: undefined,
    thumbnail: undefined,
    imageLocked: true,
  })
}

export async function setLayerImageFit(
  id: string,
  fit: LayerImageFit,
  rect?: LayerImageRect,
): Promise<LayerMapPackage | undefined> {
  return updateLayerPackage(id, {
    imageFit: fit,
    imageRect: fit === 'custom' ? rect : undefined,
  })
}

export async function setLayerTiles(
  id: string,
  tileFiles: Record<string, Blob> | undefined,
  tile: LayerTileConfig | undefined,
): Promise<LayerMapPackage | undefined> {
  return updateLayerPackage(id, { tileFiles, tile })
}

export async function deleteLayerPackage(id: string): Promise<void> {
  const db = await openDatabase()
  const transaction = db.transaction([PACKAGE_STORE, META_STORE], 'readwrite')
  transaction.objectStore(PACKAGE_STORE).delete(id)
  transaction.objectStore(META_STORE).delete(id)
  await transactionDone(transaction)
}
