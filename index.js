/**
 * OrcaTerm 模型接入插件（DeepSeek Harness）。
 *
 * 把 OrcaTerm 网页版的免费模型注册成 DSH 的 LLM provider：
 *   - 认证：网页 Cookie → 自动调用 OAuthIssueAccessToken 续期（2 小时，全自动）
 *   - 流式：SSE，正文/思考分别映射成 text-delta / reasoning-delta
 *   - 协议：ACP 信封，返回的 JSON 信封会被剥离出 taskCompletion
 *   - 工具：DSH 的工具定义写进 emphasisPrompt，模型输出原生工具信封，
 *           插件转成 tool-call-delta 交给 DSH 的 agent loop 执行
 *
 * 同时通过 webServer 暴露 /api/orcaterm/* 供设置面板读写。
 */
import { LlmAdapter, LlmError, attributionHeaders } from "@deepseek-ai/dsh-llm";
import { parseJwt, createService, toAcpEnvelope, DEFAULT_MODELS, OPTIONS } from "./service.js";
import { createEnvelopeStreamer } from "./tool-stream.js";
import { createSessionResolver } from "./session-map.js";
import { toolPromptFor, parseToolCall, buildToolResultInput } from "./tool-loop.js";
import { collectImageFiles } from "./image-files.js";
import { openExternal } from "./open-external.js";
import { SESSION_COOKIE } from "./cookie-normalize.js";
import { startAutoLogin, clearLoginProfile } from "./auto-login.js";
import { trimHistory, contextLimitMessage, isContextOverflowError } from "./context-trim.js";

const PROVIDER = "orcaterm";
const ORIGIN = "https://orcaterm.ai";
const CHAT_BASE = "https://lightai.tencentcloud.com";
const CHAT_PATH = "/assistant/chat?name=orcaterm&mode=0&csrfCode=&sseresume=true";

/**
 * 上游允许的最大输出 token 数。
 *
 * 实测来源：OrcaTerm 前端校验 `max_tokens不能大于 8096`，
 * 超过会被直接拒绝。调用方给的更大值时必须夹紧。
 */
const MAX_OUTPUT_TOKENS = 8096;

/**
 * 指数退避的等待时长。
 *
 * @param {number} attempt 第几次尝试（从 0 开始）。
 * @returns {number} 等待毫秒数。
 */
function backoffMs(attempt) {
  return Math.min(8000, 600 * 2 ** attempt);
}

/**
 * 可被中止打断的等待。
 *
 * @param {number} ms 等待毫秒数。
 * @param {AbortSignal} [signal] 中止信号。
 */
function delay(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

/**
 * 取出消息的纯文本内容。
 *
 * DSH 的 message.content 永远是 ContentBlock[]（不是字符串）。
 *
 * @param {object} m 一条消息。
 * @returns {string} 拼接后的文本。
 */
function textOf(m) {
  if (typeof m?.content === "string") return m.content;
  if (!Array.isArray(m?.content)) return "";
  return m.content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

/**
 * 找出本轮需要回传给服务端的工具结果消息。
 *
 * DSH 的 agent loop 在执行完工具后会再调一次 stream()，
 * 此时 options.messages 尾部会有一条或多条 role:"tool" 的消息。
 *
 * @param {Array<object>} messages 消息列表。
 * @returns {Array<object>} 工具结果消息（按出现顺序）；没有则空数组。
 */
function findTrailingToolResults(messages) {
  if (!Array.isArray(messages)) return [];
  const results = [];
  // 从尾部往前收集 role:"tool" 的消息，遇到非 tool 消息就停
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role === "tool") {
      results.unshift(m);
      continue;
    }
    break;
  }
  return results;
}

class OrcaTermAdapter extends LlmAdapter {
  constructor(options) {
    super();
    this.options = options;
    /**
     * 已发出但尚未回传结果的工具调用：callId → OrcaTerm 工具对象。
     *
     * DSH 执行完工具后会再调一次 stream()，那时我们要用 reportToolResult
     * 把结果回传给服务端，需要原样带上当初的 OrcaTerm 工具对象。
     */
    this.pendingToolCalls = new Map();
    /**
     * 已经回传过结果的工具调用 id。
     *
     * 服务端不幂等：同一份 reportToolResult 发两次会产生两条 tool 事件，
     * 模型会看到重复结果。这里靠 DSH 给的 toolCallId 判重。
     */
    this.reportedToolCalls = new Set();
  }

  providerInfo(provider) {
    return { id: provider, name: "OrcaTerm" };
  }

  providerRetryPolicy() {
    return void 0;
  }

  async listModels(provider) {
    // 必须先等磁盘配置合并进 runtime —— 否则 disabledModels 还是空数组，
    // 停用的模型会重新出现在选择器里（DSH 启动后直接开选择器就是这个顺序）。
    await this.options.service.ready();
    // 只返回启用中的模型 —— 停用的不会出现在 DSH 的模型选择器里。
    const models = this.options.service.getEnabledModels();
    return models.map((m) => ({
      provider,
      id: m.id,
      name: m.name,
      ...(m.note ? { description: `OrcaTerm 免费 · ${m.note}` } : { description: "OrcaTerm 免费" }),
      inputModalities: ["text"],
    }));
  }

  async resolveModel(provider, modelId) {
    await this.options.service.ready();
    const models = this.options.service.getModels();
    const runtime = this.options.service.getRuntime();
    const enabled = this.options.service.getEnabledModels();
    const id = modelId || runtime.model;
    // 传进来的是已停用模型时不报错，静默回退到第一个可用模型 ——
    // 否则用户在停用后切会话会看到莫名其妙的失败。
    const found = models.find((m) => m.id === id);
    const usable = this.options.service.isDisabled(id) ? enabled[0]?.id ?? id : id;
    const usableInfo = models.find((m) => m.id === usable);
    return {
      provider,
      id: usable,
      name: usableInfo ? usableInfo.name : found ? found.name : "OrcaTerm",
      defaultMaxTokens: MAX_OUTPUT_TOKENS,
    };
  }

  /** 必须同步返回 AsyncIterable。 */
  stream(options) {
    return this.streamChunks(options);
  }

  async *streamChunks(options) {
    /**
     * 适配器实例引用。
     *
     * 生成器方法里 `this` 是可用的，但嵌套的 `function*` 辅助函数内部
     * `this` 会丢失（普通函数调用不继承外层 this）。统一用 self 访问实例状态。
     */
    const self = this;
    const service = self.options.service;
    const signal = options.signal;
    // 先等磁盘配置合并进 runtime，否则下面的 disabledModels / model 等
    // 读到的都是 patch 默认值，停用判断会失效。
    await service.ready();
    const runtime = service.getRuntime();
    /** 本次调用的起始时刻，用于统计耗时。 */
    const callStartedAt = Date.now();

    const { token } = await service.getToken();
    const payload = parseJwt(token);
    const userId = payload && payload.userId ? String(payload.userId) : "";

    const seqId = crypto.randomUUID();

    // 会话映射：同一 DSH 会话始终使用同一个 OrcaTerm conversationId，
    // 让服务端记住上下文，实现真正的多轮对话。
    const { cid, source: cidSource } = self.options.sessionResolver.resolve(options);

    // ---- 工具定义：写进 emphasisPrompt，让模型知道有哪些工具可用 ----
    const toolsEnabled = runtime.enableTools !== false;
    const tools = toolsEnabled && Array.isArray(options.tools)
      ? options.tools.filter((t) => t && typeof t.name === "string")
      : [];
    const toolPrompt = toolPromptFor(tools);
    const allowedTools = new Set(tools.map((t) => t.name));

    // ---- 本次是首次提问，还是工具结果回灌后的再次调用？ ----
    // DSH 的 agent loop 会把工具结果也放进 messages；服务端那边我们已经用
    // reportToolResult 回传过一次了，所以这里不能再重复回灌，否则模型会看到
    // 两条一样的工具结果。
    const toolResults = findTrailingToolResults(options.messages);
    const isToolFollowUp = toolResults.length > 0;

    // 正文：首次提问时发完整历史；工具回灌时走 review 请求，不发正文。
    let promptText = "";
    /** 历史裁剪结果，用于诊断与超限提示。 */
    let trimInfo = { trimmed: false, dropped: 0, beforeChars: 0, afterChars: 0 };
    if (!isToolFollowUp) {
      // 主动裁剪：上下文虽然宽松（实测 260k 字符仍可用），但不该等到
      // 服务端报错才处理。超阈值时削掉最老的历史，保留最近对话与
      // 成对的工具调用，并始终保留 system 消息。
      trimInfo = trimHistory(options.messages, {
        threshold: runtime.contextTrimChars > 0 ? runtime.contextTrimChars : undefined,
      });
      promptText = toAcpEnvelope(trimInfo.messages);
    }

    // ---- 图片：把本轮消息里的图片块转成 OrcaTerm 的 input.files ----
    // 图片只能随「新一轮提问」发出去；工具结果回灌那一轮不需要重复发图。
    let imageFiles = [];
    let imageSkipped = [];
    if (!isToolFollowUp && runtime.enableImages !== false) {
      try {
        const collected = await collectImageFiles(options.messages, {
          model: options.model || runtime.model,
        });
        imageFiles = collected.files;
        imageSkipped = collected.skipped;
      } catch (error) {
        imageSkipped = [{ reason: `收集图片失败：${error?.message ?? error}` }];
      }
    }

    // 有图片被丢弃时，必须让用户知道 —— 否则用户以为图片已经发出去，
    // 模型却在凭空回答，只会得到莫名其妙的回复。
    let imageNotice = "";
    if (imageSkipped.length > 0) {
      const reasons = [...new Set(imageSkipped.map((s) => s.reason).filter(Boolean))];
      imageNotice = [
        `【系统提示：本轮用户附带的图片未能发送】`,
        ...reasons.map((r) => `- ${r}`),
        `请在回答开头用一句话如实告知用户这些图片没有送到你这里、你看不到图片内容，再回答其余问题。不要假装看过图片。`,
      ].join("\n");
    }

    /** 最终注入 emphasisPrompt 的内容：工具说明 + 图片提示。 */
    const emphasis = [toolPrompt, imageNotice].filter(Boolean).join("\n\n");

    const body = {
      conversationId: cid,
      user: {
        id: userId,
        setting: {
          mcpServers: [],
          uiServers: [],
          tools: [],
          approvedTools: [],
          approvedMCPTools: [],
          enableAutoSubtaskExecution: false,
          env: [],
          model: options.model || runtime.model,
          modelDesc: {
            kwargs: {
              thinking: { type: "enabled" },
              reasoning_effort: runtime.reasoningEffort,
              // 尊重调用方给的最大输出长度，但上游对 max_tokens 有硬上限（8096）。
              // 超出会被服务端直接拒绝，因此这里必须夹紧到合法区间。
              ...(Number.isFinite(options.maxTokens) && options.maxTokens > 0
                ? { max_tokens: Math.min(options.maxTokens, MAX_OUTPUT_TOKENS) }
                : {}),
            },
          },
          extra: {},
          selectedMCPTools: {},
          selectedUITools: {},
          a2a: {},
          hideToolMessage: true,
          language: "zh",
          // multimodal 是服务端识别图片的开关，必须保持 true
          multimodal: true,
          enableThinking: false,
        },
      },
      input: {
        type: "start",
        input: promptText,
        id: seqId,
        emphasisPrompt: emphasis,
        files: imageFiles,
      },
      stream: true,
    };

    // 诊断埋点：记录 options 的键名、工具定义与会话映射结果，便于排查
    const diag = {
      optionKeys: Object.keys(options || {}),
      cid,
      cidSource,
      promptChars: promptText.length,
      messageCount: Array.isArray(options.messages) ? options.messages.length : 0,
      // 消息角色分布：排查消息结构
      roleBreakdown: Array.isArray(options.messages)
        ? options.messages.reduce((acc, m) => {
            const role = m?.role ?? "?";
            acc[role] = (acc[role] ?? 0) + 1;
            return acc;
          }, {})
        : undefined,
      toolCount: tools.length,
      toolNames: tools.slice(0, 8).map((t) => t.name),
      toolPromptChars: toolPrompt.length,
      isToolFollowUp,
      // 上下文裁剪：是否削过历史、削了多少
      contextTrimmed: trimInfo.trimmed,
      contextDropped: trimInfo.dropped,
      contextBeforeChars: trimInfo.beforeChars,
      contextAfterChars: trimInfo.afterChars,
      // 图片：本轮实际带上了几张、有没有被跳过的
      imageCount: imageFiles.length,
      imageNames: imageFiles.map((f) => f.name).slice(0, 10),
      imageSkipped,
      fallbackConfigured: Boolean(runtime.fallbackModel),
      maxRetries: runtime.maxRetries,
    };

    // ---- 工具结果回灌：改用 review + reportToolResult 请求 ----
    // DSH 执行完工具后会再调一次 stream()。此时我们要把结果通过
    // reportToolResult 回传给服务端，服务端再把结果喂给模型。
    if (isToolFollowUp) {
      // 服务端不幂等：同一份 reportToolResult 发两次会产生两条 tool 事件。
      // DSH 正常只会回灌一次，但异常重试时可能重复，这里挡一道。
      const seen = toolResults.filter((tr) => tr.toolCallId && self.reportedToolCalls.has(tr.toolCallId));
      if (seen.length === toolResults.length && toolResults.length > 0) {
        // 这一批结果全都回传过了：直接当作普通追问，不重复回灌
        diag.toolReported = null;
        diag.toolReportDeduped = true;
      } else {
        // 本轮所有未回传过的工具结果
        //
        // 注意：这里不加「工具 X 执行结果：」这类包装前缀。
        // 服务端已经通过 tool 对象知道是哪个工具，加了前缀模型会连前缀
        // 一起复述到回答里（实测现象）。真实客户端回传的也是原始输出。
        const parts = [];
        let firstTool = null;
        for (const tr of toolResults) {
          const callId = tr.toolCallId;
          if (callId && self.reportedToolCalls.has(callId)) continue;
          const pending = callId ? self.pendingToolCalls.get(callId) : undefined;
          const toolObject = pending?.tool;
          const resultText = textOf(tr);
          const isError = tr.isError === true;

          // 出错时才标注，因为错误信息需要模型明确知道是失败
          parts.push(isError ? `[执行失败] ${resultText || "未知错误"}` : resultText);
          if (!firstTool && toolObject) firstTool = { tool: toolObject, name: pending?.name };
        }

        if (firstTool) {
          // 单个结果直接用原文；多个结果用空行分隔，避免粘连
          const payload = parts.join("\n\n");
          body.input = {
            ...buildToolResultInput({
              tool: firstTool.tool,
              toolResult: payload,
              seqId,
            }),
            // 保留工具说明，让模型能继续调用下一个工具
            emphasisPrompt: emphasis,
          };
          diag.toolReported = {
            name: firstTool.name,
            count: parts.length,
            resultChars: payload.length,
          };
          // 记下已回传的调用，同时清理 pending
          for (const tr of toolResults) {
            if (!tr.toolCallId) continue;
            self.reportedToolCalls.add(tr.toolCallId);
            self.pendingToolCalls.delete(tr.toolCallId);
          }
          // 防止 Set 无限增长
          if (self.reportedToolCalls.size > 64) {
            const oldest = self.reportedToolCalls.values().next().value;
            self.reportedToolCalls.delete(oldest);
          }
        } else {
          // 找不到对应的工具对象（可能是重启后遗留），退回普通请求
          body.input.emphasisPrompt = toolPrompt;
          diag.toolReported = null;
          diag.toolReportMiss = true;
        }
      }
    }

    service.noteCall(diag);

    // ---- 请求：带重试与备用模型降级 ----
    const requestBody = { ...body, user: { ...body.user, setting: { ...body.user.setting } } };

    /**
     * 依次尝试的模型：主模型 + 备用模型。
     *
     * 会话可能在模型被停用前就选中了它，或备用模型已被停用 ——
     * 这些情况都要静默回退到启用列表里的第一个，而不是直接报错。
     */
    const requestedModel = options.model || runtime.model;
    const primaryModel = service.isDisabled(requestedModel)
      ? service.getEnabledModels()[0]?.id ?? requestedModel
      : requestedModel;
    const candidates = [primaryModel];
    if (
      runtime.fallbackModel &&
      runtime.fallbackModel !== primaryModel &&
      !service.isDisabled(runtime.fallbackModel)
    ) {
      candidates.push(runtime.fallbackModel);
    }

    let response = null;
    let usedModel = primaryModel;
    let lastError = null;

    /**
     * 等待响应头的超时。
     *
     * 只覆盖「发请求 → 拿到响应头」这一段，不覆盖流式读取 ——
     * 否则长回答会被误杀。上游如果卡死不给响应头，这里能兜住。
     */
    const connectTimeoutMs = Number.isFinite(runtime.connectTimeoutMs)
      ? runtime.connectTimeoutMs
      : 60000;

    for (const candidate of candidates) {
      usedModel = candidate;
      requestBody.user.setting.model = candidate;

      for (let attempt = 0; attempt <= runtime.maxRetries; attempt += 1) {
        /** 本次尝试的独立超时控制器（与调用方的 signal 联动）。 */
        const attemptController = new AbortController();
        const onOuterAbort = () => attemptController.abort();
        signal?.addEventListener?.("abort", onOuterAbort, { once: true });
        const timer = setTimeout(() => attemptController.abort(), connectTimeoutMs);

        try {
          response = await fetch(`${CHAT_BASE}${CHAT_PATH}`, {
            method: "POST",
            headers: {
              "x-seqid": seqId,
              "X-Product": "orcaterm",
              authorization: `Bearer ${token}`,
              Accept: "text/event-stream",
              "Content-Type": "application/json",
              ...attributionHeaders(),
            },
            body: JSON.stringify(requestBody),
            signal: attemptController.signal,
          });
        } catch (error) {
          if (signal?.aborted) throw new LlmError("orcaterm: 请求被中止", "ABORTED", { cause: error });
          // 区分「上游迟迟不响应」和「网络不通」，给不同的错误信息
          const timedOut = attemptController.signal.aborted;
          lastError = new LlmError(
            timedOut
              ? `orcaterm: 上游 ${Math.round(connectTimeoutMs / 1000)} 秒内没有响应，已超时`
              : `orcaterm: 无法连接 ${CHAT_BASE}`,
            timedOut ? "TIMEOUT" : "DISCOVERY_FAILED",
            { cause: error }
          );
          // 网络错误、超时都可重试
          if (attempt < runtime.maxRetries) {
            await delay(backoffMs(attempt), signal);
            continue;
          }
          break;
        } finally {
          // 响应头已拿到（或本次尝试已结束），超时定时器与外部监听都可以撤掉，
          // 否则后续的长流式读取会被误判成超时。
          clearTimeout(timer);
          signal?.removeEventListener?.("abort", onOuterAbort);
        }

        if (response.ok) break;

        // 读取错误体，供诊断与重试判断
        const text = await response.text().catch(() => "");
        const status = response.status;

        // 401/403 是凭证问题，重试无意义
        if (status === 401 || status === 403) {
          throw new LlmError(`orcaterm: 凭证无效（HTTP ${status}），请在设置面板更新 Cookie。`, "INVALID_CREDENTIAL", {
            status,
          });
        }

        // 上下文超限：重试无意义（同样的输入必然再超），给出可操作提示
        if (isContextOverflowError(text)) {
          throw new LlmError(contextLimitMessage({ beforeChars: trimInfo.beforeChars, trimmed: trimInfo.trimmed }), "CONTEXT_OVERFLOW", {
            status,
          });
        }

        // 429/5xx 可重试
        const retryable = status === 429 || status >= 500;
        lastError = new LlmError(`orcaterm: HTTP ${status}: ${text.slice(0, 300)}`, status === 429 ? "RATE_LIMIT" : "PROVIDER_ERROR", {
          status,
        });

        if (retryable && attempt < runtime.maxRetries) {
          await delay(backoffMs(attempt), signal);
          continue;
        }
        break;
      }

      if (response && response.ok) break;
      // 主模型彻底失败，尝试下一个候选
      response = null;
    }

    if (!response) {
      throw lastError ?? new LlmError("orcaterm: 请求失败", "PROVIDER_ERROR");
    }

    // 补记实际使用的模型（可能是降级后的备用模型）
    diag.usedModel = usedModel;
    diag.degraded = usedModel !== primaryModel;
    service.noteCall(diag);

    if (!response.body) throw new LlmError("orcaterm: 响应没有 body", "PROVIDER_ERROR");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // 信封解析器：区分工具信封与正文信封
    const envelope = createEnvelopeStreamer({ allowedTools });
    /** 累积的原始文本，用于结束时兜底解析工具调用。 */
    let rawText = "";
    let anyText = false;
    let anyReasoning = false;
    let sawTool = false;
    /** 首字（正文或思考）到达的时刻，用于统计首字延迟。 */
    let firstTokenAt = null;

    /**
     * block 序号计数器。
     *
     * DSH 的 BlockAssembler 按 index 分组，text / reasoning / tool-call
     * 各自必须用不同的 index，否则组装会损坏。
     */
    let nextIndex = 0;
    /** 已分配的 text block index（-1 表示还没分配）。 */
    let textIndex = -1;
    /** 已分配的 reasoning block index。 */
    let reasoningIndex = -1;
    /** 是否已经吐过终止信号（错误码等），用于提前结束。 */
    let terminated = false;
    /** 上游通过 SSE 纯文本行返回的错误，供诊断用。 */
    let lastSseError = "";

    /**
     * 处理一段已经切分好的 SSE 帧，产出对应的 DSH chunk。
     *
     * @param {string[]} parts 以 \n\n 切分后的帧列表。
     */
    function* handleFrames(parts) {
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        let evt;
        try {
          evt = JSON.parse(data);
        } catch {
          // 非 JSON 的 data 行：上游会把错误写在这里，HTTP 仍是 200。
          // 形如 `data: [ERROR]: [LLM_ERROR]: ...`，或 `[ERROR]: ...`。
          // 不识别会表现为「模型返回空内容」，用户看不到真实原因。
          if (/\[ERROR\]/i.test(data)) {
            terminated = true;
            lastSseError = data.replace(/^\[ERROR\]:\s*/i, "").trim();
            // 上下文超限走专门的提示，普通错误保留上游原文
            const overflow = isContextOverflowError(lastSseError);
            yield {
              type: "finish",
              reason: {
                kind: "error",
                failure: overflow
                  ? {
                      message: contextLimitMessage({ beforeChars: trimInfo.beforeChars, trimmed: trimInfo.trimmed }),
                      code: "CONTEXT_OVERFLOW",
                    }
                  : { message: `orcaterm: ${lastSseError.slice(0, 500)}`, code: "PROVIDER_ERROR" },
              },
            };
            return;
          }
          continue;
        }

        // 限流是 200 OK 里的 SSE 行，不是 HTTP 错误，必须单独判
        if (typeof evt.code === "number" && evt.code !== 0) {
          terminated = true;
          const rateLimited = evt.code === 429;
          yield {
            type: "finish",
            reason: {
              kind: "error",
              failure: {
                message: rateLimited
                  ? `orcaterm: 触发限流（${evt.message ?? "chat-rpm"}），请稍后重试`
                  : `orcaterm error code ${evt.code}${evt.message ? `: ${evt.message}` : ""}`,
                code: rateLimited ? "RATE_LIMIT" : "PROVIDER_ERROR",
              },
            },
          };
          return;
        }

        // 工具事件：content 里装的是「工具执行结果原文」或「服务端执行反馈」，
        // 不是模型的回答。绝不能当正文推给用户 —— 否则用户会看到
        // <path>...</path><type>file</type><content>...</content> 这种原始工具输出。
        // 结果已经通过 reportToolResult 回传给服务端，这里直接丢弃。
        if (evt.type === "tool") continue;

        if (evt.reasoning === true) {
          // 思考过程：映射成 DSH 的 reasoning-delta
          if (runtime.showReasoning) {
            const thought =
              typeof evt.reasoningContent === "string" && evt.reasoningContent.length > 0
                ? evt.reasoningContent
                : typeof evt.content === "string"
                  ? evt.content
                  : "";
            if (thought) {
              if (firstTokenAt === null) firstTokenAt = Date.now();
              anyReasoning = true;
              if (reasoningIndex < 0) reasoningIndex = nextIndex++;
              yield { type: "reasoning-delta", index: reasoningIndex, text: thought };
            }
          }
          continue;
        }

        const piece = typeof evt.content === "string" ? evt.content : "";
        if (piece.length === 0) continue;
        rawText += piece;

        // 流式解析：工具信封 → tool-call-delta；正文 → text-delta
        const out = envelope.feed(piece);
        if (out?.type === "text" && out.text) {
          if (firstTokenAt === null) firstTokenAt = Date.now();
          anyText = true;
          if (textIndex < 0) textIndex = nextIndex++;
          yield { type: "text-delta", index: textIndex, text: out.text };
        } else if (out?.type === "tool") {
          sawTool = true;
          const callId = `orcaterm-${crypto.randomUUID()}`;
          const argsJson = JSON.stringify(out.args ?? {});
          // 工具调用必须用独立的 index
          const callIndex = nextIndex++;
          yield { type: "tool-call-delta", index: callIndex, id: callId, name: out.name, argumentsDelta: argsJson };
          // 记下工具对象，第二次调用时用它回传结果
          self.pendingToolCalls.set(callId, { tool: out.tool, name: out.name });
          // 防止异常路径下无限增长
          if (self.pendingToolCalls.size > 32) {
            const oldest = self.pendingToolCalls.keys().next().value;
            self.pendingToolCalls.delete(oldest);
          }
          diag.lastToolCall = { name: out.name, args: out.args };
          service.noteCall(diag);
        }
      }
    }

    try {
      while (true) {
        if (signal?.aborted) {
          yield {
            type: "finish",
            reason: { kind: "aborted", failure: { message: "用户中止", code: "ABORTED" } },
          };
          return;
        }

        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        yield* handleFrames(parts);
        if (terminated) return;
      }

      // 收尾：SSE 末尾不一定有 \n\n，必须把残留的最后一帧也处理掉
      buffer += decoder.decode();
      if (buffer.trim()) {
        yield* handleFrames([buffer]);
        buffer = "";
        if (terminated) return;
      }

      // 收尾：flush 可能会识别出一个此前没机会 yield 的工具调用
      // （内容一次性到齐、没有后续 feed 的情况），也可能给出兜底正文。
      if (!sawTool) {
        const tail = envelope.flush();

        // 优先看 flush 内部是否识别到了工具
        const flushedTool = envelope.tool;
        if (flushedTool && !sawTool) {
          sawTool = true;
          const callId = `orcaterm-${crypto.randomUUID()}`;
          const callIndex = nextIndex++;
          yield {
            type: "tool-call-delta",
            index: callIndex,
            id: callId,
            name: flushedTool.name,
            argumentsDelta: JSON.stringify(flushedTool.args ?? {}),
          };
          self.pendingToolCalls.set(callId, { tool: flushedTool.tool, name: flushedTool.name });
          diag.lastToolCall = { name: flushedTool.name, args: flushedTool.args };
          service.noteCall(diag);
        } else if (tail.text) {
          // 兜底正文：再试一次从中解析工具调用，避免漏掉
          const call = parseToolCall(tail.text, allowedTools);
          if (call) {
            sawTool = true;
            const callId = `orcaterm-${crypto.randomUUID()}`;
            const callIndex = nextIndex++;
            yield {
              type: "tool-call-delta",
              index: callIndex,
              id: callId,
              name: call.name,
              argumentsDelta: JSON.stringify(call.args ?? {}),
            };
            self.pendingToolCalls.set(callId, { tool: call.tool, name: call.name });
            if (self.pendingToolCalls.size > 32) {
              const oldest = self.pendingToolCalls.keys().next().value;
              self.pendingToolCalls.delete(oldest);
            }
            diag.lastToolCall = { name: call.name, args: call.args };
            service.noteCall(diag);
          } else {
            const ans = extractAnswer(tail.text);
            if (ans) {
              anyText = true;
              if (textIndex < 0) textIndex = nextIndex++;
              yield { type: "text-delta", index: textIndex, text: ans };
            }
          }
        }
      }

      if (!anyText && !anyReasoning && !sawTool) {
        // 空响应有多种成因：真实的空回答、上游安全审核拦截、或上下文问题。
        //
        // 实测表明服务端容量很大（120 万字符都不超限），所以「接近阈值」
        // 并不足以断定是上下文问题。只有一种情况值得提示上下文：
        // 关闭了裁剪且历史确实很大 —— 这时内容超出模型可靠检索区间，
        // 模型容易「看不到」问题本身而返回空。
        const trimDisabled = !(runtime.contextTrimChars > 0);
        const hugeInput = trimInfo.beforeChars >= 300_000;
        const likelyContext = trimDisabled && hugeInput;
        yield {
          type: "finish",
          reason: {
            kind: "error",
            failure: likelyContext
              ? {
                  message: contextLimitMessage({ beforeChars: trimInfo.beforeChars, trimmed: trimInfo.trimmed }),
                  code: "CONTEXT_OVERFLOW",
                }
              : { message: "orcaterm: 模型没有返回任何内容", code: "EMPTY_RESPONSE" },
          },
        };
        return;
      }

      yield {
        type: "finish",
        reason: { kind: sawTool ? "tool-calls" : "stop" },
      };
    } finally {
      try {
        reader.releaseLock();
      } catch {}

      // 记录一次真实调用：无论成功、空响应还是异常，都进本地统计
      const ok = anyText || anyReasoning || sawTool;
      service.usage
        .record({
          model: options.model || runtime.model,
          ok,
          ms: Date.now() - callStartedAt,
          firstTokenMs: firstTokenAt === null ? undefined : firstTokenAt - callStartedAt,
        })
        .catch(() => {});
    }
  }
}

/** 从 JSON 信封（可含 Markdown 围栏）中取出真正的回答文本。 */
function extractAnswer(raw) {
  let trimmed = raw.trim();
  if (!trimmed) return "";

  const fence = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  if (fence) trimmed = fence[1].trim();

  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return raw;

  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return fence ? trimmed : raw;
  }

  if (typeof obj === "string") return obj;
  if (Array.isArray(obj)) {
    const last = obj[obj.length - 1];
    return last == null ? raw : extractAnswer(JSON.stringify(last));
  }
  if (typeof obj !== "object") return raw;

  for (const key of [
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
  ]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }

  const skip = new Set(["action", "type", "code", "id", "status", "role", "model"]);
  let best = "";
  for (const [k, v] of Object.entries(obj)) {
    if (skip.has(k)) continue;
    if (typeof v === "string" && v.length > best.length) best = v;
  }
  return best || raw;
}

/** 读请求体 JSON，带大小上限。 */
async function readJsonBody(request, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return undefined;
  return JSON.parse(text);
}

function apply(ctx, config) {
  const cfg = config || {};
  const warn = (msg) => {
    if (ctx.logger && typeof ctx.logger.warn === "function") ctx.logger.warn(msg);
    else console.warn(msg);
  };

  const service = createService({ config: cfg, warn });

  // 会话映射：把当前 DSH 会话解析成稳定的 OrcaTerm conversationId。
  // currentInitiator 在模型调用链上指向发起本次调用的会话。
  const sessionResolver = createSessionResolver({
    currentAgent: () => {
      try {
        const agents = ctx.get("agents");
        return agents?.currentInitiator?.();
      } catch {
        return undefined;
      }
    },
  });

  // ---- LLM provider ----
  const adapter = new OrcaTermAdapter({ service, sessionResolver });
  ctx.llm.registerAdapter([PROVIDER], adapter);

  // ---- 设置面板的数据桥 ----
  if (typeof ctx.inject === "function") {
    ctx.inject(["webServer"], (webCtx) => {
      const webServer = webCtx?.webServer;
      if (!webServer || typeof webServer.register !== "function") {
        warn("orcaterm: webServer 不可用，设置面板将无法读取数据");
        return;
      }

      /**
       * 自动登录任务的状态机。
       *
       * 面板通过轮询 /login/status 获取进度；登录成功后这里自动
       * 把凭证写进 service，面板再拉一次 /status 就是已登录状态。
       */
      const loginTask = {
        running: false,
        stage: "idle",
        detail: "",
        error: "",
        saved: false,
        startedAt: 0,
        controller: null,
        snapshot() {
          return {
            running: this.running,
            stage: this.stage,
            detail: this.detail,
            error: this.error,
            saved: this.saved,
            elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0,
          };
        },
        start() {
          if (this.running) return;
          this.running = true;
          this.stage = "starting";
          this.detail = "";
          this.error = "";
          this.saved = false;
          this.startedAt = Date.now();
          const controller = new AbortController();
          this.controller = controller;

          const task = this;
          (async () => {
            const result = await startAutoLogin({
              signal: controller.signal,
              onProgress: (stage, detail) => {
                task.stage = stage;
                if (detail) task.detail = detail;
              },
            });

            if (result.ok) {
              // 拿到凭证立刻落盘，避免面板没来得及刷新就丢了
              try {
                await service.saveCookie(result.cookie);
                await service.getToken(true).catch(() => {});
                task.saved = true;
                task.stage = "done";
                task.detail = "登录成功，凭证已保存";
              } catch (e) {
                task.stage = "error";
                task.error = `凭证已读到但保存失败：${e?.message ?? e}`;
              }
            } else {
              task.stage = result.error === "已取消" ? "cancelled" : "error";
              task.error = result.error === "已取消" ? "" : result.error;
            }
            task.running = false;
            task.controller = null;
          })();
        },
        cancel() {
          try { this.controller?.abort(); } catch {}
          if (this.running) {
            this.stage = "cancelled";
            this.running = false;
          }
        },
      };

      webCtx.effect(() => {
        const dispose = webServer.register({
          kind: "prefix",
          path: "/api/orcaterm",
          async handler(request, response) {
            const url = new URL(request.url ?? "/", "http://127.0.0.1");
            const send = (status, payload) => {
              response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
              response.end(JSON.stringify(payload));
            };
            const path = url.pathname;

            try {
              if (path.endsWith("/status")) {
                send(200, { ok: true, ...(await service.snapshot()) });
                return;
              }
              if (path.endsWith("/models")) {
                // 返回全部模型（含停用状态），面板据此渲染启用/停用开关
                const all = service.getModels();
                const runtimeCfg = service.getRuntime();
                send(200, {
                  ok: true,
                  models: all.map((m) => ({ ...m, enabled: !service.isDisabled(m.id) })),
                  options: OPTIONS,
                  disabledModels: runtimeCfg.disabledModels,
                  enabledCount: service.getEnabledModels().length,
                });
                return;
              }
              // 启用 / 停用某个模型
              if (path.endsWith("/models/toggle") && request.method === "POST") {
                const body = await readJsonBody(request);
                const id = typeof body?.id === "string" ? body.id : "";
                const enabled = body?.enabled !== false;
                if (!id) {
                  send(400, { ok: false, error: "缺少模型 id" });
                  return;
                }
                const result = await service.setModelEnabled(id, enabled);
                // 顺带返回最新的完整状态，面板一次刷新即可
                const all = service.getModels();
                send(200, {
                  ok: true,
                  models: all.map((m) => ({ ...m, enabled: !service.isDisabled(m.id) })),
                  disabledModels: result.disabledModels,
                  model: result.model,
                  fallbackModel: result.fallbackModel,
                  enabledCount: service.getEnabledModels().length,
                });
                return;
              }
              if (path.endsWith("/config") && request.method === "POST") {
                const body = await readJsonBody(request);
                const patch = {};
                if (typeof body?.model === "string" && body.model) patch.model = body.model;
                if (typeof body?.reasoningEffort === "string" && OPTIONS.reasoningEffort.includes(body.reasoningEffort)) {
                  patch.reasoningEffort = body.reasoningEffort;
                }
                if (typeof body?.showReasoning === "boolean") patch.showReasoning = body.showReasoning;
                if (typeof body?.enableTools === "boolean") patch.enableTools = body.enableTools;
                if (typeof body?.enableImages === "boolean") patch.enableImages = body.enableImages;
                if (typeof body?.fallbackModel === "string") patch.fallbackModel = body.fallbackModel;
                if (Number.isInteger(body?.maxRetries) && body.maxRetries >= 0 && body.maxRetries <= 5) {
                  patch.maxRetries = body.maxRetries;
                }
                // 上下文裁剪阈值：0 表示关闭；允许 20k ~ 800k 之间的整千数值
                if (Number.isInteger(body?.contextTrimChars) && body.contextTrimChars >= 0 && body.contextTrimChars <= 800000) {
                  patch.contextTrimChars = body.contextTrimChars;
                }
                const saved = await service.saveRuntime(patch);
                send(200, { ok: true, config: saved });
                return;
              }
              if (path.endsWith("/cookie") && request.method === "POST") {
                const body = await readJsonBody(request);
                const normalized = await service.saveCookie(body?.cookie);
                send(200, { ok: true, saved: normalized ? normalized.length : 0, ...(await service.snapshot()) });
                return;
              }
              // ---- 自动登录：启动带调试端口的浏览器，轮询读取凭证 ----
              // 一次只允许一个登录流程，避免开多个浏览器窗口。
              if (path.endsWith("/login/start") && request.method === "POST") {
                if (loginTask.running) {
                  send(200, { ok: true, ...loginTask.snapshot() });
                  return;
                }
                loginTask.start();
                send(200, { ok: true, ...loginTask.snapshot() });
                return;
              }
              if (path.endsWith("/login/status")) {
                send(200, { ok: true, ...loginTask.snapshot() });
                return;
              }
              if (path.endsWith("/login/cancel") && request.method === "POST") {
                loginTask.cancel();
                send(200, { ok: true, ...loginTask.snapshot() });
                return;
              }
              // 清除登录用浏览器 profile（换账号 or 清残留时用）
              if (path.endsWith("/login/reset") && request.method === "POST") {
                loginTask.cancel();
                try {
                  await clearLoginProfile();
                  send(200, { ok: true, cleared: true, ...loginTask.snapshot() });
                } catch (e) {
                  send(500, { ok: false, error: `清除失败：${e?.message ?? e}` });
                }
                return;
              }
              // 兜底：手动打开系统浏览器（自动登录不可用时）
              if (path.endsWith("/open-login") && request.method === "POST") {
                const opened = await openExternal(`${ORIGIN}/terminal`);
                send(200, { ok: true, opened });
                return;
              }
              // 手动方式的分步说明
              if (path.endsWith("/login-help")) {
                send(200, {
                  ok: true,
                  target: `${ORIGIN}/terminal`,
                  cookieName: SESSION_COOKIE,
                  steps: [
                    "点击「打开登录页」，用腾讯云账号登录（支持微信扫码、QQ、GitHub、账号密码等）",
                    "登录成功后，在 OrcaTerm 页面按 F12 打开开发者工具",
                    "切到 Application（应用）标签 → 左侧 Storage 下点 Cookies → 选中 https://orcaterm.ai",
                    "在右侧列表里找到名为 __Secure-ot_session 的那一行",
                    "双击它的 Value 列，全选复制（约 80 个字符）",
                    "回到本页面，粘贴到下面的输入框并保存",
                  ],
                  note:
                    "自动登录不可用时才需要这样做。也可以直接复制整条 Cookie 请求头，插件会自动提取。",
                });
                return;
              }
              if (path.endsWith("/refresh") && request.method === "POST") {
                await service.getToken(true);
                send(200, { ok: true, ...(await service.snapshot()) });
                return;
              }
              if (path.endsWith("/quota")) {
                const quota = await service.fetchQuota();
                send(200, { ok: true, quota });
                return;
              }
              if (path.endsWith("/test") && request.method === "POST") {
                const body = await readJsonBody(request);
                const result = await service.testModel(body?.model);
                send(200, { ok: true, result });
                return;
              }
              // 客户端自检上报：把浏览器侧观察到的状态落盘，便于排查槽位是否生效
              if (path.endsWith("/diag") && request.method === "POST") {
                const body = await readJsonBody(request);
                try {
                  const { writeFile, mkdir } = await import("node:fs/promises");
                  const { homedir } = await import("node:os");
                  const { join, dirname } = await import("node:path");
                  const file = join(homedir(), ".dsh", "orcaterm-client-diag.json");
                  await mkdir(dirname(file), { recursive: true });
                  await writeFile(
                    file,
                    JSON.stringify({ at: new Date().toISOString(), ...body }, null, 2),
                    "utf8"
                  );
                  send(200, { ok: true, file });
                } catch (error) {
                  send(500, { ok: false, error: error?.message ?? String(error) });
                }
                return;
              }

              if (path.endsWith("/usage")) {
                send(200, { ok: true, usage: await service.usage.summary(30), file: service.usage.file });
                return;
              }
              if (path.endsWith("/diag") && request.method === "GET") {
                send(200, { ok: true, lastCall: service.getLastCall() });
                return;
              }
              if (path.endsWith("/usage/reset") && request.method === "POST") {
                await service.usage.reset();
                send(200, { ok: true, usage: await service.usage.summary(30) });
                return;
              }

              send(404, { ok: false, error: `未知接口 ${path}` });
            } catch (error) {
              send(500, { ok: false, error: error?.message ?? String(error) });
            }
          },
        });
        return () => {
          try {
            dispose();
          } catch {}
        };
      }, "orcaterm: settings bridge");
    });
  }

  if (ctx.logger && typeof ctx.logger.info === "function") {
    ctx.logger.info(`orcaterm: provider 已注册（models=${DEFAULT_MODELS.length}）`);
  }
}

export { apply };
export const inject = ["llm"];

/**
 * 测试句柄。
 *
 * 只给单元测试用：让测试能直接构造适配器实例、驱动 stream()，
 * 从而覆盖到实例方法里的逻辑（这类 bug 纯函数测试抓不到）。
 * DSH 运行时不读这个导出，不影响插件行为。
 */
export const __test = { OrcaTermAdapter };
