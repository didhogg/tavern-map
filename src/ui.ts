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
import { formatDistance, haversine, placeKey } from './geo'
import { errorMessage } from './http'
import { fetchPois, type Poi } from './poi'
import { syncPrompt, clearPrompt } from './prompt'
import { nearbyPlaces, reverseGeocode } from './providers'
import { routeBetween, type Route } from './route'
import { searchPlaces, type SearchResult } from './search'
import { loadState, saveState } from './state'
import { loadSettings, saveSettings, WIKI_LANGS } from './settings'
import type {
  MapState,
  Place,
  RouteItinerary,
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
const PANEL_GEOMETRY_KEY = 'tavern-map:panel-geometry'
const ROUTE_SOURCE = 'tm-route'
const WIKI_LANG_LABELS: Record<string, string> = { en: 'EN', ja: 'JA', zh: 'ZH' }

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
  <header class="tm-head">
    <strong>Tavern Map</strong>
    <div class="tm-head-actions">
      <button type="button" data-action="preview" title="预览 AI 上下文">AI 预览</button>
      <button type="button" data-action="refresh" title="刷新地点数据">刷新</button>
      <button type="button" data-action="close" title="关闭">×</button>
    </div>
  </header>
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
    <button id="tm-recenter" class="tm-recenter" type="button" title="回到人物位置" aria-label="回到人物位置">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="5.5"></circle>
        <path d="M12 2v4M12 18v4M2 12h4M18 12h4"></path>
      </svg>
    </button>
  </div>
  <div class="tm-location">
    <div class="tm-place-summary" data-action="place-current" role="button" tabindex="0" title="查看地点详情">
      <div id="tm-place-name" class="tm-place-name">点击地图选择位置</div>
      <div id="tm-place-address" class="tm-place-address"></div>
    </div>
    <div class="tm-location-meta">
      <div id="tm-status" class="tm-status" role="status"></div>
      <label class="tm-radius-control">
        <span>范围</span>
        <input id="tm-radius" type="range" min="50" max="1000" step="50" aria-label="周边搜索范围">
        <output id="tm-radius-value">250m</output>
      </label>
    </div>
  </div>
  <div class="tm-poi-bar">
    <button id="tm-poi-toggle" class="tm-poi-toggle active" type="button" aria-pressed="true">图层 POI</button>
    <label class="tm-poi-all" title="把当前范围已拉取的全部 POI 作为 POI briefs 注入，会显著增加 token"><input id="tm-poi-all-ai" type="checkbox"> 全部 POI 给 AI <span id="tm-poi-count">0</span></label>
  </div>
  <div class="tm-tabs" role="tablist">
    <button type="button" data-tab="nearby" class="active" role="tab">周边</button>
    <button type="button" data-tab="wiki" role="tab">维基</button>
    <button type="button" data-tab="saved" role="tab">收藏 <span id="tm-saved-count" class="tm-badge">0</span></button>
    <button type="button" data-tab="route" role="tab">行程 <span id="tm-route-count" class="tm-badge">0</span></button>
  </div>
  <div id="tm-list" class="tm-list"></div>
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
      <div id="tm-place-info" class="tm-place-info"></div>
      <div class="tm-place-actions">
        <button type="button" data-action="place-route">路线</button>
        <button type="button" data-action="place-go">前往</button>
        <button type="button" data-action="place-clear-route" hidden>清除路线</button>
        <button type="button" data-action="place-wiki">附近 Wiki</button>
      </div>
      <div id="tm-route-summary" class="tm-route-summary" hidden>
        <span id="tm-route-text"></span>
        <label class="tm-route-ai"><input type="checkbox" data-route-ai> 把行程显示给 AI</label>
        <div class="tm-route-actions">
          <button type="button" data-action="route-copy">复制行程</button>
          <button type="button" data-action="place-itinerary">完整行程</button>
          <button type="button" data-action="place-start" class="tm-route-start" hidden>开始移动</button>
          <button type="button" data-action="place-stop" class="tm-route-stop" hidden>停止</button>
        </div>
        <div class="tm-route-progress" id="tm-route-progress"><div id="tm-route-bar" class="tm-route-bar"></div></div>
        <ol id="tm-place-route-steps" class="tm-route-steps tm-place-route-steps"></ol>
      </div>
      <div class="tm-place-note">
        <label for="tm-place-note">我的笔记</label>
        <textarea id="tm-place-note" placeholder="收藏后可写笔记…" disabled></textarea>
        <div id="tm-place-note-status" class="tm-note-status"></div>
      </div>
    </div>
  </div>
</section>
<div id="tm-preview" class="tm-preview" role="dialog" aria-modal="true" aria-label="AI context preview" hidden>
  <div class="tm-preview-card">
    <header class="tm-head">
      <strong>AI 将看到的场景块</strong>
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
      <div class="tm-row tm-row-stack">Wiki 搜索语言（可多选）
        <div class="tm-lang-options">
          <label><input type="checkbox" data-tm-lang value="en"> English</label>
          <label><input type="checkbox" data-tm-lang value="ja"> 日本語</label>
          <label><input type="checkbox" data-tm-lang value="zh"> 中文</label>
        </div>
      </div>
      <label class="tm-row">周边半径（米）<input type="number" id="tm-set-radius" min="50" max="1000" step="50"></label>
      <label class="tm-row">周边地点数<input type="number" id="tm-set-nearby" min="0" max="12" step="1"></label>
      <label class="tm-row">注入深度<input type="number" id="tm-set-depth" min="0" max="10" step="1"></label>
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
  private marker: Marker | null = null
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
  private routeEndMarker: Marker | null = null
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
  private readonly offs: Array<() => void> = []

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
  private poiAllEl!: HTMLInputElement
  private poiCountEl!: HTMLElement
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
  private placeStartEl!: HTMLButtonElement
  private placeStopEl!: HTMLButtonElement
  private placeClearEl!: HTMLButtonElement
  private placeProgressEl!: HTMLElement
  private placeBarEl!: HTMLElement
  private placeRouteStepsEl!: HTMLElement

  private enabledEl!: HTMLInputElement
  private langEls: HTMLInputElement[] = []
  private radiusEl!: HTMLInputElement
  private nearbyEl!: HTMLInputElement
  private depthEl!: HTMLInputElement

  private readonly onUnload = (): void => this.cleanup()

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
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
    this.applyPanelGeometry()
  }

  constructor(ctx: StContext) {
    this.ctx = ctx
    this.settings = loadSettings(ctx)
    this.state = loadState(ctx)
    this.state.enabled = this.settings.enabled
    this.mount()
    this.applyFabGeometry()
    this.applyPanelGeometry()
    this.bindEvents()
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
    this.poiAllEl = document.getElementById('tm-poi-all-ai') as HTMLInputElement
    this.poiCountEl = document.getElementById('tm-poi-count') as HTMLElement
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
    this.poiAllEl.addEventListener('change', () => this.onPoiAllChange())
    this.wikiNoteEl.addEventListener('input', () => this.onWikiNoteInput())
    this.wikiNoteEl.addEventListener('change', () => this.flushNoteSave())
    this.placeNoteEl.addEventListener('input', () => this.onPlaceNoteInput())
    this.placeNoteEl.addEventListener('change', () => this.flushNoteSave())
    this.aiLangEl.addEventListener('change', () => void this.onAiLangChange())
    this.recenterEl.addEventListener('click', () => this.recenterOnPerson())
    this.panelEl.addEventListener('change', (event) => this.onPanelChange(event))

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
    this.bindPanelDrag()
    this.mountSettings()
  }

  private bindSettings(): void {
    if (this.settingsBound || !this.enabledEl) return
    this.settingsBound = true

    this.enabledEl.addEventListener('change', () => this.readSettings())
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

    document.getElementById('tm-open')?.addEventListener('click', () => this.openPanel())
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
    if (action === 'close') {
      this.closePanel()
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
      if (this.currentPlace) void this.planRouteTo(this.currentPlace)
      return
    }
    if (action === 'place-go') {
      if (this.currentPlace) {
        void this.moveTo(this.currentPlace.lat, this.currentPlace.lng, true)
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
        void this.moveTo(place.lat, place.lng, true)
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
      this.tab = tab
      this.state.lastTab = tab
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
    const target = event.target as HTMLElement
    if (!target.matches('[data-route-ai]')) return
    if (!this.state.itinerary) return
    this.state.itinerary.showToAI = (target as HTMLInputElement).checked
    this.sync()
    this.flushNoteSave()
    this.syncRouteAiCheckboxes()
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
    if (this.panelEl.hidden) this.openPanel()
    else this.closePanel()
  }

  private openPanel(): void {
    this.panelEl.hidden = false
    this.tab = this.state.lastTab ?? 'nearby'
    this.applyPanelGeometry()
    this.ensureMap()
    window.requestAnimationFrame(() => {
      this.map?.resize()
      const view = this.state.view
      this.map?.flyTo({
        center: view ? [view.center.lng, view.center.lat] : [this.state.center.lng, this.state.center.lat],
        zoom: view?.zoom ?? this.state.zoom,
      })
      this.render()
      this.drawRadius()
    })
    if (this.state.wikiOpen && this.state.lastWiki) {
      window.setTimeout(() => {
        if (!this.panelEl.hidden) void this.restoreWiki(this.state.lastWiki!)
      }, 120)
    }
    const needsInitialData = !this.state.place && this.state.nearby.length === 0 && this.state.wiki.length === 0
    if (needsInitialData) {
      window.setTimeout(() => {
        if (!this.panelEl.hidden) void this.refresh()
      }, 150)
    }
  }

  private closePanel(): void {
    this.panelEl.hidden = true
    this.state.wikiOpen = !this.wikiEl.hidden
    saveState(this.ctx, this.state)
  }

  private personMarkerElement(): HTMLElement {
    const element = document.createElement('div')
    element.className = 'tm-person-marker'
    element.title = '你在这里'
    element.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7" r="3.1"></circle><path d="M6.2 21c.35-4.1 2.6-6.3 5.8-6.3s5.45 2.2 5.8 6.3"></path></svg>'
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
    this.marker = new Marker({ element: this.personMarkerElement(), draggable: true, anchor: 'center' })
      .setLngLat([this.state.center.lng, this.state.center.lat])
      .addTo(map)
    this.marker.on('dragend', () => {
      if (!this.marker) return
      const position = this.marker.getLngLat()
      void this.moveTo(position.lat, position.lng)
    })
    map.on('click', (event) => {
      if (this.handlePoiMapClick(event)) return
      void this.moveTo(event.lngLat.lat, event.lngLat.lng)
    })
    map.on('moveend', () => {
      const current = this.map
      if (!current) return
      const center = current.getCenter()
      this.state.zoom = current.getZoom()
      this.state.view = { center: { lat: center.lat, lng: center.lng }, zoom: this.state.zoom }
      saveState(this.ctx, this.state)
    })
    map.on('style.load', () => {
      this.drawRadius()
      if (this.currentRoute) this.drawRouteLine(this.currentRoute, false)
      this.updatePoiSource()
    })
    map.once('load', () => this.drawRadius())
    map.once('idle', () => this.drawRadius())
    this.resizeObserver = new ResizeObserver(() => this.map?.resize())
    this.resizeObserver.observe(this.canvasEl)
  }

  private drawRadius(): void {
    const map = this.map
    if (!map || !map.isStyleLoaded()) return
    const data = circleFeature(this.state.center.lat, this.state.center.lng, this.settings.radiusM)
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
      paint: { 'fill-color': '#e6b56a', 'fill-opacity': 0.24 },
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
      features: this.pois.map((poi) => ({
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
    if (!map || !map.isStyleLoaded()) return
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
    if (!map || !map.isStyleLoaded()) return
    const visibility = this.settings.showPois ? 'visible' : 'none'
    for (const id of ['tm-poi-cluster', 'tm-poi-cluster-count', 'tm-poi-point', 'tm-poi-label']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility)
    }
  }

  private async refreshPois(lat: number, lng: number): Promise<void> {
    if (!this.settings.showPois && !this.state.poiAllToAI) return
    const seq = ++this.poiSeq
    this.loadingPois = true
    this.syncPoiUi()
    try {
      const pois = await fetchPois(lat, lng, this.settings.radiusM)
      if (seq !== this.poiSeq) return
      this.pois = pois
      this.poisById = new Map(pois.map((poi) => [poi.id, poi]))
      this.state.poiBriefs = pois.map((poi) => ({
        id: poi.id,
        name: poi.name,
        nameZh: poi.nameZh,
        category: poi.category,
        address: poi.address,
        distanceM: poi.distanceM,
        addedAt: Date.now(),
      }))
      this.updatePoiSource()
      this.syncPoiUi()
      saveState(this.ctx, this.state)
      if (this.state.poiAllToAI) this.sync()
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

  private onPoiAllChange(): void {
    this.state.poiAllToAI = this.poiAllEl.checked
    if (this.state.poiAllToAI && this.state.poiBriefs.length === 0) {
      void this.refreshPois(this.state.center.lat, this.state.center.lng)
    }
    this.sync()
    saveState(this.ctx, this.state)
    this.syncPoiUi()
  }

  private syncPoiUi(): void {
    if (!this.poiToggleEl) return
    this.poiToggleEl.classList.toggle('active', this.settings.showPois)
    this.poiToggleEl.classList.toggle('loading', this.loadingPois)
    this.poiToggleEl.setAttribute('aria-pressed', String(this.settings.showPois))
    this.poiAllEl.checked = this.state.poiAllToAI
    this.poiCountEl.textContent = String(this.state.poiBriefs.length)
  }

  private handlePoiMapClick(event: MapMouseEvent): boolean {
    const map = this.map
    if (!map || !map.isStyleLoaded()) return false
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

  private async moveTo(lat: number, lng: number, fly = false): Promise<void> {
    this.seq += 1
    this.wikiSeq += 1
    this.fullSeq += 1
    this.clearRouteLine()
    this.state.center = { lat, lng }
    this.state.zoom = this.map?.getZoom() ?? this.state.zoom
    this.state.place = undefined
    this.state.nearby = []
    this.state.wiki = []
    this.currentWiki = null
    this.wikiFullText = null
    this.wikiLangLinks = {}
    this.wikiEl.hidden = true
    this.marker?.setLngLat([lng, lat])
    if (fly) {
      const map = this.map
      if (map) map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 16) })
    }
    this.drawRadius()
    this.commit()
    this.setStatus('正在获取地点信息…')
    this.scheduleRefresh()
  }

  private scheduleRefresh(delay = 650): void {
    this.seq += 1
    if (this.refreshTimer !== undefined) window.clearTimeout(this.refreshTimer)
    this.refreshTimer = window.setTimeout(() => void this.refresh(), delay)
  }

  private async refresh(): Promise<void> {
    const seq = ++this.seq
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

    const placeTask = reverseGeocode(lat, lng)
      .then((place) => {
        if (seq !== this.seq) return
        this.state.place = place
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

  private sync(): void {
    this.state.enabled = this.settings.enabled
    const text = buildContext(this.state, this.settings)
    if (!this.settings.enabled || !text) {
      clearPrompt(this.ctx)
    } else {
      syncPrompt(this.ctx, text, true, this.settings.depth)
    }
    if (this.previewEl && !this.previewEl.hidden) this.preview()
  }

  private render(): void {
    if (!this.panelEl) return
    const placeName = this.state.place?.name
    this.placeNameEl.textContent = placeName
      ? this.state.place?.nameZh
        ? `${placeName} / ${this.state.place.nameZh}`
        : placeName
      : '点击地图选择位置'
    this.placeNameEl.title = this.placeNameEl.textContent
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
  }

  private updateRouteCount(): void {
    if (!this.routeCountEl) return
    this.routeCountEl.textContent = String(this.state.itinerary?.steps.length ?? 0)
  }

  private updateSavedCount(): void {
    if (!this.savedCountEl) return
    this.savedCountEl.textContent = String(this.state.savedPlaces.length + this.state.stars.length)
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
      const places = this.pois.length > 0 ? this.pois : this.state.nearby
      if (places.length === 0) {
        if (this.loadingNearby || this.loadingPois) {
          this.listEl.append(this.skeleton(), this.skeleton(), this.skeleton())
        } else {
          this.listEl.append(this.empty('还没有周边地点。点地图选一个位置，或点右上角刷新。'))
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
    save.title = saved ? '从 AI 上下文移除' : '加入 AI 上下文'
    save.setAttribute('aria-pressed', String(saved))
    save.addEventListener('click', (event) => {
      event.stopPropagation()
      this.toggleSavedPlace(place)
    })

    const go = document.createElement('button')
    go.type = 'button'
    go.className = 'tm-item-go'
    go.textContent = '前往'
    go.title = '移动到这里'
    go.addEventListener('click', (event) => {
      event.stopPropagation()
      void this.moveTo(place.lat, place.lng, true)
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
        this.empty('还没有收藏。点周边地点的 ☆ 收藏地点，或在 Wiki 里点亮星标；收藏后可以写自己的笔记。'),
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
    const title = document.createElement('div')
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
    const go = this.miniButton('前往', () => void this.moveTo(place.lat, place.lng, true))
    const remove = this.miniButton('移除', () => {
      const key = placeKey(place)
      this.state.savedPlaces = this.state.savedPlaces.filter((item) => placeKey(item) !== key)
      this.commit()
      this.toast('已移除收藏地点')
    })
    actions.append(detail, go, remove)
    head.append(title, actions)

    const note = this.noteInput(place.note, (value) => {
      place.note = value
      this.sync()
      this.scheduleNoteSave()
    })
    card.append(head, note)
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
    name.textContent = `[${langLabel(page.lang)}] ${page.title}`
    const meta = document.createElement('div')
    meta.className = 'tm-saved-meta'
    meta.textContent = `Wikipedia · 给 AI ${langLabel(page.aiLang || page.lang)} · ${
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
        this.commit()
        this.toast('已从 AI 上下文移除 Wiki')
      }),
    )
    head.append(title, actions)

    const note = this.noteInput(page.note, (value) => {
      page.note = value
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
    this.render()
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
    this.placeSaveEl.title = saved ? '从 AI 上下文移除' : '加入 AI 上下文'
    this.placeSaveEl.setAttribute('aria-pressed', String(Boolean(saved)))
    this.placeNoteEl.disabled = !saved
    this.placeNoteEl.placeholder = saved ? '写下你想让 AI 记住的地点笔记…' : '点亮星星后可写笔记…'
    if (document.activeElement !== this.placeNoteEl) this.placeNoteEl.value = saved?.note ?? ''
    this.placeNoteStatusEl.textContent = saved ? '自动保存' : ''
    this.renderPlaceInfo(place)
    this.renderPlaceRoute()
  }

  private renderPlaceInfo(place: Place): void {
    this.placeInfoEl.replaceChildren()
    const poi = place as Partial<Poi>
    const rows: Array<[string, string]> = []
    if (poi.cuisine) rows.push(['菜系', poi.cuisine])
    if (poi.openingHours) rows.push(['营业时间', poi.openingHours])
    for (const [label, value] of rows) {
      const row = document.createElement('div')
      row.className = 'tm-place-info-row'
      const name = document.createElement('span')
      name.className = 'tm-place-info-label'
      name.textContent = label
      const text = document.createElement('span')
      text.textContent = value
      row.append(name, text)
      this.placeInfoEl.append(row)
    }
    if (poi.website) {
      const row = document.createElement('div')
      row.className = 'tm-place-info-row'
      const name = document.createElement('span')
      name.className = 'tm-place-info-label'
      name.textContent = '网站'
      const link = document.createElement('a')
      if (/^https?:\/\//i.test(poi.website)) {
        link.href = poi.website
        link.target = '_blank'
        link.rel = 'noreferrer'
      }
      link.textContent = poi.website
      row.append(name, link)
      this.placeInfoEl.append(row)
    }
    this.placeInfoEl.hidden = this.placeInfoEl.childElementCount === 0
  }

  private onPlaceNoteInput(): void {
    const place = this.currentPlace
    if (!place) return
    const saved = this.findSavedPlace(place)
    if (!saved) return
    saved.note = this.placeNoteEl.value
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
      `步行 ${formatDistance(itinerary.distance)} · 约 ${formatDurationShort(itinerary.duration)}`,
    ]
    if (itinerary.fallback) lines.push('（路线服务不可用，按直线估计）')
    itinerary.steps.forEach((step, index) => {
      const distance = step.distance > 0 ? `（${formatDistance(step.distance)}）` : ''
      lines.push(`${index + 1}. ${step.instruction}${distance}`)
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
    this.placeRouteTextEl.textContent = `步行 ${formatDistance(itinerary.distance)} · 约 ${formatDurationShort(itinerary.duration)}${fallback}`
    this.placeStartEl.hidden = !this.currentRoute || this.moving
    this.placeStopEl.hidden = !this.moving
    this.placeProgressEl.hidden = !this.moving
    this.placeBarEl.style.width = `${Math.round(this.moveProgress * 100)}%`
    this.fillRouteSteps(this.placeRouteStepsEl, itinerary)
    this.syncRouteAiCheckboxes()
  }

  private fillRouteSteps(container: HTMLElement, itinerary: RouteItinerary): void {
    container.replaceChildren()
    itinerary.steps.forEach((step) => {
      const item = document.createElement('li')
      const text = document.createElement('span')
      text.textContent = step.instruction
      item.append(text)
      if (step.distance > 0) {
        const distance = document.createElement('em')
        distance.textContent = formatDistance(step.distance)
        item.append(distance)
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

  private async planRouteTo(place: Place): Promise<void> {
    if (this.moving) this.stopMovement()
    const from = { lat: this.state.center.lat, lng: this.state.center.lng }
    if (haversine(from.lat, from.lng, place.lat, place.lng) < 5) {
      this.toast('已经在这个地点')
      return
    }
    this.setStatus('正在规划步行路线…')
    try {
      const route = await routeBetween(from, { lat: place.lat, lng: place.lng })
      this.currentRoute = route
      const showToAI = this.state.itinerary?.showToAI ?? false
      this.state.itinerary = {
        from: {
          id: this.state.place?.id,
          name: this.state.place?.name ?? '当前位置',
          lat: from.lat,
          lng: from.lng,
        },
        to: { id: place.id, name: place.name, lat: place.lat, lng: place.lng },
        distance: route.distance,
        duration: route.duration,
        steps: route.steps,
        fallback: route.fallback,
        showToAI,
        updatedAt: Date.now(),
      }
      this.drawRouteLine(route, true)
      this.commit()
      this.renderPlace()
      this.setStatus(route.fallback ? '路线服务不可用，已显示直线估计' : '')
      this.toast('行程已生成，可在“行程”页查看和复制')
    } catch (error) {
      this.setStatus(`路线规划失败：${errorMessage(error)}`)
    }
  }

  private drawRouteLine(route: Route, fit: boolean): void {
    const map = this.map
    if (!map || !map.isStyleLoaded()) return
    const data: Feature<LineString> = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: route.coordinates },
    }
    const source = map.getSource(ROUTE_SOURCE) as GeoJSONSource | undefined
    if (source) {
      source.setData(data)
    } else {
      map.addSource(ROUTE_SOURCE, { type: 'geojson', data })
      map.addLayer({
        id: 'tm-route-casing',
        type: 'line',
        source: ROUTE_SOURCE,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#0b3d66', 'line-opacity': 0.9, 'line-width': 7 },
      })
      map.addLayer({
        id: 'tm-route-line',
        type: 'line',
        source: ROUTE_SOURCE,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#2f80ed', 'line-opacity': 0.95, 'line-width': 4 },
      })
    }

    this.routeEndMarker?.remove()
    const end = route.coordinates[route.coordinates.length - 1]
    const endElement = document.createElement('div')
    endElement.className = 'tm-route-end'
    endElement.title = '目的地'
    this.routeEndMarker = new Marker({ element: endElement, anchor: 'center' }).setLngLat(end).addTo(map)

    if (!fit) return
    let minLng = Infinity
    let minLat = Infinity
    let maxLng = -Infinity
    let maxLat = -Infinity
    for (const [lng, lat] of route.coordinates) {
      minLng = Math.min(minLng, lng)
      minLat = Math.min(minLat, lat)
      maxLng = Math.max(maxLng, lng)
      maxLat = Math.max(maxLat, lat)
    }
    map.fitBounds(
      [
        [minLng, minLat],
        [maxLng, maxLat],
      ],
      { padding: 40, maxZoom: 17, duration: 500 },
    )
  }

  private clearRouteLine(): void {
    this.routeEndMarker?.remove()
    this.routeEndMarker = null
    const map = this.map
    if (map && map.isStyleLoaded()) {
      if (map.getLayer('tm-route-line')) map.removeLayer('tm-route-line')
      if (map.getLayer('tm-route-casing')) map.removeLayer('tm-route-casing')
      if (map.getSource(ROUTE_SOURCE)) map.removeSource(ROUTE_SOURCE)
    }
    this.currentRoute = null
  }

  private clearItinerary(): void {
    if (this.moving) this.stopMovement()
    this.clearRouteLine()
    delete this.state.itinerary
    this.moveProgress = 0
    this.commit()
    this.renderPlace()
    if (this.tab === 'route') this.render()
    this.toast('已清除当前行程')
  }

  private replanItinerary(): void {
    const itinerary = this.state.itinerary
    if (!itinerary) return
    const place: Place = {
      id: itinerary.to.id ?? `itinerary:${itinerary.to.lat},${itinerary.to.lng}`,
      name: itinerary.to.name,
      lat: itinerary.to.lat,
      lng: itinerary.to.lng,
    }
    void this.planRouteTo(place)
  }

  private renderRouteTab(): void {
    this.listEl.replaceChildren()
    const itinerary = this.state.itinerary
    if (!itinerary) {
      this.listEl.append(this.empty('还没有行程。打开一个地点的详情，点“路线”生成步行路线。'))
      return
    }

    const card = document.createElement('div')
    card.className = 'tm-itinerary-card'
    const head = document.createElement('div')
    head.className = 'tm-itinerary-head'
    const title = document.createElement('div')
    title.className = 'tm-itinerary-title'
    title.textContent = '当前行程'
    const actions = document.createElement('div')
    actions.className = 'tm-saved-actions'
    actions.append(
      this.miniButton('复制行程', () => this.copyItinerary()),
      this.miniButton('重新规划', () => this.replanItinerary()),
      this.miniButton('清除', () => this.clearItinerary()),
    )
    if (this.currentRoute) {
      if (this.moving) actions.append(this.miniButton('停止', () => this.stopMovement()))
      else actions.append(this.miniButton('开始移动', () => this.startMovement()))
    }
    head.append(title, actions)

    const routeLine = document.createElement('div')
    routeLine.className = 'tm-itinerary-route'
    routeLine.textContent = `${itinerary.from.name} → ${itinerary.to.name}`
    const meta = document.createElement('div')
    meta.className = 'tm-itinerary-meta'
    meta.textContent = `步行 ${formatDistance(itinerary.distance)} · 约 ${formatDurationShort(itinerary.duration)}${
      itinerary.fallback ? ' · 直线估计' : ''
    }`
    const ai = document.createElement('label')
    ai.className = 'tm-route-ai'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.dataset.routeAi = ''
    checkbox.checked = itinerary.showToAI
    const aiText = document.createElement('span')
    aiText.textContent = '把行程显示给 AI'
    ai.append(checkbox, aiText)

    const progress = document.createElement('div')
    progress.className = 'tm-route-progress'
    const bar = document.createElement('div')
    bar.className = 'tm-route-bar'
    bar.style.width = `${Math.round(this.moveProgress * 100)}%`
    progress.append(bar)

    const steps = document.createElement('ol')
    steps.className = 'tm-route-steps'
    this.fillRouteSteps(steps, itinerary)

    card.append(head, routeLine, meta, ai, progress, steps)
    this.listEl.append(card)
    this.syncRouteAiCheckboxes()
  }

  private startMovement(): void {
    const route = this.currentRoute
    const itinerary = this.state.itinerary
    if (!route || !itinerary || this.moving) return
    const coordinates = route.coordinates
    if (coordinates.length < 2) return
    this.moving = true
    this.moveProgress = 0
    this.placeStartEl.hidden = true
    this.placeStopEl.hidden = false
    this.placeProgressEl.hidden = false
    this.updateRouteBars(0)
    this.setStatus('开始移动…')

    const cumulative: number[] = [0]
    for (let index = 1; index < coordinates.length; index += 1) {
      const [lng1, lat1] = coordinates[index - 1]
      const [lng2, lat2] = coordinates[index]
      cumulative.push(cumulative[index - 1] + haversine(lat1, lng1, lat2, lng2))
    }
    const total = cumulative[cumulative.length - 1] || route.distance || 1
    const duration = Math.min(10000, Math.max(2500, total * 10))
    const started = performance.now()

    const tick = (now: number): void => {
      if (!this.moving) return
      const progress = Math.min(1, (now - started) / duration)
      this.moveProgress = progress
      const target = total * progress
      const point = this.interpolateRoute(coordinates, cumulative, target)
      this.marker?.setLngLat(point)
      this.updateRouteBars(progress)
      this.setStatus(`移动中… ${formatDistance(target)} / ${formatDistance(total)}`)
      if (progress < 1) {
        this.moveFrame = window.requestAnimationFrame(tick)
      } else {
        this.finishMovement(itinerary.to)
      }
    }
    this.moveFrame = window.requestAnimationFrame(tick)
    if (this.tab === 'route') this.render()
    else this.renderPlace()
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

  private finishMovement(destination: { name: string; lat: number; lng: number }): void {
    this.moveFrame = null
    this.moving = false
    this.moveProgress = 1
    this.updateRouteBars(1)
    this.clearRouteLine()
    this.placeStartEl.hidden = true
    this.placeStopEl.hidden = true
    this.placeProgressEl.hidden = false
    void this.moveTo(destination.lat, destination.lng, false)
    this.setStatus(`已到达 ${destination.name}`)
    this.renderPlace()
    if (this.tab === 'route') this.render()
  }

  private stopMovement(): void {
    if (!this.moving) return
    this.moving = false
    if (this.moveFrame !== null) window.cancelAnimationFrame(this.moveFrame)
    this.moveFrame = null
    this.moveProgress = 0
    this.marker?.setLngLat([this.state.center.lng, this.state.center.lat])
    this.updateRouteBars(0)
    this.placeStartEl.hidden = !this.currentRoute
    this.placeStopEl.hidden = true
    this.placeProgressEl.hidden = true
    this.setStatus('已停止移动')
    this.renderPlace()
    if (this.tab === 'route') this.render()
  }

  private recenterOnPerson(): void {
    const map = this.map
    if (!map) return
    map.flyTo({
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
      const results = await searchPlaces(query)
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
      meta.textContent = [result.resultType, result.address].filter(Boolean).join(' · ')
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
    this.seq += 1
    this.wikiSeq += 1
    this.fullSeq += 1

    this.clearRouteLine()
    this.state.center = { lat: result.lat, lng: result.lng }
    this.state.place = result
    this.state.nearby = []
    this.state.wiki = []
    this.currentWiki = null
    this.currentPlace = null
    this.wikiFullText = null
    this.wikiLangLinks = {}
    this.wikiEl.hidden = true
    this.placeEl.hidden = true
    this.marker?.setLngLat([result.lng, result.lat])

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
    this.drawRadius()
    this.commit()

    if (result.resultType === 'country' || result.resultType === 'state' || result.resultType === 'region') {
      this.setStatus('已定位到国家/地区，点击地图选择具体地点')
      return
    }
    this.setStatus('正在获取地点信息…')
    this.scheduleRefresh(0)
    window.setTimeout(() => {
      if (!this.panelEl.hidden && this.state.place === result) this.openPlace(result)
    }, 180)
  }

  private onRadiusInput(): void {
    const raw = Number(this.radiusInputEl.value)
    const value = Number.isFinite(raw) ? Math.min(1000, Math.max(50, Math.round(raw))) : this.settings.radiusM
    this.settings = { ...this.settings, radiusM: value }
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

  private findSavedPlace(place: Place): SavedPlace | undefined {
    const key = placeKey(place)
    return this.state.savedPlaces.find((item) => placeKey(item) === key)
  }

  private toggleSavedPlace(place: Place): void {
    const key = placeKey(place)
    const index = this.state.savedPlaces.findIndex((item) => placeKey(item) === key)
    if (index >= 0) {
      this.state.savedPlaces.splice(index, 1)
      this.toast('已从 AI 上下文移除')
    } else {
      this.state.savedPlaces.push({ ...place, note: '', savedAt: Date.now() })
      this.toast('已加入 AI 上下文；可在“收藏”里写笔记')
    }
    this.commit()
    if (this.currentPlace) this.renderPlace()
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
    return this.state.stars.find(
      (item) => wikiKey(item.lang ?? 'en', item.pageId) === wikiKey(lang, page.pageId),
    )
  }

  private removeStar(page: { lang?: string; pageId?: number; title: string }): void {
    const lang = page.lang || 'en'
    const title = page.title.trim().toLowerCase()
    this.state.stars = this.state.stars.filter((item) => {
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
    const star = this.findStar(page)
    if (star) {
      this.wikiMode = star.contextMode ?? 'intro'
      if (this.wikiMode === 'full' && star.fullText) this.wikiFullText = star.fullText
      if (page.extract && star.extract !== page.extract) {
        star.extract = page.extract
        this.sync()
        saveState(this.ctx, this.state)
      }
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
    saveState(this.ctx, this.state)
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
      this.renderWikiToolbar()
      this.renderAiLang()
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
    saveState(this.ctx, this.state)
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
    saveState(this.ctx, this.state)
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
    saveState(this.ctx, this.state)
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
    if (document.activeElement !== this.wikiNoteEl) this.wikiNoteEl.value = star?.note ?? ''
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
    this.aiLangHintEl.textContent = star ? '显示语言与 AI 语言可以不同' : '星标后可选择'
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
      saveState(this.ctx, this.state)
      return
    }
    try {
      const text = await wikiPageFull(star.aiLang, star.aiTitle)
      await cachePut(key, text)
      star.aiFullText = text
      this.sync()
      saveState(this.ctx, this.state)
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
    star.note = this.wikiNoteEl.value
    this.sync()
    this.wikiNoteStatusEl.textContent = '保存中…'
    this.scheduleNoteSave()
  }

  private scheduleNoteSave(): void {
    if (this.noteSaveTimer !== undefined) window.clearTimeout(this.noteSaveTimer)
    this.noteSaveTimer = window.setTimeout(() => {
      this.noteSaveTimer = undefined
      saveState(this.ctx, this.state)
      this.wikiNoteStatusEl.textContent = '已保存'
    }, 400)
  }

  private flushNoteSave(): void {
    if (this.noteSaveTimer !== undefined) {
      window.clearTimeout(this.noteSaveTimer)
      this.noteSaveTimer = undefined
    }
    saveState(this.ctx, this.state)
    this.wikiNoteStatusEl.textContent = '已保存'
  }

  private async toggleStar(): Promise<void> {
    const current = this.currentWiki
    if (!current) return
    const existing = this.findStar(current)
    if (existing) {
      this.removeStar(current)
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
      note: '',
      savedAt: Date.now(),
      contextMode,
      fullText,
    })
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
    const text = buildContext(this.state, this.settings)
    this.previewTextEl.textContent =
      text || '（尚未选择地点，也没有收藏条目；当前不会注入场景块。）'
    this.tokenEstimateEl.textContent = text
      ? `≈ ${estimateTokens(text)} tokens · 不裁剪`
      : '当前不会注入'
    this.previewEl.hidden = false
  }

  private async copyPreview(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.previewTextEl.textContent ?? '')
      this.toast('已复制')
    } catch {
      this.toast('复制失败，请手动选择文本')
    }
  }

  private readSettings(): void {
    const numberValue = (element: HTMLInputElement, fallback: number, min: number, max: number): number => {
      const value = Number(element.value)
      if (!Number.isFinite(value)) return fallback
      return Math.min(max, Math.max(min, value))
    }
    const selectedLangs = this.langEls.filter((input) => input.checked).map((input) => input.value)
    this.settings = {
      ...this.settings,
      enabled: this.enabledEl.checked,
      wikiLangs: selectedLangs.length > 0 ? selectedLangs : ['en'],
      radiusM: numberValue(this.radiusEl, this.settings.radiusM, 50, 1000),
      maxNearby: Math.round(numberValue(this.nearbyEl, this.settings.maxNearby, 0, 12)),
      depth: Math.round(numberValue(this.depthEl, this.settings.depth, 0, 10)),
    }
    saveSettings(this.ctx, this.settings)
    this.writeSettingsToForm()
    this.state.enabled = this.settings.enabled
    this.commit()
  }

  private writeSettingsToForm(): void {
    if (!this.enabledEl) return
    this.enabledEl.checked = this.settings.enabled
    for (const input of this.langEls) input.checked = this.settings.wikiLangs.includes(input.value)
    this.radiusEl.value = String(this.settings.radiusM)
    this.nearbyEl.value = String(this.settings.maxNearby)
    this.depthEl.value = String(this.settings.depth)
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
    this.state.stars = []
    this.state.savedPlaces = []
    this.state.poiBriefs = []
    this.state.poiAllToAI = false
    this.state.place = undefined
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
    this.commit()
    this.toast('已清空本聊天地的地点与收藏')
  }

  private onChatChanged(): void {
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
    this.pois = []
    this.poisById.clear()
    this.poiSeq += 1
    this.tab = this.state.lastTab ?? 'nearby'
    this.currentWiki = null
    this.currentPlace = null
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
      this.map.jumpTo({
        center: view ? [view.center.lng, view.center.lat] : [this.state.center.lng, this.state.center.lat],
        zoom: view?.zoom ?? this.state.zoom,
      })
      this.marker?.setLngLat([this.state.center.lng, this.state.center.lat])
    }
    this.drawRadius()
    this.updatePoiSource()
    this.syncPoiUi()
    this.commit()
    this.setStatus('')
    if (this.settings.showPois || this.state.poiAllToAI) {
      void this.refreshPois(this.state.center.lat, this.state.center.lng)
    }
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
    try {
      const raw = localStorage.getItem(FAB_POS_KEY)
      if (!raw) return
      const value = JSON.parse(raw) as { left?: number; top?: number }
      if (!Number.isFinite(value.left) || !Number.isFinite(value.top)) return
      const rect = fab.getBoundingClientRect()
      const left = Math.min(Math.max(0, value.left!), Math.max(0, window.innerWidth - rect.width))
      const top = Math.min(Math.max(0, value.top!), Math.max(0, window.innerHeight - rect.height))
      fab.style.left = `${left}px`
      fab.style.top = `${top}px`
      fab.style.right = 'auto'
      fab.style.bottom = 'auto'
    } catch {
      // localStorage can be unavailable in private or restricted contexts.
    }
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

  private applyPanelGeometry(): void {
    if (window.innerWidth <= 640) {
      for (const property of ['left', 'top', 'right', 'bottom', 'width', 'height']) {
        this.panelEl.style.removeProperty(property)
      }
      return
    }
    try {
      const raw = localStorage.getItem(PANEL_GEOMETRY_KEY)
      if (!raw) return
      const value = JSON.parse(raw) as { left?: number; top?: number; width?: number; height?: number }
      if (
        !Number.isFinite(value.left) ||
        !Number.isFinite(value.top) ||
        !Number.isFinite(value.width) ||
        !Number.isFinite(value.height)
      ) {
        return
      }
      const width = Math.min(Math.max(340, value.width!), window.innerWidth - 8)
      const height = Math.min(Math.max(420, value.height!), window.innerHeight - 8)
      const left = Math.min(Math.max(0, value.left!), Math.max(0, window.innerWidth - width))
      const top = Math.min(Math.max(0, value.top!), Math.max(0, window.innerHeight - height))
      this.panelEl.style.left = `${left}px`
      this.panelEl.style.top = `${top}px`
      this.panelEl.style.width = `${width}px`
      this.panelEl.style.height = `${height}px`
      this.panelEl.style.right = 'auto'
      this.panelEl.style.bottom = 'auto'
    } catch {
      // ignore malformed storage
    }
  }

  private resetPanelGeometry(): void {
    for (const property of ['left', 'top', 'right', 'bottom', 'width', 'height']) {
      this.panelEl.style.removeProperty(property)
    }
    try {
      localStorage.removeItem(PANEL_GEOMETRY_KEY)
    } catch {
      // ignore storage failures
    }
  }

  private bindPanelDrag(): void {
    const headers = [
      this.panelEl.querySelector(':scope > .tm-head'),
      this.wikiEl.querySelector(':scope > .tm-head'),
      this.placeEl.querySelector(':scope > .tm-head'),
    ].filter((header): header is HTMLElement => header instanceof HTMLElement)

    for (const header of headers) {
      header.addEventListener('pointerdown', (event) => {
        if (window.innerWidth <= 640) return
        if (
          header === this.placeEl.querySelector(':scope > .tm-head') &&
          this.placeEl.classList.contains('tm-place-inline')
        ) {
          return
        }
        const target = event.target as HTMLElement
        if (target.closest('button, input, select, a, textarea')) return
        const rect = this.panelEl.getBoundingClientRect()
        const startX = event.clientX
        const startY = event.clientY
        const startLeft = rect.left
        const startTop = rect.top
        let moved = false

        this.panelEl.style.left = `${rect.left}px`
        this.panelEl.style.top = `${rect.top}px`
        this.panelEl.style.width = `${rect.width}px`
        this.panelEl.style.height = `${rect.height}px`
        this.panelEl.style.right = 'auto'
        this.panelEl.style.bottom = 'auto'

        const onMove = (moveEvent: PointerEvent): void => {
          const dx = moveEvent.clientX - startX
          const dy = moveEvent.clientY - startY
          if (!moved && Math.hypot(dx, dy) < 4) return
          moved = true
          moveEvent.preventDefault()
          const left = Math.min(Math.max(0, startLeft + dx), Math.max(0, window.innerWidth - rect.width))
          const top = Math.min(Math.max(0, startTop + dy), Math.max(0, window.innerHeight - rect.height))
          this.panelEl.style.left = `${left}px`
          this.panelEl.style.top = `${top}px`
          document.body.style.userSelect = 'none'
        }
        const onUp = (): void => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          document.body.style.userSelect = ''
          if (!moved) return
          const finalRect = this.panelEl.getBoundingClientRect()
          try {
            localStorage.setItem(
              PANEL_GEOMETRY_KEY,
              JSON.stringify({
                left: finalRect.left,
                top: finalRect.top,
                width: finalRect.width,
                height: finalRect.height,
              }),
            )
          } catch {
            // ignore storage failures
          }
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp, { once: true })
        event.preventDefault()
      })

      header.addEventListener('dblclick', (event) => {
        if ((event.target as HTMLElement).closest('button')) return
        this.resetPanelGeometry()
      })
    }
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
    if (this.moveFrame !== null) window.cancelAnimationFrame(this.moveFrame)
    this.moveFrame = null
    this.moving = false
    this.clearRouteLine()
    this.resizeObserver?.disconnect()
    this.map?.remove()
    this.map = null
    this.marker = null
    window.removeEventListener('beforeunload', this.onUnload)
    document.getElementById('tm-fab')?.remove()
    this.panelEl?.remove()
    this.previewEl?.remove()
    document.getElementById('tm-settings')?.remove()
  }
}
