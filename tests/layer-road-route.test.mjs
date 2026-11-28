import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { register } from 'node:module'
import test from 'node:test'

register(
  'data:text/javascript,' +
    encodeURIComponent(
      'export async function resolve(s, c, next) { try { return await next(s, c) } catch (error) {' +
        ' if (s.startsWith(".") && !/\\.[a-z]+$/.test(s)) return next(s + ".ts", c); throw error } }',
    ),
)
const { buildRoadGraph, roadRoute, roadsNearPolyline } = await import('../src/layer-road-route.ts')
const { polylineCumulative, polylineSlice, projectOnPolyline } = await import('../src/layer-polyline.ts')
const { roadsNearPoint, buildRoadIndex } = await import('../src/layer-roads.ts')
const { buildLayerContext } = await import('../src/layer-context.ts')
const { LAYER_STATE_KEY, loadLayerState } = await import('../src/layer-types.ts')

const street = (id, points, name = id, type = 'Main') => ({ id, name, type, points })
const kinds = (pieces) => pieces.map((p) => (p.kind === 'road' ? `road:${p.street}` : 'straight'))

test('route walks to the road, follows it through a junction and walks off', () => {
  // A: west-east road; B: north from A's end (shared vertex).
  const streets = [street('A', [[0, 0.5], [0.5, 0.5]]), street('B', [[0.5, 0.5], [0.5, 0]])]
  const pieces = roadRoute(buildRoadGraph(streets), { x: 0.1, y: 0.55 }, { x: 0.55, y: 0.1 })
  assert.deepEqual(kinds(pieces), ['straight', 'road:0', 'road:1', 'straight'])
  assert.deepEqual(pieces[1].points[0], { x: 0.1, y: 0.5 })
  const end = pieces[2].points.at(-1)
  assert.ok(Math.abs(end.x - 0.5) < 1e-9 && Math.abs(end.y - 0.1) < 1e-9)
})

test('a road end touching the middle of another road is joined (T-junction)', () => {
  const streets = [street('A', [[0, 0.5], [1, 0.5]]), street('B', [[0.5, 0.5000001], [0.5, 0]])]
  const pieces = roadRoute(buildRoadGraph(streets), { x: 0.05, y: 0.5 }, { x: 0.5, y: 0.05 })
  assert.deepEqual(kinds(pieces).filter((k) => k !== 'straight'), ['road:0', 'road:1'])
})

test('disconnected roads: the gap between them is walked straight', () => {
  const streets = [street('A', [[0, 0.5], [0.4, 0.5]]), street('B', [[0.6, 0.5], [1, 0.5]])]
  const pieces = roadRoute(buildRoadGraph(streets), { x: 0.05, y: 0.5 }, { x: 0.95, y: 0.5 })
  assert.deepEqual(kinds(pieces), ['road:0', 'straight', 'road:1'])
  assert.deepEqual(pieces[1].points, [{ x: 0.4, y: 0.5 }, { x: 0.6, y: 0.5 }])
})

test('shortest way is chosen when two roads connect the same places', () => {
  const streets = [
    street('short', [[0, 0], [1, 0]]),
    street('long', [[0, 0], [0.5, 0.8], [1, 0]]),
  ]
  const pieces = roadRoute(buildRoadGraph(streets), { x: 0, y: 0 }, { x: 1, y: 0 })
  assert.deepEqual(kinds(pieces), ['road:0'])
})

test('no roads: no route', () => {
  assert.equal(roadRoute(buildRoadGraph([]), { x: 0, y: 0 }, { x: 1, y: 1 }), undefined)
})

test('roads near a line and near a point', () => {
  const streets = [street('near', [[0, 0.52], [1, 0.52]]), street('far', [[0, 0.9], [1, 0.9]])]
  const index = buildRoadIndex(streets)
  const line = [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }]
  assert.deepEqual(roadsNearPolyline(index, line, 0.05).map((r) => r.streetIndex), [0])
  assert.deepEqual(roadsNearPoint(index, 0.5, 0.5, 0.5).map((r) => r.streetIndex), [0, 1])
})

test('polyline projection and slices measure along the line', () => {
  const points = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]
  const cumulative = polylineCumulative(points)
  assert.deepEqual(cumulative, [0, 1, 2])
  const projection = projectOnPolyline({ x: 1.2, y: 0.5 }, points, cumulative)
  assert.equal(projection.along, 1.5)
  assert.deepEqual(polylineSlice(points, cumulative, 0.5, 1.5), [{ x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.5 }])
})

test('AI text shows nearby roads, leg route with road changes and roads in range', () => {
  const text = buildLayerContext({
    version: 1,
    context: {
      mapName: 'Skyrim',
      position: { x: 0.5, y: 0.5, road: { name: 'A 大路', type: 'Main', on: true, distancePercent: 0 } },
      currentPlace: '河木镇贸易商行',
      note: '店里可补给',
      areaNotes: [{ name: '河木镇', text: '车马停在村外' }],
      nearbyRoads: [
        { name: 'A 大路', type: 'Main', on: true, distancePercent: 0 },
        { name: 'B 小径', type: 'Path', on: false, distancePercent: 1.2, direction: 'N' },
      ],
      nearby: [{ id: 'inn', name: '沉睡巨人旅店', x: 0.5, y: 0.51, direction: 'S', distancePercent: 1 }],
      nearbyScope: 'radius',
      itinerary: {
        start: '河木镇', destination: '白漫城', total: '5.0 格', stops: ['河木镇', '白漫城'],
        current: { legIndex: 0, progress: 40, from: '河木镇', to: '白漫城', remaining: '3.0 格', road: 'A 大路' },
        legs: [{
          from: '河木镇', to: '白漫城', distance: '5.0 格', current: true, mode: 'road',
          route: [
            { kind: 'straight', distance: '0.3 格' },
            { kind: 'road', name: 'A 大路', type: 'Main', distance: '3.1 格' },
            { kind: 'road', name: 'B 小径', type: 'Path', distance: '1.0 格' },
            { kind: 'straight', distance: '0.6 格' },
          ],
          roads: [{ name: 'C 小径', type: 'Path', distance: '0.8 格' }],
          areas: [{ name: '河木镇', note: '村中巡逻' }],
          pois: [{ name: '沉睡巨人旅店', category: '门', note: '记得问店主' }],
        }],
      },
      updatedAt: 1,
    },
  })
  assert.match(text, /On road: A 大路 \(Main\)/)
  assert.match(text, /Nearby roads \(within radius\):\n- A 大路 \(Main\) — on it\n- B 小径 \(Path\) — 1.20% · N/)
  assert.match(text, /Current place note: 店里可补给\nArea note \(河木镇\): 车马停在村外\nNearby roads \(within radius\):/)
  assert.match(text, /Nearby \(nearest 1, within radius\):\n- 沉睡巨人旅店 — 1\.00% · S\n\nItinerary:\n/)
  assert.match(text, /Current: leg 1\/1 · 40% traveled · on A 大路/)
  assert.match(text, /1\. 河木镇 → 白漫城 · 5.0 格 · along roads \[current\]/)
  assert.match(text, /Route: 0.3 格 straight to road → A 大路 \(Main\) 3.1 格 → switch to B 小径 \(Path\) 1.0 格 → 0.6 格 straight to stop/)
  assert.match(text, /Roads in range: C 小径 \(Path\) · 0.8 格 from route/)
  assert.match(text, /POIs in range:\n   - 沉睡巨人旅店 \(门\)\n     Note: 记得问店主\n   Areas in range:\n   - 河木镇 · note: 村中巡逻/)
})

test('the itinerary reports arrival only when stored progress confirms the destination', () => {
  const itinerary = {
    start: 'Start', destination: 'End', total: '5 格', stops: ['Start', 'End'],
    legs: [{ from: 'Start', to: 'End', distance: '5 格', pois: [] }],
  }
  const render = (progress) => buildLayerContext(loadLayerState({
    chatMetadata: {
      [LAYER_STATE_KEY]: {
        version: 1,
        context: { mapName: 'Skyrim', itinerary: { ...itinerary, ...progress } },
      },
    },
  }))
  assert.doesNotMatch(render({}), /at destination|completed/)
  assert.match(render({ nextStop: 'Start' }), /Current: not started\nNext stop: Start/)
  assert.match(render({ atDestination: true }), /Current: at destination/)
})

test('itinerary POI source and note survive reloading chat metadata independently', () => {
  const state = loadLayerState({
    chatMetadata: {
      [LAYER_STATE_KEY]: {
        version: 1,
        context: {
          mapName: 'Skyrim',
          itinerary: {
            start: 'Start', destination: 'End', total: '5 格', stops: ['Start', 'End'],
            legs: [{ from: 'Start', to: 'End', distance: '5 格', pois: [
              { name: 'Mine', sourceMaterial: 'Imported\nreference' },
              { name: 'Inn', note: 'Ask for the key', sourceMaterial: {} },
              { name: 'Farm', note: 42 },
            ] }],
          },
        },
      },
    },
  })
  assert.match(buildLayerContext(state), /- Mine\n     Source: Imported reference\n   - Inn\n     Note: Ask for the key\n   - Farm\n/)
})

const peek = '/private/tmp/claude-501/-Users-xxx/12e271b9-cf7f-4da8-ae9b-b0fa92327e4a/scratchpad/peek'
test('Skyrim pack: Windhelm to Markarth follows roads end to end', { skip: !existsSync(peek) }, () => {
  const data = JSON.parse(readFileSync(`${peek}/${readdirSync(peek)[0]}/mapdata.json`, 'utf8'))
  const streets = (data.streets.features ?? data.streets).map((f, i) =>
    street(String(i), f.geometry.coordinates, f.properties.Name, f.properties.Type))
  const place = (title) => {
    const item = data.locations.find((l) => l.title === title)
    return { x: item.longitude, y: item.latitude }
  }
  const pieces = roadRoute(buildRoadGraph(streets), place('风舵城 Windhelm'), place('马卡斯城 Markarth'))
  const inner = pieces.slice(1, -1)
  assert.ok(inner.length > 5)
  assert.ok(inner.every((piece) => piece.kind === 'road'), 'no straight gap between the two cities')
})
