import { buildLayerContext } from './layer-context'
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
import { cleanSourceText, type MapGenieTileSetInfo } from './layer-import'
import { LayerImportUI } from './layer-import-ui'
import { LayerPackagesUI } from './layer-packages-ui'
import {
  filesToBundle,
  scanTileFiles,
} from './layer-source'
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
  type LayerChatState,
  type LayerContextSnapshot,
  type LayerImageFit,
  type LayerImageRect,
  type LayerLink,
  type LayerLinkKind,
  type LayerMapPackage,
  type LayerMarker,
  type LayerPackageMeta,
  type LayerRegion,
  type LayerView,
} from './layer-types'
import {
  flushGlobalNotes,
  globalNote,
  globalNotesSnapshot,
  setGlobalNote,
} from './notes-store'
import { LayerWindowController } from './layer-window'
import type { StContext } from './types'

const PANEL_ID = 'tm-layer'
const IMAGE_FIT_MARGIN = 0.94
const LABEL_IMAGE_ZOOM = 1.7
const LABEL_TILE_ZOOM = 11
const MARKER_HIT_RADIUS = 12
const REGION_HIT_MIN_ZOOM = 8
const MARKER_INDEX_CELL = 0.025
const LABEL_CELL_PX = 48
const IMAGE_PANEL_WIDTH = 340
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
      <div id="tml-detail"></div>
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

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.importUI?.isOpen() || this.packagesUI?.isOpen()) return
    if (event.key !== 'Escape') return
    const target = event.target as HTMLElement | null
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
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
        if (this.pkg?.id === id) {
          this.closeImagePanel()
          if (this.state.packageId === id) this.state.packageId = undefined
          this.state.selectedMarkerId = undefined
          this.state.currentMarkerId = undefined
          this.state.selectedRegionId = undefined
          this.state.currentRegionId = undefined
          this.state.view = undefined
          this.persist(true)
          this.pkg = null
          this.image = null
          this.clearTileCaches()
          this.syncHeaderImage()
          this.renderEmpty('这个地图包已删除。可以重新导入，或选择另一个地图包。')
          this.renderCategories()
          this.renderDetail()
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
      this.syncHeaderImage()
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
    this.closeImagePanel()
    this.closeLightbox()
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
  }

  handleChatChanged(): void {
    void flushGlobalNotes()
    this.closeImagePanel()
    this.closeLightbox()
    if (this.aligning) this.cancelAlign()
    this.importUI?.close()
    this.packagesUI?.close()
    this.ctx = this.liveContext()
    this.state = loadLayerState(this.ctx)
    this.pkg = null
    this.image = null
    this.clearTileCaches()
    if (this.imageUrl) {
      URL.revokeObjectURL(this.imageUrl)
      this.imageUrl = null
    }
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
    if (this.aligning) this.cancelAlign()
    this.importUI?.close()
    this.packagesUI?.close()
    this.state = structuredClone(DEFAULT_LAYER_STATE)
    this.state.notes = Object.fromEntries(
      Object.entries(globalNotesSnapshot()).filter(([key]) => key.startsWith('layer:')),
    )
    this.state.updatedAt = Date.now()
    this.pkg = null
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
    this.contextModalEl = document.getElementById('tml-context') as HTMLElement
    this.contextTextEl = document.getElementById('tml-context-text') as HTMLElement
    this.contextTokensEl = document.getElementById('tml-context-tokens') as HTMLElement
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
    this.contextModalEl.addEventListener('click', (event) => {
      const target = event.target as HTMLElement
      if (target.closest('[data-context-action="close"]') || target === this.contextModalEl) {
        this.contextModalEl.hidden = true
      }
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
        new Option(`${meta.kind === 'tiles' ? '瓦片' : '图片'} · ${meta.name}`, meta.id),
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
      this.image = null
      if (this.imageUrl) {
        URL.revokeObjectURL(this.imageUrl)
        this.imageUrl = null
      }
      this.clearTileCaches()
      this.syncHeaderImage()
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
      this.lastRemovedImage = null
    }
    this.pkg = pkg
    this.migrateLegacyNotes(pkg)
    if (
      this.state.selectedMarkerId &&
      !pkg.markers.some((marker) => marker.id === this.state.selectedMarkerId)
    ) {
      this.state.selectedMarkerId = undefined
    }
    if (
      this.state.currentMarkerId &&
      !pkg.markers.some((marker) => marker.id === this.state.currentMarkerId)
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
    this.buildMarkerIndex()
    this.clearTileCaches()
    this.packageSelectEl.value = pkg.id
    this.view = this.resolveView(pkg, this.state.view)
    this.state.view = this.view
    this.loadImage(pkg)
    this.renderCategories()
    this.renderDetail()
    this.syncToolButtons()
    this.updatePackageInfo()
    this.syncHeaderImage()
    if (this.imagePanelOpen) this.renderImagePanel()
    this.refreshContext()
    this.requestDraw()
  }

  private updatePackageInfo(): void {
    const pkg = this.pkg
    if (!pkg) {
      this.packageInfoEl.textContent = ''
      return
    }
    this.packageInfoEl.textContent = [
      pkg.kind === 'tiles' ? '瓦片地图' : '图片地图',
      `${pkg.markers.length} 个地点`,
      pkg.regions.length ? `${pkg.regions.length} 个区域` : '无区域面',
      pkg.source === 'mapgenie' ? 'Map Genie' : pkg.source === 'fandom' ? 'Fandom' : '本地',
      pkg.kind === 'tiles'
        ? `${Object.keys(pkg.tileFiles ?? {}).length} 张瓦片`
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

  private loadImage(pkg: LayerMapPackage): void {
    if (this.imageUrl) {
      URL.revokeObjectURL(this.imageUrl)
      this.imageUrl = null
    }
    this.image = null
    this.syncHeaderImage()
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
      this.syncHeaderImage()
      this.requestDraw()
    }
    image.onerror = () => {
      if (this.imageUrl !== url) return
      this.image = null
      this.emptyMessage = ''
      this.emptyEl.hidden = true
      this.syncHeaderImage()
      this.toast('底图加载失败，点顶栏“底图”可以更换图片')
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
    const rect = this.aligning && this.alignRect ? this.alignRect : imageRectFor(pkg)
    const drawWidth = rect.w * pkg.width * scale
    const drawHeight = rect.h * pkg.height * scale
    const left = width / 2 + (rect.x - this.view.cx) * pkg.width * scale
    const top = height / 2 + (rect.y - this.view.cy) * pkg.height * scale
    if (this.image) {
      context.save()
      if (this.aligning) context.globalAlpha = 0.82
      context.drawImage(this.image, left, top, drawWidth, drawHeight)
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
    if (this.aligning) {
      this.zoomEl.textContent = '对齐图片'
      this.scaleEl.textContent = '拖动移动 · 滚轮缩放'
    } else {
      this.zoomEl.textContent = pkg.kind === 'tiles' ? `Z ${this.view.zoom.toFixed(1)}` : `${this.view.zoom.toFixed(2)}×`
      this.scaleEl.textContent =
        pkg.kind === 'tiles' ? '地图单位未校准' : '图片像素 · 比例未校准'
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
    if (!this.pkg || this.aligning) return
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
    const noteWrap = document.createElement('div')
    noteWrap.className = 'tml-note-section'
    const label = document.createElement('label')
    label.textContent = '区域笔记'
    const textarea = document.createElement('textarea')
    textarea.placeholder = '写一段区域笔记…'
    textarea.value = this.regionNoteValue(region)
    textarea.addEventListener('input', () => {
      this.setRegionNote(region, textarea.value)
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
      textBody.hidden = true
      const read = document.createElement('button')
      read.type = 'button'
      read.className = 'tml-mini'
      read.textContent = '正文'
      read.setAttribute('aria-expanded', 'false')
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
    if (textBody) row.append(textBody)
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
    return (
      doc.querySelector('.mw-parser-output, #mw-content-text, article, main, body')
        ?.textContent ?? ''
    )
      .replace(/\s+/g, ' ')
      .trim()
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
    const label = document.createElement('label')
    label.textContent = '我的笔记（不限字数）'
    const textarea = document.createElement('textarea')
    textarea.placeholder = '写下地点笔记，不设当前也会保存…'
    textarea.value = this.markerNoteValue(marker)
    textarea.addEventListener('input', () => {
      this.setMarkerNote(marker, textarea.value)
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
      ? this.markerNoteValue(marker)
      : region
        ? this.regionNoteValue(region)
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
      if (pkg.markers.length > 0) {
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
