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
const { regionChain, regionsAtPoint } = await import('../src/layer-regions.ts')
const { buildLayerContext } = await import('../src/layer-context.ts')

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

test('a parent cycle stops instead of looping', () => {
  const a = box('a', 'A', 0, 0, 1, 1, 'b')
  const b = box('b', 'B', 0, 0, 1, 1, 'a')
  assert.deepEqual(regionChain([a, b], a, 0.5, 0.5).map((r) => r.id), ['a', 'b'])
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
