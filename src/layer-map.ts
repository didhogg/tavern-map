import { buildLayerContext } from './layer-context'
import { estimateTokens } from './context'
import {
  cleanSourceText,
  fallbackPackageName,
  parseFandomPackage,
  parseMapGeniePackage,
} from './layer-import'
import { getLayerPackage, listLayerPackages, putLayerPackage } from './layer-store'
import {
  DEFAULT_LAYER_STATE,
  loadLayerState,
  saveLayerState,
  type LayerChatState,
  type LayerContextSnapshot,
  type LayerLink,
  type LayerLinkKind,
  type LayerMapPackage,
  type LayerMarker,
  type LayerPackageMeta,
  type LayerRegion,
  type LayerView,
} from './layer-types'
import { errorMessage } from './http'
import type { StContext } from './types'

const PANEL_ID = 'tm-layer'
const IMPORT_ID = 'tml-import'
const IMAGE_FIT_MARGIN = 0.94
const LABEL_IMAGE_ZOOM = 1.7
const LABEL_TILE_ZOOM = 11
const MARKER_HIT_RADIUS = 12
const REGION_HIT_MIN_ZOOM = 8
const MARKER_INDEX_CELL = 0.025
const LABEL_CELL_PX = 48
/** Decoded-tile cache only; imported tile files and map data are never discarded. */
const DECODED_TILE_MEMORY_BUDGET = 256 * 1024 * 1024
const TILE_LOAD_CONCURRENCY = 8

type TavernWindow = Window & {
  SillyTavern?: { getContext?: () => StContext }
}

type LayerMapCallbacks = {
  onChange: () => void
  onRealMap: () => void
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
      <button type="button" class="active" aria-selected="true">图层地图</button>
    </div>
    <div class="tml-head-center">
      <select id="tml-package" class="tml-select" aria-label="选择地图包"></select>
      <button type="button" class="tml-btn" data-action="import">导入</button>
    </div>
    <div class="tml-head-actions">
      <button type="button" class="tml-btn" data-action="ai">AI 上下文</button>
      <button type="button" class="tml-close" data-action="close" title="关闭">×</button>
    </div>
  </header>
  <div class="tml-body">
    <aside class="tml-left">
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
          <button type="button" class="tml-tool tml-mobile-only" data-action="filters">图层</button>
          <button type="button" class="tml-tool" data-action="zoom-out" aria-label="缩小">−</button>
          <button type="button" class="tml-tool" data-action="zoom-in" aria-label="放大">+</button>
          <button type="button" class="tml-tool" data-action="fit">适配</button>
        </div>
      </div>
      <div id="tml-viewport" class="tml-viewport">
        <canvas id="tml-canvas"></canvas>
        <div id="tml-empty" class="tml-empty" hidden></div>
        <div class="tml-map-status">
          <span id="tml-zoom">—</span>
          <span id="tml-scale">比例未校准</span>
        </div>
      </div>
    </main>
    <aside id="tml-inspector" class="tml-inspector">
      <div id="tml-detail"></div>
    </aside>
  </div>
  <footer class="tml-foot">
    <span id="tml-attribution">本地地图包 · 数据不会上传</span>
    <span id="tml-context-status">AI 上下文：待机</span>
  </footer>
</section>
<div id="${IMPORT_ID}" class="tml-modal" role="dialog" aria-modal="true" aria-label="导入地图包" hidden>
  <div class="tml-modal-card">
    <header class="tml-modal-head">
      <strong>导入地图包</strong>
      <button type="button" class="tml-close" data-import-action="close">×</button>
    </header>
    <div class="tml-import-tabs" role="tablist">
      <button type="button" class="active" data-import-tab="fandom">Fandom JSON + 图片</button>
      <button type="button" data-import-tab="mapgenie">Map Genie JSON + 瓦片</button>
    </div>
    <div class="tml-import-body">
      <div id="tml-import-fandom">
        <label class="tml-field">JSON 文件
          <input id="tml-fandom-json" type="file" accept=".json,application/json">
        </label>
        <label class="tml-field">底图图片
          <input id="tml-fandom-image" type="file" accept="image/*">
        </label>
        <label class="tml-field">地图包名称
          <input id="tml-fandom-name" type="text" placeholder="例如：深水城">
        </label>
        <p class="tml-hint">读取 Fandom 导出的 markers JSON 和一张本地底图。不会访问 Fandom 服务器。支持 PNG / JPG / WebP。</p>
      </div>
      <div id="tml-import-mapgenie" hidden>
        <label class="tml-field">mapData JSON
          <input id="tml-mapgenie-json" type="file" accept=".json,application/json">
        </label>
        <label class="tml-field">瓦片 URL 模板
          <input id="tml-mapgenie-tiles" type="text" placeholder="http://127.0.0.1:8000/{z}/{y}/{x}.jpg">
        </label>
        <label class="tml-field">或选择瓦片文件夹
          <input id="tml-mapgenie-folder" type="file" multiple webkitdirectory>
        </label>
        <label class="tml-field">地图包名称
          <input id="tml-mapgenie-name" type="text" placeholder="例如：Leonida">
        </label>
        <p class="tml-hint">URL 模板必须包含 {z}、{y}、{x}；也可直接选择瓦片文件夹（结构 z/y/x.jpg）。不会请求 Map Genie 线上瓦片；所有选中的瓦片都会保留。</p>
      </div>
      <div id="tml-import-status" class="tml-import-status" role="status"></div>
    </div>
    <footer class="tml-modal-foot">
      <button type="button" class="tml-btn" data-import-action="cancel">取消</button>
      <button type="button" class="tml-btn tml-primary" data-import-action="run">导入并打开</button>
    </footer>
  </div>
</div>
<div id="tml-context" class="tml-modal" role="dialog" aria-modal="true" aria-label="图层地图 AI 上下文" hidden>
  <div class="tml-modal-card tml-context-card">
    <header class="tml-modal-head">
      <strong>图层地图 · AI 上下文</strong>
      <button type="button" class="tml-close" data-context-action="close">×</button>
    </header>
    <div class="tml-context-body">
      <pre id="tml-context-text"></pre>
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
  private view: LayerView = { cx: 0.5, cy: 0.5, zoom: 1 }
  private image: HTMLImageElement | null = null
  private imageUrl: string | null = null
  private readonly tileCache = new Map<string, HTMLImageElement | 'loading' | 'error'>()
  private readonly tileFileUrls = new Map<string, string>()
  private readonly markerRegionCache = new Map<string, LayerRegion | undefined>()
  private readonly markerIndex = new Map<string, LayerMarker[]>()
  private readonly labelCells = new Set<string>()
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
  private linkDraftVisible = false
  private linkDraftTitle = ''
  private linkDraftUrl = ''
  private linkDraftKind: LayerLinkKind = 'custom'
  private importTab: 'fandom' | 'mapgenie' = 'fandom'
  private importing = false
  private emptyMessage = ''

  private panelEl!: HTMLElement
  private canvasEl!: HTMLCanvasElement
  private viewportEl!: HTMLElement
  private packageSelectEl!: HTMLSelectElement
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
  private importEl!: HTMLElement
  private importStatusEl!: HTMLElement
  private contextModalEl!: HTMLElement
  private contextTextEl!: HTMLElement
  private contextTokensEl!: HTMLElement
  private fandomJsonEl!: HTMLInputElement
  private fandomImageEl!: HTMLInputElement
  private fandomNameEl!: HTMLInputElement
  private mapgenieJsonEl!: HTMLInputElement
  private mapgenieTilesEl!: HTMLInputElement
  private mapgenieFolderEl!: HTMLInputElement
  private mapgenieNameEl!: HTMLInputElement
  private fandomPaneEl!: HTMLElement
  private mapgeniePaneEl!: HTMLElement

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    const target = event.target as HTMLElement | null
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
    if (!this.contextModalEl.hidden) {
      this.contextModalEl.hidden = true
      return
    }
    if (!this.importEl.hidden) {
      this.closeImport()
      return
    }
    if (!this.searchResultsEl.hidden) {
      this.hideSearch()
      return
    }
    if (!this.panelEl.hidden) this.close()
  }

  private readonly onDocumentClick = (event: MouseEvent): void => {
    if (!this.searchResultsEl.contains(event.target as Node) && event.target !== this.searchEl) {
      this.hideSearch()
    }
  }

  constructor(ctx: StContext, callbacks: LayerMapCallbacks) {
    this.ctx = ctx
    this.callbacks = callbacks
    this.state = loadLayerState(ctx)
    this.mount()
    this.bind()
    this.renderDetail()
    this.renderCategories()
  }

  contextText(): string {
    return buildLayerContext(this.state)
  }

  isOpen(): boolean {
    return !this.panelEl.hidden
  }

  async open(): Promise<void> {
    this.panelEl.hidden = false
    this.active = true
    this.ctx = this.liveContext()
    this.state = loadLayerState(this.ctx)
    this.panelEl.style.zIndex = '10000'
    await this.refreshPackages()
    const wanted =
      (this.state.packageId && this.metas.some((meta) => meta.id === this.state.packageId)
        ? this.state.packageId
        : this.metas[0]?.id) ?? undefined
    if (wanted) {
      await this.loadPackage(wanted)
    } else {
      this.pkg = null
      this.image = null
      if (this.imageUrl) {
        URL.revokeObjectURL(this.imageUrl)
        this.imageUrl = null
      }
      this.clearTileCaches()
      this.renderEmpty('还没有地图包。点右上角“导入”读取本地 Fandom 或 Map Genie 数据。')
      this.renderCategories()
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
    this.panelEl.hidden = true
    this.active = false
    if (this.drawFrame) {
      window.cancelAnimationFrame(this.drawFrame)
      this.drawFrame = 0
    }
    this.persist(true)
    this.hideSearch()
  }

  handleChatChanged(): void {
    this.ctx = this.liveContext()
    this.state = loadLayerState(this.ctx)
    this.pkg = null
    this.image = null
    this.clearTileCaches()
    if (this.imageUrl) {
      URL.revokeObjectURL(this.imageUrl)
      this.imageUrl = null
    }
    if (this.active) {
      void this.open()
    } else {
      this.renderDetail()
      this.renderCategories()
    }
  }

  clearChat(): void {
    this.state = structuredClone(DEFAULT_LAYER_STATE)
    this.state.updatedAt = Date.now()
    this.pkg = null
    this.image = null
    this.imageUrl = null
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
    this.viewportEl = document.getElementById('tml-viewport') as HTMLElement
    this.packageSelectEl = document.getElementById('tml-package') as HTMLSelectElement
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
    this.importEl = document.getElementById(IMPORT_ID) as HTMLElement
    this.importStatusEl = document.getElementById('tml-import-status') as HTMLElement
    this.contextModalEl = document.getElementById('tml-context') as HTMLElement
    this.contextTextEl = document.getElementById('tml-context-text') as HTMLElement
    this.contextTokensEl = document.getElementById('tml-context-tokens') as HTMLElement
    this.fandomJsonEl = document.getElementById('tml-fandom-json') as HTMLInputElement
    this.fandomImageEl = document.getElementById('tml-fandom-image') as HTMLInputElement
    this.fandomNameEl = document.getElementById('tml-fandom-name') as HTMLInputElement
    this.mapgenieJsonEl = document.getElementById('tml-mapgenie-json') as HTMLInputElement
    this.mapgenieTilesEl = document.getElementById('tml-mapgenie-tiles') as HTMLInputElement
    this.mapgenieFolderEl = document.getElementById('tml-mapgenie-folder') as HTMLInputElement
    this.mapgenieNameEl = document.getElementById('tml-mapgenie-name') as HTMLInputElement
    this.fandomPaneEl = document.getElementById('tml-import-fandom') as HTMLElement
    this.mapgeniePaneEl = document.getElementById('tml-import-mapgenie') as HTMLElement
  }

  private bind(): void {
    this.panelEl.addEventListener('click', (event) => this.onPanelClick(event))
    this.canvasEl.addEventListener('pointerdown', (event) => this.onPointerDown(event))
    this.canvasEl.addEventListener('pointermove', (event) => this.onPointerMove(event))
    this.canvasEl.addEventListener('pointerup', (event) => this.onPointerUp(event))
    this.canvasEl.addEventListener('pointercancel', (event) => this.onPointerUp(event))
    this.canvasEl.addEventListener('wheel', (event) => this.onWheel(event), { passive: false })
    this.canvasEl.addEventListener('dblclick', (event) => this.onDoubleClick(event))
    this.searchEl.addEventListener('input', () => this.onSearchInput())
    this.searchEl.addEventListener('keydown', (event) => this.onSearchKeyDown(event))
    this.categoryFilterEl.addEventListener('input', () => this.renderCategories())
    this.packageSelectEl.addEventListener('change', () => {
      const id = this.packageSelectEl.value
      if (id) void this.loadPackage(id)
    })
    this.importEl.addEventListener('click', (event) => this.onImportClick(event))
    this.contextModalEl.addEventListener('click', (event) => {
      const target = event.target as HTMLElement
      if (target.closest('[data-context-action="close"]') || target === this.contextModalEl) {
        this.contextModalEl.hidden = true
      }
    })
    for (const input of [this.fandomJsonEl, this.fandomImageEl, this.mapgenieJsonEl]) {
      input.addEventListener('change', () => this.updateImportNames())
    }
    document.addEventListener('keydown', this.onKeyDown)
    document.addEventListener('click', this.onDocumentClick)
    this.offs.push(() => document.removeEventListener('keydown', this.onKeyDown))
    this.offs.push(() => document.removeEventListener('click', this.onDocumentClick))
  }

  private readonly offs: Array<() => void> = []

  private onPanelClick(event: MouseEvent): void {
    const target = event.target as HTMLElement
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
        this.state.showLabels = !this.state.showLabels
        this.syncToolButtons()
        this.persist()
        this.requestDraw()
        break
      case 'regions':
        this.state.showRegions = !this.state.showRegions
        this.syncToolButtons()
        this.persist()
        this.requestDraw()
        break
      case 'show-all':
        this.state.hiddenCategories = []
        this.renderCategories()
        this.persist()
        this.requestDraw()
        break
      case 'hide-all':
        this.state.hiddenCategories = this.pkg?.categories.map((category) => category.id) ?? []
        this.renderCategories()
        this.persist()
        this.requestDraw()
        break
      default:
        break
    }
  }

  private showContextStatus(): void {
    const text = this.contextText()
    this.contextTextEl.textContent =
      text || '（还没有当前地点或当前区域。先点一个地点并“设为当前”。）'
    this.contextTokensEl.textContent = text ? `≈ ${estimateTokens(text)} tokens · 是否注入取决于扩展设置` : '当前不会注入'
    this.contextStatusEl.textContent = text ? '图层上下文：已生成' : '图层上下文：待机'
    this.contextStatusEl.title = text || '没有可注入的图层地图上下文'
    this.contextModalEl.hidden = false
  }

  private syncToolButtons(): void {
    const labels = this.panelEl.querySelector<HTMLElement>('[data-action="labels"]')
    const regions = this.panelEl.querySelector<HTMLElement>('[data-action="regions"]')
    labels?.classList.toggle('active', this.state.showLabels !== false)
    labels?.setAttribute('aria-pressed', String(this.state.showLabels !== false))
    regions?.classList.toggle('active', this.state.showRegions !== false)
    regions?.setAttribute('aria-pressed', String(this.state.showRegions !== false))
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
        new Option(`${meta.kind === 'tiles' ? '▦' : '▣'} ${meta.name}`, meta.id),
      )
    }
    if (this.state.packageId && this.metas.some((meta) => meta.id === this.state.packageId)) {
      this.packageSelectEl.value = this.state.packageId
    }
  }

  private async loadPackage(id: string): Promise<void> {
    const pkg = await getLayerPackage(id)
    if (!pkg) {
      this.pkg = null
      this.renderEmpty('地图包读取失败或已不存在。')
      this.renderCategories()
      this.renderDetail()
      this.requestDraw()
      return
    }
    const changed = this.state.packageId !== pkg.id
    if (changed) {
      this.state.packageId = pkg.id
      this.state.selectedMarkerId = undefined
      this.state.currentMarkerId = undefined
      this.state.selectedRegionId = undefined
      this.state.currentRegionId = undefined
      this.state.view = undefined
      this.state.hiddenCategories = []
      this.linkDraftVisible = false
    }
    this.pkg = pkg
    this.panelEl.classList.remove('filters-open')
    this.emptyMessage = ''
    this.emptyEl.hidden = true
    this.markerRegionCache.clear()
    this.buildMarkerIndex()
    this.clearTileCaches()
    this.packageSelectEl.value = pkg.id
    this.view = this.resolveView(pkg, this.state.view)
    this.state.view = this.view
    this.loadImage(pkg)
    this.renderCategories()
    this.renderDetail()
    this.syncToolButtons()
    this.packageInfoEl.textContent = [
      pkg.kind === 'tiles' ? '瓦片地图' : '图片地图',
      `${pkg.markers.length} 个地点`,
      pkg.regions.length ? `${pkg.regions.length} 个区域` : '无区域面',
      pkg.source === 'mapgenie' ? 'Map Genie' : pkg.source === 'fandom' ? 'Fandom' : '本地',
    ].join(' · ')
    this.attributionEl.textContent = `${pkg.attribution ?? '本地地图包'} · 数据不会上传`
    this.refreshContext()
    this.requestDraw()
  }

  private resolveView(pkg: LayerMapPackage, previous: LayerView | undefined): LayerView {
    if (previous) return previous
    return this.defaultView(pkg)
  }

  private defaultView(pkg: LayerMapPackage): LayerView {
    if (pkg.kind === 'image') return { cx: 0.5, cy: 0.5, zoom: 1 }
    const tile = pkg.tile
    const min = tile?.minZoom ?? 0
    const max = tile?.maxZoom ?? min + 8
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

  private loadImage(pkg: LayerMapPackage): void {
    if (this.imageUrl) {
      URL.revokeObjectURL(this.imageUrl)
      this.imageUrl = null
    }
    this.image = null
    if (!pkg.image) {
      this.requestDraw()
      return
    }
    const url = URL.createObjectURL(pkg.image)
    this.imageUrl = url
    const image = new Image()
    image.onload = () => {
      if (this.imageUrl !== url) return
      this.image = image
      this.emptyMessage = ''
      this.emptyEl.hidden = true
      this.requestDraw()
    }
    image.onerror = () => {
      if (this.imageUrl !== url) return
      this.image = null
      this.renderEmpty('底图加载失败。可以重新导入图片。')
      this.requestDraw()
    }
    image.src = url
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
    context.fillStyle = this.pkg?.tile?.backgroundColor ?? '#0a0f14'
    context.fillRect(0, 0, width, height)
    if (!this.pkg) {
      this.updateStatus()
      return
    }
    if (this.pkg.kind === 'image') this.drawImageMap(context, width, height)
    else this.drawTileMap(context, width, height)
    this.drawRegions(context, width, height)
    this.drawMarkers(context, width, height)
    this.updateStatus()
  }

  private drawImageMap(context: CanvasRenderingContext2D, width: number, height: number): void {
    const pkg = this.pkg
    if (!pkg) return
    const fit = Math.min(width / pkg.width, height / pkg.height) * IMAGE_FIT_MARGIN
    const scale = fit * this.view.zoom
    const drawWidth = pkg.width * scale
    const drawHeight = pkg.height * scale
    const left = width / 2 - this.view.cx * drawWidth
    const top = height / 2 - this.view.cy * drawHeight
    if (this.image) {
      context.drawImage(this.image, left, top, drawWidth, drawHeight)
    } else {
      context.fillStyle = '#101820'
      context.fillRect(left, top, drawWidth, drawHeight)
      context.fillStyle = '#95a3ae'
      context.font = '12px system-ui, sans-serif'
      context.textAlign = 'center'
      context.fillText('底图加载中…', width / 2, height / 2)
    }
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
    const z = Math.min(tile.maxZoom, Math.max(tile.minZoom, Math.round(this.view.zoom)))
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
    if (pkg.kind === 'tiles' && this.view.zoom < REGION_HIT_MIN_ZOOM) return
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

  private drawMarkers(context: CanvasRenderingContext2D, width: number, height: number): void {
    const pkg = this.pkg
    if (!pkg) return
    const hidden = new Set(this.state.hiddenCategories ?? [])
    const categories = new Map(pkg.categories.map((category) => [category.id, category]))
    const selectedId = this.state.selectedMarkerId
    const currentId = this.state.currentMarkerId
    const labelThreshold = pkg.kind === 'image' ? LABEL_IMAGE_ZOOM : LABEL_TILE_ZOOM
    const showLabels = this.state.showLabels !== false && this.view.zoom >= labelThreshold
    const visible = this.markersInView(width, height).filter(
      (marker) => !hidden.has(marker.categoryId),
    )
    this.labelCells.clear()
    for (const marker of visible) {
      const [x, y] = this.project(marker.x, marker.y, width, height)
      const category = categories.get(marker.categoryId)
      const selected = marker.id === selectedId
      const current = marker.id === currentId
      context.save()
      context.beginPath()
      context.arc(x, y, current ? 7 : selected ? 6.5 : 4.5, 0, Math.PI * 2)
      context.fillStyle = category?.color ?? '#e6b56a'
      context.globalAlpha = current || selected ? 1 : 0.9
      context.fill()
      context.globalAlpha = 1
      context.lineWidth = current ? 3 : selected ? 2 : 1.2
      context.strokeStyle = current ? '#ffffff' : selected ? '#f3c87f' : 'rgba(255,255,255,0.8)'
      context.stroke()
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
    const x0 = Math.floor(x / LABEL_CELL_PX)
    const x1 = Math.floor((x + width) / LABEL_CELL_PX)
    const y0 = Math.floor(y / LABEL_CELL_PX)
    const y1 = Math.floor((y + height) / LABEL_CELL_PX)
    const keys: string[] = []
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) keys.push(`${cx}:${cy}`)
    }
    return keys
  }

  private project(x: number, y: number, width: number, height: number): [number, number] {
    const pkg = this.pkg
    if (!pkg) return [0, 0]
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
    const visible = pkg.markers.filter((marker) => !hidden.has(marker.categoryId)).length
    this.visibleCountEl.textContent = `${visible}/${pkg.markers.length}`
    this.zoomEl.textContent = pkg.kind === 'tiles' ? `Z ${this.view.zoom.toFixed(1)}` : `${this.view.zoom.toFixed(2)}×`
    this.scaleEl.textContent =
      pkg.kind === 'tiles' ? '地图单位未校准' : '图片像素 · 比例未校准'
    this.emptyEl.hidden = !this.emptyMessage
    this.contextStatusEl.textContent = this.state.context ? '图层上下文：已生成' : '图层上下文：待机'
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return
    this.dragging = true
    this.moved = false
    this.dragX = event.clientX
    this.dragY = event.clientY
    this.canvasEl.setPointerCapture(event.pointerId)
    this.canvasEl.style.cursor = 'grabbing'
  }

  private onPointerMove(event: PointerEvent): void {
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
    if (!this.dragging) return
    this.dragging = false
    if (this.canvasEl.hasPointerCapture(event.pointerId)) {
      this.canvasEl.releasePointerCapture(event.pointerId)
    }
    this.canvasEl.style.cursor = 'grab'
    if (!this.moved && !this.suppressClick) {
      this.pickAt(event.clientX, event.clientY)
    }
    this.suppressClick = false
    this.state.view = this.view
    this.persist()
  }

  private onWheel(event: WheelEvent): void {
    if (!this.pkg) return
    event.preventDefault()
    const rect = this.canvasEl.getBoundingClientRect()
    const factor = Math.exp(-event.deltaY * 0.0015)
    this.zoomAt(event.clientX - rect.left, event.clientY - rect.top, factor)
  }

  private onDoubleClick(event: MouseEvent): void {
    const rect = this.canvasEl.getBoundingClientRect()
    this.zoomAt(event.clientX - rect.left, event.clientY - rect.top, 1.6)
  }

  private zoomAt(sx: number, sy: number, factor: number): void {
    if (!this.pkg) return
    const width = this.canvasEl.clientWidth || 1
    const height = this.canvasEl.clientHeight || 1
    const before = this.unproject(sx, sy, width, height)
    if (this.pkg.kind === 'image') {
      this.view.zoom = Math.min(8, Math.max(0.5, this.view.zoom * factor))
    } else {
      const tile = this.pkg.tile
      const min = tile?.minZoom ?? 0
      const max = tile?.maxZoom ?? min + 8
      this.view.zoom = Math.min(max + 1.2, Math.max(min, this.view.zoom + Math.log2(factor)))
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
    if (!this.pkg) return
    this.view = this.defaultView(this.pkg)
    this.state.view = this.view
    this.persist()
    this.requestDraw()
  }

  private pickAt(clientX: number, clientY: number): void {
    const rect = this.canvasEl.getBoundingClientRect()
    const sx = clientX - rect.left
    const sy = clientY - rect.top
    const marker = this.hitMarker(sx, sy)
    if (marker) {
      this.selectMarker(marker)
      return
    }
    const region = this.hitRegion(sx, sy)
    if (region) {
      this.state.selectedRegionId = region.id
      this.state.selectedMarkerId = undefined
      this.renderDetail()
      this.persist()
      this.requestDraw()
      return
    }
    this.state.selectedMarkerId = undefined
    this.state.selectedRegionId = undefined
    this.renderDetail()
    this.persist()
    this.requestDraw()
  }

  private buildMarkerIndex(): void {
    this.markerIndex.clear()
    for (const marker of this.pkg?.markers ?? []) {
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
    const x0 = Math.floor(minX / MARKER_INDEX_CELL)
    const x1 = Math.floor(maxX / MARKER_INDEX_CELL)
    const y0 = Math.floor(minY / MARKER_INDEX_CELL)
    const y1 = Math.floor(maxY / MARKER_INDEX_CELL)
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
    for (const marker of this.markersInView(width, height)) {
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
    if (center) this.centerOnMarker(marker)
    this.renderDetail()
    this.persist()
    this.requestDraw()
  }

  private centerOnMarker(marker: LayerMarker): void {
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
      this.view.cx = (minX + maxX) / 2
      this.view.cy = (minY + maxY) / 2
      this.clampView()
      this.state.view = this.view
      this.persist()
      this.requestDraw()
    }
  }

  private categoryColor(seed: string): string {
    const category = this.pkg?.categories.find((item) => item.id === seed)
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
    for (const marker of pkg.markers) {
      counts.set(marker.categoryId, (counts.get(marker.categoryId) ?? 0) + 1)
    }
    const groups = new Map<string, { name: string; order: number; categories: typeof pkg.categories }>()
    for (const category of pkg.categories) {
      const groupId = category.groupId ?? '__ungrouped'
      const group = pkg.groups.find((item) => item.id === category.groupId)
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
    this.detailEl.replaceChildren()
    const pkg = this.pkg
    if (!pkg) {
      this.detailEl.append(textElement('div', 'tml-empty-small', '导入一张地图，然后点地图上的地点。'))
      return
    }
    if (this.state.selectedMarkerId) {
      const marker = pkg.markers.find((item) => item.id === this.state.selectedMarkerId)
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
    const current = this.currentMarker()
    if (current) {
      this.detailEl.append(this.markerDetail(current))
      return
    }
    this.detailEl.append(
      textElement('div', 'tml-empty-small', '点地图上的地点查看详情；也可以搜索或使用左侧分类。'),
    )
  }

  private markerDetail(marker: LayerMarker): HTMLElement {
    const pkg = this.pkg
    if (!pkg) return textElement('div', 'tml-empty-small', '')
    const category = pkg.categories.find((item) => item.id === marker.categoryId)
    const region = this.regionForMarker(marker)
    const current = this.state.currentMarkerId === marker.id
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
    })
    head.append(titleWrap, close)
    const meta = document.createElement('div')
    meta.className = 'tml-detail-meta'
    meta.textContent = [
      region?.name ?? '',
      marker.sourceId ? `来源 id ${marker.sourceId}` : '',
      pkg.source === 'mapgenie' ? 'Map Genie 本地快照' : 'Fandom 本地导入',
    ]
      .filter(Boolean)
      .join(' · ')
    const actions = document.createElement('div')
    actions.className = 'tml-detail-actions'
    actions.append(
      this.actionButton('居中', () => this.centerOnMarker(marker)),
      this.actionButton(current ? '取消当前' : '设为当前', () => this.toggleCurrent(marker), current),
    )
    wrap.append(head, meta, actions)
    if (marker.description) {
      const details = document.createElement('details')
      details.className = 'tml-source'
      details.open = true
      const summary = document.createElement('summary')
      summary.textContent = '来源资料（只读）'
      const body = document.createElement('div')
      body.className = 'tml-source-text'
      body.textContent = cleanSourceText(marker.description)
      details.append(summary, body)
      wrap.append(details)
    }
    wrap.append(this.linksSection(marker))
    wrap.append(this.noteSection(marker))
    const ai = document.createElement('div')
    ai.className = 'tml-ai-row'
    const aiLabel = document.createElement('span')
    aiLabel.textContent = current ? '当前地点会进入 AI 上下文' : '设为当前后才进入 AI 上下文'
    const preview = this.actionButton('预览 AI', () => this.showContextStatus())
    ai.append(aiLabel, preview)
    wrap.append(ai)
    return wrap
  }

  private regionDetail(region: LayerRegion): HTMLElement {
    const pkg = this.pkg
    if (!pkg) return textElement('div', 'tml-empty-small', '')
    const current = this.state.currentRegionId === region.id
    const count = pkg.markers.filter((marker) => this.regionForMarker(marker)?.id === region.id).length
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
    actions.append(
      this.actionButton('居中', () => this.centerOnRegion(region)),
      this.actionButton(current ? '取消当前区域' : '设为当前区域', () => this.toggleCurrentRegion(region), current),
    )
    wrap.append(head, meta, actions)
    const noteKey = `region:${region.id}`
    const noteWrap = document.createElement('div')
    noteWrap.className = 'tml-note-section'
    const label = document.createElement('label')
    label.textContent = '区域笔记'
    const textarea = document.createElement('textarea')
    textarea.placeholder = '写一段区域笔记…'
    textarea.value = this.state.notes?.[noteKey] ?? ''
    textarea.addEventListener('input', () => {
      const notes = this.state.notes ?? (this.state.notes = {})
      if (textarea.value.trim()) notes[noteKey] = textarea.value
      else delete notes[noteKey]
      this.refreshContext()
      this.persist()
    })
    label.append(textarea)
    noteWrap.append(label)
    wrap.append(noteWrap)
    return wrap
  }

  private linksSection(marker: LayerMarker): HTMLElement {
    const section = document.createElement('section')
    section.className = 'tml-links'
    const heading = document.createElement('div')
    heading.className = 'tml-section-label'
    heading.textContent = '链接来源'
    section.append(heading)
    const imported = marker.sourceLinks ?? (
      marker.sourceUrl
        ? [{
            id: `source:${marker.id}:wiki`,
            kind: 'wikipedia' as const,
            title: marker.sourceTitle || marker.name,
            url: marker.sourceUrl,
          }]
        : []
    )
    const userLinks = this.state.links?.[marker.id] ?? []
    if (imported.length === 0 && userLinks.length === 0) {
      section.append(textElement('div', 'tml-empty-small', '还没有链接。可以添加 Wikipedia、官网、点评页或自定义链接。'))
    }
    for (const link of imported) {
      const key = `${marker.id}:${link.id}`
      const saved = this.state.sourceLinkText?.[key]
      section.append(
        this.linkRow(marker, link, true, key, saved?.text, saved?.status),
      )
    }
    for (const link of userLinks) {
      section.append(this.linkRow(marker, link, false, undefined, link.text, link.status))
    }
    if (!this.linkDraftVisible) {
      const add = document.createElement('button')
      add.type = 'button'
      add.className = 'tml-mini tml-add-link'
      add.textContent = '+ 添加链接'
      add.addEventListener('click', () => {
        this.linkDraftVisible = true
        this.linkDraftTitle = ''
        this.linkDraftUrl = ''
        this.linkDraftKind = 'custom'
        this.renderDetail()
      })
      section.append(add)
    } else {
      section.append(this.linkEditor(marker))
    }
    return section
  }

  private linkRow(
    marker: LayerMarker,
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
    const text = savedText ?? link.text
    status.textContent =
      savedStatus ??
      (text ? `已保存正文 · ${text.length} 字` : imported ? '导入链接' : '未抓取')
    body.append(title, status)
    const actions = document.createElement('div')
    actions.className = 'tml-link-actions'
    const open = document.createElement('a')
    open.className = 'tml-mini'
    open.href = link.url
    open.target = '_blank'
    open.rel = 'noreferrer'
    open.textContent = '打开'
    actions.append(open)
    if (text) {
      const read = document.createElement('button')
      read.type = 'button'
      read.className = 'tml-mini'
      read.textContent = '正文'
      read.addEventListener('click', () => {
        const details = document.createElement('pre')
        details.className = 'tml-link-text'
        details.textContent = text
        row.append(details)
        read.remove()
      })
      actions.append(read)
    } else if (/^https?:\/\//i.test(link.url)) {
      const fetch = document.createElement('button')
      fetch.type = 'button'
      fetch.className = 'tml-mini'
      fetch.textContent = '抓取'
      fetch.addEventListener('click', () => void this.fetchLink(marker, link, imported, stateKey))
      actions.append(fetch)
    }
    const paste = document.createElement('button')
    paste.type = 'button'
    paste.className = 'tml-mini'
    paste.textContent = '粘贴'
    paste.addEventListener('click', () => {
      const pasted = window.prompt('粘贴正文（只保存在本地地图会话）', text ?? '')
      if (!pasted?.trim()) return
      this.storeLinkText(link, imported, stateKey, pasted, `已手动保存 · ${pasted.length} 字`)
      this.renderDetail()
      if (this.state.selectedMarkerId === marker.id) this.refreshContext()
    })
    actions.append(paste)
    if (!imported) {
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'tml-mini'
      remove.textContent = '移除'
      remove.addEventListener('click', () => {
        const linksForMarker = this.state.links?.[marker.id] ?? []
        this.state.links![marker.id] = linksForMarker.filter((item) => item.id !== link.id)
        this.refreshContext()
        this.persist()
        this.renderDetail()
      })
      actions.append(remove)
    }
    row.append(icon, body, actions)
    return row
  }

  private storeLinkText(
    link: LayerLink,
    imported: boolean,
    stateKey: string | undefined,
    text: string,
    status: string,
  ): void {
    if (imported && stateKey) {
      const target = this.state.sourceLinkText ?? (this.state.sourceLinkText = {})
      target[stateKey] = { text, status, fetchedAt: Date.now() }
    } else {
      link.text = text
      link.fetchedAt = Date.now()
      link.status = status
    }
    this.persist()
  }

  private linkEditor(marker: LayerMarker): HTMLElement {
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
      if (!/^https?:\/\//i.test(urlValue)) {
        this.toast('链接需要 http(s) 地址')
        return
      }
      const link: LayerLink = {
        id: `link:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
        kind: this.linkDraftKind,
        title: title.value.trim() || urlValue,
        url: urlValue,
      }
      const links = this.state.links?.[marker.id] ?? []
      this.state.links = this.state.links ?? {}
      this.state.links[marker.id] = [...links, link]
      this.linkDraftVisible = false
      this.refreshContext()
      this.persist()
      this.renderDetail()
    })
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'tml-mini'
    cancel.textContent = '取消'
    cancel.addEventListener('click', () => {
      this.linkDraftVisible = false
      this.renderDetail()
    })
    actions.append(save, cancel)
    form.append(row, url, actions)
    return form
  }

  private async fetchLink(
    marker: LayerMarker,
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
    this.persist()
    this.renderDetail()
    try {
      const text = await this.loadLinkText(link.url)
      if (!text) throw new Error('没有可读取的正文')
      this.storeLinkText(link, imported, stateKey, text, `已抓取 · ${text.length} 字`)
    } catch (error) {
      this.storeLinkText(
        link,
        imported,
        stateKey,
        '',
        `抓取失败：${errorMessage(error)}。可打开原页后手动粘贴。`,
      )
    }
    this.renderDetail()
    if (this.state.selectedMarkerId === marker.id) this.refreshContext()
  }

  private async loadLinkText(url: string): Promise<string> {
    try {
      const response = await fetch(url, { mode: 'cors' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return this.htmlText(await response.text())
    } catch (directError) {
      const apiUrl = this.mediaWikiApiUrl(url)
      if (!apiUrl) throw directError
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
    doc.querySelectorAll('script, style, nav, footer, header, aside, noscript, .navbox, .toc').forEach((node) => node.remove())
    return (doc.querySelector('article, main, body')?.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private noteSection(marker: LayerMarker): HTMLElement {
    const section = document.createElement('div')
    section.className = 'tml-note-section'
    const label = document.createElement('label')
    label.textContent = '我的笔记（不限字数）'
    const textarea = document.createElement('textarea')
    textarea.placeholder = '写下地点笔记，不设当前也会保存…'
    textarea.value = this.state.notes?.[marker.id] ?? ''
    textarea.addEventListener('input', () => {
      const notes = this.state.notes ?? (this.state.notes = {})
      if (textarea.value.trim()) notes[marker.id] = textarea.value
      else delete notes[marker.id]
      this.refreshContext()
      this.persist()
    })
    label.append(textarea)
    section.append(label)
    return section
  }

  private actionButton(label: string, onClick: () => void, active = false): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `tml-action${active ? ' active' : ''}`
    button.textContent = label
    button.addEventListener('click', onClick)
    return button
  }

  private toggleCurrent(marker: LayerMarker): void {
    if (this.state.currentMarkerId === marker.id) {
      this.state.currentMarkerId = undefined
      this.state.currentRegionId = undefined
    } else {
      this.state.currentMarkerId = marker.id
      const region = this.regionForMarker(marker)
      this.state.currentRegionId = region?.id
    }
    this.refreshContext()
    this.persist()
    this.renderDetail()
    this.requestDraw()
  }

  private toggleCurrentRegion(region: LayerRegion): void {
    if (this.state.currentRegionId === region.id) {
      this.state.currentRegionId = undefined
    } else {
      this.state.currentRegionId = region.id
      this.state.currentMarkerId = undefined
    }
    this.refreshContext()
    this.persist()
    this.renderDetail()
    this.requestDraw()
  }

  private currentMarker(): LayerMarker | undefined {
    if (!this.pkg || !this.state.currentMarkerId) return undefined
    return this.pkg.markers.find((marker) => marker.id === this.state.currentMarkerId)
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
    let best: LayerRegion | undefined
    let bestArea = Infinity
    for (const region of this.pkg.regions) {
      for (const ring of region.polygons) {
        if (!pointInRing(marker.x, marker.y, ring)) continue
        let minX = Infinity
        let maxX = -Infinity
        let minY = Infinity
        let maxY = -Infinity
        for (const [x, y] of ring) {
          minX = Math.min(minX, x)
          maxX = Math.max(maxX, x)
          minY = Math.min(minY, y)
          maxY = Math.max(maxY, y)
        }
        const area = Math.max(0, maxX - minX) * Math.max(0, maxY - minY)
        if (area < bestArea) {
          best = region
          bestArea = area
        }
      }
    }
    result = best
    this.markerRegionCache.set(marker.id, result)
    return result
  }

  private refreshContext(): void {
    const pkg = this.pkg
    if (!pkg) {
      this.state.context = undefined
      this.persist()
      this.callbacks.onChange()
      return
    }
    const marker = this.currentMarker()
    const region = this.state.currentRegionId
      ? pkg.regions.find((item) => item.id === this.state.currentRegionId) ??
        (marker ? this.regionForMarker(marker) : undefined)
      : marker
        ? this.regionForMarker(marker)
        : undefined
    const category = marker ? pkg.categories.find((item) => item.id === marker.categoryId) : undefined
    const note = marker
      ? this.state.notes?.[marker.id]
      : region
        ? this.state.notes?.[`region:${region.id}`]
        : undefined
    const links = marker
      ? [
          marker.sourceTitle,
          ...(marker.sourceLinks ?? []).map((link) => link.title),
          ...(this.state.links?.[marker.id] ?? []).map((link) => link.title),
        ]
          .filter((title): title is string => Boolean(title))
          .filter((title, index, list) => list.indexOf(title) === index)
      : undefined
    const hidden = new Set(this.state.hiddenCategories ?? [])
    const visibleCategories = pkg.categories
      .filter((item) => !hidden.has(item.id) && pkg.markers.some((markerItem) => markerItem.categoryId === item.id))
      .map((item) => item.name)
    const context: LayerContextSnapshot = {
      mapName: pkg.name,
      kind: pkg.kind,
      source: pkg.source,
      currentPlace: marker?.name,
      category: category?.name,
      region: region?.name,
      note: note?.trim() || undefined,
      links: links && links.length > 0 ? links : undefined,
      visibleCategories: visibleCategories.length > 0 ? visibleCategories : undefined,
      scaleNote:
        pkg.kind === 'tiles'
          ? 'tile map; map units are uncalibrated'
          : 'image map; pixel coordinates; scale is uncalibrated',
      updatedAt: Date.now(),
    }
    this.state.context = context
    this.persist()
    this.contextStatusEl.textContent = context.currentPlace ? '图层上下文：已生成' : '图层上下文：待机'
    this.callbacks.onChange()
  }

  private persist(immediate = false): void {
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
    const categoryById = new Map(pkg.categories.map((category) => [category.id, category]))
    const matches = pkg.markers
      .filter((marker) => {
        const category = categoryById.get(marker.categoryId)?.name ?? ''
        const region = this.regionForMarker(marker)?.name ?? ''
        const note = this.state.notes?.[marker.id] ?? ''
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

  private openImport(): void {
    this.importEl.hidden = false
    this.importing = false
    this.importStatusEl.textContent = ''
    this.setImportTab(this.importTab)
    this.updateImportNames()
  }

  private closeImport(): void {
    if (this.importing) return
    this.importEl.hidden = true
  }

  private setImportTab(tab: 'fandom' | 'mapgenie'): void {
    this.importTab = tab
    this.fandomPaneEl.hidden = tab !== 'fandom'
    this.mapgeniePaneEl.hidden = tab !== 'mapgenie'
    for (const button of this.importEl.querySelectorAll<HTMLElement>('[data-import-tab]')) {
      button.classList.toggle('active', button.dataset.importTab === tab)
    }
  }

  private updateImportNames(): void {
    if (!this.fandomNameEl.value && this.fandomJsonEl.files?.[0]) {
      this.fandomNameEl.value = fallbackPackageName(this.fandomJsonEl.files[0].name)
    }
    if (!this.mapgenieNameEl.value && this.mapgenieJsonEl.files?.[0]) {
      this.mapgenieNameEl.value = fallbackPackageName(this.mapgenieJsonEl.files[0].name)
    }
  }

  private onImportClick(event: MouseEvent): void {
    const target = event.target as HTMLElement
    const action = target.closest<HTMLElement>('[data-import-action]')?.dataset.importAction
    if (action === 'close' || action === 'cancel') {
      this.closeImport()
      return
    }
    if (action === 'run') {
      void this.runImport()
      return
    }
    const tab = target.closest<HTMLElement>('[data-import-tab]')?.dataset.importTab
    if (tab === 'fandom' || tab === 'mapgenie') this.setImportTab(tab)
  }

  private async runImport(): Promise<void> {
    if (this.importing) return
    this.importing = true
    this.importStatusEl.textContent = '正在读取本地文件…'
    try {
      const pkg =
        this.importTab === 'fandom' ? await this.importFandom() : await this.importMapGenie()
      this.importStatusEl.textContent = `正在保存地图包：${pkg.markers.length} 个地点${pkg.tileFiles ? ` · ${Object.keys(pkg.tileFiles).length} 张瓦片` : ''}…`
      await putLayerPackage(pkg)
      this.importing = false
      this.importEl.hidden = true
      this.importStatusEl.textContent = ''
      this.state.packageId = pkg.id
      this.state.view = undefined
      this.state.selectedMarkerId = undefined
      this.state.currentMarkerId = undefined
      this.state.selectedRegionId = undefined
      this.state.currentRegionId = undefined
      this.state.hiddenCategories = []
      await this.refreshPackages()
      await this.loadPackage(pkg.id)
      this.toast(`已导入 ${pkg.name}`)
    } catch (error) {
      this.importing = false
      this.importStatusEl.textContent = `导入失败：${errorMessage(error)}`
    }
  }

  private async importFandom(): Promise<LayerMapPackage> {
    const jsonFile = this.fandomJsonEl.files?.[0]
    const imageFile = this.fandomImageEl.files?.[0]
    if (!jsonFile) throw new Error('请选择 Fandom JSON 文件')
    if (!imageFile) throw new Error('请选择底图图片')
    const raw = JSON.parse(await jsonFile.text()) as unknown
    return parseFandomPackage(raw, {
      name: this.fandomNameEl.value.trim() || fallbackPackageName(jsonFile.name),
      image: imageFile,
      imageType: imageFile.type,
    })
  }

  private async importMapGenie(): Promise<LayerMapPackage> {
    const jsonFile = this.mapgenieJsonEl.files?.[0]
    if (!jsonFile) throw new Error('请选择 mapData JSON 文件')
    const jsonText = await jsonFile.text()
    const raw = JSON.parse(jsonText) as unknown
    const tileTemplate = this.mapgenieTilesEl.value.trim()
    // Some Map Genie maps use {z}/{x}/{y}; the folder follows the same order.
    const tileFiles = await this.readTileFolder(/\{z\}\/\{x\}\/\{y\}/.test(jsonText))
    if (tileFiles) {
      this.importStatusEl.textContent = `已读取 ${Object.keys(tileFiles).length} 张瓦片，正在写入地图包…`
    }
    return parseMapGeniePackage(raw, {
      name: this.mapgenieNameEl.value.trim() || fallbackPackageName(jsonFile.name),
      tileTemplate,
      tileFiles,
    })
  }

  private async readTileFolder(xyOrder = false): Promise<Record<string, Blob> | undefined> {
    const input = this.mapgenieFolderEl.files
    if (!input || input.length === 0) return undefined
    const allFiles = Array.from(input)
    this.importStatusEl.textContent = `正在读取 ${allFiles.length} 个文件…`
    const files: Record<string, Blob> = {}
    let scanned = 0
    for (const file of allFiles) {
      const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
      const match = relative.match(/(?:^|\/)(\d+)\/(\d+)\/(\d+)\.(?:jpe?g|png|webp)$/i)
      if (match) {
        const first = match[2]
        const second = match[3]
        // Internally keyed z/y/x; Map Genie folders may be z/x/y.
        files[`${match[1]}/${xyOrder ? second : first}/${xyOrder ? first : second}`] = file
      }
      scanned += 1
      if (scanned % 2000 === 0) {
        this.importStatusEl.textContent = `已扫描 ${scanned}/${allFiles.length} 个文件 · 找到 ${Object.keys(files).length} 张瓦片…`
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
      }
    }
    if (Object.keys(files).length === 0) {
      throw new Error('文件夹里没有找到 z/y/x.jpg 结构的瓦片')
    }
    return files
  }

  private renderEmpty(message: string): void {
    this.emptyMessage = message
    this.emptyEl.hidden = !message
    this.emptyEl.textContent = message
  }

  private toast(message: string): void {
    const element = document.createElement('div')
    element.className = 'tm-toast'
    element.setAttribute('role', 'status')
    element.textContent = message
    document.body.append(element)
    window.setTimeout(() => element.remove(), 2600)
  }

  dispose(): void {
    this.offs.forEach((remove) => remove())
    this.offs.length = 0
    if (this.saveTimer !== undefined) window.clearTimeout(this.saveTimer)
    if (this.resizeObserver) this.resizeObserver.disconnect()
    if (this.drawFrame) window.cancelAnimationFrame(this.drawFrame)
    if (this.imageUrl) URL.revokeObjectURL(this.imageUrl)
    this.clearTileCaches()
    this.panelEl?.remove()
    this.importEl?.remove()
    this.contextModalEl?.remove()
  }
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

function pointInRing(x: number, y: number, ring: Array<[number, number]>): boolean {
  let inside = false
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [xi, yi] = ring[index]
    const [xj, yj] = ring[previous]
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
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
