/**
 * OrcaTerm 设置面板的 Host 侧数据层。
 *
 * 提供：配置读写、Cookie 管理、Token 续期、额度查询、模型列表、连通性测试。
 * 配置持久化在 `~/.dsh/orcaterm-config.json`，与 cordis.patch.yml 中的初始值合并。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { createUsageStore } from "./usage.js";
import { normalizeCookie, SESSION_COOKIE } from "./cookie-normalize.js";
import { join, dirname } from "node:path";

const ORIGIN = "https://orcaterm.ai";
const ISSUE_URL = `${ORIGIN}/cgi/api?action=OAuthIssueAccessToken`;
const CGI_API = `${ORIGIN}/cgi/api`;
const CHAT_BASE = "https://lightai.tencentcloud.com";
const CHAT_PATH = "/assistant/chat?name=orcaterm&mode=0&csrfCode=&sseresume=true";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

/**
 * OrcaTerm 网页版当前提供的模型（均已实测可用）。
 *
 * `free` 标记取自网页模型选择器上的「限时免费」角标。
 * `vendor` 仅用于分组展示。
 */
export const DEFAULT_MODELS = [
  { id: "TokenHub/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", vendor: "DeepSeek", free: true, note: "默认" },
  { id: "TokenHub/deepseek-v4-flash", name: "DeepSeek V4 Flash", vendor: "DeepSeek", free: true },
  { id: "TokenHub/deepseek-v4-pro", name: "DeepSeek V4 Pro", vendor: "DeepSeek", free: true },
  { id: "TokenHub/kimi-k3", name: "Kimi K3", vendor: "Moonshot", free: true },
  { id: "TokenHub/glm-5.3-flash", name: "GLM 5.3 Flash", vendor: "智谱", free: true },
  { id: "TokenHub/glm-5.3", name: "GLM 5.3", vendor: "智谱", free: true },
  { id: "TokenHub/glm-5.2", name: "GLM 5.2", vendor: "智谱", free: true },
  { id: "Hunyuan3/hy3", name: "Hunyuan 3", vendor: "腾讯混元", free: true },
];

/**
 * 额度说明。OrcaTerm 的 AI 配额是单一计数器，不区分模型。
 *
 * 依据：DescribeProductEditions 里 AI 相关只有一个 `hunyuan_ai: { limit: 1000, unit: m }`；
 * DescribeUserBillingStatus 的 feature 枚举穷尽为 session_share / hunyuan_ai / secret / space。
 */
export const QUOTA_NOTE = {
  shared: true,
  text: "所有模型共用同一个额度池，不按模型区分。换模型不会重置额度。",
  freeHint: "「限时免费」模型在活动期内可能不计入配额，所以用量可能长时间显示为 0。",
};

/** 可调参数的合法取值，供面板渲染下拉框。 */
export const OPTIONS = {
  reasoningEffort: ["low", "medium", "high"],
};

export function parseJwt(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    b64 += "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * 取出一条消息里的纯文本。
 *
 * DSH 的 message.content 永远是 ContentBlock[]，不是字符串。
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
 * 把 DSH 中立消息转成 OrcaTerm 的 ACP 信封文本。
 *
 * @param {Array<object>} messages 消息列表。
 * @returns {string} JSON 字符串形式的 ACP 信封。
 */
export function toAcpEnvelope(messages) {
  const lines = [];
  for (const m of messages || []) {
    if (m.role === "system" || m.role === "developer") continue;

    // 工具结果消息：单独标注，方便模型区分
    if (m.role === "tool") {
      const text = textOf(m);
      if (text) lines.push(`工具结果：${text}`);
      continue;
    }

    // 助手消息里可能夹着 tool-call block，这里只取文本部分
    const text = textOf(m);
    if (!text) continue;
    if (m.role === "user") lines.push(`用户：${text}`);
    else if (m.role === "assistant") lines.push(`助手：${text}`);
    else lines.push(text);
  }
  return JSON.stringify({
    _format: "acp-prompt",
    version: 1,
    prompt: [{ type: "text", text: lines.join("\n\n") }],
  });
}

/**
 * 创建 Host 侧的 OrcaTerm 数据层。
 *
 * @param {object} params
 * @param {object} params.config cordis.patch.yml 的 config 原始值。
 * @param {(msg: string) => void} params.warn 诊断输出。
 */
export function createService({ config, warn }) {
  const cfg = config || {};
  const configFile = cfg.configFile || join(homedir(), ".dsh", "orcaterm-config.json");
  const cookieFile = cfg.cookieFile || join(homedir(), ".dsh", "orcaterm-cookie.txt");
  const cacheFile = join(homedir(), ".dsh", "orcaterm-token.json");

  /** 本地调用统计（官方在免费期不计数，这里自己记）。 */
  const usage = createUsageStore();

  /** 运行时配置：磁盘覆盖 > patch 初始值。 */
  let runtime = {
    model: cfg.model || DEFAULT_MODELS[0].id,
    reasoningEffort: cfg.reasoningEffort || "high",
    showReasoning: cfg.showReasoning !== false,
    /** 是否把 DSH 的工具交给模型使用（本机执行，不经 OrcaTerm 服务器）。 */
    enableTools: cfg.enableTools !== false,
    /** 是否把消息里的图片转成 input.files 发给上游（上游支持真视觉）。 */
    enableImages: cfg.enableImages !== false,
    /** 失败后的重试次数（仅对网络错误、429、5xx 生效）。 */
    maxRetries: Number.isInteger(cfg.maxRetries) ? cfg.maxRetries : 2,
    /** 主模型彻底失败时改用的备用模型；为空表示不降级。 */
    fallbackModel: typeof cfg.fallbackModel === "string" ? cfg.fallbackModel : "",
    /**
     * 等待上游响应头的超时（毫秒）。
     *
     * 只覆盖「发请求 → 拿到响应头」，不截断流式读取，避免长回答被误杀。
     */
    connectTimeoutMs: Number.isFinite(cfg.connectTimeoutMs) ? cfg.connectTimeoutMs : 60000,
    /**
     * 触发历史裁剪的字符阈值。
     *
     * 实测：服务端容量很大（120 万字符都不超限、不截断），但模型可靠
     * 检索的上限约 200,000 字符 —— 超出后中间内容会漏读（lost in the middle）。
     * 因此默认 200k，用满可靠区间；超出部分模型本来也读不进去。
     * 设为 0 可关闭裁剪（始终全量发送）。
     */
    contextTrimChars: Number.isFinite(cfg.contextTrimChars) ? cfg.contextTrimChars : 200000,
  };


  /** 最近一次调用的诊断信息。 */
  let lastCall = null;

  /**
   * 记录一次调用的诊断信息。
   *
   * @param {object} info 本次调用的可观测事实。
   */
  function noteCall(info) {
    lastCall = { at: new Date().toISOString(), ...info };
  }

  /**
   * 取消息的文本内容。
   *
   * @param {object} m 一条消息。
   * @returns {string} 文本。
   */
  function textOf(m) {
    if (typeof m?.content === "string") return m.content;
    if (!Array.isArray(m?.content)) return "";
    return m.content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }

  let cached = null;
  let refreshing = null;
  let loaded = false;

  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = await readFile(configFile, "utf8");
      const disk = JSON.parse(raw);
      if (disk && typeof disk === "object") {
        if (typeof disk.model === "string" && disk.model) runtime.model = disk.model;
        if (typeof disk.reasoningEffort === "string" && disk.reasoningEffort) runtime.reasoningEffort = disk.reasoningEffort;
        if (typeof disk.showReasoning === "boolean") runtime.showReasoning = disk.showReasoning;
        if (typeof disk.enableTools === "boolean") runtime.enableTools = disk.enableTools;
        if (typeof disk.enableImages === "boolean") runtime.enableImages = disk.enableImages;
        if (Number.isInteger(disk.maxRetries)) runtime.maxRetries = disk.maxRetries;
        if (typeof disk.fallbackModel === "string") runtime.fallbackModel = disk.fallbackModel;
        if (Number.isFinite(disk.connectTimeoutMs)) runtime.connectTimeoutMs = disk.connectTimeoutMs;
        if (Number.isFinite(disk.contextTrimChars)) runtime.contextTrimChars = disk.contextTrimChars;
      }
    } catch {}
  }

  async function saveRuntime(patch) {
    await ensureLoaded();
    runtime = { ...runtime, ...patch };
    try {
      await mkdir(dirname(configFile), { recursive: true });
      await writeFile(configFile, JSON.stringify(runtime, null, 2), "utf8");
    } catch (error) {
      warn(`orcaterm: 配置写入失败 ${error?.message ?? error}`);
    }
    return runtime;
  }

  /**
   * 读取 Cookie：配置文件 > 环境变量 > cookieFile。
   *
   * 统一归一化成最小形态（只含 __Secure-ot_session）——
   * 实测这样足以换 token，且避免把过期无用的 Cookie 一起发出去。
   */
  async function resolveCookie() {
    let raw = null;
    if (cfg.cookie && String(cfg.cookie).trim()) raw = String(cfg.cookie).trim();
    else if (process.env.ORCATERM_COOKIE && process.env.ORCATERM_COOKIE.trim()) {
      raw = process.env.ORCATERM_COOKIE.trim();
    } else {
      try {
        const file = await readFile(cookieFile, "utf8");
        if (file.trim()) raw = file.trim();
      } catch {}
    }
    if (!raw) return null;

    // 归一化失败（比如旧格式里没有 session）就原样返回，交给上游报错
    try {
      return normalizeCookie(raw).cookie;
    } catch {
      return raw;
    }
  }

  async function saveCookie(cookie) {
    // 归一化：无论用户粘整条还是只粘一个值，落盘都只存最小形态。
    // 这样既减小体积，也避免存下会过期的 ot_sid 等字段。
    const { cookie: normalized } = normalizeCookie(cookie);
    if (!normalized) throw new Error("Cookie 不能为空");

    await mkdir(dirname(cookieFile), { recursive: true });
    await writeFile(cookieFile, normalized, "utf8");
    // Cookie 变了，旧 token 立即失效
    cached = null;
    try {
      await writeFile(cacheFile, "{}", "utf8");
    } catch {}
    return normalized;
  }

  /** 调 OAuthIssueAccessToken 换新 token。 */
  async function issueToken() {
    const cookie = await resolveCookie();
    if (!cookie) {
      throw new Error(
        "还没有配置凭证。请到本插件设置面板的「登录 OrcaTerm」区块，" +
          "按提示用腾讯云账号登录后粘贴 __Secure-ot_session 的值。"
      );
    }

    let res;
    try {
      res = await fetch(ISSUE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          referer: `${ORIGIN}/terminal`,
          "user-agent": UA,
          cookie,
        },
        body: JSON.stringify({ action: "OAuthIssueAccessToken", data: {} }),
      });
    } catch (error) {
      throw new Error(`无法连接 ${ORIGIN}：${error?.message ?? error}`);
    }

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`续期响应不是 JSON：${text.slice(0, 160)}`);
    }

    const r = json?.data?.Response;
    if (!r || r.Error) {
      const msg = r?.Error?.Message || text.slice(0, 160);
      throw new Error(
        `凭证续期失败（${msg}）。\n` +
          "可能是登录状态已过期 —— 请到设置面板「登录 OrcaTerm」区块重新获取一次 __Secure-ot_session 的值。"
      );
    }
    if (!r.AccessToken) throw new Error(`续期未返回 token：${text.slice(0, 160)}`);

    const payload = parseJwt(r.AccessToken);
    const exp = payload && typeof payload.exp === "number" ? payload.exp : Math.floor(Date.now() / 1000) + 7200;
    cached = { token: r.AccessToken, exp, userId: payload?.userId };

    try {
      await mkdir(dirname(cacheFile), { recursive: true });
      await writeFile(cacheFile, JSON.stringify({ token: r.AccessToken, exp }), "utf8");
    } catch {}

    return cached;
  }

  /** 取可用 token（缓存 + 提前 10 分钟续期 + 并发去重）。 */
  async function getToken(force = false) {
    const now = Math.floor(Date.now() / 1000);

    if (!force && cached && cached.exp - now > 600) return cached;

    if (!force && !cached) {
      try {
        const raw = await readFile(cacheFile, "utf8");
        const j = JSON.parse(raw);
        if (j.token && j.exp - now > 600) {
          const p = parseJwt(j.token);
          cached = { token: j.token, exp: j.exp, userId: p?.userId };
          return cached;
        }
      } catch {}
    }

    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        return await issueToken();
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  /** 查额度：hunyuan_ai 每月次数等。 */
  async function fetchQuota() {
    const cookie = await resolveCookie();
    if (!cookie) throw new Error("未找到 Cookie，无法查询额度");

    const { token } = await getToken();
    const payload = parseJwt(token);
    const uin = payload?.userId ? String(payload.userId) : "";

    // DescribeUserBillingStatus 用 Cookie 会话鉴权（和网页一致）
    const url = `${CGI_API}?action=DescribeUserBillingStatus&uin=&ownerUin=${encodeURIComponent(
      (await resolveUinFromCookie(cookie)) || ""
    )}`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        referer: `${ORIGIN}/terminal`,
        "user-agent": UA,
        cookie,
      },
      body: JSON.stringify({ action: "DescribeUserBillingStatus", data: {} }),
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`额度响应不是 JSON：${text.slice(0, 160)}`);
    }

    const r = json?.data?.Response;
    if (!r || r.Error) {
      throw new Error(r?.Error?.Message || "额度查询失败");
    }

    const usage = Array.isArray(r.usageStats) ? r.usageStats : [];
    const ai = usage.find((u) => u.feature === "hunyuan_ai") || null;

    return {
      roleType: r.roleType || "unknown",
      userId: r.userId ?? null,
      tokenUserId: uin || null,
      ai: ai
        ? {
            limit: ai.quotaLimit,
            used: ai.quotaUsed,
            remaining: typeof ai.quotaLimit === "number" && ai.quotaUsed >= 0 ? Math.max(0, ai.quotaLimit - ai.quotaUsed) : null,
            startDate: ai.quotaStartDate,
            endDate: ai.quotaEndDate,
          }
        : null,
      all: usage.map((u) => ({
        feature: u.feature,
        limit: u.quotaLimit,
        used: u.quotaUsed,
        startDate: u.quotaStartDate,
        endDate: u.quotaEndDate,
      })),
    };
  }

  /** 从 Cookie 里取 ownerUin / uin，供 cgi 接口用。 */
  async function resolveUinFromCookie(cookie) {
    const m = String(cookie || "").match(/(?:^|;\s*)(?:ownerUin|uin)=([^;]+)/);
    if (!m) return "";
    return m[1].trim().replace(/^O/, "");
  }

  /** 查账号信息。 */
  async function fetchProfile() {
    const cookie = await resolveCookie();
    if (!cookie) throw new Error("未找到 Cookie");
    const uin = await resolveUinFromCookie(cookie);

    const res = await fetch(`${CGI_API}?action=GetUserInfo&uin=&ownerUin=${encodeURIComponent(uin)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        referer: `${ORIGIN}/terminal`,
        "user-agent": UA,
        cookie,
      },
      body: JSON.stringify({ action: "GetUserInfo", data: {} }),
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`账号响应不是 JSON：${text.slice(0, 160)}`);
    }
    const r = json?.data?.Response;
    if (!r || r.Error) throw new Error(r?.Error?.Message || "账号信息查询失败");

    return {
      userId: r.userId ?? null,
      uin: r.uin ?? null,
      ownerUin: r.ownerUin ?? null,
      nickName: r.nickName ?? null,
      accountType: r.userAccountType ?? null,
      loginMethod: r.userAccountLoginMethod ?? null,
    };
  }

  /** 连通性测试：发一条最短请求，看能否拿到正文。 */
  async function testModel(model, options = {}) {
    const target = model || runtime.model;
    const { token } = await getToken(true);
    const payload = parseJwt(token);
    const userId = payload?.userId ? String(payload.userId) : "";
    const seqId = crypto.randomUUID();
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 40000);

    try {
      const res = await fetch(`${CHAT_BASE}${CHAT_PATH}`, {
        method: "POST",
        headers: {
          "x-seqid": seqId,
          "X-Product": "orcaterm",
          authorization: `Bearer ${token}`,
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          conversationId: `cid-${crypto.randomUUID()}-orcaterm`,
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
              model: target,
              modelDesc: {
                kwargs: { thinking: { type: "enabled" }, reasoning_effort: runtime.reasoningEffort },
              },
              extra: {},
              selectedMCPTools: {},
              selectedUITools: {},
              a2a: {},
              hideToolMessage: true,
              language: "zh",
              multimodal: true,
              enableThinking: false,
            },
          },
          input: {
            type: "start",
            input: JSON.stringify({
              _format: "acp-prompt",
              version: 1,
              prompt: [{ type: "text", text: "只回复两个字：你好" }],
            }),
            id: seqId,
            emphasisPrompt: "",
            files: [],
          },
          stream: true,
        }),
      });

      if (!res.ok) {
        return {
          ok: false,
          model: target,
          status: res.status,
          latencyMs: Date.now() - started,
          error: `HTTP ${res.status}`,
        };
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let answer = "";
      let reasoning = "";
      let firstTokenMs = null;
      const startedAt = Date.now();

      while (Date.now() - startedAt < (options.timeoutMs ?? 40000)) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() || "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          const d = line.slice(5).trim();
          if (!d) continue;
          try {
            const e = JSON.parse(d);
            if (e.reasoning === true) {
              const t = typeof e.reasoningContent === "string" ? e.reasoningContent : "";
              if (t) {
                reasoning += t;
                if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
              }
            } else if (typeof e.content === "string" && e.content) {
              answer += e.content;
              if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
            }
          } catch {}
        }
        if (answer.length > 0 && /taskCompletion|action/.test(answer)) break;
      }
      try {
        reader.cancel();
      } catch {}

      const elapsed = Date.now() - started;
      const ok = answer.length > 0 || reasoning.length > 0;
      await usage.record({ model: target, ok, ms: elapsed, firstTokenMs });
      return {
        ok,
        model: target,
        status: 200,
        latencyMs: elapsed,
        firstTokenMs,
        answerPreview: answer.slice(0, 160),
        reasoningPreview: reasoning.slice(0, 160),
        error: ok ? null : "模型没有返回内容",
      };
    } catch (error) {
      await usage.record({
        model: target,
        ok: false,
        ms: Date.now() - started,
        error: error?.name === "AbortError" ? "超时" : String(error?.message ?? error),
      });
      return {
        ok: false,
        model: target,
        latencyMs: Date.now() - started,
        error: error?.name === "AbortError" ? "超时" : error?.message ?? String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 汇总状态，供面板首屏渲染。 */
  async function snapshot() {
    await ensureLoaded();

    const cookie = await resolveCookie();
    const info = {
      config: { ...runtime, models: DEFAULT_MODELS, options: OPTIONS },
      quotaNote: QUOTA_NOTE,
      usage: await usage.summary(30),
      cookie: {
        present: Boolean(cookie),
        length: cookie ? cookie.length : 0,
        source: cfg.cookie ? "patch" : process.env.ORCATERM_COOKIE ? "env" : cookie ? "file" : "none",
        file: cookieFile,
      },
      token: null,
      profile: null,
      quota: null,
      errors: {},
    };

    if (!cookie) {
      info.errors.cookie = "未配置 Cookie";
      return info;
    }

    try {
      const t = await getToken();
      const p = parseJwt(t.token);
      info.token = {
        valid: true,
        expiresAt: t.exp,
        expiresInSec: Math.max(0, t.exp - Math.floor(Date.now() / 1000)),
        userId: p?.userId ?? null,
        provider: p?.provider ?? null,
      };
    } catch (error) {
      info.token = { valid: false, error: error?.message ?? String(error) };
      info.errors.token = info.token.error;
    }

    try {
      info.profile = await fetchProfile();
    } catch (error) {
      info.errors.profile = error?.message ?? String(error);
    }

    try {
      info.quota = await fetchQuota();
    } catch (error) {
      info.errors.quota = error?.message ?? String(error);
    }

    return info;
  }

  return {
    snapshot,
    getRuntime: () => runtime,
    getModels: () => (Array.isArray(cfg.models) && cfg.models.length > 0 ? cfg.models : DEFAULT_MODELS),
    getToken,
    saveRuntime,
    saveCookie,
    resolveCookie,
    testModel,
    fetchQuota,
    fetchProfile,
    usage,
    noteCall,
    getLastCall: () => lastCall,
    configFile,
    cookieFile,
  };
}
