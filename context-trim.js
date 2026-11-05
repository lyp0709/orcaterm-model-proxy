/**
 * 上下文裁剪与超限处理。
 *
 * 背景（实测结论，见 p0-context-limit.mjs / p0-context-truncate2.mjs）：
 *   - OrcaTerm 的上下文相当宽松：260,000 字符（约 17 万 token）仍然正常工作，
 *     且**不做静默截断**（10 章文档里第 1 章和第 10 章的标记内容模型都能读到）。
 *   - 但宽松不等于无限。超限时服务端会返回错误，前端识别特征为
 *     `context_length_exceeded` / `too many tokens` / `prompt is too long`
 *     等，对应的用户提示是「请新建会话或精简输入后重试」。
 *
 * 所以策略是：
 *   1. 本地主动裁剪，在接近上限前就削减历史，避免撞上服务端错误；
 *   2. 万一服务端仍然报超限，翻译成可操作的提示，而不是抛出费解的错误码。
 *
 * 裁剪原则：
 *   - 保留 system 消息（系统提示不能丢）
 *   - 保留最近的若干条消息（模型需要即时上下文）
 *   - 保留最近的工具调用与结果配对（半对会破坏协议）
 *   - 从最老的开始丢，但**不在工具调用中间切断**
 */

/**
 * 触发裁剪的字符阈值。
 *
 * 实测 260k 仍工作，这里取 120k 作为安全水位：
 * 留足余量给本轮新增内容、工具说明（约 4k）和模型输出。
 */
const TRIM_THRESHOLD_CHARS = 120_000;

/** 裁剪后希望保留的字符预算。 */
const TRIM_TARGET_CHARS = 60_000;

/** 无论如何都保留的最近消息条数。 */
const KEEP_RECENT_MESSAGES = 8;

/**
 * 估算一条消息的字符数。
 *
 * DSH 的 content 是块数组；只统计文本与工具调用参数，
 * 图片另有 input.files 通道，不占文本上下文。
 *
 * @param {object} message 一条消息。
 * @returns {number} 字符数。
 */
function messageChars(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  let total = 0;
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") total += b.text.length;
    else if (b.type === "reasoning" && typeof b.text === "string") total += b.text.length;
    else if (b.type === "tool-call") total += String(b.arguments ?? "").length + String(b.name ?? "").length;
  }
  // 工具结果消息也可能用字符串 content
  if (typeof message?.content === "string") total += message.content.length;
  return total;
}

/**
 * 计算消息列表的总字符数。
 *
 * @param {Array<object>} messages 消息列表。
 * @returns {number} 总字符数。
 */
export function totalChars(messages) {
  let total = 0;
  for (const m of Array.isArray(messages) ? messages : []) total += messageChars(m);
  return total;
}

/**
 * 判断一条消息是否是工具相关（tool-call 或 tool 角色）。
 *
 * 工具调用与结果必须成对保留，否则协议会坏。
 *
 * @param {object} message 消息。
 * @returns {boolean} 相关返回 true。
 */
function isToolRelated(message) {
  if (!message) return false;
  if (message.role === "tool") return true;
  const content = Array.isArray(message.content) ? message.content : [];
  return content.some((b) => b && b.type === "tool-call");
}

/**
 * 裁剪消息历史，使其不超过字符预算。
 *
 * 没有超出阈值时**原样返回**（不做任何处理），避免无谓的改动。
 *
 * @param {Array<object>} messages 原始消息列表。
 * @param {object} [options]
 * @param {number} [options.threshold] 触发阈值，默认 120k 字符。
 * @param {number} [options.target] 目标预算，默认 60k 字符。
 * @param {number} [options.keepRecent] 至少保留的最近条数，默认 8。
 * @returns {{ messages: Array<object>, trimmed: boolean, dropped: number, beforeChars: number, afterChars: number }}
 */
export function trimHistory(messages, { threshold = TRIM_THRESHOLD_CHARS, target = TRIM_TARGET_CHARS, keepRecent = KEEP_RECENT_MESSAGES } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const beforeChars = totalChars(list);

  const result = { messages: list, trimmed: false, dropped: 0, beforeChars, afterChars: beforeChars };
  if (beforeChars <= threshold) return result;

  // 1. 分离必须保留的前缀（system/developer）与其余部分
  const head = [];
  let start = 0;
  while (start < list.length) {
    const role = list[start]?.role;
    if (role === "system" || role === "developer") {
      head.push(list[start]);
      start += 1;
    } else break;
  }

  // 2. 先无条件保留最近 keepRecent 条（对话连贯性比字符预算更重要）
  const tail = [];
  let tailChars = totalChars(head);
  let cutIndex = list.length;

  const hardKeep = Math.min(keepRecent, list.length - start);
  const hardKeepFrom = list.length - hardKeep;
  for (let i = hardKeepFrom; i < list.length; i += 1) {
    tail.push(list[i]);
    tailChars += messageChars(list[i]);
  }
  cutIndex = hardKeepFrom;

  // 3. 在字符预算内继续向前扩充（保留更早的上下文）
  while (cutIndex > start) {
    const candidate = list[cutIndex - 1];
    const chars = messageChars(candidate);
    if (tailChars + chars > target) break;
    tail.unshift(candidate);
    tailChars += chars;
    cutIndex -= 1;
  }

  // 4. 不要从工具调用中间切断：若保留区首条是 tool 结果，向前补齐发起它的消息
  while (cutIndex > start && list[cutIndex] && list[cutIndex].role === "tool") {
    cutIndex -= 1;
    if (list[cutIndex]) {
      tail.unshift(list[cutIndex]);
      tailChars += messageChars(list[cutIndex]);
    }
  }

  const kept = [...head, ...tail];
  const dropped = list.length - kept.length;
  const afterChars = totalChars(kept);

  return { messages: kept, trimmed: dropped > 0, dropped, beforeChars, afterChars };
}

/**
 * 判断一段服务端错误文本是否为「上下文超限」。
 *
 * 正则取自 OrcaTerm 前端识别逻辑，覆盖各家模型的常见表述。
 *
 * @param {string} text 错误文本。
 * @returns {boolean} 是上下文超限返回 true。
 */
export function isContextOverflowError(text) {
  const t = String(text ?? "");
  if (!t) return false;
  return /context[\s_-]?(?:length|window)|max(?:imum)? context|context_length_exceeded|too many tokens|prompt is too long|token (?:limit|budget) (?:exceeded|reached)|input tokens? exceed|tokens? exceed(?:s|ed)? the (?:configured|maximum|max) (?:limit|number)|resulted in \d+ tokens|reduce the length of the (?:messages|input|prompt)|超出.{0,6}上下文|上下文.{0,4}上限/i.test(
    t,
  );
}

/**
 * 生成「上下文超限」的用户可读提示。
 *
 * @param {object} [info]
 * @param {number} [info.beforeChars] 裁剪前字符数。
 * @param {boolean} [info.trimmed] 是否已尝试裁剪。
 * @returns {string} 提示文本。
 */
export function contextLimitMessage({ beforeChars, trimmed } = {}) {
  const parts = ["输入已超出模型的上下文上限。"];
  if (typeof beforeChars === "number" && beforeChars > 0) {
    parts.push(`本次输入约 ${beforeChars.toLocaleString()} 字符。`);
  }
  if (trimmed) {
    parts.push("插件已尝试自动精简历史，但仍超出。");
  }
  parts.push("建议新建会话，或让我精简当前需求后重试。");
  return parts.join("");
}

export { TRIM_THRESHOLD_CHARS, TRIM_TARGET_CHARS, KEEP_RECENT_MESSAGES, messageChars };
