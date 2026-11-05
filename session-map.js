/**
 * 会话标识：把 DSH 会话映射为稳定的 OrcaTerm conversationId。
 *
 * OrcaTerm 服务端按 conversationId 维护上下文，因此同一个 DSH 会话必须始终
 * 使用同一个 id，才能让服务端记住历史。
 *
 * 取值顺序：
 *   1. options.sessionId —— LLM 运行时直接下发的当前会话 id（最准确）；
 *   2. ctx.agents.currentInitiator() —— 兜底，取不到 options 时的退路；
 *   3. 内容哈希 —— 最后退路，保证同一话题仍能续接。
 */
import { createHash } from "node:crypto";

/**
 * 从 Agent 上找会话 id 的常见字段名。
 */
const SESSION_ID_KEYS = ["sessionId", "id", "session"];

/**
 * 尝试从 Agent 上取会话 id。
 *
 * @param {object} agent DSH 的 Agent 实例。
 * @returns {string | undefined} 会话 id。
 */
export function sessionIdOf(agent) {
  if (!agent) return undefined;
  for (const key of SESSION_ID_KEYS) {
    const value = agent[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  // Agent 可能有 session 属性是对象
  const session = agent.session;
  if (session && typeof session === "object") {
    for (const key of SESSION_ID_KEYS) {
      const value = session[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return undefined;
}

/**
 * 归一化会话 id，去掉 DSH 内部的前缀，只保留稳定标识部分。
 *
 * DSH 的会话 id 形如 `session-<uuid>`，去掉前缀后各来源仍然唯一。
 *
 * @param {string} raw 原始会话 id。
 * @returns {string} 归一化后的标识。
 */
function normalize(raw) {
  return String(raw).replace(/^session-/, "");
}

/**
 * 创建一个会话标识解析器。
 *
 * @param {object} params
 * @param {() => object | undefined} params.currentAgent 取当前 Agent 的函数。
 * @returns {{ resolve: (options: object) => { cid: string, source: string } }}
 */
export function createSessionResolver({ currentAgent }) {
  /** 上一次用到的会话 id，用于取不到当前会话时保持稳定。 */
  let lastSessionId;

  /**
   * 解析本次调用应使用的 conversationId。
   *
   * @param {object} options LLM 运行时的调用参数，含 sessionId 与 messages。
   * @returns {{ cid: string, source: string }} 会话 id 与来源说明。
   */
  function resolve(options) {
    const opts = options || {};

    // 1. 运行时直接给的 sessionId —— 最准确
    if (typeof opts.sessionId === "string" && opts.sessionId.length > 0) {
      lastSessionId = opts.sessionId;
      return { cid: `cid-${normalize(opts.sessionId)}-orcaterm`, source: "options" };
    }

    // 2. 当前 Agent 的会话 id —— 兜底
    const agentId = sessionIdOf(currentAgent());
    if (agentId) {
      lastSessionId = agentId;
      return { cid: `cid-${normalize(agentId)}-orcaterm`, source: "session" };
    }

    // 3. 内容哈希 —— 最后退路，保证同一话题连续
    const text = String(lastUserText(opts.messages) ?? "");
    const digest = createHash("sha256").update(text).digest("hex").slice(0, 32);
    const seed = lastSessionId ? normalize(lastSessionId) : digest;
    return { cid: `cid-dsh-${seed}-orcaterm`, source: "fallback" };
  }

  return { resolve };
}

/** 取最后一条用户消息的文本。 */
function lastUserText(messages) {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n");
      if (text) return text;
    }
  }
  return undefined;
}
