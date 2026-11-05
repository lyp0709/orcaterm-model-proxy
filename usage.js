/**
 * 本地调用统计。
 *
 * OrcaTerm 官方在限时免费期不计数（实测 used 恒为 0），所以这里自己记：
 * 每次调用落一条记录，按天聚合，面板据此展示真实用量。
 *
 * 存储：`~/.dsh/orcaterm-usage.json`
 *   { version: 1, days: { "2026-11-04": { total, ok, fail, models: {id: {n, ok, fail, ms}} } } }
 * 只保留最近 N 天，避免无限增长。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const KEEP_DAYS = 90;
const FILE = () => join(homedir(), ".dsh", "orcaterm-usage.json");

/** 本地时区的 YYYY-MM-DD。 */
function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 创建统计器。 */
export function createUsageStore() {
  let cache = null;
  let writing = null;

  async function load() {
    if (cache) return cache;
    try {
      const raw = await readFile(FILE(), "utf8");
      const parsed = JSON.parse(raw);
      cache = parsed && typeof parsed === "object" && parsed.days ? parsed : { version: 1, days: {} };
    } catch {
      cache = { version: 1, days: {} };
    }
    return cache;
  }

  /** 原子写：合并并发调用，避免互相覆盖。 */
  async function persist() {
    if (writing) return writing;
    writing = (async () => {
      try {
        const data = await load();
        await mkdir(dirname(FILE()), { recursive: true });
        await writeFile(FILE(), JSON.stringify(data), "utf8");
      } catch {
        // 统计失败不影响主流程
      } finally {
        writing = null;
      }
    })();
    return writing;
  }

  /**
   * 记录一次调用。
   *
   * @param {object} entry
   * @param {string} entry.model 模型 id。
   * @param {boolean} entry.ok 是否成功。
   * @param {number} [entry.ms] 总耗时。
   * @param {number} [entry.firstTokenMs] 首字延迟。
   * @param {string} [entry.error] 失败原因。
   */
  async function record(entry) {
    const data = await load();
    const key = dayKey();
    const day = data.days[key] || (data.days[key] = { total: 0, ok: 0, fail: 0, models: {} });

    day.total += 1;
    if (entry.ok) day.ok += 1;
    else day.fail += 1;

    const modelId = entry.model || "unknown";
    const m = day.models[modelId] || (day.models[modelId] = { n: 0, ok: 0, fail: 0, msSum: 0, msCount: 0, ftSum: 0, ftCount: 0 });
    m.n += 1;
    if (entry.ok) m.ok += 1;
    else m.fail += 1;
    if (typeof entry.ms === "number" && entry.ms >= 0) {
      m.msSum += entry.ms;
      m.msCount += 1;
    }
    if (typeof entry.firstTokenMs === "number" && entry.firstTokenMs >= 0) {
      m.ftSum += entry.firstTokenMs;
      m.ftCount += 1;
    }

    await prune(data);
    await persist();
  }

  /** 清理超期数据。 */
  async function prune(data) {
    const keys = Object.keys(data.days).sort();
    if (keys.length <= KEEP_DAYS) return;
    for (const k of keys.slice(0, keys.length - KEEP_DAYS)) delete data.days[k];
  }

  /**
   * 汇总统计。
   *
   * @param {number} days 统计最近多少天，默认 30。
   * @returns {Promise<object>} 供面板渲染的汇总。
   */
  async function summary(days = 30) {
    const data = await load();
    const today = dayKey();
    const cutoff = Date.now() - days * 86400_000;

    const dayRows = [];
    const modelTotals = {};
    let rangeTotal = 0;
    let rangeOk = 0;
    let rangeFail = 0;

    for (const [key, day] of Object.entries(data.days)) {
      const ts = new Date(`${key}T00:00:00`).getTime();
      if (Number.isNaN(ts) || ts < cutoff) continue;

      dayRows.push({ date: key, total: day.total, ok: day.ok, fail: day.fail });
      rangeTotal += day.total;
      rangeOk += day.ok;
      rangeFail += day.fail;

      for (const [modelId, m] of Object.entries(day.models || {})) {
        const t = modelTotals[modelId] || (modelTotals[modelId] = { n: 0, ok: 0, fail: 0, msSum: 0, msCount: 0, ftSum: 0, ftCount: 0 });
        t.n += m.n;
        t.ok += m.ok;
        t.fail += m.fail;
        t.msSum += m.msSum || 0;
        t.msCount += m.msCount || 0;
        t.ftSum += m.ftSum || 0;
        t.ftCount += m.ftCount || 0;
      }
    }

    dayRows.sort((a, b) => a.date.localeCompare(b.date));

    const models = Object.entries(modelTotals)
      .map(([id, t]) => ({
        id,
        n: t.n,
        ok: t.ok,
        fail: t.fail,
        avgMs: t.msCount > 0 ? Math.round(t.msSum / t.msCount) : null,
        avgFirstTokenMs: t.ftCount > 0 ? Math.round(t.ftSum / t.ftCount) : null,
      }))
      .sort((a, b) => b.n - a.n);

    const todayRow = data.days[today] || { total: 0, ok: 0, fail: 0, models: {} };

    return {
      today: { date: today, total: todayRow.total, ok: todayRow.ok, fail: todayRow.fail },
      range: { days, total: rangeTotal, ok: rangeOk, fail: rangeFail },
      days: dayRows,
      models,
      successRate: rangeTotal > 0 ? Math.round((rangeOk / rangeTotal) * 100) : null,
    };
  }

  /** 清空统计。 */
  async function reset() {
    cache = { version: 1, days: {} };
    await persist();
  }

  return { record, summary, reset, file: FILE() };
}
