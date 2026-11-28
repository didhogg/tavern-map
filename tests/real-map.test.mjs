import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'

register(
  'data:text/javascript,' +
    encodeURIComponent(
      'export async function resolve(s, c, next) { try { return await next(s, c) } catch (error) {' +
        ' if (s.startsWith(".") && !/\\.[a-z]+$/.test(s)) return next(s + ".ts", c); throw error } }',
    ),
)
const { assignRoutePoisToSteps } = await import('../src/poi.ts')
const { buildContext } = await import('../src/context.ts')
const { currentRouteLeg, editableRoute, planPath } = await import('../src/real-itinerary.ts')
const { DEFAULT_SETTINGS } = await import('../src/settings.ts')

const start = { id: 'node/1', name: 'Start', lat: 0, lng: 0 }
const middle = { id: 'node/2', name: 'Middle', lat: 0, lng: 0.02 }
const end = { id: 'node/3', name: 'End', lat: 0.001, lng: 0 }
const cafe = { id: 'node/4', name: 'Mid-segment cafe', lat: 0.0002, lng: 0.01 }
const line = [{ coordinates: [[0, 0], [0.02, 0]] }, { coordinates: [[0.02, 0.0005], [0, 0.0005]] }]

test('corridor follows the interior of the line and can scope a POI to the current leg', () => {
  const byDistance = [[], []]
  const assigned = assignRoutePoisToSteps(line, [cafe], 40, byDistance)
  assert.equal(assigned[0][0].id, cafe.id)
  assert.equal(assigned[1].length, 0)
  assert.ok(assigned[0][0].alongM > 1100 && assigned[0][0].alongM < 1125)
  assert.equal(byDistance[1][0].id, cafe.id)
  assert.equal(assignRoutePoisToSteps(line, [cafe], 25)[1].length, 0)
})

const itinerary = {
  from: start, to: end, distance: 4400, duration: 0, profile: 'foot',
  steps: [], showToAI: true, updatedAt: 1, progress: 0.75,
  plan: {
    stops: [start, middle, end],
    legs: [
      { mode: 'manual', guide: [], distance: 2200, pois: [cafe] },
      { mode: 'snap', guide: [], distance: 2200, pois: [], poisInRange: [cafe] },
    ],
  },
}

test('editing a saved mixed route keeps a removable last station without mutating the saved route', () => {
  const draft = editableRoute(itinerary)
  draft.stops.pop()
  draft.legs.pop()
  assert.equal(planPath(draft).length, 2)
  assert.equal(itinerary.plan.stops.length, 3)
  assert.equal(currentRouteLeg(itinerary), 1)
})

test('nearby context stays with the current place and current-leg POIs take their own range', () => {
  const state = {
    center: start, centerUpdatedAt: 1, place: start, nearby: [cafe],
    stars: [], savedPlaces: [], itinerary,
  }
  const settings = { ...DEFAULT_SETTINGS, radiusM: 1500, realRouteCurrentOnly: true }
  const context = buildContext(state, settings)
  assert.ok(context.indexOf('Current place:') < context.indexOf('Nearby ('))
  assert.ok(context.indexOf('Nearby (') < context.indexOf('Itinerary:'))
  const [first, second] = context.split('2. Middle → End')
  assert.equal(first.split('POIs in range:').length, 1)
  assert.match(second, /POIs in range:\n   - Mid-segment cafe/)
})

test('a global content change clears the matching manual choices on every package and preserves other parts', async () => {
  const { saveSettings } = await import('../src/settings.ts')
  const { loadPlaceAIFlags, savePlaceAIFlags } = await import('../src/layer-ai-store.ts')
  const storage = new Map()
  const previousStorage = globalThis.localStorage
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  }
  try {
    savePlaceAIFlags('one', { museum: { note: true, source: false }, 'road:street': { note: true } })
    savePlaceAIFlags('two', { park: { note: false }, 'region:ward': { note: true } })
    const ctx = { extensionSettings: {} }
    saveSettings(ctx, { ...DEFAULT_SETTINGS, layerNoteAI: false })
    assert.deepEqual(loadPlaceAIFlags('one'), { museum: { source: false }, 'road:street': { note: true } })
    assert.deepEqual(loadPlaceAIFlags('two'), { 'region:ward': { note: true } })
    savePlaceAIFlags('one', { ...loadPlaceAIFlags('one'), library: { note: true } })
    saveSettings(ctx, { ...DEFAULT_SETTINGS, layerNoteAI: true, layerRegionNoteAI: false })
    assert.deepEqual(loadPlaceAIFlags('one'), { museum: { source: false }, 'road:street': { note: true } })
    assert.deepEqual(loadPlaceAIFlags('two'), {})
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previousStorage
  }
})
