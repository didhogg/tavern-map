/**
 * Global, chat-independent notes.
 *
 * Notes are deliberately not stored in `chatMetadata`: a note belongs to the
 * map object (layer marker/region, place, or wiki page), not to the chat that
 * happened to be open when it was written.
 */

const DB_NAME = 'tavern-map-notes'
const DB_VERSION = 1
const STORE = 'notes'

type NoteRecord = {
  key: string
  text: string
  updatedAt: number
}

let databasePromise: Promise<IDBDatabase> | null = null
let loadPromise: Promise<void> | null = null
let cache: Map<string, string> | null = null
const dirty = new Map<string, string | null>()
let flushTimer: number | undefined
let pageHideBound = false

function openDatabase(): Promise<IDBDatabase> {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () =>
        reject(request.error ?? new Error('Global notes IndexedDB open failed'))
    })
  }
  return databasePromise
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(request.error ?? new Error('Global notes IndexedDB request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Global notes IndexedDB transaction failed'))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Global notes IndexedDB transaction aborted'))
  })
}

export async function initGlobalNotes(): Promise<void> {
  if (cache) return
  if (!loadPromise) {
    loadPromise = (async () => {
      const next = new Map<string, string>()
      try {
        const db = await openDatabase()
        const transaction = db.transaction(STORE, 'readonly')
        const records = await requestResult(
          transaction.objectStore(STORE).getAll() as IDBRequest<NoteRecord[]>,
        )
        for (const record of records) {
          if (typeof record?.key === 'string' && typeof record.text === 'string') {
            next.set(record.key, record.text)
          }
        }
      } catch (error) {
        console.warn('[tavern-map] global notes unavailable; using in-memory notes', error)
      }
      cache = next
      if (!pageHideBound && typeof window !== 'undefined') {
        pageHideBound = true
        window.addEventListener('pagehide', () => {
          void flushGlobalNotes()
        })
      }
    })()
  }
  await loadPromise
}

/** Returns undefined when no record exists, and '' for an explicit empty note. */
export function globalNote(key: string): string | undefined {
  return cache?.get(key)
}

export function globalNotesSnapshot(): Record<string, string> {
  if (!cache) return {}
  return Object.fromEntries(cache.entries())
}

export function setGlobalNote(key: string, text: string): void {
  if (!cache) cache = new Map()
  cache.set(key, text)
  dirty.set(key, text)
  if (flushTimer === undefined) {
    flushTimer = window.setTimeout(() => {
      flushTimer = undefined
      void flushGlobalNotes()
    }, 250)
  }
}

export function clearGlobalNote(key: string): void {
  if (cache) cache.delete(key)
  dirty.set(key, null)
  if (flushTimer === undefined) {
    flushTimer = window.setTimeout(() => {
      flushTimer = undefined
      void flushGlobalNotes()
    }, 250)
  }
}

export async function flushGlobalNotes(): Promise<void> {
  if (dirty.size === 0) return
  if (flushTimer !== undefined) {
    window.clearTimeout(flushTimer)
    flushTimer = undefined
  }
  const entries = [...dirty.entries()]
  dirty.clear()
  try {
    const db = await openDatabase()
    const transaction = db.transaction(STORE, 'readwrite')
    const store = transaction.objectStore(STORE)
    const updatedAt = Date.now()
    for (const [key, text] of entries) {
      if (text === null) store.delete(key)
      else store.put({ key, text, updatedAt } satisfies NoteRecord)
    }
    await transactionDone(transaction)
  } catch (error) {
    console.warn('[tavern-map] global notes save failed', error)
    for (const [key, text] of entries) {
      if (!dirty.has(key)) dirty.set(key, text)
    }
  }
}
