import assert from 'node:assert/strict'
import test from 'node:test'
import { distanceUnitText, formatCellDistance, gridCellDistance } from '../src/layer-distance.ts'

const grid = (unitValue, unitLabel) => ({ originX: 0, originY: 0, cellW: 0.01, cellH: 0.01, unitValue, unitLabel })

test('distance keeps the cell count next to the converted amount', () => {
  assert.equal(formatCellDistance(9, grid(5, '米')), '≈ 45 米（9.0 格）')
  assert.equal(formatCellDistance(12.34, grid(0.5, '里')), '≈ 6.17 里（12.3 格）')
  assert.equal(formatCellDistance(300, grid(2, '公里')), '≈ 600 公里（300.0 格）')
})

test('without a conversion only cells are shown', () => {
  assert.equal(formatCellDistance(9, grid(1, '格')), '9.0 格')
  assert.equal(formatCellDistance(9, undefined), '9.0 格')
  assert.equal(distanceUnitText(grid(1, '格')), undefined)
  assert.equal(distanceUnitText(grid(5, '米')), '1 格 ≈ 5 米')
})

test('cell distance uses the grid cell size', () => {
  assert.equal(gridCellDistance({ x: 0, y: 0 }, { x: 0.03, y: 0.04 }, grid(1, '格')), 5)
})
