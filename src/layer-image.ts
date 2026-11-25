import type {
  LayerImageFit,
  LayerImageRect,
  LayerImageSource,
  LayerMapPackage,
} from './layer-types'

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif'])
const PLACEHOLDER_PATTERN = /(placeholder|blank|dummy|template|sample|占位)/i

export type LayerImageInfo = {
  width: number
  height: number
  bytes: number
  type: string
  placeholder: boolean
}

export function imageExtension(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? ''
}

export function isSupportedImageName(name: string): boolean {
  return IMAGE_EXTENSIONS.has(imageExtension(name))
}

export function normalizeImageName(name: string): string {
  let decoded = name
  try {
    decoded = decodeURIComponent(name)
  } catch {
    // Keep the raw name when it is not valid URI encoding.
  }
  return decoded
    .split('/')
    .pop()
    ?.toLowerCase()
    .replace(/[_\s-]+/g, '-')
    .trim() ?? ''
}

export function isPlaceholderName(name: string): boolean {
  return PLACEHOLDER_PATTERN.test(name)
}

function probeWithImageElement(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.onload = () => {
      const result = { width: image.naturalWidth, height: image.naturalHeight }
      URL.revokeObjectURL(url)
      if (!result.width || !result.height) reject(new Error('图片尺寸为 0'))
      else resolve(result)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片无法解码，可能已损坏或格式不受支持'))
    }
    image.src = url
  })
}

export async function readLayerImage(blob: Blob, name: string): Promise<LayerImageInfo> {
  const extension = imageExtension(name)
  if (!IMAGE_EXTENSIONS.has(extension) && !/^image\/(png|jpe?g|webp|avif|gif)$/i.test(blob.type)) {
    throw new Error('请选择 PNG / JPG / WebP / AVIF 图片')
  }
  let size: { width: number; height: number }
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(
      () => undefined,
    )
    if (bitmap) {
      size = { width: bitmap.width, height: bitmap.height }
      bitmap.close()
    } else {
      size = await probeWithImageElement(blob)
    }
  } else {
    size = await probeWithImageElement(blob)
  }
  return {
    width: size.width,
    height: size.height,
    bytes: blob.size,
    type: blob.type || `image/${extension === 'jpg' ? 'jpeg' : extension}`,
    placeholder: isPlaceholderName(name),
  }
}

export async function makeLayerThumbnail(
  blob: Blob,
  maxSide = 180,
): Promise<Blob | undefined> {
  try {
    const bitmap = await createImageBitmap(blob)
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) {
      bitmap.close()
      return undefined
    }
    context.fillStyle = '#0c1116'
    context.fillRect(0, 0, width, height)
    context.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    return await new Promise<Blob | undefined>((resolve) => {
      canvas.toBlob((result) => resolve(result ?? undefined), 'image/jpeg', 0.72)
    })
  } catch {
    return undefined
  }
}

function validRect(rect: LayerImageRect | undefined): LayerImageRect | undefined {
  if (!rect) return undefined
  if (
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.w) ||
    !Number.isFinite(rect.h) ||
    rect.w <= 0 ||
    rect.h <= 0
  ) {
    return undefined
  }
  return rect
}

export function imageRectFor(pkg: LayerMapPackage): LayerImageRect {
  if (pkg.imageFit === 'custom') {
    return validRect(pkg.imageRect) ?? { x: 0, y: 0, w: 1, h: 1 }
  }
  if (
    pkg.imageFit === 'contain' &&
    pkg.imageWidth &&
    pkg.imageHeight &&
    pkg.width > 0 &&
    pkg.height > 0
  ) {
    const imageAspect = pkg.imageWidth / pkg.imageHeight
    const canvasAspect = pkg.width / pkg.height
    if (imageAspect > canvasAspect) {
      const height = canvasAspect / imageAspect
      return { x: 0, y: (1 - height) / 2, w: 1, h: height }
    }
    const width = imageAspect / canvasAspect
    return { x: (1 - width) / 2, y: 0, w: width, h: 1 }
  }
  return { x: 0, y: 0, w: 1, h: 1 }
}

export function imageFitLabel(fit: LayerImageFit | undefined): string {
  if (fit === 'contain') return '保持比例'
  if (fit === 'custom') return '手动对齐'
  return '铺满地图'
}

export function imageSourceLabel(source: LayerImageSource | undefined): string {
  if (source === 'fandom-url') return 'Fandom 原图'
  if (source === 'local') return '本地图片'
  if (source === 'package') return '包内图片'
  if (source === 'none') return '未设置'
  return '本地图片'
}

export function imageAspectNote(pkg: LayerMapPackage): string | undefined {
  if (!pkg.imageWidth || !pkg.imageHeight || !pkg.width || !pkg.height) return undefined
  const imageAspect = pkg.imageWidth / pkg.imageHeight
  const canvasAspect = pkg.width / pkg.height
  const difference = Math.abs(imageAspect - canvasAspect) / canvasAspect
  if (difference < 0.02) return undefined
  return `图片比例与画布相差约 ${(difference * 100).toFixed(1)}%`
}

export function imageResolutionNote(pkg: LayerMapPackage): string | undefined {
  if (!pkg.imageWidth || !pkg.width) return undefined
  if (pkg.imageWidth >= pkg.width * 0.5) return undefined
  return `图片比画布小很多，放大后可能模糊`
}

export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes < 1) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** index
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

export function formatCount(value: number | undefined): string {
  return (value ?? 0).toLocaleString('zh-CN')
}

export function sanitizeRect(rect: LayerImageRect): LayerImageRect {
  return {
    x: Math.max(-2, Math.min(2, rect.x)),
    y: Math.max(-2, Math.min(2, rect.y)),
    w: Math.max(0.05, Math.min(6, rect.w)),
    h: Math.max(0.05, Math.min(6, rect.h)),
  }
}
