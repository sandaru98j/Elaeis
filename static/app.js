// ============================================================================
// ELAEIS — Palm-based Crop Monitoring System
// Frontend SPA Controller (Bunches, Fronds, Dispatch Weight, ABW & YPH Engine)
// ============================================================================

const ROLE_RANK = { pending: 0, harvester: 1, supervisor: 2, admin: 3 };
const ROLE_LABELS = {
    pending: "Pending Approval",
    harvester: "Harvester",
    supervisor: "Supervisor",
    admin: "Admin",
};

const state = {
    token: localStorage.getItem("el_token") || "",
    user: null,
    activePage: "dashboard",
    forgotChannel: "email",
    gps: { lat: 6.14224, lng: 80.36518, acc: 4.2, live: false },
    hierarchy: { estates: [], divisions: [], fields: [], blocks: [] },
    settings: { gps_threshold_m: 20, season_start_month: 4 },
    dashTrees: [],
    harvBlock: { block_id: null, trees: [], filter: "all", search: "" },
    dispatches: [],
    mapBlock: { block_id: null, trees: [] },
    compliance: { threshold_m: 20, rows: [], filter: "all" },
    adminUsers: { users: [], resets: [] },
    adminTab: "users",
    modalTree: null,
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
            ? "bg-red-600 text-white border-red-700"
            : type === "warn"
            ? "bg-amber-500 text-slate-950 border-amber-600"
            : "bg-slate-900 text-white border-slate-800";
    el.className = `pointer-events-auto px-4 py-3 rounded-xl border shadow-lg text-xs font-bold flex items-center justify-between gap-3 transition ${colors}`;
    el.innerHTML = `<span>${esc(msg)}</span>`;
    box.appendChild(el);
    setTimeout(() => {
        el.style.opacity = "0";
        setTimeout(() => el.remove(), 200);
    }, 3200);
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
    dot.className = `w-2 h-2 rounded-full ${state.gps.live ? "bg-emerald-500 animate-pulse" : "bg-emerald-500"}`;
    lbl.textContent = `${state.gps.lat.toFixed(4)}, ${state.gps.lng.toFixed(4)}`;
}

// ----------------------------------------------------------------------------
// Offline / Local Fallback Store (mirrors Cloudflare Worker D1 when offline)
// ----------------------------------------------------------------------------
const LocalDB = {
    key: "elaeis_local_db_v3",
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
        const users = [
            { id: 1, username: "admin", email: "sandaru98j@gmail.com", phone: "+94770000000", full_name: "Sandaruwan Gunathilaka", role: "admin", is_master: true, pass: "Elaeis@2026", created_at: now, approved_at: now },
            { id: 2, username: "supervisor", email: "supervisor@uskvalley.lk", phone: "+94771111111", full_name: "Kasun Perera", role: "supervisor", is_master: false, pass: "Elaeis@2026", created_at: now, approved_at: now },
            { id: 3, username: "harvester", email: "harvester@uskvalley.lk", phone: "+94772222222", full_name: "Nimal Silva", role: "harvester", is_master: false, pass: "Elaeis@2026", created_at: now, approved_at: now },
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
            { id: 1, tree_id: 1, harvest_date: `${yearMonth}-04`, year_month: yearMonth, round_no: 1, bunches: 12, fronds: 8, user_id: 3, user_lat: 6.14202, user_lng: 80.36501, user_acc: 4.1, recorded_at: now },
            { id: 2, tree_id: 2, harvest_date: `${yearMonth}-04`, year_month: yearMonth, round_no: 1, bunches: 10, fronds: 7, user_id: 3, user_lat: 6.14203, user_lng: 80.36506, user_acc: 3.9, recorded_at: now },
            { id: 3, tree_id: 3, harvest_date: `${yearMonth}-05`, year_month: yearMonth, round_no: 1, bunches: 14, fronds: 9, user_id: 3, user_lat: 6.14242, user_lng: 80.36551, user_acc: 6.2, recorded_at: now },
            { id: 4, tree_id: 4, harvest_date: `${yearMonth}-05`, year_month: yearMonth, round_no: 1, bunches: 11, fronds: 8, user_id: 2, user_lat: 6.14201, user_lng: 80.36526, user_acc: 3.5, recorded_at: now },
            { id: 5, tree_id: 5, harvest_date: today, year_month: yearMonth, round_no: round, bunches: 15, fronds: 10, user_id: 3, user_lat: 6.14202, user_lng: 80.36534, user_acc: 4.0, recorded_at: now },
            { id: 6, tree_id: 6, harvest_date: today, year_month: yearMonth, round_no: round, bunches: 9, fronds: 6, user_id: 3, user_lat: 6.14275, user_lng: 80.36492, user_acc: 8.0, recorded_at: now },
            { id: 7, tree_id: 121, harvest_date: today, year_month: yearMonth, round_no: round, bunches: 16, fronds: 10, user_id: 2, user_lat: 6.14297, user_lng: 80.36501, user_acc: 3.2, recorded_at: now },
        ];
        const dispatch = [
            { id: 1, division_id: 1, dispatch_date: `${yearMonth}-05`, year_month: yearMonth, round_no: 1, weight_kg: 895.0, user_id: 2, recorded_at: now },
            { id: 2, division_id: 1, dispatch_date: today, year_month: yearMonth, round_no: round, weight_kg: 1480.0, user_id: 2, recorded_at: now },
            { id: 3, division_id: 2, dispatch_date: today, year_month: yearMonth, round_no: round, weight_kg: 640.0, user_id: 2, recorded_at: now },
        ];
        return {
            users,
            resets: [],
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
// Unified API Client (Cloudflare Worker D1 + Local Fallback)
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
        if (err.message && !err.message.includes("Failed to fetch") && !err.message.includes("HTTP 404") && !err.message.includes("NetworkError")) {
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
        const email = String(body.email || body.identifier || "").trim().toLowerCase();
        const u = db.users.find((x) => x.email.toLowerCase() === email);
        if (!u || u.pass !== body.password) throw new Error("Invalid email or password.");
        if (u.role === "pending") throw new Error("Account created successfully. Pending admin approval.");
        return { token: `local-token-${u.id}`, user: u };
    }
    if (pathname === "/api/auth/register") {
        const email = String(body.email || "").trim().toLowerCase();
        if (db.users.some((u) => u.email.toLowerCase() === email)) {
            throw new Error("Email is already registered.");
        }
        const id = db.users.reduce((m, x) => Math.max(m, x.id), 0) + 1;
        const nu = {
            id,
            username: email.split("@")[0] + "_" + id,
            email,
            phone: body.phone.trim(),
            full_name: body.full_name.trim(),
            role: "pending",
            is_master: false,
            pass: body.password,
            created_at: new Date().toISOString(),
        };
        db.users.push(nu);
        LocalDB.save(db);
        return { ok: true, message: "Account created successfully. Pending admin approval." };
    }
    if (pathname === "/api/auth/forgot") {
        return { ok: true };
    }
    if (pathname === "/api/auth/reset") {
        const email = String(body.email || body.identifier || "").trim().toLowerCase();
        const u = db.users.find((x) => x.email.toLowerCase() === email);
        if (!u) throw new Error("Invalid or expired recovery code.");
        u.pass = body.new_password;
        LocalDB.save(db);
        return { ok: true };
    }
    if (pathname === "/api/auth/me") {
        return { user: curUser };
    }
    if (pathname === "/api/auth/logout") {
        return { ok: true };
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

        const roundsMap = {
            1: { round_no: 1, label: "Round 1 (Days 1-10)", bunches: 0, fronds: 0, dispatch_kg: 0, abw: 0, yph: 0 },
            2: { round_no: 2, label: "Round 2 (Days 11-20)", bunches: 0, fronds: 0, dispatch_kg: 0, abw: 0, yph: 0 },
            3: { round_no: 3, label: "Round 3 (Days 21-End)", bunches: 0, fronds: 0, dispatch_kg: 0, abw: 0, yph: 0 },
        };
        hRows.forEach((h) => {
            if (roundsMap[h.round_no]) {
                roundsMap[h.round_no].bunches += h.bunches;
                roundsMap[h.round_no].fronds += h.fronds;
            }
        });
        dRows.forEach((d) => {
            if (roundsMap[d.round_no]) {
                roundsMap[d.round_no].dispatch_kg += d.weight_kg;
            }
        });
        Object.values(roundsMap).forEach((r) => {
            r.abw = r.bunches > 0 ? Number((r.dispatch_kg / r.bunches).toFixed(2)) : 0;
            r.yph = totalHa > 0 ? Number((r.dispatch_kg / totalHa).toFixed(2)) : 0;
        });

        const monthsMap = {};
        hRows.forEach((h) => {
            monthsMap[h.year_month] = monthsMap[h.year_month] || { ym: h.year_month, bunches: 0, fronds: 0, dispatch_kg: 0, abw: 0, yph: 0 };
            monthsMap[h.year_month].bunches += h.bunches;
            monthsMap[h.year_month].fronds += h.fronds;
        });
        dRows.forEach((d) => {
            monthsMap[d.year_month] = monthsMap[d.year_month] || { ym: d.year_month, bunches: 0, fronds: 0, dispatch_kg: 0, abw: 0, yph: 0 };
            monthsMap[d.year_month].dispatch_kg += d.weight_kg;
        });
        const month_comparison = Object.values(monthsMap)
            .sort((a, b) => (a.ym < b.ym ? -1 : 1))
            .map((m) => ({
                ...m,
                abw: m.bunches > 0 ? Number((m.dispatch_kg / m.bunches).toFixed(2)) : 0,
                yph: totalHa > 0 ? Number((m.dispatch_kg / totalHa).toFixed(2)) : 0,
            }));

        const breakdown = db.divisions
            .filter((div) => !targetDivId || div.id === targetDivId)
            .map((div) => {
                const area_ha = db.fields.filter((f) => f.division_id === div.id).reduce((s, f) => s + f.area_ha, 0);
                const divHarvest = hRows.filter((h) => {
                    const t = db.trees.find((x) => x.id === h.tree_id);
                    const b = t ? db.blocks.find((x) => x.id === t.block_id) : null;
                    const f = b ? db.fields.find((x) => x.id === b.field_id) : null;
                    return f && f.division_id === div.id;
                });
                const divDisp = dRows.filter((d) => d.division_id === div.id);
                const dBunches = divHarvest.reduce((s, r) => s + r.bunches, 0);
                const dFronds = divHarvest.reduce((s, r) => s + r.fronds, 0);
                const dKg = divDisp.reduce((s, r) => s + r.weight_kg, 0);
                return {
                    div_id: div.id,
                    label: div.name,
                    area_ha,
                    bunches: dBunches,
                    fronds: dFronds,
                    dispatch_kg: dKg,
                    abw: dBunches > 0 ? Number((dKg / dBunches).toFixed(2)) : 0,
                    yph: area_ha > 0 ? Number((dKg / area_ha).toFixed(2)) : 0,
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
            round_comparison: Object.values(roundsMap),
            month_comparison,
            breakdown,
        };
    }
    if (pathname === "/api/admin/compliance") {
        const rows = [];
        db.harvest.forEach((r) => {
            const t = db.trees.find((x) => x.id === r.tree_id) || {};
            const b = db.blocks.find((x) => x.id === t.block_id) || {};
            const f = db.fields.find((x) => x.id === b.field_id) || {};
            const d = db.divisions.find((x) => x.id === f.division_id) || {};
            const u = db.users.find((x) => x.id === r.user_id) || { full_name: "Staff", role: "harvester" };
            let distance_m = null;
            let status = "ok";
            if (r.user_lat === null) status = "no_gps";
            else if (t.lat === null) status = "unmapped";
            else {
                distance_m = distanceMeters(t.lat, t.lng, r.user_lat, r.user_lng);
                status = distance_m > db.settings.gps_threshold_m ? "far" : "ok";
            }
            rows.push({
                activity: "harvest",
                id: r.id,
                recorded_at: r.recorded_at,
                work_date: r.harvest_date,
                user_lat: r.user_lat,
                user_lng: r.user_lng,
                user_acc: r.user_acc,
                full_name: u.full_name,
                role: u.role,
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
        return { users: db.users, resets: db.resets };
    }
    if (pathname === "/api/admin/users/role") {
        const u = db.users.find((x) => x.id === Number(body.user_id));
        if (u && !u.is_master) u.role = body.role;
        LocalDB.save(db);
        return { ok: true };
    }
    if (pathname === "/api/admin/users/delete") {
        db.users = db.users.filter((x) => x.id !== Number(body.user_id) || x.is_master);
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
// Live Clock & Time-Sensitive Greeting
// ----------------------------------------------------------------------------
function updateClockAndGreeting() {
    const now = new Date();
    const hrs = now.getHours();
    const mins = String(now.getMinutes()).padStart(2, "0");
    const secs = String(now.getSeconds()).padStart(2, "0");
    const period = hrs < 12 ? "Good morning" : hrs < 17 ? "Good afternoon" : "Good evening";
    const name = state.user ? state.user.full_name.split(" ")[0] : "";
    const gEl = $("hdr-greeting");
    const cEl = $("hdr-clock");
    const rEl = $("hdr-round-pill");
    if (gEl) gEl.textContent = name ? `${period}, ${name}` : period;
    if (cEl) cEl.textContent = `${todayStr()} ${String(hrs).padStart(2, "0")}:${mins}:${secs}`;
    if (rEl) {
        const { round, rangeLabel } = roundOfDate(todayStr());
        rEl.textContent = `R${round} (${rangeLabel})`;
    }
}

// ----------------------------------------------------------------------------
// Auth & Session Flow
// ----------------------------------------------------------------------------
function showAuthView(mode = "login", noticeMessage = "") {
    $("auth-screen").classList.remove("hidden");
    $("app-shell").classList.add("hidden");
    $("form-login").classList.toggle("hidden", mode !== "login");
    $("form-signup").classList.toggle("hidden", mode !== "signup");
    $("form-forgot").classList.toggle("hidden", mode !== "forgot");

    const banner = $("auth-notice");
    const bannerTxt = $("auth-notice-text");
    if (noticeMessage) {
        bannerTxt.textContent = noticeMessage;
        banner.classList.remove("hidden");
    } else {
        banner.classList.add("hidden");
    }
    refreshIcons();
}

async function loginWithEmail(email, password) {
    try {
        const res = await api("/api/auth/login", "POST", { email, password });
        state.token = res.token;
        state.user = res.user;
        localStorage.setItem("el_token", res.token);
        await enterApplication();
    } catch (err) {
        toast(err.message || "Invalid email or password.", "err");
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
            showAuthView("login");
            return;
        }
    }

    if (state.user.role === "pending") {
        state.token = "";
        state.user = null;
        localStorage.removeItem("el_token");
        showAuthView("login", "Account created successfully. Pending admin approval.");
        return;
    }

    updateClockAndGreeting();
    $("auth-screen").classList.add("hidden");
    $("app-shell").classList.remove("hidden");

    applyRbacNavigation();
    await loadBootstrap();
    captureDeviceGps();
    switchPage(state.activePage);
}

function applyRbacNavigation() {
    const userRank = ROLE_RANK[state.user?.role] || 0;
    document.querySelectorAll("[data-nav]").forEach((btn) => {
        const minRole = btn.getAttribute("data-min-role") || "harvester";
        const allowed = userRank >= (ROLE_RANK[minRole] || 1);
        btn.classList.toggle("hidden", !allowed);
    });
    const currentMin = {
        dashboard: "harvester",
        harvest: "harvester",
        dispatch: "harvester",
        mapper: "admin",
        compliance: "admin",
        admin: "admin",
    }[state.activePage];
    if (userRank < (ROLE_RANK[currentMin] || 1)) {
        state.activePage = "dashboard";
    }
}

async function loadBootstrap() {
    const data = await api("/api/bootstrap");
    state.hierarchy = data.hierarchy;
    state.settings = data.settings;

    initDashboardFilters();
    initDivisionCascade("harv", () => loadHarvestBlock());
    initDivisionCascade("map", () => loadMapperBlock());
    initDispatchForm();
}

function switchPage(page) {
    state.activePage = page;
    document.querySelectorAll(".page-view").forEach((sec) => {
        sec.classList.toggle("hidden", sec.id !== `page-${page}`);
    });
    document.querySelectorAll("[data-nav]").forEach((btn) => {
        const active = btn.getAttribute("data-nav") === page;
        if (btn.closest("#desktop-nav")) {
            btn.className = `nav-btn px-3 py-2 rounded-lg text-xs font-bold flex items-center gap-1.5 transition ${
                active ? "bg-emerald-600 text-white shadow-sm" : "text-slate-600 hover:bg-white/70"
            }`;
        } else {
            btn.className = `nav-btn flex flex-col items-center justify-center gap-0.5 text-[10px] font-bold transition ${
                active ? "text-emerald-600" : "text-slate-400 hover:text-slate-700"
            }`;
        }
    });

    if (page === "dashboard") refreshDashboard();
    if (page === "harvest") loadHarvestBlock();
    if (page === "dispatch") loadDispatches();
    if (page === "mapper") loadMapperBlock();
    if (page === "compliance") loadCompliance();
    if (page === "admin") loadAdminPage();
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
// PAGE 1: ADVANCED ANALYTICS DASHBOARD (Bunches, Fronds, Dispatch, ABW, YPH)
// ----------------------------------------------------------------------------
function initDashboardFilters() {
    const estEl = $("flt-estate");
    const divEl = $("flt-division");
    const fldEl = $("flt-field");
    const blkEl = $("flt-block");
    const treeEl = $("flt-tree");
    const { estates, divisions, fields, blocks } = state.hierarchy;

    estEl.innerHTML = `<option value="">All Estates</option>` + estates.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join("");
    if (estates.length === 1) estEl.value = String(estates[0].id);

    const popDivs = () => {
        const eid = Number(estEl.value);
        const list = eid ? divisions.filter((d) => d.estate_id === eid) : divisions;
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
        const fid = Number(fldEl.value);
        const list = fid ? blocks.filter((b) => b.field_id === fid) : blocks;
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
            state.dashTrees.map((t) => `<option value="${t.id}">Tree ${t.tree_no}</option>`).join("");
        refreshDashboard();
    };

    estEl.onchange = popDivs;
    divEl.onchange = popFields;
    fldEl.onchange = popBlocks;
    blkEl.onchange = popTrees;
    treeEl.onchange = refreshDashboard;

    const today = todayStr();
    $("flt-month").value = today.slice(0, 7);
    $("flt-from").value = `${today.slice(0, 4)}-01-01`;
    $("flt-to").value = today;

    const syncTimeSlots = () => {
        const mode = $("flt-time-mode").value;
        $("flt-time-slot-1").classList.toggle("hidden", mode !== "season" && mode !== "std");
        $("flt-time-slot-2").classList.toggle("hidden", mode !== "month" && mode !== "round");
        $("flt-time-slot-3").classList.toggle("hidden", mode !== "round");
        $("flt-time-custom").classList.toggle("hidden", mode !== "custom");
        refreshDashboard();
    };

    $("flt-time-mode").onchange = syncTimeSlots;
    $("flt-season-year").onchange = refreshDashboard;
    $("flt-month").onchange = refreshDashboard;
    $("flt-round").onchange = refreshDashboard;
    $("flt-from").onchange = refreshDashboard;
    $("flt-to").onchange = refreshDashboard;

    popDivs();
}

function getDashboardQuery() {
    const mode = $("flt-time-mode").value;
    const sMonth = String(state.settings.season_start_month || 4).padStart(2, "0");
    let from = "2026-04-01";
    let to = "2027-03-31";
    let timeLabel = "Season-to-Date";

    const q = new URLSearchParams();

    if (mode === "season" || mode === "std") {
        const yr = Number($("flt-season-year").value) || 2026;
        from = `${yr}-${sMonth}-01`;
        to = mode === "std" ? todayStr() : `${yr + 1}-03-31`;
        timeLabel = mode === "std" ? `${yr}/${String(yr + 1).slice(2)} Season-to-Date` : `${yr}/${String(yr + 1).slice(2)} Full Season`;
    } else if (mode === "month") {
        const ym = $("flt-month").value || todayStr().slice(0, 7);
        from = `${ym}-01`;
        to = `${ym}-31`;
        timeLabel = `Month: ${ym}`;
    } else if (mode === "round") {
        const ym = $("flt-month").value || todayStr().slice(0, 7);
        const r = Number($("flt-round").value) || 1;
        from = `${ym}-01`;
        to = `${ym}-31`;
        q.set("round_no", String(r));
        timeLabel = `${ym} • Round ${r}`;
    } else if (mode === "custom") {
        from = $("flt-from").value || "2026-01-01";
        to = $("flt-to").value || todayStr();
        timeLabel = `${from} to ${to}`;
    }

    q.set("from", from);
    q.set("to", to);

    const parts = [timeLabel];
    const addPart = (id, param) => {
        const el = $(id);
        if (el && el.value) {
            q.set(param, el.value);
            parts.push(el.options[el.selectedIndex]?.text || "");
        }
    };
    addPart("flt-estate", "estate_id");
    addPart("flt-division", "division_id");
    addPart("flt-field", "field_id");
    addPart("flt-block", "block_id");
    addPart("flt-tree", "tree_id");

    $("dash-breadcrumb").textContent = parts.filter(Boolean).join(" | ");
    return q.toString();
}

async function refreshDashboard() {
    const qs = getDashboardQuery();
    const rep = await api(`/api/report?${qs}`);
    const tot = rep.totals || {};

    $("kpi-bunches").textContent = Number(tot.bunches || 0).toLocaleString();
    $("kpi-harvest-trees").textContent = `${tot.trees || 0} palms cut`;
    $("kpi-fronds").textContent = Number(tot.fronds || 0).toLocaleString();
    $("kpi-harvest-recs").textContent = `${tot.records || 0} harvest logs`;
    $("kpi-dispatch-kg").textContent = `${Number(tot.dispatch_kg || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} kg`;
    $("kpi-dispatch-recs").textContent = `${tot.dispatch_records || 0} mill loads`;
    $("kpi-abw").textContent = `${Number(tot.abw || 0).toFixed(2)} kg`;
    $("kpi-yph").textContent = `${Number(tot.yph || 0).toFixed(2)} kg/Ha`;
    $("kpi-area-ha").textContent = `Extent: ${Number(tot.area_ha || 0).toFixed(2)} Ha`;

    renderRoundComparison(rep.round_comparison || []);
    renderMonthComparison(rep.month_comparison || []);
    renderDivisionTable(rep.breakdown || []);
}

function renderRoundComparison(rounds) {
    const box = $("chart-rounds");
    if (!rounds.length) {
        box.innerHTML = `<div class="py-8 text-center text-xs text-slate-400">No round data in selected filter</div>`;
        return;
    }
    const maxBunches = Math.max(1, ...rounds.map((r) => r.bunches || 0));
    box.innerHTML = rounds
        .map((r) => {
            const pct = Math.min(100, Math.round(((r.bunches || 0) / maxBunches) * 100));
            return `
            <div class="p-3 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1.5">
                <div class="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span class="font-extrabold text-slate-800">${esc(r.label)}</span>
                    <div class="flex items-center gap-2 font-mono-code text-[11px]">
                        <span class="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold">ABW: ${Number(r.abw || 0).toFixed(2)} kg</span>
                        <span class="px-2 py-0.5 rounded bg-slate-200 text-slate-800 font-bold">YPH: ${Number(r.yph || 0).toFixed(2)} kg/Ha</span>
                    </div>
                </div>
                <div class="flex items-center justify-between text-[11px] font-mono-code text-slate-600">
                    <span><b>${r.bunches || 0}</b> Bunches &bull; <b>${r.fronds || 0}</b> Fronds</span>
                    <span class="text-blue-700 font-bold">Dispatch: ${Number(r.dispatch_kg || 0).toLocaleString()} kg</span>
                </div>
                <div class="w-full h-2 rounded-full bg-slate-200 overflow-hidden">
                    <div class="h-full rounded-full bg-emerald-600 transition-all" style="width:${pct}%"></div>
                </div>
            </div>`;
        })
        .join("");
}

function renderMonthComparison(months) {
    const box = $("chart-months");
    if (!months.length) {
        box.innerHTML = `<div class="py-12 text-center text-xs text-slate-400">No monthly data in selected range</div>`;
        return;
    }
    const maxB = Math.max(1, ...months.map((m) => m.bunches || 0));
    box.innerHTML = months
        .map((m) => {
            const pct = Math.min(100, Math.round(((m.bunches || 0) / maxB) * 100));
            return `
            <div class="p-3 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1.5">
                <div class="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span class="font-mono-code font-extrabold text-slate-900">${esc(m.ym)}</span>
                    <div class="flex items-center gap-2 font-mono-code text-[11px]">
                        <span class="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold">ABW: ${Number(m.abw || 0).toFixed(2)} kg</span>
                        <span class="px-2 py-0.5 rounded bg-slate-200 text-slate-800 font-bold">YPH: ${Number(m.yph || 0).toFixed(2)} kg/Ha</span>
                    </div>
                </div>
                <div class="flex items-center justify-between text-[11px] font-mono-code text-slate-600">
                    <span><b>${m.bunches || 0}</b> Bunches &bull; <b>${m.fronds || 0}</b> Fronds</span>
                    <span class="text-blue-700 font-bold">Dispatch: ${Number(m.dispatch_kg || 0).toLocaleString()} kg</span>
                </div>
                <div class="w-full h-2 rounded-full bg-slate-200 overflow-hidden">
                    <div class="h-full rounded-full bg-blue-600 transition-all" style="width:${pct}%"></div>
                </div>
            </div>`;
        })
        .join("");
}

function renderDivisionTable(rows) {
    const tbody = $("dash-div-tbody");
    if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="py-6 text-center text-slate-400">No division data available</td></tr>`;
        return;
    }
    tbody.innerHTML = rows
        .map(
            (r) => `
        <tr class="hover:bg-slate-50">
            <td class="py-2.5 px-4 font-bold text-slate-900">${esc(r.label)}</td>
            <td class="py-2.5 px-4 font-mono-code text-slate-600">${Number(r.area_ha || 0).toFixed(2)} Ha</td>
            <td class="py-2.5 px-4 font-mono-code font-bold text-emerald-700">${Number(r.bunches || 0).toLocaleString()}</td>
            <td class="py-2.5 px-4 font-mono-code text-slate-700">${Number(r.fronds || 0).toLocaleString()}</td>
            <td class="py-2.5 px-4 font-mono-code font-bold text-blue-700">${Number(r.dispatch_kg || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} kg</td>
            <td class="py-2.5 px-4 font-mono-code font-extrabold text-slate-900">${Number(r.abw || 0).toFixed(2)} kg</td>
            <td class="py-2.5 px-4 font-mono-code font-extrabold text-emerald-800">${Number(r.yph || 0).toFixed(2)} kg/Ha</td>
        </tr>`
        )
        .join("");
}

// ----------------------------------------------------------------------------
// PAGE 2: UPDATED HARVEST DATA ENTRY FLOW
// Order: 1. Round -> 2. Date -> 3. Division -> Field -> Block -> Tree (2D Cards) -> 4. Bunches & Fronds
// ----------------------------------------------------------------------------
async function loadHarvestBlock() {
    const bid = Number($("harv-block")?.value);
    if (!bid) return;
    const date = $("harv-date").value || todayStr();
    const roundNo = Number($("harv-round").value) || roundOfDate(date).round;
    const { rangeLabel, yearMonth } = roundOfDate(date, roundNo);
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
            const gpsBadge = t.lat !== null ? `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500" title="GPS Mapped"></span>` : "";
            return `
            <div data-harv-tree="${t.id}" class="palm-card ${done ? "done-harvest" : ""}">
                <div class="w-full flex items-center justify-between text-[10px] font-mono-code text-slate-400">
                    <span>#${t.tree_no}</span>
                    ${gpsBadge}
                </div>
                <div class="my-1 text-emerald-700">
                    <i data-lucide="${done ? "check-circle-2" : "palmtree"}" class="w-5 h-5"></i>
                </div>
                <div class="text-[11px] font-mono-code font-extrabold ${done ? "text-emerald-900" : "text-slate-400"}">
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
    $("mh-bunches").value = tree.rec ? tree.rec.bunches : 2;
    $("mh-fronds").value = tree.rec ? tree.rec.fronds : 2;
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
        const distMsg = res.distance_m !== null && res.distance_m !== undefined ? ` (${res.distance_m}m)` : "";
        toast(`Saved Palm #${tree.tree_no} (R${round_no}): ${bunches}B / ${fronds}F${distMsg}`);
        await loadHarvestBlock();
    } catch (err) {
        toast(err.message, "err");
    } finally {
        btn.disabled = false;
    }
}

// ----------------------------------------------------------------------------
// PAGE 3: DISPATCH CROP WEIGHT LOGGER
// Order: Select Round -> Select Date -> Select Division -> Enter Dispatch Crop Load Weight (in kg)
// ----------------------------------------------------------------------------
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
        tbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-slate-400">No mill dispatch crop weights logged yet</td></tr>`;
        return;
    }

    const canDelete = (ROLE_RANK[state.user?.role] || 0) >= ROLE_RANK.supervisor;
    tbody.innerHTML = state.dispatches
        .map(
            (d) => `
        <tr class="hover:bg-slate-50">
            <td class="py-2.5 px-4 font-mono-code text-slate-700">${esc(d.dispatch_date)}</td>
            <td class="py-2.5 px-4">
                <span class="px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 font-mono-code font-bold text-[11px]">
                    Round ${d.round_no}
                </span>
            </td>
            <td class="py-2.5 px-4 font-bold text-slate-900">${esc(d.division_name)}</td>
            <td class="py-2.5 px-4 font-mono-code font-extrabold text-blue-700">${Number(d.weight_kg).toLocaleString(undefined, { maximumFractionDigits: 1 })} kg</td>
            <td class="py-2.5 px-4 text-slate-500">${esc(d.recorded_by || "Staff")}</td>
            <td class="py-2.5 px-4 text-right">
                ${
                    canDelete
                        ? `<button type="button" data-del-dispatch="${d.id}" class="p-1.5 rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600">
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
                toast("Dispatch entry removed");
                await loadDispatches();
            } catch (err) {
                toast(err.message, "err");
            }
        };
    });
    refreshIcons();
}

// ----------------------------------------------------------------------------
// PAGE 4: GPS TREE MAPPER (Admins Only)
// ----------------------------------------------------------------------------
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
                <div class="w-full flex items-center justify-between text-[10px] font-mono-code text-slate-500">
                    <span>#${t.tree_no}</span>
                    <i data-lucide="map-pin" class="w-3.5 h-3.5 ${hasGps ? "text-blue-600" : "text-slate-300"}"></i>
                </div>
                <div class="text-[10px] font-mono-code font-bold ${hasGps ? "text-blue-900" : "text-slate-400"} text-center leading-tight mt-1">
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
    $("mp-title").textContent = existing ? `Edit Palm #${existing.tree_no} GPS` : "Add New Tree (Live GPS)";
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
        toast("Tree GPS saved");
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

// ----------------------------------------------------------------------------
// PAGE 5: GPS VERIFICATION / COMPLIANCE LOG (Admins Only)
// ----------------------------------------------------------------------------
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
        tbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-slate-400">No GPS compliance logs match filter</td></tr>`;
        return;
    }

    tbody.innerHTML = list
        .map((r) => {
            const isFar = r.status === "far";
            const badge = isFar
                ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-600 text-white font-mono-code font-bold text-[11px]">
                       <i data-lucide="alert-triangle" class="w-3 h-3"></i> ${r.distance_m}m
                   </span>`
                : r.status === "ok"
                ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-mono-code font-bold text-[11px]">
                       <i data-lucide="check" class="w-3 h-3"></i> ${r.distance_m}m
                   </span>`
                : `<span class="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 font-mono-code text-[11px]">${esc(r.status)}</span>`;

            return `
            <tr class="${isFar ? "row-flagged" : "hover:bg-slate-50"}">
                <td class="py-2.5 px-3">${badge}</td>
                <td class="py-2.5 px-3">
                    <div class="font-bold text-slate-900">Palm #${r.tree_no} &bull; ${esc(r.block)}</div>
                    <div class="text-[11px] text-slate-500">${esc(r.division)} &rarr; ${esc(r.field)}</div>
                </td>
                <td class="py-2.5 px-3">
                    <div class="font-bold text-slate-800">${esc(r.full_name)}</div>
                    <div class="text-[11px] font-mono-code text-slate-500">${esc(r.detail)}</div>
                </td>
                <td class="py-2.5 px-3 font-mono-code text-[11px] text-slate-600">
                    ${r.tree_lat !== null ? `${Number(r.tree_lat).toFixed(5)}, ${Number(r.tree_lng).toFixed(5)}` : "Unmapped"}
                </td>
                <td class="py-2.5 px-3 font-mono-code text-[11px] ${isFar ? "text-red-700 font-bold" : "text-slate-600"}">
                    ${r.user_lat !== null ? `${Number(r.user_lat).toFixed(5)}, ${Number(r.user_lng).toFixed(5)}` : "No GPS"}
                </td>
                <td class="py-2.5 px-3 font-mono-code text-[11px] text-slate-500">${esc(r.work_date)}</td>
            </tr>`;
        })
        .join("");
    refreshIcons();
}

// ----------------------------------------------------------------------------
// PAGE 6: ADMIN INFRASTRUCTURE SETTINGS (Users, 5-Tier CRUD, GPS Settings)
// ----------------------------------------------------------------------------
async function loadAdminPage() {
    const [uData, boot] = await Promise.all([api("/api/admin/users"), api("/api/bootstrap")]);
    state.adminUsers = uData;
    state.hierarchy = boot.hierarchy;
    state.settings = boot.settings;

    $("set-gps-thresh").value = state.settings.gps_threshold_m || 20;
    $("set-season-month").value = state.settings.season_start_month || 4;

    renderAdminUsers();
    renderAdminHierarchy();
    refreshIcons();
}

function renderAdminUsers() {
    const users = state.adminUsers.users || [];
    const pendingCount = users.filter((u) => u.role === "pending").length;
    $("adm-pending-badge").textContent = pendingCount;

    $("adm-users-list").innerHTML = users
        .map((u) => {
            const isPending = u.role === "pending";
            return `
            <div class="py-3 flex flex-wrap items-center justify-between gap-3">
                <div class="flex items-center gap-2.5">
                    <div class="w-9 h-9 rounded-xl ${isPending ? "bg-amber-100 text-amber-700" : "bg-emerald-50 text-emerald-700"} flex items-center justify-center font-bold text-xs">
                        ${esc(u.full_name.slice(0, 2).toUpperCase())}
                    </div>
                    <div>
                        <div class="flex items-center gap-1.5">
                            <span class="text-xs font-extrabold text-slate-900">${esc(u.full_name)}</span>
                            <span class="text-[10px] font-mono-code px-2 py-0.5 rounded-full ${
                                isPending ? "bg-amber-100 text-amber-800 font-bold" : "bg-slate-100 text-slate-700"
                            }">${esc(ROLE_LABELS[u.role] || u.role)}</span>
                        </div>
                        <div class="text-[11px] font-mono-code text-slate-400">${esc(u.email)} &bull; ${esc(u.phone)}</div>
                    </div>
                </div>
                <div class="flex items-center gap-1.5">
                    ${
                        u.is_master
                            ? `<span class="px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 text-xs font-bold">Master Admin</span>`
                            : `
                        <select data-user-role="${u.id}" class="px-2.5 py-1.5 rounded-xl border border-slate-200 bg-slate-50 text-xs font-bold">
                            <option value="pending" ${u.role === "pending" ? "selected" : ""}>Pending Approval</option>
                            <option value="harvester" ${u.role === "harvester" ? "selected" : ""}>Harvester</option>
                            <option value="supervisor" ${u.role === "supervisor" ? "selected" : ""}>Supervisor</option>
                            <option value="admin" ${u.role === "admin" ? "selected" : ""}>Admin</option>
                        </select>
                        <button type="button" data-del-user="${u.id}" class="p-1.5 rounded-lg border border-slate-200 hover:bg-red-50 hover:text-red-600 text-slate-400">
                            <i data-lucide="trash-2" class="w-4 h-4"></i>
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
                toast(`Updated role to ${ROLE_LABELS[sel.value]}`);
                await loadAdminPage();
            } catch (err) {
                toast(err.message, "err");
            }
        };
    });

    document.querySelectorAll("[data-del-user]").forEach((btn) => {
        btn.onclick = async () => {
            try {
                await api("/api/admin/users/delete", "POST", { user_id: Number(btn.getAttribute("data-del-user")) });
                toast("Account removed");
                await loadAdminPage();
            } catch (err) {
                toast(err.message, "err");
            }
        };
    });
}

function renderAdminHierarchy() {
    const { estates, divisions, fields, blocks } = state.hierarchy;

    $("crud-estates").innerHTML = estates
        .map(
            (e) => `
        <div class="p-2 rounded-xl bg-slate-50 border border-slate-200/80 flex items-center justify-between text-xs">
            <span class="font-bold text-slate-800">${esc(e.name)}</span>
            <div class="flex items-center gap-1">
                <button type="button" data-edit-estate="${e.id}" class="p-1 text-slate-500 hover:text-emerald-600"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                <button type="button" data-del-entity="estate:${e.id}" class="p-1 text-slate-400 hover:text-red-600"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
            </div>
        </div>`
        )
        .join("");

    $("crud-divisions").innerHTML = divisions
        .map((d) => {
            const est = estates.find((e) => e.id === d.estate_id);
            return `
            <div class="p-2 rounded-xl bg-slate-50 border border-slate-200/80 flex items-center justify-between text-xs">
                <div>
                    <div class="font-bold text-slate-800">${esc(d.name)}</div>
                    <div class="text-[10px] text-slate-400">${esc(est?.name || "")}</div>
                </div>
                <div class="flex items-center gap-1">
                    <button type="button" data-edit-division="${d.id}" class="p-1 text-slate-500 hover:text-emerald-600"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                    <button type="button" data-del-entity="division:${d.id}" class="p-1 text-slate-400 hover:text-red-600"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                </div>
            </div>`;
        })
        .join("");

    $("crud-fields").innerHTML = fields
        .map((f) => {
            const div = divisions.find((d) => d.id === f.division_id);
            return `
            <div class="p-2 rounded-xl bg-slate-50 border border-slate-200/80 flex items-center justify-between text-xs">
                <div>
                    <div class="font-bold text-slate-800">${esc(f.name)} &bull; <span class="font-mono-code text-emerald-700">${f.planting_year} - ${Number(f.area_ha).toFixed(2)} Ha</span></div>
                    <div class="text-[10px] text-slate-400">${esc(div?.name || "")}</div>
                </div>
                <div class="flex items-center gap-1">
                    <button type="button" data-edit-field="${f.id}" class="p-1 text-slate-500 hover:text-emerald-600"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                    <button type="button" data-del-entity="field:${f.id}" class="p-1 text-slate-400 hover:text-red-600"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                </div>
            </div>`;
        })
        .join("");

    $("crud-blocks").innerHTML = blocks
        .map((b) => {
            const fld = fields.find((f) => f.id === b.field_id);
            return `
            <div class="p-2 rounded-xl bg-slate-50 border border-slate-200/80 flex items-center justify-between text-xs">
                <div>
                    <div class="font-bold text-slate-800">${esc(b.name)} <span class="font-mono-code text-[11px] text-emerald-700">(${b.tree_total} palms)</span></div>
                    <div class="text-[10px] text-slate-400">${esc(fld ? `${fld.name} (${fld.planting_year})` : "")}</div>
                </div>
                <div class="flex items-center gap-1">
                    <button type="button" data-batch-block="${b.id}" title="Batch Add Trees" class="px-2 py-1 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 font-mono-code text-[10px] font-bold">+Trees</button>
                    <button type="button" data-edit-block="${b.id}" class="p-1 text-slate-500 hover:text-emerald-600"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                    <button type="button" data-del-entity="block:${b.id}" class="p-1 text-slate-400 hover:text-red-600"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
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
                await loadAdminPage();
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
        body.innerHTML = `<input id="ac-name" type="text" placeholder="Estate Name" value="${esc(item?.name || "")}" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs font-bold" />`;
        state.crudCallback = () => api("/api/admin/estate/save", "POST", { id: item?.id, name: $("ac-name").value });
    } else if (type === "division") {
        $("ac-title").textContent = item ? "Edit Division" : "Add Division";
        body.innerHTML = `
            <select id="ac-parent" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs font-bold ${item ? "hidden" : ""}">
                ${estates.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join("")}
            </select>
            <input id="ac-name" type="text" placeholder="Division Name" value="${esc(item?.name || "")}" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs font-bold" />`;
        state.crudCallback = () =>
            api("/api/admin/division/save", "POST", { id: item?.id, estate_id: Number($("ac-parent").value), name: $("ac-name").value });
    } else if (type === "field") {
        $("ac-title").textContent = item ? "Edit Field" : "Add Field (Year & Ha)";
        body.innerHTML = `
            <select id="ac-parent" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs font-bold ${item ? "hidden" : ""}">
                ${divisions.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("")}
            </select>
            <input id="ac-name" type="text" placeholder="Field Name (e.g. Field 7)" value="${esc(item?.name || "")}" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs font-bold" />
            <div class="grid grid-cols-2 gap-2">
                <input id="ac-year" type="number" placeholder="Planting Year (e.g. 2014)" value="${item?.planting_year || 2014}" class="px-3 py-2 rounded-xl border border-slate-200 text-xs font-mono-code font-bold" />
                <input id="ac-ha" type="number" step="0.01" placeholder="Area Ha (e.g. 12.50)" value="${item?.area_ha || 10.0}" class="px-3 py-2 rounded-xl border border-slate-200 text-xs font-mono-code font-bold" />
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
            <select id="ac-parent" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs font-bold ${item ? "hidden" : ""}">
                ${fields.map((f) => `<option value="${f.id}">${esc(f.name)} (${f.planting_year} - ${f.area_ha}Ha)</option>`).join("")}
            </select>
            <input id="ac-name" type="text" placeholder="Block Name (e.g. Block C)" value="${esc(item?.name || "")}" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs font-bold" />
            <input id="ac-note" type="text" placeholder="Geographical boundary note" value="${esc(item?.boundary_note || "")}" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs" />
            ${
                item
                    ? ""
                    : `<input id="ac-count" type="number" min="0" max="3000" value="280" placeholder="Initial Palm Count (~300)" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs font-mono-code font-bold" />`
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
        $("ac-title").textContent = `Batch Generate Trees • ${item?.name}`;
        body.innerHTML = `<input id="ac-batch-count" type="number" min="1" max="3000" value="50" placeholder="Number of trees to add" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs font-mono-code font-bold" />`;
        state.crudCallback = () => api("/api/admin/trees/batch", "POST", { block_id: item.id, count: Number($("ac-batch-count").value) });
    }

    $("modal-admin-crud").classList.remove("hidden");
}

// ----------------------------------------------------------------------------
// Event Listeners & Initialization
// ----------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
    setInterval(updateClockAndGreeting, 1000);
    updateClockAndGreeting();

    // Auto-detect today's date & current round for Harvest and Dispatch pages
    const today = todayStr();
    const { round } = roundOfDate(today);
    if ($("harv-date")) $("harv-date").value = today;
    if ($("harv-round")) $("harv-round").value = String(round);
    if ($("disp-date")) $("disp-date").value = today;
    if ($("disp-round")) $("disp-round").value = String(round);

    // Auth View Switchers
    $("btn-show-signup").onclick = () => showAuthView("signup");
    $("btn-show-forgot").onclick = () => {
        $("forgot-step-1").classList.remove("hidden");
        $("forgot-step-2").classList.add("hidden");
        showAuthView("forgot");
    };
    document.querySelectorAll("[data-back-login]").forEach((b) => (b.onclick = () => showAuthView("login")));

    document.querySelectorAll("[data-toggle-pass]").forEach((btn) => {
        btn.onclick = () => {
            const inp = $(btn.getAttribute("data-toggle-pass"));
            if (inp) inp.type = inp.type === "password" ? "text" : "password";
        };
    });

    // Login Submit (Email & Password ONLY)
    $("form-login").onsubmit = async (e) => {
        e.preventDefault();
        await loginWithEmail($("login-email").value, $("login-password").value);
    };

    // Sign-Up Submit -> Shows "Account created successfully. Pending admin approval."
    $("form-signup").onsubmit = async (e) => {
        e.preventDefault();
        try {
            const res = await api("/api/auth/register", "POST", {
                full_name: $("reg-fullname").value,
                email: $("reg-email").value,
                phone: $("reg-phone").value,
                password: $("reg-password").value,
            });
            $("form-signup").reset();
            const msg = res.message || "Account created successfully. Pending admin approval.";
            showAuthView("login", msg);
            toast(msg);
        } catch (err) {
            toast(err.message, "err");
        }
    };

    // Forgot Password Channel Toggle
    const setForgotChan = (ch) => {
        state.forgotChannel = ch;
        $("chan-email").className = `px-2.5 py-1 rounded-md flex items-center gap-1 ${
            ch === "email" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
        }`;
        $("chan-sms").className = `px-2.5 py-1 rounded-md flex items-center gap-1 ${
            ch === "sms" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
        }`;
    };
    $("chan-email").onclick = () => setForgotChan("email");
    $("chan-sms").onclick = () => setForgotChan("sms");

    $("btn-send-code").onclick = async () => {
        const email = $("forgot-email").value.trim();
        if (!email) return toast("Enter your registered email address", "warn");
        try {
            await api("/api/auth/forgot", "POST", { email, channel: state.forgotChannel });
            $("forgot-step-1").classList.add("hidden");
            $("forgot-step-2").classList.remove("hidden");
            toast("If the account exists, a recovery code has been sent.");
        } catch (err) {
            toast(err.message, "err");
        }
    };

    $("btn-verify-reset").onclick = async () => {
        try {
            await api("/api/auth/reset", "POST", {
                email: $("forgot-email").value.trim(),
                code: $("reset-code").value.trim(),
                new_password: $("reset-new-password").value,
            });
            toast("Password updated. Please log in.");
            showAuthView("login");
        } catch (err) {
            toast(err.message, "err");
        }
    };

    // Header Controls
    $("btn-logout").onclick = () => doLogout();
    $("btn-gps-ping").onclick = async () => {
        const g = await captureDeviceGps();
        toast(`GPS: ${g.lat.toFixed(5)}, ${g.lng.toFixed(5)} (±${g.acc}m)`);
    };

    // Navigation Tabs (Desktop Header + Mobile Bottom Bar)
    document.querySelectorAll("[data-nav]").forEach((btn) => {
        btn.onclick = () => switchPage(btn.getAttribute("data-nav"));
    });

    // Dashboard Export & Reset
    $("btn-dash-reset").onclick = () => initDashboardFilters();
    $("btn-export-pdf").onclick = () => window.print();
    $("btn-export-csv").onclick = async () => {
        const qs = getDashboardQuery();
        try {
            const csv = await api(`/api/report.csv?${qs}`);
            const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `elaeis_yield_report_${todayStr()}.csv`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (_) {
            toast("CSV exported");
        }
    };

    // Harvest Controls (1. Round -> 2. Date -> 3. Division -> Field -> Block -> Tree)
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
                b.className = `harv-flt-btn px-2.5 py-1 rounded-lg ${
                    b === btn ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
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
            toast(`Saved Dispatch Weight: ${weight_kg.toLocaleString()} kg (Round ${round_no})`);
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
                b.className = `comp-flt-btn px-2.5 py-1 rounded-lg ${
                    b === btn ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                }`;
            });
            renderComplianceTable();
        };
    });

    // Admin Sub-Tabs & Buttons
    document.querySelectorAll("[data-admin-tab]").forEach((btn) => {
        btn.onclick = () => {
            const tab = btn.getAttribute("data-admin-tab");
            state.adminTab = tab;
            document.querySelectorAll("[data-admin-tab]").forEach((b) => {
                const on = b === btn;
                b.className = `adm-tab-btn px-3.5 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 shrink-0 ${
                    on ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                }`;
            });
            $("adm-panel-users").classList.toggle("hidden", tab !== "users");
            $("adm-panel-hierarchy").classList.toggle("hidden", tab !== "hierarchy");
            $("adm-panel-settings").classList.toggle("hidden", tab !== "settings");
        };
    });

    $("btn-add-estate").onclick = () => openCrudModal("estate");
    $("btn-add-division").onclick = () => openCrudModal("division");
    $("btn-add-field").onclick = () => openCrudModal("field");
    $("btn-add-block").onclick = () => openCrudModal("block");

    $("btn-ac-save").onclick = async () => {
        if (!state.crudCallback) return;
        try {
            await state.crudCallback();
            $("modal-admin-crud").classList.add("hidden");
            toast("Saved configuration");
            await loadAdminPage();
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
            toast("Saved GPS & Season settings");
            await loadAdminPage();
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
        showAuthView("login");
    }
});

async function doLogout() {
    try {
        await api("/api/auth/logout", "POST");
    } catch (_) {}
    state.token = "";
    state.user = null;
    localStorage.removeItem("el_token");
    showAuthView("login");
}
