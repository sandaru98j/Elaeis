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
    estates: "Estates",
    directory: "Directory",
    profile: "Profile",
    settings: "Settings",
    info: "Info",
};

const THEME_REGISTRY = {
    twitter: {
        id: "twitter",
        name: "Twitter / X (Default)",
        short: "Twitter/X",
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
    gps: { lat: 6.14224, lng: 80.36518, acc: 4.2, live: false },
    hierarchy: { estates: [], divisions: [], fields: [], blocks: [] },
    settings: { gps_threshold_m: 20, season_start_month: 4 },
    dashTrees: [],
    recentLogs: [],
    harvBlock: { block_id: null, trees: [], filter: "all", search: "" },
    dispatches: [],
    mapBlock: { block_id: null, trees: [] },
    compliance: { threshold_m: 20, rows: [], filter: "all" },
    adminUsers: { users: [] },
    profileActivity: [],
    editProfileDraft: { profile_pic: "", cover_photo: "" },
    modalTree: null,
    forcePwTarget: null,
    crudCallback: null,
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
    const R = 6371000;
    const rad = (x) => (x * Math.PI) / 180;
    const dLat = rad(lat2 - lat1);
    const dLng = rad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(a)) * 10) / 10;
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
// Silent Background Phone GPS Capture
// ----------------------------------------------------------------------------
function captureDeviceGps(targetTree = null) {
    return new Promise((resolve) => {
        if (!navigator.geolocation) {
            resolve(fallbackGps(targetTree));
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                state.gps = {
                    lat: Number(pos.coords.latitude.toFixed(6)),
                    lng: Number(pos.coords.longitude.toFixed(6)),
                    acc: Math.round((pos.coords.accuracy || 5) * 10) / 10,
                    live: true,
                };
                updateGpsHeader();
                resolve(state.gps);
            },
            () => {
                resolve(fallbackGps(targetTree));
            },
            { enableHighAccuracy: true, timeout: 3500, maximumAge: 15000 }
        );
    });
}

function fallbackGps(targetTree = null) {
    if (targetTree && targetTree.lat !== null && targetTree.lng !== null) {
        const jitterLat = (Math.random() - 0.5) * 0.00004;
        const jitterLng = (Math.random() - 0.5) * 0.00004;
        return {
            lat: Number((Number(targetTree.lat) + jitterLat).toFixed(6)),
            lng: Number((Number(targetTree.lng) + jitterLng).toFixed(6)),
            acc: 4.5,
            live: false,
        };
    }
    return {
        lat: Number((state.gps.lat + (Math.random() - 0.5) * 0.00005).toFixed(6)),
        lng: Number((state.gps.lng + (Math.random() - 0.5) * 0.00005).toFixed(6)),
        acc: 4.8,
        live: false,
    };
}

function updateGpsHeader() {
    const dot = $("gps-dot");
    const lbl = $("gps-label");
    if (!dot || !lbl) return;
    dot.className = `w-2 h-2 rounded-full shrink-0 ${state.gps.live ? "bg-[#00ba7c] animate-pulse" : "bg-[#00ba7c]"}`;
    const isMobile = typeof window !== "undefined" && window.innerWidth <= 768;
    const decimals = isMobile ? 3 : 4;
    lbl.textContent = `${state.gps.lat.toFixed(decimals)}, ${state.gps.lng.toFixed(decimals)}`;
}

// ----------------------------------------------------------------------------
// Offline / Local Fallback Store (Mirrors Python SQLite & Cloudflare D1)
// ----------------------------------------------------------------------------
const LocalDB = {
    key: "elaeis_erp_db_v5",
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
        const counts = [285, 268, 312, 294, 320, 305, 290, 264, 248, 240, 308, 282, 274, 296, 265, 258, 301, 277, 289, 252];
        const blocks = [];
        const trees = [];
        let bid = 0;
        let tid = 0;
        for (const f of fields) {
            for (const [bname, note] of [["Block A", "Valley stream boundary"], ["Block B", "Ridge road boundary"]]) {
                bid++;
                const total = counts[bid - 1] || 260;
                blocks.push({ id: bid, field_id: f.id, name: bname, boundary_note: note });
                for (let n = 1; n <= total; n++) {
                    tid++;
                    const mapped = bid === 1 && n <= 150;
                    trees.push({
                        id: tid,
                        block_id: bid,
                        tree_no: n,
                        lat: mapped ? Number((6.142 + Math.floor((n - 1) / 10) * 0.00008).toFixed(6)) : null,
                        lng: mapped ? Number((80.365 + ((n - 1) % 10) * 0.00008).toFixed(6)) : null,
                        gps_acc: mapped ? 3.8 : null,
                        status: "active",
                        mapped_at: mapped ? now : null,
                    });
                }
            }
        }
        const harvest = [
            { id: 1, tree_id: 1, harvest_date: `${yearMonth}-04`, year_month: yearMonth, round_no: 1, bunches: 12, fronds: 8, user_id: 8, user_lat: 6.14202, user_lng: 80.36501, user_acc: 4.1, recorded_at: now },
            { id: 2, tree_id: 2, harvest_date: `${yearMonth}-04`, year_month: yearMonth, round_no: 1, bunches: 10, fronds: 7, user_id: 8, user_lat: 6.14203, user_lng: 80.36506, user_acc: 3.9, recorded_at: now },
            { id: 3, tree_id: 3, harvest_date: `${yearMonth}-05`, year_month: yearMonth, round_no: 1, bunches: 14, fronds: 9, user_id: 9, user_lat: 6.14242, user_lng: 80.36551, user_acc: 6.2, recorded_at: now },
            { id: 4, tree_id: 4, harvest_date: `${yearMonth}-05`, year_month: yearMonth, round_no: 1, bunches: 11, fronds: 8, user_id: 3, user_lat: 6.14201, user_lng: 80.36526, user_acc: 3.5, recorded_at: now },
            { id: 5, tree_id: 5, harvest_date: today, year_month: yearMonth, round_no: round, bunches: 15, fronds: 10, user_id: 8, user_lat: 6.14202, user_lng: 80.36534, user_acc: 4.0, recorded_at: now },
            { id: 6, tree_id: 6, harvest_date: today, year_month: yearMonth, round_no: round, bunches: 9, fronds: 6, user_id: 9, user_lat: 6.14275, user_lng: 80.36492, user_acc: 8.0, recorded_at: now },
            { id: 7, tree_id: 121, harvest_date: today, year_month: yearMonth, round_no: round, bunches: 16, fronds: 10, user_id: 3, user_lat: 6.14297, user_lng: 80.36501, user_acc: 3.2, recorded_at: now },
        ];
        const dispatch = [
            { id: 1, division_id: 1, dispatch_date: `${yearMonth}-05`, year_month: yearMonth, round_no: 1, weight_kg: 895.0, user_id: 3, recorded_at: now },
            { id: 2, division_id: 1, dispatch_date: today, year_month: yearMonth, round_no: round, weight_kg: 1480.0, user_id: 3, recorded_at: now },
            { id: 3, division_id: 2, dispatch_date: today, year_month: yearMonth, round_no: round, weight_kg: 640.0, user_id: 4, recorded_at: now },
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
            settings: { gps_threshold_m: 20, season_start_month: 4 },
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
        return {
            hierarchy: { estates: db.estates, divisions: db.divisions, fields: db.fields, blocks },
            settings: db.settings,
        };
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
        const { yearMonth, round } = roundOfDate(body.date, body.round_no);
        const idx = db.harvest.findIndex((h) => h.tree_id === t.id && h.year_month === yearMonth && h.round_no === round);
        const row = {
            id: idx >= 0 ? db.harvest[idx].id : db.harvest.length + 1,
            tree_id: t.id,
            harvest_date: body.date,
            year_month: yearMonth,
            round_no: round,
            bunches: Number(body.bunches),
            fronds: Number(body.fronds),
            user_id: curUser.id,
            user_lat: body.lat,
            user_lng: body.lng,
            user_acc: body.acc,
            recorded_at: new Date().toISOString(),
        };
        if (idx >= 0) db.harvest[idx] = row;
        else db.harvest.push(row);
        LocalDB.save(db);
        const dist = t.lat !== null && body.lat !== null ? distanceMeters(t.lat, t.lng, body.lat, body.lng) : null;
        return { ok: true, round, distance_m: dist };
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
    if (pathname === "/api/admin/compliance") {
        const rows = [];
        db.harvest.forEach((r) => {
            const t = db.trees.find((x) => x.id === r.tree_id) || {};
            const b = db.blocks.find((x) => x.id === t.block_id) || {};
            const f = db.fields.find((x) => x.id === b.field_id) || {};
            const d = db.divisions.find((x) => x.id === f.division_id) || {};
            const u = db.users.find((x) => x.id === r.user_id) || { full_name: "Staff", role: "Harvester" };
            let distance_m = null;
            let status = "ok";
            if (r.user_lat === null) status = "no_gps";
            else if (t.lat === null) status = "unmapped";
            else {
                distance_m = distanceMeters(t.lat, t.lng, r.user_lat, r.user_lng);
                status = distance_m > db.settings.gps_threshold_m ? "far" : "ok";
            }
            rows.push({
                id: r.id,
                work_date: r.harvest_date,
                user_lat: r.user_lat,
                user_lng: r.user_lng,
                user_acc: r.user_acc,
                full_name: u.full_name,
                tree_no: t.tree_no,
                tree_lat: t.lat,
                tree_lng: t.lng,
                block: b.name,
                field: f.name,
                division: d.name,
                detail: `${r.bunches} Bunches / ${r.fronds} Fronds (R${r.round_no})`,
                distance_m,
                status,
            });
        });
        return { threshold_m: db.settings.gps_threshold_m, rows: rows.reverse() };
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
        db.settings.gps_threshold_m = Number(body.gps_threshold_m) || 20;
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
                No harvest activity logged under your account yet. Use <strong>Log Harvest</strong> to record palm yields.
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
    state.settings = data.settings;

    if ($("set-diag-gps")) {
        $("set-diag-gps").textContent = `${state.settings.gps_threshold_m || 20} meters`;
    }

    initDashboardFilters();
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
// VIEW 2: HARVESTS (Palm Harvest Logger + Mill Dispatch Weight)
// ----------------------------------------------------------------------------
async function loadHarvestBlock() {
    const bid = Number($("harv-block")?.value);
    if (!bid) return;
    const date = $("harv-date").value || todayStr();
    const roundNo = Number($("harv-round").value) || roundOfDate(date).round;
    const { rangeLabel } = roundOfDate(date, roundNo);
    $("harv-auto-meta").textContent = `Round ${roundNo} (${rangeLabel}) • ${date}`;

    const data = await api(`/api/block?block_id=${bid}&mode=harvest&date=${date}&round_no=${roundNo}`);
    state.harvBlock.block_id = bid;
    state.harvBlock.trees = data.trees || [];
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
            const gpsBadge =
                t.lat !== null
                    ? `<span class="w-1.5 h-1.5 rounded-full ${done ? "bg-[#00ba7c]" : "bg-[#0f1419]"}" title="GPS Mapped"></span>`
                    : "";
            return `
            <div data-harv-tree="${t.id}" class="palm-card ${done ? "done-harvest" : ""}">
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
        card.onclick = () => openHarvestModal(Number(card.getAttribute("data-harv-tree")));
    });
    refreshIcons();
}

function openHarvestModal(treeId) {
    const tree = state.harvBlock.trees.find((t) => t.id === treeId);
    if (!tree) return;
    state.modalTree = tree;
    const date = $("harv-date").value || todayStr();
    const roundNo = Number($("harv-round").value) || roundOfDate(date).round;
    const { rangeLabel } = roundOfDate(date, roundNo);
    $("mh-tree-badge").textContent = `#${tree.tree_no}`;
    $("mh-title").textContent = `Palm #${tree.tree_no}`;
    $("mh-sub").textContent = `Round ${roundNo} (${rangeLabel}) • ${date}`;
    $("mh-bunches").value = tree.rec ? tree.rec.bunches : 0;
    $("mh-fronds").value = tree.rec ? tree.rec.fronds : 0;
    $("modal-harvest").classList.remove("hidden");
}

async function submitHarvestModal() {
    const tree = state.modalTree;
    if (!tree) return;
    const btn = $("btn-submit-harvest");
    btn.disabled = true;
    try {
        const gps = await captureDeviceGps(tree);
        const date = $("harv-date").value || todayStr();
        const round_no = Number($("harv-round").value) || roundOfDate(date).round;
        const bunches = Number($("mh-bunches").value) || 0;
        const fronds = Number($("mh-fronds").value) || 0;
        const res = await api("/api/harvest", "POST", {
            tree_id: tree.id,
            round_no,
            date,
            bunches,
            fronds,
            lat: gps.lat,
            lng: gps.lng,
            acc: gps.acc,
        });
        $("modal-harvest").classList.add("hidden");
        const distMsg = res.distance_m !== null && res.distance_m !== undefined ? ` • ${res.distance_m}m` : "";
        toast(`Harvest logged (Palm #${tree.tree_no}: ${bunches}B / ${fronds}F${distMsg})`);
        await loadHarvestBlock();
    } catch (err) {
        toast(err.message, "err");
    } finally {
        btn.disabled = false;
    }
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
// VIEW 3: ESTATES (5-Tier Plantation Hierarchy + GPS Mapper + GPS Compliance)
// ----------------------------------------------------------------------------
async function loadEstatesPage() {
    const boot = await api("/api/bootstrap");
    state.hierarchy = boot.hierarchy;
    state.settings = boot.settings;

    $("set-gps-thresh").value = state.settings.gps_threshold_m || 20;
    $("set-season-month").value = state.settings.season_start_month || 4;

    renderAdminHierarchy();
    if (state.estatesTab === "mapper") await loadMapperBlock();
    if (state.estatesTab === "compliance") await loadCompliance();
    refreshIcons();
}

async function loadMapperBlock() {
    const bid = Number($("map-block")?.value);
    if (!bid) return;
    const data = await api(`/api/block?block_id=${bid}&mode=map`);
    state.mapBlock.block_id = bid;
    state.mapBlock.trees = data.trees || [];
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

    if (existing && existing.lat !== null) {
        $("mp-lat").value = existing.lat;
        $("mp-lng").value = existing.lng;
    } else {
        const gps = await captureDeviceGps();
        $("mp-lat").value = gps.lat;
        $("mp-lng").value = gps.lng;
    }
    $("modal-mapper").classList.remove("hidden");
}

async function saveMapperModal() {
    const bid = state.mapBlock.block_id;
    if (!bid) return;
    try {
        await api("/api/admin/tree/save", "POST", {
            id: state.modalTree?.id || null,
            block_id: bid,
            tree_no: Number($("mp-tree-no").value),
            lat: Number($("mp-lat").value),
            lng: Number($("mp-lng").value),
            acc: state.gps.acc || 4.0,
            status: "active",
        });
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
        $("modal-mapper").classList.add("hidden");
        toast(`Deleted Palm #${state.modalTree.tree_no}`);
        await loadMapperBlock();
    } catch (err) {
        toast(err.message, "err");
    }
}

async function loadCompliance() {
    const data = await api("/api/admin/compliance");
    state.compliance.threshold_m = data.threshold_m || 20;
    state.compliance.rows = data.rows || [];
    $("comp-thresh-label").textContent = `${state.compliance.threshold_m}m`;
    renderComplianceTable();
}

function renderComplianceTable() {
    const rows = state.compliance.rows;
    const okCount = rows.filter((r) => r.status === "ok").length;
    const farCount = rows.filter((r) => r.status === "far").length;
    $("comp-count-all").textContent = rows.length;
    $("comp-count-ok").textContent = okCount;
    $("comp-count-far").textContent = farCount;

    const flt = state.compliance.filter;
    const list = rows.filter((r) => {
        if (flt === "far") return r.status === "far";
        if (flt === "ok") return r.status === "ok";
        return true;
    });

    const tbody = $("comp-tbody");
    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-[#536471]">No GPS compliance logs match filter</td></tr>`;
        return;
    }

    tbody.innerHTML = list
        .map((r, idx) => {
            const isFar = r.status === "far";
            const badge = isFar
                ? `<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-[#f4212e] text-white font-mono-code font-bold text-[11px]">
                       <i data-lucide="alert-triangle" class="w-3 h-3"></i> ${r.distance_m}m
                   </span>`
                : r.status === "ok"
                ? `<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-[#0f1419] text-white font-mono-code font-bold text-[11px]">
                       <i data-lucide="check" class="w-3 h-3"></i> ${r.distance_m}m
                   </span>`
                : `<span class="px-2 py-0.5 rounded-full bg-[#f7f9f9] text-[#536471] font-mono-code text-[11px]">${esc(r.status)}</span>`;

            return `
            <tr data-comp-idx="${idx}" class="cursor-pointer ${isFar ? "row-flagged" : "hover:bg-[#f7f9f9]"}">
                <td class="py-3.5 px-4 whitespace-nowrap">${badge}</td>
                <td class="py-3.5 px-4 whitespace-nowrap">
                    <div class="font-bold text-[#0f1419]">Palm #${r.tree_no} &bull; ${esc(r.block)}</div>
                    <div class="text-[11px] text-[#536471]">${esc(r.division)} &rarr; ${esc(r.field)}</div>
                </td>
                <td class="py-3.5 px-4 whitespace-nowrap">
                    <div class="font-bold text-[#0f1419]">${esc(r.full_name)}</div>
                    <div class="text-[11px] font-mono-code text-[#536471]">${esc(r.detail)}</div>
                </td>
                <td class="py-3.5 px-4 font-mono-code text-[11px] text-[#536471] whitespace-nowrap">
                    ${r.tree_lat !== null ? `${Number(r.tree_lat).toFixed(5)}, ${Number(r.tree_lng).toFixed(5)}` : "Unmapped"}
                </td>
                <td class="py-3.5 px-4 font-mono-code text-[11px] whitespace-nowrap ${isFar ? "text-[#f4212e] font-bold" : "text-[#536471]"}">
                    ${r.user_lat !== null ? `${Number(r.user_lat).toFixed(5)}, ${Number(r.user_lng).toFixed(5)}` : "No GPS"}
                </td>
                <td class="py-3.5 px-4 font-mono-code text-[11px] text-[#536471] whitespace-nowrap">${esc(r.work_date)}</td>
            </tr>`;
        })
        .join("");

    tbody.querySelectorAll("[data-comp-idx]").forEach((rowEl) => {
        rowEl.onclick = () => {
            const r = list[Number(rowEl.getAttribute("data-comp-idx"))];
            if (!r) return;
            openItemDetailModal({
                badge: r.status === "far" ? `FLAGGED (${r.distance_m}m > ${state.compliance.threshold_m}m)` : `VERIFIED (${r.distance_m ?? 0}m)`,
                title: `Palm #${r.tree_no} GPS Compliance Audit`,
                fields: [
                    { label: "Location", value: `${r.division} → ${r.field} → ${r.block}`, full: true },
                    { label: "Harvester", value: r.full_name },
                    { label: "Work Date", value: r.work_date, mono: true },
                    { label: "Harvest Output", value: r.detail, mono: true, full: true },
                    { label: "Registered Palm GPS", value: r.tree_lat !== null ? `${r.tree_lat}, ${r.tree_lng}` : "Unmapped", mono: true },
                    { label: "Harvester Device GPS", value: r.user_lat !== null ? `${r.user_lat}, ${r.user_lng}` : "No GPS", mono: true },
                ],
            });
        };
    });

    refreshIcons();
}

function renderAdminHierarchy() {
    const { estates, divisions, fields, blocks } = state.hierarchy;

    $("crud-estates").innerHTML = estates
        .map(
            (e) => `
        <div class="p-3.5 rounded-xl bg-[#f7f9f9] border border-[#eff3f4] flex items-center justify-between gap-2 text-xs">
            <div class="min-w-0">
                <div class="font-extrabold text-[#0f1419] truncate">${esc(e.name)}</div>
                <div class="text-[11px] font-mono-code text-[#536471]">Corporate Estate Root</div>
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
                        <div class="text-xs font-mono-code text-[#536471]">@${esc(u.username)} &bull; Uskvalley Estate</div>
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
        const g = await captureDeviceGps();
        toast(`GPS: ${g.lat.toFixed(5)}, ${g.lng.toFixed(5)} (±${g.acc}m)`);
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

    // Harvest Controls
    $("harv-round").onchange = () => loadHarvestBlock();
    $("harv-date").onchange = () => loadHarvestBlock();
    $("harv-search").oninput = (e) => {
        state.harvBlock.search = e.target.value;
        renderHarvestGrid();
    };
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

    // Estates Sub-Tabs (5-Tier Hierarchy, GPS Tree Mapper, GPS Compliance)
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
            $("est-panel-compliance").classList.toggle("hidden", tab !== "compliance");
            if (tab === "mapper") loadMapperBlock();
            if (tab === "compliance") loadCompliance();
        };
    });

    // Mapper Controls
    $("btn-mapper-add-tree").onclick = () => openMapperModal(null);
    $("btn-mp-capture").onclick = async () => {
        const g = await captureDeviceGps();
        $("mp-lat").value = g.lat;
        $("mp-lng").value = g.lng;
        toast(`Captured GPS: ${g.lat.toFixed(5)}, ${g.lng.toFixed(5)}`);
    };
    $("btn-mp-save").onclick = () => saveMapperModal();
    $("btn-mp-delete").onclick = () => deleteMapperTree();

    // Compliance Filter Pills
    document.querySelectorAll(".comp-flt-btn").forEach((btn) => {
        btn.onclick = () => {
            state.compliance.filter = btn.getAttribute("data-comp-filter");
            document.querySelectorAll(".comp-flt-btn").forEach((b) => {
                b.className = `comp-flt-btn px-3 py-1 rounded-full ${
                    b === btn ? "bg-[#0f1419] text-white" : "text-[#536471]"
                }`;
            });
            renderComplianceTable();
        };
    });

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
                gps_threshold_m: Number($("set-gps-thresh").value),
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
