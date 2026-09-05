import { KV_KEYS } from './config'
import type { Env } from './types'

export interface MetricsSnapshot {
  startedAt: number
  requests: number
  successes: number
  totalLatencyMs: number
  latencySamples: number[]
  statusCounts: Record<string, number>
  providerFailures: Record<string, number>
  modelFailures: Record<string, number>
  keyFailures: Record<string, number>
  keySwitches: number
}

export interface RequestMetricEvent {
  providerId?: string
  modelId?: string
  status: number
  latencyMs: number
}

export interface UpstreamMetricEvent {
  providerId: string
  modelId: string
  keyIndex: number
  status: number
  failed: boolean
}

const MAX_LATENCY_SAMPLES = 1000
let snapshot: MetricsSnapshot | null = null
let loadPromise: Promise<void> | null = null
let flushPromise: Promise<void> | null = null

function emptySnapshot(): MetricsSnapshot {
  return {
    startedAt: Date.now(),
    requests: 0,
    successes: 0,
    totalLatencyMs: 0,
    latencySamples: [],
    statusCounts: {},
    providerFailures: {},
    modelFailures: {},
    keyFailures: {},
    keySwitches: 0,
  }
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] || 0) + 1
}

function statusBucket(status: number): string {
  if (status === 429) return '429'
  if (status === 401) return '401'
  if (status === 403) return '403'
  if (status >= 500) return '5xx'
  if (status >= 400) return '4xx'
  if (status >= 300) return '3xx'
  return '2xx'
}

async function ensureLoaded(env: Env): Promise<void> {
  if (snapshot) return
  if (!loadPromise) {
    loadPromise = env.KV.get(KV_KEYS.METRICS).then((raw: string | null) => {
      try {
        const parsed = raw ? JSON.parse(raw) as MetricsSnapshot : null
        snapshot = parsed && typeof parsed === 'object' && Date.now() - parsed.startedAt < 24 * 60 * 60 * 1000
          ? { ...emptySnapshot(), ...parsed }
          : emptySnapshot()
      } catch {
        snapshot = emptySnapshot()
      }
    }).catch(() => { snapshot = emptySnapshot() })
  }
  await loadPromise
}

function scheduleFlush(env: Env): void {
  if (flushPromise || !snapshot) return
  flushPromise = env.KV.put(KV_KEYS.METRICS, JSON.stringify(snapshot))
    .catch(() => {})
    .finally(() => { flushPromise = null })
}

export async function recordRequestMetric(env: Env, event: RequestMetricEvent): Promise<void> {
  await ensureLoaded(env)
  const current = snapshot!
  current.requests++
  if (event.status >= 200 && event.status < 400) current.successes++
  current.totalLatencyMs += Math.max(0, Math.round(event.latencyMs))
  current.latencySamples.push(Math.max(0, Math.round(event.latencyMs)))
  if (current.latencySamples.length > MAX_LATENCY_SAMPLES) current.latencySamples.splice(0, current.latencySamples.length - MAX_LATENCY_SAMPLES)
  increment(current.statusCounts, statusBucket(event.status))
  if (event.status >= 400) {
    if (event.providerId) increment(current.providerFailures, event.providerId)
    if (event.providerId && event.modelId) increment(current.modelFailures, `${event.providerId}/${event.modelId}`)
  }
  scheduleFlush(env)
}

export async function recordUpstreamMetric(env: Env, event: UpstreamMetricEvent): Promise<void> {
  await ensureLoaded(env)
  const current = snapshot!
  if (event.keyIndex > 0) current.keySwitches++
  if (event.failed) {
    increment(current.keyFailures, `${event.providerId}#${event.keyIndex + 1}`)
  }
  scheduleFlush(env)
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]
}

function topFailures(values: Record<string, number>) {
  return Object.entries(values).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count }))
}

export async function getMetricsSnapshot(env: Env) {
  await ensureLoaded(env)
  const current = snapshot!
  return {
    startedAt: current.startedAt,
    requests: current.requests,
    successRate: current.requests ? current.successes / current.requests : 0,
    averageLatencyMs: current.requests ? Math.round(current.totalLatencyMs / current.requests) : 0,
    p50LatencyMs: percentile(current.latencySamples, 0.5),
    p95LatencyMs: percentile(current.latencySamples, 0.95),
    statusCounts: current.statusCounts,
    keySwitches: current.keySwitches,
    providerFailures: topFailures(current.providerFailures),
    modelFailures: topFailures(current.modelFailures),
    keyFailures: topFailures(current.keyFailures),
  }
}
