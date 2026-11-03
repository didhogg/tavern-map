import { Map as MapLibreMap, Marker, NavigationControl } from 'maplibre-gl'
import { cacheGet, cachePut, wikiCacheKey } from './cache'
import { buildContext, estimateTokens } from './context'
import { formatDistance } from './geo'
import { errorMessage } from './http'
import { syncPrompt, clearPrompt } from './prompt'
import { nearbyPlaces, reverseGeocode } from './providers'
import { loadState, saveState } from './state'
import { loadSettings, saveSettings } from './settings'
import type { MapState, Place, Settings, StContext, WikiCandidate, WikiPage } from './types'
import { wikiNearby, wikiPage } from './wiki'

const PANEL_ID = 'tm-panel'
const WIKI_TTL_MS = 7 * 24 * 60 * 60 * 1000
const WIKI_LANG_LABELS: Record<string, string> = { en: 'EN', ja: 'JA', zh: 'ZH' }

function wikiKey(lang: string, pageId: number): string {
  return `${lang}:${pageId}`
}

function langLabel(lang: string): string {
  return WIKI_LANG_LABELS[lang] ?? lang.toUpperCase()
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
  <div id="tm-canvas" class="tm-canvas"></div>
  <div class="tm-location">
    <div id="tm-place-name" class="tm-place-name">点击地图选择位置</div>
    <div id="tm-place-address" class="tm-place-address"></div>
    <div id="tm-status" class="tm-status" role="status"></div>
  </div>
  <div class="tm-tabs" role="tablist">
    <button type="button" data-tab="nearby" class="active" role="tab">周边</button>
    <button type="button" data-tab="wiki" role="tab">维基</button>
  </div>
  <div id="tm-list" class="tm-list"></div>
  <footer class="tm-foot">© OpenStreetMap contributors · Wikipedia CC BY-SA 4.0</footer>
  <div id="tm-wiki" class="tm-wiki" role="dialog" aria-label="Wikipedia article" hidden>
    <header class="tm-head">
      <strong id="tm-wiki-title">Wiki</strong>
      <div class="tm-head-actions">
        <button type="button" id="tm-star" data-action="star" title="加入 AI 上下文">☆</button>
        <button type="button" data-action="close-wiki" title="关闭">×</button>
      </div>
    </header>
    <div id="tm-wiki-body" class="tm-wiki-body"></div>
    <a id="tm-wiki-link" class="tm-wiki-link" target="_blank" rel="noreferrer">打开 Wikipedia</a>
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
      <div class="tm-row tm-row-stack">Wiki 语言（可多选）
        <div class="tm-lang-options">
          <label><input type="checkbox" data-tm-lang value="en"> English</label>
          <label><input type="checkbox" data-tm-lang value="ja"> 日本語</label>
          <label><input type="checkbox" data-tm-lang value="zh"> 中文</label>
        </div>
      </div>
      <label class="tm-row">周边半径（米）<input type="number" id="tm-set-radius" min="50" max="1000" step="50"></label>
      <label class="tm-row">周边地点数<input type="number" id="tm-set-nearby" min="0" max="12" step="1"></label>
      <label class="tm-row">每篇 Wiki 字符数<input type="number" id="tm-set-wiki" min="200" max="1200" step="50"></label>
      <label class="tm-row">上下文预算（token）<input type="number" id="tm-set-budget" min="300" max="2000" step="50"></label>
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
  private seq = 0
  private wikiSeq = 0
  private tab: 'nearby' | 'wiki' = 'nearby'
  private currentWiki: WikiPage | null = null
  private loadingNearby = false
  private loadingWiki = false
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

  private enabledEl!: HTMLInputElement
  private langEls: HTMLInputElement[] = []
  private radiusEl!: HTMLInputElement
  private nearbyEl!: HTMLInputElement
  private wikiCharsEl!: HTMLInputElement
  private budgetEl!: HTMLInputElement
  private depthEl!: HTMLInputElement
  private settingsBound = false

  private readonly onUnload = (): void => this.cleanup()

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
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

  constructor(ctx: StContext) {
    this.ctx = ctx
    this.settings = loadSettings(ctx)
    this.state = loadState(ctx)
    this.state.enabled = this.settings.enabled
    this.mount()
    this.bindEvents()
    this.sync()
    this.render()
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
    this.wikiCharsEl = document.getElementById('tm-set-wiki') as HTMLInputElement
    this.budgetEl = document.getElementById('tm-set-budget') as HTMLInputElement
    this.depthEl = document.getElementById('tm-set-depth') as HTMLInputElement
    if (!this.enabledEl) return
    this.writeSettingsToForm()
    this.bindSettings()
  }

  private bindEvents(): void {
    document.getElementById('tm-fab')?.addEventListener('click', () => this.togglePanel())
    this.panelEl.addEventListener('click', (event) => this.onPanelClick(event))
    this.previewEl.addEventListener('click', (event) => this.onPreviewClick(event))

    const eventTypes = this.ctx.eventTypes ?? this.ctx.event_types ?? {}
    this.on(eventTypes.CHAT_CHANGED ?? 'chat_id_changed', () => this.onChatChanged())
    this.on(eventTypes.GENERATION_STARTED ?? 'generation_started', () => this.sync())
    window.addEventListener('beforeunload', this.onUnload)
    document.addEventListener('keydown', this.onKeyDown)
    this.offs.push(() => document.removeEventListener('keydown', this.onKeyDown))

    this.mountSettings()
  }

  private bindSettings(): void {
    if (this.settingsBound || !this.enabledEl) return
    this.settingsBound = true

    this.enabledEl.addEventListener('change', () => this.readSettings())
    const onLanguagesChanged = (): void => {
      const previous = [...this.settings.wikiLangs].sort().join(',')
      this.wikiSeq += 1
      this.readSettings()
      const next = [...this.settings.wikiLangs].sort().join(',')
      if (previous === next) return
      const enabled = new Set(this.settings.wikiLangs)
      this.state.wiki = this.state.wiki.filter((candidate) => enabled.has(candidate.lang))
      this.state.stars = this.state.stars.filter((page) => enabled.has(page.lang ?? 'en'))
      if (this.currentWiki && !enabled.has(this.currentWiki.lang)) {
        this.currentWiki = null
        this.wikiEl.hidden = true
      }
      this.commit()
      this.scheduleRefresh(0)
    }
    for (const input of this.langEls) input.addEventListener('change', onLanguagesChanged)
    this.radiusEl.addEventListener('change', () => {
      this.readSettings()
      this.scheduleRefresh(0)
    })
    this.nearbyEl.addEventListener('change', () => this.readSettings())
    this.wikiCharsEl.addEventListener('change', () => this.readSettings())
    this.budgetEl.addEventListener('change', () => this.readSettings())
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
      return
    }
    if (action === 'star') {
      this.toggleStar()
      return
    }
    const tab = target.closest<HTMLElement>('[data-tab]')?.dataset.tab
    if (tab === 'nearby' || tab === 'wiki') {
      this.tab = tab
      this.render()
    }
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
    this.ensureMap()
    window.requestAnimationFrame(() => {
      this.map?.resize()
      this.map?.flyTo({ center: [this.state.center.lng, this.state.center.lat], zoom: this.state.zoom })
      this.render()
    })
    const needsInitialData = !this.state.place && this.state.nearby.length === 0 && this.state.wiki.length === 0
    if (needsInitialData) {
      window.setTimeout(() => {
        if (!this.panelEl.hidden) void this.refresh()
      }, 150)
    }
  }

  private closePanel(): void {
    this.panelEl.hidden = true
  }

  private ensureMap(): void {
    if (this.map) return
    try {
      this.map = new MapLibreMap({
        container: this.canvasEl,
        style: 'https://tiles.openfreemap.org/styles/liberty',
        center: [this.state.center.lng, this.state.center.lat],
        zoom: this.state.zoom,
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
    this.marker = new Marker({ color: '#e11d48', draggable: true })
      .setLngLat([this.state.center.lng, this.state.center.lat])
      .addTo(map)
    this.marker.on('dragend', () => {
      if (!this.marker) return
      const position = this.marker.getLngLat()
      void this.moveTo(position.lat, position.lng)
    })
    map.on('click', (event) => {
      void this.moveTo(event.lngLat.lat, event.lngLat.lng)
    })
    map.on('moveend', () => {
      if (!this.map) return
      this.state.zoom = this.map.getZoom()
      saveState(this.ctx, this.state)
    })
    this.resizeObserver = new ResizeObserver(() => this.map?.resize())
    this.resizeObserver.observe(this.canvasEl)
  }

  private async moveTo(lat: number, lng: number, fly = false): Promise<void> {
    this.seq += 1
    this.wikiSeq += 1
    this.state.center = { lat, lng }
    this.state.zoom = this.map?.getZoom() ?? this.state.zoom
    this.state.place = undefined
    this.state.nearby = []
    this.state.wiki = []
    this.currentWiki = null
    this.wikiEl.hidden = true
    this.marker?.setLngLat([lng, lat])
    if (fly) {
      const map = this.map
      if (map) map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 16) })
    }
    this.commit()
    this.setStatus('正在获取地点信息…')
    this.scheduleRefresh()
  }

  private scheduleRefresh(delay = 650): void {
    // Invalidate any in-flight refresh immediately, not only when the timer
    // fires; otherwise a slow Overpass response can overwrite a newer location.
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

    // Apply each source as soon as it arrives. Overpass can take 15s; waiting
    // for all three before showing the place name makes the panel look frozen.
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
    syncPrompt(this.ctx, text, this.settings.enabled, this.settings.depth)
  }

  private render(): void {
    if (!this.panelEl) return
    this.placeNameEl.textContent = this.state.place?.name ?? '点击地图选择位置'
    this.placeAddressEl.textContent = this.state.place?.address ?? ''
    for (const button of this.panelEl.querySelectorAll<HTMLElement>('[data-tab]')) {
      const active = button.dataset.tab === this.tab
      button.classList.toggle('active', active)
      button.setAttribute('aria-selected', String(active))
    }
    this.renderList()
    this.updateStarButton()
  }

  private renderList(): void {
    this.listEl.replaceChildren()
    if (this.tab === 'nearby') {
      if (this.state.nearby.length === 0) {
        this.listEl.append(
          this.empty(
            this.loadingNearby ? '正在加载周边地点…' : '还没有周边地点。点地图选一个位置，或点右上角刷新。',
          ),
        )
        return
      }
      for (const place of this.state.nearby.slice(0, 12)) {
        this.listEl.append(this.nearbyItem(place))
      }
      return
    }
    if (this.state.wiki.length === 0) {
      this.listEl.append(
        this.empty(
          this.loadingWiki ? '正在搜索附近的维基条目…' : '附近没有找到维基条目。可以放大/移动地图后再刷新。',
        ),
      )
      return
    }
    for (const candidate of this.state.wiki) {
      this.listEl.append(this.wikiItem(candidate))
    }
  }

  private nearbyItem(place: Place): HTMLElement {
    const row = document.createElement('div')
    row.className = 'tm-item'
    const main = document.createElement('button')
    main.type = 'button'
    main.className = 'tm-item-main'
    main.title = '在地图上查看'
    const name = document.createElement('span')
    name.className = 'tm-item-name'
    name.textContent = place.name
    const meta = document.createElement('span')
    meta.className = 'tm-item-meta'
    meta.textContent = [place.category, formatDistance(place.distanceM)].filter(Boolean).join(' · ')
    main.append(name, meta)
    main.addEventListener('click', () => {
      const map = this.map
      if (map) map.flyTo({ center: [place.lng, place.lat], zoom: Math.max(map.getZoom(), 17) })
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
    row.append(main, go)
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
    const starred = this.state.stars.some(
      (page) => wikiKey(page.lang ?? 'en', page.pageId) === wikiKey(candidate.lang, candidate.pageId),
    )
    const meta = document.createElement('span')
    meta.className = 'tm-item-meta'
    meta.textContent = [`[${langLabel(candidate.lang)}]`, formatDistance(candidate.dist), starred ? '★ 已加入 AI 上下文' : '']
      .filter(Boolean)
      .join(' · ')
    main.append(name, meta)
    main.addEventListener('click', () => void this.openWiki(candidate))
    row.append(main)
    return row
  }

  private empty(text: string): HTMLElement {
    const element = document.createElement('div')
    element.className = 'tm-empty'
    element.textContent = text
    return element
  }

  private async openWiki(candidate: WikiCandidate): Promise<void> {
    const seq = ++this.wikiSeq
    this.wikiEl.hidden = false
    this.wikiTitleEl.textContent = `[${langLabel(candidate.lang)}] ${candidate.title}`
    this.wikiBodyEl.textContent = '加载中…'
    this.wikiLinkEl.hidden = true
    this.starEl.disabled = true
    this.currentWiki = null

    const key = wikiCacheKey(candidate.lang, candidate.pageId)
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
    this.currentWiki = page
    this.wikiTitleEl.textContent = `[${langLabel(page.lang)}] ${page.title}`
    this.wikiBodyEl.textContent = page.extract || '（这个条目没有可用的纯文本正文）'
    this.wikiLinkEl.href = page.url
    this.wikiLinkEl.hidden = false
    const starred = this.state.stars.some(
      (item) => wikiKey(item.lang ?? 'en', item.pageId) === wikiKey(page.lang, page.pageId),
    )
    this.starEl.disabled = !page.extract && !starred
    this.updateStarButton()
  }

  private toggleStar(): void {
    const current = this.currentWiki
    if (!current) return
    const index = this.state.stars.findIndex(
      (page) => wikiKey(page.lang ?? 'en', page.pageId) === wikiKey(current.lang, current.pageId),
    )
    if (index >= 0) {
      this.state.stars.splice(index, 1)
      this.toast('已从 AI 上下文移除')
    } else {
      if (!current.extract) return
      this.state.stars.push({ ...current })
      this.toast('已加入 AI 上下文，下一轮生成生效')
    }
    this.commit()
  }

  private updateStarButton(): void {
    if (!this.starEl) return
    const current = this.currentWiki
    const starred = current
      ? this.state.stars.some(
          (page) => wikiKey(page.lang ?? 'en', page.pageId) === wikiKey(current.lang, current.pageId),
        )
      : false
    this.starEl.textContent = starred ? '★' : '☆'
    this.starEl.title = starred ? '从 AI 上下文移除' : '加入 AI 上下文'
    this.starEl.setAttribute('aria-pressed', String(starred))
  }

  private preview(): void {
    const text = buildContext(this.state, this.settings)
    this.previewTextEl.textContent =
      text || '（尚未选择地点，也没有星标条目；当前不会注入场景块。）'
    this.tokenEstimateEl.textContent = text
      ? `≈ ${estimateTokens(text)} tokens · 预算 ${this.settings.tokenBudget}`
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
      maxWikiChars: Math.round(numberValue(this.wikiCharsEl, this.settings.maxWikiChars, 200, 1200)),
      tokenBudget: Math.round(numberValue(this.budgetEl, this.settings.tokenBudget, 300, 2000)),
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
    this.wikiCharsEl.value = String(this.settings.maxWikiChars)
    this.budgetEl.value = String(this.settings.tokenBudget)
    this.depthEl.value = String(this.settings.depth)
  }

  private clearChat(): void {
    this.seq += 1
    this.wikiSeq += 1
    this.loadingNearby = false
    this.loadingWiki = false
    this.state.nearby = []
    this.state.wiki = []
    this.state.stars = []
    this.state.place = undefined
    this.currentWiki = null
    this.wikiEl.hidden = true
    this.previewEl.hidden = true
    this.commit()
    this.toast('已清空本聊天地的地点与星标')
  }

  private onChatChanged(): void {
    this.seq += 1
    this.wikiSeq += 1
    this.loadingNearby = false
    this.loadingWiki = false
    this.ctx = this.liveContext()
    this.settings = loadSettings(this.ctx)
    this.state = loadState(this.ctx)
    this.state.enabled = this.settings.enabled
    this.currentWiki = null
    this.wikiEl.hidden = true
    this.previewEl.hidden = true
    this.writeSettingsToForm()
    if (this.map) {
      this.map.jumpTo({ center: [this.state.center.lng, this.state.center.lat], zoom: this.state.zoom })
      this.marker?.setLngLat([this.state.center.lng, this.state.center.lat])
    }
    this.commit()
    this.setStatus('')
    if (!this.panelEl.hidden && !this.state.place && this.state.nearby.length === 0 && this.state.wiki.length === 0) {
      this.scheduleRefresh(0)
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
