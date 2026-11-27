// ============================================================================
// ELAEIS — Core State, Constants, Dynamic Estate Helpers & UI Utilities
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

const VALID_HEALTH_STATUSES = [
    "Healthy",
    "Ganoderma / Disease",
    "Nutrient Deficient",
    "Pest / Rhinoceros",
    "Fallen / Vacant",
];

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
    twitter: { id: "twitter", name: "Default", short: "Default" },
    "dracula-dark": { id: "dracula-dark", name: "Dracula Dark", short: "Dracula Dark" },
    "dracula-light": { id: "dracula-light", name: "Dracula Light", short: "Dracula Light" },
    nord: { id: "nord", name: "Nord", short: "Nord" },
};

// Lightweight inline SVG icons for high-speed 2D palm grids (avoids 600+ Lucide re-parses)
const INLINE_SVG_PALM = `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8c0-2.76-2.46-5-5.5-5S2 5.24 2 8h2l1-1 1 1h4"/><path d="M13 7.14A5.82 5.82 0 0 1 16.5 6c3.04 0 5.5 2.24 5.5 5h-3l-1-1-1 1h-3"/><path d="M5.89 9.71c-2.15 2.15-2.3 5.47-.35 7.43l4.24-4.25.7-.7.71-.71 2.12-2.12c-1.95-1.96-5.27-1.8-7.42.35"/><path d="M11 15.5c.5 2.5-.17 4.5-1 6.5h4c2-5.5-.5-12-1-14"/></svg>`;
const INLINE_SVG_CHECK = `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`;
const INLINE_SVG_PIN = `<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>`;

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
    activeEstateId: Number(localStorage.getItem("elaeis_active_estate_id")) || null,
    harvestView: "trees",
    estatesTab: "hierarchy",
    online: typeof navigator !== "undefined" ? navigator.onLine !== false : true,
    syncing: false,
    pendingSyncCount: 0,
    gps: { lat: null, lng: null, acc: null, live: false, timestamp: 0 },
    autoDetectGps: localStorage.getItem("elaeis_autodetect_gps") === "1",
    hierarchy: { estates: [], divisions: [], fields: [], blocks: [] },
    mappedTrees: [],
    settings: { season_start_month: 4 },
    dashTrees: [],
    recentLogs: [],
    agronomy: null,
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
        basemapMode: "satellite",
        showBoundaries: true,
        showLabels: true,
        isolate: false,
        allTrees: [],
        visibleTrees: [],
        unmappedCount: 0,
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
// DOM & Formatting Utilities
// ----------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const esc = (s) =>
    String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

function generateClientId(prefix = "op") {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return `${prefix}-${crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

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

function formatShortDateLabel(isoDateStr) {
    if (!isoDateStr || isoDateStr.length < 10) return isoDateStr || "";
    const [y, m, d] = isoDateStr.split("-").map(Number);
    const dt = new Date(y, (m || 1) - 1, d || 1);
    return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatMonthYearLabel(ymStr) {
    if (!ymStr || ymStr.length < 7) return ymStr || "";
    const [y, m] = ymStr.split("-").map(Number);
    const dt = new Date(y, (m || 1) - 1, 1);
    return dt.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

// ----------------------------------------------------------------------------
// Dynamic Estate Helpers (Zero Hardcoded Estate Names Anywhere in UI)
// ----------------------------------------------------------------------------
function getActiveEstate() {
    const estates = state.hierarchy.estates || [];
    if (!estates.length) return null;
    if (state.activeEstateId) {
        const match = estates.find((e) => e.id === Number(state.activeEstateId));
        if (match) return match;
    }
    return estates[0];
}

function getActiveEstateName() {
    return getActiveEstate()?.name || "Plantation Estate";
}

function getEstateSlug(name = null) {
    const raw = String(name || getActiveEstateName() || "Elaeis")
        .trim()
        .replace(/[^A-Za-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 48);
    return raw || "Elaeis";
}

function setActiveEstateId(estateId) {
    state.activeEstateId = estateId ? Number(estateId) : null;
    try {
        if (state.activeEstateId) localStorage.setItem("elaeis_active_estate_id", String(state.activeEstateId));
        else localStorage.removeItem("elaeis_active_estate_id");
    } catch (_) {}
}

function populateDynamicYearSelect(selectId, mode = "season") {
    const el = $(selectId);
    if (!el) return;
    const curYear = new Date().getFullYear();
    const prevVal = el.value;
    const years = [];
    for (let y = curYear + 1; y >= curYear - 4; y--) {
        years.push(y);
    }
    el.innerHTML = years
        .map((y) => {
            const label = mode === "season" ? `${y}/${String(y + 1).slice(2)} Season` : `Year ${y}`;
            return `<option value="${y}">${label}</option>`;
        })
        .join("");
    el.value = years.includes(Number(prevVal)) ? prevVal : String(curYear);
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
    }, 3400);
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

    if (persistRemote && state.token && state.online && typeof api === "function") {
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
