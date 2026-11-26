import type { LayerMapPackage } from './layer-types'

/** Derive the Map Genie game slug from tile paths or the original page URL. */
export function mapGenieGameSlug(pkg: LayerMapPackage): string | undefined {
  const candidates = [
    pkg.tile?.remoteTemplate,
    pkg.tile?.template,
    pkg.sourceUrl,
  ].filter((value): value is string => Boolean(value?.trim()))
  for (const candidate of candidates) {
    const tileMatch = /\/games\/([^/?#]+)/i.exec(candidate)
    if (tileMatch?.[1]) return tileMatch[1]
    const pageMatch = /mapgenie\.io\/([^/?#]+)/i.exec(candidate)
    if (pageMatch?.[1] && pageMatch[1] !== 'maps') return pageMatch[1]
  }
  return undefined
}

/**
 * Best-effort download of Map Genie's original category icon font.
 * The package still works with colored dots when this is unavailable.
 */
export async function downloadMapGenieIconFont(
  pkg: LayerMapPackage,
  signal?: AbortSignal,
): Promise<LayerMapPackage['iconFont'] | undefined> {
  if (pkg.source !== 'mapgenie') return undefined
  const icons = new Set(
    pkg.categories
      .map((category) => category.icon?.trim())
      .filter((icon): icon is string => Boolean(icon)),
  )
  if (icons.size === 0) return undefined
  const game = mapGenieGameSlug(pkg)
  if (!game) return undefined
  const cssUrl = `https://cdn.mapgenie.io/css/themes/icons/${encodeURIComponent(game)}-icons.css`
  try {
    const cssResponse = await fetch(cssUrl, {
      signal,
      credentials: 'omit',
      cache: 'force-cache',
    })
    if (!cssResponse.ok) return undefined
    const css = await cssResponse.text()
    const glyphs: Record<string, string> = {}
    const glyphPattern = /\.icon-([a-zA-Z0-9_-]+):before\s*\{[^}]*content:\s*"\\([0-9a-fA-F]+)"/g
    for (const match of css.matchAll(glyphPattern)) {
      const code = Number.parseInt(match[2], 16)
      if (!Number.isFinite(code)) continue
      glyphs[match[1]] = String.fromCharCode(code)
    }
    for (const icon of icons) {
      if (!glyphs[icon]) delete glyphs[icon]
    }
    if (Object.keys(glyphs).length === 0) return undefined

    const fontPath = /url\(['"]?([^'")]+\.ttf(?:\?[^'")]*)?)/i.exec(css)?.[1]
    const fontUrl = fontPath
      ? new URL(fontPath, cssUrl).href
      : `https://cdn.mapgenie.io/fonts/${encodeURIComponent(game)}/icons/icomoon.ttf`
    const fontResponse = await fetch(fontUrl, {
      signal,
      credentials: 'omit',
      cache: 'force-cache',
    })
    if (!fontResponse.ok) return undefined
    const data = await fontResponse.blob()
    if (data.size === 0) return undefined
    return {
      family: `tm-mapgenie-${pkg.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
      data,
      glyphs,
      source: cssUrl,
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    console.warn('[tavern-map] Map Genie icon font download failed', error)
    return undefined
  }
}


const MAPGENIE_ICON_ATLAS_VERSION = 'v158'

/** Download the original Map Genie icon-set sprite atlas (e.g. GTA6). */
export async function downloadMapGenieIconAtlas(
  pkg: LayerMapPackage,
  signal?: AbortSignal,
): Promise<LayerMapPackage['iconAtlas'] | undefined> {
  if (pkg.source !== 'mapgenie') return undefined
  const icons = new Set(
    pkg.categories
      .map((category) => category.icon?.trim())
      .filter((icon): icon is string => Boolean(icon)),
  )
  if (icons.size === 0) return undefined
  const game = mapGenieGameSlug(pkg)
  if (!game) return undefined
  const base = `https://media.mapgenie.io/v2/assets/prod/games/${encodeURIComponent(game)}/icon-set/build/${MAPGENIE_ICON_ATLAS_VERSION}`
  try {
    const [jsonResponse, imageResponse] = await Promise.all([
      fetch(`${base}/atlas.json`, { signal, credentials: 'omit', cache: 'force-cache' }),
      fetch(`${base}/atlas.png`, { signal, credentials: 'omit', cache: 'force-cache' }),
    ])
    if (!jsonResponse.ok || !imageResponse.ok) return undefined
    const raw = (await jsonResponse.json()) as Record<string, unknown>
    const frames: NonNullable<LayerMapPackage['iconAtlas']>['frames'] = {}
    for (const [key, value] of Object.entries(raw)) {
      if (!value || typeof value !== 'object') continue
      const item = value as Record<string, unknown>
      const x = Number(item.x)
      const y = Number(item.y)
      const width = Number(item.width)
      const height = Number(item.height)
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue
      frames[key] = {
        x,
        y,
        width,
        height,
        pixelRatio: Number.isFinite(Number(item.pixelRatio))
          ? Number(item.pixelRatio)
          : undefined,
      }
    }
    const usable = [...icons].some((icon) =>
      [`g.${icon}.a`, `g.${icon}.ffffff`, icon].some((key) => Boolean(frames[key])),
    )
    if (!usable) return undefined
    const image = await imageResponse.blob()
    if (image.size === 0) return undefined
    return { image, frames, source: `${base}/atlas.json` }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    console.warn('[tavern-map] Map Genie icon atlas download failed', error)
    return undefined
  }
}
