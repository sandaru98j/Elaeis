// ============================================================================
// ELAEIS — Offline-Aware API Client & Non-Blocking Browser GPS Helpers
// ============================================================================

function isNetworkError(err) {
    if (!err) return false;
    if (err.name === "TypeError") return true;
    const msg = String(err.message || "");
    return (
        msg.includes("Failed to fetch") ||
        msg.includes("NetworkError") ||
        msg.includes("Load failed") ||
        msg.includes("network")
    );
}

function cacheKeyForApiPath(path) {
    if (path.startsWith("/api/bootstrap") || path.startsWith("/api/hierarchy")) return "cache:bootstrap";
    if (path.startsWith("/api/trees/mapped")) return "cache:mapped_trees";
    if (path.startsWith("/api/auth/me")) return "cache:me";
    if (path.startsWith("/api/dispatch")) return `cache:dispatch:${path}`;
    if (path.startsWith("/api/report?")) return `cache:report:${path}`;
    if (path.startsWith("/api/analytics/agronomy")) return `cache:agronomy:${path}`;
    if (path.startsWith("/api/map/trees")) return "cache:map_trees";
    if (path.startsWith("/api/profile/activity")) return "cache:profile_activity";
    return null;
}

async function api(path, method = "GET", body = null) {
    const headers = { "Content-Type": "application/json" };
    if (state.token) headers["Authorization"] = `Bearer ${state.token}`;

    const isGet = method.toUpperCase() === "GET";
    const blockMatch = isGet && path.startsWith("/api/block?") ? new URL(path, window.location.origin) : null;
    let blockCacheKey = null;
    if (blockMatch) {
        const bid = blockMatch.searchParams.get("block_id");
        const mode = blockMatch.searchParams.get("mode") || "map";
        const dt = blockMatch.searchParams.get("date") || todayStr();
        const rn = blockMatch.searchParams.get("round_no") || roundOfDate(dt).round;
        blockCacheKey = mode === "harvest" ? `block:${bid}:${dt.slice(0, 7)}:${rn}` : `block_map:${bid}`;
    }

    try {
        const res = await fetch(path, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
        });
        state.online = true;
        OfflineSync.updateIndicators();

        const ct = res.headers.get("content-type") || "";
        if (ct.includes("application/json")) {
            const data = await res.json();
            if (!res.ok) {
                const err = new Error(data.error || `Error ${res.status}`);
                err.status = res.status;
                throw err;
            }
            if (isGet) {
                if (blockCacheKey) {
                    OfflineDB.setBlock(blockCacheKey, data).catch(() => {});
                } else {
                    const ck = cacheKeyForApiPath(path);
                    if (ck) OfflineDB.setKV(ck, data).catch(() => {});
                }
            }
            return data;
        }
        if (!res.ok) {
            const err = new Error(`HTTP ${res.status}`);
            err.status = res.status;
            throw err;
        }
        return await res.text();
    } catch (err) {
        if (!isNetworkError(err)) {
            throw err;
        }

        state.online = false;
        OfflineSync.updateIndicators();

        // Offline GET: serve durable IndexedDB cache seamlessly
        if (isGet) {
            if (blockCacheKey) {
                const cached = await OfflineDB.getBlock(blockCacheKey);
                if (cached) return cached;
                // Fallback to any cached map view for the same block
                const bid = blockMatch.searchParams.get("block_id");
                const fallbackMap = await OfflineDB.getBlock(`block_map:${bid}`);
                if (fallbackMap) return fallbackMap;
            } else {
                const ck = cacheKeyForApiPath(path);
                if (ck) {
                    const cached = await OfflineDB.getKV(ck);
                    if (cached) return cached;
                }
            }
            throw new Error("Offline — this data is not cached yet. Connect once and tap Preload.");
        }

        throw new Error("Offline — network unavailable.");
    }
}

/**
 * Field-priority write helper: tries live network first when online,
 * and automatically falls back to IndexedDB Sync Queue when offline or on network drop.
 */
async function apiFieldWrite(type, endpoint, payload, summary) {
    const clientId = payload.client_id || generateClientId(type);
    const enriched = { ...payload, client_id: clientId };

    if (typeof navigator !== "undefined" && navigator.onLine === false) {
        state.online = false;
        await OfflineSync.enqueue(type, enriched, summary);
        return { ok: true, queued: true, client_id: clientId };
    }

    try {
        const res = await api(endpoint, "POST", enriched);
        return { ...res, queued: false, client_id: clientId };
    } catch (err) {
        if (!err.status && (isNetworkError(err) || String(err.message || "").startsWith("Offline"))) {
            await OfflineSync.enqueue(type, enriched, summary);
            return { ok: true, queued: true, client_id: clientId };
        }
        throw err;
    }
}

// ----------------------------------------------------------------------------
// Browser Geolocation API (GPS Assist — Non-Blocking)
// ----------------------------------------------------------------------------
function requestBrowserGps(timeoutMs = 5000) {
    return new Promise((resolve) => {
        if (!navigator.geolocation) {
            state.gps.live = false;
            updateGpsHeader();
            updateGpsAccuracyPills();
            resolve({ ok: false, lat: null, lng: null, acc: null, live: false });
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const lat = Number(pos.coords.latitude.toFixed(6));
                const lng = Number(pos.coords.longitude.toFixed(6));
                const acc = Math.max(1, Math.round(pos.coords.accuracy || 14));
                state.gps = { lat, lng, acc, live: true, timestamp: Date.now() };
                updateGpsHeader();
                updateGpsAccuracyPills();
                resolve({ ok: true, ...state.gps });
            },
            () => {
                state.gps.live = false;
                updateGpsHeader();
                updateGpsAccuracyPills();
                resolve({ ok: false, lat: null, lng: null, acc: null, live: false });
            },
            { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
        );
    });
}

function captureDeviceGps(targetTree = null) {
    return requestBrowserGps(3500).then((res) => {
        if (res.ok && res.lat !== null && res.lng !== null) return res;
        return fallbackGps(targetTree);
    });
}

function fallbackGps(targetTree = null) {
    if (targetTree && targetTree.lat !== null && targetTree.lat !== undefined && targetTree.lng !== null && targetTree.lng !== undefined) {
        return {
            lat: Number(Number(targetTree.lat).toFixed(6)),
            lng: Number(Number(targetTree.lng).toFixed(6)),
            acc: targetTree.gps_acc || null,
            live: false,
        };
    }
    return {
        lat: state.gps.lat !== null ? Number(Number(state.gps.lat).toFixed(6)) : null,
        lng: state.gps.lng !== null ? Number(Number(state.gps.lng).toFixed(6)) : null,
        acc: state.gps.acc || null,
        live: false,
    };
}

function updateGpsAccuracyPills(customText = null) {
    const text =
        customText ||
        (state.gps.live && state.gps.acc !== null ? `GPS ±${Math.round(state.gps.acc)}m` : "GPS ±--m");
    const isStrong = state.gps.live && state.gps.acc !== null && state.gps.acc <= 50;
    ["harv-gps-pill", "mh-gps-pill", "mp-gps-pill"].forEach((id) => {
        const el = $(id);
        if (!el) return;
        el.textContent = text;
        el.className = `x-status-pill font-mono-code text-[11px] ${
            isStrong ? "text-[#00ba7c] border-[#00ba7c]" : "text-[#536471]"
        }`;
    });
}

function updateGpsHeader() {
    const dot = $("gps-dot");
    const lbl = $("gps-label");
    if (!dot || !lbl) return;
    dot.className = `w-2 h-2 rounded-full shrink-0 ${state.gps.live ? "bg-[#00ba7c] animate-pulse" : "bg-[#536471]"}`;
    const isMobile = typeof window !== "undefined" && window.innerWidth <= 768;
    const decimals = isMobile ? 3 : 4;
    if (state.gps.lat !== null && state.gps.lng !== null) {
        lbl.textContent = `${Number(state.gps.lat).toFixed(decimals)}, ${Number(state.gps.lng).toFixed(decimals)}`;
    } else {
        lbl.textContent = "GPS Standby";
    }
}
