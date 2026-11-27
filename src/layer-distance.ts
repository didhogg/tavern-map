import type { LayerGridConfig } from './layer-types'

/**
 * Grid distances are measured in cells. The grid's unitValue/unitLabel is a
 * plain display conversion ("1 cell ≈ 5 米"); it never changes the grid itself
 * or the cell coordinates. One formatter serves the map UI and the AI context
 * so both always show the same text.
 */
export function hasDistanceUnit(grid: LayerGridConfig | undefined): grid is LayerGridConfig {
  if (!grid) return false
  const label = grid.unitLabel?.trim() ?? ''
  return Number.isFinite(grid.unitValue) && grid.unitValue > 0 && label !== '' && label !== '格'
}

/** Distance between two map points, in grid cells. */
export function gridCellDistance(
  from: { x: number; y: number },
  to: { x: number; y: number },
  grid: LayerGridConfig,
): number {
  return Math.hypot((to.x - from.x) / grid.cellW, (to.y - from.y) / grid.cellH)
}

function roundAmount(value: number): string {
  const size = Math.abs(value)
  if (size >= 100) return String(Math.round(value))
  if (size >= 10) return value.toFixed(1).replace(/\.0$/, '')
  return value.toFixed(2).replace(/0$/, '').replace(/\.0$/, '')
}

/** "≈ 45 米（9.0 格）" with a conversion, otherwise "9.0 格". */
export function formatCellDistance(cells: number, grid: LayerGridConfig | undefined): string {
  const cellText = `${cells.toFixed(1)} 格`
  if (!hasDistanceUnit(grid)) return cellText
  return `≈ ${roundAmount(cells * grid.unitValue)} ${grid.unitLabel.trim()}（${cellText}）`
}

/** "1 格 ≈ 5 米", or undefined when there is no conversion. */
export function distanceUnitText(grid: LayerGridConfig | undefined): string | undefined {
  if (!hasDistanceUnit(grid)) return undefined
  return `1 格 ≈ ${roundAmount(grid.unitValue)} ${grid.unitLabel.trim()}`
}
