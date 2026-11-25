import { errorMessage } from './http'
import {
  imageFitLabel,
  imageSourceLabel,
  formatBytes,
  formatCount,
} from './layer-image'
import type { LayerMapPackage } from './layer-types'
import {
  analyzeBundle,
  bundleFromDrop,
  fetchFandomMap,
  filesToBundle,
  removePreviewImage,
  selectPreviewImage,
  useLocalImage,
  zipToBundle,
  type LayerImageChoice,
  type LayerImportPreview,
  type LayerProgressEvent,
  type LayerSourceBundle,
} from './layer-source'
import {
  StorageQuotaError,
  ensureLayerStorage,
  isQuotaError,
  saveImportedPackage,
} from './layer-store'

export type LayerImportUIOptions = {
  onImported: (pkg: LayerMapPackage) => void | Promise<void>
  onToast: (message: string) => void
}

type View = 'pick' | 'preview' | 'busy' | 'error'

type ManualSelection = {
  json?: File
  image?: File
  tiles?: File[]
}

const IMPORT_ID = 'tml-import'

const IMPORT_HTML = `
<div id="${IMPORT_ID}" class="tml-modal tml-import-modal" role="dialog" aria-modal="true" aria-label="导入地图包" hidden>
  <div class="tml-modal-card tml-import-card">
    <header class="tml-modal-head">
      <div class="tml-modal-heading">
        <strong>导入地图包</strong>
        <span id="tml-import-sub" class="tml-modal-sub">一个包一次导入</span>
      </div>
      <button type="button" class="tml-close" data-import-action="close" aria-label="关闭">×</button>
    </header>
    <div class="tml-import-body">
      <section id="tml-import-pick" class="tml-import-view">
        <div id="tml-drop-zone" class="tml-drop-zone">
          <div class="tml-drop-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5"/>
              <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/>
            </svg>
          </div>
          <h3>把地图包拖到这里</h3>
          <p>.zip / 整个文件夹 / map.json + 图片 / mapdata.json + tiles</p>
          <div class="tml-file-buttons">
            <button type="button" class="tml-file-btn" data-pick="zip">选择 .zip 地图包</button>
            <button type="button" class="tml-file-btn" data-pick="folder">选择地图文件夹</button>
            <button type="button" class="tml-file-btn" data-pick="json">选择 JSON 文件</button>
            <button type="button" class="tml-file-btn" data-pick="image">选择底图图片</button>
            <button type="button" class="tml-file-btn" data-pick="tiles">选择瓦片文件夹</button>
          </div>
          <div id="tml-pick-summary" class="tml-pick-summary">尚未选择文件</div>
          <p class="tml-drop-hint">只选一张底图也可以先导入；文件只在本机读取，不会上传。</p>
          <input id="tml-input-zip" class="tml-file-input" type="file" accept=".zip,application/zip,application/x-zip-compressed" hidden tabindex="-1">
          <input id="tml-input-folder" class="tml-file-input" type="file" webkitdirectory directory multiple hidden tabindex="-1">
          <input id="tml-input-json" class="tml-file-input" type="file" accept=".json,application/json" hidden tabindex="-1">
          <input id="tml-input-image" class="tml-file-input" type="file" accept=".png,.jpg,.jpeg,.webp,.avif,.gif,image/*" hidden tabindex="-1">
          <input id="tml-input-tiles" class="tml-file-input" type="file" webkitdirectory directory multiple hidden tabindex="-1">
        </div>

        <section class="tml-url-section" aria-labelledby="tml-url-label">
          <label id="tml-url-label" for="tml-fandom-url">Fandom 地图页面 URL</label>
          <div class="tml-url-row">
            <input id="tml-fandom-url" type="url" autocomplete="off" spellcheck="false"
              placeholder="https://forgottenrealms.fandom.com/wiki/Map:Waterdeep">
            <button type="button" class="tml-btn tml-primary" data-import-action="read-url">读取</button>
          </div>
          <p class="tml-hint">只读取 Map: 页面的 JSON 和一张底图。Map Genie 页面 URL 不能直接解析，请选择本地 mapData 或整个地图包。</p>
        </section>

        <details class="tml-advanced">
          <summary>高级手动模式</summary>
          <div class="tml-advanced-body">
            <p>上面的按钮已经可以分别选择 JSON、底图和瓦片。高级模式只用于补一个普通 JSON URL，或在你明确知道来源时手动组合文件。</p>
            <label class="tml-field">
              <span>普通 JSON URL（可选，要求目标站允许 CORS）</span>
              <input id="tml-json-url" type="url" placeholder="https://example.com/map.json">
            </label>
            <button type="button" class="tml-mini" data-import-action="read-json-url">读取 JSON URL</button>
          </div>
        </details>
      </section>

      <section id="tml-import-preview" class="tml-import-view" hidden></section>
      <section id="tml-import-busy" class="tml-import-view" role="status" aria-live="polite" hidden></section>
      <section id="tml-import-error" class="tml-import-view" role="alert" hidden></section>
    </div>
    <footer class="tml-modal-foot">
      <span id="tml-import-note" class="tml-import-note"></span>
      <div class="tml-modal-actions">
        <button type="button" class="tml-btn" data-import-action="back" hidden>返回重选</button>
        <button type="button" class="tml-btn" data-import-action="retry" hidden>重试</button>
        <button type="button" class="tml-btn" data-import-action="cancel">取消</button>
        <button type="button" class="tml-btn tml-primary" data-import-action="run" hidden>导入并打开</button>
      </div>
    </footer>
  </div>
</div>
`

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

function icon(name: 'image' | 'warning' | 'info' | 'check' | 'grid'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.6')
  svg.setAttribute('aria-hidden', 'true')
  const paths: Record<typeof name, string[]> = {
    image: [
      'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z',
      'M8.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
      'm4 16 4.5-4.5 3.5 3.5 3-3L20 17',
    ],
    warning: ['M12 3 2.8 20h18.4L12 3Z', 'M12 9v5', 'M12 17h.01'],
    info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 11v5', 'M12 8h.01'],
    check: ['M20 6 9 17l-5-5'],
    grid: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h6v6h-6z'],
  }
  for (const d of paths[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

export class LayerImportUI {
  private readonly options: LayerImportUIOptions
  private readonly el: HTMLElement
  private readonly dropZone: HTMLElement
  private readonly pickSummary: HTMLElement
  private readonly previewEl: HTMLElement
  private readonly busyEl: HTMLElement
  private readonly errorEl: HTMLElement
  private readonly noteEl: HTMLElement
  private readonly subEl: HTMLElement
  private readonly backButton: HTMLButtonElement
  private readonly retryButton: HTMLButtonElement
  private readonly cancelButton: HTMLButtonElement
  private readonly runButton: HTMLButtonElement
  private readonly fandomUrlEl: HTMLInputElement
  private readonly jsonUrlEl: HTMLInputElement
  private readonly inputs: Record<string, HTMLInputElement>
  private readonly previewImageInput: HTMLInputElement
  private readonly previewTilesInput: HTMLInputElement
  private view: View = 'pick'
  private bundle: LayerSourceBundle | null = null
  private manual: ManualSelection = {}
  private preview: LayerImportPreview | null = null
  private abort: AbortController | null = null
  private busy = false
  private closing = false
  private nameOverride = ''
  private wikiOverride = ''
  private tileUrl = ''
  private errorText = ''
  private errorStage = ''
  private lastTask: (() => Promise<void>) | null = null
  private progress: LayerProgressEvent[] = []
  private progressFrame = 0
  private previewImageUrl: string | null = null
  private choiceUrls: string[] = []
  private showChoices = false

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.el.hidden) return
    if (event.key === 'Escape') {
      event.preventDefault()
      if (this.busy) this.cancelBusy()
      else this.close()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = Array.from(
      this.el.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), select:not([disabled]), a[href], summary',
      ),
    ).filter((node) => node.offsetParent !== null)
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    }
  }

  private readonly onPaste = (event: ClipboardEvent): void => {
    if (this.el.hidden) return
    const target = event.target as HTMLElement | null
    if (target?.closest('input, textarea')) return
    const file = Array.from(event.clipboardData?.files ?? []).find((item) =>
      item.type.startsWith('image/'),
    )
    if (!file) return
    event.preventDefault()
    void this.handleImageFile(file)
  }

  private readonly onDragOver = (event: DragEvent): void => {
    if (this.el.hidden) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    this.dropZone.classList.add('is-dragging')
  }

  private readonly onDragLeave = (event: DragEvent): void => {
    const related = event.relatedTarget as Node | null
    if (related && this.el.contains(related)) return
    this.dropZone.classList.remove('is-dragging')
  }

  private readonly onDrop = (event: DragEvent): void => {
    if (this.el.hidden) return
    event.preventDefault()
    this.dropZone.classList.remove('is-dragging')
    const transfer = event.dataTransfer
    if (!transfer) return
    const files = Array.from(transfer.files ?? [])
    const hasDirectory = Array.from(transfer.items ?? []).some(
      (item) => item.kind === 'file' && item.webkitGetAsEntry?.()?.isDirectory === true,
    )
    const imagesOnly =
      !hasDirectory &&
      files.length > 0 &&
      files.every((file) => file.type.startsWith('image/')) &&
      !files.some((file) => /\.zip$/i.test(file.name))
    if (imagesOnly && this.view === 'preview' && this.preview) {
      void this.handleImageFile(files[0])
      return
    }
    void this.loadDropped(transfer)
  }

  constructor(options: LayerImportUIOptions) {
    this.options = options
    const existing = document.getElementById(IMPORT_ID)
    if (existing) existing.remove()
    const template = document.createElement('template')
    template.innerHTML = IMPORT_HTML.trim()
    document.body.append(template.content)
    this.el = document.getElementById(IMPORT_ID) as HTMLElement
    this.dropZone = document.getElementById('tml-drop-zone') as HTMLElement
    this.pickSummary = document.getElementById('tml-pick-summary') as HTMLElement
    this.previewEl = document.getElementById('tml-import-preview') as HTMLElement
    this.busyEl = document.getElementById('tml-import-busy') as HTMLElement
    this.errorEl = document.getElementById('tml-import-error') as HTMLElement
    this.noteEl = document.getElementById('tml-import-note') as HTMLElement
    this.subEl = document.getElementById('tml-import-sub') as HTMLElement
    this.backButton = this.el.querySelector('[data-import-action="back"]') as HTMLButtonElement
    this.retryButton = this.el.querySelector('[data-import-action="retry"]') as HTMLButtonElement
    this.cancelButton = this.el.querySelector('[data-import-action="cancel"]') as HTMLButtonElement
    this.runButton = this.el.querySelector('[data-import-action="run"]') as HTMLButtonElement
    this.fandomUrlEl = document.getElementById('tml-fandom-url') as HTMLInputElement
    this.jsonUrlEl = document.getElementById('tml-json-url') as HTMLInputElement
    this.inputs = {
      zip: document.getElementById('tml-input-zip') as HTMLInputElement,
      folder: document.getElementById('tml-input-folder') as HTMLInputElement,
      json: document.getElementById('tml-input-json') as HTMLInputElement,
      image: document.getElementById('tml-input-image') as HTMLInputElement,
      tiles: document.getElementById('tml-input-tiles') as HTMLInputElement,
    }
    this.previewImageInput = document.createElement('input')
    this.previewImageInput.type = 'file'
    this.previewImageInput.accept = '.png,.jpg,.jpeg,.webp,.avif,.gif,image/*'
    this.previewImageInput.hidden = true
    this.previewTilesInput = document.createElement('input')
    this.previewTilesInput.type = 'file'
    this.previewTilesInput.multiple = true
    this.previewTilesInput.setAttribute('webkitdirectory', '')
    this.previewTilesInput.hidden = true
    this.el.append(this.previewImageInput, this.previewTilesInput)
    this.bind()
  }

  isOpen(): boolean {
    return !this.el.hidden
  }

  open(): void {
    this.reset()
    this.el.hidden = false
    document.addEventListener('keydown', this.onKeyDown)
    window.requestAnimationFrame(() => {
      const first = this.el.querySelector<HTMLElement>('[data-pick="zip"]')
      first?.focus()
    })
  }

  close(): void {
    if (this.abort) this.abort.abort()
    this.abort = null
    this.busy = false
    this.closing = true
    this.el.hidden = true
    document.removeEventListener('keydown', this.onKeyDown)
    this.revokeUrls()
    this.closing = false
  }

  dispose(): void {
    this.close()
    this.el.remove()
  }

  private bind(): void {
    this.el.addEventListener('click', (event) => this.onClick(event))
    this.el.addEventListener('change', (event) => this.onChange(event))
    this.el.addEventListener('dragover', this.onDragOver)
    this.el.addEventListener('dragleave', this.onDragLeave)
    this.el.addEventListener('drop', this.onDrop)
    document.addEventListener('paste', this.onPaste)
    this.previewImageInput.addEventListener('change', () => {
      const file = this.previewImageInput.files?.[0]
      this.previewImageInput.value = ''
      if (file) void this.handleImageFile(file)
    })
    this.previewTilesInput.addEventListener('change', () => {
      const files = Array.from(this.previewTilesInput.files ?? [])
      this.previewTilesInput.value = ''
      if (files.length) void this.replaceTiles(files)
    })
  }

  private onClick(event: MouseEvent): void {
    const target = event.target as HTMLElement
    const pick = target.closest<HTMLElement>('[data-pick]')?.dataset.pick
    if (pick) {
      this.inputs[pick]?.click()
      return
    }
    const imageChoice = target.closest<HTMLElement>('[data-image-choice]')?.dataset.imageChoice
    if (imageChoice) {
      void this.chooseImage(imageChoice)
      return
    }
    const previewAction = target.closest<HTMLElement>('[data-preview-action]')?.dataset.previewAction
    if (previewAction) {
      void this.onPreviewAction(previewAction)
      return
    }
    const action = target.closest<HTMLElement>('[data-import-action]')?.dataset.importAction
    if (!action) return
    switch (action) {
      case 'close':
        this.close()
        break
      case 'cancel':
        if (this.busy) this.cancelBusy()
        else this.close()
        break
      case 'back':
        this.setView('pick')
        break
      case 'read-url':
        void this.readFandomUrl()
        break
      case 'read-json-url':
        void this.readJsonUrl()
        break
      case 'retry':
        void this.lastTask?.()
        break
      case 'run':
        void this.runImport()
        break
      default:
        break
    }
  }

  private onChange(event: Event): void {
    const target = event.target as HTMLInputElement
    if (target === this.inputs.zip) {
      const file = target.files?.[0]
      target.value = ''
      if (file) void this.loadZip(file)
      return
    }
    if (target === this.inputs.folder) {
      const files = Array.from(target.files ?? [])
      target.value = ''
      if (files.length) void this.loadFolder(files)
      return
    }
    if (target === this.inputs.json) {
      const file = target.files?.[0]
      target.value = ''
      if (file) {
        this.manual.json = file
        void this.analyzeManual()
      }
      return
    }
    if (target === this.inputs.image) {
      const file = target.files?.[0]
      target.value = ''
      if (file) {
        this.manual.image = file
        if (this.view === 'preview' && this.preview) void this.handleImageFile(file)
        else void this.analyzeManual()
      }
      return
    }
    if (target === this.inputs.tiles) {
      const files = Array.from(target.files ?? [])
      target.value = ''
      if (files.length) {
        this.manual.tiles = files
        if (this.manual.json || this.preview) void this.analyzeManual()
        else this.renderPickSummary()
      }
    }
  }

  private async loadZip(file: File): Promise<void> {
    this.manual = {}
    this.bundle = null
    this.preview = null
    this.nameOverride = ''
    this.wikiOverride = ''
    this.tileUrl = ''
    await this.runTask('读取 .zip 地图包', async () => {
      const bundle = await zipToBundle(file, {
        signal: this.abort?.signal,
        onProgress: (event) => this.reportProgress(event),
      })
      this.bundle = bundle
      return analyzeBundle(bundle, this.analyzeOptions())
    })
  }

  private async loadFolder(files: File[]): Promise<void> {
    this.manual = {}
    this.bundle = filesToBundle(files)
    this.preview = null
    await this.runTask('扫描地图文件夹', async () =>
      analyzeBundle(this.bundle as LayerSourceBundle, this.analyzeOptions()),
    )
  }

  private async analyzeManual(): Promise<void> {
    const files: File[] = []
    if (this.manual.tiles?.length) files.push(...this.manual.tiles)
    if (this.manual.json) files.push(this.manual.json)
    if (this.manual.image) files.push(this.manual.image)
    this.renderPickSummary()
    if (files.length === 0) return
    if (!this.manual.json && !this.manual.image && this.manual.tiles?.length) {
      this.setView('pick')
      return
    }
    const label =
      (this.manual.json && this.manual.json.name.replace(/\.[^.]+$/, '')) ||
      (this.manual.image && this.manual.image.name.replace(/\.[^.]+$/, '')) ||
      '手动选择的地图包'
    this.bundle = filesToBundle(files, label)
    this.preview = null
    await this.runTask('读取本地文件', async () =>
      analyzeBundle(this.bundle as LayerSourceBundle, this.analyzeOptions()),
    )
  }

  private analyzeOptions() {
    return {
      signal: this.abort?.signal,
      onProgress: (event: LayerProgressEvent) => this.reportProgress(event),
      dataPath: this.preview?.dataPath,
      name: this.nameOverride.trim() || undefined,
      wikiBase: this.wikiOverride.trim() || undefined,
      tileUrl: this.tileUrl.trim() || undefined,
    }
  }

  private async loadDropped(transfer: DataTransfer): Promise<void> {
    await this.runTask('读取拖入的地图包', async () => {
      const bundle = await bundleFromDrop(transfer, {
        signal: this.abort?.signal,
        onProgress: (event) => this.reportProgress(event),
      })
      if (!bundle) throw new Error('没有识别到文件。可以拖入 .zip、文件夹，或 map.json + 图片。')
      this.bundle = bundle
      this.manual = {}
      return analyzeBundle(bundle, this.analyzeOptions())
    })
  }

  private async readFandomUrl(): Promise<void> {
    const url = this.fandomUrlEl.value.trim()
    if (!url) {
      this.showError('读取 Fandom 页面', '请输入 Fandom 地图页面 URL。')
      return
    }
    this.bundle = null
    this.preview = null
    await this.runTask('读取 Fandom 地图页面', async () =>
      fetchFandomMap(url, {
        signal: this.abort?.signal,
        onProgress: (event) => this.reportProgress(event),
      }),
    )
  }

  private async readJsonUrl(): Promise<void> {
    const value = this.jsonUrlEl.value.trim()
    if (!value) {
      this.showError('读取 JSON URL', '请输入 JSON 文件 URL。')
      return
    }
    await this.runTask('读取 JSON URL', async () => {
      let response: Response
      try {
        response = await fetch(value, { signal: this.abort?.signal, credentials: 'omit' })
      } catch (error) {
        throw new Error(
          `无法读取这个 URL（可能是 CORS 限制）：${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (!response.ok) throw new Error(`JSON URL 返回 HTTP ${response.status}`)
      const blob = await response.blob()
      const name = value.split('/').pop()?.split('?')[0] || 'map.json'
      const file = new File([blob], name.endsWith('.json') ? name : `${name}.json`, {
        type: 'application/json',
      })
      const bundle = filesToBundle([file], name.replace(/\.[^.]+$/, ''))
      this.bundle = bundle
      return analyzeBundle(bundle, this.analyzeOptions())
    })
  }

  private async runTask(label: string, task: () => Promise<LayerImportPreview>): Promise<void> {
    if (this.busy) return
    this.lastTask = () => this.runTask(label, task)
    this.abort = new AbortController()
    this.busy = true
    this.progress = []
    this.setView('busy')
    this.subEl.textContent = label
    this.reportProgress({ step: label, detail: '正在读取…' })
    try {
      const preview = await task()
      if (this.abort?.signal.aborted) throw new DOMException('导入已取消', 'AbortError')
      this.preview = preview
      this.nameOverride = this.nameOverride || preview.pkg.name
      this.wikiOverride = this.wikiOverride || preview.pkg.wikiBase || ''
      this.tileUrl = this.tileUrl || preview.pkg.tile?.template || ''
      this.showChoices = preview.imageChoices.length > 1 && preview.pkg.image === undefined
      this.setView('preview')
      this.renderPreview()
      this.subEl.textContent = '预览后再写入'
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (!this.closing) {
          this.busy = false
          this.setView(this.preview ? 'preview' : 'pick')
          if (this.preview) this.renderPreview()
        }
        return
      }
      this.busy = false
      this.showError(label, errorMessage(error))
    } finally {
      if (!this.closing) this.busy = false
      this.abort = null
      this.renderFooter()
    }
  }

  private reportProgress(event: LayerProgressEvent): void {
    const index = this.progress.findIndex((item) => item.step === event.step)
    if (index >= 0) this.progress[index] = { ...this.progress[index], ...event }
    else this.progress.push(event)
    if (this.busy && this.view === 'busy' && !this.progressFrame) {
      this.progressFrame = window.requestAnimationFrame(() => {
        this.progressFrame = 0
        if (this.view === 'busy') this.renderBusy()
      })
    }
  }

  private async chooseImage(path: string): Promise<void> {
    if (!this.preview) return
    this.preview = await selectPreviewImage(this.preview, path)
    this.showChoices = false
    this.renderPreview()
  }

  private async handleImageFile(file: File): Promise<void> {
    if (!file.type.startsWith('image/') && !/\.(png|jpe?g|webp|avif|gif)$/i.test(file.name)) {
      this.showError('读取底图', '请选择 PNG / JPG / WebP / AVIF 图片。')
      return
    }
    if (this.view === 'preview' && this.preview) {
      try {
        this.preview = await useLocalImage(this.preview, file)
        this.showChoices = false
        this.renderPreview()
      } catch (error) {
        this.showError('读取底图', errorMessage(error))
      }
      return
    }
    this.manual.image = file
    await this.analyzeManual()
  }

  private async replaceTiles(files: File[]): Promise<void> {
    const original = this.preview?.bundle
    if (!original) return
    const jsonFiles = original.files.filter(
      (file) => file.path.toLowerCase().endsWith('.json'),
    )
    const manifestFile = original.files.find(
      (file) => file.name.toLowerCase() === 'manifest.json',
    )
    const newTiles = filesToBundle(files, original.label).files
    const bundle: LayerSourceBundle = {
      label: original.label,
      source: 'files',
      files: [
        ...newTiles,
        ...jsonFiles,
        ...(manifestFile ? [manifestFile] : []),
      ],
    }
    this.bundle = bundle
    await this.runTask('重新扫描瓦片', async () =>
      analyzeBundle(bundle, {
        ...this.analyzeOptions(),
        dataPath: this.preview?.dataPath,
      }),
    )
  }

  private async onPreviewAction(action: string): Promise<void> {
    if (!this.preview) return
    if (action === 'pick-image') {
      this.previewImageInput.click()
      return
    }
    if (action === 'pick-tiles') {
      this.previewTilesInput.click()
      return
    }
    if (action === 'remove-image') {
      this.preview = removePreviewImage(this.preview)
      this.renderPreview()
      return
    }
    if (action === 'toggle-choices') {
      this.showChoices = !this.showChoices
      this.renderPreview()
      return
    }
    if (action === 'run-without-image') {
      await this.runImport()
      return
    }
    if (action === 'reanalyze') {
      if (!this.bundle) return
      await this.runTask('重新读取地图包', async () =>
        analyzeBundle(this.bundle as LayerSourceBundle, this.analyzeOptions()),
      )
      return
    }
    if (action === 'read-url-again') {
      await this.readFandomUrl()
    }
  }

  private setView(view: View): void {
    this.view = view
    const map: Record<View, HTMLElement> = {
      pick: document.getElementById('tml-import-pick') as HTMLElement,
      preview: this.previewEl,
      busy: this.busyEl,
      error: this.errorEl,
    }
    for (const [key, node] of Object.entries(map)) node.hidden = key !== view
    this.renderFooter()
  }

  private renderFooter(): void {
    const preview = this.preview
    const hasImage = Boolean(preview?.pkg.image)
    const hasTiles = Boolean(preview && (preview.stats.tiles?.count ?? 0) > 0)
    const hasData = Boolean(
      preview &&
        (preview.pkg.markers.length > 0 ||
          (preview.pkg.kind === 'tiles' && (hasTiles || Boolean(preview.pkg.tile?.template)))),
    )
    this.backButton.hidden = this.view === 'pick' || this.view === 'busy'
    this.retryButton.hidden = this.view !== 'error'
    this.cancelButton.hidden = false
    this.cancelButton.textContent = this.view === 'busy' ? '取消导入' : '取消'
    this.runButton.hidden = this.view !== 'preview'
    if (this.view === 'preview' && preview) {
      if (preview.pkg.kind === 'image' && preview.pkg.markers.length === 0 && !hasImage) {
        this.runButton.textContent = '没有可导入的内容'
        this.runButton.disabled = true
      } else if (preview.pkg.kind === 'tiles' && (hasTiles || preview.pkg.tile?.template)) {
        this.runButton.textContent = '导入并打开'
        this.runButton.disabled = false
      } else if (!hasImage) {
        this.runButton.textContent = preview.pkg.markers.length > 0 ? '先导入点位' : '导入并打开'
        this.runButton.disabled = !hasData
      } else if (preview.pkg.kind === 'image' && preview.pkg.markers.length === 0) {
        this.runButton.textContent = '导入底图'
        this.runButton.disabled = false
      } else {
        this.runButton.textContent = '导入并打开'
        this.runButton.disabled = false
      }
    } else {
      this.runButton.disabled = false
    }
    this.noteEl.textContent =
      this.view === 'busy'
        ? '取消后不会写入未完成的数据。'
        : this.view === 'error'
          ? '没有写入任何数据。'
          : this.view === 'preview'
            ? '底图、地点、笔记都只保存在本机。'
            : '支持 .zip、文件夹；只选一张底图也可以先导入。'
  }

  private renderPickSummary(): void {
    const parts: string[] = []
    if (this.manual.json) parts.push(`JSON ${this.manual.json.name}`)
    if (this.manual.image) parts.push(`底图 ${this.manual.image.name}`)
    if (this.manual.tiles?.length) parts.push(`瓦片 ${this.manual.tiles.length} 个文件`)
    if (this.bundle && parts.length === 0) {
      parts.push(`${this.bundle.label} · ${this.bundle.files.length} 个文件`)
    }
    const waitingTiles = this.manual.tiles?.length && !this.manual.json
    this.pickSummary.textContent = parts.length
      ? `已选：${parts.join(' · ')}${waitingTiles ? '（还需要 mapData JSON）' : ''}`
      : '尚未选择文件'
    this.pickSummary.classList.toggle('has-selection', parts.length > 0)
  }

  private renderBusy(): void {
    this.busyEl.replaceChildren()
    const head = element('div', 'tml-progress-head')
    head.append(
      element('strong', undefined, '正在读取地图包'),
      element('span', undefined, '可以把这一步取消，未完成的数据不会写入。'),
    )
    this.busyEl.append(head)
    const list = element('div', 'tml-progress-list')
    const currentIndex = this.progress.length - 1
    this.progress.forEach((item, index) => {
      const row = element('div', 'tml-progress-row')
      const mark = element('span', 'tml-progress-mark')
      if (index < currentIndex || (item.total && item.done === item.total)) {
        mark.classList.add('is-done')
        mark.append(icon('check'))
      } else {
        mark.classList.add('is-active')
      }
      const body = element('div', 'tml-progress-body')
      body.append(element('span', 'tml-progress-step', item.step))
      if (item.detail) body.append(element('span', 'tml-progress-detail', item.detail))
      if (item.total) {
        const bar = element('div', 'tml-progress-bar')
        const fill = element('span')
        fill.style.width = `${Math.min(100, Math.max(0, ((item.done ?? 0) / item.total) * 100))}%`
        bar.append(fill)
        body.append(bar)
        body.append(
          element(
            'span',
            'tml-progress-count',
            `${formatCount(item.done ?? 0)} / ${formatCount(item.total)}`,
          ),
        )
      }
      row.append(mark, body)
      list.append(row)
    })
    this.busyEl.append(list)
  }

  private renderError(): void {
    this.errorEl.replaceChildren()
    const head = element('div', 'tml-error-head')
    const mark = element('span', 'tml-error-mark')
    mark.append(icon('warning'))
    const copy = element('div')
    copy.append(
      element('strong', undefined, this.errorStage || '导入失败'),
      element('p', undefined, this.errorText),
    )
    head.append(mark, copy)
    this.errorEl.append(head)
    this.errorEl.append(
      element(
        'p',
        'tml-hint',
        '已经读取到的文件仍保留在这个窗口里，可以返回重选或重试；没有写入任何地图包。',
      ),
    )
  }

  private showError(stage: string, message: string): void {
    this.errorStage = stage
    this.errorText = message
    this.busy = false
    this.setView('error')
    this.renderError()
  }

  private renderPreview(): void {
    const preview = this.preview
    if (!preview) return
    this.revokePreviewUrls()
    this.previewEl.replaceChildren()
    const { pkg, stats } = preview
    const head = element('div', 'tml-preview-head')
    const type = element('span', 'tml-type-badge', preview.sourceLabel)
    const source = element('span', 'tml-preview-source')
    source.textContent = preview.dataPath || '本地文件'
    head.append(type, source)
    this.previewEl.append(head)
    const title = element('h3', 'tml-preview-title', pkg.name)
    this.previewEl.append(title)
    const facts = element('div', 'tml-preview-facts')
    const fact = (label: string, value: string): HTMLElement => {
      const item = element('span', 'tml-fact')
      item.append(element('span', 'tml-fact-label', label), element('strong', undefined, value))
      return item
    }
    facts.append(
      fact('地点', formatCount(stats.markerCount)),
      fact('分类', formatCount(stats.categoryCount)),
      fact('有说明', formatCount(stats.descriptionCount)),
      fact('有链接', formatCount(stats.linkMarkerCount)),
    )
    if (pkg.kind === 'tiles') facts.append(fact('区域', formatCount(stats.regionCount)))
    if (pkg.kind === 'image') facts.append(fact('画布', `${formatCount(pkg.width)}×${formatCount(pkg.height)}`))
    this.previewEl.append(facts)
    const meta = element('div', 'tml-preview-meta')
    meta.append(
      element('span', undefined, `${formatCount(stats.fileCount)} 个文件`),
      element('span', undefined, `约 ${formatBytes(stats.sizeBytes)}`),
      element(
        'span',
        undefined,
        pkg.kind === 'tiles'
          ? '瓦片地图 · WebMercator'
          : pkg.image
            ? `底图 ${formatCount(pkg.imageWidth ?? 0)}×${formatCount(pkg.imageHeight ?? 0)}`
            : '暂无底图',
      ),
    )
    this.previewEl.append(meta)
    if (pkg.kind === 'image') this.previewEl.append(this.renderImageSection(preview))
    if (pkg.kind === 'tiles') this.previewEl.append(this.renderTileSection(preview))
    this.previewEl.append(this.renderNotices(preview))
    this.previewEl.append(this.renderDataChoices(preview))
    this.previewEl.append(this.renderAdvanced(preview))
    this.renderFooter()
  }

  private renderImageSection(preview: LayerImportPreview): HTMLElement {
    const section = element('section', 'tml-preview-image')
    const head = element('div', 'tml-section-heading')
    head.append(element('h4', undefined, '底图'))
    const choice = preview.imageChoices.find(
      (item) => item.path === preview.selectedImagePath,
    )
    if (choice) {
      const badge = element('span', 'tml-image-badge', this.matchLabel(choice))
      head.append(badge)
    }
    section.append(head)
    if (preview.pkg.image) {
      const row = element('div', 'tml-image-row')
      const thumbWrap = element('div', 'tml-image-thumb')
      const img = document.createElement('img')
      this.previewImageUrl = URL.createObjectURL(preview.pkg.image)
      img.src = this.previewImageUrl
      img.alt = preview.pkg.imageName || '当前底图'
      thumbWrap.append(img)
      const body = element('div', 'tml-image-body')
      const name = element('strong', 'tml-image-name', preview.pkg.imageName || '当前底图')
      name.title = preview.pkg.imageName || ''
      body.append(name)
      const details: string[] = []
      if (preview.pkg.imageWidth && preview.pkg.imageHeight) {
        details.push(
          `${formatCount(preview.pkg.imageWidth)}×${formatCount(preview.pkg.imageHeight)}`,
        )
      }
      details.push(formatBytes(preview.pkg.image?.size))
      details.push(imageSourceLabel(preview.pkg.imageSource))
      details.push(imageFitLabel(preview.pkg.imageFit))
      body.append(element('span', 'tml-image-meta', details.join(' · ')))
      if (choice?.placeholder) {
        body.append(
          element('span', 'tml-image-warning', '占位图，不是原始地图。建议换成本地原图。'),
        )
      }
      const actions = element('div', 'tml-image-actions')
      const pick = element('button', 'tml-btn', '更换底图')
      pick.type = 'button'
      pick.dataset.previewAction = 'pick-image'
      actions.append(pick)
      if (preview.imageChoices.length > 1) {
        const choose = element(
          'button',
          'tml-btn',
          this.showChoices ? '收起包内图片' : `使用包内图片 ${preview.imageChoices.length}`,
        )
        choose.type = 'button'
        choose.dataset.previewAction = 'toggle-choices'
        actions.append(choose)
      }
      const remove = element('button', 'tml-btn tml-danger-text', '移除底图')
      remove.type = 'button'
      remove.dataset.previewAction = 'remove-image'
      actions.append(remove)
      body.append(actions)
      row.append(thumbWrap, body)
      section.append(row)
      section.append(
        element(
          'p',
          'tml-image-drop-hint',
          '也可以把图片拖到这里，或直接粘贴剪贴板里的图片替换。',
        ),
      )
    } else {
      const empty = element('div', 'tml-image-empty')
      const mark = element('span', 'tml-image-empty-mark')
      mark.append(icon('image'))
      const body = element('div', 'tml-image-empty-body')
      body.append(
        element('strong', undefined, '这张包没有可用底图'),
        element(
          'p',
          undefined,
          preview.imageDownloadError
            ? 'JSON、说明和链接已经读取。底图下载失败，可以选择本地图片或先导入点位。'
            : '地点、说明和链接已经读取。可以先导入点位，之后随时补图。',
        ),
      )
      if (preview.imageDownloadError) {
        body.append(
          element('p', 'tml-image-error', `原因：${preview.imageDownloadError}`),
        )
        if (preview.imagePageUrl) {
          const link = document.createElement('a')
          link.href = preview.imagePageUrl
          link.target = '_blank'
          link.rel = 'noreferrer'
          link.className = 'tml-link-inline'
          link.textContent =
            preview.pkg.imageSource === 'fandom-url' || preview.sourceLabel === 'Fandom 页面'
              ? '打开 Fandom 图片页'
              : '打开源数据图片页'
          body.append(link)
        }
      }
      const actions = element('div', 'tml-image-actions')
      const pick = element('button', 'tml-btn tml-primary', '选择本地图片')
      pick.type = 'button'
      pick.dataset.previewAction = 'pick-image'
      actions.append(pick)
      if (preview.imageChoices.length > 0) {
        const choose = element(
          'button',
          'tml-btn',
          this.showChoices ? '收起包内图片' : `使用包内图片 ${preview.imageChoices.length}`,
        )
        choose.type = 'button'
        choose.dataset.previewAction = 'toggle-choices'
        actions.append(choose)
      }
      if (preview.pkg.markers.length > 0) {
        const skip = element('button', 'tml-btn', '先导入点位（无底图）')
        skip.type = 'button'
        skip.dataset.previewAction = 'run-without-image'
        actions.append(skip)
      }
      body.append(actions)
      empty.append(mark, body)
      section.append(empty)
    }
    if (this.showChoices && preview.imageChoices.length > 1) {
      section.append(this.renderImageChoices(preview))
    }
    return section
  }

  private renderImageChoices(preview: LayerImportPreview): HTMLElement {
    const rail = element('div', 'tml-image-choices')
    for (const choice of preview.imageChoices) {
      const button = element('button', 'tml-image-choice')
      button.type = 'button'
      button.dataset.imageChoice = choice.path
      button.setAttribute(
        'aria-pressed',
        String(choice.path === preview.selectedImagePath),
      )
      const thumb = element('span', 'tml-image-choice-thumb')
      const url = URL.createObjectURL(choice.blob)
      this.choiceUrls.push(url)
      const img = document.createElement('img')
      img.src = url
      img.alt = ''
      thumb.append(img)
      const name = element('span', 'tml-image-choice-name', choice.name)
      name.title = choice.name
      const match = element('span', 'tml-image-choice-match', this.matchLabel(choice))
      button.append(thumb, name, match)
      rail.append(button)
    }
    return rail
  }

  private matchLabel(choice: LayerImageChoice): string {
    if (choice.matched === 'manifest') return 'manifest 指定'
    if (choice.matched === 'mapImage') return '匹配 mapImage'
    if (choice.matched === 'only') return '包内唯一图片'
    if (choice.matched === 'local') return '本地图片'
    if (choice.matched === 'downloaded') return 'Fandom 原图'
    if (choice.matched === 'fuzzy') return '最接近的图片'
    return '包内图片'
  }

  private renderTileSection(preview: LayerImportPreview): HTMLElement {
    const section = element('section', 'tml-preview-tiles')
    const head = element('div', 'tml-section-heading')
    head.append(element('h4', undefined, '瓦片'))
    section.append(head)
    const stats = preview.stats.tiles
    if (stats && stats.count > 0) {
      const row = element('div', 'tml-tile-summary')
      row.append(
        element('strong', undefined, `${formatCount(stats.count)} 张`),
        element(
          'span',
          undefined,
          stats.minZoom != null && stats.maxZoom != null
            ? `覆盖 z${stats.minZoom}–z${stats.maxZoom}`
            : '覆盖层级未检测',
        ),
        element(
          'span',
          stats.missing > 0 ? 'tml-tile-missing' : 'tml-tile-ok',
          stats.missing > 0 ? `缺 ${formatCount(stats.missing)} 张` : '已覆盖层级不缺块',
        ),
      )
      section.append(row)
      section.append(
        element(
          'p',
          'tml-hint',
          `顺序 ${stats.order === 'zxy' ? '{z}/{x}/{y}' : stats.order === 'zyx' ? '{z}/{y}/{x}' : '未检测'} · ${stats.hasBounds ? '有 bounds' : '无 bounds，按 WebMercator'} · 瓦片组「${stats.setName}」`,
        ),
      )
    } else {
      section.append(
        element(
          'p',
          'tml-hint',
          '没有找到本地瓦片。地点和区域仍可导入；也可以在“底图”里补瓦片。',
        ),
      )
    }
    if (preview.bundle) {
      const pick = element('button', 'tml-btn', stats?.count ? '重新选择瓦片文件夹' : '选择瓦片文件夹')
      pick.type = 'button'
      pick.dataset.previewAction = 'pick-tiles'
      section.append(pick)
    }
    return section
  }

  private renderNotices(preview: LayerImportPreview): HTMLElement {
    const section = element('section', 'tml-preview-notices')
    if (preview.notices.length === 0) {
      const ok = element('div', 'tml-notice is-ok')
      const mark = element('span', 'tml-notice-mark')
      mark.append(icon('check'))
      ok.append(mark, element('span', undefined, '数据完整，可以导入。'))
      section.append(ok)
      return section
    }
    for (const notice of preview.notices) {
      const row = element('div', `tml-notice is-${notice.tone}`)
      const mark = element('span', 'tml-notice-mark')
      mark.append(icon(notice.tone === 'warning' ? 'warning' : 'info'))
      row.append(mark, element('span', undefined, notice.text))
      section.append(row)
    }
    return section
  }

  private renderDataChoices(preview: LayerImportPreview): HTMLElement {
    const section = element('section', 'tml-preview-data')
    if (preview.dataCandidates.length <= 1) return section
    const label = element('label', 'tml-field')
    label.append(element('span', undefined, '数据文件'))
    const select = document.createElement('select')
    select.className = 'tml-select'
    for (const candidate of preview.dataCandidates) {
      const option = new Option(candidate.label, candidate.path)
      option.selected = candidate.path === preview.dataPath
      select.append(option)
    }
    select.addEventListener('change', () => {
      const dataPath = select.value
      if (!this.bundle) return
      void this.runTask('切换数据文件', async () =>
        analyzeBundle(this.bundle as LayerSourceBundle, {
          ...this.analyzeOptions(),
          dataPath,
        }),
      )
    })
    label.append(select)
    section.append(label)
    return section
  }

  private renderAdvanced(preview: LayerImportPreview): HTMLElement {
    const details = document.createElement('details')
    details.className = 'tml-advanced tml-preview-advanced'
    const summary = document.createElement('summary')
    summary.textContent = '高级选项'
    details.append(summary)
    const body = element('div', 'tml-advanced-body')
    const nameField = element('label', 'tml-field')
    nameField.append(element('span', undefined, '地图包名称'))
    const nameInput = document.createElement('input')
    nameInput.type = 'text'
    nameInput.value = preview.pkg.name
    nameInput.addEventListener('input', () => {
      this.nameOverride = nameInput.value
      if (this.preview) {
        this.preview.pkg.name = nameInput.value.trim() || preview.pkg.name
        this.preview.pkg.nameLocked = true
      }
      const title = this.previewEl.querySelector<HTMLElement>('.tml-preview-title')
      if (title && this.preview) title.textContent = this.preview.pkg.name
    })
    nameField.append(nameInput)
    body.append(nameField)
    if (preview.pkg.source === 'fandom' && preview.bundle) {
      const wikiField = element('label', 'tml-field')
      wikiField.append(element('span', undefined, 'Wiki 域名（影响链接补全）'))
      const wikiInput = document.createElement('input')
      wikiInput.type = 'text'
      wikiInput.value = preview.pkg.wikiBase || ''
      wikiInput.placeholder = 'forgottenrealms.fandom.com'
      wikiInput.addEventListener('input', () => {
        this.wikiOverride = wikiInput.value
      })
      wikiField.append(wikiInput)
      body.append(wikiField)
    }
    if (preview.pkg.kind === 'tiles') {
      const tileField = element('label', 'tml-field')
      tileField.append(element('span', undefined, '瓦片 URL 模板（本地瓦片可留空）'))
      const tileInput = document.createElement('input')
      tileInput.type = 'text'
      tileInput.value = preview.pkg.tile?.template || ''
      tileInput.placeholder = 'http://127.0.0.1:8000/{z}/{y}/{x}.jpg'
      tileInput.addEventListener('input', () => {
        this.tileUrl = tileInput.value
        if (this.preview?.pkg.tile) this.preview.pkg.tile.template = tileInput.value.trim()
      })
      tileField.append(tileInput)
      body.append(tileField)
    }
    if (preview.bundle) {
      const reanalyze = element('button', 'tml-mini', '用这些设置重新扫描')
      reanalyze.type = 'button'
      reanalyze.dataset.previewAction = 'reanalyze'
      body.append(reanalyze)
    }
    if (preview.imagePageUrl) {
      const link = document.createElement('a')
      link.href = preview.imagePageUrl
      link.target = '_blank'
      link.rel = 'noreferrer'
      link.className = 'tml-link-inline'
      link.textContent =
        preview.pkg.imageSource === 'fandom-url' || preview.sourceLabel === 'Fandom 页面'
          ? '打开 Fandom 图片页'
          : '打开源数据图片页'
      body.append(link)
    }
    details.append(body)
    return details
  }

  private async runImport(): Promise<void> {
    const preview = this.preview
    if (!preview || this.busy) return
    const pkg = preview.pkg
    if (
      pkg.kind === 'tiles' &&
      pkg.tile?.template &&
      (!/\{z\}/.test(pkg.tile.template) ||
        !/\{x\}/.test(pkg.tile.template) ||
        !/\{y\}/.test(pkg.tile.template))
    ) {
      this.showError('瓦片 URL 模板', '模板必须同时包含 {z}、{x}、{y}。')
      return
    }
    if (!pkg.image && pkg.markers.length === 0 && pkg.kind === 'image') {
      this.showError('导入地图包', '这个地图包既没有底图，也没有地点数据，无法导入。')
      return
    }
    this.lastTask = () => this.runImport()
    this.abort = new AbortController()
    this.busy = true
    this.progress = []
    this.setView('busy')
    this.subEl.textContent = '正在写入地图包'
    this.reportProgress({ step: '准备写入 IndexedDB', detail: '检查浏览器存储空间…' })
    try {
      await ensureLayerStorage(preview.stats.sizeBytes)
      if (this.abort.signal.aborted) throw new DOMException('导入已取消', 'AbortError')
      this.reportProgress({
        step: '写入 IndexedDB',
        detail: `${formatCount(pkg.markers.length)} 个地点 · ${formatBytes(preview.stats.sizeBytes)}`,
      })
      const result = await saveImportedPackage(pkg, this.abort.signal)
      if (this.abort.signal.aborted) {
        throw new DOMException('导入已取消', 'AbortError')
      }
      this.busy = false
      this.el.hidden = true
      document.removeEventListener('keydown', this.onKeyDown)
      this.options.onToast(
        result.updated ? `已更新地图包：${result.pkg.name}` : `已导入地图包：${result.pkg.name}`,
      )
      try {
        await this.options.onImported(result.pkg)
      } catch (error) {
        console.warn('[tavern-map] package imported but opening it failed', error)
      }
      this.close()
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        this.busy = false
        this.setView('preview')
        this.renderPreview()
        this.options.onToast('已取消导入')
        return
      }
      if (error instanceof StorageQuotaError || isQuotaError(error)) {
        const quota =
          error instanceof StorageQuotaError
            ? `需要约 ${formatBytes(error.needed)}，已用 ${formatBytes(error.usage)} / 配额 ${formatBytes(error.quota)}。`
            : errorMessage(error)
        this.showError(
          '浏览器存储空间不足',
          `${quota} 请删除不用的地图包，或换一个更大的浏览器存储配额。已读取的数据还在这个窗口里。`,
        )
        return
      }
      this.showError('导入地图包', errorMessage(error))
    } finally {
      this.busy = false
      this.abort = null
    }
  }

  private cancelBusy(): void {
    this.abort?.abort()
    this.abort = null
    this.busy = false
    this.setView(this.preview ? 'preview' : 'pick')
    if (this.preview) this.renderPreview()
    this.options.onToast('已取消')
  }

  private reset(): void {
    this.abort?.abort()
    this.abort = null
    this.bundle = null
    this.manual = {}
    this.preview = null
    this.busy = false
    this.nameOverride = ''
    this.wikiOverride = ''
    this.tileUrl = ''
    this.errorText = ''
    this.errorStage = ''
    this.progress = []
    this.lastTask = null
    this.showChoices = false
    this.fandomUrlEl.value = ''
    this.jsonUrlEl.value = ''
    for (const input of Object.values(this.inputs)) input.value = ''
    this.previewImageInput.value = ''
    this.revokeUrls()
    this.setView('pick')
    this.renderPickSummary()
    this.subEl.textContent = '一个包一次导入'
  }

  private revokePreviewUrls(): void {
    if (this.previewImageUrl) {
      URL.revokeObjectURL(this.previewImageUrl)
      this.previewImageUrl = null
    }
    for (const url of this.choiceUrls) URL.revokeObjectURL(url)
    this.choiceUrls = []
  }

  private revokeUrls(): void {
    this.revokePreviewUrls()
  }
}
