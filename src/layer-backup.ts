/**
 * Tavern Map backup package: one layer map package written out exactly as the
 * extension stores it, plus the user's own changes that live in other stores.
 *
 *   manifest.json        { format: "tavern-map-backup", version, parts, ... }
 *   map-package.json     the stored LayerMapPackage, Blobs replaced by file refs
 *   personal.json        notes, edited sources, pins, AI ticks, favorites, chat data
 *   tavern-map-files/…   every Blob of the package (image, tiles, icons, thumbnail)
 *
 * Personal keys are written relative to the package, so the same backup can be
 * restored under whatever id the package gets on another device.
 */
import { loadPlaceAIFlags, savePlaceAIFlags } from './layer-ai-store'
import { loadPinEdits, savePinEdits } from './layer-pin-store'
import type {
  LayerItinerary,
  LayerLink,
  LayerMapPackage,
  LayerPinEdits,
  LayerPlaceAIFlags,
  LayerUserPosition,
  LayerView,
} from './layer-types'
import { writeZip, type ZipWriteEntry } from './layer-zip'
import {
  flushGlobalNotes,
  globalNote,
  globalNotesSnapshot,
  LAYER_LINK_TEXT_PREFIX,
  layerNotePrefix,
  layerSourcePrefix,
  setGlobalNote,
} from './notes-store'
import { layerFavoriteKey, listFavorites, setFavorite, type FavoritePlace } from './favorites-store'

export const BACKUP_FORMAT = 'tavern-map-backup'
export const BACKUP_VERSION = 1
const MANIFEST_FILE = 'manifest.json'
const PACKAGE_FILE = 'map-package.json'
const PERSONAL_FILE = 'personal.json'
const FILES_DIR = 'tavern-map-files'
const FILE_REF = '$tmlFile'

/** The groups the export dialog can tick; the map itself is always included. */
export type BackupPart = 'notes' | 'materials' | 'pins' | 'ai' | 'favorites' | 'chat'
export const BACKUP_PARTS: BackupPart[] = ['notes', 'materials', 'pins', 'ai', 'favorites', 'chat']
/** Chat data belongs to one chat, so it is opt-in. */
export const BACKUP_DEFAULT_PARTS: BackupPart[] = ['notes', 'materials', 'pins', 'ai', 'favorites']

export type BackupMergeMode = 'keep' | 'replace'

export type LinkTextState = { text?: string; status?: string; fetchedAt?: number }

/** Data the layer map keeps in the current chat's metadata for one package. */
export type BackupChatSource = {
  /** User-added links of imported places, keyed by marker id. */
  links?: Record<string, LayerLink[]>
  /** Fetched text of imported links, keyed `markerId:linkId`. */
  sourceLinkText?: Record<string, LinkTextState>
  position?: LayerUserPosition
  view?: LayerView
  itinerary?: LayerItinerary
}

export type BackupPersonal = {
  /** Note key relative to the package prefix (marker id, `region:…`, `road:…`). */
  notes?: Record<string, string>
  /** Marker id → user-edited source text. */
  sources?: Record<string, string>
  /** URL → fetched link / Wiki text. */
  linkTexts?: Record<string, string>
  links?: Record<string, LayerLink[]>
  sourceLinkText?: Record<string, LinkTextState>
  pins?: LayerPinEdits
  aiFlags?: Record<string, LayerPlaceAIFlags>
  /** Favorites of this map; `key`/`mapId` are rebuilt on restore. */
  favorites?: FavoritePlace[]
  chat?: { position?: LayerUserPosition; view?: LayerView; itinerary?: LayerItinerary }
}

export type BackupManifest = {
  format: typeof BACKUP_FORMAT
  version: number
  name: string
  exportedAt: string
  parts: BackupPart[]
  data: string
  personal: string
}

export type BackupContents = {
  manifest: BackupManifest
  pkg: LayerMapPackage
  personal: BackupPersonal
}

type BundleFile = { path: string; name: string; blob: Blob }

// ── collecting ──────────────────────────────────────────────────────────────

function withPrefix(prefix: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(globalNotesSnapshot())) {
    if (key.startsWith(prefix) && value.trim()) result[key.slice(prefix.length)] = value
  }
  return result
}

/** Every http(s) string anywhere in the values; used to find link texts. */
function collectUrls(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) into.add(value)
  } else if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, into)
  } else if (value && typeof value === 'object' && !(value instanceof Blob)) {
    for (const item of Object.values(value)) collectUrls(item, into)
  }
}

function nonEmpty<T extends object>(value: T | undefined): T | undefined {
  if (!value) return undefined
  if (Array.isArray(value)) return value.length ? value : undefined
  return Object.keys(value).length ? value : undefined
}

function placeIds(pkg: LayerMapPackage, pins: LayerPinEdits): Set<string> {
  return new Set([...pkg.markers.map((marker) => marker.id), ...pins.customPins.map((pin) => pin.id)])
}

/** Everything personal about one package, for every part; the dialog filters. */
export function collectBackupPersonal(
  pkg: LayerMapPackage,
  chat: BackupChatSource = {},
): Required<Pick<BackupPersonal, 'notes' | 'sources' | 'linkTexts' | 'aiFlags' | 'favorites'>> &
  BackupPersonal {
  const pins = loadPinEdits(pkg.id)
  const ids = placeIds(pkg, pins)
  const ownedByPlace = <T>(record: Record<string, T> | undefined, idOf: (key: string) => string) =>
    nonEmpty(Object.fromEntries(Object.entries(record ?? {}).filter(([key]) => ids.has(idOf(key)))))
  const links = ownedByPlace(chat.links, (key) => key)
  const sourceLinkText = ownedByPlace(chat.sourceLinkText, (key) => key.split(':')[0])
  const urls = new Set<string>()
  collectUrls(pkg, urls)
  collectUrls(pins, urls)
  collectUrls(links, urls)
  const linkTexts: Record<string, string> = {}
  for (const url of urls) {
    const text = globalNote(`${LAYER_LINK_TEXT_PREFIX}${url}`)
    if (text?.trim()) linkTexts[url] = text
  }
  const hasPins = Object.keys(pins.overrides).length > 0 || pins.customPins.length > 0
  const chatData = nonEmpty(
    Object.fromEntries(
      Object.entries({ position: chat.position, view: chat.view, itinerary: chat.itinerary }).filter(
        ([, value]) => value !== undefined,
      ),
    ),
  )
  return {
    notes: withPrefix(layerNotePrefix(pkg.id)),
    sources: withPrefix(layerSourcePrefix(pkg.id)),
    linkTexts,
    links,
    sourceLinkText,
    pins: hasPins ? pins : undefined,
    aiFlags: loadPlaceAIFlags(pkg.id),
    favorites: listFavorites().filter((item) => item.kind === 'layer' && item.mapId === pkg.id),
    chat: chatData,
  }
}

/** How many items each part holds; 0 means the part has nothing to export. */
export function countBackupParts(personal: BackupPersonal): Record<BackupPart, number> {
  const size = (value: object | undefined) => (value ? Object.keys(value).length : 0)
  const linkCount = Object.values(personal.links ?? {}).reduce((total, list) => total + list.length, 0)
  const historyOnly = Object.keys(personal.pins?.history ?? {}).length
  return {
    notes: size(personal.notes),
    materials: size(personal.sources) + size(personal.linkTexts) + linkCount + size(personal.sourceLinkText),
    pins: size(personal.pins?.overrides) + (personal.pins?.customPins.length ?? 0) || (historyOnly ? 1 : 0),
    ai: size(personal.aiFlags),
    favorites: personal.favorites?.length ?? 0,
    chat: size(personal.chat),
  }
}

const PART_FIELDS: Record<BackupPart, Array<keyof BackupPersonal>> = {
  notes: ['notes'],
  materials: ['sources', 'linkTexts', 'links', 'sourceLinkText'],
  pins: ['pins'],
  ai: ['aiFlags'],
  favorites: ['favorites'],
  chat: ['chat'],
}

export function pickBackupParts(personal: BackupPersonal, parts: BackupPart[]): BackupPersonal {
  const result: BackupPersonal = {}
  for (const part of parts) {
    for (const field of PART_FIELDS[part]) {
      const value = personal[field]
      if (value && nonEmpty(value as object)) (result as Record<string, unknown>)[field] = value
    }
  }
  return result
}

// ── writing ─────────────────────────────────────────────────────────────────

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'font/ttf': 'ttf',
  'application/json': 'json',
}

function safeSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9._-]/g, '_') || '_'
}

/**
 * Copy `value` for JSON, moving every Blob (wherever it sits) into `files` and
 * leaving `{ $tmlFile, type }` in its place. No field list: new Blob fields in
 * the package format are exported without changing this code.
 */
function packBlobs(value: unknown, path: string[], files: ZipWriteEntry[], used: Set<string>): unknown {
  if (value instanceof Blob) {
    const extension = EXTENSIONS[value.type] ?? 'bin'
    const base = `${FILES_DIR}/${path.map(safeSegment).join('/') || 'file'}`
    let filePath = `${base}.${extension}`
    for (let n = 2; used.has(filePath); n += 1) filePath = `${base}-${n}.${extension}`
    used.add(filePath)
    files.push({ path: filePath, blob: value })
    return { [FILE_REF]: filePath, type: value.type }
  }
  if (Array.isArray(value)) return value.map((item, index) => packBlobs(item, [...path, String(index)], files, used))
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      result[key] = packBlobs(item, [...path, key], files, used)
    }
    return result
  }
  return value
}

function jsonBlob(value: unknown): Blob {
  return new Blob([JSON.stringify(value, null, 1)], { type: 'application/json' })
}

export type BuildBackupOptions = {
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
  date?: Date
}

export async function buildBackupZip(
  pkg: LayerMapPackage,
  personal: BackupPersonal,
  parts: BackupPart[],
  options: BuildBackupOptions = {},
): Promise<Blob> {
  const files: ZipWriteEntry[] = []
  const packed = packBlobs(pkg, [], files, new Set())
  const date = options.date ?? new Date()
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    name: pkg.name,
    exportedAt: date.toISOString(),
    parts,
    data: PACKAGE_FILE,
    personal: PERSONAL_FILE,
  }
  const entries: ZipWriteEntry[] = [
    { path: MANIFEST_FILE, blob: jsonBlob(manifest) },
    { path: PACKAGE_FILE, blob: jsonBlob(packed) },
    { path: PERSONAL_FILE, blob: jsonBlob(pickBackupParts(personal, parts)) },
    ...files,
  ]
  return writeZip(entries, {
    signal: options.signal,
    date,
    onProgress: (done, total) => options.onProgress?.(done, total),
  })
}

export function backupFileName(pkg: LayerMapPackage): string {
  const name = pkg.name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim() || 'map'
  return `${name}.tavern-map.zip`
}

// ── reading ─────────────────────────────────────────────────────────────────

/** Backup payload files are not JSON or images, so the ZIP reader must keep them. */
export function isBackupFilePath(path: string): boolean {
  return path === FILES_DIR || path.startsWith(`${FILES_DIR}/`) || path.includes(`/${FILES_DIR}/`)
}

function shallowest(files: BundleFile[], name: string): BundleFile | undefined {
  return files
    .filter((file) => file.name.toLowerCase() === name)
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length)[0]
}

function unpackBlobs(value: unknown, byPath: Map<string, Blob>, missing: string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => unpackBlobs(item, byPath, missing))
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record[FILE_REF] === 'string') {
      const blob = byPath.get(record[FILE_REF] as string)
      if (!blob) {
        missing.push(record[FILE_REF] as string)
        return undefined
      }
      return new Blob([blob], { type: typeof record.type === 'string' ? record.type : blob.type })
    }
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(record)) {
      const unpacked = unpackBlobs(item, byPath, missing)
      if (unpacked !== undefined) result[key] = unpacked
    }
    return result
  }
  return value
}

/** Read a bundle as a backup package; undefined when it is not one. */
export async function readBackupBundle(files: BundleFile[]): Promise<BackupContents | undefined> {
  const manifestFile = shallowest(files, MANIFEST_FILE)
  if (!manifestFile) return undefined
  let manifest: BackupManifest
  try {
    manifest = JSON.parse(await manifestFile.blob.text()) as BackupManifest
  } catch {
    return undefined
  }
  if (!manifest || manifest.format !== BACKUP_FORMAT) return undefined
  if (typeof manifest.version !== 'number' || manifest.version > BACKUP_VERSION) {
    throw new Error(`这个备份包来自更新版本的 Tavern Map（格式 v${manifest.version}），请先更新插件。`)
  }
  const base = manifestFile.path.includes('/') ? manifestFile.path.slice(0, manifestFile.path.lastIndexOf('/') + 1) : ''
  const byPath = new Map<string, Blob>()
  for (const file of files) {
    if (file.path.startsWith(base)) byPath.set(file.path.slice(base.length), file.blob)
  }
  const dataBlob = byPath.get(manifest.data || PACKAGE_FILE)
  if (!dataBlob) throw new Error(`备份包缺少 ${manifest.data || PACKAGE_FILE}`)
  const missing: string[] = []
  const pkg = unpackBlobs(JSON.parse(await dataBlob.text()), byPath, missing) as LayerMapPackage
  if (missing.length > 0) {
    throw new Error(`备份包缺少 ${missing.length} 个文件，例如 ${missing[0]}。压缩包可能没有下载完整。`)
  }
  if (!pkg || typeof pkg.id !== 'string' || !Array.isArray(pkg.markers)) {
    throw new Error('备份包里的地图数据损坏')
  }
  const personalBlob = byPath.get(manifest.personal || PERSONAL_FILE)
  const personal = personalBlob ? (JSON.parse(await personalBlob.text()) as BackupPersonal) : {}
  return { manifest, pkg, personal }
}

// ── restoring ───────────────────────────────────────────────────────────────

/**
 * The one merge rule for every kind of personal data: "keep" adds only what
 * this device does not have yet, "replace" lets the backup win for items both
 * have. Items only on this device are never removed.
 */
export function mergeRecord<T>(
  current: Record<string, T> | undefined,
  incoming: Record<string, T> | undefined,
  mode: BackupMergeMode,
  isEmpty: (value: T | undefined) => boolean = (value) => value === undefined,
): Record<string, T> {
  const result: Record<string, T> = { ...(current ?? {}) }
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (mode === 'replace' || isEmpty(result[key])) result[key] = value
  }
  return result
}

const blankText = (value: string | undefined) => !value?.trim()

function mergeGlobalNotes(prefix: string, incoming: Record<string, string> | undefined, mode: BackupMergeMode): void {
  for (const [key, text] of Object.entries(incoming ?? {})) {
    if (typeof text !== 'string') continue
    const full = `${prefix}${key}`
    if (mode === 'replace' || blankText(globalNote(full))) setGlobalNote(full, text)
  }
}

/**
 * Restore the map-level personal data under `pkg.id`. Chat-level data (links,
 * link texts, position, view, itinerary) is returned for the layer map to
 * write into the current chat.
 */
export async function applyBackupPersonal(
  pkg: LayerMapPackage,
  personal: BackupPersonal,
  mode: BackupMergeMode,
): Promise<BackupChatSource> {
  mergeGlobalNotes(layerNotePrefix(pkg.id), personal.notes, mode)
  mergeGlobalNotes(layerSourcePrefix(pkg.id), personal.sources, mode)
  mergeGlobalNotes(LAYER_LINK_TEXT_PREFIX, personal.linkTexts, mode)
  await flushGlobalNotes()

  if (personal.pins) {
    const current = loadPinEdits(pkg.id)
    const byId = <T extends { id: string }>(list: T[]) => Object.fromEntries(list.map((item) => [item.id, item]))
    savePinEdits(pkg.id, {
      version: 1,
      overrides: mergeRecord(current.overrides, personal.pins.overrides, mode),
      customPins: Object.values(mergeRecord(byId(current.customPins), byId(personal.pins.customPins ?? []), mode)),
      history: mergeRecord(current.history, personal.pins.history, mode),
      updatedAt: Date.now(),
    })
  }

  if (personal.aiFlags) {
    const current = loadPlaceAIFlags(pkg.id)
    const merged = { ...current }
    for (const [key, flags] of Object.entries(personal.aiFlags)) {
      merged[key] = mode === 'replace' ? { ...current[key], ...flags } : { ...flags, ...current[key] }
    }
    savePlaceAIFlags(pkg.id, merged)
  }

  for (const favorite of personal.favorites ?? []) {
    if (!favorite.markerId) continue
    const key = layerFavoriteKey(pkg.id, favorite.markerId)
    const exists = listFavorites().some((item) => item.key === key)
    if (exists && mode === 'keep') continue
    setFavorite({ ...favorite, key, kind: 'layer', mapId: pkg.id, mapName: pkg.name }, true)
  }

  return {
    links: personal.links,
    sourceLinkText: personal.sourceLinkText,
    ...personal.chat,
  }
}
