/**
 * 通过 CDP 自动获取 OrcaTerm 凭证。
 *
 * 背景（见 p0-verify-decrypt.mjs / p0-cdp-cookie.mjs）：
 *   - Chrome 127+ / Edge 新版把 Cookie 加密成 v20（App-Bound Encryption），
 *     密钥与浏览器进程身份绑定，第三方进程**无法解密**。
 *   - 但浏览器自己解密得开。只要让浏览器开着 DevTools 调试端口，
 *     就能通过 CDP 的 Network.getCookies 拿到**明文** Cookie。
 *   - 实测：用独立 profile 启动 Edge + --remote-debugging-port，
 *     能读到任意站点的明文 Cookie（含 v20 加密的）。
 *
 * 本模块流程：
 *   1. 用独立 profile 启动 Edge/Chrome，开启调试端口
 *   2. 导航到 orcaterm.ai 登录页
 *   3. 轮询检查是否已登录（Cookie 里出现 __Secure-ot_session）
 *   4. 读到就立刻返回并关闭浏览器
 *
 * 为什么要独立 profile：用户的日常浏览器如果已经在运行，新传的启动参数
 * 会被忽略（端口起不来）；而且往用户 profile 里塞调试端口有隐私风险。
 * 独立 profile 干净、可随时删除，用户在里面登录一次后状态可保留。
 */
import { spawn } from "node:child_process";
import { mkdir, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

/** 长期凭证的 Cookie 名。 */
const SESSION_COOKIE = "__Secure-ot_session";

/** 登录页。 */
const LOGIN_URL = "https://orcaterm.ai/terminal";

/** 调试端口。选一个冷门端口，减少冲突。 */
const DEBUG_PORT = 9333;

/** 浏览器候选路径（按优先级）。 */
const BROWSER_CANDIDATES = [
  { name: "Edge", paths: [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ] },
  { name: "Chrome", paths: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ] },
];

/**
 * 找一个可用的浏览器可执行文件。
 *
 * @returns {{ name: string, path: string } | null}
 */
function findBrowser() {
  for (const b of BROWSER_CANDIDATES) {
    for (const p of b.paths) {
      if (p && existsSync(p)) return { name: b.name, path: p };
    }
  }
  return null;
}

/**
 * 独立 profile 目录。
 *
 * 放在 ~/.dsh 下，这样用户登录一次后状态能保留，
 * 下次再点「自动登录」不需要重新扫码。
 *
 * @returns {string} 目录路径。
 */
function profileDir() {
  return join(homedir(), ".dsh", "orcaterm-login-profile");
}

/**
 * 等待 CDP 端口就绪。
 *
 * @param {number} port 端口。
 * @param {AbortSignal} [signal] 中止信号。
 * @param {number} [timeoutMs] 超时。
 * @returns {Promise<object | null>} version 信息。
 */
async function waitForCdp(port, signal, timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) return null;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

/**
 * 建立一个 CDP 连接。
 *
 * @param {string} wsUrl 浏览器级 WebSocket 地址。
 * @returns {Promise<object>} 带 send/close 的客户端。
 */
function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();

    ws.addEventListener("open", () => {
      resolve({
        send(method, params = {}, sessionId) {
          return new Promise((res, rej) => {
            const id = nextId++;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id);
                rej(new Error(`CDP 超时: ${method}`));
              }
            }, 15000);
          });
        },
        close() {
          try { ws.close(); } catch {}
        },
      });
    });

    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(`${msg.error.message} (${msg.error.code})`));
        else res(msg.result);
      }
    });

    ws.addEventListener("error", () => reject(new Error("CDP WebSocket 连接失败")));
  });
}

/**
 * 启动自动登录流程。
 *
 * 启动浏览器并等待用户完成登录，读到凭证后立即关闭浏览器。
 *
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] 中止信号（用户取消时用）。
 * @param {(stage: string, detail?: string) => void} [options.onProgress] 进度回调。
 * @param {number} [options.timeoutMs] 总超时，默认 5 分钟。
 * @returns {Promise<{ ok: true, cookie: string } | { ok: false, error: string }>}
 */
export async function startAutoLogin({ signal, onProgress, timeoutMs = 5 * 60 * 1000 } = {}) {
  const report = (stage, detail) => {
    try { onProgress?.(stage, detail); } catch {}
  };

  if (process.platform !== "win32" && process.platform !== "darwin") {
    return { ok: false, error: "自动登录目前只支持 Windows 和 macOS。请改用手动方式粘贴凭证。" };
  }

  const browser = findBrowser();
  if (!browser) {
    return { ok: false, error: "没找到 Edge 或 Chrome。请安装任意一个，或改用手动方式粘贴凭证。" };
  }

  const userDir = profileDir();
  await mkdir(userDir, { recursive: true });

  report("launching", `正在启动 ${browser.name}…`);

  /** 浏览器进程。 */
  const child = spawn(browser.path, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    LOGIN_URL,
  ], { detached: false, stdio: "ignore" });

  let childExited = false;
  child.on("exit", () => { childExited = true; });
  child.on("error", () => { childExited = true; });

  /**
   * 判断浏览器是否真的没了。
   *
   * ⚠️ 不能只看子进程的 exit 事件：Windows 上 Edge/Chrome 启动后，
   * 最初那个进程常常会立刻退出并把工作交给已存在的实例或其他子进程，
   * 此时 CDP 端口仍然可用。所以以「CDP 还能不能连」为准。
   *
   * @returns {Promise<boolean>} 浏览器确实不可用时返回 true。
   */
  async function browserGone() {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`, {
        signal: AbortSignal.timeout(1200),
      });
      return !r.ok;
    } catch {
      // 连不上：只有子进程也退出了才认定浏览器没了
      return childExited;
    }
  }

  let client = null;
  const cleanup = () => {
    try { client?.close(); } catch {}
    try { child.kill(); } catch {}
  };

  try {
    const version = await waitForCdp(DEBUG_PORT, signal);
    if (!version) {
      cleanup();
      if (signal?.aborted) return { ok: false, error: "已取消" };
      return {
        ok: false,
        error:
          "浏览器调试端口没有就绪。可能的原因：调试端口被占用，或浏览器启动失败。\n" +
          "请关闭所有 Edge/Chrome 窗口后重试，或改用手动方式粘贴凭证。",
      };
    }

    report("waiting", "请在打开的浏览器里完成登录");

    client = await cdpConnect(version.webSocketDebuggerUrl);

    // 找到一个页面 target 并附着
    const targets = await client.send("Target.getTargets");
    const page = targets.targetInfos.find((t) => t.type === "page");
    if (!page) {
      cleanup();
      return { ok: false, error: "浏览器里没有可用页面，请重试。" };
    }

    const { sessionId } = await client.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    await client.send("Network.enable", {}, sessionId);

    // 确保停在登录页（attach 之后页面可能变了）
    const currentTargets = await client.send("Target.getTargets");
    const cur = currentTargets.targetInfos.find((t) => t.type === "page");
    if (cur && !/orcaterm\.ai/.test(cur.url)) {
      await client.send("Page.navigate", { url: LOGIN_URL }, sessionId);
    }

    report("polling", "等待登录完成…");

    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (signal?.aborted) {
        cleanup();
        return { ok: false, error: "已取消" };
      }
      // 用 CDP 端口是否还活着判断浏览器状态（不能只看子进程 exit）
      if (await browserGone()) {
        cleanup();
        return {
          ok: false,
          error: "浏览器被关闭了，登录未完成。请重试，并在登录成功后让窗口保持打开几秒。",
        };
      }

      try {
        const r = await client.send(
          "Network.getCookies",
          { urls: ["https://orcaterm.ai", "https://orcaterm.ai/terminal"] },
          sessionId,
        );
        const session = (r.cookies ?? []).find((c) => c.name === SESSION_COOKIE);
        if (session?.value) {
          report("done", "已获取凭证");
          cleanup();
          return { ok: true, cookie: `${SESSION_COOKIE}=${session.value}` };
        }
      } catch {
        // 页面跳转期间可能短暂失败，忽略继续轮询
      }

      const waited = Math.round((Date.now() - started) / 1000);
      if (waited > 0 && waited % 15 === 0) {
        report("polling", `已等待 ${waited} 秒，请确认已在浏览器里登录完成`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    cleanup();
    return {
      ok: false,
      error: `等待登录超时（${Math.round(timeoutMs / 60000)} 分钟）。请重试，或改用手动方式粘贴凭证。`,
    };
  } catch (error) {
    cleanup();
    return { ok: false, error: `自动登录出错：${error?.message ?? error}` };
  }
}

/**
 * 清除登录用的浏览器 profile。
 *
 * 用户退出登录或想换账号时调用，避免残留旧会话。
 *
 * @returns {Promise<void>}
 */
export async function clearLoginProfile() {
  const dir = profileDir();
  try {
    await access(dir);
  } catch {
    return; // 不存在就算了
  }
  await rm(dir, { recursive: true, force: true });
}

export { SESSION_COOKIE, LOGIN_URL, DEBUG_PORT };
