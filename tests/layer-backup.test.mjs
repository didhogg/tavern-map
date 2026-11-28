import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'

// Source files import siblings without an extension (resolved by Vite); let Node try `.ts`.
register(
  'data:text/javascript,' +
    encodeURIComponent(
      'export async function resolve(s, c, next) { try { return await next(s, c) } catch (error) {' +
        ' if (s.startsWith(".") && !/\\.[a-z]+$/.test(s)) return next(s + ".ts", c); throw error } }',
    ),
)

const memory = new Map()
globalThis.window = globalThis
globalThis.addEventListener ??= () => {}
globalThis.removeEventListener ??= () => {}
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
}

const notes = await import('../src/notes-store.ts')
const pins = await import('../src/layer-pin-store.ts')
const ai = await import('../src/layer-ai-store.ts')
const favorites = await import('../src/favorites-store.ts')
const store = await import('../src/layer-store.ts')
const backup = await import('../src/layer-backup.ts')
const { analyzeBundle, zipToBundle } = await import('../src/layer-source.ts')
const { readZip } = await import('../src/layer-zip.ts')

const URL_A = 'https://example.fandom.com/wiki/Riverwood'

function samplePackage() {
  return {
    id: 'pkg-a',
    name: '天际 测试',
    kind: 'tiles',
    source: 'mapgenie',
    sourceKey: 'mapgenie:test',
    nameLocked: true,
    width: 0,
    height: 0,
    categories: [{ id: 'c1', name: 'Town', color: '#fff' }],
    groups: [],
    markers: [
      { id: 'm1', name: '河木镇', categoryId: 'c1', x: 0.4, y: 0.5, sourceLinks: [{ id: 'l1', kind: 'source', title: 'Wiki', url: URL_A }] },
      { id: 'm2', name: '白漫城', categoryId: 'c1', x: 0.5, y: 0.4 },
    ],
    regions: [{ id: 'r1', name: '白漫领', points: [[0, 0], [1, 0], [1, 1]] }],
    streets: [{ id: 's1', name: '大路', type: 'Main', points: [[0, 0], [1, 1]], properties: [['fid', 'road-1'], ['Name', '大路']] }],
    grid: { size: 0.05, offsetX: 0, offsetY: 0, visible: true, unitAmount: 5, unitLabel: '米' },
    tile: { template: '', minZoom: 9, maxZoom: 10, xMin: 0, yMin: 0, count: 1, order: 'zyx' },
    tileFiles: {
      '9/0/0': new Blob(['tile-9-0-0'], { type: 'image/jpeg' }),
      '10/1/1': new Blob(['tile-10-1-1'], { type: 'image/png' }),
    },
    thumbnail: new Blob(['thumb'], { type: 'image/webp' }),
    iconFont: { family: 'mg', data: new Blob(['font-bytes'], { type: 'font/woff2' }) },
    createdAt: 1,
    updatedAt: 1,
  }
}

function seedPersonal(pkg) {
  notes.setGlobalNote(`layer:${pkg.id}:m1`, '河木镇的笔记')
  notes.setGlobalNote(`layer:${pkg.id}:region:r1`, '白漫领笔记')
  notes.setGlobalNote(`layer:${pkg.id}:road:name:大路|Main`, '大路笔记')
  notes.setGlobalNote(`layer:other-pkg:m1`, '别的地图的笔记')
  notes.setGlobalNote(`layer-source:${pkg.id}:m2`, '改过的来源资料')
  notes.setGlobalNote(`layer-linktext:${URL_A}`, '抓取的 Wiki 正文')
  notes.setGlobalNote('layer-linktext:https://unrelated.example/', '无关正文')
  pins.savePinEdits(pkg.id, {
    version: 1,
    overrides: { m2: { x: 0.51, y: 0.41 } },
    customPins: [{ id: 'custom-1', name: '营地', categoryId: pins.CUSTOM_PIN_CATEGORY_ID, x: 0.2, y: 0.2, custom: true, links: [], createdAt: 2, updatedAt: 2 }],
    history: { m2: { past: [{ x: 0.5, y: 0.4 }], future: [] } },
    updatedAt: 3,
  })
  ai.savePlaceAIFlags(pkg.id, { m1: { note: false }, 'region:r1': { note: true } })
  favorites.setFavorite({ key: favorites.layerFavoriteKey(pkg.id, 'm1'), kind: 'layer', mapId: pkg.id, mapName: pkg.name, markerId: 'm1', name: '河木镇', savedAt: 5 }, true)
}

const chat = {
  links: { m1: [{ id: 'u1', kind: 'custom', title: '我的链接', url: 'https://mine.example/' }], 'not-in-map': [{ id: 'x', kind: 'custom', title: 'x', url: 'https://x.example/' }] },
  position: { x: 0.4, y: 0.5, atPlaceId: 'm1' },
  view: { cx: 0.4, cy: 0.5, zoom: 10 },
}

await notes.initGlobalNotes()
seedPersonal(samplePackage())

async function exportZip(pkg, parts) {
  const personal = backup.collectBackupPersonal(pkg, chat)
  return backup.buildBackupZip(pkg, personal, parts, { date: new Date('2026-11-28T00:00:00Z') })
}

test('export collects only this map and counts every part', async () => {
  const pkg = samplePackage()
  const personal = backup.collectBackupPersonal(pkg, chat)
  assert.deepEqual(Object.keys(personal.notes).sort(), ['m1', 'region:r1', 'road:name:大路|Main'])
  assert.deepEqual(personal.sources, { m2: '改过的来源资料' })
  assert.deepEqual(personal.linkTexts, { [URL_A]: '抓取的 Wiki 正文' })
  assert.deepEqual(Object.keys(personal.links), ['m1'])
  assert.deepEqual(backup.countBackupParts(personal), { notes: 3, materials: 3, pins: 2, ai: 2, favorites: 1, chat: 2 })
})

test('backup zip round-trips the stored package unchanged, Blob types included', async () => {
  const pkg = samplePackage()
  const zip = await exportZip(pkg, backup.BACKUP_PARTS)
  const entries = await readZip(zip, { shouldRead: () => true })
  assert.ok(entries.some((entry) => entry.path === 'manifest.json'))
  assert.ok(entries.some((entry) => entry.path.endsWith('.woff2')))

  const preview = await analyzeBundle(await zipToBundle(new File([zip], 'x.tavern-map.zip')))
  assert.ok(preview.backup)
  assert.equal(preview.sourceLabel, 'Tavern Map 备份包')
  const restored = preview.pkg
  const plain = (value) => JSON.parse(JSON.stringify(value, (key, item) => (item instanceof Blob ? `blob:${item.type}:${item.size}` : item)))
  assert.deepEqual(plain(restored), plain(pkg))
  assert.equal(await restored.tileFiles['10/1/1'].text(), 'tile-10-1-1')
  assert.equal(restored.iconFont.data.type, 'font/woff2')
  assert.equal(await restored.iconFont.data.text(), 'font-bytes')
  assert.equal(preview.stats.tiles.count, 2)
  assert.deepEqual(preview.backup.counts, { notes: 3, materials: 3, pins: 2, ai: 2, favorites: 1, chat: 2 })
})

test('unticked parts stay out of the backup', async () => {
  const zip = await exportZip(samplePackage(), ['pins'])
  const preview = await analyzeBundle(await zipToBundle(new File([zip], 'x.zip')))
  assert.deepEqual(Object.keys(preview.backup.personal), ['pins'])
})

test('restore on a fresh device puts everything back under the new package', async () => {
  const pkg = samplePackage()
  const zip = await exportZip(pkg, backup.BACKUP_PARTS)
  // "Another device": nothing stored locally.
  memory.clear()
  for (const key of Object.keys(notes.globalNotesSnapshot())) notes.clearGlobalNote(key)
  await notes.flushGlobalNotes()

  const preview = await analyzeBundle(await zipToBundle(new File([zip], 'x.zip')))
  const saved = await store.saveImportedPackage(preview.pkg)
  const restoredChat = await backup.applyBackupPersonal(saved.pkg, preview.backup.personal, 'keep')
  const id = saved.pkg.id
  assert.equal(notes.globalNote(`layer:${id}:m1`), '河木镇的笔记')
  assert.equal(notes.globalNote(`layer:${id}:region:r1`), '白漫领笔记')
  assert.equal(notes.globalNote(`layer:${id}:road:name:大路|Main`), '大路笔记')
  assert.equal(notes.globalNote(`layer-source:${id}:m2`), '改过的来源资料')
  assert.equal(notes.globalNote(`layer-linktext:${URL_A}`), '抓取的 Wiki 正文')
  assert.equal(notes.globalNote('layer-linktext:https://unrelated.example/'), undefined)
  const restoredPins = pins.loadPinEdits(id)
  assert.deepEqual(restoredPins.overrides, { m2: { x: 0.51, y: 0.41 } })
  assert.deepEqual(restoredPins.customPins.map((pin) => pin.id), ['custom-1'])
  assert.deepEqual(ai.loadPlaceAIFlags(id), { m1: { note: false }, 'region:r1': { note: true } })
  const fav = favorites.listFavorites().find((item) => item.mapId === id)
  assert.equal(fav.key, favorites.layerFavoriteKey(id, 'm1'))
  assert.equal(fav.savedAt, 5)
  assert.deepEqual(Object.keys(restoredChat.links), ['m1'])
  assert.deepEqual(restoredChat.position, chat.position)
  const stored = await store.getLayerPackage(id)
  assert.equal(stored.grid.unitLabel, '米')
  assert.equal(Object.keys(stored.tileFiles).length, 2)
})

test('keep fills only gaps; replace lets the backup win but never deletes local-only items', async () => {
  const pkg = samplePackage()
  const zip = await exportZip(pkg, backup.BACKUP_PARTS)
  const preview = await analyzeBundle(await zipToBundle(new File([zip], 'x.zip')))
  const id = pkg.id
  notes.setGlobalNote(`layer:${id}:m1`, '本机改过的笔记')
  notes.setGlobalNote(`layer:${id}:m2`, '只有本机有的笔记')
  pins.savePinEdits(id, { version: 1, overrides: { m2: { x: 0.9, y: 0.9 } }, customPins: [], history: {}, updatedAt: 9 })

  await backup.applyBackupPersonal(pkg, preview.backup.personal, 'keep')
  assert.equal(notes.globalNote(`layer:${id}:m1`), '本机改过的笔记')
  assert.equal(notes.globalNote(`layer:${id}:region:r1`), '白漫领笔记')
  assert.deepEqual(pins.loadPinEdits(id).overrides.m2, { x: 0.9, y: 0.9 })
  assert.deepEqual(pins.loadPinEdits(id).customPins.map((pin) => pin.id), ['custom-1'])

  await backup.applyBackupPersonal(pkg, preview.backup.personal, 'replace')
  assert.equal(notes.globalNote(`layer:${id}:m1`), '河木镇的笔记')
  assert.equal(notes.globalNote(`layer:${id}:m2`), '只有本机有的笔记')
  assert.deepEqual(pins.loadPinEdits(id).overrides.m2, { x: 0.51, y: 0.41 })
})

test('a non-backup zip still goes through the normal importer', async () => {
  const { writeZip } = await import('../src/layer-zip.ts')
  const zip = await writeZip([{ path: 'readme.txt', blob: new Blob(['hi']) }, { path: 'map.json', blob: new Blob(['{"nope":1}']) }])
  await assert.rejects(analyzeBundle(await zipToBundle(new File([zip], 'y.zip'))), /既不像 Fandom|没有找到/)
})
