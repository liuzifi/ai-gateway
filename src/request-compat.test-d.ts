/**
 * 请求体兼容性编译期测试（type-level tests）
 *
 * 项目未引入运行时测试框架，本文件通过 `tsc --noEmit` 完成断言：
 * - 正例使用 `satisfies ProxyRequestBody`，与真实调用点的字面量推断一致；
 * - 负例使用一行式 `Accepts<...>` 配合 `@ts-expect-error`，保证报错位置可预测。
 *
 * 本文件不被 `src/index.ts` 引用，不会进入 Worker 产物。
 */

import type {
  AnthropicTool,
  AnthropicToolChoice,
  ChatAssistantMessage,
  ChatContentPart,
  ChatFunctionTool,
  ChatMessage,
  ChatToolMessage,
  ProxyRequestBody,
  ResponseFormat,
  StreamOptions,
} from './types'

/** 约束式断言：T 必须可赋值给 ProxyRequestBody，否则在本行报错 */
type Accepts<T extends ProxyRequestBody> = T

/** 约束式断言：T 必须可赋值给 ChatMessage */
type AcceptsMessage<T extends ChatMessage> = T

// ── 1. 兼容既有调用点：最小请求体（proxy.ts / admin.ts / opencode.ts 内联字面量） ──

const legacyMinimalRequest = {
  model: 'openai/gpt-4o-mini',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 1,
} satisfies ProxyRequestBody

// ── 2. stream 与 stream_options ──

const streamingRequest = {
  model: 'openai/gpt-4o',
  messages: [{ role: 'user', content: '讲个笑话' }],
  stream: true,
  stream_options: { include_usage: true },
} satisfies ProxyRequestBody

const nonStreamingRequest = {
  model: 'openai/gpt-4o',
  messages: [{ role: 'user', content: 'hi' }],
  stream: false,
  stream_options: null,
} satisfies ProxyRequestBody

const streamOptionsPassthrough = {
  include_usage: true,
  include_obfuscation: false,
  // 未知字段沿索引签名透传
  vendor_flag: 'x',
} satisfies StreamOptions

// @ts-expect-error stream 必须是布尔值
type _BadStream = Accepts<{ stream: 'true' }>

// ── 3. system message（消息角色形式 + Anthropic 顶层形式） ──

const systemRoleRequest = {
  model: 'openai/gpt-4o',
  messages: [
    { role: 'system', content: '你是一个严谨的助手' },
    { role: 'user', content: '你好' },
  ],
} satisfies ProxyRequestBody

const developerRoleRequest = {
  model: 'openai/o3-mini',
  messages: [
    { role: 'developer', content: '按 JSON 输出' },
    { role: 'user', content: 'ping' },
  ],
} satisfies ProxyRequestBody

const anthropicTopLevelSystemRequest = {
  model: 'anthropic/claude-sonnet-4',
  system: '你是一个严谨的助手',
  max_tokens: 1024,
  messages: [{ role: 'user', content: '你好' }],
} satisfies ProxyRequestBody

const anthropicSystemBlocksRequest = {
  model: 'anthropic/claude-sonnet-4',
  system: [{ type: 'text', text: '你是一个严谨的助手' }],
  max_tokens: 1024,
  messages: [{ role: 'user', content: '你好' }],
} satisfies ProxyRequestBody

// ── 4. 多模态 content ──

const multimodalRequest = {
  model: 'openai/gpt-4o',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: '这两张图有什么区别？' },
        { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' },
        },
        { type: 'input_audio', input_audio: { data: 'AAAA', format: 'mp3' } },
        { type: 'file', file: { filename: 'a.pdf', file_data: 'AAAA' } },
      ],
    },
  ],
} satisfies ProxyRequestBody

const anthropicMultimodalRequest = {
  model: 'anthropic/claude-sonnet-4',
  max_tokens: 1024,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: '描述这张图' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
        },
      ],
    },
  ],
} satisfies ProxyRequestBody

const refusalContentPart = { type: 'refusal', refusal: '无法回答' } satisfies ChatContentPart

// @ts-expect-error image_url 必须是对象而非字符串
type _BadImagePart = Accepts<{ messages: [{ role: 'user'; content: [{ type: 'image_url'; image_url: 'https://x' }] }] }>

// @ts-expect-error input_audio.format 只允许 wav / mp3
type _BadAudioFormat = Accepts<{ messages: [{ role: 'user'; content: [{ type: 'input_audio'; input_audio: { data: 'A'; format: 'ogg' } }] }] }>

// ── 5. tools 与 tool_choice ──

const openAIFunctionTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: '查询天气',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
    strict: true,
  },
} satisfies ChatFunctionTool

const anthropicTool = {
  name: 'get_weather',
  description: '查询天气',
  input_schema: {
    type: 'object',
    properties: { city: { type: 'string' } },
  },
} satisfies AnthropicTool

const toolCallRequest = {
  model: 'openai/gpt-4o',
  messages: [{ role: 'user', content: '北京天气' }],
  tools: [openAIFunctionTool],
  tool_choice: 'auto',
  parallel_tool_calls: true,
} satisfies ProxyRequestBody

const namedToolChoiceRequest = {
  model: 'openai/gpt-4o',
  messages: [{ role: 'user', content: '北京天气' }],
  tools: [openAIFunctionTool],
  tool_choice: { type: 'function', function: { name: 'get_weather' } },
} satisfies ProxyRequestBody

const allowedToolsChoiceRequest = {
  model: 'openai/gpt-4o',
  messages: [{ role: 'user', content: '北京天气' }],
  tools: [openAIFunctionTool],
  tool_choice: {
    type: 'allowed_tools',
    allowed_tools: {
      mode: 'required',
      tools: [{ type: 'function', function: { name: 'get_weather' } }],
    },
  },
} satisfies ProxyRequestBody

const anthropicToolRequest = {
  model: 'anthropic/claude-sonnet-4',
  max_tokens: 1024,
  messages: [{ role: 'user', content: '北京天气' }],
  tools: [anthropicTool],
  tool_choice: { type: 'tool', name: 'get_weather' },
} satisfies ProxyRequestBody

const anthropicAnyToolChoice = {
  type: 'any',
  disable_parallel_tool_use: true,
} satisfies AnthropicToolChoice

/** assistant 回填 tool_calls，随后由 tool 消息给出结果 */
const toolRoundTripRequest = {
  model: 'openai/gpt-4o',
  messages: [
    { role: 'user', content: '北京天气' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"北京"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"temp":25}' },
  ],
  tools: [openAIFunctionTool],
} satisfies ProxyRequestBody

/** 旧版 function_call / function 角色仍需可表达 */
const legacyFunctionCallRequest = {
  model: 'openai/gpt-3.5-turbo',
  messages: [
    { role: 'user', content: '北京天气' },
    {
      role: 'assistant',
      content: null,
      function_call: { name: 'get_weather', arguments: '{"city":"北京"}' },
    },
    { role: 'function', name: 'get_weather', content: '{"temp":25}' },
  ],
} satisfies ProxyRequestBody

/** Anthropic 的 tool_use / tool_result 内容块 */
const anthropicToolResultRequest = {
  model: 'anthropic/claude-sonnet-4',
  max_tokens: 1024,
  messages: [
    { role: 'user', content: '北京天气' },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '北京' } },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [{ type: 'text', text: '{"temp":25}' }],
        },
      ],
    },
  ],
} satisfies ProxyRequestBody

// @ts-expect-error tool_choice 不存在 always 取值
type _BadToolChoice = Accepts<{ tool_choice: 'always' }>

// @ts-expect-error tool 消息必须携带 tool_call_id
type _MissingToolCallId = AcceptsMessage<{ role: 'tool'; content: 'ok' }>

// ── 6. response_format ──

const textFormatRequest = {
  model: 'openai/gpt-4o',
  messages: [{ role: 'user', content: 'hi' }],
  response_format: { type: 'text' },
} satisfies ProxyRequestBody

const jsonObjectFormatRequest = {
  model: 'openai/gpt-4o',
  messages: [{ role: 'user', content: '输出 JSON' }],
  response_format: { type: 'json_object' },
} satisfies ProxyRequestBody

const jsonSchemaFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'weather',
    description: '天气结构化输出',
    strict: true,
    schema: {
      type: 'object',
      properties: { temp: { type: 'number' } },
      required: ['temp'],
      additionalProperties: false,
    },
  },
} satisfies ResponseFormat

const jsonSchemaFormatRequest = {
  model: 'openai/gpt-4o',
  messages: [{ role: 'user', content: '输出结构化天气' }],
  response_format: jsonSchemaFormat,
} satisfies ProxyRequestBody

// @ts-expect-error response_format 不存在 json 取值
type _BadResponseFormat = Accepts<{ response_format: { type: 'json' } }>

// @ts-expect-error json_schema 必须提供 name
type _MissingSchemaName = Accepts<{ response_format: { type: 'json_schema'; json_schema: { schema: {} } } }>

// ── 7. 采样参数、上游私有字段与非 chat 端点 ──

const samplingRequest = {
  model: 'openai/gpt-4o',
  messages: [{ role: 'user', content: 'hi' }],
  temperature: 0.7,
  top_p: 0.9,
  top_k: 40,
  n: 1,
  seed: 42,
  stop: ['\n\n'],
  stop_sequences: ['</done>'],
  presence_penalty: 0,
  frequency_penalty: 0,
  logit_bias: { '1234': -100 },
  logprobs: true,
  top_logprobs: 5,
  max_completion_tokens: 2048,
  user: 'u-1',
  metadata: { trace: 'abc' },
  // 未声明的上游私有字段沿索引签名透传
  enable_thinking: true,
  chat_template_kwargs: { thinking: false },
} satisfies ProxyRequestBody

const completionsRequest = {
  model: 'openai/gpt-3.5-turbo-instruct',
  prompt: '写一句诗',
  max_tokens: 32,
} satisfies ProxyRequestBody

// ── 8. 消息类型可被判别联合正确窄化 ──

function narrowMessage(message: ChatMessage): string {
  switch (message.role) {
    case 'assistant': {
      const assistant: ChatAssistantMessage = message
      const firstCall = assistant.tool_calls?.[0]
      return firstCall ? firstCall.function.name : ''
    }
    case 'tool': {
      const tool: ChatToolMessage = message
      return tool.tool_call_id
    }
    case 'system':
    case 'developer':
    case 'user':
      return typeof message.content === 'string' ? message.content : message.content.length.toString()
    case 'function':
      return message.name
  }
}

// @ts-expect-error 非法 role 必须被拒绝
type _BadRole = AcceptsMessage<{ role: 'moderator'; content: 'x' }>

// 显式引用，避免 “声明未使用” 类检查在未来开启时报错
export const __requestCompatFixtures = {
  legacyMinimalRequest,
  streamingRequest,
  nonStreamingRequest,
  streamOptionsPassthrough,
  systemRoleRequest,
  developerRoleRequest,
  anthropicTopLevelSystemRequest,
  anthropicSystemBlocksRequest,
  multimodalRequest,
  anthropicMultimodalRequest,
  refusalContentPart,
  openAIFunctionTool,
  anthropicTool,
  toolCallRequest,
  namedToolChoiceRequest,
  allowedToolsChoiceRequest,
  anthropicToolRequest,
  anthropicAnyToolChoice,
  toolRoundTripRequest,
  legacyFunctionCallRequest,
  anthropicToolResultRequest,
  textFormatRequest,
  jsonObjectFormatRequest,
  jsonSchemaFormat,
  jsonSchemaFormatRequest,
  samplingRequest,
  completionsRequest,
  narrowMessage,
}

export type __RequestCompatTypeChecks = [
  _BadStream,
  _BadImagePart,
  _BadAudioFormat,
  _BadToolChoice,
  _MissingToolCallId,
  _BadResponseFormat,
  _MissingSchemaName,
  _BadRole,
]
