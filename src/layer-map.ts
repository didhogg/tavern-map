import { addProtocol, Map as MapLibreMap } from 'maplibre-gl'
import { buildLayerContext } from './layer-context'
import { itineraryRegions, pointInRing, regionChain, regionsAtPoint } from './layer-regions'
import {
  pointAlong,
  pointDistance,
  polylineCumulative,
  polylineSlice,
  projectOnPolyline,
  type Pt,
} from './layer-polyline'
import {
  buildRoadGraph,
  roadRoute,
  roadsNearPolyline,
  type RoadGraph,
  type RoadRoutePiece,
} from './layer-road-route'
import { buildRoadIndex, nearestRoad, roadRank, roadsInRect, roadsNearPoint, type NearestRoad, type RoadHit, type RoadIndex } from './layer-roads'
import { estimateTokens } from './context'
import { errorMessage } from './http'
import {
  formatBytes,
  formatCount,
  imageAspectNote,
  imageFitLabel,
  imageRectFor,
  imageSourceLabel,
  makeLayerThumbnail,
  readLayerImage,
  sanitizeRect,
} from './layer-image'
import { sourceFieldLinks, sourceHttpUrl, type MapGenieTileSetInfo } from './layer-import'
import { LayerImportUI } from './layer-import-ui'
import { LayerPackagesUI } from './layer-packages-ui'
import {
  filesToBundle,
  scanTileFiles,
} from './layer-source'
import { distanceUnitText, formatCellDistance, gridCellDistance } from './layer-distance'
import {
  getLayerPackage,
  listLayerPackages,
  removeLayerImage,
  setLayerImage,
  setLayerImageFit,
  setLayerTiles,
  updateLayerPackage,
} from './layer-store'
import {
  DEFAULT_LAYER_STATE,
  loadLayerState,
  saveLayerState,
  type LayerAIPart,
  type LayerCategory,
  type LayerCategoryGroup,
  type LayerChatState,
  type LayerContextRoad,
  type LayerContextRoadNote,
  type LayerContextSnapshot,
  type LayerCustomPin,
  type LayerImageFit,
  type LayerImageRect,
  type LayerGridConfig,
  type LayerItinerary,
  type LayerItineraryContext,
  type LayerItineraryContextPoi,
  type LayerItineraryStop,
  type LayerFavoritePlace,
  type LayerLink,
  type LayerLinkKind,
  type LayerMapPackage,
  type LayerMarker,
  type LayerNearbyPlace,
  type LayerPinEdits,
  type LayerPinPoint,
  type LayerPlaceAIFlags,
  type LayerUserPosition,
  type LayerPackageMeta,
  type LayerRegion,
  type LayerStreet,
  type LayerView,
} from './layer-types'
import {
  clearGlobalNote,
  flushGlobalNotes,
  globalNote,
  globalNotesSnapshot,
  setGlobalNote,
} from './notes-store'
import { ITINERARY_RANGE_MAX, ITINERARY_RANGE_MIN, loadSettings, saveSettings } from './settings'
import {
  layerFavoriteKey,
  listFavorites,
  removeFavorite,
  setFavorite,
  toggleFavorite,
  type FavoritePlace,
} from './favorites-store'
import {
  CUSTOM_PIN_CATEGORY_ID,
  CUSTOM_PIN_COLOR,
  CUSTOM_PIN_GROUP_ID,
  MAX_PIN_HISTORY,
  emptyPinEdits,
  loadPinEdits,
  removePinEdits,
  savePinEdits,
} from './layer-pin-store'
import {
  loadPlaceAIFlags,
  removePlaceAIFlags,
  savePlaceAIFlags,
} from './layer-ai-store'
import { LayerWindowController } from './layer-window'
import {
  removeStoredLayerPackage,
  saveStoredLayerPosition,
  saveStoredLayerView,
  storedLastLayerPackage,
  storedLayerPosition,
  storedLayerView,
} from './layer-positions'
import type { Settings, StContext } from './types'

const PANEL_ID = 'tm-layer'
const IMAGE_FIT_MARGIN = 0.94
const LABEL_IMAGE_ZOOM = 1.7
const LABEL_TILE_ZOOM = 11
const MARKER_HIT_RADIUS = 12
const REGION_HIT_MIN_ZOOM = 8
const REGION_LABEL_MIN_ZOOM = 8
const TILE_CLUSTER_BELOW_ZOOM = 10.8
/** Road-name zooms per road rank (main, secondary, minor), tuned like LABEL_TILE_ZOOM. */
const STREET_LABEL_TILE_ZOOMS = [13, 14, 15]
/** "On a road" when within this fraction of the map span width of its line. */
const ON_ROAD_SPAN_FRACTION = 0.004
/**
 * The tile zoom thresholds above were tuned on Map Genie maps whose tile sets
 * start at zoom 8. Other maps start elsewhere (RDR2 2–7, Skyrim HD 6–12), so a
 * fixed zoom 11 meant labels never appeared there. See tileZoomThreshold().
 */
const TILE_ZOOM_TUNED_MIN = 8
const MARKER_INDEX_CELL = 0.025
const LABEL_CELL_PX = 48
const IMAGE_PANEL_WIDTH = 340
/** Decoded-tile cache only; imported tile files and map data are never discarded. */
const DECODED_TILE_MEMORY_BUDGET = 256 * 1024 * 1024
const TILE_LOAD_CONCURRENCY = 8
const CUSTOM_PIN_CATEGORY: LayerCategory = {
  id: CUSTOM_PIN_CATEGORY_ID,
  name: '我的图钉',
  groupId: CUSTOM_PIN_GROUP_ID,
  color: CUSTOM_PIN_COLOR,
  order: 9999,
}
const CUSTOM_PIN_GROUP: LayerCategoryGroup = {
  id: CUSTOM_PIN_GROUP_ID,
  name: '我的',
  order: 9998,
}

/** One stretch of a leg: along one named road, or a straight line. */
type ItineraryPieceView = {
  kind: 'road' | 'straight'
  /** Road identity (see roadKey) for road pieces. */
  key?: string
  name?: string
  type?: string
  points: Pt[]
}

type ItineraryLegView = {
  fromStop: LayerItineraryStop
  toStop: LayerItineraryStop
  from: Pt
  to: Pt
  /** The travelled line: straight, or along roads with straight bits where no road goes. */
  points: Pt[]
  cumulative: number[]
  length: number
  /** Planned to follow roads (and the map has roads). */
  snap: boolean
  pieces: ItineraryPieceView[]
}

type ItineraryPoiView = {
  marker: LayerMarker
  along: number
  offset: number
  projected: { x: number; y: number }
}
function linkTextKey(url: string): string {
  return `layer-linktext:${url}`
}

const REFERENCE_HEADINGS = new Set([
  'references',
  'reference',
  '参考文献',
  '參考文獻',
  '参考资料',
  '參考資料',
  '参考',
  '參考',
  '来源',
  '來源',
  '引用',
  '脚注',
  '腳註',
  '注释',
  '註釋',
])

function isReferenceHeading(element: Element): boolean {
  const text = (element.textContent ?? '')
    .replace(/\[.*?\]/g, ' ')
    .replace(/edit/gi, ' ')
    .replace(/[\s_]+/g, ' ')
    .trim()
    .toLowerCase()
  return REFERENCE_HEADINGS.has(text)
}

function removeReferenceSections(doc: Document): void {
  doc
    .querySelectorAll(
      '.references, .reflist, .reference-list, .mw-references-wrap, ol.references, li.reference, #References',
    )
    .forEach((node) => node.remove())
  const headings = Array.from(doc.querySelectorAll<HTMLElement>('h2, h3, h4, h5, h6'))
  for (const heading of headings) {
    if (!heading.isConnected || !isReferenceHeading(heading)) continue
    const level = Number(heading.tagName.slice(1))
    let node: Element | null = heading
    while (node) {
      const next: Element | null = node.nextElementSibling
      if (
        node !== heading &&
        next &&
        /^H[1-6]$/.test(next.tagName) &&
        Number(next.tagName.slice(1)) <= level
      ) {
        break
      }
      node.remove()
      node = next
    }
  }
}

const TILE_PROTOCOL = 'tavern-tile'
const TILE_SOURCE_ID = 'tml-layer-tiles'
const TILE_LAYER_ID = 'tml-layer-tiles'
const REMOTE_TILE_SOURCE_ID = 'tml-layer-remote-tiles'
const REMOTE_TILE_LAYER_ID = 'tml-layer-remote-tiles'
const tileProtocolPackages = new Map<string, LayerMapPackage>()
let tileProtocolRegistered = false

function lngLatFromNormalized(x: number, y: number): [number, number] {
  const lng = x * 360 - 180
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI
  return [lng, lat]
}

function normalizedFromLngLat(lng: number, lat: number): { x: number; y: number } {
  const x = (lng + 180) / 360
  const sin = Math.sin((lat * Math.PI) / 180)
  const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)
  return { x, y }
}

function remoteTileUrl(template: string, z: number, x: number, y: number): string {
  return template
    .replace(/\{z\}/g, String(z))
    .replace(/\{x\}/g, String(x))
    .replace(/\{y\}/g, String(y))
}

const tileProtocolRefreshes = new Map<string, Promise<LayerMapPackage | undefined>>()

/** Re-read a package's tiles from storage; concurrent callers share one read. */
function refreshTileProtocolPackage(packageId: string): Promise<LayerMapPackage | undefined> {
  let pending = tileProtocolRefreshes.get(packageId)
  if (!pending) {
    pending = getLayerPackage(packageId)
      .then((fresh) => {
        if (fresh && tileProtocolPackages.has(packageId)) tileProtocolPackages.set(packageId, fresh)
        return fresh
      })
      .finally(() => {
        window.setTimeout(() => tileProtocolRefreshes.delete(packageId), 2000)
      })
    tileProtocolRefreshes.set(packageId, pending)
  }
  return pending
}

function registerTileProtocol(): void {
  if (tileProtocolRegistered) return
  tileProtocolRegistered = true
  addProtocol(TILE_PROTOCOL, async (params) => {
    const url = new URL(params.url)
    const packageId = decodeURIComponent(url.hostname)
    const [z, x, y] = url.pathname
      .replace(/^\/+/, '')
      .split('/')
      .map((part) => Number(part))
    const pkg = tileProtocolPackages.get(packageId)
    if (!pkg || !Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error('Local tile is unavailable')
    }
    const key = `${z}/${y}/${x}`
    const blob = pkg.tileFiles?.[key]
    if (blob) {
      try {
        return { data: await blob.arrayBuffer() }
      } catch (error) {
        // The stored tiles were rewritten (asset move, tile replacement) after
        // this package was loaded, so the old handles are gone. Reload them once.
        const fresh = await refreshTileProtocolPackage(packageId)
        const retry = fresh?.tileFiles?.[key]
        if (!retry) throw error
        return { data: await retry.arrayBuffer() }
      }
    }
    const template = pkg.tile?.template?.trim()
    if (template) {
      const response = await fetch(remoteTileUrl(template, z, x, y))
      if (response.ok) return { data: await response.arrayBuffer() }
    }
    throw new Error(`Local tile ${z}/${x}/${y} is missing`)
  })
}

type TavernWindow = Window & {
  SillyTavern?: { getContext?: () => StContext }
}

type LinkOwner = Pick<LayerMarker, 'id' | 'custom' | 'links'>

type LayerMapCallbacks = {
  onChange: () => void
  onRealMap: () => void
  onClosed?: () => void
  onSettingsChanged?: () => void
}

const PANEL_HTML = `
<section id="${PANEL_ID}" class="tml-panel" aria-label="Tavern Map 图层地图" hidden>
  <header class="tml-head">
    <div class="tml-title">
      <span>Tavern Map</span>
      <strong>图层地图</strong>
    </div>
    <div class="tml-mode-tabs" role="tablist" aria-label="地图模式">
      <button type="button" data-action="real-map">现实地图</button>
      <button type="button" class="active" role="tab" aria-selected="true">图层地图</button>
    </div>
    <div class="tml-head-center">
      <select id="tml-package" class="tml-select" aria-label="选择地图包"></select>
      <button type="button" class="tml-btn" data-action="import">导入</button>
      <button type="button" class="tml-btn" data-action="manage">管理</button>
      <button type="button" class="tml-header-image" data-action="image-panel" aria-label="底图" aria-haspopup="dialog" aria-expanded="false" title="底图">
        <img id="tml-header-image" alt="" hidden>
        <span id="tml-header-image-empty" class="tml-header-image-empty" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z"/>
            <path d="M8.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/>
            <path d="m4 16 4.5-4.5 3.5 3.5 3-3L20 17"/>
          </svg>
        </span>
      </button>
    </div>
    <div class="tml-head-actions">
      <button type="button" class="tml-btn" data-action="ai">AI 上下文</button>
      <button type="button" class="tml-close" data-action="close" title="关闭">×</button>
    </div>
  </header>
  <div class="tml-body">
    <aside class="tml-left">
      <div class="tml-side-tabs">
        <button type="button" class="active" data-left-tab="layers">图层</button>
        <button type="button" data-left-tab="favorites">收藏 <span id="tml-favorite-count">0</span></button>
      </div>
      <div id="tml-layer-pane">
      <div class="tml-side-heading">
        <span>图层</span>
        <span id="tml-visible-count" class="tml-side-count">0</span>
      </div>
      <div class="tml-filter">
        <input id="tml-filter" type="search" placeholder="筛选分类…" autocomplete="off" aria-label="筛选分类">
      </div>
      <div id="tml-categories" class="tml-categories"></div>
      <div class="tml-side-actions">
        <button type="button" class="tml-mini" data-action="show-all">全显</button>
        <button type="button" class="tml-mini" data-action="hide-all">全隐</button>
        <button type="button" class="tml-mini" data-action="fit">适配</button>
      </div>
      <div class="tml-side-note" id="tml-package-info"></div>
      </div>
      <div id="tml-favorites" class="tml-favorites" hidden></div>
    </aside>
    <main class="tml-main">
      <div class="tml-toolbar">
        <div class="tml-search-wrap">
          <input id="tml-search" type="search" placeholder="搜地点 / 分类 / 区域 / 笔记" autocomplete="off" aria-label="搜索图层地图">
          <div id="tml-search-results" class="tml-search-results" role="listbox" hidden></div>
        </div>
        <div class="tml-toolbar-actions">
          <button type="button" class="tml-tool active" data-action="labels" aria-pressed="true">标签</button>
          <button type="button" class="tml-tool active" data-action="regions" aria-pressed="true">区域</button>
          <button type="button" class="tml-tool" data-action="roads" aria-pressed="false" title="显示这张地图自带的道路线" hidden>道路</button>
          <button type="button" class="tml-tool tml-add-pin" data-action="add-pin" title="在地图上添加自己的图钉" aria-label="添加图钉">＋ 图钉</button>
          <button type="button" class="tml-tool tml-route-tool" data-action="itinerary" title="规划或查看行程" aria-label="行程">行程</button>
          <button type="button" class="tml-tool tml-history-tool" data-action="undo-pin" title="撤销选中图钉的移动" aria-label="撤销图钉移动" disabled>↶</button>
          <button type="button" class="tml-tool tml-history-tool" data-action="redo-pin" title="重做选中图钉的移动" aria-label="重做图钉移动" disabled>↷</button>
          <button type="button" class="tml-tool" data-action="locate" title="回到我的位置；未设置时放置" aria-label="回到我的位置">◎ 回到我</button>
          <button type="button" class="tml-tool" data-action="grid" title="校准地图网格" aria-label="网格校准"># 网格</button>
          <button type="button" class="tml-tool tml-mobile-only" data-action="filters">图层</button>
          <button type="button" class="tml-tool" data-action="zoom-out" aria-label="缩小">−</button>
          <button type="button" class="tml-tool" data-action="zoom-in" aria-label="放大">+</button>
          <button type="button" class="tml-tool" data-action="fit">适配</button>
        </div>
      </div>
      <div id="tml-viewport" class="tml-viewport">
        <div id="tml-maplibre" class="tml-maplibre" hidden></div>
        <canvas id="tml-canvas"></canvas>
        <div id="tml-route-stops" class="tml-route-stops" aria-live="polite"></div>
        <button type="button" id="tml-user-stamp" class="tml-user-stamp" hidden title="拖动我" aria-label="我在的位置">
          <svg viewBox="0 0 24 34" aria-hidden="true">
            <path d="M12 1C6.5 1 2 5.5 2 11c0 7.6 10 22 10 22s10-14.4 10-22c0-5.5-4.5-10-10-10Z" fill="currentColor"></path>
            <circle cx="12" cy="11" r="3.4" fill="#fff"></circle>
          </svg>
        </button>
        <button type="button" id="tml-grid-origin" class="tml-grid-handle tml-grid-origin" hidden aria-label="拖动网格原点">0,0</button>
        <button type="button" id="tml-grid-scale" class="tml-grid-handle tml-grid-scale" hidden aria-label="拖动缩放网格">↘</button>
        <div id="tml-place-bar" class="tml-place-bar" hidden>
          <span id="tml-place-text">点击地图放置“我的位置” · Esc 取消</span>
          <button type="button" data-user-action="cancel">取消</button>
          <button type="button" data-pin-move="undo" title="撤销这次的上一步拖动 (Ctrl+Z)" hidden>撤销</button>
          <button type="button" data-pin-move="redo" title="重做 (Ctrl+Shift+Z)" hidden>重做</button>
          <button type="button" data-pin-move="cancel" title="放回原来的位置 (Esc)" hidden>取消</button>
          <button type="button" data-pin-move="confirm" class="tml-place-confirm" title="保存新位置" hidden>确定</button>
        </div>
        <div id="tml-grid-panel" class="tml-grid-panel" hidden>
          <header class="tml-grid-head">
            <strong>网格校准</strong>
            <div class="tml-grid-head-actions">
              <button type="button" class="tml-mini tml-grid-collapse" data-grid-action="collapse">收起</button>
              <button type="button" class="tml-close" data-grid-action="close" aria-label="关闭网格">×</button>
            </div>
          </header>
          <div class="tml-grid-row">
            <label class="tml-grid-check"><input id="tml-grid-show" type="checkbox"> 关闭后仍显示</label>
          </div>
          <datalist id="tml-grid-units">
            <option value="米"></option><option value="公里"></option><option value="英里"></option>
            <option value="英尺"></option><option value="里"></option><option value="格"></option>
          </datalist>
          <div class="tml-grid-row tml-grid-scale-row">
            <span>格宽</span>
            <button type="button" class="tml-mini tml-grid-step" data-grid-action="scale-out" aria-label="缩小网格">−</button>
            <input id="tml-grid-cell" type="number" min="0.001" max="200" step="0.01" value="10" aria-label="格宽百分比">%
            <button type="button" class="tml-mini tml-grid-step" data-grid-action="scale-in" aria-label="放大网格">＋</button>
            <input id="tml-grid-range" type="range" min="0.01" max="100" step="0.01" value="10" aria-label="拖动调整格宽">
          </div>
          <div class="tml-grid-row">
            <label>X 偏移 <input id="tml-grid-x" type="number" step="0.1" value="0">%</label>
            <label>Y 偏移 <input id="tml-grid-y" type="number" step="0.1" value="0">%</label>
          </div>
          <div id="tml-grid-distance" class="tml-grid-row"></div>
          <div class="tml-grid-row tml-grid-hint">
            <span>拖 0,0 移动 · 拖右下角缩放点缩放 · Alt+滚轮缩放网格 · 普通滚轮缩放地图</span>
          </div>
          <div class="tml-grid-actions">
            <button type="button" class="tml-mini" data-grid-action="reset">重置</button>
            <button type="button" class="tml-mini tml-primary" data-grid-action="done">完成并关闭</button>
          </div>
        </div>
        <div id="tml-empty" class="tml-empty" hidden></div>
        <div id="tml-route-shelf" class="tml-route-shelf" role="region" aria-label="行程" hidden></div>
        <div id="tml-align-bar" class="tml-align-bar" hidden>
          <span>拖动图片对齐地点，滚轮缩放；地点标记固定不动。</span>
          <div class="tml-align-actions">
            <button type="button" class="tml-mini" data-align-action="reset">重置铺满</button>
            <button type="button" class="tml-mini" data-align-action="cancel">取消</button>
            <button type="button" class="tml-mini tml-primary" data-align-action="done">完成</button>
          </div>
        </div>
        <div class="tml-map-status">
          <span id="tml-zoom">—</span>
          <span id="tml-scale">比例未校准</span>
        </div>
      </div>
    </main>
    <aside id="tml-inspector" class="tml-inspector">
      <div id="tml-position">
        <section id="tml-position-card" class="tml-position-card" hidden>
          <div id="tml-position-content"></div>
          <div id="tml-distance-unit" class="tml-distance-unit">
            <span>距离换算</span>
            <span id="tml-distance-hint" class="tml-distance-unit-hint">先用“# 网格”校准格子</span>
            <span id="tml-distance-fields" class="tml-distance-unit-fields" hidden>
              <span>1 格 ≈</span>
              <input id="tml-distance-amount" type="number" min="0" step="any" aria-label="每格换算数值">
              <input id="tml-distance-label" type="text" list="tml-grid-units" placeholder="米" aria-label="换算单位">
            </span>
          </div>
        </section>
      </div>
      <div id="tml-detail"></div>
      <div id="tml-nearby" class="tml-nearby" hidden></div>
    </aside>
  </div>
  <footer class="tml-foot">
    <span id="tml-attribution">本地地图包 · 数据不会上传</span>
    <span id="tml-context-status">AI 上下文：待机</span>
  </footer>
  <div class="tml-resize" data-resize="n" aria-hidden="true"></div>
  <div class="tml-resize" data-resize="s" aria-hidden="true"></div>
  <div class="tml-resize" data-resize="e" aria-hidden="true"></div>
  <div class="tml-resize" data-resize="w" aria-hidden="true"></div>
  <div class="tml-resize" data-resize="nw" aria-hidden="true"></div>
  <div class="tml-resize" data-resize="ne" aria-hidden="true"></div>
  <div class="tml-resize" data-resize="sw" aria-hidden="true"></div>
  <div class="tml-resize" data-resize="se" aria-hidden="true" title="拖动调整窗口大小"></div>
</section>
<div id="tml-image-panel" class="tml-image-panel" role="dialog" aria-modal="false" aria-label="底图" hidden>
  <div class="tml-image-panel-head">
    <strong>底图</strong>
    <button type="button" class="tml-close" data-image-action="close" aria-label="关闭">×</button>
  </div>
  <div id="tml-image-panel-body" class="tml-image-panel-body"></div>
</div>
<div id="tml-image-lightbox" class="tml-lightbox" role="dialog" aria-modal="true" aria-label="底图预览" hidden>
  <button type="button" class="tml-lightbox-close" data-lightbox-action="close" aria-label="关闭">×</button>
  <img id="tml-lightbox-image" alt="底图预览">
</div>
<div id="tml-context" class="tml-modal" role="dialog" aria-modal="true" aria-label="图层地图 AI 上下文" hidden>
  <div class="tml-modal-card tml-context-card">
    <header class="tml-modal-head">
      <strong>图层地图 · AI 上下文</strong>
      <div class="tml-context-head-actions">
        <button type="button" class="tml-btn" data-context-action="copy">复制</button>
        <button type="button" class="tml-close" data-context-action="close" aria-label="关闭">×</button>
      </div>
    </header>
    <div class="tml-context-layout">
      <aside class="tml-context-controls">
        <section class="tml-context-section">
          <div class="tml-context-label">我的位置</div>
          <div id="tml-context-position" class="tml-context-position"></div>
          <div class="tml-context-coords">
            X <input id="tml-context-x" type="number" min="0" max="100" step="0.1" aria-label="我的位置 X 百分比">%
            Y <input id="tml-context-y" type="number" min="0" max="100" step="0.1" aria-label="我的位置 Y 百分比">%
          </div>
          <div class="tml-context-actions">
            <button type="button" class="tml-mini" data-context-action="place">在地图上放置</button>
            <button type="button" class="tml-mini" data-context-action="from-selected">用选中地点</button>
            <button type="button" class="tml-mini" data-context-action="clear-position">清除</button>
          </div>
        </section>
        <section class="tml-context-section">
          <div class="tml-context-label">AI 内容</div>
          <div class="tml-context-hint">所在地点、周围地点、收藏地点的字段开关在扩展设置 › Tavern Map 里调整。</div>
        </section>
        <section class="tml-context-section">
          <div class="tml-context-label">地图网格</div>
          <div id="tml-context-grid" class="tml-context-grid"></div>
          <button type="button" class="tml-mini" data-context-action="grid">打开网格校准</button>
        </section>
        <section class="tml-context-section">
          <label class="tml-context-check"><input id="tml-context-inject" type="checkbox"> 注入到 AI</label>
          <div class="tml-context-hint">笔记全文不截断；地点类型随每个地点显示。</div>
        </section>
      </aside>
      <div class="tml-context-preview">
        <pre id="tml-context-text"></pre>
      </div>
    </div>
    <footer class="tml-modal-foot">
      <span id="tml-context-tokens" class="tml-context-tokens"></span>
      <button type="button" class="tml-btn" data-context-action="close">关闭</button>
    </footer>
  </div>
</div>
`

export class LayerMapUI {
  private ctx: StContext
  private readonly callbacks: LayerMapCallbacks
  private state: LayerChatState
  private pkg: LayerMapPackage | null = null
  private metas: LayerPackageMeta[] = []
  private pinEdits: LayerPinEdits = emptyPinEdits()
  private placeAIFlags: Record<string, LayerPlaceAIFlags> = {}
  private itinerary: LayerItinerary | null = null
  private itineraryDraft: LayerItinerary | null = null
  private itineraryEdit = false
  private routeShelfOpen = false
  private routeExpandedLeg = 0
  private routeHover: { x: number; y: number } | null = null
  private routeStopDrag: {
    stopId: string
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
    originMarkerId?: string
    moved: boolean
  } | null = null
  private readonly routeStopButtons = new Map<string, HTMLButtonElement>()
  private effectiveMarkerList: LayerMarker[] = []
  private effectiveCategoryList: LayerCategory[] = []
  private effectiveGroupList: LayerCategoryGroup[] = []
  private readonly effectiveMarkerMap = new Map<string, LayerMarker>()
  private view: LayerView = { cx: 0.5, cy: 0.5, zoom: 1 }
  private maplibreEl!: HTMLElement
  private maplibreMap: MapLibreMap | null = null
  private maplibreReady: Promise<void> | null = null
  private tileViewPackageId = ''
  private packageLoadToken = 0
  private placingUser = false
  private placingPin: 'add' | 'move' | null = null
  /**
   * "移动图钉" session: the pin can only be dragged while this is set. Each drag
   * adds a point; undo/redo walk them; confirm writes one history entry.
   */
  private pinMove: { id: string; points: LayerPinPoint[]; cursor: number } | null = null
  private pinDrag: {
    id: string
    startSx: number
    startSy: number
    startX: number
    startY: number
    originX: number
    originY: number
    pressX?: number
    pressY?: number
    moved: boolean
    pointerId: number
  } | null = null
  private gridPanelOpen = false
  private gridSaveTimer: number | undefined
  private userDrag: {
    startX: number
    startY: number
    originX: number
    originY: number
    snapRoute: boolean
  } | null = null
  private userStampEl!: HTMLButtonElement
  private favoriteMarkerIds = new Set<string>()
  private iconFontPackageId = ''
  private iconFontFamily = ''
  private iconAtlasPackageId = ''
  private iconAtlasUrl: string | null = null
  private iconAtlasImage: HTMLImageElement | null = null
  private readonly markerIconCache = new Map<string, HTMLCanvasElement>()
  private gridHandleDrag: {
    mode: 'origin' | 'scale'
    startX: number
    startY: number
    startNormX: number
    startNormY: number
    originX: number
    originY: number
    cellW: number
    cellH: number
  } | null = null
  private image: HTMLImageElement | null = null
  private imageUrl: string | null = null
  private imagePreview: HTMLImageElement | null = null
  private imagePreviewUrl: string | null = null
  private imageLarge = false
  private imageFullRequested = false
  private imageLoadTimer: number | undefined
  private imagePreviewToken = 0
  private readonly tileCache = new Map<string, HTMLImageElement | 'loading' | 'error'>()
  private readonly tileFileUrls = new Map<string, string>()
  private readonly markerRegionCache = new Map<string, LayerRegion | undefined>()
  private readonly regionLabelCache = new Map<string, { x: number; y: number; area: number }>()
  private readonly streetLabelCache = new Map<string, { x: number; y: number; angle: number }>()
  private roadIndexCache: { streets: LayerStreet[]; yScale: number; index: RoadIndex } | undefined
  private roadGraphCache:
    | {
        streets: LayerStreet[]
        yScale: number
        graph: RoadGraph
        routes: Map<string, RoadRoutePiece[] | undefined>
      }
    | undefined
  private itineraryPoiCache:
    | { key: string; markers: LayerMarker[]; result: Map<number, ItineraryPoiView[]> }
    | undefined
  private itineraryAreaCache?: {
    key: string
    regions: LayerRegion[]
    streets: LayerStreet[] | undefined
    result: LayerRegion[][]
  }
  private readonly itineraryNoteRegionIds = new Set<string>()
  private syncRegionNoteAI?: () => void
  /** Range while the slider or map handle is being dragged; saved to settings on release. */
  private itineraryRangeOverride: number | undefined
  /** Planning: the next leg added follows roads. Stays on until switched off. */
  private routeSnapNext = false
  private routeRangeHandleEl: HTMLButtonElement | undefined
  private rangeBandCanvas: HTMLCanvasElement | undefined
  private roadLinesCache: { streets: LayerStreet[]; map: Map<string, LayerStreet[]> } | undefined
  private rangeHandleDrag: number | undefined
  private currentRoadCache: { key: string; road: NearestRoad | undefined } | undefined
  private tileMoving = false
  private readonly markerIndex = new Map<string, LayerMarker[]>()
  private readonly labelCells = new Set<string>()
  private clusterHitAreas: Array<{ x: number; y: number; radius: number; nx: number; ny: number }> = []
  private tileCacheBytes = 0
  private tileLoads = 0
  private readonly tileQueue: Array<() => void> = []
  private tileGeneration = 0
  private drawFrame = 0
  private saveTimer: number | undefined
  private resizeObserver: ResizeObserver | null = null
  private active = false
  private dragging = false
  private moved = false
  private dragX = 0
  private dragY = 0
  private suppressClick = false
  private linkDraftFor: string | undefined
  private linkDraftTitle = ''
  private linkDraftUrl = ''
  private linkDraftKind: LayerLinkKind = 'custom'
  private emptyMessage = ''
  private readonly windowController: LayerWindowController
  private readonly importUI: LayerImportUI
  private readonly packagesUI: LayerPackagesUI
  private headerImageEl!: HTMLImageElement
  private headerImageEmptyEl!: HTMLElement
  private headerImageButtonEl!: HTMLButtonElement
  private headerImageUrl: string | null = null
  private imagePanelEl!: HTMLElement
  private imagePanelBodyEl!: HTMLElement
  private imagePanelOpen = false
  private imageBusy = false
  private imageRemovePending = false
  private lightboxEl!: HTMLElement
  private lightboxImageEl!: HTMLImageElement
  private lightboxUrl: string | null = null
  private alignBarEl!: HTMLElement
  private aligning = false
  private alignRect: LayerImageRect | null = null
  private alignStartRect: LayerImageRect | null = null
  private alignStartPointer: { x: number; y: number } | null = null
  private alignDrag = false
  private lastRemovedImage:
    | {
        pkgId: string
        image: Blob
        type?: string
        name?: string
        pageUrl?: string
        width?: number
        height?: number
        bytes?: number
        source?: LayerMapPackage['imageSource']
        fit?: LayerImageFit
        rect?: LayerImageRect
        thumbnail?: Blob
      }
    | null = null
  private imageInput!: HTMLInputElement
  private tilesInput!: HTMLInputElement

  private panelEl!: HTMLElement
  private canvasEl!: HTMLCanvasElement
  private viewportEl!: HTMLElement
  private packageSelectEl!: HTMLSelectElement
  private layerPaneEl!: HTMLElement
  private favoritesEl!: HTMLElement
  private favoriteCountEl!: HTMLElement
  private categoriesEl!: HTMLElement
  private categoryFilterEl!: HTMLInputElement
  private detailEl!: HTMLElement
  private emptyEl!: HTMLElement
  private searchEl!: HTMLInputElement
  private searchResultsEl!: HTMLElement
  private visibleCountEl!: HTMLElement
  private zoomEl!: HTMLElement
  private scaleEl!: HTMLElement
  private packageInfoEl!: HTMLElement
  private attributionEl!: HTMLElement
  private contextStatusEl!: HTMLElement
  private contextModalEl!: HTMLElement
  private contextTextEl!: HTMLElement
  private contextTokensEl!: HTMLElement
  private positionEl!: HTMLElement
  private positionCardEl!: HTMLElement
  private positionContentEl!: HTMLElement
  private distanceUnitEl!: HTMLElement
  private distanceHintEl!: HTMLElement
  private distanceFieldsEl!: HTMLElement
  private distanceAmountEl!: HTMLInputElement
  private distanceLabelEl!: HTMLInputElement
  private nearbyEl!: HTMLElement
  private placeBarEl!: HTMLElement
  private placeTextEl!: HTMLElement
  private routeStopsEl!: HTMLElement
  private routeShelfEl!: HTMLElement
  private gridPanelEl!: HTMLElement
  private gridDistanceEl!: HTMLElement
  private gridOriginHandleEl!: HTMLButtonElement
  private gridScaleHandleEl!: HTMLButtonElement
  private gridRangeEl!: HTMLInputElement
  private gridShowEl!: HTMLInputElement
  private gridCellEl!: HTMLInputElement
  private gridXEl!: HTMLInputElement
  private gridYEl!: HTMLInputElement
  private contextPositionEl!: HTMLElement
  private contextXEl!: HTMLInputElement
  private contextYEl!: HTMLInputElement
  private contextInjectEl!: HTMLInputElement
  private contextGridEl!: HTMLElement

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.importUI?.isOpen() || this.packagesUI?.isOpen()) return
    const target = event.target as HTMLElement | null
    const editing =
      target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
    if (
      this.panelEl &&
      !this.panelEl.hidden &&
      !editing &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey
    ) {
      const key = event.key.toLowerCase()
      if (key === 'z' || key === 'y') {
        const selected = this.pinMove ? this.markerById(this.pinMove.id) : this.selectedMarker()
        if (selected) {
          if (key === 'y' || event.shiftKey) this.redoPin(selected.id)
          else this.undoPin(selected.id)
          event.preventDefault()
          return
        }
      }
    }
    if (event.key !== 'Escape') return
    if (editing) return
    if (this.placingUser || this.placingPin) {
      this.cancelPlacements()
      return
    }
    if (!this.lightboxEl.hidden) {
      this.closeLightbox()
      return
    }
    if (this.aligning) {
      this.cancelAlign()
      return
    }
    if (this.imagePanelOpen) {
      this.closeImagePanel()
      return
    }
    if (!this.contextModalEl.hidden) {
      this.contextModalEl.hidden = true
      return
    }
    if (!this.searchResultsEl.hidden) {
      this.hideSearch()
      return
    }
    if (!this.panelEl.hidden) this.close()
  }

  private readonly onDocumentClick = (event: MouseEvent): void => {
    const target = event.target as Node
    const path = event.composedPath()
    if (!this.searchResultsEl.contains(target) && event.target !== this.searchEl) {
      this.hideSearch()
    }
    if (!this.imagePanelOpen) return
    const insideImagePanel = path.includes(this.imagePanelEl)
    const onTrigger = path.some(
      (node) =>
        node instanceof HTMLElement && node.dataset?.action === 'image-panel',
    )
    if (!insideImagePanel && !onTrigger) this.closeImagePanel()
  }

  constructor(ctx: StContext, callbacks: LayerMapCallbacks) {
    this.ctx = ctx
    this.callbacks = callbacks
    this.state = loadLayerState(ctx)
    this.mount()
    this.windowController = new LayerWindowController(
      this.panelEl,
      this.panelEl.querySelector('.tml-head') as HTMLElement,
      { storageKey: 'tavern-map:layer-window:v1' },
    )
    this.importUI = new LayerImportUI({
      onImported: async (pkg) => {
        this.lastRemovedImage = null
        this.panelEl.hidden = false
        this.active = true
        this.windowController.open()
        await this.refreshPackages()
        await this.loadPackage(pkg.id)
        this.callbacks.onChange()
      },
      onToast: (message) => this.toast(message),
    })
    this.packagesUI = new LayerPackagesUI({
      onOpen: async (id) => {
        this.panelEl.hidden = false
        this.active = true
        this.windowController.open()
        await this.refreshPackages()
        await this.loadPackage(id)
      },
      onChanged: async (pkg) => {
        this.lastRemovedImage = null
        await this.refreshPackages()
        if (this.pkg?.id === pkg.id) {
          await this.loadPackage(pkg.id)
          this.callbacks.onChange()
        }
      },
      onDeleted: (id) => {
        removePinEdits(id)
        removePlaceAIFlags(id)
        if (this.state.itinerariesByPackage) delete this.state.itinerariesByPackage[id]
        if (this.pkg?.id === id) {
          tileProtocolPackages.delete(id)
          this.closeImagePanel()
          if (this.state.packageId === id) this.state.packageId = undefined
          if (this.state.positionsByPackage) delete this.state.positionsByPackage[id]
          if (this.state.viewsByPackage) delete this.state.viewsByPackage[id]
          removeStoredLayerPackage(this.ctx, id)
          this.state.selectedMarkerId = undefined
          this.state.currentMarkerId = undefined
          this.state.selectedRegionId = undefined
          this.state.currentRegionId = undefined
          this.state.view = undefined
          this.persist(true)
          this.pkg = null
          this.placeAIFlags = {}
          this.itinerary = null
          this.itineraryDraft = null
          this.itineraryEdit = false
          this.routeShelfOpen = false
          this.image = null
          this.setTileMapVisible(false)
          this.clearTileCaches()
          this.syncHeaderImage()
          this.renderEmpty('这个地图包已删除。可以重新导入，或选择另一个地图包。')
          this.renderCategories()
          this.renderFavorites()
          this.renderDetail()
          this.renderItineraryShelf()
          this.renderRouteStopHandles()
          this.requestDraw()
        }
        void this.refreshPackages()
      },
      onImport: () => this.openImport(),
      onToast: (message) => this.toast(message),
    })
    this.bind()
    this.renderDetail()
    this.renderCategories()
    this.syncHeaderImage()
  }

  contextText(): string {
    return buildLayerContext(this.state)
  }

  isOpen(): boolean {
    return !this.panelEl.hidden
  }

  handleSettingsChanged(): void {
    this.ctx = this.liveContext()
    if (!this.pkg) return
    this.renderDetail()
    this.renderItineraryShelf()
    this.refreshContext()
  }

  async open(): Promise<void> {
    this.panelEl.hidden = false
    this.active = true
    this.closeImagePanel()
    this.closeLightbox()
    this.windowController.open()
    this.ctx = this.liveContext()
    this.state = loadLayerState(this.ctx)
    this.panelEl.style.zIndex = '10000'
    await this.refreshPackages()
    const storedLast = storedLastLayerPackage(this.ctx)
    const wanted =
      (this.state.packageId && this.metas.some((meta) => meta.id === this.state.packageId)
        ? this.state.packageId
        : storedLast && this.metas.some((meta) => meta.id === storedLast)
          ? storedLast
          : this.metas[0]?.id) ?? undefined
    if (wanted) {
      await this.loadPackage(wanted)
    } else {
      this.pkg = null
      this.clearImageResources()
      this.setTileMapVisible(false)
      this.clearTileCaches()
      this.syncHeaderImage()
      this.renderEmpty('还没有地图包。点右上角“导入”读取本地 Fandom 或 Map Genie 数据。')
      this.renderCategories()
      this.renderFavorites()
      this.renderDetail()
      this.requestDraw()
    }
    this.observeViewport()
    window.requestAnimationFrame(() => {
      this.resizeCanvas()
      this.requestDraw()
    })
  }

  close(): void {
    this.closeImagePanel()
    this.closeLightbox()
    this.cancelPlacements()
    if (this.itineraryEdit) this.cancelItineraryEditing()
    if (this.gridPanelOpen) this.closeGridPanel()
    if (this.aligning) this.cancelAlign()
    this.importUI?.close()
    this.packagesUI?.close()
    this.panelEl.hidden = true
    this.active = false
    if (this.drawFrame) {
      window.cancelAnimationFrame(this.drawFrame)
      this.drawFrame = 0
    }
    this.persist(true)
    this.hideSearch()
    this.callbacks.onClosed?.()
  }

  handleChatChanged(): void {
    void flushGlobalNotes()
    this.closeImagePanel()
    this.closeLightbox()
    this.cancelPlacements()
    if (this.gridPanelOpen) this.closeGridPanel()
    if (this.aligning) this.cancelAlign()
    this.importUI?.close()
    this.packagesUI?.close()
    this.ctx = this.liveContext()
    this.state = loadLayerState(this.ctx)
    this.pkg = null
    this.pinEdits = emptyPinEdits()
    this.placeAIFlags = {}
    this.itinerary = null
    this.itineraryDraft = null
    this.itineraryEdit = false
    this.routeShelfOpen = false
    this.rebuildEffectiveMarkers()
    this.clearImageResources()
    this.setTileMapVisible(false)
    this.clearTileCaches()
    this.syncHeaderImage()
    if (this.active) {
      void this.open()
    } else {
      this.renderDetail()
      this.renderCategories()
    }
  }

  clearChat(): void {
    this.closeImagePanel()
    this.closeLightbox()
    this.cancelPlacements()
    if (this.gridPanelOpen) this.closeGridPanel()
    if (this.aligning) this.cancelAlign()
    this.importUI?.close()
    this.packagesUI?.close()
    this.state = structuredClone(DEFAULT_LAYER_STATE)
    this.state.notes = Object.fromEntries(
      Object.entries(globalNotesSnapshot()).filter(([key]) => key.startsWith('layer:')),
    )
    this.state.updatedAt = Date.now()
    this.pkg = null
    this.pinEdits = emptyPinEdits()
    this.placeAIFlags = {}
    this.itinerary = null
    this.itineraryDraft = null
    this.itineraryEdit = false
    this.routeShelfOpen = false
    this.rebuildEffectiveMarkers()
    this.image = null
    this.imageUrl = null
    this.syncHeaderImage()
    this.active = false
    this.panelEl.hidden = true
    this.saveNow()
    this.callbacks.onChange()
  }

  private liveContext(): StContext {
    const api = (window as TavernWindow).SillyTavern
    try {
      const latest = api?.getContext?.()
      if (latest?.eventSource && latest.extensionSettings) return latest
    } catch {
      // The main UI has already warned about context failures.
    }
    return this.ctx
  }

  private mount(): void {
    if (!document.getElementById(PANEL_ID)) {
      const template = document.createElement('template')
      template.innerHTML = PANEL_HTML.trim()
      document.body.append(template.content)
    }
    this.panelEl = document.getElementById(PANEL_ID) as HTMLElement
    this.canvasEl = document.getElementById('tml-canvas') as HTMLCanvasElement
    this.maplibreEl = document.getElementById('tml-maplibre') as HTMLElement
    this.viewportEl = document.getElementById('tml-viewport') as HTMLElement
    this.packageSelectEl = document.getElementById('tml-package') as HTMLSelectElement
    this.layerPaneEl = document.getElementById('tml-layer-pane') as HTMLElement
    this.favoritesEl = document.getElementById('tml-favorites') as HTMLElement
    this.favoriteCountEl = document.getElementById('tml-favorite-count') as HTMLElement
    this.categoriesEl = document.getElementById('tml-categories') as HTMLElement
    this.categoryFilterEl = document.getElementById('tml-filter') as HTMLInputElement
    this.detailEl = document.getElementById('tml-detail') as HTMLElement
    this.emptyEl = document.getElementById('tml-empty') as HTMLElement
    this.searchEl = document.getElementById('tml-search') as HTMLInputElement
    this.searchResultsEl = document.getElementById('tml-search-results') as HTMLElement
    this.visibleCountEl = document.getElementById('tml-visible-count') as HTMLElement
    this.zoomEl = document.getElementById('tml-zoom') as HTMLElement
    this.scaleEl = document.getElementById('tml-scale') as HTMLElement
    this.packageInfoEl = document.getElementById('tml-package-info') as HTMLElement
    this.attributionEl = document.getElementById('tml-attribution') as HTMLElement
    this.contextStatusEl = document.getElementById('tml-context-status') as HTMLElement
    this.contextModalEl = document.getElementById('tml-context') as HTMLElement
    this.contextTextEl = document.getElementById('tml-context-text') as HTMLElement
    this.contextTokensEl = document.getElementById('tml-context-tokens') as HTMLElement
    this.positionEl = document.getElementById('tml-position') as HTMLElement
    this.positionCardEl = document.getElementById('tml-position-card') as HTMLElement
    this.positionContentEl = document.getElementById('tml-position-content') as HTMLElement
    this.distanceUnitEl = document.getElementById('tml-distance-unit') as HTMLElement
    this.distanceHintEl = document.getElementById('tml-distance-hint') as HTMLElement
    this.distanceFieldsEl = document.getElementById('tml-distance-fields') as HTMLElement
    this.distanceAmountEl = document.getElementById('tml-distance-amount') as HTMLInputElement
    this.distanceLabelEl = document.getElementById('tml-distance-label') as HTMLInputElement
    this.nearbyEl = document.getElementById('tml-nearby') as HTMLElement
    this.placeBarEl = document.getElementById('tml-place-bar') as HTMLElement
    this.placeTextEl = document.getElementById('tml-place-text') as HTMLElement
    this.routeStopsEl = document.getElementById('tml-route-stops') as HTMLElement
    this.routeShelfEl = document.getElementById('tml-route-shelf') as HTMLElement
    this.gridPanelEl = document.getElementById('tml-grid-panel') as HTMLElement
    this.gridDistanceEl = document.getElementById('tml-grid-distance') as HTMLElement
    this.userStampEl = document.getElementById('tml-user-stamp') as HTMLButtonElement
    this.gridOriginHandleEl = document.getElementById('tml-grid-origin') as HTMLButtonElement
    this.gridScaleHandleEl = document.getElementById('tml-grid-scale') as HTMLButtonElement
    this.gridShowEl = document.getElementById('tml-grid-show') as HTMLInputElement
    this.gridCellEl = document.getElementById('tml-grid-cell') as HTMLInputElement
    this.gridRangeEl = document.getElementById('tml-grid-range') as HTMLInputElement
    this.gridXEl = document.getElementById('tml-grid-x') as HTMLInputElement
    this.gridYEl = document.getElementById('tml-grid-y') as HTMLInputElement
    this.contextPositionEl = document.getElementById('tml-context-position') as HTMLElement
    this.contextXEl = document.getElementById('tml-context-x') as HTMLInputElement
    this.contextYEl = document.getElementById('tml-context-y') as HTMLInputElement
    this.contextInjectEl = document.getElementById('tml-context-inject') as HTMLInputElement
    this.contextGridEl = document.getElementById('tml-context-grid') as HTMLElement
    const inspector = this.positionEl.parentElement
    if (inspector) inspector.insertBefore(this.gridPanelEl, this.positionEl)
    this.headerImageEl = document.getElementById('tml-header-image') as HTMLImageElement
    this.headerImageEmptyEl = document.getElementById('tml-header-image-empty') as HTMLElement
    this.headerImageButtonEl = this.panelEl.querySelector(
      '[data-action="image-panel"]',
    ) as HTMLButtonElement
    this.imagePanelEl = document.getElementById('tml-image-panel') as HTMLElement
    this.imagePanelBodyEl = document.getElementById('tml-image-panel-body') as HTMLElement
    this.lightboxEl = document.getElementById('tml-image-lightbox') as HTMLElement
    this.lightboxImageEl = document.getElementById('tml-lightbox-image') as HTMLImageElement
    this.alignBarEl = document.getElementById('tml-align-bar') as HTMLElement
    this.imageInput = document.createElement('input')
    this.imageInput.type = 'file'
    this.imageInput.accept = '.png,.jpg,.jpeg,.webp,.avif,.gif,image/*'
    this.imageInput.hidden = true
    this.tilesInput = document.createElement('input')
    this.tilesInput.type = 'file'
    this.tilesInput.multiple = true
    this.tilesInput.setAttribute('webkitdirectory', '')
    this.tilesInput.hidden = true
    this.imagePanelEl.append(this.imageInput, this.tilesInput)
  }

  private bind(): void {
    this.panelEl.addEventListener('click', (event) => this.onPanelClick(event))
    this.routeShelfEl.addEventListener('click', (event) => this.onRouteShelfClick(event))
    this.canvasEl.addEventListener('pointerdown', (event) => this.onPointerDown(event))
    this.canvasEl.addEventListener('pointermove', (event) => this.onPointerMove(event))
    this.canvasEl.addEventListener('pointerup', (event) => this.onPointerUp(event))
    this.canvasEl.addEventListener('pointercancel', (event) => this.onPointerUp(event))
    this.canvasEl.addEventListener('wheel', (event) => this.onWheel(event), { passive: false })
    this.canvasEl.addEventListener('dblclick', (event) => this.onDoubleClick(event))
    this.canvasEl.addEventListener('pointerleave', () => {
      if (!this.itineraryEdit) return
      this.routeHover = null
      this.requestDraw()
    })
    this.userStampEl.addEventListener('pointerdown', (event) => this.onUserStampDown(event))
    this.userStampEl.addEventListener('pointermove', (event) => this.onUserStampMove(event))
    this.userStampEl.addEventListener('pointerup', (event) => this.onUserStampUp(event))
    this.userStampEl.addEventListener('pointercancel', (event) => this.onUserStampUp(event))
    this.maplibreEl.addEventListener('mousedown', this.onTileMapDomMouseDown, true)
    document.addEventListener('mousemove', this.onTileMapDomMouseMove)
    document.addEventListener('mouseup', this.onTileMapDomMouseUp)
    this.offs.push(() => this.maplibreEl.removeEventListener('mousedown', this.onTileMapDomMouseDown, true))
    this.offs.push(() => document.removeEventListener('mousemove', this.onTileMapDomMouseMove))
    this.offs.push(() => document.removeEventListener('mouseup', this.onTileMapDomMouseUp))
    this.searchEl.addEventListener('input', () => this.onSearchInput())
    this.searchEl.addEventListener('keydown', (event) => this.onSearchKeyDown(event))
    this.categoryFilterEl.addEventListener('input', () => this.renderCategories())
    this.packageSelectEl.addEventListener('change', () => {
      const id = this.packageSelectEl.value
      if (id) void this.loadPackage(id)
    })
    this.contextModalEl.addEventListener('click', (event) => {
      const target = event.target as HTMLElement
      if (target.closest('[data-context-action="close"]') || target === this.contextModalEl) {
        this.contextModalEl.hidden = true
        return
      }
      const action = target.closest<HTMLElement>('[data-context-action]')?.dataset.contextAction
      if (action === 'copy') {
        void navigator.clipboard?.writeText(this.contextText())
        this.toast('已复制 AI 上下文')
      } else if (action === 'place') {
        this.contextModalEl.hidden = true
        this.startUserPlacement()
      } else if (action === 'from-selected') {
        const marker = this.selectedMarker()
        if (marker) {
          this.setUserPosition(marker.x, marker.y, marker.id)
          this.showContextStatus()
        } else {
          this.toast('先点开一个地点，再移动我过去')
        }
      } else if (action === 'clear-position') {
        this.clearUserPosition()
        this.renderContextControls()
      } else if (action === 'grid') {
        this.contextModalEl.hidden = true
        this.openGridPanel()
      }
    })
    this.contextInjectEl.addEventListener('change', () => {
      const settings = loadSettings(this.ctx)
      settings.layerMapContext = this.contextInjectEl.checked
      if (settings.layerMapContext) settings.realMapContext = false
      saveSettings(this.ctx, settings)
      this.callbacks.onSettingsChanged?.()
      this.renderContextControls()
    })
    this.imagePanelEl.addEventListener('click', (event) => this.onImagePanelClick(event))
    this.imagePanelEl.addEventListener('change', (event) => this.onImagePanelChange(event))
    this.lightboxEl.addEventListener('click', (event) => {
      const target = event.target as HTMLElement
      if (target.closest('[data-lightbox-action="close"]') || target === this.lightboxEl) {
        this.closeLightbox()
      }
    })
    this.alignBarEl.addEventListener('click', (event) => {
      const target = event.target as HTMLElement
      const action = target.closest<HTMLElement>('[data-align-action]')?.dataset.alignAction
      if (action === 'reset') this.resetAlign()
      else if (action === 'cancel') this.cancelAlign()
      else if (action === 'done') void this.finishAlign()
    })
    this.imageInput.addEventListener('change', () => {
      const file = this.imageInput.files?.[0]
      this.imageInput.value = ''
      if (file) void this.replaceImage(file)
    })
    this.tilesInput.addEventListener('change', () => {
      const files = Array.from(this.tilesInput.files ?? [])
      this.tilesInput.value = ''
      if (files.length) void this.replaceTiles(files)
    })
    this.gridPanelEl.addEventListener('click', (event) => {
      const target = event.target as HTMLElement
      const action = target.closest<HTMLElement>('[data-grid-action]')?.dataset.gridAction
      if (action === 'close' || action === 'done') this.closeGridPanel()
      else if (action === 'reset') this.resetGrid()
      else if (action === 'collapse') this.toggleGridCollapsed()
      else if (action === 'scale-in') this.scaleGrid(1.15)
      else if (action === 'scale-out') this.scaleGrid(1 / 1.15)
    })
    for (const input of [this.gridCellEl, this.gridXEl, this.gridYEl, this.gridShowEl]) {
      input.addEventListener('input', () => this.applyGridInputs())
      input.addEventListener('change', () => this.applyGridInputs())
    }
    for (const input of [this.distanceAmountEl, this.distanceLabelEl]) {
      input.addEventListener('input', () => this.applyDistanceInputs(false))
      input.addEventListener('change', () => this.applyDistanceInputs(true))
    }
    this.gridRangeEl.addEventListener('input', () => {
      this.gridCellEl.value = this.gridRangeEl.value
      this.applyGridInputs()
    })
    this.gridOriginHandleEl.addEventListener('pointerdown', this.onGridHandleDown)
    this.gridOriginHandleEl.addEventListener('pointermove', this.onGridHandleMove)
    this.gridOriginHandleEl.addEventListener('pointerup', this.onGridHandleUp)
    this.gridOriginHandleEl.addEventListener('pointercancel', this.onGridHandleUp)
    this.gridScaleHandleEl.addEventListener('pointerdown', this.onGridHandleDown)
    this.gridScaleHandleEl.addEventListener('pointermove', this.onGridHandleMove)
    this.gridScaleHandleEl.addEventListener('pointerup', this.onGridHandleUp)
    this.gridScaleHandleEl.addEventListener('pointercancel', this.onGridHandleUp)
    this.viewportEl.addEventListener('wheel', this.onGridWheel, { passive: false, capture: true })
    this.placeBarEl.addEventListener('click', (event) => {
      const target = event.target as HTMLElement
      if (target.closest('[data-user-action="cancel"]')) this.cancelPlacements()
      const pinMove = target.closest<HTMLElement>('[data-pin-move]')?.dataset.pinMove
      if (pinMove === 'undo') this.stepPinMove(-1)
      else if (pinMove === 'redo') this.stepPinMove(1)
      else if (pinMove === 'cancel') this.cancelPlacements()
      else if (pinMove === 'confirm') this.endPinMove(true)
    })
    const onResize = (): void => {
      if (this.imagePanelOpen) this.positionImagePanel()
    }
    window.addEventListener('resize', onResize)
    this.offs.push(() => window.removeEventListener('resize', onResize))
    document.addEventListener('pointerup', onResize)
    this.offs.push(() => document.removeEventListener('pointerup', onResize))
    const panelObserver = new ResizeObserver(onResize)
    panelObserver.observe(this.panelEl)
    this.offs.push(() => panelObserver.disconnect())
    document.addEventListener('keydown', this.onKeyDown)
    document.addEventListener('click', this.onDocumentClick)
    this.offs.push(() => document.removeEventListener('keydown', this.onKeyDown))
    this.offs.push(() => document.removeEventListener('click', this.onDocumentClick))
    this.offs.push(() =>
      this.viewportEl.removeEventListener('wheel', this.onGridWheel, { capture: true }),
    )
  }

  private readonly offs: Array<() => void> = []

  private onPanelClick(event: MouseEvent): void {
    const target = event.target as HTMLElement
    const leftTab = target.closest<HTMLElement>('[data-left-tab]')?.dataset.leftTab
    if (leftTab === 'layers' || leftTab === 'favorites') {
      this.layerPaneEl.hidden = leftTab !== 'layers'
      this.favoritesEl.hidden = leftTab !== 'favorites'
      for (const button of this.panelEl.querySelectorAll<HTMLElement>('[data-left-tab]')) {
        button.classList.toggle('active', button.dataset.leftTab === leftTab)
      }
      this.renderFavorites()
      return
    }
    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action
    if (!action) return
    switch (action) {
      case 'close':
        this.close()
        break
      case 'real-map':
        this.close()
        this.callbacks.onRealMap()
        break
      case 'import':
        this.openImport()
        break
      case 'manage':
        this.openManage()
        break
      case 'image-panel':
        this.toggleImagePanel()
        break
      case 'ai':
        this.showContextStatus()
        break
      case 'fit':
        this.fitView()
        break
      case 'zoom-in':
        this.zoomAt(this.canvasEl.clientWidth / 2, this.canvasEl.clientHeight / 2, 1.45)
        break
      case 'zoom-out':
        this.zoomAt(this.canvasEl.clientWidth / 2, this.canvasEl.clientHeight / 2, 1 / 1.45)
        break
      case 'filters':
        this.panelEl.classList.toggle('filters-open')
        break
      case 'labels':
        // Labels are on unless explicitly turned off (undefined = on).
        this.state.showLabels = this.state.showLabels === false
        this.syncToolButtons()
        this.persist()
        this.requestDraw()
        break
      case 'regions':
        this.state.showRegions = this.state.showRegions === false
        this.syncToolButtons()
        this.persist()
        this.requestDraw()
        break
      case 'roads':
        // Road lines are off unless turned on: the base map usually draws roads already.
        this.state.showRoads = this.state.showRoads !== true
        this.syncToolButtons()
        this.persist()
        this.requestDraw()
        break
      case 'add-pin':
        if (this.placingPin === 'add') this.cancelPinPlacement()
        else this.startPinPlacement('add')
        break
      case 'itinerary':
        this.toggleItineraryShelf()
        break
      case 'undo-pin': {
        const selected = this.selectedMarker()
        if (selected) this.undoPin(selected.id)
        break
      }
      case 'redo-pin': {
        const selected = this.selectedMarker()
        if (selected) this.redoPin(selected.id)
        break
      }
      case 'locate':
        if (this.placingUser) this.cancelUserPlacement()
        else if (this.state.userPosition) this.centerOnUserPosition()
        else this.startUserPlacement()
        break
      case 'grid':
        if (this.gridPanelOpen) this.closeGridPanel()
        else this.openGridPanel()
        break
      case 'show-all':
        this.state.hiddenCategories = []
        this.renderCategories()
        this.refreshContext()
        this.persist()
        this.requestDraw()
        break
      case 'hide-all':
        this.state.hiddenCategories = this.effectiveCategoryList.map((category) => category.id)
        this.renderCategories()
        this.refreshContext()
        this.persist()
        this.requestDraw()
        break
      default:
        break
    }
  }

  private renderContextPosition(): void {
    if (!this.contextPositionEl) return
    const user = this.state.userPosition
    if (!user) {
      this.contextPositionEl.textContent = '未设置；不会输出“我的位置”。'
      this.contextXEl.value = ''
      this.contextYEl.value = ''
      return
    }
    const area = this.regionForPoint(user.x, user.y)?.name
    const road = this.currentRoad()
    const roadText = road ? ` · ${road.on ? '在路上' : '附近道路'}：${this.roadDisplayName(road.road.street)}` : ''
    this.contextPositionEl.textContent = `${this.pointText(user.x, user.y)}${area ? ` · ${area}` : ''}${roadText}`
    this.contextXEl.value = (user.x * 100).toFixed(2)
    this.contextYEl.value = (user.y * 100).toFixed(2)
  }

  private renderContextControls(): void {
    if (!this.contextInjectEl) return
    this.renderContextPosition()
    this.contextInjectEl.checked = loadSettings(this.ctx).layerMapContext
    const grid = this.gridConfig()
    this.contextGridEl.textContent = grid
      ? `已校准 · 坐标按格 · ${distanceUnitText(grid) ?? '距离按格（未设换算）'}`
      : '未校准；AI 使用地图百分比坐标'
  }

  private renderContextPreview(): void {
    const text = this.contextText()
    this.contextTextEl.textContent =
      text || '（还没有当前地点或当前区域。先点一个地点、放置我的位置，或校准网格。）'
    this.contextTokensEl.textContent = text
      ? `≈ ${estimateTokens(text)} tokens · 笔记全文不截断`
      : '当前不会注入'
    this.contextStatusEl.textContent = text ? '图层上下文：已生成' : '图层上下文：待机'
    this.contextStatusEl.title = text
      ? '当前图层地图场景会进入 AI 上下文'
      : '没有可注入的图层地图上下文'
  }

  private showContextStatus(): void {
    this.renderContextControls()
    this.renderContextPreview()
    this.contextModalEl.hidden = false
  }

  private syncToolButtons(): void {
    const labels = this.panelEl.querySelector<HTMLElement>('[data-action="labels"]')
    const regions = this.panelEl.querySelector<HTMLElement>('[data-action="regions"]')
    labels?.classList.toggle('active', this.state.showLabels !== false)
    labels?.setAttribute('aria-pressed', String(this.state.showLabels !== false))
    regions?.classList.toggle('active', this.state.showRegions !== false)
    regions?.setAttribute('aria-pressed', String(this.state.showRegions !== false))
    const roads = this.panelEl.querySelector<HTMLElement>('[data-action="roads"]')
    if (roads) {
      roads.hidden = !this.pkg?.streets?.length
      roads.classList.toggle('active', this.state.showRoads === true)
      roads.setAttribute('aria-pressed', String(this.state.showRoads === true))
    }
    const grid = this.panelEl.querySelector<HTMLElement>('[data-action="grid"]')
    grid?.classList.toggle('active', this.gridPanelOpen)
    const locate = this.panelEl.querySelector<HTMLElement>('[data-action="locate"]')
    locate?.classList.toggle('active', this.placingUser || Boolean(this.state.userPosition))
    const addPin = this.panelEl.querySelector<HTMLElement>('[data-action="add-pin"]')
    addPin?.classList.toggle('active', this.placingPin === 'add')
    const routeTool = this.panelEl.querySelector<HTMLElement>('[data-action="itinerary"]')
    if (routeTool) {
      const count = this.itinerary?.stops.length ?? this.itineraryDraft?.stops.length ?? 0
      routeTool.textContent = count > 0 ? `行程 ${count}` : '行程'
      routeTool.classList.toggle('active', this.itineraryEdit || this.routeShelfOpen)
    }
    const selected = this.selectedMarker()
    const history = selected ? this.pinHistoryFor(selected.id) : undefined
    const undo = this.panelEl.querySelector<HTMLButtonElement>('[data-action="undo-pin"]')
    const redo = this.panelEl.querySelector<HTMLButtonElement>('[data-action="redo-pin"]')
    const session = selected && this.pinMove?.id === selected.id ? this.pinMove : undefined
    if (undo) undo.disabled = session ? session.cursor <= 0 : !history?.past.length
    if (redo) redo.disabled = session ? session.cursor >= session.points.length - 1 : !history?.future.length
  }

  private async refreshPackages(): Promise<void> {
    this.metas = await listLayerPackages()
    this.packageSelectEl.replaceChildren()
    if (this.metas.length === 0) {
      const option = new Option('没有地图包', '')
      this.packageSelectEl.append(option)
      this.packageSelectEl.disabled = true
      return
    }
    this.packageSelectEl.disabled = false
    for (const meta of this.metas) {
      this.packageSelectEl.append(
        new Option(`${meta.kind === 'tiles' ? '瓦片' : '图片'} · ${meta.name}`, meta.id),
      )
    }
    if (this.state.packageId && this.metas.some((meta) => meta.id === this.state.packageId)) {
      this.packageSelectEl.value = this.state.packageId
    }
  }

  /**
   * Imported package data stays untouched. This view is the only source for
   * drawing, hit-testing, search, nearby places, favorites and AI context.
   */
  private rebuildEffectiveMarkers(): void {
    this.effectiveMarkerMap.clear()
    this.effectiveMarkerList = []
    this.effectiveCategoryList = []
    this.effectiveGroupList = []
    const pkg = this.pkg
    if (!pkg) {
      this.buildMarkerIndex()
      return
    }
    const customPins = this.pinEdits.customPins
    const imported = pkg.markers.map((marker) => {
      const override = this.pinEdits.overrides[marker.id]
      return override
        ? { ...marker, x: override.x, y: override.y }
        : marker
    })
    const custom = customPins.map((pin) => ({ ...pin, custom: true as const }))
    this.effectiveCategoryList = [...pkg.categories]
    this.effectiveGroupList = [...pkg.groups]
    if (custom.length > 0) {
      if (!this.effectiveCategoryList.some((item) => item.id === CUSTOM_PIN_CATEGORY.id)) {
        this.effectiveCategoryList.push(CUSTOM_PIN_CATEGORY)
      }
      if (!this.effectiveGroupList.some((item) => item.id === CUSTOM_PIN_GROUP.id)) {
        this.effectiveGroupList.push(CUSTOM_PIN_GROUP)
      }
    }
    this.effectiveMarkerList = [...imported, ...custom]
    for (const marker of this.effectiveMarkerList) {
      this.effectiveMarkerMap.set(marker.id, marker)
    }
    this.markerRegionCache.clear()
    this.buildMarkerIndex()
  }

  private markerById(id: string | undefined): LayerMarker | undefined {
    return id ? this.effectiveMarkerMap.get(id) : undefined
  }

  private categoryById(id: string): LayerCategory | undefined {
    return this.effectiveCategoryList.find((category) => category.id === id)
  }

  private customPinRecord(id: string): LayerCustomPin | undefined {
    return this.pinEdits.customPins.find((pin) => pin.id === id)
  }

  private userLinksFor(owner: LinkOwner): LayerLink[] {
    if (owner.custom) return this.customPinRecord(owner.id)?.links ?? owner.links ?? []
    return this.state.links?.[owner.id] ?? []
  }

  private setUserLinks(owner: LinkOwner, links: LayerLink[]): void {
    if (owner.custom) {
      const pin = this.customPinRecord(owner.id)
      if (!pin) return
      pin.links = links
      this.savePinEditsForMap()
    } else {
      const saved = this.state.links ?? (this.state.links = {})
      saved[owner.id] = links
      this.persist()
    }
  }

  private async loadPackage(id: string): Promise<void> {
    this.cancelPlacements()
    const pkg = await getLayerPackage(id)
    if (!pkg) {
      this.pkg = null
      this.pinEdits = emptyPinEdits()
      this.placeAIFlags = {}
      this.itinerary = null
      this.itineraryDraft = null
      this.itineraryEdit = false
      this.routeShelfOpen = false
      this.rebuildEffectiveMarkers()
      this.clearImageResources()
      this.setTileMapVisible(false)
      this.clearTileCaches()
      this.syncHeaderImage()
      this.renderEmpty('地图包读取失败或已不存在。')
      this.renderCategories()
      this.renderFavorites()
      this.renderDetail()
      this.renderItineraryShelf()
      this.requestDraw()
      return
    }
    const changed = this.state.packageId !== pkg.id
    if (changed) {
      this.tileViewPackageId = ''
      this.tileMoving = false
      if (this.saveTimer !== undefined) {
        window.clearTimeout(this.saveTimer)
        this.saveTimer = undefined
      }
      this.rememberUserPosition()
      this.state.packageId = pkg.id
      this.state.selectedMarkerId = undefined
      this.state.currentMarkerId = undefined
      this.state.userPosition = undefined
      this.state.atPlaceId = undefined
      this.state.selectedRegionId = undefined
      this.state.selectedRoadKey = undefined
      this.state.currentRegionId = undefined
      this.state.view = undefined
      this.state.hiddenCategories = []
      this.linkDraftFor = undefined
      this.lastRemovedImage = null
      this.packageLoadToken += 1
    }
    if (changed || !this.state.userPosition) this.restoreUserPosition(pkg.id)
    if (!this.state.view && pkg.defaultView) {
      this.state.view = { ...pkg.defaultView }
      this.view = { ...pkg.defaultView }
    }
    if (this.pkg && this.pkg.id !== pkg.id) tileProtocolPackages.delete(this.pkg.id)
    this.pkg = pkg
    this.pinEdits = loadPinEdits(pkg.id)
    this.placeAIFlags = loadPlaceAIFlags(pkg.id)
    this.itinerary = this.state.itinerariesByPackage?.[pkg.id] ?? null
    this.itineraryDraft = null
    this.itineraryEdit = false
    this.routeShelfOpen = false
    this.routeExpandedLeg = 0
    this.rebuildEffectiveMarkers()
    this.migrateLegacyNotes(pkg)
    await this.ensureIconFont(pkg)
    await this.ensureIconAtlas(pkg)
    if (
      this.state.atPlaceId &&
      !this.markerById(this.state.atPlaceId)
    ) {
      this.state.atPlaceId = undefined
    }
    if (
      this.state.selectedMarkerId &&
      !this.markerById(this.state.selectedMarkerId)
    ) {
      this.state.selectedMarkerId = undefined
    }
    if (
      this.state.currentMarkerId &&
      !this.markerById(this.state.currentMarkerId)
    ) {
      this.state.currentMarkerId = undefined
    }
    if (
      this.state.selectedRegionId &&
      !pkg.regions.some((region) => region.id === this.state.selectedRegionId)
    ) {
      this.state.selectedRegionId = undefined
    }
    if (
      this.state.currentRegionId &&
      !pkg.regions.some((region) => region.id === this.state.currentRegionId)
    ) {
      this.state.currentRegionId = undefined
    }
    this.panelEl.classList.remove('filters-open')
    this.emptyMessage = ''
    this.emptyEl.hidden = true
    this.markerRegionCache.clear()
    this.regionLabelCache.clear()
    this.streetLabelCache.clear()
    this.roadIndexCache = undefined
    this.currentRoadCache = undefined
    this.rebuildEffectiveMarkers()
    this.clearTileCaches()
    this.packageSelectEl.value = pkg.id
    // Render the panel chrome and data before waiting for MapLibre. A slow or
    // blocked tile connection must not leave the whole map panel as a black box.
    this.renderCategories()
    this.refreshFavoriteMarkerIds()
    this.renderFavorites()
    this.renderDetail()
    this.renderItineraryShelf()
    this.syncToolButtons()
    this.updatePackageInfo()
    this.syncHeaderImage()
    if (this.imagePanelOpen) this.renderImagePanel()
    this.refreshContext()
    this.renderItineraryShelf()
    this.requestDraw()
    if (pkg.kind === 'tiles') {
      this.clearImageResources()
      const loadToken = this.packageLoadToken
      void this.loadTileMap(pkg, loadToken).catch((error) => {
        console.warn('[tavern-map] tile map initialization failed', error)
        this.toast('底图初始化失败；地点和标签仍可查看。')
        this.requestDraw()
      })
    } else {
      this.setTileMapVisible(false)
      this.view = this.resolveView(pkg, this.state.view)
      this.state.view = this.view
      this.loadImage(pkg)
    }
  }

  private updatePackageInfo(): void {
    const pkg = this.pkg
    if (!pkg) {
      this.packageInfoEl.textContent = ''
      return
    }
    const customCount = this.pinEdits.customPins.length
    this.packageInfoEl.textContent = [
      pkg.kind === 'tiles' ? '瓦片地图' : '图片地图',
      `${pkg.markers.length} 个地点${customCount ? ` + ${customCount} 个我的图钉` : ''}`,
      pkg.regions.length ? `${pkg.regions.length} 个区域` : '无区域面',
      pkg.sourceLabel || (pkg.source === 'mapgenie' ? 'Map Genie' : pkg.source === 'fandom' ? 'Fandom' : '本地'),
      pkg.kind === 'tiles'
        ? Object.keys(pkg.tileFiles ?? {}).length > 0
          ? `${Object.keys(pkg.tileFiles ?? {}).length} 张瓦片`
          : pkg.tile?.template
            ? '在线瓦片'
            : '0 张瓦片'
        : pkg.image
          ? '有底图'
          : '缺底图',
    ].join(' · ')
    this.attributionEl.textContent = `${pkg.attribution ?? '本地地图包'} · 数据不会上传`
  }

  private resolveView(pkg: LayerMapPackage, previous: LayerView | undefined): LayerView {
    if (previous) return previous
    return this.defaultView(pkg)
  }

  private defaultView(pkg: LayerMapPackage): LayerView {
    if (pkg.kind === 'image') return { cx: 0.5, cy: 0.5, zoom: 1 }
    const tile = pkg.tile
    const min = tile?.coverageMinZoom ?? tile?.minZoom ?? 0
    const max = tile?.coverageMaxZoom ?? tile?.maxZoom ?? min + 8
    const width = Math.max(240, this.viewportEl.clientWidth || 800)
    const height = Math.max(240, this.viewportEl.clientHeight || 600)
    if (tile?.projection === 'webmercator' && tile.worldBounds) {
      const bounds = tile.worldBounds
      const spanX = Math.max(1e-6, bounds.maxX - bounds.minX)
      const spanY = Math.max(1e-6, bounds.maxY - bounds.minY)
      const fit = Math.min(width / (spanX * 256), height / (spanY * 256))
      const zoom = Math.min(max + 0.8, Math.max(0, Math.log2(fit)))
      return {
        cx: (bounds.minX + bounds.maxX) / 2,
        cy: (bounds.minY + bounds.maxY) / 2,
        zoom,
      }
    }
    const zoom = Math.min(max + 0.8, Math.max(min, min + Math.log2(Math.min(width, height) / 256)))
    return { cx: 0.5, cy: 0.5, zoom }
  }

  private clearImageResources(): void {
    if (this.imageLoadTimer !== undefined) {
      window.clearTimeout(this.imageLoadTimer)
      this.imageLoadTimer = undefined
    }
    if (this.imageUrl) {
      URL.revokeObjectURL(this.imageUrl)
      this.imageUrl = null
    }
    if (this.imagePreviewUrl) {
      URL.revokeObjectURL(this.imagePreviewUrl)
      this.imagePreviewUrl = null
    }
    this.imagePreviewToken += 1
    this.image = null
    this.imagePreview = null
    this.imageLarge = false
    this.imageFullRequested = false
  }

  private loadFullImage(pkg: LayerMapPackage): void {
    if (this.imageFullRequested || !pkg.image) return
    this.imageFullRequested = true
    const url = URL.createObjectURL(pkg.image)
    this.imageUrl = url
    const image = new Image()
    image.onload = () => {
      if (this.imageUrl !== url) return
      this.image = image
      this.emptyMessage = ''
      this.emptyEl.hidden = true
      this.syncHeaderImage()
      this.requestDraw()
    }
    image.onerror = () => {
      if (this.imageUrl !== url) return
      this.image = null
      this.imageLarge = false
      this.imageFullRequested = false
      this.emptyMessage = ''
      this.emptyEl.hidden = true
      this.syncHeaderImage()
      this.toast('底图加载失败，点顶栏“底图”可以更换图片')
      this.requestDraw()
    }
    image.src = url
  }

  private async loadMediumPreview(pkg: LayerMapPackage, token: number): Promise<void> {
    if (!pkg.image) return
    try {
      const maxSide = 1800
      const width = pkg.imageWidth ?? 0
      const height = pkg.imageHeight ?? 0
      let options: ImageBitmapOptions | undefined
      if (width > 0 && height > 0) {
        const scale = Math.min(1, maxSide / Math.max(width, height))
        options = {
          resizeWidth: Math.max(1, Math.round(width * scale)),
          resizeHeight: Math.max(1, Math.round(height * scale)),
          resizeQuality: 'medium',
        }
      } else {
        options = { resizeWidth: maxSide, resizeQuality: 'medium' }
      }
      const bitmap = await createImageBitmap(pkg.image, options)
      if (token !== this.imagePreviewToken) {
        bitmap.close()
        return
      }
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const context = canvas.getContext('2d')
      if (!context) {
        bitmap.close()
        return
      }
      context.drawImage(bitmap, 0, 0)
      bitmap.close()
      const blob = await new Promise<Blob | undefined>((resolve) => {
        canvas.toBlob((result) => resolve(result ?? undefined), 'image/jpeg', 0.82)
      })
      if (!blob || token !== this.imagePreviewToken) return
      const url = URL.createObjectURL(blob)
      const image = new Image()
      image.onload = () => {
        if (token !== this.imagePreviewToken) {
          URL.revokeObjectURL(url)
          return
        }
        if (this.imagePreviewUrl) URL.revokeObjectURL(this.imagePreviewUrl)
        this.imagePreviewUrl = url
        this.imagePreview = image
        this.requestDraw()
      }
      image.onerror = () => URL.revokeObjectURL(url)
      image.src = url
    } catch {
      // The thumbnail remains usable if the browser cannot resize this image.
    }
  }

  private loadImage(pkg: LayerMapPackage): void {
    this.clearImageResources()
    this.syncHeaderImage()
    if (!pkg.image) {
      this.requestDraw()
      return
    }
    const area = Math.max(0, (pkg.imageWidth ?? 0) * (pkg.imageHeight ?? 0))
    this.imageLarge = area > 16_000_000 || pkg.image.size > 12 * 1024 * 1024
    if (this.imageLarge && pkg.thumbnail) {
      const previewUrl = URL.createObjectURL(pkg.thumbnail)
      this.imagePreviewUrl = previewUrl
      const preview = new Image()
      preview.onload = () => {
        if (this.imagePreviewUrl !== previewUrl) return
        this.imagePreview = preview
        this.emptyMessage = ''
        this.emptyEl.hidden = true
        this.requestDraw()
      }
      preview.src = previewUrl
      // Progressive: thumbnail now, medium overview next, full-resolution only
      // after the user actually zooms in.
      void this.loadMediumPreview(pkg, this.imagePreviewToken)
      this.requestDraw()
      return
    }
    this.loadFullImage(pkg)
  }

  private normalizedToLngLat(x: number, y: number): [number, number] {
    return lngLatFromNormalized(x, y)
  }

  private lngLatToNormalized(lng: number, lat: number): { x: number; y: number } {
    return normalizedFromLngLat(lng, lat)
  }

  private async ensureTileMap(): Promise<MapLibreMap> {
    if (this.maplibreMap) return this.maplibreMap
    registerTileProtocol()
    const map = new MapLibreMap({
      container: this.maplibreEl,
      style: {
        version: 8,
        sources: {},
        layers: [
          {
            id: 'tml-bg',
            type: 'background',
            paint: { 'background-color': '#0a0f14' },
          },
        ],
      },
      center: [0, 0],
      zoom: 1,
      minZoom: 0,
      maxZoom: 25,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      fadeDuration: 0,
      maxTileCacheSize: 256,
      localIdeographFontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
    })
    this.maplibreMap = map
    map.touchZoomRotate.disableRotation()
    map.on('move', () => this.onTileMapMove())
    map.on('moveend', () => this.onTileMapMoveEnd())
    map.on('click', (event) => this.onTileMapClick(event))
    map.on('mousemove', (event) => {
      if (!this.itineraryEdit || this.itineraryDraft?.stops.length === 0) return
      const point = this.lngLatToNormalized(event.lngLat.lng, event.lngLat.lat)
      this.routeHover = point
      this.requestDraw()
    })
    map.on('mouseout', () => {
      if (!this.itineraryEdit) return
      this.routeHover = null
      this.requestDraw()
    })
    this.maplibreReady = new Promise<void>((resolve) => {
      map.once('load', () => resolve())
    })
    await this.maplibreReady
    return map
  }

  private setTileMapVisible(visible: boolean): void {
    this.maplibreEl.hidden = !visible
    this.canvasEl.classList.toggle('tml-tile-overlay', visible)
    this.canvasEl.style.pointerEvents = visible ? 'none' : ''
    if (visible) {
      this.maplibreMap?.resize()
      this.maplibreMap?.triggerRepaint()
    }
  }

  private tileBoundsNormalized(pkg: LayerMapPackage): {
    minX: number
    minY: number
    maxX: number
    maxY: number
  } | undefined {
    const tile = pkg.tile
    const zoom = tile?.coverageMaxZoom
    const bounds = zoom != null ? tile?.boundsByZoom?.[String(zoom)] : undefined
    if (bounds && zoom != null) {
      const scale = 2 ** zoom
      return {
        minX: bounds.xMin / scale,
        minY: bounds.yMin / scale,
        maxX: (bounds.xMax + 1) / scale,
        maxY: (bounds.yMax + 1) / scale,
      }
    }
    return tile?.worldBounds
  }

  private tileBoundsLngLat(pkg: LayerMapPackage): [number, number, number, number] | undefined {
    const bounds = this.tileBoundsNormalized(pkg)
    if (!bounds) return undefined
    const [west, north] = lngLatFromNormalized(bounds.minX, bounds.minY)
    const [east, south] = lngLatFromNormalized(bounds.maxX, bounds.maxY)
    return [west, south, east, north]
  }

  private async applyTileSource(pkg: LayerMapPackage): Promise<void> {
    const map = await this.ensureTileMap()
    const tile = pkg.tile
    if (!tile) return
    const coverageMin = tile.coverageMinZoom ?? tile.minZoom ?? 0
    const coverageMax = Math.max(coverageMin, tile.coverageMaxZoom ?? tile.maxZoom ?? coverageMin)
    const min = coverageMin
    const max = coverageMax
    tileProtocolPackages.set(pkg.id, pkg)
    if (map.getLayer(REMOTE_TILE_LAYER_ID)) map.removeLayer(REMOTE_TILE_LAYER_ID)
    if (map.getSource(REMOTE_TILE_SOURCE_ID)) map.removeSource(REMOTE_TILE_SOURCE_ID)
    if (map.getLayer(TILE_LAYER_ID)) map.removeLayer(TILE_LAYER_ID)
    if (map.getSource(TILE_SOURCE_ID)) map.removeSource(TILE_SOURCE_ID)
    const bounds = this.tileBoundsLngLat(pkg)
    const source: {
      type: 'raster'
      tiles: string[]
      tileSize: number
      minzoom: number
      maxzoom: number
      bounds?: [number, number, number, number]
    } = {
      type: 'raster',
      tiles: [`${TILE_PROTOCOL}://${encodeURIComponent(pkg.id)}/{z}/{x}/{y}`],
      tileSize: 256,
      minzoom: min,
      maxzoom: max,
    }
    if (bounds) source.bounds = bounds
    map.addSource(TILE_SOURCE_ID, source)
    map.addLayer({
      id: TILE_LAYER_ID,
      type: 'raster',
      source: TILE_SOURCE_ID,
      paint: {
        'raster-opacity': 1,
        'raster-fade-duration': 0,
      },
    })
    const remoteMax = tile.maxZoom ?? 0
    const remoteTemplate = tile.remoteTemplate?.trim()
    if (remoteTemplate && remoteMax > coverageMax) {
      const remoteSource: {
        type: 'raster'
        tiles: string[]
        tileSize: number
        minzoom: number
        maxzoom: number
        bounds?: [number, number, number, number]
      } = {
        type: 'raster',
        tiles: [remoteTemplate],
        tileSize: 256,
        minzoom: coverageMax + 1,
        maxzoom: remoteMax,
      }
      if (bounds) remoteSource.bounds = bounds
      map.addSource(REMOTE_TILE_SOURCE_ID, remoteSource)
      map.addLayer({
        id: REMOTE_TILE_LAYER_ID,
        type: 'raster',
        source: REMOTE_TILE_SOURCE_ID,
        paint: {
          'raster-opacity': 1,
          'raster-fade-duration': 0,
        },
      })
    }
    map.setMinZoom(min)
    map.setMaxZoom(25)
    map.setPaintProperty('tml-bg', 'background-color', tile.backgroundColor ?? '#0a0f14')
    map.resize()
    map.triggerRepaint()
  }

  private async loadTileMap(pkg: LayerMapPackage, loadToken: number): Promise<void> {
    if (loadToken !== this.packageLoadToken || this.pkg?.id !== pkg.id) return
    this.setTileMapVisible(true)
    await this.ensureTileMap()
    if (loadToken !== this.packageLoadToken || this.pkg?.id !== pkg.id) return
    await this.applyTileSource(pkg)
    if (loadToken !== this.packageLoadToken || this.pkg?.id !== pkg.id) return
    this.tileViewPackageId = pkg.id
    if (!this.state.view || !this.canRestoreTileView(pkg)) {
      await this.fitTileMap(pkg)
    } else {
      this.applyStoredTileView()
    }
  }

  private canRestoreTileView(pkg: LayerMapPackage): boolean {
    const bounds = this.tileBoundsNormalized(pkg)
    const view = this.state.view
    if (!bounds || !view) return false
    const marginX = (bounds.maxX - bounds.minX) * 0.02
    const marginY = (bounds.maxY - bounds.minY) * 0.02
    return (
      view.cx > bounds.minX + marginX &&
      view.cx < bounds.maxX - marginX &&
      view.cy > bounds.minY + marginY &&
      view.cy < bounds.maxY - marginY
    )
  }

  private applyStoredTileView(): void {
    const map = this.maplibreMap
    const view = this.state.view
    if (!map || !view) return
    const [lng, lat] = this.normalizedToLngLat(view.cx, view.cy)
    map.jumpTo({ center: [lng, lat], zoom: view.zoom })
    map.resize()
    map.triggerRepaint()
    this.syncViewFromMap()
  }

  private async fitTileMap(pkg: LayerMapPackage): Promise<void> {
    const map = await this.ensureTileMap()
    const bounds = this.tileBoundsLngLat(pkg)
    if (bounds) {
      const tile = pkg.tile
      const max = tile?.coverageMaxZoom ?? tile?.maxZoom ?? 0
      map.fitBounds(bounds, {
        padding: 24,
        duration: 0,
        maxZoom: max + 0.8,
      })
    } else {
      const view = this.defaultView(pkg)
      const [lng, lat] = this.normalizedToLngLat(view.cx, view.cy)
      map.jumpTo({ center: [lng, lat], zoom: view.zoom })
    }
    map.resize()
    map.triggerRepaint()
    this.syncViewFromMap()
    window.requestAnimationFrame(() => {
      map.resize()
      map.triggerRepaint()
      this.syncViewFromMap()
    })
  }

  private syncViewFromMap(): void {
    const map = this.maplibreMap
    if (!map || this.pkg?.kind !== 'tiles' || this.tileViewPackageId !== this.pkg.id) return
    const center = map.getCenter()
    const normalized = this.lngLatToNormalized(center.lng, center.lat)
    this.view = {
      cx: Math.min(1, Math.max(0, normalized.x)),
      cy: Math.min(1, Math.max(0, normalized.y)),
      zoom: map.getZoom(),
    }
    this.state.view = this.view
    this.updateStatus()
    this.requestDraw()
  }

  private onTileMapMove(): void {
    if (!this.maplibreMap || this.pkg?.kind !== 'tiles' || this.tileViewPackageId !== this.pkg.id) return
    this.tileMoving = true
    this.syncViewFromMap()
  }

  private onTileMapMoveEnd(): void {
    if (!this.maplibreMap || this.pkg?.kind !== 'tiles' || this.tileViewPackageId !== this.pkg.id) return
    this.tileMoving = false
    this.syncViewFromMap()
    this.persist()
    this.refreshContext()
  }

  private onTileMapClick(event: {
    point: { x: number; y: number }
    lngLat: { lng: number; lat: number }
    originalEvent?: MouseEvent
  }): void {
    if (!this.pkg) return
    if (this.pkg.kind !== 'tiles') return
    const point = this.lngLatToNormalized(event.lngLat.lng, event.lngLat.lat)
    if (this.itineraryEdit) {
      const marker = this.hitMarker(event.point.x, event.point.y)
      this.addItineraryStop(point.x, point.y, marker)
      return
    }
    // While moving a pin, clicks neither place nor select: only dragging the pin moves it.
    if (this.pinMove) return
    if (this.placingPin === 'add') {
      this.cancelPinPlacement()
      this.createCustomPin(point.x, point.y)
      return
    }
    if (this.placingUser) {
      this.setUserPosition(point.x, point.y, undefined, !event.originalEvent?.altKey)
      return
    }
    const rect = this.viewportEl.getBoundingClientRect()
    this.pickAt(rect.left + event.point.x, rect.top + event.point.y)
  }

  private tileNormalizedAt(clientX: number, clientY: number): { x: number; y: number } | undefined {
    const map = this.maplibreMap
    if (!map) return undefined
    const rect = this.maplibreEl.getBoundingClientRect()
    const point = map.unproject([clientX - rect.left, clientY - rect.top])
    return this.lngLatToNormalized(point.lng, point.lat)
  }

  private readonly onTileMapDomMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return
    if (!this.pkg || this.pkg.kind !== 'tiles' || this.pinDrag) return
    const rect = this.maplibreEl.getBoundingClientRect()
    const marker = this.hitMovingPin(event.clientX - rect.left, event.clientY - rect.top)
    if (!marker) return
    const point = this.tileNormalizedAt(event.clientX, event.clientY)
    if (!point) return
    this.pinDrag = {
      id: marker.id,
      startSx: event.clientX - rect.left,
      startSy: event.clientY - rect.top,
      startX: marker.x,
      startY: marker.y,
      originX: marker.x,
      originY: marker.y,
      pressX: point.x,
      pressY: point.y,
      moved: false,
      pointerId: -1,
    }
    event.preventDefault()
    event.stopImmediatePropagation()
    this.maplibreMap?.dragPan.disable()
  }

  private readonly onTileMapDomMouseMove = (event: MouseEvent): void => {
    if (!this.pinDrag || this.pinDrag.pointerId !== -1) return
    const point = this.tileNormalizedAt(event.clientX, event.clientY)
    if (!point || this.pinDrag.pressX == null || this.pinDrag.pressY == null) return
    const rect = this.maplibreEl.getBoundingClientRect()
    const dx = event.clientX - rect.left - this.pinDrag.startSx
    const dy = event.clientY - rect.top - this.pinDrag.startSy
    if (!this.pinDrag.moved && Math.hypot(dx, dy) < 4) return
    this.pinDrag.moved = true
    this.updatePinCoordinate(
      this.pinDrag.id,
      this.pinDrag.originX + (point.x - this.pinDrag.pressX),
      this.pinDrag.originY + (point.y - this.pinDrag.pressY),
      false,
    )
  }

  private readonly onTileMapDomMouseUp = (): void => {
    if (!this.pinDrag || this.pinDrag.pointerId !== -1) return
    this.maplibreMap?.dragPan.enable()
    this.commitPinDrag(false)
  }

  private observeViewport(): void {
    if (this.resizeObserver) return
    this.resizeObserver = new ResizeObserver(() => {
      this.resizeCanvas()
      this.requestDraw()
    })
    this.resizeObserver.observe(this.viewportEl)
  }

  private resizeCanvas(): void {
    const rect = this.viewportEl.getBoundingClientRect()
    const width = Math.max(1, Math.floor(rect.width))
    const height = Math.max(1, Math.floor(rect.height))
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (this.canvasEl.width !== Math.floor(width * dpr) || this.canvasEl.height !== Math.floor(height * dpr)) {
      this.canvasEl.width = Math.floor(width * dpr)
      this.canvasEl.height = Math.floor(height * dpr)
      this.canvasEl.style.width = `${width}px`
      this.canvasEl.style.height = `${height}px`
    }
    const context = this.canvasEl.getContext('2d')
    context?.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.maplibreMap?.resize()
  }

  private requestDraw(): void {
    if (this.drawFrame) return
    this.drawFrame = window.requestAnimationFrame(() => {
      this.drawFrame = 0
      this.draw()
    })
  }

  private draw(): void {
    const canvas = this.canvasEl
    const width = canvas.clientWidth || 1
    const height = canvas.clientHeight || 1
    const context = canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, width, height)
    if (!this.pkg) {
      context.fillStyle = '#0a0f14'
      context.fillRect(0, 0, width, height)
      this.updateStatus()
      return
    }
    if (this.pkg.kind === 'image') {
      context.fillStyle = this.pkg.tile?.backgroundColor ?? '#0a0f14'
      context.fillRect(0, 0, width, height)
      this.drawImageMap(context, width, height)
    } else if (!this.maplibreMap) {
      context.fillStyle = this.pkg.tile?.backgroundColor ?? '#0a0f14'
      context.fillRect(0, 0, width, height)
      this.drawTileMap(context, width, height)
    }
    this.drawGrid(context, width, height)
    this.drawRegions(context, width, height)
    this.drawRoads(context, width, height)
    this.drawItineraryLine(context, width, height)
    this.drawSelectedRoad(context, width, height)
    this.labelCells.clear()
    this.drawRegionLabels(context, width, height)
    this.drawStreetLabels(context, width, height)
    this.drawMarkers(context, width, height)
    this.drawItineraryPoiRings(context, width, height)
    this.drawUserRadius(context, width, height)
    this.updateUserStamp()
    this.positionRouteStopHandles()
    this.updateGridHandles()
    this.updateStatus()
  }

  private drawGrid(context: CanvasRenderingContext2D, width: number, height: number): void {
    const grid = this.pkg?.grid
    if (!grid || (!this.gridPanelOpen && grid.visible !== true)) return
    const span = this.mapSpan()
    const cellW = Math.max(1e-8, grid.cellW)
    const cellH = Math.max(1e-8, grid.cellH)
    context.save()
    context.lineWidth = 1
    context.strokeStyle = 'rgba(230, 181, 106, 0.62)'
    const startX = grid.originX - Math.ceil((grid.originX - span.x) / cellW) * cellW - cellW
    const startY = grid.originY - Math.ceil((grid.originY - span.y) / cellH) * cellH - cellH
    let count = 0
    for (let x = startX; x <= span.x + span.w + cellW && count < 900; x += cellW, count += 1) {
      const [sx, sy] = this.project(x, span.y, width, height)
      const [ex, ey] = this.project(x, span.y + span.h, width, height)
      context.beginPath()
      context.moveTo(sx, sy)
      context.lineTo(ex, ey)
      context.stroke()
    }
    count = 0
    for (let y = startY; y <= span.y + span.h + cellH && count < 900; y += cellH, count += 1) {
      const [sx, sy] = this.project(span.x, y, width, height)
      const [ex, ey] = this.project(span.x + span.w, y, width, height)
      context.beginPath()
      context.moveTo(sx, sy)
      context.lineTo(ex, ey)
      context.stroke()
    }
    const [ox, oy] = this.project(grid.originX, grid.originY, width, height)
    context.strokeStyle = 'rgba(243, 200, 127, 0.95)'
    context.lineWidth = 1.5
    context.beginPath()
    context.moveTo(ox, 0)
    context.lineTo(ox, height)
    context.moveTo(0, oy)
    context.lineTo(width, oy)
    context.stroke()
    context.fillStyle = 'rgba(243, 200, 127, 0.98)'
    context.font = '600 10px ui-monospace, monospace'
    context.fillText('0,0', ox + 5, oy - 5)
    context.fillText('X', width - 16, Math.max(12, oy - 6))
    context.fillText('Y', ox + 5, height - 8)
    const [bx, by] = this.project(
      grid.originX + grid.cellW * 3,
      grid.originY + grid.cellH * 3,
      width,
      height,
    )
    context.save()
    context.strokeStyle = 'rgba(243, 200, 127, 0.72)'
    context.setLineDash([5, 4])
    context.lineWidth = 1.25
    context.strokeRect(ox, oy, bx - ox, by - oy)
    context.fillStyle = 'rgba(243, 200, 127, 0.95)'
    context.font = '600 9px system-ui, sans-serif'
    context.fillText('3×3 样本', ox + 5, by + 12)
    context.restore()
    context.restore()
  }


  private drawImageMap(context: CanvasRenderingContext2D, width: number, height: number): void {
    const pkg = this.pkg
    if (!pkg) return
    const fit = Math.min(width / pkg.width, height / pkg.height) * IMAGE_FIT_MARGIN
    const scale = fit * this.view.zoom
    const rect = this.aligning && this.alignRect ? this.alignRect : imageRectFor(pkg)
    const drawWidth = rect.w * pkg.width * scale
    const drawHeight = rect.h * pkg.height * scale
    const left = width / 2 + (rect.x - this.view.cx) * pkg.width * scale
    const top = height / 2 + (rect.y - this.view.cy) * pkg.height * scale
    const image = this.image ?? this.imagePreview
    if (image) {
      context.save()
      if (this.aligning) context.globalAlpha = 0.82
      context.drawImage(image, left, top, drawWidth, drawHeight)
      context.restore()
      if (this.aligning) {
        context.save()
        context.strokeStyle = 'rgba(230,181,106,0.85)'
        context.setLineDash([7, 5])
        context.lineWidth = 1.5
        context.strokeRect(left, top, drawWidth, drawHeight)
        context.restore()
      }
      return
    }
    context.fillStyle = '#101820'
    context.fillRect(left, top, drawWidth, drawHeight)
    context.save()
    context.strokeStyle = 'rgba(255,255,255,0.08)'
    context.lineWidth = 1
    context.strokeRect(left + 0.5, top + 0.5, drawWidth - 1, drawHeight - 1)
    context.fillStyle = '#95a3ae'
    context.font = '12px system-ui, sans-serif'
    context.textAlign = 'center'
    context.fillText(
      pkg.image ? '底图加载中…' : '还没有底图 · 点顶栏“底图”补图',
      width / 2,
      height / 2,
    )
    context.restore()
  }

  private tileCountAt(zoom: number): number {
    const tile = this.pkg?.tile
    if (!tile) return 1
    if (tile.projection === 'webmercator') return 2 ** zoom
    return Math.max(1, tile.count * 2 ** (zoom - tile.minZoom))
  }

  private tileScale(): number {
    const tile = this.pkg?.tile
    if (!tile) return 1
    if (tile.projection === 'webmercator') return 256 * 2 ** this.view.zoom
    return 256 * 2 ** (this.view.zoom - tile.minZoom)
  }

  private drawTileMap(context: CanvasRenderingContext2D, width: number, height: number): void {
    const pkg = this.pkg
    const tile = pkg?.tile
    if (!pkg || !tile) return
    const scale = this.tileScale()
    if (!tile.template && !pkg.tileFiles) {
      context.fillStyle = '#95a3ae'
      context.font = '12px system-ui, sans-serif'
      context.textAlign = 'center'
      context.fillText('瓦片 URL 未设置；地点和区域仍可查看', width / 2, height / 2)
      return
    }
    const minZoom = tile.coverageMinZoom ?? tile.minZoom
    const maxZoom = tile.coverageMaxZoom ?? tile.maxZoom
    const z = Math.min(maxZoom, Math.max(minZoom, Math.round(this.view.zoom)))
    const count = this.tileCountAt(z)
    const tileSize = 256 * 2 ** (this.view.zoom - z)
    const minX = Math.floor((this.view.cx - width / 2 / scale) * count)
    const maxX = Math.ceil((this.view.cx + width / 2 / scale) * count)
    const minY = Math.floor((this.view.cy - height / 2 / scale) * count)
    const maxY = Math.ceil((this.view.cy + height / 2 / scale) * count)
    const webMercator = tile.projection === 'webmercator'
    const xMin = webMercator ? 0 : tile.xMin * 2 ** (z - tile.minZoom)
    const yMin = webMercator ? 0 : tile.yMin * 2 ** (z - tile.minZoom)
    for (let ty = Math.max(0, minY); ty <= Math.min(count - 1, maxY); ty += 1) {
      for (let tx = Math.max(0, minX); tx <= Math.min(count - 1, maxX); tx += 1) {
        const left = width / 2 + (tx / count - this.view.cx) * scale
        const top = height / 2 + (ty / count - this.view.cy) * scale
        const key = `${z}/${yMin + ty}/${xMin + tx}`
        const blob = pkg.tileFiles?.[key]
        const url = blob ? this.tileFileUrl(key, blob) : this.tileUrl(tile.template, z, yMin + ty, xMin + tx)
        const cached = this.tileCache.get(key)
        if (cached === 'error') {
          context.fillStyle = 'rgba(255,255,255,0.035)'
          context.fillRect(left, top, tileSize + 0.5, tileSize + 0.5)
          continue
        }
        if (cached instanceof HTMLImageElement && cached.complete) {
          this.tileCache.delete(key)
          this.tileCache.set(key, cached)
          context.drawImage(cached, left, top, tileSize + 0.5, tileSize + 0.5)
          continue
        }
        if (cached === undefined) {
          this.tileCache.set(key, 'loading')
          this.startTileLoad(key, url)
        }
        context.fillStyle = 'rgba(255,255,255,0.035)'
        context.fillRect(left, top, tileSize + 0.5, tileSize + 0.5)
      }
    }
  }

  private tileFileUrl(key: string, blob: Blob): string {
    const existing = this.tileFileUrls.get(key)
    if (existing) return existing
    const url = URL.createObjectURL(blob)
    this.tileFileUrls.set(key, url)
    return url
  }

  private startTileLoad(key: string, url: string): void {
    const run = (): void => {
      if (this.tileLoads >= TILE_LOAD_CONCURRENCY) {
        this.tileQueue.push(run)
        return
      }
      this.tileLoads += 1
      const generation = this.tileGeneration
      const image = new Image()
      const done = (result: HTMLImageElement | 'error'): void => {
        if (generation === this.tileGeneration) this.tileLoads = Math.max(0, this.tileLoads - 1)
        if (generation === this.tileGeneration) {
          if (result === 'error') {
            this.tileCache.set(key, 'error')
          } else {
            this.tileCache.set(key, result)
            this.tileCacheBytes += result.naturalWidth * result.naturalHeight * 4
            this.evictTiles()
          }
          this.requestDraw()
        }
        this.tileQueue.shift()?.()
      }
      image.onload = () => done(image)
      image.onerror = () => done('error')
      image.src = url
    }
    run()
  }

  private evictTiles(): void {
    if (this.tileCacheBytes <= DECODED_TILE_MEMORY_BUDGET) return
    for (const [key, value] of this.tileCache) {
      if (this.tileCacheBytes <= DECODED_TILE_MEMORY_BUDGET) break
      if (!(value instanceof HTMLImageElement)) continue
      this.tileCacheBytes -= value.naturalWidth * value.naturalHeight * 4
      this.tileCache.delete(key)
      const fileUrl = this.tileFileUrls.get(key)
      if (fileUrl) {
        URL.revokeObjectURL(fileUrl)
        this.tileFileUrls.delete(key)
      }
    }
  }

  private clearTileCaches(): void {
    this.tileGeneration += 1
    this.tileLoads = 0
    this.tileQueue.length = 0
    this.tileCache.clear()
    this.tileCacheBytes = 0
    for (const url of this.tileFileUrls.values()) URL.revokeObjectURL(url)
    this.tileFileUrls.clear()
  }

  private tileUrl(template: string, z: number, y: number, x: number): string {
    return template
      .replace(/\{z\}/g, String(z))
      .replace(/\{y\}/g, String(y))
      .replace(/\{x\}/g, String(x))
  }

  private drawRegions(context: CanvasRenderingContext2D, width: number, height: number): void {
    const pkg = this.pkg
    if (!pkg || this.state.showRegions === false) return
    if (pkg.kind === 'tiles' && this.view.zoom < this.tileZoomThreshold(REGION_HIT_MIN_ZOOM)) return
    const project = (x: number, y: number): [number, number] => this.project(x, y, width, height)
    pkg.regions.forEach((region, index) => {
      const selected = region.id === this.state.selectedRegionId
      const current = region.id === this.state.currentRegionId
      const color = this.categoryColor(`region-${index}`)
      context.save()
      context.beginPath()
      for (const ring of region.polygons) {
        ring.forEach(([x, y], pointIndex) => {
          const [px, py] = project(x, y)
          if (pointIndex === 0) context.moveTo(px, py)
          else context.lineTo(px, py)
        })
        context.closePath()
      }
      context.fillStyle = color
      context.globalAlpha = selected ? 0.23 : current ? 0.16 : 0.09
      context.fill('evenodd')
      context.globalAlpha = selected ? 0.95 : 0.55
      context.strokeStyle = selected || current ? color : 'rgba(255,255,255,0.35)'
      context.lineWidth = selected ? 2.5 : 1
      context.stroke()
      context.restore()
    })
  }

  private regionLabelPoint(region: LayerRegion): { x: number; y: number; area: number } | undefined {
    if (region.labelX != null && region.labelY != null) {
      return { x: region.labelX, y: region.labelY, area: 1 }
    }
    const cached = this.regionLabelCache.get(region.id)
    if (cached) return cached
    let best: { x: number; y: number; area: number } | undefined
    for (const ring of region.polygons) {
      if (ring.length < 3) continue
      let twiceArea = 0
      let cx = 0
      let cy = 0
      for (let index = 0; index < ring.length; index += 1) {
        const [x0, y0] = ring[index]
        const [x1, y1] = ring[(index + 1) % ring.length]
        const cross = x0 * y1 - x1 * y0
        twiceArea += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
      }
      const area = Math.abs(twiceArea / 2)
      if (area < 1e-9) continue
      const point = {
        x: cx / (3 * twiceArea),
        y: cy / (3 * twiceArea),
        area,
      }
      if (!best || point.area > best.area) best = point
    }
    if (best) this.regionLabelCache.set(region.id, best)
    return best
  }

  private drawRegionLabels(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
  ): void {
    const pkg = this.pkg
    if (!pkg || this.state.showRegions === false || pkg.regions.length === 0) return
    const regionLabelZoom =
      pkg.kind === 'tiles' ? this.tileZoomThreshold(REGION_LABEL_MIN_ZOOM) : REGION_LABEL_MIN_ZOOM
    if (this.view.zoom < regionLabelZoom) return
    const zoom = this.view.zoom
    const size = pkg.kind === 'tiles' ? Math.max(11, Math.min(17, 10 + (zoom - 7) * 1.15)) : 12
    for (const region of pkg.regions) {
      const point = this.regionLabelPoint(region)
      if (!point || point.x < -0.1 || point.x > 1.1 || point.y < -0.1 || point.y > 1.1) continue
      const [x, y] = this.project(point.x, point.y, width, height)
      if (x < -100 || y < -30 || x > width + 100 || y > height + 30) continue
      const selected = region.id === this.state.selectedRegionId
      context.save()
      context.font = `${selected ? 700 : 600} ${size}px system-ui, sans-serif`
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      const metrics = context.measureText(region.name)
      const boxWidth = metrics.width + 8
      const boxHeight = size + 4
      const cells = this.labelCellKeys(x - boxWidth / 2, y - boxHeight / 2, boxWidth, boxHeight)
      if (!selected && cells.some((cell) => this.labelCells.has(cell))) {
        context.restore()
        continue
      }
      for (const cell of cells) this.labelCells.add(cell)
      context.lineWidth = Math.max(2, size / 5)
      context.strokeStyle = 'rgba(0, 0, 0, 0.72)'
      context.strokeText(region.name, x, y)
      context.fillStyle = selected ? '#f3c87f' : 'rgba(255, 255, 255, 0.9)'
      context.fillText(region.name, x, y)
      context.restore()
    }
  }

  private async ensureIconFont(pkg: LayerMapPackage): Promise<void> {
    if (this.iconFontPackageId === pkg.id) return
    this.iconFontPackageId = ''
    this.iconFontFamily = ''
    this.markerIconCache.clear()
    if (!pkg.iconFont) return
    try {
      const face = new FontFace(pkg.iconFont.family, await pkg.iconFont.data.arrayBuffer())
      await face.load()
      document.fonts.add(face)
      this.iconFontPackageId = pkg.id
      this.iconFontFamily = pkg.iconFont.family
      this.markerIconCache.clear()
      this.requestDraw()
    } catch (error) {
      console.warn('[tavern-map] Map Genie icon font load failed', error)
    }
  }

  private async ensureIconAtlas(pkg: LayerMapPackage): Promise<void> {
    if (this.iconAtlasPackageId === pkg.id && this.iconAtlasImage) return
    this.iconAtlasPackageId = ''
    this.iconAtlasImage = null
    if (this.iconAtlasUrl) {
      URL.revokeObjectURL(this.iconAtlasUrl)
      this.iconAtlasUrl = null
    }
    this.markerIconCache.clear()
    if (!pkg.iconAtlas) return
    const url = URL.createObjectURL(pkg.iconAtlas.image)
    const image = new Image()
    try {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = () => reject(new Error('icon atlas image decode failed'))
        image.src = url
      })
      this.iconAtlasPackageId = pkg.id
      this.iconAtlasUrl = url
      this.iconAtlasImage = image
      this.markerIconCache.clear()
      this.requestDraw()
    } catch (error) {
      URL.revokeObjectURL(url)
      console.warn('[tavern-map] Map Genie icon atlas load failed', error)
    }
  }

  private iconAtlasFrameKey(icon: string): string | undefined {
    const frames = this.pkg?.iconAtlas?.frames
    if (!frames) return undefined
    const direct = [`g.${icon}.a`, `g.${icon}.ffffff`, icon].find((key) => Boolean(frames[key]))
    if (direct) return direct
    return Object.keys(frames).find((key) => key.startsWith(`g.${icon}.`))
  }

  private markerIconFor(category: LayerCategory | undefined): HTMLCanvasElement | undefined {
    const pkg = this.pkg
    if (!category?.icon) return undefined
    const frameKey = this.iconAtlasFrameKey(category.icon)
    if (this.iconAtlasImage && frameKey) {
      const cachedAtlas = this.markerIconCache.get(`atlas:${category.id}`)
      if (cachedAtlas) return cachedAtlas
      const frame = pkg?.iconAtlas?.frames[frameKey]
      if (!frame) return undefined
      const cssSize = 30
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(cssSize * dpr)
      canvas.height = Math.round(cssSize * dpr)
      const atlasContext = canvas.getContext('2d')
      if (!atlasContext) return undefined
      atlasContext.setTransform(dpr, 0, 0, dpr, 0, 0)
      atlasContext.beginPath()
      atlasContext.arc(cssSize / 2, cssSize / 2, 11, 0, Math.PI * 2)
      atlasContext.fillStyle = category.color || '#e6b56a'
      atlasContext.fill()
      atlasContext.lineWidth = 1.2
      atlasContext.strokeStyle = 'rgba(255,255,255,0.82)'
      atlasContext.stroke()
      atlasContext.drawImage(
        this.iconAtlasImage,
        frame.x,
        frame.y,
        frame.width,
        frame.height,
        cssSize / 2 - 9,
        cssSize / 2 - 9,
        18,
        18,
      )
      this.markerIconCache.set(`atlas:${category.id}`, canvas)
      return canvas
    }
    if (!pkg?.iconFont || !this.iconFontFamily) return undefined
    const glyph = pkg.iconFont.glyphs[category.icon]
    if (!glyph) return undefined
    const cached = this.markerIconCache.get(category.id)
    if (cached) return cached
    const cssSize = 30
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(cssSize * dpr)
    canvas.height = Math.round(cssSize * dpr)
    const context = canvas.getContext('2d')
    if (!context) return undefined
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.beginPath()
    context.arc(cssSize / 2, cssSize / 2, 11, 0, Math.PI * 2)
    context.fillStyle = category.color || '#e6b56a'
    context.fill()
    context.lineWidth = 1.2
    context.strokeStyle = 'rgba(255,255,255,0.82)'
    context.stroke()
    context.font = `400 15px "${this.iconFontFamily}"`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillStyle = '#fff'
    context.fillText(glyph, cssSize / 2, cssSize / 2 + 0.5)
    this.markerIconCache.set(category.id, canvas)
    return canvas
  }

  private shouldCluster(pkg: LayerMapPackage, visibleCount: number): boolean {
    if (visibleCount < 500) return false
    return pkg.kind === 'image'
      ? this.view.zoom < 1.55
      : this.view.zoom < this.tileZoomThreshold(TILE_CLUSTER_BELOW_ZOOM)
  }

  /**
   * A tile zoom threshold for the current package: the tuned level shifted by
   * how far this map's tile set starts below zoom 8. Never later than the tuned
   * level, so maps that already worked keep their behavior.
   */
  private tileZoomThreshold(tunedLevel: number): number {
    const minZoom = this.pkg?.tile?.minZoom
    if (minZoom == null || !Number.isFinite(minZoom)) return tunedLevel
    return Math.min(tunedLevel, tunedLevel - TILE_ZOOM_TUNED_MIN + minZoom)
  }

  private drawMarkerClusters(
    context: CanvasRenderingContext2D,
    markers: LayerMarker[],
    width: number,
    height: number,
    selectedId: string | undefined,
  ): Set<string> {
    const cell = 36
    const groups = new Map<string, LayerMarker[]>()
    for (const marker of markers) {
      if (marker.id === selectedId) continue
      const [x, y] = this.project(marker.x, marker.y, width, height)
      const key = `${Math.floor(x / cell)}:${Math.floor(y / cell)}`
      const bucket = groups.get(key)
      if (bucket) bucket.push(marker)
      else groups.set(key, [marker])
    }
    const clustered = new Set<string>()
    for (const group of groups.values()) {
      if (group.length < 2) continue
      let sumX = 0
      let sumY = 0
      let nx = 0
      let ny = 0
      for (const marker of group) {
        const [x, y] = this.project(marker.x, marker.y, width, height)
        sumX += x
        sumY += y
        nx += marker.x
        ny += marker.y
        clustered.add(marker.id)
      }
      const x = sumX / group.length
      const y = sumY / group.length
      const radius = Math.min(18, 8 + Math.log2(group.length) * 2.2)
      context.save()
      context.beginPath()
      context.arc(x, y, radius, 0, Math.PI * 2)
      context.fillStyle = 'rgba(230, 181, 106, 0.9)'
      context.fill()
      context.lineWidth = 1.5
      context.strokeStyle = 'rgba(255, 247, 226, 0.95)'
      context.stroke()
      context.font = '700 10px system-ui, sans-serif'
      context.fillStyle = '#21180a'
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillText(String(group.length), x, y + 0.5)
      context.restore()
      this.clusterHitAreas.push({
        x,
        y,
        radius,
        nx: nx / group.length,
        ny: ny / group.length,
      })
    }
    return clustered
  }

  private zoomIntoCluster(nx: number, ny: number): void {
    if (this.pkg?.kind === 'tiles' && this.maplibreMap) {
      this.maplibreMap.easeTo({
        center: this.normalizedToLngLat(nx, ny),
        zoom: Math.min(25, this.maplibreMap.getZoom() + 1.4),
        duration: 220,
      })
      return
    }
    this.view.cx = nx
    this.view.cy = ny
    this.view.zoom = Math.min(8, this.view.zoom * 1.8)
    this.clampView()
    this.state.view = this.view
    this.persist()
    this.requestDraw()
  }

  private streetRank(street: LayerStreet): number {
    return roadRank(street.type)
  }

  /** Spatial index of the package's road lines, rebuilt only when they change. */
  private roadIndex(): RoadIndex | undefined {
    const pkg = this.pkg
    if (!pkg?.streets?.length) return undefined
    const yScale = pkg.kind === 'image' ? pkg.height / pkg.width : 1
    const cached = this.roadIndexCache
    if (cached && cached.streets === pkg.streets && cached.yScale === yScale) return cached.index
    const index = buildRoadIndex(pkg.streets, yScale)
    this.roadIndexCache = { streets: pkg.streets, yScale, index }
    return index
  }

  /**
   * The road nearest to "my position" inside the nearby radius. Computed once
   * per position/radius, never per frame.
   */
  private currentRoad(): { road: NearestRoad; on: boolean } | undefined {
    const user = this.state.userPosition
    const index = this.roadIndex()
    if (!user || !index) return undefined
    const radius = this.nearbyRadiusMapUnits()
    const key = `${this.pkg?.id}:${user.x}:${user.y}:${radius}`
    if (this.currentRoadCache?.key !== key) {
      this.currentRoadCache = { key, road: nearestRoad(index, user.x, user.y, radius) }
    }
    const road = this.currentRoadCache.road
    if (!road) return undefined
    return { road, on: road.distance <= this.mapSpan().w * ON_ROAD_SPAN_FRACTION }
  }

  private roadDisplayName(street: LayerStreet): string {
    return street.name || (street.type ? `无名道路（${street.type}）` : '无名道路')
  }

  /**
   * One road: every line with the same name and type (data often splits a
   * road into several lines); an unnamed line is a road of its own. Used for
   * highlighting, road notes and de-duplicating roads in AI.
   */
  private roadKey(street: LayerStreet): string {
    return street.name ? `name:${street.name}|${street.type ?? ''}` : `line:${street.id}`
  }

  private roadLines(key: string): LayerStreet[] {
    const streets = this.pkg?.streets
    if (!streets?.length) return []
    if (this.roadLinesCache?.streets !== streets) {
      const map = new Map<string, LayerStreet[]>()
      for (const street of streets) {
        const roadKey = this.roadKey(street)
        const list = map.get(roadKey)
        if (list) list.push(street)
        else map.set(roadKey, [street])
      }
      this.roadLinesCache = { streets, map }
    }
    return this.roadLinesCache.map.get(key) ?? []
  }

  private roadNoteKey(key: string): string {
    return `${this.notePrefix()}road:${key}`
  }

  private roadNoteValue(key: string): string {
    const noteKey = this.roadNoteKey(key)
    const global = globalNote(noteKey)
    if (global !== undefined) return global
    return this.state.notes?.[noteKey] ?? ''
  }

  private roadAIKey(key: string): string {
    return `road:${key}`
  }

  private roadNotesGloballyEnabled(settings = loadSettings(this.liveContext())): boolean {
    return settings.layerRoadNoteNearby || settings.layerRoadNoteCurrentLeg || settings.layerRoadNoteAllLegs
  }

  /** Source fields of a road for AI: each distinct set of line fields once, written as in the data. */
  private roadSourceText(key: string): string {
    const seen = new Set<string>()
    const parts: string[] = []
    for (const line of this.roadLines(key)) {
      const fields = line.properties ?? []
      if (fields.length === 0) continue
      const text = fields.map(([name, value]) => `${name}=${value}`).join('; ')
      if (seen.has(text)) continue
      seen.add(text)
      parts.push(text)
    }
    return parts.join(' | ')
  }

  /** Select a road (from the map or a list); the detail panel shows it and the map highlights it. */
  private selectRoad(key: string, center = false): void {
    const lines = this.roadLines(key)
    if (lines.length === 0) return
    this.state.selectedRoadKey = key
    this.state.selectedMarkerId = undefined
    this.state.selectedRegionId = undefined
    if (center) this.centerOnRoad(lines)
    this.renderDetail()
    this.persist()
    this.requestDraw()
    this.syncToolButtons()
  }

  private centerOnRoad(lines: LayerStreet[]): void {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const line of lines) {
      for (const [x, y] of line.points) {
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
      }
    }
    if (Number.isFinite(minX)) this.centerOnPoint({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 })
  }

  /** The road under a screen point (a few pixels of tolerance), only while the road layer is shown. */
  private hitRoad(sx: number, sy: number): LayerStreet | undefined {
    if (this.state.showRoads !== true) return undefined
    const index = this.roadIndex()
    if (!index) return undefined
    const width = this.canvasEl.clientWidth || 1
    const height = this.canvasEl.clientHeight || 1
    const [x, y] = this.unproject(sx, sy, width, height)
    const [x2] = this.unproject(sx + 7, sy, width, height)
    const tolerance = Math.abs(x2 - x)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(tolerance > 0)) return undefined
    return nearestRoad(index, x, y, tolerance)?.street
  }

  /** The selected road drawn on top, also when the road layer is off. */
  private drawSelectedRoad(context: CanvasRenderingContext2D, width: number, height: number): void {
    const key = this.state.selectedRoadKey
    if (!key) return
    const lines = this.roadLines(key)
    if (lines.length === 0) return
    context.save()
    context.lineJoin = 'round'
    context.lineCap = 'round'
    context.beginPath()
    for (const line of lines) {
      line.points.forEach(([px, py], index) => {
        const [x, y] = this.project(px, py, width, height)
        if (index === 0) context.moveTo(x, y)
        else context.lineTo(x, y)
      })
    }
    context.strokeStyle = 'rgba(255, 214, 120, 0.35)'
    context.lineWidth = 15
    context.stroke()
    context.strokeStyle = 'rgba(8, 13, 18, 0.9)'
    context.lineWidth = 8
    context.stroke()
    context.strokeStyle = '#fff2c4'
    context.lineWidth = 4.5
    context.stroke()
    context.restore()
  }

  /**
   * Road notes for AI. Sources: roads near my position, roads of the current
   * itinerary leg, roads of every leg (travelled roads plus the roads listed
   * in range). Each road appears once with every reason it was included.
   */
  private roadNotesForAI(settings: Settings): LayerContextRoadNote[] {
    if (!this.pkg?.streets?.length || !this.roadNotesGloballyEnabled(settings)) return []
    const roads = this.roadAIScope(settings)
    // Roads ticked "给 AI" outside the automatic range are sent too.
    for (const key of Object.keys(this.placeAIFlags)) {
      if (!key.startsWith('road:')) continue
      const roadKey = key.slice('road:'.length)
      if (roads.has(roadKey)) continue
      if (this.aiFlagState(key, 'note') !== true && this.aiFlagState(key, 'source') !== true) continue
      const street = this.roadLines(roadKey)[0]
      if (street) roads.set(roadKey, { name: this.roadDisplayName(street), type: street.type || undefined, tags: ['pinned'] })
    }
    const result: LayerContextRoadNote[] = []
    for (const [key, entry] of roads) {
      const aiKey = this.roadAIKey(key)
      const inScope = !entry.tags.includes('pinned')
      const text = this.aiFlagSends(aiKey, 'note', inScope) ? this.roadNoteValue(key).trim() : ''
      const source =
        settings.layerRoadSourceAI && this.aiFlagSends(aiKey, 'source', inScope) ? this.roadSourceText(key) : ''
      if (text || source) {
        result.push({ name: entry.name, type: entry.type, tags: entry.tags, text, source: source || undefined })
      }
    }
    return result
  }

  /** Roads whose notes go to AI automatically, with why each is included. */
  private roadAIScope(settings: Settings): Map<string, { name: string; type?: string; tags: string[] }> {
    const roads = new Map<string, { name: string; type?: string; tags: string[] }>()
    const add = (key: string | undefined, name: string, type: string | undefined, tag: string): void => {
      if (!key) return
      const entry = roads.get(key) ?? { name, type, tags: [] }
      if (!entry.tags.includes(tag)) entry.tags.push(tag)
      roads.set(key, entry)
    }
    const user = this.state.userPosition
    if (settings.layerRoadNoteNearby && user) {
      for (const { street } of this.nearbyRoadHits(user)) {
        add(this.roadKey(street), this.roadDisplayName(street), street.type || undefined, 'near me')
      }
    }
    const route = this.itinerary
    if (route && route.showToAI && (settings.layerRoadNoteCurrentLeg || settings.layerRoadNoteAllLegs)) {
      const legs = this.itineraryLegs(route)
      const position = this.itineraryPosition(route)
      const extras = this.itineraryExtrasLegs(route, legs.length, position)
      const legRoads = this.itineraryLegRoads(legs)
      // Same rule as "only the current leg": before setting off it is leg 1; none at the destination.
      const current =
        !position || position.atFinal ? undefined : position.onRoute ? position.legIndex ?? 0 : 0
      legs.forEach((leg, index) => {
        const isCurrent = index === current
        if (!settings.layerRoadNoteAllLegs && !(settings.layerRoadNoteCurrentLeg && isCurrent)) return
        const tag = isCurrent && settings.layerRoadNoteCurrentLeg ? 'current leg' : `leg ${index + 1}`
        for (const piece of leg.pieces) {
          if (piece.kind === 'road') add(piece.key, piece.name ?? '', piece.type, tag)
        }
        if (extras.has(index)) {
          for (const road of legRoads.get(index) ?? []) {
            add(this.roadKey(road.street), this.roadDisplayName(road.street), road.street.type || undefined, tag)
          }
        }
      })
    }
    return roads
  }


  /** Road lines in view; the road "I" am on is highlighted. */
  private drawRoads(context: CanvasRenderingContext2D, width: number, height: number): void {
    const pkg = this.pkg
    if (!pkg?.streets?.length || this.state.showRoads !== true) return
    const index = this.roadIndex()
    if (!index) return
    const [west, north] = this.unproject(-16, -16, width, height)
    const [east, south] = this.unproject(width + 16, height + 16, width, height)
    if (![west, north, east, south].every(Number.isFinite)) return
    const visible = roadsInRect(index, {
      minX: Math.min(west, east),
      maxX: Math.max(west, east),
      minY: Math.min(north, south) * index.yScale,
      maxY: Math.max(north, south) * index.yScale,
    })
    const current = this.currentRoad()
    const styles = [
      { width: 3.2, color: 'rgba(255, 196, 92, 0.85)', dash: [] as number[] },
      { width: 2.4, color: 'rgba(255, 222, 150, 0.8)', dash: [] as number[] },
      { width: 1.6, color: 'rgba(250, 240, 214, 0.75)', dash: [5, 4] },
    ]
    context.save()
    context.lineJoin = 'round'
    context.lineCap = 'round'
    const trace = (street: LayerStreet): void => {
      context.beginPath()
      street.points.forEach(([x, y], pointIndex) => {
        const [sx, sy] = this.project(x, y, width, height)
        if (pointIndex === 0) context.moveTo(sx, sy)
        else context.lineTo(sx, sy)
      })
    }
    for (const rank of [2, 1, 0]) {
      const style = styles[rank]
      for (const streetIndex of visible) {
        const street = index.streets[streetIndex]
        if (this.streetRank(street) !== rank || street === current?.road.street) continue
        trace(street)
        context.setLineDash(style.dash)
        context.lineWidth = style.width + 2
        context.strokeStyle = 'rgba(24, 16, 10, 0.55)'
        context.stroke()
        context.lineWidth = style.width
        context.strokeStyle = style.color
        context.stroke()
      }
    }
    if (current?.on && visible.includes(index.streets.indexOf(current.road.street))) {
      trace(current.road.street)
      context.setLineDash([])
      context.lineWidth = 7
      context.strokeStyle = 'rgba(16, 24, 32, 0.6)'
      context.stroke()
      context.lineWidth = 4.5
      context.strokeStyle = 'rgba(92, 214, 255, 0.95)'
      context.stroke()
    }
    context.restore()
  }

  private streetLabelAnchor(
    street: LayerStreet,
  ): { x: number; y: number; angle: number } | undefined {
    const cached = this.streetLabelCache.get(street.id)
    if (cached) return cached
    const points = street.points
    if (points.length < 2) return undefined
    let total = 0
    for (let index = 1; index < points.length; index += 1) {
      total += Math.hypot(
        points[index][0] - points[index - 1][0],
        points[index][1] - points[index - 1][1],
      )
    }
    if (!Number.isFinite(total) || total < 1e-9) return undefined
    let target = total / 2
    for (let index = 1; index < points.length; index += 1) {
      const [x1, y1] = points[index - 1]
      const [x2, y2] = points[index]
      const length = Math.hypot(x2 - x1, y2 - y1)
      if (target <= length || index === points.length - 1) {
        const ratio = length > 0 ? Math.min(1, Math.max(0, target / length)) : 0.5
        let angle = Math.atan2(y2 - y1, x2 - x1)
        if (angle > Math.PI / 2) angle -= Math.PI
        if (angle < -Math.PI / 2) angle += Math.PI
        const anchor = {
          x: x1 + (x2 - x1) * ratio,
          y: y1 + (y2 - y1) * ratio,
          angle,
        }
        this.streetLabelCache.set(street.id, anchor)
        return anchor
      }
      target -= length
    }
    return undefined
  }

  private drawStreetLabels(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
  ): void {
    const pkg = this.pkg
    if (!pkg?.streets?.length || this.state.showLabels === false || this.tileMoving) return
    const zoom = this.view.zoom
    const seen = new Set<string>()
    const ordered = [...pkg.streets].sort(
      (a, b) => this.streetRank(a) - this.streetRank(b) || a.name.localeCompare(b.name),
    )
    let drawn = 0
    for (const street of ordered) {
      if (!street.name) continue
      const rank = this.streetRank(street)
      const tuned = STREET_LABEL_TILE_ZOOMS[rank] ?? STREET_LABEL_TILE_ZOOMS[2]
      const minZoom = pkg.kind === 'tiles' ? this.tileZoomThreshold(tuned) : tuned
      if (zoom < minZoom) continue
      const nameKey = street.name.toLocaleLowerCase()
      if (seen.has(nameKey)) continue
      const anchor = this.streetLabelAnchor(street)
      if (!anchor) continue
      const [x, y] = this.project(anchor.x, anchor.y, width, height)
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      if (x < -60 || y < -30 || x > width + 60 || y > height + 30) continue
      const size = rank === 0 ? 13 : rank === 1 ? 12 : 11
      context.save()
      context.font = `${rank === 2 ? '' : '600 '}${size}px Georgia, "Times New Roman", serif`
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      const metrics = context.measureText(street.name)
      const halfWidth = Math.min(150, Math.max(18, metrics.width / 2 + 3))
      const halfHeight = size / 2 + 3
      const cells = this.labelCellKeys(x - halfWidth, y - halfHeight, halfWidth * 2, halfHeight * 2)
      if (cells.some((cell) => this.labelCells.has(cell))) {
        context.restore()
        continue
      }
      for (const cell of cells) this.labelCells.add(cell)
      seen.add(nameKey)
      context.translate(x, y)
      context.rotate(anchor.angle)
      context.lineJoin = 'round'
      context.lineWidth = 3
      context.strokeStyle = 'rgba(31,20,29,0.9)'
      context.strokeText(street.name, 0, 0)
      context.fillStyle = rank === 0 ? '#eadfc6' : '#d8cfb8'
      context.fillText(street.name, 0, 0)
      context.restore()
      drawn += 1
      if (drawn >= 120) break
    }
  }

  private drawMarkers(context: CanvasRenderingContext2D, width: number, height: number): void {
    const pkg = this.pkg
    if (!pkg) return
    const hidden = new Set(this.state.hiddenCategories ?? [])
    const categories = new Map(
      this.effectiveCategoryList.map((category) => [category.id, category]),
    )
    const selectedId = this.state.selectedMarkerId
    const favoriteIds = this.favoriteMarkerIds
    const labelThreshold =
      pkg.kind === 'image'
        ? LABEL_IMAGE_ZOOM
        : this.tileZoomThreshold(LABEL_TILE_ZOOM)
    const showLabels = this.state.showLabels !== false && this.view.zoom >= labelThreshold
    const visible = this.markersInView(width, height).filter(
      (marker) => !hidden.has(marker.categoryId),
    )
    this.clusterHitAreas = []
    const clustered = this.shouldCluster(pkg, visible.length)
      ? this.drawMarkerClusters(context, visible, width, height, selectedId)
      : new Set<string>()
    for (const marker of visible) {
      if (clustered.has(marker.id) && marker.id !== selectedId) continue
      const [x, y] = this.project(marker.x, marker.y, width, height)
      const category = categories.get(marker.categoryId)
      const selected = marker.id === selectedId
      const current = false
      const icon = this.markerIconFor(category)
      context.save()
      if (marker.custom) {
        this.drawCustomPin(context, x, y, selected, category?.color)
      } else if (icon) {
        const size = selected ? 36 : 28
        context.globalAlpha = selected ? 1 : 0.95
        context.drawImage(icon, x - size / 2, y - size / 2, size, size)
        context.globalAlpha = 1
        if (selected) {
          context.beginPath()
          context.arc(x, y, 17, 0, Math.PI * 2)
          context.strokeStyle = '#f3c87f'
          context.lineWidth = 2
          context.stroke()
        }
      } else {
        context.beginPath()
        context.arc(x, y, current ? 8 : selected ? 7.5 : 4.5, 0, Math.PI * 2)
        context.fillStyle = category?.color ?? '#e6b56a'
        context.globalAlpha = current || selected ? 1 : 0.9
        context.fill()
        context.globalAlpha = 1
        context.lineWidth = current ? 3 : selected ? 2.5 : 1.2
        context.strokeStyle = current ? '#ffffff' : selected ? '#f3c87f' : 'rgba(255,255,255,0.8)'
        context.stroke()
      }
      if (favoriteIds.has(marker.id)) {
        context.font = '600 10px system-ui, sans-serif'
        context.fillStyle = '#ffd98f'
        context.textAlign = 'center'
        context.textBaseline = 'middle'
        context.fillText('★', x + 7, y - 8)
      }
      if (current) {
        context.beginPath()
        context.arc(x, y, 12, 0, Math.PI * 2)
        context.strokeStyle = 'rgba(243,200,127,0.8)'
        context.lineWidth = 1.5
        context.stroke()
      }
      context.restore()
      if (
        (selected || current || showLabels) &&
        y > 14 &&
        y < height - 6
      ) {
        this.drawLabel(context, marker, x, y, selected || current)
      }
    }
  }

  private drawCustomPin(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    selected: boolean,
    colorValue: string | undefined,
  ): void {
    const color = colorValue ?? CUSTOM_PIN_COLOR
    const radius = selected ? 8 : 6.5
    context.save()
    context.beginPath()
    context.moveTo(x, y + 9)
    context.lineTo(x - 5.5, y + 1)
    context.lineTo(x + 5.5, y + 1)
    context.closePath()
    context.fillStyle = color
    context.fill()
    context.beginPath()
    context.arc(x, y - 2, radius, 0, Math.PI * 2)
    context.fillStyle = color
    context.fill()
    context.lineWidth = selected ? 2.5 : 1.2
    context.strokeStyle = selected ? '#f3c87f' : 'rgba(255,255,255,0.85)'
    context.stroke()
    context.beginPath()
    context.arc(x, y - 2, selected ? 2.6 : 2.2, 0, Math.PI * 2)
    context.fillStyle = '#fff7e6'
    context.fill()
    context.restore()
  }

  private drawItineraryLine(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
  ): void {
    const route = this.activeItinerary()
    if (!route || route.stops.length < 1) return
    const legs = this.itineraryLegs(route)
    const position =
      this.itineraryEdit || this.itinerary !== route
        ? undefined
        : this.itineraryPosition(route)
    const activeLeg =
      position?.onRoute && !position.atFinal ? position.legIndex : undefined
    const trace = (points: Pt[]): void => {
      context.beginPath()
      points.forEach((point, index) => {
        const [x, y] = this.project(point.x, point.y, width, height)
        if (index === 0) context.moveTo(x, y)
        else context.lineTo(x, y)
      })
    }
    context.save()
    context.lineCap = 'round'
    context.lineJoin = 'round'
    if (this.itineraryRangeVisible() && legs.length > 0) this.drawItineraryRangeBand(context, legs, width, height)
    const drawPiece = (piece: ItineraryPieceView, current: boolean, snapped: boolean): void => {
      trace(piece.points)
      const offRoad = snapped && piece.kind === 'straight'
      if (current) {
        context.setLineDash(offRoad ? [5, 5] : [])
        context.strokeStyle = 'rgba(8, 13, 18, 0.9)'
        context.lineWidth = offRoad ? 6 : 8
        context.stroke()
        context.strokeStyle = '#f3c87f'
        context.lineWidth = offRoad ? 2.5 : 4
        context.stroke()
        return
      }
      const dash = this.itineraryEdit || offRoad ? (offRoad ? [4, 5] : [8, 6]) : []
      context.setLineDash(dash)
      context.strokeStyle = 'rgba(8, 13, 18, 0.72)'
      context.lineWidth = offRoad ? 4 : this.itineraryEdit ? 5 : 5.5
      context.stroke()
      context.strokeStyle = this.itineraryEdit
        ? 'rgba(243, 200, 127, 0.82)'
        : 'rgba(230, 181, 106, 0.68)'
      context.lineWidth = offRoad ? 2 : this.itineraryEdit ? 2.5 : 3
      context.stroke()
    }
    const drawLeg = (leg: ItineraryLegView, current: boolean): void => {
      for (const piece of leg.pieces) drawPiece(piece, current, leg.snap)
    }
    for (const [index, leg] of legs.entries()) {
      if (index === activeLeg) continue
      drawLeg(leg, false)
    }
    if (activeLeg !== undefined) drawLeg(legs[activeLeg], true)
    context.setLineDash([])
    // Where a road-following leg changes road or leaves the road.
    for (const leg of legs) {
      if (!leg.snap) continue
      for (let index = 1; index < leg.pieces.length; index += 1) {
        const point = leg.pieces[index].points[0]
        const [x, y] = this.project(point.x, point.y, width, height)
        context.beginPath()
        context.moveTo(x, y - 5)
        context.lineTo(x + 5, y)
        context.lineTo(x, y + 5)
        context.lineTo(x - 5, y)
        context.closePath()
        context.fillStyle = 'rgba(8, 13, 18, 0.92)'
        context.fill()
        context.strokeStyle = '#f3c87f'
        context.lineWidth = 1.5
        context.stroke()
      }
    }
    if (activeLeg !== undefined) {
      const leg = legs[activeLeg]
      const at = leg.length * 0.56
      const here = pointAlong(leg.points, leg.cumulative, at)
      const ahead = pointAlong(leg.points, leg.cumulative, Math.min(leg.length, at + leg.length * 0.02))
      const [x1, y1] = this.project(here.x, here.y, width, height)
      const [x2, y2] = this.project(ahead.x, ahead.y, width, height)
      const angle = Math.atan2(y2 - y1, x2 - x1)
      context.save()
      context.translate(x1, y1)
      context.rotate(angle)
      context.beginPath()
      context.moveTo(7, 0)
      context.lineTo(-4, -4.5)
      context.lineTo(-4, 4.5)
      context.closePath()
      context.fillStyle = '#f3c87f'
      context.fill()
      context.restore()
    }
    if (this.itineraryEdit && this.routeHover && route.stops.length > 0) {
      const last = this.itineraryStopPoint(route.stops[route.stops.length - 1])
      const pieces = this.legPieces(last, this.routeHover, this.routeSnapNext && this.canSnapRoads())
      const line: Pt[] = [pieces[0].points[0]]
      for (const piece of pieces) line.push(...piece.points.slice(1))
      trace(line)
      context.strokeStyle = 'rgba(243, 200, 127, 0.8)'
      context.lineWidth = 1.5
      context.setLineDash([4, 4])
      context.stroke()
      context.setLineDash([])
      const [x2, y2] = this.project(this.routeHover.x, this.routeHover.y, width, height)
      const distance = this.itineraryPathLabel(line)
      const label = `${distance.startsWith('≈') ? distance : `≈ ${distance}`}${this.routeSnapNext && this.canSnapRoads() ? ' · 沿路' : ''}`
      context.font = '600 10px "PingFang SC", "Microsoft YaHei", sans-serif'
      const textWidth = context.measureText(label).width
      const left = Math.min(width - textWidth - 14, Math.max(8, x2 + 10))
      const top = Math.min(height - 26, Math.max(8, y2 - 28))
      context.fillStyle = 'rgba(8, 13, 18, 0.9)'
      context.fillRect(left - 5, top - 12, textWidth + 10, 18)
      context.fillStyle = '#f3c87f'
      context.fillText(label, left, top)
    }
    context.restore()
  }

  /**
   * The range band: a soft fill with a clear edge. Drawn on a scratch canvas
   * so overlapping legs form one shape (no darker overlaps, no inner edges).
   */
  private drawItineraryRangeBand(
    context: CanvasRenderingContext2D,
    legs: ItineraryLegView[],
    width: number,
    height: number,
  ): void {
    const radius = this.itineraryRangePixels(width, height)
    if (!(radius > 0.5)) return
    const path = new Path2D()
    for (const leg of legs) {
      leg.points.forEach((point, index) => {
        const [x, y] = this.project(point.x, point.y, width, height)
        if (index === 0) path.moveTo(x, y)
        else path.lineTo(x, y)
      })
    }
    const target = context.canvas
    const scratch = this.rangeBandCanvas ?? (this.rangeBandCanvas = document.createElement('canvas'))
    if (scratch.width !== target.width || scratch.height !== target.height) {
      scratch.width = target.width
      scratch.height = target.height
    }
    const band = scratch.getContext('2d')
    if (!band) return
    band.setTransform(1, 0, 0, 1, 0, 0)
    band.clearRect(0, 0, scratch.width, scratch.height)
    band.setTransform(context.getTransform())
    band.lineCap = 'round'
    band.lineJoin = 'round'
    band.strokeStyle = 'rgba(243, 200, 127, 0.7)'
    band.lineWidth = radius * 2 + 3
    band.stroke(path)
    band.globalCompositeOperation = 'destination-out'
    band.strokeStyle = '#000'
    band.lineWidth = Math.max(0.5, radius * 2 - 1)
    band.stroke(path)
    band.globalCompositeOperation = 'source-over'
    band.strokeStyle = 'rgba(243, 200, 127, 0.13)'
    band.stroke(path)
    context.save()
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.drawImage(scratch, 0, 0)
    context.restore()
  }

  private canSnapRoads(): boolean {
    return Boolean(this.pkg?.streets?.length)
  }

  /** The range band and its handle show while planning or while the route list is open. */
  private itineraryRangeVisible(): boolean {
    const route = this.activeItinerary()
    return Boolean(route && route.stops.length >= 2 && (this.itineraryEdit || this.routeShelfOpen))
  }

  /** The range on screen, in pixels, measured along the X axis at the view centre. */
  private itineraryRangePixels(width: number, height: number): number {
    const [cx, cy] = this.unproject(width / 2, height / 2, width, height)
    const [x1] = this.project(cx, cy, width, height)
    const [x2] = this.project(cx + this.itineraryRangeUnits(), cy, width, height)
    return Math.abs(x2 - x1)
  }

  private drawItineraryPoiRings(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
  ): void {
    const route = this.activeItinerary()
    if (!route || route.stops.length < 2) return
    const position = this.itineraryEdit ? undefined : this.itineraryPosition(route)
    const legIndex =
      position?.onRoute && !position.atFinal
        ? position.legIndex
        : this.routeExpandedLeg >= 0
          ? this.routeExpandedLeg
          : undefined
    if (legIndex === undefined) return
    const legs = this.itineraryLegs(route)
    const extras = this.itineraryExtrasLegs(route, legs.length, position)
    if (!extras.has(legIndex)) return
    const items = this.itineraryPois(route, legs, extras).get(legIndex) ?? []
    if (items.length === 0) return
    context.save()
    context.strokeStyle = 'rgba(243, 200, 127, 0.8)'
    context.lineWidth = 1.5
    for (const poi of items) {
      const [x, y] = this.project(poi.marker.x, poi.marker.y, width, height)
      context.beginPath()
      context.arc(x, y, 10, 0, Math.PI * 2)
      context.stroke()
    }
    context.restore()
  }

  private drawLabel(
    context: CanvasRenderingContext2D,
    marker: LayerMarker,
    x: number,
    y: number,
    strong: boolean,
  ): void {
    const label = marker.name
    context.save()
    context.font = strong ? '600 11px system-ui, sans-serif' : '11px system-ui, sans-serif'
    context.textAlign = 'left'
    context.textBaseline = 'middle'
    const metrics = context.measureText(label)
    const padding = 4
    const boxWidth = metrics.width + padding * 2
    const boxHeight = 17
    const boxX = x + 9
    const boxY = y - boxHeight / 2
    const cells = this.labelCellKeys(boxX, boxY, boxWidth, boxHeight)
    if (!strong && cells.some((cell) => this.labelCells.has(cell))) {
      context.restore()
      return
    }
    for (const cell of cells) this.labelCells.add(cell)
    context.fillStyle = strong ? 'rgba(12,17,22,0.92)' : 'rgba(12,17,22,0.78)'
    context.fillRect(boxX, boxY, boxWidth, boxHeight)
    context.fillStyle = strong ? '#f3c87f' : '#e9eef3'
    context.fillText(label, boxX + padding, y)
    context.restore()
  }

  private labelCellKeys(x: number, y: number, width: number, height: number): string[] {
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      return []
    }
    const x0 = Math.floor(x / LABEL_CELL_PX)
    const x1 = Math.floor((x + width) / LABEL_CELL_PX)
    const y0 = Math.floor(y / LABEL_CELL_PX)
    const y1 = Math.floor((y + height) / LABEL_CELL_PX)
    if (!Number.isFinite(x0) || !Number.isFinite(x1) || !Number.isFinite(y0) || !Number.isFinite(y1)) {
      return []
    }
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 512) return []
    const keys: string[] = []
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) keys.push(`${cx}:${cy}`)
    }
    return keys
  }

  private project(x: number, y: number, width: number, height: number): [number, number] {
    const pkg = this.pkg
    if (!pkg) return [0, 0]
    if (pkg.kind === 'tiles' && this.maplibreMap) {
      const point = this.maplibreMap.project(this.normalizedToLngLat(x, y))
      return [point.x, point.y]
    }
    if (pkg.kind === 'image') {
      const fit = Math.min(width / pkg.width, height / pkg.height) * IMAGE_FIT_MARGIN
      const scale = fit * this.view.zoom
      return [
        width / 2 + (x - this.view.cx) * pkg.width * scale,
        height / 2 + (y - this.view.cy) * pkg.height * scale,
      ]
    }
    const scale = this.tileScale()
    return [width / 2 + (x - this.view.cx) * scale, height / 2 + (y - this.view.cy) * scale]
  }

  private unproject(sx: number, sy: number, width: number, height: number): [number, number] {
    const pkg = this.pkg
    if (!pkg) return [0, 0]
    if (pkg.kind === 'tiles' && this.maplibreMap) {
      const lngLat = this.maplibreMap.unproject([sx, sy])
      const point = this.lngLatToNormalized(lngLat.lng, lngLat.lat)
      return [point.x, point.y]
    }
    if (pkg.kind === 'image') {
      const fit = Math.min(width / pkg.width, height / pkg.height) * IMAGE_FIT_MARGIN
      const scale = fit * this.view.zoom
      return [
        this.view.cx + (sx - width / 2) / (pkg.width * scale),
        this.view.cy + (sy - height / 2) / (pkg.height * scale),
      ]
    }
    const scale = this.tileScale()
    return [this.view.cx + (sx - width / 2) / scale, this.view.cy + (sy - height / 2) / scale]
  }

  private updateStatus(): void {
    const pkg = this.pkg
    if (!pkg) {
      this.zoomEl.textContent = '—'
      this.scaleEl.textContent = '比例未校准'
      this.visibleCountEl.textContent = '0'
      return
    }
    const hidden = new Set(this.state.hiddenCategories ?? [])
    const visible = this.effectiveMarkerList.filter(
      (marker) => !hidden.has(marker.categoryId),
    ).length
    this.visibleCountEl.textContent = `${visible}/${this.effectiveMarkerList.length}`
    if (this.aligning) {
      this.zoomEl.textContent = '对齐图片'
      this.scaleEl.textContent = '拖动移动 · 滚轮缩放'
    } else if (pkg.kind === 'tiles') {
      const min = pkg.tile?.coverageMinZoom ?? pkg.tile?.minZoom ?? 0
      const max = pkg.tile?.coverageMaxZoom ?? pkg.tile?.maxZoom ?? min
      const over = this.view.zoom > max + 0.05
      this.zoomEl.textContent = `Z ${this.view.zoom.toFixed(1)}`
      const remoteMax = pkg.tile?.maxZoom ?? 0
      const hasRemote = Boolean(pkg.tile?.remoteTemplate?.trim()) && remoteMax > max
      this.scaleEl.textContent = `本地瓦片 z${min}–${max}${hasRemote ? ` · 在线高清 z${max + 1}–${remoteMax}` : ''}${over ? ' · 最高层放大' : ''}`
    } else {
      this.zoomEl.textContent = `${this.view.zoom.toFixed(2)}×`
      this.scaleEl.textContent =
        this.imageLarge && !this.image
          ? this.imageFullRequested
            ? '高清底图加载中'
            : '概览 · 放大加载高清'
          : '图片像素 · 比例未校准'
    }
    const grid = this.gridConfig()
    if (grid) {
      this.scaleEl.textContent += ` · 网格${distanceUnitText(grid) ? ` · ${distanceUnitText(grid)}` : ''}`
    }
    this.emptyEl.hidden = !this.emptyMessage
    this.contextStatusEl.textContent = this.state.context ? '图层上下文：已生成' : '图层上下文：待机'
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return
    if (this.aligning) {
      if (!this.alignRect) return
      this.alignDrag = true
      this.alignStartPointer = { x: event.clientX, y: event.clientY }
      this.alignStartRect = { ...this.alignRect }
      this.canvasEl.setPointerCapture(event.pointerId)
      this.canvasEl.style.cursor = 'move'
      return
    }
    if (this.pinMove && !this.itineraryEdit) {
      const rect = this.canvasEl.getBoundingClientRect()
      const marker = this.hitMovingPin(event.clientX - rect.left, event.clientY - rect.top)
      if (marker) {
        const owner = this.pinDrag
        if (owner) return
        this.pinDrag = {
          id: marker.id,
          startSx: event.clientX - rect.left,
          startSy: event.clientY - rect.top,
          startX: marker.x,
          startY: marker.y,
          originX: marker.x,
          originY: marker.y,
          moved: false,
          pointerId: event.pointerId,
        }
        this.canvasEl.setPointerCapture(event.pointerId)
        this.canvasEl.style.cursor = 'grabbing'
        event.preventDefault()
        return
      }
    }
    this.dragging = true
    this.moved = false
    this.dragX = event.clientX
    this.dragY = event.clientY
    this.canvasEl.setPointerCapture(event.pointerId)
    this.canvasEl.style.cursor = 'grabbing'
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.aligning) {
      if (
        !this.alignDrag ||
        !this.alignStartPointer ||
        !this.alignStartRect ||
        !this.alignRect ||
        !this.pkg
      ) {
        return
      }
      event.preventDefault()
      const dx = event.clientX - this.alignStartPointer.x
      const dy = event.clientY - this.alignStartPointer.y
      const width = this.canvasEl.clientWidth || 1
      const height = this.canvasEl.clientHeight || 1
      const fit = Math.min(width / this.pkg.width, height / this.pkg.height) * IMAGE_FIT_MARGIN
      const scale = fit * this.view.zoom
      this.alignRect = sanitizeRect({
        ...this.alignStartRect,
        x: this.alignStartRect.x + dx / (this.pkg.width * scale),
        y: this.alignStartRect.y + dy / (this.pkg.height * scale),
      })
      this.requestDraw()
      return
    }
    if (this.itineraryEdit && !this.dragging) {
      const rect = this.canvasEl.getBoundingClientRect()
      const width = this.canvasEl.clientWidth || 1
      const height = this.canvasEl.clientHeight || 1
      const [x, y] = this.unproject(
        event.clientX - rect.left,
        event.clientY - rect.top,
        width,
        height,
      )
      this.routeHover = { x, y }
      this.requestDraw()
      return
    }
    if (this.pinDrag) {
      const rect = this.canvasEl.getBoundingClientRect()
      const width = this.canvasEl.clientWidth || 1
      const height = this.canvasEl.clientHeight || 1
      const dx = event.clientX - rect.left - this.pinDrag.startSx
      const dy = event.clientY - rect.top - this.pinDrag.startSy
      if (!this.pinDrag.moved && Math.hypot(dx, dy) < 4) return
      event.preventDefault()
      this.pinDrag.moved = true
      const [startX, startY] = this.unproject(
        this.pinDrag.startSx,
        this.pinDrag.startSy,
        width,
        height,
      )
      const [currentX, currentY] = this.unproject(
        event.clientX - rect.left,
        event.clientY - rect.top,
        width,
        height,
      )
      this.updatePinCoordinate(
        this.pinDrag.id,
        this.pinDrag.originX + (currentX - startX),
        this.pinDrag.originY + (currentY - startY),
        false,
      )
      return
    }
    if (!this.dragging) return
    const dx = event.clientX - this.dragX
    const dy = event.clientY - this.dragY
    if (!this.moved && Math.hypot(dx, dy) < 4) return
    this.moved = true
    event.preventDefault()
    const width = this.canvasEl.clientWidth || 1
    const height = this.canvasEl.clientHeight || 1
    if (this.pkg?.kind === 'tiles') {
      const scale = this.tileScale()
      this.view.cx -= dx / scale
      this.view.cy -= dy / scale
    } else if (this.pkg) {
      const fit = Math.min(width / this.pkg.width, height / this.pkg.height) * IMAGE_FIT_MARGIN
      const scale = fit * this.view.zoom
      this.view.cx -= dx / (this.pkg.width * scale)
      this.view.cy -= dy / (this.pkg.height * scale)
    }
    this.clampView()
    this.dragX = event.clientX
    this.dragY = event.clientY
    this.requestDraw()
  }

  private onPointerUp(event: PointerEvent): void {
    if (this.pinDrag) {
      this.finishPinDrag(event)
      return
    }
    if (event.type === 'pointercancel' && (this.placingUser || this.placingPin)) {
      this.cancelPlacements()
      this.dragging = false
      if (this.canvasEl.hasPointerCapture(event.pointerId)) {
        this.canvasEl.releasePointerCapture(event.pointerId)
      }
      this.canvasEl.style.cursor = 'grab'
      return
    }
    if (this.pinMove && !this.moved && this.dragging) {
      // A click (not a pan) while moving a pin does nothing; drag the pin instead.
      this.dragging = false
      if (this.canvasEl.hasPointerCapture(event.pointerId)) {
        this.canvasEl.releasePointerCapture(event.pointerId)
      }
      this.canvasEl.style.cursor = 'grab'
      return
    }
    if (this.placingPin === 'add' && !this.moved) {
      const rect = this.canvasEl.getBoundingClientRect()
      const width = this.canvasEl.clientWidth || 1
      const height = this.canvasEl.clientHeight || 1
      const [x, y] = this.unproject(
        event.clientX - rect.left,
        event.clientY - rect.top,
        width,
        height,
      )
      this.dragging = false
      this.moved = false
      if (this.canvasEl.hasPointerCapture(event.pointerId)) {
        this.canvasEl.releasePointerCapture(event.pointerId)
      }
      this.canvasEl.style.cursor = 'grab'
      this.cancelPinPlacement()
      this.createCustomPin(x, y)
      return
    }
    if (this.placingUser && !this.moved) {
      const rect = this.canvasEl.getBoundingClientRect()
      const width = this.canvasEl.clientWidth || 1
      const height = this.canvasEl.clientHeight || 1
      const [x, y] = this.unproject(
        event.clientX - rect.left,
        event.clientY - rect.top,
        width,
        height,
      )
      this.dragging = false
      if (this.canvasEl.hasPointerCapture(event.pointerId)) {
        this.canvasEl.releasePointerCapture(event.pointerId)
      }
      this.canvasEl.style.cursor = 'grab'
      this.setUserPosition(x, y, undefined, !event.altKey)
      return
    }
    if (this.aligning) {
      if (!this.alignDrag) return
      this.alignDrag = false
      this.alignStartPointer = null
      this.alignStartRect = null
      if (this.canvasEl.hasPointerCapture(event.pointerId)) {
        this.canvasEl.releasePointerCapture(event.pointerId)
      }
      this.canvasEl.style.cursor = 'grab'
      return
    }
    if (!this.dragging) return
    this.dragging = false
    if (this.canvasEl.hasPointerCapture(event.pointerId)) {
      this.canvasEl.releasePointerCapture(event.pointerId)
    }
    this.canvasEl.style.cursor = 'grab'
    if (this.itineraryEdit && !this.moved) {
      const rect = this.canvasEl.getBoundingClientRect()
      const width = this.canvasEl.clientWidth || 1
      const height = this.canvasEl.clientHeight || 1
      const [x, y] = this.unproject(
        event.clientX - rect.left,
        event.clientY - rect.top,
        width,
        height,
      )
      const marker = this.hitMarker(event.clientX - rect.left, event.clientY - rect.top)
      this.addItineraryStop(x, y, marker)
      return
    }
    if (!this.moved && !this.suppressClick) {
      this.pickAt(event.clientX, event.clientY)
    }
    this.suppressClick = false
    this.state.view = this.view
    this.persist()
    if (this.pkg?.kind === 'image') this.refreshContext()
  }

  private onWheel(event: WheelEvent): void {
    if (!this.pkg) return
    event.preventDefault()
    if (this.aligning) {
      const rect = this.canvasEl.getBoundingClientRect()
      this.zoomAlign(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * 0.0015))
      return
    }
    const rect = this.canvasEl.getBoundingClientRect()
    const factor = Math.exp(-event.deltaY * 0.0015)
    this.zoomAt(event.clientX - rect.left, event.clientY - rect.top, factor)
  }

  private onDoubleClick(event: MouseEvent): void {
    if (this.aligning) return
    const rect = this.canvasEl.getBoundingClientRect()
    this.zoomAt(event.clientX - rect.left, event.clientY - rect.top, 1.6)
  }

  private zoomAt(sx: number, sy: number, factor: number): void {
    if (!this.pkg || this.aligning) return
    if (this.pkg.kind === 'tiles' && this.maplibreMap) {
      this.maplibreMap.zoomTo(this.maplibreMap.getZoom() + Math.log2(factor), { duration: 120 })
      return
    }
    const width = this.canvasEl.clientWidth || 1
    const height = this.canvasEl.clientHeight || 1
    const before = this.unproject(sx, sy, width, height)
    if (this.pkg.kind === 'image') {
      this.view.zoom = Math.max(0.05, this.view.zoom * factor)
      if (this.imageLarge && this.view.zoom > 1.15) this.loadFullImage(this.pkg)
    } else {
      const tile = this.pkg.tile
      const min = tile?.coverageMinZoom ?? tile?.minZoom ?? 0
      this.view.zoom = Math.max(min, Math.min(25, this.view.zoom + Math.log2(factor)))
    }
    const after = this.unproject(sx, sy, width, height)
    this.view.cx += before[0] - after[0]
    this.view.cy += before[1] - after[1]
    this.clampView()
    this.state.view = this.view
    this.persist()
    this.requestDraw()
  }

  private clampView(): void {
    this.view.cx = Math.min(1.15, Math.max(-0.15, this.view.cx))
    this.view.cy = Math.min(1.15, Math.max(-0.15, this.view.cy))
  }

  private fitView(): void {
    if (!this.pkg || this.aligning) return
    if (this.pkg.kind === 'tiles' && this.maplibreMap) {
      void this.fitTileMap(this.pkg)
      return
    }
    this.view = this.defaultView(this.pkg)
    this.state.view = this.view
    this.persist()
    this.requestDraw()
    if (this.pkg.kind === 'image') this.refreshContext()
  }

  private pickAt(clientX: number, clientY: number): void {
    const rect = this.canvasEl.getBoundingClientRect()
    const sx = clientX - rect.left
    const sy = clientY - rect.top
    const cluster = this.clusterHitAreas.find(
      (area) => Math.hypot(area.x - sx, area.y - sy) <= area.radius,
    )
    if (cluster) {
      this.zoomIntoCluster(cluster.nx, cluster.ny)
      return
    }
    const marker = this.hitMarker(sx, sy)
    if (marker) {
      this.selectMarker(marker)
      return
    }
    const road = this.hitRoad(sx, sy)
    if (road) {
      this.selectRoad(this.roadKey(road))
      return
    }
    this.selectRegion(this.hitRegion(sx, sy))
  }

  private selectRegion(region: LayerRegion | undefined): void {
    this.state.selectedMarkerId = undefined
    this.state.selectedRegionId = region?.id
    this.state.selectedRoadKey = undefined
    this.renderDetail()
    this.refreshContext()
    this.persist()
    this.requestDraw()
    this.syncToolButtons()
  }

  private buildMarkerIndex(): void {
    this.markerIndex.clear()
    for (const marker of this.effectiveMarkerList) {
      const key = `${Math.floor(marker.x / MARKER_INDEX_CELL)}:${Math.floor(marker.y / MARKER_INDEX_CELL)}`
      const bucket = this.markerIndex.get(key)
      if (bucket) bucket.push(marker)
      else this.markerIndex.set(key, [marker])
    }
  }

  private markersInView(width: number, height: number): LayerMarker[] {
    if (!this.pkg) return []
    const [west, north] = this.unproject(-24, -24, width, height)
    const [east, south] = this.unproject(width + 24, height + 24, width, height)
    const minX = Math.min(west, east)
    const maxX = Math.max(west, east)
    const minY = Math.min(north, south)
    const maxY = Math.max(north, south)
    if (
      !Number.isFinite(minX) ||
      !Number.isFinite(maxX) ||
      !Number.isFinite(minY) ||
      !Number.isFinite(maxY)
    ) {
      return []
    }
    const x0 = Math.floor(minX / MARKER_INDEX_CELL)
    const x1 = Math.floor(maxX / MARKER_INDEX_CELL)
    const y0 = Math.floor(minY / MARKER_INDEX_CELL)
    const y1 = Math.floor(maxY / MARKER_INDEX_CELL)
    if (!Number.isFinite(x0) || !Number.isFinite(x1) || !Number.isFinite(y0) || !Number.isFinite(y1)) {
      return []
    }
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 8192) return []
    const result: LayerMarker[] = []
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        const bucket = this.markerIndex.get(`${cx}:${cy}`)
        if (!bucket) continue
        for (const marker of bucket) {
          if (marker.x < minX || marker.x > maxX || marker.y < minY || marker.y > maxY) continue
          result.push(marker)
        }
      }
    }
    return result
  }

  private hitMarker(sx: number, sy: number): LayerMarker | undefined {
    const pkg = this.pkg
    if (!pkg) return undefined
    const width = this.canvasEl.clientWidth || 1
    const height = this.canvasEl.clientHeight || 1
    const hidden = new Set(this.state.hiddenCategories ?? [])
    let best: LayerMarker | undefined
    let bestDistance = MARKER_HIT_RADIUS
    const inView = this.markersInView(width, height)
    for (const marker of inView) {
      if (hidden.has(marker.categoryId)) continue
      const [x, y] = this.project(marker.x, marker.y, width, height)
      const distance = Math.hypot(x - sx, y - sy)
      if (distance <= bestDistance) {
        best = marker
        bestDistance = distance
      }
    }
    return best
  }

  private hitRegion(sx: number, sy: number): LayerRegion | undefined {
    const pkg = this.pkg
    if (!pkg || this.state.showRegions === false || pkg.regions.length === 0) return undefined
    const width = this.canvasEl.clientWidth || 1
    const height = this.canvasEl.clientHeight || 1
    const [x, y] = this.unproject(sx, sy, width, height)
    let best: LayerRegion | undefined
    let bestArea = Infinity
    for (const region of pkg.regions) {
      for (const ring of region.polygons) {
        if (!pointInRing(x, y, ring)) continue
        let minX = Infinity
        let maxX = -Infinity
        let minY = Infinity
        let maxY = -Infinity
        for (const [px, py] of ring) {
          minX = Math.min(minX, px)
          maxX = Math.max(maxX, px)
          minY = Math.min(minY, py)
          maxY = Math.max(maxY, py)
        }
        const area = Math.max(0, maxX - minX) * Math.max(0, maxY - minY)
        if (area < bestArea) {
          best = region
          bestArea = area
        }
      }
    }
    return best
  }

  private selectMarker(marker: LayerMarker, center = false): void {
    this.state.selectedMarkerId = marker.id
    this.state.selectedRegionId = undefined
    this.state.selectedRoadKey = undefined
    if (center) this.centerOnMarker(marker)
    this.renderDetail()
    this.refreshContext()
    this.persist()
    this.requestDraw()
    this.syncToolButtons()
  }

  private centerOnMarker(marker: LayerMarker): void {
    if (this.pkg?.kind === 'tiles' && this.maplibreMap) {
      this.maplibreMap.easeTo({
        center: this.normalizedToLngLat(marker.x, marker.y),
        duration: 320,
      })
      return
    }
    this.view.cx = marker.x
    this.view.cy = marker.y
    this.clampView()
    this.state.view = this.view
    this.persist()
    this.requestDraw()
  }

  private centerOnRegion(region: LayerRegion): void {
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const ring of region.polygons) {
      for (const [x, y] of ring) {
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
      }
    }
    if (Number.isFinite(minX)) {
      if (this.pkg?.kind === 'tiles' && this.maplibreMap) {
        const [west, north] = this.normalizedToLngLat(minX, minY)
        const [east, south] = this.normalizedToLngLat(maxX, maxY)
        this.maplibreMap.fitBounds(
          [west, south, east, north],
          { padding: 36, duration: 320, maxZoom: (this.pkg.tile?.coverageMaxZoom ?? 14) + 1 },
        )
        return
      }
      this.view.cx = (minX + maxX) / 2
      this.view.cy = (minY + maxY) / 2
      this.clampView()
      this.state.view = this.view
      this.persist()
      this.requestDraw()
    }
  }

  private categoryColor(seed: string): string {
    const category = this.categoryById(seed)
    if (category) return category.color
    const index = [...seed].reduce((sum, char) => sum + char.charCodeAt(0), 0)
    return PALETTE[index % PALETTE.length]
  }

  private renderCategories(): void {
    if (!this.categoriesEl) return
    this.categoriesEl.replaceChildren()
    const pkg = this.pkg
    if (!pkg) {
      this.categoriesEl.append(textElement('div', 'tml-empty-small', '导入地图包后显示分类。'))
      return
    }
    const query = this.categoryFilterEl.value.trim().toLowerCase()
    const hidden = new Set(this.state.hiddenCategories ?? [])
    const counts = new Map<string, number>()
    for (const marker of this.effectiveMarkerList) {
      counts.set(marker.categoryId, (counts.get(marker.categoryId) ?? 0) + 1)
    }
    const groups = new Map<string, { name: string; order: number; categories: LayerCategory[] }>()
    for (const category of this.effectiveCategoryList) {
      const groupId = category.groupId ?? '__ungrouped'
      const group = this.effectiveGroupList.find((item) => item.id === category.groupId)
      if (!groups.has(groupId)) {
        groups.set(groupId, {
          name: group?.name ?? '未分组',
          order: group?.order ?? 9999,
          categories: [],
        })
      }
      groups.get(groupId)!.categories.push(category)
    }
    const groupList = [...groups.entries()].sort((a, b) => a[1].order - b[1].order)
    let visibleGroups = 0
    for (const group of groupList.map((entry) => entry[1])) {
      const categories = group.categories
        .filter((category) => {
          if (!query) return true
          return (
            category.name.toLowerCase().includes(query) ||
            group.name.toLowerCase().includes(query)
          )
        })
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      if (categories.length === 0) continue
      visibleGroups += 1
      const details = document.createElement('details')
      details.className = 'tml-cat-group'
      details.open = groupList.length <= 2 || visibleGroups <= 2
      const summary = document.createElement('summary')
      const label = document.createElement('span')
      label.textContent = group.name
      const count = document.createElement('span')
      count.className = 'tml-cat-group-count'
      count.textContent = `${categories.filter((category) => !hidden.has(category.id)).length}/${categories.length}`
      summary.append(label, count)
      details.append(summary)
      for (const category of categories) {
        const row = document.createElement('label')
        row.className = 'tml-cat-row'
        const checkbox = document.createElement('input')
        checkbox.type = 'checkbox'
        checkbox.checked = !hidden.has(category.id)
        checkbox.addEventListener('change', () => {
          const next = new Set(this.state.hiddenCategories ?? [])
          if (checkbox.checked) next.delete(category.id)
          else next.add(category.id)
          this.state.hiddenCategories = [...next]
          this.renderCategories()
          this.refreshContext()
          this.persist()
          this.requestDraw()
        })
        const swatch = document.createElement('span')
        swatch.className = 'tml-swatch'
        swatch.style.background = category.color
        const name = document.createElement('span')
        name.className = 'tml-cat-name'
        name.textContent = category.name
        const count = document.createElement('span')
        count.className = 'tml-cat-count'
        count.textContent = String(counts.get(category.id) ?? 0)
        row.append(checkbox, swatch, name, count)
        details.append(row)
      }
      this.categoriesEl.append(details)
    }
    if (this.categoriesEl.childElementCount === 0) {
      this.categoriesEl.append(textElement('div', 'tml-empty-small', '没有匹配的分类。'))
    }
  }

  private renderDetail(): void {
    if (!this.detailEl) return
    this.syncRegionNoteAI = undefined
    this.detailEl.replaceChildren()
    const pkg = this.pkg
    if (!pkg) {
      this.detailEl.append(textElement('div', 'tml-empty-small', '导入一张地图，然后点地图上的地点。'))
      return
    }
    if (this.state.selectedMarkerId) {
      const marker = this.markerById(this.state.selectedMarkerId)
      if (marker) {
        this.detailEl.append(this.markerDetail(marker))
        return
      }
    }
    if (this.state.selectedRegionId) {
      const region = pkg.regions.find((item) => item.id === this.state.selectedRegionId)
      if (region) {
        this.detailEl.append(this.regionDetail(region))
        return
      }
    }
    if (this.state.selectedRoadKey && this.roadLines(this.state.selectedRoadKey).length > 0) {
      this.detailEl.append(this.roadDetail(this.state.selectedRoadKey))
      return
    }
    this.detailEl.append(
      textElement('div', 'tml-empty-small', '点地图上的地点查看详情；也可以搜索或使用左侧分类。'),
    )
  }

  private markerDetail(marker: LayerMarker): HTMLElement {
    const pkg = this.pkg
    if (!pkg) return textElement('div', 'tml-empty-small', '')
    const category = this.categoryById(marker.categoryId)
    const region = this.regionForMarker(marker)
    const atPlace = this.state.atPlaceId === marker.id
    const favorite = this.markerFavorite(marker)
    const wrap = document.createElement('article')
    wrap.className = 'tml-detail-card'
    const head = document.createElement('header')
    head.className = 'tml-detail-head'
    const titleWrap = document.createElement('div')
    const kicker = document.createElement('span')
    kicker.className = 'tml-kicker'
    kicker.textContent = category?.name ?? '地点'
    const title = document.createElement('h2')
    title.textContent = marker.name
    titleWrap.append(kicker, title)
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'tml-close'
    close.title = '关闭详情'
    close.textContent = '×'
    close.addEventListener('click', () => {
      this.state.selectedMarkerId = undefined
      this.renderDetail()
      this.persist()
      this.requestDraw()
      this.syncToolButtons()
    })
    const star = document.createElement('button')
    star.type = 'button'
    star.className = `tml-star-toggle${favorite ? ' active' : ''}`
    star.textContent = favorite ? '★' : '☆'
    star.title = favorite ? '取消收藏' : '收藏地点'
    star.addEventListener('click', () => {
      this.toggleMarkerFavorite(marker)
      this.renderDetail()
      this.renderFavorites()
    })
    head.append(titleWrap, star, close)
    const meta = document.createElement('div')
    meta.className = 'tml-detail-meta'
    const gridText = this.gridText(marker.x, marker.y)
    meta.textContent = [
      region?.name ?? '',
      gridText ?? '',
      marker.sourceId ? `来源 id ${marker.sourceId}` : '',
      marker.custom ? '我添加的图钉' : '',
      pkg.sourceLabel || (pkg.source === 'mapgenie' ? 'Map Genie 本地快照' : 'Fandom 本地导入'),
    ]
      .filter(Boolean)
      .join(' · ')
    const actions = document.createElement('div')
    actions.className = 'tml-detail-actions'
    actions.append(
      this.actionButton('居中', () => this.centerOnMarker(marker)),
      this.actionButton(atPlace ? '我在这里' : '移动我到这里', () => this.setUserPosition(marker.x, marker.y, marker.id), atPlace),
      this.actionButton(
        '移动图钉',
        () => (this.pinMove?.id === marker.id ? this.cancelPlacements() : this.startPinPlacement('move', marker.id)),
        this.pinMove?.id === marker.id,
      ),
    )
    // While this pin is being moved, undo/redo step through the current drags.
    const session = this.pinMove?.id === marker.id ? this.pinMove : undefined
    const history = this.pinHistoryFor(marker.id)
    const undoCount = session ? session.cursor : history?.past.length ?? 0
    const redoCount = session ? session.points.length - 1 - session.cursor : history?.future.length ?? 0
    const undo = this.actionButton(`↶ 撤销${undoCount ? ` ${undoCount}` : ''}`, () => this.undoPin(marker.id))
    undo.disabled = !undoCount
    const redo = this.actionButton(`↷ 重做${redoCount ? ` ${redoCount}` : ''}`, () => this.redoPin(marker.id))
    redo.disabled = !redoCount
    actions.append(undo, redo)
    if (!marker.custom && this.pinEdits.overrides[marker.id]) {
      actions.append(
        this.actionButton('恢复原位', () => this.resetPinPosition(marker.id), false, 'tml-danger-text'),
      )
    }
    if (marker.custom) {
      actions.append(
        this.actionButton('删除图钉', () => this.deleteCustomPin(marker.id), false, 'tml-danger-text'),
      )
    }
    const nameSection = marker.custom ? this.customPinNameSection(marker, title) : null
    wrap.append(head, meta, actions)
    if (nameSection) wrap.append(nameSection)
    wrap.append(this.sourceSection(marker))
    wrap.append(this.linksSection(marker, this.markerImportedLinks(marker), this.aiContentToggle(marker, 'wiki')))
    wrap.append(this.noteSection(marker))
    const ai = document.createElement('div')
    ai.className = 'tml-ai-row'
    const aiLabel = document.createElement('span')
    aiLabel.textContent = atPlace
      ? '我在的地点会进入 AI 上下文'
      : '点开只是查看；AI 不会把这里当成我在的地点'
    const preview = this.actionButton('预览 AI', () => this.showContextStatus())
    ai.append(aiLabel, preview)
    wrap.append(ai)
    return wrap
  }

  private markerFavoriteKey(marker: LayerMarker): string {
    return layerFavoriteKey(this.pkg?.id ?? '', marker.id)
  }

  private markerFavorite(marker: LayerMarker): FavoritePlace | undefined {
    const key = this.markerFavoriteKey(marker)
    return listFavorites().find((favorite) => favorite.key === key)
  }

  private toggleMarkerFavorite(marker: LayerMarker): void {
    const pkg = this.pkg
    if (!pkg) return
    const place: FavoritePlace = {
      key: this.markerFavoriteKey(marker),
      kind: 'layer',
      mapId: pkg.id,
      mapName: pkg.name,
      markerId: marker.id,
      name: marker.name,
      category: this.categoryById(marker.categoryId)?.name,
      x: marker.x,
      y: marker.y,
      note: this.markerNoteValue(marker),
      savedAt: Date.now(),
    }
    const added = toggleFavorite(place)
    this.toast(added ? `已收藏 ${marker.name}` : `已取消收藏 ${marker.name}`)
    this.refreshContext()
    this.renderFavorites()
    this.requestDraw()
  }

  private refreshFavoriteMarkerIds(): void {
    const pkg = this.pkg
    this.favoriteMarkerIds = new Set(
      pkg
        ? listFavorites()
            .filter((favorite) => favorite.kind === 'layer' && favorite.mapId === pkg.id)
            .map((favorite) => favorite.markerId)
            .filter((id): id is string => Boolean(id))
        : [],
    )
  }

  private renderFavorites(): void {
    if (!this.favoritesEl) return
    this.refreshFavoriteMarkerIds()
    const pkg = this.pkg
    const favorites = listFavorites().filter(
      (favorite) => favorite.kind === 'layer' && pkg && favorite.mapId === pkg.id,
    )
    this.favoriteCountEl.textContent = String(favorites.length)
    this.favoritesEl.replaceChildren()
    if (!pkg || favorites.length === 0) {
      this.favoritesEl.append(
        textElement('div', 'tml-empty-small', '还没有收藏这个地图的地点。点开地点后点 ☆ 收藏。'),
      )
      return
    }
    for (const favorite of favorites) {
      const row = document.createElement('div')
      row.className = 'tml-favorite-row'
      const marker = favorite.markerId
        ? this.markerById(favorite.markerId)
        : undefined
      const title = document.createElement('button')
      title.type = 'button'
      title.className = 'tml-favorite-main'
      const name = document.createElement('span')
      name.className = 'tml-favorite-name'
      name.textContent = favorite.name
      const meta = document.createElement('span')
      meta.className = 'tml-favorite-meta'
      meta.textContent = [favorite.category, favorite.mapName].filter(Boolean).join(' · ')
      title.append(name, meta)
      title.addEventListener('click', () => {
        if (marker) this.selectMarker(marker, true)
      })
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'tml-star-toggle active'
      remove.textContent = '★'
      remove.title = '取消收藏'
      remove.addEventListener('click', () => {
        removeFavorite(favorite.key)
        this.refreshContext()
        this.renderFavorites()
        this.renderDetail()
        this.requestDraw()
      })
      row.append(title, remove)
      this.favoritesEl.append(row)
    }
  }

  /** Right panel for a road: name, length, source fields from the map data, road note. */
  private roadDetail(key: string): HTMLElement {
    const lines = this.roadLines(key)
    const first = lines[0]
    const wrap = document.createElement('article')
    wrap.className = 'tml-detail-card tml-road-detail'
    const head = document.createElement('header')
    head.className = 'tml-detail-head'
    const titleWrap = document.createElement('div')
    const kicker = document.createElement('span')
    kicker.className = 'tml-kicker'
    kicker.textContent = '道路'
    const title = document.createElement('h2')
    title.textContent = this.roadDisplayName(first)
    titleWrap.append(kicker, title)
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'tml-close'
    close.textContent = '×'
    close.setAttribute('aria-label', '关闭道路详情')
    close.addEventListener('click', () => {
      this.state.selectedRoadKey = undefined
      this.renderDetail()
      this.persist()
      this.requestDraw()
    })
    head.append(titleWrap, close)
    const length = lines.reduce(
      (total, line) => total + this.itineraryPathMeasure(line.points.map(([x, y]) => ({ x, y }))),
      0,
    )
    const meta = document.createElement('div')
    meta.className = 'tml-detail-meta'
    meta.textContent = [first.type, `${lines.length} 段`, `全长 ${this.itineraryMeasureLabel(length)}`]
      .filter(Boolean)
      .join(' · ')
    const actions = document.createElement('div')
    actions.className = 'tml-detail-actions'
    actions.append(this.actionButton('居中', () => this.centerOnRoad(lines)))
    wrap.append(head, meta, actions)

    const source = document.createElement('details')
    source.className = 'tml-source tml-road-source'
    source.open = true
    const summary = document.createElement('summary')
    summary.textContent = '来源资料（随道路显示）'
    const settings = loadSettings(this.liveContext())
    const sourceAI = document.createElement('div')
    sourceAI.className = 'tml-road-source-ai'
    sourceAI.append(
      this.aiFlagToggle(
        this.roadAIKey(key),
        'source',
        '道路来源资料',
        '道路',
        settings.layerRoadSourceAI && this.roadNotesGloballyEnabled(settings),
        () => this.roadAIScope(loadSettings(this.liveContext())).has(key),
        '这条路不在你附近，也不在勾选的行程段里',
      ).label,
    )
    source.append(summary, sourceAI)
    const withFields = lines.filter((line) => line.properties?.length)
    if (withFields.length === 0) {
      source.append(
        textElement(
          'div',
          'tml-road-source-empty',
          '这张地图包导入时还没有保留道路的原始字段，重新导入地图包后会在这里显示。',
        ),
      )
      source.append(this.roadFieldList([
        ['Name', first.name],
        ['Type', first.type ?? ''],
      ].filter(([, value]) => value) as Array<[string, string]>))
    } else {
      // Lines of one road often share their fields; show each distinct set once.
      const groups = new Map<string, { fields: Array<[string, string]>; count: number }>()
      for (const line of withFields) {
        const fields = (line.properties ?? []).filter(([, value]) => !sourceHttpUrl(value))
        if (!fields.length) continue
        const signature = JSON.stringify(fields)
        const group = groups.get(signature)
        if (group) group.count += 1
        else groups.set(signature, { fields, count: 1 })
      }
      const many = groups.size > 1
      let index = 0
      for (const group of groups.values()) {
        index += 1
        if (many) {
          source.append(
            textElement('div', 'tml-road-source-head', `第 ${index} 组${group.count > 1 ? `（${group.count} 段）` : ''}`),
          )
        }
        source.append(this.roadFieldList(group.fields))
      }
      if (groups.size === 0) {
        source.append(textElement('div', 'tml-road-source-empty', '暂无道路来源正文。'))
      }
    }
    const owner = { id: this.roadNoteKey(key) }
    wrap.append(source, this.linksSection(owner, sourceFieldLinks(lines.flatMap((line) => line.properties ?? []), key)))

    const noteWrap = document.createElement('div')
    noteWrap.className = 'tml-note-section'
    const noteHead = document.createElement('div')
    noteHead.className = 'tml-section-head'
    const label = document.createElement('label')
    label.className = 'tml-note-label'
    label.textContent = '道路笔记'
    noteHead.append(
      label,
      this.aiFlagToggle(
        this.roadAIKey(key),
        'note',
        '道路笔记',
        '道路',
        this.roadNotesGloballyEnabled(),
        () => this.roadAIScope(loadSettings(this.liveContext())).has(key),
        '这条路不在你附近，也不在勾选的行程段里',
      ).label,
    )
    const textarea = document.createElement('textarea')
    textarea.placeholder = '写一段道路笔记…'
    textarea.setAttribute('aria-label', '道路笔记')
    textarea.value = this.roadNoteValue(key)
    textarea.addEventListener('input', () => this.setNoteValue(this.roadNoteKey(key), textarea.value))
    noteWrap.append(noteHead, textarea)
    wrap.append(noteWrap)
    return wrap
  }

  private roadFieldList(fields: Array<[string, string]>): HTMLElement {
    const list = document.createElement('dl')
    list.className = 'tml-road-fields'
    for (const [name, value] of fields) {
      const term = document.createElement('dt')
      term.textContent = name
      const detail = document.createElement('dd')
      detail.textContent = value
      list.append(term, detail)
    }
    return list
  }

  private regionDetail(region: LayerRegion): HTMLElement {
    const pkg = this.pkg
    if (!pkg) return textElement('div', 'tml-empty-small', '')
    const count = this.effectiveMarkerList.filter(
      (marker) => this.regionForMarker(marker)?.id === region.id,
    ).length
    const wrap = document.createElement('article')
    wrap.className = 'tml-detail-card'
    const head = document.createElement('header')
    head.className = 'tml-detail-head'
    const titleWrap = document.createElement('div')
    const kicker = document.createElement('span')
    kicker.className = 'tml-kicker'
    kicker.textContent = '区域'
    const title = document.createElement('h2')
    title.textContent = region.name
    titleWrap.append(kicker, title)
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'tml-close'
    close.textContent = '×'
    close.addEventListener('click', () => {
      this.state.selectedRegionId = undefined
      this.renderDetail()
      this.persist()
      this.requestDraw()
    })
    head.append(titleWrap, close)
    const meta = document.createElement('div')
    meta.className = 'tml-detail-meta'
    meta.textContent = `${count} 个地点 · ${region.polygons.length} 个多边形`
    const actions = document.createElement('div')
    actions.className = 'tml-detail-actions'
    actions.append(this.actionButton('居中', () => this.centerOnRegion(region)))
    const source = this.editableSourceSection(
      '区域',
      `layer-source:${pkg.id}:region:${region.id}`,
      region.description ?? '',
    )
    const fields = (region.properties ?? []).filter(([, value]) => !sourceHttpUrl(value))
    if (fields.length) source.append(this.roadFieldList(fields))
    wrap.append(head, meta, actions, source, this.linksSection({ id: this.regionNoteKey(region) }, region.sourceLinks ?? []))
    const noteWrap = document.createElement('div')
    noteWrap.className = 'tml-note-section'
    const noteHead = document.createElement('div')
    noteHead.className = 'tml-section-head'
    const label = document.createElement('label')
    label.className = 'tml-note-label'
    label.textContent = '区域笔记'
    noteHead.append(label, this.regionNoteAIToggle(region))
    const textarea = document.createElement('textarea')
    textarea.placeholder = '写一段区域笔记…'
    textarea.setAttribute('aria-label', '区域笔记')
    textarea.value = this.regionNoteValue(region)
    textarea.addEventListener('input', () => {
      this.setRegionNote(region, textarea.value)
    })
    noteWrap.append(noteHead, textarea)
    wrap.append(noteWrap)
    return wrap
  }

  private markerImportedLinks(marker: LayerMarker): LayerLink[] {
    if (marker.sourceLinks) return marker.sourceLinks
    return marker.sourceUrl
      ? [{ id: `source:${marker.id}:wiki`, kind: 'wikipedia', title: marker.sourceTitle || marker.name, url: marker.sourceUrl }]
      : []
  }

  private linksSection(owner: LinkOwner, importedLinks: LayerLink[], aiToggle?: HTMLElement): HTMLElement {
    const section = document.createElement('section')
    section.className = 'tml-links'
    const heading = document.createElement('div')
    heading.className = 'tml-section-label tml-links-head'
    const headingText = document.createElement('span')
    headingText.textContent = '链接来源'
    heading.append(headingText)
    if (aiToggle) heading.append(aiToggle)
    section.append(heading)
    const imported = importedLinks.filter((link) => sourceHttpUrl(link.url))
    const userLinks = this.userLinksFor(owner).filter((link) => sourceHttpUrl(link.url))
    if (imported.length === 0) {
      section.append(
        textElement(
          'div',
          'tml-link-source-empty',
          userLinks.length === 0
            ? '源数据没有链接。可以添加 Wikipedia、官网、点评页或自定义链接。'
            : '源数据没有链接。下面是你在本机添加的链接。',
        ),
      )
    }
    for (const link of imported) {
      const key = `${owner.id}:${link.id}`
      const saved = this.state.sourceLinkText?.[key]
      const cached = this.linkTextValue(link)
      if (cached === undefined && saved?.text) {
        setGlobalNote(linkTextKey(link.url), saved.text)
      }
      section.append(
        this.linkRow(owner, link, true, key, cached ?? saved?.text, saved?.status),
      )
    }
    for (const link of userLinks) {
      const cached = this.linkTextValue(link)
      if (cached === undefined && link.text) setGlobalNote(linkTextKey(link.url), link.text)
      section.append(
        this.linkRow(owner, link, false, undefined, cached ?? link.text, link.status),
      )
    }
    if (this.linkDraftFor !== owner.id) {
      const add = document.createElement('button')
      add.type = 'button'
      add.className = 'tml-mini tml-add-link'
      add.textContent = '+ 添加链接'
      add.addEventListener('click', () => {
        this.linkDraftFor = owner.id
        this.linkDraftTitle = ''
        this.linkDraftUrl = ''
        this.linkDraftKind = 'custom'
        this.renderDetail()
      })
      section.append(add)
    } else {
      section.append(this.linkEditor(owner))
    }
    return section
  }

  private linkRow(
    owner: LinkOwner,
    link: LayerLink,
    imported: boolean,
    stateKey: string | undefined,
    savedText: string | undefined,
    savedStatus: string | undefined,
  ): HTMLElement {
    const row = document.createElement('div')
    row.className = 'tml-link-row'
    const icon = document.createElement('span')
    icon.className = `tml-link-kind kind-${link.kind}`
    icon.textContent =
      link.kind === 'wikipedia' ? 'W' : link.kind === 'official' ? 'O' : link.kind === 'review' ? 'R' : link.kind === 'source' ? 'S' : 'C'
    const body = document.createElement('div')
    body.className = 'tml-link-body'
    const title = document.createElement('div')
    title.className = 'tml-link-title'
    title.textContent = link.title
    const status = document.createElement('div')
    status.className = 'tml-link-status'
    const autoExpand = loadSettings(this.ctx).layerAutoExpandWiki
    const text = savedText ?? link.text
    const hasError = Boolean(savedStatus && /失败|错误|没有可读取/.test(savedStatus))
    status.textContent =
      hasError || !text
        ? savedStatus ?? (imported ? '导入链接' : '未抓取')
        : `已缓存正文 · ${text.length} 字`
    body.append(title, status)
    const actions = document.createElement('div')
    actions.className = 'tml-link-actions'
    let textBody: HTMLPreElement | undefined
    const open = document.createElement('a')
    open.className = 'tml-mini'
    open.href = link.url
    open.target = '_blank'
    open.rel = 'noreferrer'
    open.textContent = '打开'
    actions.append(open)
    if (text) {
      textBody = document.createElement('pre')
      textBody.className = 'tml-link-text'
      textBody.textContent = text
      textBody.hidden = !autoExpand
      const read = document.createElement('button')
      read.type = 'button'
      read.className = 'tml-mini'
      read.textContent = autoExpand ? '收起正文' : '正文'
      read.setAttribute('aria-expanded', String(autoExpand))
      read.addEventListener('click', () => {
        if (!textBody) return
        textBody.hidden = !textBody.hidden
        read.textContent = textBody.hidden ? '正文' : '收起正文'
        read.setAttribute('aria-expanded', String(!textBody.hidden))
      })
      actions.append(read)
    } else if (/^https?:\/\//i.test(link.url)) {
      const fetch = document.createElement('button')
      fetch.type = 'button'
      fetch.className = 'tml-mini'
      fetch.textContent = '抓取'
      fetch.addEventListener('click', () => void this.fetchLink(owner, link, imported, stateKey))
      actions.append(fetch)
    }
    const paste = document.createElement('button')
    paste.type = 'button'
    paste.className = 'tml-mini'
    paste.textContent = '粘贴'
    paste.addEventListener('click', () => {
      const pasted = window.prompt('粘贴正文（会保存在本地全局缓存）', text ?? '')
      if (!pasted?.trim()) return
      this.storeLinkText(link, imported, stateKey, pasted, `已手动保存 · ${pasted.length} 字`, owner)
      this.renderDetail()
      if (this.state.selectedMarkerId === owner.id) this.refreshContext()
    })
    actions.append(paste)
    if (!imported) {
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'tml-mini'
      remove.textContent = '移除'
      remove.addEventListener('click', () => {
        this.setUserLinks(owner, this.userLinksFor(owner).filter((item) => item.id !== link.id))
        this.refreshContext()
        this.renderDetail()
      })
      actions.append(remove)
    }
    row.append(icon, body, actions)
    if (textBody) row.append(textBody)
    return row
  }

  private storeLinkText(
    link: LayerLink,
    imported: boolean,
    stateKey: string | undefined,
    text: string,
    status: string,
    owner: LinkOwner,
  ): void {
    if (text.trim()) setGlobalNote(linkTextKey(link.url), text)
    if (imported && stateKey) {
      const target = this.state.sourceLinkText ?? (this.state.sourceLinkText = {})
      target[stateKey] = { text, status, fetchedAt: Date.now() }
    } else {
      link.text = text
      link.fetchedAt = Date.now()
      link.status = status
    }
    if (owner.custom) this.savePinEditsForMap()
    else this.persist()
  }

  private linkEditor(owner: LinkOwner): HTMLElement {
    const form = document.createElement('div')
    form.className = 'tml-link-editor'
    const kind = document.createElement('select')
    const kinds: Array<[LayerLinkKind, string]> = [
      ['wikipedia', 'Wikipedia'],
      ['official', '官网'],
      ['review', '点评'],
      ['source', '来源页'],
      ['custom', '自定义'],
    ]
    for (const [value, label] of kinds) kind.append(new Option(label, value))
    kind.value = this.linkDraftKind
    kind.addEventListener('change', () => {
      this.linkDraftKind = kind.value as LayerLinkKind
    })
    const title = document.createElement('input')
    title.placeholder = '标题'
    title.value = this.linkDraftTitle
    title.addEventListener('input', () => {
      this.linkDraftTitle = title.value
    })
    const url = document.createElement('input')
    url.placeholder = 'https://…'
    url.value = this.linkDraftUrl
    url.addEventListener('input', () => {
      this.linkDraftUrl = url.value
    })
    const row = document.createElement('div')
    row.className = 'tml-link-editor-row'
    row.append(kind, title)
    const actions = document.createElement('div')
    actions.className = 'tml-link-actions'
    const save = document.createElement('button')
    save.type = 'button'
    save.className = 'tml-mini'
    save.textContent = '保存'
    save.addEventListener('click', () => {
      const urlValue = url.value.trim()
      if (!sourceHttpUrl(urlValue)) {
        this.toast('链接需要 http(s) 地址')
        return
      }
      const link: LayerLink = {
        id: `link:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
        kind: this.linkDraftKind,
        title: title.value.trim() || urlValue,
        url: urlValue,
      }
      this.setUserLinks(owner, [...this.userLinksFor(owner), link])
      this.linkDraftFor = undefined
      this.refreshContext()
      this.renderDetail()
    })
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'tml-mini'
    cancel.textContent = '取消'
    cancel.addEventListener('click', () => {
      this.linkDraftFor = undefined
      this.renderDetail()
    })
    actions.append(save, cancel)
    form.append(row, url, actions)
    return form
  }

  private async fetchLink(
    owner: LinkOwner,
    link: LayerLink,
    imported: boolean,
    stateKey: string | undefined,
  ): Promise<void> {
    if (imported && stateKey) {
      const target = this.state.sourceLinkText ?? (this.state.sourceLinkText = {})
      target[stateKey] = { ...target[stateKey], status: '正在抓取…' }
    } else {
      link.status = '正在抓取…'
    }
    if (owner.custom) this.savePinEditsForMap()
    else this.persist()
    this.renderDetail()
    try {
      const text = await this.loadLinkText(link.url)
      if (!text) throw new Error('没有可读取的正文')
      this.storeLinkText(link, imported, stateKey, text, `已抓取 · ${text.length} 字`, owner)
    } catch (error) {
      this.storeLinkText(
        link,
        imported,
        stateKey,
        '',
        `抓取失败：${errorMessage(error)}。可打开原页后手动粘贴。`,
        owner,
      )
    }
    this.renderDetail()
    if (this.state.selectedMarkerId === owner.id) this.refreshContext()
  }

  private async loadLinkText(url: string): Promise<string> {
    const apiUrl = this.mediaWikiApiUrl(url)
    if (apiUrl) {
      const response = await fetch(apiUrl, { mode: 'cors' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = (await response.json()) as {
        error?: { info?: string }
        parse?: { text?: string }
      }
      if (payload.error) throw new Error(payload.error.info || '页面不存在或无法读取')
      const html = payload.parse?.text
      if (!html) throw new Error('API 没有返回正文')
      return this.htmlText(html)
    }
    const response = await fetch(url, { mode: 'cors' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return this.htmlText(await response.text())
  }

  private mediaWikiApiUrl(raw: string): string | undefined {
    try {
      const url = new URL(raw)
      const host = url.hostname.toLowerCase()
      if (!host.endsWith('.fandom.com') && !host.endsWith('.wikipedia.org')) return undefined
      const match = url.pathname.match(/\/wiki\/(.+)$/)
      if (!match) return undefined
      const title = decodeURIComponent(match[1]).replace(/_/g, ' ')
      const api = new URL(`https://${url.hostname}/api.php`)
      api.searchParams.set('action', 'parse')
      api.searchParams.set('page', title)
      api.searchParams.set('prop', 'text')
      api.searchParams.set('format', 'json')
      api.searchParams.set('formatversion', '2')
      api.searchParams.set('origin', '*')
      return api.toString()
    } catch {
      return undefined
    }
  }

  private htmlText(html: string): string {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    doc
      .querySelectorAll(
        'script, style, nav, footer, header, aside, noscript, .navbox, .toc, .mw-editsection, sup.reference, .reference, .mw-jump-link',
      )
      .forEach((node) => node.remove())
    removeReferenceSections(doc)
    return (
      doc.querySelector('.mw-parser-output, #mw-content-text, article, main, body')
        ?.textContent ?? ''
    )
      .replace(/\s+/g, ' ')
      .trim()
  }

  private markerSourceKey(marker: LayerMarker): string {
    return `layer-source:${this.pkg?.id ?? ''}:${marker.id}`
  }

  private markerSourceValue(marker: LayerMarker): string {
    const global = globalNote(this.markerSourceKey(marker))
    if (global !== undefined) return global
    return marker.description ?? ''
  }


  private savePlaceAIFlagsForMap(): void {
    if (this.pkg) savePlaceAIFlags(this.pkg.id, this.placeAIFlags)
  }

  private placeAIPartAllowed(marker: LayerMarker, part: LayerAIPart): boolean {
    return this.aiFlagAllowed(marker.id, part)
  }

  private aiFlagAllowed(key: string, part: LayerAIPart): boolean {
    return this.placeAIFlags[key]?.[part] !== false
  }

  /** true = always send, false = never send, undefined = follow the automatic rule. */
  private aiFlagState(key: string, part: LayerAIPart): boolean | undefined {
    const value = this.placeAIFlags[key]?.[part]
    return typeof value === 'boolean' ? value : undefined
  }

  /** Sent to AI: ticked explicitly, or left automatic and inside the automatic range. */
  private aiFlagSends(key: string, part: LayerAIPart, inScope: boolean): boolean {
    const state = this.aiFlagState(key, part)
    return state === true || (state === undefined && inScope)
  }

  /** My area chain and the current place's chain: the areas whose notes go to AI automatically. */
  private contextAreaChain(): LayerRegion[] {
    const user = this.state.userPosition
    const marker = this.markerById(this.state.atPlaceId)
    return [
      ...(user ? this.regionChain(this.regionForPoint(user.x, user.y), user.x, user.y) : []),
      ...(marker ? this.regionChain(this.regionForMarker(marker), marker.x, marker.y) : []),
    ]
  }

  /** Region notes share the place AI flag store under a `region:` key. */
  private regionAIKey(region: LayerRegion): string {
    return `region:${region.id}`
  }

  /**
   * Area notes for AI: my area and the areas around it (unless unticked),
   * plus any other area whose note was ticked "给 AI".
   */
  private areaNotesForAI(
    chain: LayerRegion[],
    settings: ReturnType<typeof loadSettings>,
  ): Array<{ name: string; text: string; other?: boolean }> {
    if (!settings.layerRegionNoteAI || !this.pkg) return []
    const result: Array<{ name: string; text: string; other?: boolean }> = []
    const seen = new Set<string>()
    for (const region of chain) {
      if (seen.has(region.id)) continue
      seen.add(region.id)
      if (!this.aiFlagSends(this.regionAIKey(region), 'note', true)) continue
      const text = this.regionNoteValue(region).trim()
      if (text) result.push({ name: region.name, text })
    }
    for (const region of this.pkg.regions) {
      if (seen.has(region.id) || this.aiFlagState(this.regionAIKey(region), 'note') !== true) continue
      seen.add(region.id)
      const text = this.regionNoteValue(region).trim()
      if (text) result.push({ name: region.name, text, other: true })
    }
    return result
  }

  private aiPartGloballyEnabled(part: LayerAIPart): boolean {
    const settings = loadSettings(this.liveContext())
    const nearby = settings.layerNearbyAI
    const favorites = settings.layerFavoritesAI
    if (part === 'source') {
      return (
        settings.layerSourceAI ||
        (nearby && settings.layerNearbySource) ||
        (favorites && settings.layerFavoriteSource) ||
        (settings.layerItineraryPoisShow && settings.layerItineraryPoiSource)
      )
    }
    if (part === 'wiki') {
      return (
        settings.layerWikiAI ||
        (nearby && settings.layerNearbyWiki) ||
        (favorites && settings.layerFavoriteWiki)
      )
    }
    return (
      settings.layerNoteAI ||
      (nearby && settings.layerNearbyNotes) ||
      (favorites && settings.layerFavoriteNote) ||
      (settings.layerItineraryPoisShow && settings.layerItineraryPoiNotes)
    )
  }

  /** `undefined` returns the part to the automatic rule. */
  private setAIFlag(key: string, part: LayerAIPart, value: boolean | undefined): void {
    const flags = { ...(this.placeAIFlags[key] ?? {}) }
    if (value === undefined) delete flags[part]
    else flags[part] = value
    if (Object.keys(flags).length > 0) this.placeAIFlags[key] = flags
    else delete this.placeAIFlags[key]
    this.savePlaceAIFlagsForMap()
    this.refreshContext()
  }

  private aiContentToggle(marker: LayerMarker, part: LayerAIPart): HTMLElement {
    const names: Record<LayerAIPart, string> = {
      source: '来源资料',
      wiki: 'Wiki 正文',
      note: '笔记',
    }
    return this.aiFlagToggle(marker.id, part, names[part], '地点', this.aiPartGloballyEnabled(part)).label
  }

  private regionNoteAIToggle(region: LayerRegion): HTMLElement {
    const settings = loadSettings(this.liveContext())
    const inItinerary = () => this.itineraryNoteRegionIds.has(region.id)
    const { label, sync } = this.aiFlagToggle(
      this.regionAIKey(region),
      'note',
      '区域笔记',
      '区域',
      () => settings.layerRegionNoteAI || inItinerary(),
      () => inItinerary() ||
        (settings.layerRegionNoteAI && this.contextAreaChain().some((item) => item.id === region.id)),
      '区域不在当前位置或行程的范围内',
    )
    this.syncRegionNoteAI = sync
    return label
  }

  /**
   * "给 AI" checkbox. Places only narrow (ticked by default). Areas and roads
   * pass `inScope`: ticked by default only inside the automatic range, and a
   * tick outside it sends the content anyway — what the box shows is what AI gets.
   */
  private aiFlagToggle(
    key: string,
    part: LayerAIPart,
    name: string,
    scope: string,
    globallyEnabled: boolean | (() => boolean),
    inScope?: () => boolean,
    outOfScopeText = '',
  ): { label: HTMLElement; sync: () => void } {
    const label = document.createElement('label')
    label.className = 'tml-ai-toggle'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.setAttribute('aria-label', `${name}是否显示给 AI`)
    const caption = document.createElement('span')
    caption.textContent = '给 AI'
    label.append(checkbox, caption)
    const automatic = (): boolean => (inScope ? inScope() : true)
    const enabled = () => typeof globallyEnabled === 'function' ? globallyEnabled() : globallyEnabled
    const sync = (): void => {
      const isEnabled = enabled()
      const on = isEnabled && this.aiFlagSends(key, part, automatic())
      checkbox.checked = on
      checkbox.disabled = !isEnabled
      label.classList.toggle('is-off', !on)
      label.classList.toggle('is-disabled', !isEnabled)
      label.title = !isEnabled
        ? `没有开启${name}的全局 AI 开关`
        : on
          ? `点击取消这个${scope}的${name}进入 AI`
          : !automatic() && outOfScopeText
            ? `${outOfScopeText}；勾上后也会把${name}发给 AI`
            : `点击让这个${scope}的${name}进入 AI`
    }
    sync()
    checkbox.addEventListener('change', () => {
      if (!enabled()) {
        checkbox.checked = false
        return
      }
      // Matching the automatic rule clears the explicit choice.
      this.setAIFlag(key, part, checkbox.checked === automatic() ? undefined : checkbox.checked)
      sync()
    })
    return { label, sync }
  }

  private sourceSection(marker: LayerMarker): HTMLElement {
    return this.editableSourceSection(
      '地点',
      this.markerSourceKey(marker),
      marker.description ?? '',
      this.aiContentToggle(marker, 'source'),
      () => {
        if (this.aiPartGloballyEnabled('source')) this.refreshContext(false)
        if (this.state.selectedMarkerId === marker.id) this.renderPositionCard()
      },
    )
  }

  private editableSourceSection(
    scope: '地点' | '区域',
    key: string,
    original: string,
    aiToggle?: HTMLElement,
    onEdit?: () => void,
  ): HTMLDetailsElement {
    const details = document.createElement('details')
    details.className = 'tml-source'
    details.open = true
    const summary = document.createElement('summary')
    summary.textContent = `来源资料（随${scope}显示）`
    const textarea = document.createElement('textarea')
    textarea.className = 'tml-source-input'
    textarea.placeholder = '可编辑的来源资料…'
    textarea.setAttribute('aria-label', `${scope}来源资料`)
    textarea.value = globalNote(key) ?? original
    const status = document.createElement('div')
    status.className = 'tml-source-status'
    textarea.addEventListener('input', () => {
      setGlobalNote(key, textarea.value)
      status.textContent = '自动保存 · 与笔记一样全局保存'
      onEdit?.()
    })
    const actions = document.createElement('div')
    actions.className = 'tml-source-actions'
    const restore = document.createElement('button')
    restore.type = 'button'
    restore.className = 'tml-mini'
    restore.textContent = '恢复导入原文'
    restore.addEventListener('click', () => {
      clearGlobalNote(key)
      textarea.value = original
      status.textContent = '已恢复导入原文'
      if (aiToggle) this.refreshContext()
    })
    actions.append(restore)
    details.append(summary)
    if (aiToggle) {
      const aiRow = document.createElement('div')
      aiRow.className = 'tml-ai-toggle-row'
      aiRow.append(aiToggle)
      details.append(aiRow)
    }
    details.append(textarea, status, actions)
    return details
  }


  private linkTextValue(link: LayerLink): string | undefined {
    const global = globalNote(linkTextKey(link.url))
    return global !== undefined ? global : undefined
  }

  private notePrefix(): string {
    return `layer:${this.pkg?.id ?? ''}:`
  }

  private markerNoteKey(marker: LayerMarker): string {
    return `${this.notePrefix()}${marker.id}`
  }

  private regionNoteKey(region: LayerRegion): string {
    return `${this.notePrefix()}region:${region.id}`
  }

  private markerNoteValue(marker: LayerMarker): string {
    const key = this.markerNoteKey(marker)
    const global = globalNote(key)
    if (global !== undefined) return global
    return this.state.notes?.[key] ?? ''
  }

  private regionNoteValue(region: LayerRegion): string {
    const key = this.regionNoteKey(region)
    const global = globalNote(key)
    if (global !== undefined) return global
    return this.state.notes?.[key] ?? ''
  }

  private setNoteValue(key: string, value: string): void {
    setGlobalNote(key, value)
    const notes = this.state.notes ?? (this.state.notes = {})
    if (value.trim()) notes[key] = value
    else delete notes[key]
    this.refreshContext()
    this.persist()
  }

  private setMarkerNote(marker: LayerMarker, value: string): void {
    this.setNoteValue(this.markerNoteKey(marker), value)
  }

  private setRegionNote(region: LayerRegion, value: string): void {
    this.setNoteValue(this.regionNoteKey(region), value)
  }

  private migrateLegacyNotes(pkg: LayerMapPackage): void {
    const notes = this.state.notes ?? (this.state.notes = {})
    let changed = false
    for (const [key, value] of Object.entries(notes)) {
      if (key.startsWith('layer:') || key.startsWith('place:') || key.startsWith('wiki:')) continue
      const target = `layer:${pkg.id}:${key}`
      if (globalNote(target) === undefined) setGlobalNote(target, value)
      delete notes[key]
      changed = true
    }
    const global = globalNotesSnapshot()
    for (const [key, value] of Object.entries(global)) {
      if (key.startsWith(`layer:${pkg.id}:`)) notes[key] = value
    }
    if (changed) {
      void flushGlobalNotes()
      this.persist(true)
    }
  }

  private noteSection(marker: LayerMarker): HTMLElement {
    const section = document.createElement('div')
    section.className = 'tml-note-section'
    const head = document.createElement('div')
    head.className = 'tml-section-head'
    const label = document.createElement('label')
    label.className = 'tml-note-label'
    label.textContent = '我的笔记（不限字数）'
    head.append(label, this.aiContentToggle(marker, 'note'))
    const textarea = document.createElement('textarea')
    textarea.placeholder = '写下地点笔记，不设当前也会保存…'
    textarea.value = this.markerNoteValue(marker)
    textarea.addEventListener('input', () => {
      this.setMarkerNote(marker, textarea.value)
    })
    section.append(head, textarea)
    return section
  }

  private actionButton(
    label: string,
    onClick: () => void,
    active = false,
    extraClass = '',
  ): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `tml-action${active ? ' active' : ''}${extraClass ? ` ${extraClass}` : ''}`
    button.textContent = label
    button.addEventListener('click', onClick)
    return button
  }



  private selectedMarker(): LayerMarker | undefined {
    if (!this.pkg) return undefined
    return this.markerById(this.state.selectedMarkerId)
  }


  private regionsAtPoint(x: number, y: number): Array<{ region: LayerRegion; area: number }> {
    return this.pkg ? regionsAtPoint(this.pkg.regions, x, y) : []
  }

  private regionForPoint(x: number, y: number): LayerRegion | undefined {
    return this.regionsAtPoint(x, y)[0]?.region
  }

  private regionChain(start: LayerRegion | undefined, x: number, y: number): LayerRegion[] {
    return this.pkg ? regionChain(this.pkg.regions, start, x, y) : []
  }

  private regionChainNames(chain: LayerRegion[]): string[] | undefined {
    const names = chain.slice(1).map((region) => region.name).filter(Boolean)
    return names.length > 0 ? names : undefined
  }

  private regionForMarker(marker: LayerMarker): LayerRegion | undefined {
    if (!this.pkg) return undefined
    if (this.markerRegionCache.has(marker.id)) return this.markerRegionCache.get(marker.id)
    let result: LayerRegion | undefined
    if (marker.regionId) {
      const direct = this.pkg.regions.find((region) => region.id === marker.regionId)
      if (direct) {
        this.markerRegionCache.set(marker.id, direct)
        return direct
      }
    }
    result = this.regionForPoint(marker.x, marker.y)
    this.markerRegionCache.set(marker.id, result)
    return result
  }

  private gridConfig(): LayerGridConfig | undefined {
    const grid = this.pkg?.grid
    if (!grid || !Number.isFinite(grid.cellW) || !Number.isFinite(grid.cellH)) return undefined
    if (grid.cellW <= 0 || grid.cellH <= 0) return undefined
    return grid
  }

  private gridPoint(x: number, y: number): { x: number; y: number } | undefined {
    const grid = this.gridConfig()
    if (!grid) return undefined
    return {
      x: (x - grid.originX) / grid.cellW,
      y: (y - grid.originY) / grid.cellH,
    }
  }

  private gridText(x: number, y: number): string | undefined {
    const point = this.gridPoint(x, y)
    if (!point) return undefined
    const format = (value: number): string =>
      Number.isInteger(value) ? String(value) : value.toFixed(1)
    return `X ${format(point.x)}, Y ${format(point.y)}`
  }

  private mapPointText(x: number, y: number): string {
    return `${(x * 100).toFixed(1)}%, ${(y * 100).toFixed(1)}%`
  }

  private pointText(x: number, y: number): string {
    return this.gridText(x, y) ?? this.mapPointText(x, y)
  }

  private directionFor(dx: number, dy: number): string {
    const directions = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE']
    const angle = Math.atan2(dy, dx)
    const index = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8
    return directions[index]
  }

  private nearbyRadiusFraction(): number {
    return Math.min(0.8, Math.max(0.001, this.state.nearbyRadius ?? 0.08))
  }

  /**
   * Nearby radius is stored as a fraction of the map span width. Image maps use
   * 0..1 map coordinates, but tile maps use whole-world WebMercator coordinates,
   * so the fraction must be converted before projecting or drawing it.
   */
  private nearbyRadiusMapUnits(): number {
    return this.nearbyRadiusFraction() * this.mapSpan().w
  }

  /** Roads inside the nearby radius, one entry per road, nearest first, up to the nearby limit. */
  private nearbyRoadHits(anchor: Pt): Array<{ street: LayerStreet; hit: RoadHit }> {
    const index = this.roadIndex()
    if (!index) return []
    const max = loadSettings(this.liveContext()).layerNearbyMax
    const seen = new Set<string>()
    const result: Array<{ street: LayerStreet; hit: RoadHit }> = []
    for (const hit of roadsNearPoint(index, anchor.x, anchor.y, this.nearbyRadiusMapUnits())) {
      const street = index.streets[hit.streetIndex]
      const key = this.roadKey(street)
      if (seen.has(key)) continue
      if (result.length >= max) break
      seen.add(key)
      result.push({ street, hit })
    }
    return result
  }

  /** Roads inside the nearby radius for the nearby list and AI. */
  private buildNearbyRoads(anchor: Pt, settings: Settings): LayerContextRoad[] {
    const index = this.roadIndex()
    if (!index || !settings.layerNearbyAI) return []
    const span = this.mapSpan()
    const grid = this.gridConfig()
    const result: LayerContextRoad[] = []
    for (const { street, hit } of this.nearbyRoadHits(anchor)) {
      const on = hit.distance <= span.w * ON_ROAD_SPAN_FRACTION
      result.push({
        key: this.roadKey(street),
        name: street.name,
        type: settings.layerNearbyType ? street.type || undefined : undefined,
        on,
        distancePercent: (hit.distance / span.w) * 100,
        distanceCells: grid ? gridCellDistance(anchor, hit, grid) : undefined,
        direction:
          on || !settings.layerNearbyDirection
            ? undefined
            : this.directionFor(hit.x - anchor.x, (hit.y - anchor.y) * index.yScale),
      })
    }
    return result
  }

  private buildNearby(
    anchor: { x: number; y: number },
    settings: Settings,
    excludeId?: string,
  ): LayerNearbyPlace[] {
    const pkg = this.pkg
    if (!pkg || !settings.layerNearbyAI || settings.layerNearbyMax <= 0) return []
    const mapWidth = this.mapSpan().w
    const radiusFraction = this.nearbyRadiusFraction()
    // One normalized Y unit covers the image height. Tile coordinates already
    // have equal X and Y scale. Compare distances in units of map width.
    const yScale = pkg.kind === 'image' ? pkg.height / pkg.width : 1
    const grid = this.gridConfig()
    const hidden = new Set(this.state.hiddenCategories ?? [])
    const categories = new Map(
      this.effectiveCategoryList.map((category) => [category.id, category]),
    )
    const nearby: LayerNearbyPlace[] = []
    for (const marker of this.effectiveMarkerList) {
      if (marker.id === excludeId || hidden.has(marker.categoryId)) continue
      const dx = marker.x - anchor.x
      const dy = (marker.y - anchor.y) * yScale
      const distanceFraction = Math.hypot(dx, dy) / mapWidth
      if (distanceFraction > radiusFraction) continue
      nearby.push({
        id: marker.id,
        name: marker.name,
        distanceCells: grid ? gridCellDistance(anchor, marker, grid) : undefined,
        category: settings.layerNearbyType ? categories.get(marker.categoryId)?.name : undefined,
        x: marker.x,
        y: marker.y,
        direction: settings.layerNearbyDirection ? this.directionFor(dx, dy) : '',
        distancePercent: distanceFraction * 100,
        note:
          settings.layerNearbyNotes &&
          this.placeAIPartAllowed(marker, 'note') &&
          this.markerNoteValue(marker).trim()
            ? this.markerNoteValue(marker)
            : undefined,
        sourceMaterial:
          settings.layerNearbySource &&
          this.placeAIPartAllowed(marker, 'source') &&
          this.markerSourceValue(marker).trim()
            ? this.markerSourceValue(marker)
            : undefined,
        wikiTexts:
          settings.layerNearbyWiki && this.placeAIPartAllowed(marker, 'wiki')
            ? this.contextWikiTexts(marker, settings, true)
            : undefined,
      })
    }
    return nearby
      .sort((a, b) => a.distancePercent - b.distancePercent)
      .slice(0, settings.layerNearbyMax)
  }

  private contextWikiTexts(
    marker: LayerMarker,
    settings: Settings,
    includeWiki = settings.layerWikiAI,
  ): Array<{ title: string; text: string }> {
    if (!includeWiki || !this.placeAIPartAllowed(marker, 'wiki')) return []
    const imported = this.markerImportedLinks(marker)
    const userLinks = this.userLinksFor(marker)
    const seen = new Set<string>()
    const result: Array<{ title: string; text: string }> = []
    for (const [link, importedLink] of [
      ...imported.map((link) => [link, true] as const),
      ...userLinks.map((link) => [link, false] as const),
    ]) {
      const key = `${marker.id}:${link.id}`
      const text = this.linkTextValue(link) ??
        (importedLink ? this.state.sourceLinkText?.[key]?.text : link.text)
      const cleanText = (text ?? '').trim()
      if (!cleanText || seen.has(cleanText)) continue
      seen.add(cleanText)
      result.push({ title: link.title, text: cleanText })
    }
    return result
  }

  private favoriteContext(settings: Settings): LayerFavoritePlace[] {
    const pkg = this.pkg
    if (!pkg || !settings.layerFavoritesAI) return []
    const categories = new Map(
      this.effectiveCategoryList.map((category) => [category.id, category]),
    )
    return listFavorites()
      .filter((favorite) => favorite.kind === 'layer' && favorite.mapId === pkg.id)
      .map((favorite) => {
        const marker = favorite.markerId
          ? this.markerById(favorite.markerId)
          : undefined
        const region = marker ? this.regionForMarker(marker)?.name : undefined
        const category = marker
          ? categories.get(marker.categoryId)?.name
          : favorite.category
        return {
          key: favorite.key,
          name: favorite.name,
          category: settings.layerFavoriteType ? category : undefined,
          region: settings.layerFavoriteCoords ? region : undefined,
          x: settings.layerFavoriteCoords ? (marker?.x ?? favorite.x) : undefined,
          y: settings.layerFavoriteCoords ? (marker?.y ?? favorite.y) : undefined,
          note:
            settings.layerFavoriteNote &&
            (!marker || this.placeAIPartAllowed(marker, 'note'))
              ? (marker ? this.markerNoteValue(marker) : favorite.note)?.trim() || undefined
              : undefined,
          sourceMaterial:
            settings.layerFavoriteSource &&
            marker &&
            this.placeAIPartAllowed(marker, 'source')
              ? this.markerSourceValue(marker).trim() || undefined
              : undefined,
          wikiTexts:
            settings.layerFavoriteWiki &&
            marker &&
            this.placeAIPartAllowed(marker, 'wiki')
              ? this.contextWikiTexts(marker, settings, settings.layerFavoriteWiki)
              : undefined,
        }
      })
  }

  private activeItinerary(): LayerItinerary | null {
    return this.itineraryEdit ? this.itineraryDraft : this.itinerary
  }

  private cloneItinerary(route: LayerItinerary): LayerItinerary {
    return {
      ...route,
      stops: route.stops.map((stop) => ({ ...stop })),
    }
  }

  private itineraryStopPoint(stop: LayerItineraryStop): { x: number; y: number } {
    const marker = stop.markerId ? this.markerById(stop.markerId) : undefined
    return marker ? { x: marker.x, y: marker.y } : { x: stop.x, y: stop.y }
  }

  private itineraryStopName(stop: LayerItineraryStop): string {
    const marker = stop.markerId ? this.markerById(stop.markerId) : undefined
    return marker?.name ?? stop.name
  }

  private itineraryYScale(): number {
    const pkg = this.pkg
    return pkg?.kind === 'image' ? pkg.height / pkg.width : 1
  }

  /** Road network of the package for road-following legs, rebuilt only when the roads change. */
  private roadGraph(): { graph: RoadGraph; routes: Map<string, RoadRoutePiece[] | undefined> } | undefined {
    const pkg = this.pkg
    if (!pkg?.streets?.length) return undefined
    const yScale = this.itineraryYScale()
    const cached = this.roadGraphCache
    if (cached && cached.streets === pkg.streets && cached.yScale === yScale) return cached
    this.roadGraphCache = {
      streets: pkg.streets,
      yScale,
      graph: buildRoadGraph(pkg.streets, yScale),
      routes: new Map(),
    }
    return this.roadGraphCache
  }

  /** Stretches of one leg: along roads (merged by road name) or one straight line. */
  private legPieces(from: Pt, to: Pt, snap: boolean): ItineraryPieceView[] {
    const straight: ItineraryPieceView[] = [{ kind: 'straight', points: [from, to] }]
    if (!snap) return straight
    const network = this.roadGraph()
    if (!network) return straight
    const key = `${from.x}:${from.y}:${to.x}:${to.y}`
    if (!network.routes.has(key)) {
      if (network.routes.size > 200) network.routes.clear()
      network.routes.set(key, roadRoute(network.graph, from, to))
    }
    const raw = network.routes.get(key)
    if (!raw) return straight
    const streets = network.graph.index.streets
    const pieces: ItineraryPieceView[] = []
    for (const piece of raw) {
      const street = piece.kind === 'road' ? streets[piece.street] : undefined
      const name = street ? this.roadDisplayName(street) : undefined
      const type = street?.type || undefined
      const key = street ? this.roadKey(street) : undefined
      const last = pieces[pieces.length - 1]
      if (last && last.kind === piece.kind && last.key === key) {
        last.points.push(...piece.points.slice(1))
      } else {
        pieces.push({ kind: piece.kind, key, name, type, points: piece.points.slice() })
      }
    }
    return pieces
  }

  private itineraryLegs(route: LayerItinerary): ItineraryLegView[] {
    const points = route.stops.map((stop) => ({
      stop,
      point: this.itineraryStopPoint(stop),
    }))
    const yScale = this.itineraryYScale()
    const hasRoads = Boolean(this.pkg?.streets?.length)
    const legs: ItineraryLegView[] = []
    for (let index = 1; index < points.length; index += 1) {
      const from = points[index - 1]
      const to = points[index]
      const snap = hasRoads && to.stop.snapRoad === true
      const pieces = this.legPieces(from.point, to.point, snap)
      const line: Pt[] = [pieces[0].points[0]]
      for (const piece of pieces) line.push(...piece.points.slice(1))
      const cumulative = polylineCumulative(line, yScale)
      legs.push({
        fromStop: from.stop,
        toStop: to.stop,
        from: from.point,
        to: to.point,
        points: line,
        cumulative,
        length: cumulative[cumulative.length - 1],
        snap,
        pieces,
      })
    }
    return legs
  }

  private itineraryFormatCellDistance(cells: number, grid: LayerGridConfig): string {
    return formatCellDistance(cells, grid)
  }

  /** Distance in the unit shown to the user: grid cells when calibrated, else % of the map. */
  private itineraryMeasure(from: Pt, to: Pt): number {
    const grid = this.gridConfig()
    if (grid) return Math.hypot((to.x - from.x) / grid.cellW, (to.y - from.y) / grid.cellH)
    // % of the map width, Y in the same unit as X (matches "nearby" and the range).
    const span = this.mapSpan()
    return (pointDistance(from, to, this.itineraryYScale()) / Math.max(1e-8, span.w)) * 100
  }

  private itineraryMeasureLabel(value: number): string {
    const grid = this.gridConfig()
    if (grid) return this.itineraryFormatCellDistance(value, grid)
    return `${value < 0.1 ? value.toFixed(3) : value.toFixed(1)}% 地图`
  }

  private itineraryPathMeasure(points: Pt[]): number {
    let total = 0
    for (let index = 1; index < points.length; index += 1) {
      total += this.itineraryMeasure(points[index - 1], points[index])
    }
    return total
  }

  private itineraryDistanceLabel(from: Pt, to: Pt): string {
    return this.itineraryMeasureLabel(this.itineraryMeasure(from, to))
  }

  private itineraryPathLabel(points: Pt[]): string {
    return this.itineraryMeasureLabel(this.itineraryPathMeasure(points))
  }

  /** Distance along a leg between two lengths along it. */
  private itineraryAlongLabel(leg: ItineraryLegView, from: number, to: number): string {
    return this.itineraryPathLabel(polylineSlice(leg.points, leg.cumulative, from, to))
  }

  private itineraryTotalLabel(route: LayerItinerary, legs = this.itineraryLegs(route)): string {
    return this.itineraryMeasureLabel(
      legs.reduce((total, leg) => total + this.itineraryPathMeasure(leg.points), 0),
    )
  }

  private itineraryProjection(
    route: LayerItinerary,
    point: Pt,
  ):
    | {
        legIndex: number
        t: number
        point: Pt
        distance: number
        along: number
        leg: ItineraryLegView
      }
    | undefined {
    let best:
      | {
          legIndex: number
          t: number
          point: Pt
          distance: number
          along: number
          leg: ItineraryLegView
        }
      | undefined
    const yScale = this.itineraryYScale()
    for (const [legIndex, leg] of this.itineraryLegs(route).entries()) {
      const projected = projectOnPolyline(point, leg.points, leg.cumulative, yScale)
      if (!best || projected.distance < best.distance) {
        best = {
          legIndex,
          t: leg.length > 0 ? projected.along / leg.length : 0,
          point: projected.point,
          distance: projected.distance,
          along: projected.along,
          leg,
        }
      }
    }
    return best
  }

  private itineraryPosition(route: LayerItinerary):
    | {
        onRoute: boolean
        atFinal: boolean
        legIndex?: number
        progress: number
        point: Pt
        /** Length along the current leg. */
        along?: number
        nextStopIndex?: number
      }
    | undefined {
    const legs = this.itineraryLegs(route)
    if (legs.length === 0) return undefined
    const user = this.state.userPosition
    if (!user) {
      return { onRoute: false, atFinal: false, progress: 0, point: legs[0].from, nextStopIndex: 0 }
    }
    const width = this.viewportEl.clientWidth || this.canvasEl.clientWidth || 1
    const height = this.viewportEl.clientHeight || this.canvasEl.clientHeight || 1
    const [ux, uy] = this.project(user.x, user.y, width, height)
    for (const [index, stop] of route.stops.entries()) {
      const point = this.itineraryStopPoint(stop)
      const [sx, sy] = this.project(point.x, point.y, width, height)
      if (Math.hypot(sx - ux, sy - uy) > 22) continue
      if (index === route.stops.length - 1) {
        return {
          onRoute: true,
          atFinal: true,
          progress: 1,
          point,
        }
      }
      return {
        onRoute: true,
        atFinal: false,
        legIndex: index,
        progress: 0,
        point,
        along: 0,
        nextStopIndex: index + 1,
      }
    }
    const projection = this.itineraryProjection(route, user)
    if (!projection) return undefined
    const [px, py] = this.project(projection.point.x, projection.point.y, width, height)
    if (Math.hypot(px - ux, py - uy) > 20) {
      return { onRoute: false, atFinal: false, progress: 0, point: user, nextStopIndex: 0 }
    }
    if (projection.legIndex >= legs.length - 1 && projection.t >= 0.999) {
      return {
        onRoute: true,
        atFinal: true,
        progress: 1,
        point: projection.point,
      }
    }
    return {
      onRoute: true,
      atFinal: false,
      legIndex: projection.legIndex,
      progress: projection.t,
      point: projection.point,
      along: projection.along,
      nextStopIndex:
        projection.legIndex + 1 < route.stops.length ? projection.legIndex + 1 : undefined,
    }
  }

  /** Range around the route, as a fraction of the map width (global setting, live while dragging). */
  private itineraryRange(): number {
    const value = this.itineraryRangeOverride ?? loadSettings(this.liveContext()).layerItineraryPoiRadius
    return Math.min(ITINERARY_RANGE_MAX, Math.max(ITINERARY_RANGE_MIN, value || 0.08))
  }

  /** The range in road-index units (map X units, Y scaled like the roads). */
  private itineraryRangeUnits(): number {
    return this.itineraryRange() * this.mapSpan().w
  }

  /**
   * Legs whose nearby places, roads and areas are shown, following
   * the two global switches. Planning shows every leg.
   */
  private itineraryExtrasLegs(
    route: LayerItinerary,
    legCount: number,
    position = route === this.itineraryDraft ? undefined : this.itineraryPosition(route),
  ): Set<number> {
    const settings = loadSettings(this.liveContext())
    const all = new Set(Array.from({ length: legCount }, (_, index) => index))
    if (!settings.layerItineraryPoisShow) return new Set()
    if (route === this.itineraryDraft || !settings.layerItineraryPoisCurrentOnly) return all
    if (!position || position.atFinal) return new Set()
    return new Set([position.onRoute ? position.legIndex ?? 0 : 0])
  }

  private itineraryPois(
    route: LayerItinerary,
    legs: ItineraryLegView[],
    shownLegs: ReadonlySet<number>,
  ): Map<number, ItineraryPoiView[]> {
    if (shownLegs.size === 0) return new Map()
    const settings = loadSettings(this.liveContext())
    const radius = this.itineraryRange()
    const max = Math.min(30, Math.max(1, settings.layerItineraryPoiMax || 8))
    const hidden = [...(this.state.hiddenCategories ?? [])].sort().join(',')
    const key = [
      legs.map((leg) => `${leg.points.length}:${leg.from.x},${leg.from.y}>${leg.to.x},${leg.to.y}:${leg.snap}`).join('|'),
      route.stops.map((stop) => stop.markerId ?? '').join(','),
      radius,
      max,
      hidden,
      [...shownLegs].join(','),
    ].join('#')
    const cached = this.itineraryPoiCache
    if (cached && cached.key === key && cached.markers === this.effectiveMarkerList) return cached.result
    const result = new Map<number, ItineraryPoiView[]>()
    const hiddenSet = new Set(this.state.hiddenCategories ?? [])
    const span = this.mapSpan()
    const yScale = this.itineraryYScale()
    const units = radius * span.w
    const stopMarkerIds = new Set(
      route.stops.map((stop) => stop.markerId).filter((id): id is string => Boolean(id)),
    )
    const candidates = [...shownLegs].map((legIndex) => {
      const leg = legs[legIndex]
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const point of leg.points) {
        minX = Math.min(minX, point.x)
        maxX = Math.max(maxX, point.x)
        minY = Math.min(minY, point.y)
        maxY = Math.max(maxY, point.y)
      }
      const dy = units / Math.max(1e-8, yScale)
      return { legIndex, leg, minX: minX - units, maxX: maxX + units, minY: minY - dy, maxY: maxY + dy }
    })
    for (const marker of this.effectiveMarkerList) {
      if (hiddenSet.has(marker.categoryId) || stopMarkerIds.has(marker.id)) continue
      let best: { legIndex: number; along: number; offset: number; projected: Pt } | undefined
      for (const { legIndex, leg, minX, maxX, minY, maxY } of candidates) {
        if (marker.x < minX || marker.x > maxX || marker.y < minY || marker.y > maxY) continue
        const projected = projectOnPolyline(marker, leg.points, leg.cumulative, yScale)
        if (!best || projected.distance < best.offset) {
          best = { legIndex, along: projected.along, offset: projected.distance, projected: projected.point }
        }
      }
      if (best && best.offset <= units) {
        const bucket = result.get(best.legIndex) ?? []
        bucket.push({
          marker,
          along: best.along,
          offset: best.offset / Math.max(1e-8, span.w),
          projected: best.projected,
        })
        result.set(best.legIndex, bucket)
      }
    }
    for (const [legIndex, bucket] of result) {
      result.set(
        legIndex,
        bucket.sort((a, b) => a.along - b.along || a.offset - b.offset).slice(0, max),
      )
    }
    this.itineraryPoiCache = { key, markers: this.effectiveMarkerList, result }
    return result
  }

  /**
   * Roads inside the range of each leg that the leg does not travel on, one
   * entry per road name, nearest first.
   */
  private itineraryLegRoads(legs: ItineraryLegView[]): Map<number, Array<{ street: LayerStreet; distance: number }>> {
    const result = new Map<number, Array<{ street: LayerStreet; distance: number }>>()
    const network = this.roadGraph()
    if (!network) return result
    const index = network.graph.index
    const units = this.itineraryRangeUnits()
    const max = Math.min(30, Math.max(1, loadSettings(this.liveContext()).layerItineraryPoiMax || 8))
    for (const [legIndex, leg] of legs.entries()) {
      const used = new Set(
        leg.pieces.filter((piece) => piece.kind === 'road').map((piece) => piece.key),
      )
      const seen = new Set<string>()
      const list: Array<{ street: LayerStreet; distance: number }> = []
      for (const hit of roadsNearPolyline(index, leg.points, units)) {
        const street = index.streets[hit.streetIndex]
        const key = this.roadKey(street)
        if (used.has(key) || seen.has(key)) continue
        seen.add(key)
        list.push({ street, distance: hit.distance })
        if (list.length >= max) break
      }
      if (list.length > 0) result.set(legIndex, list)
    }
    return result
  }

  private itineraryPoiDetails(
    marker: LayerMarker,
    settings: Settings,
    forAI: boolean,
  ): Pick<LayerItineraryContextPoi, 'sourceMaterial' | 'note'> {
    return {
      sourceMaterial: settings.layerItineraryPoiSource && (!forAI || this.placeAIPartAllowed(marker, 'source'))
        ? this.markerSourceValue(marker).trim() || undefined
        : undefined,
      note: settings.layerItineraryPoiNotes && (!forAI || this.placeAIPartAllowed(marker, 'note'))
        ? this.markerNoteValue(marker).trim() || undefined
        : undefined,
    }
  }

  private itineraryLegAreas(legs: ItineraryLegView[]): LayerRegion[][] {
    const pkg = this.pkg
    if (!pkg?.regions.length) return []
    const radius = this.itineraryRangeUnits()
    const yScale = this.itineraryYScale()
    const geometry = legs.map(({ from, to, snap }) => [from.x, from.y, to.x, to.y, snap])
    const key = JSON.stringify([radius, yScale, geometry])
    const cached = this.itineraryAreaCache
    if (cached?.key === key && cached.regions === pkg.regions && cached.streets === pkg.streets) {
      return cached.result
    }
    const result = itineraryRegions(pkg.regions, legs.map((leg) => leg.points), radius, yScale)
    this.itineraryAreaCache = { key, regions: pkg.regions, streets: pkg.streets, result }
    return result
  }

  /** Road touching or crossing the route (same tolerance as "on road"). */
  private roadTouches(distance: number): boolean {
    return distance <= this.mapSpan().w * ON_ROAD_SPAN_FRACTION
  }

  /** Distance label for a length in road-index units (map X units). */
  private roadUnitsLabel(distance: number): string {
    const grid = this.gridConfig()
    if (grid) return this.itineraryFormatCellDistance(distance / grid.cellW, grid)
    const percent = (distance / Math.max(1e-8, this.mapSpan().w)) * 100
    return `${percent < 0.1 ? percent.toFixed(3) : percent.toFixed(1)}% 地图`
  }

  /** The road stretch of a road-following leg at a length along it. */
  private legPieceAt(leg: ItineraryLegView, along: number): ItineraryPieceView | undefined {
    let travelled = 0
    const yScale = this.itineraryYScale()
    for (const piece of leg.pieces) {
      const length = polylineCumulative(piece.points, yScale).pop() ?? 0
      if (along <= travelled + length + 1e-12) return piece
      travelled += length
    }
    return leg.pieces[leg.pieces.length - 1]
  }

  private itineraryContext(route: LayerItinerary, settings: Settings): LayerItineraryContext | undefined {
    if (!route.showToAI || route.stops.length < 2) return undefined
    const legs = this.itineraryLegs(route)
    const position = this.itineraryPosition(route)
    const extras = this.itineraryExtrasLegs(route, legs.length, position)
    const pois = this.itineraryPois(route, legs, extras)
    const legRoads = this.itineraryLegRoads(legs)
    const legAreas = extras.size ? this.itineraryLegAreas(legs) : []
    const names = route.stops.map((stop) => this.itineraryStopName(stop))
    const currentLeg = position?.onRoute && !position.atFinal ? position.legIndex : undefined
    const current =
      currentLeg !== undefined
        ? (() => {
            const leg = legs[currentLeg]
            const along = position?.along ?? 0
            const piece = leg.snap ? this.legPieceAt(leg, along) : undefined
            return {
              legIndex: currentLeg,
              progress: (position?.progress ?? 0) * 100,
              from: this.itineraryStopName(leg.fromStop),
              to: this.itineraryStopName(leg.toStop),
              remaining: this.itineraryAlongLabel(leg, along, leg.length),
              road: piece?.kind === 'road' ? piece.name : undefined,
            }
          })()
        : undefined
    const nextStop =
      position?.atFinal
        ? undefined
        : names[position?.nextStopIndex ?? 0] ?? undefined
    return {
      start: names[0],
      destination: names[names.length - 1],
      total: this.itineraryTotalLabel(route, legs),
      stops: names,
      current,
      nextStop,
      atDestination: position?.atFinal ? true : undefined,
      legs: legs.map((leg, index) => ({
        from: this.itineraryStopName(leg.fromStop),
        to: this.itineraryStopName(leg.toStop),
        distance: this.itineraryPathLabel(leg.points),
        current: currentLeg === index ? true : undefined,
        mode: leg.snap ? ('road' as const) : ('straight' as const),
        route: leg.snap
          ? leg.pieces.map((piece) => ({
              kind: piece.kind,
              name: piece.name,
              type: piece.type,
              distance: this.itineraryPathLabel(piece.points),
            }))
          : undefined,
        roads: extras.has(index)
          ? (legRoads.get(index) ?? []).map((road) => ({
              name: this.roadDisplayName(road.street),
              type: road.street.type || undefined,
              distance: this.roadTouches(road.distance) ? 'touches' : this.roadUnitsLabel(road.distance),
            }))
          : undefined,
        areas: extras.has(index)
          ? legAreas[index]?.map((area) => {
              if (!settings.layerItineraryRegionNotes || this.itineraryNoteRegionIds.has(area.id)) {
                return { name: area.name }
              }
              this.itineraryNoteRegionIds.add(area.id)
              const note = this.aiFlagAllowed(this.regionAIKey(area), 'note')
                ? this.regionNoteValue(area).trim() || undefined
                : undefined
              return { name: area.name, note }
            })
          : undefined,
        pois: extras.has(index)
          ? (pois.get(index) ?? []).map((poi) => ({
              name: poi.marker.name,
              category: this.categoryById(poi.marker.categoryId)?.name,
              along: this.itineraryAlongLabel(leg, 0, poi.along),
              offset: this.itineraryDistanceLabel(poi.marker, poi.projected),
              ...this.itineraryPoiDetails(poi.marker, settings, true),
            }))
          : [],
      })),
    }
  }

  private saveItineraryToState(route: LayerItinerary): void {
    if (!this.pkg) return
    const routes =
      this.state.itinerariesByPackage ?? (this.state.itinerariesByPackage = {})
    routes[this.pkg.id] = this.cloneItinerary(route)
    this.state.updatedAt = Date.now()
    this.persist()
    this.refreshContext()
  }

  private toggleItineraryShelf(): void {
    if (!this.pkg) {
      this.toast('先导入或选择一个地图包')
      return
    }
    if (this.itineraryEdit) {
      this.routeShelfOpen = true
      this.renderItineraryShelf()
      return
    }
    if (!this.itinerary) {
      this.routeShelfOpen = !this.routeShelfOpen
      this.renderItineraryShelf()
      this.syncToolButtons()
      return
    }
    this.routeShelfOpen = !this.routeShelfOpen
    this.renderItineraryShelf()
    this.requestDraw()
    this.syncToolButtons()
  }

  private startItineraryEditing(): void {
    if (!this.pkg) {
      this.toast('先导入或选择一个地图包')
      return
    }
    const now = Date.now()
    this.itineraryDraft = this.itinerary
      ? this.cloneItinerary(this.itinerary)
      : {
          version: 1,
          packageId: this.pkg.id,
          stops: [],
          showToAI: true,
          createdAt: now,
          updatedAt: now,
        }
    this.itineraryDraft.packageId = this.pkg.id
    this.itineraryEdit = true
    this.routeShelfOpen = true
    this.routeExpandedLeg = 0
    this.routeHover = null
    this.cancelPlacements()
    this.renderItineraryShelf()
    this.renderRouteStopHandles()
    this.requestDraw()
    this.syncToolButtons()
    this.toast(
      this.itineraryDraft.stops.length > 0
        ? '编辑行程：完成前不会进入 AI'
        : '点击地图添加第一站',
    )
  }

  private finishItineraryEditing(): void {
    const draft = this.itineraryDraft
    if (!draft) return
    if (draft.stops.length < 2) {
      this.toast('至少需要起点和终点两个站')
      return
    }
    draft.updatedAt = Date.now()
    this.itinerary = this.cloneItinerary(draft)
    this.itineraryEdit = false
    this.itineraryDraft = null
    this.routeShelfOpen = false
    this.routeExpandedLeg = 0
    this.renderItineraryShelf()
    this.renderRouteStopHandles()
    this.saveItineraryToState(this.itinerary)
    this.requestDraw()
    this.syncToolButtons()
    this.toast('行程已完成；AI 已更新')
  }

  private cancelItineraryEditing(): void {
    this.itineraryEdit = false
    this.itineraryDraft = null
    this.routeHover = null
    this.routeShelfOpen = false
    this.renderItineraryShelf()
    this.renderRouteStopHandles()
    this.requestDraw()
    this.syncToolButtons()
  }

  private clearItinerary(): void {
    if (!this.itinerary && !this.itineraryDraft) return
    if (typeof window !== 'undefined' && !window.confirm('清除当前行程？')) return
    if (this.pkg && this.state.itinerariesByPackage) {
      delete this.state.itinerariesByPackage[this.pkg.id]
    }
    this.itinerary = null
    this.itineraryDraft = null
    this.itineraryEdit = false
    this.routeShelfOpen = false
    this.routeHover = null
    this.renderItineraryShelf()
    this.renderRouteStopHandles()
    this.persist()
    this.refreshContext()
    this.requestDraw()
    this.syncToolButtons()
  }

  private addItineraryStop(
    x: number,
    y: number,
    marker?: LayerMarker,
  ): void {
    const draft = this.itineraryDraft
    if (!draft || !this.itineraryEdit) return
    if (marker && draft.stops.some((stop) => stop.markerId === marker.id)) {
      this.toast(`${marker.name} 已经在行程里`)
      return
    }
    const now = Date.now()
    const region = this.regionForPoint(x, y)?.name
    const fallbackName = region
      ? `${region} · 经停点 ${draft.stops.length + 1}`
      : `经停点 ${draft.stops.length + 1}`
    draft.stops.push({
      id: `stop:${now}:${Math.random().toString(36).slice(2, 7)}`,
      markerId: marker?.id,
      name: marker?.name ?? fallbackName,
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y)),
      snapRoad: draft.stops.length > 0 && this.routeSnapNext && this.canSnapRoads() ? true : undefined,
    })
    draft.updatedAt = now
    this.routeExpandedLeg = Math.max(0, draft.stops.length - 2)
    this.routeHover = null
    this.renderItineraryShelf()
    this.renderRouteStopHandles()
    this.requestDraw()
    this.syncToolButtons()
  }

  private removeItineraryStop(stopId: string): void {
    if (!this.itineraryDraft || !this.itineraryEdit) return
    this.itineraryDraft.stops = this.itineraryDraft.stops.filter(
      (stop) => stop.id !== stopId,
    )
    this.itineraryDraft.updatedAt = Date.now()
    this.routeExpandedLeg = Math.min(
      this.routeExpandedLeg,
      Math.max(0, this.itineraryDraft.stops.length - 2),
    )
    this.renderItineraryShelf()
    this.renderRouteStopHandles()
    this.requestDraw()
    this.syncToolButtons()
  }

  private undoLastItineraryStop(): void {
    const draft = this.itineraryDraft
    if (!draft?.stops.length) return
    this.removeItineraryStop(draft.stops[draft.stops.length - 1].id)
  }

  private selectItineraryStop(stop: LayerItineraryStop): void {
    const marker = stop.markerId ? this.markerById(stop.markerId) : undefined
    if (marker) {
      this.selectMarker(marker, true)
      return
    }
    this.centerOnPoint(this.itineraryStopPoint(stop))
  }

  private centerOnPoint(point: { x: number; y: number }): void {
    if (this.pkg?.kind === 'tiles' && this.maplibreMap) {
      this.maplibreMap.easeTo({
        center: this.normalizedToLngLat(point.x, point.y),
        duration: 260,
      })
      return
    }
    this.view.cx = point.x
    this.view.cy = point.y
    this.clampView()
    this.state.view = this.view
    this.persist()
    this.requestDraw()
  }

  private itineraryNextStop(route: LayerItinerary): LayerItineraryStop | undefined {
    const legs = this.itineraryLegs(route)
    if (legs.length === 0) return undefined
    const position = this.itineraryPosition(route)
    if (position?.atFinal) return undefined
    const index = position?.nextStopIndex ?? 0
    return route.stops[index]
  }

  private itineraryNextLabel(route: LayerItinerary): string {
    const position = this.itineraryPosition(route)
    if (position?.atFinal) return '已到终点'
    const next = this.itineraryNextStop(route)
    if (!next) return '已到终点'
    const number = route.stops.findIndex((stop) => stop.id === next.id) + 1
    return position?.onRoute
      ? `前往下一站：${number}`
      : '前往起点：1'
  }

  private goToNextItineraryStop(): void {
    const route = this.itinerary
    if (!route) return
    const next = this.itineraryNextStop(route)
    if (!next) {
      this.toast('已经到终点')
      return
    }
    const point = this.itineraryStopPoint(next)
    const marker = next.markerId ? this.markerById(next.markerId) : undefined
    this.setUserPosition(point.x, point.y, marker?.id, false)
    const nextIndex = route.stops.findIndex((stop) => stop.id === next.id)
    if (nextIndex >= 0) this.routeExpandedLeg = Math.min(nextIndex, Math.max(0, route.stops.length - 2))
    this.centerOnUserPosition()
    this.renderItineraryShelf()
    this.renderRouteStopHandles()
    this.toast(`已到 ${this.itineraryStopName(next)}`)
  }

  private renderItineraryShelf(): void {
    if (!this.routeShelfEl) return
    const route = this.activeItinerary()
    if (!this.pkg || (!route && !this.routeShelfOpen)) {
      this.routeShelfEl.hidden = true
      this.renderRouteStopHandles()
      return
    }
    this.routeShelfEl.hidden = false
    this.routeShelfEl.replaceChildren()
    const legs = route ? this.itineraryLegs(route) : []
    const position = route ? this.itineraryPosition(route) : undefined
    const extras = route
      ? this.itineraryExtrasLegs(route, legs.length, this.itineraryEdit ? undefined : position)
      : new Set<number>()
    const pois = route ? this.itineraryPois(route, legs, extras) : new Map<number, ItineraryPoiView[]>()
    const legRoads = route ? this.itineraryLegRoads(legs) : new Map<number, Array<{ street: LayerStreet; distance: number }>>()
    const settings = loadSettings(this.liveContext())
    const legAreas = extras.size ? this.itineraryLegAreas(legs) : []
    const head = document.createElement('header')
    head.className = 'tml-route-head'
    const titleWrap = document.createElement('div')
    titleWrap.className = 'tml-route-heading'
    const title = document.createElement('strong')
    title.textContent = this.itineraryEdit ? '行程编辑' : '行程'
    const summary = document.createElement('span')
    summary.className = 'tml-route-summary'
    summary.textContent = !route
      ? '还没有行程'
      : this.itineraryEdit
        ? route.stops.length === 0
          ? '点击地图添加第一站'
          : `${route.stops.length} 站 · 点击地图添加下一站`
        : `${route.stops.length} 站 · ${this.itineraryTotalLabel(route, legs)}`
    titleWrap.append(title, summary)
    head.append(titleWrap)
    const actions = document.createElement('div')
    actions.className = 'tml-route-actions'
    if (this.itineraryEdit) {
      const undo = this.routeActionButton('撤销上一站', 'undo-stop')
      undo.disabled = !route?.stops.length
      const finish = this.routeActionButton('完成', 'finish', true)
      finish.disabled = (route?.stops.length ?? 0) < 2
      actions.append(
        undo,
        finish,
        this.routeActionButton('取消', 'cancel'),
      )
    } else if (route) {
      const next = this.routeActionButton(this.itineraryNextLabel(route), 'next', true)
      next.disabled = position?.atFinal === true
      const nextStop = this.itineraryNextStop(route)
      if (nextStop) next.title = this.itineraryStopName(nextStop)
      actions.append(
        next,
        this.routeActionButton('编辑', 'edit'),
        this.routeActionButton('清除', 'clear', false, 'tml-danger-text'),
      )
    } else {
      actions.append(this.routeActionButton('规划行程', 'start', true))
    }
    const shelfToggle = this.routeActionButton(
      this.routeShelfOpen ? '收起' : '展开',
      'toggle',
    )
    shelfToggle.title = this.routeShelfOpen
      ? '收起行程列表，查看地图和拖动站点'
      : '展开行程列表和沿途地点'
    actions.append(shelfToggle)
    head.append(actions)
    this.routeShelfEl.append(head)
    if (route && (this.itineraryEdit || (this.routeShelfOpen && route.stops.length >= 2))) {
      this.routeShelfEl.append(this.itineraryToolsRow())
    }
    if (!this.routeShelfOpen) {
      this.renderRouteStopHandles()
      return
    }
    const body = document.createElement('div')
    body.className = 'tml-route-body'
    if (!route) {
      body.append(
        textElement(
          'div',
          'tml-route-empty',
          '点“规划行程”后，在地图上依次点击起点、经停点和终点；最后一个点就是终点。',
        ),
      )
      if (this.state.userPosition) {
        const startHere = this.routeActionButton(
          '从我的位置开始',
          'start-here',
          true,
        )
        startHere.classList.add('tml-route-start-here')
        body.append(startHere)
      }
      this.routeShelfEl.append(body)
      this.renderRouteStopHandles()
      return
    }
    if (route.stops.length === 0) {
      body.append(
        textElement(
          'div',
          'tml-route-empty',
          '点击地图放第一站。点到地点图钉会用地点名称；点空白地图会生成自由经停点。',
        ),
      )
    } else {
      if (position && !this.itineraryEdit) {
        const state = document.createElement('div')
        state.className = 'tml-route-current'
        if (position.atFinal) {
          state.textContent = '已到终点'
        } else if (!position.onRoute) {
          state.textContent = '尚未在路线上 · 点“前往起点”开始'
        } else {
          const leg = legs[position.legIndex ?? 0]
          const along = position.along ?? 0
          const piece = leg.snap ? this.legPieceAt(leg, along) : undefined
          const onRoad = piece?.kind === 'road' && piece.name ? ` · 在 ${piece.name} 上` : ''
          state.textContent = `当前第 ${(position.legIndex ?? 0) + 1}/${legs.length} 段 · ${Math.round(position.progress * 100)}% · 剩余 ${this.itineraryAlongLabel(leg, along, leg.length)}${onRoad}`
        }
        body.append(state)
      }
      const list = document.createElement('ol')
      list.className = 'tml-route-list'
      for (const [index, stop] of route.stops.entries()) {
        const row = document.createElement('li')
        row.className = `tml-route-stop-row${index === 0 ? ' is-start' : index === route.stops.length - 1 ? ' is-end' : ''}`
        const badge = document.createElement('span')
        badge.className = 'tml-route-badge'
        badge.textContent = String(index + 1)
        const info = document.createElement('div')
        info.className = 'tml-route-stop-info'
        const name = document.createElement('strong')
        name.textContent = this.itineraryStopName(stop)
        const role = document.createElement('small')
        role.textContent =
          index === 0 ? '起点' : index === route.stops.length - 1 ? '终点' : '经停点'
        info.append(name, role)
        const select = document.createElement('button')
        select.type = 'button'
        select.className = 'tml-route-stop-select'
        select.textContent = '›'
        select.setAttribute('aria-label', `查看第 ${index + 1} 站 ${name.textContent}`)
        select.addEventListener('click', () => this.selectItineraryStop(stop))
        row.append(badge, info, select)
        if (this.itineraryEdit) {
          const remove = document.createElement('button')
          remove.type = 'button'
          remove.className = 'tml-route-remove'
          remove.title = '移除这一站'
          remove.setAttribute('aria-label', `移除第 ${index + 1} 站`)
          remove.textContent = '×'
          remove.addEventListener('click', () => this.removeItineraryStop(stop.id))
          row.append(remove)
        }
        list.append(row)
        const leg = legs[index]
        if (!leg) continue
        const shown = extras.has(index)
        const legButton = this.routeActionButton(
          [
            this.itineraryPathLabel(leg.points),
            leg.snap ? '沿路' : '直线',
            shown ? `沿途 ${pois.get(index)?.length ?? 0} 个地点` : '',
            shown && legRoads.get(index)?.length ? `${legRoads.get(index)?.length} 条道路` : '',
            shown && legAreas[index]?.length ? `${legAreas[index].length} 个区域` : '',
          ]
            .filter(Boolean)
            .join(' · '),
          'toggle-leg',
        )
        legButton.classList.add('tml-route-leg')
        if (position?.onRoute && position.legIndex === index) {
          legButton.classList.add('is-current')
          legButton.setAttribute('aria-current', 'step')
        }
        if (this.routeExpandedLeg === index) {
          legButton.classList.add('is-open')
          legButton.setAttribute('aria-expanded', 'true')
        }
        legButton.dataset.legIndex = String(index)
        const legRow = document.createElement('div')
        legRow.className = 'tml-route-leg-row'
        legRow.append(legButton)
        if (this.canSnapRoads()) {
          const snap = this.routeActionButton(leg.snap ? '沿路 ●' : '沿路 ○', 'snap-leg')
          snap.classList.add('tml-route-snap-leg')
          snap.classList.toggle('is-on', leg.snap)
          snap.dataset.legIndex = String(index)
          snap.setAttribute('aria-pressed', String(leg.snap))
          snap.title = leg.snap ? '这一段改成直线' : '这一段改成沿道路走'
          legRow.append(snap)
        }
        list.append(legRow)
        if (this.routeExpandedLeg === index) {
          const poiList = document.createElement('div')
          poiList.className = 'tml-route-pois'
          if (leg.snap) {
            leg.pieces.forEach((piece, pieceIndex) => {
              const line = document.createElement(piece.key ? 'button' : 'div')
              line.className = `tml-route-piece is-${piece.kind}`
              if (line instanceof HTMLButtonElement && piece.key) {
                const key = piece.key
                line.type = 'button'
                line.title = '查看这条路'
                line.addEventListener('click', () => this.selectRoad(key, true))
              }
              const distance = this.itineraryPathLabel(piece.points)
              if (piece.kind === 'straight') {
                line.textContent =
                  pieceIndex === 0
                    ? `┄ 直线 ${distance}，走到路上`
                    : pieceIndex === leg.pieces.length - 1
                      ? `┄ 直线 ${distance}，到${this.itineraryStopName(leg.toStop)}`
                      : `┄ 无路相连，直线 ${distance}`
              } else {
                const previousRoad = leg.pieces
                  .slice(0, pieceIndex)
                  .some((item) => item.kind === 'road')
                line.textContent = `${previousRoad ? '◆ 换到' : '═ 在'} ${piece.name}${piece.type ? `（${piece.type}）` : ''}${previousRoad ? '' : ' 上'} · ${distance}`
              }
              poiList.append(line)
            })
          }
          if (!shown) {
            poiList.append(
              textElement(
                'div',
                'tml-route-poi-empty',
                settings.layerItineraryPoisShow
                  ? '设置为只显示当前所在段的沿途地点、道路和区域。'
                  : '沿途地点、道路和区域已在设置中关闭。',
              ),
            )
          } else {
            for (const road of legRoads.get(index) ?? []) {
              const button = document.createElement('button')
              button.type = 'button'
              button.className = 'tml-route-piece is-near'
              button.title = '查看这条路'
              button.textContent = `━ ${this.roadDisplayName(road.street)}${road.street.type ? `（${road.street.type}）` : ''} · ${this.roadTouches(road.distance) ? '与本段相接' : `距本段 ${this.roadUnitsLabel(road.distance)}`}`
              const key = this.roadKey(road.street)
              button.addEventListener('click', () => this.selectRoad(key, true))
              poiList.append(button)
            }
            const poiSection = document.createElement('section')
            poiSection.className = 'tml-route-section'
            poiSection.setAttribute('aria-label', '沿途兴趣点')
            poiSection.append(textElement('div', 'tml-route-section-title', '沿途兴趣点'))
            poiList.append(poiSection)
            const legPois = pois.get(index) ?? []
            if (legPois.length === 0) {
              poiSection.append(
                textElement('div', 'tml-route-poi-empty', '这段范围内暂无兴趣点。'),
              )
            }
            const showPoiDetails = !settings.layerItineraryPoisCurrentOnly ||
              (!position?.atFinal && (position?.legIndex ?? 0) === index)
            for (const poi of legPois) {
              const poiButton = document.createElement('button')
              poiButton.type = 'button'
              poiButton.className = 'tml-route-poi'
              poiButton.textContent = `${poi.marker.name}${this.categoryById(poi.marker.categoryId) ? ` · ${this.categoryById(poi.marker.categoryId)?.name}` : ''}`
              poiButton.title = `沿程 ${this.itineraryAlongLabel(leg, 0, poi.along)}`
              poiButton.addEventListener('click', () => {
                const marker = this.markerById(poi.marker.id)
                if (marker) this.selectMarker(marker, true)
              })
              poiSection.append(poiButton)
              if (showPoiDetails) {
                const { sourceMaterial, note } = this.itineraryPoiDetails(poi.marker, settings, false)
                if (sourceMaterial) {
                  poiSection.append(textElement('div', 'tml-route-detail', `来源资料 · ${sourceMaterial}`))
                }
                if (note) poiSection.append(textElement('div', 'tml-route-detail', `笔记 · ${note}`))
              }
            }
            const areas = legAreas[index] ?? []
            if (areas.length > 0) {
              const areaSection = document.createElement('section')
              areaSection.className = 'tml-route-section'
              areaSection.setAttribute('aria-label', '经停区域')
              areaSection.append(textElement('div', 'tml-route-section-title', '经停区域'))
              for (const area of areas) {
                const button = document.createElement('button')
                button.type = 'button'
                button.className = 'tml-route-poi'
                button.textContent = area.name
                button.title = '查看区域详情'
                button.addEventListener('click', () => this.selectRegion(area))
                areaSection.append(button)
                const note = settings.layerItineraryRegionNotes && this.regionNoteValue(area).trim()
                if (note) areaSection.append(textElement('div', 'tml-route-detail', note))
              }
              poiList.append(areaSection)
            }
          }
          list.append(poiList)
        }
      }
      body.append(list)
    }
    const footer = document.createElement('div')
    footer.className = 'tml-route-foot'
    const ai = document.createElement('label')
    ai.className = 'tml-route-ai'
    const aiCheckbox = document.createElement('input')
    aiCheckbox.type = 'checkbox'
    aiCheckbox.checked = route.showToAI
    aiCheckbox.dataset.routeAction = 'toggle-ai'
    aiCheckbox.setAttribute('aria-label', '把本次行程发给 AI')
    aiCheckbox.addEventListener('change', () => {
      const next = aiCheckbox.checked
      if (this.itineraryEdit && this.itineraryDraft) {
        this.itineraryDraft.showToAI = next
        this.renderItineraryShelf()
      } else if (this.itinerary) {
        this.itinerary = { ...this.itinerary, showToAI: next }
        this.saveItineraryToState(this.itinerary)
        this.renderItineraryShelf()
      }
    })
    ai.append(aiCheckbox, document.createTextNode('把本次行程发给 AI'))
    const hint = document.createElement('span')
    hint.className = 'tml-route-hint'
    hint.textContent = this.itineraryEdit
      ? '完成前是草稿，不会进入 AI；收起列表后可拖站点'
      : `沿途范围 ±${this.roadUnitsLabel(this.itineraryRangeUnits())} · 每段最多 ${loadSettings(this.liveContext()).layerItineraryPoiMax || 8} 个地点`
    footer.append(ai, hint)
    body.append(footer)
    this.routeShelfEl.append(body)
    this.renderRouteStopHandles()
  }

  /** Planning tools: road-following switch for the next leg and the range slider. */
  private itineraryToolsRow(): HTMLElement {
    const row = document.createElement('div')
    row.className = 'tml-route-tools'
    if (this.itineraryEdit) {
      const snap = this.routeActionButton(
        this.routeSnapNext && this.canSnapRoads() ? '贴合道路 ●' : '贴合道路 ○',
        'snap-next',
      )
      snap.classList.add('tml-route-snap-next')
      snap.classList.toggle('is-on', this.routeSnapNext && this.canSnapRoads())
      snap.setAttribute('aria-pressed', String(this.routeSnapNext && this.canSnapRoads()))
      snap.disabled = !this.canSnapRoads()
      snap.title = !this.canSnapRoads()
        ? '这张地图没有道路数据'
        : this.routeSnapNext
          ? '下一段沿道路走；再点一下改为直线'
          : '下一段按直线；点一下改为沿道路走'
      const caption = document.createElement('span')
      caption.className = 'tml-route-tools-caption'
      caption.textContent = '下一段：'
      row.append(caption, snap)
    }
    const range = document.createElement('label')
    range.className = 'tml-route-range'
    const text = document.createElement('span')
    text.textContent = '沿途范围'
    const input = document.createElement('input')
    input.type = 'range'
    input.min = '0'
    input.max = '1000'
    input.step = '1'
    input.dataset.routeRange = 'slider'
    input.setAttribute('aria-label', '沿途范围')
    input.value = String(this.rangeToSlider(this.itineraryRange()))
    const value = document.createElement('span')
    value.className = 'tml-route-range-value'
    value.textContent = this.itineraryRangeText()
    input.addEventListener('input', () => {
      this.previewItineraryRange(this.sliderToRange(Number(input.value)))
      value.textContent = this.itineraryRangeText()
    })
    input.addEventListener('change', () => this.commitItineraryRange())
    range.append(text, input, value)
    row.append(range)
    return row
  }

  private rangeToSlider(range: number): number {
    return Math.round(
      (Math.log(range / ITINERARY_RANGE_MIN) / Math.log(ITINERARY_RANGE_MAX / ITINERARY_RANGE_MIN)) * 1000,
    )
  }

  private sliderToRange(value: number): number {
    return ITINERARY_RANGE_MIN * (ITINERARY_RANGE_MAX / ITINERARY_RANGE_MIN) ** (value / 1000)
  }

  private itineraryRangeText(): string {
    const range = this.itineraryRange()
    const percent = range * 100
    return `±${this.roadUnitsLabel(this.itineraryRangeUnits())}（${percent < 1 ? percent.toFixed(2) : percent.toFixed(1)}% 地图宽）`
  }

  /** Live range while dragging; the list and AI update when it is committed. */
  private previewItineraryRange(range: number): void {
    this.itineraryRangeOverride = Math.min(ITINERARY_RANGE_MAX, Math.max(ITINERARY_RANGE_MIN, range))
    const label = this.routeShelfEl?.querySelector<HTMLElement>('.tml-route-range-value')
    if (label) label.textContent = this.itineraryRangeText()
    this.positionRouteRangeHandle()
    this.requestDraw()
  }

  /** Save the range to the global setting (shared with the settings page). */
  private commitItineraryRange(): void {
    const range = this.itineraryRangeOverride
    if (range === undefined) return
    const settings = loadSettings(this.ctx)
    settings.layerItineraryPoiRadius = range
    saveSettings(this.ctx, settings)
    this.itineraryRangeOverride = undefined
    this.callbacks.onSettingsChanged?.()
    this.renderItineraryShelf()
    this.refreshContext()
    this.requestDraw()
  }

  private toggleLegSnap(index: number): void {
    const editing = this.itineraryEdit && this.itineraryDraft
    const route = editing ? this.itineraryDraft : this.itinerary
    const stop = route?.stops[index + 1]
    if (!route || !stop || !this.canSnapRoads()) return
    stop.snapRoad = stop.snapRoad ? undefined : true
    route.updatedAt = Date.now()
    if (!editing && this.itinerary) {
      this.itinerary = { ...this.itinerary, stops: this.itinerary.stops.map((item) => ({ ...item })) }
      this.saveItineraryToState(this.itinerary)
    }
    this.renderItineraryShelf()
    this.requestDraw()
  }

  private routeActionButton(
    label: string,
    action: string,
    primary = false,
    extraClass = '',
  ): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `tml-route-action${primary ? ' tml-primary' : ''}${extraClass ? ` ${extraClass}` : ''}`
    button.dataset.routeAction = action
    button.textContent = label
    return button
  }

  private onRouteShelfClick(event: MouseEvent): void {
    const target = event.target as HTMLElement
    const action = target.closest<HTMLElement>('[data-route-action]')?.dataset.routeAction
    if (!action) return
    if (action === 'toggle') {
      this.routeShelfOpen = !this.routeShelfOpen
      this.renderItineraryShelf()
      this.requestDraw()
      return
    }
    if (action === 'start') {
      this.startItineraryEditing()
      return
    }
    if (action === 'start-here') {
      this.startItineraryEditing()
      const user = this.state.userPosition
      if (user) {
        const marker = this.state.atPlaceId
          ? this.markerById(this.state.atPlaceId)
          : undefined
        this.addItineraryStop(user.x, user.y, marker)
      }
      return
    }
    if (action === 'edit') {
      this.startItineraryEditing()
      return
    }
    if (action === 'finish') {
      this.finishItineraryEditing()
      return
    }
    if (action === 'cancel') {
      this.cancelItineraryEditing()
      return
    }
    if (action === 'undo-stop') {
      this.undoLastItineraryStop()
      return
    }
    if (action === 'clear') {
      this.clearItinerary()
      return
    }
    if (action === 'next') {
      this.goToNextItineraryStop()
      return
    }
    if (action === 'snap-next') {
      this.routeSnapNext = !this.routeSnapNext
      this.renderItineraryShelf()
      this.requestDraw()
      return
    }
    if (action === 'snap-leg') {
      const index = Number(target.closest<HTMLElement>('[data-leg-index]')?.dataset.legIndex)
      if (Number.isInteger(index)) this.toggleLegSnap(index)
      return
    }
    if (action === 'toggle-leg') {
      const index = Number(target.closest<HTMLElement>('[data-leg-index]')?.dataset.legIndex)
      if (Number.isInteger(index)) {
        this.routeExpandedLeg = this.routeExpandedLeg === index ? -1 : index
        this.renderItineraryShelf()
        this.requestDraw()
      }
    }
  }

  private renderRouteStopHandles(): void {
    if (!this.routeStopsEl) return
    const route = this.activeItinerary()
    if (!route || !this.pkg) {
      this.routeStopsEl.replaceChildren()
      this.routeStopsEl.hidden = true
      this.routeStopButtons.clear()
      return
    }
    this.routeStopsEl.hidden = false
    this.routeStopsEl.replaceChildren()
    this.routeStopButtons.clear()
    for (const [index, stop] of route.stops.entries()) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `tml-route-stop${index === 0 ? ' is-start' : index === route.stops.length - 1 ? ' is-end' : ''}${this.itineraryEdit ? ' is-editing' : ''}`
      button.dataset.routeStopId = stop.id
      button.textContent = String(index + 1)
      button.title = `${index + 1}. ${this.itineraryStopName(stop)}`
      button.setAttribute('aria-label', `第 ${index + 1} 站：${this.itineraryStopName(stop)}`)
      button.addEventListener('pointerdown', (event) =>
        this.onRouteStopDown(event, stop.id),
      )
      button.addEventListener('pointermove', (event) =>
        this.onRouteStopMove(event),
      )
      button.addEventListener('pointerup', (event) => this.onRouteStopUp(event))
      button.addEventListener('pointercancel', (event) => this.onRouteStopUp(event))
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        if (!this.routeStopDrag) this.selectItineraryStop(stop)
      })
      this.routeStopButtons.set(stop.id, button)
      this.routeStopsEl.append(button)
    }
    const handle = document.createElement('button')
    handle.type = 'button'
    handle.className = 'tml-route-range-handle'
    handle.title = '拖动调整沿途范围（往外变宽，往里变窄）'
    handle.setAttribute('aria-label', '沿途范围拉手')
    handle.addEventListener('pointerdown', (event) => this.onRangeHandleDown(event))
    handle.addEventListener('pointermove', (event) => this.onRangeHandleMove(event))
    handle.addEventListener('pointerup', (event) => this.onRangeHandleUp(event))
    handle.addEventListener('pointercancel', (event) => this.onRangeHandleUp(event))
    handle.addEventListener('click', (event) => event.stopPropagation())
    this.routeRangeHandleEl = handle
    this.routeStopsEl.append(handle)
    this.positionRouteStopHandles()
  }

  /** The leg the range handle sits on: the open leg, else my current leg, else the last leg. */
  private rangeHandleLeg(legs: ItineraryLegView[]): ItineraryLegView | undefined {
    if (legs.length === 0) return undefined
    if (this.routeExpandedLeg >= 0 && legs[this.routeExpandedLeg]) return legs[this.routeExpandedLeg]
    const route = this.activeItinerary()
    const position = route && !this.itineraryEdit ? this.itineraryPosition(route) : undefined
    if (position?.onRoute && position.legIndex !== undefined) return legs[position.legIndex]
    return legs[legs.length - 1]
  }

  private positionRouteRangeHandle(): void {
    const handle = this.routeRangeHandleEl
    if (!handle) return
    const route = this.activeItinerary()
    if (!route || !this.itineraryRangeVisible()) {
      handle.hidden = true
      return
    }
    const width = this.viewportEl.clientWidth || 1
    const height = this.viewportEl.clientHeight || 1
    const leg = this.rangeHandleLeg(this.itineraryLegs(route))
    if (!leg || leg.length <= 0) {
      handle.hidden = true
      return
    }
    const middle = pointAlong(leg.points, leg.cumulative, leg.length / 2)
    const before = pointAlong(leg.points, leg.cumulative, Math.max(0, leg.length / 2 - leg.length * 0.01))
    const after = pointAlong(leg.points, leg.cumulative, Math.min(leg.length, leg.length / 2 + leg.length * 0.01))
    const [mx, my] = this.project(middle.x, middle.y, width, height)
    const [bx, by] = this.project(before.x, before.y, width, height)
    const [ax, ay] = this.project(after.x, after.y, width, height)
    const dx = ax - bx
    const dy = ay - by
    const length = Math.hypot(dx, dy) || 1
    const radius = this.itineraryRangePixels(width, height)
    // Perpendicular to the line; prefer the upper side, which the route list never covers.
    let nx = -dy / length
    let ny = dx / length
    if (ny > 0) {
      nx = -nx
      ny = -ny
    }
    const viewport = this.viewportEl.getBoundingClientRect()
    const shelf = this.routeShelfEl && !this.routeShelfEl.hidden ? this.routeShelfEl.getBoundingClientRect() : undefined
    const usable = (px: number, py: number): boolean => {
      if (px < 10 || py < 10 || px > width - 10 || py > height - 10) return false
      if (!shelf) return true
      const sx = px + viewport.left
      const sy = py + viewport.top
      return !(sx >= shelf.left && sx <= shelf.right && sy >= shelf.top && sy <= shelf.bottom)
    }
    let x = mx + nx * radius
    let y = my + ny * radius
    if (!usable(x, y) && usable(mx - nx * radius, my - ny * radius)) {
      x = mx - nx * radius
      y = my - ny * radius
    }
    handle.style.left = `${x}px`
    handle.style.top = `${y}px`
    handle.hidden = !usable(x, y)
  }

  private onRangeHandleDown(event: PointerEvent): void {
    event.preventDefault()
    event.stopPropagation()
    this.rangeHandleDrag = event.pointerId
    this.routeRangeHandleEl?.classList.add('dragging')
    this.routeRangeHandleEl?.setPointerCapture(event.pointerId)
  }

  private onRangeHandleMove(event: PointerEvent): void {
    if (this.rangeHandleDrag !== event.pointerId) return
    event.preventDefault()
    const route = this.activeItinerary()
    if (!route) return
    const rect = this.viewportEl.getBoundingClientRect()
    const width = this.viewportEl.clientWidth || 1
    const height = this.viewportEl.clientHeight || 1
    const px = event.clientX - rect.left
    const py = event.clientY - rect.top
    let best = Infinity
    for (const leg of this.itineraryLegs(route)) {
      const screen = leg.points.map((point) => this.project(point.x, point.y, width, height))
      for (let index = 1; index < screen.length; index += 1) {
        const [x1, y1] = screen[index - 1]
        const [x2, y2] = screen[index]
        const dx = x2 - x1
        const dy = y2 - y1
        const lengthSquared = dx * dx + dy * dy
        const t = lengthSquared > 0 ? Math.min(1, Math.max(0, ((px - x1) * dx + (py - y1) * dy) / lengthSquared)) : 0
        best = Math.min(best, Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t)))
      }
    }
    if (!Number.isFinite(best)) return
    const [cx, cy] = this.unproject(width / 2, height / 2, width, height)
    const [x1] = this.project(cx, cy, width, height)
    const [x2] = this.project(cx + this.mapSpan().w, cy, width, height)
    const pixelsPerMapWidth = Math.abs(x2 - x1)
    if (!(pixelsPerMapWidth > 0)) return
    this.previewItineraryRange(best / pixelsPerMapWidth)
    const slider = this.routeShelfEl?.querySelector<HTMLInputElement>('[data-route-range="slider"]')
    if (slider) slider.value = String(this.rangeToSlider(this.itineraryRange()))
  }

  private onRangeHandleUp(event: PointerEvent): void {
    if (this.rangeHandleDrag !== event.pointerId) return
    this.rangeHandleDrag = undefined
    this.routeRangeHandleEl?.classList.remove('dragging')
    if (this.routeRangeHandleEl?.hasPointerCapture(event.pointerId)) {
      this.routeRangeHandleEl.releasePointerCapture(event.pointerId)
    }
    this.commitItineraryRange()
  }

  private positionRouteStopHandles(): void {
    this.positionRouteRangeHandle()
    const route = this.activeItinerary()
    if (!route) return
    const width = this.viewportEl.clientWidth || 1
    const height = this.viewportEl.clientHeight || 1
    for (const stop of route.stops) {
      const button = this.routeStopButtons.get(stop.id)
      if (!button) continue
      const point = this.itineraryStopPoint(stop)
      const [x, y] = this.project(point.x, point.y, width, height)
      button.style.left = `${x}px`
      button.style.top = `${y}px`
      button.hidden = x < -32 || y < -32 || x > width + 32 || y > height + 32
    }
  }

  private onRouteStopDown(event: PointerEvent, stopId: string): void {
    const stop = this.itineraryDraft?.stops.find((item) => item.id === stopId)
    if (!stop || !this.itineraryEdit) {
      event.stopPropagation()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const point = this.itineraryStopPoint(stop)
    this.routeStopDrag = {
      stopId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: point.x,
      originY: point.y,
      originMarkerId: stop.markerId,
      moved: false,
    }
    event.currentTarget instanceof HTMLElement &&
      event.currentTarget.setPointerCapture(event.pointerId)
  }

  private onRouteStopMove(event: PointerEvent): void {
    const drag = this.routeStopDrag
    const route = this.itineraryDraft
    if (!drag || !route || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) < 4) return
    event.preventDefault()
    drag.moved = true
    const rect = this.viewportEl.getBoundingClientRect()
    const width = this.viewportEl.clientWidth || 1
    const height = this.viewportEl.clientHeight || 1
    const [x, y] = this.unproject(
      event.clientX - rect.left,
      event.clientY - rect.top,
      width,
      height,
    )
    const stop = route.stops.find((item) => item.id === drag.stopId)
    if (!stop) return
    let nx = Math.min(1, Math.max(0, x))
    let ny = Math.min(1, Math.max(0, y))
    const projection = this.itineraryProjection(route, { x: nx, y: ny })
    if (projection) {
      const [sx, sy] = this.project(nx, ny, width, height)
      const [px, py] = this.project(projection.point.x, projection.point.y, width, height)
      if (Math.hypot(sx - px, sy - py) <= 14) {
        nx = projection.point.x
        ny = projection.point.y
      }
    }
    stop.x = nx
    stop.y = ny
    stop.markerId = undefined
    route.updatedAt = Date.now()
    this.positionRouteStopHandles()
    this.requestDraw()
  }

  private onRouteStopUp(event: PointerEvent): void {
    const drag = this.routeStopDrag
    if (!drag || drag.pointerId !== event.pointerId) return
    this.routeStopDrag = null
    const button = this.routeStopButtons.get(drag.stopId)
    if (button?.hasPointerCapture(event.pointerId)) {
      button.releasePointerCapture(event.pointerId)
    }
    if (event.type === 'pointercancel') {
      const stop = this.itineraryDraft?.stops.find((item) => item.id === drag.stopId)
      if (stop) {
        stop.x = drag.originX
        stop.y = drag.originY
        stop.markerId = drag.originMarkerId
      }
      this.renderItineraryShelf()
      this.requestDraw()
      return
    }
    if (drag.moved) {
      this.renderItineraryShelf()
      this.requestDraw()
    }
  }

  private refreshContext(renderPosition = true): void {
    const pkg = this.pkg
    if (!pkg) {
      this.state.context = undefined
      this.persist()
      this.renderPositionCard()
      this.renderNearby()
      this.callbacks.onChange()
      return
    }
    const settings = loadSettings(this.liveContext())
    const marker = this.markerById(this.state.atPlaceId)
    const region = marker ? this.regionForMarker(marker) : undefined
    const category = marker ? this.categoryById(marker.categoryId) : undefined
    const user = this.state.userPosition
    const positionRegion = user ? this.regionForPoint(user.x, user.y) : undefined
    const positionChain = user ? this.regionChain(positionRegion, user.x, user.y) : []
    const placeChain = marker ? this.regionChain(region, marker.x, marker.y) : []
    const areaNotes = this.areaNotesForAI([...positionChain, ...placeChain], settings)
    const roadNotes = this.roadNotesForAI(settings)
    const road = user ? this.currentRoad() : undefined
    const contextGrid = this.gridConfig()
    const nearby = user ? this.buildNearby(user, settings, this.state.atPlaceId) : []
    const nearbyRoads = user ? this.buildNearbyRoads(user, settings) : []
    this.itineraryNoteRegionIds.clear()
    const itinerary = this.itinerary ? this.itineraryContext(this.itinerary, settings) : undefined
    this.syncRegionNoteAI?.()
    const note =
      settings.layerNoteAI && marker && this.placeAIPartAllowed(marker, 'note')
        ? this.markerNoteValue(marker)
        : undefined
    const favorites = this.favoriteContext(settings)
    const context: LayerContextSnapshot = {
      mapName: pkg.name,
      position: user
        ? {
            x: user.x,
            y: user.y,
            region: positionRegion?.name,
            regionParents: this.regionChainNames(positionChain),
            road: road
              ? {
                  name: road.road.street.name,
                  type: road.road.street.type,
                  on: road.on,
                  distancePercent: (road.road.distance / this.mapSpan().w) * 100,
                  distanceCells: contextGrid
                    ? gridCellDistance(user, road.road, contextGrid)
                    : undefined,
                  direction: road.on
                    ? undefined
                    : this.directionFor(
                        road.road.x - user.x,
                        (road.road.y - user.y) * (pkg.kind === 'image' ? pkg.height / pkg.width : 1),
                      ),
                }
              : undefined,
          }
        : undefined,
      currentPlace: marker?.name,
      currentX: marker?.x,
      currentY: marker?.y,
      category: category?.name,
      region: region?.name,
      regionParents: this.regionChainNames(placeChain),
      areaNotes: areaNotes.length > 0 ? areaNotes : undefined,
      roadNotes: roadNotes.length > 0 ? roadNotes : undefined,
      note: note?.trim() || undefined,
      sourceMaterial:
        marker &&
        settings.layerSourceAI &&
        this.placeAIPartAllowed(marker, 'source')
          ? this.markerSourceValue(marker).trim() || undefined
          : undefined,
      wikiTexts: marker ? this.contextWikiTexts(marker, settings) : undefined,
      favorites: favorites.length > 0 ? favorites : undefined,
      itinerary,
      nearby: nearby.length > 0 ? nearby : undefined,
      nearbyRoads: nearbyRoads.length > 0 ? nearbyRoads : undefined,
      nearbyAnchor: user ? 'my position' : undefined,
      nearbyScope: 'radius',
      nearbyCoords: settings.layerNearbyCoords,
      grid: this.gridConfig() ? { ...this.gridConfig()! } : undefined,
      updatedAt: Date.now(),
    }
    this.state.context = context
    this.persist()
    this.contextStatusEl.textContent =
      context.currentPlace || context.position || context.nearby || context.favorites
        ? '图层上下文：已生成'
        : '图层上下文：待机'
    this.contextStatusEl.title = context.currentPlace
      ? '所在地点会进入图层地图 AI 上下文'
      : '拖动“我”到地点，或调整附近范围后生成'
    if (renderPosition) this.renderPositionCard()
    this.renderNearby()
    if (this.routeShelfEl) this.renderItineraryShelf()
    if (!this.contextModalEl.hidden) {
      this.renderContextControls()
      this.renderContextPreview()
    }
    this.callbacks.onChange()
  }


  private renderPositionCard(): void {
    if (!this.positionContentEl) return
    const pkg = this.pkg
    this.positionCardEl.hidden = !pkg
    const content = this.positionContentEl
    content.replaceChildren()
    if (!pkg) return
    this.syncDistanceInputs(true)
    const user = this.state.userPosition
    const head = document.createElement('div')
    head.className = 'tml-position-head'
    const flag = document.createElement('span')
    flag.className = 'tml-position-flag'
    flag.textContent = '◎'
    const atPlace = this.markerById(this.state.atPlaceId)
    const title = document.createElement('strong')
    title.textContent = '我'
    const value = document.createElement('span')
    value.className = 'tml-position-value'
    value.textContent = user
      ? atPlace
        ? atPlace.name
        : this.pointText(user.x, user.y)
      : '未设置'
    head.append(flag, title, value)
    content.append(head)
    if (user) {
      const area = this.regionChain(this.regionForPoint(user.x, user.y), user.x, user.y)
        .map((item) => item.name)
        .join(' · ')
      if (area) {
        const areaEl = document.createElement('div')
        areaEl.className = 'tml-position-area'
        areaEl.textContent = atPlace ? `我在这里 · 区域：${area}` : `区域：${area}`
        content.append(areaEl)
      }
      const radiusRow = document.createElement('label')
      radiusRow.className = 'tml-position-radius'
      const radiusText = document.createElement('span')
      radiusText.textContent = `附近 ${this.radiusLabel()}`
      const radiusInput = document.createElement('input')
      radiusInput.type = 'range'
      radiusInput.min = pkg.kind === 'tiles' ? '0.001' : '0.01'
      radiusInput.max = '0.4'
      radiusInput.step = pkg.kind === 'tiles' ? '0.001' : '0.005'
      radiusInput.value = String(this.nearbyRadiusFraction())
      radiusInput.setAttribute('aria-label', '附近半径')
      radiusInput.addEventListener('input', () => {
        this.state.nearbyRadius = Number(radiusInput.value)
        radiusText.textContent = `附近 ${this.radiusLabel()}`
        this.refreshContext(false)
        this.requestDraw()
      })
      radiusRow.append(radiusText, radiusInput)
      content.append(radiusRow)
      const actions = document.createElement('div')
      actions.className = 'tml-position-actions'
      actions.append(
        this.actionButton('居中', () => this.centerOnUserPosition()),
        this.actionButton('移动', () => this.startUserPlacement()),
        this.actionButton('清除', () => this.clearUserPosition()),
      )
      content.append(actions)
    } else {
      content.append(
        this.actionButton('在地图上放置', () => this.startUserPlacement(), false, 'tml-position-place'),
      )
    }
  }

  private syncDistanceInputs(preserveTyping = false): void {
    const grid = this.gridConfig()
    this.distanceHintEl.hidden = Boolean(grid)
    this.distanceFieldsEl.hidden = !grid
    if (!grid) return
    if (!preserveTyping || document.activeElement !== this.distanceAmountEl) {
      this.distanceAmountEl.value = String(grid.unitValue)
    }
    if (!preserveTyping || document.activeElement !== this.distanceLabelEl) {
      this.distanceLabelEl.value = grid.unitLabel
    }
  }

  private applyDistanceInputs(renderPosition: boolean): void {
    const grid = this.gridConfig()
    if (!grid) return
    const value = Number(this.distanceAmountEl.value)
    grid.unitValue = Number.isFinite(value) && value > 0 ? value : 1
    grid.unitLabel = this.distanceLabelEl.value.trim() || '格'
    this.scheduleGridSave()
    this.updateStatus()
    this.refreshContext(renderPosition)
  }

  private renderNearby(): void {
    if (!this.nearbyEl) return
    this.nearbyEl.replaceChildren()
    const context = this.state.context
    const places = context?.nearby ?? []
    const roads = context?.nearbyRoads ?? []
    if (places.length === 0 && roads.length === 0) {
      this.nearbyEl.hidden = true
      return
    }
    this.nearbyEl.hidden = false
    const head = document.createElement('div')
    head.className = 'tml-nearby-head'
    const title = document.createElement('strong')
    title.textContent = roads.length > 0 ? `附近 ${places.length} · 道路 ${roads.length}` : `附近 ${places.length}`
    const scope = document.createElement('span')
    scope.textContent = '半径圈内'
    head.append(title, scope)
    this.nearbyEl.append(head)
    const list = document.createElement('div')
    list.className = 'tml-nearby-list'
    const grid = this.gridConfig()
    for (const road of roads) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'tml-nearby-row is-road'
      if (road.key) {
        const key = road.key
        row.addEventListener('click', () => this.selectRoad(key, true))
      }
      const name = document.createElement('span')
      name.className = 'tml-nearby-name'
      name.textContent = `━ ${road.name || (road.type ? `无名道路（${road.type}）` : '无名道路')}`
      const meta = document.createElement('span')
      meta.className = 'tml-nearby-meta'
      const distance = road.on
        ? '就在路上'
        : grid && road.distanceCells != null
          ? formatCellDistance(road.distanceCells, grid)
          : `${road.distancePercent < 0.01 ? '<0.01' : road.distancePercent.toFixed(2)}%`
      meta.textContent = ['道路', road.type, distance, road.direction].filter(Boolean).join(' · ')
      row.append(name, meta)
      list.append(row)
    }
    for (const place of places) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'tml-nearby-row'
      const name = document.createElement('span')
      name.className = 'tml-nearby-name'
      name.textContent = place.name
      const meta = document.createElement('span')
      meta.className = 'tml-nearby-meta'
      const location = grid
        ? this.gridText(place.x, place.y) ?? ''
        : place.distancePercent < 0.01
          ? '<0.01%'
          : `${place.distancePercent.toFixed(2)}%`
      const distance =
        grid && place.distanceCells != null ? formatCellDistance(place.distanceCells, grid) : ''
      meta.textContent = [place.category, distance, place.direction, location]
        .filter(Boolean)
        .join(' · ')
      button.append(name, meta)
      button.addEventListener('click', () => {
        const marker = this.markerById(place.id)
        if (marker) this.selectMarker(marker, true)
      })
      list.append(button)
    }
    this.nearbyEl.append(list)
  }

  private showPlaceBar(text: string): void {
    if (this.placeTextEl) this.placeTextEl.textContent = text
    if (this.placeBarEl) this.placeBarEl.hidden = false
    this.syncToolButtons()
  }

  private hidePlaceBarIfIdle(): void {
    if (this.placingUser || this.placingPin) return
    if (this.placeBarEl) this.placeBarEl.hidden = true
    this.syncToolButtons()
  }

  private startUserPlacement(): void {
    if (!this.pkg) return
    this.cancelPinPlacement()
    this.placingUser = true
    this.showPlaceBar('点击地图放置“我的位置” · Esc 取消')
  }

  private cancelUserPlacement(): void {
    this.placingUser = false
    this.hidePlaceBarIfIdle()
  }

  private startPinPlacement(mode: 'add' | 'move', id?: string): void {
    if (!this.pkg) {
      this.toast('先导入或选择一个地图包')
      return
    }
    this.cancelUserPlacement()
    this.endPinMove(false)
    const marker = mode === 'move' && id ? this.markerById(id) : undefined
    if (mode === 'move' && !marker) return
    this.placingPin = mode
    this.pinMove = marker
      ? { id: marker.id, points: [{ x: marker.x, y: marker.y }], cursor: 0 }
      : null
    this.showPlaceBar(mode === 'add' ? '点击地图放置我的图钉 · Esc 取消' : '挪动图钉到新位置')
    this.syncPlaceBar()
    if (marker) this.renderDetail()
  }

  private cancelPinPlacement(): void {
    this.endPinMove(false)
    this.placingPin = null
    this.hidePlaceBarIfIdle()
    this.syncPlaceBar()
  }

  private cancelPlacements(): void {
    this.endPinMove(false)
    this.placingUser = false
    this.placingPin = null
    if (this.placeBarEl) this.placeBarEl.hidden = true
    this.syncPlaceBar()
    this.syncToolButtons()
  }

  /** Move-pin buttons only while moving a pin; the plain cancel button otherwise. */
  private syncPlaceBar(): void {
    this.syncToolButtons()
    if (!this.placeBarEl) return
    const session = this.pinMove
    for (const button of this.placeBarEl.querySelectorAll<HTMLButtonElement>('[data-pin-move]')) {
      button.hidden = !session
      if (button.dataset.pinMove === 'undo') button.disabled = !session || session.cursor <= 0
      if (button.dataset.pinMove === 'redo') {
        button.disabled = !session || session.cursor >= session.points.length - 1
      }
    }
    const plainCancel = this.placeBarEl.querySelector<HTMLElement>('[data-user-action="cancel"]')
    if (plainCancel) plainCancel.hidden = Boolean(session)
  }

  /** The pin being moved, when (sx, sy) is on it. Other pins stay locked. */
  private hitMovingPin(sx: number, sy: number): LayerMarker | undefined {
    const marker = this.pinMove ? this.markerById(this.pinMove.id) : undefined
    if (!marker) return undefined
    const width = this.canvasEl.clientWidth || 1
    const height = this.canvasEl.clientHeight || 1
    const [x, y] = this.project(marker.x, marker.y, width, height)
    return Math.hypot(x - sx, y - sy) <= MARKER_HIT_RADIUS + 6 ? marker : undefined
  }

  /** Undo (-1) / redo (+1) one drag inside the current move session. */
  private stepPinMove(delta: -1 | 1): void {
    const session = this.pinMove
    if (!session) return
    const cursor = session.cursor + delta
    if (cursor < 0 || cursor >= session.points.length) return
    session.cursor = cursor
    const point = session.points[cursor]
    this.updatePinCoordinate(session.id, point.x, point.y, false)
    this.syncPlaceBar()
    this.renderDetail()
  }

  /**
   * End the move session. Confirm keeps the final position as one move in the
   * pin's history; otherwise the pin goes back to where the session started.
   */
  private endPinMove(confirm: boolean): void {
    const session = this.pinMove
    if (!session) return
    this.pinMove = null
    const drag = this.pinDrag
    if (drag?.id === session.id) {
      this.pinDrag = null
      if (drag.pointerId === -1) {
        this.maplibreMap?.dragPan.enable()
      } else {
        if (this.canvasEl.hasPointerCapture(drag.pointerId)) this.canvasEl.releasePointerCapture(drag.pointerId)
        this.canvasEl.style.cursor = 'grab'
      }
    }
    const origin = session.points[0]
    const final = this.markerById(session.id) ?? session.points[session.cursor]
    const moved = !samePinPosition(origin, final)
    if (confirm) {
      this.placingPin = null
      this.hidePlaceBarIfIdle()
      this.syncPlaceBar()
      if (moved) {
        this.recordPinMove(session.id, origin, final)
        this.savePinEditsForMap()
        this.afterPinMove(session.id, origin, final)
        const marker = this.markerById(session.id)
        if (marker) this.toast(`已移动 ${marker.name}`)
      } else {
        this.renderDetail()
      }
      return
    }
    if (moved) {
      this.updatePinCoordinate(session.id, origin.x, origin.y, false)
      this.savePinEditsForMap()
    }
    this.renderDetail()
    this.syncToolButtons()
  }

  private savePinEditsForMap(): void {
    if (this.pkg) savePinEdits(this.pkg.id, this.pinEdits)
  }

  private pinHistoryFor(id: string): { past: LayerPinPoint[]; future: LayerPinPoint[] } | undefined {
    return this.pinEdits.history[id]
  }

  private updatePinCoordinate(id: string, x: number, y: number, persist = true): LayerPinPoint {
    const nx = Math.min(1, Math.max(0, x))
    const ny = Math.min(1, Math.max(0, y))
    const pinpoint = { x: nx, y: ny }
    const pin = this.customPinRecord(id)
    if (pin) {
      pin.x = nx
      pin.y = ny
      pin.updatedAt = Date.now()
    } else {
      const base = this.pkg?.markers.find((marker) => marker.id === id)
      // In a tile map, a tiny world-coordinate difference can be many pixels.
      if (base && samePinPosition(base, pinpoint)) {
        delete this.pinEdits.overrides[id]
      } else {
        this.pinEdits.overrides[id] = pinpoint
      }
    }
    this.rebuildEffectiveMarkers()
    this.requestDraw()
    if (persist) {
      this.savePinEditsForMap()
      this.syncToolButtons()
    }
    return pinpoint
  }

  private recordPinMove(id: string, before: LayerPinPoint, after: LayerPinPoint): void {
    if (samePinPosition(before, after)) return
    const history = this.pinEdits.history[id] ?? (this.pinEdits.history[id] = {
      past: [],
      future: [],
    })
    history.past.push({ x: before.x, y: before.y })
    while (history.past.length > MAX_PIN_HISTORY) history.past.shift()
    history.future = []
  }

  private afterPinMove(id: string, before: LayerPinPoint, after: LayerPinPoint): void {
    if (samePinPosition(before, after)) return
    const marker = this.markerById(id)
    if (!marker) return
    if (this.state.atPlaceId === id) {
      this.state.userPosition = { x: after.x, y: after.y }
      this.persist()
    }
    const favorite = this.markerFavorite(marker)
    if (favorite) {
      setFavorite({ ...favorite, x: after.x, y: after.y, name: marker.name })
    }
    this.refreshContext()
    this.renderDetail()
    this.renderFavorites()
    this.requestDraw()
    this.syncToolButtons()
  }

  private movePinTo(id: string, x: number, y: number): void {
    const marker = this.markerById(id)
    if (!marker) return
    const before = { x: marker.x, y: marker.y }
    const after = this.updatePinCoordinate(id, x, y, false)
    this.recordPinMove(id, before, after)
    this.savePinEditsForMap()
    this.afterPinMove(id, before, after)
    this.toast(`已移动 ${marker.name}`)
  }

  private undoPin(id: string): void {
    if (this.pinMove?.id === id) {
      this.stepPinMove(-1)
      return
    }
    const history = this.pinHistoryFor(id)
    const marker = this.markerById(id)
    if (!history?.past.length || !marker) return
    const target = history.past.pop()!
    history.future.push({ x: marker.x, y: marker.y })
    while (history.future.length > MAX_PIN_HISTORY) history.future.shift()
    this.updatePinCoordinate(id, target.x, target.y, false)
    this.savePinEditsForMap()
    this.afterPinMove(id, { x: marker.x, y: marker.y }, target)
    this.toast(`已撤销 ${marker.name} 的移动`)
  }

  private redoPin(id: string): void {
    if (this.pinMove?.id === id) {
      this.stepPinMove(1)
      return
    }
    const history = this.pinHistoryFor(id)
    const marker = this.markerById(id)
    if (!history?.future.length || !marker) return
    const target = history.future.pop()!
    history.past.push({ x: marker.x, y: marker.y })
    while (history.past.length > MAX_PIN_HISTORY) history.past.shift()
    this.updatePinCoordinate(id, target.x, target.y, false)
    this.savePinEditsForMap()
    this.afterPinMove(id, { x: marker.x, y: marker.y }, target)
    this.toast(`已重做 ${marker.name} 的移动`)
  }

  private finishPinDrag(event: PointerEvent): void {
    if (this.canvasEl.hasPointerCapture(event.pointerId)) {
      this.canvasEl.releasePointerCapture(event.pointerId)
    }
    this.canvasEl.style.cursor = 'grab'
    this.commitPinDrag(event.type === 'pointercancel')
  }

  private commitPinDrag(cancelled: boolean): void {
    const drag = this.pinDrag
    if (!drag) return
    this.pinDrag = null
    if (cancelled || !drag.moved) {
      this.updatePinCoordinate(drag.id, drag.originX, drag.originY, false)
      return
    }
    const session = this.pinMove
    if (session?.id === drag.id) {
      const marker = this.markerById(drag.id)
      if (!marker) return
      session.points = session.points.slice(0, session.cursor + 1)
      session.points.push({ x: marker.x, y: marker.y })
      session.cursor = session.points.length - 1
      this.syncPlaceBar()
      this.renderDetail()
      return
    }
    const marker = this.markerById(drag.id)
    const after = marker ? { x: marker.x, y: marker.y } : { x: drag.originX, y: drag.originY }
    this.recordPinMove(drag.id, { x: drag.originX, y: drag.originY }, after)
    this.savePinEditsForMap()
    this.afterPinMove(drag.id, { x: drag.originX, y: drag.originY }, after)
  }

  private createCustomPin(x: number, y: number): void {
    if (!this.pkg) return
    const now = Date.now()
    const pin: LayerCustomPin = {
      id: `custom:${now}:${Math.random().toString(36).slice(2, 7)}`,
      name: `我的图钉 ${this.pinEdits.customPins.length + 1}`,
      categoryId: CUSTOM_PIN_CATEGORY_ID,
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y)),
      custom: true,
      links: [],
      createdAt: now,
      updatedAt: now,
    }
    this.pinEdits.customPins.push(pin)
    this.state.hiddenCategories = (this.state.hiddenCategories ?? []).filter(
      (id) => id !== CUSTOM_PIN_CATEGORY_ID,
    )
    this.rebuildEffectiveMarkers()
    this.savePinEditsForMap()
    this.selectMarker(pin, true)
    this.renderCategories()
    this.updateStatus()
    this.updatePackageInfo()
    this.toast('已添加我的图钉；可以在详情里改名、加链接和写笔记')
  }

  private customPinNameSection(marker: LayerMarker, title: HTMLElement): HTMLElement {
    const section = document.createElement('div')
    section.className = 'tml-custom-name'
    const label = document.createElement('label')
    label.textContent = '图钉名称'
    const input = document.createElement('input')
    input.type = 'text'
    input.value = marker.name
    input.placeholder = '我的图钉'
    input.addEventListener('input', () => {
      const pin = this.customPinRecord(marker.id)
      if (!pin) return
      pin.name = input.value.trim() || '我的图钉'
      pin.updatedAt = Date.now()
      title.textContent = pin.name
      this.savePinEditsForMap()
      this.rebuildEffectiveMarkers()
      this.renderItineraryShelf()
      this.refreshContext()
      this.requestDraw()
    })
    label.append(input)
    section.append(label)
    return section
  }

  private deleteCustomPin(id: string): void {
    const marker = this.markerById(id)
    if (!marker?.custom || typeof window === 'undefined') return
    if (!window.confirm(`删除“${marker.name}”这个图钉？它的笔记和链接也会删除。`)) return
    const key = this.markerNoteKey(marker)
    const sourceKey = this.markerSourceKey(marker)
    clearGlobalNote(key)
    clearGlobalNote(sourceKey)
    delete this.state.notes?.[key]
    for (const route of [this.itinerary, this.itineraryDraft]) {
      if (!route) continue
      for (const stop of route.stops) {
        if (stop.markerId !== id) continue
        stop.x = marker.x
        stop.y = marker.y
        stop.name = marker.name
        stop.markerId = undefined
      }
    }
    if (this.itinerary) this.saveItineraryToState(this.itinerary)
    this.pinEdits.customPins = this.pinEdits.customPins.filter((pin) => pin.id !== id)
    delete this.pinEdits.history[id]
    if (this.placeAIFlags[id]) {
      delete this.placeAIFlags[id]
      this.savePlaceAIFlagsForMap()
    }
    this.state.selectedMarkerId = undefined
    if (this.state.atPlaceId === id) this.state.atPlaceId = undefined
    removeFavorite(this.markerFavoriteKey(marker))
    this.rebuildEffectiveMarkers()
    this.savePinEditsForMap()
    this.refreshContext()
    this.renderCategories()
    this.renderFavorites()
    this.renderDetail()
    this.updateStatus()
    this.updatePackageInfo()
    this.persist()
    this.requestDraw()
    this.syncToolButtons()
    this.toast(`已删除 ${marker.name}`)
  }

  private resetPinPosition(id: string): void {
    const marker = this.markerById(id)
    const base = this.pkg?.markers.find((item) => item.id === id)
    if (!marker || !base || marker.custom) return
    if (this.pinMove?.id === id) this.cancelPlacements()
    this.movePinTo(id, base.x, base.y)
  }

  private nearestMarkerAt(x: number, y: number): LayerMarker | undefined {
    const pkg = this.pkg
    if (!pkg) return undefined
    const width = this.viewportEl.clientWidth || 1
    const height = this.viewportEl.clientHeight || 1
    const [sx, sy] = this.project(x, y, width, height)
    let best: LayerMarker | undefined
    let bestDistance = 18
    for (const marker of this.effectiveMarkerList) {
      const [mx, my] = this.project(marker.x, marker.y, width, height)
      const distance = Math.hypot(mx - sx, my - sy)
      if (distance < bestDistance) {
        best = marker
        bestDistance = distance
      }
    }
    return best
  }

  private setUserPosition(
    x: number,
    y: number,
    placeId?: string,
    allowSnap = true,
  ): void {
    const nx = Math.min(1, Math.max(0, x))
    const ny = Math.min(1, Math.max(0, y))
    const marker = placeId
      ? this.markerById(placeId)
      : allowSnap
        ? this.nearestMarkerAt(nx, ny)
        : undefined
    this.state.userPosition = { x: nx, y: ny }
    this.state.atPlaceId = marker?.id
    this.cancelUserPlacement()
    this.refreshContext()
    this.persist()
    this.requestDraw()
    if (marker) this.toast(`我在 ${marker.name}`)
  }

  private updateUserStamp(): void {
    const user = this.state.userPosition
    if (!user || !this.pkg) {
      this.userStampEl.hidden = true
      return
    }
    this.userStampEl.title =
      this.itinerary && !this.itineraryEdit ? '沿行程路线拖动我' : '拖动我'
    const width = this.viewportEl.clientWidth || 1
    const height = this.viewportEl.clientHeight || 1
    const [x, y] = this.project(user.x, user.y, width, height)
    if (x < -30 || y < -30 || x > width + 30 || y > height + 30) {
      this.userStampEl.hidden = true
      return
    }
    this.userStampEl.hidden = false
    this.userStampEl.style.left = `${x}px`
    this.userStampEl.style.top = `${y}px`
  }

  private drawUserRadius(context: CanvasRenderingContext2D, width: number, height: number): void {
    const user = this.state.userPosition
    if (!user) return
    const radius = this.nearbyRadiusMapUnits()
    const [cx, cy] = this.project(user.x, user.y, width, height)
    const [rx, ry] = this.project(user.x + radius, user.y, width, height)
    const radiusPx = Math.hypot(rx - cx, ry - cy)
    if (!Number.isFinite(radiusPx) || radiusPx <= 0) return
    context.save()
    context.beginPath()
    context.arc(cx, cy, radiusPx, 0, Math.PI * 2)
    context.fillStyle = 'rgba(217, 83, 79, 0.10)'
    context.fill()
    context.setLineDash([7, 5])
    context.lineWidth = 1.6
    context.strokeStyle = 'rgba(230, 91, 84, 0.95)'
    context.stroke()
    context.restore()
  }

  private onUserStampDown = (event: PointerEvent): void => {
    const user = this.state.userPosition
    if (!user) return
    event.preventDefault()
    event.stopPropagation()
    this.userDrag = {
      startX: event.clientX,
      startY: event.clientY,
      originX: user.x,
      originY: user.y,
      snapRoute: Boolean(this.itinerary && !this.itineraryEdit),
    }
    this.userStampEl.classList.add('dragging')
    this.userStampEl.classList.toggle('is-route-snap', this.userDrag.snapRoute)
    this.userStampEl.setPointerCapture(event.pointerId)
  }

  private onUserStampMove = (event: PointerEvent): void => {
    if (!this.userDrag) return
    event.preventDefault()
    const rect = this.viewportEl.getBoundingClientRect()
    const width = this.viewportEl.clientWidth || 1
    const height = this.viewportEl.clientHeight || 1
    const start = this.unproject(
      this.userDrag.startX - rect.left,
      this.userDrag.startY - rect.top,
      width,
      height,
    )
    const current = this.unproject(event.clientX - rect.left, event.clientY - rect.top, width, height)
    let nextX = Math.min(1, Math.max(0, this.userDrag.originX + current[0] - start[0]))
    let nextY = Math.min(1, Math.max(0, this.userDrag.originY + current[1] - start[1]))
    if (this.userDrag.snapRoute && this.itinerary) {
      const projection = this.itineraryProjection(this.itinerary, { x: nextX, y: nextY })
      if (projection) {
        nextX = projection.point.x
        nextY = projection.point.y
      }
    }
    this.state.userPosition = { x: nextX, y: nextY }
    this.state.atPlaceId = undefined
    this.updateUserStamp()
    this.requestDraw()
  }

  private onUserStampUp = (event: PointerEvent): void => {
    if (!this.userDrag) return
    const wasRouteSnap = this.userDrag.snapRoute
    this.userDrag = null
    this.userStampEl.classList.remove('dragging')
    this.userStampEl.classList.remove('is-route-snap')
    if (this.userStampEl.hasPointerCapture(event.pointerId)) {
      this.userStampEl.releasePointerCapture(event.pointerId)
    }
    const user = this.state.userPosition
    if (user) {
      const marker = event.altKey ? undefined : this.nearestMarkerAt(user.x, user.y)
      this.state.atPlaceId = marker?.id
      if (marker) this.toast(`我在 ${marker.name}`)
    }
    if (wasRouteSnap) this.renderItineraryShelf()
    this.refreshContext()
    this.persist()
    this.requestDraw()
  }

  private radiusLabel(): string {
    const fraction = this.nearbyRadiusFraction()
    const radius = this.nearbyRadiusMapUnits()
    const grid = this.gridConfig()
    if (grid) {
      return formatCellDistance(radius / grid.cellW, grid)
    }
    return `${(fraction * 100).toFixed(1)}% 地图宽`
  }

  private clearUserPosition(): void {
    this.state.userPosition = undefined
    this.cancelUserPlacement()
    this.refreshContext()
    this.persist()
    this.requestDraw()
  }

  private centerOnUserPosition(): void {
    const user = this.state.userPosition
    if (!user) return
    if (this.pkg?.kind === 'tiles' && this.maplibreMap) {
      this.maplibreMap.easeTo({
        center: this.normalizedToLngLat(user.x, user.y),
        duration: 320,
      })
      return
    }
    this.view.cx = user.x
    this.view.cy = user.y
    this.clampView()
    this.state.view = this.view
    this.persist()
    this.requestDraw()
  }

  private rememberUserPosition(): void {
    const pkgId = this.state.packageId
    if (!pkgId) return
    if (this.view) {
      const views = this.state.viewsByPackage ?? (this.state.viewsByPackage = {})
      views[pkgId] = { cx: this.view.cx, cy: this.view.cy, zoom: this.view.zoom }
      saveStoredLayerView(this.ctx, pkgId, this.view)
    }
    const positions = this.state.positionsByPackage ?? (this.state.positionsByPackage = {})
    const user = this.state.userPosition
    if (!user) {
      delete positions[pkgId]
      saveStoredLayerPosition(this.ctx, pkgId)
      return
    }
    const position: LayerUserPosition = {
      x: user.x,
      y: user.y,
      atPlaceId: this.state.atPlaceId,
      nearbyRadius: this.state.nearbyRadius,
    }
    positions[pkgId] = position
    saveStoredLayerPosition(this.ctx, pkgId, position)
  }

  private restoreUserPosition(pkgId: string): void {
    const savedView = this.state.viewsByPackage?.[pkgId] ?? storedLayerView(this.ctx, pkgId)
    if (savedView) {
      this.state.viewsByPackage ??= {}
      this.state.viewsByPackage[pkgId] = savedView
      this.state.view = savedView
      this.view = { cx: savedView.cx, cy: savedView.cy, zoom: savedView.zoom }
    }
    const saved = this.state.positionsByPackage?.[pkgId] ?? storedLayerPosition(this.ctx, pkgId)
    if (!saved) {
      this.state.userPosition = undefined
      this.state.atPlaceId = undefined
      saveStoredLayerPosition(this.ctx, pkgId)
      return
    }
    this.state.positionsByPackage ??= {}
    this.state.positionsByPackage[pkgId] = saved
    this.state.userPosition = { x: saved.x, y: saved.y }
    this.state.atPlaceId = saved.atPlaceId
    if (saved.nearbyRadius != null) this.state.nearbyRadius = saved.nearbyRadius
  }

  private persist(immediate = false): void {
    this.rememberUserPosition()
    if (this.saveTimer !== undefined) window.clearTimeout(this.saveTimer)
    this.state.view = this.view
    if (immediate) {
      this.saveNow()
      return
    }
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = undefined
      this.saveNow()
    }, 250)
  }

  private saveNow(): void {
    this.state.view = this.view
    this.rememberUserPosition()
    saveLayerState(this.ctx, this.state)
  }

  private onSearchInput(): void {
    const query = this.searchEl.value.trim().toLowerCase()
    if (!query) {
      this.hideSearch()
      return
    }
    const pkg = this.pkg
    if (!pkg) return
    const hidden = new Set(this.state.hiddenCategories ?? [])
    const categoryById = new Map(
      this.effectiveCategoryList.map((category) => [category.id, category]),
    )
    const matches = this.effectiveMarkerList
      .filter((marker) => {
        const category = categoryById.get(marker.categoryId)?.name ?? ''
        const region = this.regionForMarker(marker)?.name ?? ''
        const note = this.markerNoteValue(marker)
        return (
          marker.name.toLowerCase().includes(query) ||
          category.toLowerCase().includes(query) ||
          region.toLowerCase().includes(query) ||
          note.toLowerCase().includes(query)
        )
      })
    this.searchResultsEl.replaceChildren()
    const fragment = document.createDocumentFragment()
    if (matches.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'tml-search-empty'
      empty.textContent = '没有匹配的地点'
      this.searchResultsEl.append(empty)
    } else {
      for (const marker of matches) {
        const category = categoryById.get(marker.categoryId)
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'tml-search-result'
        const name = document.createElement('span')
        name.className = 'tml-search-name'
        name.textContent = marker.name
        const meta = document.createElement('span')
        meta.className = 'tml-search-meta'
        meta.textContent = [
          category?.name,
          this.regionForMarker(marker)?.name,
          hidden.has(marker.categoryId) ? '被图层隐藏' : '',
        ]
          .filter(Boolean)
          .join(' · ')
        button.append(name, meta)
        button.addEventListener('click', () => {
          this.hideSearch()
          this.searchEl.value = marker.name
          this.selectMarker(marker, true)
          if (hidden.has(marker.categoryId)) {
            this.state.hiddenCategories = this.state.hiddenCategories?.filter(
              (id) => id !== marker.categoryId,
            )
            this.renderCategories()
            this.requestDraw()
          }
        })
        fragment.append(button)
      }
    }
    this.searchResultsEl.append(fragment)
    this.searchResultsEl.hidden = false
  }

  private onSearchKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation()
      this.hideSearch()
      this.searchEl.blur()
    }
    if (event.key === 'Enter') {
      const first = this.searchResultsEl.querySelector<HTMLButtonElement>('.tml-search-result')
      first?.click()
    }
  }

  private hideSearch(): void {
    this.searchResultsEl.hidden = true
    this.searchResultsEl.replaceChildren()
  }

  private mapSpan(pkg = this.pkg): { x: number; y: number; w: number; h: number } {
    if (pkg?.kind === 'tiles') {
      const bounds = this.tileBoundsNormalized(pkg)
      if (bounds) {
        return {
          x: bounds.minX,
          y: bounds.minY,
          w: Math.max(1e-8, bounds.maxX - bounds.minX),
          h: Math.max(1e-8, bounds.maxY - bounds.minY),
        }
      }
    }
    return { x: 0, y: 0, w: 1, h: 1 }
  }

  private positionGridHandle(
    element: HTMLElement,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    const visible = x > -24 && y > -24 && x < width + 24 && y < height + 24
    element.hidden = !visible
    if (!visible) return
    element.style.left = `${Math.min(width - 14, Math.max(14, x))}px`
    element.style.top = `${Math.min(height - 14, Math.max(14, y))}px`
  }

  private updateGridHandles(): void {
    if (!this.gridPanelOpen || !this.pkg?.grid) {
      this.gridOriginHandleEl.hidden = true
      this.gridScaleHandleEl.hidden = true
      return
    }
    const grid = this.pkg.grid
    const width = this.viewportEl.clientWidth || 1
    const height = this.viewportEl.clientHeight || 1
    const [ox, oy] = this.project(grid.originX, grid.originY, width, height)
    const [sx, sy] = this.project(
      grid.originX + grid.cellW * 3,
      grid.originY + grid.cellH * 3,
      width,
      height,
    )
    this.positionGridHandle(this.gridOriginHandleEl, ox, oy, width, height)
    this.positionGridHandle(this.gridScaleHandleEl, sx, sy, width, height)
  }

  private scaleGrid(factor: number): void {
    const grid = this.pkg?.grid
    if (!grid) return
    const span = this.mapSpan()
    grid.cellW = Math.min(
      span.w * 2,
      Math.max(span.w * 0.0001, grid.cellW * factor),
    )
    grid.cellH =
      this.pkg?.kind === 'image' && this.pkg.width > 0 && this.pkg.height > 0
        ? grid.cellW * (this.pkg.width / this.pkg.height)
        : grid.cellW
    this.syncGridInputs()
    this.refreshContext()
    this.requestDraw()
    this.scheduleGridSave()
  }

  private onGridWheel = (event: WheelEvent): void => {
    if (!this.gridPanelOpen || !event.altKey) return
    if ((event.target as HTMLElement)?.closest?.('#tml-grid-panel')) return
    event.preventDefault()
    event.stopPropagation()
    this.scaleGrid(Math.exp(-event.deltaY * 0.0015))
  }

  private onGridHandleDown = (event: PointerEvent): void => {
    const grid = this.pkg?.grid
    if (!grid || !this.gridPanelOpen) return
    const element = event.currentTarget as HTMLElement
    const mode = element.id === 'tml-grid-scale' ? 'scale' : 'origin'
    const rect = this.viewportEl.getBoundingClientRect()
    const width = this.viewportEl.clientWidth || 1
    const height = this.viewportEl.clientHeight || 1
    const [nx, ny] = this.unproject(event.clientX - rect.left, event.clientY - rect.top, width, height)
    event.preventDefault()
    event.stopPropagation()
    this.gridHandleDrag = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      startNormX: nx,
      startNormY: ny,
      originX: grid.originX,
      originY: grid.originY,
      cellW: grid.cellW,
      cellH: grid.cellH,
    }
    element.setPointerCapture(event.pointerId)
    element.classList.add('dragging')
  }

  private onGridHandleMove = (event: PointerEvent): void => {
    const drag = this.gridHandleDrag
    const grid = this.pkg?.grid
    if (!drag || !grid) return
    event.preventDefault()
    const rect = this.viewportEl.getBoundingClientRect()
    const width = this.viewportEl.clientWidth || 1
    const height = this.viewportEl.clientHeight || 1
    const [nx, ny] = this.unproject(event.clientX - rect.left, event.clientY - rect.top, width, height)
    if (drag.mode === 'origin') {
      grid.originX = Math.min(2, Math.max(-1, drag.originX + nx - drag.startNormX))
      grid.originY = Math.min(2, Math.max(-1, drag.originY + ny - drag.startNormY))
    } else {
      const startDistance = Math.hypot(
        drag.startNormX - drag.originX,
        drag.startNormY - drag.originY,
      )
      const distance = Math.hypot(nx - drag.originX, ny - drag.originY)
      if (startDistance > 1e-9) {
        const factor = Math.min(20, Math.max(0.05, distance / startDistance))
        const span = this.mapSpan()
        const nextW = Math.min(span.w * 2, Math.max(span.w * 0.0001, drag.cellW * factor))
        grid.cellW = nextW
        grid.cellH =
          this.pkg?.kind === 'image' && this.pkg.width > 0 && this.pkg.height > 0
            ? nextW * (this.pkg.width / this.pkg.height)
            : nextW
      }
    }
    this.syncGridInputs()
    this.refreshContext()
    this.requestDraw()
  }

  private onGridHandleUp = (event: PointerEvent): void => {
    const element = event.currentTarget as HTMLElement
    if (this.gridHandleDrag) {
      this.gridHandleDrag = null
      element.classList.remove('dragging')
      if (element.hasPointerCapture(event.pointerId)) {
        element.releasePointerCapture(event.pointerId)
      }
      this.scheduleGridSave()
    }
  }

  private toggleGridCollapsed(): void {
    if (!this.gridPanelOpen) return
    const collapsed = this.panelEl.classList.toggle('tml-grid-collapsed')
    const button = this.gridPanelEl.querySelector<HTMLElement>('[data-grid-action="collapse"]')
    if (button) button.textContent = collapsed ? '展开' : '收起'
    this.updateGridHandles()
  }

  private defaultGrid(pkg: LayerMapPackage): LayerGridConfig {
    const span = this.mapSpan(pkg)
    const cellW = span.w / 10
    const cellH =
      pkg.kind === 'image' && pkg.width > 0 && pkg.height > 0
        ? cellW * (pkg.width / pkg.height)
        : cellW
    return {
      originX: this.view.cx,
      originY: this.view.cy,
      cellW,
      cellH,
      unitValue: 1,
      unitLabel: '格',
      visible: false,
    }
  }

  private ensureGrid(): LayerGridConfig | undefined {
    const pkg = this.pkg
    if (!pkg) return undefined
    if (!pkg.grid) pkg.grid = this.defaultGrid(pkg)
    return pkg.grid
  }

  private syncGridInputs(): void {
    const grid = this.pkg?.grid
    if (!grid) return
    const span = this.mapSpan()
    const percent = (value: number, total: number): string =>
      (value / total * 100).toFixed(3).replace(/\.?0+$/, '')
    const cellPercent = percent(grid.cellW, span.w)
    this.gridCellEl.value = cellPercent
    this.gridRangeEl.value = String(Math.min(100, Math.max(0.01, Number(cellPercent) || 0.01)))
    this.gridXEl.value = percent(grid.originX - span.x, span.w)
    this.gridYEl.value = percent(grid.originY - span.y, span.h)
    this.gridShowEl.checked = grid.visible === true
  }

  private readGridInputs(): LayerGridConfig | undefined {
    const pkg = this.pkg
    if (!pkg) return undefined
    const grid = this.ensureGrid()
    if (!grid) return undefined
    const number = (value: string, fallback: number): number => {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : fallback
    }
    const span = this.mapSpan(pkg)
    grid.cellW = Math.min(span.w * 2, Math.max(span.w * 0.0001, span.w * number(this.gridCellEl.value, (grid.cellW / span.w) * 100) / 100))
    grid.cellH =
      pkg.kind === 'image' && pkg.width > 0 && pkg.height > 0
        ? grid.cellW * (pkg.width / pkg.height)
        : grid.cellW
    grid.originX = span.x + span.w * number(this.gridXEl.value, ((grid.originX - span.x) / span.w) * 100) / 100
    grid.originY = span.y + span.h * number(this.gridYEl.value, ((grid.originY - span.y) / span.h) * 100) / 100
    grid.visible = this.gridShowEl.checked
    return grid
  }

  private scheduleGridSave(): void {
    if (this.gridSaveTimer !== undefined) window.clearTimeout(this.gridSaveTimer)
    this.gridSaveTimer = window.setTimeout(() => {
      this.gridSaveTimer = undefined
      void this.saveGridNow()
    }, 280)
  }

  private async saveGridNow(): Promise<void> {
    const pkg = this.pkg
    if (!pkg?.grid) return
    const updated = await updateLayerPackage(pkg.id, { grid: { ...pkg.grid } }).catch((error) => {
      this.toast(`保存网格失败：${errorMessage(error)}`)
      return undefined
    })
    // Keep the grid being edited: inputs may have changed while this save ran.
    if (updated && this.pkg?.id === updated.id) this.pkg = { ...updated, grid: this.pkg.grid }
  }

  private applyGridInputs(): void {
    if (!this.readGridInputs()) return
    this.scheduleGridSave()
    this.refreshContext()
    this.requestDraw()
  }

  private migrateLegacyGridOrigin(): void {
    const pkg = this.pkg
    const grid = pkg?.grid
    if (!pkg || !grid) return
    const span = this.mapSpan(pkg)
    const defaultCellW = span.w / 10
    const defaultCellH =
      pkg.kind === 'image' && pkg.width > 0 && pkg.height > 0
        ? defaultCellW * (pkg.width / pkg.height)
        : defaultCellW
    const legacy =
      Math.abs(grid.originX - span.x) < 1e-9 &&
      Math.abs(grid.originY - span.y) < 1e-9 &&
      Math.abs(grid.cellW - defaultCellW) < 1e-9 &&
      Math.abs(grid.cellH - defaultCellH) < 1e-9 &&
      grid.unitValue === 1 &&
      grid.unitLabel === '格' &&
      grid.visible !== true
    if (!legacy) return
    grid.originX = this.view.cx
    grid.originY = this.view.cy
    this.syncGridInputs()
    this.scheduleGridSave()
  }

  private openGridPanel(): void {
    if (!this.pkg) return
    this.ensureGrid()
    this.migrateLegacyGridOrigin()
    this.gridPanelOpen = true
    this.panelEl.classList.add('tml-grid-mode')
    const compact = this.panelEl.classList.contains('tml-compact') || this.panelEl.classList.contains('tml-mobile')
    this.panelEl.classList.toggle('tml-grid-collapsed', compact)
    const collapse = this.gridPanelEl.querySelector<HTMLElement>('[data-grid-action="collapse"]')
    if (collapse) collapse.textContent = compact ? '展开' : '收起'
    this.gridPanelEl.hidden = false
    this.gridPanelEl.classList.remove('dragging')
    this.gridDistanceEl.append(this.distanceUnitEl)
    this.syncGridInputs()
    this.refreshContext()
    this.requestDraw()
    this.syncToolButtons()
    this.updateGridHandles()
  }

  private closeGridPanel(): void {
    if (this.gridSaveTimer !== undefined) {
      window.clearTimeout(this.gridSaveTimer)
      this.gridSaveTimer = undefined
    }
    this.gridPanelOpen = false
    this.readGridInputs()
    this.gridPanelEl.hidden = true
    this.positionCardEl.append(this.distanceUnitEl)
    this.panelEl.classList.remove('tml-grid-mode', 'tml-grid-collapsed')
    const collapse = this.gridPanelEl.querySelector<HTMLElement>('[data-grid-action="collapse"]')
    if (collapse) collapse.textContent = '收起'
    this.gridOriginHandleEl.hidden = true
    this.gridScaleHandleEl.hidden = true
    void this.saveGridNow()
    this.refreshContext()
    this.requestDraw()
    this.syncToolButtons()
  }

  private resetGrid(): void {
    const pkg = this.pkg
    if (!pkg) return
    pkg.grid = this.defaultGrid(pkg)
    this.syncGridInputs()
    this.syncDistanceInputs()
    this.refreshContext()
    this.requestDraw()
    this.scheduleGridSave()
  }


  private openImport(): void {
    this.closeImagePanel()
    this.closeLightbox()
    if (this.aligning) this.cancelAlign()
    this.importUI?.open()
  }

  private openManage(): void {
    this.closeImagePanel()
    this.closeLightbox()
    if (this.aligning) this.cancelAlign()
    void this.packagesUI?.open()
  }

  private toggleImagePanel(): void {
    if (this.imagePanelOpen) this.closeImagePanel()
    else this.openImagePanel()
  }

  private openImagePanel(): void {
    if (!this.pkg) {
      this.toast('先导入一个地图包，再设置底图')
      return
    }
    if (this.aligning) this.cancelAlign()
    this.imageRemovePending = false
    this.imagePanelOpen = true
    this.imagePanelEl.hidden = false
    this.headerImageButtonEl.setAttribute('aria-expanded', 'true')
    this.renderImagePanel()
    this.positionImagePanel()
    this.imagePanelEl.querySelector<HTMLElement>('[data-image-action="close"]')?.focus()
  }

  private closeImagePanel(): void {
    if (!this.imagePanelOpen) return
    this.imagePanelOpen = false
    this.imagePanelEl.hidden = true
    this.imageRemovePending = false
    this.headerImageButtonEl?.setAttribute('aria-expanded', 'false')
    if (this.imagePanelEl.contains(document.activeElement)) {
      this.headerImageButtonEl.focus()
    }
  }

  private positionImagePanel(): void {
    if (!this.imagePanelOpen) return
    const compact = this.windowController.isCompact()
    this.imagePanelEl.classList.toggle('is-compact', compact)
    if (compact) {
      const panelRect = this.panelEl.getBoundingClientRect()
      const left = Math.max(8, panelRect.left + 8)
      const width = Math.max(240, panelRect.width - 16)
      const maxHeight = Math.round(Math.min(panelRect.height * 0.7, 560))
      this.imagePanelEl.style.left = `${Math.round(left)}px`
      this.imagePanelEl.style.top = '0px'
      this.imagePanelEl.style.width = `${Math.round(width)}px`
      this.imagePanelEl.style.right = 'auto'
      this.imagePanelEl.style.bottom = 'auto'
      this.imagePanelEl.style.maxHeight = `${maxHeight}px`
      const height = Math.min(this.imagePanelEl.offsetHeight || maxHeight, maxHeight)
      const top = Math.max(panelRect.top + 8, panelRect.bottom - 8 - height)
      this.imagePanelEl.style.top = `${Math.round(top)}px`
      return
    }
    const trigger = this.headerImageButtonEl.getBoundingClientRect()
    const width = Math.min(IMAGE_PANEL_WIDTH, window.innerWidth - 16)
    const height = Math.min(this.imagePanelEl.offsetHeight || 440, window.innerHeight - 16)
    const left = Math.min(
      window.innerWidth - width - 8,
      Math.max(8, trigger.right - width),
    )
    let top = trigger.bottom + 6
    if (top + height > window.innerHeight - 8) {
      top = Math.max(8, trigger.top - height - 6)
    }
    this.imagePanelEl.style.left = `${Math.round(left)}px`
    this.imagePanelEl.style.top = `${Math.round(top)}px`
    this.imagePanelEl.style.width = `${Math.round(width)}px`
    this.imagePanelEl.style.right = 'auto'
    this.imagePanelEl.style.bottom = 'auto'
    this.imagePanelEl.style.maxHeight = 'min(72vh, 620px)'
  }

  private onImagePanelClick(event: MouseEvent): void {
    const target = event.target as HTMLElement
    const action = target.closest<HTMLElement>('[data-image-action]')?.dataset.imageAction
    if (!action) return
    switch (action) {
      case 'close':
        this.closeImagePanel()
        break
      case 'replace':
        this.imageInput.click()
        break
      case 'remove':
        this.imageRemovePending = true
        this.renderImagePanel()
        break
      case 'remove-cancel':
        this.imageRemovePending = false
        this.renderImagePanel()
        break
      case 'remove-confirm':
        void this.removeImage()
        break
      case 'align':
        this.startAlign()
        break
      case 'view':
        this.openLightbox()
        break
      case 'replace-tiles':
        this.tilesInput.click()
        break
      case 'open-source': {
        const url = this.pkg ? this.imagePageUrl(this.pkg) : undefined
        if (url) window.open(url, '_blank', 'noreferrer')
        break
      }
      default:
        break
    }
  }

  private onImagePanelChange(event: Event): void {
    const target = event.target as HTMLElement
    const action = target.closest<HTMLElement>('[data-image-action]')?.dataset.imageAction
    if (action === 'fit') {
      const fit = (target as HTMLSelectElement).value as LayerImageFit
      void this.setImageFit(fit)
      return
    }
    if (action === 'tile-template') {
      const value = (target as HTMLInputElement).value.trim()
      void this.saveTileTemplate(value)
    }
  }

  private imagePageUrl(pkg: LayerMapPackage): string | undefined {
    return pkg.imagePageUrl
  }

  private renderImagePanel(): void {
    const pkg = this.pkg
    this.imagePanelBodyEl.replaceChildren()
    if (!pkg) return
    if (this.imageBusy) {
      this.imagePanelBodyEl.append(
        element('p', 'tml-empty-small', '正在读取图片，请稍候…'),
      )
      return
    }
    if (pkg.kind === 'tiles') {
      this.renderTilePanel(pkg)
      return
    }
    if (pkg.image) {
      const preview = element('div', 'tml-image-panel-preview')
      if (this.imageUrl) {
        const img = document.createElement('img')
        img.src = this.imageUrl
        img.alt = pkg.imageName || '当前底图'
        preview.append(img)
      }
      const view = document.createElement('button')
      view.type = 'button'
      view.className = 'tml-mini tml-image-view'
      view.dataset.imageAction = 'view'
      view.textContent = '查看大图'
      preview.append(view)
      this.imagePanelBodyEl.append(preview)
      const name = element('strong', 'tml-image-panel-name', pkg.imageName || '当前底图')
      name.title = pkg.imageName || ''
      this.imagePanelBodyEl.append(name)
      const details = [
        pkg.imageWidth && pkg.imageHeight
          ? `${formatCount(pkg.imageWidth)}×${formatCount(pkg.imageHeight)}`
          : '',
        formatBytes(pkg.image.size),
        imageSourceLabel(pkg.imageSource),
        imageFitLabel(pkg.imageFit),
      ].filter(Boolean)
      this.imagePanelBodyEl.append(element('span', 'tml-image-meta', details.join(' · ')))
      const aspect = imageAspectNote(pkg)
      if (aspect) this.imagePanelBodyEl.append(element('p', 'tml-hint', aspect))
      const fitRow = element('label', 'tml-image-fit-row')
      fitRow.append(element('span', undefined, '显示'))
      const fit = document.createElement('select')
      fit.dataset.imageAction = 'fit'
      fit.className = 'tml-select'
      fit.append(new Option('铺满地图', 'stretch'), new Option('保持比例', 'contain'))
      if (pkg.imageFit === 'custom') fit.append(new Option('手动对齐', 'custom'))
      fit.value = pkg.imageFit ?? 'stretch'
      fitRow.append(fit)
      this.imagePanelBodyEl.append(fitRow)
      const actions = element('div', 'tml-image-panel-actions')
      const replace = element('button', 'tml-btn', '更换底图')
      replace.type = 'button'
      replace.dataset.imageAction = 'replace'
      const remove = element('button', 'tml-btn tml-danger-text', '移除底图')
      remove.type = 'button'
      remove.dataset.imageAction = 'remove'
      actions.append(replace, remove)
      if (this.effectiveMarkerList.length > 0) {
        const align = element('button', 'tml-btn', '对齐底图')
        align.type = 'button'
        align.dataset.imageAction = 'align'
        actions.append(align)
      }
      this.imagePanelBodyEl.append(actions)
      if (this.imageRemovePending) {
        const confirm = element('div', 'tml-image-confirm')
        confirm.append(
          element('span', undefined, '移除底图后，地点、链接和笔记都会保留，之后可以再补。'),
        )
        const confirmActions = element('div', 'tml-image-panel-actions')
        const yes = element('button', 'tml-mini tml-danger-text', '确认移除')
        yes.type = 'button'
        yes.dataset.imageAction = 'remove-confirm'
        const no = element('button', 'tml-mini', '取消')
        no.type = 'button'
        no.dataset.imageAction = 'remove-cancel'
        confirmActions.append(yes, no)
        confirm.append(confirmActions)
        this.imagePanelBodyEl.append(confirm)
      }
      const source = this.imagePageUrl(pkg)
      if (source) {
        const link = element(
        'button',
        'tml-link-inline',
        pkg.imageSource === 'fandom-url' || pkg.attribution?.includes('Fandom 页面')
          ? '打开 Fandom 图片页'
          : '打开源数据图片页',
      )
        link.type = 'button'
        link.dataset.imageAction = 'open-source'
        this.imagePanelBodyEl.append(link)
      }
      this.imagePanelBodyEl.append(
        element('p', 'tml-hint', '底图只保存在本机，不会上传；换图不会改动地点、笔记或链接。'),
      )
      return
    }
    const empty = element('div', 'tml-image-panel-empty')
    empty.append(
      element('strong', undefined, '这张地图还没有底图'),
      element('p', undefined, '选一张本地图片，或继续只用点位浏览。'),
    )
    const actions = element('div', 'tml-image-panel-actions')
    const pick = element('button', 'tml-btn tml-primary', '选择底图')
    pick.type = 'button'
    pick.dataset.imageAction = 'replace'
    actions.append(pick)
    empty.append(actions)
    this.imagePanelBodyEl.append(empty)
    const source = this.imagePageUrl(pkg)
    if (source) {
      const link = element(
        'button',
        'tml-link-inline',
        pkg.imageSource === 'fandom-url' || pkg.attribution?.includes('Fandom 页面')
          ? '打开 Fandom 图片页'
          : '打开源数据图片页',
      )
      link.type = 'button'
      link.dataset.imageAction = 'open-source'
      this.imagePanelBodyEl.append(link)
    }
  }

  private renderTilePanel(pkg: LayerMapPackage): void {
    const tile = pkg.tile
    const count = Object.keys(pkg.tileFiles ?? {}).length
    const preview = element('div', 'tml-image-panel-tiles')
    preview.append(
      element('strong', undefined, tile?.setName || '瓦片底图'),
      element(
        'span',
        'tml-image-meta',
        count > 0
          ? `${formatCount(count)} 张瓦片 · 层级 ${tile?.coverageMinZoom ?? tile?.minZoom ?? '—'}–${tile?.coverageMaxZoom ?? tile?.maxZoom ?? '—'}${tile?.missingCount ? ` · 缺 ${formatCount(tile.missingCount)} 张` : ''}`
          : '还没有关联瓦片',
      ),
    )
    this.imagePanelBodyEl.append(preview)
    const actions = element('div', 'tml-image-panel-actions')
    const replace = element('button', 'tml-btn tml-primary', '重新选择瓦片文件夹')
    replace.type = 'button'
    replace.dataset.imageAction = 'replace-tiles'
    actions.append(replace)
    this.imagePanelBodyEl.append(actions)
    if (tile) {
      const field = element('label', 'tml-field')
      field.append(element('span', undefined, '瓦片 URL 模板（本地瓦片可留空）'))
      const input = document.createElement('input')
      input.type = 'text'
      input.value = tile.template
      input.placeholder = 'http://127.0.0.1:8000/{z}/{y}/{x}.jpg'
      input.dataset.imageAction = 'tile-template'
      field.append(input)
      this.imagePanelBodyEl.append(field)
      if (tile.setCount && tile.setCount > 1) {
        this.imagePanelBodyEl.append(
          element(
            'p',
            'tml-hint',
            `这个地图包有 ${tile.setCount} 个瓦片组，当前使用「${tile.setName || '默认'}」。需要其他组时重新导入并在高级选项里选择。`,
          ),
        )
      }
    }
    this.imagePanelBodyEl.append(
      element('p', 'tml-hint', '瓦片只保存在本机，不会请求 Map Genie 线上数据。'),
    )
  }

  private async replaceImage(file: File): Promise<void> {
    const pkg = this.pkg
    if (!pkg || this.imageBusy) return
    this.imageBusy = true
    this.renderImagePanel()
    try {
      const info = await readLayerImage(file, file.name)
      const thumbnail = await makeLayerThumbnail(file)
      const imageOnly =
        pkg.kind === 'image' && pkg.markers.length === 0 && pkg.source === 'manual'
      const updated = await setLayerImage(pkg.id, {
        image: file,
        imageType: file.type,
        imageName: file.name,
        imagePageUrl: undefined,
        imageWidth: info.width,
        imageHeight: info.height,
        imageBytes: file.size,
        imageSource: 'local',
        imageFit: 'stretch',
        thumbnail,
        imageLocked: true,
        width: imageOnly ? info.width : pkg.width,
        height: imageOnly ? info.height : pkg.height,
      })
      if (updated) {
        this.pkg = updated
        this.imageBusy = false
        this.updatePackageInfo()
        this.loadImage(updated)
        this.syncHeaderImage()
        this.renderImagePanel()
        await this.refreshPackages()
        this.toast('底图已更换，地点和笔记没有变化')
      }
    } catch (error) {
      this.imageBusy = false
      this.renderImagePanel()
      this.toast(`更换底图失败：${errorMessage(error)}`)
    }
  }

  private async removeImage(): Promise<void> {
    const pkg = this.pkg
    if (!pkg || this.imageBusy) return
    const old = {
      image: pkg.image,
      type: pkg.imageType,
      name: pkg.imageName,
      pageUrl: pkg.imagePageUrl,
      width: pkg.imageWidth,
      height: pkg.imageHeight,
      bytes: pkg.imageBytes,
      source: pkg.imageSource,
      fit: pkg.imageFit,
      rect: pkg.imageRect,
      thumbnail: pkg.thumbnail,
    }
    if (!old.image) return
    this.imageBusy = true
    this.renderImagePanel()
    try {
      const updated = await removeLayerImage(pkg.id)
      if (updated) {
        this.lastRemovedImage = {
          pkgId: pkg.id,
          image: old.image,
          type: old.type,
          name: old.name,
          pageUrl: old.pageUrl,
          width: old.width,
          height: old.height,
          bytes: old.bytes,
          source: old.source,
          fit: old.fit,
          rect: old.rect,
          thumbnail: old.thumbnail,
        }
        this.pkg = updated
        this.imageBusy = false
        this.imageRemovePending = false
        this.updatePackageInfo()
        this.loadImage(updated)
        this.syncHeaderImage()
        this.renderImagePanel()
        await this.refreshPackages()
        this.toast('已移除底图，地点和笔记都还在', {
          label: '撤销',
          onClick: () => void this.undoRemoveImage(),
        })
      }
    } catch (error) {
      this.imageBusy = false
      this.renderImagePanel()
      this.toast(`移除底图失败：${errorMessage(error)}`)
    }
  }

  private async undoRemoveImage(): Promise<void> {
    const pkg = this.pkg
    const old = this.lastRemovedImage
    if (!pkg || !old) return
    if (old.pkgId !== pkg.id) {
      this.lastRemovedImage = null
      this.toast('已经切换到另一个地图包，不能撤销上一次移除')
      return
    }
    const updated = await setLayerImage(pkg.id, {
      image: old.image,
      imageType: old.type,
      imageName: old.name,
      imagePageUrl: old.pageUrl,
      imageWidth: old.width,
      imageHeight: old.height,
      imageBytes: old.bytes,
      imageSource: old.source ?? 'local',
      imageFit: old.fit ?? 'stretch',
      imageRect: old.rect,
      thumbnail: old.thumbnail,
      imageLocked: true,
    }).catch((error) => {
      this.toast(`撤销失败：${errorMessage(error)}`)
      return undefined
    })
    if (updated) {
      this.lastRemovedImage = null
      this.pkg = updated
      this.updatePackageInfo()
      this.loadImage(updated)
      this.syncHeaderImage()
      this.renderImagePanel()
      await this.refreshPackages()
      this.toast('底图已恢复')
    }
  }

  private async setImageFit(fit: LayerImageFit): Promise<void> {
    const pkg = this.pkg
    if (!pkg) return
    if (fit === 'custom') {
      this.startAlign()
      return
    }
    const updated = await setLayerImageFit(pkg.id, fit).catch((error) => {
      this.toast(`保存显示方式失败：${errorMessage(error)}`)
      return undefined
    })
    if (updated) {
      this.pkg = updated
      this.renderImagePanel()
      this.requestDraw()
    }
  }

  private startAlign(): void {
    const pkg = this.pkg
    if (!pkg?.image || pkg.kind !== 'image') {
      this.toast('这张地图没有图片底图，无法对齐')
      return
    }
    if (!this.image) {
      this.toast('底图还在加载，请稍候再对齐')
      return
    }
    if (pkg.markers.length === 0) {
      this.toast('这张底图还没有地点数据；先关联 JSON 再对齐')
      return
    }
    this.closeImagePanel()
    this.imageRemovePending = false
    this.alignRect = { ...imageRectFor(pkg) }
    this.alignStartRect = null
    this.alignStartPointer = null
    this.alignDrag = false
    this.aligning = true
    this.alignBarEl.hidden = false
    this.panelEl.classList.add('tml-aligning')
    this.canvasEl.style.cursor = 'move'
    this.requestDraw()
  }

  private resetAlign(): void {
    if (!this.aligning) return
    this.alignRect = { x: 0, y: 0, w: 1, h: 1 }
    this.requestDraw()
  }

  private cancelAlign(): void {
    if (!this.aligning) return
    this.aligning = false
    this.alignDrag = false
    this.alignStartPointer = null
    this.alignStartRect = null
    this.alignRect = null
    this.alignBarEl.hidden = true
    this.panelEl.classList.remove('tml-aligning')
    this.canvasEl.style.cursor = 'grab'
    this.requestDraw()
  }

  private async finishAlign(): Promise<void> {
    const pkg = this.pkg
    if (!pkg || !this.alignRect) return
    const rect = sanitizeRect(this.alignRect)
    const updated = await setLayerImageFit(pkg.id, 'custom', rect).catch((error) => {
      this.toast(`保存对齐失败：${errorMessage(error)}`)
      return undefined
    })
    if (!updated) return
    this.pkg = updated
    this.aligning = false
    this.alignDrag = false
    this.alignStartPointer = null
    this.alignStartRect = null
    this.alignRect = null
    this.alignBarEl.hidden = true
    this.panelEl.classList.remove('tml-aligning')
    this.canvasEl.style.cursor = 'grab'
    this.syncHeaderImage()
    this.requestDraw()
    this.toast('底图对齐已保存')
  }

  private zoomAlign(sx: number, sy: number, factor: number): void {
    const pkg = this.pkg
    if (!pkg || !this.alignRect) return
    const width = this.canvasEl.clientWidth || 1
    const height = this.canvasEl.clientHeight || 1
    const fit = Math.min(width / pkg.width, height / pkg.height) * IMAGE_FIT_MARGIN
    const scale = fit * this.view.zoom
    const mapX = this.view.cx + (sx - width / 2) / (pkg.width * scale)
    const mapY = this.view.cy + (sy - height / 2) / (pkg.height * scale)
    const rect = this.alignRect
    const relativeX = (mapX - rect.x) / rect.w
    const relativeY = (mapY - rect.y) / rect.h
    const nextWidth = Math.min(6, Math.max(0.05, rect.w * factor))
    const nextHeight = Math.min(6, Math.max(0.05, rect.h * (nextWidth / rect.w)))
    this.alignRect = sanitizeRect({
      x: mapX - relativeX * nextWidth,
      y: mapY - relativeY * nextHeight,
      w: nextWidth,
      h: nextHeight,
    })
    this.requestDraw()
  }

  private openLightbox(): void {
    const pkg = this.pkg
    if (!pkg?.image) return
    this.closeLightbox()
    this.lightboxUrl = URL.createObjectURL(pkg.image)
    this.lightboxImageEl.src = this.lightboxUrl
    this.lightboxImageEl.alt = pkg.imageName || '底图预览'
    this.lightboxEl.hidden = false
    this.lightboxEl.querySelector<HTMLElement>('[data-lightbox-action="close"]')?.focus()
  }

  private closeLightbox(): void {
    if (this.lightboxEl.hidden) return
    this.lightboxEl.hidden = true
    this.lightboxImageEl.removeAttribute('src')
    if (this.lightboxUrl) {
      URL.revokeObjectURL(this.lightboxUrl)
      this.lightboxUrl = null
    }
  }

  private syncHeaderImage(): void {
    if (this.headerImageUrl) {
      URL.revokeObjectURL(this.headerImageUrl)
      this.headerImageUrl = null
    }
    const pkg = this.pkg
    if (pkg?.image) {
      this.headerImageUrl = URL.createObjectURL(pkg.image)
      this.headerImageEl.src = this.headerImageUrl
      this.headerImageEl.alt = pkg.imageName || '当前底图'
      this.headerImageEl.hidden = false
      this.headerImageEmptyEl.hidden = true
      this.headerImageButtonEl.title = `底图：${pkg.imageName || '已设置'}`
    } else {
      this.headerImageEl.removeAttribute('src')
      this.headerImageEl.hidden = true
      this.headerImageEmptyEl.hidden = false
      this.headerImageButtonEl.title =
        pkg?.kind === 'tiles' ? '瓦片底图 · 点开设置' : '底图 · 点开设置'
    }
    this.headerImageButtonEl.setAttribute('aria-expanded', String(this.imagePanelOpen))
  }

  private tileSetFor(pkg: LayerMapPackage): MapGenieTileSetInfo | undefined {
    if (!pkg.tile) return undefined
    return {
      index: pkg.tile.setIndex ?? 0,
      id: '',
      name: pkg.tile.setName || '当前瓦片组',
      pattern: '',
      minZoom: pkg.tile.minZoom,
      maxZoom: pkg.tile.maxZoom,
      order: pkg.tile.order ?? 'unknown',
      prefix: '',
      boundsByZoom: pkg.tile.boundsByZoom ?? {},
    }
  }

  private async replaceTiles(files: File[]): Promise<void> {
    const pkg = this.pkg
    if (!pkg || pkg.kind !== 'tiles' || this.imageBusy) return
    const tileSet = this.tileSetFor(pkg)
    if (!tileSet) {
      this.toast('这个地图包缺少瓦片配置，无法重新关联')
      return
    }
    this.imageBusy = true
    this.renderImagePanel()
    try {
      const bundle = filesToBundle(files, pkg.name)
      const scan = scanTileFiles(bundle.files, tileSet, pkg.tile?.setCount ?? 1)
      if (!scan.tileFiles || Object.keys(scan.tileFiles).length === 0) {
        throw new Error('这个文件夹里没有找到 z/x/y 结构的瓦片')
      }
      const tile = {
        ...(pkg.tile as NonNullable<LayerMapPackage['tile']>),
        order: scan.order,
        coverageMinZoom: scan.stats?.minZoom,
        coverageMaxZoom: scan.stats?.maxZoom,
        expectedCount: scan.stats?.expected,
        missingCount: scan.stats?.missing,
      }
      const updated = await setLayerTiles(pkg.id, scan.tileFiles, tile)
      if (updated) {
        this.pkg = updated
        this.imageBusy = false
        this.updatePackageInfo()
        this.clearTileCaches()
        this.renderImagePanel()
        this.syncHeaderImage()
        await this.refreshPackages()
        this.requestDraw()
        this.toast(`已关联 ${Object.keys(scan.tileFiles).length.toLocaleString('zh-CN')} 张瓦片`)
      }
    } catch (error) {
      this.imageBusy = false
      this.renderImagePanel()
      this.toast(`关联瓦片失败：${errorMessage(error)}`)
    }
  }

  private async saveTileTemplate(value: string): Promise<void> {
    const pkg = this.pkg
    if (!pkg?.tile) return
    if (
      value &&
      (!/\{z\}/.test(value) || !/\{x\}/.test(value) || !/\{y\}/.test(value))
    ) {
      this.toast('瓦片模板必须同时包含 {z}、{x}、{y}')
      this.renderImagePanel()
      return
    }
    const updated = await updateLayerPackage(pkg.id, {
      tile: { ...pkg.tile, template: value },
    }).catch((error) => {
      this.toast(`保存瓦片模板失败：${errorMessage(error)}`)
      return undefined
    })
    if (updated) {
      this.pkg = updated
      this.updatePackageInfo()
      this.requestDraw()
      this.toast('瓦片 URL 模板已保存')
    }
  }

  private renderEmpty(message: string): void {
    this.emptyMessage = message
    this.emptyEl.hidden = !message
    this.emptyEl.textContent = message
  }

  private toast(
    message: string,
    action?: { label: string; onClick: () => void },
  ): void {
    const node = document.createElement('div')
    node.className = 'tm-toast'
    node.setAttribute('role', 'status')
    const text = document.createElement('span')
    text.textContent = message
    node.append(text)
    if (action) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'tm-toast-action'
      button.textContent = action.label
      button.addEventListener('click', () => {
        action.onClick()
        node.remove()
      })
      node.append(button)
    }
    document.querySelectorAll('.tm-toast').forEach((toast) => toast.remove())
    document.body.append(node)
    window.setTimeout(() => node.remove(), action ? 6000 : 2600)
  }

  dispose(): void {
    void flushGlobalNotes()
    this.maplibreMap?.remove()
    this.maplibreMap = null
    this.maplibreReady = null
    this.windowController?.dispose()
    this.importUI?.dispose()
    this.packagesUI?.dispose()
    this.offs.forEach((remove) => remove())
    this.offs.length = 0
    if (this.saveTimer !== undefined) window.clearTimeout(this.saveTimer)
    if (this.resizeObserver) this.resizeObserver.disconnect()
    if (this.drawFrame) window.cancelAnimationFrame(this.drawFrame)
    if (this.imageUrl) URL.revokeObjectURL(this.imageUrl)
    if (this.headerImageUrl) URL.revokeObjectURL(this.headerImageUrl)
    if (this.lightboxUrl) URL.revokeObjectURL(this.lightboxUrl)
    this.clearTileCaches()
    this.panelEl?.remove()
    this.imagePanelEl?.remove()
    this.lightboxEl?.remove()
    this.contextModalEl?.remove()
  }
}

function samePinPosition(a: LayerPinPoint, b: LayerPinPoint): boolean {
  return a.x === b.x && a.y === b.y
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function textElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  element.className = className
  element.textContent = text
  return element
}

const PALETTE = [
  '#e6b56a',
  '#78c6c0',
  '#e78282',
  '#8ab4f8',
  '#c792ea',
  '#9ccc65',
  '#ffb74d',
  '#4dd0e1',
  '#f06292',
  '#a1887f',
  '#90a4ae',
  '#dce775',
  '#ff8a65',
  '#7986cb',
  '#4db6ac',
  '#ba68c8',
  '#fdd835',
  '#81c784',
  '#64b5f6',
  '#e57373',
]
