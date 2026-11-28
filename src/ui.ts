import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson'
import {
  type GeoJSONSource,
  Map as MapLibreMap,
  type MapMouseEvent,
  Marker,
  NavigationControl,
} from 'maplibre-gl'
import { cacheGet, cachePut, wikiCacheKey, wikiFullCacheKey } from './cache'
import { buildContext, estimateTokens } from './context'
import { buildLayerContext, buildMapContexts } from './layer-context'
import { LayerMapUI } from './layer-map'
import { LayerWindowController, MAP_WINDOW_STORAGE_KEY } from './layer-window'
import { nearbyPlacesInRange, realLinks, realNote, realPartAllowed, realSource, realWiki, setRealPart } from './real-places'
import { currentRouteLeg, editableRoute, itineraryLegPois, LEG_MODES, legPath, pathLength, planPath, stopPoint } from './real-itinerary'
import { findFavorite, listFavorites, realFavoriteKey, removeFavorite, setFavorite } from './favorites-store'
import { LAYER_STATE_KEY, loadLayerState } from './layer-types'
import { flushGlobalNotes, globalNote, setGlobalNote } from './notes-store'
import { formatDistance, haversine, placeKey } from './geo'
import { errorMessage } from './http'
import {
  assignRoutePoisToSteps,
  fetchPois,
  fetchRoutePois,
  filterPoisAlongRoute,
  type Poi,
} from './poi'
import { syncPrompt, clearPrompt } from './prompt'
import { nearbyPlaces, reverseGeocode, reverseStreet } from './providers'
import { matchDrawnRoute, routeBetween, type Route, type RouteStep } from './route'
import { searchPlaces, type SearchResult } from './search'
import { loadState, saveState } from './state'
import { storedRealPosition } from './layer-positions'
import { ITINERARY_RANGE_MAX, ITINERARY_RANGE_MIN, loadSettings, saveSettings, WIKI_LANGS } from './settings'
import type {
  LegMode,
  MapState,
  RealLeg,
  RealPlacePart,
  RealRouteDraft,
  RealStop,
  RoutePoint,
  Place,
  RouteItinerary,
  RoutePoi,
  RouteProfile,
  SavedPlace,
  Settings,
  StContext,
  StarredWiki,
  WikiCandidate,
  WikiPage,
  WikiRef,
} from './types'
import { wikiLangLinks, wikiNearby, wikiPage, wikiPageFull } from './wiki'

const PANEL_ID = 'tm-panel'
const WIKI_TTL_MS = 7 * 24 * 60 * 60 * 1000
const FAB_POS_KEY = 'tavern-map:fab-position'
const ROUTE_SOURCE = 'tm-route'
const WIKI_LANG_LABELS: Record<string, string> = { en: 'EN', ja: 'JA', zh: 'ZH' }
const ROUTE_MODE_LABELS: Record<RouteProfile, string> = {
  foot: '步行',
  driving: '驾车',
  transit: '公共交通',
}
const ROUTE_MODES: RouteProfile[] = ['foot', 'driving', 'transit']

function wikiKey(lang: string, pageId: number): string {
  return `${lang}:${pageId}`
}

function langLabel(lang: string): string {
  return WIKI_LANG_LABELS[lang] ?? lang.toUpperCase()
}

function formatRadius(metres: number): string {
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)}km` : `${Math.round(metres)}m`
}

function formatDurationShort(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`
}

function circleFeature(lat: number, lng: number, radiusM: number): Feature<Polygon> {
  const steps = 72
  const dLat = radiusM / 111320
  const dLng = radiusM / (111320 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)))
  const ring: Array<[number, number]> = []
  for (let index = 0; index <= steps; index += 1) {
    const angle = (index / steps) * Math.PI * 2
    ring.push([lng + dLng * Math.cos(angle), lat + dLat * Math.sin(angle)])
  }
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [ring] },
  }
}

function zoomForSearchType(type: string | undefined): number {
  switch (type) {
    case 'country':
      return 5
    case 'state':
    case 'region':
      return 7
    case 'county':
      return 9
    case 'city':
    case 'town':
    case 'village':
    case 'municipality':
      return 12
    case 'district':
    case 'locality':
    case 'suburb':
    case 'neighbourhood':
      return 14
    case 'street':
    case 'road':
    case 'pedestrian':
      return 16
    case 'house':
    case 'building':
    case 'address':
      return 17
    default:
      return 14
  }
}

const PANEL_HTML = `
<button id="tm-fab" class="tm-fab" type="button" title="打开地图" aria-label="打开地图">🗺️</button>
<section id="${PANEL_ID}" class="tm-panel" aria-label="Tavern Map" hidden>
  <header class="tm-head tml-head">
    <strong>Tavern Map</strong>
    <div class="tml-mode-tabs" role="tablist" aria-label="地图模式">
      <button type="button" class="active" role="tab" aria-selected="true">现实地图</button>
      <button type="button" role="tab" data-action="layer-map">图层地图</button>
    </div>
    <div class="tm-head-actions">
      <button type="button" data-action="preview" title="预览 AI 上下文">AI 预览</button>
      <button type="button" data-action="refresh" title="刷新地点数据">刷新</button>
      <button type="button" data-action="close" title="关闭">×</button>
    </div>
  </header>
  <div class="tm-workspace">
  <aside class="tm-real-side">
    <div class="tm-tabs" role="tablist">
      <button type="button" data-tab="nearby" class="active" role="tab">周边</button>
      <button type="button" data-tab="saved" role="tab">收藏 <span id="tm-saved-count" class="tm-badge">0</span></button>
      <button type="button" data-tab="wiki" role="tab">维基</button>
    </div>
    <button id="tm-poi-toggle" class="tm-poi-toggle active" type="button" aria-pressed="true">POI 图层</button>
    <div id="tm-poi-filters" class="tm-real-filters"></div>
  </aside>
  <div class="tm-map-shell">
    <div id="tm-canvas" class="tm-canvas"></div>
    <div class="tm-search">
      <svg class="tm-search-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="10.5" cy="10.5" r="6.5"></circle>
        <path d="m15.4 15.4 5.1 5.1"></path>
      </svg>
      <input id="tm-search-input" type="search" placeholder="搜索国家、城市、地点…" autocomplete="off" spellcheck="false" aria-label="搜索地点">
      <div id="tm-search-results" class="tm-search-results" role="listbox" hidden></div>
    </div>
    <button type="button" class="tm-map-route" data-tab="route">行程 <span id="tm-route-count" class="tm-badge">0</span></button>
    <div id="tm-map-tool" class="tm-map-tool" hidden></div>
    <button type="button" id="tm-route-width" class="tm-route-width" aria-label="拖动调整沿途 POI 范围" title="拖动调整沿途 POI 范围" hidden>↔</button>
    <button id="tm-recenter" class="tm-recenter" type="button" title="回到人物位置" aria-label="回到人物位置">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="5.5"></circle>
        <path d="M12 2v4M12 18v4M2 12h4M18 12h4"></path>
      </svg>
    </button>
  </div>
  <div id="tm-split" class="tm-split" role="separator" aria-label="调整地图与详情大小" tabindex="0"></div>
  <aside class="tm-real-inspector">
  <div class="tm-location">
    <div class="tm-my-heading">我</div>
    <div class="tm-place-summary" data-action="place-current" role="button" tabindex="0" title="查看地点详情">
      <div id="tm-place-name" class="tm-place-name">尚未放置</div>
      <div id="tm-place-address" class="tm-place-address"></div>
    </div>
    <div class="tm-place-actions">
      <button type="button" data-action="my-center">居中</button>
      <button type="button" data-action="my-move">移动</button>
      <button type="button" data-action="my-clear">清除</button>
    </div>
    <div class="tm-location-meta">
      <div id="tm-status" class="tm-status" role="status"></div>
      <label class="tm-radius-control">
        <span>范围</span>
        <input id="tm-radius" type="range" min="25" max="1000" step="5" aria-label="周边搜索范围">
        <output id="tm-radius-value">250m</output>
      </label>
    </div>
  </div>
  <div id="tm-list" class="tm-list"></div>
  </aside>
  </div>
  ${['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'].map((edge) => `<span class="tml-resize" data-resize="${edge}" aria-hidden="true"></span>`).join('')}
  <footer class="tm-foot">© OpenStreetMap contributors · Wikipedia CC BY-SA 4.0</footer>
  <div id="tm-wiki" class="tm-wiki" role="dialog" aria-label="Wikipedia article" hidden>
    <header class="tm-head">
      <strong id="tm-wiki-title">Wiki</strong>
      <div class="tm-head-actions">
        <button type="button" id="tm-star" data-action="star" title="加入 AI 上下文" aria-pressed="false">☆</button>
        <button type="button" data-action="close-wiki" title="关闭">×</button>
      </div>
    </header>
    <div class="tm-wiki-toolbar">
      <div id="tm-wiki-langs" class="tm-pill-row" role="group" aria-label="Wikipedia 语言"></div>
      <div id="tm-wiki-modes" class="tm-pill-row" role="group" aria-label="显示范围">
        <button type="button" class="tm-pill active" data-wiki-mode="intro">概览</button>
        <button type="button" class="tm-pill" data-wiki-mode="full">全文</button>
      </div>
    </div>
    <div class="tm-ai-lang-row">
      <label for="tm-wiki-ai-lang">给 AI 的语言</label>
      <select id="tm-wiki-ai-lang" aria-label="选择展示给 AI 的语言"></select>
      <span id="tm-ai-lang-hint" class="tm-ai-lang-hint">星标后可选择</span>
    </div>
    <div id="tm-wiki-full-hint" class="tm-wiki-full-hint" hidden>全文会完整注入 AI，token 会显著增加。</div>
    <div id="tm-wiki-body" class="tm-wiki-body"></div>
    <div class="tm-wiki-note">
      <label for="tm-wiki-note">我的笔记</label>
      <textarea id="tm-wiki-note" placeholder="点亮星标后可为这篇 Wiki 添加笔记…" disabled></textarea>
      <div id="tm-wiki-note-status" class="tm-note-status"></div>
    </div>
    <a id="tm-wiki-link" class="tm-wiki-link" target="_blank" rel="noreferrer">打开 Wikipedia</a>
  </div>
  <div id="tm-place" class="tm-place" role="dialog" aria-label="Place details" hidden>
    <header class="tm-head">
      <strong id="tm-place-title">地点</strong>
      <div class="tm-head-actions">
        <button type="button" id="tm-place-save" data-action="place-save" title="收藏地点" aria-pressed="false">☆</button>
        <button type="button" data-action="close-place" title="关闭">×</button>
      </div>
    </header>
    <div class="tm-place-body">
      <div id="tm-place-meta" class="tm-place-detail-meta"></div>
      <div class="tm-place-actions">
        <select id="tm-place-route-mode" class="tm-route-mode" aria-label="路线方式" title="路线方式">
          <option value="foot">步行</option>
          <option value="driving">驾车</option>
          <option value="transit">公共交通</option>
        </select>
        <button type="button" data-action="place-route">路线</button>
        <button type="button" data-action="place-center">居中</button>
        <button type="button" data-action="place-go">移我到这里</button>
        <button type="button" data-action="place-add-stop">+ 经停</button>
        <button type="button" data-action="place-clear-route" hidden>清除路线</button>
        <button type="button" data-action="place-wiki">附近 Wiki</button>
      </div>
      <div id="tm-place-info" class="tm-place-info"></div>
      <div id="tm-route-summary" class="tm-route-summary" hidden>
        <span id="tm-route-text"></span>
        <label class="tm-route-ai"><input type="checkbox" data-route-ai> 把行程显示给 AI</label>
        <div class="tm-route-actions">
          <button type="button" data-action="route-copy">复制行程</button>
          <button type="button" data-action="place-itinerary">完整行程</button>
          <button type="button" data-action="place-start" class="tm-route-start" hidden>开始移动</button>
          <button type="button" data-action="place-stop" class="tm-route-stop" hidden>停止</button>
        </div>
        <div class="tm-route-poi-controls">
          <label><input type="checkbox" data-route-pois> 显示沿途 POI</label>
          <label class="tm-route-poi-radius">范围
            <input type="range" data-route-poi-radius min="25" max="500" step="5" aria-label="沿途 POI 范围">
            <span data-route-poi-radius-value>100m</span>
          </label>
        </div>
        <div class="tm-route-progress" id="tm-route-progress"><div id="tm-route-bar" class="tm-route-bar"></div></div>
        <ol id="tm-place-route-steps" class="tm-route-steps tm-place-route-steps"></ol>
      </div>
      <div class="tm-place-note">
        <label for="tm-place-note">我的笔记</label>
        <span id="tm-place-note-ai"></span>
        <textarea id="tm-place-note" placeholder="写下地点笔记（不收藏也会保存）…" disabled></textarea>
        <div id="tm-place-note-status" class="tm-note-status"></div>
      </div>
    </div>
  </div>
</section>
<div id="tm-preview" class="tm-preview" role="dialog" aria-modal="true" aria-label="AI context preview" hidden>
  <div class="tm-preview-card">
    <header class="tm-head">
      <strong id="tm-preview-heading">AI 将看到的场景块</strong>
      <div class="tm-head-actions">
        <button type="button" data-action="copy">复制</button>
        <button type="button" data-action="close-preview">×</button>
      </div>
    </header>
    <div id="tm-token-estimate" class="tm-token-estimate"></div>
    <pre id="tm-preview-text"></pre>
  </div>
</div>
`

const SETTINGS_HTML = `
<div id="tm-settings" class="tm-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Tavern Map</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
    </div>
    <div class="inline-drawer-content">
      <label class="checkbox_label"><input type="checkbox" id="tm-set-enabled"> 启用 AI 注入（地图仍可查看）</label>
      <div class="tm-row tm-row-stack">地图上下文（二选一，可都不选）
        <div class="tm-context-options">
          <label><input type="checkbox" id="tm-set-real-context"> 现实地图上下文</label>
          <label><input type="checkbox" id="tm-set-layer-context"> 图层地图上下文</label>
        </div>
      </div>
      <div class="tm-row tm-row-stack">Wiki 搜索语言（可多选）
        <div class="tm-lang-options">
          <label><input type="checkbox" data-tm-lang value="en"> English</label>
          <label><input type="checkbox" data-tm-lang value="ja"> 日本語</label>
          <label><input type="checkbox" data-tm-lang value="zh"> 中文</label>
        </div>
      </div>

      <div class="tm-settings-group">
        <div class="tm-settings-group-title">现实地图 · 所在地点</div>
        <label class="checkbox_label"><input type="checkbox" data-real-setting="realSourceAI"> 来源资料进入 AI</label>
        <label class="checkbox_label"><input type="checkbox" data-real-setting="realWikiAI"> Wiki 正文进入 AI</label>
        <label class="checkbox_label"><input type="checkbox" data-real-setting="realNoteAI"> 地点笔记进入 AI</label>
      </div>

      <div class="tm-settings-group">
        <div class="tm-settings-group-title">现实地图 · 周围地点</div>
        <label class="checkbox_label"><input type="checkbox" data-real-setting="realNearbyAI"> 半径内地点进入 AI</label>
        <label class="checkbox_label"><input type="checkbox" data-real-setting="realNearbyType"> 附带类型</label>
        <label class="checkbox_label"><input type="checkbox" data-real-setting="realNearbyDistance"> 附带距离 / 方位</label>
        <label class="checkbox_label"><input type="checkbox" data-real-setting="realNearbyCoords"> 附带坐标</label>
        <label class="checkbox_label"><input type="checkbox" data-real-setting="realNearbyNotes"> 附带笔记</label>
        <label class="checkbox_label"><input type="checkbox" data-real-setting="realNearbySource"> 附带来源资料</label>
        <label class="checkbox_label"><input type="checkbox" data-real-setting="realNearbyWiki"> 附带 Wiki 正文</label>
        <label class="tm-row">周边半径（米）<input type="number" id="tm-set-radius" min="25" max="1000" step="5"></label>
        <label class="tm-row">周围地点最多<input type="number" id="tm-set-nearby" min="0" max="50" step="1"></label>
      </div>

      <div class="tm-settings-group">
        <div class="tm-settings-group-title">现实地图 · 收藏地点</div>
        <label class="checkbox_label"><input type="checkbox" data-real-setting="realFavoritesAI"> 把收藏地点发给 AI</label>
        <label class="checkbox_label"><input type="checkbox" data-real-setting="realFavoriteType"> 附带类型</label>
        <label class="checkbox_label"><input type="checkbox" data-real-setting="realFavoriteCoords"> 附带坐标</label>
        <label class="checkbox_label"><input type="checkbox" data-real-setting="realFavoriteSource"> 附带来源资料</label>
        <label class="checkbox_label"><input type="checkbox" data-real-setting="realFavoriteWiki"> 附带 Wiki 正文</label>
        <label class="checkbox_label"><input type="checkbox" data-real-setting="realFavoriteNote"> 附带笔记</label>
      </div>

      <div class="tm-settings-group">
        <div class="tm-settings-group-title">现实地图 · 行程</div>
        <label class="checkbox_label"><input type="checkbox" data-real-setting="showRoutePois"> 显示沿途地点</label>
        <label class="checkbox_label"><input type="checkbox" data-real-setting="realRouteCurrentOnly"> 只显示当前段的沿途地点</label>
        <label class="checkbox_label"><input type="checkbox" data-real-setting="realRouteSource"> 附带沿途地点的来源资料</label>
        <label class="checkbox_label"><input type="checkbox" data-real-setting="realRouteNote"> 附带沿途地点的笔记</label>
        <label class="tm-row">沿途范围（米）<input type="number" data-real-setting="routePoiRadiusM" min="25" max="500" step="5"></label>
        <label class="tm-row">每段最多地点数<input type="number" data-real-setting="realRouteMax" min="1" max="30" step="1"></label>
      </div>

      <div class="tm-settings-group">
        <div class="tm-settings-group-title">注入深度</div>
        <label class="tm-row">注入深度<input type="number" id="tm-set-depth" min="0" max="10" step="1"></label>
      </div>

      <div class="tm-settings-group">
        <div class="tm-settings-group-title">图层地图 · 所在地点</div>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerSourceAI"> 来源资料进入 AI</label>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerWikiAI"> Wiki 正文进入 AI</label>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerNoteAI"> 笔记进入 AI</label>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerRegionNoteAI"> 区域笔记进入 AI（所在区域和它的上级区域）</label>
        <div class="tm-hint">每个地点的详情里可以单独取消来源资料、Wiki 正文和笔记的 AI 勾选；每个区域的详情里可以单独取消区域笔记。</div>
      </div>

      <div class="tm-settings-group">
        <div class="tm-settings-group-title">图层地图 · 周围地点</div>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerNearbyAI"> 半径圈内地点进入 AI</label>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerNearbyType"> 附带类型</label>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerNearbyDirection"> 附带方位 / 距离</label>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerNearbyCoords"> 附带 XY / 网格坐标</label>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerNearbyNotes"> 附带笔记</label>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerNearbySource"> 附带来源资料</label>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerNearbyWiki"> 附带 Wiki 正文</label>
        <label class="tm-row">最多地点数<input type="number" data-layer-setting="layerNearbyMax" min="1" max="50" step="1"></label>
      </div>

      <div class="tm-settings-group">
        <div class="tm-settings-group-title">图层地图 · 行程</div>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerItineraryPoisShow"> 显示沿途地点、道路和区域</label>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerItineraryPoisCurrentOnly"> 只显示当前所在段的沿途地点、道路和区域</label>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerItineraryPoiSource"> 显示沿途地点来源资料（行程列表和 AI）</label>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerItineraryPoiNotes"> 显示沿途地点笔记（行程列表和 AI）</label>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerItineraryRegionNotes"> 显示经停区域笔记（行程列表和 AI）</label>
        <label class="tm-row">沿途范围
          <input id="tm-set-itinerary-poi-radius" type="number" data-layer-setting="layerItineraryPoiRadius" min="0.1" max="40" step="0.1">
          <span>% 地图宽</span>
        </label>
        <label class="tm-row">每段最多显示
          <input id="tm-set-itinerary-poi-max" type="number" data-layer-setting="layerItineraryPoiMax" min="1" max="30" step="1">
          <span>个地点 / 条道路</span>
        </label>
        <div class="tm-hint">沿途范围也可以在规划行程时用面板滑条或地图上的范围拉手调整，三处是同一个数。行程面板里可以单独关闭本次行程的 AI 发送。</div>
      </div>

      <div class="tm-settings-group">
        <div class="tm-settings-group-title">图层地图 · 道路笔记与来源资料</div>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerRoadNoteNearby"> 当前位置附近道路的笔记（在路上的那条和附近列表里的道路）</label>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerRoadNoteCurrentLeg"> 行程当前段道路的笔记</label>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerRoadNoteAllLegs"> 行程所有段道路的笔记</label>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerRoadSourceAI"> 道路来源资料一起发给 AI（只发上面勾选范围内的道路）</label>
        <div class="tm-hint">一段行程的道路 = 这一段实际走过的路 + 范围内列出的路。同一条路只发一次；每条路的详情里，笔记和来源资料各有一个“给 AI”可以单独取消。</div>
      </div>

      <div class="tm-settings-group">
        <div class="tm-settings-group-title">图层地图 · 收藏地点</div>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerFavoritesAI"> 把收藏地点发给 AI</label>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerFavoriteType"> 附带类型</label>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerFavoriteCoords"> 附带区域 / 坐标</label>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerFavoriteNote"> 附带笔记</label>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerFavoriteSource"> 附带来源资料</label>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerFavoriteWiki"> 附带 Wiki 正文</label>
      </div>

      <div class="tm-settings-group">
        <div class="tm-settings-group-title">显示</div>
        <label class="checkbox_label"><input type="checkbox" data-layer-setting="layerAutoExpandWiki"> 详情中自动展开已抓取 Wiki 正文</label>
      </div>
      <div class="tm-settings-actions">
        <button type="button" id="tm-open">打开地图</button>
        <button type="button" id="tm-clear">清空本聊天地图</button>
        <button type="button" id="tm-preview-settings">预览 AI 上下文</button>
      </div>
      <div class="tm-hint">默认使用 OpenStreetMap / Photon / Overpass / Wikipedia；不需要 API key。</div>
    </div>
  </div>
</div>
`

export class MapUI {
  private ctx: StContext
  private settings: Settings
  private state: MapState

  private map: MapLibreMap | null = null
  private mapStyleReady = false
  private marker: Marker | null = null
  private viewMarker?: Marker
  private resizeObserver: ResizeObserver | null = null
  private refreshTimer: number | undefined
  private settingsTimer: number | undefined
  private noteSaveTimer: number | undefined
  private searchTimer: number | undefined
  private seq = 0
  private wikiSeq = 0
  private fullSeq = 0
  private searchSeq = 0
  private tab: 'nearby' | 'wiki' | 'saved' | 'route' = 'nearby'
  private currentWiki: WikiPage | null = null
  private currentPlace: Place | null = null
  private wikiMode: 'intro' | 'full' = 'intro'
  private wikiFullText: string | null = null
  private fullLoadingKey: string | null = null
  private fullPromise: Promise<void> | null = null
  private wikiLangLinks: Record<string, string> = {}
  private currentRoute: Route | null = null
  private routeMode: RouteProfile = 'foot'
  private routeSeq = 0
  private routePoiSeq = 0
  private draftPoiTimer?: number
  private moveFrame: number | null = null
  private moving = false
  private moveProgress = 0
  private loadingNearby = false
  private loadingWiki = false
  private settingsBound = false
  private searchResults: SearchResult[] = []
  private pois: Poi[] = []
  private poisById = new Map<string, Poi>()
  private loadingPois = false
  private poiSeq = 0
  private suppressFabClick = false
  private routePoiById = new Map<string, RoutePoi>()
  private readonly offs: Array<() => void> = []
  private layerUI: LayerMapUI | null = null
  private windowController: LayerWindowController
  private mapTool: 'browse' | 'move' | 'stop' | 'draw' = 'browse'
  private routeSelection = 0
  private insertStopAt?: number
  private routeRedo: Array<{ stop: RealStop; leg: RealLeg }> = []
  private get pendingGuide(): RoutePoint[] {
    const draft = this.state.routeDraft
    return draft ? (draft.pendingGuide ??= []) : []
  }
  private set pendingGuide(points: RoutePoint[]) {
    if (this.state.routeDraft) this.state.routeDraft.pendingGuide = points
  }
  private positionLookup = 0
  private hiddenPoiCategories = new Set<string>()
  private markerDragging = false
  private routeMarkers: Marker[] = []
  private routeWidthDragging = false
  private routeRunning = false
  private viewRestoring = false

  private panelEl!: HTMLElement
  private canvasEl!: HTMLElement
  private placeNameEl!: HTMLElement
  private placeAddressEl!: HTMLElement
  private statusEl!: HTMLElement
  private listEl!: HTMLElement
  private wikiEl!: HTMLElement
  private wikiTitleEl!: HTMLElement
  private wikiBodyEl!: HTMLElement
  private wikiLinkEl!: HTMLAnchorElement
  private starEl!: HTMLButtonElement
  private previewEl!: HTMLElement
  private previewTextEl!: HTMLElement
  private tokenEstimateEl!: HTMLElement
  private savedCountEl!: HTMLElement
  private searchEl!: HTMLElement
  private searchInputEl!: HTMLInputElement
  private searchResultsEl!: HTMLElement
  private radiusInputEl!: HTMLInputElement
  private radiusValueEl!: HTMLOutputElement
  private poiToggleEl!: HTMLButtonElement
  private wikiLangsEl!: HTMLElement
  private wikiModesEl!: HTMLElement
  private wikiNoteEl!: HTMLTextAreaElement
  private wikiNoteStatusEl!: HTMLElement
  private aiLangEl!: HTMLSelectElement
  private aiLangHintEl!: HTMLElement
  private wikiFullHintEl!: HTMLElement
  private routeCountEl!: HTMLElement
  private recenterEl!: HTMLButtonElement
  private placeEl!: HTMLElement
  private placeTitleEl!: HTMLElement
  private placeSaveEl!: HTMLButtonElement
  private placeMetaEl!: HTMLElement
  private placeInfoEl!: HTMLElement
  private placeNoteEl!: HTMLTextAreaElement
  private placeNoteStatusEl!: HTMLElement
  private placeRouteSummaryEl!: HTMLElement
  private placeRouteTextEl!: HTMLElement
  private placeRouteModeEl!: HTMLSelectElement
  private placeStartEl!: HTMLButtonElement
  private placeStopEl!: HTMLButtonElement
  private placeClearEl!: HTMLButtonElement
  private placeProgressEl!: HTMLElement
  private placeBarEl!: HTMLElement
  private placeRouteStepsEl!: HTMLElement

  private enabledEl!: HTMLInputElement
  private realContextEl!: HTMLInputElement
  private layerContextEl!: HTMLInputElement
  private langEls: HTMLInputElement[] = []
  private radiusEl!: HTMLInputElement
  private nearbyEl!: HTMLInputElement
  private depthEl!: HTMLInputElement

  private readonly onUnload = (): void => this.cleanup()

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    if (this.layerUI?.isOpen()) return
    if (!this.panelEl.hidden && this.mapTool !== 'browse') {
      this.setMapTool('browse')
      return
    }
    const target = event.target as HTMLElement | null
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
    if (!this.previewEl.hidden) {
      this.previewEl.hidden = true
      return
    }
    if (!this.wikiEl.hidden) {
      this.wikiEl.hidden = true
      return
    }
    if (!this.panelEl.hidden) this.closePanel()
  }

  private readonly onDocumentClick = (event: MouseEvent): void => {
    if (!this.searchEl.contains(event.target as Node)) this.hideSearchResults()
  }

  private readonly onWindowResize = (): void => {
    this.clampFab()
  }

  constructor(ctx: StContext) {
    this.ctx = ctx
    this.settings = loadSettings(ctx)
    this.state = loadState(ctx)
    this.state.enabled = this.settings.enabled
    this.restoreStoredRealPosition()
    this.hydrateGlobalNotes()
    this.migrateSavedPlaceNotes()
    this.hydrateRealFavorites()
    this.loadSharedRoute()
    this.loadSharedWiki()
    this.routeMode = this.state.itinerary?.profile ?? 'foot'
    this.restoreRealRoute()
    this.mount()
    this.windowController = new LayerWindowController(
      this.panelEl,
      this.panelEl.querySelector('.tm-head') as HTMLElement,
      { storageKey: MAP_WINDOW_STORAGE_KEY },
    )
    this.currentPlace = this.state.viewedPlace ?? null
    this.applyFabGeometry()
    this.bindEvents()
    this.bindInspectorResize()
    this.sync()
    this.render()
    this.syncRadiusUi()
    this.syncPoiUi()
  }

  private mount(): void {
    if (!document.getElementById(PANEL_ID)) {
      const template = document.createElement('template')
      template.innerHTML = PANEL_HTML.trim()
      document.body.append(template.content)
    }

    this.panelEl = document.getElementById(PANEL_ID) as HTMLElement
    this.canvasEl = document.getElementById('tm-canvas') as HTMLElement
    this.placeNameEl = document.getElementById('tm-place-name') as HTMLElement
    this.placeAddressEl = document.getElementById('tm-place-address') as HTMLElement
    this.statusEl = document.getElementById('tm-status') as HTMLElement
    this.listEl = document.getElementById('tm-list') as HTMLElement
    this.wikiEl = document.getElementById('tm-wiki') as HTMLElement
    this.wikiTitleEl = document.getElementById('tm-wiki-title') as HTMLElement
    this.wikiBodyEl = document.getElementById('tm-wiki-body') as HTMLElement
    this.wikiLinkEl = document.getElementById('tm-wiki-link') as HTMLAnchorElement
    this.starEl = document.getElementById('tm-star') as HTMLButtonElement
    this.previewEl = document.getElementById('tm-preview') as HTMLElement
    this.previewTextEl = document.getElementById('tm-preview-text') as HTMLElement
    this.tokenEstimateEl = document.getElementById('tm-token-estimate') as HTMLElement
    this.savedCountEl = document.getElementById('tm-saved-count') as HTMLElement
    this.searchEl = this.panelEl.querySelector('.tm-search') as HTMLElement
    this.searchInputEl = document.getElementById('tm-search-input') as HTMLInputElement
    this.searchResultsEl = document.getElementById('tm-search-results') as HTMLElement
    this.radiusInputEl = document.getElementById('tm-radius') as HTMLInputElement
    this.radiusValueEl = document.getElementById('tm-radius-value') as HTMLOutputElement
    this.poiToggleEl = document.getElementById('tm-poi-toggle') as HTMLButtonElement
    this.wikiLangsEl = document.getElementById('tm-wiki-langs') as HTMLElement
    this.wikiModesEl = document.getElementById('tm-wiki-modes') as HTMLElement
    this.wikiNoteEl = document.getElementById('tm-wiki-note') as HTMLTextAreaElement
    this.wikiNoteStatusEl = document.getElementById('tm-wiki-note-status') as HTMLElement
    this.aiLangEl = document.getElementById('tm-wiki-ai-lang') as HTMLSelectElement
    this.aiLangHintEl = document.getElementById('tm-ai-lang-hint') as HTMLElement
    this.wikiFullHintEl = document.getElementById('tm-wiki-full-hint') as HTMLElement
    this.routeCountEl = document.getElementById('tm-route-count') as HTMLElement
    this.recenterEl = document.getElementById('tm-recenter') as HTMLButtonElement
    this.placeEl = document.getElementById('tm-place') as HTMLElement
    this.placeTitleEl = document.getElementById('tm-place-title') as HTMLElement
    this.placeSaveEl = document.getElementById('tm-place-save') as HTMLButtonElement
    this.placeMetaEl = document.getElementById('tm-place-meta') as HTMLElement
    this.placeInfoEl = document.getElementById('tm-place-info') as HTMLElement
    this.placeNoteEl = document.getElementById('tm-place-note') as HTMLTextAreaElement
    this.placeNoteStatusEl = document.getElementById('tm-place-note-status') as HTMLElement
    this.placeRouteSummaryEl = document.getElementById('tm-route-summary') as HTMLElement
    this.placeRouteTextEl = document.getElementById('tm-route-text') as HTMLElement
    this.placeRouteModeEl = document.getElementById('tm-place-route-mode') as HTMLSelectElement
    this.placeStartEl = document.querySelector('[data-action="place-start"]') as HTMLButtonElement
    this.placeStopEl = document.querySelector('[data-action="place-stop"]') as HTMLButtonElement
    this.placeClearEl = document.querySelector('[data-action="place-clear-route"]') as HTMLButtonElement
    this.placeProgressEl = document.getElementById('tm-route-progress') as HTMLElement
    this.placeBarEl = document.getElementById('tm-route-bar') as HTMLElement
    this.placeRouteStepsEl = document.getElementById('tm-place-route-steps') as HTMLElement
  }

  private mountSettings(retries = 0): void {
    if (!document.getElementById('tm-settings')) {
      const host = document.getElementById('extensions_settings2')
      if (!host) {
        if (retries < 40) {
          if (this.settingsTimer !== undefined) window.clearTimeout(this.settingsTimer)
          this.settingsTimer = window.setTimeout(() => this.mountSettings(retries + 1), 250)
        } else {
          console.warn('[tavern-map] #extensions_settings2 not found; settings panel not mounted')
        }
        return
      }
      const template = document.createElement('template')
      template.innerHTML = SETTINGS_HTML.trim()
      host.append(template.content)
    }
    this.enabledEl = document.getElementById('tm-set-enabled') as HTMLInputElement
    this.realContextEl = document.getElementById('tm-set-real-context') as HTMLInputElement
    this.layerContextEl = document.getElementById('tm-set-layer-context') as HTMLInputElement
    this.langEls = Array.from(document.querySelectorAll<HTMLInputElement>('#tm-settings [data-tm-lang]'))
    this.radiusEl = document.getElementById('tm-set-radius') as HTMLInputElement
    this.nearbyEl = document.getElementById('tm-set-nearby') as HTMLInputElement
    this.depthEl = document.getElementById('tm-set-depth') as HTMLInputElement
    if (!this.enabledEl) return
    this.writeSettingsToForm()
    this.bindSettings()
  }

  private bindEvents(): void {
    document.getElementById('tm-fab')?.addEventListener('click', () => {
      if (this.suppressFabClick) {
        this.suppressFabClick = false
        return
      }
      this.togglePanel()
    })
    this.panelEl.addEventListener('click', (event) => this.onPanelClick(event))
    this.previewEl.addEventListener('click', (event) => this.onPreviewClick(event))

    this.searchInputEl.addEventListener('input', () => this.onSearchInput())
    this.searchInputEl.addEventListener('keydown', (event) => this.onSearchKeyDown(event))
    this.searchResultsEl.addEventListener('mousedown', (event) => event.preventDefault())
    this.searchResultsEl.addEventListener('click', (event) => this.onSearchResultClick(event))
    this.radiusInputEl.addEventListener('input', () => this.onRadiusInput())
    this.poiToggleEl.addEventListener('click', () => this.togglePoiLayer())
    this.wikiNoteEl.addEventListener('input', () => this.onWikiNoteInput())
    this.wikiNoteEl.addEventListener('change', () => this.flushNoteSave())
    this.placeNoteEl.addEventListener('input', () => this.onPlaceNoteInput())
    this.placeNoteEl.addEventListener('change', () => this.flushNoteSave())
    this.placeRouteModeEl.addEventListener('change', () => this.onPlaceRouteModeChange())
    this.aiLangEl.addEventListener('change', () => void this.onAiLangChange())
    this.recenterEl.addEventListener('click', () => this.recenterOnPerson())
    this.panelEl.addEventListener('change', (event) => this.onPanelChange(event))
    this.panelEl.addEventListener('input', (event) => {
      const input = event.target as HTMLInputElement
      if (input.matches('[data-route-poi-radius]')) this.setRealRouteRadius(input.valueAsNumber, false)
    })

    const eventTypes = this.ctx.eventTypes ?? this.ctx.event_types ?? {}
    this.on(eventTypes.CHAT_CHANGED ?? 'chat_id_changed', () => this.onChatChanged())
    this.on(eventTypes.GENERATION_STARTED ?? 'generation_started', () => this.sync())
    window.addEventListener('beforeunload', this.onUnload)
    document.addEventListener('keydown', this.onKeyDown)
    document.addEventListener('click', this.onDocumentClick)
    window.addEventListener('resize', this.onWindowResize)
    this.offs.push(() => document.removeEventListener('keydown', this.onKeyDown))
    this.offs.push(() => document.removeEventListener('click', this.onDocumentClick))
    this.offs.push(() => window.removeEventListener('resize', this.onWindowResize))

    this.bindFabDrag()
    this.mountSettings()
  }

  private bindSettings(): void {
    if (this.settingsBound || !this.enabledEl) return
    this.settingsBound = true

    this.enabledEl.addEventListener('change', () => this.readSettings())
    this.realContextEl.addEventListener('change', () => {
      if (this.realContextEl.checked) this.layerContextEl.checked = false
      this.readSettings()
    })
    this.layerContextEl.addEventListener('change', () => {
      if (this.layerContextEl.checked) this.realContextEl.checked = false
      this.readSettings()
    })
    const onLanguagesChanged = (): void => {
      const previous = [...this.settings.wikiLangs].sort().join(',')
      this.readSettings()
      const next = [...this.settings.wikiLangs].sort().join(',')
      if (previous === next) return
      const enabled = new Set(this.settings.wikiLangs)
      this.state.wiki = this.state.wiki.filter((candidate) => enabled.has(candidate.lang))
      // Stars and notes are user choices; changing the search languages must
      // not delete them. Only the discovery list is refetched.
      this.commit()
      this.scheduleRefresh(0)
    }
    for (const input of this.langEls) input.addEventListener('change', onLanguagesChanged)
    this.radiusEl.addEventListener('change', () => {
      this.readSettings()
      this.syncRadiusUi()
      this.drawRadius()
      this.scheduleRefresh(0)
    })
    this.nearbyEl.addEventListener('change', () => this.readSettings())
    this.depthEl.addEventListener('change', () => this.readSettings())
    for (const input of document.querySelectorAll<HTMLElement>('#tm-settings [data-layer-setting], #tm-settings [data-real-setting]')) {
      input.addEventListener('change', () => this.readSettings())
    }

    document.getElementById('tm-open')?.addEventListener('click', () => this.openLastMode())
    document.getElementById('tm-clear')?.addEventListener('click', () => this.clearChat())
    document.getElementById('tm-preview-settings')?.addEventListener('click', () => this.preview())
  }

  private on(name: string, handler: (...args: unknown[]) => void): void {
    const source = this.ctx.eventSource
    source.on(name, handler)
    const remove = source.removeListener ?? source.off
    if (remove) this.offs.push(() => remove.call(source, name, handler))
  }

  /**
   * chat_metadata is replaced when the active chat changes. The context object
   * captured at load time can therefore point at the previous chat's metadata;
   * refresh it before reading or writing per-chat state.
   */
  private liveContext(): StContext {
    const api = (window as Window & { SillyTavern?: { getContext?: () => StContext } }).SillyTavern
    try {
      const latest = api?.getContext?.()
      if (latest?.eventSource && latest.extensionSettings) return latest
    } catch (error) {
      console.warn('[tavern-map] could not refresh SillyTavern context', error)
    }
    return this.ctx
  }

  private onPanelClick(event: MouseEvent): void {
    const target = event.target as HTMLElement
    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action
    if (action === 'my-center' || action === 'place-center') {
      if (action === 'my-center') this.recenterOnPerson()
      else if (this.currentPlace) this.map?.easeTo({ center: stopPoint(this.currentPlace), duration: 250 })
      return
    }
    if (action === 'my-move') {
      this.setMapTool(this.mapTool === 'move' ? 'browse' : 'move')
      return
    }
    if (action === 'my-clear') {
      this.clearPosition()
      return
    }
    if (action === 'place-add-stop' && this.currentPlace) {
      const place = this.currentPlace
      this.editRealRoute()
      this.addRealStop(place)
      return
    }
    if (action === 'close') {
      this.closePanel()
      return
    }
    if (action === 'layer-map') {
      this.openLayerMap()
      return
    }
    if (action === 'refresh') {
      void this.refresh()
      return
    }
    if (action === 'preview') {
      this.preview()
      return
    }
    if (action === 'close-wiki') {
      this.wikiEl.hidden = true
      this.state.wikiOpen = false
      saveState(this.ctx, this.state)
      return
    }
    if (action === 'star') {
      void this.toggleStar()
      return
    }
    if (action === 'place-current') {
      if (this.state.place) this.openPlace(this.state.place)
      return
    }
    if (action === 'close-place') {
      this.closePlace()
      return
    }
    if (action === 'place-save') {
      if (this.currentPlace) {
        this.toggleSavedPlace(this.currentPlace)
        this.renderPlace()
      }
      return
    }
    if (action === 'place-route') {
      if (this.currentPlace) {
        const selected = this.placeRouteModeEl.value as RouteProfile
        const mode = ROUTE_MODES.includes(selected) ? selected : this.routeMode
        void this.planRouteTo(this.currentPlace, mode)
      }
      return
    }
    if (action === 'place-go') {
      if (this.currentPlace) {
        void this.moveTo(this.currentPlace.lat, this.currentPlace.lng, true, this.currentPlace)
        this.setStatus(`前往 ${this.currentPlace.name}…`)
      }
      return
    }
    if (action === 'place-clear-route' || action === 'route-clear') {
      this.clearItinerary()
      return
    }
    if (action === 'place-wiki') {
      const place = this.currentPlace
      if (place) {
        this.closePlace()
        this.tab = 'wiki'
        this.render()
        void this.browseWikiAt(place)
      }
      return
    }
    if (action === 'place-itinerary') {
      this.closePlace()
      this.tab = 'route'
      this.render()
      return
    }
    if (action === 'place-start' || action === 'route-start') {
      this.startMovement()
      return
    }
    if (action === 'place-stop' || action === 'route-stop') {
      this.stopMovement()
      return
    }
    if (action === 'route-copy') {
      this.copyItinerary()
      return
    }
    if (action === 'route-replan') {
      this.replanItinerary()
      return
    }

    const tab = target.closest<HTMLElement>('[data-tab]')?.dataset.tab
    if (tab === 'nearby' || tab === 'wiki' || tab === 'saved' || tab === 'route') {
      if (this.currentPlace) this.closePlace()
      if (tab !== 'route' && (this.mapTool === 'draw' || this.mapTool === 'stop')) this.setMapTool('browse')
      this.tab = tab
      this.state.lastTab = tab
      this.drawActiveRoute()
      saveState(this.ctx, this.state)
      this.render()
      return
    }

    const wikiMode = target.closest<HTMLElement>('[data-wiki-mode]')?.dataset.wikiMode
    if (wikiMode === 'intro' || wikiMode === 'full') {
      this.setWikiMode(wikiMode)
      return
    }

    const wikiLang = target.closest<HTMLElement>('[data-wiki-lang]')?.dataset.wikiLang
    if (wikiLang) void this.switchWikiLang(wikiLang)
  }

  private onPanelChange(event: Event): void {
    const target = event.target as HTMLInputElement
    if (target.matches('[data-route-ai]')) {
      if (!this.state.itinerary) return
      this.state.itinerary.showToAI = target.checked
      this.commit()
    } else if (target.matches('[data-route-pois]')) {
      this.settings.showRoutePois = target.checked
      saveSettings(this.ctx, this.settings)
      this.writeRealAiSettingsToForm()
      this.refreshRealRouteRange()
    } else if (target.matches('[data-route-poi-radius]')) {
      this.setRealRouteRadius(target.valueAsNumber, true)
    }
  }

  private refreshRealRouteRange(): void {
    this.routePoiSeq += 1
    this.refreshDraftPois()
    if (this.currentRoute && this.settings.showRoutePois) void this.loadRoutePois(this.currentRoute, this.routeSeq)
    this.drawActiveRoute()
    this.sync()
    this.syncRoutePoiControls()
    if (this.tab === 'route') this.renderList()
  }

  private setRealRouteRadius(radius: number, save: boolean): void {
    if (!Number.isFinite(radius)) return
    this.settings.routePoiRadiusM = Math.max(25, Math.min(500, Math.round(radius / 5) * 5))
    this.updateRouteWidthHandle()
    this.syncRoutePoiControls()
    if (!save) return
    saveSettings(this.ctx, this.settings)
    this.writeRealAiSettingsToForm()
    this.refreshRealRouteRange()
  }

  private onPreviewClick(event: MouseEvent): void {
    const target = event.target as HTMLElement
    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action
    if (action === 'close-preview') {
      this.previewEl.hidden = true
      return
    }
    if (action === 'copy') {
      void this.copyPreview()
    }
  }

  private togglePanel(): void {
    if (this.layerUI?.isOpen()) {
      this.layerUI.close()
      return
    }
    if (this.panelEl.hidden) this.openLastMode()
    else this.closePanel()
  }

  private openLastMode(): void {
    if (this.state.lastMapMode === 'layer') this.openLayerMap()
    else this.openPanel()
  }

  private restoreStoredRealPosition(): void {
    const stored = storedRealPosition(this.ctx)
    if (this.state.positionCleared || !stored || (stored.updatedAt ?? 0) < (this.state.centerUpdatedAt ?? 0)) return
    this.state.center = { lat: stored.lat, lng: stored.lng }
    this.state.centerUpdatedAt = stored.updatedAt
    if (stored.zoom != null) this.state.zoom = stored.zoom
    this.state.view ??= {
      center: { lat: stored.lat, lng: stored.lng },
      zoom: stored.zoom ?? this.state.zoom,
    }
    this.marker?.setLngLat([stored.lng, stored.lat])
  }

  private openPanel(): void {
    if (this.layerUI?.isOpen()) this.layerUI.close()
    this.ctx = this.liveContext()
    this.state.lastMapMode = 'real'
    saveState(this.ctx, this.state)
    this.panelEl.hidden = false
    this.windowController.open()
    this.tab = this.state.lastTab ?? 'nearby'
    this.ensureMap()
    const view = this.state.view
    this.viewRestoring = true
    this.map?.resize()
    this.map?.jumpTo({
      center: view ? [view.center.lng, view.center.lat] : [this.state.center.lng, this.state.center.lat],
      zoom: view?.zoom ?? this.state.zoom,
    })
    this.viewRestoring = false
    this.drawRadius()
    this.drawActiveRoute()
    this.render()
    if (this.state.wikiOpen && this.state.lastWiki) {
      window.setTimeout(() => {
        if (!this.panelEl.hidden) void this.restoreWiki(this.state.lastWiki!)
      }, 120)
    }
    if (!this.pois.length && this.state.place && !this.state.positionCleared && !this.loadingPois) {
      void this.refreshPois(this.state.center.lat, this.state.center.lng)
    }
    const needsInitialData = !this.state.positionCleared && !this.state.place && this.state.nearby.length === 0 && this.state.wiki.length === 0
    if (needsInitialData) {
      window.setTimeout(() => {
        if (!this.panelEl.hidden) void this.refresh()
      }, 150)
    }
  }

  private openLayerMap(): void {
    if (!this.panelEl.hidden) this.rememberRealView()
    if (this.moving) this.stopMovement()
    this.setMapTool('browse')
    this.panelEl.hidden = true
    this.ctx = this.liveContext()
    this.state.lastMapMode = 'layer'
    saveState(this.ctx, this.state)
    if (!this.layerUI) {
      this.layerUI = new LayerMapUI(this.liveContext(), {
        onChange: () => this.sync(),
        onRealMap: () => this.openPanel(),
        onClosed: () => {
          this.state.lastMapMode = 'layer'
          this.ctx = this.liveContext()
          saveState(this.ctx, this.state)
        },
        onSettingsChanged: () => {
          this.settings = loadSettings(this.ctx)
          this.writeSettingsToForm()
          this.sync()
        },
      })
    }
    void this.layerUI.open()
  }

  private closePanel(): void {
    this.rememberRealView()
    if (this.moving) this.stopMovement()
    this.setMapTool('browse')
    this.panelEl.hidden = true
    this.state.lastMapMode = 'real'
    this.state.wikiOpen = !this.wikiEl.hidden
    saveState(this.ctx, this.state)
  }

  private rememberRealView(): void {
    if (!this.map || this.panelEl.hidden || this.viewRestoring) return
    const center = this.map.getCenter()
    this.state.view = { center: { lat: center.lat, lng: center.lng }, zoom: this.map.getZoom() }
  }

  private personMarkerElement(): HTMLElement {
    const element = document.createElement('div')
    element.className = 'tm-person-marker'
    element.title = '你在这里'
    element.innerHTML =
      '<svg viewBox="0 0 24 34" aria-hidden="true"><path d="M12 1C6.5 1 2 5.5 2 11c0 7.6 10 22 10 22s10-14.4 10-22c0-5.5-4.5-10-10-10Z" fill="currentColor"></path><circle cx="12" cy="11" r="3.4" fill="#fff"></circle></svg>'
    return element
  }

  private ensureMap(): void {
    if (this.map) return
    try {
      const view = this.state.view
      this.map = new MapLibreMap({
        container: this.canvasEl,
        style: 'https://tiles.openfreemap.org/styles/liberty',
        center: view ? [view.center.lng, view.center.lat] : [this.state.center.lng, this.state.center.lat],
        zoom: view?.zoom ?? this.state.zoom,
        attributionControl: { compact: true },
        dragRotate: false,
        pitchWithRotate: false,
      })
    } catch (error) {
      console.error('[tavern-map] map initialization failed', error)
      this.canvasEl.textContent = `地图初始化失败：${errorMessage(error)}`
      return
    }

    const map = this.map
    map.touchZoomRotate.disableRotation()
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right')
    this.marker = new Marker({ element: this.personMarkerElement(), draggable: true, anchor: 'bottom' })
      .setLngLat([this.state.center.lng, this.state.center.lat])
      .addTo(map)
    this.marker.getElement().addEventListener('click', (event) => {
      if (this.mapTool !== 'browse' || this.markerDragging || this.moving || !this.state.place) return
      event.stopPropagation()
      this.openPlace(this.state.place)
    })
    this.marker.on('dragstart', () => { this.markerDragging = true })
    this.marker.on('dragend', () => {
      this.markerDragging = false
      if (!this.marker) return
      const position = this.marker.getLngLat().wrap()
      const itinerary = this.state.itinerary
      if (itinerary?.plan && this.currentRoute) {
        const line = this.currentRoute.coordinates
        const nearest = assignRoutePoisToSteps([{ coordinates: line }], [{
          id: 'me', name: '我', lat: position.lat, lng: position.lng,
        }], 25)[0][0]
        const distance = pathLength(line)
        if (nearest?.alongM !== undefined && distance > 0) {
          this.moveProgress = itinerary.progress = Math.min(1, nearest.alongM / distance)
          this.routeSelection = Math.max(0, currentRouteLeg(itinerary))
          this.drawActiveRoute()
        }
      }
      void this.moveTo(position.lat, position.lng)
    })
    map.on('click', (event) => this.clickRealMap(event))
    map.on('move', () => this.updateRouteWidthHandle())
    map.on('moveend', () => {
      const current = this.map
      if (!current || this.panelEl.hidden || this.viewRestoring) return
      this.rememberRealView()
      saveState(this.ctx, this.state)
    })
    map.on('style.load', () => {
      this.mapStyleReady = true
      this.drawRadius()
      this.drawActiveRoute()
      this.updatePoiSource()
    })
    map.once('load', () => this.drawRadius())
    map.once('idle', () => this.drawRadius())
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.panelEl.hidden) this.map?.resize()
    })
    this.resizeObserver.observe(this.canvasEl)
    this.bindRealMapTools()
    this.renderPositionMarker()
    this.renderViewedMarker()
  }

  private drawRadius(): void {
    const map = this.map
    if (!map || !this.mapStyleReady) return
    const data = this.state.positionCleared
      ? { type: 'FeatureCollection' as const, features: [] }
      : circleFeature(this.state.center.lat, this.state.center.lng, this.settings.radiusM)
    const source = map.getSource('tm-radius') as GeoJSONSource | undefined
    if (source) {
      source.setData(data)
      return
    }
    map.addSource('tm-radius', { type: 'geojson', data })
    map.addLayer({
      id: 'tm-radius-fill',
      type: 'fill',
      source: 'tm-radius',
      paint: { 'fill-color': '#e6b56a', 'fill-opacity': 0.10 },
    })
    map.addLayer({
      id: 'tm-radius-line',
      type: 'line',
      source: 'tm-radius',
      paint: {
        'line-color': '#c2410c',
        'line-opacity': 1,
        'line-width': 2.5,
        'line-dasharray': [2, 1.5],
      },
    })
  }

  private poiFeatureCollection(): FeatureCollection<Point> {
    return {
      type: 'FeatureCollection',
      features: this.pois.filter((poi) => !this.hiddenPoiCategories.has(poi.category ?? '其他') &&
        haversine(this.state.center.lat, this.state.center.lng, poi.lat, poi.lng) <= this.settings.radiusM).map((poi) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [poi.lng, poi.lat] },
        properties: {
          id: poi.id,
          name: poi.name,
          nameZh: poi.nameZh ?? '',
          category: poi.category ?? '',
          group: poi.group,
          distanceM: poi.distanceM ?? 0,
          address: poi.address ?? '',
        },
      })),
    }
  }

  private updatePoiSource(): void {
    const map = this.map
    if (!map || !this.mapStyleReady) return
    const data = this.poiFeatureCollection()
    const source = map.getSource('tm-poi') as GeoJSONSource | undefined
    if (source) {
      source.setData(data)
      this.setPoiVisibility()
      return
    }

    const before = map.getLayer('tm-route-line') ? 'tm-route-line' : undefined
    map.addSource('tm-poi', {
      type: 'geojson',
      data,
      cluster: true,
      clusterRadius: 48,
      clusterMaxZoom: 15,
    })
    map.addLayer(
      {
        id: 'tm-poi-cluster',
        type: 'circle',
        source: 'tm-poi',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#e6b56a',
          'circle-radius': ['step', ['get', 'point_count'], 14, 10, 18, 40, 24],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
          'circle-opacity': 0.96,
        },
      },
      before,
    )
    map.addLayer(
      {
        id: 'tm-poi-cluster-count',
        type: 'symbol',
        source: 'tm-poi',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          'text-size': 10,
          'text-font': ['Noto Sans Bold'],
        },
        paint: { 'text-color': '#21180a' },
      },
      before,
    )
    map.addLayer(
      {
        id: 'tm-poi-point',
        type: 'circle',
        source: 'tm-poi',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': [
            'match',
            ['get', 'group'],
            'food',
            '#e67e22',
            'shopping',
            '#8e44ad',
            'culture',
            '#c0392b',
            'nature',
            '#27ae60',
            'transit',
            '#2f80ed',
            'service',
            '#7f8c8d',
            '#34495e',
          ],
          'circle-radius': 6,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.5,
          'circle-opacity': 0.96,
        },
      },
      before,
    )
    map.addLayer(
      {
        id: 'tm-poi-label',
        type: 'symbol',
        source: 'tm-poi',
        filter: ['!', ['has', 'point_count']],
        minzoom: 15,
        layout: {
          'text-field': ['coalesce', ['get', 'nameZh'], ['get', 'name']],
          'text-size': 10,
          'text-font': ['Noto Sans Regular'],
          'text-offset': [0, 1.2],
          'text-anchor': 'top',
          'text-max-width': 10,
        },
        paint: {
          'text-color': '#1f2933',
          'text-halo-color': 'rgba(255,255,255,0.88)',
          'text-halo-width': 1.2,
        },
      },
      before,
    )
    this.setPoiVisibility()
  }

  private setPoiVisibility(): void {
    const map = this.map
    if (!map || !this.mapStyleReady) return
    const visibility = this.settings.showPois ? 'visible' : 'none'
    for (const id of ['tm-poi-cluster', 'tm-poi-cluster-count', 'tm-poi-point', 'tm-poi-label']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility)
    }
  }

  private async refreshPois(lat: number, lng: number): Promise<void> {
    if (this.state.positionCleared) return
    const seq = ++this.poiSeq
    this.loadingPois = true
    this.syncPoiUi()
    try {
      const pois = await fetchPois(lat, lng, this.settings.radiusM)
      if (seq !== this.poiSeq) return
      this.pois = pois.filter((poi) => haversine(lat, lng, poi.lat, poi.lng) <= this.settings.radiusM)
      this.poisById = new Map(pois.map((poi) => [poi.id, poi]))
      this.updatePoiSource()
      this.syncPoiUi()
      saveState(this.ctx, this.state)
      this.sync()
      this.render()
    } catch (error) {
      console.warn('[tavern-map] POI layer failed', errorMessage(error))
    } finally {
      if (seq === this.poiSeq) {
        this.loadingPois = false
        this.syncPoiUi()
      }
    }
  }

  private togglePoiLayer(): void {
    this.settings = { ...this.settings, showPois: !this.settings.showPois }
    saveSettings(this.ctx, this.settings)
    this.setPoiVisibility()
    this.syncPoiUi()
    if (this.settings.showPois) void this.refreshPois(this.state.center.lat, this.state.center.lng)
  }

  private syncPoiUi(): void {
    if (!this.poiToggleEl) return
    this.poiToggleEl.classList.toggle('active', this.settings.showPois)
    this.poiToggleEl.classList.toggle('loading', this.loadingPois)
    this.poiToggleEl.setAttribute('aria-pressed', String(this.settings.showPois))
  }

  private handlePoiMapClick(event: MapMouseEvent): boolean {
    const map = this.map
    if (!map || !this.mapStyleReady) return false
    const layers = ['tm-poi-cluster', 'tm-poi-point', 'tm-poi-label'].filter((id) => map.getLayer(id))
    if (layers.length === 0) return false
    const feature = map.queryRenderedFeatures(event.point, { layers })[0]
    if (!feature) return false
    if (feature.properties?.cluster) {
      const clusterId = Number(feature.properties.cluster_id)
      const source = map.getSource('tm-poi') as GeoJSONSource | undefined
      const geometry = feature.geometry
      if (!source || !Number.isFinite(clusterId) || geometry.type !== 'Point') return true
      const coordinates = geometry.coordinates as [number, number]
      void source
        .getClusterExpansionZoom(clusterId)
        .then((zoom) => map.easeTo({ center: coordinates, zoom }))
        .catch((error) => console.warn('[tavern-map] cluster zoom failed', error))
      return true
    }
    const poi = feature.properties?.id ? this.poisById.get(String(feature.properties.id)) : undefined
    if (poi) {
      this.openPlace(poi)
      return true
    }
    return false
  }

  private async moveTo(lat: number, lng: number, fly = false, place?: Place): Promise<void> {
    if (this.moving) this.stopMovement()
    this.seq += 1
    this.poiSeq += 1
    this.positionLookup += 1
    this.state.positionCleared = false
    this.state.center = { lat, lng }
    this.state.centerUpdatedAt = Date.now()
    this.state.zoom = this.map?.getZoom() ?? this.state.zoom
    this.state.place = place
    this.state.nearby = []
    this.state.wiki = []
    this.pois = []
    this.poisById.clear()
    this.updatePoiSource()
    this.setMapTool('browse')
    this.renderPositionMarker()
    if (fly) {
      this.map?.easeTo({ center: [lng, lat], zoom: Math.max(this.map.getZoom(), 16), duration: 300 })
    }
    this.drawRadius()
    this.commit()
    this.setStatus('正在获取地点信息…')
    this.scheduleRefresh(450)
  }

  private clearPosition(): void {
    if (this.moving) this.stopMovement()
    this.seq += 1
    this.poiSeq += 1
    if (this.refreshTimer !== undefined) window.clearTimeout(this.refreshTimer)
    this.state.positionCleared = true
    this.state.place = undefined
    this.state.nearby = []
    this.state.wiki = []
    this.pois = []
    this.poisById.clear()
    this.loadingNearby = this.loadingWiki = this.loadingPois = false
    this.setMapTool('browse')
    this.renderPositionMarker()
    this.drawRadius()
    this.updatePoiSource()
    this.setStatus('')
    this.commit()
  }

  private renderPositionMarker(): void {
    if (!this.marker || this.markerDragging || this.moving) return
    const element = this.marker.getElement()
    element.hidden = this.state.positionCleared === true
    if (!element.hidden) this.marker.setLngLat([this.state.center.lng, this.state.center.lat])
  }

  private setMapTool(tool: MapUI['mapTool']): void {
    this.mapTool = tool
    if (tool !== 'stop') this.insertStopAt = undefined
    const bar = this.panelEl.querySelector<HTMLElement>('#tm-map-tool')!
    bar.hidden = tool === 'browse'
    bar.replaceChildren()
    if (!bar.hidden) {
      const hint = tool === 'move' ? '点击地图放置“我”' :
        tool === 'stop' ? '点击地图添加经停点' : '点击折点或按住拖画路径'
      bar.append(hint, this.miniButton('退出', () => this.setMapTool('browse')))
    }
    this.map?.dragPan[tool === 'draw' ? 'disable' : 'enable']()
    this.map?.getCanvas().classList.toggle('tm-pick-map', tool !== 'browse')
    this.marker?.setDraggable(tool === 'browse' && !this.moving)
  }

  private clickedPoi(event: MapMouseEvent): Place | undefined {
    const map = this.map
    if (!map || !this.mapStyleReady) return undefined
    const layers = ['tm-route-poi-point', 'tm-poi-point', 'tm-poi-label'].filter((id) => map.getLayer(id))
    if (!layers.length) return undefined
    const id = map.queryRenderedFeatures(event.point, { layers })[0]?.properties?.id
    return id ? this.poisById.get(String(id)) ?? this.routePoiById.get(String(id)) : undefined
  }

  private clickRealMap(event: MapMouseEvent): void {
    const { lat, lng } = event.lngLat.wrap()
    const poi = this.clickedPoi(event)
    if (this.mapTool === 'stop') {
      this.addRealStop(poi ?? { name: `经停点 ${(this.state.routeDraft?.stops.length ?? 0) + 1}`, lat, lng })
      this.setMapTool('browse')
      return
    }
    if (this.mapTool === 'move') {
      void this.moveTo(poi?.lat ?? lat, poi?.lng ?? lng, false, poi)
      return
    }
    if (this.mapTool === 'draw') return
    if (poi) { this.openPlace(poi); return }
    if (this.handlePoiMapClick(event)) return
    const feature = this.map && this.mapStyleReady
      ? this.map.queryRenderedFeatures(event.point).find((item) =>
          !item.layer.id.startsWith('tm-') && (item.properties?.name || item.properties?.['name:en']))
      : undefined
    const current: Place = {
      id: `point:${lat.toFixed(6)},${lng.toFixed(6)}`,
      name: feature?.properties?.name ?? feature?.properties?.['name:en'] ?? `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      lat, lng,
    }
    this.openPlace(current)
    const seq = ++this.positionLookup
    void reverseGeocode(lat, lng).then((place) => {
      if (this.currentPlace !== current || seq !== this.positionLookup) return
      this.openPlace(place)
    }).catch(() => undefined)
  }

  private async browseWikiAt(place: Place): Promise<void> {
    const seq = ++this.wikiSeq
    const pages = await wikiNearby(place.lat, place.lng, Math.max(300, this.settings.radiusM), this.settings.wikiLangs)
    if (seq !== this.wikiSeq || this.tab !== 'wiki') return
    this.renderList()
    this.listEl.replaceChildren()
    for (const candidate of pages) this.listEl.append(this.wikiItem(candidate))
    if (!pages.length) this.listEl.append(this.empty('此地点附近没有维基条目。'))
  }

  private scheduleRefresh(delay = 650): void {
    this.seq += 1
    if (this.refreshTimer !== undefined) window.clearTimeout(this.refreshTimer)
    this.refreshTimer = window.setTimeout(() => void this.refresh(), delay)
  }

  private async refresh(): Promise<void> {
    const seq = ++this.seq
    if (this.state.positionCleared) return
    const { lat, lng } = this.state.center
    type Source = 'place' | 'nearby' | 'wiki'
    const labels: Record<Source, string> = { place: '地点', nearby: '周边', wiki: '维基' }
    const pending = new Set<Source>(['place', 'nearby', 'wiki'])
    const errors: Partial<Record<Source, string>> = {}

    const reportPending = (source: Source): void => {
      pending.delete(source)
      if (seq !== this.seq || pending.size === 0) return
      this.setStatus(`正在获取：${Array.from(pending, (item) => labels[item]).join('、')}…`)
    }

    this.loadingNearby = true
    this.loadingWiki = true
    this.setStatus('正在获取：地点、周边、维基…')
    this.render()
    void this.refreshPois(lat, lng)

    const slowTimer = window.setTimeout(() => {
      if (seq === this.seq && pending.has('nearby')) {
        this.setStatus('周边加载较慢，正在切换备用数据源…')
      }
    }, 4000)

    const placeTask = (this.state.place ? Promise.resolve(this.state.place) : reverseGeocode(lat, lng))
      .then((place) => {
        if (seq !== this.seq) return
        this.state.place ??= place
        this.commit()
      })
      .catch((error) => {
        errors.place = errorMessage(error)
      })
      .finally(() => reportPending('place'))

    const nearbyTask = nearbyPlaces(lat, lng, this.settings.radiusM)
      .then((nearby) => {
        if (seq !== this.seq) return
        this.state.nearby = nearby
        this.commit()
      })
      .catch((error) => {
        errors.nearby = errorMessage(error)
      })
      .finally(() => {
        if (seq === this.seq) {
          this.loadingNearby = false
          window.clearTimeout(slowTimer)
          this.render()
        }
        reportPending('nearby')
      })

    const wikiTask = wikiNearby(lat, lng, Math.max(300, this.settings.radiusM * 2), this.settings.wikiLangs)
      .then((wiki) => {
        if (seq !== this.seq) return
        this.state.wiki = wiki
        this.commit()
      })
      .catch((error) => {
        errors.wiki = errorMessage(error)
      })
      .finally(() => {
        if (seq === this.seq) {
          this.loadingWiki = false
          this.render()
        }
        reportPending('wiki')
      })

    await Promise.allSettled([placeTask, nearbyTask, wikiTask])
    window.clearTimeout(slowTimer)
    if (seq !== this.seq) return

    const failed = Object.entries(errors)
    if (failed.length === 0) {
      this.setStatus('')
    } else {
      const reasons = failed.map(([source, reason]) => `${labels[source as Source]}：${reason}`).join('；')
      this.setStatus(`部分数据获取失败（${failed.length}/3）：${reasons}`)
    }
  }

  private commit(): void {
    this.state.enabled = this.settings.enabled
    saveState(this.ctx, this.state)
    this.sync()
    this.render()
  }

  private activeContextText(): string {
    const real = this.settings.realMapContext ? buildContext(this.state, this.settings, this.nearbyVisible(), this.hiddenPoiCategories) : ''
    const layer = this.settings.layerMapContext
      ? this.layerUI?.contextText() ?? buildLayerContext(loadLayerState(this.liveContext()))
      : ''
    return buildMapContexts(real, layer, this.settings)
  }

  private sync(): void {
    this.state.enabled = this.settings.enabled
    const text = this.activeContextText()
    if (!this.settings.enabled || !text) {
      clearPrompt(this.ctx)
    } else {
      syncPrompt(this.ctx, text, true, this.settings.depth)
    }
    if (this.previewEl && !this.previewEl.hidden) this.preview()
  }

  private render(): void {
    if (!this.panelEl) return
    const placeName = this.state.positionCleared ? undefined : this.state.place?.name
    this.placeNameEl.textContent = placeName
      ? this.state.place?.nameZh
        ? `${placeName} / ${this.state.place.nameZh}`
        : placeName
      : this.state.positionCleared ? '尚未放置' : '地图上的位置'
    this.placeNameEl.title = this.placeNameEl.textContent
    this.panelEl.querySelector('[data-action=my-move]')!.textContent = this.state.positionCleared ? '放置' : '移动'
    const nearbyCount = this.nearbyVisible().length
    const nearbyTab = this.panelEl.querySelector('[data-tab=nearby]')
    if (nearbyTab) nearbyTab.textContent = nearbyCount ? `周边 ${nearbyCount}` : '周边'
    this.renderPoiFilters()
    this.placeAddressEl.textContent = this.state.place?.address ?? ''
    for (const button of this.panelEl.querySelectorAll<HTMLElement>('[data-tab]')) {
      const active = button.dataset.tab === this.tab
      button.classList.toggle('active', active)
      button.setAttribute('aria-selected', String(active))
    }
    this.updateSavedCount()
    this.updateRouteCount()
    this.renderList()
    this.updateStarButton()
    this.syncRoutePoiControls()
  }

  private updateRouteCount(): void {
    if (!this.routeCountEl) return
    this.routeCountEl.textContent = String(this.state.routeDraft?.stops.length ?? this.state.itinerary?.plan?.stops.length ?? (this.state.itinerary ? 2 : 0))
  }

  private updateSavedCount(): void {
    if (!this.savedCountEl) return
    this.savedCountEl.textContent = String(this.state.savedPlaces.length + this.state.stars.length)
  }

  private visibleRouteCandidates(): Place[] {
    return [...this.pois, ...this.state.nearby]
  }

  private nearbyVisible(): Place[] {
    return nearbyPlacesInRange(this.state, this.settings, this.visibleRouteCandidates())
      .filter((place) => !this.hiddenPoiCategories.has(place.category ?? '其他'))
      .slice(0, this.settings.maxNearby)
  }

  private renderPoiFilters(): void {
    const root = this.panelEl.querySelector('#tm-poi-filters')!
    if (root.contains(document.activeElement)) return
    const categories = new Set(this.pois.map((poi) => poi.category ?? '其他'))
    const sorted = [...categories].sort((a, b) => a.localeCompare(b))
    root.replaceChildren(...sorted.map((category) => this.realCheck(
      category,
      !this.hiddenPoiCategories.has(category),
      (checked) => {
        if (checked) this.hiddenPoiCategories.delete(category)
        else this.hiddenPoiCategories.add(category)
        this.updatePoiSource()
        this.render()
        this.drawActiveRoute()
        this.sync()
      },
    )))
  }

  private bindInspectorResize(): void {
    const handle = this.panelEl.querySelector<HTMLElement>('#tm-split')!
    const workspace = handle.parentElement!
    const apply = (x: number, y: number) => {
      const rect = workspace.getBoundingClientRect()
      const compact = this.windowController.isCompact()
      const span = compact ? rect.height : rect.width
      const position = compact ? rect.bottom - y : rect.right - x
      const value = Math.min(span * 0.72, Math.max(Math.min(240, span * 0.46), position))
      workspace.style.setProperty(compact ? '--tm-bottom-size' : '--tm-inspector-size', `${value}px`)
    }
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      handle.setPointerCapture(event.pointerId)
      event.preventDefault()
    })
    handle.addEventListener('pointermove', (event) => {
      if (handle.hasPointerCapture(event.pointerId)) apply(event.clientX, event.clientY)
    })
    handle.addEventListener('keydown', (event) => {
      const delta = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -18 :
        ['ArrowRight', 'ArrowDown'].includes(event.key) ? 18 : 0
      if (delta === 0) return
      event.preventDefault()
      const rect = handle.getBoundingClientRect()
      apply(rect.left + delta, rect.top + delta)
    })
  }

  private routeWidthAnchor(): { x: number; y: number; metresPerPixel: number } | undefined {
    const map = this.map
    const itinerary = this.state.itinerary
    const draft = this.state.routeDraft
    const plan = draft ?? itinerary?.plan
    if (!map || !plan?.legs.length || this.tab !== 'route' || !this.settings.showRoutePois) return undefined
    const active = itinerary ? currentRouteLeg(itinerary) : 0
    const index = draft || !this.settings.realRouteCurrentOnly ? this.routeSelection : active
    if (index < 0) return undefined
    const points = legPath(plan, Math.min(index, plan.legs.length - 1)).map((point) => map.project(point))
    const width = this.canvasEl.clientWidth
    const height = this.canvasEl.clientHeight
    let best: { x: number; y: number; score: number } | undefined
    for (let i = 1; i < points.length; i += 1) {
      const [a, b] = [points[i - 1], points[i]]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const lengthSquared = dx * dx + dy * dy
      if (lengthSquared < 1) continue
      const ratio = Math.max(0, Math.min(1, ((width / 2 - a.x) * dx + (height / 2 - a.y) * dy) / lengthSquared))
      const x = a.x + dx * ratio
      const y = a.y + dy * ratio
      if (x < 12 || y < 65 || x > width - 12 || y > height - 25) continue
      const score = Math.hypot(width / 2 - x, height / 2 - y)
      if (!best || score < best.score) best = { x, y, score }
    }
    if (!best) return undefined
    const [start, end] = [map.unproject([best.x, best.y]), map.unproject([best.x + 10, best.y])]
    const metresPerPixel = haversine(start.lat, start.lng, end.lat, end.lng) / 10
    return { x: best.x, y: best.y, metresPerPixel }
  }

  private updateRouteWidthHandle(): void {
    const map = this.map
    const handle = this.panelEl.querySelector<HTMLElement>('#tm-route-width')!
    if (!map?.getLayer('tm-route-range')) { handle.hidden = true; return }
    const anchor = this.routeWidthAnchor()
    const middle = map.getCenter()
    const metresPerPixel = anchor?.metresPerPixel ?? 156543.03392 * Math.cos(middle.lat * Math.PI / 180) / 2 ** map.getZoom()
    const offset = this.settings.routePoiRadiusM / Math.max(0.001, metresPerPixel)
    map.setPaintProperty('tm-route-range', 'line-width', Math.min(15000, offset * 2))
    handle.hidden = !anchor && !this.routeWidthDragging
    if (!anchor) return
    const width = this.canvasEl.clientWidth
    const side = anchor.x > width / 2 ? -1 : 1
    const x = Math.min(width - 18, Math.max(18, anchor.x + side * Math.max(18, offset)))
    handle.style.left = `${x}px`
    handle.style.top = `${anchor.y}px`
    handle.title = `拖动调整沿途范围 · ${formatRadius(this.settings.routePoiRadiusM)}`
  }

  private bindRealMapTools(): void {
    const map = this.map!
    const handle = this.panelEl.querySelector<HTMLButtonElement>('#tm-route-width')!
    let widthStart: { pointer: number; x: number; radius: number; scale: number; sign: number } | undefined
    handle.addEventListener('pointerdown', (event) => {
      const anchor = this.routeWidthAnchor()
      if (event.button !== 0 || !anchor) return
      this.routeWidthDragging = true
      widthStart = { pointer: event.pointerId, x: event.clientX, radius: this.settings.routePoiRadiusM,
        scale: anchor.metresPerPixel, sign: anchor.x > this.canvasEl.clientWidth / 2 ? -1 : 1 }
      handle.setPointerCapture(event.pointerId)
      event.preventDefault()
    })
    handle.addEventListener('pointermove', (event) => {
      if (!widthStart || event.pointerId !== widthStart.pointer) return
      this.setRealRouteRadius(widthStart.radius + (event.clientX - widthStart.x) * widthStart.scale * widthStart.sign, false)
    })
    const finishWidth = (event: PointerEvent) => {
      if (!widthStart || event.pointerId !== widthStart.pointer) return
      widthStart = undefined
      this.routeWidthDragging = false
      this.setRealRouteRadius(this.settings.routePoiRadiusM, true)
    }
    handle.addEventListener('pointerup', finishWidth)
    handle.addEventListener('pointercancel', finishWidth)
    handle.addEventListener('keydown', (event) => {
      const delta = ['ArrowRight', 'ArrowUp'].includes(event.key) ? 5 : ['ArrowLeft', 'ArrowDown'].includes(event.key) ? -5 : 0
      if (!delta) return
      event.preventDefault()
      this.setRealRouteRadius(this.settings.routePoiRadiusM + delta, true)
    })

    const canvas = map.getCanvas()
    let stroke: { id: number; points: RoutePoint[]; last: [number, number] } | undefined
    const sample = (event: PointerEvent): RoutePoint => {
      const rect = canvas.getBoundingClientRect()
      const point = map.unproject([event.clientX - rect.left, event.clientY - rect.top]).wrap()
      return [point.lng, point.lat]
    }
    const displayStroke = (points: RoutePoint[]) => {
      const data: FeatureCollection<LineString> = { type: 'FeatureCollection',
        features: points.length >= 2 ? [{ type: 'Feature', properties: {},
          geometry: { type: 'LineString', coordinates: points } }] : [] }
      if (!this.mapStyleReady) return
      const source = map.getSource('tm-route-ink') as GeoJSONSource | undefined
      if (source) source.setData(data)
      else {
        map.addSource('tm-route-ink', { type: 'geojson', data })
        map.addLayer({ id: 'tm-route-ink', type: 'line', source: 'tm-route-ink',
          paint: { 'line-color': '#e6b56a', 'line-width': 3 } })
      }
    }
    canvas.addEventListener('pointerdown', (event) => {
      if (this.mapTool !== 'draw' || !event.isPrimary || event.button !== 0 || !this.state.routeDraft) return
      canvas.setPointerCapture(event.pointerId)
      stroke = { id: event.pointerId, points: [sample(event)], last: [event.clientX, event.clientY] }
      event.preventDefault()
    })
    canvas.addEventListener('pointermove', (event) => {
      if (!stroke || stroke.id !== event.pointerId || this.mapTool !== 'draw') return
      if (stroke.points.length >= 500 || Math.hypot(event.clientX - stroke.last[0], event.clientY - stroke.last[1]) < 7) return
      stroke.points.push(sample(event))
      stroke.last = [event.clientX, event.clientY]
      displayStroke(stroke.points)
    })
    canvas.addEventListener('pointerup', (event) => {
      if (!stroke || stroke.id !== event.pointerId) return
      const points = stroke.points
      stroke = undefined
      displayStroke([])
      const draft = this.state.routeDraft
      if (!draft || this.mapTool !== 'draw') return
      const leg = draft.legs[this.routeSelection]
      if (leg) draft.legs[this.routeSelection] = { mode: leg.mode, guide: [...leg.guide, ...points] }
      else this.pendingGuide.push(...points)
      this.updateRouteDraft()
    })
    canvas.addEventListener('pointercancel', () => {
      stroke = undefined
      displayStroke([])
    })
  }

  private renderList(): void {
    if (this.currentPlace) {
      this.placeEl.classList.add('tm-place-inline')
      this.placeEl.hidden = false
      if (this.placeEl.parentElement !== this.listEl) {
        this.listEl.replaceChildren(this.placeEl)
      }
      this.renderPlace()
      return
    }

    const active = document.activeElement
    const activeNote =
      active instanceof HTMLTextAreaElement && active.classList.contains('tm-note-input') && this.listEl.contains(active)
        ? active
        : null
    const noteIndex = activeNote
      ? Array.from(this.listEl.querySelectorAll<HTMLTextAreaElement>('.tm-note-input')).indexOf(activeNote)
      : -1
    const selectionStart = activeNote?.selectionStart ?? 0
    const selectionEnd = activeNote?.selectionEnd ?? 0

    this.listEl.replaceChildren()
    if (this.tab === 'nearby') {
      const places = this.nearbyVisible()
      if (places.length === 0) {
        if (this.loadingNearby || this.loadingPois) {
          this.listEl.append(this.skeleton(), this.skeleton(), this.skeleton())
        } else {
          this.listEl.append(this.empty('附近范围内暂无地点。移动“我”或调整范围后再查看。'))
        }
        return
      }
      for (const place of places) {
        this.listEl.append(this.nearbyItem(place))
      }
      return
    }

    if (this.tab === 'wiki') {
      if (this.state.wiki.length === 0) {
        if (this.loadingWiki) {
          this.listEl.append(this.skeleton(), this.skeleton(), this.skeleton())
        } else {
          this.listEl.append(this.empty('附近没有找到维基条目。可以放大/移动地图后再刷新。'))
        }
        return
      }
      for (const candidate of this.state.wiki) {
        this.listEl.append(this.wikiItem(candidate))
      }
      return
    }

    if (this.tab === 'route') {
      this.renderRouteTab()
      return
    }

    this.renderSavedList()
    if (noteIndex >= 0) {
      const notes = this.listEl.querySelectorAll<HTMLTextAreaElement>('.tm-note-input')
      const next = notes[noteIndex]
      if (next) {
        next.focus()
        next.setSelectionRange(selectionStart, selectionEnd)
      }
    }
  }

  private nearbyItem(place: Place): HTMLElement {
    const row = document.createElement('div')
    row.className = 'tm-item'
    const main = document.createElement('button')
    main.type = 'button'
    main.className = 'tm-item-main'
    main.title = '查看地点详情'
    const name = document.createElement('span')
    name.className = 'tm-item-name'
    name.textContent = place.nameZh ? `${place.name} / ${place.nameZh}` : place.name
    name.title = name.textContent
    const meta = document.createElement('span')
    meta.className = 'tm-item-meta'
    meta.textContent = [place.category, formatDistance(place.distanceM)].filter(Boolean).join(' · ')
    main.append(name, meta)
    main.addEventListener('click', () => this.openPlace(place))

    const save = document.createElement('button')
    save.type = 'button'
    save.className = 'tm-item-save'
    const saved = Boolean(this.findSavedPlace(place))
    save.textContent = saved ? '★' : '☆'
    save.title = saved ? '取消收藏' : '收藏地点'
    save.setAttribute('aria-pressed', String(saved))
    save.addEventListener('click', (event) => {
      event.stopPropagation()
      this.toggleSavedPlace(place)
    })

    const go = document.createElement('button')
    go.type = 'button'
    go.className = 'tm-item-go'
    go.textContent = '移我到这里'
    go.title = '移动到这里'
    go.addEventListener('click', (event) => {
      event.stopPropagation()
      void this.moveTo(place.lat, place.lng, true, place)
    })
    row.append(main, save, go)
    return row
  }

  private wikiItem(candidate: WikiCandidate): HTMLElement {
    const row = document.createElement('div')
    row.className = 'tm-item'
    const main = document.createElement('button')
    main.type = 'button'
    main.className = 'tm-item-main'
    main.title = '查看 Wikipedia 摘要'
    const name = document.createElement('span')
    name.className = 'tm-item-name'
    name.textContent = candidate.title
    const starred = Boolean(this.findStar(candidate))
    const meta = document.createElement('span')
    meta.className = 'tm-item-meta'
    meta.textContent = [`[${langLabel(candidate.lang)}]`, formatDistance(candidate.dist), starred ? '★ 已加入' : '']
      .filter(Boolean)
      .join(' · ')
    main.append(name, meta)
    main.addEventListener('click', () => void this.openWiki(candidate))
    row.append(main)
    return row
  }

  private renderSavedList(): void {
    if (this.state.savedPlaces.length === 0 && this.state.stars.length === 0) {
      this.listEl.append(
        this.empty('还没有收藏。点周边地点的 ☆ 收藏地点，或在 Wiki 里点亮星标；地点笔记可直接在地点详情里写，不要求先收藏。'),
      )
      return
    }

    if (this.state.savedPlaces.length > 0) {
      this.listEl.append(this.sectionTitle('地点', this.state.savedPlaces.length))
      for (const place of this.state.savedPlaces) {
        this.listEl.append(this.savedPlaceItem(place))
      }
    }

    if (this.state.stars.length > 0) {
      this.listEl.append(this.sectionTitle('Wiki', this.state.stars.length))
      for (const page of this.state.stars) {
        this.listEl.append(this.savedWikiItem(page))
      }
    }
  }

  private sectionTitle(text: string, count: number): HTMLElement {
    const element = document.createElement('div')
    element.className = 'tm-section-title'
    const label = document.createElement('span')
    label.textContent = text
    const badge = document.createElement('span')
    badge.textContent = String(count)
    element.append(label, badge)
    return element
  }

  private savedPlaceItem(place: SavedPlace): HTMLElement {
    const card = document.createElement('div')
    card.className = 'tm-saved-card'
    const head = document.createElement('div')
    head.className = 'tm-saved-head'
    const title = document.createElement('button')
    title.type = 'button'
    title.addEventListener('click', () => this.openPlace(place))
    title.className = 'tm-saved-title'
    const name = document.createElement('div')
    name.className = 'tm-saved-name'
    name.textContent = place.nameZh ? `${place.name} / ${place.nameZh}` : place.name
    name.title = name.textContent
    const meta = document.createElement('div')
    meta.className = 'tm-saved-meta'
    meta.textContent = [place.category, place.address].filter(Boolean).join(' · ') || '收藏地点'
    title.append(name, meta)

    const actions = document.createElement('div')
    actions.className = 'tm-saved-actions'
    const detail = this.miniButton('详情', () => this.openPlace(place))
    const go = this.miniButton('移我到这里', () => void this.moveTo(place.lat, place.lng, true, place))
    const remove = this.miniButton('移除', () => {
      this.removeSavedPlace(place)
      this.commit()
      this.toast('已移除收藏地点，地点笔记仍保留')
    })
    actions.append(detail, go, remove)
    head.append(title, actions)

    const note = this.noteInput(this.getPlaceNote(place), (value) => {
      this.setPlaceNote(place, value)
      this.sync()
      this.scheduleNoteSave()
    })
    const filters = document.createElement('div')
    filters.className = 'tm-saved-actions tm-favorite-ai'
    for (const [part, label] of [['source', '来源资料'], ['wiki', 'Wiki 正文'], ['note', '笔记']] as const) {
      const checkbox = this.realPlaceCheck(place, part)
      checkbox.lastChild!.textContent = label
      filters.append(checkbox)
    }
    card.append(head, filters, note)
    return card
  }

  private savedWikiItem(page: StarredWiki): HTMLElement {
    const card = document.createElement('div')
    card.className = 'tm-saved-card'
    const head = document.createElement('div')
    head.className = 'tm-saved-head'
    const title = document.createElement('div')
    title.className = 'tm-saved-title'
    const name = document.createElement('div')
    name.className = 'tm-saved-name'
    const displayLang = page.aiLang || page.lang
    const displayTitle = page.aiTitle || page.title
    name.textContent = `[${langLabel(displayLang)}] ${displayTitle}`
    const meta = document.createElement('div')
    meta.className = 'tm-saved-meta'
    meta.textContent = `Wikipedia · 给 AI ${langLabel(displayLang)} · ${
      page.contextMode === 'full' ? '全文' : '概览'
    }`
    title.append(name, meta)

    const actions = document.createElement('div')
    actions.className = 'tm-saved-actions'
    const open = this.miniButton('打开', () => {
      void this.openWiki({
        pageId: page.pageId,
        title: page.title,
        dist: 0,
        lang: page.lang,
        lat: page.lat,
        lng: page.lng,
      })
    })
    actions.append(open)
    if (typeof page.lat === 'number' && typeof page.lng === 'number') {
      actions.append(this.miniButton('前往', () => void this.moveTo(page.lat!, page.lng!, true)))
    }
    actions.append(
      this.miniButton('移除', () => {
        this.removeStar(page)
        this.saveWikiLibrary()
        this.commit()
        this.toast('已从 AI 上下文移除 Wiki')
      }),
    )
    head.append(title, actions)

    const note = this.noteInput(this.wikiNoteValue(page, page.note), (value) => {
      this.setWikiNote(page, value)
      this.sync()
      this.scheduleNoteSave()
    })
    card.append(head, note)
    return card
  }

  private miniButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'tm-mini-btn'
    button.textContent = label
    button.addEventListener('click', onClick)
    return button
  }

  private noteInput(value: string, onInput: (value: string) => void): HTMLTextAreaElement {
    const textarea = document.createElement('textarea')
    textarea.className = 'tm-note-input'
    textarea.placeholder = '添加自己的笔记…'
    textarea.value = value
    textarea.addEventListener('input', () => {
      onInput(textarea.value)
    })
    textarea.addEventListener('change', () => this.flushNoteSave())
    return textarea
  }

  private openPlace(place: Place): void {
    this.currentPlace = place
    this.state.viewedPlace = place
    this.renderViewedMarker()
    this.wikiEl.hidden = true
    this.state.wikiOpen = false
    saveState(this.ctx, this.state)
    this.placeEl.classList.add('tm-place-inline')
    this.placeEl.hidden = false
    this.render()
  }

  private closePlace(): void {
    this.placeEl.hidden = true
    this.placeEl.classList.remove('tm-place-inline')
    this.currentPlace = null
    delete this.state.viewedPlace
    this.renderViewedMarker()
    saveState(this.ctx, this.state)
    this.render()
  }

  private renderViewedMarker(): void {
    if (!this.map) return
    this.viewMarker?.remove()
    this.viewMarker = undefined
    if (!this.currentPlace) return
    const element = document.createElement('div')
    element.className = 'tm-viewed-marker'
    element.setAttribute('aria-hidden', 'true')
    this.viewMarker = new Marker({ element, anchor: 'center' })
      .setLngLat(stopPoint(this.currentPlace)).addTo(this.map)
  }

  private renderPlace(): void {
    const place = this.currentPlace
    if (!place) return
    const title = place.nameZh ? `${place.name} / ${place.nameZh}` : place.name
    this.placeTitleEl.textContent = title
    this.placeTitleEl.title = title
    this.placeMetaEl.textContent =
      [place.category, formatDistance(place.distanceM), place.address].filter(Boolean).join(' · ') || '地点'
    const saved = this.findSavedPlace(place)
    this.placeSaveEl.textContent = saved ? '★' : '☆'
    this.placeSaveEl.title = saved ? '取消收藏' : '收藏地点'
    this.placeSaveEl.setAttribute('aria-pressed', String(Boolean(saved)))
    const note = this.getPlaceNote(place)
    this.placeNoteEl.disabled = false
    this.placeNoteEl.placeholder = saved
      ? '写下你想让 AI 记住的地点笔记…'
      : '写下地点笔记（不收藏也会保存）…'
    if (document.activeElement !== this.placeNoteEl) this.placeNoteEl.value = note
    this.placeNoteStatusEl.textContent = note || saved ? '自动保存' : ''
    if (this.placeRouteModeEl) this.placeRouteModeEl.value = this.routeMode
    this.renderPlaceInfo(place)
    this.renderPlaceRoute()
  }

  private realCheck(labelText: string, checked: boolean, change: (checked: boolean) => void): HTMLLabelElement {
    const label = document.createElement('label')
    label.className = 'tm-real-check'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = checked
    input.addEventListener('change', () => change(input.checked))
    label.append(input, labelText)
    return label
  }

  private realPlaceCheck(place: Place, part: RealPlacePart): HTMLLabelElement {
    const s = this.settings
    const available = part === 'source'
      ? s.realSourceAI || (s.realNearbyAI && s.realNearbySource) || (s.realFavoritesAI && s.realFavoriteSource) ||
        (s.showRoutePois && s.realRouteSource)
      : part === 'wiki'
        ? s.realWikiAI || (s.realNearbyAI && s.realNearbyWiki) || (s.realFavoritesAI && s.realFavoriteWiki)
        : s.realNoteAI || (s.realNearbyAI && s.realNearbyNotes) || (s.realFavoritesAI && s.realFavoriteNote) ||
          (s.showRoutePois && s.realRouteNote)
    const label = this.realCheck('给 AI', available && realPartAllowed(place, part), (checked) => {
      setRealPart(place, part, checked)
      this.sync()
    })
    label.querySelector('input')!.disabled = !available
    if (!available) label.title = '请在扩展设置打开相应的 AI 内容开关'
    return label
  }

  private appendRealPart(container: HTMLElement, text: string): void {
    if (!text.trim()) return
    const paragraph = document.createElement('p')
    paragraph.className = 'tm-real-part'
    paragraph.textContent = text
    container.append(paragraph)
  }

  private renderPlaceInfo(place: Place): void {
    const key = placeKey(place)
    const section = (name: string, part: RealPlacePart): HTMLElement => {
      const content = document.createElement('section')
      content.className = 'tm-real-content'
      const heading = document.createElement('div')
      heading.className = 'tm-real-content-heading'
      const title = document.createElement('strong')
      title.textContent = name
      heading.append(title, this.realPlaceCheck(place, part))
      content.append(heading)
      return content
    }
    const source = section('来源资料', 'source')
    const sourceText = document.createElement('textarea')
    sourceText.setAttribute('aria-label', '来源资料')
    sourceText.placeholder = '补充来源资料…'
    sourceText.value = realSource(place)
    sourceText.addEventListener('input', () => {
      setGlobalNote(`real-source:${key}`, sourceText.value)
      this.sync()
    })
    source.append(sourceText)
    const links = section('链接来源 / Wiki 正文', 'wiki')
    for (const url of realLinks(place)) {
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.target = '_blank'
      anchor.rel = 'noreferrer'
      anchor.textContent = url.replace(/^https?:\/\//i, '').split('/')[0]
      anchor.title = url
      const row = document.createElement('div')
      row.className = 'tm-saved-actions'
      row.append(anchor)
      const wiki = /^https?:\/\/([a-z-]+)\.wikipedia\.org\/wiki\/([^?#]+)$/i.exec(url)
      if (wiki) row.append(this.miniButton('抓取 Wiki 正文', () => {
        void wikiPageFull(wiki[1], decodeURIComponent(wiki[2]).replaceAll('_', ' ')).then((text) => {
          if (!text.trim()) { this.toast('维基没有返回正文'); return }
          setGlobalNote(`real-wiki:${key}`, text)
          if (this.currentPlace && placeKey(this.currentPlace) === key) this.placeInfoEl.replaceChildren()
          this.sync()
          if (this.currentPlace && placeKey(this.currentPlace) === key) this.renderPlace()
        }).catch((error) => this.toast(`读取 Wiki 失败：${errorMessage(error)}`))
      }))
      links.append(row)
    }
    const add = document.createElement('input')
    add.type = 'url'
    add.placeholder = 'https://…'
    add.setAttribute('aria-label', '添加链接')
    const linkRow = document.createElement('div')
    linkRow.className = 'tm-saved-actions'
    linkRow.append(add, this.miniButton('+ 添加链接', () => {
      try {
        const url = new URL(add.value.trim())
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid URL')
        if (!realLinks(place).includes(url.href)) {
          const previous = globalNote(`real-links:${key}`)
          setGlobalNote(`real-links:${key}`, [previous, url.href].filter(Boolean).join('\n'))
        }
        this.renderPlace()
      } catch { this.toast('请输入有效的 HTTP 或 HTTPS 链接') }
    }))
    links.append(linkRow)
    const wikiText = document.createElement('textarea')
    wikiText.value = realWiki(place)
    wikiText.placeholder = '粘贴 Wiki 正文或来源摘录…'
    wikiText.setAttribute('aria-label', 'Wiki 正文')
    wikiText.addEventListener('input', () => {
      setGlobalNote(`real-wiki:${key}`, wikiText.value)
      this.sync()
    })
    links.append(wikiText)
    if (!this.placeInfoEl.contains(document.activeElement) || this.placeInfoEl.dataset.placeKey !== key) {
      this.placeInfoEl.replaceChildren(source, links)
      this.placeInfoEl.dataset.placeKey = key
    }
    this.placeInfoEl.hidden = false
    this.panelEl.querySelector('#tm-place-note-ai')!.replaceChildren(this.realPlaceCheck(place, 'note'))
  }

  private onPlaceNoteInput(): void {
    const place = this.currentPlace
    if (!place) return
    this.setPlaceNote(place, this.placeNoteEl.value)
    this.sync()
    this.placeNoteStatusEl.textContent = '保存中…'
    this.scheduleNoteSave()
  }

  private itineraryMatches(place: Place): boolean {
    const itinerary = this.state.itinerary
    if (!itinerary) return false
    if (itinerary.to.id && place.id) {
      return (
        placeKey({ id: itinerary.to.id, lat: itinerary.to.lat, lng: itinerary.to.lng }) === placeKey(place)
      )
    }
    return haversine(itinerary.to.lat, itinerary.to.lng, place.lat, place.lng) < 15
  }

  private itineraryText(itinerary: RouteItinerary): string {
    const lines = [
      'Tavern Map 行程',
      `${itinerary.from.name} → ${itinerary.to.name}`,
      formatDistance(itinerary.distance),
    ]
    if (itinerary.plan) {
      const plan = itinerary.plan
      const current = currentRouteLeg(itinerary)
      plan.legs.forEach((leg, index) => {
        lines.push(`${index + 1}. ${plan.stops[index].name} → ${plan.stops[index + 1].name} · ${LEG_MODES[leg.mode]} · ${formatDistance(leg.distance)}`)
        if (leg.fallback) lines.push(`   ${this.legFallback(leg)}`)
        for (const step of leg.steps ?? []) lines.push(`   ${step.instruction}${step.road ? ` · ${step.road}` : ''}`)
        if (!this.settings.showRoutePois || (this.settings.realRouteCurrentOnly && index !== current)) return
        for (const poi of this.legPois(leg)) {
          lines.push(`   - ${poi.name} · 距路线 ${formatDistance(poi.distanceM)}`)
          if (this.settings.realRouteSource && realSource(poi)) lines.push(`     来源资料：${realSource(poi)}`)
          if (this.settings.realRouteNote && realNote(poi)) lines.push(`     笔记：${realNote(poi)}`)
        }
      })
      return lines.join('\n')
    }
    if (itinerary.fallback) lines.push('（路线服务不可用，按直线估计）')
    itinerary.steps.forEach((step, index) => {
      const road = step.road ? ` — ${step.road}` : ''
      const distance = step.distance > 0 ? `（${formatDistance(step.distance)}）` : ''
      lines.push(`${index + 1}. ${step.instruction}${road}${distance}`)
      for (const poi of this.settings.showRoutePois ? step.pois ?? [] : []) {
        const category = poi.category ? `（${poi.category}）` : ''
        const cuisine = poi.cuisine ? ` · ${poi.cuisine}` : ''
        const toLeg = poi.distanceM == null ? '' : ` · 距本段 ${formatDistance(poi.distanceM)}`
        const along = poi.alongM == null ? '' : ` · 距段首 ${formatDistance(poi.alongM)}`
        lines.push(`   - ${poi.name}${category}${cuisine}${toLeg}${along}`)
      }
    })
    return lines.join('\n')
  }

  private copyItinerary(): void {
    const itinerary = this.state.itinerary
    if (!itinerary) {
      this.toast('还没有可复制的行程')
      return
    }
    void navigator.clipboard
      .writeText(this.itineraryText(itinerary))
      .then(() => this.toast('行程已复制'))
      .catch(() => this.toast('复制失败，请手动选择文本'))
  }

  private renderPlaceRoute(): void {
    const itinerary = this.state.itinerary
    const place = this.currentPlace
    const matches = Boolean(place && itinerary && this.itineraryMatches(place))
    this.placeRouteSummaryEl.hidden = !matches
    this.placeClearEl.hidden = !matches
    if (!matches || !itinerary) {
      this.placeStartEl.hidden = true
      this.placeStopEl.hidden = true
      this.placeProgressEl.hidden = true
      this.placeBarEl.style.width = '0%'
      this.placeRouteStepsEl.replaceChildren()
      return
    }
    const fallback = itinerary.fallback ? ' · 直线估计' : ''
    const mode = itinerary.plan ? `${itinerary.plan.legs.length} 段` : ROUTE_MODE_LABELS[itinerary.profile]
    this.placeRouteTextEl.textContent = `${mode} · ${formatDistance(itinerary.distance)}${itinerary.plan ? '' : fallback}`
    this.placeStartEl.hidden = !this.currentRoute || this.moving
    this.placeStopEl.hidden = !this.moving
    this.placeProgressEl.hidden = !this.moving
    this.placeBarEl.style.width = `${Math.round(this.moveProgress * 100)}%`
    if (itinerary.plan) this.placeRouteStepsEl.replaceChildren()
    else this.fillRouteSteps(this.placeRouteStepsEl, itinerary)
    this.syncRoutePoiControls()
    this.syncRouteAiCheckboxes()
  }

  private syncRoutePoiControls(): void {
    if (!this.panelEl) return
    for (const input of this.panelEl.querySelectorAll<HTMLInputElement>('[data-route-pois]')) {
      input.checked = this.settings.showRoutePois
    }
    for (const input of this.panelEl.querySelectorAll<HTMLInputElement>('[data-route-poi-radius]')) {
      input.value = String(this.settings.routePoiRadiusM)
    }
    for (const label of this.panelEl.querySelectorAll<HTMLElement>('[data-route-poi-radius-value]')) {
      label.textContent = `${this.settings.routePoiRadiusM}m`
    }
  }

  private routePoiControls(): HTMLElement {
    const controls = document.createElement('div')
    controls.className = 'tm-route-poi-controls'
    const toggle = document.createElement('label')
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.dataset.routePois = ''
    checkbox.checked = this.settings.showRoutePois
    toggle.append(checkbox, document.createTextNode(' 显示沿途 POI'))
    const radius = document.createElement('label')
    radius.className = 'tm-route-poi-radius'
    radius.append(document.createTextNode('范围 '))
    const range = document.createElement('input')
    range.type = 'range'
    range.min = '25'
    range.max = '500'
    range.step = '5'
    range.dataset.routePoiRadius = ''
    range.value = String(this.settings.routePoiRadiusM)
    range.setAttribute('aria-label', '沿途 POI 范围')
    const value = document.createElement('span')
    value.dataset.routePoiRadiusValue = ''
    value.textContent = `${this.settings.routePoiRadiusM}m`
    radius.append(range, value)
    const current = this.realCheck('只显示当前段', this.settings.realRouteCurrentOnly, (on) => {
      this.settings.realRouteCurrentOnly = on
      saveSettings(this.ctx, this.settings)
      this.writeRealAiSettingsToForm()
      this.sync()
      this.drawActiveRoute()
      this.renderList()
    })
    const limit = document.createElement('label')
    limit.className = 'tm-route-limit'
    const count = document.createElement('input')
    count.type = 'number'
    count.min = '1'
    count.max = '30'
    count.value = String(this.settings.realRouteMax)
    count.setAttribute('aria-label', '每段最多沿途 POI')
    count.addEventListener('change', () => {
      if (!Number.isFinite(count.valueAsNumber)) return
      this.settings.realRouteMax = Math.max(1, Math.min(30, Math.round(count.valueAsNumber)))
      saveSettings(this.ctx, this.settings)
      this.writeRealAiSettingsToForm()
      this.sync()
      this.drawActiveRoute()
      this.renderList()
    })
    limit.append('每段最多 ', count)
    controls.append(toggle, radius, limit, current)
    return controls
  }

  private fillRouteSteps(container: HTMLElement, itinerary: RouteItinerary): void {
    container.replaceChildren()
    itinerary.steps.forEach((step) => {
      const item = document.createElement('li')
      const text = document.createElement('span')
      text.textContent = step.instruction
      item.append(text)
      if (step.road) {
        const road = document.createElement('small')
        road.className = 'tm-route-road'
        road.textContent = step.road
        item.append(road)
      }
      if (step.distance > 0) {
        const distance = document.createElement('em')
        distance.textContent = formatDistance(step.distance)
        item.append(distance)
      }
      if (this.settings.showRoutePois && step.pois?.length) {
        const list = document.createElement('div')
        list.className = 'tm-route-step-pois'
        const buttons: HTMLButtonElement[] = []
        for (const poi of step.pois) {
          const button = document.createElement('button')
          button.type = 'button'
          button.className = 'tm-route-poi'
          const parts = [
            poi.nameZh && poi.nameZh !== poi.name ? `${poi.name} / ${poi.nameZh}` : poi.name,
            poi.category,
            poi.cuisine,
            poi.distanceM == null ? '' : `距本段 ${formatDistance(poi.distanceM)}`,
            poi.alongM == null ? '' : `距段首 ${formatDistance(poi.alongM)}`,
          ].filter(Boolean)
          button.textContent = parts.join(' · ')
          button.addEventListener('click', () => {
            this.openPlace({
              id: poi.id,
              name: poi.name,
              nameZh: poi.nameZh,
              category: poi.category,
              address: poi.address,
              lat: poi.lat,
              lng: poi.lng,
              distanceM: poi.distanceM,
              cuisine: poi.cuisine,
              openingHours: poi.openingHours,
            })
          })
          buttons.push(button)
          list.append(button)
        }
        const visible = 5
        if (buttons.length > visible) {
          buttons.slice(visible).forEach((button) => button.classList.add('tm-route-poi-extra'))
          const more = document.createElement('button')
          more.type = 'button'
          more.className = 'tm-route-poi-more'
          more.textContent = `再显示 ${buttons.length - visible} 个`
          more.addEventListener('click', () => {
            list.classList.add('expanded')
            more.remove()
          })
          list.append(more)
        }
        item.append(list)
      }
      container.append(item)
    })
  }

  private syncRouteAiCheckboxes(): void {
    const checked = Boolean(this.state.itinerary?.showToAI)
    for (const input of this.panelEl.querySelectorAll<HTMLInputElement>('[data-route-ai]')) {
      input.checked = checked
    }
  }

  private onPlaceRouteModeChange(): void {
    const value = this.placeRouteModeEl.value as RouteProfile
    if (!ROUTE_MODES.includes(value)) return
    this.routeMode = value
    if (this.currentPlace) void this.planRouteTo(this.currentPlace, value)
  }

  private fallbackStreet(place: Place): string | undefined {
    const address = this.state.place?.address || place.address || ''
    return address.split(',')[0]?.trim() || undefined
  }

  private isUnnamedRoad(road: string | undefined): boolean {
    return (
      !road ||
      road === '未命名步道' ||
      road === '未命名道路' ||
      /^[A-Z]?\d+[FB]?$/i.test(road.trim())
    )
  }

  /**
   * OSRM's foot profile often snaps to unnamed sidewalks or indoor levels
   * (B2F / B3F). When the path has no real street name, prefer the nearest
   * named step and then the current street.
   */
  private async resolveRouteRoads(steps: RouteStep[], place: Place): Promise<RouteStep[]> {
    // Transit/wait steps intentionally have no road; do not try to invent one.
    if (steps.every((step) => step.road === undefined)) return steps
    const fallback = this.fallbackStreet(place)
    const destinationFallback = place.address?.split(',')[0]?.trim() || undefined
    const names = steps.map((step) => (this.isUnnamedRoad(step.road) ? undefined : step.road))
    const unnamed = steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => step.road !== undefined && this.isUnnamedRoad(step.road))
      .slice(0, 8)

    const streetByIndex = new Map<number, string>()
    // Sequential, small batch: Photon rate-limits parallel reverse bursts.
    for (const { step, index } of unnamed) {
      const coordinates = step.coordinates
      if (!coordinates || coordinates.length === 0) continue
      const middle = coordinates[Math.floor(coordinates.length / 2)]
      const street = await reverseStreet(middle[1], middle[0])
      if (street) streetByIndex.set(index, street)
    }

    return steps.map((step, index) => {
      // Transit and wait steps intentionally have no street name.
      if (step.road === undefined) return step
      if (!this.isUnnamedRoad(step.road)) return step
      let previous: { index: number; name: string } | undefined
      let next: { index: number; name: string } | undefined
      for (let i = index - 1; i >= 0; i -= 1) {
        if (names[i]) {
          previous = { index: i, name: names[i]! }
          break
        }
      }
      for (let i = index + 1; i < names.length; i += 1) {
        if (names[i]) {
          next = { index: i, name: names[i]! }
          break
        }
      }
      const nearest =
        previous && next
          ? index - previous.index <= next.index - index
            ? previous.name
            : next.name
          : previous?.name ?? next?.name
      const streetFallback =
        index === steps.length - 1 ? destinationFallback : index === 0 ? fallback : undefined
      const road =
        index === 0
          ? fallback ?? streetByIndex.get(index) ?? nearest
          : streetByIndex.get(index) ?? streetFallback ?? fallback ?? nearest
      return road ? { ...step, road, name: road } : step
    })
  }

  private async planRouteTo(place: Place, mode: RouteProfile = this.routeMode): Promise<void> {
    if (this.state.positionCleared) {
      this.toast('请先放置“我”，或从地图上选择行程起点')
      this.editRealRoute()
      this.setMapTool('stop')
      return
    }
    if (haversine(this.state.center.lat, this.state.center.lng, place.lat, place.lng) < 5) {
      this.toast('已经在这个地点')
      return
    }
    this.routeMode = mode
    this.state.routeDraft = {
      stops: [this.realStart(), place],
      legs: [{ mode, guide: [] }],
    }
    this.setRouteTab()
    await this.saveRealRoute(true)
  }

  private realStart(): RealStop {
    return { ...this.state.center, id: this.state.place?.id, name: this.state.place?.name ?? '当前位置' }
  }

  private setRouteTab(): void {
    this.closePlace()
    this.tab = 'route'
    this.state.lastTab = 'route'
  }

  private editRealRoute(): void {
    if (this.moving) this.stopMovement()
    if (!this.state.routeDraft) {
      this.state.routeDraft = this.state.itinerary
        ? editableRoute(this.state.itinerary)
        : this.state.positionCleared
          ? { stops: [], legs: [] }
          : { stops: [this.realStart()], legs: [] }
      this.routeSelection = this.state.routeDraft.legs.length
      this.routeRedo = []
    }
    this.setRouteTab()
    this.updateRouteDraft()
  }

  private updateRouteDraft(): void {
    this.routeSeq += 1
    this.routeRunning = false
    this.saveSharedRoute()
    saveState(this.ctx, this.state)
    this.drawActiveRoute()
    this.updateRouteCount()
    this.renderList()
    this.refreshDraftPois()
  }

  private addRealStop(stop: RealStop): void {
    const draft = this.state.routeDraft
    if (!draft) return
    const previous = draft.stops.at(-1)
    if (this.insertStopAt === undefined && previous && haversine(previous.lat, previous.lng, stop.lat, stop.lng) < 1) {
      this.toast('经停点和上一站重合')
      return
    }
    if (this.insertStopAt !== undefined) {
      const index = this.insertStopAt
      const leg = draft.legs[index]
      if (!leg) return
      draft.stops.splice(index + 1, 0, { id: stop.id, name: stop.name, lat: stop.lat, lng: stop.lng })
      const guides: [RoutePoint[], RoutePoint[]] = [[], []]
      let split = 0
      if (leg.guide.length) {
        for (let i = 1; i < leg.guide.length; i += 1) {
          const point = leg.guide[i]
          const nearest = leg.guide[split]
          if (haversine(stop.lat, stop.lng, point[1], point[0]) < haversine(stop.lat, stop.lng, nearest[1], nearest[0])) split = i
        }
        guides[0] = leg.guide.slice(0, split + 1)
        guides[1] = leg.guide.slice(split + 1)
      }
      draft.legs.splice(index, 1, ...guides.map((guide) => ({ mode: leg.mode, guide })))
      this.insertStopAt = undefined
      this.routeRedo = []
      this.routeSelection = index
      this.updateRouteDraft()
      return
    }
    if (previous) draft.legs.push({ mode: 'manual', guide: [...this.pendingGuide] })
    draft.stops.push({ id: stop.id, name: stop.name, lat: stop.lat, lng: stop.lng })
    this.pendingGuide = []
    this.routeRedo = []
    this.routeSelection = draft.legs.length ? draft.legs.length - 1 : 0
    this.updateRouteDraft()
  }

  private undoRealStop(): void {
    const draft = this.state.routeDraft
    if (!draft?.legs.length) return
    this.routeRedo.push({ stop: draft.stops.pop()!, leg: draft.legs.pop()! })
    this.pendingGuide = []
    this.routeSelection = Math.max(0, draft.legs.length - 1)
    this.updateRouteDraft()
  }

  private redoRealStop(): void {
    const draft = this.state.routeDraft
    const next = this.routeRedo.pop()
    if (!draft || !next) return
    draft.stops.push(next.stop)
    draft.legs.push(next.leg)
    this.routeSelection = draft.legs.length - 1
    this.updateRouteDraft()
  }

  private changeRealLeg(index: number, mode: LegMode): void {
    const draft = this.state.routeDraft
    if (!draft || draft.legs[index].mode === mode) return
    draft.legs[index] = { mode, guide: draft.legs[index].guide }
    this.routeSelection = index
    this.updateRouteDraft()
  }

  private async solveRealLeg(draft: RealRouteDraft, index: number, departure?: number): Promise<RealLeg> {
    const leg = draft.legs[index]
    const [from, to] = draft.stops.slice(index, index + 2)
    if (leg.line && !leg.fallback && (leg.mode !== 'transit' || leg.departure === departure)) return leg
    const drawn = [stopPoint(from), ...leg.guide, stopPoint(to)]
    if (leg.mode === 'manual' || leg.mode === 'snap') {
      let matched: RoutePoint[] | undefined
      if (leg.mode === 'snap' && drawn.length >= 3) {
        try { matched = await matchDrawnRoute(drawn) } catch { /* keep the drawn line */ }
      }
      if (leg.mode === 'snap' && drawn.length === 2) {
        const route = await routeBetween(from, to, 'foot')
        if (!route.fallback) matched = [drawn[0], ...route.coordinates, drawn[1]]
      }
      const line = matched ?? drawn
      return {
        ...leg,
        line,
        distance: pathLength(line),
        fallback: leg.mode === 'snap' && !matched,
        steps: [],
      }
    }
    const route = await routeBetween(from, to, leg.mode, departure)
    const place: Place = { ...to, id: to.id ?? `stop:${to.lng},${to.lat}` }
    const steps = await this.resolveRouteRoads(route.steps, place)
    return {
      ...leg,
      line: [stopPoint(from), ...route.coordinates, stopPoint(to)],
      distance: route.distance,
      duration: route.duration,
      fallback: route.fallback,
      departure,
      arrival: route.arrival,
      steps: steps.map((step) => ({
        ...step,
        instruction: step.instruction.replace(/\bSTART\b/g, from.name).replace(/\bEND\b/g, to.name),
      })),
    }
  }

  private async previewRealLeg(): Promise<void> {
    const draft = this.state.routeDraft
    const index = this.routeSelection
    if (!draft?.legs[index] || this.routeRunning) return
    const seq = ++this.routeSeq
    this.routeRunning = true
    this.setStatus('正在计算本段…')
    try {
      const leg = await this.solveRealLeg(draft, index, draft.departure)
      if (seq !== this.routeSeq) return
      draft.legs[index] = leg
      this.setStatus(leg.fallback ? this.legFallback(leg) : '本段预览已更新')
      this.updateRouteDraft()
    } catch (error) {
      if (seq !== this.routeSeq) return
      this.routeRunning = false
      this.setStatus(errorMessage(error))
    }
  }

  private async saveRealRoute(fit = false): Promise<void> {
    const draft = this.state.routeDraft
    if (!draft?.legs.length || this.routeRunning) return
    if (this.pendingGuide.length) {
      this.toast('请为正在画的线添加下一站')
      return
    }
    const seq = ++this.routeSeq
    this.routeRunning = true
    this.setMapTool('browse')
    this.setStatus('正在计算行程…')
    const plan = structuredClone(draft)
    plan.departure ??= Date.now()
    let departure: number | undefined = plan.departure
    try {
      for (let index = 0; index < plan.legs.length; index += 1) {
        const leg = await this.solveRealLeg(plan, index, departure)
        if (seq !== this.routeSeq) return
        plan.legs[index] = leg
        departure = departure !== undefined && leg.duration !== undefined && !leg.fallback
          ? leg.arrival ?? departure + leg.duration * 1000
          : undefined
      }
      this.state.itinerary = {
        from: plan.stops[0],
        to: plan.stops.at(-1)!,
        profile: this.routeMode,
        distance: plan.legs.reduce((total, leg) => total + (leg.distance ?? 0), 0),
        duration: plan.legs.reduce((total, leg) => total + (leg.duration ?? 0), 0),
        fallback: plan.legs.some((leg) => leg.fallback),
        steps: plan.legs.flatMap((leg) => leg.steps ?? []),
        showToAI: this.state.itinerary?.showToAI ?? false,
        updatedAt: Date.now(),
        plan,
        progress: 0,
      }
      this.routeRunning = false
      delete this.state.routeDraft
      this.pendingGuide = []
      this.routeRedo = []
      this.restoreRealRoute()
      this.saveSharedRoute()
      this.commit()
      this.drawActiveRoute(fit)
      this.setStatus(plan.legs.some((leg) => leg.fallback) ? '部分路线使用估算或原线，详见各段' : '')
      if (this.currentRoute) void this.loadRoutePois(this.currentRoute, seq)
    } catch (error) {
      if (seq !== this.routeSeq) return
      this.routeRunning = false
      this.setStatus(`路线规划失败：${errorMessage(error)}`)
    }
  }

  private legFallback(leg: RealLeg): string {
    return leg.mode === 'snap' ? '无法可靠贴合，保留原线' : '导航服务不可用 · 直线估算'
  }

  private saveSharedRoute(): void {
    const itinerary = this.state.itinerary
    const shared = itinerary ? {
      ...itinerary,
      progress: undefined,
      showToAI: false,
    } : undefined
    const record = JSON.stringify({ itinerary: shared, draft: this.state.routeDraft })
    if (globalNote('real-route') !== record) setGlobalNote('real-route', record)
  }

  private loadSharedRoute(): void {
    const stored = globalNote('real-route')
    if (!stored) {
      if (this.state.itinerary || this.state.routeDraft) this.saveSharedRoute()
      return
    }
    try {
      const shared = JSON.parse(stored) as { itinerary?: RouteItinerary; draft?: RealRouteDraft }
      const existing = this.state.itinerary
      const plan = shared.itinerary
      if (plan && existing?.updatedAt === plan.updatedAt) {
        plan.progress = existing.progress
        plan.showToAI = existing.showToAI
      }
      this.state.itinerary = plan
      this.state.routeDraft = shared.draft
    } catch (error) {
      console.warn('[tavern-map] saved route could not be read', error)
    }
  }

  private restoreRealRoute(): void {
    const itinerary = this.state.itinerary
    const plan = itinerary?.plan
    this.moveProgress = itinerary?.progress ?? 0
    this.currentRoute = itinerary && plan?.legs.length ? {
      coordinates: planPath(plan),
      distance: itinerary.distance,
      duration: itinerary.duration,
      profile: itinerary.profile,
      steps: [],
    } : null
  }

  private applyRoutePois(route: Route, pois: RoutePoi[]): void {
    const itinerary = this.state.itinerary
    if (route !== this.currentRoute || !itinerary?.plan || !this.settings.showRoutePois) return
    const plan = itinerary.plan
    this.populateLegPois(plan, pois)
    const steps = plan.legs.flatMap((leg) => leg.steps ?? [])
    const byStep = assignRoutePoisToSteps(steps.map((step) => ({
      coordinates: (step as RouteStep).coordinates,
    })), pois, this.settings.routePoiRadiusM)
    steps.forEach((step, index) => { step.pois = byStep[index] })
    this.saveSharedRoute()
    saveState(this.ctx, this.state)
    this.sync()
    this.drawActiveRoute()
    if (this.tab === 'route' && !this.state.routeDraft) this.renderList()
  }

  private populateLegPois(plan: RealRouteDraft, pois: RoutePoi[]): void {
    const stops = new Set(plan.stops.filter((stop) => stop.id).map((stop) => placeKey(stop)))
    const byDistance: RoutePoi[][] = plan.legs.map(() => [])
    const byLeg = assignRoutePoisToSteps(
      plan.legs.map((_, index) => ({ coordinates: legPath(plan, index) })),
      pois.filter((poi) => !stops.has(placeKey(poi))),
      this.settings.routePoiRadiusM,
      byDistance,
    )
    plan.legs.forEach((leg, index) => {
      leg.pois = byLeg[index]
      leg.poisInRange = byDistance[index]
    })
  }

  private refreshDraftPois(): void {
    if (this.draftPoiTimer !== undefined) window.clearTimeout(this.draftPoiTimer)
    const draft = this.state.routeDraft
    if (!draft?.legs.length || !this.settings.showRoutePois || this.panelEl.hidden) return
    const path = planPath(draft)
    const radius = this.settings.routePoiRadiusM
    const seq = this.routeSeq
    if (path.length < 2) return
    this.draftPoiTimer = window.setTimeout(() => {
      this.draftPoiTimer = undefined
      if (draft !== this.state.routeDraft || this.panelEl.hidden || seq !== this.routeSeq) return
      const local = this.visibleRouteCandidates()
      this.populateLegPois(draft, local)
      this.drawActiveRoute()
      if (this.tab === 'route' && this.mapTool !== 'draw') this.renderList()
      void fetchRoutePois(path, radius).then((fetched) => {
        if (draft !== this.state.routeDraft || seq !== this.routeSeq ||
            radius !== this.settings.routePoiRadiusM || !this.settings.showRoutePois) return
        const candidates = new Map([...local, ...fetched].map((poi) => [placeKey(poi), poi]))
        this.populateLegPois(draft, [...candidates.values()])
        this.drawActiveRoute()
        if (this.tab === 'route' && this.mapTool !== 'draw') this.renderList()
      })
    }, 650)
  }

  private async loadRoutePois(route: Route, seq: number): Promise<void> {
    const loadSeq = ++this.routePoiSeq
    const radius = this.settings.routePoiRadiusM
    if (!this.settings.showRoutePois) return

    // Show POIs already loaded around the current map immediately; the route
    // corridor fetch below is independent of the map radius and can widen it.
    const candidates = this.visibleRouteCandidates()
    const initial = assignRoutePoisToSteps([{ coordinates: route.coordinates }], candidates, radius)[0] ?? []
    this.applyRoutePois(route, initial)

    const fetched = await fetchRoutePois(route.coordinates, radius)
    if (loadSeq !== this.routePoiSeq || seq !== this.routeSeq) return
    let fetchedPois: RoutePoi[] = fetched
    if (fetchedPois.length === 0) {
      let candidates = this.pois
      if (candidates.length === 0 && route.coordinates.length > 0) {
        try {
          const start = route.coordinates[0]
          candidates = await fetchPois(start[1], start[0], Math.max(250, radius))
        } catch (error) {
          console.warn('[tavern-map] route POI fallback failed', errorMessage(error))
        }
      }
      if (loadSeq !== this.routePoiSeq || seq !== this.routeSeq) return
      fetchedPois = filterPoisAlongRoute(route.coordinates, candidates, radius)
    }
    // Union with the immediate map-POI pass: a partial Overpass response must
    // not erase POIs already attached to other steps.
    const merged = new Map<string, RoutePoi>()
    for (const poi of initial) merged.set(placeKey(poi), poi)
    for (const poi of fetchedPois) merged.set(placeKey(poi), poi)
    const pois = [...merged.values()]
    if (pois.length > 0 || initial.length === 0) {
      this.applyRoutePois(route, pois)
    }
  }

  private drawActiveRoute(fit = false): void {
    const map = this.map
    if (!map || this.panelEl.hidden || !this.mapStyleReady) return
    const draft = this.state.routeDraft
    const itinerary = this.state.itinerary
    const plan = draft ?? itinerary?.plan
    const features: Array<Feature<LineString>> = []
    const showRange = this.settings.showRoutePois && (this.tab === 'route' || Boolean(draft))
    const active = itinerary ? currentRouteLeg(itinerary) : 0
    plan?.legs.forEach((leg, index) => {
      features.push({
        type: 'Feature',
        properties: {
          color: leg.mode === 'manual' ? '#e6b56a' : leg.mode === 'snap' ? '#93d6a9' : '#64c8ed',
          dash: Boolean(leg.fallback || (!leg.line && leg.mode !== 'manual')),
          range: showRange && (draft || !this.settings.realRouteCurrentOnly || index === active) ? 1 : 0,
          selected: draft && index === this.routeSelection ? 1 : 0,
        },
        geometry: { type: 'LineString', coordinates: legPath(plan, index) },
      })
    })
    if (draft && this.pendingGuide.length && draft.stops.length) {
      features.push({
        type: 'Feature',
        properties: { color: '#e6b56a', dash: true, range: 0, selected: 1 },
        geometry: { type: 'LineString', coordinates: [stopPoint(draft.stops.at(-1)!), ...this.pendingGuide] },
      })
    }
    const data: FeatureCollection<LineString> = { type: 'FeatureCollection', features }
    const source = map.getSource(ROUTE_SOURCE) as GeoJSONSource | undefined
    if (source) source.setData(data)
    else {
      map.addSource(ROUTE_SOURCE, { type: 'geojson', data })
      map.addLayer({
        id: 'tm-route-range', type: 'line', source: ROUTE_SOURCE,
        filter: ['==', ['get', 'range'], 1],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#e9bf68', 'line-opacity': 0.14, 'line-width': 0 },
      })
      for (const dash of [false, true]) {
        map.addLayer({
          id: dash ? 'tm-route-dashed' : 'tm-route-line', type: 'line', source: ROUTE_SOURCE,
          filter: ['==', ['get', 'dash'], dash],
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': ['get', 'color'],
            'line-width': ['case', ['==', ['get', 'selected'], 1], 6, 4],
            ...(dash ? { 'line-dasharray': [2, 2] } : {}),
          },
        })
      }
    }
    this.routeMarkers.forEach((marker) => marker.remove())
    this.routeMarkers = []
    if (plan && (this.tab === 'route' || draft)) {
      plan.stops.forEach((stop, index) => {
        const button = this.miniButton(String(index + 1), () => undefined)
        button.className = 'tm-route-stop-pin'
        button.title = stop.name
        button.addEventListener('click', (event) => {
          event.stopPropagation()
          this.routeSelection = Math.min(index, Math.max(0, plan.legs.length - 1))
          this.selectRealLeg(this.routeSelection)
        })
        const marker = new Marker({ element: button, draggable: Boolean(draft) })
          .setLngLat(stopPoint(stop)).addTo(map)
        if (draft) marker.on('dragend', () => {
          if (this.state.routeDraft !== draft) return
          const point = marker.getLngLat().wrap()
          draft.stops[index] = { name: stop.name, lat: point.lat, lng: point.lng }
          for (const legIndex of [index - 1, index]) {
            const leg = draft.legs[legIndex]
            if (leg) draft.legs[legIndex] = { mode: leg.mode, guide: leg.guide }
          }
          this.routeRedo = []
          this.updateRouteDraft()
        })
        this.routeMarkers.push(marker)
      })
      if (draft) this.addGuideHandles(draft, map)
    }
    this.drawRoutePois(plan, Boolean(draft), showRange, active)
    this.updateRouteWidthHandle()
    const points = plan ? planPath(plan) : []
    if (!fit || !points.length) return
    const lons = points.map(([lng]) => lng)
    const lats = points.map(([, lat]) => lat)
    map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], {
      padding: 55, maxZoom: 17, duration: 300,
    })
  }

  private legPois(leg: RealLeg, scoped = this.settings.realRouteCurrentOnly): RoutePoi[] {
    return itineraryLegPois(leg, scoped).filter((poi) => !this.hiddenPoiCategories.has(poi.category ?? '其他'))
      .slice(0, this.settings.realRouteMax)
  }

  private drawRoutePois(plan: RealRouteDraft | undefined, drafting: boolean, visible: boolean, active: number): void {
    const map = this.map!
    this.routePoiById.clear()
    if (visible) plan?.legs.forEach((leg, index) => {
      if (!drafting && this.settings.realRouteCurrentOnly && active !== index) return
      for (const poi of this.legPois(leg, !drafting && this.settings.realRouteCurrentOnly)) this.routePoiById.set(poi.id, poi)
    })
    const data: FeatureCollection<Point> = { type: 'FeatureCollection', features: [...this.routePoiById.values()].map((poi) => ({
      type: 'Feature', properties: { id: poi.id }, geometry: { type: 'Point', coordinates: [poi.lng, poi.lat] },
    })) }
    const source = map.getSource('tm-route-pois') as GeoJSONSource | undefined
    if (source) source.setData(data)
    else {
      map.addSource('tm-route-pois', { type: 'geojson', data })
      map.addLayer({ id: 'tm-route-poi-point', type: 'circle', source: 'tm-route-pois',
        paint: { 'circle-radius': 6, 'circle-color': '#eed293', 'circle-opacity': 0.35,
          'circle-stroke-color': '#f4cc79', 'circle-stroke-width': 1.5 } })
    }
  }

  private addGuideHandles(draft: RealRouteDraft, map: MapLibreMap): void {
    const leg = draft.legs[this.routeSelection]
    if (!leg || (leg.mode !== 'manual' && leg.mode !== 'snap')) return
    leg.guide.forEach((point, index) => {
      if (index % Math.ceil(leg.guide.length / 35) !== 0) return
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'tm-route-guide-pin'
      button.setAttribute('aria-label', `线形调整点 ${index + 1}`)
      const marker = new Marker({ element: button, draggable: true }).setLngLat(point).addTo(map)
      marker.on('dragend', () => {
        const position = marker.getLngLat().wrap()
        leg.guide[index] = [position.lng, position.lat]
        draft.legs[this.routeSelection] = { mode: leg.mode, guide: leg.guide }
        this.updateRouteDraft()
      })
      this.routeMarkers.push(marker)
    })
  }

  private clearRouteLine(): void {
    this.routeMarkers.forEach((marker) => marker.remove())
    this.routeMarkers = []
    this.routePoiById.clear()
    this.currentRoute = null
    const source = this.map?.getSource(ROUTE_SOURCE) as GeoJSONSource | undefined
    source?.setData({ type: 'FeatureCollection', features: [] })
    const poiSource = this.map?.getSource('tm-route-pois') as GeoJSONSource | undefined
    poiSource?.setData({ type: 'FeatureCollection', features: [] })
    this.panelEl.querySelector<HTMLElement>('#tm-route-width')!.hidden = true
  }

  private clearItinerary(): void {
    if (this.moving) this.stopMovement()
    this.routeSeq += 1
    this.routeRunning = false
    delete this.state.itinerary
    delete this.state.routeDraft
    this.pendingGuide = []
    this.routeRedo = []
    this.moveProgress = 0
    this.clearRouteLine()
    this.setMapTool('browse')
    this.saveSharedRoute()
    this.commit()
  }

  private replanItinerary(): void {
    const itinerary = this.state.itinerary
    if (!itinerary) return
    this.editRealRoute()
    const draft = this.state.routeDraft!
    draft.departure = Date.now()
    draft.legs = draft.legs.map((leg) => ({ mode: leg.mode, guide: leg.guide }))
    void this.saveRealRoute(true)
  }

  private selectRealLeg(index: number): void {
    this.routeSelection = index
    this.drawActiveRoute()
    this.renderList()
  }

  private renderRouteTab(): void {
    const draft = this.state.routeDraft
    const itinerary = this.state.itinerary
    const plan = draft ?? itinerary?.plan
    this.listEl.replaceChildren()
    const card = document.createElement('div')
    card.className = 'tm-itinerary-card'
    const head = document.createElement('div')
    head.className = 'tm-itinerary-head'
    const title = document.createElement('strong')
    title.textContent = draft ? '行程编辑' : '行程'
    head.append(title)
    card.append(head)
    if (draft) {
      head.append(
        this.miniButton('撤销上一站', () => this.undoRealStop()),
        this.miniButton('重做', () => this.redoRealStop()),
        this.miniButton('保存', () => void this.saveRealRoute()),
        this.miniButton('取消', () => {
          delete this.state.routeDraft
          this.pendingGuide = []
          this.routeRedo = []
          this.setMapTool('browse')
          this.updateRouteDraft()
        }),
      )
      const buttons = head.querySelectorAll('button')
      buttons[0].disabled = !draft.legs.length
      buttons[1].disabled = !this.routeRedo.length
      buttons[2].disabled = !draft.legs.length
      const tools = document.createElement('div')
      tools.className = 'tm-saved-actions'
      tools.append(
        this.miniButton('浏览', () => this.setMapTool('browse')),
        this.miniButton('画下一段', () => {
          if (!draft.stops.length) { this.setMapTool('stop'); return }
          this.routeSelection = draft.legs.length
          this.setMapTool('draw')
          this.renderList()
        }),
        this.miniButton('+ 地图经停点', () => this.setMapTool('stop')),
      )
      if (this.pendingGuide.length) tools.append(this.miniButton('撤销折点', () => {
        this.pendingGuide.pop()
        this.updateRouteDraft()
      }))
      card.append(tools)
    } else if (itinerary) {
      head.append(
        this.miniButton('编辑行程', () => this.editRealRoute()),
        this.miniButton('复制', () => this.copyItinerary()),
        this.miniButton('清除', () => this.clearItinerary()),
      )
      const actions = document.createElement('div')
      actions.className = 'tm-saved-actions'
      if (this.moving) actions.append(this.miniButton('暂停', () => this.stopMovement()))
      else if (this.currentRoute && this.moveProgress < 1) actions.append(
        this.miniButton(this.moveProgress > 0 ? '继续移动' : '开始移动', () => this.startMovement()),
        this.miniButton('前往下一站', () => this.goToNextRealStop()),
      )
      if (!this.currentRoute || this.moveProgress >= 1) {
        actions.append(this.miniButton('重新规划', () => this.replanItinerary()))
      }
      const ai = this.realCheck('给 AI', itinerary.showToAI, (on) => {
        itinerary.showToAI = on
        this.commit()
      })
      actions.append(ai)
      const summary = document.createElement('p')
      const duration = itinerary.duration > 0
        ? ` · 约 ${formatDurationShort(itinerary.duration)}${plan?.legs.some((leg) => leg.duration === undefined) ? '（已估时的段）' : ''}`
        : ''
      const active = currentRouteLeg(itinerary)
      const position = plan && active >= 0 && this.moveProgress > 0 ? ` · 第 ${active + 1}/${plan.legs.length} 段`
        : this.moveProgress >= 1 ? ' · 已到达' : ''
      summary.textContent = `${formatDistance(itinerary.distance)}${duration}${position}`
      card.append(summary, actions)
      if (this.moveProgress > 0 || this.moving) {
        const progress = document.createElement('div')
        progress.className = 'tm-route-progress'
        progress.setAttribute('aria-label', '行程进度')
        const bar = document.createElement('div')
        bar.className = 'tm-route-bar'
        bar.style.width = `${Math.round(this.moveProgress * 100)}%`
        progress.append(bar)
        card.append(progress)
      }
    } else {
      head.append(this.miniButton('新建行程', () => this.editRealRoute()))
    }
    if (draft || itinerary) card.append(this.routePoiControls())
    if (plan) {
      const stops = document.createElement('ol')
      stops.className = 'tm-real-route-stops'
      plan.stops.forEach((stop, index) => {
        const row = document.createElement('li')
        row.append(this.miniButton(stop.name, () => this.map?.easeTo({ center: stopPoint(stop), duration: 250 })))
        const leg = plan.legs[index]
        if (leg) row.append(this.realLegRow(plan, index, Boolean(draft)))
        stops.append(row)
      })
      card.append(stops)
    } else if (itinerary) {
      const steps = document.createElement('ol')
      steps.className = 'tm-route-steps'
      this.fillRouteSteps(steps, itinerary)
      card.append(steps)
    }
    this.listEl.append(card)
  }

  private realLegRow(plan: RealRouteDraft, index: number, editing: boolean): HTMLElement {
    const leg = plan.legs[index]
    const row = document.createElement('div')
    row.className = 'tm-real-leg'
    row.classList.toggle('active', this.routeSelection === index)
    const label = this.miniButton(`${LEG_MODES[leg.mode]} · ${formatDistance(leg.distance ?? pathLength(legPath(plan, index)))}`, () => this.selectRealLeg(index))
    row.append(label)
    if (editing) {
      const mode = document.createElement('select')
      mode.setAttribute('aria-label', `第 ${index + 1} 段方式`)
      for (const [value, name] of Object.entries(LEG_MODES)) mode.add(new Option(name, value))
      mode.value = leg.mode
      mode.addEventListener('change', () => this.changeRealLeg(index, mode.value as LegMode))
      row.append(mode)
      if (this.routeSelection === index && (leg.mode === 'manual' || leg.mode === 'snap')) {
        row.append(this.miniButton('重画本段', () => {
          plan.legs[index] = { mode: leg.mode, guide: [] }
          this.setMapTool('draw')
          this.updateRouteDraft()
        }))
      }
      if (this.routeSelection === index) row.append(this.miniButton('插入经停点', () => {
        this.insertStopAt = index
        this.setMapTool('stop')
      }))
      if (this.routeSelection === index && leg.mode !== 'manual') {
        row.append(this.miniButton('预览本段', () => void this.previewRealLeg()))
      }
    }
    if (leg.fallback) row.append(this.empty(this.legFallback(leg)))
    if (leg.mode === 'transit' && leg.line && leg.departure === undefined && index > 0) {
      row.append(this.empty('前段耗时未定，本段班次以查询时间为准'))
    }
    if (this.routeSelection !== index) return row
    if (leg.steps?.length) {
      const list = document.createElement('ol')
      list.className = 'tm-route-steps'
      for (const step of leg.steps) {
        const item = document.createElement('li')
        item.textContent = [step.instruction, step.road, step.distance > 0 ? formatDistance(step.distance) : ''].filter(Boolean).join(' · ')
        list.append(item)
      }
      row.append(list)
    }
    const itinerary = this.state.itinerary
    if (this.settings.showRoutePois && (editing || !this.settings.realRouteCurrentOnly ||
        (itinerary && currentRouteLeg(itinerary) === index)) && this.legPois(leg, !editing && this.settings.realRouteCurrentOnly).length) {
      const list = document.createElement('div')
      list.className = 'tm-route-step-pois'
      for (const poi of this.legPois(leg, !editing && this.settings.realRouteCurrentOnly)) {
        const button = this.miniButton(`${poi.name} · 距路线 ${formatDistance(poi.distanceM)}`, () => this.openPlace(poi))
        list.append(button)
        if (this.settings.realRouteSource) this.appendRealPart(list, realSource(poi))
        if (this.settings.realRouteNote) this.appendRealPart(list, realNote(poi))
      }
      row.append(list)
    }
    return row
  }

  private startMovement(targetProgress = 1): void {
    const route = this.currentRoute
    const itinerary = this.state.itinerary
    if (!route || !itinerary || this.moving || this.state.routeDraft) return
    const coordinates = route.coordinates
    const fromProgress = itinerary.progress ?? 0
    if (coordinates.length < 2 || targetProgress <= fromProgress) return
    this.moving = true
    this.setMapTool('browse')
    this.state.positionCleared = false
    if (this.marker) this.marker.getElement().hidden = false
    this.moveProgress = fromProgress
    this.placeStartEl.hidden = true
    this.placeStopEl.hidden = false
    this.placeProgressEl.hidden = false
    this.updateRouteBars(fromProgress)
    const cumulative: number[] = [0]
    for (let index = 1; index < coordinates.length; index += 1) {
      const [lng1, lat1] = coordinates[index - 1]
      const [lng2, lat2] = coordinates[index]
      cumulative.push(cumulative[index - 1] + haversine(lat1, lng1, lat2, lng2))
    }
    const total = cumulative.at(-1) || route.distance || 1
    const duration = Math.min(10000, Math.max(1400, total * (targetProgress - fromProgress) * 8))
    const started = performance.now()
    let previousLeg = currentRouteLeg(itinerary)
    let distanceAtStop = 0
    const stopThresholds = itinerary.plan
      ? itinerary.plan.legs.map((_, index) => {
          distanceAtStop += pathLength(legPath(itinerary.plan!, index))
          return distanceAtStop / total
        })
      : []
    const tick = (now: number): void => {
      if (!this.moving) return
      const fraction = Math.min(1, (now - started) / duration)
      const progress = fromProgress + (targetProgress - fromProgress) * fraction
      this.moveProgress = itinerary.progress = progress
      const point = this.interpolateRoute(coordinates, cumulative, total * progress)
      this.marker?.setLngLat(point)
      this.updateRouteBars(progress)
      this.setStatus(`移动中… ${formatDistance(total * progress)} / ${formatDistance(total)}`)
      if (fraction >= 1) {
        this.stopMovement(targetProgress >= 1 ? itinerary.to : this.nextStopAt(targetProgress))
        return
      }
      const activeLeg = stopThresholds.findIndex((threshold) => progress < threshold)
      if (activeLeg !== previousLeg) {
        previousLeg = activeLeg
        this.routeSelection = Math.max(0, activeLeg)
        this.state.center = { lng: point[0], lat: point[1] }
        this.state.place = undefined
        this.state.nearby = []
        this.pois = []
        this.poisById.clear()
        this.updatePoiSource()
        this.drawRadius()
        this.sync()
        this.drawActiveRoute()
        if (this.tab === 'route') this.renderList()
      }
      this.moveFrame = window.requestAnimationFrame(tick)
    }
    this.moveFrame = window.requestAnimationFrame(tick)
    if (this.tab === 'route') this.renderList()
    else this.renderPlace()
  }

  private nextStopAt(progress: number): RealStop | undefined {
    const plan = this.state.itinerary?.plan
    if (!plan) return undefined
    const target = pathLength(planPath(plan)) * progress
    let length = 0
    for (let index = 0; index < plan.legs.length; index += 1) {
      length += pathLength(legPath(plan, index))
      if (Math.abs(length - target) < 0.1) return plan.stops[index + 1]
    }
    return undefined
  }

  private goToNextRealStop(): void {
    const itinerary = this.state.itinerary
    const plan = itinerary?.plan
    if (!itinerary || !plan) return
    const legIndex = currentRouteLeg(itinerary)
    if (legIndex < 0) return
    const full = pathLength(planPath(plan))
    const end = plan.legs.slice(0, legIndex + 1).reduce((length, _, index) => length + pathLength(legPath(plan, index)), 0)
    if (full > 0) this.startMovement(Math.min(1, end / full))
  }

  private interpolateRoute(
    coordinates: Array<[number, number]>,
    cumulative: number[],
    target: number,
  ): [number, number] {
    for (let index = 1; index < coordinates.length; index += 1) {
      if (target <= cumulative[index]) {
        const span = cumulative[index] - cumulative[index - 1] || 1
        const ratio = (target - cumulative[index - 1]) / span
        const [lng1, lat1] = coordinates[index - 1]
        const [lng2, lat2] = coordinates[index]
        return [lng1 + (lng2 - lng1) * ratio, lat1 + (lat2 - lat1) * ratio]
      }
    }
    return coordinates[coordinates.length - 1]
  }

  private updateRouteBars(progress: number): void {
    for (const bar of this.panelEl.querySelectorAll<HTMLElement>('.tm-route-bar')) {
      bar.style.width = `${Math.round(progress * 100)}%`
    }
  }

  private stopMovement(destination?: RealStop): void {
    if (!this.moving) return
    this.moving = false
    if (this.moveFrame !== null) window.cancelAnimationFrame(this.moveFrame)
    this.moveFrame = null
    const current = destination ?? this.marker?.getLngLat().wrap()
    if (current) {
      const place = destination?.id ? { ...destination, id: destination.id } : undefined
      void this.moveTo(current.lat, current.lng, false, place)
    }
    this.drawActiveRoute()
    this.setStatus(destination ? `已到达 ${destination.name}` : '行程已暂停')
    this.renderPlace()
    if (this.tab === 'route') this.renderList()
  }

  private recenterOnPerson(): void {
    const map = this.map
    if (!map) return
    if (this.state.positionCleared) {
      this.setMapTool('move')
      return
    }
    map.easeTo({
      center: [this.state.center.lng, this.state.center.lat],
      zoom: Math.max(this.state.view?.zoom ?? this.state.zoom, 15),
    })
  }

  private empty(text: string): HTMLElement {
    const element = document.createElement('div')
    element.className = 'tm-empty'
    element.textContent = text
    return element
  }

  private skeleton(): HTMLElement {
    const element = document.createElement('div')
    element.className = 'tm-skeleton'
    const a = document.createElement('div')
    a.className = 'tm-skeleton-line w60'
    const b = document.createElement('div')
    b.className = 'tm-skeleton-line w30'
    element.append(a, b)
    return element
  }

  private onSearchInput(): void {
    const query = this.searchInputEl.value
    if (this.searchTimer !== undefined) window.clearTimeout(this.searchTimer)
    if (query.trim().length < 2) {
      this.hideSearchResults()
      return
    }
    this.searchTimer = window.setTimeout(() => void this.runSearch(query), 300)
  }

  private onSearchKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      const first = this.searchResults[0]
      if (first) this.selectSearchResult(first)
      return
    }
    if (event.key === 'Escape') {
      event.stopPropagation()
      this.hideSearchResults()
      this.searchInputEl.blur()
    }
  }

  private async runSearch(query: string): Promise<void> {
    const seq = ++this.searchSeq
    this.renderSearchMessage('搜索中…')
    try {
      const near = this.state.place ?? this.state.center
      const results = await searchPlaces(query, near)
      if (seq !== this.searchSeq) return
      this.searchResults = results
      this.renderSearchResults(results)
    } catch (error) {
      if (seq !== this.searchSeq) return
      this.searchResults = []
      this.renderSearchMessage(`搜索失败：${errorMessage(error)}`)
    }
  }

  private onSearchResultClick(event: MouseEvent): void {
    const target = event.target as HTMLElement
    const index = target.closest<HTMLElement>('[data-search-index]')?.dataset.searchIndex
    if (index == null) return
    const result = this.searchResults[Number(index)]
    if (result) this.selectSearchResult(result)
  }

  private renderSearchResults(results: SearchResult[]): void {
    this.searchResultsEl.replaceChildren()
    if (results.length === 0) {
      this.renderSearchMessage('没有找到匹配的地点')
      return
    }
    results.forEach((result, index) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'tm-search-result'
      button.dataset.searchIndex = String(index)
      button.setAttribute('role', 'option')
      const name = document.createElement('span')
      name.className = 'tm-search-result-name'
      name.textContent = result.nameZh ? `${result.name} / ${result.nameZh}` : result.name
      const meta = document.createElement('span')
      meta.className = 'tm-search-result-meta'
      meta.textContent = [
        result.resultType,
        result.distanceM == null ? '' : formatDistance(result.distanceM),
        result.address,
      ]
        .filter(Boolean)
        .join(' · ')
      button.append(name, meta)
      this.searchResultsEl.append(button)
    })
    this.searchResultsEl.hidden = false
  }

  private renderSearchMessage(message: string): void {
    this.searchResultsEl.replaceChildren()
    const element = document.createElement('div')
    element.className = 'tm-search-empty'
    element.textContent = message
    this.searchResultsEl.append(element)
    this.searchResultsEl.hidden = false
  }

  private hideSearchResults(): void {
    this.searchResultsEl.hidden = true
    this.searchResultsEl.replaceChildren()
    this.searchResults = []
  }

  private selectSearchResult(result: SearchResult): void {
    this.hideSearchResults()
    this.searchInputEl.value = result.name
    this.searchInputEl.blur()
    const map = this.map
    if (map) {
      if (result.bounds) {
        map.fitBounds(
          [
            [result.bounds[0], result.bounds[1]],
            [result.bounds[2], result.bounds[3]],
          ],
          { padding: 30, maxZoom: 14, duration: 600 },
        )
      } else {
        map.flyTo({ center: [result.lng, result.lat], zoom: zoomForSearchType(result.resultType), duration: 600 })
      }
    }
    this.openPlace(result)
  }

  private onRadiusInput(): void {
    const raw = Number(this.radiusInputEl.value)
    const value = Number.isFinite(raw) ? Math.min(1000, Math.max(25, Math.round(raw))) : this.settings.radiusM
    this.settings = { ...this.settings, radiusM: value }
    this.seq += 1
    this.poiSeq += 1
    this.updatePoiSource()
    this.render()
    this.sync()
    saveSettings(this.ctx, this.settings)
    this.radiusValueEl.textContent = formatRadius(value)
    if (this.radiusEl) this.radiusEl.value = String(value)
    this.drawRadius()
    this.scheduleRefresh(500)
  }

  private syncRadiusUi(): void {
    if (!this.radiusInputEl) return
    this.radiusInputEl.value = String(this.settings.radiusM)
    this.radiusValueEl.textContent = formatRadius(this.settings.radiusM)
    if (this.radiusEl) this.radiusEl.value = String(this.settings.radiusM)
  }

  private loadSharedWiki(): void {
    const stored = globalNote('real-wiki-library')
    const legacy = this.state.stars
    if (!stored && !legacy.length) return
    try {
      const library = stored ? JSON.parse(stored) as { stars: StarredWiki[]; migrated: string[] }
        : { stars: [], migrated: [] }
      const known = new Set(library.migrated)
      for (const star of legacy) {
        const identity = wikiKey(star.lang, star.pageId)
        if (known.has(identity)) continue
        known.add(identity)
        if (!library.stars.some((item) => wikiKey(item.lang, item.pageId) === identity)) library.stars.push(star)
      }
      this.state.stars = library.stars
      for (const star of this.state.stars) star.note = this.wikiNoteValue(star, star.note)
      this.saveWikiLibrary([...known])
    } catch (error) {
      console.warn('[tavern-map] Wiki collection could not be read', error)
    }
  }

  private saveWikiLibrary(migrated?: string[]): void {
    const stored = globalNote('real-wiki-library')
    const known = new Set(migrated ?? (stored ? (JSON.parse(stored) as { migrated: string[] }).migrated : []))
    if (!stored && !this.state.stars.length) return
    for (const star of this.state.stars) known.add(wikiKey(star.lang, star.pageId))
    const stars = this.state.stars.map((star) => ({ ...star, note: '' }))
    const next = JSON.stringify({ stars, migrated: [...known] })
    if (stored !== next) setGlobalNote('real-wiki-library', next)
  }

  private saveWikiState(): void {
    this.saveWikiLibrary()
    saveState(this.ctx, this.state)
  }

  private placeNoteKey(place: Place): string {
    return `place:${placeKey(place)}`
  }

  private wikiNoteKey(page: { lang?: string; pageId?: number; title?: string }): string {
    const lang = page.lang || 'en'
    const identity =
      page.pageId && page.pageId > 0
        ? String(page.pageId)
        : (page.title || '').trim().toLowerCase()
    return `wiki:${lang}:${identity}`
  }

  private wikiNoteValue(
    page: { lang?: string; pageId?: number; title?: string },
    fallback?: string,
  ): string {
    const key = this.wikiNoteKey(page)
    const global = globalNote(key)
    if (global !== undefined) return global
    if (fallback?.trim()) {
      setGlobalNote(key, fallback)
      return fallback
    }
    return ''
  }

  private setWikiNote(
    page: { lang?: string; pageId?: number; title?: string; note?: string },
    value: string,
  ): void {
    setGlobalNote(this.wikiNoteKey(page), value)
    page.note = value
  }

  private hydrateGlobalNotes(): void {
    const notes = this.state.placeNotes ?? (this.state.placeNotes = {})
    for (const [key, entry] of Object.entries(notes)) {
      const global = globalNote(`place:${key}`)
      if (global !== undefined) entry.note = global
      else if (entry.note.trim()) setGlobalNote(`place:${key}`, entry.note)
    }
    for (const place of this.state.savedPlaces) {
      const key = this.placeNoteKey(place)
      const global = globalNote(key)
      if (global !== undefined) place.note = global
      else if (place.note.trim()) setGlobalNote(key, place.note)
    }
    for (const star of this.state.stars) {
      const key = this.wikiNoteKey(star)
      const global = globalNote(key)
      if (global !== undefined) star.note = global
      else if (star.note.trim()) setGlobalNote(key, star.note)
    }
    if (this.state.place) {
      const note = this.getPlaceNote(this.state.place)
      const key = placeKey(this.state.place)
      if (note.trim()) {
        notes[key] = {
          note,
          name: this.state.place.name,
          nameZh: this.state.place.nameZh,
          lat: this.state.place.lat,
          lng: this.state.place.lng,
          updatedAt: Date.now(),
        }
      }
    }
    void flushGlobalNotes()
  }

  private migrateSavedPlaceNotes(): void {
    for (const place of this.state.savedPlaces) {
      this.preservePlaceNote(place, place.note)
    }
  }

  private preservePlaceNote(place: Place, note: string): void {
    if (!note.trim()) return
    const notes = this.state.placeNotes ?? (this.state.placeNotes = {})
    const key = placeKey(place)
    const globalKey = this.placeNoteKey(place)
    if (globalNote(globalKey) !== undefined) return
    setGlobalNote(globalKey, note)
    if (notes[key]) return
    notes[key] = {
      note,
      name: place.name,
      nameZh: place.nameZh,
      lat: place.lat,
      lng: place.lng,
      updatedAt: Date.now(),
    }
  }

  private hydrateRealFavorites(): void {
    for (const place of this.state.savedPlaces) {
      const key = realFavoriteKey(placeKey(place))
      if (globalNote(`real-favorite-migrated:${key}`) !== undefined) continue
      if (!findFavorite(key)) {
        setFavorite({ ...place, key, kind: 'real', markerId: place.id }, true)
      }
      setGlobalNote(`real-favorite-migrated:${key}`, '1')
    }
    this.state.savedPlaces = listFavorites().flatMap((favorite) =>
      favorite.kind === 'real' && favorite.lat != null && favorite.lng != null
        ? [{
            ...favorite, id: favorite.markerId ?? favorite.key,
            lat: favorite.lat, lng: favorite.lng,
            note: this.getPlaceNote({
              ...favorite, id: favorite.markerId ?? favorite.key, lat: favorite.lat, lng: favorite.lng,
            }),
          }]
        : [],
    )
  }

  private removeSavedPlace(place: Place): void {
    this.preservePlaceNote(place, this.getPlaceNote(place))
    const key = realFavoriteKey(placeKey(place))
    setGlobalNote(`real-favorite-migrated:${key}`, '1')
    removeFavorite(key)
    this.state.savedPlaces = this.state.savedPlaces.filter((item) => placeKey(item) !== placeKey(place))
  }

  private findSavedPlace(place: Place): SavedPlace | undefined {
    const key = placeKey(place)
    return this.state.savedPlaces.find((item) => placeKey(item) === key)
  }

  private getPlaceNote(place: Place): string {
    const key = this.placeNoteKey(place)
    const global = globalNote(key)
    if (global !== undefined) return global
    const entry = this.state.placeNotes?.[placeKey(place)]
    const legacy = entry?.note ?? this.findSavedPlace(place)?.note ?? ''
    if (legacy.trim()) setGlobalNote(key, legacy)
    return legacy
  }

  private setPlaceNote(place: Place, value: string): void {
    const key = placeKey(place)
    setGlobalNote(this.placeNoteKey(place), value)
    const notes = this.state.placeNotes ?? (this.state.placeNotes = {})
    if (value.trim()) {
      notes[key] = {
        note: value,
        name: place.name,
        nameZh: place.nameZh,
        lat: place.lat,
        lng: place.lng,
        updatedAt: Date.now(),
      }
    } else {
      delete notes[key]
    }
    const saved = this.findSavedPlace(place)
    if (saved) saved.note = value
  }

  private toggleSavedPlace(place: Place): void {
    const key = realFavoriteKey(placeKey(place))
    if (this.findSavedPlace(place)) {
      this.removeSavedPlace(place)
      this.toast('已取消收藏，笔记已保留')
    } else {
      setFavorite({ ...place, key, kind: 'real', markerId: place.id, savedAt: Date.now() })
      setGlobalNote(`real-favorite-migrated:${key}`, '1')
      this.hydrateRealFavorites()
      this.toast('已收藏地点')
    }
    this.commit()
    if (this.currentPlace) this.renderPlace()
  }

  /**
   * The same Wikipedia article has different titles/pageIds per language.
   * `wikiLangLinks` is the bridge; only use it while the page being queried is
   * the currently open article, otherwise a saved card could match a different
   * article that happens to share a title.
   */
  private articleTitles(page: { lang?: string; title?: string }): Map<string, string> {
    const known = new Map<string, string>()
    const lang = page.lang || 'en'
    const title = page.title?.trim().toLowerCase()
    if (!title) return known
    known.set(lang, title)
    const current = this.currentWiki
    if (
      current &&
      (current.lang || 'en') === lang &&
      current.title.trim().toLowerCase() === title
    ) {
      for (const [linkLang, linkTitle] of Object.entries(this.wikiLangLinks)) {
        if (typeof linkTitle === 'string' && linkTitle.trim()) {
          known.set(linkLang, linkTitle.trim().toLowerCase())
        }
      }
    }
    return known
  }

  private articleMatches(
    page: { lang: string; pageId: number; title?: string },
    star: StarredWiki,
  ): boolean {
    const known = this.articleTitles(page)
    const starLang = star.lang ?? 'en'
    const starTitle = star.title.trim().toLowerCase()
    if (known.get(starLang) === starTitle) return true
    return starLang === (page.lang || 'en') && star.pageId === page.pageId
  }

  private findArticleStars(page: {
    lang: string
    pageId: number
    title?: string
  }): StarredWiki[] {
    return this.state.stars.filter((star) => this.articleMatches(page, star))
  }

  private findStar(page: { lang: string; pageId: number; title?: string }): StarredWiki | undefined {
    const lang = page.lang || 'en'
    const title = page.title?.trim().toLowerCase()
    if (title) {
      const byTitle = this.state.stars.find(
        (item) => (item.lang ?? 'en') === lang && item.title.trim().toLowerCase() === title,
      )
      if (byTitle) return byTitle
    }
    const byId = this.state.stars.find(
      (item) => wikiKey(item.lang ?? 'en', item.pageId) === wikiKey(lang, page.pageId),
    )
    if (byId) return byId
    return this.state.stars.find((item) => this.articleMatches(page, item))
  }

  private reconcileStars(page: WikiPage): StarredWiki | undefined {
    const matches = this.findArticleStars(page)
    if (matches.length === 0) return undefined
    const pageLang = page.lang || 'en'
    const pageTitle = page.title.trim().toLowerCase()
    const primary =
      matches.find(
        (item) =>
          (item.lang ?? 'en') === pageLang &&
          item.title.trim().toLowerCase() === pageTitle,
      ) ??
      matches.find((item) => item.pageId === page.pageId) ??
      matches[0]

    let changed = false
    for (const other of matches) {
      if (other === primary) continue
      if (other.note) {
        const notes = [primary.note, other.note].map((note) => note.trim()).filter(Boolean)
        primary.note = Array.from(new Set(notes)).join('\n')
      }
      if (!primary.aiLang && other.aiLang) {
        primary.aiLang = other.aiLang
        primary.aiTitle = other.aiTitle
        primary.aiExtract = other.aiExtract
        primary.aiFullText = other.aiFullText
      }
      if (
        !primary.fullText &&
        other.fullText &&
        (other.lang ?? 'en') === (primary.lang ?? 'en')
      ) {
        primary.fullText = other.fullText
      }
      if (other.contextMode === 'full' && primary.contextMode !== 'full') {
        primary.contextMode = 'full'
      }
      this.state.stars = this.state.stars.filter((item) => item !== other)
      changed = true
    }

    const languageChanged =
      (primary.lang ?? 'en') !== pageLang ||
      primary.title.trim().toLowerCase() !== pageTitle
    if (languageChanged || primary.pageId !== page.pageId || primary.url !== page.url) {
      primary.lang = pageLang
      primary.title = page.title
      primary.pageId = page.pageId
      primary.url = page.url
      primary.lat = page.lat
      primary.lng = page.lng
      primary.extract = page.extract
      if (languageChanged) primary.fullText = undefined
      changed = true
    } else if (page.extract && primary.extract !== page.extract) {
      primary.extract = page.extract
      changed = true
    }

    if (changed) {
      this.sync()
      this.saveWikiState()
    }
    return primary
  }

  private removeStar(page: { lang?: string; pageId?: number; title: string }): void {
    const known = this.articleTitles(page)
    const lang = page.lang || 'en'
    const title = page.title.trim().toLowerCase()
    this.state.stars = this.state.stars.filter((item) => {
      if (known.get(item.lang ?? 'en') === item.title.trim().toLowerCase()) return false
      if ((item.lang ?? 'en') === lang && item.title.trim().toLowerCase() === title) return false
      if (page.pageId != null && wikiKey(item.lang ?? 'en', item.pageId) === wikiKey(lang, page.pageId)) {
        return false
      }
      return true
    })
  }

  private async openWiki(candidate: WikiCandidate, mode: 'intro' | 'full' = 'intro'): Promise<void> {
    const seq = ++this.wikiSeq
    this.wikiEl.hidden = false
    this.placeEl.hidden = true
    this.currentPlace = null
    this.wikiMode = mode
    this.wikiFullText = null
    this.wikiLangLinks = {}
    this.currentWiki = null
    this.wikiTitleEl.textContent = `[${langLabel(candidate.lang)}] ${candidate.title}`
    this.wikiBodyEl.textContent = '加载中…'
    this.wikiLinkEl.hidden = true
    this.starEl.disabled = true
    this.wikiNoteEl.value = ''
    this.wikiNoteEl.disabled = true
    this.wikiNoteStatusEl.textContent = ''
    this.renderWikiToolbar()
    this.renderAiLang()
    this.render()
    await this.loadWikiCandidate(candidate, seq, true)
  }

  private async restoreWiki(ref: WikiRef): Promise<void> {
    await this.openWiki(
      { pageId: ref.pageId, title: ref.title, dist: 0, lang: ref.lang, lat: ref.lat, lng: ref.lng },
      this.state.lastWikiMode ?? 'intro',
    )
  }

  private async loadWikiCandidate(candidate: WikiCandidate, seq: number, preserveMode: boolean): Promise<void> {
    const key = wikiCacheKey(candidate.lang, candidate.title)
    let page = await cacheGet<WikiPage>(key)
    const cachedUsable =
      page &&
      typeof page.fetchedAt === 'number' &&
      typeof page.extract === 'string' &&
      typeof page.url === 'string' &&
      typeof page.lang === 'string'

    if (!cachedUsable || Date.now() - page!.fetchedAt > WIKI_TTL_MS) {
      try {
        page = await wikiPage(candidate)
        await cachePut(key, page)
      } catch (error) {
        if (!page) {
          if (seq === this.wikiSeq) {
            this.wikiBodyEl.textContent = `加载失败：${errorMessage(error)}`
            this.starEl.disabled = true
          }
          return
        }
        this.toast('网络不可用，显示本地缓存')
      }
    }

    if (seq !== this.wikiSeq) return
    if (!page) {
      this.wikiBodyEl.textContent = '加载失败：没有可用的 Wiki 数据'
      this.starEl.disabled = true
      return
    }

    if (!preserveMode) this.wikiMode = 'intro'
    this.wikiFullText = null
    this.currentWiki = page
    const star = this.reconcileStars(page)
    if (star) {
      this.wikiMode = star.contextMode ?? 'intro'
      if (this.wikiMode === 'full' && star.fullText) this.wikiFullText = star.fullText
      if (
        this.wikiMode === 'full' &&
        star.aiLang &&
        star.aiLang !== page.lang &&
        !star.aiFullText
      ) {
        void this.ensureAiFullText(star)
      }
    }
    this.state.lastWiki = {
      lang: page.lang,
      pageId: page.pageId,
      title: page.title,
      lat: page.lat,
      lng: page.lng,
    }
    this.state.wikiOpen = true
    this.state.lastWikiMode = this.wikiMode
    this.saveWikiState()
    this.renderWikiPage()
    void this.loadWikiLangLinks(page, seq)
  }

  private async loadWikiLangLinks(page: WikiPage, seq: number): Promise<void> {
    const targets = WIKI_LANGS.filter((lang) => lang !== page.lang)
    try {
      const links = await wikiLangLinks(page.lang, page.title, targets)
      if (seq !== this.wikiSeq) return
      this.wikiLangLinks = { [page.lang]: page.title, ...links }
    } catch (error) {
      console.warn('[tavern-map] langlinks failed', errorMessage(error))
      if (seq === this.wikiSeq) this.wikiLangLinks = { [page.lang]: page.title }
    }
    if (seq === this.wikiSeq) {
      this.reconcileStars(page)
      this.renderWikiToolbar()
      this.renderWikiNote()
      this.renderAiLang()
      this.updateStarButton()
    }
  }

  private renderWikiPage(): void {
    const page = this.currentWiki
    if (!page) return
    this.wikiTitleEl.textContent = `[${langLabel(page.lang)}] ${page.title}`
    this.renderWikiToolbar()
    this.renderWikiBody()
    this.wikiLinkEl.href = page.url
    this.wikiLinkEl.hidden = false
    const starred = Boolean(this.findStar(page))
    this.starEl.disabled = !page.extract && !starred
    this.updateStarButton()
    this.renderWikiNote()
    this.renderAiLang()
  }

  private renderWikiBody(): void {
    const page = this.currentWiki
    if (!page) return
    if (this.wikiMode === 'intro') {
      this.wikiBodyEl.textContent = page.extract || '（这个条目没有可用的纯文本正文）'
      return
    }
    if (this.wikiFullText !== null) {
      this.wikiBodyEl.textContent = this.wikiFullText || '（全文为空）'
      return
    }
    this.wikiBodyEl.textContent = '正在加载全文…'
    void this.loadFullText()
  }

  private setWikiMode(mode: 'intro' | 'full'): void {
    if (this.wikiMode === mode) return
    this.wikiMode = mode
    this.state.lastWikiMode = mode
    const current = this.currentWiki
    if (current) {
      const star = this.findStar(current)
      if (star) {
        star.contextMode = mode
        if (mode === 'full' && this.wikiFullText) star.fullText = this.wikiFullText
        if (mode === 'full' && star.aiLang && star.aiLang !== current.lang) {
          void this.ensureAiFullText(star)
        }
        this.sync()
      }
    }
    this.saveWikiState()
    this.renderWikiToolbar()
    this.updateStarButton()
    this.renderWikiBody()
  }

  private async loadFullText(): Promise<void> {
    const page = this.currentWiki
    if (
      !page ||
      this.wikiMode !== 'full' ||
      (this.wikiFullText !== null && this.wikiFullText.length > 0)
    ) {
      return
    }
    if (this.wikiFullText !== null) this.wikiFullText = null
    const key = wikiFullCacheKey(page.lang, page.title)
    if (this.fullLoadingKey === key && this.fullPromise) {
      await this.fullPromise
      return
    }
    this.fullLoadingKey = key
    const seq = ++this.fullSeq
    const task = (async () => {
      try {
        this.wikiBodyEl.textContent = '正在加载全文…'
        const cached = await cacheGet<string>(key)
        if (seq !== this.fullSeq || this.currentWiki !== page || this.wikiMode !== 'full') {
          this.fallbackFullStar(page)
          return
        }
        if (typeof cached === 'string' && cached.length > 0) {
          this.wikiFullText = cached
          this.rememberFullText(page)
          this.renderWikiBody()
          return
        }
        try {
          const text = await wikiPageFull(page.lang, page.title)
          if (!text.trim()) throw new Error('全文为空')
          await cachePut(key, text)
          if (seq !== this.fullSeq || this.currentWiki !== page || this.wikiMode !== 'full') {
            this.fallbackFullStar(page)
            return
          }
          this.wikiFullText = text
          this.rememberFullText(page)
          this.renderWikiBody()
        } catch (error) {
          if (seq === this.fullSeq) {
            this.wikiBodyEl.textContent = `全文加载失败：${errorMessage(error)}`
            this.fallbackFullStar(page)
          }
        }
      } finally {
        if (this.fullLoadingKey === key) {
          this.fullLoadingKey = null
          this.fullPromise = null
        }
      }
    })()
    this.fullPromise = task
    await task
  }

  private fallbackFullStar(page: WikiPage): void {
    const star = this.findStar(page)
    if (!star || star.contextMode !== 'full' || star.fullText || star.aiFullText) return
    star.contextMode = 'intro'
    this.sync()
    this.saveWikiState()
    this.renderWikiToolbar()
    this.updateStarButton()
    this.toast('全文加载失败，已改为概览注入；可以稍后再切一次全文重试')
  }

  private rememberFullText(page: WikiPage): void {
    if (this.wikiMode !== 'full' || this.wikiFullText === null) return
    const star = this.findStar(page)
    if (!star) return
    star.contextMode = 'full'
    star.fullText = this.wikiFullText
    this.sync()
    this.saveWikiState()
    this.renderWikiToolbar()
    this.updateStarButton()
  }

  private renderWikiToolbar(): void {
    const page = this.currentWiki
    this.wikiLangsEl.replaceChildren()
    for (const lang of WIKI_LANGS) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'tm-pill'
      button.dataset.wikiLang = lang
      button.textContent = langLabel(lang)
      const current = page?.lang === lang
      const available = current || Boolean(this.wikiLangLinks[lang])
      button.classList.toggle('active', current)
      button.disabled = !available
      button.title = available ? `切换到 ${langLabel(lang)}` : '该条目没有此语言版本'
      this.wikiLangsEl.append(button)
    }
    for (const button of this.wikiModesEl.querySelectorAll<HTMLElement>('[data-wiki-mode]')) {
      button.classList.toggle('active', button.dataset.wikiMode === this.wikiMode)
    }
    const star = page ? this.findStar(page) : undefined
    const starFull = star?.contextMode === 'full'
    this.wikiFullHintEl.hidden = !star && this.wikiMode !== 'full'
    this.wikiFullHintEl.textContent = this.wikiMode === 'full'
      ? `全文会完整注入 AI，token 会显著增加。${star ? `当前星标：${starFull ? '全文' : '概览'}。` : ''}`
      : star
        ? `当前星标：${starFull ? '全文' : '概览'}。${starFull ? '' : '切到全文会把全文注入 AI。'}`
        : ''
  }

  private async switchWikiLang(lang: string): Promise<void> {
    const page = this.currentWiki
    if (!page || page.lang === lang) return
    const title = this.wikiLangLinks[lang]
    if (!title) {
      this.toast('该条目没有此语言版本')
      return
    }
    const seq = ++this.wikiSeq
    this.wikiFullText = null
    this.currentWiki = null
    this.wikiTitleEl.textContent = `[${langLabel(lang)}] ${title}`
    this.wikiBodyEl.textContent = '加载中…'
    this.wikiLinkEl.hidden = true
    this.starEl.disabled = true
    this.wikiNoteEl.disabled = true
    this.wikiNoteStatusEl.textContent = ''
    this.renderWikiToolbar()
    await this.loadWikiCandidate(
      { pageId: 0, title, dist: 0, lang, lat: page.lat, lng: page.lng },
      seq,
      true,
    )
  }

  private renderWikiNote(): void {
    const page = this.currentWiki
    const star = page ? this.findStar(page) : undefined
    this.wikiNoteEl.disabled = !star
    this.wikiNoteEl.placeholder = star
      ? '写下你想让 AI 记住的笔记…'
      : '点亮星标后可为这篇 Wiki 添加笔记…'
    if (document.activeElement !== this.wikiNoteEl) {
      this.wikiNoteEl.value = star ? this.wikiNoteValue(star, star.note) : ''
    }
    this.wikiNoteStatusEl.textContent = star ? '自动保存' : ''
  }

  private renderAiLang(): void {
    const page = this.currentWiki
    const star = page ? this.findStar(page) : undefined
    this.aiLangEl.replaceChildren()
    if (!page) {
      this.aiLangEl.disabled = true
      this.aiLangHintEl.textContent = ''
      return
    }
    this.aiLangEl.append(new Option(`跟随星标页（${langLabel(star?.lang ?? page.lang)}）`, ''))
    for (const lang of WIKI_LANGS) {
      const option = new Option(langLabel(lang), lang)
      option.disabled =
        lang !== page.lang && !this.wikiLangLinks[lang] && star?.aiLang !== lang
      this.aiLangEl.append(option)
    }
    this.aiLangEl.disabled = !star
    this.aiLangEl.value = star?.aiLang ?? ''
    this.aiLangHintEl.textContent = star
      ? '收藏与 AI 预览只显示给 AI 的语言'
      : '星标后可选择'
  }

  private async onAiLangChange(): Promise<void> {
    const page = this.currentWiki
    if (!page) return
    const star = this.findStar(page)
    if (!star) {
      this.renderAiLang()
      return
    }
    const lang = this.aiLangEl.value
    if (!lang || lang === star.lang) {
      star.aiLang = undefined
      star.aiTitle = undefined
      star.aiExtract = undefined
      star.aiFullText = undefined
      this.sync()
      this.flushNoteSave()
      this.renderAiLang()
      this.toast('AI 将使用星标页原文')
      return
    }
    const title = this.wikiLangLinks[lang] ?? (star.aiLang === lang ? star.aiTitle : undefined)
    if (!title) {
      this.toast('该条目没有此语言版本')
      this.renderAiLang()
      return
    }
    this.aiLangEl.disabled = true
    this.aiLangHintEl.textContent = '正在加载 AI 语言…'
    try {
      const target = await this.loadAiPage(lang, title, star)
      star.aiLang = lang
      star.aiTitle = target.title
      star.aiExtract = target.extract
      star.aiFullText = undefined
      this.sync()
      if (star.contextMode === 'full') await this.ensureAiFullText(star)
      this.flushNoteSave()
      this.toast(`AI 将使用 ${langLabel(lang)} 版本${star.contextMode === 'full' ? '（全文）' : ''}`)
    } catch (error) {
      this.toast(`加载失败：${errorMessage(error)}`)
    } finally {
      this.renderAiLang()
    }
  }

  private async ensureAiFullText(star: StarredWiki): Promise<void> {
    if (star.contextMode !== 'full' || !star.aiLang || !star.aiTitle) return
    const key = wikiFullCacheKey(star.aiLang, star.aiTitle)
    const cached = await cacheGet<string>(key)
    if (typeof cached === 'string' && cached.length > 0) {
      star.aiFullText = cached
      this.sync()
      this.saveWikiState()
      return
    }
    try {
      const text = await wikiPageFull(star.aiLang, star.aiTitle)
      await cachePut(key, text)
      star.aiFullText = text
      this.sync()
      this.saveWikiState()
    } catch (error) {
      console.warn('[tavern-map] AI full text failed', errorMessage(error))
      this.toast('AI 语言全文加载失败，仍会使用该语言的简介')
    }
  }

  private async loadAiPage(lang: string, title: string, star: StarredWiki): Promise<WikiPage> {
    const key = wikiCacheKey(lang, title)
    const cached = await cacheGet<WikiPage>(key)
    if (
      cached &&
      typeof cached.fetchedAt === 'number' &&
      typeof cached.extract === 'string' &&
      typeof cached.lang === 'string'
    ) {
      return cached
    }
    const page = await wikiPage({
      pageId: 0,
      title,
      dist: 0,
      lang,
      lat: star.lat,
      lng: star.lng,
    })
    await cachePut(key, page)
    return page
  }

  private onWikiNoteInput(): void {
    const page = this.currentWiki
    if (!page) return
    const star = this.findStar(page)
    if (!star) return
    this.setWikiNote(star, this.wikiNoteEl.value)
    this.sync()
    this.wikiNoteStatusEl.textContent = '保存中…'
    this.scheduleNoteSave()
  }

  private scheduleNoteSave(): void {
    if (this.noteSaveTimer !== undefined) window.clearTimeout(this.noteSaveTimer)
    this.noteSaveTimer = window.setTimeout(() => {
      this.noteSaveTimer = undefined
      this.saveWikiState()
      this.wikiNoteStatusEl.textContent = '已保存'
    }, 400)
  }

  private flushNoteSave(): void {
    if (this.noteSaveTimer !== undefined) {
      window.clearTimeout(this.noteSaveTimer)
      this.noteSaveTimer = undefined
    }
    this.saveWikiState()
    this.wikiNoteStatusEl.textContent = '已保存'
  }

  private async toggleStar(): Promise<void> {
    const current = this.currentWiki
    if (!current) return
    const existing = this.findStar(current)
    if (existing) {
      this.removeStar(current)
      this.saveWikiLibrary()
      this.toast('已从 AI 上下文移除')
      this.commit()
      this.updateStarButton()
      this.renderWikiNote()
      this.renderAiLang()
      return
    }

    if (!current.extract && !this.wikiFullText && this.wikiMode !== 'full') return
    const contextMode: 'intro' | 'full' = this.wikiMode
    const fullText = contextMode === 'full' ? this.wikiFullText || undefined : undefined
    this.removeStar(current)
    this.state.stars.push({
      ...current,
      note: this.wikiNoteValue(current),
      savedAt: Date.now(),
      contextMode,
      fullText,
    })
    this.saveWikiLibrary()
    this.toast(
      contextMode === 'full'
        ? fullText
          ? '已加入 AI 上下文（全文）'
          : '已加入 AI 上下文（全文加载中，完成后自动生效）'
        : '已加入 AI 上下文（概览）',
    )
    this.commit()
    this.updateStarButton()
    this.renderWikiNote()
    this.renderAiLang()
    if (contextMode === 'full' && !fullText) void this.loadFullText()
  }

  private updateStarButton(): void {
    if (!this.starEl) return
    const current = this.currentWiki
    const star = current ? this.findStar(current) : undefined
    const starred = Boolean(star)
    const mode = star?.contextMode ?? this.wikiMode
    this.starEl.textContent = starred ? '★' : '☆'
    this.starEl.title = starred
      ? `从 AI 上下文移除（当前：${mode === 'full' ? '全文' : '概览'}）`
      : `加入 AI 上下文（${this.wikiMode === 'full' ? '全文' : '概览'}）`
    this.starEl.setAttribute('aria-pressed', String(starred))
  }

  private preview(): void {
    const text = this.activeContextText()
    this.previewTextEl.textContent =
      text || '（当前没有启用地图上下文，或没有可用内容；不会注入场景块。）'
    this.tokenEstimateEl.textContent = text
      ? `≈ ${estimateTokens(text)} tokens · 不裁剪`
      : '当前不会注入'
    this.previewEl.hidden = false
    const heading = document.getElementById('tm-preview-heading')
    if (heading) heading.textContent = this.settings.layerMapContext ? 'AI 上下文 · 图层地图' :
      this.settings.realMapContext ? 'AI 上下文 · 现实地图' : 'AI 上下文 · 未启用地图'
  }

  private async copyPreview(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.previewTextEl.textContent ?? '')
      this.toast('已复制')
    } catch {
      this.toast('复制失败，请手动选择文本')
    }
  }

  private realAiSettings(): Partial<Settings> {
    const result: Record<string, boolean | number> = {}
    for (const input of document.querySelectorAll<HTMLInputElement>('#tm-settings [data-real-setting]')) {
      const key = input.dataset.realSetting
      if (key && input.type === 'checkbox') result[key] = input.checked
      if (key && input.type === 'number' && input.valueAsNumber >= Number(input.min) &&
          input.valueAsNumber <= Number(input.max)) result[key] = Math.round(input.valueAsNumber)
    }
    return result as Partial<Settings>
  }

  private writeRealAiSettingsToForm(): void {
    for (const input of document.querySelectorAll<HTMLInputElement>('#tm-settings [data-real-setting]')) {
      const key = input.dataset.realSetting as keyof Settings | undefined
      if (!key) continue
      if (input.type === 'checkbox') input.checked = this.settings[key] === true
      else input.value = String(this.settings[key])
    }
  }

  private layerAiSettings(): Partial<Settings> {
    const result: Record<string, boolean | number> = {}
    for (const input of document.querySelectorAll<HTMLInputElement>('#tm-settings [data-layer-setting]')) {
      const key = input.dataset.layerSetting
      if (!key) continue
      if (input.type === 'checkbox') result[key] = input.checked
      else if (input.type === 'number') {
        const value = Number(input.value)
        if (Number.isFinite(value)) {
          result[key] =
            key === 'layerNearbyMax' || key === 'layerItineraryPoiMax'
              ? Math.round(value)
              : key === 'layerItineraryPoiRadius'
                ? value / 100
                : value
        }
      }
    }
    return result as Partial<Settings>
  }

  private writeLayerAiSettingsToForm(): void {
    for (const input of document.querySelectorAll<HTMLInputElement>('#tm-settings [data-layer-setting]')) {
      const key = input.dataset.layerSetting as keyof Settings | undefined
      if (!key) continue
      const value = this.settings[key]
      if (input.type === 'checkbox') input.checked = value === true
      else if (input.type === 'number' && typeof value === 'number') {
        input.value = String(
          key === 'layerItineraryPoiRadius' ? Math.round(value * 1000) / 10 : value,
        )
      }
    }
  }

  private readSettings(): void {
    const previous = this.settings
    const numberValue = (element: HTMLInputElement, fallback: number, min: number, max: number): number => {
      const value = Number(element.value)
      if (!Number.isFinite(value)) return fallback
      return Math.min(max, Math.max(min, value))
    }
    const selectedLangs = this.langEls.filter((input) => input.checked).map((input) => input.value)
    this.settings = {
      ...this.settings,
      enabled: this.enabledEl.checked,
      realMapContext: this.realContextEl.checked,
      layerMapContext: this.layerContextEl.checked,
      wikiLangs: selectedLangs.length > 0 ? selectedLangs : ['en'],
      radiusM: numberValue(this.radiusEl, this.settings.radiusM, 25, 1000),
      maxNearby: Math.round(numberValue(this.nearbyEl, this.settings.maxNearby, 0, 50)),
      depth: Math.round(numberValue(this.depthEl, this.settings.depth, 0, 10)),
      ...this.realAiSettings(),
      ...this.layerAiSettings(),
    }
    this.settings.layerNearbyMax = Math.min(
      50,
      Math.max(1, Math.round(this.settings.layerNearbyMax || 8)),
    )
    this.settings.layerItineraryPoiRadius = Math.min(
      ITINERARY_RANGE_MAX,
      Math.max(ITINERARY_RANGE_MIN, this.settings.layerItineraryPoiRadius || 0.08),
    )
    this.settings.layerItineraryPoiMax = Math.min(
      30,
      Math.max(1, Math.round(this.settings.layerItineraryPoiMax || 8)),
    )
    saveSettings(this.ctx, this.settings)
    this.layerUI?.handleSettingsChanged()
    this.writeSettingsToForm()
    this.state.enabled = this.settings.enabled
    this.commit()
    this.drawRadius()
    if (previous.radiusM !== this.settings.radiusM) {
      this.updatePoiSource()
      this.scheduleRefresh(450)
    }
    if (previous.routePoiRadiusM !== this.settings.routePoiRadiusM || previous.showRoutePois !== this.settings.showRoutePois) {
      this.refreshRealRouteRange()
    } else {
      this.drawActiveRoute()
    }
  }

  private writeSettingsToForm(): void {
    if (!this.enabledEl) return
    this.enabledEl.checked = this.settings.enabled
    this.realContextEl.checked = this.settings.realMapContext
    this.layerContextEl.checked = this.settings.layerMapContext
    for (const input of this.langEls) input.checked = this.settings.wikiLangs.includes(input.value)
    this.radiusEl.value = String(this.settings.radiusM)
    this.nearbyEl.value = String(this.settings.maxNearby)
    this.depthEl.value = String(this.settings.depth)
    this.writeRealAiSettingsToForm()
    this.writeLayerAiSettingsToForm()
    this.syncRadiusUi()
  }

  private clearChat(): void {
    this.seq += 1
    this.wikiSeq += 1
    this.fullSeq += 1
    if (this.moving) this.stopMovement()
    this.clearRouteLine()
    if (this.noteSaveTimer !== undefined) window.clearTimeout(this.noteSaveTimer)
    this.loadingNearby = false
    this.loadingWiki = false
    this.state.nearby = []
    this.state.wiki = []
    this.state.place = undefined
    this.state.positionCleared = true
    delete this.state.viewedPlace
    delete this.state.routeDraft
    this.renderPositionMarker()
    this.drawRadius()
    this.pois = []
    this.poisById.clear()
    this.poiSeq += 1
    delete this.state.itinerary
    delete this.state.lastWiki
    delete this.state.lastWikiMode
    this.state.wikiOpen = false
    this.state.lastTab = 'nearby'
    this.currentWiki = null
    this.currentPlace = null
    this.tab = 'nearby'
    this.moveProgress = 0
    this.wikiFullText = null
    this.wikiLangLinks = {}
    this.wikiEl.hidden = true
    this.placeEl.hidden = true
    this.previewEl.hidden = true
    this.searchInputEl.value = ''
    this.hideSearchResults()
    this.updatePoiSource()
    this.syncPoiUi()
    this.layerUI?.clearChat()
    delete this.liveContext().chatMetadata?.[LAYER_STATE_KEY]
    this.commit()
    this.toast('已清空当前聊天的地图会话')
  }

  private onChatChanged(): void {
    this.routeSeq += 1
    this.positionLookup += 1
    this.routeRunning = false
    this.routeRedo = []
    this.routeSelection = 0
    this.setMapTool('browse')
    this.seq += 1
    this.wikiSeq += 1
    this.fullSeq += 1
    if (this.noteSaveTimer !== undefined) window.clearTimeout(this.noteSaveTimer)
    this.loadingNearby = false
    this.loadingWiki = false
    if (this.moving) this.stopMovement()
    this.clearRouteLine()
    this.ctx = this.liveContext()
    this.settings = loadSettings(this.ctx)
    this.state = loadState(this.ctx)
    this.state.enabled = this.settings.enabled
    this.restoreStoredRealPosition()
    this.hydrateGlobalNotes()
    this.hydrateRealFavorites()
    this.loadSharedRoute()
    this.loadSharedWiki()
    this.restoreRealRoute()
    this.layerUI?.handleChatChanged()
    this.pois = []
    this.poisById.clear()
    this.poiSeq += 1
    this.tab = this.state.lastTab ?? 'nearby'
    this.currentWiki = null
    this.currentPlace = this.state.viewedPlace ?? null
    this.renderViewedMarker()
    this.wikiFullText = null
    this.wikiLangLinks = {}
    this.wikiEl.hidden = true
    this.placeEl.hidden = true
    this.previewEl.hidden = true
    this.searchInputEl.value = ''
    this.hideSearchResults()
    this.writeSettingsToForm()
    if (this.map) {
      const view = this.state.view
      this.viewRestoring = true
      this.map.jumpTo({
        center: view ? [view.center.lng, view.center.lat] : [this.state.center.lng, this.state.center.lat],
        zoom: view?.zoom ?? this.state.zoom,
      })
      this.viewRestoring = false
      this.renderPositionMarker()
    }
    this.drawRadius()
    this.drawActiveRoute()
    this.updatePoiSource()
    this.syncPoiUi()
    this.commit()
    this.setStatus('')
    if (!this.panelEl.hidden && !this.state.positionCleared) void this.refreshPois(this.state.center.lat, this.state.center.lng)
    if (this.state.wikiOpen && this.state.lastWiki) {
      window.setTimeout(() => {
        if (!this.panelEl.hidden) void this.restoreWiki(this.state.lastWiki!)
      }, 120)
    }
    if (!this.panelEl.hidden && !this.state.place && this.state.nearby.length === 0 && this.state.wiki.length === 0) {
      this.scheduleRefresh(0)
    }
  }

  private applyFabGeometry(): void {
    const fab = document.getElementById('tm-fab')
    if (!fab) return
    const rect = fab.getBoundingClientRect()
    const width = rect.width || 52
    const height = rect.height || 52
    const mobile = window.matchMedia('(max-width: 640px)').matches
    // SillyTavern's mobile layout can make `bottom` resolve against a zero-height
    // fixed body. Always write explicit left/top so the FAB stays on screen.
    let left = Math.max(0, window.innerWidth - width - (mobile ? 14 : 18))
    let top = Math.max(0, window.innerHeight - height - (mobile ? 124 : 96))
    try {
      const raw = localStorage.getItem(FAB_POS_KEY)
      if (raw) {
        const value = JSON.parse(raw) as { left?: number; top?: number }
        if (Number.isFinite(value.left) && Number.isFinite(value.top)) {
          left = Math.min(Math.max(0, value.left!), Math.max(0, window.innerWidth - width))
          top = Math.min(Math.max(0, value.top!), Math.max(0, window.innerHeight - height))
        }
      }
    } catch {
      // localStorage can be unavailable in private or restricted contexts.
    }
    fab.style.left = `${left}px`
    fab.style.top = `${top}px`
    fab.style.right = 'auto'
    fab.style.bottom = 'auto'
  }

  private clampFab(): void {
    const fab = document.getElementById('tm-fab')
    if (!fab || !fab.style.left) return
    const rect = fab.getBoundingClientRect()
    fab.style.left = `${Math.min(Math.max(0, rect.left), Math.max(0, window.innerWidth - rect.width))}px`
    fab.style.top = `${Math.min(Math.max(0, rect.top), Math.max(0, window.innerHeight - rect.height))}px`
  }

  private bindFabDrag(): void {
    const fab = document.getElementById('tm-fab')
    if (!fab) return
    let startX = 0
    let startY = 0
    let startLeft = 0
    let startTop = 0
    let moved = false
    let dragging = false

    fab.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return
      const rect = fab.getBoundingClientRect()
      startX = event.clientX
      startY = event.clientY
      startLeft = rect.left
      startTop = rect.top
      moved = false
      dragging = true
      fab.setPointerCapture(event.pointerId)
    })

    fab.addEventListener('pointermove', (event) => {
      if (!dragging) return
      const dx = event.clientX - startX
      const dy = event.clientY - startY
      if (!moved && Math.hypot(dx, dy) < 5) return
      moved = true
      event.preventDefault()
      const rect = fab.getBoundingClientRect()
      const left = Math.min(Math.max(0, startLeft + dx), Math.max(0, window.innerWidth - rect.width))
      const top = Math.min(Math.max(0, startTop + dy), Math.max(0, window.innerHeight - rect.height))
      fab.style.left = `${left}px`
      fab.style.top = `${top}px`
      fab.style.right = 'auto'
      fab.style.bottom = 'auto'
      fab.style.cursor = 'grabbing'
    })

    const finish = (event: PointerEvent): void => {
      if (!dragging) return
      dragging = false
      fab.style.cursor = ''
      if (fab.hasPointerCapture(event.pointerId)) fab.releasePointerCapture(event.pointerId)
      if (!moved) return
      this.suppressFabClick = true
      window.setTimeout(() => {
        this.suppressFabClick = false
      }, 0)
      const rect = fab.getBoundingClientRect()
      try {
        localStorage.setItem(FAB_POS_KEY, JSON.stringify({ left: rect.left, top: rect.top }))
      } catch {
        // ignore storage failures
      }
    }
    fab.addEventListener('pointerup', finish)
    fab.addEventListener('pointercancel', finish)
  }

  private setStatus(message: string): void {
    this.statusEl.textContent = message
  }

  private toast(message: string): void {
    const element = document.createElement('div')
    element.className = 'tm-toast'
    element.setAttribute('role', 'status')
    element.textContent = message
    document.body.append(element)
    window.setTimeout(() => element.remove(), 2600)
  }

  private cleanup(): void {
    clearPrompt(this.ctx)
    this.offs.forEach((remove) => remove())
    this.offs.length = 0
    if (this.refreshTimer !== undefined) window.clearTimeout(this.refreshTimer)
    if (this.settingsTimer !== undefined) window.clearTimeout(this.settingsTimer)
    if (this.noteSaveTimer !== undefined) window.clearTimeout(this.noteSaveTimer)
    if (this.searchTimer !== undefined) window.clearTimeout(this.searchTimer)
    if (this.draftPoiTimer !== undefined) window.clearTimeout(this.draftPoiTimer)
    if (this.moveFrame !== null) window.cancelAnimationFrame(this.moveFrame)
    this.moveFrame = null
    this.moving = false
    this.clearRouteLine()
    this.resizeObserver?.disconnect()
    this.windowController.dispose()
    this.layerUI?.dispose()
    this.layerUI = null
    this.map?.remove()
    this.map = null
    this.mapStyleReady = false
    this.marker = null
    window.removeEventListener('beforeunload', this.onUnload)
    document.getElementById('tm-fab')?.remove()
    this.panelEl?.remove()
    this.previewEl?.remove()
    document.getElementById('tm-settings')?.remove()
  }
}
