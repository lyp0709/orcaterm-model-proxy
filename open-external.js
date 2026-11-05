/**
 * 用系统默认浏览器打开 URL。
 *
 * 参照 dsh-our-free-model 的实现方式（src/open-external.js）：
 * 通过系统启动器打开，不依赖 Electron API —— 插件运行在 Node 宿主里，
 * 拿不到 Electron 的 shell 对象。
 *
 * 安全约束：只允许 http/https，且长度受限，避免被拼进命令行注入。
 */
import childProcess from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

/** URL 长度上限。 */
const MAX_URL_LENGTH = 2048;

/**
 * 校验并规范化外部 URL。
 *
 * @param {string} value 候选 URL。
 * @returns {string | null} 规范化后的 URL；不合法返回 null。
 */
export function externalUrl(value) {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (!url.hostname || url.username || url.password) return null;
    if (url.href.length > MAX_URL_LENGTH) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * 打开系统默认浏览器。
 *
 * @param {string} value URL。
 * @param {object} [options]
 * @param {string} [options.platform] 平台，默认 process.platform。
 * @param {string} [options.systemRoot] Windows 系统目录。
 * @returns {Promise<boolean>} 是否成功唤起。
 */
export async function openExternal(value, {
  platform = process.platform,
  systemRoot = process.env.SystemRoot ?? "C:\\Windows",
} = {}) {
  const url = externalUrl(value);
  if (url === null) return false;

  const runFile = promisify(childProcess.execFile);
  try {
    if (platform === "win32") {
      // 用 PowerShell 的 Start-Process，避免 cmd 的 & 转义问题
      const script = `Start-Process -FilePath '${url.replaceAll("'", "''")}' -ErrorAction Stop`;
      await runFile(
        path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { windowsHide: true, timeout: 10000 }
      );
    } else if (platform === "darwin") {
      await runFile("/usr/bin/open", [url], { timeout: 10000 });
    } else {
      await runFile("xdg-open", [url], { timeout: 10000 });
    }
    return true;
  } catch {
    return false;
  }
}
