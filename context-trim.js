/**
 * 上下文裁剪与超限处理。
 *
 * 背景（实测结论，见 p0-ctx-tiers.mjs / p0-ctx-scan.mjs / p0-ctx-reliable.mjs）：
 *
 *   1. 服务端容量远大于预期：30 万 / 60 万 / 120 万字符三档全部 HTTP 200，
 *      首尾埋点都能读到，说明**既不超限也不静默截断**。
 *
 *   2. 真正的瓶颈是模型注意力，不是传输。600k 字符文档的位置扫描：
 *      1%~5% ✅、10%~90% ❌、95%~100% ✅ —— 典型的 lost-in-the-middle。
 *      长度递增测试显示可靠区间约 200,000 字符，400k 起中部开始丢失。
 *
 *   3. 超限时服务端仍会返回错误，特征为 context_length_exceeded /
 *      too many tokens / prompt is too long，用户提示「请新建会话或精简输入」。
 *
 * 所以策略是：
 *   1. 本地主动裁剪，把历史压在实测可靠区间内 —— 超出的部分模型本来也读不进去；
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
 * 完整的实测结论（p0-ctx-tiers.mjs / p0-ctx-scan.mjs / p0-ctx-reliable.mjs）：
 *
 *   容量：服务端容量很大。256k / 500k / 1M token 三档（对应 30 万 / 60 万 /
 *   120 万字符）全部 HTTP 200 且首尾内容都能读到 —— 说明既没超限，
 *   也没有静默截断。
 *
 *   但可靠检索的上限是约 200,000 字符。600k 字符文档的位置扫描显示：
 *   1%~5% 能读到、10%~90% 全部丢失、95%~100% 又能读到。
 *   长度递增测试进一步确认：20k/50k/100k/200k 三个位置都可靠，
 *   到 400k 中部开始丢失。这是模型的 lost-in-the-middle 现象，
 *   与 OrcaTerm 的传输无关。
 *
 * 因此阈值取 200,000 —— 用满实测可靠区间，超出后模型本来也会漏读中间内容，
 * 留下的历史再多也是浪费。留出余量给工具说明（约 4k）与本轮新增内容。
 */
const TRIM_THRESHOLD_CHARS = 200_000;

/** 裁剪后希望保留的字符预算。 */
const TRIM_TARGET_CHARS = 100_000;

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
