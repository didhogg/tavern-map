import { errorMessage, fetchJson } from './http'
import type { WikiCandidate, WikiPage } from './types'

function api(lang: string): string {
  return `https://${lang}.wikipedia.org/w/api.php`
}

/**
 * Query geosearch in every selected language and merge the results.
 * The same physical place can have different page IDs per wiki, so the
 * candidate key is `${lang}:${pageId}`, not pageId alone.
 */
export async function wikiNearby(
  lat: number,
  lng: number,
  radiusM: number,
  langs: string[],
): Promise<WikiCandidate[]> {
  const unique = Array.from(new Set(langs)).filter(Boolean)
  if (unique.length === 0) return []

  const results = await Promise.allSettled(
    unique.map(async (lang) => {
      try {
        return await wikiNearbyOne(lat, lng, radiusM, lang)
      } catch (error) {
        console.warn(`[tavern-map] Wikipedia ${lang} geosearch failed`, error)
        throw error
      }
    }),
  )

  // Keep each language represented instead of letting the closest wiki fill
  // the whole merged list.
  const candidates = results.flatMap((result) =>
    result.status === 'fulfilled' ? result.value.slice(0, 10) : [],
  )
  if (candidates.length === 0) {
    const firstFailure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (firstFailure) throw new Error(`Wikipedia 请求失败：${errorMessage(firstFailure.reason)}`)
  }
  return dedupeCandidates(candidates).slice(0, 30)
}

async function wikiNearbyOne(
  lat: number,
  lng: number,
  radiusM: number,
  lang: string,
): Promise<WikiCandidate[]> {
  const url = new URL(api(lang))
  url.search = new URLSearchParams({
    action: 'query',
    format: 'json',
    origin: '*',
    list: 'geosearch',
    gscoord: `${lat}|${lng}`,
    gsradius: String(Math.min(10000, Math.max(100, Math.round(radiusM)))),
    gslimit: '20',
  }).toString()
  const data = await fetchJson<{
    query?: { geosearch?: Array<{ pageid: number; title: string; dist: number }> }
  }>(url)
  return (data.query?.geosearch ?? []).map((item) => ({
    pageId: item.pageid,
    title: item.title,
    dist: item.dist,
    lang,
  }))
}

function dedupeCandidates(candidates: WikiCandidate[]): WikiCandidate[] {
  const seen = new Set<string>()
  return candidates
    .filter((candidate) => {
      const key = `${candidate.lang}:${candidate.pageId}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => a.dist - b.dist)
}

type WikiPageResponse = {
  query?: {
    pages?: Record<
      string,
      {
        pageid?: number
        title?: string
        missing?: string
        extract?: string
        pageprops?: { disambiguation?: string }
        revisions?: Array<{ revid?: number }>
      }
    >
  }
}

export async function wikiPage(candidate: WikiCandidate): Promise<WikiPage> {
  const lang = candidate.lang
  const url = new URL(api(lang))
  url.search = new URLSearchParams({
    action: 'query',
    format: 'json',
    origin: '*',
    prop: 'extracts|pageprops|revisions',
    explaintext: '1',
    exintro: '1',
    exchars: '1200',
    redirects: '1',
    titles: candidate.title,
    rvprop: 'ids',
  }).toString()
  const data = await fetchJson<WikiPageResponse>(url)
  const page = Object.values(data.query?.pages ?? {})[0]
  if (!page || page.missing !== undefined || page.pageprops?.disambiguation !== undefined) {
    throw new Error('该条目不存在，或是一个消歧义页')
  }
  const pageId = page.pageid ?? candidate.pageId
  return {
    pageId,
    title: page.title ?? candidate.title,
    extract: page.extract ?? '',
    url: `https://${lang}.wikipedia.org/?curid=${pageId}`,
    lang,
    fetchedAt: Date.now(),
    revId: page.revisions?.[0]?.revid,
  }
}
