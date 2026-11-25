import type { LayerMapPackage, LayerPackageMeta } from './layer-types'

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
    transaction.onerror = () => reject(transaction.error ?? new Error('Layer map IndexedDB transaction failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Layer map IndexedDB transaction aborted'))
  })
}

export function layerMeta(pkg: LayerMapPackage): LayerPackageMeta {
  return {
    id: pkg.id,
    name: pkg.name,
    kind: pkg.kind,
    source: pkg.source,
    markerCount: pkg.markers.length,
    regionCount: pkg.regions.length,
    categoryCount: pkg.categories.length,
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

export async function putLayerPackage(pkg: LayerMapPackage): Promise<void> {
  const db = await openDatabase()
  const transaction = db.transaction([PACKAGE_STORE, META_STORE], 'readwrite')
  transaction.objectStore(PACKAGE_STORE).put(pkg)
  transaction.objectStore(META_STORE).put(layerMeta(pkg))
  await transactionDone(transaction)
}

export async function deleteLayerPackage(id: string): Promise<void> {
  try {
    const db = await openDatabase()
    const transaction = db.transaction([PACKAGE_STORE, META_STORE], 'readwrite')
    transaction.objectStore(PACKAGE_STORE).delete(id)
    transaction.objectStore(META_STORE).delete(id)
    await transactionDone(transaction)
  } catch (error) {
    console.warn('[tavern-map] layer package delete failed', error)
  }
}
