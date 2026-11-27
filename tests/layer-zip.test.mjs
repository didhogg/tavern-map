import assert from 'node:assert/strict'
import test from 'node:test'
import { crc32, deflateRawSync } from 'node:zlib'
import { readZip } from '../src/layer-zip.ts'

function singleEntryZip(bytes, method) {
  const name = Buffer.from('tiles/0/0/0.png')
  const compressed = method === 8 ? deflateRawSync(bytes) : bytes
  const checksum = crc32(bytes)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(method, 8)
  local.writeUInt32LE(checksum, 14)
  local.writeUInt32LE(compressed.length, 18)
  local.writeUInt32LE(bytes.length, 22)
  local.writeUInt16LE(name.length, 26)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50)
  central.writeUInt16LE(20, 4)
  local.copy(central, 6, 4, 28)

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12)
  end.writeUInt32LE(local.length + name.length + compressed.length, 16)
  return new Blob([local, name, compressed, central, name, end])
}

function trackArchiveSlices(archive, slices) {
  slices.add(archive)
  const slice = archive.slice.bind(archive)
  archive.slice = (...args) => trackArchiveSlices(slice(...args), slices)
  return archive
}

for (const [label, method] of [['stored', 0], ['deflated', 8]]) {
  test(`ZIP ${label} entries do not keep an archive slice for IndexedDB`, async () => {
    const bytes = Buffer.from('tile bytes inside the archive')
    const slices = new WeakSet()
    const zip = trackArchiveSlices(singleEntryZip(bytes, method), slices)
    const entries = await readZip(zip)

    assert.equal(entries.length, 1)
    assert.equal(entries[0].blob.type, 'image/png')
    assert.deepEqual(Buffer.from(await entries[0].blob.arrayBuffer()), bytes)
    assert.equal(slices.has(entries[0].blob), false)
  })
}
