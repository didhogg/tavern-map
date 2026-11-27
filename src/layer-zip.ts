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
