import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { register } from 'node:module'
import test from 'node:test'
import { parseMapGeniePackage } from '../src/layer-import.ts'
import { buildRoadIndex, nearestRoad, roadRank, roadsInRect } from '../src/layer-roads.ts'

// Source files import siblings without an extension (resolved by Vite); let Node try `.ts`.
register(
  'data:text/javascript,' +
    encodeURIComponent(
      'export async function resolve(s, c, next) { try { return await next(s, c) } catch (error) {' +
        ' if (s.startsWith(".") && !/\\.[a-z]+$/.test(s)) return next(s + ".ts", c); throw error } }',
    ),
)
const { buildLayerContext } = await import('../src/layer-context.ts')

const street = (id, type, points, name = id) => ({ id, name, type, points })

test('road rank understands Tych, Skyrim pack and OSM-style types', () => {
  for (const type of ['Main', 'main', 'primary', 'trunk', 'motorway', 'highway']) assert.equal(roadRank(type), 0, type)
  for (const type of ['Major', 'secondary', 'tertiary']) assert.equal(roadRank(type), 1, type)
  for (const type of ['Minor', 'Path', 'footway', 'residential', '', undefined]) assert.equal(roadRank(type), 2, String(type))
})

test('nearest road from the index matches a brute-force scan', () => {
  let seed = 7
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const streets = Array.from({ length: 300 }, (_, index) => {
    let x = random()
    let y = random()
    const points = [[x, y]]
    for (let step = 0; step < 6; step += 1) points.push([(x += (random() - 0.5) * 0.05), (y += (random() - 0.5) * 0.05)])
    return street(`s${index}`, 'Minor', points)
  })
  const index = buildRoadIndex(streets)
  const brute = (px, py, max) => {
    let best
    for (const s of streets) {
      for (let i = 1; i < s.points.length; i += 1) {
        const [ax, ay] = s.points[i - 1]
        const [bx, by] = s.points[i]
        const dx = bx - ax
        const dy = by - ay
        const len = dx * dx + dy * dy
        const t = len ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len)) : 0
        const d = Math.hypot(px - (ax + dx * t), py - (ay + dy * t))
        if (d <= max && (!best || d < best.d)) best = { s, d }
      }
    }
    return best
  }
  for (let probe = 0; probe < 400; probe += 1) {
    const px = random()
    const py = random()
    const expected = brute(px, py, 0.03)
    const actual = nearestRoad(index, px, py, 0.03)
    assert.equal(actual?.street.id, expected?.s.id)
    if (expected) assert.ok(Math.abs(actual.distance - expected.d) < 1e-12)
  }
})

test('image maps measure Y in the same unit as X', () => {
  // A horizontal road 0.1 below the point in Y, on an image twice as tall as wide.
  const index = buildRoadIndex([street('h', 'Main', [[0, 0.6], [1, 0.6]])], 2)
  const road = nearestRoad(index, 0.5, 0.5, 1)
  assert.ok(Math.abs(road.distance - 0.2) < 1e-12)
  assert.ok(Math.abs(road.y - 0.6) < 1e-12)
  assert.equal(nearestRoad(index, 0.5, 0.5, 0.19), undefined)
})

test('only roads overlapping the view are drawn', () => {
  const index = buildRoadIndex([
    street('in', 'Main', [[0.1, 0.1], [0.2, 0.2]]),
    street('crossing', 'Main', [[0, 0.5], [1, 0.5]]),
    street('out', 'Main', [[0.8, 0.8], [0.9, 0.9]]),
  ])
  assert.deepEqual(roadsInRect(index, { minX: 0.05, minY: 0.05, maxX: 0.6, maxY: 0.6 }), [0, 1])
})

test('road GeoJSON: FeatureCollection, other name/type keys, unnamed lines kept', () => {
  const pkg = parseMapGeniePackage(
    {
      locations: [{ id: 1, title: 'A', latitude: 0, longitude: 0, category_id: 1 }],
      categories: [{ id: 1, title: 'Place' }],
      roads: {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', id: 'w1', properties: { name: 'High Road', highway: 'primary' }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
          { type: 'Feature', properties: { class: 'footway' }, geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [0, 1]], [[1, 0], [1, 1]]] } },
          { type: 'Feature', properties: { NAME: 'Point' }, geometry: { type: 'Point', coordinates: [0, 0] } },
        ],
      },
    },
    { tileTemplate: 'https://example.invalid/{z}/{x}/{y}.png' },
  )
  assert.equal(pkg.streets.length, 3)
  assert.deepEqual(pkg.streets.map((s) => [s.name, s.type]), [['High Road', 'primary'], ['', 'footway'], ['', 'footway']])
  assert.equal(pkg.streets[0].id, 'mapgenie-street:w1:0')
})

test('AI context says which road I am on, or the nearest one', () => {
  const base = { version: 1, context: { mapName: 'Skyrim', updatedAt: 1 } }
  const on = buildLayerContext({
    ...base,
    context: { ...base.context, position: { x: 0.5, y: 0.5, road: { name: '白漫 – 河木鎮 大路', type: 'Main', on: true, distancePercent: 0.1 } } },
  })
  assert.match(on, /^On road: 白漫 – 河木鎮 大路 \(Main\)$/m)
  const grid = { originX: 0, originY: 0, cellW: 0.01, cellH: 0.01, unitValue: 58, unitLabel: '米' }
  const near = buildLayerContext({
    ...base,
    context: { ...base.context, grid, position: { x: 0.5, y: 0.5, road: { name: '', type: 'Path', on: false, distancePercent: 2, distanceCells: 2, direction: 'NE' } } },
  })
  assert.match(near, /^Nearest road: unnamed road \(Path\) — ≈ 116 米（2\.0 格） · NE$/m)
})

const tych = '/Users/xxx/Downloads/TavernMap-Packages/TavernMap-Tych-Waterdeep.zip'
test('real Tych Waterdeep streets keep every line, named or not', { skip: !existsSync(tych) }, async () => {
  const { execFileSync } = await import('node:child_process')
  const raw = JSON.parse(execFileSync('unzip', ['-p', tych, 'mapdata.json'], { maxBuffer: 64 << 20 }).toString())
  const pkg = parseMapGeniePackage(raw, { tileSetIndex: 0 })
  assert.equal(pkg.streets.length, raw.streets.length)
  assert.equal(pkg.streets.filter((s) => !s.name).length, raw.streets.filter((f) => !f.properties.Name).length)
})
