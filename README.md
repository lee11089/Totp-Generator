# TOTP 验证码生成器

一个**纯前端**的 TOTP（基于时间的一次性密码）生成工具。打开网页，粘贴密钥，验证码立即出现。用完关掉就好。

> 单次使用场景设计：不保存密钥、不持久化、不联网。需要时打开，用完即走。


## 特性

- **零依赖运行时**：纯原生 HTML / CSS / JavaScript，不依赖任何第三方库
- **Web Crypto 实现**：HMAC-SHA1/256/512 全部用浏览器原生 API，已通过 [RFC 6238](https://datatracker.ietf.org/doc/html/rfc6238) 全部 10 条测试向量
- **支持 otpauth:// URI**：直接粘贴 Google/Microsoft Authenticator 导出的链接，自动识别 issuer、digits、period、algorithm
- **PWA 离线**：可"添加到主屏幕"，断网也能算码
- **暗色模式**：跟随系统偏好，可手动切换
- **a11y 友好**：键盘可操作、读屏可播报、`prefers-reduced-motion` 支持
- **隐私保护**：密钥仅停留在内存，关闭页面立即丢弃；无任何遥测或分析脚本

## 安全模型

这个工具按"**单次使用**"设计：

| 项 | 处理方式 |
| --- | --- |
| 密钥 | 仅存在于当前页面内存，关闭/刷新即丢失 |
| 持久化 | 无（不写入 localStorage / IndexedDB / cookie） |
| 网络请求 | 加载页面所需的静态资源；无任何运行时上行 |
| 第三方脚本 | 无 |

> 如果你需要多账号管理，请使用 Authy、1Password、Bitwarden 等专业 Authenticator。本项目刻意不做账号库。

## 使用

支持两种输入：

**1. 裸 Base32 密钥**

```
JBSWY3DPEHPK3PXP
```

默认参数：6 位、30 秒周期、SHA1。

**2. otpauth:// URI**

```
otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example&digits=6&period=30&algorithm=SHA1
```

URI 中的参数会被自动应用，issuer 与账号名会显示在卡片顶部。

支持的算法：`SHA1` `SHA256` `SHA512`
支持的位数：6、7、8


## 部署

### Vercel（推荐）

1. 把仓库 push 到 GitHub
2. 打开 [vercel.com/new](https://vercel.com/new)，导入这个仓库
3. 框架预设选 **Other**，Build Command 留空，Output Directory 留空
4. 点 Deploy

仓库根目录的 `vercel.json` 已经配好了安全响应头、Service Worker 头、缓存策略，无需手动调整。后续 push 到主分支会自动重新部署。

### 其他静态托管

任意静态托管都行，把仓库根目录所有文件直接发布即可：

- **Cloudflare Pages**：连 GitHub，Build 命令留空，输出目录填 `.`
- **Netlify**：拖拽整个文件夹到 Netlify Drop，或连 GitHub
- **GitHub Pages**：在仓库 Settings → Pages 选择分支即可（注意 Pages 默认会带子路径，PWA 的 `start_url` 可能需要相应调整）

> 部署后必须是 HTTPS，否则 Service Worker 不会注册，PWA 离线功能会失效。Vercel / Netlify / Cloudflare Pages 都默认配 HTTPS，开箱即用。

## 项目结构

```
.
├── index.html              # 页面结构 + SVG 图标库 + Service Worker 注册
├── style.css               # 样式（CSS 变量 + 暗色模式）
├── script.js               # 核心逻辑：Base32 / HMAC / TOTP / 渲染
├── sw.js                   # Service Worker（cache-first）
├── manifest.webmanifest    # PWA Manifest
├── icon.svg                # 应用图标（标准）
├── icon-maskable.svg       # 应用图标（maskable，用于 Android 自适应裁切）
└── vercel.json             # Vercel 部署配置
```

## 实现要点

- **Base32 解码**严格按 RFC 4648：5-bit 拼接、按 8-bit 切字节、丢弃末尾不足 8-bit 的部分
- **HMAC** 使用 [`crypto.subtle.sign`](https://developer.mozilla.org/docs/Web/API/SubtleCrypto/sign)，无需任何 polyfill
- **counter** 用 `BigInt` + `DataView.setBigUint64` 编码 8 字节，避免 `Math.pow(2, 32)` 之后的精度问题
- **渲染循环**用 `requestAnimationFrame` 驱动，仅在 `counter` 变化时才重算 TOTP，每帧只更新进度条与倒计时
- **倒计时颜色**用 HSL 色相在 `蓝紫 → 绿 → 黄 → 红` 之间分段插值，而非"剩 5 秒突变红"
- **后台节能**：`document.hidden` 时取消 rAF，回前台再恢复
- **PWA**：cache-first 策略 + 通过 `CACHE_NAME` 版本号控制更新

## 浏览器兼容

需要支持以下能力：

- Web Crypto API（`crypto.subtle`）
- `BigInt`
- ES2020 语法
- 可选：`navigator.clipboard`（不可用时降级为 `execCommand`）
- 可选：Service Worker（不可用时不影响主功能）

主流浏览器（Chrome / Edge / Firefox / Safari 近三年版本）均可正常运行。

## 验证

`script.js` 中的 TOTP 实现已通过 RFC 6238 附录 B 的全部测试向量：

```
PASS  t=59         SHA1     94287082
PASS  t=59         SHA256   46119246
PASS  t=59         SHA512   90693936
PASS  t=1111111109 SHA1     07081804
PASS  t=1111111111 SHA1     14050471
PASS  t=1234567890 SHA1     89005924
PASS  t=1234567890 SHA256   91819424
PASS  t=1234567890 SHA512   93441116
PASS  t=2000000000 SHA1     69279037
PASS  t=20000000000 SHA1    65353130
```


## License

MIT
