export async function fetchJson<T = unknown>(input: URL | string, init?: RequestInit, timeoutMs = 15000): Promise<T> {
  const res = await fetchWithTimeout(input, init, timeoutMs)
  return (await res.json()) as T
}

export async function fetchText(input: URL | string, init?: RequestInit, timeoutMs = 15000): Promise<string> {
  const res = await fetchWithTimeout(input, init, timeoutMs)
  return await res.text()
}

async function fetchWithTimeout(input: URL | string, init?: RequestInit, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(input, { ...init, signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res
  } finally {
    window.clearTimeout(timer)
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return '请求超时'
    return error.message
  }
  return String(error)
}
