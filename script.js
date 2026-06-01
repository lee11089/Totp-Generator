/**
 * TOTP 验证码生成器
 * - 使用 Web Crypto API（HMAC-SHA1/256/512）
 * - 标准 Base32 解码（RFC 4648）
 * - 支持 otpauth:// URI 和裸密钥
 * - rAF 驱动环形进度条，跨周期才重算 TOTP
 */
(() => {
    'use strict';

    // ---------- DOM ----------
    const $ = (id) => document.getElementById(id);
    const secretInput = $('secretInput');
    const toggleVisibilityBtn = $('toggleVisibility');
    const tokenCard = $('tokenCard');
    const tokenCode = $('tokenCode');
    const ringProgress = $('ringProgress');
    const secondsRemaining = $('secondsRemaining');
    const themeToggle = $('themeToggle');
    const errorText = $('errorText');
    const accountMeta = $('accountMeta');
    const accountIssuer = $('accountIssuer');
    const accountLabel = $('accountLabel');
    const emptyState = $('emptyState');
    const toast = $('toast');

    // ---------- 常量 ----------
    // 环形进度条周长 = 2π × 54
    const RING_CIRCUMFERENCE = 2 * Math.PI * 54;

    // ---------- 状态 ----------
    /** @type {{secret: string, digits: number, period: number, algorithm: string, issuer: string, label: string} | null} */
    let config = null;
    let lastCounter = -1n;
    let rafId = 0;
    let debounceTimer = 0;
    let copiedTimer = 0;

    // ---------- Base32 解码（RFC 4648） ----------
    const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    function base32ToBytes(input) {
        const cleaned = input.replace(/\s+/g, '').replace(/=+$/, '').toUpperCase();
        if (!cleaned) throw new Error('密钥为空');

        let bits = '';
        for (const ch of cleaned) {
            const v = BASE32_CHARS.indexOf(ch);
            if (v === -1) throw new Error(`非法的 Base32 字符: ${ch}`);
            bits += v.toString(2).padStart(5, '0');
        }

        const byteCount = Math.floor(bits.length / 8);
        const bytes = new Uint8Array(byteCount);
        for (let i = 0; i < byteCount; i++) {
            bytes[i] = parseInt(bits.substr(i * 8, 8), 2);
        }
        return bytes;
    }

    // ---------- HMAC（Web Crypto） ----------
    async function hmac(keyBytes, msgBytes, algoName) {
        const hashMap = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };
        const hash = hashMap[algoName] || 'SHA-1';
        const key = await crypto.subtle.importKey(
            'raw',
            keyBytes,
            { name: 'HMAC', hash },
            false,
            ['sign']
        );
        const sig = await crypto.subtle.sign('HMAC', key, msgBytes);
        return new Uint8Array(sig);
    }

    // ---------- HOTP / TOTP ----------
    async function hotp(keyBytes, counter, digits, algorithm) {
        const msg = new Uint8Array(8);
        new DataView(msg.buffer).setBigUint64(0, counter, false);
        const mac = await hmac(keyBytes, msg, algorithm);
        const offset = mac[mac.length - 1] & 0x0f;
        const bin =
            ((mac[offset] & 0x7f) << 24) |
            (mac[offset + 1] << 16) |
            (mac[offset + 2] << 8) |
            mac[offset + 3];
        const otp = bin % 10 ** digits;
        return otp.toString().padStart(digits, '0');
    }

    function counterFromEpoch(epochSec, period) {
        return BigInt(Math.floor(epochSec / period));
    }

    // ---------- 输入解析 ----------
    function parseInput(input) {
        const trimmed = input.trim();
        if (!trimmed) throw new Error('请输入密钥');

        if (/^otpauth:\/\//i.test(trimmed)) {
            return parseOtpauthUri(trimmed);
        }

        const cleaned = trimmed.replace(/\s+/g, '').toUpperCase();
        if (!/^[A-Z2-7]+=*$/.test(cleaned)) {
            throw new Error('密钥包含非法字符（仅允许 A–Z 与 2–7）');
        }
        return {
            secret: cleaned,
            digits: 6,
            period: 30,
            algorithm: 'SHA1',
            issuer: '',
            label: '',
        };
    }

    function parseOtpauthUri(raw) {
        let uri;
        try {
            uri = new URL(raw);
        } catch {
            throw new Error('无效的 otpauth URI');
        }
        if (uri.protocol !== 'otpauth:') throw new Error('协议必须是 otpauth://');
        if (uri.host.toLowerCase() !== 'totp') {
            throw new Error(`暂不支持类型: ${uri.host}`);
        }

        const params = uri.searchParams;
        const secret = params.get('secret');
        if (!secret) throw new Error('URI 中缺少 secret 参数');

        const rawLabel = decodeURIComponent(uri.pathname.replace(/^\//, ''));
        let issuer = params.get('issuer') || '';
        let label = rawLabel;
        const colonIdx = rawLabel.indexOf(':');
        if (colonIdx !== -1) {
            if (!issuer) issuer = rawLabel.slice(0, colonIdx).trim();
            label = rawLabel.slice(colonIdx + 1).trim();
        }

        let digits = 6;
        const dRaw = params.get('digits');
        if (dRaw !== null) {
            const d = parseInt(dRaw, 10);
            if (d >= 6 && d <= 8) digits = d;
        }

        let period = 30;
        const pRaw = params.get('period');
        if (pRaw !== null) {
            const p = parseInt(pRaw, 10);
            if (p > 0) period = p;
        }

        let algorithm = 'SHA1';
        const aRaw = params.get('algorithm');
        if (aRaw) {
            const a = aRaw.toUpperCase();
            if (['SHA1', 'SHA256', 'SHA512'].includes(a)) algorithm = a;
        }

        return {
            secret: secret.replace(/\s+/g, '').toUpperCase(),
            digits,
            period,
            algorithm,
            issuer,
            label,
        };
    }

    // ---------- 颜色：剩余时间 → 色相 ----------
    /**
     * 剩余比例 1.0 → 蓝紫（230），到 0.5 → 绿（140），到 0.2 → 黄（50），到 0 → 红（0）
     * 用分段线性插值，渐变更自然，不会"突然变红"。
     */
    function hueForRatio(ratio) {
        // ratio: 0..1（剩余时间占比）
        if (ratio >= 0.5) {
            // 230 → 140
            const t = (ratio - 0.5) / 0.5;
            return 140 + (230 - 140) * t;
        } else if (ratio >= 0.2) {
            // 140 → 50
            const t = (ratio - 0.2) / 0.3;
            return 50 + (140 - 50) * t;
        } else {
            // 50 → 0
            const t = ratio / 0.2;
            return 0 + 50 * t;
        }
    }

    // ---------- 主循环 ----------
    function startLoop() {
        cancelLoop();
        lastCounter = -1n;
        const tick = () => {
            renderFrame().catch((e) => {
                console.error(e);
                showError('生成验证码失败');
            });
            rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
    }

    function cancelLoop() {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
    }

    async function renderFrame() {
        if (!config) return;
        const { secret, digits, period, algorithm } = config;

        const nowMs = Date.now();
        const epoch = nowMs / 1000;
        const counter = counterFromEpoch(epoch, period);

        const elapsed = epoch % period;
        const remainSec = period - elapsed;
        const ratio = remainSec / period;

        // 环形进度：dashoffset 从 0（满）到 周长（空）
        const offset = RING_CIRCUMFERENCE * (1 - ratio);
        ringProgress.style.strokeDashoffset = offset.toFixed(2);

        // 倒计时颜色
        const hue = hueForRatio(ratio);
        document.documentElement.style.setProperty('--timer-hue', hue.toFixed(0));

        secondsRemaining.textContent = Math.ceil(remainSec);

        if (counter !== lastCounter) {
            lastCounter = counter;
            const keyBytes = base32ToBytes(secret);
            const code = await hotp(keyBytes, counter, digits, algorithm);
            const formatted = formatCode(code, digits);
            tokenCode.textContent = formatted;
            tokenCode.setAttribute('aria-label', `验证码 ${code}`);

            // 翻牌动画（重启）
            tokenCode.classList.remove('flip');
            void tokenCode.offsetWidth;
            tokenCode.classList.add('flip');
        }
    }

    function formatCode(code, digits) {
        if (digits === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
        if (digits === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
        return code;
    }

    // ---------- UI 行为 ----------
    function handleSecretInput() {
        clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(applyInput, 200);
    }

    function applyInput() {
        const value = secretInput.value;
        if (!value.trim()) {
            resetUI();
            return;
        }

        try {
            const parsed = parseInput(value);
            base32ToBytes(parsed.secret); // 预校验
            config = parsed;

            accountIssuer.textContent = parsed.issuer || '';
            accountLabel.textContent = parsed.label
                ? (parsed.issuer ? ` · ${parsed.label}` : parsed.label)
                : '';
            accountMeta.classList.toggle('is-empty', !parsed.issuer && !parsed.label);

            tokenCard.hidden = false;
            emptyState.hidden = true;
            errorText.textContent = '';
            startLoop();
        } catch (e) {
            config = null;
            cancelLoop();
            tokenCard.hidden = true;
            emptyState.hidden = false;
            errorText.textContent = e instanceof Error ? e.message : String(e);
        }
    }

    function resetUI() {
        config = null;
        cancelLoop();
        tokenCard.hidden = true;
        emptyState.hidden = false;
        errorText.textContent = '';
        accountIssuer.textContent = '';
        accountLabel.textContent = '';
    }

    function toggleSecretVisibility() {
        const showing = secretInput.type === 'text';
        secretInput.type = showing ? 'password' : 'text';
        const useEl = toggleVisibilityBtn.querySelector('use');
        useEl.setAttribute('href', showing ? '#i-eye' : '#i-eye-off');
    }

    async function copyToClipboard() {
        if (!config) return;
        const code = tokenCode.textContent.replace(/\s/g, '');
        if (!code || /^[—-]+$/.test(code)) return;

        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(code);
            } else {
                fallbackCopy(code);
            }
            flashCopied();
        } catch (e) {
            console.error('复制失败:', e);
            try {
                fallbackCopy(code);
                flashCopied();
            } catch {
                showToast('复制失败，请手动选择复制', true);
            }
        }
    }

    function flashCopied() {
        tokenCard.classList.add('copied');
        clearTimeout(copiedTimer);
        copiedTimer = window.setTimeout(() => tokenCard.classList.remove('copied'), 1400);
    }

    function fallbackCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (!ok) throw new Error('execCommand copy failed');
    }

    function setThemeIcon(isDark) {
        const useEl = themeToggle.querySelector('use');
        useEl.setAttribute('href', isDark ? '#i-sun' : '#i-moon');
    }

    // 同步浏览器 UI（地址栏/状态栏）颜色，避免手动切换主题后与页面不一致
    function applyThemeColor(isDark) {
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', isDark ? '#0f1014' : '#4e54c8');
    }

    function toggleTheme() {
        const isDark = document.body.classList.toggle('dark-mode');
        try { localStorage.setItem('darkMode', String(isDark)); } catch { /* ignore */ }
        setThemeIcon(isDark);
        applyThemeColor(isDark);
    }

    function initTheme() {
        let pref = null;
        try { pref = localStorage.getItem('darkMode'); } catch { /* ignore */ }
        const prefersDark = pref === null
            ? window.matchMedia?.('(prefers-color-scheme: dark)').matches
            : pref === 'true';
        if (prefersDark) {
            document.body.classList.add('dark-mode');
        }
        setThemeIcon(prefersDark);
        applyThemeColor(prefersDark);
    }

    // ---------- Toast ----------
    let toastTimer = 0;
    function showToast(msg, isError = false) {
        toast.textContent = msg;
        toast.classList.toggle('error', isError);
        toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => toast.classList.remove('show'), 1800);
    }

    function showError(msg) {
        errorText.textContent = msg;
    }

    // ---------- 初始化环形进度条 ----------
    function initRing() {
        ringProgress.style.strokeDasharray = RING_CIRCUMFERENCE.toFixed(3);
        ringProgress.style.strokeDashoffset = '0';
    }

    // ---------- 后台暂停 ----------
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            cancelLoop();
        } else if (config) {
            startLoop();
        }
    });

    // ---------- 事件绑定 ----------
    secretInput.addEventListener('input', handleSecretInput);
    toggleVisibilityBtn.addEventListener('click', toggleSecretVisibility);

    // 整张卡片可点击复制
    tokenCard.addEventListener('click', copyToClipboard);
    tokenCard.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            copyToClipboard();
        }
    });

    themeToggle.addEventListener('click', toggleTheme);

    initTheme();
    initRing();
})();
