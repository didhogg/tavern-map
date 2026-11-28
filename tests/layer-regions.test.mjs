import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'

register(
  'data:text/javascript,' +
    encodeURIComponent(
      'export async function resolve(s, c, next) { try { return await next(s, c) } catch (error) {' +
        ' if (s.startsWith(".") && !/\\.[a-z]+$/.test(s)) return next(s + ".ts", c); throw error } }',
    ),
)
const { itineraryRegions, regionChain, regionsAtPoint, regionsNearPolyline } = await import('../src/layer-regions.ts')
const { buildLayerContext } = await import('../src/layer-context.ts')
const { LAYER_STATE_KEY, loadLayerState } = await import('../src/layer-types.ts')

const box = (id, name, x0, y0, x1, y1, parentId) => ({
  id,
  name,
  parentId,
  polygons: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
})

const hold = box('hold', '白漫领 Whiterun Hold', 0, 0, 1, 1)
const town = box('town', '河木镇 Riverwood', 0.4, 0.4, 0.5, 0.5, 'hold')
const tundra = box('tundra', '白漫城苔原 Whiterun Tundra', 0.6, 0.6, 0.7, 0.7)
const regions = [town, hold, tundra]

test('smallest containing region comes first', () => {
  assert.deepEqual(regionsAtPoint(regions, 0.45, 0.45).map((item) => item.region.id), ['town', 'hold'])
})

test('declared parent is used', () => {
  assert.deepEqual(regionChain(regions, town, 0.45, 0.45).map((r) => r.id), ['town', 'hold'])
})

test('a region without a declared parent falls back to the larger polygon around the point', () => {
  assert.deepEqual(regionChain(regions, tundra, 0.65, 0.65).map((r) => r.id), ['tundra', 'hold'])
})

test('stored Map Genie parent IDs resolve even outside the parent boundary', () => {
  const parent = box('mapgenie-region:hold', 'Hold', 0, 0, 1, 1)
  const child = box('mapgenie-region:town', 'Town', 0.9, 0.9, 1.1, 1.1, 'hold')
  assert.deepEqual(regionChain([child, parent], child, 1.05, 1.05), [child, parent])
})

test('a parent cycle stops instead of looping', () => {
  const a = box('a', 'A', 0, 0, 1, 1, 'b')
  const b = box('b', 'B', 0, 0, 1, 1, 'a')
  assert.deepEqual(regionChain([a, b], a, 0.5, 0.5).map((r) => r.id), ['a', 'b'])
})

test('itinerary range finds crossed and nearby polygons along the actual bent route', () => {
  const crossing = box('crossing', 'Crossing', 0.3, 0.49, 0.4, 0.51)
  const near = box('near', 'Near', 0.5, 0.53, 0.6, 0.55)
  const far = box('far', 'Far', 0.5, 0.57, 0.6, 0.59)
  const chord = box('chord', 'Chord', 0.3, 0.29, 0.4, 0.31)
  const points = [{ x: 0.1, y: 0.3 }, { x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }, { x: 0.9, y: 0.3 }]
  const options = [hold, crossing, near, far, chord]
  assert.deepEqual(regionsNearPolyline(options, points, 0.04).map((region) => region.id), ['hold', 'crossing', 'near'])
  assert.deepEqual(regionsNearPolyline(options, points, 0.04, 2).map((region) => region.id), ['hold', 'crossing'])
})

test('a region with multiple rings appears once, including when the route touches its closing edge', () => {
  const region = {
    id: 'area', name: 'Area',
    polygons: [
      [[0.3, 0.3], [0.5, 0.3], [0.5, 0.6], [0.3, 0.6]],
      [[0.4, 0.4], [0.6, 0.4], [0.6, 0.5], [0.4, 0.5]],
    ],
  }
  const start = { x: 0, y: 0.45 }
  assert.deepEqual(regionsNearPolyline([region], [start, { x: 0.3, y: 0.45 }], 0), [region])
  assert.deepEqual(regionsNearPolyline([region], [start, { x: 0.8, y: 0.45 }], 0), [region])
})

const west = box('west', 'West Hold', 0, 0, 0.5, 1)
const east = box('east', 'East Hold', 0.5, 0, 1, 1)
const westTown = box('west-town', 'West Town', 0.3, 0.2, 0.4, 0.3, west.id)
const eastTown = box('east-town', 'East Town', 0.65, 0.2, 0.75, 0.3)
const holds = [west, east, westTown, eastTown]
const path = (...points) => points.map(([x, y]) => ({ x, y }))
const listedAreas = (legs, radius = 0) => itineraryRegions(holds, legs, radius).map((leg) => leg.map((r) => r.id))

test('a single-hold route shows local areas, even when the POI band overlaps the next hold', () => {
  assert.deepEqual(listedAreas([path([0.1, 0.25], [0.48, 0.25])], 0.1), [[westTown.id]])
  assert.deepEqual(listedAreas([path([0.55, 0.25], [0.9, 0.25])]), [[eastTown.id]])
})

test('the actual bend can leave and re-enter its starting hold even with both stops inside', () => {
  assert.deepEqual(listedAreas([path([0.2, 0.4], [0.7, 0.4], [0.2, 0.6])]), [[west.id, east.id]])
  assert.deepEqual(listedAreas([path([0.1, 0.25], [0.9, 0.25])]), [[west.id, east.id, westTown.id, eastTown.id]])
})

test('tangency and travel along a boundary do not count as changing holds', () => {
  assert.deepEqual(listedAreas([path([0.2, 0.4], [0.5, 0.45], [0.5, 0.6], [0.2, 0.6])]), [[]])
})

test('a change at a waypoint is only listed on the leg entering the next hold', () => {
  assert.deepEqual(listedAreas([
    path([0.2, 0.6], [0.5, 0.6]),
    path([0.5, 0.6], [0.7, 0.6]),
    path([0.7, 0.6], [0.9, 0.6]),
  ]), [[], [west.id, east.id], []])
})

test('AI text names the enclosing areas and area notes', () => {
  const text = buildLayerContext({
    version: 1,
    context: {
      mapName: 'Skyrim',
      position: { x: 0.45, y: 0.45, region: '河木镇 Riverwood', regionParents: ['白漫领 Whiterun Hold'] },
      areaNotes: [{ name: '白漫领 Whiterun Hold', text: '内战前线' }],
      updatedAt: 1,
    },
  })
  assert.match(text, /Area: 河木镇 Riverwood \(in 白漫领 Whiterun Hold\)/)
  assert.match(text, /Area note \(白漫领 Whiterun Hold\): 内战前线/)
})

test('a ticked area elsewhere is sent as another area note', () => {
  const text = buildLayerContext({
    version: 1,
    context: {
      mapName: 'Skyrim',
      areaNotes: [
        { name: '白漫领 Whiterun Hold', text: '内战前线' },
        { name: '裂谷城 Riften', text: '盗贼公会', other: true },
      ],
      updatedAt: 1,
    },
  })
  assert.match(text, /^Area note \(白漫领 Whiterun Hold\): 内战前线\nOther area note \(裂谷城 Riften\): 盗贼公会$/m)
})

test('itinerary areas and optional notes survive reloading the chat context', () => {
  const leg = { from: 'Start', to: 'End', distance: '5 格', pois: [] }
  const state = loadLayerState({
    chatMetadata: { [LAYER_STATE_KEY]: {
      version: 1,
      context: {
        mapName: 'Skyrim',
        itinerary: {
          start: 'Start', destination: 'End', total: '5 格', stops: ['Start', 'End'],
          legs: [{ ...leg, areas: [
            { name: '河木镇', note: '伐木场' },
            { name: '白漫领' },
            { name: '白漫城', note: 123 },
            null,
          ] }],
        },
      },
    } },
  })
  assert.match(buildLayerContext(state), /Areas in range:\n   - 河木镇 · note: 伐木场\n   - 白漫领\n   - 白漫城\n/)
})
