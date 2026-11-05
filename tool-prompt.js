/**
 * 把 DSH 的工具定义转换成 OrcaTerm 能理解的提示文本。
 *
 * 实测结论（见 p0-tools-exp*.mjs）：
 *   - 服务端会忽略 `user.setting.tools` 里的 OpenAI 格式定义，
 *     模型看不到我们注册的工具；
 *   - 但 `input.emphasisPrompt` 是服务端认可的系统位，写在里面的内容
 *     不会被判定为 prompt injection，模型会照着描述的格式输出工具信封。
 *
 * 因此工具清单必须写进 emphasisPrompt，并用「原生信封格式」描述输出约定，
 * 否则模型会尝试使用服务端内置工具（execute_command 等）。
 */

/** 我们在信封里使用的虚拟工具服务名。服务端不认识它，因此工具由本地执行。 */
export const BRIDGE_SERVER = "dsh-tools";

/**
 * 信封里使用的工具类型。
 *
 * 实测（p0-tools-exp15.mjs）：`type:"mcp"` 会被服务端立即自动执行，
 * 对不存在的 server 直接报错「不存在名为【dsh-tools】的 MCP 服务」，
 * 模型收到失败后就不再请求工具了。
 * `type:"ui"` 的语义是「客户端执行」，服务端会等待客户端回传结果。
 */
export const TOOL_TYPE = "ui";

/** 对应的服务名字段名。 */
export const TOOL_SERVER_FIELD = "uiServer";

/** 提示词里禁止模型使用的服务端内置工具。 */
const BUILTIN_TOOL_NAMES = [
  "execute_command",
  "run_sandbox_task",
  "connect_by_history_session",
  "fetch",
  "cloud_ai_assistant_search",
  "internal_load_skill",
  "internal_load_skill_file",
];

/**
 * 描述文本的最大长度。
 *
 * 实测（p0-toolprompt-ab.mjs）：把 44 个工具的完整描述（约 15774 字符）
 * 截短到一行后，工具选择准确率完全不变。每轮省下上万字符，值得。
 *
 * ⚠️ 但只留工具名是不够的：实测发现模型不知道有哪些必填参数，
 * 会漏传（例如 pwsh 漏掉 description），导致调用被拒。
 * 所以必须同时列出必填参数名 —— 那才是模型真正需要的信息。
 */
const DESC_LIMIT = 60;

/**
 * 把描述压成一行短句：取第一个句子，超长则截断。
 *
 * @param {string} desc 原始描述。
 * @returns {string} 压缩后的描述。
 */
function shorten(desc) {
  const flat = String(desc ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  // 取第一个句子（英文按句号，中文按句号/分号）
  const firstSentence = flat.split(/(?<=[.。;；])\s*/)[0] ?? flat;
  const s = firstSentence.length > DESC_LIMIT ? `${firstSentence.slice(0, DESC_LIMIT)}…` : firstSentence;
  return s.replace(/[.。;；]$/, "");
}

/**
 * 从 JSON Schema 里提取必填参数名。
 *
 * 只取参数名，不带类型与说明 —— 模型需要的是「必须传哪些键」，
 * 完整 schema 太占地方。
 *
 * @param {object} parameters 工具的 JSON Schema。
 * @returns {string[]} 必填参数名列表。
 */
function requiredParams(parameters) {
  const req = parameters && typeof parameters === "object" ? parameters.required : undefined;
  if (!Array.isArray(req)) return [];
  return req.filter((r) => typeof r === "string" && r);
}

/**
 * 把 DSH 的工具定义数组转成简短的文字描述。
 *
 * 每行形如：`- pwsh(description, command)：执行 PowerShell 命令…`
 *
 * @param {Array<object>} tools DSH 工具定义（OpenAI function 格式）。
 * @returns {string} 描述文本。
 */
function describeTools(tools) {
  const lines = [];
  for (const t of tools) {
    if (!t || typeof t.name !== "string" || !t.name) continue;
    const desc = shorten(t.description);
    const req = requiredParams(t.parameters);
    const sig = req.length > 0 ? `(${req.join(", ")})` : "";
    lines.push(`- ${t.name}${sig}${desc ? `：${desc}` : ""}`);
  }
  return lines.join("\n");
}

/**
 * 生成工具调用协议提示词。
 *
 * @param {Array<object>} tools DSH 工具定义数组。
 * @param {object} [options]
 * @param {string} [options.toolNamespace] 提示里使用的虚拟服务名。
 * @returns {string} 可直接放进 emphasisPrompt 的文本；没有工具时返回空串。
 */
export function buildToolPrompt(tools, { toolNamespace = BRIDGE_SERVER } = {}) {
  const list = Array.isArray(tools) ? tools.filter((t) => t && typeof t.name === "string") : [];
  if (list.length === 0) return "";

  const forbidden = BUILTIN_TOOL_NAMES.map((n) => `\`${n}\``).join("、");

  return [
    `【可用工具】`,
    describeTools(list),
    ``,
    `【调用方式】`,
    `当需要使用上述工具时，你的整条回复必须是且仅是下面这个 JSON 对象（不要 Markdown 代码块，不要任何解释文字）：`,
    `{"action":"review","ph_1":"--","tool":{"type":"${TOOL_TYPE}","${TOOL_SERVER_FIELD}":"${toolNamespace}","name":"<工具名>","description":"<一句话说明调用目的>","args":{<参数>}}}`,
    ``,
    `【规则】`,
    `1. 一次只调用一个工具。`,
    `2. 工具名后面括号里是**必填参数**，写进 args 时一个都不能少；漏写会被系统拒绝。`,
    `3. 严禁使用服务端内置工具（${forbidden}），只能使用上面列出的工具。`,
    `4. 输出工具调用后立即停止，不要回答用户、不要解释、不要再输出任何内容。工具执行结果会作为下一条消息给你，届时你再基于结果继续回答。`,
    `5. 收到工具结果后直接回答用户：不要复述工具输出的原文，不要说「工具返回了…」或「执行结果为…」这类话，只把用户需要的信息组织成自然回答。`,
    `6. 不需要工具时，直接用自然语言回答用户，不要输出 JSON。`,
  ].join("\n");
}

export { BUILTIN_TOOL_NAMES, describeTools };
