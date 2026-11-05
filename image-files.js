/**
 * 图片附件处理：把 DSH 的 ImageBlock 转成 OrcaTerm 的 input.files 条目。
 *
 * DSH 侧的图片块形状（实测自会话日志）：
 *   { type: "image", attachment: { attachmentId, mediaType, width, height, bytes, name } }
 * 其中 attachmentId 形如 "sha256:<hex>"，实际字节存放在
 *   ~/.dsh/attachments/<hex>
 *
 * OrcaTerm 侧的 files 条目形状（实测可用）：
 *   {
 *     name: "a1.png",
 *     mimeType: "image/png",
 *     bytes: "<裸 base64，不带 data: 前缀>",
 *     details: { acp: { type: "image", mimeType: "image/png" } }
 *   }
 *
 * 服务端限制（实测报错原文）：
 *   - MIME 白名单：image/png、image/jpeg、image/webp、image/gif
 *   - 单文件 10 MB；文件数 10；总量 50 MB
 *   - 不支持用 data: 或其它域名走 uri，只能走 bytes
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** 服务端接受的图片 MIME。 */
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/**
 * 没有视觉能力的模型。
 *
 * 实测（见 imgproto-REPORT.md）：
 *   - glm-5.3 收到非空 files 会硬 400（`rejected by an internal MaaS component`）
 *   - hy3 接受但无视觉，同一张「7」先答 2 再答 8，会给出错误答案
 * 对这两个模型主动丢弃图片，避免报错或误导。
 */
const NO_VISION_MODELS = new Set(["TokenHub/glm-5.3", "Hunyuan3/hy3"]);

/**
 * 判断某个模型是否支持图片输入。
 *
 * @param {string} model 模型 id。
 * @returns {boolean} 支持返回 true。
 */
export function supportsImages(model) {
  return !NO_VISION_MODELS.has(String(model ?? ""));
}

/** 服务端限制。 */
const LIMITS = {
  singleBytes: 10 * 1024 * 1024,
  count: 10,
  totalBytes: 50 * 1024 * 1024,
};

/** 按 MIME 给一个合适的扩展名，服务端会看 name 的扩展名。 */
function extFor(mime) {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
}

/** 取扩展名（小写，不含点）。 */
function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name ?? ""));
  return m ? m[1].toLowerCase() : "";
}

/**
 * DSH 的附件是内容寻址存储，实际路径形如：
 *   ~/.dsh/attachments/v1/objects/<hash 前两位>/<完整 hash>
 *
 * 早期版本把路径拼成 `~/.dsh/attachments/<hash>`，导致所有图片都 ENOENT。
 * 这里同时兼容新布局与旧的平铺布局。
 */
const ATTACHMENT_SUBDIR = "v1/objects";

/**
 * 从 attachmentId 里取出 hash。
 *
 * attachmentId 形如 "sha256:<hex>"，落盘用 <hex>。
 *
 * @param {string} attachmentId 附件 id。
 * @returns {string} hash 串。
 */
function fileNameOf(attachmentId) {
  const s = String(attachmentId ?? "");
  const at = s.indexOf(":");
  return at >= 0 ? s.slice(at + 1) : s;
}

/**
 * 读出附件字节，兼容内容寻址布局与旧的平铺布局。
 *
 * @param {string} baseDir 附件根目录。
 * @param {string} hash 附件 hash。
 * @returns {Promise<Buffer>} 文件内容。
 */
async function readAttachment(baseDir, hash) {
  const candidates = [
    // 内容寻址：objects/<前两位>/<hash>
    join(baseDir, ATTACHMENT_SUBDIR, hash.slice(0, 2), hash),
    // 旧布局兜底
    join(baseDir, hash),
    join(baseDir, "v1", hash),
  ];

  let lastError;
  for (const p of candidates) {
    try {
      return await readFile(p);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("附件不存在");
}

/**
 * 从消息列表里挑出「本轮新带进来的图片」。
 *
 * 背景（实测踩过的两个坑）：
 *   1. 无脑遍历所有消息 → 历史发过的图被反复重发，上游收到重复 payload，
 *      反而让模型答「没有收到图片」。
 *   2. 只取「最后一条 user 消息」→ 也不行。DSH 在用户发完消息后，会**再追加**
 *      两条自动消息（runtime context、time），所以最后一条 user 永远没有图片。
 *
 * 正确判据：本轮发的图，其消息**之后没有 assistant 回复**（模型还没答它）；
 * 历史图片之后必然跟着 assistant 的回复。据此从尾部往前找第一条
 * 「尚未被回复」的带图用户消息。
 *
 * @param {Array<object>} messages DSH 消息列表。
 * @returns {Array<object>} 本轮新图片的 image 块列表。
 */
function takeNewImageBlocks(messages) {
  const list = Array.isArray(messages) ? messages : [];

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (!m) continue;

    // 碰到模型回复：再往前的图片都属于历史，不再发送
    if (m.role === "assistant") return [];

    if (m.role !== "user") continue;

    const blocks = Array.isArray(m.content) ? m.content : [];
    const images = blocks.filter((b) => b && b.type === "image");
    if (images.length > 0) return images;
  }

  return [];
}

/**
 * 把 DSH 消息里的图片块转成 OrcaTerm files 条目。
 *
 * @param {Array<object>} messages DSH 消息列表。
 * @param {object} [options]
 * @param {string} [options.attachmentsDir] 附件目录，默认 ~/.dsh/attachments。
 * @param {string} [options.model] 本次调用的模型；用于跳过没有视觉能力的模型。
 * @returns {Promise<{ files: Array<object>, skipped: Array<object> }>}
 *   files 为可直接放进 input.files 的条目；skipped 记录被跳过的原因。
 */
export async function collectImageFiles(messages, { attachmentsDir, model } = {}) {
  const dir = attachmentsDir ?? join(homedir(), ".dsh", "attachments");
  const files = [];
  const skipped = [];
  let totalBytes = 0;

  /** 该模型是否支持图片；不支持时全部跳过并说明原因。 */
  const visionOk = supportsImages(model);

  /** 只处理本轮新增的图片，避免历史图片被反复重发。 */
  const imageBlocks = takeNewImageBlocks(messages);

  for (const b of imageBlocks) {
    if (!visionOk) {
      skipped.push({
        reason: `当前模型 ${model} 不支持图片识别，已忽略图片（可切换到 DeepSeek V4.1 Flash 或 Kimi K3）`,
        name: b.attachment?.name,
      });
      continue;
    }

    const att = b.attachment;
    if (!att) {
      skipped.push({ reason: "没有 attachment" });
      continue;
    }

    const mediaType = String(att.mediaType ?? "");
    if (!ALLOWED_MIME.has(mediaType)) {
      skipped.push({ reason: `不支持的图片格式 ${mediaType || "未知"}`, name: att.name });
      continue;
    }

    const declared = Number(att.bytes ?? 0);
    if (declared > LIMITS.singleBytes) {
      skipped.push({ reason: `单张超过 10MB（${declared}）`, name: att.name });
      continue;
    }
    if (files.length >= LIMITS.count) {
      skipped.push({ reason: "超过 10 张", name: att.name });
      continue;
    }
    if (totalBytes + declared > LIMITS.totalBytes) {
      skipped.push({ reason: "总量超过 50MB", name: att.name });
      continue;
    }

    let buf;
    try {
      buf = await readAttachment(dir, fileNameOf(att.attachmentId));
    } catch (error) {
      skipped.push({ reason: `读取附件失败：${error?.message ?? error}`, name: att.name });
      continue;
    }

    if (buf.length > LIMITS.singleBytes) {
      skipped.push({ reason: `单张超过 10MB（实际 ${buf.length}）`, name: att.name });
      continue;
    }

    // 文件名：保留原名但确保扩展名与 MIME 一致（服务端会校验扩展名）
    const base = String(att.name ?? "").replace(/\.[a-z0-9]+$/i, "") || "image";
    const wantExt = extFor(mediaType);
    const haveExt = extOf(att.name);
    const name = haveExt === wantExt || (wantExt === "jpg" && haveExt === "jpeg")
      ? `${base}.${haveExt || wantExt}`
      : `${base}.${wantExt}`;

    files.push({
      name,
      mimeType: mediaType,
      bytes: buf.toString("base64"),
      details: { acp: { type: "image", mimeType: mediaType } },
    });
    totalBytes += buf.length;
  }

  return { files, skipped };
}

export { ALLOWED_MIME, LIMITS, NO_VISION_MODELS };
