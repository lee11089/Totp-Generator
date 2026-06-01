/**
 * Service Worker - TOTP 验证码生成器
 *
 * 策略：cache-first（应用壳）
 * - 安装阶段预缓存核心资源
 * - 拦截同源 GET 请求，命中缓存直接返回，未命中走网络并写入缓存
 * - 升级时通过 CACHE_NAME 版本号触发旧缓存清理
 *
 * 升级方式：修改 CACHE_NAME（例如 v2 -> v3），用户下次打开自动拉取新版本
 */

const CACHE_NAME = 'totp-v1';
const PRECACHE_URLS = [
    './',
    'index.html',
    'style.css',
    'script.js',
    'manifest.webmanifest',
    'icon.svg',
    'icon-maskable.svg'
];

// 安装：预缓存核心资源
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(PRECACHE_URLS))
            .then(() => self.skipWaiting())
    );
});

// 激活：清理旧版本缓存
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

// 拦截请求：cache-first，仅处理同源 GET
self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    event.respondWith(
        caches.match(req).then((cached) => {
            if (cached) return cached;
            return fetch(req).then((res) => {
                // 仅缓存基本成功响应
                if (!res || res.status !== 200 || res.type !== 'basic') return res;
                const copy = res.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
                return res;
            }).catch(() => {
                // 离线兜底：导航请求降级到 index.html
                if (req.mode === 'navigate') {
                    return caches.match('index.html');
                }
                return Response.error();
            });
        })
    );
});
