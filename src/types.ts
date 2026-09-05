export interface Model {
  id: string
  enabled: boolean
}

export interface ApiKeyEntry {
  key: string
  enabled: boolean
}

export interface Provider {
  id: string
  name: string
  baseUrl: string
  apiType?: 'openai' | 'anthropic'
  apiKeys: ApiKeyEntry[]
  models: Model[]
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface ProxyKey {
  id: string
  key: string
  name: string
  enabled: boolean
  createdAt: string
  expiresAt?: string | null
}

export interface Session {
  username: string
  expiresAt: number
}

// ── 请求体兼容类型（OpenAI Chat Completions + Anthropic Messages） ──
// 网关对请求体做原样透传（handleProxy 内 `{ ...body, model: modelId }`），
// 这些类型只用于提升类型表达能力与静态检查，不参与运行时校验。

/** 纯文本内容块 */
export interface ChatContentPartText {
  type: 'text'
  text: string
}

/** 图片内容块（OpenAI 多模态输入） */
export interface ChatContentPartImageUrl {
  type: 'image_url'
  image_url: {
    /** 远程 URL 或 data:image/...;base64,... */
    url: string
    detail?: 'auto' | 'low' | 'high'
  }
}

/** 音频内容块（OpenAI 多模态输入） */
export interface ChatContentPartInputAudio {
  type: 'input_audio'
  input_audio: {
    /** Base64 编码的音频数据 */
    data: string
    format: 'wav' | 'mp3'
  }
}

/** 文件内容块（OpenAI 多模态输入） */
export interface ChatContentPartFile {
  type: 'file'
  file: {
    file_data?: string
    file_id?: string
    filename?: string
  }
}

/** 拒答内容块（assistant 消息回填时使用） */
export interface ChatContentPartRefusal {
  type: 'refusal'
  refusal: string
}

/** 图片内容块（Anthropic 风格） */
export interface ChatContentPartAnthropicImage {
  type: 'image'
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string }
}

/** 工具调用内容块（Anthropic 风格） */
export interface ChatContentPartToolUse {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

/** 工具结果内容块（Anthropic 风格） */
export interface ChatContentPartToolResult {
  type: 'tool_result'
  tool_use_id: string
  content?: string | ChatContentPart[]
  is_error?: boolean
}

export type ChatContentPart =
  | ChatContentPartText
  | ChatContentPartImageUrl
  | ChatContentPartInputAudio
  | ChatContentPartFile
  | ChatContentPartRefusal
  | ChatContentPartAnthropicImage
  | ChatContentPartToolUse
  | ChatContentPartToolResult

/** 消息内容：纯文本或多模态内容块数组 */
export type ChatContent = string | ChatContentPart[]

/** 函数调用负载（arguments 为 JSON 字符串） */
export interface ChatFunctionCall {
  name: string
  arguments: string
}

/** assistant 消息回填的工具调用 */
export interface ChatToolCall {
  id: string
  type: 'function'
  index?: number
  function: ChatFunctionCall
}

export interface ChatSystemMessage {
  role: 'system'
  content: ChatContent
  name?: string
}

/** OpenAI 新版用于替代 system 的角色 */
export interface ChatDeveloperMessage {
  role: 'developer'
  content: ChatContent
  name?: string
}

export interface ChatUserMessage {
  role: 'user'
  content: ChatContent
  name?: string
}

export interface ChatAssistantMessage {
  role: 'assistant'
  content?: ChatContent | null
  name?: string
  refusal?: string | null
  tool_calls?: ChatToolCall[]
  /** 部分上游（DeepSeek / Qwen 等）携带的思维链字段 */
  reasoning_content?: string | null
  /** 已废弃字段，保留以兼容旧客户端 */
  function_call?: ChatFunctionCall | null
}

export interface ChatToolMessage {
  role: 'tool'
  content: ChatContent
  tool_call_id: string
}

/** 已废弃的 function 角色消息，保留以兼容旧客户端 */
export interface ChatFunctionMessage {
  role: 'function'
  name: string
  content: ChatContent | null
}

export type ChatMessage =
  | ChatSystemMessage
  | ChatDeveloperMessage
  | ChatUserMessage
  | ChatAssistantMessage
  | ChatToolMessage
  | ChatFunctionMessage

/** 工具定义（OpenAI 风格） */
export interface ChatFunctionTool {
  type: 'function'
  function: {
    name: string
    description?: string
    /** JSON Schema */
    parameters?: Record<string, unknown>
    strict?: boolean | null
  }
}

/** 工具定义（Anthropic 风格） */
export interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

export type ChatTool = ChatFunctionTool | AnthropicTool

/** 工具选择策略（OpenAI 风格） */
export type OpenAIToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } }
  | {
      type: 'allowed_tools'
      allowed_tools: {
        mode: 'auto' | 'required'
        tools: Array<{ type: 'function'; function: { name: string } }>
      }
    }
  | { type: 'custom'; custom: { name: string } }

/** 工具选择策略（Anthropic 风格） */
export interface AnthropicToolChoice {
  type: 'auto' | 'any' | 'tool' | 'none'
  name?: string
  disable_parallel_tool_use?: boolean
}

export type ChatToolChoice = OpenAIToolChoice | AnthropicToolChoice

export interface ResponseFormatText {
  type: 'text'
}

export interface ResponseFormatJsonObject {
  type: 'json_object'
}

export interface ResponseFormatJsonSchema {
  type: 'json_schema'
  json_schema: {
    name: string
    description?: string
    /** JSON Schema */
    schema?: Record<string, unknown>
    strict?: boolean | null
  }
}

export type ResponseFormat =
  | ResponseFormatText
  | ResponseFormatJsonObject
  | ResponseFormatJsonSchema

export interface StreamOptions {
  include_usage?: boolean
  include_obfuscation?: boolean
  [key: string]: unknown
}

export interface ProxyRequestBody {
  model?: string
  messages?: ChatMessage[]
  /** Anthropic Messages API 的顶层 system 提示 */
  system?: string | ChatContentPart[]
  stream?: boolean
  stream_options?: StreamOptions | null
  tools?: ChatTool[]
  tool_choice?: ChatToolChoice
  parallel_tool_calls?: boolean
  response_format?: ResponseFormat
  max_tokens?: number | null
  max_completion_tokens?: number | null
  temperature?: number | null
  top_p?: number | null
  top_k?: number | null
  n?: number | null
  seed?: number | null
  stop?: string | string[] | null
  stop_sequences?: string[]
  presence_penalty?: number | null
  frequency_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  top_logprobs?: number | null
  user?: string
  metadata?: Record<string, unknown> | null
  /** 兼容 /v1/completions 等非 chat 端点 */
  prompt?: string | string[] | number[] | number[][]
  /** 其余上游私有字段原样透传 */
  [key: string]: unknown
}

export interface TestModelRequest {
  modelId: string
}

export interface CreateProviderRequest {
  id: string
  name: string
  baseUrl: string
  apiType?: 'openai' | 'anthropic'
  apiKeys?: Array<{ key: string; enabled: boolean }>
  models?: Array<{ id: string; enabled: boolean }> | string[]
  enabled?: boolean
}

export interface UpdateProviderRequest {
  name?: string
  baseUrl?: string
  apiType?: 'openai' | 'anthropic'
  apiKeys?: Array<{ key: string; enabled: boolean }>
  models?: Array<{ id: string; enabled: boolean }> | string[]
  enabled?: boolean
}

export type ModelApplyMode = 'new-only' | 'replace' | 'merge'

export interface ApplyProviderModelsRequest {
  mode: ModelApplyMode
  models: Array<{ id: string; enabled?: boolean } | string>
}

/** 支持的批量操作类型 */
export type BulkOperationAction =
  | 'enable-providers'
  | 'disable-providers'
  | 'enable-models'
  | 'disable-models'
  | 'delete-models'
  | 'prune-invalid'

/** 批量启用/禁用提供商 */
export interface BulkProviderStateRequest {
  action: 'enable-providers' | 'disable-providers'
  providerIds: string[]
}

/** 批量模型操作中单个提供商的目标模型 */
export interface BulkModelTarget {
  providerId: string
  modelIds: string[]
}

/** 批量启用/禁用/删除模型 */
export interface BulkModelStateRequest {
  action: 'enable-models' | 'disable-models' | 'delete-models'
  targets: BulkModelTarget[]
}

/**
 * 清理无效项的目标。
 * 只删除显式列出的 Key 与模型，未列出（含未测试）的项一律保留。
 */
export interface BulkPruneTarget {
  providerId: string
  invalidKeys?: string[]
  invalidModelIds?: string[]
}

/** 只保留可用项：删除已确认无效的 Key 与模型 */
export interface BulkPruneRequest {
  action: 'prune-invalid'
  targets: BulkPruneTarget[]
}

export type BulkOperationRequest =
  | BulkProviderStateRequest
  | BulkModelStateRequest
  | BulkPruneRequest

/** 批量操作结果统计 */
export interface BulkOperationResult {
  action: BulkOperationAction
  providersUpdated: number
  modelsUpdated: number
  modelsRemoved: number
  keysRemoved: number
  missingProviderIds: string[]
}

export interface CreateProxyKeyRequest {
  name?: string
  expiresIn?: string // '30d' | '90d' | '180d' | '1y' | 'forever'
}

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  message?: string
}

export interface Env {
  KV: KVNamespace
  ADMIN_USERNAME?: string
  ADMIN_PASSWORD?: string
  OPENCODE_MIRRORS_URL?: string
}
