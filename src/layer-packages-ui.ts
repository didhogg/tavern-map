import { errorMessage } from './http'
import {
  formatBytes,
  formatCount,
  imageFitLabel,
  imageSourceLabel,
  makeLayerThumbnail,
  readLayerImage,
} from './layer-image'
import type { LayerMapPackage, LayerPackageMeta, LayerTileConfig } from './layer-types'
import {
  analyzeBundle,
  filesToBundle,
  scanTileFiles,
  zipToBundle,
  type LayerSourceBundle,
} from './layer-source'
import {
  deleteLayerPackage,
  getLayerPackage,
  listLayerPackages,
  removeLayerImage,
  renameLayerPackage,
  setLayerImage,
  setLayerTiles,
  updateLayerPackage,
} from './layer-store'
import type { MapGenieTileSetInfo } from './layer-import'

export type LayerPackagesUIOptions = {
  onOpen: (id: string) => void | Promise<void>
  onChanged: (pkg: LayerMapPackage) => void | Promise<void>
  onDeleted: (id: string) => void
  onImport: () => void
  onToast: (message: string) => void
}

const PACKAGES_ID = 'tml-packages'

const PACKAGES_HTML = `
<div id="${PACKAGES_ID}" class="tml-modal tml-packages-modal" role="dialog" aria-modal="true" aria-label="地图包管理" hidden>
  <div class="tml-modal-card tml-packages-card">
    <header class="tml-modal-head">
      <div class="tml-modal-heading">
        <strong>地图包</strong>
        <span class="tml-modal-sub">底图、地点和聊天笔记分开保存</span>
      </div>
      <button type="button" class="tml-close" data-package-action="close" aria-label="关闭">×</button>
    </header>
    <div id="tml-packages-list" class="tml-packages-body"></div>
    <footer class="tml-modal-foot">
      <span class="tml-import-note">删除地图包不会删除聊天里的地点笔记。</span>
      <div class="tml-modal-actions">
        <button type="button" class="tml-btn" data-package-action="import">+ 导入地图包</button>
        <button type="button" class="tml-btn" data-package-action="close">关闭</button>
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

function typeLabel(meta: LayerPackageMeta): string {
  if (meta.sourceLabel) return meta.sourceLabel
  if (meta.source === 'fandom') return 'Fandom 图片'
  if (meta.source === 'mapgenie') return 'Map Genie 瓦片'
  return meta.kind === 'tiles' ? '瓦片' : '图片'
}

function tileSetFor(pkg: LayerMapPackage): MapGenieTileSetInfo | undefined {
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

export class LayerPackagesUI {
  private readonly options: LayerPackagesUIOptions
  private readonly el: HTMLElement
  private readonly listEl: HTMLElement
  private readonly imageInput: HTMLInputElement
  private readonly tilesInput: HTMLInputElement
  private readonly attachInput: HTMLInputElement
  private metas: LayerPackageMeta[] = []
  private expandedId: string | undefined
  private expandedPkg: LayerMapPackage | undefined
  private renamingId: string | undefined
  private deletingId: string | undefined
  private removingImageId: string | undefined
  private targetId: string | undefined
  private loading = false
  private thumbUrls: string[] = []

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.el.hidden) return
    if (event.key === 'Escape') {
      event.preventDefault()
      this.close()
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

  constructor(options: LayerPackagesUIOptions) {
    this.options = options
    const existing = document.getElementById(PACKAGES_ID)
    if (existing) existing.remove()
    const template = document.createElement('template')
    template.innerHTML = PACKAGES_HTML.trim()
    document.body.append(template.content)
    this.el = document.getElementById(PACKAGES_ID) as HTMLElement
    this.listEl = document.getElementById('tml-packages-list') as HTMLElement
    this.imageInput = document.createElement('input')
    this.imageInput.type = 'file'
    this.imageInput.accept = '.png,.jpg,.jpeg,.webp,.avif,.gif,image/*'
    this.imageInput.hidden = true
    this.tilesInput = document.createElement('input')
    this.tilesInput.type = 'file'
    this.tilesInput.multiple = true
    this.tilesInput.setAttribute('webkitdirectory', '')
    this.tilesInput.hidden = true
    this.attachInput = document.createElement('input')
    this.attachInput.type = 'file'
    this.attachInput.accept = '.json,.zip,application/json,application/zip'
    this.attachInput.hidden = true
    this.el.append(this.imageInput, this.tilesInput, this.attachInput)
    this.bind()
  }

  isOpen(): boolean {
    return !this.el.hidden
  }

  async open(): Promise<void> {
    this.el.hidden = false
    this.expandedId = undefined
    this.expandedPkg = undefined
    this.renamingId = undefined
    this.deletingId = undefined
    this.removingImageId = undefined
    document.addEventListener('keydown', this.onKeyDown)
    await this.reload()
    this.el.querySelector<HTMLElement>('[data-package-action="close"]')?.focus()
  }

  close(): void {
    this.el.hidden = true
    document.removeEventListener('keydown', this.onKeyDown)
    this.revokeThumbUrls()
  }

  dispose(): void {
    this.close()
    this.el.remove()
  }

  private bind(): void {
    this.el.addEventListener('click', (event) => {
      const target = event.target as HTMLElement
      const action = target.closest<HTMLElement>('[data-package-action]')?.dataset.packageAction
      if (!action) return
      const id = target.closest<HTMLElement>('[data-package-id]')?.dataset.packageId
      void this.onAction(action, id)
    })
    this.imageInput.addEventListener('change', () => {
      const file = this.imageInput.files?.[0]
      this.imageInput.value = ''
      if (file && this.targetId) void this.replaceImage(this.targetId, file)
    })
    this.tilesInput.addEventListener('change', () => {
      const files = Array.from(this.tilesInput.files ?? [])
      this.tilesInput.value = ''
      if (files.length && this.targetId) void this.replaceTiles(this.targetId, files)
    })
    this.attachInput.addEventListener('change', () => {
      const file = this.attachInput.files?.[0]
      this.attachInput.value = ''
      if (file && this.targetId) void this.attachData(this.targetId, file)
    })
  }

  private async onAction(action: string, id: string | undefined): Promise<void> {
    if (action === 'close') {
      this.close()
      return
    }
    if (action === 'import') {
      this.close()
      this.options.onImport()
      return
    }
    if (!id) return
    if (action === 'open') {
      this.close()
      await this.options.onOpen(id)
      return
    }
    if (action === 'rename') {
      this.renamingId = id
      this.deletingId = undefined
      this.render()
      const input = this.listEl.querySelector<HTMLInputElement>('[data-package-rename-input]')
      input?.focus()
      input?.select()
      return
    }
    if (action === 'rename-save') {
      const input = this.listEl.querySelector<HTMLInputElement>('[data-package-rename-input]')
      const name = input?.value ?? ''
      const updated = await renameLayerPackage(id, name).catch((error) => {
        this.options.onToast(`重命名失败：${errorMessage(error)}`)
        return undefined
      })
      if (updated) {
        this.options.onToast(`已重命名为 ${updated.name}`)
        this.renamingId = undefined
        await this.reload()
        await this.options.onChanged(updated)
      }
      return
    }
    if (action === 'rename-cancel') {
      this.renamingId = undefined
      this.render()
      return
    }
    if (action === 'expand') {
      if (this.expandedId === id) {
        this.expandedId = undefined
        this.expandedPkg = undefined
        this.render()
        return
      }
      const pkg = await getLayerPackage(id)
      if (!pkg) {
        this.options.onToast('这个地图包已经不存在。')
        await this.reload()
        return
      }
      this.expandedId = id
      this.expandedPkg = pkg
      this.removingImageId = undefined
      this.render()
      return
    }
    if (action === 'delete') {
      this.deletingId = id
      this.renamingId = undefined
      this.render()
      return
    }
    if (action === 'delete-cancel') {
      this.deletingId = undefined
      this.render()
      return
    }
    if (action === 'delete-confirm') {
      try {
        await deleteLayerPackage(id)
        this.deletingId = undefined
        if (this.expandedId === id) {
          this.expandedId = undefined
          this.expandedPkg = undefined
        }
        this.options.onToast('地图包已删除')
        this.options.onDeleted(id)
        await this.reload()
      } catch (error) {
        this.options.onToast(`删除失败：${errorMessage(error)}`)
      }
      return
    }
    if (action === 'replace-image') {
      this.targetId = id
      this.imageInput.click()
      return
    }
    if (action === 'remove-image') {
      this.removingImageId = id
      this.render()
      return
    }
    if (action === 'remove-image-cancel') {
      this.removingImageId = undefined
      this.render()
      return
    }
    if (action === 'remove-image-confirm') {
      const updated = await removeLayerImage(id).catch((error) => {
        this.options.onToast(`移除底图失败：${errorMessage(error)}`)
        return undefined
      })
      if (updated) {
        this.removingImageId = undefined
        this.expandedPkg = updated
        this.options.onToast('已移除底图，地点和笔记都还在')
        await this.reload()
        await this.options.onChanged(updated)
      }
      return
    }
    if (action === 'replace-tiles') {
      this.targetId = id
      this.tilesInput.click()
      return
    }
    if (action === 'attach-data') {
      this.targetId = id
      this.attachInput.click()
      return
    }
    if (action === 'open-image') {
      const pkg = this.expandedPkg?.id === id ? this.expandedPkg : await getLayerPackage(id)
      if (!pkg?.image) return
      const url = URL.createObjectURL(pkg.image)
      const win = window.open(url, '_blank')
      if (!win) this.options.onToast('浏览器拦截了新窗口')
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    }
  }

  private async reload(): Promise<void> {
    this.loading = true
    this.metas = await listLayerPackages()
    this.loading = false
    if (this.expandedId) {
      this.expandedPkg = await getLayerPackage(this.expandedId)
      if (!this.expandedPkg) {
        this.expandedId = undefined
      }
    }
    this.render()
  }

  private render(): void {
    this.revokeThumbUrls()
    this.listEl.replaceChildren()
    if (this.loading) {
      this.listEl.append(element('p', 'tml-empty-small', '正在读取地图包…'))
      return
    }
    if (this.metas.length === 0) {
      const empty = element('div', 'tml-packages-empty')
      empty.append(
        element('strong', undefined, '还没有地图包'),
        element(
          'p',
          undefined,
          '导入一个 .zip、文件夹，或只选一张底图先开始。',
        ),
      )
      const button = element('button', 'tml-btn tml-primary', '导入第一个地图包')
      button.type = 'button'
      button.dataset.packageAction = 'import'
      empty.append(button)
      this.listEl.append(empty)
      return
    }
    for (const meta of this.metas) this.listEl.append(this.renderRow(meta))
  }

  private renderRow(meta: LayerPackageMeta): HTMLElement {
    const row = element('article', 'tml-package-row')
    row.dataset.packageId = meta.id
    const head = element('div', 'tml-package-head')
    const thumb = element('div', 'tml-package-thumb')
    if (meta.thumbnail) {
      const url = URL.createObjectURL(meta.thumbnail)
      this.thumbUrls.push(url)
      const img = document.createElement('img')
      img.src = url
      img.alt = ''
      thumb.append(img)
    } else {
      thumb.append(icon(meta.kind === 'tiles' ? 'grid' : 'image'))
    }
    const info = element('div', 'tml-package-info')
    const titleRow = element('div', 'tml-package-title-row')
    if (this.renamingId === meta.id) {
      const input = document.createElement('input')
      input.type = 'text'
      input.value = meta.name
      input.className = 'tml-package-rename'
      input.dataset.packageRenameInput = 'true'
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          const button = row.querySelector<HTMLElement>('[data-package-action="rename-save"]')
          button?.click()
        } else if (event.key === 'Escape') {
          const button = row.querySelector<HTMLElement>('[data-package-action="rename-cancel"]')
          button?.click()
        }
      })
      titleRow.append(input)
    } else {
      titleRow.append(element('strong', 'tml-package-name', meta.name))
    }
    titleRow.append(element('span', 'tml-package-type', typeLabel(meta)))
    if (meta.missingAsset === 'image') {
      titleRow.append(element('span', 'tml-badge is-warning', '缺底图'))
    }
    if (meta.missingAsset === 'tiles') {
      titleRow.append(element('span', 'tml-badge is-warning', '缺瓦片'))
    }
    info.append(titleRow)
    const facts = element('div', 'tml-package-facts')
    const factText = [
      `${formatCount(meta.markerCount)} 地点`,
      meta.regionCount ? `${formatCount(meta.regionCount)} 区域` : '',
      `${formatCount(meta.categoryCount)} 分类`,
      formatBytes(meta.sizeBytes),
      `${formatCount(meta.fileCount)} 个文件`,
    ].filter(Boolean)
    facts.append(element('span', undefined, factText.join(' · ')))
    info.append(facts)
    if (meta.kind === 'tiles') {
      const tileText =
        meta.tileCount && meta.tileCount > 0
          ? `瓦片 ${formatCount(meta.tileCount)} 张${meta.tileZoomMin != null ? ` · z${meta.tileZoomMin}–z${meta.tileZoomMax}` : ''}${meta.missingTiles ? ` · 缺 ${formatCount(meta.missingTiles)}` : ''}`
          : meta.remoteTiles
            ? '在线瓦片'
            : '未关联瓦片'
      info.append(element('span', 'tml-package-asset', tileText))
    } else if (meta.hasImage) {
      info.append(
        element(
          'span',
          'tml-package-asset',
          `底图 ${meta.imageName || ''}${meta.imageWidth ? ` · ${formatCount(meta.imageWidth)}×${formatCount(meta.imageHeight ?? 0)}` : ''}`,
        ),
      )
    } else {
      info.append(element('span', 'tml-package-asset is-missing', '没有底图'))
    }
    const actions = element('div', 'tml-package-actions')
    const add = (label: string, action: string, primary = false): void => {
      const button = element('button', `tml-mini${primary ? ' tml-primary' : ''}`, label)
      button.type = 'button'
      button.dataset.packageAction = action
      actions.append(button)
    }
    add('打开', 'open', true)
    add(this.renamingId === meta.id ? '保存名称' : '重命名', this.renamingId === meta.id ? 'rename-save' : 'rename')
    if (this.renamingId === meta.id) add('取消', 'rename-cancel')
    add(meta.kind === 'tiles' ? '瓦片' : '底图', 'expand')
    add('删除', 'delete')
    head.append(thumb, info, actions)
    row.append(head)

    if (this.renamingId === meta.id) {
      row.append(
        element(
          'p',
          'tml-package-hint',
          '重命名只改显示名称，不会改变地图包 id、地点或聊天里的笔记。',
        ),
      )
    }
    if (this.deletingId === meta.id) {
      const confirm = element('div', 'tml-package-confirm')
      confirm.append(
        element(
          'span',
          undefined,
          '删除这个地图包和它的底图/瓦片？聊天里的笔记和链接不会被删除，但会暂时找不到对应地点。',
        ),
      )
      const actionsEl = element('div', 'tml-package-actions')
      const remove = element('button', 'tml-mini tml-danger-text', '确认删除')
      remove.type = 'button'
      remove.dataset.packageAction = 'delete-confirm'
      const cancel = element('button', 'tml-mini', '取消')
      cancel.type = 'button'
      cancel.dataset.packageAction = 'delete-cancel'
      actionsEl.append(remove, cancel)
      confirm.append(actionsEl)
      row.append(confirm)
    }
    if (this.expandedId === meta.id && this.expandedPkg) {
      row.append(this.renderAssetEditor(this.expandedPkg))
    }
    return row
  }

  private renderAssetEditor(pkg: LayerMapPackage): HTMLElement {
    const section = element('section', 'tml-package-editor')
    if (pkg.kind === 'tiles') {
      section.append(this.renderTileEditor(pkg))
    } else {
      section.append(this.renderImageEditor(pkg))
    }
    return section
  }

  private renderImageEditor(pkg: LayerMapPackage): HTMLElement {
    const wrap = element('div', 'tml-package-image-editor')
    if (pkg.image) {
      const row = element('div', 'tml-package-image-row')
      const thumb = element('div', 'tml-package-image-preview')
      const url = URL.createObjectURL(pkg.image)
      this.thumbUrls.push(url)
      const img = document.createElement('img')
      img.src = url
      img.alt = pkg.imageName || '当前底图'
      thumb.append(img)
      const body = element('div', 'tml-package-image-copy')
      body.append(element('strong', undefined, pkg.imageName || '当前底图'))
      const details = [
        pkg.imageWidth && pkg.imageHeight
          ? `${formatCount(pkg.imageWidth)}×${formatCount(pkg.imageHeight)}`
          : '',
        formatBytes(pkg.image.size),
        imageSourceLabel(pkg.imageSource),
        imageFitLabel(pkg.imageFit),
      ].filter(Boolean)
      body.append(element('span', 'tml-image-meta', details.join(' · ')))
      const actions = element('div', 'tml-package-actions')
      const replace = element('button', 'tml-mini', '更换底图')
      replace.type = 'button'
      replace.dataset.packageAction = 'replace-image'
      const view = element('button', 'tml-mini', '查看原图')
      view.type = 'button'
      view.dataset.packageAction = 'open-image'
      const remove = element('button', 'tml-mini tml-danger-text', '移除底图')
      remove.type = 'button'
      remove.dataset.packageAction = 'remove-image'
      actions.append(replace, view, remove)
      body.append(actions)
      row.append(thumb, body)
      wrap.append(row)
    } else {
      const empty = element('div', 'tml-package-image-empty')
      empty.append(
        element('strong', undefined, '这张地图还没有底图'),
        element('p', undefined, '可以选一张本地图片；地点和笔记不会受影响。'),
      )
      const button = element('button', 'tml-mini tml-primary', '选择底图')
      button.type = 'button'
      button.dataset.packageAction = 'replace-image'
      empty.append(button)
      wrap.append(empty)
    }
    if (this.removingImageId === pkg.id) {
      const confirm = element('div', 'tml-package-confirm')
      confirm.append(
        element('span', undefined, '移除底图后地点、链接和笔记都会保留，之后可以再补。'),
      )
      const actions = element('div', 'tml-package-actions')
      const remove = element('button', 'tml-mini tml-danger-text', '确认移除')
      remove.type = 'button'
      remove.dataset.packageAction = 'remove-image-confirm'
      const cancel = element('button', 'tml-mini', '取消')
      cancel.type = 'button'
      cancel.dataset.packageAction = 'remove-image-cancel'
      actions.append(remove, cancel)
      confirm.append(actions)
      wrap.append(confirm)
    }
    if (pkg.markers.length === 0 && pkg.source === 'manual') {
      const attach = element('div', 'tml-package-attach')
      attach.append(
        element('strong', undefined, '还没有地点数据'),
        element(
          'p',
          undefined,
          '可以关联一个 Fandom map.json 或地图包；底图会保留，地点会合并进来。',
        ),
      )
      const button = element('button', 'tml-mini', '关联 Fandom JSON / 地图包')
      button.type = 'button'
      button.dataset.packageAction = 'attach-data'
      attach.append(button)
      wrap.append(attach)
    }
    return wrap
  }

  private renderTileEditor(pkg: LayerMapPackage): HTMLElement {
    const wrap = element('div', 'tml-package-tile-editor')
    const stats = pkg.tile
    const text = stats
      ? `${Object.keys(pkg.tileFiles ?? {}).length.toLocaleString('zh-CN')} 张瓦片 · 层级 ${stats.coverageMinZoom ?? stats.minZoom}–${stats.coverageMaxZoom ?? stats.maxZoom}${stats.missingCount ? ` · 缺 ${stats.missingCount.toLocaleString('zh-CN')}` : ''}`
      : '还没有瓦片'
    wrap.append(element('p', 'tml-image-meta', text))
    const actions = element('div', 'tml-package-actions')
    const replace = element('button', 'tml-mini tml-primary', '重新选择瓦片文件夹')
    replace.type = 'button'
    replace.dataset.packageAction = 'replace-tiles'
    actions.append(replace)
    wrap.append(actions)
    if (stats) {
      const field = element('label', 'tml-field')
      field.append(element('span', undefined, '瓦片 URL 模板（本地瓦片可留空）'))
      const input = document.createElement('input')
      input.type = 'text'
      input.value = stats.template
      input.placeholder = 'http://127.0.0.1:8000/{z}/{y}/{x}.jpg'
      input.addEventListener('change', () => {
        const value = input.value.trim()
        if (
          value &&
          (!/\{z\}/.test(value) || !/\{x\}/.test(value) || !/\{y\}/.test(value))
        ) {
          this.options.onToast('瓦片模板必须同时包含 {z}、{x}、{y}')
          input.value = stats.template
          return
        }
        void updateLayerPackage(pkg.id, {
          tile: { ...stats, template: value },
        }).then(async (updated) => {
          if (updated) {
            this.expandedPkg = updated
            this.options.onToast('瓦片 URL 模板已保存')
            await this.reload()
            await this.options.onChanged(updated)
          }
        })
      })
      field.append(input)
      wrap.append(field)
    }
    return wrap
  }

  private async replaceImage(id: string, file: File): Promise<void> {
    const pkg = await getLayerPackage(id)
    if (!pkg) return
    try {
      const info = await readLayerImage(file, file.name)
      const thumbnail = await makeLayerThumbnail(file)
      const imageOnly = pkg.kind === 'image' && pkg.markers.length === 0 && pkg.source === 'manual'
      const updated = await setLayerImage(id, {
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
        this.expandedPkg = updated
        this.options.onToast('底图已更换')
        await this.reload()
        await this.options.onChanged(updated)
      }
    } catch (error) {
      this.options.onToast(`更换底图失败：${errorMessage(error)}`)
    }
  }

  private async replaceTiles(id: string, files: File[]): Promise<void> {
    const pkg = await getLayerPackage(id)
    if (!pkg) return
    const tileSet = tileSetFor(pkg)
    if (!tileSet) {
      this.options.onToast('这个地图包缺少瓦片配置。')
      return
    }
    try {
      const bundle = filesToBundle(files, pkg.name)
      const scan = scanTileFiles(bundle.files, tileSet, pkg.tile?.setCount ?? 1)
      if (!scan.tileFiles || Object.keys(scan.tileFiles).length === 0) {
        this.options.onToast('这个文件夹里没有找到 z/x/y 结构的瓦片。')
        return
      }
      const tile: LayerTileConfig = {
        ...(pkg.tile as LayerTileConfig),
        order: scan.order,
        coverageMinZoom: scan.stats?.minZoom,
        coverageMaxZoom: scan.stats?.maxZoom,
        expectedCount: scan.stats?.expected,
        missingCount: scan.stats?.missing,
      }
      const updated = await setLayerTiles(id, scan.tileFiles, tile)
      if (updated) {
        this.expandedPkg = updated
        this.options.onToast(`已关联 ${Object.keys(scan.tileFiles).length.toLocaleString('zh-CN')} 张瓦片`)
        await this.reload()
        await this.options.onChanged(updated)
      }
    } catch (error) {
      this.options.onToast(`关联瓦片失败：${errorMessage(error)}`)
    }
  }

  private async attachData(id: string, file: File): Promise<void> {
    const pkg = await getLayerPackage(id)
    if (!pkg) return
    if (pkg.markers.length > 0) {
      this.options.onToast('这个地图包已经地点数据；请用重新导入同一个包来更新。')
      return
    }
    try {
      let bundle: LayerSourceBundle
      if (/\.zip$/i.test(file.name)) {
        bundle = await zipToBundle(file)
      } else {
        bundle = filesToBundle([file], file.name.replace(/\.[^.]+$/, ''))
      }
      const preview = await analyzeBundle(bundle)
      if (preview.pkg.kind !== 'image' || preview.pkg.markers.length === 0) {
        this.options.onToast('这不是可贴到图片底图上的 Fandom 地点数据。')
        return
      }
      const updated = await updateLayerPackage(id, {
        name: pkg.nameLocked ? pkg.name : preview.pkg.name,
        source: preview.pkg.source,
        sourceKey: preview.pkg.sourceKey,
        sourceUrl: preview.pkg.sourceUrl,
        wikiBase: preview.pkg.wikiBase,
        imagePageUrl: preview.pkg.imagePageUrl,
        width: preview.pkg.width,
        height: preview.pkg.height,
        categories: preview.pkg.categories,
        groups: preview.pkg.groups,
        markers: preview.pkg.markers,
        regions: preview.pkg.regions,
        dataBytes: preview.pkg.dataBytes,
        attribution: preview.pkg.attribution,
        imageFit: 'stretch',
        imageRect: undefined,
      })
      if (updated) {
        this.expandedPkg = updated
        this.options.onToast(
          `已关联 ${updated.markers.length.toLocaleString('zh-CN')} 个地点`,
        )
        await this.reload()
        await this.options.onChanged(updated)
      }
    } catch (error) {
      this.options.onToast(`关联数据失败：${errorMessage(error)}`)
    }
  }

  private revokeThumbUrls(): void {
    for (const url of this.thumbUrls) URL.revokeObjectURL(url)
    this.thumbUrls = []
  }
}

function icon(name: 'image' | 'grid'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.6')
  svg.setAttribute('aria-hidden', 'true')
  const paths =
    name === 'grid'
      ? ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h6v6h-6z']
      : [
          'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z',
          'M8.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
          'm4 16 4.5-4.5 3.5 3.5 3-3L20 17',
        ]
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}
