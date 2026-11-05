/**
 * OrcaTerm 回复信封的统一流式解析器。
 *
 * 实测结论（见 p0-tools-exp*.mjs、llm-contract-notes.md）：
 *   1. 服务端会忽略 `user.setting.tools` 传入的 OpenAI 格式定义，
 *      模型只能看到服务端内置工具（execute_command / fetch / ...）。
 *   2. `input.emphasisPrompt` 是服务端认可的系统位。工具说明放在这里时，
 *      不会被判定为 prompt injection，模型会照着描述输出工具调用信封。
 *   3. 工具调用信封形如：
 *        {"action":"review","ph_1":"--","tool":{"type":"ui","uiServer":"dsh-tools",
 *         "name":"read_file","description":"...","args":{"path":"..."}}}
 *   4. 普通回答形如：
 *        {"action":"completion","ph_1":"--","taskCompletion":"正文"}
 *
 * 本模块在流式过程中区分这两种信封：
 *   - 命中工具信封 → 产出 { type: "tool", name, args, tool }
 *   - 命中正文信封 → 逐块产出 { type: "text", text }
 *   - 不是 JSON     → 纯文本直通，产出 { type: "text", text }
 */
import { createAnswerStreamer } from "./answer-stream.js";

/**
 * 找到 `"<key>": "<字符串值>"` 中值内容起始位置。
 *
 * @param {string} text 待扫描文本。
 * @param {string} key 目标键名。
 * @returns {number} 值内容的起始下标；未找到返回 -1。
 */
function findStringValueStart(text, key) {
  const re = new RegExp(`"${key}"\\s*:\\s*"`);
  const m = re.exec(text);
  if (!m) return -1;
  return m.index + m[0].length;
}

/**
 * 找到 `"tool": {` 中 `{` 的下标。
 *
 * @param {string} text 待扫描文本。
 * @returns {number} `{` 的下标；未找到返回 -1。
 */
function findToolObjectStart(text) {
  const re = /"tool"\s*:\s*\{/g;
  const m = re.exec(text);
  if (!m) return -1;
  return m.index + m[0].length - 1;
}

/**
 * 从 `{` 开始做花括号配对，跳过字符串字面量里的花括号。
 *
 * @param {string} text 待扫描文本。
 * @param {number} start 起始 `{` 的下标。
 * @returns {{ raw: string, end: number } | null} 配对完整时返回结果，否则 null。
 */
function matchBraces(text, start) {
  if (text[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { raw: text.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
}

/**
 * 从工具对象里取出工具名与参数。
 *
 * @param {object} toolObj 信封中的 tool 对象。
 * @returns {{ name: string, args: object } | null} 解析结果；无效时 null。
 */
export function readTool(toolObj) {
  if (!toolObj || typeof toolObj !== "object") return null;
  const name = typeof toolObj.name === "string" ? toolObj.name : "";
  if (!name) return null;
  const args =
    toolObj.args && typeof toolObj.args === "object" && !Array.isArray(toolObj.args)
      ? toolObj.args
      : {};
  return { name, args };
}

/**
 * 纯文本模式下用于探测信封边界的保留长度。
 *
 * 模型有时会先输出一段自然语言，再补一个 JSON 信封。
 * 纯文本路径需要据此截断，避免把信封原文也当成回答吐给用户。
 */
const PLAIN_GUARD = 16;

/**
 * DSML 风格的工具调用标记。
 *
 * deepseek-v4.1-flash 偶尔不输出 JSON 信封，而输出这种类 XML 的调用块：
 *   <｜｜DSML｜｜ calls>
 *   <｜｜DSML｜｜ invoke name="ask_user_question">
 *   <｜｜DSML｜｜ parameter name="question">...</｜｜DSML｜｜ parameter>
 *   </｜｜DSML｜｜ invoke>
 *   </｜｜DSML｜｜ calls>
 *
 * 这类内容绝不能当正文展示给用户。用宽松正则匹配（竖线可能是全角/半角、
 * 间隔符可能不同），命中后整段丢弃。
 */
const DSML_START = /<[|｜\u01C0\u2223]{2}\s*DSML\s*[|｜\u01C0\u2223]{2}/i;

/** 判断文本里是否出现 DSML 调用标记。 */
function hasDsml(text) {
  return DSML_START.test(String(text ?? ""));
}

/**
 * 从 DSML 块里尽量解析出工具名与参数。
 *
 * 只做「尽力而为」—— 格式细节未经完整验证，解析失败就丢弃不做展示，
 * 至少不会把原始标记吐给用户。
 *
 * @param {string} text 原始文本。
 * @returns {{ name: string, args: object } | null} 解析结果。
 */
function parseDsmlCall(text) {
  const src = String(text ?? "");
  // 工具名：invoke name="xxx"
  const nameMatch = src.match(/invoke\s+name\s*=\s*["']([^"']+)["']/i);
  if (!nameMatch) return null;
  const name = nameMatch[1].trim();
  if (!name) return null;

  /**
   * 必须等到整个调用块闭合才算解析完成。
   *
   * 否则逐字符流式到达时，会在参数尚未出现时就返回空 args，
   * 导致工具被调用但什么参数都没传。
   */
  const closed = /<\/[|｜\u01C0\u2223]{2}\s*DSML\s*[|｜\u01C0\u2223]{2}\s*invoke\s*>/i.test(src);
  if (!closed) return null;

  // 参数：parameter name="k">值<...parameter>
  const args = {};
  const re = /parameter\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/[|｜\u01C0\u2223]{2}\s*DSML\s*[|｜\u01C0\u2223]{2}\s*parameter>/gi;
  let m;
  while ((m = re.exec(src))) {
    const key = m[1].trim();
    const raw = m[2].trim();
    if (!key) continue;
    // 尝试按 JSON 解析值，失败就当字符串
    try {
      args[key] = JSON.parse(raw);
    } catch {
      args[key] = raw;
    }
  }

  return { name, args };
}

/**
 * 从可能被截断的 JSON 文本里尽量取出某个键的字符串值。
 *
 * 流意外中断时信封往往不完整，直接 JSON.parse 会失败。
 * 这里只做「尽力而为」的提取，失败返回空串。
 *
 * @param {string} text 原始文本。
 * @param {string} key 目标键名。
 * @returns {string} 提取到的文本（可能不完整）；无法提取时为空串。
 */
function extractPartialString(text, key) {
  const start = findStringValueStart(text, key);
  if (start < 0) return "";
  let out = "";
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') break;
    if (ch === "\\") {
      const marker = text[i + 1];
      if (marker === undefined) break;
      const simple = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f" };
      if (marker === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 5;
        continue;
      }
      if (marker in simple) {
        out += simple[marker];
        i += 1;
        continue;
      }
      out += marker;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * 创建统一的信封解析器。
 *
 * @param {object} [options]
 * @param {Set<string>} [options.allowedTools] 允许的工具名集合。
 *   命中集合外的工具信封会被跳过，继续往后找下一个信封。
 * @returns {{
 *   feed: (piece: string) => ({ type: "tool", name: string, args: object, tool: object } | { type: "text", text: string } | null),
 *   flush: () => { text: string, fallback: boolean },
 *   get tool: ({ name: string, args: object, tool: object } | null),
 *   get isPlain: boolean,
 * }}
 */
export function createEnvelopeStreamer({ allowedTools } = {}) {
  /** 已累积但尚未消费的原始文本。 */
  let raw = "";
  /**
   * 阶段：
   *   sniff —— 判断是不是 JSON 信封；
   *   plain —— 看起来是自然语言，但保留一小段尾巴用于探测后续信封；
   *   gate  —— 是 JSON，正在判断是工具信封还是正文信封；
   *   answer—— 已确认是正文，走 answer-stream 的增量提取。
   */
  let phase = "sniff";
  /** 正文提取器，在进入 answer 阶段时创建。 */
  let answer = null;
  /** 已识别出的工具调用（只保留第一个）。 */
  let toolResult = null;
  /** 纯文本直通标记。 */
  let plain = false;
  /** 纯文本模式下尚未吐出的缓冲。 */
  let plainBuffer = "";
  /** 正文先于信封产出时暂存的信封结果。 */
  let pendingGateOut = null;
  /**
   * 是否抑制 completion 信封的正文。
   *
   * 模型有时会先输出整段自然语言，再补一个
   * {"action":"completion","taskCompletion":"<同一段文字>"}。
   * 此时前面已经吐过正文了，信封里的内容不能再吐，否则回答整段重复。
   */
  let gateSuppressed = false;
  /** 纯文本模式下已放行的实义字符数（诊断用）。 */
  let plainEmitted = 0;
  /**
   * 是否已经把自然语言正文给过用户。
   *
   * 模型有时先输出整段纯文本，再补一个
   * {"action":"completion","taskCompletion":"<同一段文字>"}。
   * 此时信封里的内容绝不能再吐一遍，否则回答整段重复。
   */
  let headEmitted = false;

  /** 判断累积内容是否像 JSON 信封。 */
  function looksLikeJson() {
    const t = raw.trimStart();
    if (t.length === 0) return null;
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

  /** 去掉 Markdown 围栏前缀。 */
  function stripFence() {
    const t = raw.trimStart();
    if (!t.startsWith("```")) return;
    const nl = t.indexOf("\n");
    if (nl < 0) return;
    raw = t.slice(nl + 1);
  }

  /**
   * 尝试把当前 raw 解析成一个工具信封。
   *
   * @returns {{ done: boolean, tool?: { name: string, args: object, tool: object }, skipTo?: number }}
   *   done=true 表示已得出结论（找到工具 / 确认此处没有工具信封）。
   */
  function tryTool() {
    const braceAt = findToolObjectStart(raw);
    // 这里根本没有 tool 键：正文信封，直接继续往下走
    if (braceAt < 0) return { done: true };

    const matched = matchBraces(raw, braceAt);
    if (!matched) return { done: false }; // 还没收全，等下一片

    let obj = null;
    try {
      obj = JSON.parse(matched.raw);
    } catch {}

    const parsed = readTool(obj);
    if (!parsed) return { done: true, skipTo: matched.end };

    if (allowedTools && allowedTools.size > 0 && !allowedTools.has(parsed.name)) {
      // 不是我们注册的工具（多半是服务端内置工具），跳过这个信封继续找
      return { done: true, skipTo: matched.end };
    }

    return {
      done: true,
      tool: { name: parsed.name, args: parsed.args, tool: obj },
      skipTo: matched.end,
    };
  }

  /**
   * 纯文本模式下的处理：延迟一小段尾巴，探测后面是否跟着 JSON 信封。
   *
   * 模型有时会先写一段自然语言，再补一个 JSON 信封。若不处理，
   * 信封原文会被当成回答一起吐给用户。
   *
   * 关键设计：检测到信封时**立刻**把信封之前的内容（head）交出去，
   * 然后把信封本体留在 raw 里交给 gate 阶段慢慢收全并判定类型。
   * 不能在还没收全时就猜测类型 —— 那样会漏掉工具调用。
   *
   * @param {string} piece 新到达的文本。
   * @returns {{ type: "text", text: string } | null} 可立即产出的文本。
   */
  function feedPlain(piece) {
    plainBuffer += piece;

    // DSML 调用块：解析出完整调用才处理，绝不把原始标记展示给用户。
    if (hasDsml(plainBuffer)) {
      const parsed = parseDsmlCall(plainBuffer);
      // 还没解析出完整调用：继续等后续片段（先不放行这段，否则会丢标记）
      if (!parsed) return null;

      if (!allowedTools || allowedTools.size === 0 || allowedTools.has(parsed.name)) {
        toolResult = {
          name: parsed.name,
          args: parsed.args,
          tool: { type: "ui", name: parsed.name, args: parsed.args },
        };
        plainBuffer = "";
        phase = "done";
        return { type: "tool", name: toolResult.name, args: toolResult.args, tool: toolResult.tool };
      }

      // 解析出了工具名但不在白名单：整段剥掉，不留痕迹
      plainBuffer = plainBuffer
        .replace(/<[|｜\u01C0\u2223]{2}[\s\S]*?(<\/[|｜\u01C0\u2223]{2}\s*DSML[^>]*>|$)/gi, "")
        .trim();
      return null;
    }

    // 找信封起点
    const at = plainBuffer.search(/\{\s*"(action|tool|taskCompletion)"/);
    if (at >= 0) {
      // 信封之前的内容是真正的正文
      const head = plainBuffer.slice(0, at);
      // 信封本体留下来，交给 gate 阶段判定
      raw = plainBuffer.slice(at);
      plainBuffer = "";
      phase = "gate";
      stripFence();
      // 记下「正文已经给过用户」，供 gate 判定 completion 是否重复
      if (plainEmitted > 0 || head.trim().length > 0) headEmitted = true;
      return head ? { type: "text", text: head } : null;
    }

    // 保留一小段尾巴，防止信封被切断。
    //
    // 不能无脑放行全部缓冲：否则后面到达的信封检测不到，
    // completion 里的 taskCompletion 会被当成第二份正文吐出去（实测问题）。
    if (plainBuffer.length > PLAIN_GUARD) {
      let cut = plainBuffer.length - PLAIN_GUARD;
      // 不要在 `{` 之前切断：JSON 信封可能刚好从这里开始
      const brace = plainBuffer.lastIndexOf("{", cut);
      if (brace >= 0 && cut - brace < PLAIN_GUARD) cut = brace;
      // 也不要在 `<` 之前切断：DSML 调用块以 `<` 开头，切掉就再也认不出来了
      const angle = plainBuffer.lastIndexOf("<", cut);
      if (angle >= 0 && cut - angle < PLAIN_GUARD) cut = Math.min(cut, angle);

      if (cut <= 0) return null;
      const out = plainBuffer.slice(0, cut);
      plainBuffer = plainBuffer.slice(cut);
      if (out) plainEmitted += out.length;
      return out ? { type: "text", text: out } : null;
    }
    return null;
  }

  /**
   * gate 阶段的处理：判定信封类型并产出对应内容。
   *
   * @returns {{ type: "tool", ... } | { type: "text", text: string } | null}
   */
  function feedGate() {
    if (gateSuppressed) {
      phase = "done";
      raw = "";
      return null;
    }

    const toolTry = tryTool();
    // 信封还没收全：继续等（每片会追加到 raw）
    if (!toolTry.done) return null;

    // 1) 工具信封：优先级最高，工具调用必须识别出来
    if (toolTry.tool) {
      toolResult = toolTry.tool;
      return {
        type: "tool",
        name: toolResult.name,
        args: toolResult.args,
        tool: toolResult.tool,
      };
    }
    if (toolTry.skipTo != null) raw = raw.slice(toolTry.skipTo);

    // 2) 正文信封
    const valueStart = findStringValueStart(raw, "taskCompletion");
    if (valueStart >= 0) {
      // 前面已经用纯文本给用户看过内容了：这个信封是同一段内容的重排，
      // 再吐一遍会让回答整段重复。
      if (headEmitted) {
        gateSuppressed = true;
        phase = "done";
        raw = "";
        return null;
      }
      phase = "answer";
      answer = createAnswerStreamer({ insideValue: true });
      const out = answer.feed(raw.slice(valueStart));
      return out ? { type: "text", text: out.text } : null;
    }

    // 3) 提问信封：把问题和选项一起呈现
    if (/"action"\s*:\s*"ask"/.test(raw)) {
      const braceAt = raw.indexOf("{");
      const matched = braceAt >= 0 ? matchBraces(raw, braceAt) : null;
      if (!matched) return null; // 还没收全

      let obj = null;
      try {
        obj = JSON.parse(matched.raw);
      } catch {}

      phase = "done";
      raw = "";

      if (obj && typeof obj.question === "string" && obj.question.trim()) {
        const options = Array.isArray(obj.options)
          ? obj.options.filter((o) => typeof o === "string" && o.trim())
          : [];
        let text = obj.question.trim();
        if (options.length > 0) {
          text += "\n\n" + options.map((o, i) => `${i + 1}. ${o}`).join("\n");
        }
        return { type: "text", text };
      }
      return null;
    }

    // 4) 其它信封（planner 等）：等收全后由上层兜底处理
    return null;
  }

  /**
   * 喂入新片段。
   *
   * @param {string} piece 新到达的文本。
   * @returns {{ type: "tool", name: string, args: object, tool: object } | { type: "text", text: string } | null}
   */
  function feed(piece) {
    if (!piece) return null;
    if (toolResult) return null;

    // 上一次正文先于信封产出时，信封结果在这里补上
    if (pendingGateOut) {
      const out = pendingGateOut;
      pendingGateOut = null;
      return out;
    }

    if (phase === "plain") return feedPlain(piece);

    raw += piece;

    if (phase === "sniff") {
      const verdict = looksLikeJson();
      if (verdict === null) return null;
      if (verdict === false) {
        // 纯文本：进入 plain 模式（带信封探测）
        // raw 已包含全部内容，移交给 plainBuffer
        plain = true;
        phase = "plain";
        plainBuffer = raw;
        raw = "";
        return feedPlain("");
      }
      phase = "gate";
      stripFence();
    }

    if (phase === "gate") return feedGate();

    if (phase === "answer") {
      if (!answer) {
        // 纯文本直通模式：整段都是正文
        const out = raw;
        raw = "";
        return out ? { type: "text", text: out } : null;
      }
      const out = answer.feed(piece);
      return out ? { type: "text", text: out.text } : null;
    }

    return null;
  }

  /**
   * 收尾。
   *
   * @returns {{ text: string, fallback: boolean }} 未能识别时的兜底原文。
   */
  function flush() {
    if (toolResult) return { text: "", fallback: false };

    // 先看 gate 阶段：信封可能已经收全但还没判定。
    // 这种情况出现在整段一次性喂入时 —— feed 先把纯文本 head 返回了，
    // 信封留在 raw 里等下一次 feed，但没有下一次了。
    if (phase === "gate" && raw) {
      const gateOut = feedGate();
      if (gateOut?.type === "tool") {
        // 工具调用本应在 feed 过程中 yield；走到这里说明内容一次性到齐、
        // 没有后续 feed 了。记进 toolResult，由上层在 flush 后读 tool 属性。
        toolResult = { name: gateOut.name, args: gateOut.args, tool: gateOut.tool };
        return { text: "", fallback: false };
      }
      if (gateOut?.type === "text" && gateOut.text) {
        return { text: gateOut.text, fallback: true };
      }
    }

    if (answer) {
      const tail = answer.flush();
      if (!tail.fallback) return { text: "", fallback: false };
      return { text: tail.text, fallback: true };
    }

    if (plain) {
      // 纯文本模式下把缓冲区吐出；但 DSML 标记绝不能泄漏给用户
      let out = plainBuffer;
      plainBuffer = "";
      if (hasDsml(out)) {
        const parsed = parseDsmlCall(out);
        if (parsed && (!allowedTools || allowedTools.size === 0 || allowedTools.has(parsed.name))) {
          toolResult = {
            name: parsed.name,
            args: parsed.args,
            tool: { type: "ui", name: parsed.name, args: parsed.args },
          };
          return { text: "", fallback: false };
        }
        // 解析不出：把 DSML 块整体剥掉，保留前后可能的正文
        out = out.replace(/<[|｜\u01C0\u2223]{2}[\s\S]*?(<\/[|｜\u01C0\u2223]{2}\s*DSML[^>]*>|$)/gi, "").trim();
      }
      return out ? { text: out, fallback: true } : { text: "", fallback: false };
    }

    // 信封可能被截断。尽量从残缺内容里捞出可用信息。
    if (raw && /"action"\s*:\s*"ask"/.test(raw)) {
      const question = extractPartialString(raw, "question");
      if (question) {
        const out = question;
        raw = "";
        return { text: out, fallback: true };
      }
    }
    if (raw && /"taskCompletion"\s*:/.test(raw)) {
      if (headEmitted) {
        raw = "";
        return { text: "", fallback: false };
      }
      const answerText = extractPartialString(raw, "taskCompletion");
      if (answerText) {
        raw = "";
        return { text: answerText, fallback: true };
      }
    }

    const rest = raw;
    raw = "";

    // 兜底原文里如果包含 DSML 标记，剥掉后再给用户
    if (hasDsml(rest)) {
      const cleaned = rest
        .replace(/<[|｜\u01C0\u2223]{2}[\s\S]*?(<\/[|｜\u01C0\u2223]{2}\s*DSML[^>]*>|$)/gi, "")
        .trim();
      return { text: cleaned, fallback: cleaned.length > 0 };
    }

    // 兜底原文里如果包含了信封本体，不能直接当正文给用户
    const at = rest.search(/\{\s*"(action|tool|taskCompletion)"/);
    if (at >= 0) {
      const head = rest.slice(0, at);
      return { text: head, fallback: head.length > 0 };
    }

    return { text: rest, fallback: true };
  }

  return {
    feed,
    flush,
    get tool() {
      return toolResult;
    },
    get isPlain() {
      return plain;
    },
  };
}

export { matchBraces, findStringValueStart, findToolObjectStart };
