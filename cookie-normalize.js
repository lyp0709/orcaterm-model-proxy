/**
 * OrcaTerm 凭证归一化。
 *
 * 实测结论（见 p0-cookie-probe.mjs / p0-session-probe.mjs）：
 *   - 换 token 只需要 `__Secure-ot_session` 这一个 Cookie，
 *     其余（lifeId、userId、ot_login、Hm_* 统计等）全部可省。
 *   - `__Secure-ot_session` 不绑定 UA，长期有效。
 *   - `ot_sid` 由服务端在每次响应里用 Set-Cookie 自动续期，
 *     所以本地不需要保存它 —— 保存了也会过期。
 *
 * 因此本模块接受两种输入：
 *   1. 完整的 Cookie 请求头字符串（用户从 DevTools 整条复制）
 *   2. 单独的 __Secure-ot_session 值（80 字符左右）
 * 统一归一化成「只含 __Secure-ot_session 的最小 Cookie 串」。
 */

/** 长期凭证的 Cookie 名。 */
const SESSION_COOKIE = "__Secure-ot_session";

/**
 * 从一段文本里取出 __Secure-ot_session 的值。
 *
 * 输入可能是整条 Cookie、也可能是裸值（用户只复制了 Value 列）。
 *
 * @param {string} raw 原始输入。
 * @returns {string | null} 凭证值；没找到返回 null。
 */
function extractSession(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  // 形如 `...; __Secure-ot_session=xxx; ...`
  const m = new RegExp(`(?:^|[;\\s])${SESSION_COOKIE.replace(/\./g, "\\.")}=([^;\\s]+)`).exec(text);
  if (m) return decodeURIComponent(m[1].trim());

  // 裸值：<uuid>.<43字符 base64url>
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{20,}$/i.test(text)) {
    return text;
  }

  return null;
}

/**
 * 把用户输入归一化成最小 Cookie 串。
 *
 * @param {string} raw 用户输入（整条 Cookie 或裸值）。
 * @returns {{ cookie: string, extracted: boolean, hint?: string }}
 *   `cookie` 是可直接放进请求头的字符串；`extracted` 表示是否从整条里提取过。
 * @throws {Error} 输入里找不到有效凭证时抛出，带可展示的提示。
 */
export function normalizeCookie(raw) {
  const text = String(raw ?? "").trim();
  if (!text) {
    throw new Error("内容为空。请粘贴 __Secure-ot_session 的值，或整条 Cookie。");
  }

  const session = extractSession(text);
  if (!session) {
    throw new Error(
      "没有找到 __Secure-ot_session。\n" +
        "请确认复制的是 orcaterm.ai 站点下的 __Secure-ot_session 这一行（Name 列），" +
        "或者直接复制整条 Cookie 请求头。"
    );
  }

  // 值里含分号或空白说明截取有误，避免拼出坏请求头
  if (/[;\s]/.test(session)) {
    throw new Error("__Secure-ot_session 的值格式不正确（含分号或空白），请重新复制。");
  }

  return {
    cookie: `${SESSION_COOKIE}=${session}`,
    extracted: text.length > session.length + SESSION_COOKIE.length + 1,
  };
}

/**
 * 判断一个 Cookie 串是否为最小形态（只含长期凭证）。
 *
 * @param {string} cookie Cookie 串。
 * @returns {boolean} 是则 true。
 */
export function isMinimalCookie(cookie) {
  const parts = String(cookie ?? "")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length === 1 && parts[0].startsWith(`${SESSION_COOKIE}=`);
}

export { SESSION_COOKIE };
