export type ZipEntry = {
  /** Normalized path inside the archive, using forward slashes. */
  path: string
  name: string
  blob: Blob
  size: number
  compressedSize: number
}

export type ZipReadOptions = {
  signal?: AbortSignal
  onProgress?: (done: number, total: number, path: string) => void
  /** Return false to skip decompressing an entry that is not needed. */
  shouldRead?: (path: string) => boolean
}

const EOCD_SIGNATURE = 0x06054b50
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50
const EOCD64_SIGNATURE = 0x06064b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const MAX_SAFE = Number.MAX_SAFE_INTEGER

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif'])

export function isZipCandidate(path: string): boolean {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  return extension === 'json' || IMAGE_EXTENSIONS.has(extension)
}

function extensionOf(path: string): string {
  return path.split('.').pop()?.toLowerCase() ?? ''
}

function mimeForPath(path: string): string {
  switch (extensionOf(path)) {
    case 'json':
      return 'application/json'
    case 'png':
      return 'image/png'
    case 'webp':
      return 'image/webp'
    case 'avif':
      return 'image/avif'
    case 'gif':
      return 'image/gif'
    default:
      return 'image/jpeg'
  }
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('导入已取消', 'AbortError')
}

async function readBytes(blob: Blob, start: number, end: number): Promise<ArrayBuffer> {
  const safeStart = Math.max(0, Math.min(blob.size, start))
  const safeEnd = Math.max(safeStart, Math.min(blob.size, end))
  return blob.slice(safeStart, safeEnd).arrayBuffer()
}

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true)
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true)
}

function u64(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true)
  if (value > BigInt(MAX_SAFE)) throw new Error('ZIP64 数值超出浏览器可处理范围')
  return Number(value)
}

function findSignature(bytes: Uint8Array, signature: number, fromEnd = false): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (fromEnd) {
    for (let offset = bytes.byteLength - 4; offset >= 0; offset -= 1) {
      if (u32(view, offset) === signature) return offset
    }
  } else {
    for (let offset = 0; offset + 4 <= bytes.byteLength; offset += 1) {
      if (u32(view, offset) === signature) return offset
    }
  }
  return -1
}

type CentralEntry = {
  path: string
  flags: number
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

function zip64Extra(
  extra: Uint8Array,
  needs: { uncompressed: boolean; compressed: boolean; offset: boolean },
): { uncompressed?: number; compressed?: number; offset?: number } {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength)
  let cursor = 0
  while (cursor + 4 <= extra.byteLength) {
    const id = u16(view, cursor)
    const size = u16(view, cursor + 2)
    const dataStart = cursor + 4
    if (id === 0x0001) {
      let position = dataStart
      const result: { uncompressed?: number; compressed?: number; offset?: number } = {}
      if (needs.uncompressed && position + 8 <= dataStart + size) {
        result.uncompressed = u64(view, position)
        position += 8
      }
      if (needs.compressed && position + 8 <= dataStart + size) {
        result.compressed = u64(view, position)
        position += 8
      }
      if (needs.offset && position + 8 <= dataStart + size) {
        result.offset = u64(view, position)
      }
      return result
    }
    cursor += 4 + size
  }
  return {}
}

async function readCentralDirectory(
  file: Blob,
  offset: number,
  size: number,
): Promise<CentralEntry[]> {
  const bytes = new Uint8Array(await readBytes(file, offset, offset + size))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entries: CentralEntry[] = []
  let cursor = 0
  while (cursor + 46 <= bytes.byteLength) {
    if (u32(view, cursor) !== CENTRAL_SIGNATURE) {
      throw new Error('ZIP 中央目录损坏，文件可能没有下载完整')
    }
    const flags = u16(view, cursor + 8)
    const method = u16(view, cursor + 10)
    const compressedRaw = u32(view, cursor + 20)
    const uncompressedRaw = u32(view, cursor + 24)
    const nameLength = u16(view, cursor + 28)
    const extraLength = u16(view, cursor + 30)
    const commentLength = u16(view, cursor + 32)
    const localOffsetRaw = u32(view, cursor + 42)
    const nameStart = cursor + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd > bytes.byteLength) throw new Error('ZIP 文件名长度损坏')
    const nameBytes = bytes.subarray(nameStart, nameEnd)
    const decoded = new TextDecoder('utf-8').decode(nameBytes)
    const path = decoded.replace(/\\/g, '/').replace(/^\.?\//, '')
    const extraStart = nameEnd
    const extraEnd = Math.min(bytes.byteLength, extraStart + extraLength)
    const extra = bytes.subarray(extraStart, extraEnd)
    let uncompressedSize = uncompressedRaw
    let compressedSize = compressedRaw
    let localOffset = localOffsetRaw
    if (
      uncompressedRaw === 0xffffffff ||
      compressedRaw === 0xffffffff ||
      localOffsetRaw === 0xffffffff
    ) {
      const zip64 = zip64Extra(extra, {
        uncompressed: uncompressedRaw === 0xffffffff,
        compressed: compressedRaw === 0xffffffff,
        offset: localOffsetRaw === 0xffffffff,
      })
      if (zip64.uncompressed != null) uncompressedSize = zip64.uncompressed
      if (zip64.compressed != null) compressedSize = zip64.compressed
      if (zip64.offset != null) localOffset = zip64.offset
    }
    const isDirectory = path.endsWith('/')
    if (path && !isDirectory) {
      entries.push({
        path,
        flags,
        method,
        compressedSize,
        uncompressedSize,
        localOffset,
      })
    }
    cursor = extraEnd + commentLength
  }
  return entries
}

async function readZipDirectory(file: Blob): Promise<{
  entries: CentralEntry[]
  centralOffset: number
  centralSize: number
}> {
  const tailLength = Math.min(file.size, 65557 + 64)
  const tailStart = Math.max(0, file.size - tailLength)
  const tail = new Uint8Array(await readBytes(file, tailStart, file.size))
  const eocdIndex = findSignature(tail, EOCD_SIGNATURE, true)
  if (eocdIndex < 0) throw new Error('不是有效的 ZIP 文件（找不到中央目录结尾）')
  const eocdView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  const eocdAbsolute = tailStart + eocdIndex
  let totalEntries = u16(eocdView, eocdIndex + 10)
  let centralSize = u32(eocdView, eocdIndex + 12)
  let centralOffset = u32(eocdView, eocdIndex + 16)
  if (
    totalEntries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    const locatorOffset = eocdAbsolute - 20
    if (locatorOffset < 0) throw new Error('ZIP64 定位器缺失')
    const locator = new Uint8Array(await readBytes(file, locatorOffset, locatorOffset + 20))
    const locatorView = new DataView(locator.buffer, locator.byteOffset, locator.byteLength)
    if (u32(locatorView, 0) !== EOCD64_LOCATOR_SIGNATURE) {
      throw new Error('ZIP64 定位器损坏')
    }
    const eocd64Offset = u64(locatorView, 8)
    const eocd64 = new Uint8Array(await readBytes(file, eocd64Offset, eocd64Offset + 56))
    const eocd64View = new DataView(eocd64.buffer, eocd64.byteOffset, eocd64.byteLength)
    if (u32(eocd64View, 0) !== EOCD64_SIGNATURE) throw new Error('ZIP64 中央目录损坏')
    totalEntries = u64(eocd64View, 32)
    centralSize = u64(eocd64View, 40)
    centralOffset = u64(eocd64View, 48)
  }
  if (centralOffset + centralSize > file.size) {
    throw new Error('ZIP 中央目录超出文件范围，文件可能没有下载完整')
  }
  const entries = await readCentralDirectory(file, centralOffset, centralSize)
  if (totalEntries && entries.length === 0) {
    throw new Error('ZIP 中没有可读取的文件')
  }
  return { entries, centralOffset, centralSize }
}

async function extractEntry(
  file: Blob,
  entry: CentralEntry,
  signal: AbortSignal | undefined,
): Promise<Blob | undefined> {
  abortIfNeeded(signal)
  if (entry.flags & 0x0001) {
    throw new Error(`ZIP 内文件已加密，无法读取：${entry.path}`)
  }
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error(`ZIP 使用了不支持的压缩方式（${entry.method}）：${entry.path}`)
  }
  const header = new Uint8Array(await readBytes(file, entry.localOffset, entry.localOffset + 30))
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength)
  if (header.byteLength < 30 || u32(headerView, 0) !== LOCAL_SIGNATURE) {
    throw new Error(`ZIP 文件头损坏：${entry.path}`)
  }
  const nameLength = u16(headerView, 26)
  const extraLength = u16(headerView, 28)
  const dataStart = entry.localOffset + 30 + nameLength + extraLength
  const compressed = file.slice(dataStart, dataStart + entry.compressedSize)
  const type = mimeForPath(entry.path)
  // Always hand out a Blob that owns its bytes. A slice still references the
  // whole archive File, and WebKit (TauriTavern / Safari) copies that entire
  // backing file into a temporary file for every such Blob stored in
  // IndexedDB: one 255 MB tile ZIP became hundreds of 255 MB temp copies.
  if (entry.method === 0) {
    return new Blob([await compressed.arrayBuffer()], { type })
  }
  const Decompression = globalThis.DecompressionStream
  if (!Decompression) {
    throw new Error('当前浏览器不支持 ZIP 解压，请改用文件夹导入')
  }
  const stream = compressed.stream().pipeThrough(new Decompression('deflate-raw'))
  return new Blob([await new Response(stream).arrayBuffer()], { type })
}

/**
 * Minimal ZIP reader: EOCD / ZIP64 / central directory, stored and deflate
 * entries. It reads only the entries the caller needs, so a map archive does
 * not have to be unpacked into memory all at once.
 */
export async function readZip(file: Blob, options: ZipReadOptions = {}): Promise<ZipEntry[]> {
  const { entries, centralOffset, centralSize } = await readZipDirectory(file)
  const shouldRead = options.shouldRead ?? isZipCandidate
  const selected = entries.filter(
    (entry) =>
      !entry.path.startsWith('__MACOSX/') &&
      !entry.path.split('/').includes('.DS_Store') &&
      shouldRead(entry.path),
  )
  const result: ZipEntry[] = []
  let done = 0
  for (const entry of selected) {
    abortIfNeeded(options.signal)
    const blob = await extractEntry(file, entry, options.signal)
    done += 1
    options.onProgress?.(done, selected.length, entry.path)
    if (!blob) continue
    result.push({
      path: entry.path,
      name: entry.path.split('/').pop() ?? entry.path,
      blob,
      size: blob.size,
      compressedSize: entry.compressedSize,
    })
  }
  if (selected.length === 0) {
    throw new Error(
      `ZIP 中央目录有 ${entries.length} 个文件，但没有找到 JSON 或图片（目录偏移 ${centralOffset}，大小 ${centralSize}）`,
    )
  }
  return result
}

export type ZipWriteEntry = {
  /** Path inside the archive, forward slashes, no leading slash. */
  path: string
  blob: Blob
}

export type ZipWriteOptions = {
  signal?: AbortSignal
  onProgress?: (done: number, total: number, path: string) => void
  /** Timestamp written into every entry; defaults to now. */
  date?: Date
}

const ZIP32_MAX = 0xffffffff
const ZIP16_MAX = 0xffff
let crcTable: Uint32Array | undefined

function crc32Of(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date: Date): { time: number; day: number } {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/**
 * Minimal ZIP writer matching `readZip`: stored (uncompressed) entries, UTF-8
 * names and ZIP64 records when sizes, offsets or the entry count need them.
 * Entry data stays as the caller's Blobs, so a large tile package is not
 * copied into one buffer; only each entry is read once for its checksum.
 */
export async function writeZip(entries: ZipWriteEntry[], options: ZipWriteOptions = {}): Promise<Blob> {
  const encoder = new TextEncoder()
  const { time, day } = dosDateTime(options.date ?? new Date())
  const parts: BlobPart[] = []
  const central: Array<Uint8Array<ArrayBuffer>> = []
  let offset = 0
  let done = 0
  for (const entry of entries) {
    abortIfNeeded(options.signal)
    const name = encoder.encode(entry.path)
    const crc = crc32Of(new Uint8Array(await entry.blob.arrayBuffer()))
    const size = entry.blob.size
    const bigSize = size >= ZIP32_MAX
    const bigOffset = offset >= ZIP32_MAX

    const localExtra = bigSize ? new DataView(new ArrayBuffer(20)) : undefined
    if (localExtra) {
      localExtra.setUint16(0, 0x0001, true)
      localExtra.setUint16(2, 16, true)
      localExtra.setBigUint64(4, BigInt(size), true)
      localExtra.setBigUint64(12, BigInt(size), true)
    }
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, LOCAL_SIGNATURE, true)
    local.setUint16(4, bigSize ? 45 : 20, true)
    local.setUint16(6, 0x0800, true)
    local.setUint16(8, 0, true)
    local.setUint16(10, time, true)
    local.setUint16(12, day, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, bigSize ? ZIP32_MAX : size, true)
    local.setUint32(22, bigSize ? ZIP32_MAX : size, true)
    local.setUint16(26, name.length, true)
    local.setUint16(28, localExtra?.byteLength ?? 0, true)
    parts.push(local.buffer, name)
    if (localExtra) parts.push(localExtra.buffer)
    parts.push(entry.blob)

    const extraFields: bigint[] = []
    if (bigSize) extraFields.push(BigInt(size), BigInt(size))
    if (bigOffset) extraFields.push(BigInt(offset))
    const centralExtra = extraFields.length ? new DataView(new ArrayBuffer(4 + extraFields.length * 8)) : undefined
    if (centralExtra) {
      centralExtra.setUint16(0, 0x0001, true)
      centralExtra.setUint16(2, extraFields.length * 8, true)
      extraFields.forEach((value, index) => centralExtra.setBigUint64(4 + index * 8, value, true))
    }
    const head = new DataView(new ArrayBuffer(46))
    head.setUint32(0, CENTRAL_SIGNATURE, true)
    head.setUint16(4, centralExtra ? 45 : 20, true)
    head.setUint16(6, centralExtra ? 45 : 20, true)
    head.setUint16(8, 0x0800, true)
    head.setUint16(10, 0, true)
    head.setUint16(12, time, true)
    head.setUint16(14, day, true)
    head.setUint32(16, crc, true)
    head.setUint32(20, bigSize ? ZIP32_MAX : size, true)
    head.setUint32(24, bigSize ? ZIP32_MAX : size, true)
    head.setUint16(28, name.length, true)
    head.setUint16(30, centralExtra?.byteLength ?? 0, true)
    head.setUint32(42, bigOffset ? ZIP32_MAX : offset, true)
    central.push(new Uint8Array(head.buffer), name)
    if (centralExtra) central.push(new Uint8Array(centralExtra.buffer))

    offset += 30 + name.length + (localExtra?.byteLength ?? 0) + size
    done += 1
    options.onProgress?.(done, entries.length, entry.path)
  }
  const centralOffset = offset
  const centralSize = central.reduce((total, part) => total + part.length, 0)
  // One Blob, not a spread: a big tile package has more parts than the call stack allows.
  parts.push(new Blob(central))
  const needs64 = entries.length >= ZIP16_MAX || centralOffset >= ZIP32_MAX || centralSize >= ZIP32_MAX
  if (needs64) {
    const record = new DataView(new ArrayBuffer(56))
    record.setUint32(0, EOCD64_SIGNATURE, true)
    record.setBigUint64(4, 44n, true)
    record.setUint16(12, 45, true)
    record.setUint16(14, 45, true)
    record.setBigUint64(24, BigInt(entries.length), true)
    record.setBigUint64(32, BigInt(entries.length), true)
    record.setBigUint64(40, BigInt(centralSize), true)
    record.setBigUint64(48, BigInt(centralOffset), true)
    const locator = new DataView(new ArrayBuffer(20))
    locator.setUint32(0, EOCD64_LOCATOR_SIGNATURE, true)
    locator.setBigUint64(8, BigInt(centralOffset + centralSize), true)
    locator.setUint32(16, 1, true)
    parts.push(record.buffer, locator.buffer)
  }
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, EOCD_SIGNATURE, true)
  end.setUint16(8, needs64 ? ZIP16_MAX : entries.length, true)
  end.setUint16(10, needs64 ? ZIP16_MAX : entries.length, true)
  end.setUint32(12, needs64 ? ZIP32_MAX : centralSize, true)
  end.setUint32(16, needs64 ? ZIP32_MAX : centralOffset, true)
  parts.push(end.buffer)
  return new Blob(parts, { type: 'application/zip' })
}
