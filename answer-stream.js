/**
 * 增量 JSON 信封解析器。
 *
 * OrcaTerm 返回的是 `{"action":"completion","taskCompletion":"...正文..."}` 这类信封，
 * 且内容以极小的碎片逐片到达。为了让正文能边到边显示，这里做流式提取：
 * 先定位目标键的字符串值起点，之后逐字符解码（含转义），把可确定的片段立即吐出。
 *
 * 设计要点：
 *   - 在 `\uXXXX` 或 `\` 转义不完整时，保留尾部待下一片，不产出半个字符；
 *   - 遇到未转义引号视为字符串结束；
 *   - 输入一旦确认不是 JSON（首字符非 { [），调用方应切回纯文本直通模式。
 */

/** 待提取的目标键，按优先级排列。 */
const ANSWER_KEYS = [
  "taskCompletion",
  "task_completion",
  "finalAnswer",
  "final_answer",
  "answer",
  "content",
  "message",
  "text",
  "result",
  "reply",
];

/**
 * 解码一个 JSON 字符串转义序列。
 *
 * @param {string} text 从反斜杠开始的内容。
 * @returns {{ value: string, length: number } | null} 解码结果与消耗长度；不完整时返回 null。
 */
export function decodeEscape(text) {
  if (text.length < 2) return null;
  const marker = text[1];
  switch (marker) {
    case '"':
      return { value: '"', length: 2 };
    case "\\":
      return { value: "\\", length: 2 };
    case "/":
      return { value: "/", length: 2 };
    case "b":
      return { value: "\b", length: 2 };
    case "f":
      return { value: "\f", length: 2 };
    case "n":
      return { value: "\n", length: 2 };
    case "r":
      return { value: "\r", length: 2 };
    case "t":
      return { value: "\t", length: 2 };
    case "u": {
      // 需要 4 位十六进制
      if (text.length < 6) return null;
      const hex = text.slice(2, 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
      return { value: String.fromCharCode(parseInt(hex, 16)), length: 6 };
    }
    default:
      // 未知转义：原样保留反斜杠与字符，避免丢内容
      return { value: text.slice(0, 2), length: 2 };
  }
}

/**
 * 创建一个流式正文提取器。
 *
 * 用法：反复 `feed(片段)`，把返回的文本立即 yield 出去；结束时调用 `flush()`。
 *
 * @param {object} [options]
 * @param {boolean} [options.insideValue] 调用方已经确认片段位于目标字符串值内部
 *   （比如上游已经定位到 `"taskCompletion":"` 之后）。此时跳过嗅探与定位，
 *   直接从解码阶段开始 —— 否则首字符不是 `{`，会被误判成纯文本，
 *   导致字符串结束后的 `"}` 也被当成正文吐出来。
 */
export function createAnswerStreamer({ insideValue = false } = {}) {
  /** 已收到但尚未消费的原始文本。 */
  let raw = "";

  /**
   * 当前阶段：
   *   sniff  —— 还在判断是否为 JSON 信封；
   *   seek   —— 是 JSON，正在找目标键的值起点；
   *   stream —— 已进入字符串值内部，逐字符解码；
   *   done   —— 字符串已结束。
   */
  let phase = insideValue ? "stream" : "sniff";

  /** 是否为纯文本直通模式（非信封）。 */
  let plain = false;

  /** 已产出的正文（用于最终兜底比对）。 */
  let emitted = "";

  /**
   * 判断当前累积内容是否像 JSON 信封。
   *
   * @returns {boolean | null} true=JSON, false=纯文本, null=还判断不了。
   */
  function looksLikeJson() {
    const t = raw.trimStart();
    if (t.length === 0) return null;
    // Markdown 围栏：跳过 ```json 或 ```
    if (t.startsWith("```")) {
      const nl = t.indexOf("\n");
      if (nl < 0) return null;
      const body = t.slice(nl + 1).trimStart();
      if (body.length === 0) return null;
      return body.startsWith("{") || body.startsWith("[");
    }
    if ("```".startsWith(t.slice(0, 3)) && t.length < 3) return null;
    return t.startsWith("{") || t.startsWith("[");
  }

  /** 去掉 Markdown 围栏前缀，便于后续按键查找。 */
  function stripFence() {
    const t = raw.trimStart();
    if (!t.startsWith("```")) return;
    const nl = t.indexOf("\n");
    if (nl < 0) return;
    raw = t.slice(nl + 1);
  }

  /** 在 raw 中定位目标键的字符串值起点；找不到返回 false。 */
  function locateValueStart() {
    for (const key of ANSWER_KEYS) {
      const needle = `"${key}"`;
      const at = raw.indexOf(needle);
      if (at < 0) continue;

      // needle 之后必须是 冒号（允许空白），再之后是 引号
      let i = at + needle.length;
      while (i < raw.length && /\s/.test(raw[i])) i += 1;
      if (raw[i] !== ":") continue;
      i += 1;
      while (i < raw.length && /\s/.test(raw[i])) i += 1;
      if (i >= raw.length) return false; // 还没到，等下一片
      if (raw[i] !== '"') continue;      // 值不是字符串，跳过该键

      raw = raw.slice(i + 1); // 丢掉到值引号为止的前缀
      return true;
    }

    // 键还没出现：若内容已经明显不是信封（比如超过一定长度仍无目标键），
    // 交给调用方在结束时兜底，这里继续等
    return false;
  }

  /**
   * 喂入新片段，返回可立即产出的文本。
   *
   * @param {string} piece 新到达的文本。
   * @returns {{ type: "plain", text: string } | { type: "answer", text: string } | null}
   */
  function feed(piece) {
    if (!piece) return null;

    if (phase === "done") {
      // 字符串已结束，后续内容（如 "action":"completion"} ）忽略
      return null;
    }

    raw += piece;

    if (phase === "sniff") {
      const verdict = looksLikeJson();
      if (verdict === null) return null;
      if (verdict === false) {
        plain = true;
        phase = "stream";
        const out = raw;
        emitted += out;
        raw = "";
        return { type: "plain", text: out };
      }
      phase = "seek";
      stripFence();
    }

    if (phase === "seek") {
      if (!locateValueStart()) return null;
      phase = "stream";
    }

    // phase === "stream"：逐字符解码，直到遇到未转义的引号
    let out = "";
    let i = 0;

    while (i < raw.length) {
      const ch = raw[i];

      if (ch === '"') {
        // 字符串结束
        phase = "done";
        i += 1;
        break;
      }

      if (ch === "\\") {
        const decoded = decodeEscape(raw.slice(i));
        if (decoded === null) break; // 转义不完整，等下一片
        out += decoded.value;
        i += decoded.length;
        continue;
      }

      out += ch;
      i += 1;
    }

    raw = raw.slice(i);

    if (out.length > 0) {
      emitted += out;
      return { type: "answer", text: out };
    }
    return null;
  }

  /**
   * 流结束时的收尾。
   *
   * 如果一直没进入正文提取（比如信封格式不标准），退回原始文本，
   * 保证不会因为解析失败而丢掉模型的回答。
   *
   * @returns {{ text: string, fallback: boolean }}
   */
  function flush() {
    if (plain) return { text: "", fallback: false };
    if (emitted.length > 0) return { text: "", fallback: false };

    // 一条正文都没吐出来：把原始内容整体交回，由调用方用 extractAnswer 兜底
    return { text: raw, fallback: true };
  }

  return {
    feed,
    flush,
    get emitted() {
      return emitted;
    },
    get finished() {
      return phase === "done" || plain;
    },
  };
}
