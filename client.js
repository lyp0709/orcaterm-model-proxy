/**
 * OrcaTerm 设置面板（浏览器侧）。
 *
 * 通过 /api/orcaterm/* 与 Host 通信，提供：
 *   - 账号与额度概览
 *   - Cookie 管理（粘贴 / 更新 / 校验）
 *   - Token 状态与手动续期
 *   - 默认模型 / 推理强度 / 思考显示
 *   - 逐模型连通性测试
 */
window.__ModuleLoader__.load({
  id: 'orcaterm-model-proxy',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    const NS = 'orcaterm-model-proxy';
    const API = 'api/orcaterm';

    /** 解析接口地址：用 baseURI 兜底反向代理子路径。 */
    function apiUrl(path) {
      const base = new URL(API + '/', document.baseURI);
      return new URL(path, base).toString();
    }

    async function api(path, options) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options?.timeout ?? 60000);
      try {
        const res = await fetch(apiUrl(path), {
          credentials: 'same-origin',
          ...options,
          signal: controller.signal,
          headers: {
            ...(options?.body ? { 'content-type': 'application/json' } : {}),
            ...(options?.headers ?? {}),
          },
        });
        const text = await res.text();
        let payload;
        try {
          payload = text ? JSON.parse(text) : undefined;
        } catch {
          throw new Error(`响应不是合法 JSON（HTTP ${res.status}）`);
        }
        if (!res.ok) throw new Error(payload?.error ?? `HTTP ${res.status}`);
        return payload;
      } finally {
        clearTimeout(timer);
      }
    }

    // ---------- 样式（只依赖主题 token） ----------
    const CSS = `
.ot-wrap { display: flex; flex-direction: column; gap: 20px; padding: 4px 2px 32px; }
.ot-card {
  border: 1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.22));
  border-radius: 10px; padding: 16px 18px; background: transparent;
}
.ot-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.ot-card-title { font-size: 13px; font-weight: 600; letter-spacing: .01em; }
.ot-card-sub { font-size: 12px; opacity: .62; margin-top: 3px; line-height: 1.5; }
.ot-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 9px 0; }
.ot-row + .ot-row { border-top: 1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.14)); }
.ot-label { font-size: 12.5px; }
.ot-hint { font-size: 11.5px; opacity: .55; margin-top: 2px; line-height: 1.5; }
.ot-value { font-size: 12.5px; font-variant-numeric: tabular-nums; }
.ot-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
.ot-btn {
  border: 1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.3));
  background: transparent; color: inherit; border-radius: 7px;
  padding: 5px 12px; font-size: 12px; cursor: pointer; white-space: nowrap;
  transition: background .12s ease, border-color .12s ease;
}
.ot-btn:hover:not(:disabled) { background: var(--dsw-alias-fill-subtle, rgba(128,128,128,.1)); }
.ot-btn:disabled { opacity: .45; cursor: default; }
.ot-btn-primary {
  background: var(--dsw-alias-accent, #2b7fff); color: #fff;
  border-color: transparent;
}
.ot-btn-primary:hover:not(:disabled) { opacity: .88; background: var(--dsw-alias-accent, #2b7fff); }
.ot-input, .ot-select {
  background: var(--dsw-alias-fill-subtle, rgba(128,128,128,.08));
  border: 1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.24));
  color: inherit; border-radius: 7px; padding: 6px 9px; font-size: 12px;
  font-family: inherit; outline: none; min-width: 0;
}
.ot-input:focus, .ot-select:focus { border-color: var(--dsw-alias-accent, #2b7fff); }
.ot-textarea { width: 100%; min-height: 74px; resize: vertical; line-height: 1.55; box-sizing: border-box; }
.ot-badge {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.3));
}
.ot-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.ot-ok { color: var(--dsw-alias-success, #16a34a); }
.ot-bad { color: var(--dsw-alias-danger, #dc2626); }
.ot-warn { color: var(--dsw-alias-warning, #d97706); }
.ot-err {
  font-size: 11.5px; line-height: 1.55; color: var(--dsw-alias-danger, #dc2626);
  margin-top: 10px; white-space: pre-wrap; word-break: break-word;
}
.ot-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.ot-bar { height: 6px; border-radius: 999px; background: var(--dsw-alias-fill-subtle, rgba(128,128,128,.16)); overflow: hidden; margin-top: 8px; }
.ot-bar-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-accent, #2b7fff); transition: width .3s ease; }
.ot-models { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; }
.ot-note {
  margin-top: 12px; padding: 10px 12px; border-radius: 8px;
  background: var(--dsw-alias-fill-subtle, rgba(128,128,128,.08));
  border-left: 2px solid var(--dsw-alias-accent, #2b7fff);
  font-size: 11.5px; line-height: 1.62; opacity: .82;
}
.ot-note-line + .ot-note-line { margin-top: 4px; }

/* ---- 登录引导 ---- */
.ot-login-step { display: flex; flex-direction: column; gap: 10px; }
.ot-login-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.ot-login-progress {
  display: flex; align-items: center; gap: 8px;
  margin-top: 14px; padding: 10px 12px; border-radius: 8px;
  background: var(--dsw-alias-fill-subtle, rgba(128,128,128,.08));
  font-size: 12.5px;
}
.ot-spinner {
  flex: 0 0 auto; width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.3));
  border-top-color: var(--dsw-alias-accent, #2b7fff);
  animation: otSpin .8s linear infinite;
}
@keyframes otSpin { to { transform: rotate(360deg); } }

/* ---- 操作结果提示 ---- */
.ot-toast {
  border-radius: 10px; padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.24));
  background: var(--dsw-alias-fill-subtle, rgba(128,128,128,.08));
  animation: otToastIn .18s ease-out;
}
@keyframes otToastIn {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}
.ot-toast-ok {
  border-color: var(--dsw-alias-success, #16a34a);
  border-left-width: 3px;
}
.ot-toast-warn {
  border-color: var(--dsw-alias-warning, #d97706);
  border-left-width: 3px;
}
.ot-toast-head { display: flex; align-items: center; gap: 8px; }
.ot-toast-icon {
  flex: 0 0 auto; width: 18px; height: 18px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700; color: #fff;
}
.ot-toast-ok .ot-toast-icon { background: var(--dsw-alias-success, #16a34a); }
.ot-toast-warn .ot-toast-icon { background: var(--dsw-alias-warning, #d97706); }
.ot-toast-title { font-size: 13px; font-weight: 600; flex: 1 1 auto; }
.ot-toast-close {
  flex: 0 0 auto; border: none; background: transparent; color: inherit;
  cursor: pointer; font-size: 16px; line-height: 1; opacity: .5; padding: 0 2px;
}
.ot-toast-close:hover { opacity: 1; }
.ot-toast-detail {
  font-size: 12px; line-height: 1.65; margin-top: 6px; opacity: .85;
  padding-left: 26px; word-break: break-word;
}

/* ---- 模型行：左信息 / 右操作，两栏不挤压 ---- */
.ot-model {
  display: flex; align-items: center; gap: 16px;
  padding: 10px 0; font-size: 12.5px;
}
.ot-model + .ot-model { border-top: 1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.12)); }

/* 左栏可压缩，内部标题与副信息各自不换行 */
.ot-model-info { flex: 1 1 auto; min-width: 0; }
.ot-model-title { display: flex; align-items: center; gap: 7px; min-width: 0; }
.ot-model-title-text {
  font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ot-model-meta {
  display: flex; align-items: center; gap: 6px; margin-top: 3px;
  font-size: 11px; opacity: .52; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}

/* 右栏固定，永不换行 */
.ot-model-ops { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }

/* 胶囊小标签：单行、不参与挤压 */
.ot-chip {
  flex: 0 0 auto; font-size: 10.5px; line-height: 1.6;
  padding: 0 6px; border-radius: 4px; white-space: nowrap;
}
.ot-chip-free { color: var(--dsw-alias-success, #16a34a); border: 1px solid currentColor; }
.ot-chip-default { color: var(--dsw-alias-accent, #2b7fff); border: 1px solid currentColor; }

.ot-sep { opacity: .5; }
.ot-meta-ok { color: var(--dsw-alias-success, #16a34a); opacity: .9; }
.ot-meta-bad { color: var(--dsw-alias-danger, #dc2626); opacity: .9; }
.ot-btn-sm { padding: 3px 10px; font-size: 11.5px; }

/* ---- 用量统计：紧凑两栏 ---- */
.ot-sub-title {
  font-size: 11px; font-weight: 600; opacity: .55;
  letter-spacing: .02em; margin-bottom: 4px;
}
.ot-stat-row {
  display: flex; align-items: center; justify-content: space-between; gap: 14px;
  padding: 7px 0; font-size: 12.5px;
}
.ot-stat-row + .ot-stat-row { border-top: 1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.1)); }
.ot-stat-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ot-stat-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ot-stat-right {
  display: flex; align-items: center; gap: 10px; flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}
.ot-chip-fail {
  flex: 0 0 auto; font-size: 10.5px; line-height: 1.6; padding: 0 6px;
  border-radius: 4px; white-space: nowrap;
  color: var(--dsw-alias-danger, #dc2626); border: 1px solid currentColor;
}
.ot-empty {
  margin-top: 12px; font-size: 11.5px; opacity: .55; line-height: 1.6;
}

.ot-spin { display: inline-block; width: 11px; height: 11px; border: 1.5px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: ot-spin .7s linear infinite; }
@keyframes ot-spin { to { transform: rotate(360deg); } }
.ot-radio { display: flex; gap: 4px; }
.ot-radio-item {
  border: 1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.3));
  background: transparent; color: inherit; border-radius: 6px;
  padding: 4px 11px; font-size: 11.5px; cursor: pointer;
}
.ot-radio-item[data-on="1"] {
  background: var(--dsw-alias-accent, #2b7fff); color: #fff; border-color: transparent;
}
`;

    // ---------- 小工具组件 ----------
    function Badge({ tone, children }) {
      return h('span', { className: `ot-badge ot-${tone}` }, h('span', { className: 'ot-dot' }), children);
    }

    function Row({ label, hint, children }) {
      return h(
        'div',
        { className: 'ot-row' },
        h('div', null, h('div', { className: 'ot-label' }, label), hint ? h('div', { className: 'ot-hint' }, hint) : null),
        h('div', { className: 'ot-value' }, children),
      );
    }

    function Card({ title, sub, actions, children }) {
      return h(
        'section',
        { className: 'ot-card' },
        h(
          'div',
          { className: 'ot-card-head' },
          h('div', null, h('div', { className: 'ot-card-title' }, title), sub ? h('div', { className: 'ot-card-sub' }, sub) : null),
          actions ? h('div', { className: 'ot-actions' }, actions) : null,
        ),
        children,
      );
    }

    /** 把秒数渲染成“x 小时 y 分”。 */
    function humanize(sec) {
      if (typeof sec !== 'number' || sec <= 0) return '已过期';
      const m = Math.floor(sec / 60);
      if (m < 60) return `${m} 分钟`;
      const hh = Math.floor(m / 60);
      const mm = m % 60;
      return mm ? `${hh} 小时 ${mm} 分` : `${hh} 小时`;
    }

    // ---------- 主面板 ----------
    function OrcaTermSettings() {
      const [status, setStatus] = useState({ loading: true, data: null, error: '' });
      const [busy, setBusy] = useState('');
      const [actionError, setActionError] = useState('');
      const [cookieDraft, setCookieDraft] = useState('');
      const [tests, setTests] = useState({});
      const [testing, setTesting] = useState('');
      /** 登录引导：分步说明内容（从 Host 拉取）。 */
      const [loginHelp, setLoginHelp] = useState(null);
      /** 是否展开步骤说明。 */
      const [showSteps, setShowSteps] = useState(false);
      /** 登录相关错误提示。 */
      const [loginErr, setLoginErr] = useState('');
      /** 自动登录任务状态（从 Host 轮询）。 */
      const [login, setLogin] = useState({ running: false, stage: 'idle', detail: '', error: '', saved: false, elapsedMs: 0 });
      /** 是否展开手动输入方式。 */
      const [showManual, setShowManual] = useState(false);
      /** 操作成功提示：{ kind, title, detail } 或 null。 */
      const [notice, setNotice] = useState(null);
      /** 提示自动消失的定时器。 */
      const noticeTimer = useRef(null);

      /**
       * 显示一条成功提示，几秒后自动收起。
       *
       * @param {{ kind?: string, title: string, detail?: string }} info 提示内容。
       */
      const flash = useCallback((info) => {
        if (noticeTimer.current) clearTimeout(noticeTimer.current);
        setNotice({ kind: 'ok', ...info });
        noticeTimer.current = setTimeout(() => setNotice(null), 6000);
      }, []);

      useEffect(
        () => () => {
          if (noticeTimer.current) clearTimeout(noticeTimer.current);
        },
        [],
      );

      const load = useCallback(async () => {
        setStatus((s) => ({ ...s, loading: true }));
        try {
          const data = await api('status', { timeout: 90000 });
          setStatus({ loading: false, data, error: '' });
        } catch (error) {
          setStatus({ loading: false, data: null, error: error?.message ?? String(error) });
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      // 登录引导内容（步骤文案）由 Host 提供，拉一次即可。
      useEffect(() => {
        let alive = true;
        api('login-help')
          .then((r) => {
            if (alive && r?.ok) setLoginHelp(r);
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, []);

      const run = useCallback(
        async (name, fn) => {
          setBusy(name);
          setActionError('');
          try {
            await fn();
          } catch (error) {
            setActionError(error?.message ?? String(error));
          } finally {
            setBusy('');
          }
        },
        [],
      );

      const data = status.data;
      const cfg = data?.config;
      const models = cfg?.models ?? [];
      const efforts = cfg?.options?.reasoningEffort ?? ['low', 'medium', 'high'];

      const saveConfig = (patch) =>
        run('config', async () => {
          await api('config', { method: 'POST', body: JSON.stringify(patch), timeout: 30000 });
          await load();
        });

      const saveCookie = () =>
        run('cookie', async () => {
          if (!cookieDraft.trim()) throw new Error('请先粘贴凭证');
          const r = await api('cookie', { method: 'POST', body: JSON.stringify({ cookie: cookieDraft.trim() }), timeout: 90000 });
          setCookieDraft('');
          await load();
          setLoginErr('');
          // 成功时明确告诉用户「已经能用了吗」——这里包含校验结果
          const token = r?.token;
          if (token?.valid) {
            flash({
              title: '登录成功，凭证已生效',
              detail: `已识别到腾讯云账号 ${
                r?.profile?.nickName ?? r?.profile?.ownerUin ?? '—'
              }，凭证有效期 ${Math.max(0, Math.round((token.expiresInSec ?? 0) / 60))} 分钟，到期前会自动续期。现在可以直接在对话里选用 OrcaTerm 模型了。`,
            });
          } else {
            flash({
              title: '凭证已保存，但校验未通过',
              detail: r?.errors?.token ?? '请确认复制的值来自已登录的 orcaterm.ai 会话，然后重试。',
              kind: 'warn',
            });
          }
        });

      const refreshToken = () =>
        run('refresh', async () => {
          const r = await api('refresh', { method: 'POST', timeout: 90000 });
          await load();
          const token = r?.token;
          if (token?.valid) {
            flash({
              title: 'Token 已续期',
              detail: `新的凭证有效期 ${Math.max(0, Math.round((token.expiresInSec ?? 0) / 60))} 分钟。`,
            });
          } else {
            flash({
              title: '续期失败',
              detail: r?.errors?.token ?? '登录状态可能已过期，请重新获取一次凭证。',
              kind: 'warn',
            });
          }
        });

      /** 登录阶段的文案。 */
      const stageText = (stage) =>
        ({
          idle: '等待开始',
          starting: '正在启动浏览器…',
          launching: '正在启动浏览器…',
          waiting: '请在浏览器里完成登录',
          polling: '等待登录完成…',
          done: '登录成功',
          cancelled: '已取消',
          error: '登录失败',
        })[stage] ?? stage;

      /** 启动自动登录，并轮询进度直到结束。 */
      const autoLogin = async () => {
        setLoginErr('');
        setLogin({ running: true, stage: 'starting', detail: '', error: '', saved: false, elapsedMs: 0 });
        try {
          await api('login/start', { method: 'POST', timeout: 30000 });
        } catch (e) {
          setLogin({ running: false, stage: 'error', detail: '', error: String(e.message ?? e), elapsedMs: 0 });
          return;
        }

        // 轮询直到结束（最多 6 分钟，比后端超时略长）
        const deadline = Date.now() + 6 * 60 * 1000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1000));
          let st;
          try {
            st = await api('login/status', { timeout: 15000 });
          } catch {
            continue;
          }
          setLogin(st);
          if (!st?.running) {
            if (st?.stage === 'done' && st.saved) {
              await load();
              flash({
                title: '登录成功，凭证已生效',
                detail: '现在可以直接在对话里选用 OrcaTerm 模型了。凭证会自动续期，通常不需要再操作。',
              });
            } else if (st?.stage === 'cancelled') {
              setLoginErr('');
            } else if (st?.error) {
              setLoginErr('');
            }
            return;
          }
        }
        setLogin({ running: false, stage: 'error', detail: '', error: '等待登录超时，请重试。', elapsedMs: 0 });
      };

      /** 取消正在进行的登录。 */
      const cancelLogin = async () => {
        try {
          await api('login/cancel', { method: 'POST', timeout: 15000 });
        } catch {}
        setLogin({ running: false, stage: 'cancelled', detail: '', error: '', elapsedMs: 0 });
      };

      /** 清除自动登录用的浏览器 profile（换账号或清残留）。 */
      const resetLoginProfile = () =>
        run('resetProfile', async () => {
          await api('login/reset', { method: 'POST', timeout: 30000 });
          flash({
            title: '已清除登录缓存',
            detail: '下次点「一键登录」时会是全新的浏览器会话，需要重新登录。',
          });
        });

      /** 手动方式：打开系统浏览器。 */
      const openManualLoginPage = () =>
        run('openLogin', async () => {
          const r = await api('open-login', { method: 'POST', timeout: 30000 });
          if (!r?.opened) {
            setLoginErr('没能自动打开浏览器，请手动访问 https://orcaterm.ai/terminal');
          }
        });

      const testOne = async (modelId) => {
        setTesting(modelId);
        try {
          const res = await api('test', { method: 'POST', body: JSON.stringify({ model: modelId }), timeout: 60000 });
          setTests((t) => ({ ...t, [modelId]: res.result }));
        } catch (error) {
          setTests((t) => ({ ...t, [modelId]: { ok: false, error: error?.message ?? String(error) } }));
        } finally {
          setTesting('');
        }
      };

      if (status.loading && !data) {
        return h('div', { className: 'ot-wrap' }, h('div', { className: 'ot-card-sub' }, '正在读取 OrcaTerm 状态…'));
      }
      if (status.error) {
        return h(
          'div',
          { className: 'ot-wrap' },
          h(Card, { title: '无法读取状态' }, h('div', { className: 'ot-err' }, status.error)),
        );
      }

      const tokenOk = Boolean(data?.token?.valid);
      const quota = data?.quota?.ai;
      const usedRatio = quota && quota.limit > 0 ? Math.min(1, quota.used / quota.limit) : 0;

      return h(
        'div',
        { className: 'ot-wrap' },

        // ---- 操作结果提示（登录/续期成功后显眼展示）----
        notice
          ? h(
              'div',
              { className: `ot-toast ot-toast-${notice.kind ?? 'ok'}`, role: 'status' },
              h(
                'div',
                { className: 'ot-toast-head' },
                h('span', { className: 'ot-toast-icon' }, notice.kind === 'warn' ? '!' : '✓'),
                h('span', { className: 'ot-toast-title' }, notice.title),
                h(
                  'button',
                  { className: 'ot-toast-close', onClick: () => setNotice(null), title: '关闭' },
                  '×',
                ),
              ),
              notice.detail ? h('div', { className: 'ot-toast-detail' }, notice.detail) : null,
            )
          : null,

        // ---- 登录 / 凭证 ----
        h(
          Card,
          {
            title: '登录 OrcaTerm',
            sub: '点一下按钮，在弹出的浏览器里登录一次即可；之后插件自动续期',
          },

          // 主路径：自动登录
          data?.token?.valid
            ? h(
                'div',
                { className: 'ot-note' },
                h('div', { className: 'ot-note-line', style: { fontWeight: 600 } }, '已登录'),
                h(
                  'div',
                  { className: 'ot-note-line' },
                  `凭证有效，剩余 ${Math.max(0, Math.round((data.token.expiresInSec ?? 0) / 60))} 分钟，到期前会自动续期。`,
                ),
                h(
                  'div',
                  { className: 'ot-actions', style: { marginTop: 10 } },
                  h(
                    'button',
                    { className: 'ot-btn', onClick: autoLogin, disabled: Boolean(busy) || login?.running },
                    '重新登录 / 换账号',
                  ),
                  h(
                    'button',
                    { className: 'ot-btn', onClick: resetLoginProfile, disabled: Boolean(busy) || login?.running },
                    '清除登录缓存',
                  ),
                ),
              )
            : h(
                'div',
                { className: 'ot-login-step' },
                h(
                  'div',
                  { className: 'ot-login-actions' },
                  h(
                    'button',
                    {
                      className: 'ot-btn ot-btn-primary',
                      disabled: Boolean(busy) || login?.running,
                      onClick: autoLogin,
                    },
                    login?.running ? '等待登录中…' : '一键登录',
                  ),
                  login?.running
                    ? h(
                        'button',
                        { className: 'ot-btn', onClick: cancelLogin },
                        '取消',
                      )
                    : null,
                  h(
                    'button',
                    { className: 'ot-btn', onClick: () => setShowManual((v) => !v) },
                    showManual ? '收起手动方式' : '手动输入',
                  ),
                ),
                h(
                  'div',
                  { className: 'ot-hint', style: { marginTop: 8 } },
                  '点击后会打开一个独立的浏览器窗口（不影响你平时用的浏览器）。用腾讯云账号登录，插件会自动读取凭证。',
                ),
              ),

          // 自动登录进度
          login?.running
            ? h(
                'div',
                { className: 'ot-login-progress' },
                h('span', { className: 'ot-spinner' }),
                h('span', null, login.detail || stageText(login.stage)),
                login.elapsedMs > 0
                  ? h('span', { className: 'ot-hint' }, ` · 已等待 ${Math.round(login.elapsedMs / 1000)} 秒`)
                  : null,
              )
            : null,

          // 自动登录失败
          login && !login.running && login.stage === 'error' && login.error
            ? h(
                'div',
                { className: 'ot-err' },
                login.error,
                h(
                  'div',
                  { style: { marginTop: 8 } },
                  h(
                    'button',
                    { className: 'ot-btn', onClick: () => setShowManual(true) },
                    '改用手动输入',
                  ),
                ),
              )
            : null,

          // 手动方式（折叠）
          showManual
            ? h(
                'div',
                { style: { marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.14))' } },

                h(
                  'div',
                  { className: 'ot-actions', style: { marginBottom: 10 } },
                  h(
                    'button',
                    { className: 'ot-btn', onClick: openManualLoginPage, disabled: Boolean(busy) },
                    '打开登录页',
                  ),
                  h(
                    'button',
                    { className: 'ot-btn', onClick: () => setShowSteps((v) => !v) },
                    showSteps ? '收起步骤' : '查看步骤',
                  ),
                ),

                showSteps
                  ? h(
                      'div',
                      { className: 'ot-note' },
                      ...(
                        loginHelp?.steps ?? [
                          '用浏览器打开 https://orcaterm.ai/terminal 并登录',
                          '按 F12 打开开发者工具',
                          '切到 Application 标签 → Cookies → 选中 https://orcaterm.ai',
                          '找到 __Secure-ot_session 这一行',
                          '双击 Value 列全选复制（约 80 个字符）',
                          '回到本页面粘贴到下面',
                        ]
                      ).map((s, i) => h('div', { className: 'ot-note-line' }, `${i + 1}. ${s}`)),
                      loginHelp?.note
                        ? h('div', { className: 'ot-note-line', style: { marginTop: 6, opacity: 0.75 } }, loginHelp.note)
                        : null,
                    )
                  : null,

                h('div', { className: 'ot-label', style: { margin: '12px 0 6px' } }, '粘贴凭证'),
                h('textarea', {
                  className: 'ot-input ot-textarea',
                  placeholder: '__Secure-ot_session 的值（约 80 字符）\n也可以直接粘贴整条 Cookie，插件会自动提取',
                  value: cookieDraft,
                  spellCheck: false,
                  onChange: (e) => {
                    setCookieDraft(e.target.value);
                    if (loginErr) setLoginErr('');
                  },
                }),
                h(
                  'div',
                  { className: 'ot-actions', style: { marginTop: 10 } },
                  h(
                    'button',
                    { className: 'ot-btn ot-btn-primary', onClick: saveCookie, disabled: Boolean(busy) || !cookieDraft.trim() },
                    busy === 'cookie' ? '保存中…' : '保存并校验',
                  ),
                  h(
                    'button',
                    { className: 'ot-btn', onClick: () => setCookieDraft(''), disabled: Boolean(busy) || !cookieDraft },
                    '清空',
                  ),
                  data?.cookie?.present
                    ? h('span', { className: 'ot-hint' }, '已保存凭证')
                    : h('span', { className: 'ot-hint' }, '尚未配置'),
                ),
                loginErr ? h('div', { className: 'ot-err' }, loginErr) : null,
              )
            : null,
        ),

        // ---- 账号与额度 ----
        h(
          Card,
          {
            title: '账号与额度',
            sub: 'OrcaTerm 网页版的登录状态与本月免费额度',
            actions: h(
              'div',
              { className: 'ot-actions' },
              h(
                'button',
                { className: 'ot-btn', onClick: () => run('reload', load), disabled: Boolean(busy) },
                busy === 'reload' ? '刷新中…' : '刷新',
              ),
              h(
                'button',
                { className: 'ot-btn ot-btn-primary', onClick: refreshToken, disabled: Boolean(busy) },
                busy === 'refresh' ? '续期中…' : '立即续期 Token',
              ),
            ),
          },
          h(
            Row,
            {
              label: '账号',
              hint: data?.profile
                ? `登录方式：${data.profile.loginMethod === 'oauth' ? '腾讯云 OAuth' : data.profile.loginMethod ?? '—'} · 账号类型：${
                    data.profile.accountType === 'txcloud' ? '腾讯云' : data.profile.accountType ?? '—'
                  }`
                : undefined,
            },
            data?.profile
              ? h('span', { className: 'ot-mono' }, `${data.profile.nickName ?? '—'} · UIN ${data.profile.ownerUin ?? '—'}`)
              : h('span', { className: 'ot-warn' }, data?.errors?.profile ?? '未知'),
          ),
          h(
            Row,
            {
              label: 'Cookie',
              hint: data?.cookie?.present
                ? `来源：${{ patch: '配置文件', env: '环境变量', file: '本地文件' }[data.cookie.source] ?? data.cookie.source}（${data.cookie.length} 字符）`
                : '尚未配置，插件无法调用模型',
            },
            data?.cookie?.present ? h(Badge, { tone: 'ok' }, '已配置') : h(Badge, { tone: 'bad' }, '缺失'),
          ),
          h(
            Row,
            { label: 'Token', hint: tokenOk ? `有效期剩余 ${humanize(data.token.expiresInSec)}` : data?.token?.error },
            tokenOk ? h(Badge, { tone: 'ok' }, '有效') : h(Badge, { tone: 'bad' }, '无效'),
          ),
          h(
            Row,
            { label: 'AI 额度', hint: quota?.endDate ? `统计周期至 ${String(quota.endDate).slice(0, 10)}` : undefined },
            quota
              ? h(
                  'div',
                  { style: { minWidth: 168 } },
                  h(
                    'div',
                    { style: { textAlign: 'right' } },
                    `${quota.used} / ${quota.limit < 0 ? '不限' : quota.limit} 次`,
                  ),
                  quota.limit > 0
                    ? h(
                        'div',
                        { className: 'ot-bar' },
                        h('div', { className: 'ot-bar-fill', style: { width: `${(usedRatio * 100).toFixed(1)}%` } }),
                      )
                    : null,
                )
              : h('span', { className: 'ot-warn' }, data?.errors?.quota ?? '未知'),
          ),
          // 额度口径说明：共用池 + 限时免费可能不计数
          data?.quotaNote
            ? h(
                'div',
                { className: 'ot-note' },
                h('div', { className: 'ot-note-line' }, h('strong', null, '共用额度：'), data.quotaNote.text),
                h('div', { className: 'ot-note-line' }, data.quotaNote.freeHint),
              )
            : null,
        ),

        // ---- 本地用量统计 ----
        h(
          Card,
          {
            title: '我的调用记录',
            sub: 'OrcaTerm 官方在限时免费期不计次，这里由插件自己统计',
            actions: h(
              'button',
              {
                className: 'ot-btn',
                disabled: Boolean(busy) || !data?.usage?.range?.total,
                onClick: () =>
                  run('resetUsage', async () => {
                    await api('usage/reset', { method: 'POST', timeout: 20000 });
                    await load();
                  }),
              },
              busy === 'resetUsage' ? '清空中…' : '清空',
            ),
          },
          h(
            Row,
            { label: '今天' },
            h(
              'span',
              null,
              `${data?.usage?.today?.total ?? 0} 次`,
              data?.usage?.today?.fail
                ? h('span', { className: 'ot-warn' }, `（失败 ${data.usage.today.fail} 次）`)
                : null,
            ),
          ),
          h(
            Row,
            { label: '近 30 天' },
            h(
              'span',
              null,
              `${data?.usage?.range?.total ?? 0} 次`,
              data?.usage?.successRate !== null && data?.usage?.successRate !== undefined
                ? h('span', { className: 'ot-hint' }, `，成功率 ${data.usage.successRate}%`)
                : null,
            ),
          ),
          data?.usage?.models?.length
            ? h(
                'div',
                { className: 'ot-models', style: { marginTop: 12 } },
                h('div', { className: 'ot-sub-title' }, '各模型使用情况'),
                data.usage.models.map((m) => {
                  const known = models.find((x) => x.id === m.id);
                  const name = known?.name ?? m.id;
                  return h(
                    'div',
                    { key: m.id, className: 'ot-stat-row' },
                    h(
                      'div',
                      { className: 'ot-stat-left' },
                      h('span', { className: 'ot-stat-name' }, name),
                      m.fail > 0 ? h('span', { className: 'ot-chip ot-chip-fail' }, `${m.fail} 次失败`) : null,
                    ),
                    h(
                      'div',
                      { className: 'ot-stat-right' },
                      h('span', null, `${m.n} 次`),
                      m.avgFirstTokenMs !== null
                        ? h('span', { className: 'ot-hint' }, `首字 ${m.avgFirstTokenMs}ms`)
                        : null,
                      m.avgMs !== null ? h('span', { className: 'ot-hint' }, `共 ${m.avgMs}ms`) : null,
                    ),
                  );
                }),
              )
            : h('div', { className: 'ot-empty' }, '还没有调用记录，随便发一条消息试试。'),
        ),

        // ---- 生成参数 ----
        h(
          Card,
          { title: '生成参数', sub: '改动会立即生效，并对后续所有会话起作用' },
          h(
            Row,
            { label: '默认模型', hint: '新会话未显式选择时使用' },
            h(
              'select',
              {
                className: 'ot-select',
                value: cfg.model,
                disabled: Boolean(busy),
                onChange: (e) => saveConfig({ model: e.target.value }),
              },
              models.map((m) => h('option', { key: m.id, value: m.id }, m.name)),
            ),
          ),
          h(
            Row,
            { label: '推理强度', hint: 'low 更快，high 更深入' },
            h(
              'div',
              { className: 'ot-radio' },
              efforts.map((e) =>
                h(
                  'button',
                  {
                    key: e,
                    className: 'ot-radio-item',
                    'data-on': cfg.reasoningEffort === e ? '1' : '0',
                    disabled: Boolean(busy),
                    onClick: () => saveConfig({ reasoningEffort: e }),
                  },
                  e,
                ),
              ),
            ),
          ),
          h(
            Row,
            { label: '显示思考过程', hint: '关闭后只显示最终回答' },
            h(
              'button',
              {
                className: 'ot-btn',
                disabled: Boolean(busy),
                onClick: () => saveConfig({ showReasoning: !cfg.showReasoning }),
              },
              cfg.showReasoning ? '已开启' : '已关闭',
            ),
          ),
          h(
            Row,
            {
              label: '工具调用',
              hint: '开启后，DSH 注册的工具会交给模型使用（由本机执行，不经 OrcaTerm 服务器）。关闭则只做纯对话',
            },
            h(
              'button',
              {
                className: 'ot-btn',
                disabled: Boolean(busy),
                onClick: () => saveConfig({ enableTools: !cfg.enableTools }),
              },
              cfg.enableTools ? '已开启' : '已关闭',
            ),
          ),
          h(
            Row,
            {
              label: '图片识别',
              hint: '开启后可以把图片发给模型（支持 PNG / JPEG / WebP / GIF，单张 10MB 内）。DeepSeek、Kimi 可识图；GLM 5.3 不接受图片，Hunyuan 3 识图不准',
            },
            h(
              'button',
              {
                className: 'ot-btn',
                disabled: Boolean(busy),
                onClick: () => saveConfig({ enableImages: !cfg.enableImages }),
              },
              cfg.enableImages ? '已开启' : '已关闭',
            ),
          ),
          h(
            Row,
            { label: '失败重试', hint: '仅对网络错误、限流和服务端故障生效；凭证失效不重试' },
            h(
              'div',
              { className: 'ot-radio' },
              [0, 1, 2, 3].map((n) =>
                h(
                  'button',
                  {
                    key: n,
                    className: 'ot-radio-item',
                    'data-on': (cfg.maxRetries ?? 2) === n ? '1' : '0',
                    disabled: Boolean(busy),
                    onClick: () => saveConfig({ maxRetries: n }),
                  },
                  n === 0 ? '不重试' : `${n} 次`,
                ),
              ),
            ),
          ),
          h(
            Row,
            { label: '备用模型', hint: '主模型彻底失败时自动切换到它；留空表示不降级' },
            h(
              'select',
              {
                className: 'ot-select',
                value: cfg.fallbackModel || '',
                disabled: Boolean(busy),
                onChange: (e) => saveConfig({ fallbackModel: e.target.value }),
              },
              h('option', { value: '' }, '不降级'),
              models.map((m) =>
                h('option', { key: m.id, value: m.id }, m.name),
              ),
            ),
          ),
          h(
            Row,
            {
              label: '超长会话裁剪',
              hint: '历史超过阈值时自动丢弃最老的对话，保留最近内容与成对的工具调用。关闭则完整发送，可能撞上游上下文上限',
            },
            h(
              'select',
              {
                className: 'ot-select',
                value: String(cfg.contextTrimChars ?? 120000),
                disabled: Boolean(busy),
                onChange: (e) => saveConfig({ contextTrimChars: Number(e.target.value) }),
              },
              h('option', { value: '0' }, '关闭（始终全量发送）'),
              h('option', { value: '40000' }, '40,000 字符（激进）'),
              h('option', { value: '80000' }, '80,000 字符（偏紧）'),
              h('option', { value: '120000' }, '120,000 字符（推荐）'),
              h('option', { value: '240000' }, '240,000 字符（宽松）'),
            ),
          ),
          h(
            'div',
            { className: 'ot-note' },
            h('div', { className: 'ot-note-line' }, '工具调用怎么工作'),
            h(
              'div',
              { className: 'ot-note-line' },
              '① 插件把 DSH 当前注册的工具清单随请求一起发给模型；② 模型判断需要工具时返回一个调用请求；③ 插件把请求交回 DSH，由 DSH 在本机真正执行；④ 执行结果再回传给模型，模型据此给出最终回答。',
            ),
            h(
              'div',
              { className: 'ot-note-line' },
              '工具始终在本机运行，OrcaTerm 服务器只负责转发调用描述与执行结果，不会接触你的文件内容。',
            ),
          ),
        ),

        // ---- 模型可用性 ----
        h(
          Card,
          {
            title: '可用模型',
            sub: '8 个模型共用同一额度池。可测试连通性，或点「设为默认」切换新会话使用的模型。',
            actions: h(
              'button',
              {
                className: 'ot-btn',
                disabled: Boolean(busy) || Boolean(testing),
                onClick: async () => {
                  for (const m of models) {
                    // 串行，避免并发打满额度
                    await testOne(m.id);
                  }
                },
              },
              testing ? '测试中…' : '全部测试',
            ),
          },
          h(
            'div',
            { className: 'ot-models' },
            models.map((m) => {
              const r = tests[m.id];
              const isDefault = cfg.model === m.id;
              return h(
                'div',
                { key: m.id, className: 'ot-model' },
                // 主信息：模型名 + 标识，占据剩余宽度
                h(
                  'div',
                  { className: 'ot-model-info' },
                  h(
                    'div',
                    { className: 'ot-model-title' },
                    h('span', { className: 'ot-model-title-text' }, m.name),
                    isDefault ? h('span', { className: 'ot-chip ot-chip-default' }, '默认') : null,
                    m.free ? h('span', { className: 'ot-chip ot-chip-free' }, '限时免费') : null,
                  ),
                  h(
                    'div',
                    { className: 'ot-model-meta' },
                    m.vendor ? h('span', null, m.vendor) : null,
                    m.vendor ? h('span', { className: 'ot-sep' }, '·') : null,
                    h('span', { className: 'ot-mono' }, m.id),
                    r
                      ? h(
                          'span',
                          { className: r.ok ? 'ot-meta-ok' : 'ot-meta-bad' },
                          r.ok ? ` · ${r.latencyMs}ms` : ` · ${r.error || '失败'}`,
                        )
                      : null,
                  ),
                ),
                // 操作区：固定宽度，不参与换行
                h(
                  'div',
                  { className: 'ot-model-ops' },
                  h(
                    'button',
                    {
                      className: 'ot-btn ot-btn-sm',
                      disabled: Boolean(testing) || Boolean(busy),
                      onClick: () => testOne(m.id),
                    },
                    testing === m.id ? h('span', { className: 'ot-spin' }) : '测试',
                  ),
                  isDefault
                    ? null
                    : h(
                        'button',
                        {
                          className: 'ot-btn ot-btn-sm',
                          disabled: Boolean(busy),
                          onClick: () => saveConfig({ model: m.id }),
                        },
                        '设为默认',
                      ),
                ),
              );
            }),
          ),
        ),

        actionError ? h('div', { className: 'ot-err' }, actionError) : null,
      );
    }

    // ---------- 模型选择器标签增强 ----------

    /** OrcaTerm 模型的展示元数据（与 Host 侧清单保持一致）。 */
    const MODEL_META = {
      'TokenHub/deepseek-v4.1-flash': { vendor: 'DeepSeek', free: true },
      'TokenHub/deepseek-v4-flash': { vendor: 'DeepSeek', free: true },
      'TokenHub/deepseek-v4-pro': { vendor: 'DeepSeek', free: true },
      'TokenHub/kimi-k3': { vendor: 'Moonshot', free: true },
      'TokenHub/glm-5.3-flash': { vendor: '智谱', free: true },
      'TokenHub/glm-5.3': { vendor: '智谱', free: true },
      'TokenHub/glm-5.2': { vendor: '智谱', free: true },
      'Hunyuan3/hy3': { vendor: '混元', free: true },
    };

    const LABEL_CSS = `
.ot-mlabel { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; }
.ot-mlabel-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ot-mtag {
  font-size: 10px; line-height: 1.6; padding: 0 5px; border-radius: 4px;
  flex: none; letter-spacing: .01em; white-space: nowrap;
}
.ot-mtag-free { color: var(--dsw-alias-success, #16a34a); border: 1px solid currentColor; opacity: .92; }
.ot-mtag-vendor { color: inherit; opacity: .45; }
`;

    /**
     * 模型标签：为 OrcaTerm 的模型追加「免费」角标与厂商提示。
     * 其它 provider 的模型原样输出名称，不影响宿主原生外观。
     *
     * 宿主的 placement 取值：`"option"`（下拉菜单项）与 `"trigger"`（按钮）。
     * @param {object} props 槽位传入的 `{ provider, model, placement, selected }`。
     */
    function ModelLabel(props) {
      const { model, placement } = props || {};
      const meta = model && MODEL_META[model.id];
      const name = (model && model.name) || '';

      if (!meta) return h('span', { className: 'ot-mlabel-name' }, name);

      return h(
        'span',
        { className: 'ot-mlabel' },
        h('span', { className: 'ot-mlabel-name' }, name),
        meta.free ? h('span', { className: 'ot-mtag ot-mtag-free' }, '免费') : null,
        // 下拉菜单里空间较宽，才显示厂商；触发按钮上只留紧凑的免费角标
        (placement === 'option' || placement === 'menu') && meta.vendor
          ? h('span', { className: 'ot-mtag ot-mtag-vendor' }, meta.vendor)
          : null,
      );
    }

    // ---------- DOM 兜底：直接给模型行补角标 ----------

    /**
     * 在模型选择器已渲染的 DOM 上补「免费」与厂商角标。
     *
     * 宿主用 `<span data-model-id="...">` 包裹模型标签，这里按 id 查出该行，
     * 幂等地追加角标（已存在则跳过），并用 MutationObserver 跟随弹层开关。
     *
     * @returns {() => void} 清理函数。
     */
    function decorateModelRows() {
      const MARK = 'data-ot-decorated';

      /** 为一行补角标。 */
      const patch = (node) => {
        const modelId = node.getAttribute('data-model-id');
        const meta = modelId ? MODEL_META[modelId] : null;
        if (!meta) return;

        // 同一行可能被反复渲染，用标记避免重复追加
        if (node.getAttribute(MARK) === '1') return;

        // 确保是「名称 + 角标」的紧凑横向布局
        node.classList.add('ot-mlabel');

        if (meta.free && !node.querySelector('.ot-mtag-free')) {
          const tag = document.createElement('span');
          tag.className = 'ot-mtag ot-mtag-free';
          tag.textContent = '免费';
          node.appendChild(tag);
        }
        if (meta.vendor && !node.querySelector('.ot-mtag-vendor')) {
          const tag = document.createElement('span');
          tag.className = 'ot-mtag ot-mtag-vendor';
          tag.textContent = meta.vendor;
          node.appendChild(tag);
        }

        node.setAttribute(MARK, '1');
      };

      /** 扫描整个文档。 */
      const sweep = () => {
        for (const node of document.querySelectorAll('span[data-model-id]')) patch(node);
      };

      sweep();

      // 弹层是动态挂载的，跟随 DOM 变化补扫
      const observer = new MutationObserver(() => {
        // 合并同一轮变更，避免逐节点触发
        if (observer.__scheduled) return;
        observer.__scheduled = true;
        queueMicrotask(() => {
          observer.__scheduled = false;
          sweep();
        });
      });

      observer.observe(document.body, { childList: true, subtree: true });

      return () => observer.disconnect();
    }

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style');
        style.setAttribute('data-plugin', 'orcaterm-model-proxy');
        style.textContent = CSS + LABEL_CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'orcaterm: styles');

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'orcaterm-model-proxy',
            order: 35,
            label: () => 'OrcaTerm',
          },
          OrcaTermSettings,
        ),
      );

      // 模型选择器标签增强。
      // 槽位 `conversation.input.model.label` 的 scope 是 session，注册时机不一定可靠，
      // 因此再挂一层 DOM 兜底：直接给已渲染的模型行补角标。
      try {
        ctx.slots.inject('conversation.input.model.label', () =>
          ctx.slots.register(
            { name: 'conversation.input.model.label', id: 'orcaterm-model-label' },
            ModelLabel,
          ),
        );
      } catch (error) {
        console.warn('[orcaterm] model.label slot unavailable, falling back to DOM badges', error);
      }

      ctx.effect(() => decorateModelRows(), 'orcaterm: model badges');

      // 自检上报：把浏览器侧的实际情况写到 Host 侧文件，便于排查
      // （桌面端走 dsh-app:// 协议，外部工具无法直接打开页面检查）
      reportDiag();
    }

    /**
     * 一次性自检上报。
     *
     * 收集样式是否注入、槽位是否注册成功、DOM 里能找到几个模型行等事实，
     * 通过 /api/orcaterm/diag 落到 ~/.dsh/orcaterm-client-diag.json。
     */
    function reportDiag() {
      const collect = () => ({
        href: location.href,
        hasBoot: Boolean(window.__DSH_BOOT__),
        styleInjected: Boolean(document.querySelector('style[data-plugin="orcaterm-model-proxy"]')),
        modelSpans: document.querySelectorAll('span[data-model-id]').length,
        decoratedSpans: document.querySelectorAll('span[data-model-id][data-ot-decorated="1"]').length,
        ourBadges: document.querySelectorAll('.ot-mtag-free').length,
        rootChildren: document.querySelector('#root')?.children.length ?? -1,
      });

      const send = async (extra) => {
        try {
          await fetch(apiUrl('diag'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...collect(), ...extra }),
          });
        } catch {
          // 上报失败不影响功能
        }
      };

      // 页面刚挂载时可能还没有模型选择器，稍后再采一次
      setTimeout(() => send({ phase: 'initial' }), 3000);
      setTimeout(() => send({ phase: 'late' }), 12000);
    }

    return { inject: ['slots'], apply };
  },
});
