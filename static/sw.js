// ============================================================================
// ELAEIS — Field Offline Service Worker
// Caches the modular app shell + CDN libraries for zero-signal field operation
// ============================================================================

const SHELL_CACHE = "elaeis-shell-v3";
const RUNTIME_CACHE = "elaeis-runtime-v3";

const SHELL_ASSETS = [
    "/",
    "/index.html",
    "/styles.css",
    "/manifest.webmanifest",
    "/icon.svg",
    "/js/core.js",
    "/js/offline.js",
    "/js/api.js",
    "/js/dashboard.js",
    "/js/harvest.js",
    "/js/gis-map.js",
    "/js/admin.js",
    "/js/main.js",
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches
            .open(SHELL_CACHE)
            .then((cache) => cache.addAll(SHELL_ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) =>
                Promise.all(
                    keys
                        .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
                        .map((k) => caches.delete(k))
                )
            )
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET") return;

    const url = new URL(req.url);

    // Never intercept API or export endpoints — handled by IndexedDB Offline Engine
    if (
        url.pathname.startsWith("/api/") ||
        url.pathname === "/export/excel" ||
        url.pathname === "/report.xlsx"
    ) {
        return;
    }

    // Same-origin SPA navigations: Network-first with cached /index.html fallback
    if (req.mode === "navigate" && url.origin === self.location.origin) {
        event.respondWith(
            fetch(req)
                .then((res) => {
                    if (res && res.ok) {
                        const copy = res.clone();
                        caches.open(SHELL_CACHE).then((c) => c.put("/index.html", copy));
                    }
                    return res;
                })
                .catch(() => caches.match("/index.html"))
        );
        return;
    }

    // Same-origin static assets: Stale-While-Revalidate
    if (url.origin === self.location.origin) {
        event.respondWith(
            caches.match(req).then((cached) => {
                const fetchPromise = fetch(req)
                    .then((res) => {
                        if (res && res.ok) {
                            const copy = res.clone();
                            caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
                        }
                        return res;
                    })
                    .catch(() => cached);
                return cached || fetchPromise;
            })
        );
        return;
    }

    // External CDN libs & fonts & map tiles: Cache-first / Stale-While-Revalidate for offline readiness
    const cacheableHosts = [
        "cdn.tailwindcss.com",
        "unpkg.com",
        "fonts.googleapis.com",
        "fonts.gstatic.com",
        "server.arcgisonline.com",
        "basemaps.cartocdn.com",
    ];
    if (cacheableHosts.some((h) => url.hostname.endsWith(h))) {
        event.respondWith(
            caches.match(req).then((cached) => {
                const netFetch = fetch(req)
                    .then((res) => {
                        if (res && (res.ok || res.type === "opaque")) {
                            const copy = res.clone();
                            caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy));
                        }
                        return res;
                    })
                    .catch(() => cached);
                return cached || netFetch;
            })
        );
    }
});
