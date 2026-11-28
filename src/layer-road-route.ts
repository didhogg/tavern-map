import { segmentDistance, type Pt } from './layer-polyline'
import { buildRoadIndex, nearestSegment, type RoadHit, type RoadIndex } from './layer-roads'
import type { LayerStreet } from './layer-types'

/**
 * Road network for itinerary legs that follow roads.
 *
 * Every road vertex is a node; vertices at the same spot join, and a road end
 * that stops right next to another road (a T-junction without a shared
 * vertex) is joined to that road. A route walks straight from the start to the
 * nearest road, follows the shortest way along the roads, and walks straight
 * from the road point nearest the end. When the two roads are not connected,
 * the reachable road parts are used and the smallest gap between them is
 * walked straight.
 */

type Edge = { to: number; length: number; street: number }

export type RoadGraph = {
  /** Index over the roads with junction points inserted; same order as the source streets. */
  index: RoadIndex
  yScale: number
  /** Node id of each vertex of each indexed road. */
  vertexNodes: number[][]
  nodeX: number[]
  nodeY: number[]
  adjacency: Edge[][]
}

export type RoadRoutePiece =
  | { kind: 'road'; street: number; points: Pt[] }
  | { kind: 'straight'; points: Pt[] }

export function buildRoadGraph(streets: LayerStreet[], yScale = 1): RoadGraph {
  const base = buildRoadIndex(streets, yScale)
  const tolerance = base.cell * 0.05
  const splits = new Map<string, Array<{ t: number; x: number; y: number }>>()
  const connectors: Array<{ a: Pt; b: Pt; street: number; length: number }> = []
  streets.forEach((street, streetIndex) => {
    const points = street.points
    if (points.length < 2) return
    for (const [x, y] of [points[0], points[points.length - 1]]) {
      const hit = nearestSegment(base, x, y, tolerance, (other) => other === streetIndex)
      if (!hit) continue
      const target = streets[hit.streetIndex].points
      let b: Pt
      if (hit.t > 1e-6 && hit.t < 1 - 1e-6) {
        const key = `${hit.streetIndex}:${hit.segment}`
        const list = splits.get(key) ?? []
        list.push({ t: hit.t, x: hit.x, y: hit.y })
        splits.set(key, list)
        b = { x: hit.x, y: hit.y }
      } else {
        const [vx, vy] = target[hit.t <= 1e-6 ? hit.segment - 1 : hit.segment]
        b = { x: vx, y: vy }
      }
      connectors.push({ a: { x, y }, b, street: streetIndex, length: hit.distance })
    }
  })
  const augmented: LayerStreet[] = streets.map((street, streetIndex) => {
    if (street.points.length < 2) return street
    const points: Array<[number, number]> = [street.points[0]]
    for (let segment = 1; segment < street.points.length; segment += 1) {
      const list = splits.get(`${streetIndex}:${segment}`)
      if (list) for (const item of list.sort((a, b) => a.t - b.t)) points.push([item.x, item.y])
      points.push(street.points[segment])
    }
    return { ...street, points }
  })
  const index = buildRoadIndex(augmented, yScale)
  const quantum = Math.max(1e-12, base.cell * 1e-4)
  const nodes = new Map<string, number>()
  const nodeX: number[] = []
  const nodeY: number[] = []
  const adjacency: Edge[][] = []
  const nodeAt = (x: number, y: number): number => {
    const key = `${Math.round(x / quantum)}:${Math.round((y * yScale) / quantum)}`
    let id = nodes.get(key)
    if (id === undefined) {
      id = nodeX.length
      nodes.set(key, id)
      nodeX.push(x)
      nodeY.push(y)
      adjacency.push([])
    }
    return id
  }
  const link = (a: number, b: number, length: number, street: number): void => {
    if (a === b) return
    adjacency[a].push({ to: b, length, street })
    adjacency[b].push({ to: a, length, street })
  }
  const vertexNodes = augmented.map((street, streetIndex) => {
    const ids = street.points.map(([x, y]) => nodeAt(x, y))
    for (let vertex = 1; vertex < ids.length; vertex += 1) {
      const [ax, ay] = street.points[vertex - 1]
      const [bx, by] = street.points[vertex]
      link(ids[vertex - 1], ids[vertex], Math.hypot(bx - ax, (by - ay) * yScale), streetIndex)
    }
    return ids
  })
  for (const connector of connectors) {
    link(nodeAt(connector.a.x, connector.a.y), nodeAt(connector.b.x, connector.b.y), connector.length, connector.street)
  }
  return { index, yScale, vertexNodes, nodeX, nodeY, adjacency }
}

/** Min-heap Dijkstra over the graph plus temporary edges. */
function shortestPaths(
  graph: RoadGraph,
  total: number,
  source: number,
  extra: Map<number, Edge[]>,
): { dist: Float64Array; prev: Int32Array; prevStreet: Int32Array } {
  const dist = new Float64Array(total).fill(Infinity)
  const prev = new Int32Array(total).fill(-1)
  const prevStreet = new Int32Array(total).fill(-1)
  const heap: Array<[number, number]> = []
  const push = (item: [number, number]): void => {
    heap.push(item)
    let index = heap.length - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (heap[parent][0] <= heap[index][0]) break
      ;[heap[parent], heap[index]] = [heap[index], heap[parent]]
      index = parent
    }
  }
  const pop = (): [number, number] => {
    const top = heap[0]
    const last = heap.pop()!
    if (heap.length > 0) {
      heap[0] = last
      let index = 0
      for (;;) {
        const left = index * 2 + 1
        const right = left + 1
        let smallest = index
        if (left < heap.length && heap[left][0] < heap[smallest][0]) smallest = left
        if (right < heap.length && heap[right][0] < heap[smallest][0]) smallest = right
        if (smallest === index) break
        ;[heap[smallest], heap[index]] = [heap[index], heap[smallest]]
        index = smallest
      }
    }
    return top
  }
  dist[source] = 0
  push([0, source])
  while (heap.length > 0) {
    const [d, node] = pop()
    if (d > dist[node]) continue
    const edges = node < graph.adjacency.length ? graph.adjacency[node] : []
    for (const list of [edges, extra.get(node) ?? []]) {
      for (const edge of list) {
        const next = d + edge.length
        if (next < dist[edge.to]) {
          dist[edge.to] = next
          prev[edge.to] = node
          prevStreet[edge.to] = edge.street
          push([next, edge.to])
        }
      }
    }
  }
  return { dist, prev, prevStreet }
}

/** Nodes from `node` back to the source, each with the street of the edge reaching it. */
function backtrack(prev: Int32Array, prevStreet: Int32Array, node: number): Array<{ node: number; street: number }> {
  const path: Array<{ node: number; street: number }> = []
  for (let current = node; current >= 0; current = prev[current]) {
    path.push({ node: current, street: prevStreet[current] })
  }
  return path
}

/**
 * Route from `from` to `to` along the roads. Undefined when the map has no
 * roads. Pieces are in travel order; consecutive edges of the same road are
 * one piece.
 */
export function roadRoute(graph: RoadGraph, from: Pt, to: Pt): RoadRoutePiece[] | undefined {
  const index = graph.index
  const far = index.cell * (index.columns + index.rows + 2)
  const entry = nearestSegment(index, from.x, from.y, far)
  const exit = nearestSegment(index, to.x, to.y, far)
  if (!entry || !exit) return undefined
  const count = graph.nodeX.length
  const E = count
  const X = count + 1
  const position = (node: number): Pt =>
    node === E
      ? { x: entry.x, y: entry.y }
      : node === X
        ? { x: exit.x, y: exit.y }
        : { x: graph.nodeX[node], y: graph.nodeY[node] }
  const extra = new Map<number, Edge[]>()
  const add = (a: number, b: number, length: number, street: number): void => {
    extra.set(a, [...(extra.get(a) ?? []), { to: b, length, street }])
    extra.set(b, [...(extra.get(b) ?? []), { to: a, length, street }])
  }
  const attach = (temp: number, hit: RoadHit): void => {
    const ids = graph.vertexNodes[hit.streetIndex]
    const a = ids[hit.segment - 1]
    const b = ids[hit.segment]
    const length = Math.hypot(graph.nodeX[b] - graph.nodeX[a], (graph.nodeY[b] - graph.nodeY[a]) * graph.yScale)
    add(temp, a, length * hit.t, hit.streetIndex)
    add(temp, b, length * (1 - hit.t), hit.streetIndex)
  }
  attach(E, entry)
  attach(X, exit)
  if (entry.streetIndex === exit.streetIndex && entry.segment === exit.segment) {
    add(E, X, Math.hypot(exit.x - entry.x, (exit.y - entry.y) * graph.yScale), entry.streetIndex)
  }
  const forward = shortestPaths(graph, count + 2, E, extra)
  // Sequence of nodes in travel order; street -1 marks a straight gap.
  let walk: Array<{ node: number; street: number }>
  if (Number.isFinite(forward.dist[X])) {
    walk = backtrack(forward.prev, forward.prevStreet, X).reverse()
  } else {
    const backward = shortestPaths(graph, count + 2, X, extra)
    let best: { a: number; b: number; gap: number; total: number } | undefined
    const reachA: number[] = []
    const reachB: number[] = []
    for (let node = 0; node < count + 2; node += 1) {
      if (Number.isFinite(forward.dist[node])) reachA.push(node)
      if (Number.isFinite(backward.dist[node])) reachB.push(node)
    }
    for (const a of reachA) {
      const pa = position(a)
      for (const b of reachB) {
        const pb = position(b)
        const gap = Math.hypot(pb.x - pa.x, (pb.y - pa.y) * graph.yScale)
        const total = forward.dist[a] + backward.dist[b]
        if (!best || gap < best.gap - 1e-12 || (Math.abs(gap - best.gap) <= 1e-12 && total < best.total)) {
          best = { a, b, gap, total }
        }
      }
    }
    const head = backtrack(forward.prev, forward.prevStreet, best!.a).reverse()
    // Backward tree goes from b towards X; the edge street belongs to the step leaving each node.
    const tailNodes: Array<{ node: number; street: number }> = []
    for (let current = best!.b; current >= 0; current = backward.prev[current]) {
      tailNodes.push({ node: current, street: -1 })
    }
    for (let step = 1; step < tailNodes.length; step += 1) {
      tailNodes[step].street = backward.prevStreet[tailNodes[step - 1].node]
    }
    tailNodes[0].street = -1
    walk = [...head, ...tailNodes]
  }
  const pieces: RoadRoutePiece[] = []
  const pushStraight = (a: Pt, b: Pt): void => {
    if (Math.hypot(b.x - a.x, (b.y - a.y) * graph.yScale) <= 1e-12) return
    const last = pieces[pieces.length - 1]
    if (last?.kind === 'straight') last.points.push(b)
    else pieces.push({ kind: 'straight', points: [a, b] })
  }
  pushStraight(from, position(E))
  for (let step = 1; step < walk.length; step += 1) {
    const a = position(walk[step - 1].node)
    const b = position(walk[step].node)
    const street = walk[step].street
    if (street < 0) {
      pushStraight(a, b)
      continue
    }
    const last = pieces[pieces.length - 1]
    if (last?.kind === 'road' && last.street === street) last.points.push(b)
    else pieces.push({ kind: 'road', street, points: [a, b] })
  }
  pushStraight(position(X), to)
  if (pieces.length === 0) pieces.push({ kind: 'straight', points: [from, to] })
  return pieces
}

/** Roads within `maxDistance` of a polyline, each with its smallest distance, nearest first. */
export function roadsNearPolyline(
  index: RoadIndex,
  points: Pt[],
  maxDistance: number,
): Array<{ streetIndex: number; distance: number }> {
  const best = new Map<number, number>()
  const yScale = index.yScale
  for (let vertex = 1; vertex < points.length; vertex += 1) {
    const a = points[vertex - 1]
    const b = points[vertex]
    const c1 = Math.max(0, Math.floor((Math.min(a.x, b.x) - maxDistance - index.origin.x) / index.cell))
    const c2 = Math.min(index.columns - 1, Math.floor((Math.max(a.x, b.x) + maxDistance - index.origin.x) / index.cell))
    const r1 = Math.max(0, Math.floor((Math.min(a.y, b.y) * yScale - maxDistance - index.origin.y) / index.cell))
    const r2 = Math.min(index.rows - 1, Math.floor((Math.max(a.y, b.y) * yScale + maxDistance - index.origin.y) / index.cell))
    for (let column = c1; column <= c2; column += 1) {
      for (let row = r1; row <= r2; row += 1) {
        for (const [streetIndex, segment] of index.buckets.get(row * index.columns + column) ?? []) {
          const road = index.streets[streetIndex].points
          const c = { x: road[segment - 1][0], y: road[segment - 1][1] }
          const d = { x: road[segment][0], y: road[segment][1] }
          const distance = segmentDistance(a, b, c, d, yScale)
          if (distance <= maxDistance && distance < (best.get(streetIndex) ?? Infinity)) {
            best.set(streetIndex, distance)
          }
        }
      }
    }
  }
  return [...best.entries()]
    .map(([streetIndex, distance]) => ({ streetIndex, distance }))
    .sort((a, b) => a.distance - b.distance)
}
