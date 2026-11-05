/**
 * 工具调用在 OrcaTerm 侧的两件事：
 *   1. 把 DSH 的工具定义翻译成模型能懂的提示（写进 emphasisPrompt）。
 *   2. 把 DSH 的工具结果回传给服务端（ACP input.type = "review"）。
 *
 * OrcaTerm 协议（实测结论，见 p0-tools-exp*.mjs）：
 *   1. 模型需要工具时输出原生信封：
 *      {"action":"review","ph_1":"--","tool":{"type":"ui","uiServer":"dsh-tools",
 *       "name":"read_file","description":"...","args":{...}}}
 *   2. 客户端本地执行工具（服务端不认识 dsh-tools，所以必须客户端执行）。
 *   3. 客户端把结果回传：
 *      POST /assistant/chat
 *      input: {type:"review", reviewAction:"reportToolResult", toolResult:"<结果文本>",
 *               tool:<原样回传 tool 对象>, id, emphasisPrompt:"", files:[]}
 *   4. 服务端把结果作为 type:"tool" 事件推回，模型基于结果继续回答。
 *
 * ⚠️ 关键：工具结果的回灌由本模块负责（服务端只在 reportToolResult 时才把结果
 * 喂给模型）。DSH 侧的 agent loop 会把工具结果也放进 options.messages，
 * 因此适配器要判断「本次调用是首次提问还是工具结果回灌」，避免重复回灌。
 */
import { createEnvelopeStreamer } from "./tool-stream.js";
import { buildToolPrompt, BRIDGE_SERVER } from "./tool-prompt.js";

/**
 * 从模型输出里解析出工具调用。
 *
 * @param {string} text 模型输出的完整文本。
 * @param {Set<string>} [allowedTools] 允许的工具名；不传则接受任何工具。
 * @returns {{ name: string, args: object, tool: object } | null} 解析结果。
 */
export function parseToolCall(text, allowedTools) {
  if (!text) return null;
  const s = createEnvelopeStreamer({ allowedTools });
  // 一次性喂入整段，解析器会自己找第一个工具信封
  for (const ch of text) {
    const r = s.feed(ch);
    if (r?.type === "tool") {
      return { name: r.name, args: r.args, tool: r.tool };
    }
  }
  return null;
}

/**
 * 构造工具结果的回传请求体。
 *
 * @param {object} params
 * @param {object} params.tool 原样回传的工具对象。
 * @param {string} params.toolResult 工具执行结果文本。
 * @param {string} params.seqId 本次请求的序列 id。
 * @returns {object} input 字段。
 */
export function buildToolResultInput({ tool, toolResult, seqId }) {
  return {
    type: "review",
    reviewAction: "reportToolResult",
    toolResult,
    tool,
    id: seqId,
    emphasisPrompt: "",
    files: [],
  };
}

/**
 * 生成注入到 emphasisPrompt 的工具说明。
 *
 * @param {Array<object>} tools DSH 工具定义。
 * @returns {string} 提示词；没有工具时返回空串。
 */
export function toolPromptFor(tools) {
  return buildToolPrompt(tools, { toolNamespace: BRIDGE_SERVER });
}

export { BRIDGE_SERVER };
