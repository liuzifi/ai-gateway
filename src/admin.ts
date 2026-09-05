import { Context } from 'hono'
import {
  getProviders,
  getProvider,
  setProviders,
  addProvider,
  updateProvider,
  deleteProvider,
  getProxyKeys,
  addProxyKey,
  updateProxyKey,
  deleteProxyKey,
} from './storage'
import { testModelConnection } from './proxy'
import { getMetricsSnapshot } from './metrics'
import { fetchOpenCodeModels, isOpenCodeProvider, resolveOpenCodeUrls, testOpenCodeModel } from './opencode'
import { PROXY_KEY_PREFIX, EXPIRY_OPTIONS, OPENCODE_DEFAULT_URL } from './config'
import type {
  Env,
  ApiResponse,
  Provider,
  Model,
  ApiKeyEntry,
  CreateProviderRequest,
  UpdateProviderRequest,
  ApplyProviderModelsRequest,
  CreateProxyKeyRequest,
  TestModelRequest,
  BulkOperationAction,
  BulkOperationRequest,
  BulkOperationResult,
  BulkProviderStateRequest,
  BulkModelStateRequest,
  BulkPruneRequest,
} from './types'

// ===== 系统状态 =====

/**
 * 将 string[] 或正规对象数组统一转换为正规对象数组，并按值去重。
 * 字符串输入支持英文逗号、中文逗号、空白字符和换行分隔。
 */
function normalizeArray<T>(
  items: unknown,
  mapFn: (val: string) => T
): T[] {
  const values = Array.isArray(items)
    ? items.flatMap((item) => typeof item === 'string' ? item.split(/[\s,，]+/) : [item])
    : typeof items === 'string'
      ? items.split(/[\s,，]+/)
      : []
  const seen = new Set<string>()
  const result: T[] = []

  for (const value of values) {
    if (typeof value === 'string') {
      const normalized = value.trim()
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      result.push(mapFn(normalized))
      continue
    }
    if (!value || typeof value !== 'object') continue
    const record = value as Record<string, unknown>
    const field = typeof record.key === 'string' ? 'key' : typeof record.id === 'string' ? 'id' : null
    const normalized = field ? String(record[field]).trim() : ''
    if (!field || !normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push({ ...record, [field]: normalized } as T)
  }
  return result
}

export async function handleStatus(c: Context<{ Bindings: Env }>) {
  const providers = await getProviders(c.env)
  const proxyKeys = await getProxyKeys(c.env)

  const totalModels = providers.reduce((sum, p) => sum + p.models.length, 0)
  const enabledModels = providers.reduce(
    (sum, p) => sum + p.models.filter((m) => m.enabled).length,
    0
  )

  return c.json<ApiResponse>({
    success: true,
    data: {
      providersCount: providers.length,
      enabledProvidersCount: providers.filter((p) => p.enabled).length,
      modelsCount: totalModels,
      enabledModelsCount: enabledModels,
      proxyKeysCount: proxyKeys.filter((k) => k.enabled).length,
      adminConfigured: !!(c.env.ADMIN_USERNAME && c.env.ADMIN_PASSWORD),
      baseUrl: new URL(c.req.url).origin,
    },
  })
}

export async function handleMetrics(c: Context<{ Bindings: Env }>) {
  return c.json<ApiResponse>({ success: true, data: await getMetricsSnapshot(c.env) })
}

// ===== 提供商 CRUD =====

export async function handleGetProviders(c: Context<{ Bindings: Env }>) {
  const providers = await getProviders(c.env)
  return c.json<ApiResponse<Provider[]>>({ success: true, data: providers })
}

export async function handleCreateProvider(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<CreateProviderRequest>()
  // opencode 未传地址时自动填充
  if (body.id === 'opencode' && !body.baseUrl) {
    body.baseUrl = OPENCODE_DEFAULT_URL
  }

  if (!body.id || !body.name || !body.baseUrl) {
    return c.json<ApiResponse>({ success: false, message: 'id、name、baseUrl 为必填项' }, 400)
  }

  const providers = await getProviders(c.env)
  if (providers.some((p) => p.id === body.id)) {
    return c.json<ApiResponse>({ success: false, message: `提供商 id "${body.id}" 已存在` }, 409)
  }

  const now = new Date().toISOString()
  const provider: Provider = {
    id: body.id,
    name: body.name,
    baseUrl: body.baseUrl.replace(/\/$/, ''),
    apiType: body.apiType || 'openai',
    apiKeys: normalizeArray(body.apiKeys, (k) => ({ key: k, enabled: true })),
    models: body.models
      ? normalizeArray(body.models, (m) => ({ id: m, enabled: true }))
      : [],
    enabled: body.enabled !== undefined ? body.enabled : true,
    createdAt: now,
    updatedAt: now,
  }

  await addProvider(c.env, provider)
  return c.json<ApiResponse<Provider>>({ success: true, data: provider }, 201)
}

export async function handleUpdateProvider(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const body = await c.req.json<UpdateProviderRequest>()

  const updates: Partial<Provider> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.baseUrl !== undefined) updates.baseUrl = body.baseUrl.replace(/\/$/, '')
  if (body.apiType !== undefined) updates.apiType = body.apiType
  if (body.apiKeys !== undefined) {
    updates.apiKeys = normalizeArray(body.apiKeys, (k) => ({ key: k, enabled: true }))
  }
  if (body.enabled !== undefined) updates.enabled = body.enabled
  if (body.models !== undefined) {
    updates.models = normalizeArray(body.models, (m) => ({ id: m, enabled: true }))
  }

  const updated = await updateProvider(c.env, id, updates)
  if (!updated) {
    return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  }

  return c.json<ApiResponse<Provider>>({ success: true, data: updated })
}

function normalizeDiscoveredModels(data: unknown): Array<{ id: string }> {
  if (!data || typeof data !== 'object') return []
  const items = Array.isArray(data)
    ? data
    : Array.isArray((data as { data?: unknown }).data)
      ? (data as { data: unknown[] }).data
      : []
  const seen = new Set<string>()
  return items.map((item) => {
    const id = typeof item === 'string'
      ? item
      : item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string'
        ? (item as { id: string }).id
        : ''
    return { id: id.trim() }
  }).filter((item) => {
    if (!item.id || item.id.length > 200 || seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

async function fetchProviderModels(c: Context<{ Bindings: Env }>, provider: Provider) {
  const enabledKeys = provider.apiKeys.filter((key) => key.enabled)
  if (!isOpenCodeProvider(provider.id) && enabledKeys.length === 0) {
    return { success: false, statusCode: 400, message: '该提供商未配置可用的 API Key' }
  }

  if (isOpenCodeProvider(provider.id)) {
    const result = await fetchOpenCodeModels(provider.baseUrl, enabledKeys, resolveOpenCodeUrls(c.env))
    const models = result.data && typeof result.data === 'object' && 'data' in result.data
      ? (result.data as { data?: unknown }).data
      : []
    return { success: result.success, statusCode: result.statusCode || 0, message: result.message, data: normalizeDiscoveredModels(models) }
  }

  const cleanBase = provider.baseUrl.replace(/\/$/, '')
  try {
    const response = await fetch(`${cleanBase}/models`, {
      method: 'GET',
      headers: buildAuthHeaders(enabledKeys[0].key, provider.apiType),
      signal: AbortSignal.timeout(15000),
    })
    let data: unknown = null
    try { data = await response.json() } catch { /* ignore */ }
    return {
      success: response.ok,
      statusCode: response.status,
      message: response.ok ? '连接成功' : `HTTP ${response.status}`,
      data: normalizeDiscoveredModels(data),
    }
  } catch (error) {
    return { success: false, statusCode: 0, message: (error as Error).message || '连接失败' }
  }
}

export async function handleDiscoverProviderModels(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)

  const result = await fetchProviderModels(c, provider)
  return c.json<ApiResponse>({ success: result.success, data: result, message: result.success ? undefined : result.message }, result.success ? 200 : 502)
}

export async function handleApplyProviderModels(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const body = await c.req.json<ApplyProviderModelsRequest>()
  if (!['new-only', 'replace', 'merge'].includes(body.mode) || !Array.isArray(body.models)) {
    return c.json<ApiResponse>({ success: false, message: 'mode 必须是 new-only、replace 或 merge，models 必须是数组' }, 400)
  }
  const provider = await getProvider(c.env, id)
  if (!provider) return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)

  const discovered = normalizeDiscoveredModels(body.models)
  const incoming = new Map(discovered.map((model) => [model.id, { id: model.id, enabled: true }]))
  const existing = new Map(provider.models.map((model) => [model.id, model]))
  let models
  if (body.mode === 'replace') {
    models = Array.from(incoming.values())
  } else if (body.mode === 'new-only') {
    models = [...provider.models, ...Array.from(incoming.values()).filter((model) => !existing.has(model.id))]
  } else {
    models = provider.models.map((model) => incoming.has(model.id) ? { ...model, enabled: model.enabled } : model)
    models.push(...Array.from(incoming.values()).filter((model) => !existing.has(model.id)))
  }

  const updated = await updateProvider(c.env, id, { models })
  return c.json<ApiResponse>({ success: true, data: { provider: updated, added: models.filter((model) => !existing.has(model.id)).length, total: models.length } })
}

export async function handleDeleteProvider(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const deleted = await deleteProvider(c.env, id)
  if (!deleted) {
    return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, message: '提供商已删除' })
}

export async function handleTestModel(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const { modelId } = await c.req.json<TestModelRequest>()

  if (!modelId) {
    return c.json<ApiResponse>({ success: false, message: 'modelId 为必填项' }, 400)
  }

  const provider = await getProvider(c.env, id)
  if (!provider) {
    return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  }

  const modelConfig = provider.models.find((m) => m.id === modelId)
  if (!modelConfig) {
    return c.json<ApiResponse>({ success: false, message: `模型 "${modelId}" 不存在于提供商 "${provider.name}"` }, 404)
  }

  const enabledKeys = provider.apiKeys.filter(k => k.enabled)
  if (!isOpenCodeProvider(provider.id) && enabledKeys.length === 0) {
    return c.json<ApiResponse>({ success: false, message: '该提供商未配置可用的 API Key' }, 400)
  }

  const result = isOpenCodeProvider(provider.id)
    ? await testOpenCodeModel(provider.baseUrl, enabledKeys, modelId, resolveOpenCodeUrls(c.env))
    : await testModelConnection(provider.baseUrl, enabledKeys[0].key, modelId, provider.apiType)

  return c.json<ApiResponse>({
    success: true,
    data: result,
  })
}

// ===== Key / 模型连通性测试（通过服务端代理，避免 CORS） =====

function buildAuthHeaders(apiKey: string, apiType?: string): Record<string, string> {
  if (apiType === 'anthropic') {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  }
  return { 'Authorization': `Bearer ${apiKey}` }
}

export async function handleTestKeyNew(c: Context<{ Bindings: Env }>) {
  const { url, apiKey, apiType, providerId } = await c.req.json<{
    url: string
    apiKey: string
    apiType?: string
    providerId?: string
  }>()
  if (!url || (!apiKey && !(providerId && isOpenCodeProvider(providerId)))) {
    return c.json<ApiResponse>({ success: false, message: 'url 和 apiKey 为必填项' }, 400)
  }

  if (providerId && isOpenCodeProvider(providerId)) {
    // 没填 key 时检查是否配了镜像，避免迷惑性报错
    if (!apiKey) {
      const mirrors = resolveOpenCodeUrls(c.env)
      if (mirrors.length === 0) {
        return c.json<ApiResponse>({
          success: true,
          data: { success: false, statusCode: 0, message: '请先填写 API Key 或配置 OPENCODE_MIRRORS_URL 环境变量' },
        })
      }
    }
    const result = await fetchOpenCodeModels(url, [{ key: apiKey, enabled: true }], resolveOpenCodeUrls(c.env))
    return c.json<ApiResponse>({
      success: true,
      data: {
        success: result.success,
        statusCode: result.statusCode || 0,
        message: result.message,
        data: result.data,
      },
    })
  }

  const cleanBase = url.replace(/\/$/, '')
  try {
    const response = await fetch(`${cleanBase}/models`, {
      method: 'GET', headers: buildAuthHeaders(apiKey, apiType), signal: AbortSignal.timeout(15000),
    })

    let data: unknown = null
    if (response.ok) {
      try { data = await response.json() } catch { /* ignore */ }
    }

    return c.json<ApiResponse>({
      success: true,
      data: { success: response.ok, statusCode: response.status, data },
    })
  } catch (err) {
    return c.json<ApiResponse>({
      success: true,
      data: { success: false, statusCode: 0, message: (err as Error).message || '连接失败' },
    })
  }
}

export async function handleTestModelNew(c: Context<{ Bindings: Env }>) {
  const { url, apiKey, apiType, model, providerId } = await c.req.json<{
    url: string
    apiKey: string
    apiType?: string
    model: string
    providerId?: string
  }>()
  if (!url || !model || (!apiKey && !isOpenCodeProvider(providerId || ''))) {
    return c.json<ApiResponse>({ success: false, message: 'url、apiKey、model 为必填项' }, 400)
  }

  if (providerId && isOpenCodeProvider(providerId)) {
    const apiKeys = apiKey ? [{ key: apiKey, enabled: true }] : []
    const result = await testOpenCodeModel(url, apiKeys, model, resolveOpenCodeUrls(c.env))
    return c.json<ApiResponse>({
      success: true,
      data: { success: result.success, statusCode: result.statusCode || 0, message: result.message },
    })
  }

  const cleanBase = url.replace(/\/$/, '')
  const endpoint = apiType === 'anthropic' ? 'messages' : 'chat/completions'

  try {
    const response = await fetch(`${cleanBase}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(apiKey, apiType) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(15000),
    })

    return c.json<ApiResponse>({
      success: true,
      data: { success: response.ok, statusCode: response.status },
    })
  } catch (err) {
    return c.json<ApiResponse>({
      success: true,
      data: { success: false, statusCode: 0, message: (err as Error).message || '连接失败' },
    })
  }
}

// ===== 转发 Key 管理 =====

export async function handleGetProxyKeys(c: Context<{ Bindings: Env }>) {
  const keys = await getProxyKeys(c.env)
  const maskedKeys = keys.map((k) => ({
    ...k,
    key: k.key.length > 12
      ? k.key.substring(0, 8) + '****' + k.key.substring(k.key.length - 4)
      : k.key,
  }))
  return c.json<ApiResponse>({ success: true, data: maskedKeys })
}

export async function handleCreateProxyKey(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<CreateProxyKeyRequest>()
  const id = crypto.randomUUID()
  const randomPart = crypto.randomUUID().replace(/-/g, '')
  const key = `${PROXY_KEY_PREFIX}${randomPart}`

  // 计算过期时间
  let expiresAt: string | null = null
  if (body.expiresIn && body.expiresIn !== 'forever') {
    const ttl = EXPIRY_OPTIONS[body.expiresIn]
    if (ttl) {
      expiresAt = new Date(Date.now() + ttl * 1000).toISOString()
    }
  }

  const proxyKey = {
    id,
    key,
    name: body.name || `Key-${new Date().toLocaleDateString()}`,
    enabled: true,
    createdAt: new Date().toISOString(),
    expiresAt,
  }

  await addProxyKey(c.env, proxyKey)
  return c.json<ApiResponse>({
    success: true,
    data: proxyKey,
    message: '请立即保存此 Key，关闭后将不再显示',
  }, 201)
}

export async function handleDeleteProxyKey(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const deleted = await deleteProxyKey(c.env, id)
  if (!deleted) {
    return c.json<ApiResponse>({ success: false, message: '转发 Key 不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, message: '转发 Key 已删除' })
}

export async function handleUpdateProxyKey(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const body = await c.req.json<{ enabled?: boolean }>()
  const updates: Partial<import('./types').ProxyKey> = {}
  if (body.enabled !== undefined) updates.enabled = body.enabled
  const updated = await updateProxyKey(c.env, id, updates)
  if (!updated) {
    return c.json<ApiResponse>({ success: false, message: '转发 Key 不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, data: updated })
}

// ===== 批量操作 =====

/** 兼容历史数据：模型项可能是字符串或 { id, enabled } 对象 */
function readModelEntry(entry: unknown): Model {
  if (typeof entry === 'string') return { id: entry.trim(), enabled: true }
  if (entry && typeof entry === 'object') {
    const record = entry as { id?: unknown; enabled?: unknown }
    return {
      id: typeof record.id === 'string' ? record.id.trim() : '',
      enabled: record.enabled !== false,
    }
  }
  return { id: '', enabled: true }
}

/** 兼容历史数据：API Key 项可能是字符串或 { key, enabled } 对象 */
function readApiKeyEntry(entry: unknown): ApiKeyEntry {
  if (typeof entry === 'string') return { key: entry.trim(), enabled: true }
  if (entry && typeof entry === 'object') {
    const record = entry as { key?: unknown; enabled?: unknown }
    return {
      key: typeof record.key === 'string' ? record.key.trim() : '',
      enabled: record.enabled !== false,
    }
  }
  return { key: '', enabled: true }
}

/** 读取提供商模型列表：归一化后剔除空 id */
function readProviderModels(provider: Provider): Model[] {
  const raw: unknown = provider.models
  if (!Array.isArray(raw)) return []
  return raw.map(readModelEntry).filter((model) => model.id !== '')
}

/** 读取提供商 API Key 列表：归一化后剔除空 key */
function readProviderApiKeys(provider: Provider): ApiKeyEntry[] {
  const raw: unknown = provider.apiKeys
  if (!Array.isArray(raw)) return []
  return raw.map(readApiKeyEntry).filter((entry) => entry.key !== '')
}

/** 提取去空白、去重后的字符串 ID 列表 */
function toIdList(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  for (const value of values) {
    const id = typeof value === 'string' ? value.trim() : ''
    if (id) seen.add(id)
  }
  return Array.from(seen)
}

/** 合并批量模型目标：providerId -> 模型 ID 集合 */
function toModelTargetMap(targets: unknown): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  if (!Array.isArray(targets)) return map
  for (const item of targets) {
    if (!item || typeof item !== 'object') continue
    const record = item as { providerId?: unknown; modelIds?: unknown }
    const providerId = typeof record.providerId === 'string' ? record.providerId.trim() : ''
    if (!providerId) continue
    const bucket = map.get(providerId) ?? new Set<string>()
    for (const id of toIdList(record.modelIds)) bucket.add(id)
    map.set(providerId, bucket)
  }
  return map
}

/** 合并"只保留可用项"目标：providerId -> 待删除的 Key 与模型 */
function toPruneTargetMap(targets: unknown): Map<string, { keys: Set<string>; models: Set<string> }> {
  const map = new Map<string, { keys: Set<string>; models: Set<string> }>()
  if (!Array.isArray(targets)) return map
  for (const item of targets) {
    if (!item || typeof item !== 'object') continue
    const record = item as { providerId?: unknown; invalidKeys?: unknown; invalidModelIds?: unknown }
    const providerId = typeof record.providerId === 'string' ? record.providerId.trim() : ''
    if (!providerId) continue
    const bucket = map.get(providerId) ?? { keys: new Set<string>(), models: new Set<string>() }
    for (const key of toIdList(record.invalidKeys)) bucket.keys.add(key)
    for (const id of toIdList(record.invalidModelIds)) bucket.models.add(id)
    map.set(providerId, bucket)
  }
  return map
}

/** 组装批量操作的中文结果描述 */
function describeBulkResult(result: BulkOperationResult): string {
  const parts: string[] = []
  if (result.providersUpdated) parts.push('提供商 ' + result.providersUpdated + ' 个')
  if (result.modelsUpdated) parts.push('模型状态 ' + result.modelsUpdated + ' 个')
  if (result.modelsRemoved) parts.push('删除模型 ' + result.modelsRemoved + ' 个')
  if (result.keysRemoved) parts.push('删除 Key ' + result.keysRemoved + ' 个')
  let message = parts.length ? '批量操作完成：' + parts.join('，') : '没有需要变更的内容'
  if (result.missingProviderIds.length) {
    message += '；已跳过不存在的提供商 ' + result.missingProviderIds.length + ' 个'
  }
  return message
}

/**
 * 批量操作端点。
 *
 * 所有提供商都存放在同一个 KV 键下，`updateProvider()` 是"读全量 → 改一项 → 写回全量"。
 * 因此批量变更必须在一次读取 + 一次写入内完成，否则前端并发多次 PUT 会互相覆盖。
 */
export async function handleBulkOperations(c: Context<{ Bindings: Env }>) {
  let body: BulkOperationRequest | null = null
  try {
    body = await c.req.json<BulkOperationRequest>()
  } catch {
    return c.json<ApiResponse>({ success: false, message: '请求体不是合法 JSON' }, 400)
  }
  if (!body || typeof body !== 'object') {
    return c.json<ApiResponse>({ success: false, message: '请求体格式错误' }, 400)
  }
  const rawAction = (body as { action?: unknown }).action
  if (typeof rawAction !== 'string' || !rawAction) {
    return c.json<ApiResponse>({ success: false, message: '缺少 action 参数' }, 400)
  }

  const providers = await getProviders(c.env)
  const indexById = new Map<string, number>()
  providers.forEach((provider, index) => {
    if (provider && typeof provider.id === 'string' && provider.id) indexById.set(provider.id, index)
  })
  const now = new Date().toISOString()
  const result: BulkOperationResult = {
    action: rawAction as BulkOperationAction,
    providersUpdated: 0,
    modelsUpdated: 0,
    modelsRemoved: 0,
    keysRemoved: 0,
    missingProviderIds: [],
  }

  switch (rawAction) {
    case 'enable-providers':
    case 'disable-providers': {
      const enabled = rawAction === 'enable-providers'
      const providerIds = toIdList((body as BulkProviderStateRequest).providerIds)
      if (!providerIds.length) {
        return c.json<ApiResponse>({ success: false, message: '未选择任何提供商' }, 400)
      }
      for (const providerId of providerIds) {
        const index = indexById.get(providerId)
        const provider = index === undefined ? undefined : providers[index]
        if (index === undefined || !provider) {
          result.missingProviderIds.push(providerId)
          continue
        }
        if (provider.enabled === enabled) continue
        providers[index] = { ...provider, enabled, updatedAt: now }
        result.providersUpdated++
      }
      break
    }

    case 'enable-models':
    case 'disable-models':
    case 'delete-models': {
      const targets = toModelTargetMap((body as BulkModelStateRequest).targets)
      if (!targets.size) {
        return c.json<ApiResponse>({ success: false, message: '未选择任何模型' }, 400)
      }
      for (const entry of Array.from(targets.entries())) {
        const providerId = entry[0]
        const modelIds = entry[1]
        const index = indexById.get(providerId)
        const provider = index === undefined ? undefined : providers[index]
        if (index === undefined || !provider) {
          result.missingProviderIds.push(providerId)
          continue
        }
        if (!modelIds.size) continue
        const current = readProviderModels(provider)
        let stateChanged = 0
        let removed = 0
        let nextModels: Model[]
        if (rawAction === 'delete-models') {
          nextModels = current.filter((model) => !modelIds.has(model.id))
          removed = current.length - nextModels.length
        } else {
          const enabled = rawAction === 'enable-models'
          nextModels = current.map((model) => {
            if (!modelIds.has(model.id) || model.enabled === enabled) return model
            stateChanged++
            return { ...model, enabled }
          })
        }
        if (!stateChanged && !removed) continue
        providers[index] = { ...provider, models: nextModels, updatedAt: now }
        result.providersUpdated++
        result.modelsUpdated += stateChanged
        result.modelsRemoved += removed
      }
      break
    }

    case 'prune-invalid': {
      const targets = toPruneTargetMap((body as BulkPruneRequest).targets)
      if (!targets.size) {
        return c.json<ApiResponse>({ success: false, message: '没有需要清理的无效项' }, 400)
      }
      for (const entry of Array.from(targets.entries())) {
        const providerId = entry[0]
        const target = entry[1]
        const index = indexById.get(providerId)
        const provider = index === undefined ? undefined : providers[index]
        if (index === undefined || !provider) {
          result.missingProviderIds.push(providerId)
          continue
        }
        if (!target.keys.size && !target.models.size) continue
        const currentKeys = readProviderApiKeys(provider)
        const currentModels = readProviderModels(provider)
        // 只删除显式列出的无效项，未列出（含未测试）的项一律保留
        const nextKeys = target.keys.size
          ? currentKeys.filter((item) => !target.keys.has(item.key))
          : currentKeys
        const nextModels = target.models.size
          ? currentModels.filter((model) => !target.models.has(model.id))
          : currentModels
        const keysRemoved = currentKeys.length - nextKeys.length
        const modelsRemoved = currentModels.length - nextModels.length
        if (!keysRemoved && !modelsRemoved) continue
        providers[index] = { ...provider, apiKeys: nextKeys, models: nextModels, updatedAt: now }
        result.providersUpdated++
        result.keysRemoved += keysRemoved
        result.modelsRemoved += modelsRemoved
      }
      break
    }

    default:
      return c.json<ApiResponse>({ success: false, message: '不支持的批量操作：' + rawAction }, 400)
  }

  if (result.providersUpdated > 0) {
    await setProviders(c.env, providers)
  }

  return c.json<ApiResponse<BulkOperationResult>>({
    success: true,
    data: result,
    message: describeBulkResult(result),
  })
}
