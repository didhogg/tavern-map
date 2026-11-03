const DB_NAME = 'tavern-map'
const STORE_NAME = 'wiki'
const DB_VERSION = 1

let databasePromise: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
    })
  }
  return databasePromise
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await openDatabase()
    return await new Promise<T | undefined>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly')
      const request = transaction.objectStore(STORE_NAME).get(key)
      request.onsuccess = () => resolve(request.result as T | undefined)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'))
    })
  } catch (error) {
    console.warn('[tavern-map] cache read failed', error)
    return undefined
  }
}

export async function cachePut(key: string, value: unknown): Promise<void> {
  try {
    const db = await openDatabase()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).put(value, key)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB write failed'))
    })
  } catch (error) {
    console.warn('[tavern-map] cache write failed', error)
  }
}

export function wikiCacheKey(lang: string, title: string): string {
  return `${lang}:${title.trim().toLowerCase()}`
}

export function wikiFullCacheKey(lang: string, title: string): string {
  return `${wikiCacheKey(lang, title)}:full`
}
