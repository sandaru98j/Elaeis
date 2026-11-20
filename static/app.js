// ============================================================================
// ELAEIS — Closed Corporate ERP (Uskvalley Estate)
// Twitter / X 3-Column Frontend Controller + 4-Theme CSS Custom Property Engine
// ============================================================================

const ROLE_RANK = {
    Harvester: 1,
    Supervisor: 2,
    Admin: 3,
    "Master Admin": 4,
    harvester: 1,
    supervisor: 2,
    admin: 3,
    master_admin: 4,
};

const PAGE_TITLES = {
    overview: "Overview",
    harvests: "Harvests",
    map: "Map",
    estates: "Estates",
    directory: "Directory",
    profile: "Profile",
    settings: "Settings",
    info: "About Us",
};

const THEME_PALM_COLORS = {
    twitter: { harvested: "#00BA7C", unharvested: "#536471" },
    "dracula-dark": { harvested: "#50FA7B", unharvested: "#6272A4" },
    "dracula-light": { harvested: "#14710A", unharvested: "#6C664B" },
    nord: { harvested: "#A3BE8C", unharvested: "#4C566A" },
};

const THEME_REGISTRY = {
    twitter: {
        id: "twitter",
        name: "Default",
        short: "Default",
    },
    "dracula-dark": {
        id: "dracula-dark",
        name: "Dracula Dark",
        short: "Dracula Dark",
    },
    "dracula-light": {
        id: "dracula-light",
        name: "Dracula Light",
        short: "Dracula Light",
    },
    nord: {
        id: "nord",
        name: "Nord",
        short: "Nord",
    },
};

function normalizeRole(r) {
    const s = String(r || "").trim().toLowerCase();
    if (s === "master admin" || s === "master_admin" || s === "master") return "Master Admin";
    if (s === "admin") return "Admin";
    if (s === "supervisor") return "Supervisor";
    return "Harvester";
}

function getInitialRouteFromLocation() {
    const raw = (window.location.pathname || "/").replace(/^\/+|\/+$/g, "").toLowerCase();
    if (PAGE_TITLES[raw]) return raw;
    return "overview";
}

const state = {
    token: localStorage.getItem("el_token") || "",
    theme: localStorage.getItem("elaeis_theme") || "twitter",
    user: null,
    activePage: getInitialRouteFromLocation(),
    harvestView: "trees",
    estatesTab: "hierarchy",
    gps: { lat: 6.14224, lng: 80.36518, acc: null, live: false, timestamp: 0 },
    autoDetectGps: localStorage.getItem("elaeis_autodetect_gps") === "1",
    hierarchy: { estates: [], divisions: [], fields: [], blocks: [] },
    mappedTrees: [],
    settings: { season_start_month: 4 },
    dashTrees: [],
    recentLogs: [],
    harvBlock: { block_id: null, trees: [], filter: "all", search: "", selectedTreeId: null, manualOverride: false },
    dispatches: [],
    mapBlock: { block_id: null, trees: [] },
    adminUsers: { users: [] },
    profileActivity: [],
    editProfileDraft: { profile_pic: "", cover_photo: "" },
    modalTree: null,
    forcePwTarget: null,
    crudCallback: null,
    gisMap: {
        map: null,
        satelliteLayer: null,
        cleanLayer: null,
        boundaryLayer: null,
        labelLayer: null,
        palmCanvasLayer: null,
        basemapMode: "satellite", // "satellite" | "clean"
        showBoundaries: true,
        showLabels: true,
        isolate: false,
        allTrees: [],
        visibleTrees: [],
        boundariesCacheKey: "",
        boundaries: { estates: [], divisions: [], fields: [], blocks: [] },
        sprites: {
            harvested: null,
            unharvested: null,
            harvestedColor: "#00BA7C",
            unharvestedColor: "#536471",
            svgHarvestedUrl: "",
            svgUnharvestedUrl: "",
        },
        initializedFilters: false,
    },
};

// ----------------------------------------------------------------------------
// Utilities
// ----------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const esc = (s) =>
    String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

function todayStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

function roundOfDate(dateStr, explicitRound = null) {
    const r = Number(explicitRound);
    const ym = (dateStr || todayStr()).slice(0, 7);
    if (r === 1 || r === 2 || r === 3) {
        const rangeLabel = r === 1 ? "Days 1-10" : r === 2 ? "Days 11-20" : "Days 21-End";
        return { round: r, rangeLabel, yearMonth: ym };
    }
    const d = Number((dateStr || todayStr()).slice(8, 10)) || 1;
    const round = d <= 10 ? 1 : d <= 20 ? 2 : 3;
    const rangeLabel = round === 1 ? "Days 1-10" : round === 2 ? "Days 11-20" : "Days 21-End";
    return { round, rangeLabel, yearMonth: ym };
}

function distanceMeters(lat1, lng1, lat2, lng2) {
    if ([lat1, lng1, lat2, lng2].some((v) => v === null || v === undefined || v === "" || !Number.isFinite(Number(v)))) {
        return Infinity;
    }
    const R = 6371000;
    const rad = (x) => (Number(x) * Math.PI) / 180;
    const dLat = rad(Number(lat2) - Number(lat1));
    const dLng = rad(Number(lng2) - Number(lng1));
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(a))) * 10) / 10;
}

function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === "function") {
        window.lucide.createIcons();
    }
}

function toast(msg, type = "ok") {
    const box = $("toast-container");
    if (!box) return;
    const el = document.createElement("div");
    const colors =
        type === "err"
            ? "bg-[#f4212e] text-white border-[#f4212e]"
            : type === "warn"
            ? "bg-amber-500 text-[#0f1419] border-amber-600"
            : "bg-[#0f1419] text-white border-[#0f1419]";
    el.className = `pointer-events-auto px-4 py-3 rounded-full border shadow-md text-xs font-bold flex items-center justify-between gap-3 transition ${colors}`;
    el.innerHTML = `<span class="truncate">${esc(msg)}</span>`;
    box.appendChild(el);
    setTimeout(() => {
        el.style.opacity = "0";
        setTimeout(() => el.remove(), 200);
    }, 3200);
}

// ----------------------------------------------------------------------------
// 4-Theme CSS Custom Property Engine
// ----------------------------------------------------------------------------
function applyTheme(themeId, persistRemote = true) {
    const validTheme = THEME_REGISTRY[themeId] ? themeId : "twitter";
    state.theme = validTheme;

    document.documentElement.setAttribute("data-theme", validTheme);
    if (document.body) {
        document.body.setAttribute("data-theme", validTheme);
    }

    try {
        localStorage.setItem("elaeis_theme", validTheme);
    } catch (_) {}

    // Update Settings UI & Profile UI badges
    const meta = THEME_REGISTRY[validTheme];
    if ($("settings-active-theme-pill")) {
        $("settings-active-theme-pill").textContent = `Active: ${meta.short}`;
    }
    if ($("prof-theme-label")) {
        $("prof-theme-label").textContent = meta.name;
    }

    document.querySelectorAll("[data-theme-select]").forEach((card) => {
        const isCurrent = card.getAttribute("data-theme-select") === validTheme;
        card.classList.toggle("active-theme", isCurrent);
    });

    document.querySelectorAll("[data-theme-check]").forEach((badge) => {
        const isCurrent = badge.getAttribute("data-theme-check") === validTheme;
        badge.classList.toggle("hidden", !isCurrent);
    });

    if (persistRemote && state.token) {
        api("/api/settings/theme", "POST", { theme: validTheme }).catch(() => {});
    }

    if (typeof rebuildGisPalmSpritesAndRedraw === "function") {
        rebuildGisPalmSpritesAndRedraw();
    }
}

// ----------------------------------------------------------------------------
// Structured Item Detail Modal Helper
// ----------------------------------------------------------------------------
function openItemDetailModal({ badge, title, fields }) {
    if ($("mid-badge")) $("mid-badge").textContent = badge || "Record Details";
    if ($("mid-title")) $("mid-title").textContent = title || "Details";
    if ($("mid-content")) {
        $("mid-content").innerHTML = (fields || [])
            .map(
                (f) => `
            <div class="erp-card !p-3.5 ${f.full ? "sm:col-span-2" : ""}">
                <div class="text-[10px] font-bold uppercase tracking-wider text-[#536471]">${esc(f.label)}</div>
                <div class="text-xs font-extrabold text-[#0f1419] mt-1 ${f.mono ? "font-mono-code" : ""} break-words">${esc(f.value)}</div>
            </div>`
            )
            .join("");
    }
    if ($("modal-item-detail")) {
        $("modal-item-detail").classList.remove("hidden");
    }
    refreshIcons();
}

// ----------------------------------------------------------------------------
// Password Hashing & Verification for Local Fallback Store
// ----------------------------------------------------------------------------
function encryptPassword(plain) {
    const salt = "elaeis_uskvalley_erp_2026";
    const input = `${salt}:${String(plain || "")}:${salt}`;
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let round = 0; round < 256; round++) {
        for (let i = 0; i < input.length; i++) {
            const c = input.charCodeAt(i) ^ (round & 0xff);
            h1 ^= c;
            h1 = Math.imul(h1, 0x01000193) >>> 0;
            h2 ^= (c + i) & 0xff;
            h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
        }
    }
    const hexDigest = h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
    const b64Payload = btoa(unescape(encodeURIComponent(`${hexDigest}:${input.length}`)));
    return `enc$v1$${b64Payload}$${hexDigest}`;
}

function verifyEncryptedPassword(plain, storedHash) {
    if (!storedHash) return false;
    return encryptPassword(plain) === storedHash;
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
                state.gps = {
                    lat,
                    lng,
                    acc,
                    live: true,
                    timestamp: Date.now(),
                };
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
        if (res.ok && res.lat !== null && res.lng !== null) {
            return res;
        }
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
        lat: state.gps.lat ? Number(Number(state.gps.lat).toFixed(6)) : null,
        lng: state.gps.lng ? Number(Number(state.gps.lng).toFixed(6)) : null,
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
    const lat = Number(state.gps.lat || 6.14224);
    const lng = Number(state.gps.lng || 80.36518);
    lbl.textContent = `${lat.toFixed(decimals)}, ${lng.toFixed(decimals)}`;
}

// ----------------------------------------------------------------------------
// Deterministic Natural Hillside Contour Coordinate Generator (11,020+ Palms)
// ----------------------------------------------------------------------------
const BLOCK_STAND_COUNTS = [
    560, 540, 580, 550, 590, 565, 545, 535, 520, 515,
    575, 545, 550, 565, 540, 530, 570, 545, 560, 540,
];

function computePalmCoordinates(blockId, treeNo) {
    const bIdx = Math.max(0, (Number(blockId) || 1) - 1);
    const fieldIdx = Math.floor(bIdx / 2);
    const blockInField = bIdx % 2;

    let fieldBaseLat = 6.142;
    let fieldBaseLng = 80.365;
    if (fieldIdx <= 5) {
        const fCol = fieldIdx % 2;
        const fRow = Math.floor(fieldIdx / 2);
        fieldBaseLat = 6.142 + fRow * 0.00255;
        fieldBaseLng = 80.365 + fCol * 0.00485;
    } else if (fieldIdx <= 7) {
        const fRow = fieldIdx - 6;
        fieldBaseLat = 6.1452 + fRow * 0.00255;
        fieldBaseLng = 80.3756;
    } else if (fieldIdx <= 9) {
        const fRow = fieldIdx - 8;
        fieldBaseLat = 6.14175 - fRow * 0.00255;
        fieldBaseLng = 80.3756;
    } else {
        const extra = fieldIdx - 10;
        fieldBaseLat = 6.1392 - (Math.floor(extra / 2) + 1) * 0.00255;
        fieldBaseLng = 80.365 + (extra % 2) * 0.00485;
    }

    const blockBaseLat = fieldBaseLat;
    const blockBaseLng = fieldBaseLng + blockInField * 0.00235;
    const cols = 23;
    const idx = Math.max(0, (Number(treeNo) || 1) - 1);
    const row = Math.floor(idx / cols);
    const col = idx % cols;
    const stagLng = row % 2 === 1 ? 0.00004 : 0.0;
    const u = (col / 22.0) * Math.PI;
    const v = (row / 24.0) * Math.PI;
    const phase = bIdx * 0.65;
    const curveLat = Math.sin(u + phase) * 0.00011 - Math.sin(phase) * 0.00011;
    const curveLng = Math.sin(v + phase * 0.7) * 0.00011 - Math.sin(phase * 0.7) * 0.00011;
    const archLat = Math.sin(u) * (blockInField === 0 ? 0.00008 : -0.00008);

    const lat = Number((blockBaseLat + row * 0.000075 + curveLat + archLat).toFixed(6));
    const lng = Number((blockBaseLng + col * 0.000078 + stagLng + curveLng).toFixed(6));
    return { lat, lng };
}

// ----------------------------------------------------------------------------
// Offline / Local Fallback Store (Mirrors Python SQLite & Cloudflare D1)
// ----------------------------------------------------------------------------
const LocalDB = {
    key: "elaeis_erp_db_v6",
    load() {
        try {
            const raw = localStorage.getItem(this.key);
            if (raw) return JSON.parse(raw);
        } catch (_) {}
        const seeded = this.seed();
        this.save(seeded);
        return seeded;
    },
    save(db) {
        try {
            localStorage.setItem(this.key, JSON.stringify(db));
        } catch (_) {}
    },
    seed() {
        const now = new Date().toISOString();
        const today = todayStr();
        const { yearMonth, round } = roundOfDate(today);
        const defaultHash = encryptPassword("Uskvalley2026!");

        const users = [
            { id: 1, username: "sandaru98j", email: "", phone: "", full_name: "Sandaruwan Gunathilaka", role: "Master Admin", is_master: true, theme: "twitter", pass_hash: defaultHash, created_at: now },
            { id: 2, username: "sandun", email: "", phone: "", full_name: "Sandun (Estate Manager)", role: "Admin", is_master: false, theme: "twitter", pass_hash: defaultHash, created_at: now },
            { id: 3, username: "raveendra", email: "", phone: "", full_name: "Raveendra", role: "Supervisor", is_master: false, theme: "twitter", pass_hash: defaultHash, created_at: now },
            { id: 4, username: "pasindu", email: "", phone: "", full_name: "Pasindu", role: "Supervisor", is_master: false, theme: "twitter", pass_hash: defaultHash, created_at: now },
            { id: 5, username: "kavindu", email: "", phone: "", full_name: "Kavindu", role: "Supervisor", is_master: false, theme: "twitter", pass_hash: defaultHash, created_at: now },
            { id: 6, username: "muditha", email: "", phone: "", full_name: "Muditha", role: "Supervisor", is_master: false, theme: "twitter", pass_hash: defaultHash, created_at: now },
            { id: 7, username: "rajasekaran", email: "", phone: "", full_name: "Rajasekaran", role: "Supervisor", is_master: false, theme: "twitter", pass_hash: defaultHash, created_at: now },
            { id: 8, username: "ajith", email: "", phone: "", full_name: "Ajith", role: "Harvester", is_master: false, theme: "twitter", pass_hash: defaultHash, created_at: now },
            { id: 9, username: "baba", email: "", phone: "", full_name: "Baba", role: "Harvester", is_master: false, theme: "twitter", pass_hash: defaultHash, created_at: now },
        ];

        const estates = [{ id: 1, name: "Uskvalley Estate" }];
        const divisions = [
            { id: 1, estate_id: 1, name: "Uskvalley Division" },
            { id: 2, estate_id: 1, name: "Trafalgar Division" },
            { id: 3, estate_id: 1, name: "Morawaka Division" },
        ];
        const fields = [
            { id: 1, division_id: 1, name: "Field 1", planting_year: 2011, area_ha: 11.0 },
            { id: 2, division_id: 1, name: "Field 2", planting_year: 2011, area_ha: 16.5 },
            { id: 3, division_id: 1, name: "Field 3", planting_year: 2011, area_ha: 28.0 },
            { id: 4, division_id: 1, name: "Field 4", planting_year: 2013, area_ha: 19.0 },
            { id: 5, division_id: 1, name: "Field 5", planting_year: 2014, area_ha: 3.75 },
            { id: 6, division_id: 1, name: "Field 6", planting_year: 2015, area_ha: 1.75 },
            { id: 7, division_id: 2, name: "Field 1", planting_year: 2012, area_ha: 22.5 },
            { id: 8, division_id: 2, name: "Field 2", planting_year: 2014, area_ha: 14.25 },
            { id: 9, division_id: 3, name: "Field 1", planting_year: 2013, area_ha: 18.0 },
            { id: 10, division_id: 3, name: "Field 2", planting_year: 2016, area_ha: 12.5 },
        ];
        const counts = BLOCK_STAND_COUNTS;
        const blocks = [];
        const trees = [];
        const harvest = [];
        let bid = 0;
        let tid = 0;
        let hid = 0;
        for (const f of fields) {
            for (const [bname, note] of [["Block A", "Valley stream boundary"], ["Block B", "Ridge road boundary"]]) {
                bid++;
                const total = counts[bid - 1] || 540;
                blocks.push({ id: bid, field_id: f.id, name: bname, boundary_note: note });
                for (let n = 1; n <= total; n++) {
                    tid++;
                    const coords = computePalmCoordinates(bid, n);
                    trees.push({
                        id: tid,
                        block_id: bid,
                        tree_no: n,
                        tree_code: `T-${String(n).padStart(3, "0")}`,
                        lat: coords.lat,
                        lng: coords.lng,
                        gps_acc: 3.8,
                        status: "active",
                        mapped_at: now,
                    });
                    if ((n + bid * 3) % 3 === 0) {
                        hid++;
                        const isR1 = (n + bid) % 2 === 0;
                        const rnd = isR1 ? 1 : round;
                        const hdate = isR1 ? `${yearMonth}-05` : today;
                        harvest.push({
                            id: hid,
                            tree_id: tid,
                            harvest_date: hdate,
                            year_month: yearMonth,
                            round_no: rnd,
                            bunches: 2 + ((n * 7 + bid) % 5),
                            fronds: 2 + ((n * 3 + bid) % 4),
                            user_id: 8 + ((tid + bid) % 2),
                            user_lat: coords.lat,
                            user_lng: coords.lng,
                            user_acc: 3.9,
                            recorded_at: now,
                        });
                    }
                }
            }
        }
        const dispatch = [
            { id: 1, division_id: 1, dispatch_date: `${yearMonth}-05`, year_month: yearMonth, round_no: 1, weight_kg: 72400.0, user_id: 3, recorded_at: now },
            { id: 2, division_id: 1, dispatch_date: today, year_month: yearMonth, round_no: round, weight_kg: 74200.0, user_id: 3, recorded_at: now },
            { id: 3, division_id: 2, dispatch_date: today, year_month: yearMonth, round_no: round, weight_kg: 48600.0, user_id: 4, recorded_at: now },
            { id: 4, division_id: 3, dispatch_date: today, year_month: yearMonth, round_no: round, weight_kg: 47900.0, user_id: 5, recorded_at: now },
        ];
        return {
            users,
            estates,
            divisions,
            fields,
            blocks,
            trees,
            harvest,
            dispatch,
            settings: { season_start_month: 4 },
        };
    },
};

// ----------------------------------------------------------------------------
// Unified API Client
// ----------------------------------------------------------------------------
async function api(path, method = "GET", body = null) {
    const headers = { "Content-Type": "application/json" };
    if (state.token) headers["Authorization"] = `Bearer ${state.token}`;
    try {
        const res = await fetch(path, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
        });
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("application/json")) {
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
            return data;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
    } catch (err) {
        if (
            err.message &&
            !err.message.includes("Failed to fetch") &&
            !err.message.includes("HTTP 404") &&
            !err.message.includes("NetworkError")
        ) {
            throw err;
        }
        return localApiFallback(path, method, body);
    }
}

function localApiFallback(path, method, body) {
    const db = LocalDB.load();
    const uObj = new URL(path, window.location.origin);
    const pathname = uObj.pathname;
    const params = Object.fromEntries(uObj.searchParams.entries());
    const curUser = db.users.find((u) => `local-token-${u.id}` === state.token) || db.users[0];

    if (pathname === "/api/auth/login") {
        const username = String(body.username || body.identifier || "").trim().toLowerCase();
        if (!username) throw new Error("Enter your Username.");
        const u = db.users.find((x) => x.username.toLowerCase() === username);
        if (!u || !verifyEncryptedPassword(body.password, u.pass_hash)) {
            throw new Error("Invalid username or password.");
        }
        return { token: `local-token-${u.id}`, user: u };
    }
    if (pathname === "/api/auth/me") {
        const acts = db.harvest
            .filter((h) => h.user_id === curUser.id)
            .slice(-5)
            .reverse()
            .map((h) => {
                const t = db.trees.find((x) => x.id === h.tree_id) || {};
                const b = db.blocks.find((x) => x.id === t.block_id) || {};
                const f = db.fields.find((x) => x.id === b.field_id) || {};
                const d = db.divisions.find((x) => x.id === f.division_id) || {};
                return {
                    id: h.id,
                    harvest_date: h.harvest_date,
                    round_no: h.round_no,
                    bunches: h.bunches,
                    fronds: h.fronds,
                    tree_no: t.tree_no,
                    block_name: b.name,
                    field_name: f.name,
                    division_name: d.name,
                    recorded_by: curUser.full_name,
                };
            });
        return { user: curUser, recent_activity: acts };
    }
    if (pathname === "/api/profile/activity") {
        const acts = db.harvest
            .filter((h) => h.user_id === curUser.id)
            .slice(-5)
            .reverse()
            .map((h) => {
                const t = db.trees.find((x) => x.id === h.tree_id) || {};
                const b = db.blocks.find((x) => x.id === t.block_id) || {};
                const f = db.fields.find((x) => x.id === b.field_id) || {};
                const d = db.divisions.find((x) => x.id === f.division_id) || {};
                return {
                    id: h.id,
                    harvest_date: h.harvest_date,
                    round_no: h.round_no,
                    bunches: h.bunches,
                    fronds: h.fronds,
                    tree_no: t.tree_no,
                    block_name: b.name,
                    field_name: f.name,
                    division_name: d.name,
                    recorded_by: curUser.full_name,
                };
            });
        return { recent_activity: acts };
    }
    if (pathname === "/api/profile/update" || pathname === "/api/auth/profile") {
        const nextName = String(body?.full_name || curUser.full_name).trim();
        const nextUser = String(body?.username || curUser.username).trim().toLowerCase().replace(/^@+/, "");
        if (!nextName || !nextUser) throw new Error("Full Name and Username are required.");
        if (db.users.some((u) => u.id !== curUser.id && u.username.toLowerCase() === nextUser)) {
            throw new Error(`Username '@${nextUser}' is already taken.`);
        }
        curUser.full_name = nextName;
        curUser.username = nextUser;
        if (body?.profile_pic !== undefined) curUser.profile_pic = String(body.profile_pic || "");
        if (body?.cover_photo !== undefined) curUser.cover_photo = String(body.cover_photo || "");
        LocalDB.save(db);
        return { ok: true, message: "Profile updated successfully.", user: curUser };
    }
    if (pathname === "/api/auth/logout") {
        return { ok: true };
    }
    if (pathname === "/api/settings/theme") {
        const nextTheme = String(body?.theme || "twitter");
        if (curUser) {
            curUser.theme = nextTheme;
            LocalDB.save(db);
        }
        return { ok: true, theme: nextTheme };
    }
    if (pathname === "/api/auth/change-password") {
        if (!verifyEncryptedPassword(body.current_password, curUser.pass_hash)) {
            throw new Error("Current password is incorrect.");
        }
        if (String(body.new_password || "").length < 6) {
            throw new Error("New password must be at least 6 characters.");
        }
        curUser.pass_hash = encryptPassword(body.new_password);
        LocalDB.save(db);
        return { ok: true, message: "Password updated successfully." };
    }
    if (pathname === "/api/bootstrap") {
        const blocks = db.blocks.map((b) => {
            const bt = db.trees.filter((t) => t.block_id === b.id);
            return {
                ...b,
                tree_total: bt.length,
                tree_active: bt.filter((t) => t.status === "active").length,
                tree_mapped: bt.filter((t) => t.lat !== null).length,
            };
        });
        const mapped_trees = db.trees
            .filter((t) => t.status === "active" && t.lat !== null && t.lng !== null)
            .map((t) => ({ id: t.id, block_id: t.block_id, tree_no: t.tree_no, lat: t.lat, lng: t.lng, gps_acc: t.gps_acc }));
        return {
            hierarchy: { estates: db.estates, divisions: db.divisions, fields: db.fields, blocks },
            settings: db.settings,
            mapped_trees,
        };
    }
    if (pathname === "/api/trees/mapped") {
        const trees = db.trees
            .filter((t) => t.status === "active" && t.lat !== null && t.lng !== null)
            .map((t) => ({ id: t.id, block_id: t.block_id, tree_no: t.tree_no, lat: t.lat, lng: t.lng, gps_acc: t.gps_acc }));
        return { trees };
    }
    if (pathname === "/api/trees/nearest") {
        const uLat = Number(params.lat);
        const uLng = Number(params.lng);
        const maxRadiusM = Number(params.max_radius_m || 100);
        const prefBlockId = params.block_id ? Number(params.block_id) : null;
        if (!Number.isFinite(uLat) || !Number.isFinite(uLng)) return { tree: null };
        let bestTree = null;
        let bestDist = Infinity;
        for (const t of db.trees) {
            if (t.status !== "active" || t.lat === null || t.lng === null) continue;
            const d = distanceMeters(uLat, uLng, t.lat, t.lng);
            if (d < bestDist || (d === bestDist && prefBlockId && t.block_id === prefBlockId)) {
                bestDist = d;
                const b = db.blocks.find((x) => x.id === t.block_id) || {};
                const f = db.fields.find((x) => x.id === b.field_id) || {};
                bestTree = { ...t, field_id: b.field_id, division_id: f.division_id, distance_m: d };
            }
        }
        if (bestTree && bestDist <= maxRadiusM) {
            return { tree: bestTree, distance_m: bestDist };
        }
        return { tree: null, distance_m: Number.isFinite(bestDist) ? bestDist : null };
    }
    if (pathname === "/api/map/trees") {
        const from = params.from || "1900-01-01";
        const to = params.to || "2999-12-31";
        const rFlt = params.round_no ? Number(params.round_no) : null;
        const divId = params.division_id ? Number(params.division_id) : null;
        const fldId = params.field_id ? Number(params.field_id) : null;
        const blkId = params.block_id ? Number(params.block_id) : null;
        const isolate = ["1", "true", "yes"].includes(String(params.isolate || "0").toLowerCase());

        const hAgg = new Map();
        for (const h of db.harvest || []) {
            if (h.harvest_date < from || h.harvest_date > to) continue;
            if (rFlt && Number(h.round_no) !== rFlt) continue;
            const prev = hAgg.get(h.tree_id) || { bunches: 0, fronds: 0 };
            prev.bunches += Number(h.bunches || 0);
            prev.fronds += Number(h.fronds || 0);
            hAgg.set(h.tree_id, prev);
        }

        const blockMap = new Map(db.blocks.map((b) => [b.id, b]));
        const fieldMap = new Map(db.fields.map((f) => [f.id, f]));
        const divMap = new Map(db.divisions.map((d) => [d.id, d]));
        const est = db.estates[0] || { id: 1, name: "Uskvalley Estate" };

        const treesOut = [];
        let harvestedCount = 0;
        for (const t of db.trees) {
            if (t.status !== "active") continue;
            const b = blockMap.get(t.block_id) || {};
            const f = fieldMap.get(b.field_id) || {};
            const d = divMap.get(f.division_id) || {};
            if (isolate) {
                if (blkId && b.id !== blkId) continue;
                else if (!blkId && fldId && f.id !== fldId) continue;
                else if (!blkId && !fldId && divId && d.id !== divId) continue;
            }
            let lat = t.lat;
            let lng = t.lng;
            if (lat === null || lat === undefined || lng === null || lng === undefined) {
                const c = computePalmCoordinates(t.block_id, t.tree_no);
                lat = c.lat;
                lng = c.lng;
            }
            const agg = hAgg.get(t.id) || { bunches: 0, fronds: 0 };
            const harvested = agg.bunches > 0;
            if (harvested) harvestedCount++;
            treesOut.push({
                id: t.id,
                tree_no: t.tree_no,
                tree_code: t.tree_code || `T-${String(t.tree_no).padStart(3, "0")}`,
                lat,
                lng,
                block_id: b.id,
                block_name: b.name || "Block",
                field_id: f.id,
                field_name: f.name || "Field",
                division_id: d.id,
                division_name: d.name || "Division",
                estate_id: est.id,
                estate_name: est.name,
                harvested,
                bunches: agg.bunches,
                fronds: agg.fronds,
            });
        }
        return {
            from,
            to,
            round_no: rFlt,
            total_trees: treesOut.length,
            harvested_trees: harvestedCount,
            trees: treesOut,
        };
    }
    if (pathname === "/api/tree/calibrate" && method === "POST") {
        const tid = Number(body.id || body.tree_id);
        const t = db.trees.find((x) => x.id === tid);
        if (!t) throw new Error("Tree not found.");
        const lat = Number(body.lat);
        const lng = Number(body.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
            throw new Error("Enter valid Latitude and Longitude coordinates.");
        }
        t.lat = Number(lat.toFixed(6));
        t.lng = Number(lng.toFixed(6));
        t.gps_acc = Number(body.acc) || 4.0;
        t.mapped_at = new Date().toISOString();
        LocalDB.save(db);
        return { ok: true, lat: t.lat, lng: t.lng };
    }
    if (pathname === "/api/block") {
        const bid = Number(params.block_id);
        const date = params.date || todayStr();
        const { yearMonth, round } = roundOfDate(date, params.round_no);
        const bt = db.trees.filter((t) => t.block_id === bid).sort((a, b) => a.tree_no - b.tree_no);
        return {
            block_id: bid,
            date,
            trees: bt.map((t) => {
                let rec = null;
                if (params.mode === "harvest") {
                    rec = db.harvest.find((h) => h.tree_id === t.id && h.year_month === yearMonth && h.round_no === round) || null;
                }
                return { ...t, rec };
            }),
        };
    }
    if (pathname === "/api/harvest" && method === "POST") {
        const t = db.trees.find((x) => x.id === Number(body.tree_id));
        if (!t) throw new Error("Palm tree not found.");
        const { yearMonth, round } = roundOfDate(body.date, body.round_no);
        const idx = db.harvest.findIndex((h) => h.tree_id === t.id && h.year_month === yearMonth && h.round_no === round);
        const hasValidGps =
            body.lat !== null &&
            body.lat !== undefined &&
            body.lng !== null &&
            body.lng !== undefined &&
            Number.isFinite(Number(body.lat)) &&
            Number.isFinite(Number(body.lng));
        const finalLat = hasValidGps ? Number(body.lat) : (t.lat ?? null);
        const finalLng = hasValidGps ? Number(body.lng) : (t.lng ?? null);
        const finalAcc = hasValidGps && body.acc !== null && body.acc !== undefined ? Number(body.acc) : (t.gps_acc ?? null);
        const row = {
            id: idx >= 0 ? db.harvest[idx].id : db.harvest.length + 1,
            tree_id: t.id,
            harvest_date: body.date,
            year_month: yearMonth,
            round_no: round,
            bunches: Number(body.bunches),
            fronds: Number(body.fronds),
            user_id: curUser.id,
            user_lat: finalLat,
            user_lng: finalLng,
            user_acc: finalAcc,
            recorded_at: new Date().toISOString(),
        };
        if (idx >= 0) db.harvest[idx] = row;
        else db.harvest.push(row);
        LocalDB.save(db);
        return { ok: true, round, lat: finalLat, lng: finalLng };
    }
    if (pathname === "/api/dispatch" && method === "GET") {
        const list = (db.dispatch || []).map((x) => {
            const div = db.divisions.find((d) => d.id === x.division_id);
            const u = db.users.find((usr) => usr.id === x.user_id);
            return {
                ...x,
                division_name: div ? div.name : "Division",
                recorded_by: u ? u.full_name : "Staff",
            };
        });
        return { dispatches: list.reverse() };
    }
    if (pathname === "/api/dispatch" && method === "POST") {
        db.dispatch = db.dispatch || [];
        const id = db.dispatch.reduce((m, x) => Math.max(m, x.id), 0) + 1;
        db.dispatch.push({
            id,
            division_id: Number(body.division_id),
            dispatch_date: body.date,
            year_month: body.date.slice(0, 7),
            round_no: Number(body.round_no),
            weight_kg: Number(body.weight_kg),
            user_id: curUser.id,
            recorded_at: new Date().toISOString(),
        });
        LocalDB.save(db);
        return { ok: true };
    }
    if (pathname === "/api/dispatch/delete" && method === "POST") {
        db.dispatch = (db.dispatch || []).filter((x) => x.id !== Number(body.id));
        LocalDB.save(db);
        return { ok: true };
    }
    if (pathname === "/api/report") {
        const from = params.from || "1900-01-01";
        const to = params.to || "2999-12-31";
        const rFlt = params.round_no ? Number(params.round_no) : null;
        let targetDivId = params.division_id ? Number(params.division_id) : null;
        let totalHa = 0;

        if (params.field_id) {
            const f = db.fields.find((x) => x.id === Number(params.field_id));
            totalHa = f ? f.area_ha : 0;
            if (f && !targetDivId) targetDivId = f.division_id;
        } else if (params.block_id) {
            const b = db.blocks.find((x) => x.id === Number(params.block_id));
            const f = b ? db.fields.find((x) => x.id === b.field_id) : null;
            totalHa = f ? f.area_ha : 0;
            if (f && !targetDivId) targetDivId = f.division_id;
        } else if (params.tree_id) {
            const t = db.trees.find((x) => x.id === Number(params.tree_id));
            const b = t ? db.blocks.find((x) => x.id === t.block_id) : null;
            const f = b ? db.fields.find((x) => x.id === b.field_id) : null;
            totalHa = f ? f.area_ha : 0;
            if (f && !targetDivId) targetDivId = f.division_id;
        } else if (targetDivId) {
            totalHa = db.fields.filter((f) => f.division_id === targetDivId).reduce((s, f) => s + f.area_ha, 0);
        } else {
            totalHa = db.fields.reduce((s, f) => s + f.area_ha, 0);
        }

        const matchTree = (tid) => {
            const t = db.trees.find((x) => x.id === tid);
            if (!t) return false;
            const b = db.blocks.find((x) => x.id === t.block_id);
            const f = db.fields.find((x) => x.id === b.field_id);
            const d = db.divisions.find((x) => x.id === f.division_id);
            if (params.tree_id && t.id !== Number(params.tree_id)) return false;
            if (params.block_id && b.id !== Number(params.block_id)) return false;
            if (params.field_id && f.id !== Number(params.field_id)) return false;
            if (params.division_id && d.id !== Number(params.division_id)) return false;
            if (params.estate_id && d.estate_id !== Number(params.estate_id)) return false;
            return true;
        };

        const hRows = db.harvest.filter(
            (h) => h.harvest_date >= from && h.harvest_date <= to && (!rFlt || h.round_no === rFlt) && matchTree(h.tree_id)
        );
        const dRows = (db.dispatch || []).filter(
            (d) =>
                d.dispatch_date >= from &&
                d.dispatch_date <= to &&
                (!rFlt || d.round_no === rFlt) &&
                (!targetDivId || d.division_id === targetDivId)
        );

        const bunches = hRows.reduce((s, r) => s + r.bunches, 0);
        const fronds = hRows.reduce((s, r) => s + r.fronds, 0);
        const dispatch_kg = dRows.reduce((s, r) => s + r.weight_kg, 0);
        const abw = bunches > 0 ? Number((dispatch_kg / bunches).toFixed(2)) : 0;
        const yph = totalHa > 0 ? Number((dispatch_kg / totalHa).toFixed(2)) : 0;

        const recent_logs = hRows
            .slice(-12)
            .reverse()
            .map((h) => {
                const t = db.trees.find((x) => x.id === h.tree_id) || {};
                const b = db.blocks.find((x) => x.id === t.block_id) || {};
                const f = db.fields.find((x) => x.id === b.field_id) || {};
                const d = db.divisions.find((x) => x.id === f.division_id) || {};
                const u = db.users.find((x) => x.id === h.user_id) || {};
                return {
                    id: h.id,
                    harvest_date: h.harvest_date,
                    round_no: h.round_no,
                    bunches: h.bunches,
                    fronds: h.fronds,
                    tree_no: t.tree_no,
                    block_name: b.name,
                    field_name: f.name,
                    division_name: d.name,
                    recorded_by: u.full_name || "Harvester",
                };
            });

        return {
            from,
            to,
            totals: {
                bunches,
                fronds,
                records: hRows.length,
                trees: new Set(hRows.map((x) => x.tree_id)).size,
                dispatch_kg,
                dispatch_records: dRows.length,
                area_ha: totalHa,
                abw,
                yph,
            },
            recent_logs,
        };
    }
    if (pathname === "/api/admin/users") {
        return { users: db.users };
    }
    if (pathname === "/api/admin/users/create") {
        const username = String(body.username || "").trim().toLowerCase();
        const full_name = String(body.full_name || "").trim();
        const role = normalizeRole(body.role || "Harvester");
        const password = String(body.password || "");
        if (!username || !full_name) throw new Error("Username and Full Name are required.");
        if (password.length < 6) throw new Error("Initial password must be at least 6 characters.");
        if (db.users.some((u) => u.username.toLowerCase() === username)) {
            throw new Error(`Username '@${username}' already exists.`);
        }
        const id = db.users.reduce((m, x) => Math.max(m, x.id), 0) + 1;
        db.users.push({
            id,
            username,
            email: "",
            phone: "",
            full_name,
            role,
            is_master: false,
            theme: "twitter",
            pass_hash: encryptPassword(password),
            created_at: new Date().toISOString(),
        });
        LocalDB.save(db);
        return { ok: true, message: `Created ERP user @${username} (${role}).` };
    }
    if (pathname === "/api/admin/users/role") {
        const u = db.users.find((x) => x.id === Number(body.user_id));
        if (u && !u.is_master && u.username.toLowerCase() !== "sandaru98j") {
            u.role = normalizeRole(body.role);
        }
        LocalDB.save(db);
        return { ok: true };
    }
    if (pathname === "/api/admin/users/force-password") {
        const isMaster = Boolean(curUser.is_master) || curUser.username.toLowerCase() === "sandaru98j";
        if (!isMaster) throw new Error("Only Master Admin (sandaru98j) can force-reset user passwords.");
        const u = db.users.find((x) => x.id === Number(body.user_id));
        if (!u) throw new Error("User not found.");
        const nextPw = String(body.new_password || "");
        if (nextPw.length < 6) throw new Error("New password must be at least 6 characters.");
        u.pass_hash = encryptPassword(nextPw);
        LocalDB.save(db);
        return { ok: true, message: `Password force-updated for @${u.username}.` };
    }
    if (pathname === "/api/admin/users/delete") {
        db.users = db.users.filter((x) => x.id !== Number(body.user_id) || x.is_master || x.username.toLowerCase() === "sandaru98j");
        LocalDB.save(db);
        return { ok: true };
    }
    if (pathname === "/api/admin/trees/batch") {
        const bid = Number(body.block_id);
        const count = Number(body.count);
        const maxNo = db.trees.filter((t) => t.block_id === bid).reduce((m, t) => Math.max(m, t.tree_no), 0);
        let maxId = db.trees.reduce((m, t) => Math.max(m, t.id), 0);
        for (let n = maxNo + 1; n <= maxNo + count; n++) {
            maxId++;
            db.trees.push({ id: maxId, block_id: bid, tree_no: n, lat: null, lng: null, gps_acc: null, status: "active", mapped_at: null });
        }
        LocalDB.save(db);
        return { ok: true, from: maxNo + 1, to: maxNo + count };
    }
    if (pathname === "/api/admin/settings") {
        db.settings.season_start_month = Number(body.season_start_month) || 4;
        LocalDB.save(db);
        return { ok: true };
    }
    const m = pathname.match(/^\/api\/admin\/(estate|division|field|block|tree)\/(save|delete)$/);
    if (m) {
        const [, ent, act] = m;
        const mapKey = { estate: "estates", division: "divisions", field: "fields", block: "blocks", tree: "trees" }[ent];
        if (act === "delete") {
            db[mapKey] = db[mapKey].filter((x) => x.id !== Number(body.id));
        } else {
            if (body.id) {
                const item = db[mapKey].find((x) => x.id === Number(body.id));
                if (item) Object.assign(item, body);
            } else {
                const nextId = db[mapKey].reduce((mx, x) => Math.max(mx, x.id), 0) + 1;
                db[mapKey].push({ ...body, id: nextId, status: "active" });
            }
        }
        LocalDB.save(db);
        return { ok: true };
    }
    return { ok: true };
}

// ----------------------------------------------------------------------------
// Live Auto-Refresh Digital Clock (Updates every 1000ms) & Greeting
// ----------------------------------------------------------------------------
function formatShortDateLabel(isoDateStr) {
    if (!isoDateStr || !/^\d{4}-\d{2}-\d{2}$/.test(isoDateStr)) return isoDateStr || "";
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const mIdx = Math.max(0, Math.min(11, Number(isoDateStr.slice(5, 7)) - 1));
    const day = Number(isoDateStr.slice(8, 10));
    return `${months[mIdx]} ${day}`;
}

function formatMonthYearLabel(ymStr) {
    if (!ymStr || !/^\d{4}-\d{2}$/.test(ymStr)) return ymStr || "";
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const yr = ymStr.slice(0, 4);
    const mIdx = Math.max(0, Math.min(11, Number(ymStr.slice(5, 7)) - 1));
    return `${months[mIdx]} ${yr}`;
}

function updateClockAndGreeting() {
    const now = new Date();
    const hrs24 = now.getHours();
    const mins = String(now.getMinutes()).padStart(2, "0");
    const secs = String(now.getSeconds()).padStart(2, "0");
    const ampm = hrs24 >= 12 ? "PM" : "AM";
    const hrs12 = String(hrs24 % 12 || 12).padStart(2, "0");

    const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const isNarrowMobile = typeof window !== "undefined" && window.innerWidth < 600;
    const clockDisplay = isNarrowMobile
        ? `${months[now.getMonth()]} ${now.getDate()} • ${hrs12}:${mins} ${ampm}`
        : `${weekdays[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()} • ${hrs12}:${mins}:${secs} ${ampm}`;

    const period = hrs24 < 12 ? "Good morning" : hrs24 < 17 ? "Good afternoon" : "Good evening";
    const name = state.user ? state.user.full_name.split(" ")[0] : "";
    const gEl = $("hdr-greeting");
    const cEl = $("hdr-clock");
    const rEl = $("hdr-round-pill");
    const rRight = $("right-active-round");
    if (gEl) gEl.textContent = name ? `${period}, ${name}` : period;
    if (cEl) cEl.textContent = clockDisplay;
    const { round, rangeLabel } = roundOfDate(todayStr());
    if (rEl) rEl.textContent = `R${round} (${rangeLabel})`;
    if (rRight) rRight.textContent = `Round ${round} (${rangeLabel})`;
}

// ----------------------------------------------------------------------------
// Auth & Session Flow (Closed Corporate ERP: Username + Password ONLY)
// ----------------------------------------------------------------------------
function showAuthScreen() {
    $("auth-screen").classList.remove("hidden");
    $("app-shell").classList.add("hidden");
    refreshIcons();
}

async function loginWithUsername(username, password) {
    try {
        const res = await api("/api/auth/login", "POST", { username, password });
        state.token = res.token;
        state.user = res.user;
        localStorage.setItem("el_token", res.token);
        if (res.user?.theme && THEME_REGISTRY[res.user.theme]) {
            applyTheme(res.user.theme, false);
        }
        toast(`Welcome back, @${res.user.username}`);
        await enterApplication();
    } catch (err) {
        toast(err.message || "Invalid username or password.", "err");
    }
}

async function enterApplication() {
    if (!state.user) {
        try {
            const me = await api("/api/auth/me");
            state.user = me.user;
        } catch (_) {
            state.token = "";
            localStorage.removeItem("el_token");
            showAuthScreen();
            return;
        }
    }

    const isMaster = Boolean(state.user.is_master) || String(state.user.username || "").toLowerCase() === "sandaru98j";
    state.user.is_master = isMaster;
    state.user.role = isMaster ? "Master Admin" : normalizeRole(state.user.role);

    if (state.user.theme && THEME_REGISTRY[state.user.theme] && !localStorage.getItem("elaeis_theme")) {
        applyTheme(state.user.theme, false);
    } else {
        applyTheme(state.theme, false);
    }

    updateClockAndGreeting();
    syncUserIdentityUI();
    $("auth-screen").classList.add("hidden");
    $("app-shell").classList.remove("hidden");

    applyRbacNavigation();
    await loadBootstrap();
    captureDeviceGps();
    switchPage(state.activePage, false);
}

function syncUserIdentityUI() {
    if (!state.user) return;
    const u = state.user;
    const initials = (u.full_name || "U")
        .split(" ")
        .filter(Boolean)
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();

    const hasAvatar = Boolean(u.profile_pic);
    const hasCover = Boolean(u.cover_photo);

    if ($("rail-user-avatar-initials")) {
        $("rail-user-avatar-initials").textContent = initials;
        $("rail-user-avatar-initials").classList.toggle("hidden", hasAvatar);
    }
    if ($("rail-user-avatar-img")) {
        if (hasAvatar) $("rail-user-avatar-img").src = u.profile_pic;
        $("rail-user-avatar-img").classList.toggle("hidden", !hasAvatar);
    }
    if ($("rail-user-name")) $("rail-user-name").textContent = u.full_name;
    if ($("rail-user-handle")) $("rail-user-handle").textContent = `@${u.username}`;
    if ($("rail-user-role")) $("rail-user-role").textContent = u.role;

    if ($("drawer-user-name")) $("drawer-user-name").textContent = u.full_name;
    if ($("drawer-user-handle")) $("drawer-user-handle").textContent = `@${u.username} • ${u.role}`;

    if ($("prof-avatar-inner")) {
        $("prof-avatar-inner").textContent = initials;
        $("prof-avatar-inner").classList.toggle("hidden", hasAvatar);
    }
    if ($("prof-avatar-img")) {
        if (hasAvatar) $("prof-avatar-img").src = u.profile_pic;
        $("prof-avatar-img").classList.toggle("hidden", !hasAvatar);
    }
    if ($("prof-cover-img")) {
        if (hasCover) $("prof-cover-img").src = u.cover_photo;
        $("prof-cover-img").classList.toggle("hidden", !hasCover);
    }
    if ($("prof-fullname")) $("prof-fullname").textContent = u.full_name;
    if ($("prof-username")) $("prof-username").textContent = `@${u.username}`;
    if ($("prof-role-badge")) $("prof-role-badge").textContent = u.role;
    if ($("prof-theme-label")) {
        $("prof-theme-label").textContent = THEME_REGISTRY[state.theme]?.name || "Twitter / X (Default)";
    }
}

async function loadProfilePage() {
    syncUserIdentityUI();
    try {
        const res = await api("/api/profile/activity");
        state.profileActivity = res.recent_activity || [];
    } catch (_) {
        state.profileActivity = [];
    }
    renderProfileActivity();
    refreshIcons();
}

function renderProfileActivity() {
    const listEl = $("prof-activity-list");
    if (!listEl) return;
    const logs = state.profileActivity || [];
    if (!logs.length) {
        listEl.innerHTML = `
            <div class="erp-detail-card !p-6 text-center text-xs text-[#536471]">
                No recent harvest activity.
            </div>`;
        return;
    }

    listEl.innerHTML = logs
        .map(
            (l, idx) => `
        <div data-prof-act-idx="${idx}" class="erp-detail-card cursor-pointer space-y-2.5">
            <div class="flex items-start justify-between gap-2">
                <div class="flex items-center gap-2.5 min-w-0">
                    <div class="w-9 h-9 rounded-full bg-[#0f1419] text-white font-mono-code font-extrabold text-xs flex items-center justify-center shrink-0">
                        #${l.tree_no || "-"}
                    </div>
                    <div class="min-w-0">
                        <div class="font-extrabold text-xs sm:text-sm text-[#0f1419] truncate">
                            Palm #${l.tree_no || "-"} &bull; ${esc(l.block_name || "Block")}
                        </div>
                        <div class="text-[11px] text-[#536471] truncate">
                            ${esc(l.division_name || "Uskvalley Division")} &rarr; ${esc(l.field_name || "Field")}
                        </div>
                    </div>
                </div>
                <span class="px-2.5 py-0.5 rounded-full bg-[#0f1419] text-white font-mono-code font-bold text-[10px] shrink-0">
                    Round ${l.round_no}
                </span>
            </div>

            <div class="grid grid-cols-3 gap-2 pt-2 border-t border-[#eff3f4] text-center">
                <div class="p-2 rounded-xl bg-[#f7f9f9]">
                    <div class="text-[10px] font-bold uppercase text-[#536471]">Bunches</div>
                    <div class="text-xs font-mono-code font-extrabold text-[#0f1419] mt-0.5">${l.bunches}</div>
                </div>
                <div class="p-2 rounded-xl bg-[#f7f9f9]">
                    <div class="text-[10px] font-bold uppercase text-[#536471]">Fronds</div>
                    <div class="text-xs font-mono-code font-extrabold text-[#0f1419] mt-0.5">${l.fronds}</div>
                </div>
                <div class="p-2 rounded-xl bg-[#f7f9f9]">
                    <div class="text-[10px] font-bold uppercase text-[#536471]">Date</div>
                    <div class="text-[11px] font-mono-code font-bold text-[#0f1419] mt-0.5 truncate">${esc(l.harvest_date)}</div>
                </div>
            </div>
        </div>`
        )
        .join("");

    listEl.querySelectorAll("[data-prof-act-idx]").forEach((card) => {
        card.onclick = () => {
            const item = logs[Number(card.getAttribute("data-prof-act-idx"))];
            if (!item) return;
            openItemDetailModal({
                badge: `Harvest Log #${item.id} • Round ${item.round_no}`,
                title: `Palm #${item.tree_no} — ${item.block_name}`,
                fields: [
                    { label: "Division", value: item.division_name || "Uskvalley Division" },
                    { label: "Field & Block", value: `${item.field_name} • ${item.block_name}` },
                    { label: "Bunches Cut", value: `${item.bunches} Fresh Fruit Bunches`, mono: true },
                    { label: "Fronds Cut", value: `${item.fronds} Pruned Fronds`, mono: true },
                    { label: "Harvest Date", value: item.harvest_date, mono: true },
                    { label: "Logged By", value: item.recorded_by || state.user?.full_name || "Staff" },
                ],
            });
        };
    });
}

function readImageFileAsDataUrl(file, maxW = 900, maxH = 900) {
    return new Promise((resolve, reject) => {
        if (!file) return reject(new Error("No file selected."));
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Could not read image file."));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error("Invalid image format."));
            img.onload = () => {
                let w = img.width;
                let h = img.height;
                if (w > maxW || h > maxH) {
                    const ratio = Math.min(maxW / w, maxH / h);
                    w = Math.round(w * ratio);
                    h = Math.round(h * ratio);
                }
                const canvas = document.createElement("canvas");
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext("2d");
                ctx.drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL("image/jpeg", 0.85));
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

function syncEditProfileModalPreviews() {
    const u = state.user || {};
    const initials = (u.full_name || "U")
        .split(" ")
        .filter(Boolean)
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();

    const draftAvatar = state.editProfileDraft.profile_pic;
    const draftCover = state.editProfileDraft.cover_photo;

    if ($("ep-avatar-initials")) {
        $("ep-avatar-initials").textContent = initials;
        $("ep-avatar-initials").classList.toggle("hidden", Boolean(draftAvatar));
    }
    if ($("ep-avatar-preview")) {
        if (draftAvatar) $("ep-avatar-preview").src = draftAvatar;
        $("ep-avatar-preview").classList.toggle("hidden", !draftAvatar);
    }
    if ($("btn-ep-remove-avatar")) {
        $("btn-ep-remove-avatar").classList.toggle("hidden", !draftAvatar);
    }

    if ($("ep-cover-preview")) {
        if (draftCover) $("ep-cover-preview").src = draftCover;
        $("ep-cover-preview").classList.toggle("hidden", !draftCover);
    }
    if ($("btn-ep-remove-cover")) {
        $("btn-ep-remove-cover").classList.toggle("hidden", !draftCover);
    }
}

function openEditProfileModal() {
    if (!state.user) return;
    state.editProfileDraft = {
        profile_pic: state.user.profile_pic || "",
        cover_photo: state.user.cover_photo || "",
    };
    if ($("ep-fullname")) $("ep-fullname").value = state.user.full_name || "";
    if ($("ep-username")) $("ep-username").value = state.user.username || "";
    syncEditProfileModalPreviews();
    $("modal-edit-profile")?.classList.remove("hidden");
    refreshIcons();
}

async function saveEditProfile() {
    const full_name = ($("ep-fullname")?.value || "").trim();
    const username = ($("ep-username")?.value || "").trim().toLowerCase().replace(/^@+/, "");
    if (!full_name || !username) {
        return toast("Name and Username are required.", "err");
    }
    try {
        const res = await api("/api/profile/update", "POST", {
            full_name,
            username,
            profile_pic: state.editProfileDraft.profile_pic,
            cover_photo: state.editProfileDraft.cover_photo,
        });
        if (res.user) {
            state.user = { ...state.user, ...res.user };
        }
        $("modal-edit-profile")?.classList.add("hidden");
        syncUserIdentityUI();
        updateClockAndGreeting();
        await loadProfilePage();
        toast(res.message || "Profile updated");
    } catch (err) {
        toast(err.message, "err");
    }
}

function applyRbacNavigation() {
    const userRank = ROLE_RANK[state.user?.role] || 1;
    document.querySelectorAll("[data-nav]").forEach((btn) => {
        const minRole = btn.getAttribute("data-min-role") || "Harvester";
        const allowed = userRank >= (ROLE_RANK[minRole] || 1);
        btn.classList.toggle("hidden", !allowed);
    });
    const currentMin = {
        overview: "Harvester",
        harvests: "Harvester",
        map: "Harvester",
        estates: "Admin",
        directory: "Admin",
        profile: "Harvester",
        settings: "Harvester",
        info: "Harvester",
    }[state.activePage];
    if (userRank < (ROLE_RANK[currentMin] || 1)) {
        state.activePage = "overview";
    }
}

async function loadBootstrap() {
    const data = await api("/api/bootstrap");
    state.hierarchy = data.hierarchy;
    state.settings = data.settings || { season_start_month: 4 };
    if (Array.isArray(data.mapped_trees)) {
        state.mappedTrees = data.mapped_trees;
    } else {
        api("/api/trees/mapped")
            .then((r) => {
                if (Array.isArray(r?.trees)) state.mappedTrees = r.trees;
            })
            .catch(() => {});
    }

    initDashboardFilters();
    initGisMapFilters();
    initDivisionCascade("harv", () => loadHarvestBlock());
    initDivisionCascade("map", () => loadMapperBlock());
    initDispatchForm();
}

function closeMobileDrawer() {
    if ($("mobile-drawer")) {
        $("mobile-drawer").classList.add("hidden");
    }
}

function switchPage(page, pushUrl = true) {
    const target = PAGE_TITLES[page] ? page : "overview";
    state.activePage = target;

    if (pushUrl && window.history && typeof window.history.pushState === "function") {
        const nextPath = target === "overview" ? "/" : `/${target}`;
        if (window.location.pathname !== nextPath) {
            window.history.pushState({ page: target }, "", nextPath);
        }
    }

    if ($("hdr-page-title")) {
        $("hdr-page-title").textContent = PAGE_TITLES[target] || "Overview";
    }
    if ($("set-diag-route")) {
        $("set-diag-route").textContent = target === "overview" ? "/" : `/${target}`;
    }

    document.querySelectorAll(".page-view").forEach((sec) => {
        sec.classList.toggle("hidden", sec.id !== `page-${target}`);
    });

    document.querySelectorAll("[data-nav]").forEach((btn) => {
        const active = btn.getAttribute("data-nav") === target;
        if (btn.closest("#desktop-nav") || btn.closest("#drawer-nav")) {
            btn.classList.toggle("active", active);
        } else if (btn.closest("#mobile-nav")) {
            btn.className = `nav-btn flex flex-col items-center justify-center gap-0.5 text-[10px] font-bold min-w-0 transition ${
                active ? "text-[#0f1419] font-extrabold" : "text-[#536471]"
            }`;
        }
    });

    closeMobileDrawer();

    if (target === "overview") refreshDashboard();
    if (target === "harvests") {
        if (state.harvestView === "trees") loadHarvestBlock();
        else loadDispatches();
    }
    if (target === "map") loadGisMapPage();
    if (target === "estates") loadEstatesPage();
    if (target === "directory") loadDirectoryPage();
    if (target === "profile") loadProfilePage();
    if (target === "settings") applyTheme(state.theme, false);
    refreshIcons();
}

// ----------------------------------------------------------------------------
// Hierarchy Cascade Helpers (Division -> Field -> Block)
// ----------------------------------------------------------------------------
function initDivisionCascade(prefix, onChange) {
    const divEl = $(`${prefix}-division`);
    const fldEl = $(`${prefix}-field`);
    const blkEl = $(`${prefix}-block`);
    if (!divEl || !fldEl || !blkEl) return;

    const { divisions, fields, blocks } = state.hierarchy;
    divEl.innerHTML = divisions.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("");

    const syncFields = () => {
        const did = Number(divEl.value);
        const fList = fields.filter((f) => f.division_id === did);
        fldEl.innerHTML = fList
            .map((f) => `<option value="${f.id}">${esc(f.name)} (${f.planting_year} - ${Number(f.area_ha).toFixed(2)} Ha)</option>`)
            .join("");
        syncBlocks();
    };
    const syncBlocks = () => {
        const fid = Number(fldEl.value);
        const bList = blocks.filter((b) => b.field_id === fid);
        blkEl.innerHTML = bList
            .map((b) => `<option value="${b.id}">${esc(b.name)} (${b.tree_total} palms)</option>`)
            .join("");
        onChange();
    };

    divEl.onchange = syncFields;
    fldEl.onchange = syncBlocks;
    blkEl.onchange = onChange;

    syncFields();
}

// ----------------------------------------------------------------------------
// VIEW 1: OVERVIEW (Unified Filters + 5 Core KPIs + Structured Activity Feed)
// ----------------------------------------------------------------------------
function initDashboardFilters() {
    const estFixed = $("flt-estate-fixed");
    const divEl = $("flt-division");
    const fldEl = $("flt-field");
    const blkEl = $("flt-block");
    const treeEl = $("flt-tree");
    const { estates, divisions, fields, blocks } = state.hierarchy;

    const userEstate = estates[0] || { id: 1, name: "Uskvalley Estate" };
    if (estFixed) estFixed.textContent = userEstate.name;

    const popDivs = () => {
        const list = divisions.filter((d) => d.estate_id === userEstate.id);
        divEl.innerHTML = `<option value="">All Divisions</option>` + list.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("");
        popFields();
    };
    const popFields = () => {
        const did = Number(divEl.value);
        const list = did ? fields.filter((f) => f.division_id === did) : fields;
        fldEl.innerHTML =
            `<option value="">All Fields</option>` +
            list.map((f) => `<option value="${f.id}">${esc(f.name)} (${f.planting_year} - ${Number(f.area_ha).toFixed(2)} Ha)</option>`).join("");
        popBlocks();
    };
    const popBlocks = () => {
        const did = Number(divEl.value);
        const fid = Number(fldEl.value);
        let list = blocks;
        if (fid) {
            list = blocks.filter((b) => b.field_id === fid);
        } else if (did) {
            const divFieldIds = new Set(fields.filter((f) => f.division_id === did).map((f) => f.id));
            list = blocks.filter((b) => divFieldIds.has(b.field_id));
        }
        blkEl.innerHTML = `<option value="">All Blocks</option>` + list.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join("");
        popTrees();
    };
    const popTrees = async () => {
        const bid = Number(blkEl.value);
        if (!bid) {
            treeEl.innerHTML = `<option value="">All Palms</option>`;
            refreshDashboard();
            return;
        }
        const bData = await api(`/api/block?block_id=${bid}&mode=map`);
        state.dashTrees = bData.trees || [];
        treeEl.innerHTML =
            `<option value="">All Palms (${state.dashTrees.length})</option>` +
            state.dashTrees.map((t) => `<option value="${t.id}">Palm #${t.tree_no}</option>`).join("");
        refreshDashboard();
    };

    divEl.onchange = popFields;
    fldEl.onchange = popBlocks;
    blkEl.onchange = popTrees;
    treeEl.onchange = refreshDashboard;

    const today = todayStr();
    $("flt-season-year").value = "2026";
    $("flt-time-mode").value = "std";
    $("flt-month").value = today.slice(0, 7);
    $("flt-from").value = `${today.slice(0, 4)}-04-01`;
    $("flt-to").value = today;
    $("flt-round").value = "";

    const syncTimeSlots = () => {
        const mode = $("flt-time-mode").value;
        $("flt-time-slot-std").classList.toggle("hidden", mode !== "std");
        $("flt-time-slot-month").classList.toggle("hidden", mode !== "month");
        $("flt-time-custom").classList.toggle("hidden", mode !== "custom");
        refreshDashboard();
    };

    $("flt-time-mode").onchange = syncTimeSlots;
    $("flt-season-year").onchange = refreshDashboard;
    $("flt-month").onchange = refreshDashboard;
    $("flt-round").onchange = refreshDashboard;
    $("flt-from").onchange = refreshDashboard;
    $("flt-to").onchange = refreshDashboard;

    syncTimeSlots();
    popDivs();
}

function getDashboardQuery() {
    const mode = $("flt-time-mode").value;
    const yr = Number($("flt-season-year").value) || 2026;
    const seasonLabel = `${yr}/${String(yr + 1).slice(2)}`;
    const sMonth = String(state.settings.season_start_month || 4).padStart(2, "0");
    const roundVal = $("flt-round").value;

    let from = `${yr}-${sMonth}-01`;
    let to = todayStr();
    let periodBadgeText = `YTD: ${formatShortDateLabel(from)} - ${formatShortDateLabel(to)}`;

    if (mode === "std") {
        from = `${yr}-${sMonth}-01`;
        to = todayStr();
        periodBadgeText = `YTD: ${formatShortDateLabel(from)} - ${formatShortDateLabel(to)}`;
        const stdLbl = $("flt-std-label");
        if (stdLbl) stdLbl.textContent = `${formatShortDateLabel(from)} to ${formatShortDateLabel(to)}`;
    } else if (mode === "month") {
        const ym = $("flt-month").value || todayStr().slice(0, 7);
        from = `${ym}-01`;
        to = `${ym}-31`;
        periodBadgeText = `Month: ${formatMonthYearLabel(ym)}`;
    } else if (mode === "custom") {
        from = $("flt-from").value || `${yr}-${sMonth}-01`;
        to = $("flt-to").value || todayStr();
        periodBadgeText = `Range: ${formatShortDateLabel(from)} - ${formatShortDateLabel(to)}`;
    }

    const yearMonth = mode === "month" ? ($("flt-month").value || todayStr().slice(0, 7)) : (to || todayStr()).slice(0, 7);
    const q = new URLSearchParams({ from, to, year_month: yearMonth });
    const estateId = state.hierarchy.estates[0]?.id || 1;
    q.set("estate_id", String(estateId));

    if (roundVal) {
        q.set("round_no", roundVal);
    }

    const estateName = state.hierarchy.estates[0]?.name || "Uskvalley Estate";
    const roundBadgeText = roundVal ? `Filter: Round ${roundVal}` : "Filter: Entire Month";
    const scopeParts = [];

    const addPart = (id, param) => {
        const el = $(id);
        if (el && el.value) {
            q.set(param, el.value);
            const rawTxt = el.options[el.selectedIndex]?.text || "";
            if (rawTxt) scopeParts.push(rawTxt);
        }
    };
    addPart("flt-division", "division_id");
    addPart("flt-field", "field_id");
    addPart("flt-block", "block_id");
    addPart("flt-tree", "tree_id");

    // Update Clean Executive Overview Header & Flexbox Badges
    if ($("dash-estate-heading")) $("dash-estate-heading").textContent = estateName;
    if ($("badge-season")) $("badge-season").textContent = `Season ${seasonLabel}`;
    if ($("badge-period")) $("badge-period").textContent = periodBadgeText;
    if ($("badge-filter-round")) $("badge-filter-round").textContent = roundBadgeText;
    if ($("badge-scope") && $("badge-scope-sep")) {
        const hasScope = scopeParts.length > 0;
        $("badge-scope").textContent = scopeParts.join(" • ");
        $("badge-scope").classList.toggle("hidden", !hasScope);
        $("badge-scope-sep").classList.toggle("hidden", !hasScope);
    }

    return q.toString();
}

async function refreshDashboard() {
    const qs = getDashboardQuery();
    const rep = await api(`/api/report?${qs}`);
    const tot = rep.totals || {};
    state.recentLogs = rep.recent_logs || [];

    const bunchesTxt = Number(tot.bunches || 0).toLocaleString();
    const frondsTxt = Number(tot.fronds || 0).toLocaleString();
    const dispTxt = `${Number(tot.dispatch_kg || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} kg`;
    const abwTxt = `${Number(tot.abw || 0).toFixed(2)} kg`;
    const yphTxt = `${Number(tot.yph || 0).toFixed(2)} kg/Ha`;
    const haTxt = `${Number(tot.area_ha || 0).toFixed(2)} Ha`;

    $("kpi-bunches").textContent = bunchesTxt;
    $("kpi-harvest-trees").textContent = `${tot.trees || 0} palms harvested`;
    $("kpi-fronds").textContent = frondsTxt;
    $("kpi-harvest-recs").textContent = `${tot.records || 0} harvest logs`;
    $("kpi-dispatch-kg").textContent = dispTxt;
    $("kpi-dispatch-recs").textContent = `${tot.dispatch_records || 0} mill dispatches`;
    $("kpi-abw").textContent = abwTxt;
    $("kpi-yph").textContent = yphTxt;
    $("kpi-area-ha").textContent = `Extent: ${haTxt}`;

    if ($("right-kpi-bunches")) $("right-kpi-bunches").textContent = bunchesTxt;
    if ($("right-kpi-fronds")) $("right-kpi-fronds").textContent = frondsTxt;
    if ($("right-kpi-dispatch")) $("right-kpi-dispatch").textContent = dispTxt;
    if ($("right-kpi-abw")) $("right-kpi-abw").textContent = abwTxt;
    if ($("right-kpi-yph")) $("right-kpi-yph").textContent = yphTxt;
    if ($("right-extent-ha")) $("right-extent-ha").textContent = haTxt;

    // Render Structured Recent Harvest Cards
    const feedEl = $("overview-feed-list");
    if (feedEl) {
        const logs = state.recentLogs;
        if (!logs.length) {
            feedEl.innerHTML = `<div class="erp-detail-card md:col-span-2 !p-6 text-center text-xs text-[#536471]">No harvest logs recorded in this filter window.</div>`;
        } else {
            feedEl.innerHTML = logs
                .map(
                    (l, idx) => `
                <div data-feed-idx="${idx}" class="erp-detail-card cursor-pointer space-y-3">
                    <div class="flex items-start justify-between gap-2">
                        <div class="flex items-center gap-2.5 min-w-0">
                            <div class="w-9 h-9 rounded-full bg-[#0f1419] text-white font-mono-code font-extrabold text-xs flex items-center justify-center shrink-0">
                                #${l.tree_no || "-"}
                            </div>
                            <div class="min-w-0">
                                <div class="font-extrabold text-xs sm:text-sm text-[#0f1419] truncate">
                                    Palm #${l.tree_no || "-"} &bull; ${esc(l.block_name || "Block")}
                                </div>
                                <div class="text-[11px] text-[#536471] truncate">
                                    ${esc(l.division_name || "Uskvalley")} &rarr; ${esc(l.field_name || "Field")}
                                </div>
                            </div>
                        </div>
                        <span class="px-2.5 py-0.5 rounded-full bg-[#0f1419] text-white font-mono-code font-bold text-[10px] shrink-0">
                            Round ${l.round_no}
                        </span>
                    </div>

                    <div class="grid grid-cols-3 gap-2 pt-2 border-t border-[#eff3f4] text-center">
                        <div class="p-2 rounded-xl bg-[#f7f9f9]">
                            <div class="text-[10px] font-bold uppercase text-[#536471]">Bunches</div>
                            <div class="text-xs font-mono-code font-extrabold text-[#0f1419] mt-0.5">${l.bunches}</div>
                        </div>
                        <div class="p-2 rounded-xl bg-[#f7f9f9]">
                            <div class="text-[10px] font-bold uppercase text-[#536471]">Fronds</div>
                            <div class="text-xs font-mono-code font-extrabold text-[#0f1419] mt-0.5">${l.fronds}</div>
                        </div>
                        <div class="p-2 rounded-xl bg-[#f7f9f9]">
                            <div class="text-[10px] font-bold uppercase text-[#536471]">Date</div>
                            <div class="text-[11px] font-mono-code font-bold text-[#0f1419] mt-0.5 truncate">${esc(l.harvest_date)}</div>
                        </div>
                    </div>

                    <div class="flex items-center justify-between text-[11px] text-[#536471]">
                        <span>Harvester: <strong class="text-[#0f1419]">${esc(l.recorded_by || "Staff")}</strong></span>
                        <span class="font-bold underline">Inspect &rarr;</span>
                    </div>
                </div>`
                )
                .join("");

            feedEl.querySelectorAll("[data-feed-idx]").forEach((card) => {
                card.onclick = () => {
                    const item = state.recentLogs[Number(card.getAttribute("data-feed-idx"))];
                    if (!item) return;
                    openItemDetailModal({
                        badge: `Harvest Log #${item.id} • Round ${item.round_no}`,
                        title: `Palm #${item.tree_no} — ${item.block_name}`,
                        fields: [
                            { label: "Division", value: item.division_name || "Uskvalley Division" },
                            { label: "Field & Block", value: `${item.field_name} • ${item.block_name}` },
                            { label: "Bunches Cut", value: `${item.bunches} Fresh Fruit Bunches`, mono: true },
                            { label: "Fronds Cut", value: `${item.fronds} Pruned Fronds`, mono: true },
                            { label: "Harvest Date", value: item.harvest_date, mono: true },
                            { label: "Recorded By", value: item.recorded_by || "Field Harvester" },
                        ],
                    });
                };
            });
        }
    }
    refreshIcons();
}

// ----------------------------------------------------------------------------
// VIEW 2: HARVESTS (Palm Harvest Logger + GPS Assist + Mill Dispatch Weight)
// ----------------------------------------------------------------------------
function syncMappedTreeInCache(treeObj) {
    if (!treeObj || !treeObj.id) return;
    const idx = state.mappedTrees.findIndex((t) => t.id === treeObj.id);
    if (treeObj.lat !== null && treeObj.lat !== undefined && treeObj.lng !== null && treeObj.lng !== undefined) {
        const entry = {
            id: treeObj.id,
            block_id: treeObj.block_id || state.harvBlock.block_id || state.mapBlock.block_id,
            tree_no: treeObj.tree_no,
            lat: Number(treeObj.lat),
            lng: Number(treeObj.lng),
            gps_acc: treeObj.gps_acc || 4.0,
        };
        if (idx >= 0) state.mappedTrees[idx] = entry;
        else state.mappedTrees.push(entry);
    } else if (idx >= 0) {
        state.mappedTrees.splice(idx, 1);
    }
}

function populateHarvestTreeDropdowns(selectedTreeId = null) {
    const trees = state.harvBlock.trees || [];
    const curId = selectedTreeId || state.harvBlock.selectedTreeId || trees[0]?.id || "";
    state.harvBlock.selectedTreeId = curId ? Number(curId) : null;

    const harvSel = $("harv-tree-select");
    if (harvSel) {
        harvSel.innerHTML =
            `<option value="">Select Palm (${trees.length})...</option>` +
            trees
                .map((t) => {
                    const statusTxt = t.rec ? ` • ${t.rec.bunches}B/${t.rec.fronds}F` : "";
                    return `<option value="${t.id}" ${Number(curId) === t.id ? "selected" : ""}>Palm #${t.tree_no}${statusTxt}</option>`;
                })
                .join("");
    }

    const mhBlockSel = $("mh-block");
    if (mhBlockSel && state.hierarchy.blocks?.length) {
        const { fields, blocks } = state.hierarchy;
        mhBlockSel.innerHTML = blocks
            .map((b) => {
                const fld = fields.find((f) => f.id === b.field_id);
                const label = fld ? `${fld.name} • ${b.name}` : b.name;
                return `<option value="${b.id}" ${b.id === state.harvBlock.block_id ? "selected" : ""}>${esc(label)}</option>`;
            })
            .join("");
    }

    const mhTreeSel = $("mh-tree-select");
    if (mhTreeSel) {
        mhTreeSel.innerHTML = trees
            .map((t) => {
                const statusTxt = t.rec ? ` (${t.rec.bunches}B/${t.rec.fronds}F)` : "";
                return `<option value="${t.id}" ${Number(curId) === t.id ? "selected" : ""}>Palm #${t.tree_no}${statusTxt}</option>`;
            })
            .join("");
    }
}

async function selectHarvestBlockCascade(blockId) {
    const bid = Number(blockId);
    if (!bid) return;
    const { fields, blocks } = state.hierarchy;
    const blk = blocks.find((b) => b.id === bid);
    if (!blk) return;
    const fld = fields.find((f) => f.id === blk.field_id);
    const divEl = $("harv-division");
    const fldEl = $("harv-field");
    const blkEl = $("harv-block");
    if (divEl && fld && Number(divEl.value) !== fld.division_id) {
        divEl.value = String(fld.division_id);
        const fList = fields.filter((f) => f.division_id === fld.division_id);
        if (fldEl) {
            fldEl.innerHTML = fList
                .map((f) => `<option value="${f.id}">${esc(f.name)} (${f.planting_year} - ${Number(f.area_ha).toFixed(2)} Ha)</option>`)
                .join("");
        }
    }
    if (fldEl && fld && Number(fldEl.value) !== fld.id) {
        fldEl.value = String(fld.id);
    }
    if (blkEl && fld) {
        const bList = blocks.filter((b) => b.field_id === fld.id);
        blkEl.innerHTML = bList
            .map((b) => `<option value="${b.id}">${esc(b.name)} (${b.tree_total} palms)</option>`)
            .join("");
        blkEl.value = String(bid);
    }
    await loadHarvestBlock(bid);
}

async function loadHarvestBlock(explicitBlockId = null) {
    const bid = Number(explicitBlockId || $("harv-block")?.value);
    if (!bid) return;
    const date = $("harv-date").value || todayStr();
    const roundNo = Number($("harv-round").value) || roundOfDate(date).round;
    const { rangeLabel } = roundOfDate(date, roundNo);
    $("harv-auto-meta").textContent = `Round ${roundNo} (${rangeLabel}) • ${date}`;

    const data = await api(`/api/block?block_id=${bid}&mode=harvest&date=${date}&round_no=${roundNo}`);
    state.harvBlock.block_id = bid;
    state.harvBlock.trees = data.trees || [];
    state.harvBlock.trees.forEach((t) => syncMappedTreeInCache({ ...t, block_id: bid }));
    populateHarvestTreeDropdowns(state.harvBlock.selectedTreeId);
    renderHarvestGrid();
}

function renderHarvestGrid() {
    const trees = state.harvBlock.trees;
    const doneCount = trees.filter((t) => t.rec).length;
    $("harv-progress-pill").textContent = `${doneCount} / ${trees.length} Cut`;

    const flt = state.harvBlock.filter;
    const q = state.harvBlock.search.trim();
    const filtered = trees.filter((t) => {
        if (q && String(t.tree_no) !== q) return false;
        if (flt === "done" && !t.rec) return false;
        if (flt === "pending" && t.rec) return false;
        return true;
    });

    const grid = $("harv-grid");
    grid.innerHTML = filtered
        .map((t) => {
            const done = Boolean(t.rec);
            const isSelected = state.harvBlock.selectedTreeId === t.id;
            const gpsBadge =
                t.lat !== null
                    ? `<span class="w-1.5 h-1.5 rounded-full ${done ? "bg-[#00ba7c]" : "bg-[#0f1419]"}" title="GPS Mapped"></span>`
                    : "";
            return `
            <div data-harv-tree="${t.id}" class="palm-card ${done ? "done-harvest" : ""} ${isSelected ? "selected-palm" : ""}">
                <div class="w-full flex items-center justify-between text-[10px] font-mono-code ${done ? "opacity-80" : "text-[#536471]"}">
                    <span>#${t.tree_no}</span>
                    ${gpsBadge}
                </div>
                <div class="my-1">
                    <i data-lucide="${done ? "check-circle-2" : "palmtree"}" class="w-5 h-5"></i>
                </div>
                <div class="text-[11px] font-mono-code font-extrabold">
                    ${done ? `${t.rec.bunches}B / ${t.rec.fronds}F` : "Tap"}
                </div>
            </div>`;
        })
        .join("");

    grid.querySelectorAll("[data-harv-tree]").forEach((card) => {
        card.onclick = () => {
            state.harvBlock.manualOverride = true;
            openHarvestModal(Number(card.getAttribute("data-harv-tree")));
        };
    });
    refreshIcons();
}

function populateHarvestModalFields(tree) {
    if (!tree) return;
    state.modalTree = tree;
    state.harvBlock.selectedTreeId = tree.id;

    const date = $("harv-date").value || todayStr();
    const roundNo = Number($("harv-round").value) || roundOfDate(date).round;
    const { rangeLabel } = roundOfDate(date, roundNo);
    const blk = state.hierarchy.blocks.find((b) => b.id === (tree.block_id || state.harvBlock.block_id));

    $("mh-tree-badge").textContent = `#${tree.tree_no}`;
    $("mh-title").textContent = `Palm #${tree.tree_no}${blk ? ` • ${blk.name}` : ""}`;
    $("mh-sub").textContent = `Round ${roundNo} (${rangeLabel}) • ${date}`;
    $("mh-bunches").value = tree.rec ? tree.rec.bunches : 0;
    $("mh-fronds").value = tree.rec ? tree.rec.fronds : 0;

    if ($("mh-block")) $("mh-block").value = String(tree.block_id || state.harvBlock.block_id || "");
    if ($("mh-tree-select")) $("mh-tree-select").value = String(tree.id);
    if ($("mh-tree-no")) $("mh-tree-no").value = String(tree.tree_no);
    if ($("harv-tree-select")) $("harv-tree-select").value = String(tree.id);

    const canCalibrate = (ROLE_RANK[state.user?.role] || 1) >= ROLE_RANK.Supervisor;
    const calSec = $("mh-calibration-section");
    if (calSec) {
        calSec.classList.toggle("hidden", !canCalibrate);
        if ($("mh-cal-lat")) $("mh-cal-lat").value = tree.lat !== null && tree.lat !== undefined ? tree.lat : "";
        if ($("mh-cal-lng")) $("mh-cal-lng").value = tree.lng !== null && tree.lng !== undefined ? tree.lng : "";
    }

    updateGpsAccuracyPills();
    renderHarvestGrid();
}

function openHarvestModal(treeId = null, { fromAutoDetect = false } = {}) {
    const trees = state.harvBlock.trees || [];
    const tree = (treeId ? trees.find((t) => t.id === Number(treeId)) : null) || trees.find((t) => t.id === state.harvBlock.selectedTreeId) || trees[0];
    if (!tree) return;
    if (!fromAutoDetect) {
        state.harvBlock.manualOverride = true;
    }
    populateHarvestTreeDropdowns(tree.id);
    populateHarvestModalFields(tree);
    $("modal-harvest").classList.remove("hidden");
    refreshIcons();

    if (!fromAutoDetect && state.autoDetectGps && !treeId) {
        autoDetectNearestTree({ openModal: true });
    }
}

async function autoDetectNearestTree({ openModal = true } = {}) {
    const btn1 = $("btn-harv-autodetect");
    const btn2 = $("btn-mh-autodetect");
    if (btn1) btn1.disabled = true;
    if (btn2) btn2.disabled = true;
    updateGpsAccuracyPills("GPS...");

    try {
        const gpsRes = await requestBrowserGps(5500);
        if (!gpsRes.ok || gpsRes.lat === null || gpsRes.lng === null) {
            updateGpsAccuracyPills();
            toast("GPS weak — select tree manually");
            return null;
        }

        // Combine all geo-tagged trees in the database and current block
        const candidateMap = new Map();
        for (const t of state.mappedTrees || []) {
            if (t.lat !== null && t.lat !== undefined && t.lng !== null && t.lng !== undefined) {
                candidateMap.set(t.id, t);
            }
        }
        for (const t of state.harvBlock.trees || []) {
            if (t.lat !== null && t.lat !== undefined && t.lng !== null && t.lng !== undefined) {
                candidateMap.set(t.id, { ...t, block_id: t.block_id || state.harvBlock.block_id });
            }
        }

        let nearest = null;
        let minDist = Infinity;
        const curBlockId = state.harvBlock.block_id;

        for (const t of candidateMap.values()) {
            const dist = distanceMeters(gpsRes.lat, gpsRes.lng, t.lat, t.lng);
            if (dist < minDist || (dist === minDist && curBlockId && t.block_id === curBlockId)) {
                minDist = dist;
                nearest = t;
            }
        }

        // Reasonable radius: 100 meters
        if (!nearest || !Number.isFinite(minDist) || minDist > 100) {
            toast("GPS weak — select tree manually");
            return null;
        }

        state.harvBlock.manualOverride = false;
        if (nearest.block_id && nearest.block_id !== state.harvBlock.block_id) {
            await selectHarvestBlockCascade(nearest.block_id);
        }

        const matchedTree =
            state.harvBlock.trees.find((t) => t.id === nearest.id || t.tree_no === nearest.tree_no) || nearest;
        state.harvBlock.selectedTreeId = matchedTree.id;
        state.harvBlock.search = "";
        if ($("harv-search")) $("harv-search").value = String(matchedTree.tree_no);

        populateHarvestTreeDropdowns(matchedTree.id);
        populateHarvestModalFields(matchedTree);

        if (openModal) {
            $("modal-harvest").classList.remove("hidden");
            refreshIcons();
        }

        const cardEl = document.querySelector(`[data-harv-tree="${matchedTree.id}"]`);
        if (cardEl && typeof cardEl.scrollIntoView === "function") {
            cardEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }

        toast(`Palm #${matchedTree.tree_no} auto-detected (${Math.round(minDist)}m • GPS ±${Math.round(gpsRes.acc)}m)`);
        return matchedTree;
    } finally {
        if (btn1) btn1.disabled = false;
        if (btn2) btn2.disabled = false;
    }
}

async function syncCalibrationInputsToMyLocation(latInputId, lngInputId) {
    const latEl = $(latInputId);
    const lngEl = $(lngInputId);
    if (!latEl || !lngEl) return;

    updateGpsAccuracyPills("GPS...");
    const gpsRes = await requestBrowserGps(5500);
    if (gpsRes.ok && gpsRes.lat !== null && gpsRes.lng !== null) {
        latEl.value = gpsRes.lat;
        lngEl.value = gpsRes.lng;
        toast(`Synced to your location (${gpsRes.lat.toFixed(5)}, ${gpsRes.lng.toFixed(5)} • ±${Math.round(gpsRes.acc)}m)`);
    } else {
        if (state.gps.lat && state.gps.lng) {
            latEl.value = Number(state.gps.lat).toFixed(6);
            lngEl.value = Number(state.gps.lng).toFixed(6);
        }
        toast("GPS weak — adjust coordinates manually");
    }
}

async function saveHarvestModalPinCalibration(silent = false) {
    const tree = state.modalTree;
    if (!tree) return false;
    const canCalibrate = (ROLE_RANK[state.user?.role] || 1) >= ROLE_RANK.Supervisor;
    if (!canCalibrate) return false;

    const rawLat = $("mh-cal-lat")?.value;
    const rawLng = $("mh-cal-lng")?.value;
    if (rawLat === "" || rawLng === "" || rawLat === undefined || rawLng === undefined) return false;

    const nextLat = Number(rawLat);
    const nextLng = Number(rawLng);
    if (!Number.isFinite(nextLat) || !Number.isFinite(nextLng) || Math.abs(nextLat) > 90 || Math.abs(nextLng) > 180) {
        if (!silent) toast("Enter valid Latitude and Longitude coordinates.", "err");
        return false;
    }

    const changed = Number(tree.lat) !== Number(nextLat.toFixed(6)) || Number(tree.lng) !== Number(nextLng.toFixed(6));
    if (!changed && silent) return false;

    await api("/api/tree/calibrate", "POST", {
        id: tree.id,
        tree_id: tree.id,
        lat: Number(nextLat.toFixed(6)),
        lng: Number(nextLng.toFixed(6)),
        acc: state.gps.acc || 4.0,
    });
    tree.lat = Number(nextLat.toFixed(6));
    tree.lng = Number(nextLng.toFixed(6));
    syncMappedTreeInCache({ ...tree, block_id: tree.block_id || state.harvBlock.block_id });
    if (!silent) {
        toast(`Palm #${tree.tree_no} GPS pin calibrated`);
        renderHarvestGrid();
    }
    return true;
}

async function submitHarvestModal() {
    const tree = state.modalTree;
    if (!tree) return;
    const btn = $("btn-submit-harvest");
    btn.disabled = true;
    try {
        // Persist supervisor/admin pin calibration if modified
        await saveHarvestModalPinCalibration(true).catch(() => {});

        // Manual GPS Fallback on Save:
        // If user manually picked a tree and device GPS is weak or unavailable,
        // default the log's latitude & longitude to the tree's saved coordinates.
        let logLat = null;
        let logLng = null;
        let logAcc = null;

        const hasTreeCoords = tree.lat !== null && tree.lat !== undefined && tree.lng !== null && tree.lng !== undefined;
        const gpsIsFreshAndStrong =
            state.gps.live &&
            state.gps.lat !== null &&
            state.gps.lng !== null &&
            (state.gps.acc === null || state.gps.acc <= 50);

        if (state.harvBlock.manualOverride) {
            if (
                gpsIsFreshAndStrong &&
                (!hasTreeCoords || distanceMeters(state.gps.lat, state.gps.lng, tree.lat, tree.lng) <= 100)
            ) {
                logLat = state.gps.lat;
                logLng = state.gps.lng;
                logAcc = state.gps.acc;
            } else if (hasTreeCoords) {
                logLat = Number(tree.lat);
                logLng = Number(tree.lng);
                logAcc = tree.gps_acc || null;
            }
        } else if (gpsIsFreshAndStrong) {
            logLat = state.gps.lat;
            logLng = state.gps.lng;
            logAcc = state.gps.acc;
        } else if (hasTreeCoords) {
            logLat = Number(tree.lat);
            logLng = Number(tree.lng);
            logAcc = tree.gps_acc || null;
        }

        const date = $("harv-date").value || todayStr();
        const round_no = Number($("harv-round").value) || roundOfDate(date).round;
        const bunches = Number($("mh-bunches").value) || 0;
        const fronds = Number($("mh-fronds").value) || 0;
        await api("/api/harvest", "POST", {
            tree_id: tree.id,
            round_no,
            date,
            bunches,
            fronds,
            lat: logLat,
            lng: logLng,
            acc: logAcc,
        });
        $("modal-harvest").classList.add("hidden");
        toast(`Harvest logged (Palm #${tree.tree_no}: ${bunches}B / ${fronds}F)`);
        await loadHarvestBlock();
        if (state.activePage === "map" && typeof refreshGisMapData === "function") {
            await refreshGisMapData(false);
        }
    } catch (err) {
        toast(err.message, "err");
    } finally {
        btn.disabled = false;
    }
}

// ----------------------------------------------------------------------------
// VIEW 2C: DEDICATED FULL-SCREEN GIS SATELLITE MAP (11,000+ Trees 60fps Canvas)
// ----------------------------------------------------------------------------
const AERIAL_PALM_FROND_PATHS = [
    "M32 30 C28 19, 27 10, 32 3 C37 10, 36 19, 32 30 Z",
    "M34 30 C41 21, 48 15, 55 10 C50 18, 43 25, 34 30 Z",
    "M34 32 C45 28, 54 27, 61 32 C54 37, 45 36, 34 32 Z",
    "M34 34 C43 39, 50 46, 55 54 C48 49, 41 43, 34 34 Z",
    "M32 34 C36 45, 37 54, 32 61 C27 54, 28 45, 32 34 Z",
    "M30 34 C23 43, 16 49, 9 54 C14 46, 21 39, 30 34 Z",
    "M30 32 C19 36, 10 37, 3 32 C10 27, 19 28, 30 32 Z",
    "M30 30 C21 25, 14 18, 9 10 C16 15, 23 21, 30 30 Z",
];

function getThemePalmColors() {
    const fallback = THEME_PALM_COLORS[state.theme] || THEME_PALM_COLORS.twitter;
    if (typeof window === "undefined" || !document.documentElement) return fallback;
    const cs = getComputedStyle(document.documentElement);
    const harv = cs.getPropertyValue("--map-palm-harvested").trim() || fallback.harvested;
    const unharv = cs.getPropertyValue("--map-palm-unharvested").trim() || fallback.unharvested;
    return { harvested: harv, unharvested: unharv };
}

function buildAerialPalmSvgString(fillColor) {
    const pathsXml = AERIAL_PALM_FROND_PATHS.map((d) => `<path d="${d}" />`).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
        <g fill="${fillColor}" stroke="#0f1419" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">
            ${pathsXml}
            <circle cx="32" cy="32" r="5.2" fill="${fillColor}" stroke="#0f1419" stroke-width="1.8" />
        </g>
    </svg>`;
}

function createAerialPalmSpriteCanvas(fillColor) {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (!ctx) return canvas;

    ctx.fillStyle = fillColor;
    ctx.strokeStyle = "#0f1419";
    ctx.lineWidth = 2.2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    if (typeof Path2D === "function") {
        for (const d of AERIAL_PALM_FROND_PATHS) {
            const p = new Path2D(d);
            ctx.fill(p);
            ctx.stroke(p);
        }
    } else {
        for (let i = 0; i < 8; i++) {
            const angle = (i * Math.PI) / 4;
            ctx.save();
            ctx.translate(32, 32);
            ctx.rotate(angle);
            ctx.beginPath();
            ctx.moveTo(0, -2);
            ctx.quadraticCurveTo(-5, -15, 0, -29);
            ctx.quadraticCurveTo(5, -15, 0, -2);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.restore();
        }
    }

    ctx.beginPath();
    ctx.arc(32, 32, 5.2, 0, Math.PI * 2);
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.lineWidth = 1.8;
    ctx.stroke();

    return canvas;
}

function rebuildGisPalmSpritesAndRedraw() {
    const { harvested, unharvested } = getThemePalmColors();
    state.gisMap.sprites.harvestedColor = harvested;
    state.gisMap.sprites.unharvestedColor = unharvested;
    state.gisMap.sprites.harvested = createAerialPalmSpriteCanvas(harvested);
    state.gisMap.sprites.unharvested = createAerialPalmSpriteCanvas(unharvested);
    state.gisMap.sprites.svgHarvestedUrl =
        "data:image/svg+xml;charset=utf-8," + encodeURIComponent(buildAerialPalmSvgString(harvested));
    state.gisMap.sprites.svgUnharvestedUrl =
        "data:image/svg+xml;charset=utf-8," + encodeURIComponent(buildAerialPalmSvgString(unharvested));

    if (state.gisMap.map && state.gisMap.basemapMode === "clean") {
        syncGisCleanBasemapLayer();
    }
    if (state.gisMap.boundaryLayer) {
        renderGisBoundariesAndLabels();
    }
    if (state.gisMap.palmCanvasLayer) {
        state.gisMap.palmCanvasLayer.redraw();
    }
}

function getPalmIconPixelSize(zoom) {
    if (zoom <= 13) return 5.5;
    if (zoom === 14) return 7;
    if (zoom === 15) return 9.5;
    if (zoom === 16) return 14;
    if (zoom === 17) return 20;
    if (zoom === 18) return 26;
    return 32;
}

function createPalmCanopyCanvasLayer() {
    if (!window.L) return null;
    const LayerClass = window.L.Layer.extend({
        onAdd(map) {
            this._map = map;
            const pane = map.getPanes().overlayPane;
            const canvas = window.L.DomUtil.create("canvas", "leaflet-zoom-animated palm-canopy-canvas", pane);
            canvas.style.position = "absolute";
            canvas.style.top = "0";
            canvas.style.left = "0";
            canvas.style.pointerEvents = "none";
            canvas.style.zIndex = "450";
            this._canvas = canvas;
            this._ctx = canvas.getContext("2d");

            map.on("moveend zoomend resize viewreset", this.redraw, this);
            map.on("zoomanim", this._onZoomAnim, this);
            map.on("click", this._onMapClick, this);
            map.on("mousemove", this._onMapMouseMove, this);
            this.redraw();
        },
        onRemove(map) {
            map.off("moveend zoomend resize viewreset", this.redraw, this);
            map.off("zoomanim", this._onZoomAnim, this);
            map.off("click", this._onMapClick, this);
            map.off("mousemove", this._onMapMouseMove, this);
            if (this._canvas && this._canvas.parentNode) {
                this._canvas.parentNode.removeChild(this._canvas);
            }
            this._canvas = null;
            this._ctx = null;
            this._map = null;
        },
        _onZoomAnim(e) {
            if (!this._map || !this._canvas) return;
            const scale = this._map.getZoomScale(e.zoom);
            const offset = this._map._latLngBoundsToNewLayerBounds(this._map.getBounds(), e.zoom, e.center).min;
            window.L.DomUtil.setTransform(this._canvas, offset, scale);
        },
        redraw() {
            const map = this._map;
            const canvas = this._canvas;
            const ctx = this._ctx;
            if (!map || !canvas || !ctx) return;

            const size = map.getSize();
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            const topLeft = map.containerPointToLayerPoint([0, 0]);
            window.L.DomUtil.setPosition(canvas, topLeft);

            canvas.width = Math.round(size.x * dpr);
            canvas.height = Math.round(size.y * dpr);
            canvas.style.width = `${size.x}px`;
            canvas.style.height = `${size.y}px`;

            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, size.x, size.y);

            if (!state.gisMap.sprites.harvested) {
                rebuildGisPalmSpritesAndRedraw();
            }
            const sprHarv = state.gisMap.sprites.harvested;
            const sprUnharv = state.gisMap.sprites.unharvested;
            if (!sprHarv || !sprUnharv) return;

            const zoom = map.getZoom();
            const iconSize = getPalmIconPixelSize(zoom);
            const half = iconSize / 2;

            const bounds = map.getBounds().pad(0.08);
            const sLat = bounds.getSouth();
            const nLat = bounds.getNorth();
            const wLng = bounds.getWest();
            const eLng = bounds.getEast();

            const trees = state.gisMap.visibleTrees || [];
            for (let i = 0; i < trees.length; i++) {
                const t = trees[i];
                const lat = t.lat;
                const lng = t.lng;
                if (lat < sLat || lat > nLat || lng < wLng || lng > eLng) continue;
                const pt = map.latLngToContainerPoint([lat, lng]);
                const sprite = t.harvested ? sprHarv : sprUnharv;
                ctx.drawImage(sprite, pt.x - half, pt.y - half, iconSize, iconSize);
            }
        },
        _findTreeAtPoint(containerPoint) {
            const map = this._map;
            if (!map || !containerPoint) return null;
            const zoom = map.getZoom();
            const iconSize = getPalmIconPixelSize(zoom);
            const hitRadius = Math.max(11, iconSize * 0.72);
            const maxDistSq = hitRadius * hitRadius;

            const bounds = map.getBounds().pad(0.02);
            const sLat = bounds.getSouth();
            const nLat = bounds.getNorth();
            const wLng = bounds.getWest();
            const eLng = bounds.getEast();

            let bestTree = null;
            let bestDistSq = maxDistSq;
            const trees = state.gisMap.visibleTrees || [];
            for (let i = 0; i < trees.length; i++) {
                const t = trees[i];
                if (t.lat < sLat || t.lat > nLat || t.lng < wLng || t.lng > eLng) continue;
                const pt = map.latLngToContainerPoint([t.lat, t.lng]);
                const dx = pt.x - containerPoint.x;
                const dy = pt.y - containerPoint.y;
                const dSq = dx * dx + dy * dy;
                if (dSq <= bestDistSq) {
                    bestDistSq = dSq;
                    bestTree = t;
                }
            }
            return bestTree;
        },
        _onMapMouseMove(e) {
            if (!this._map) return;
            const container = this._map.getContainer();
            if (!container) return;
            const hit = this._findTreeAtPoint(e.containerPoint);
            container.style.cursor = hit ? "pointer" : "";
        },
        _onMapClick(e) {
            if (!this._map) return;
            const tree = this._findTreeAtPoint(e.containerPoint);
            if (!tree) return;
            const { harvested, unharvested } = getThemePalmColors();
            const statusColor = tree.harvested ? harvested : unharvested;
            const statusLabel = tree.harvested ? "Harvested" : "Not Harvested";

            const html = `
                <div class="min-w-[195px] space-y-2 text-xs">
                    <div class="flex items-center justify-between gap-2 border-b border-[#eff3f4] pb-1.5">
                        <span class="font-mono-code font-extrabold text-sm">${esc(tree.tree_code)} (Palm #${tree.tree_no})</span>
                        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold text-white" style="background:${statusColor};">
                            ${statusLabel}
                        </span>
                    </div>
                    <div class="text-[11px] opacity-80 font-semibold">
                        ${esc(tree.block_name)} &bull; ${esc(tree.field_name)}<br/>
                        <span class="text-[10px] opacity-75">${esc(tree.division_name)}</span>
                    </div>
                    <div class="grid grid-cols-2 gap-1.5 pt-1 text-center">
                        <div class="p-1.5 rounded-lg bg-[#f7f9f9] border border-[#eff3f4]">
                            <div class="text-[9px] font-bold uppercase opacity-70">Bunches Cut</div>
                            <div class="font-mono-code font-extrabold text-xs mt-0.5">${tree.bunches}</div>
                        </div>
                        <div class="p-1.5 rounded-lg bg-[#f7f9f9] border border-[#eff3f4]">
                            <div class="text-[9px] font-bold uppercase opacity-70">Fronds Cut</div>
                            <div class="font-mono-code font-extrabold text-xs mt-0.5">${tree.fronds}</div>
                        </div>
                    </div>
                    <button type="button" onclick="window.__openGisTreeHarvest(${tree.block_id}, ${tree.id})" class="x-btn-primary w-full !py-1.5 !text-[11px] mt-1">
                        Log / Edit Harvest
                    </button>
                </div>
            `;
            window.L.popup({ closeButton: true, offset: [0, -4] })
                .setLatLng([tree.lat, tree.lng])
                .setContent(html)
                .openOn(this._map);
        },
    });
    return new LayerClass();
}

window.__openGisTreeHarvest = async (blockId, treeId) => {
    await selectHarvestBlockCascade(blockId);
    openHarvestModal(treeId);
};

// ----------------------------------------------------------------------------
// Turf.js Curved Outer Boundary Algorithm (10m Margin from Outermost Trees)
// ----------------------------------------------------------------------------
function extractOutermostPerimeterTrees(treesGroup, bins = 24) {
    if (!treesGroup || treesGroup.length <= 70) return treesGroup || [];
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;
    for (let i = 0; i < treesGroup.length; i++) {
        const t = treesGroup[i];
        if (t.lat < minLat) minLat = t.lat;
        if (t.lat > maxLat) maxLat = t.lat;
        if (t.lng < minLng) minLng = t.lng;
        if (t.lng > maxLng) maxLng = t.lng;
    }
    const latSpan = Math.max(0.00001, maxLat - minLat);
    const lngSpan = Math.max(0.00001, maxLng - minLng);

    const rowMin = new Array(bins).fill(null);
    const rowMax = new Array(bins).fill(null);
    const colMin = new Array(bins).fill(null);
    const colMax = new Array(bins).fill(null);

    for (let i = 0; i < treesGroup.length; i++) {
        const t = treesGroup[i];
        const rBin = Math.min(bins - 1, Math.max(0, Math.floor(((t.lat - minLat) / latSpan) * bins)));
        const cBin = Math.min(bins - 1, Math.max(0, Math.floor(((t.lng - minLng) / lngSpan) * bins)));

        if (!rowMin[rBin] || t.lng < rowMin[rBin].lng) rowMin[rBin] = t;
        if (!rowMax[rBin] || t.lng > rowMax[rBin].lng) rowMax[rBin] = t;
        if (!colMin[cBin] || t.lat < colMin[cBin].lat) colMin[cBin] = t;
        if (!colMax[cBin] || t.lat > colMax[cBin].lat) colMax[cBin] = t;
    }

    const picked = new Map();
    for (let b = 0; b < bins; b++) {
        if (rowMin[b]) picked.set(rowMin[b].id, rowMin[b]);
        if (rowMax[b]) picked.set(rowMax[b].id, rowMax[b]);
        if (colMin[b]) picked.set(colMin[b].id, colMin[b]);
        if (colMax[b]) picked.set(colMax[b].id, colMax[b]);
    }
    return Array.from(picked.values());
}

function buildCurved10mBoundaryFeature(treesGroup, meta) {
    if (!window.turf || !treesGroup || !treesGroup.length) return null;
    const turf = window.turf;
    const perimeterTrees = extractOutermostPerimeterTrees(treesGroup, meta.level === "block" ? 24 : 32);
    const pts = perimeterTrees.map((t) => turf.point([Number(t.lng), Number(t.lat)]));
    const fc = turf.featureCollection(pts);

    let hull = null;
    if (pts.length === 1) {
        hull = pts[0];
    } else if (pts.length === 2) {
        hull = turf.lineString(pts.map((p) => p.geometry.coordinates));
    } else {
        // 1. Run turf.concave(points, { maxEdge: 0.05, units: 'kilometers' })
        try {
            hull = turf.concave(fc, { maxEdge: 0.05, units: "kilometers" });
        } catch (_) {
            hull = null;
        }
        // If sparse or internal road gap split the hull into a MultiPolygon, bridge or fall back to turf.convex(points)
        if (!hull || hull.geometry?.type !== "Polygon") {
            const bridgeEdge = meta.level === "block" ? 0.09 : meta.level === "field" ? 0.16 : 0.35;
            try {
                hull = turf.concave(fc, { maxEdge: bridgeEdge, units: "kilometers" });
            } catch (_) {
                hull = null;
            }
        }
        if (!hull || hull.geometry?.type !== "Polygon") {
            try {
                hull = turf.convex(fc);
            } catch (_) {
                hull = null;
            }
        }
    }

    if (!hull) return null;

    // 2. Apply 10-meter outward buffer from the outermost palm trees
    let buffered = null;
    try {
        buffered = turf.buffer(hull, 10, { units: "meters", steps: 16 });
    } catch (_) {
        buffered = hull;
    }
    if (!buffered) return null;

    // 3. Smooth curves with turf.polygonSmooth
    if (typeof turf.polygonSmooth === "function" && buffered.geometry?.type === "Polygon") {
        try {
            const smoothed = turf.polygonSmooth(buffered, { iterations: 2 });
            if (smoothed?.features?.[0]) {
                buffered = smoothed.features[0];
            }
        } catch (_) {}
    }

    let centerCoords = null;
    try {
        const com = turf.centerOfMass(buffered);
        centerCoords = com?.geometry?.coordinates || null; // [lng, lat]
    } catch (_) {}

    buffered.properties = {
        ...meta,
        center_lng: centerCoords ? centerCoords[0] : null,
        center_lat: centerCoords ? centerCoords[1] : null,
    };
    return buffered;
}

function ensureGisHierarchyBoundaries(allTrees) {
    if (!window.turf || !allTrees || !allTrees.length) return;
    const sig = `${allTrees.length}:${allTrees[0]?.lat}:${allTrees[allTrees.length - 1]?.lng}`;
    if (state.gisMap.boundariesCacheKey === sig && state.gisMap.boundaries.blocks.length) {
        return;
    }

    const byEstate = new Map();
    const byDivision = new Map();
    const byField = new Map();
    const byBlock = new Map();

    // First group by Block and extract each Block's outermost perimeter trees
    for (let i = 0; i < allTrees.length; i++) {
        const t = allTrees[i];
        if (!byBlock.has(t.block_id)) {
            byBlock.set(t.block_id, {
                id: t.block_id,
                name: `${t.field_name} • ${t.block_name}`,
                short_name: t.block_name,
                field_id: t.field_id,
                division_id: t.division_id,
                estate_id: t.estate_id,
                trees: [],
            });
        }
        byBlock.get(t.block_id).trees.push(t);
    }

    const blockFeatures = [];
    for (const blk of byBlock.values()) {
        const perim = extractOutermostPerimeterTrees(blk.trees, 24);
        const feat = buildCurved10mBoundaryFeature(perim, {
            level: "block",
            id: blk.id,
            name: blk.name,
            short_name: blk.short_name,
            block_id: blk.id,
            field_id: blk.field_id,
            division_id: blk.division_id,
            estate_id: blk.estate_id,
        });
        if (feat) blockFeatures.push(feat);

        // Feed block's perimeter trees into Field, Division, and Estate groups
        const sampleTree = blk.trees[0];
        if (!byField.has(blk.field_id)) {
            byField.set(blk.field_id, {
                id: blk.field_id,
                name: sampleTree.field_name,
                division_id: blk.division_id,
                estate_id: blk.estate_id,
                trees: [],
            });
        }
        byField.get(blk.field_id).trees.push(...perim);

        if (!byDivision.has(blk.division_id)) {
            byDivision.set(blk.division_id, {
                id: blk.division_id,
                name: sampleTree.division_name,
                estate_id: blk.estate_id,
                trees: [],
            });
        }
        byDivision.get(blk.division_id).trees.push(...perim);

        if (!byEstate.has(blk.estate_id)) {
            byEstate.set(blk.estate_id, {
                id: blk.estate_id,
                name: sampleTree.estate_name || "Uskvalley Estate",
                trees: [],
            });
        }
        byEstate.get(blk.estate_id).trees.push(...perim);
    }

    const fieldFeatures = [];
    for (const fld of byField.values()) {
        const feat = buildCurved10mBoundaryFeature(fld.trees, {
            level: "field",
            id: fld.id,
            name: fld.name,
            field_id: fld.id,
            division_id: fld.division_id,
            estate_id: fld.estate_id,
        });
        if (feat) fieldFeatures.push(feat);
    }

    const divisionFeatures = [];
    for (const div of byDivision.values()) {
        const feat = buildCurved10mBoundaryFeature(div.trees, {
            level: "division",
            id: div.id,
            name: div.name,
            division_id: div.id,
            estate_id: div.estate_id,
        });
        if (feat) divisionFeatures.push(feat);
    }

    const estateFeatures = [];
    for (const est of byEstate.values()) {
        const feat = buildCurved10mBoundaryFeature(est.trees, {
            level: "estate",
            id: est.id,
            name: est.name,
            estate_id: est.id,
        });
        if (feat) estateFeatures.push(feat);
    }

    state.gisMap.boundaries = {
        estates: estateFeatures,
        divisions: divisionFeatures,
        fields: fieldFeatures,
        blocks: blockFeatures,
    };
    state.gisMap.boundariesCacheKey = sig;
}

function getBoundaryStyleForLevel(level) {
    const isLightClean =
        state.gisMap.basemapMode === "clean" && (state.theme === "twitter" || state.theme === "dracula-light");
    const strokeMain = isLightClean ? "#0f1419" : "#ffffff";
    const strokeDiv = isLightClean ? "#1e293b" : "#f8fafc";
    const strokeFld = isLightClean ? "#334155" : "#e2e8f0";
    const strokeBlk = isLightClean ? "rgba(15, 20, 25, 0.55)" : "rgba(255, 255, 255, 0.68)";

    if (level === "estate") {
        return {
            color: strokeMain,
            weight: 3,
            opacity: 0.96,
            fillColor: strokeMain,
            fillOpacity: 0.01,
            interactive: false,
        };
    }
    if (level === "division") {
        return {
            color: strokeDiv,
            weight: 2.2,
            dashArray: "12, 6",
            opacity: 0.9,
            fillColor: strokeDiv,
            fillOpacity: 0.02,
            interactive: false,
        };
    }
    if (level === "field") {
        return {
            color: strokeFld,
            weight: 1.6,
            dashArray: "5, 5",
            opacity: 0.84,
            fillColor: strokeFld,
            fillOpacity: 0.02,
            interactive: false,
        };
    }
    return {
        color: strokeBlk,
        weight: 1.2,
        opacity: 0.75,
        fillColor: strokeMain,
        fillOpacity: 0.03,
        interactive: false,
    };
}

function getVisibleBoundaryFeatures() {
    const { estates, divisions, fields, blocks } = state.gisMap.boundaries;
    const divId = Number($("mapview-division")?.value || 0);
    const fldId = Number($("mapview-field")?.value || 0);
    const blkId = Number($("mapview-block")?.value || 0);
    const isolate = state.gisMap.isolate && (divId || fldId || blkId);

    if (!isolate) {
        return [...estates, ...divisions, ...fields, ...blocks];
    }
    if (blkId) {
        return blocks.filter((f) => f.properties.block_id === blkId);
    }
    if (fldId) {
        return [
            ...fields.filter((f) => f.properties.field_id === fldId),
            ...blocks.filter((f) => f.properties.field_id === fldId),
        ];
    }
    if (divId) {
        return [
            ...divisions.filter((f) => f.properties.division_id === divId),
            ...fields.filter((f) => f.properties.division_id === divId),
            ...blocks.filter((f) => f.properties.division_id === divId),
        ];
    }
    return [...estates, ...divisions, ...fields, ...blocks];
}

function getZoomFilteredLabelFeatures() {
    if (!state.gisMap.map) return [];
    const zoom = state.gisMap.map.getZoom();
    const { estates, divisions, fields, blocks } = state.gisMap.boundaries;
    const divId = Number($("mapview-division")?.value || 0);
    const fldId = Number($("mapview-field")?.value || 0);
    const blkId = Number($("mapview-block")?.value || 0);
    const isolate = state.gisMap.isolate && (divId || fldId || blkId);

    if (isolate) {
        if (blkId) return blocks.filter((f) => f.properties.block_id === blkId);
        if (fldId) {
            return zoom >= 16
                ? blocks.filter((f) => f.properties.field_id === fldId)
                : fields.filter((f) => f.properties.field_id === fldId);
        }
        if (divId) {
            if (zoom >= 17) return blocks.filter((f) => f.properties.division_id === divId);
            if (zoom >= 15) return fields.filter((f) => f.properties.division_id === divId);
            return divisions.filter((f) => f.properties.division_id === divId);
        }
    }

    // Smart Zoom-Based Labels: Estate/Division when zoomed out, Field/Block as you zoom in
    if (zoom <= 13) return estates;
    if (zoom <= 15) return divisions;
    if (zoom === 16) return fields;
    return blocks;
}

function renderGisBoundariesAndLabels() {
    const map = state.gisMap.map;
    if (!map || !window.L) return;

    if (state.gisMap.boundaryLayer) {
        state.gisMap.boundaryLayer.clearLayers();
    } else {
        state.gisMap.boundaryLayer = window.L.layerGroup().addTo(map);
    }

    if (state.gisMap.labelLayer) {
        state.gisMap.labelLayer.clearLayers();
    } else {
        state.gisMap.labelLayer = window.L.layerGroup().addTo(map);
    }

    if (state.gisMap.showBoundaries) {
        const feats = getVisibleBoundaryFeatures();
        for (const feat of feats) {
            const style = getBoundaryStyleForLevel(feat.properties?.level);
            window.L.geoJSON(feat, { style }).addTo(state.gisMap.boundaryLayer);
        }
    }

    if (state.gisMap.showLabels) {
        const labelFeats = getZoomFilteredLabelFeatures();
        for (const feat of labelFeats) {
            const p = feat.properties || {};
            if (p.center_lat === null || p.center_lng === null) continue;
            const lvlClass = p.level === "estate" ? "lbl-estate" : p.level === "division" ? "lbl-division" : "";
            const icon = window.L.divIcon({
                className: "gis-boundary-label-icon",
                html: `<div class="gis-boundary-label ${lvlClass}">${esc(p.name)}</div>`,
                iconSize: [0, 0],
            });
            window.L.marker([p.center_lat, p.center_lng], { icon, interactive: false }).addTo(state.gisMap.labelLayer);
        }
    }
}

// ----------------------------------------------------------------------------
// GIS Map Initialization, Cascading Area & Time Filters, and FitBounds
// ----------------------------------------------------------------------------
function ensureLeafletGisMap() {
    if (state.gisMap.map || !window.L) return state.gisMap.map;
    const container = $("gis-map-canvas");
    if (!container) return null;

    const map = window.L.map(container, {
        center: [6.1448, 80.372],
        zoom: 15,
        minZoom: 12,
        maxZoom: 20,
        zoomControl: true,
        preferCanvas: true,
    });

    // Real Satellite Base Map: Esri World Imagery (crossOrigin: true for PNG download)
    state.gisMap.satelliteLayer = window.L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        {
            maxZoom: 20,
            maxNativeZoom: 18,
            crossOrigin: true,
            attribution: "Tiles &copy; Esri",
        }
    );

    state.gisMap.satelliteLayer.addTo(map);
    state.gisMap.boundaryLayer = window.L.layerGroup().addTo(map);
    state.gisMap.labelLayer = window.L.layerGroup().addTo(map);

    rebuildGisPalmSpritesAndRedraw();
    state.gisMap.palmCanvasLayer = createPalmCanopyCanvasLayer();
    if (state.gisMap.palmCanvasLayer) {
        state.gisMap.palmCanvasLayer.addTo(map);
    }

    map.on("zoomend", () => {
        renderGisBoundariesAndLabels();
    });

    state.gisMap.map = map;
    return map;
}

function syncGisCleanBasemapLayer() {
    const map = state.gisMap.map;
    if (!map || !window.L) return;
    if (state.gisMap.cleanLayer) {
        map.removeLayer(state.gisMap.cleanLayer);
    }
    const isDarkTheme = state.theme === "dracula-dark" || state.theme === "nord";
    const tileUrl = isDarkTheme
        ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
    state.gisMap.cleanLayer = window.L.tileLayer(tileUrl, {
        maxZoom: 20,
        crossOrigin: true,
        attribution: "&copy; OpenStreetMap &copy; CARTO",
    });
    if (state.gisMap.basemapMode === "clean") {
        state.gisMap.cleanLayer.addTo(map);
    }
}

function initGisMapFilters() {
    const divEl = $("mapview-division");
    const fldEl = $("mapview-field");
    const blkEl = $("mapview-block");
    if (!divEl || !fldEl || !blkEl) return;

    const { divisions, fields, blocks } = state.hierarchy;
    divEl.innerHTML =
        `<option value="">All Divisions (Full Estate)</option>` +
        (divisions || []).map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("");

    const popMapFields = () => {
        const did = Number(divEl.value);
        const list = did ? fields.filter((f) => f.division_id === did) : fields;
        fldEl.innerHTML =
            `<option value="">All Fields</option>` +
            list.map((f) => `<option value="${f.id}">${esc(f.name)} (${Number(f.area_ha).toFixed(1)} Ha)</option>`).join("");
        popMapBlocks();
    };

    const popMapBlocks = () => {
        const did = Number(divEl.value);
        const fid = Number(fldEl.value);
        let list = blocks;
        if (fid) {
            list = blocks.filter((b) => b.field_id === fid);
        } else if (did) {
            const fIds = new Set(fields.filter((f) => f.division_id === did).map((f) => f.id));
            list = blocks.filter((b) => fIds.has(b.field_id));
        }
        blkEl.innerHTML =
            `<option value="">All Blocks</option>` +
            list
                .map((b) => {
                    const f = fields.find((x) => x.id === b.field_id);
                    return `<option value="${b.id}">${esc(f ? `${f.name} • ${b.name}` : b.name)}</option>`;
                })
                .join("");
    };

    divEl.onchange = () => {
        popMapFields();
        onGisAreaSelectionChanged(true);
    };
    fldEl.onchange = () => {
        popMapBlocks();
        onGisAreaSelectionChanged(true);
    };
    blkEl.onchange = () => {
        onGisAreaSelectionChanged(true);
    };

    if (!state.gisMap.initializedFilters) {
        const today = todayStr();
        if ($("mapview-time-mode")) $("mapview-time-mode").value = "month";
        if ($("mapview-month")) $("mapview-month").value = today.slice(0, 7);
        if ($("mapview-season")) $("mapview-season").value = today.slice(0, 4);
        if ($("mapview-year")) $("mapview-year").value = today.slice(0, 4);
        if ($("mapview-from")) $("mapview-from").value = `${today.slice(0, 4)}-04-01`;
        if ($("mapview-to")) $("mapview-to").value = today;
        if ($("mapview-round")) $("mapview-round").value = "";
        state.gisMap.initializedFilters = true;
    }

    popMapFields();
}

function getGisTimeQuery() {
    const mode = $("mapview-time-mode")?.value || "month";
    const sMonth = String(state.settings.season_start_month || 4).padStart(2, "0");
    const roundVal = $("mapview-round")?.value || "";
    const today = todayStr();

    let from = `${today.slice(0, 7)}-01`;
    let to = `${today.slice(0, 7)}-31`;
    let label = `Month: ${formatMonthYearLabel(today.slice(0, 7))}`;

    if (mode === "season") {
        const yr = Number($("mapview-season")?.value) || 2026;
        from = `${yr}-${sMonth}-01`;
        to = `${yr + 1}-03-31`;
        label = `Season ${yr}/${String(yr + 1).slice(2)}`;
    } else if (mode === "year") {
        const yr = Number($("mapview-year")?.value) || 2026;
        from = `${yr}-01-01`;
        to = `${yr}-12-31`;
        label = `Year ${yr}`;
    } else if (mode === "month") {
        const ym = $("mapview-month")?.value || today.slice(0, 7);
        from = `${ym}-01`;
        to = `${ym}-31`;
        label = formatMonthYearLabel(ym);
    } else if (mode === "custom") {
        from = $("mapview-from")?.value || `${today.slice(0, 4)}-04-01`;
        to = $("mapview-to")?.value || today;
        label = `${formatShortDateLabel(from)} – ${formatShortDateLabel(to)}`;
    }

    const roundLabel = roundVal ? `R${roundVal}` : "Entire Month";
    return { from, to, round_no: roundVal, periodLabel: `${label} (${roundLabel})` };
}

function getGisActiveScopeMeta() {
    const divId = Number($("mapview-division")?.value || 0);
    const fldId = Number($("mapview-field")?.value || 0);
    const blkId = Number($("mapview-block")?.value || 0);
    const { divisions, fields, blocks } = state.hierarchy;

    const parts = [];
    if (divId) {
        const d = divisions.find((x) => x.id === divId);
        if (d) parts.push(d.name);
    }
    if (fldId) {
        const f = fields.find((x) => x.id === fldId);
        if (f) parts.push(f.name);
    }
    if (blkId) {
        const b = blocks.find((x) => x.id === blkId);
        if (b) parts.push(b.name);
    }

    const hasAreaFilter = Boolean(divId || fldId || blkId);
    const scopeName = parts.length ? parts.join(" • ") : "Full Estate (All 3 Divisions)";
    return { divId, fldId, blkId, hasAreaFilter, scopeName };
}

function applyGisTreeIsolationAndStats() {
    const all = state.gisMap.allTrees || [];
    const { divId, fldId, blkId, hasAreaFilter, scopeName } = getGisActiveScopeMeta();
    const isolate = state.gisMap.isolate && hasAreaFilter;

    let visible = all;
    if (isolate) {
        visible = all.filter((t) => {
            if (blkId && t.block_id !== blkId) return false;
            if (fldId && t.field_id !== fldId) return false;
            if (divId && t.division_id !== divId) return false;
            return true;
        });
    }
    state.gisMap.visibleTrees = visible;

    let harvCount = 0;
    for (let i = 0; i < visible.length; i++) {
        if (visible[i].harvested) harvCount++;
    }
    const unharvCount = visible.length - harvCount;

    if ($("gis-leg-harvested")) $("gis-leg-harvested").textContent = harvCount.toLocaleString();
    if ($("gis-leg-unharvested")) $("gis-leg-unharvested").textContent = unharvCount.toLocaleString();
    if ($("gis-leg-scope")) {
        $("gis-leg-scope").textContent = isolate ? `Isolated • 10m Buffer` : `Full Map • 10m Buffer`;
    }

    const { periodLabel } = getGisTimeQuery();
    if ($("mapview-summary-badge")) {
        $("mapview-summary-badge").textContent = `${scopeName}${isolate ? " [Isolated]" : ""} • ${harvCount.toLocaleString()} / ${visible.length.toLocaleString()} Harvested • ${periodLabel}`;
    }

    const isoBtn = $("btn-mapview-isolate");
    const isoLbl = $("lbl-mapview-isolate");
    if (isoBtn && isoLbl) {
        isoBtn.classList.toggle("active", Boolean(state.gisMap.isolate));
        isoLbl.textContent = state.gisMap.isolate ? "Isolate: On" : "Isolate: Off";
    }

    renderGisBoundariesAndLabels();
    if (state.gisMap.palmCanvasLayer) {
        state.gisMap.palmCanvasLayer.redraw();
    }
}

function fitGisMapToActiveSelection(animate = true) {
    const map = state.gisMap.map;
    if (!map || !window.L) return;

    const { divId, fldId, blkId } = getGisActiveScopeMeta();
    const all = state.gisMap.allTrees || [];
    let targetTrees = all;
    if (blkId) {
        targetTrees = all.filter((t) => t.block_id === blkId);
    } else if (fldId) {
        targetTrees = all.filter((t) => t.field_id === fldId);
    } else if (divId) {
        targetTrees = all.filter((t) => t.division_id === divId);
    }
    if (!targetTrees.length) targetTrees = all;
    if (!targetTrees.length) return;

    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;
    for (let i = 0; i < targetTrees.length; i++) {
        const t = targetTrees[i];
        if (t.lat < minLat) minLat = t.lat;
        if (t.lat > maxLat) maxLat = t.lat;
        if (t.lng < minLng) minLng = t.lng;
        if (t.lng > maxLng) maxLng = t.lng;
    }
    const bounds = window.L.latLngBounds([minLat - 0.00015, minLng - 0.00015], [maxLat + 0.00015, maxLng + 0.00015]);
    map.fitBounds(bounds, { padding: [26, 26], maxZoom: blkId ? 18 : fldId ? 17 : divId ? 16 : 15, animate });
}

function onGisAreaSelectionChanged(zoomToArea = true) {
    const { hasAreaFilter } = getGisActiveScopeMeta();
    if (hasAreaFilter && !state.gisMap.isolate) {
        // Automatically enable Isolate when a specific Division/Field/Block is picked (can be toggled off anytime)
        state.gisMap.isolate = true;
    } else if (!hasAreaFilter) {
        state.gisMap.isolate = false;
    }
    applyGisTreeIsolationAndStats();
    if (zoomToArea) {
        fitGisMapToActiveSelection(true);
    }
}

async function refreshGisMapData(fitView = false) {
    const { from, to, round_no } = getGisTimeQuery();
    const qs = new URLSearchParams({ from, to });
    if (round_no) qs.set("round_no", round_no);

    const data = await api(`/api/map/trees?${qs.toString()}`);
    state.gisMap.allTrees = data.trees || [];
    ensureGisHierarchyBoundaries(state.gisMap.allTrees);
    applyGisTreeIsolationAndStats();
    if (fitView) {
        fitGisMapToActiveSelection(false);
    }
}

async function loadGisMapPage() {
    ensureLeafletGisMap();
    if (!state.gisMap.initializedFilters) {
        initGisMapFilters();
    }
    setTimeout(() => {
        if (state.gisMap.map) {
            state.gisMap.map.invalidateSize();
        }
    }, 60);

    const isFirstLoad = !state.gisMap.allTrees.length;
    await refreshGisMapData(isFirstLoad);
}

// ----------------------------------------------------------------------------
// Daily Downloadable Map: PNG Snapshot & Google Earth KML Export
// ----------------------------------------------------------------------------
async function downloadGisMapPng() {
    const map = state.gisMap.map;
    const container = $("gis-map-canvas");
    if (!map || !container) return;

    const rect = container.getBoundingClientRect();
    const w = Math.max(600, Math.round(rect.width));
    const h = Math.max(420, Math.round(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const outCanvas = document.createElement("canvas");
    outCanvas.width = Math.round(w * dpr);
    outCanvas.height = Math.round(h * dpr);
    const ctx = outCanvas.getContext("2d");
    ctx.scale(dpr, dpr);

    // 1. Background Fill
    const isLightClean =
        state.gisMap.basemapMode === "clean" && (state.theme === "twitter" || state.theme === "dracula-light");
    ctx.fillStyle = isLightClean ? "#f8fafc" : "#0e1b14";
    ctx.fillRect(0, 0, w, h);

    // 2. Draw Visible Satellite / Basemap Tiles
    const tileImgs = container.querySelectorAll(".leaflet-tile-pane img.leaflet-tile");
    tileImgs.forEach((img) => {
        if (!img.complete || !img.naturalWidth) return;
        const r = img.getBoundingClientRect();
        const dx = r.left - rect.left;
        const dy = r.top - rect.top;
        try {
            ctx.drawImage(img, dx, dy, r.width, r.height);
        } catch (_) {}
    });

    // 3. Draw Curved 10m-Buffered Boundaries
    if (state.gisMap.showBoundaries) {
        const feats = getVisibleBoundaryFeatures();
        for (const feat of feats) {
            const st = getBoundaryStyleForLevel(feat.properties?.level);
            const geom = feat.geometry;
            if (!geom) continue;
            const rings =
                geom.type === "Polygon"
                    ? geom.coordinates
                    : geom.type === "MultiPolygon"
                    ? geom.coordinates.flat()
                    : [];

            ctx.save();
            ctx.strokeStyle = st.color;
            ctx.lineWidth = st.weight;
            ctx.globalAlpha = st.opacity ?? 0.9;
            if (st.dashArray) {
                ctx.setLineDash(
                    String(st.dashArray)
                        .split(",")
                        .map((n) => Number(n.trim()))
                );
            } else {
                ctx.setLineDash([]);
            }

            for (const ring of rings) {
                if (!ring || !ring.length) continue;
                ctx.beginPath();
                ring.forEach(([lng, lat], idx) => {
                    const pt = map.latLngToContainerPoint([lat, lng]);
                    if (idx === 0) ctx.moveTo(pt.x, pt.y);
                    else ctx.lineTo(pt.x, pt.y);
                });
                ctx.closePath();
                ctx.stroke();
            }
            ctx.restore();
        }
    }

    // 4. Draw Color-Coded Aerial Palm Trees
    const zoom = map.getZoom();
    const iconSize = getPalmIconPixelSize(zoom);
    const half = iconSize / 2;
    const sprHarv = state.gisMap.sprites.harvested;
    const sprUnharv = state.gisMap.sprites.unharvested;
    const visibleTrees = state.gisMap.visibleTrees || [];
    let harvCount = 0;

    for (let i = 0; i < visibleTrees.length; i++) {
        const t = visibleTrees[i];
        if (t.harvested) harvCount++;
        const pt = map.latLngToContainerPoint([t.lat, t.lng]);
        if (pt.x < -iconSize || pt.x > w + iconSize || pt.y < -iconSize || pt.y > h + iconSize) continue;
        ctx.drawImage(t.harvested ? sprHarv : sprUnharv, pt.x - half, pt.y - half, iconSize, iconSize);
    }

    // 5. Draw Smart Zoom-Based Boundary Labels
    if (state.gisMap.showLabels) {
        const labelFeats = getZoomFilteredLabelFeatures();
        ctx.save();
        ctx.font = "bold 11px 'Plus Jakarta Sans', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        for (const feat of labelFeats) {
            const p = feat.properties || {};
            if (p.center_lat === null || p.center_lng === null) continue;
            const pt = map.latLngToContainerPoint([p.center_lat, p.center_lng]);
            if (pt.x < 20 || pt.x > w - 20 || pt.y < 20 || pt.y > h - 20) continue;
            const txt = String(p.name || "");
            const tw = ctx.measureText(txt).width + 16;
            const th = 20;
            ctx.fillStyle = "rgba(15, 20, 25, 0.82)";
            ctx.beginPath();
            if (typeof ctx.roundRect === "function") {
                ctx.roundRect(pt.x - tw / 2, pt.y - th / 2, tw, th, 10);
            } else {
                ctx.rect(pt.x - tw / 2, pt.y - th / 2, tw, th);
            }
            ctx.fill();
            ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.fillStyle = "#ffffff";
            ctx.fillText(txt, pt.x, pt.y);
        }
        ctx.restore();
    }

    // 6. Draw Minimal Legend, Active Area/Time Filter Label & Harvested Count Overlay
    const { scopeName } = getGisActiveScopeMeta();
    const { periodLabel } = getGisTimeQuery();
    const { harvested: harvHex, unharvested: unharvHex } = getThemePalmColors();
    const unharvCount = visibleTrees.length - harvCount;

    const pad = 14;
    const boxW = Math.min(w - 28, 540);
    const boxH = 54;
    const boxX = pad;
    const boxY = h - boxH - pad;

    ctx.save();
    ctx.fillStyle = "rgba(15, 20, 25, 0.88)";
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
        ctx.roundRect(boxX, boxY, boxW, boxH, 14);
    } else {
        ctx.rect(boxX, boxY, boxW, boxH);
    }
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 12px 'Plus Jakarta Sans', sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(`Uskvalley Estate • ${scopeName} (${periodLabel})`, boxX + 14, boxY + 10);

    // Legend Row
    const legY = boxY + 32;
    ctx.fillStyle = harvHex;
    ctx.beginPath();
    ctx.arc(boxX + 19, legY + 5, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 11px 'JetBrains Mono', monospace";
    const harvTxt = `Harvested: ${harvCount.toLocaleString()}`;
    ctx.fillText(harvTxt, boxX + 29, legY);

    const nextX = boxX + 42 + ctx.measureText(harvTxt).width;
    ctx.fillStyle = unharvHex;
    ctx.beginPath();
    ctx.arc(nextX + 5, legY + 5, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    const unharvTxt = `Not Harvested: ${unharvCount.toLocaleString()}  |  Total: ${visibleTrees.length.toLocaleString()} Palms`;
    ctx.fillText(unharvTxt, nextX + 15, legY);
    ctx.restore();

    const safeScope = scopeName.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const filename = `Uskvalley_Map_${safeScope}_${todayStr()}.png`;

    outCanvas.toBlob((blob) => {
        if (!blob) return toast("Could not generate PNG image.", "err");
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast(`${filename} downloaded`);
    }, "image/png");
}

function hexToKmlColor(hexStr, alphaHex = "ff") {
    const clean = String(hexStr || "#00BA7C").replace("#", "").trim();
    if (clean.length !== 6) return `${alphaHex}7cba00`;
    const r = clean.slice(0, 2);
    const g = clean.slice(2, 4);
    const b = clean.slice(4, 6);
    return `${alphaHex}${b}${g}${r}`.toLowerCase();
}

function exportGisMapKml() {
    const visibleTrees = state.gisMap.visibleTrees || [];
    const visibleBoundaries = getVisibleBoundaryFeatures();
    const { scopeName } = getGisActiveScopeMeta();
    const { periodLabel } = getGisTimeQuery();
    const { harvested: harvHex, unharvested: unharvHex } = getThemePalmColors();

    const kmlHarvColor = hexToKmlColor(harvHex, "ff");
    const kmlUnharvColor = hexToKmlColor(unharvestedHexOrFallback(unharvHex), "ff");

    const boundaryPlacemarks = visibleBoundaries
        .map((feat) => {
            const p = feat.properties || {};
            const geom = feat.geometry;
            if (!geom) return "";
            const ring =
                geom.type === "Polygon"
                    ? geom.coordinates[0]
                    : geom.type === "MultiPolygon"
                    ? geom.coordinates[0]?.[0]
                    : null;
            if (!ring || !ring.length) return "";
            const coordsStr = ring.map(([lng, lat]) => `${lng},${lat},0`).join(" ");
            const styleId =
                p.level === "estate"
                    ? "boundEstate"
                    : p.level === "division"
                    ? "boundDivision"
                    : p.level === "field"
                    ? "boundField"
                    : "boundBlock";
            return `
            <Placemark>
                <name>${esc(p.name || "Boundary")}</name>
                <description>${esc((p.level || "boundary").toUpperCase())} • 10m Curved Outer Buffer</description>
                <styleUrl>#${styleId}</styleUrl>
                <Polygon>
                    <outerBoundaryIs>
                        <LinearRing>
                            <coordinates>${coordsStr}</coordinates>
                        </LinearRing>
                    </outerBoundaryIs>
                </Polygon>
            </Placemark>`;
        })
        .join("");

    const palmPlacemarks = visibleTrees
        .map((t) => {
            const styleId = t.harvested ? "palmHarvested" : "palmUnharvested";
            const statusTxt = t.harvested ? "Harvested" : "Not Harvested";
            return `
            <Placemark>
                <name>${esc(t.tree_code)}</name>
                <description>${esc(t.block_name)} • ${esc(t.field_name)} (${esc(t.division_name)}) | Status: ${statusTxt} | Bunches: ${t.bunches} | Fronds: ${t.fronds}</description>
                <styleUrl>#${styleId}</styleUrl>
                <ExtendedData>
                    <Data name="TreeCode"><value>${esc(t.tree_code)}</value></Data>
                    <Data name="Block"><value>${esc(t.block_name)}</value></Data>
                    <Data name="Field"><value>${esc(t.field_name)}</value></Data>
                    <Data name="Division"><value>${esc(t.division_name)}</value></Data>
                    <Data name="Status"><value>${statusTxt}</value></Data>
                    <Data name="BunchesCut"><value>${t.bunches}</value></Data>
                    <Data name="FrondsCut"><value>${t.fronds}</value></Data>
                </ExtendedData>
                <Point>
                    <coordinates>${t.lng},${t.lat},0</coordinates>
                </Point>
            </Placemark>`;
        })
        .join("");

    const kmlXml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
    <Document>
        <name>Uskvalley Estate — ${esc(scopeName)} (${esc(periodLabel)})</name>
        <description>Elaeis GIS Export • ${visibleTrees.length} Palms • 10m Curved Outer Boundaries</description>
        <Style id="palmHarvested">
            <IconStyle>
                <color>${kmlHarvColor}</color>
                <scale>0.85</scale>
                <Icon><href>https://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon>
            </IconStyle>
            <LabelStyle><scale>0</scale></LabelStyle>
        </Style>
        <Style id="palmUnharvested">
            <IconStyle>
                <color>${kmlUnharvColor}</color>
                <scale>0.7</scale>
                <Icon><href>https://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon>
            </IconStyle>
            <LabelStyle><scale>0</scale></LabelStyle>
        </Style>
        <Style id="boundEstate">
            <LineStyle><color>ffffffff</color><width>3</width></LineStyle>
            <PolyStyle><color>0affffff</color></PolyStyle>
        </Style>
        <Style id="boundDivision">
            <LineStyle><color>fff8fafc</color><width>2.2</width></LineStyle>
            <PolyStyle><color>0df8fafc</color></PolyStyle>
        </Style>
        <Style id="boundField">
            <LineStyle><color>ffe2e8f0</color><width>1.6</width></LineStyle>
            <PolyStyle><color>0de2e8f0</color></PolyStyle>
        </Style>
        <Style id="boundBlock">
            <LineStyle><color>b8ffffff</color><width>1.2</width></LineStyle>
            <PolyStyle><color>12ffffff</color></PolyStyle>
        </Style>
        <Folder>
            <name>Boundaries (10m Curved Outer Buffer)</name>
            ${boundaryPlacemarks}
        </Folder>
        <Folder>
            <name>Oil Palm Trees (${visibleTrees.length})</name>
            ${palmPlacemarks}
        </Folder>
    </Document>
</kml>`;

    const safeScope = scopeName.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const filename = `Uskvalley_Map_${safeScope}_${todayStr()}.kml`;
    const blob = new Blob([kmlXml], { type: "application/vnd.google-earth.kml+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(`${filename} exported`);
}

function unharvestedHexOrFallback(hex) {
    return /^#[0-9a-fA-F]{6}$/.test(hex || "") ? hex : "#536471";
}

function initDispatchForm() {
    const divEl = $("disp-division");
    if (!divEl) return;
    const { divisions } = state.hierarchy;
    divEl.innerHTML = divisions.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("");
}

async function loadDispatches() {
    const data = await api("/api/dispatch");
    state.dispatches = data.dispatches || [];
    const totalKg = state.dispatches.reduce((s, d) => s + Number(d.weight_kg || 0), 0);
    $("disp-total-badge").textContent = `Total: ${totalKg.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg`;

    const tbody = $("disp-tbody");
    if (!state.dispatches.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-[#536471]">No mill dispatch crop weights logged yet</td></tr>`;
        return;
    }

    const canDelete = (ROLE_RANK[state.user?.role] || 0) >= ROLE_RANK.Supervisor;
    tbody.innerHTML = state.dispatches
        .map(
            (d) => `
        <tr class="hover:bg-[#f7f9f9]">
            <td class="py-3.5 px-4 font-mono-code text-[#0f1419] whitespace-nowrap">${esc(d.dispatch_date)}</td>
            <td class="py-3.5 px-4 whitespace-nowrap">
                <span class="px-2.5 py-0.5 rounded-full bg-[#0f1419] text-white font-mono-code font-bold text-[11px]">
                    R${d.round_no}
                </span>
            </td>
            <td class="py-3.5 px-4 font-bold text-[#0f1419] whitespace-nowrap">${esc(d.division_name)}</td>
            <td class="py-3.5 px-4 font-mono-code font-extrabold text-[#0f1419] whitespace-nowrap">${Number(d.weight_kg).toLocaleString(undefined, { maximumFractionDigits: 1 })} kg</td>
            <td class="py-3.5 px-4 text-[#536471] whitespace-nowrap">${esc(d.recorded_by || "Staff")}</td>
            <td class="py-3.5 px-4 text-right whitespace-nowrap">
                ${
                    canDelete
                        ? `<button type="button" data-del-dispatch="${d.id}" class="p-1.5 rounded-full text-[#536471] hover:text-[#f4212e]">
                               <i data-lucide="trash-2" class="w-4 h-4"></i>
                           </button>`
                        : ""
                }
            </td>
        </tr>`
        )
        .join("");

    document.querySelectorAll("[data-del-dispatch]").forEach((btn) => {
        btn.onclick = async () => {
            try {
                await api("/api/dispatch/delete", "POST", { id: Number(btn.getAttribute("data-del-dispatch")) });
                toast("Dispatch weight removed");
                await loadDispatches();
            } catch (err) {
                toast(err.message, "err");
            }
        };
    });
    refreshIcons();
}

// ----------------------------------------------------------------------------
// VIEW 3: ESTATES (5-Tier Plantation Hierarchy + GPS Mapper)
// ----------------------------------------------------------------------------
async function loadEstatesPage() {
    const boot = await api("/api/bootstrap");
    state.hierarchy = boot.hierarchy;
    state.settings = boot.settings || { season_start_month: 4 };
    if (Array.isArray(boot.mapped_trees)) {
        state.mappedTrees = boot.mapped_trees;
    }

    if ($("set-season-month")) {
        $("set-season-month").value = state.settings.season_start_month || 4;
    }

    renderAdminHierarchy();
    if (state.estatesTab === "mapper") await loadMapperBlock();
    refreshIcons();
}

async function loadMapperBlock() {
    const bid = Number($("map-block")?.value);
    if (!bid) return;
    const data = await api(`/api/block?block_id=${bid}&mode=map`);
    state.mapBlock.block_id = bid;
    state.mapBlock.trees = data.trees || [];
    state.mapBlock.trees.forEach((t) => syncMappedTreeInCache({ ...t, block_id: bid }));
    const mapped = state.mapBlock.trees.filter((t) => t.lat !== null).length;
    $("map-stats-label").textContent = `${mapped} / ${state.mapBlock.trees.length} GPS Mapped`;

    const grid = $("map-grid");
    grid.innerHTML = state.mapBlock.trees
        .map((t) => {
            const hasGps = t.lat !== null && t.lng !== null;
            return `
            <div data-map-tree="${t.id}" class="palm-card ${hasGps ? "mapped-gps" : ""}">
                <div class="w-full flex items-center justify-between text-[10px] font-mono-code text-[#536471]">
                    <span>#${t.tree_no}</span>
                    <i data-lucide="map-pin" class="w-3.5 h-3.5 ${hasGps ? "text-[#0f1419]" : "text-[#cfd9de]"}"></i>
                </div>
                <div class="text-[10px] font-mono-code font-bold ${hasGps ? "text-[#0f1419]" : "text-[#536471]"} text-center leading-tight mt-1">
                    ${hasGps ? `${Number(t.lat).toFixed(4)}<br/>${Number(t.lng).toFixed(4)}` : "Unmapped"}
                </div>
            </div>`;
        })
        .join("");

    grid.querySelectorAll("[data-map-tree]").forEach((card) => {
        card.onclick = () => openMapperModal(Number(card.getAttribute("data-map-tree")));
    });
    refreshIcons();
}

async function openMapperModal(treeId = null) {
    const trees = state.mapBlock.trees;
    const existing = treeId ? trees.find((t) => t.id === treeId) : null;
    state.modalTree = existing;

    const nextNo = trees.reduce((m, t) => Math.max(m, t.tree_no), 0) + 1;
    $("mp-title").textContent = existing ? `Edit Palm #${existing.tree_no} GPS` : "Map New Palm (Live GPS)";
    $("mp-tree-no").value = existing ? existing.tree_no : nextNo;
    $("btn-mp-delete").classList.toggle("hidden", !existing);
    updateGpsAccuracyPills();

    if (existing && existing.lat !== null) {
        $("mp-lat").value = existing.lat;
        $("mp-lng").value = existing.lng;
    } else {
        const gps = await captureDeviceGps();
        $("mp-lat").value = gps.lat || "";
        $("mp-lng").value = gps.lng || "";
    }
    $("modal-mapper").classList.remove("hidden");
    refreshIcons();
}

async function saveMapperModal() {
    const bid = state.mapBlock.block_id;
    if (!bid) return;
    try {
        const treeNo = Number($("mp-tree-no").value);
        const lat = Number($("mp-lat").value);
        const lng = Number($("mp-lng").value);
        await api("/api/admin/tree/save", "POST", {
            id: state.modalTree?.id || null,
            block_id: bid,
            tree_no: treeNo,
            lat,
            lng,
            acc: state.gps.acc || 4.0,
            status: "active",
        });
        if (state.modalTree?.id) {
            syncMappedTreeInCache({ id: state.modalTree.id, block_id: bid, tree_no: treeNo, lat, lng, gps_acc: state.gps.acc || 4.0 });
        }
        $("modal-mapper").classList.add("hidden");
        toast("Palm GPS coordinates saved");
        await loadMapperBlock();
    } catch (err) {
        toast(err.message, "err");
    }
}

async function deleteMapperTree() {
    if (!state.modalTree) return;
    try {
        await api("/api/admin/tree/delete", "POST", { id: state.modalTree.id });
        syncMappedTreeInCache({ id: state.modalTree.id, lat: null, lng: null });
        $("modal-mapper").classList.add("hidden");
        toast(`Deleted Palm #${state.modalTree.tree_no}`);
        await loadMapperBlock();
    } catch (err) {
        toast(err.message, "err");
    }
}

function renderAdminHierarchy() {
    const { estates, divisions, fields, blocks } = state.hierarchy;

    $("crud-estates").innerHTML = estates
        .map(
            (e) => `
        <div class="p-3.5 rounded-xl bg-[#f7f9f9] border border-[#eff3f4] flex items-center justify-between gap-2 text-xs">
            <div class="min-w-0">
                <div class="font-extrabold text-[#0f1419] truncate">${esc(e.name)}</div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
                <button type="button" data-edit-estate="${e.id}" class="p-1.5 rounded-lg text-[#536471] hover:text-[#0f1419]"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                <button type="button" data-del-entity="estate:${e.id}" class="p-1.5 rounded-lg text-[#536471] hover:text-[#f4212e]"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
            </div>
        </div>`
        )
        .join("");

    $("crud-divisions").innerHTML = divisions
        .map((d) => {
            const est = estates.find((e) => e.id === d.estate_id);
            return `
            <div class="p-3.5 rounded-xl bg-[#f7f9f9] border border-[#eff3f4] flex items-center justify-between gap-2 text-xs">
                <div class="min-w-0">
                    <div class="font-extrabold text-[#0f1419] truncate">${esc(d.name)}</div>
                    <div class="text-[11px] text-[#536471] truncate">${esc(est?.name || "Uskvalley Estate")}</div>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                    <button type="button" data-edit-division="${d.id}" class="p-1.5 rounded-lg text-[#536471] hover:text-[#0f1419]"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                    <button type="button" data-del-entity="division:${d.id}" class="p-1.5 rounded-lg text-[#536471] hover:text-[#f4212e]"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                </div>
            </div>`;
        })
        .join("");

    $("crud-fields").innerHTML = fields
        .map((f) => {
            const div = divisions.find((d) => d.id === f.division_id);
            return `
            <div class="p-3.5 rounded-xl bg-[#f7f9f9] border border-[#eff3f4] flex items-center justify-between gap-2 text-xs">
                <div class="min-w-0">
                    <div class="flex flex-wrap items-center gap-1.5">
                        <span class="font-extrabold text-[#0f1419]">${esc(f.name)}</span>
                        <span class="px-2 py-0.5 rounded-md bg-white border border-[#cfd9de] font-mono-code text-[10px] font-bold">${f.planting_year}</span>
                        <span class="px-2 py-0.5 rounded-md bg-white border border-[#cfd9de] font-mono-code text-[10px] font-bold">${Number(f.area_ha).toFixed(2)} Ha</span>
                    </div>
                    <div class="text-[11px] text-[#536471] mt-0.5 truncate">${esc(div?.name || "")}</div>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                    <button type="button" data-edit-field="${f.id}" class="p-1.5 rounded-lg text-[#536471] hover:text-[#0f1419]"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                    <button type="button" data-del-entity="field:${f.id}" class="p-1.5 rounded-lg text-[#536471] hover:text-[#f4212e]"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                </div>
            </div>`;
        })
        .join("");

    $("crud-blocks").innerHTML = blocks
        .map((b) => {
            const fld = fields.find((f) => f.id === b.field_id);
            return `
            <div class="p-3.5 rounded-xl bg-[#f7f9f9] border border-[#eff3f4] flex items-center justify-between gap-2 text-xs">
                <div class="min-w-0">
                    <div class="flex flex-wrap items-center gap-1.5">
                        <span class="font-extrabold text-[#0f1419]">${esc(b.name)}</span>
                        <span class="px-2 py-0.5 rounded-md bg-white border border-[#cfd9de] font-mono-code text-[10px] font-bold">${b.tree_total} palms</span>
                    </div>
                    <div class="text-[11px] text-[#536471] mt-0.5 truncate">${esc(fld ? `${fld.name} (${fld.planting_year})` : "")} ${b.boundary_note ? `• ${esc(b.boundary_note)}` : ""}</div>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                    <button type="button" data-batch-block="${b.id}" class="px-2.5 py-1 rounded-full bg-white border border-[#cfd9de] text-[#0f1419] font-mono-code text-[10px] font-bold">+Palms</button>
                    <button type="button" data-edit-block="${b.id}" class="p-1.5 rounded-lg text-[#536471] hover:text-[#0f1419]"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                    <button type="button" data-del-entity="block:${b.id}" class="p-1.5 rounded-lg text-[#536471] hover:text-[#f4212e]"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                </div>
            </div>`;
        })
        .join("");

    document.querySelectorAll("[data-del-entity]").forEach((btn) => {
        btn.onclick = async () => {
            const [ent, id] = btn.getAttribute("data-del-entity").split(":");
            try {
                await api(`/api/admin/${ent}/delete`, "POST", { id: Number(id) });
                toast(`Removed ${ent}`);
                await loadEstatesPage();
                await loadBootstrap();
            } catch (err) {
                toast(err.message, "err");
            }
        };
    });

    document.querySelectorAll("[data-edit-estate]").forEach((b) => {
        b.onclick = () => openCrudModal("estate", estates.find((x) => x.id === Number(b.getAttribute("data-edit-estate"))));
    });
    document.querySelectorAll("[data-edit-division]").forEach((b) => {
        b.onclick = () => openCrudModal("division", divisions.find((x) => x.id === Number(b.getAttribute("data-edit-division"))));
    });
    document.querySelectorAll("[data-edit-field]").forEach((b) => {
        b.onclick = () => openCrudModal("field", fields.find((x) => x.id === Number(b.getAttribute("data-edit-field"))));
    });
    document.querySelectorAll("[data-edit-block]").forEach((b) => {
        b.onclick = () => openCrudModal("block", blocks.find((x) => x.id === Number(b.getAttribute("data-edit-block"))));
    });
    document.querySelectorAll("[data-batch-block]").forEach((b) => {
        b.onclick = () => openCrudModal("batch", blocks.find((x) => x.id === Number(b.getAttribute("data-batch-block"))));
    });
}

function openCrudModal(type, item = null) {
    const body = $("ac-body");
    const { estates, divisions, fields } = state.hierarchy;

    if (type === "estate") {
        $("ac-title").textContent = item ? "Edit Estate" : "Add Estate";
        body.innerHTML = `<input id="ac-name" type="text" placeholder="Estate Name" value="${esc(item?.name || "")}" class="x-input" />`;
        state.crudCallback = () => api("/api/admin/estate/save", "POST", { id: item?.id, name: $("ac-name").value });
    } else if (type === "division") {
        $("ac-title").textContent = item ? "Edit Division" : "Add Division";
        body.innerHTML = `
            <select id="ac-parent" class="x-input ${item ? "hidden" : ""}">
                ${estates.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join("")}
            </select>
            <input id="ac-name" type="text" placeholder="Division Name" value="${esc(item?.name || "")}" class="x-input" />`;
        state.crudCallback = () =>
            api("/api/admin/division/save", "POST", { id: item?.id, estate_id: Number($("ac-parent").value), name: $("ac-name").value });
    } else if (type === "field") {
        $("ac-title").textContent = item ? "Edit Field" : "Add Field (Year & Ha)";
        body.innerHTML = `
            <select id="ac-parent" class="x-input ${item ? "hidden" : ""}">
                ${divisions.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("")}
            </select>
            <input id="ac-name" type="text" placeholder="Field Name (e.g. Field 7)" value="${esc(item?.name || "")}" class="x-input" />
            <div class="grid grid-cols-2 gap-2">
                <input id="ac-year" type="number" placeholder="Planting Year" value="${item?.planting_year || 2014}" class="x-input font-mono-code" />
                <input id="ac-ha" type="number" step="0.01" placeholder="Area Ha" value="${item?.area_ha || 10.0}" class="x-input font-mono-code" />
            </div>`;
        state.crudCallback = () =>
            api("/api/admin/field/save", "POST", {
                id: item?.id,
                division_id: Number($("ac-parent").value),
                name: $("ac-name").value,
                planting_year: Number($("ac-year").value),
                area_ha: Number($("ac-ha").value),
            });
    } else if (type === "block") {
        $("ac-title").textContent = item ? "Edit Block" : "Add Block";
        body.innerHTML = `
            <select id="ac-parent" class="x-input ${item ? "hidden" : ""}">
                ${fields.map((f) => `<option value="${f.id}">${esc(f.name)} (${f.planting_year} - ${f.area_ha}Ha)</option>`).join("")}
            </select>
            <input id="ac-name" type="text" placeholder="Block Name (e.g. Block C)" value="${esc(item?.name || "")}" class="x-input" />
            <input id="ac-note" type="text" placeholder="Boundary note" value="${esc(item?.boundary_note || "")}" class="x-input" />
            ${
                item
                    ? ""
                    : `<input id="ac-count" type="number" min="0" max="3000" value="280" placeholder="Initial Palm Count (~300)" class="x-input font-mono-code" />`
            }`;
        state.crudCallback = () =>
            api("/api/admin/block/save", "POST", {
                id: item?.id,
                field_id: Number($("ac-parent").value),
                name: $("ac-name").value,
                boundary_note: $("ac-note").value,
                tree_count: item ? undefined : Number($("ac-count").value),
            });
    } else if (type === "batch") {
        $("ac-title").textContent = `Batch Generate Palms • ${item?.name}`;
        body.innerHTML = `<input id="ac-batch-count" type="number" min="1" max="3000" value="50" placeholder="Number of palms to add" class="x-input font-mono-code" />`;
        state.crudCallback = () => api("/api/admin/trees/batch", "POST", { block_id: item.id, count: Number($("ac-batch-count").value) });
    }

    $("modal-admin-crud").classList.remove("hidden");
}

// ----------------------------------------------------------------------------
// VIEW 4: DIRECTORY (Corporate User Management & Master Admin Force Password Reset)
// ----------------------------------------------------------------------------
async function loadDirectoryPage() {
    const uData = await api("/api/admin/users");
    state.adminUsers = uData;
    renderDirectoryUsers();
    refreshIcons();
}

function renderDirectoryUsers() {
    const users = state.adminUsers.users || [];
    const isMasterViewer = Boolean(state.user?.is_master) || String(state.user?.username || "").toLowerCase() === "sandaru98j";

    if ($("adm-total-users-badge")) $("adm-total-users-badge").textContent = users.length;
    if ($("master-admin-banner")) $("master-admin-banner").classList.toggle("hidden", !isMasterViewer);

    $("adm-users-list").innerHTML = users
        .map((u) => {
            const uMaster = Boolean(u.is_master) || String(u.username || "").toLowerCase() === "sandaru98j";
            const uRole = uMaster ? "Master Admin" : normalizeRole(u.role);
            const initials = u.full_name
                .split(" ")
                .map((w) => w[0])
                .join("")
                .slice(0, 2)
                .toUpperCase();

            return `
            <div class="erp-detail-card !p-4 sm:!p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div class="flex items-center gap-3 min-w-0">
                    <div class="w-10 h-10 rounded-full ${uMaster ? "bg-[#0f1419] text-white" : "bg-[#eff3f4] text-[#0f1419]"} flex items-center justify-center font-extrabold text-xs shrink-0">
                        ${esc(initials)}
                    </div>
                    <div class="min-w-0">
                        <div class="flex flex-wrap items-center gap-2">
                            <span class="text-sm font-extrabold text-[#0f1419] truncate">${esc(u.full_name)}</span>
                            <span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold ${
                                uMaster ? "bg-[#0f1419] text-white" : "bg-[#eff3f4] text-[#0f1419]"
                            }">${esc(uRole)}</span>
                        </div>
                        <div class="text-xs font-mono-code text-[#536471]">@${esc(u.username)}</div>
                    </div>
                </div>

                <div class="flex flex-wrap items-center gap-2">
                    ${
                        isMasterViewer
                            ? `<button type="button" data-force-pw-user="${u.id}" class="x-btn-outline !py-1.5 !px-3 !text-xs">
                                   <i data-lucide="key-round" class="w-3.5 h-3.5"></i>
                                   <span>Reset Password</span>
                               </button>`
                            : ""
                    }
                    ${
                        uMaster
                            ? `<span class="px-3 py-1.5 rounded-full bg-[#f7f9f9] border border-[#cfd9de] text-xs font-bold text-[#0f1419]">Master Admin</span>`
                            : `
                        <select data-user-role="${u.id}" class="x-input !w-auto !py-1.5 !px-3 !rounded-full text-xs font-bold">
                            <option value="Harvester" ${uRole === "Harvester" ? "selected" : ""}>Harvester</option>
                            <option value="Supervisor" ${uRole === "Supervisor" ? "selected" : ""}>Supervisor</option>
                            <option value="Admin" ${uRole === "Admin" ? "selected" : ""}>Admin</option>
                        </select>
                        <button type="button" data-del-user="${u.id}" title="Remove User" class="p-2 rounded-full border border-[#cfd9de] hover:text-[#f4212e] text-[#536471]">
                            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                        </button>`
                    }
                </div>
            </div>`;
        })
        .join("");

    document.querySelectorAll("[data-user-role]").forEach((sel) => {
        sel.onchange = async () => {
            try {
                await api("/api/admin/users/role", "POST", {
                    user_id: Number(sel.getAttribute("data-user-role")),
                    role: sel.value,
                });
                toast(`Updated role to ${sel.value}`);
                await loadDirectoryPage();
            } catch (err) {
                toast(err.message, "err");
            }
        };
    });

    document.querySelectorAll("[data-force-pw-user]").forEach((btn) => {
        btn.onclick = () => {
            const uid = Number(btn.getAttribute("data-force-pw-user"));
            const target = users.find((x) => x.id === uid);
            if (!target) return;
            state.forcePwTarget = target;
            $("fp-title").textContent = `Force Reset Password • ${target.full_name}`;
            $("fp-subtitle").textContent = `@${target.username}`;
            $("fp-new-password").value = "";
            $("modal-force-password").classList.remove("hidden");
        };
    });

    document.querySelectorAll("[data-del-user]").forEach((btn) => {
        btn.onclick = async () => {
            try {
                await api("/api/admin/users/delete", "POST", { user_id: Number(btn.getAttribute("data-del-user")) });
                toast("User removed from Directory");
                await loadDirectoryPage();
            } catch (err) {
                toast(err.message, "err");
            }
        };
    });
}

function buildClientXlsxFallback(yearMonth, paramsObj) {
    const db = LocalDB.load();
    const ym = /^\d{4}-\d{2}$/.test(yearMonth || "") ? yearMonth : todayStr().slice(0, 7);

    const matchTree = (t) => {
        const b = db.blocks.find((x) => x.id === t.block_id);
        if (!b) return false;
        const f = db.fields.find((x) => x.id === b.field_id);
        if (!f) return false;
        const d = db.divisions.find((x) => x.id === f.division_id);
        if (!d) return false;
        if (paramsObj.tree_id && t.id !== Number(paramsObj.tree_id)) return false;
        if (paramsObj.block_id && b.id !== Number(paramsObj.block_id)) return false;
        if (paramsObj.field_id && f.id !== Number(paramsObj.field_id)) return false;
        if (paramsObj.division_id && d.id !== Number(paramsObj.division_id)) return false;
        if (paramsObj.estate_id && d.estate_id !== Number(paramsObj.estate_id)) return false;
        return true;
    };

    const grouped = new Map();
    for (const h of db.harvest || []) {
        const hYm = h.year_month || (h.harvest_date || "").slice(0, 7);
        if (hYm !== ym) continue;
        const t = db.trees.find((x) => x.id === h.tree_id);
        if (!t || !matchTree(t)) continue;
        const b = db.blocks.find((x) => x.id === t.block_id) || {};
        const f = db.fields.find((x) => x.id === b.field_id) || {};
        const d = db.divisions.find((x) => x.id === f.division_id) || {};
        const e = db.estates.find((x) => x.id === d.estate_id) || { name: "Uskvalley Estate" };

        if (!grouped.has(t.id)) {
            grouped.set(t.id, {
                estate_name: e.name || "Uskvalley Estate",
                division_name: d.name || "Uskvalley Division",
                field_name: f.name || "Field 1",
                block_name: b.name || "Block A",
                tree_number: t.tree_no,
                r1_bunches: 0,
                r1_fronds: 0,
                r2_bunches: 0,
                r2_fronds: 0,
                r3_bunches: 0,
                r3_fronds: 0,
            });
        }
        const entry = grouped.get(t.id);
        const rnd = Number(h.round_no) || roundOfDate(h.harvest_date).round;
        if (rnd === 1) {
            entry.r1_bunches += Number(h.bunches || 0);
            entry.r1_fronds += Number(h.fronds || 0);
        } else if (rnd === 2) {
            entry.r2_bunches += Number(h.bunches || 0);
            entry.r2_fronds += Number(h.fronds || 0);
        } else {
            entry.r3_bunches += Number(h.bunches || 0);
            entry.r3_fronds += Number(h.fronds || 0);
        }
    }

    const rows = Array.from(grouped.values()).sort((a, b) => a.tree_number - b.tree_number);
    const headers = [
        "Estate",
        "Division",
        "Field",
        "Block",
        "Tree Number",
        "R1 Bunches",
        "R1 Fronds",
        "R2 Bunches",
        "R2 Fronds",
        "R3 Bunches",
        "R3 Fronds",
        "Month Total Bunches",
        "Month Total Fronds",
    ];
    const cols = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M"];
    const rowXml = [];
    const hdrCells = headers.map((h, i) => `<c r="${cols[i]}1" t="inlineStr"><is><t>${esc(h)}</t></is></c>`).join("");
    rowXml.push(`<row r="1">${hdrCells}</row>`);

    rows.forEach((r, idx) => {
        const rNum = idx + 2;
        const totB = r.r1_bunches + r.r2_bunches + r.r3_bunches;
        const totF = r.r1_fronds + r.r2_fronds + r.r3_fronds;
        const textVals = [r.estate_name, r.division_name, r.field_name, r.block_name, `Palm #${r.tree_number}`];
        const intVals = [r.r1_bunches, r.r1_fronds, r.r2_bunches, r.r2_fronds, r.r3_bunches, r.r3_fronds];
        const cells = [];
        textVals.forEach((tv, ci) => cells.push(`<c r="${cols[ci]}${rNum}" t="inlineStr"><is><t>${esc(tv)}</t></is></c>`));
        intVals.forEach((iv, ci) => cells.push(`<c r="${cols[5 + ci]}${rNum}" t="n"><v>${iv}</v></c>`));
        cells.push(`<c r="L${rNum}" t="n"><f>F${rNum}+H${rNum}+J${rNum}</f><v>${totB}</v></c>`);
        cells.push(`<c r="M${rNum}" t="n"><f>G${rNum}+I${rNum}+K${rNum}</f><v>${totF}</v></c>`);
        rowXml.push(`<row r="${rNum}">${cells.join("")}</row>`);
    });

    const crc32 = (u8) => {
        let c = 0xffffffff;
        for (let i = 0; i < u8.length; i++) {
            c ^= u8[i];
            for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
        }
        return (c ^ 0xffffffff) >>> 0;
    };

    const enc = new TextEncoder();
    const files = [
        {
            name: "[Content_Types].xml",
            content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
        },
        {
            name: "_rels/.rels",
            content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        },
        {
            name: "xl/workbook.xml",
            content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Tree Matrix ${esc(ym)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        },
        {
            name: "xl/_rels/workbook.xml.rels",
            content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
        },
        {
            name: "xl/worksheets/sheet1.xml",
            content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml.join("")}</sheetData></worksheet>`,
        },
    ];

    const entries = files.map((f) => {
        const nameBytes = enc.encode(f.name);
        const dataBytes = enc.encode(f.content);
        return { nameBytes, dataBytes, crc: crc32(dataBytes), localOffset: 0 };
    });

    let localSize = 0;
    let cdSize = 0;
    entries.forEach((e) => {
        localSize += 30 + e.nameBytes.length + e.dataBytes.length;
        cdSize += 46 + e.nameBytes.length;
    });
    const out = new Uint8Array(localSize + cdSize + 22);
    const dv = new DataView(out.buffer);
    let offset = 0;

    entries.forEach((e) => {
        e.localOffset = offset;
        dv.setUint32(offset, 0x04034b50, true);
        dv.setUint16(offset + 4, 20, true);
        dv.setUint16(offset + 12, 0x21, true);
        dv.setUint32(offset + 14, e.crc, true);
        dv.setUint32(offset + 18, e.dataBytes.length, true);
        dv.setUint32(offset + 22, e.dataBytes.length, true);
        dv.setUint16(offset + 26, e.nameBytes.length, true);
        out.set(e.nameBytes, offset + 30);
        out.set(e.dataBytes, offset + 30 + e.nameBytes.length);
        offset += 30 + e.nameBytes.length + e.dataBytes.length;
    });

    const cdStart = offset;
    entries.forEach((e) => {
        dv.setUint32(offset, 0x02014b50, true);
        dv.setUint16(offset + 4, 20, true);
        dv.setUint16(offset + 6, 20, true);
        dv.setUint16(offset + 14, 0x21, true);
        dv.setUint32(offset + 16, e.crc, true);
        dv.setUint32(offset + 20, e.dataBytes.length, true);
        dv.setUint32(offset + 24, e.dataBytes.length, true);
        dv.setUint16(offset + 28, e.nameBytes.length, true);
        dv.setUint32(offset + 42, e.localOffset, true);
        out.set(e.nameBytes, offset + 46);
        offset += 46 + e.nameBytes.length;
    });

    dv.setUint32(offset, 0x06054b50, true);
    dv.setUint16(offset + 8, entries.length, true);
    dv.setUint16(offset + 10, entries.length, true);
    dv.setUint32(offset + 12, cdSize, true);
    dv.setUint32(offset + 16, cdStart, true);
    return new Blob([out], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
}
// ----------------------------------------------------------------------------
// Event Listeners & Initialization
// ----------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
    // Initialize persisted theme immediately
    applyTheme(state.theme, false);

    setInterval(updateClockAndGreeting, 1000);
    updateClockAndGreeting();
    updateGpsHeader();

    window.addEventListener("resize", () => {
        updateClockAndGreeting();
        updateGpsHeader();
    });

    const today = todayStr();
    const { round } = roundOfDate(today);
    if ($("harv-date")) $("harv-date").value = today;
    if ($("harv-round")) $("harv-round").value = String(round);
    if ($("disp-date")) $("disp-date").value = today;
    if ($("disp-round")) $("disp-round").value = String(round);

    // Handle Browser Back/Forward Navigation (/settings, /overview, etc.)
    window.addEventListener("popstate", () => {
        const route = getInitialRouteFromLocation();
        if (state.token) {
            switchPage(route, false);
        }
    });

    document.querySelectorAll("[data-toggle-pass]").forEach((btn) => {
        btn.onclick = () => {
            const inp = $(btn.getAttribute("data-toggle-pass"));
            if (inp) inp.type = inp.type === "password" ? "text" : "password";
        };
    });

    // Theme Engine Selection Cards
    document.querySelectorAll("[data-theme-select]").forEach((card) => {
        card.onclick = () => {
            const chosen = card.getAttribute("data-theme-select");
            applyTheme(chosen, true);
            const label = THEME_REGISTRY[chosen]?.name || chosen;
            toast(`Theme switched to ${label}`);
        };
    });

    if ($("btn-theme-quick")) {
        $("btn-theme-quick").onclick = () => switchPage("settings");
    }

    // Mobile Hamburger Drawer Controls
    if ($("btn-mobile-menu")) {
        $("btn-mobile-menu").onclick = () => {
            $("mobile-drawer")?.classList.remove("hidden");
            refreshIcons();
        };
    }
    if ($("btn-close-mobile-drawer")) {
        $("btn-close-mobile-drawer").onclick = closeMobileDrawer;
    }
    if ($("mobile-drawer-backdrop")) {
        $("mobile-drawer-backdrop").onclick = closeMobileDrawer;
    }

    // ERP Login Submit (Username + Password ONLY)
    $("form-login").onsubmit = async (e) => {
        e.preventDefault();
        await loginWithUsername($("login-username").value.trim(), $("login-password").value);
    };

    // Brand Logo Click -> Overview & Refresh
    const goHomeAndRefresh = async () => {
        switchPage("overview");
        await loadBootstrap();
        await refreshDashboard();
        toast("Overview refreshed");
    };
    if ($("btn-brand-home")) $("btn-brand-home").onclick = goHomeAndRefresh;
    if ($("btn-brand-home-mobile")) $("btn-brand-home-mobile").onclick = goHomeAndRefresh;

    // Quick Harvest CTA & Profile Rail CTA
    if ($("btn-quick-harvest")) $("btn-quick-harvest").onclick = () => switchPage("harvests");
    if ($("btn-feed-go-harvests")) $("btn-feed-go-harvests").onclick = () => switchPage("harvests");
    if ($("btn-rail-profile")) $("btn-rail-profile").onclick = () => switchPage("profile");

    // Logout
    if ($("btn-logout")) $("btn-logout").onclick = () => doLogout();
    if ($("btn-logout-mobile")) $("btn-logout-mobile").onclick = () => doLogout();
    if ($("btn-logout-drawer")) $("btn-logout-drawer").onclick = () => doLogout();

    // Live GPS Ping
    $("btn-gps-ping").onclick = async () => {
        const g = await requestBrowserGps(5000);
        if (g.ok && g.lat !== null && g.lng !== null) {
            toast(`GPS: ${g.lat.toFixed(5)}, ${g.lng.toFixed(5)} (±${Math.round(g.acc)}m)`);
        } else {
            toast("GPS weak — select tree manually");
        }
    };

    // Primary Navigation Rail, Mobile Drawer, and Mobile Bottom Bar
    document.querySelectorAll("[data-nav]").forEach((btn) => {
        btn.onclick = () => switchPage(btn.getAttribute("data-nav"));
    });

    // Overview Export (Monthly Tree-by-Tree 3-Round Matrix .xlsx) & Reset
    $("btn-dash-reset").onclick = () => initDashboardFilters();
    $("btn-export-pdf").onclick = () => window.print();
    if ($("btn-export-excel")) {
        $("btn-export-excel").onclick = async () => {
            const qs = getDashboardQuery();
            const qParams = new URLSearchParams(qs);
            const ym = qParams.get("year_month") || todayStr().slice(0, 7);
            const paramsObj = Object.fromEntries(qParams.entries());
            const headers = {};
            if (state.token) headers["Authorization"] = `Bearer ${state.token}`;

            let blob = null;
            for (const endpoint of [`/export/excel?${qs}`, `/api/export/excel?${qs}`, `/api/report.xlsx?${qs}`]) {
                try {
                    const res = await fetch(endpoint, { method: "GET", headers });
                    const ct = (res.headers.get("content-type") || "").toLowerCase();
                    if (res.ok && (ct.includes("spreadsheetml") || ct.includes("octet-stream") || ct.includes("excel"))) {
                        blob = await res.blob();
                        break;
                    }
                } catch (_) {}
            }

            if (!blob) {
                blob = buildClientXlsxFallback(ym, paramsObj);
            }

            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "Uskvalley_Harvest_Report.xlsx";
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            toast("Uskvalley_Harvest_Report.xlsx downloaded");
        };
    }

    // Twitter/X Edit Profile Modal Controls
    if ($("btn-open-edit-profile")) {
        $("btn-open-edit-profile").onclick = openEditProfileModal;
    }
    if ($("btn-ep-save-top")) {
        $("btn-ep-save-top").onclick = () => saveEditProfile();
    }
    if ($("form-edit-profile")) {
        $("form-edit-profile").onsubmit = (e) => {
            e.preventDefault();
            saveEditProfile();
        };
    }
    if ($("btn-ep-upload-avatar") && $("ep-avatar-input")) {
        $("btn-ep-upload-avatar").onclick = () => $("ep-avatar-input").click();
        $("ep-avatar-input").onchange = async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                state.editProfileDraft.profile_pic = await readImageFileAsDataUrl(file, 400, 400);
                syncEditProfileModalPreviews();
            } catch (err) {
                toast(err.message, "err");
            }
            e.target.value = "";
        };
    }
    if ($("btn-ep-remove-avatar")) {
        $("btn-ep-remove-avatar").onclick = () => {
            state.editProfileDraft.profile_pic = "";
            syncEditProfileModalPreviews();
        };
    }
    if ($("btn-ep-upload-cover") && $("ep-cover-input")) {
        $("btn-ep-upload-cover").onclick = () => $("ep-cover-input").click();
        $("ep-cover-input").onchange = async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                state.editProfileDraft.cover_photo = await readImageFileAsDataUrl(file, 1200, 480);
                syncEditProfileModalPreviews();
            } catch (err) {
                toast(err.message, "err");
            }
            e.target.value = "";
        };
    }
    if ($("btn-ep-remove-cover")) {
        $("btn-ep-remove-cover").onclick = () => {
            state.editProfileDraft.cover_photo = "";
            syncEditProfileModalPreviews();
        };
    }

    // Harvests Sub-Tabs (Palm Harvest Logger vs Mill Dispatch Weight)
    document.querySelectorAll("[data-harv-view]").forEach((btn) => {
        btn.onclick = () => {
            const v = btn.getAttribute("data-harv-view");
            state.harvestView = v;
            document.querySelectorAll("[data-harv-view]").forEach((b) => {
                const on = b === btn;
                b.className = `harv-view-tab py-3.5 px-2 text-xs truncate ${
                    on ? "font-extrabold border-b-2 border-[#0f1419] text-[#0f1419]" : "font-semibold border-b-2 border-transparent text-[#536471]"
                } hover:bg-[#f7f9f9] transition`;
            });
            $("harv-panel-trees").classList.toggle("hidden", v !== "trees");
            $("harv-panel-dispatch").classList.toggle("hidden", v !== "dispatch");
            if (v === "trees") loadHarvestBlock();
            else loadDispatches();
        };
    });

    // Harvest Controls & Smart GPS Auto-Detect
    $("harv-round").onchange = () => loadHarvestBlock();
    $("harv-date").onchange = () => loadHarvestBlock();

    if ($("harv-autodetect-toggle")) {
        $("harv-autodetect-toggle").checked = Boolean(state.autoDetectGps);
        $("harv-autodetect-toggle").onchange = (e) => {
            state.autoDetectGps = Boolean(e.target.checked);
            try {
                localStorage.setItem("elaeis_autodetect_gps", state.autoDetectGps ? "1" : "0");
            } catch (_) {}
            if (state.autoDetectGps) {
                autoDetectNearestTree({ openModal: false });
            }
        };
    }

    if ($("btn-harv-autodetect")) {
        $("btn-harv-autodetect").onclick = () => autoDetectNearestTree({ openModal: true });
    }
    if ($("btn-mh-autodetect")) {
        $("btn-mh-autodetect").onclick = () => autoDetectNearestTree({ openModal: true });
    }

    if ($("harv-tree-select")) {
        $("harv-tree-select").onchange = (e) => {
            const tid = Number(e.target.value);
            if (!tid) return;
            state.harvBlock.manualOverride = true;
            state.harvBlock.selectedTreeId = tid;
            openHarvestModal(tid);
        };
    }

    const openTypedTreeForHarvest = () => {
        const rawNo = ($("harv-search")?.value || "").trim();
        const trees = state.harvBlock.trees || [];
        if (rawNo) {
            const match = trees.find((t) => t.tree_no === Number(rawNo));
            if (!match) {
                return toast(`Palm #${rawNo} not found in current block.`, "err");
            }
            state.harvBlock.manualOverride = true;
            state.harvBlock.selectedTreeId = match.id;
            openHarvestModal(match.id);
        } else if (state.harvBlock.selectedTreeId) {
            state.harvBlock.manualOverride = true;
            openHarvestModal(state.harvBlock.selectedTreeId);
        } else if (trees[0]) {
            openHarvestModal(trees[0].id);
        }
    };

    $("harv-search").oninput = (e) => {
        state.harvBlock.search = e.target.value;
        const typedNo = Number(e.target.value);
        if (typedNo) {
            const match = (state.harvBlock.trees || []).find((t) => t.tree_no === typedNo);
            if (match) {
                state.harvBlock.manualOverride = true;
                state.harvBlock.selectedTreeId = match.id;
                if ($("harv-tree-select")) $("harv-tree-select").value = String(match.id);
            }
        }
        renderHarvestGrid();
    };
    $("harv-search").onkeydown = (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            openTypedTreeForHarvest();
        }
    };
    if ($("btn-harv-log-typed")) {
        $("btn-harv-log-typed").onclick = openTypedTreeForHarvest;
    }

    // Manual Override controls inside Log Harvest Modal
    if ($("mh-block")) {
        $("mh-block").onchange = async (e) => {
            const nextBid = Number(e.target.value);
            if (!nextBid) return;
            state.harvBlock.manualOverride = true;
            const prevTreeNo = Number($("mh-tree-no")?.value) || 1;
            await selectHarvestBlockCascade(nextBid);
            const target =
                state.harvBlock.trees.find((t) => t.tree_no === prevTreeNo) || state.harvBlock.trees[0];
            if (target) {
                populateHarvestTreeDropdowns(target.id);
                populateHarvestModalFields(target);
            }
        };
    }
    if ($("mh-tree-select")) {
        $("mh-tree-select").onchange = (e) => {
            const tid = Number(e.target.value);
            const target = (state.harvBlock.trees || []).find((t) => t.id === tid);
            if (target) {
                state.harvBlock.manualOverride = true;
                populateHarvestModalFields(target);
            }
        };
    }
    if ($("mh-tree-no")) {
        $("mh-tree-no").oninput = (e) => {
            const tno = Number(e.target.value);
            if (!tno) return;
            const target = (state.harvBlock.trees || []).find((t) => t.tree_no === tno);
            if (target) {
                state.harvBlock.manualOverride = true;
                populateHarvestModalFields(target);
            }
        };
    }
    if ($("btn-mh-sync-gps")) {
        $("btn-mh-sync-gps").onclick = () => syncCalibrationInputsToMyLocation("mh-cal-lat", "mh-cal-lng");
    }
    if ($("btn-mh-save-pin")) {
        $("btn-mh-save-pin").onclick = () => saveHarvestModalPinCalibration(false);
    }

    document.querySelectorAll(".harv-flt-btn").forEach((btn) => {
        btn.onclick = () => {
            state.harvBlock.filter = btn.getAttribute("data-harv-filter");
            document.querySelectorAll(".harv-flt-btn").forEach((b) => {
                b.className = `harv-flt-btn px-3 py-1 rounded-full ${
                    b === btn ? "bg-[#0f1419] text-white" : "text-[#536471]"
                }`;
            });
            renderHarvestGrid();
        };
    });
    $("btn-submit-harvest").onclick = () => submitHarvestModal();

    // Dispatch Crop Weight Form Submit
    $("form-dispatch").onsubmit = async (e) => {
        e.preventDefault();
        const btn = $("btn-submit-dispatch");
        btn.disabled = true;
        try {
            const round_no = Number($("disp-round").value);
            const date = $("disp-date").value || todayStr();
            const division_id = Number($("disp-division").value);
            const weight_kg = Number($("disp-weight").value);
            await api("/api/dispatch", "POST", { round_no, date, division_id, weight_kg });
            $("disp-weight").value = "";
            toast(`Dispatch weight logged (${weight_kg.toLocaleString()} kg • R${round_no})`);
            await loadDispatches();
        } catch (err) {
            toast(err.message, "err");
        } finally {
            btn.disabled = false;
        }
    };

    // Stepper buttons (+/-)
    document.querySelectorAll("[data-step]").forEach((btn) => {
        btn.onclick = () => {
            const [id, delta] = btn.getAttribute("data-step").split(":");
            const inp = $(id);
            if (!inp) return;
            inp.value = Math.max(0, Math.min(60, (Number(inp.value) || 0) + Number(delta)));
        };
    });

    // Dedicated Full-Screen GIS Map Controls & Filters
    if ($("btn-mapview-full")) {
        $("btn-mapview-full").onclick = () => {
            if ($("mapview-division")) $("mapview-division").value = "";
            initGisMapFilters();
            state.gisMap.isolate = false;
            applyGisTreeIsolationAndStats();
            fitGisMapToActiveSelection(true);
        };
    }

    if ($("btn-mapview-isolate")) {
        $("btn-mapview-isolate").onclick = () => {
            const { hasAreaFilter } = getGisActiveScopeMeta();
            if (!hasAreaFilter && !state.gisMap.isolate) {
                toast("Select a Division, Field, or Block to isolate");
                return;
            }
            state.gisMap.isolate = !state.gisMap.isolate;
            applyGisTreeIsolationAndStats();
            fitGisMapToActiveSelection(true);
        };
    }

    if ($("btn-mapview-basemap")) {
        $("btn-mapview-basemap").onclick = () => {
            const map = state.gisMap.map;
            if (!map) return;
            const nextMode = state.gisMap.basemapMode === "satellite" ? "clean" : "satellite";
            state.gisMap.basemapMode = nextMode;
            if (nextMode === "clean") {
                if (state.gisMap.satelliteLayer) map.removeLayer(state.gisMap.satelliteLayer);
                syncGisCleanBasemapLayer();
            } else {
                if (state.gisMap.cleanLayer) map.removeLayer(state.gisMap.cleanLayer);
                if (state.gisMap.satelliteLayer) state.gisMap.satelliteLayer.addTo(map);
            }
            $("btn-mapview-basemap").classList.toggle("active", nextMode === "satellite");
            if ($("lbl-mapview-basemap")) {
                $("lbl-mapview-basemap").textContent = nextMode === "satellite" ? "Satellite" : "Clean Map";
            }
            renderGisBoundariesAndLabels();
        };
    }

    if ($("btn-mapview-boundaries")) {
        $("btn-mapview-boundaries").onclick = () => {
            state.gisMap.showBoundaries = !state.gisMap.showBoundaries;
            $("btn-mapview-boundaries").classList.toggle("active", state.gisMap.showBoundaries);
            renderGisBoundariesAndLabels();
        };
    }

    if ($("btn-mapview-labels")) {
        $("btn-mapview-labels").onclick = () => {
            state.gisMap.showLabels = !state.gisMap.showLabels;
            $("btn-mapview-labels").classList.toggle("active", state.gisMap.showLabels);
            renderGisBoundariesAndLabels();
        };
    }

    if ($("mapview-time-mode")) {
        const syncMapTimeInputs = () => {
            const mode = $("mapview-time-mode").value;
            $("mapview-season")?.classList.toggle("hidden", mode !== "season");
            $("mapview-year")?.classList.toggle("hidden", mode !== "year");
            $("mapview-month")?.classList.toggle("hidden", mode !== "month");
            $("mapview-custom-dates")?.classList.toggle("hidden", mode !== "custom");
            refreshGisMapData(false);
        };
        $("mapview-time-mode").onchange = syncMapTimeInputs;
    }
    ["mapview-season", "mapview-year", "mapview-month", "mapview-from", "mapview-to", "mapview-round"].forEach((id) => {
        if ($(id)) $(id).onchange = () => refreshGisMapData(false);
    });

    if ($("btn-mapview-download")) {
        $("btn-mapview-download").onclick = (e) => {
            e.stopPropagation();
            $("mapview-download-menu")?.classList.toggle("hidden");
        };
    }
    document.addEventListener("click", (e) => {
        const wrap = $("mapview-download-wrap");
        const menu = $("mapview-download-menu");
        if (menu && !menu.classList.contains("hidden") && wrap && !wrap.contains(e.target)) {
            menu.classList.add("hidden");
        }
    });
    if ($("btn-mapview-dl-png")) {
        $("btn-mapview-dl-png").onclick = () => {
            $("mapview-download-menu")?.classList.add("hidden");
            downloadGisMapPng();
        };
    }
    if ($("btn-mapview-dl-kml")) {
        $("btn-mapview-dl-kml").onclick = () => {
            $("mapview-download-menu")?.classList.add("hidden");
            exportGisMapKml();
        };
    }

    // Estates Sub-Tabs (5-Tier Hierarchy & GPS Tree Mapper)
    document.querySelectorAll("[data-est-tab]").forEach((btn) => {
        btn.onclick = () => {
            const tab = btn.getAttribute("data-est-tab");
            state.estatesTab = tab;
            document.querySelectorAll("[data-est-tab]").forEach((b) => {
                const on = b === btn;
                b.className = `est-tab-btn py-3.5 px-2 text-xs truncate ${
                    on ? "font-extrabold border-b-2 border-[#0f1419] text-[#0f1419]" : "font-semibold border-b-2 border-transparent text-[#536471]"
                } hover:bg-[#f7f9f9] transition`;
            });
            $("est-panel-hierarchy").classList.toggle("hidden", tab !== "hierarchy");
            $("est-panel-mapper").classList.toggle("hidden", tab !== "mapper");
            if (tab === "mapper") loadMapperBlock();
        };
    });

    // Mapper Controls ("Sync to My Location" & Save Coordinates)
    $("btn-mapper-add-tree").onclick = () => openMapperModal(null);
    $("btn-mp-capture").onclick = () => syncCalibrationInputsToMyLocation("mp-lat", "mp-lng");
    $("btn-mp-save").onclick = () => saveMapperModal();
    $("btn-mp-delete").onclick = () => deleteMapperTree();

    // Estates Hierarchy CRUD
    $("btn-add-estate").onclick = () => openCrudModal("estate");
    $("btn-add-division").onclick = () => openCrudModal("division");
    $("btn-add-field").onclick = () => openCrudModal("field");
    $("btn-add-block").onclick = () => openCrudModal("block");

    $("btn-ac-save").onclick = async () => {
        if (!state.crudCallback) return;
        try {
            await state.crudCallback();
            $("modal-admin-crud").classList.add("hidden");
            toast("Estate hierarchy updated");
            await loadEstatesPage();
            await loadBootstrap();
        } catch (err) {
            toast(err.message, "err");
        }
    };

    $("btn-save-settings").onclick = async () => {
        try {
            await api("/api/admin/settings", "POST", {
                season_start_month: Number($("set-season-month").value),
            });
            toast("Estate parameters saved");
            await loadEstatesPage();
        } catch (err) {
            toast(err.message, "err");
        }
    };

    // Directory: Create User & Master Admin Force-Reset Password
    $("btn-open-create-user").onclick = () => $("modal-create-user").classList.remove("hidden");
    $("form-create-user").onsubmit = async (e) => {
        e.preventDefault();
        try {
            const res = await api("/api/admin/users/create", "POST", {
                username: $("cu-username").value.trim(),
                full_name: $("cu-fullname").value.trim(),
                role: $("cu-role").value,
                password: $("cu-password").value,
            });
            $("form-create-user").reset();
            $("modal-create-user").classList.add("hidden");
            toast(res.message || "ERP user created");
            await loadDirectoryPage();
        } catch (err) {
            toast(err.message, "err");
        }
    };

    $("btn-confirm-force-password").onclick = async () => {
        if (!state.forcePwTarget) return;
        const new_password = $("fp-new-password").value;
        if (new_password.length < 6) return toast("Password must be at least 6 characters.", "err");
        try {
            const res = await api("/api/admin/users/force-password", "POST", {
                user_id: state.forcePwTarget.id,
                new_password,
            });
            $("modal-force-password").classList.add("hidden");
            toast(res.message || `Password updated for @${state.forcePwTarget.username}`);
        } catch (err) {
            toast(err.message, "err");
        }
    };

    // Profile: Self Password Change
    $("form-profile-password").onsubmit = async (e) => {
        e.preventDefault();
        const current_password = $("prof-cur-password").value;
        const new_password = $("prof-new-password").value;
        const confirm_password = $("prof-confirm-password").value;
        if (new_password !== confirm_password) return toast("New passwords do not match.", "err");
        try {
            const res = await api("/api/auth/change-password", "POST", {
                current_password,
                new_password,
            });
            $("form-profile-password").reset();
            toast(res.message || "Password updated successfully");
        } catch (err) {
            toast(err.message, "err");
        }
    };

    // Modal close buttons
    document.querySelectorAll("[data-close-modal]").forEach((btn) => {
        btn.onclick = () => $(btn.getAttribute("data-close-modal")).classList.add("hidden");
    });

    // Boot
    if (state.token) {
        enterApplication();
    } else {
        showAuthScreen();
    }
});

async function doLogout() {
    closeMobileDrawer();
    try {
        await api("/api/auth/logout", "POST");
    } catch (_) {}
    state.token = "";
    state.user = null;
    localStorage.removeItem("el_token");
    showAuthScreen();
}
