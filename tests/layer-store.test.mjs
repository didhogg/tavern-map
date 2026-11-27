import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'

// Count every write that carries tile blobs, whichever store it goes to, so
// the tests can tell whether a save re-stored the tiles.
let tileWrites = 0
const originalPut = IDBObjectStore.prototype.put
IDBObjectStore.prototype.put = function (value, ...rest) {
  if (value && typeof value === 'object' && value.tileFiles && Object.keys(value.tileFiles).length) {
    tileWrites += 1
  }
  return originalPut.call(this, value, ...rest)
}
const assetPuts = () => tileWrites

function tilePackage(id, tileCount = 3) {
  const tileFiles = {}
  for (let i = 0; i < tileCount; i += 1) {
    tileFiles[`5/${i}/0`] = new Blob([`tile ${i}`], { type: 'image/png' })
  }
  return {
    id,
    name: id,
    kind: 'tiles',
    source: 'files',
    width: 0,
    height: 0,
    markers: [],
    categories: [],
    regions: [],
    tileFiles,
    tile: { template: '', minZoom: 5, maxZoom: 5, xMin: 0, yMin: 0, count: 1 },
    createdAt: 1,
    updatedAt: 1,
  }
}

async function tileText(pkg, key) {
  return pkg.tileFiles[key].text()
}

// Must run first: writes a package the way 0.7.1 and earlier stored it
// (database version 1, tiles inline in the package record).
test('a pre-0.7.2 package keeps its tiles and moves them out of the record once', async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.open('tavern-map-layer', 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('packages', { keyPath: 'id' })
      request.result.createObjectStore('meta', { keyPath: 'id' })
    }
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('packages', 'readwrite')
      tx.objectStore('packages').put(tilePackage('legacy'))
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    }
    request.onerror = () => reject(request.error)
  })

  const store = await import('../src/layer-store.ts')
  const before = await store.getLayerPackage('legacy')
  assert.equal(Object.keys(before.tileFiles).length, 3)

  const firstAssets = assetPuts()
  const updated = await store.updateLayerPackage('legacy', {
    grid: { originX: 0, originY: 0, cellW: 1, cellH: 1, unitValue: 10, unitLabel: '米' },
  })
  assert.equal(updated.grid.unitLabel, '米')
  assert.equal(assetPuts(), firstAssets + 1, 'first save moves the inline tiles once')

  await store.updateLayerPackage('legacy', { name: 'renamed' })
  assert.equal(assetPuts(), firstAssets + 1, 'later setting saves leave the tiles alone')

  const after = await store.getLayerPackage('legacy')
  assert.equal(after.name, 'renamed')
  assert.equal(after.grid.unitValue, 10)
  assert.equal(await tileText(after, '5/2/0'), 'tile 2')
})

test('changing a setting does not rewrite tile assets', async () => {
  const store = await import('../src/layer-store.ts')
  await store.putLayerPackage(tilePackage('fresh'))
  const baseline = assetPuts()
  for (const unitValue of [2, 5, 10]) {
    await store.updateLayerPackage('fresh', {
      grid: { originX: 0, originY: 0, cellW: 1, cellH: 1, unitValue, unitLabel: '里' },
    })
  }
  assert.equal(assetPuts(), baseline)
  const pkg = await store.getLayerPackage('fresh')
  assert.equal(pkg.grid.unitValue, 10)
  assert.equal(pkg.grid.unitLabel, '里')
  assert.equal(Object.keys(pkg.tileFiles).length, 3)
})

test('overlapping saves all succeed and the last edit wins', async () => {
  const store = await import('../src/layer-store.ts')
  await store.putLayerPackage(tilePackage('overlap'))
  const saves = [1, 2, 3, 4, 5].map((unitValue) =>
    store.updateLayerPackage('overlap', {
      grid: { originX: 0, originY: 0, cellW: 1, cellH: 1, unitValue, unitLabel: '步' },
    }),
  )
  const results = await Promise.all(saves)
  assert.ok(results.every(Boolean))
  const pkg = await store.getLayerPackage('overlap')
  assert.equal(pkg.grid.unitValue, 5)
})

test('replacing or removing tiles still stores the new tiles', async () => {
  const store = await import('../src/layer-store.ts')
  await store.putLayerPackage(tilePackage('swap'))
  const replacement = { '6/0/0': new Blob(['new tile'], { type: 'image/png' }) }
  await store.setLayerTiles('swap', replacement, { template: '', minZoom: 6, maxZoom: 6, xMin: 0, yMin: 0, count: 1 })
  const swapped = await store.getLayerPackage('swap')
  assert.deepEqual(Object.keys(swapped.tileFiles), ['6/0/0'])
  assert.equal(await tileText(swapped, '6/0/0'), 'new tile')

  await store.setLayerTiles('swap', undefined, undefined)
  const cleared = await store.getLayerPackage('swap')
  assert.equal(cleared.tileFiles, undefined)
})

test('deleting a package removes its assets too', async () => {
  const store = await import('../src/layer-store.ts')
  await store.putLayerPackage(tilePackage('gone'))
  await store.deleteLayerPackage('gone')
  assert.equal(await store.getLayerPackage('gone'), undefined)
  const leftover = await new Promise((resolve, reject) => {
    const request = indexedDB.open('tavern-map-layer')
    request.onsuccess = () => {
      const db = request.result
      const get = db.transaction('assets').objectStore('assets').get('gone')
      get.onsuccess = () => {
        db.close()
        resolve(get.result)
      }
      get.onerror = () => reject(get.error)
    }
  })
  assert.equal(leftover, undefined)
})
