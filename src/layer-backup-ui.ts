/**
 * Export panel inside a package row, and the part labels shared with the
 * import preview. Counting and packing live in layer-backup; this file only
 * shows the numbers and collects the ticks.
 */
import { errorMessage } from './http'
import {
  BACKUP_DEFAULT_PARTS,
  BACKUP_PARTS,
  backupFileName,
  buildBackupZip,
  collectBackupPersonal,
  countBackupParts,
  type BackupChatSource,
  type BackupPart,
  type BackupPersonal,
} from './layer-backup'
import { formatBytes, formatCount } from './layer-image'
import { getLayerPackage } from './layer-store'
import type { LayerMapPackage } from './layer-types'

export const BACKUP_PART_LABELS: Record<BackupPart, { label: string; hint: string; unit: string }> = {
  notes: { label: '笔记', hint: '地点、区域、道路笔记', unit: '条' },
  materials: { label: '改过的资料', hint: '改过的来源资料、手动添加的链接、已抓取的 Wiki 正文', unit: '项' },
  pins: { label: '图钉', hint: '移动过的位置、自定义图钉和撤销记录', unit: '个' },
  ai: { label: '“给 AI”勾选', hint: '地点、区域、道路的单独勾选', unit: '处' },
  favorites: { label: '收藏', hint: '这张地图里收藏的地点', unit: '个' },
  chat: { label: '当前聊天的“我”、视角和行程', hint: '这些按聊天保存，默认不带', unit: '项' },
}

export function backupCountsText(counts: Record<BackupPart, number>): string {
  return BACKUP_PARTS.filter((part) => counts[part] > 0)
    .map((part) => `${BACKUP_PART_LABELS[part].label} ${formatCount(counts[part])}`)
    .join(' · ')
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function packageBytes(pkg: LayerMapPackage): number {
  let total = 0
  const walk = (value: unknown): void => {
    if (value instanceof Blob) total += value.size
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') Object.values(value).forEach(walk)
  }
  walk(pkg)
  return total + (pkg.dataBytes ?? 0)
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.style.display = 'none'
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export type LayerExportPanelHost = {
  /** The current chat's per-package data (links, position, view, itinerary). */
  chatData: (packageId: string) => BackupChatSource
  rerender: () => void
  toast: (message: string) => void
}

export class LayerExportPanel {
  private host: LayerExportPanelHost
  private packageId?: string
  private pkg?: LayerMapPackage
  private personal?: BackupPersonal
  private counts?: Record<BackupPart, number>
  private parts = new Set<BackupPart>()
  private abort?: AbortController
  private progressEl?: HTMLElement

  constructor(host: LayerExportPanelHost) {
    this.host = host
  }

  isOpenFor(id: string): boolean {
    return this.packageId === id
  }

  async toggle(id: string): Promise<void> {
    if (this.packageId === id) {
      this.close()
      this.host.rerender()
      return
    }
    this.close()
    const pkg = await getLayerPackage(id)
    if (!pkg) {
      this.host.toast('这个地图包已经不存在。')
      return
    }
    this.packageId = id
    this.pkg = pkg
    this.personal = collectBackupPersonal(pkg, this.host.chatData(id))
    this.counts = countBackupParts(this.personal)
    this.parts = new Set(BACKUP_DEFAULT_PARTS.filter((part) => (this.counts?.[part] ?? 0) > 0))
    this.host.rerender()
  }

  close(): void {
    this.abort?.abort()
    this.abort = undefined
    this.packageId = undefined
    this.pkg = undefined
    this.personal = undefined
    this.counts = undefined
    this.progressEl = undefined
  }

  render(): HTMLElement {
    const pkg = this.pkg as LayerMapPackage
    const counts = this.counts as Record<BackupPart, number>
    const busy = Boolean(this.abort)
    const panel = element('div', 'tml-package-editor tml-export-panel')
    panel.append(element('strong', 'tml-export-title', '导出地图包'))
    const body = [
      `地点 ${formatCount(pkg.markers.length)}`,
      pkg.regions.length ? `区域 ${formatCount(pkg.regions.length)}` : '',
      pkg.streets?.length ? `道路 ${formatCount(pkg.streets.length)}` : '',
      pkg.tileFiles ? `瓦片 ${formatCount(Object.keys(pkg.tileFiles).length)}` : '',
      pkg.image ? '底图 1' : '',
    ].filter(Boolean)
    panel.append(
      element('p', 'tml-package-hint', `地图本体（总会带上）：${body.join(' · ')} · 约 ${formatBytes(packageBytes(pkg))}`),
      element('p', 'tml-package-hint', '名称、网格校准与距离换算、底图对齐都在地图本体里。'),
      element('span', 'tml-export-subhead', '一起带上的个人修改：'),
    )
    const list = element('div', 'tml-export-parts')
    for (const part of BACKUP_PARTS) {
      const info = BACKUP_PART_LABELS[part]
      const count = counts[part]
      const label = element('label', `tml-export-part${count === 0 ? ' is-empty' : ''}`)
      const checkbox = element('input')
      checkbox.type = 'checkbox'
      checkbox.checked = count > 0 && this.parts.has(part)
      checkbox.disabled = count === 0 || busy
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) this.parts.add(part)
        else this.parts.delete(part)
      })
      label.append(
        checkbox,
        element('span', 'tml-export-part-name', info.label),
        element('span', 'tml-export-part-hint', info.hint),
        element('span', 'tml-export-part-count', count > 0 ? `${formatCount(count)} ${info.unit}` : '没有'),
      )
      list.append(label)
    }
    panel.append(list)
    this.progressEl = element('p', 'tml-package-hint tml-export-progress', busy ? '正在打包…' : '')
    this.progressEl.hidden = !busy
    panel.append(this.progressEl)
    const actions = element('div', 'tml-package-actions tml-export-actions')
    const cancel = element('button', 'tml-mini', busy ? '取消导出' : '取消')
    cancel.type = 'button'
    cancel.addEventListener('click', () => {
      if (this.abort) {
        this.abort.abort()
        return
      }
      this.close()
      this.host.rerender()
    })
    const run = element('button', 'tml-mini tml-primary', '导出 .zip')
    run.type = 'button'
    run.disabled = busy
    run.addEventListener('click', () => void this.run())
    actions.append(cancel, run)
    panel.append(actions)
    return panel
  }

  private async run(): Promise<void> {
    if (!this.pkg || !this.personal || this.abort) return
    const pkg = this.pkg
    const abort = new AbortController()
    this.abort = abort
    this.host.rerender()
    let lastPaint = 0
    try {
      const parts = BACKUP_PARTS.filter((part) => this.parts.has(part))
      const zip = await buildBackupZip(pkg, this.personal, parts, {
        signal: abort.signal,
        onProgress: (done, total) => {
          const now = performance.now()
          if (done < total && now - lastPaint < 120) return
          lastPaint = now
          if (this.progressEl) this.progressEl.textContent = `正在打包 ${formatCount(done)} / ${formatCount(total)} 个文件`
        },
      })
      download(zip, backupFileName(pkg))
      this.host.toast(`已导出 ${backupFileName(pkg)}（${formatBytes(zip.size)}）`)
      this.abort = undefined
      this.close()
    } catch (error) {
      this.abort = undefined
      if (abort.signal.aborted) this.host.toast('已取消导出')
      else this.host.toast(`导出失败：${errorMessage(error)}`)
    }
    this.host.rerender()
  }
}
