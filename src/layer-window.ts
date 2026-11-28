export type LayerWindowRect = {
  left: number
  top: number
  width: number
  height: number
}

type LayerWindowOptions = {
  storageKey: string
  defaultWidth?: number
  defaultHeight?: number
  minWidth?: number
  minHeight?: number
  compactWidth?: number
  margin?: number
}

export const MAP_WINDOW_STORAGE_KEY = 'tavern-map:layer-window:v1'

const MOBILE_QUERY = '(max-width: 640px)'

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export class LayerWindowController {
  private readonly panel: HTMLElement
  private readonly header: HTMLElement
  private readonly options: Required<LayerWindowOptions>
  private readonly resizeObserver: ResizeObserver
  private readonly mobileQuery = window.matchMedia(MOBILE_QUERY)
  private rect: LayerWindowRect | null = null
  private drag:
    | {
        pointerId: number
        startX: number
        startY: number
        rect: LayerWindowRect
        mode: 'move' | 'resize'
        edge: string
      }
    | undefined
  private saved = false

  private readonly onHeaderPointerDown = (event: PointerEvent): void => {
    if (this.mobileQuery.matches || event.button !== 0) return
    const target = event.target as HTMLElement | null
    if (target?.closest('button, input, select, textarea, a, [data-no-window-drag]')) return
    this.startDrag(event, 'move', '')
  }

  private readonly onDoubleClick = (event: MouseEvent): void => {
    if (this.mobileQuery.matches) return
    const target = event.target as HTMLElement | null
    if (target?.closest('button, input, select, textarea, a, [data-no-window-drag]')) return
    this.reset()
  }

  private readonly onResizePointerDown = (event: PointerEvent): void => {
    if (this.mobileQuery.matches || event.button !== 0) return
    const target = event.currentTarget as HTMLElement
    const edge = target.dataset.resize ?? 'se'
    event.preventDefault()
    event.stopPropagation()
    this.startDrag(event, 'resize', edge)
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag
    if (!drag || event.pointerId !== drag.pointerId) return
    event.preventDefault()
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (drag.mode === 'move') {
      this.rect = this.clampRect({
        ...drag.rect,
        left: drag.rect.left + dx,
        top: drag.rect.top + dy,
      })
    } else {
      this.rect = this.resizeRect(drag.rect, drag.edge, dx, dy)
    }
    this.applyRect(this.rect)
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    const drag = this.drag
    if (!drag || event.pointerId !== drag.pointerId) return
    this.drag = undefined
    this.panel.classList.remove('tml-dragging')
    this.panel.classList.remove('tml-resizing')
    this.save()
    if (this.header.hasPointerCapture(event.pointerId)) {
      this.header.releasePointerCapture(event.pointerId)
    }
  }

  private readonly onWindowResize = (): void => {
    if (this.mobileQuery.matches) {
      this.applyMobile()
      return
    }
    if (!this.rect) this.rect = this.defaultRect()
    this.rect = this.clampRect(this.rect)
    this.applyRect(this.rect)
    this.updateCompact()
  }

  constructor(panel: HTMLElement, header: HTMLElement, options: LayerWindowOptions) {
    this.panel = panel
    this.header = header
    this.options = {
      storageKey: options.storageKey,
      defaultWidth: options.defaultWidth ?? 1280,
      defaultHeight: options.defaultHeight ?? 860,
      minWidth: options.minWidth ?? 560,
      minHeight: options.minHeight ?? 380,
      compactWidth: options.compactWidth ?? 820,
      margin: options.margin ?? 12,
    }
    this.resizeObserver = new ResizeObserver(() => this.updateCompact())
    this.header.addEventListener('pointerdown', this.onHeaderPointerDown)
    this.header.addEventListener('dblclick', this.onDoubleClick)
    for (const handle of this.panel.querySelectorAll<HTMLElement>('[data-resize]')) {
      handle.addEventListener('pointerdown', this.onResizePointerDown)
    }
    document.addEventListener('pointermove', this.onPointerMove)
    document.addEventListener('pointerup', this.onPointerUp)
    document.addEventListener('pointercancel', this.onPointerUp)
    window.addEventListener('resize', this.onWindowResize)
    this.mobileQuery.addEventListener('change', this.onWindowResize)
    this.resizeObserver.observe(this.panel)
  }

  open(): void {
    if (this.mobileQuery.matches) {
      this.applyMobile()
    } else {
      this.rect = this.readSaved() ?? this.defaultRect()
      this.rect = this.clampRect(this.rect)
      this.applyRect(this.rect)
      this.saved = true
    }
    this.updateCompact()
  }

  reset(): void {
    if (this.mobileQuery.matches) return
    this.rect = this.defaultRect()
    this.applyRect(this.rect)
    this.save()
  }

  isCompact(): boolean {
    return this.mobileQuery.matches || this.panel.clientWidth < this.options.compactWidth
  }

  dispose(): void {
    this.header.removeEventListener('pointerdown', this.onHeaderPointerDown)
    this.header.removeEventListener('dblclick', this.onDoubleClick)
    for (const handle of this.panel.querySelectorAll<HTMLElement>('[data-resize]')) {
      handle.removeEventListener('pointerdown', this.onResizePointerDown)
    }
    document.removeEventListener('pointermove', this.onPointerMove)
    document.removeEventListener('pointerup', this.onPointerUp)
    document.removeEventListener('pointercancel', this.onPointerUp)
    window.removeEventListener('resize', this.onWindowResize)
    this.mobileQuery.removeEventListener('change', this.onWindowResize)
    this.resizeObserver.disconnect()
  }

  private startDrag(event: PointerEvent, mode: 'move' | 'resize', edge: string): void {
    const rect = this.panel.getBoundingClientRect()
    this.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      mode,
      edge,
    }
    this.header.setPointerCapture(event.pointerId)
    this.panel.classList.add(mode === 'move' ? 'tml-dragging' : 'tml-resizing')
  }

  private resizeRect(rect: LayerWindowRect, edge: string, dx: number, dy: number): LayerWindowRect {
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const margin = this.options.margin
    const maxWidth = viewportWidth - margin * 2
    const maxHeight = viewportHeight - margin * 2
    const minWidth = Math.min(this.options.minWidth, maxWidth)
    const minHeight = Math.min(this.options.minHeight, maxHeight)
    let { left, top, width, height } = rect
    if (edge.includes('e')) width = rect.width + dx
    if (edge.includes('s')) height = rect.height + dy
    if (edge.includes('w')) {
      width = rect.width - dx
      left = rect.left + dx
    }
    if (edge.includes('n')) {
      height = rect.height - dy
      top = rect.top + dy
    }
    width = clamp(width, minWidth, maxWidth)
    height = clamp(height, minHeight, maxHeight)
    if (edge.includes('w')) left = rect.left + rect.width - width
    if (edge.includes('n')) top = rect.top + rect.height - height
    return this.clampRect({ left, top, width, height })
  }

  private clampRect(rect: LayerWindowRect): LayerWindowRect {
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const margin = this.options.margin
    const maxWidth = Math.max(1, viewportWidth - margin * 2)
    const maxHeight = Math.max(1, viewportHeight - margin * 2)
    const width = clamp(rect.width, Math.min(this.options.minWidth, maxWidth), maxWidth)
    const height = clamp(rect.height, Math.min(this.options.minHeight, maxHeight), maxHeight)
    return {
      width,
      height,
      left: clamp(rect.left, margin, Math.max(margin, viewportWidth - width - margin)),
      top: clamp(rect.top, margin, Math.max(margin, viewportHeight - height - margin)),
    }
  }

  private defaultRect(): LayerWindowRect {
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const margin = this.options.margin
    const width = Math.max(
      Math.min(this.options.minWidth, viewportWidth - margin * 2),
      Math.min(this.options.defaultWidth, viewportWidth - margin * 2),
    )
    const height = Math.max(
      Math.min(this.options.minHeight, viewportHeight - margin * 2),
      Math.min(this.options.defaultHeight, viewportHeight - margin * 2),
    )
    return {
      left: Math.max(margin, (viewportWidth - width) / 2),
      top: Math.max(margin, (viewportHeight - height) / 2),
      width,
      height,
    }
  }

  private applyRect(rect: LayerWindowRect): void {
    this.panel.classList.remove('tml-mobile')
    this.panel.dataset.positioned = 'true'
    this.panel.style.left = `${Math.round(rect.left)}px`
    this.panel.style.top = `${Math.round(rect.top)}px`
    this.panel.style.width = `${Math.round(rect.width)}px`
    this.panel.style.height = `${Math.round(rect.height)}px`
    this.panel.style.right = 'auto'
    this.panel.style.bottom = 'auto'
    this.panel.style.transform = 'none'
  }

  private applyMobile(): void {
    this.panel.classList.add('tml-mobile')
    this.panel.dataset.positioned = 'false'
    // SillyTavern's mobile body is fixed with a zero-height containing block,
    // so `inset: 0` can collapse fixed children. Write explicit dimensions.
    this.panel.style.left = '0px'
    this.panel.style.top = '0px'
    this.panel.style.width = `${Math.max(1, window.innerWidth)}px`
    this.panel.style.height = `${Math.max(1, window.innerHeight)}px`
    this.panel.style.right = 'auto'
    this.panel.style.bottom = 'auto'
    this.panel.style.transform = 'none'
    this.updateCompact()
  }

  private updateCompact(): void {
    this.panel.classList.toggle('tml-compact', this.isCompact())
  }

  private readSaved(): LayerWindowRect | null {
    try {
      const raw = localStorage.getItem(this.options.storageKey)
      if (!raw) return null
      const value = JSON.parse(raw) as Partial<LayerWindowRect>
      if (
        typeof value.left !== 'number' ||
        typeof value.top !== 'number' ||
        typeof value.width !== 'number' ||
        typeof value.height !== 'number' ||
        !Number.isFinite(value.left) ||
        !Number.isFinite(value.top) ||
        !Number.isFinite(value.width) ||
        !Number.isFinite(value.height)
      ) {
        return null
      }
      return {
        left: value.left,
        top: value.top,
        width: value.width,
        height: value.height,
      }
    } catch {
      return null
    }
  }

  private save(): void {
    if (this.mobileQuery.matches || !this.rect || !this.saved) return
    try {
      localStorage.setItem(this.options.storageKey, JSON.stringify(this.rect))
    } catch {
      // Window geometry is a convenience; storage failures are non-fatal.
    }
  }
}
