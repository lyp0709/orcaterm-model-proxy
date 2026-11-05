# OrcaTerm Model Proxy

把 [OrcaTerm](https://orcaterm.ai) 网页版的免费模型接入 DeepSeek Harness（DSH），支持工具调用与图片识别。

**本项目与腾讯云 / OrcaTerm 官方无关**，是一个第三方集成插件。使用前请自行确认符合 OrcaTerm 的服务条款。

## 功能

- **接入 8 个免费模型**：DeepSeek V4.1 Flash / V4 Flash / V4 Pro、Kimi K3、GLM 5.3 Flash / 5.3 / 5.2、Hunyuan 3
- **凭证自动续期**：只需配置一次，之后长期自动续期，不需要反复更新
- **工具调用**：DSH 注册的工具由本机执行，模型可以读取文件、执行命令等
- **图片识别**：可以把图片发给模型（DeepSeek V4.1 Flash、Kimi K3 支持；GLM 5.3 不接受图片）
- **可视化设置面板**：模型选择、推理强度、账号状态、额度查询、调用统计

## 安装

### 从 GitHub 安装（推荐）

```powershell
dsh plugin --profile desktop add github:<你的用户名>/orcaterm-model-proxy
```

### 从本地目录安装

```powershell
dsh plugin --profile desktop add "D:\path\to\orcaterm-model-proxy"
```

或者使用 DSH 的插件管理器：设置 → 插件 → 安装本地插件，选择目录。

### 交给 AI 助手

在 DSH 里直接说：

> 帮我安装这个插件：github.com/<你的用户名>/orcaterm-model-proxy

安装完成后**重启 DSH**。

> 本插件零运行时依赖，安装时不需要构建步骤。

## 配置凭证（一键登录）

插件需要 OrcaTerm 的登录凭证。**只需登录一次，之后自动续期**。

1. 打开 DSH 设置 → 找到 OrcaTerm 面板（登录区块在最上面）
2. 点 **「一键登录」**
3. 插件自动弹出一个**独立的浏览器窗口**（与日常浏览器完全隔离，不影响你正在用的）
4. 在这个窗口里用**腾讯云账号**登录（支持微信扫码、QQ、GitHub、账号密码等）
5. 登录成功后无需操作 —— 插件自动检测并读取凭证，然后关闭窗口
6. 面板显示「登录成功，凭证已生效」即完成

成功后会有明显提示，并显示识别到的账号和凭证有效期。

### 自动登录的实现

浏览器把 Cookie 加密存储（Chrome 127+ / Edge 新版使用 App-Bound Encryption，密钥与浏览器进程身份绑定），第三方进程无法解密。但浏览器自己可以。

插件的做法：
1. 用独立 profile 启动 Edge/Chrome，开启 `--remote-debugging-port`
2. 导航到 `orcaterm.ai/terminal`，让用户完成登录
3. 通过 CDP 的 `Network.getCookies` 读取 `__Secure-ot_session`
4. 拿到后立即关闭浏览器并保存凭证

这个过程只读取 `orcaterm.ai` 一个域名的 Cookie，不触碰用户日常浏览器数据。

### 手动方式（自动登录不可用时）

1. 点「手动输入」展开
2. 点「打开登录页」，用浏览器登录
3. 按 `F12` → **Application** 标签 → **Cookies** → 选中 `https://orcaterm.ai`
4. 找到 `__Secure-ot_session`，双击 **Value** 列全选复制（约 80 个字符）
5. 粘贴到输入框，点「保存并校验」

> **提示**：也可以直接复制整条 Cookie 请求头，插件会自动提取需要的部分。

### 关于账号

- 需要一个腾讯云账号。首次使用腾讯云可能需要完成实名认证等前置步骤。
- OrcaTerm 目前提供免费额度（AI 功能为单一额度池，不按模型区分）。

## 使用

配置完成后，在 DSH 的模型选择器里就能看到 OrcaTerm 提供的模型。

设置面板里还可以调整：

| 选项 | 说明 |
|---|---|
| 默认模型 | 未指定时使用的模型 |
| 推理强度 | low / medium / high |
| 显示思考过程 | 是否显示模型的推理过程 |
| 工具调用 | 是否允许模型使用 DSH 的工具 |
| 图片识别 | 是否把图片发给模型 |
| 失败重试 | 网络错误、限流时的重试次数 |
| 备用模型 | 主模型失败时自动切换 |

## 工作原理

插件实现了 DSH 的 `LlmAdapter` 接口，把 DSH 的请求翻译成 OrcaTerm 的 ACP 协议：

1. **认证**：用 `__Secure-ot_session` 换取 JWT access token（有效期 2 小时，自动续期）
2. **对话**：调用 OrcaTerm 的 SSE 流式接口，把事件映射成 DSH 的 chunk
3. **工具调用**：把 DSH 的工具清单写进系统提示位，模型返回工具请求后由 DSH 在本机执行，结果回传
4. **图片**：把 DSH 的图片附件转成 base64 放进 `input.files`

工具**始终在本机运行**，OrcaTerm 服务器只负责转发调用描述与执行结果。

## 已知限制

- **仅支持腾讯云账号登录**，不支持 OrcaTerm 独立账号。
- OrcaTerm 不提供 token 用量数据，因此 DSH 的 token 统计面板不会显示本插件的用量。插件自带的调用统计（次数、耗时、首字延迟）是准确的。
- 图片识别的模型支持不一致：GLM 5.3 收到图片会报错（插件会自动跳过），Hunyuan 3 识图不准确。
- 模型列表是内置的。OrcaTerm 调整模型时需要更新插件版本。

## 隐私说明

- 凭证保存在本地 `~/.dsh/orcaterm-cookie.txt`，只包含 `__Secure-ot_session` 一个值。
- 插件**不会**把凭证发送到除 OrcaTerm 官方接口以外的任何地方。
- 插件**不会**读取浏览器数据。凭证由用户手动粘贴。
- 调用统计保存在本地 `~/.dsh/orcaterm-usage.json`。

## 故障排查

设置面板的「诊断」可查看最近一次调用的详情。也可以直接访问：

```
http://127.0.0.1:<DSH端口>/api/orcaterm/diag
```

常见问题：

| 现象 | 原因与处理 |
|---|---|
| 提示凭证无效 | 登录状态过期，重新获取一次 `__Secure-ot_session` |
| 模型不返回内容 | 检查是否触发限流（上游限制约 2 秒 1 次） |
| 图片识别失效 | 确认用的是 DeepSeek 或 Kimi 模型，且设置里「图片识别」已开启 |
| 工具调用失败 | 确认「工具调用」已开启；GLM 5.3 对图片会 400 |

## 开发

```powershell
# 语法检查
node --check index.js

# 测试（需要在 DSH 仓库外运行）
node test-tool-stream.mjs
node test-adapter.mjs
node test-images.mjs
node test-cookie.mjs
```

## 许可

MIT
