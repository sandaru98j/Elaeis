// ============================================================================
// ELAEIS — Palm-based Crop Monitoring & Plantation ERP
// Cloudflare Worker / Pages Function API + D1 (SQLite)
//
// Hierarchy : Estate > Division > Field (year, ha) > Block > Tree
// Scope     : Harvest (Bunches, Fronds, Health, Loose Fruit) + Mill Dispatch (kg)
// Analytics : Total Bunches, Total Fronds, Dispatch Weight, ABW, YPH, FBR, Coverage
// Offline   : Idempotent Sync Batch API (/api/sync/batch) + client_id dedupe
// ============================================================================

const PBKDF2_ITER = 20000;
const SESSION_DAYS = 30;
const MAX_D1_IMAGE_CHARS = 700000; // ~500 KB base64 safe limit for Cloudflare D1 rows
const VALID_HEALTH_STATUSES = [
    "Healthy",
    "Ganoderma / Disease",
    "Nutrient Deficient",
    "Pest / Rhinoceros",
    "Fallen / Vacant",
];

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

function normalizeRole(r) {
    const s = String(r || "").trim().toLowerCase();
    if (s === "master admin" || s === "master_admin" || s === "master") return "Master Admin";
    if (s === "admin") return "Admin";
    if (s === "supervisor") return "Supervisor";
    return "Harvester";
}

function normalizeHealthStatus(h) {
    const s = String(h || "").trim();
    if (!s) return "Healthy";
    const found = VALID_HEALTH_STATUSES.find((v) => v.toLowerCase() === s.toLowerCase());
    return found || "Healthy";
}

function slugifyFilename(name, fallback = "Elaeis") {
    const cleaned = String(name || "")
        .trim()
        .replace(/[^A-Za-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 48);
    return cleaned || fallback;
}

const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS el_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        email TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        full_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'Harvester',
        is_master INTEGER NOT NULL DEFAULT 0,
        pass_hash TEXT NOT NULL,
        approved_by INTEGER,
        approved_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS el_sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS el_resets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        code TEXT NOT NULL,
        channel TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS el_estates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        location_region TEXT DEFAULT ''
    )`,
    `CREATE TABLE IF NOT EXISTS el_divisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        estate_id INTEGER NOT NULL,
        name TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS el_fields (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        division_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        planting_year INTEGER NOT NULL,
        area_ha REAL NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS el_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        field_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        boundary_note TEXT NOT NULL DEFAULT ''
    )`,
    `CREATE TABLE IF NOT EXISTS el_trees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        block_id INTEGER NOT NULL,
        tree_no INTEGER NOT NULL,
        lat REAL,
        lng REAL,
        gps_acc REAL,
        status TEXT NOT NULL DEFAULT 'active',
        health_status TEXT NOT NULL DEFAULT 'Healthy',
        mapped_by INTEGER,
        mapped_at TEXT,
        UNIQUE (block_id, tree_no)
    )`,
    `CREATE TABLE IF NOT EXISTS el_harvest (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tree_id INTEGER NOT NULL,
        harvest_date TEXT NOT NULL,
        year_month TEXT NOT NULL,
        round_no INTEGER NOT NULL,
        bunches INTEGER NOT NULL,
        fronds INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        user_lat REAL,
        user_lng REAL,
        user_acc REAL,
        health_status TEXT NOT NULL DEFAULT 'Healthy',
        loose_fruit INTEGER NOT NULL DEFAULT 1,
        remarks TEXT NOT NULL DEFAULT '',
        recorded_at TEXT NOT NULL,
        UNIQUE (tree_id, year_month, round_no)
    )`,
    `CREATE TABLE IF NOT EXISTS el_dispatch (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        division_id INTEGER NOT NULL,
        dispatch_date TEXT NOT NULL,
        year_month TEXT NOT NULL,
        round_no INTEGER NOT NULL,
        weight_kg REAL NOT NULL,
        client_id TEXT,
        user_id INTEGER NOT NULL,
        recorded_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS el_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_el_trees_block ON el_trees (block_id)`,
    `CREATE INDEX IF NOT EXISTS idx_el_trees_coords ON el_trees (lat, lng)`,
    `CREATE INDEX IF NOT EXISTS idx_el_harvest_date ON el_harvest (harvest_date)`,
    `CREATE INDEX IF NOT EXISTS idx_el_harvest_tree ON el_harvest (tree_id)`,
    `CREATE INDEX IF NOT EXISTS idx_el_harvest_ym_round ON el_harvest (year_month, round_no)`,
    `CREATE INDEX IF NOT EXISTS idx_el_dispatch_date ON el_dispatch (dispatch_date)`,
    `CREATE INDEX IF NOT EXISTS idx_el_dispatch_div ON el_dispatch (division_id, year_month, round_no)`,
    `CREATE INDEX IF NOT EXISTS idx_el_sessions_user ON el_sessions (user_id)`,
];

const ADDITIVE_MIGRATIONS = [
    "ALTER TABLE el_estates ADD COLUMN location_region TEXT DEFAULT ''",
    "ALTER TABLE el_trees ADD COLUMN health_status TEXT NOT NULL DEFAULT 'Healthy'",
    "ALTER TABLE el_harvest ADD COLUMN health_status TEXT NOT NULL DEFAULT 'Healthy'",
    "ALTER TABLE el_harvest ADD COLUMN loose_fruit INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE el_harvest ADD COLUMN remarks TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE el_dispatch ADD COLUMN client_id TEXT",
];

// ---------------------------------------------------------------------------
// Utilities & HTTP Helpers
// ---------------------------------------------------------------------------
class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Expose-Headers": "Content-Disposition",
};

function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            ...SECURITY_HEADERS,
            ...extraHeaders,
        },
    });
}

const fail = (status, message) => {
    throw new HttpError(status, message);
};

const nowIso = () => new Date().toISOString();
const toInt = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
};
const toNum = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const str = (v, max = 120) => String(v ?? "").trim().slice(0, max);

function hex(buf) {
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(h) {
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
}

function safeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

async function pbkdf2(password, salt, iterations) {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        "PBKDF2",
        false,
        ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-256", salt, iterations },
        key,
        256
    );
    return hex(bits);
}

async function hashPassword(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const digest = await pbkdf2(password, salt, PBKDF2_ITER);
    return `pbkdf2$${PBKDF2_ITER}$${hex(salt)}$${digest}`;
}

async function verifyPassword(password, stored) {
    const parts = String(stored || "").split("$");
    if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
    const digest = await pbkdf2(password, fromHex(parts[2]), Number(parts[1]));
    return safeEqual(digest, parts[3]);
}

function randomToken() {
    return hex(crypto.getRandomValues(new Uint8Array(32)));
}

function validDate(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(s || "");
}

function roundOf(dateStr, explicitRound = null) {
    if (!validDate(dateStr)) fail(400, "Invalid date.");
    const r = toInt(explicitRound);
    if (r === 1 || r === 2 || r === 3) {
        return { yearMonth: dateStr.slice(0, 7), round: r };
    }
    const day = Number(dateStr.slice(8, 10));
    return { yearMonth: dateStr.slice(0, 7), round: day <= 10 ? 1 : day <= 20 ? 2 : 3 };
}

function distanceM(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const rad = (x) => (x * Math.PI) / 180;
    const dLat = rad(lat2 - lat1);
    const dLng = rad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function validateImagePayload(val) {
    const s = String(val || "").trim();
    if (!s) return "";
    if (s.startsWith("data:image/")) {
        if (!/^data:image\/(jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i.test(s)) {
            fail(400, "Unsupported image format. Use PNG, JPG, WEBP, or GIF.");
        }
        if (s.length > MAX_D1_IMAGE_CHARS) {
            fail(400, "Image is too large. Please upload an image smaller than 500 KB.");
        }
        return s;
    }
    if (s.startsWith("https://") || (s.startsWith("/uploads/") && !s.includes(".."))) {
        return s.slice(0, 500);
    }
    fail(400, "Invalid image URL or upload format.");
}

function publicUser(u) {
    const isMaster = Boolean(u.is_master) || normalizeRole(u.role) === "Master Admin";
    const role = isMaster ? "Master Admin" : normalizeRole(u.role);
    return {
        id: u.id,
        username: u.username,
        email: u.email || "",
        phone: u.phone || "",
        full_name: u.full_name,
        role,
        is_master: isMaster,
        theme: u.theme || "twitter",
        profile_pic: u.profile_pic || "",
        cover_photo: u.cover_photo || "",
    };
}

// ---------------------------------------------------------------------------
// Schema Bootstrap + Safe Additive Migrations
// ---------------------------------------------------------------------------
let schemaReady = false;

async function ensureSchema(env) {
    if (schemaReady) return;
    const db = env.DB;
    await db.batch(SCHEMA.map((s) => db.prepare(s)));

    // Apply additive column migrations safely on existing D1 databases
    for (const sql of ADDITIVE_MIGRATIONS) {
        try {
            await db.prepare(sql).run();
        } catch (_) {
            // Column already exists
        }
    }
    try {
        await db
            .prepare(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_el_dispatch_client_id ON el_dispatch (client_id) WHERE client_id IS NOT NULL"
            )
            .run();
    } catch (_) {}

    const lock = await db
        .prepare("INSERT OR IGNORE INTO el_settings (key, value) VALUES ('seeded_erp_v4', ?)")
        .bind(nowIso())
        .run();
    if (lock.meta && lock.meta.changes === 1) {
        await seed(env);
    }
    schemaReady = true;
}

async function seed(env) {
    const db = env.DB;
    const erpPass = env.ERP_INITIAL_PASSWORD || "Elaeis2026!";
    const defaultEstate = str(env.ELAEIS_ESTATE_NAME || "Primary Plantation Estate", 80);
    const defaultRegion = str(env.ELAEIS_ESTATE_REGION || "", 120);
    const erpHash = await hashPassword(erpPass);
    const now = nowIso();
    const today = now.slice(0, 10);
    const ym = today.slice(0, 7);
    const curRound = roundOf(today).round;

    const fields = [
        [1, 1, "Field 1", 2011, 11.0],
        [2, 1, "Field 2", 2011, 16.5],
        [3, 1, "Field 3", 2011, 28.0],
        [4, 1, "Field 4", 2013, 19.0],
        [5, 1, "Field 5", 2014, 3.75],
        [6, 1, "Field 6", 2015, 1.75],
        [7, 2, "Field 1", 2012, 22.5],
        [8, 2, "Field 2", 2014, 14.25],
        [9, 3, "Field 1", 2013, 18.0],
        [10, 3, "Field 2", 2016, 12.5],
    ];
    const blockNames = [
        ["Block A", "Stream boundary"],
        ["Block B", "Ridge road boundary"],
    ];
    const treeCounts = [285, 268, 312, 294, 320, 305, 290, 264, 248, 240, 308, 282, 274, 296, 265, 258, 301, 277, 289, 252];

    const erpUsers = [
        [1, "sandaru98j", "Sandaruwan Gunathilaka", "Master Admin", 1],
        [2, "sandun", "Sandun (Estate Manager)", "Admin", 0],
        [3, "raveendra", "Raveendra", "Supervisor", 0],
        [4, "pasindu", "Pasindu", "Supervisor", 0],
        [5, "kavindu", "Kavindu", "Supervisor", 0],
        [6, "muditha", "Muditha", "Supervisor", 0],
        [7, "rajasekaran", "Rajasekaran", "Supervisor", 0],
        [8, "ajith", "Ajith", "Harvester", 0],
        [9, "baba", "Baba", "Harvester", 0],
    ];

    const stmts = erpUsers.map(([id, uname, fname, role, isMaster]) =>
        db
            .prepare(
                `INSERT OR IGNORE INTO el_users (id, username, email, phone, full_name, role, is_master, pass_hash, approved_by, approved_at)
                 VALUES (?, ?, '', '', ?, ?, ?, ?, 1, ?)`
            )
            .bind(id, uname, fname, role, isMaster, erpHash, now)
    );
    stmts.push(
        db.prepare("INSERT OR IGNORE INTO el_settings (key, value) VALUES ('season_start_month', '4')"),
        db
            .prepare("INSERT OR IGNORE INTO el_estates (id, name, location_region) VALUES (1, ?, ?)")
            .bind(defaultEstate, defaultRegion),
        db.prepare("INSERT OR IGNORE INTO el_divisions (id, estate_id, name) VALUES (1, 1, 'Division 1')"),
        db.prepare("INSERT OR IGNORE INTO el_divisions (id, estate_id, name) VALUES (2, 1, 'Division 2')"),
        db.prepare("INSERT OR IGNORE INTO el_divisions (id, estate_id, name) VALUES (3, 1, 'Division 3')")
    );

    let blockId = 0;
    for (const [fid, did, name, year, ha] of fields) {
        stmts.push(
            db
                .prepare(
                    "INSERT OR IGNORE INTO el_fields (id, division_id, name, planting_year, area_ha) VALUES (?, ?, ?, ?, ?)"
                )
                .bind(fid, did, name, year, ha)
        );
        for (const [bname, note] of blockNames) {
            blockId++;
            stmts.push(
                db
                    .prepare("INSERT OR IGNORE INTO el_blocks (id, field_id, name, boundary_note) VALUES (?, ?, ?, ?)")
                    .bind(blockId, fid, bname, note)
            );
            stmts.push(insertTreeRange(db, blockId, 1, treeCounts[blockId - 1] || 280));
        }
    }

    // Pre-map GPS coordinates on Block 1 (Trees 1..150) as starter demonstration
    stmts.push(
        db
            .prepare(
                `UPDATE el_trees
                 SET lat = ROUND(6.1420 + ((tree_no - 1) / 10) * 0.00008, 6),
                     lng = ROUND(80.3650 + ((tree_no - 1) % 10) * 0.00008, 6),
                     gps_acc = 3.8,
                     mapped_by = 1,
                     mapped_at = ?
                 WHERE block_id = 1 AND tree_no <= 150`
            )
            .bind(now)
    );

    const sampleHarvest = [
        [1, `${ym}-04`, ym, 1, 12, 8, 3, 0.00002, 0.00001, 4.1],
        [2, `${ym}-04`, ym, 1, 10, 7, 3, 0.00003, -0.00002, 3.9],
        [3, `${ym}-05`, ym, 1, 14, 9, 3, 0.00002, 0.00001, 4.2],
        [4, `${ym}-05`, ym, 1, 11, 8, 2, 0.00001, 0.00002, 3.5],
        [5, today, ym, curRound, 15, 10, 3, 0.00002, 0.00002, 4.0],
        [6, today, ym, curRound, 9, 6, 3, 0.00001, -0.00001, 4.0],
        [7, today, ym, curRound, 13, 8, 3, 0.00001, -0.00001, 3.7],
        [8, today, ym, curRound, 11, 7, 2, 0.00002, 0.00001, 4.2],
        [12, today, ym, curRound, 14, 9, 3, 0.00003, 0.00001, 4.4],
        [121, today, ym, curRound, 16, 10, 2, 0.00001, 0.00001, 3.2],
    ];
    for (const [tno, dt, ymo, rnd, b, f, uid, dLat, dLng, acc] of sampleHarvest) {
        const baseLat = 6.142 + Math.floor((tno - 1) / 10) * 0.00008;
        const baseLng = 80.365 + ((tno - 1) % 10) * 0.00008;
        stmts.push(
            db
                .prepare(
                    `INSERT OR IGNORE INTO el_harvest
                     (tree_id, harvest_date, year_month, round_no, bunches, fronds, user_id, user_lat, user_lng, user_acc, recorded_at)
                     SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                     FROM el_trees WHERE block_id = 1 AND tree_no = ?`
                )
                .bind(dt, ymo, rnd, b, f, uid, Number((baseLat + dLat).toFixed(6)), Number((baseLng + dLng).toFixed(6)), acc, now, tno)
        );
    }

    const sampleDispatches = [
        [1, `${ym}-05`, ym, 1, 895.0, "seed-disp-1", 2, now],
        [1, today, ym, curRound, 1480.0, "seed-disp-2", 2, now],
        [2, today, ym, curRound, 640.0, "seed-disp-3", 2, now],
    ];
    for (const [divId, dt, ymo, rnd, wkg, cid, uid, recAt] of sampleDispatches) {
        stmts.push(
            db
                .prepare(
                    `INSERT OR IGNORE INTO el_dispatch (division_id, dispatch_date, year_month, round_no, weight_kg, client_id, user_id, recorded_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .bind(divId, dt, ymo, rnd, wkg, cid, uid, recAt)
        );
    }

    await db.batch(stmts);
}

function insertTreeRange(db, blockId, from, to) {
    return db
        .prepare(
            `WITH RECURSIVE seq(n) AS (SELECT ?1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?2)
             INSERT OR IGNORE INTO el_trees (block_id, tree_no) SELECT ?3, n FROM seq`
        )
        .bind(from, to, blockId);
}

async function getSettings(db) {
    const { results } = await db.prepare("SELECT key, value FROM el_settings").all();
    const map = Object.fromEntries((results || []).map((r) => [r.key, r.value]));
    return {
        season_start_month: Number(map.season_start_month || 4),
    };
}

async function getMappedTrees(db) {
    const { results } = await db
        .prepare(
            `SELECT id, block_id, tree_no, lat, lng, gps_acc, health_status
             FROM el_trees
             WHERE status = 'active' AND lat IS NOT NULL AND lng IS NOT NULL
             ORDER BY block_id ASC, tree_no ASC`
        )
        .all();
    return results || [];
}

// ---------------------------------------------------------------------------
// Auth & Sessions (Closed Corporate ERP: Username + Password)
// ---------------------------------------------------------------------------
async function currentUser(request, db, urlParams = {}) {
    const header = request.headers.get("Authorization") || "";
    let token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token && urlParams.token) token = String(urlParams.token).trim();
    if (!token) return null;
    const user = await db
        .prepare(
            `SELECT u.*,
                    COALESCE(st.value, 'twitter') AS theme,
                    COALESCE(sp.value, '') AS profile_pic,
                    COALESCE(sc.value, '') AS cover_photo
             FROM el_sessions s
             JOIN el_users u ON u.id = s.user_id
             LEFT JOIN el_settings st ON st.key = ('user_theme_' || u.id)
             LEFT JOIN el_settings sp ON sp.key = ('user_pic_' || u.id)
             LEFT JOIN el_settings sc ON sc.key = ('user_cover_' || u.id)
             WHERE s.token = ? AND s.expires_at > ?`
        )
        .bind(token, nowIso())
        .first();
    return user ? { ...user, token } : null;
}

function requireRole(user, minRole) {
    if (!user) fail(401, "Please log in.");
    const uRole = user.is_master ? "Master Admin" : normalizeRole(user.role);
    const mRole = normalizeRole(minRole);
    if ((ROLE_RANK[uRole] ?? 0) < (ROLE_RANK[mRole] ?? 1)) {
        fail(403, "You do not have permission for this action.");
    }
}

async function createSession(db, userId) {
    const token = randomToken();
    const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    await db
        .prepare("INSERT INTO el_sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
        .bind(token, userId, expires)
        .run();
    return token;
}

async function handleLogin(db, body) {
    const username = str(body.username || body.identifier, 80).toLowerCase();
    if (!username) fail(400, "Enter your Username.");
    const user = await db
        .prepare(
            `SELECT u.*,
                    COALESCE(st.value, 'twitter') AS theme,
                    COALESCE(sp.value, '') AS profile_pic,
                    COALESCE(sc.value, '') AS cover_photo
             FROM el_users u
             LEFT JOIN el_settings st ON st.key = ('user_theme_' || u.id)
             LEFT JOIN el_settings sp ON sp.key = ('user_pic_' || u.id)
             LEFT JOIN el_settings sc ON sc.key = ('user_cover_' || u.id)
             WHERE LOWER(u.username) = ? LIMIT 1`
        )
        .bind(username)
        .first();
    const ok = user && (await verifyPassword(String(body.password || ""), user.pass_hash));
    if (!ok) fail(401, "Invalid username or password.");
    await db.prepare("DELETE FROM el_sessions WHERE user_id = ? AND expires_at <= ?").bind(user.id, nowIso()).run();
    const token = await createSession(db, user.id);
    return { token, user: publicUser(user) };
}

async function handleChangePassword(db, user, body) {
    const curPw = String(body.current_password || "");
    const newPw = String(body.new_password || "");
    if (newPw.length < 6) fail(400, "New password must be at least 6 characters.");
    const ok = await verifyPassword(curPw, user.pass_hash);
    if (!ok) fail(400, "Current password is incorrect.");
    await db
        .prepare("UPDATE el_users SET pass_hash = ? WHERE id = ?")
        .bind(await hashPassword(newPw), user.id)
        .run();
    return { ok: true, message: "Password updated successfully." };
}

// ---------------------------------------------------------------------------
// Hierarchy & Block Data
// ---------------------------------------------------------------------------
async function getHierarchy(db) {
    const [estates, divisions, fields, blocks] = await db.batch([
        db.prepare("SELECT id, name, COALESCE(location_region, '') AS location_region FROM el_estates ORDER BY id ASC, name ASC"),
        db.prepare("SELECT id, estate_id, name FROM el_divisions ORDER BY id ASC, name ASC"),
        db.prepare("SELECT id, division_id, name, planting_year, area_ha FROM el_fields ORDER BY planting_year, id ASC"),
        db.prepare(
            `SELECT b.id, b.field_id, b.name, b.boundary_note,
                    COUNT(t.id) AS tree_total,
                    SUM(CASE WHEN t.status = 'active' THEN 1 ELSE 0 END) AS tree_active,
                    SUM(CASE WHEN t.lat IS NOT NULL AND t.lng IS NOT NULL THEN 1 ELSE 0 END) AS tree_mapped
             FROM el_blocks b LEFT JOIN el_trees t ON t.block_id = b.id
             GROUP BY b.id ORDER BY b.id ASC`
        ),
    ]);
    return {
        estates: estates.results || [],
        divisions: divisions.results || [],
        fields: fields.results || [],
        blocks: (blocks.results || []).map((b) => ({
            ...b,
            tree_total: b.tree_total || 0,
            tree_active: b.tree_active || 0,
            tree_mapped: b.tree_mapped || 0,
        })),
    };
}

async function getBlockData(db, params) {
    const blockId = toInt(params.block_id);
    if (!blockId) fail(400, "Select a block.");
    const mode = params.mode || "map";
    const date = validDate(params.date) ? params.date : new Date().toISOString().slice(0, 10);

    const { results: trees } = await db
        .prepare(
            `SELECT id, block_id, tree_no, lat, lng, gps_acc, status,
                    COALESCE(health_status, 'Healthy') AS health_status, mapped_at
             FROM el_trees WHERE block_id = ? ORDER BY tree_no`
        )
        .bind(blockId)
        .all();

    const records = {};
    if (mode === "harvest") {
        const { yearMonth, round } = roundOf(date, params.round_no);
        const { results } = await db
            .prepare(
                `SELECT h.tree_id, h.bunches, h.fronds, h.harvest_date, h.round_no,
                        COALESCE(h.health_status, 'Healthy') AS health_status,
                        COALESCE(h.loose_fruit, 1) AS loose_fruit,
                        COALESCE(h.remarks, '') AS remarks
                 FROM el_harvest h JOIN el_trees t ON t.id = h.tree_id
                 WHERE t.block_id = ? AND h.year_month = ? AND h.round_no = ?`
            )
            .bind(blockId, yearMonth, round)
            .all();
        (results || []).forEach((r) => (records[r.tree_id] = r));
    }

    return {
        block_id: blockId,
        date,
        trees: (trees || []).map((t) => ({ ...t, rec: records[t.id] || null })),
    };
}

async function requireTree(db, treeId) {
    const tree = await db.prepare("SELECT * FROM el_trees WHERE id = ?").bind(toInt(treeId)).first();
    if (!tree) fail(404, "Tree not found.");
    if (tree.status !== "active") fail(400, "This tree is marked inactive.");
    return tree;
}

function readGps(body) {
    const lat = toNum(body.lat);
    const lng = toNum(body.lng);
    const acc = toNum(body.acc);
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return { lat: null, lng: null, acc: null };
    }
    return { lat, lng, acc };
}

async function handleHarvest(db, user, body) {
    requireRole(user, "harvester");
    const tree = await requireTree(db, body.tree_id);
    const date = str(body.date, 10);
    const { yearMonth, round } = roundOf(date, body.round_no);
    const bunches = toInt(body.bunches);
    const fronds = toInt(body.fronds);
    if (bunches === null || bunches < 0 || bunches > 60) fail(400, "Bunches must be 0-60.");
    if (fronds === null || fronds < 0 || fronds > 60) fail(400, "Fronds must be 0-60.");

    const gps = readGps(body);
    const finalLat = gps.lat !== null ? gps.lat : (tree.lat ?? null);
    const finalLng = gps.lng !== null ? gps.lng : (tree.lng ?? null);
    const finalAcc = gps.acc !== null ? gps.acc : (tree.gps_acc ?? null);

    const healthStatus = normalizeHealthStatus(body.health_status || tree.health_status || "Healthy");
    const looseFruit = body.loose_fruit === false || body.loose_fruit === 0 || body.loose_fruit === "0" ? 0 : 1;
    const remarks = str(body.remarks || "", 240);

    const stmts = [
        db
            .prepare(
                `INSERT INTO el_harvest
                   (tree_id, harvest_date, year_month, round_no, bunches, fronds, user_id, user_lat, user_lng, user_acc,
                    health_status, loose_fruit, remarks, recorded_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (tree_id, year_month, round_no) DO UPDATE SET
                   harvest_date = excluded.harvest_date, bunches = excluded.bunches, fronds = excluded.fronds,
                   user_id = excluded.user_id, user_lat = excluded.user_lat, user_lng = excluded.user_lng,
                   user_acc = excluded.user_acc, health_status = excluded.health_status,
                   loose_fruit = excluded.loose_fruit, remarks = excluded.remarks,
                   recorded_at = excluded.recorded_at`
            )
            .bind(
                tree.id, date, yearMonth, round, bunches, fronds, user.id,
                finalLat, finalLng, finalAcc, healthStatus, looseFruit, remarks, nowIso()
            ),
    ];

    if (body.health_status) {
        stmts.push(
            db.prepare("UPDATE el_trees SET health_status = ? WHERE id = ?").bind(healthStatus, tree.id)
        );
    }

    await db.batch(stmts);
    return { ok: true, round, lat: finalLat, lng: finalLng, health_status: healthStatus, loose_fruit: looseFruit };
}

// ---------------------------------------------------------------------------
// Dispatch Crop Weight Logger (with client_id Idempotency for Offline Sync)
// ---------------------------------------------------------------------------
async function getDispatches(db, params) {
    const divId = toInt(params.division_id);
    const estateId = toInt(params.estate_id);
    const roundNo = toInt(params.round_no);
    const where = [];
    const binds = [];
    if (divId) {
        where.push("x.division_id = ?");
        binds.push(divId);
    }
    if (estateId) {
        where.push("d.estate_id = ?");
        binds.push(estateId);
    }
    if (roundNo) {
        where.push("x.round_no = ?");
        binds.push(roundNo);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const { results } = await db
        .prepare(
            `SELECT x.id, x.division_id, d.name AS division_name, x.dispatch_date, x.year_month,
                    x.round_no, x.weight_kg, x.client_id, u.full_name AS recorded_by, x.recorded_at
             FROM el_dispatch x
             JOIN el_divisions d ON d.id = x.division_id
             LEFT JOIN el_users u ON u.id = x.user_id
             ${clause}
             ORDER BY x.dispatch_date DESC, x.id DESC LIMIT 200`
        )
        .bind(...binds)
        .all();
    return { dispatches: results || [] };
}

async function handleCreateDispatch(db, user, body) {
    requireRole(user, "harvester");
    const divisionId = toInt(body.division_id);
    const roundNo = toInt(body.round_no);
    const date = str(body.date, 10);
    const weightKg = toNum(body.weight_kg);
    const clientId = str(body.client_id || "", 80) || null;

    if (!divisionId) fail(400, "Select a division.");
    const div = await db.prepare("SELECT id FROM el_divisions WHERE id = ?").bind(divisionId).first();
    if (!div) fail(404, "Division not found.");
    if (roundNo !== 1 && roundNo !== 2 && roundNo !== 3) fail(400, "Select Round 1, 2, or 3.");
    if (!validDate(date)) fail(400, "Select a valid date.");
    if (weightKg === null || weightKg <= 0 || weightKg > 500000) {
        fail(400, "Enter a valid dispatch crop weight in kg.");
    }

    if (clientId) {
        const existing = await db
            .prepare("SELECT id FROM el_dispatch WHERE client_id = ?")
            .bind(clientId)
            .first();
        if (existing) {
            return { ok: true, id: existing.id, deduplicated: true };
        }
    }

    const yearMonth = date.slice(0, 7);
    const res = await db
        .prepare(
            `INSERT INTO el_dispatch (division_id, dispatch_date, year_month, round_no, weight_kg, client_id, user_id, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(divisionId, date, yearMonth, roundNo, weightKg, clientId, user.id, nowIso())
        .run();

    return { ok: true, id: res.meta?.last_row_id || null };
}

async function handleDeleteDispatch(db, user, body) {
    requireRole(user, "supervisor");
    const id = toInt(body.id);
    if (!id) fail(400, "Missing dispatch ID.");
    await db.prepare("DELETE FROM el_dispatch WHERE id = ?").bind(id).run();
    return { ok: true };
}

// ---------------------------------------------------------------------------
// Offline-First Batch Sync Engine (/api/sync/batch)
// ---------------------------------------------------------------------------
async function handleSyncBatch(db, user, body) {
    requireRole(user, "harvester");
    const ops = Array.isArray(body.operations) ? body.operations : [];
    if (ops.length > 200) fail(400, "Maximum 200 operations per sync batch.");

    const results = [];
    let synced = 0;
    let failed = 0;

    for (const op of ops) {
        const cid = str(op?.client_id || "", 80);
        const opType = str(op?.type || "", 30).toLowerCase();
        const payload = op?.payload && typeof op.payload === "object" ? op.payload : {};

        try {
            let data = null;
            if (opType === "harvest") {
                data = await handleHarvest(db, user, payload);
            } else if (opType === "dispatch") {
                data = await handleCreateDispatch(db, user, {
                    ...payload,
                    client_id: payload.client_id || cid || undefined,
                });
            } else if (opType === "calibrate") {
                data = await handleCalibrateTree(db, user, payload);
            } else if (opType === "tree_save") {
                requireRole(user, "Supervisor");
                data = await adminSave(db, user, "tree", payload);
            } else {
                fail(400, `Unsupported sync operation type '${opType}'.`);
            }
            synced++;
            results.push({ client_id: cid, type: opType, ok: true, status: 200, data });
        } catch (err) {
            failed++;
            const status = err instanceof HttpError ? err.status : 500;
            const message = err instanceof HttpError ? err.message : "Operation failed during sync.";
            results.push({ client_id: cid, type: opType, ok: false, status, error: message });
        }
    }

    return { ok: true, synced, failed, results };
}

// ---------------------------------------------------------------------------
// Advanced Yield & Agronomy Analytics Engine
// ---------------------------------------------------------------------------
const JOINS = `JOIN el_trees t ON t.id = x.tree_id
    JOIN el_blocks b ON b.id = t.block_id
    JOIN el_fields f ON f.id = b.field_id
    JOIN el_divisions d ON d.id = f.division_id
    JOIN el_estates e ON e.id = d.estate_id`;

async function resolveScopeEstateName(db, params) {
    const estateId = toInt(params.estate_id);
    if (estateId) {
        const row = await db.prepare("SELECT name FROM el_estates WHERE id = ?").bind(estateId).first();
        if (row?.name) return row.name;
    }
    const first = await db.prepare("SELECT name FROM el_estates ORDER BY id ASC LIMIT 1").first();
    return first?.name || "Elaeis";
}

async function getReport(db, params) {
    const from = validDate(params.from) ? params.from : "1900-01-01";
    const to = validDate(params.to) ? params.to : "2999-12-31";
    const roundFilter = toInt(params.round_no);

    const estateId = toInt(params.estate_id);
    const divisionId = toInt(params.division_id);
    const fieldId = toInt(params.field_id);
    const blockId = toInt(params.block_id);
    const treeId = toInt(params.tree_id);

    // 1. Determine Hectares (area_ha) & Active Tree Stand for YPH & Coverage %
    let haSql = "SELECT COALESCE(SUM(f.area_ha), 0) AS total_ha FROM el_fields f JOIN el_divisions d ON d.id = f.division_id";
    const haBinds = [];
    if (fieldId) {
        haSql += " WHERE f.id = ?";
        haBinds.push(fieldId);
    } else if (blockId) {
        haSql += " JOIN el_blocks b ON b.field_id = f.id WHERE b.id = ?";
        haBinds.push(blockId);
    } else if (treeId) {
        haSql += " JOIN el_blocks b ON b.field_id = f.id JOIN el_trees t ON t.block_id = b.id WHERE t.id = ?";
        haBinds.push(treeId);
    } else if (divisionId) {
        haSql += " WHERE f.division_id = ?";
        haBinds.push(divisionId);
    } else if (estateId) {
        haSql += " WHERE d.estate_id = ?";
        haBinds.push(estateId);
    }

    const tStandWhere = ["t.status = 'active'"];
    const tStandBinds = [];
    if (treeId) {
        tStandWhere.push("t.id = ?");
        tStandBinds.push(treeId);
    } else if (blockId) {
        tStandWhere.push("t.block_id = ?");
        tStandBinds.push(blockId);
    } else if (fieldId) {
        tStandWhere.push("b.field_id = ?");
        tStandBinds.push(fieldId);
    } else if (divisionId) {
        tStandWhere.push("f.division_id = ?");
        tStandBinds.push(divisionId);
    } else if (estateId) {
        tStandWhere.push("d.estate_id = ?");
        tStandBinds.push(estateId);
    }

    // 2. Build Harvest filter clauses
    const hWhere = ["x.harvest_date BETWEEN ? AND ?"];
    const hBinds = [from, to];
    if (roundFilter) {
        hWhere.push("x.round_no = ?");
        hBinds.push(roundFilter);
    }
    if (treeId) {
        hWhere.push("t.id = ?");
        hBinds.push(treeId);
    } else if (blockId) {
        hWhere.push("t.block_id = ?");
        hBinds.push(blockId);
    } else if (fieldId) {
        hWhere.push("b.field_id = ?");
        hBinds.push(fieldId);
    } else if (divisionId) {
        hWhere.push("f.division_id = ?");
        hBinds.push(divisionId);
    } else if (estateId) {
        hWhere.push("d.estate_id = ?");
        hBinds.push(estateId);
    }
    const hClause = `WHERE ${hWhere.join(" AND ")}`;

    // 3. Build Dispatch filter clauses
    let targetDivisionId = divisionId;
    if (!targetDivisionId && (fieldId || blockId || treeId)) {
        let divLookupSql = "SELECT f.division_id FROM el_fields f";
        let divArg = fieldId;
        if (blockId) {
            divLookupSql += " JOIN el_blocks b ON b.field_id = f.id WHERE b.id = ?";
            divArg = blockId;
        } else if (treeId) {
            divLookupSql += " JOIN el_blocks b ON b.field_id = f.id JOIN el_trees t ON t.block_id = b.id WHERE t.id = ?";
            divArg = treeId;
        } else {
            divLookupSql += " WHERE f.id = ?";
        }
        const dRow = await db.prepare(divLookupSql).bind(divArg).first();
        if (dRow) targetDivisionId = dRow.division_id;
    }

    const dWhere = ["x.dispatch_date BETWEEN ? AND ?"];
    const dBinds = [from, to];
    if (roundFilter) {
        dWhere.push("x.round_no = ?");
        dBinds.push(roundFilter);
    }
    if (targetDivisionId) {
        dWhere.push("x.division_id = ?");
        dBinds.push(targetDivisionId);
    } else if (estateId) {
        dWhere.push("d.estate_id = ?");
        dBinds.push(estateId);
    }
    const dClause = `WHERE ${dWhere.join(" AND ")}`;

    // 4. Execute batch queries
    const [haRes, standRes, hTot, dTot, rLogs] = await db.batch([
        db.prepare(haSql).bind(...haBinds),
        db
            .prepare(
                `SELECT COUNT(t.id) AS active_trees,
                        SUM(CASE WHEN COALESCE(t.health_status, 'Healthy') != 'Healthy' THEN 1 ELSE 0 END) AS flagged_trees
                 FROM el_trees t
                 JOIN el_blocks b ON b.id = t.block_id
                 JOIN el_fields f ON f.id = b.field_id
                 JOIN el_divisions d ON d.id = f.division_id
                 WHERE ${tStandWhere.join(" AND ")}`
            )
            .bind(...tStandBinds),
        db
            .prepare(
                `SELECT COALESCE(SUM(bunches), 0) AS bunches,
                        COALESCE(SUM(fronds), 0) AS fronds,
                        COUNT(*) AS records,
                        COUNT(DISTINCT x.tree_id) AS trees
                 FROM el_harvest x ${JOINS} ${hClause}`
            )
            .bind(...hBinds),
        db
            .prepare(
                `SELECT COALESCE(SUM(x.weight_kg), 0) AS dispatch_kg,
                        COUNT(*) AS dispatch_records
                 FROM el_dispatch x JOIN el_divisions d ON d.id = x.division_id ${dClause}`
            )
            .bind(...dBinds),
        db
            .prepare(
                `SELECT x.id, x.harvest_date, x.round_no, x.bunches, x.fronds,
                        COALESCE(x.health_status, 'Healthy') AS health_status,
                        COALESCE(x.loose_fruit, 1) AS loose_fruit,
                        COALESCE(x.remarks, '') AS remarks,
                        t.tree_no, b.name AS block_name, f.name AS field_name, d.name AS division_name,
                        e.name AS estate_name, u.full_name AS recorded_by
                 FROM el_harvest x ${JOINS} LEFT JOIN el_users u ON u.id = x.user_id
                 ${hClause}
                 ORDER BY x.harvest_date DESC, x.id DESC LIMIT 15`
            )
            .bind(...hBinds),
    ]);

    const totalHa = Number(haRes.results[0]?.total_ha || 0);
    const activeTrees = Number(standRes.results[0]?.active_trees || 0);
    const flaggedTrees = Number(standRes.results[0]?.flagged_trees || 0);
    const totalBunches = Number(hTot.results[0]?.bunches || 0);
    const totalFronds = Number(hTot.results[0]?.fronds || 0);
    const harvestedTrees = Number(hTot.results[0]?.trees || 0);
    const totalDispatchKg = Number(dTot.results[0]?.dispatch_kg || 0);

    const abw = totalBunches > 0 ? Number((totalDispatchKg / totalBunches).toFixed(2)) : 0;
    const yph = totalHa > 0 ? Number((totalDispatchKg / totalHa).toFixed(2)) : 0;
    const fbr = totalBunches > 0 ? Number((totalFronds / totalBunches).toFixed(2)) : 0;
    const coveragePct = activeTrees > 0 ? Number(((harvestedTrees / activeTrees) * 100).toFixed(1)) : 0;
    const estateName = await resolveScopeEstateName(db, params);

    return {
        from,
        to,
        estate_name: estateName,
        totals: {
            bunches: totalBunches,
            fronds: totalFronds,
            records: Number(hTot.results[0]?.records || 0),
            trees: harvestedTrees,
            active_trees: activeTrees,
            flagged_trees: flaggedTrees,
            coverage_pct: coveragePct,
            fbr,
            dispatch_kg: totalDispatchKg,
            dispatch_records: Number(dTot.results[0]?.dispatch_records || 0),
            area_ha: totalHa,
            abw,
            yph,
        },
        recent_logs: rLogs.results || [],
    };
}

async function getAgronomyAnalytics(db, params) {
    const from = validDate(params.from) ? params.from : "1900-01-01";
    const to = validDate(params.to) ? params.to : "2999-12-31";
    const estateId = toInt(params.estate_id);
    const divisionId = toInt(params.division_id);
    const fieldId = toInt(params.field_id);
    const blockId = toInt(params.block_id);
    const roundFilter = toInt(params.round_no);

    const scopeWhere = ["t.status = 'active'"];
    const scopeBinds = [];
    if (blockId) {
        scopeWhere.push("b.id = ?");
        scopeBinds.push(blockId);
    } else if (fieldId) {
        scopeWhere.push("f.id = ?");
        scopeBinds.push(fieldId);
    } else if (divisionId) {
        scopeWhere.push("d.id = ?");
        scopeBinds.push(divisionId);
    } else if (estateId) {
        scopeWhere.push("e.id = ?");
        scopeBinds.push(estateId);
    }
    const scopeClause = scopeWhere.join(" AND ");

    const hWhere = ["x.harvest_date BETWEEN ? AND ?"];
    const hBinds = [from, to];
    if (blockId) {
        hWhere.push("b.id = ?");
        hBinds.push(blockId);
    } else if (fieldId) {
        hWhere.push("f.id = ?");
        hBinds.push(fieldId);
    } else if (divisionId) {
        hWhere.push("d.id = ?");
        hBinds.push(divisionId);
    } else if (estateId) {
        hWhere.push("e.id = ?");
        hBinds.push(estateId);
    }

    const hWhereWithRound = [...hWhere];
    const hBindsWithRound = [...hBinds];
    if (roundFilter) {
        hWhereWithRound.push("x.round_no = ?");
        hBindsWithRound.push(roundFilter);
    }

    const dWhere = ["x.dispatch_date BETWEEN ? AND ?"];
    const dBinds = [from, to];
    if (divisionId) {
        dWhere.push("d.id = ?");
        dBinds.push(divisionId);
    } else if (estateId) {
        dWhere.push("d.estate_id = ?");
        dBinds.push(estateId);
    }
    const dWhereWithRound = [...dWhere];
    const dBindsWithRound = [...dBinds];
    if (roundFilter) {
        dWhereWithRound.push("x.round_no = ?");
        dBindsWithRound.push(roundFilter);
    }

    const divFilterWhere = [];
    const divFilterBinds = [];
    if (divisionId) {
        divFilterWhere.push("d.id = ?");
        divFilterBinds.push(divisionId);
    } else if (estateId) {
        divFilterWhere.push("d.estate_id = ?");
        divFilterBinds.push(estateId);
    }
    const divClause = divFilterWhere.length ? `WHERE ${divFilterWhere.join(" AND ")}` : "";

    const [
        roundHarvRes,
        roundDispRes,
        divListRes,
        divHaRes,
        divStandRes,
        divHarvRes,
        divDispRes,
        healthRes,
        looseRes,
    ] = await db.batch([
        db
            .prepare(
                `SELECT x.round_no,
                        COALESCE(SUM(x.bunches), 0) AS bunches,
                        COALESCE(SUM(x.fronds), 0) AS fronds,
                        COUNT(DISTINCT x.tree_id) AS harvested_trees,
                        COUNT(*) AS records
                 FROM el_harvest x ${JOINS}
                 WHERE ${hWhere.join(" AND ")}
                 GROUP BY x.round_no`
            )
            .bind(...hBinds),
        db
            .prepare(
                `SELECT x.round_no, COALESCE(SUM(x.weight_kg), 0) AS dispatch_kg
                 FROM el_dispatch x JOIN el_divisions d ON d.id = x.division_id
                 WHERE ${dWhere.join(" AND ")}
                 GROUP BY x.round_no`
            )
            .bind(...dBinds),
        db
            .prepare(`SELECT d.id, d.name, d.estate_id FROM el_divisions d ${divClause} ORDER BY d.id ASC`)
            .bind(...divFilterBinds),
        db
            .prepare(
                `SELECT f.division_id, COALESCE(SUM(f.area_ha), 0) AS area_ha
                 FROM el_fields f JOIN el_divisions d ON d.id = f.division_id ${divClause}
                 GROUP BY f.division_id`
            )
            .bind(...divFilterBinds),
        db
            .prepare(
                `SELECT d.id AS division_id, COUNT(t.id) AS active_trees
                 FROM el_trees t
                 JOIN el_blocks b ON b.id = t.block_id
                 JOIN el_fields f ON f.id = b.field_id
                 JOIN el_divisions d ON d.id = f.division_id
                 JOIN el_estates e ON e.id = d.estate_id
                 WHERE ${scopeClause}
                 GROUP BY d.id`
            )
            .bind(...scopeBinds),
        db
            .prepare(
                `SELECT d.id AS division_id,
                        COALESCE(SUM(x.bunches), 0) AS bunches,
                        COALESCE(SUM(x.fronds), 0) AS fronds,
                        COUNT(DISTINCT x.tree_id) AS harvested_trees
                 FROM el_harvest x ${JOINS}
                 WHERE ${hWhereWithRound.join(" AND ")}
                 GROUP BY d.id`
            )
            .bind(...hBindsWithRound),
        db
            .prepare(
                `SELECT d.id AS division_id, COALESCE(SUM(x.weight_kg), 0) AS dispatch_kg
                 FROM el_dispatch x JOIN el_divisions d ON d.id = x.division_id
                 WHERE ${dWhereWithRound.join(" AND ")}
                 GROUP BY d.id`
            )
            .bind(...dBindsWithRound),
        db
            .prepare(
                `SELECT COALESCE(t.health_status, 'Healthy') AS health_status, COUNT(t.id) AS cnt
                 FROM el_trees t
                 JOIN el_blocks b ON b.id = t.block_id
                 JOIN el_fields f ON f.id = b.field_id
                 JOIN el_divisions d ON d.id = f.division_id
                 JOIN el_estates e ON e.id = d.estate_id
                 WHERE ${scopeClause}
                 GROUP BY COALESCE(t.health_status, 'Healthy')`
            )
            .bind(...scopeBinds),
        db
            .prepare(
                `SELECT COUNT(*) AS total_logs,
                        SUM(CASE WHEN COALESCE(x.loose_fruit, 1) = 1 THEN 1 ELSE 0 END) AS loose_collected
                 FROM el_harvest x ${JOINS}
                 WHERE ${hWhereWithRound.join(" AND ")}`
            )
            .bind(...hBindsWithRound),
    ]);

    const standByDiv = new Map((divStandRes.results || []).map((r) => [r.division_id, Number(r.active_trees || 0)]));
    const totalActiveTrees = [...standByDiv.values()].reduce((a, b) => a + b, 0);

    const rhMap = new Map((roundHarvRes.results || []).map((r) => [Number(r.round_no), r]));
    const rdMap = new Map((roundDispRes.results || []).map((r) => [Number(r.round_no), Number(r.dispatch_kg || 0)]));
    const rounds = [1, 2, 3].map((rn) => {
        const rh = rhMap.get(rn) || {};
        const bunches = Number(rh.bunches || 0);
        const fronds = Number(rh.fronds || 0);
        const harvestedTrees = Number(rh.harvested_trees || 0);
        const dispatchKg = rdMap.get(rn) || 0;
        return {
            round_no: rn,
            bunches,
            fronds,
            fbr: bunches > 0 ? Number((fronds / bunches).toFixed(2)) : 0,
            harvested_trees: harvestedTrees,
            coverage_pct: totalActiveTrees > 0 ? Number(((harvestedTrees / totalActiveTrees) * 100).toFixed(1)) : 0,
            dispatch_kg: Number(dispatchKg.toFixed(1)),
            abw: bunches > 0 ? Number((dispatchKg / bunches).toFixed(2)) : 0,
        };
    });

    const haByDiv = new Map((divHaRes.results || []).map((r) => [r.division_id, Number(r.area_ha || 0)]));
    const harvByDiv = new Map((divHarvRes.results || []).map((r) => [r.division_id, r]));
    const dispByDiv = new Map((divDispRes.results || []).map((r) => [r.division_id, Number(r.dispatch_kg || 0)]));

    const divisions = (divListRes.results || []).map((d) => {
        const areaHa = haByDiv.get(d.id) || 0;
        const activeTrees = standByDiv.get(d.id) || 0;
        const h = harvByDiv.get(d.id) || {};
        const bunches = Number(h.bunches || 0);
        const fronds = Number(h.fronds || 0);
        const harvestedTrees = Number(h.harvested_trees || 0);
        const dispatchKg = dispByDiv.get(d.id) || 0;
        return {
            id: d.id,
            name: d.name,
            area_ha: Number(areaHa.toFixed(2)),
            active_trees: activeTrees,
            harvested_trees: harvestedTrees,
            coverage_pct: activeTrees > 0 ? Number(((harvestedTrees / activeTrees) * 100).toFixed(1)) : 0,
            bunches,
            fronds,
            fbr: bunches > 0 ? Number((fronds / bunches).toFixed(2)) : 0,
            dispatch_kg: Number(dispatchKg.toFixed(1)),
            abw: bunches > 0 ? Number((dispatchKg / bunches).toFixed(2)) : 0,
            yph: areaHa > 0 ? Number((dispatchKg / areaHa).toFixed(2)) : 0,
        };
    });

    const healthBreakdown = {};
    let flaggedTrees = 0;
    for (const r of healthRes.results || []) {
        const key = r.health_status || "Healthy";
        const cnt = Number(r.cnt || 0);
        healthBreakdown[key] = cnt;
        if (key !== "Healthy") flaggedTrees += cnt;
    }

    const totalLogs = Number(looseRes.results[0]?.total_logs || 0);
    const looseCollected = Number(looseRes.results[0]?.loose_collected || 0);
    const looseFruitPct = totalLogs > 0 ? Number(((looseCollected / totalLogs) * 100).toFixed(1)) : 100;

    const sumBunches = divisions.reduce((s, x) => s + x.bunches, 0);
    const sumFronds = divisions.reduce((s, x) => s + x.fronds, 0);
    const sumHarvested = divisions.reduce((s, x) => s + x.harvested_trees, 0);
    const fbr = sumBunches > 0 ? Number((sumFronds / sumBunches).toFixed(2)) : 0;
    const pruningStatus =
        sumBunches === 0 ? "No Data" : fbr > 2.0 ? "Over-Pruned" : fbr < 0.7 ? "Under-Pruned" : "Optimal";

    return {
        from,
        to,
        rounds,
        divisions,
        health: {
            breakdown: healthBreakdown,
            flagged_trees: flaggedTrees,
            loose_fruit_pct: looseFruitPct,
        },
        summary: {
            active_trees: totalActiveTrees,
            harvested_trees: sumHarvested,
            coverage_pct: totalActiveTrees > 0 ? Number(((sumHarvested / totalActiveTrees) * 100).toFixed(1)) : 0,
            fbr,
            pruning_status: pruningStatus,
            flagged_trees: flaggedTrees,
            loose_fruit_pct: looseFruitPct,
        },
    };
}

function csvCell(v) {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function getReportCsv(db, params) {
    const rep = await getReport(db, params);
    const slug = slugifyFilename(rep.estate_name, "Elaeis");
    const lines = [
        "Metric,Value",
        `Estate,${csvCell(rep.estate_name)}`,
        `From Date,${rep.from}`,
        `To Date,${rep.to}`,
        `Total Bunches Cut,${rep.totals.bunches}`,
        `Total Fronds Cut,${rep.totals.fronds}`,
        `Frond-to-Bunch Ratio (FBR),${rep.totals.fbr}`,
        `Active Palms,${rep.totals.active_trees}`,
        `Harvested Palms,${rep.totals.trees}`,
        `Harvest Coverage (%),${rep.totals.coverage_pct}`,
        `Flagged Health Palms,${rep.totals.flagged_trees}`,
        `Total Dispatched Weight (kg),${rep.totals.dispatch_kg}`,
        `Selected Area (Ha),${rep.totals.area_ha}`,
        `Average Bunch Weight ABW (kg/bunch),${rep.totals.abw}`,
        `Yield Per Hectare YPH (kg/Ha),${rep.totals.yph}`,
    ];
    return new Response(lines.join("\n"), {
        headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${slug}_KPI_Report_${rep.from}_${rep.to}.csv"`,
            "Cache-Control": "no-store",
            ...SECURITY_HEADERS,
        },
    });
}

const EXCEL_MATRIX_HEADERS = [
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

function xmlEsc(s) {
    return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function crc32Bytes(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) {
        c ^= u8[i];
        for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
}

function buildZipStore(files) {
    const enc = new TextEncoder();
    const entries = files.map((f) => {
        const nameBytes = enc.encode(f.name);
        const dataBytes = typeof f.content === "string" ? enc.encode(f.content) : f.content;
        const crc = crc32Bytes(dataBytes);
        return { nameBytes, dataBytes, crc };
    });

    let localSize = 0;
    let cdSize = 0;
    for (const e of entries) {
        localSize += 30 + e.nameBytes.length + e.dataBytes.length;
        cdSize += 46 + e.nameBytes.length;
    }
    const out = new Uint8Array(localSize + cdSize + 22);
    const dv = new DataView(out.buffer);
    let offset = 0;

    for (const e of entries) {
        e.localOffset = offset;
        dv.setUint32(offset, 0x04034b50, true);
        dv.setUint16(offset + 4, 20, true);
        dv.setUint16(offset + 6, 0, true);
        dv.setUint16(offset + 8, 0, true);
        dv.setUint16(offset + 10, 0, true);
        dv.setUint16(offset + 12, 0x21, true);
        dv.setUint32(offset + 14, e.crc, true);
        dv.setUint32(offset + 18, e.dataBytes.length, true);
        dv.setUint32(offset + 22, e.dataBytes.length, true);
        dv.setUint16(offset + 26, e.nameBytes.length, true);
        dv.setUint16(offset + 28, 0, true);
        out.set(e.nameBytes, offset + 30);
        out.set(e.dataBytes, offset + 30 + e.nameBytes.length);
        offset += 30 + e.nameBytes.length + e.dataBytes.length;
    }

    const cdStart = offset;
    for (const e of entries) {
        dv.setUint32(offset, 0x02014b50, true);
        dv.setUint16(offset + 4, 20, true);
        dv.setUint16(offset + 6, 20, true);
        dv.setUint16(offset + 8, 0, true);
        dv.setUint16(offset + 10, 0, true);
        dv.setUint16(offset + 12, 0, true);
        dv.setUint16(offset + 14, 0x21, true);
        dv.setUint32(offset + 16, e.crc, true);
        dv.setUint32(offset + 20, e.dataBytes.length, true);
        dv.setUint32(offset + 24, e.dataBytes.length, true);
        dv.setUint16(offset + 28, e.nameBytes.length, true);
        dv.setUint16(offset + 30, 0, true);
        dv.setUint16(offset + 32, 0, true);
        dv.setUint16(offset + 34, 0, true);
        dv.setUint16(offset + 36, 0, true);
        dv.setUint32(offset + 38, 0, true);
        dv.setUint32(offset + 42, e.localOffset, true);
        out.set(e.nameBytes, offset + 46);
        offset += 46 + e.nameBytes.length;
    }

    dv.setUint32(offset, 0x06054b50, true);
    dv.setUint16(offset + 4, 0, true);
    dv.setUint16(offset + 6, 0, true);
    dv.setUint16(offset + 8, entries.length, true);
    dv.setUint16(offset + 10, entries.length, true);
    dv.setUint32(offset + 12, cdSize, true);
    dv.setUint32(offset + 16, cdStart, true);
    dv.setUint16(offset + 20, 0, true);
    return out;
}

async function queryMonthlyTreeMatrix(db, params) {
    let ym = String(params.year_month || params.month || (params.to || "").slice(0, 7) || (params.from || "").slice(0, 7) || nowIso().slice(0, 7));
    if (!/^\d{4}-\d{2}$/.test(ym)) ym = nowIso().slice(0, 7);

    const where = ["x.year_month = ?"];
    const binds = [ym];
    const estateId = toInt(params.estate_id);
    const divisionId = toInt(params.division_id);
    const fieldId = toInt(params.field_id);
    const blockId = toInt(params.block_id);
    const treeId = toInt(params.tree_id);

    if (estateId) {
        where.push("e.id = ?");
        binds.push(estateId);
    }
    if (divisionId) {
        where.push("d.id = ?");
        binds.push(divisionId);
    }
    if (fieldId) {
        where.push("f.id = ?");
        binds.push(fieldId);
    }
    if (blockId) {
        where.push("b.id = ?");
        binds.push(blockId);
    }
    if (treeId) {
        where.push("t.id = ?");
        binds.push(treeId);
    }

    const sql = `
        SELECT
            e.name AS estate_name,
            d.name AS division_name,
            f.name AS field_name,
            b.name AS block_name,
            t.id AS tree_id,
            t.tree_no AS tree_number,
            COALESCE(SUM(CASE WHEN x.round_no = 1 THEN x.bunches ELSE 0 END), 0) AS r1_bunches,
            COALESCE(SUM(CASE WHEN x.round_no = 1 THEN x.fronds ELSE 0 END), 0) AS r1_fronds,
            COALESCE(SUM(CASE WHEN x.round_no = 2 THEN x.bunches ELSE 0 END), 0) AS r2_bunches,
            COALESCE(SUM(CASE WHEN x.round_no = 2 THEN x.fronds ELSE 0 END), 0) AS r2_fronds,
            COALESCE(SUM(CASE WHEN x.round_no = 3 THEN x.bunches ELSE 0 END), 0) AS r3_bunches,
            COALESCE(SUM(CASE WHEN x.round_no = 3 THEN x.fronds ELSE 0 END), 0) AS r3_fronds
        FROM el_harvest x
        ${JOINS}
        WHERE ${where.join(" AND ")}
        GROUP BY t.id, e.name, d.name, f.name, b.name, t.tree_no
        ORDER BY e.id ASC, d.id ASC, f.id ASC, b.id ASC, t.tree_no ASC
    `;
    const { results } = await db.prepare(sql).bind(...binds).all();
    return { year_month: ym, rows: results || [] };
}

async function getReportXlsx(db, params) {
    const { year_month, rows } = await queryMonthlyTreeMatrix(db, params);
    const estateName = rows[0]?.estate_name || (await resolveScopeEstateName(db, params));
    const slug = slugifyFilename(estateName, "Elaeis");
    const filename = `${slug}_Harvest_Report_${year_month}.xlsx`;

    const cols = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M"];
    const rowXml = [];

    const hdrCells = EXCEL_MATRIX_HEADERS.map(
        (h, i) => `<c r="${cols[i]}1" t="inlineStr"><is><t>${xmlEsc(h)}</t></is></c>`
    ).join("");
    rowXml.push(`<row r="1">${hdrCells}</row>`);

    rows.forEach((r, idx) => {
        const rNum = idx + 2;
        const r1b = Number(r.r1_bunches || 0);
        const r1f = Number(r.r1_fronds || 0);
        const r2b = Number(r.r2_bunches || 0);
        const r2f = Number(r.r2_fronds || 0);
        const r3b = Number(r.r3_bunches || 0);
        const r3f = Number(r.r3_fronds || 0);
        const totB = r1b + r2b + r3b;
        const totF = r1f + r2f + r3f;

        const textVals = [
            r.estate_name || estateName,
            r.division_name || "Division",
            r.field_name || "Field",
            r.block_name || "Block",
            `Palm #${r.tree_number}`,
        ];
        const intVals = [r1b, r1f, r2b, r2f, r3b, r3f];

        const cells = [];
        textVals.forEach((tv, ci) => {
            cells.push(`<c r="${cols[ci]}${rNum}" t="inlineStr"><is><t>${xmlEsc(tv)}</t></is></c>`);
        });
        intVals.forEach((iv, ci) => {
            cells.push(`<c r="${cols[5 + ci]}${rNum}" t="n"><v>${iv}</v></c>`);
        });
        cells.push(`<c r="L${rNum}" t="n"><f>F${rNum}+H${rNum}+J${rNum}</f><v>${totB}</v></c>`);
        cells.push(`<c r="M${rNum}" t="n"><f>G${rNum}+I${rNum}+K${rNum}</f><v>${totF}</v></c>`);
        rowXml.push(`<row r="${rNum}">${cells.join("")}</row>`);
    });

    const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rowXml.join("")}</sheetData>
</worksheet>`;

    const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Tree Matrix ${xmlEsc(year_month)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

    const wbRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

    const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

    const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

    const xlsxBytes = buildZipStore([
        { name: "[Content_Types].xml", content: contentTypesXml },
        { name: "_rels/.rels", content: rootRelsXml },
        { name: "xl/workbook.xml", content: workbookXml },
        { name: "xl/_rels/workbook.xml.rels", content: wbRelsXml },
        { name: "xl/worksheets/sheet1.xml", content: sheetXml },
    ]);

    return new Response(xlsxBytes, {
        status: 200,
        headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Cache-Control": "no-store",
            ...SECURITY_HEADERS,
        },
    });
}

// ---------------------------------------------------------------------------
// Admin: Users (Strict RBAC Hierarchy)
// ---------------------------------------------------------------------------
async function adminUsers(db) {
    const { results } = await db
        .prepare(
            `SELECT id, username, email, phone, full_name, role, is_master, created_at, approved_at
             FROM el_users ORDER BY is_master DESC, id ASC`
        )
        .all();
    return {
        users: (results || []).map((u) => publicUser(u)),
    };
}

async function adminCreateUser(db, env, admin, body) {
    const username = str(body.username, 40).toLowerCase().replace(/^@+/, "");
    const full_name = str(body.full_name, 80);
    const role = normalizeRole(body.role || "Harvester");
    const password = String(body.password || env.ERP_INITIAL_PASSWORD || "Elaeis2026!");
    if (!username || !full_name) fail(400, "Username and Full Name are required.");
    if (!/^[a-z0-9_.-]{2,40}$/.test(username)) {
        fail(400, "Username must be 2-40 characters (letters, numbers, _, ., -).");
    }
    if (password.length < 6) fail(400, "Password must be at least 6 characters.");
    if (role === "Master Admin" && !admin.is_master) fail(403, "Only Master Admin can assign Master Admin role.");
    const dup = await db.prepare("SELECT id FROM el_users WHERE LOWER(username) = ?").bind(username).first();
    if (dup) fail(409, `Username '@${username}' already exists.`);
    await db
        .prepare(
            `INSERT INTO el_users (username, email, phone, full_name, role, is_master, pass_hash, approved_by, approved_at)
             VALUES (?, '', '', ?, ?, 0, ?, ?, ?)`
        )
        .bind(username, full_name, role, await hashPassword(password), admin.id, nowIso())
        .run();
    return { ok: true, message: `Created ERP user @${username} (${role}).` };
}

async function adminTargetUser(db, admin, userId) {
    const target = await db.prepare("SELECT * FROM el_users WHERE id = ?").bind(toInt(userId)).first();
    if (!target) fail(404, "User not found.");
    if (target.is_master && !admin.is_master) fail(403, "Only the Master Admin can change this account.");
    return target;
}

async function adminSetRole(db, admin, body) {
    const target = await adminTargetUser(db, admin, body.user_id);
    if (target.id === admin.id) fail(400, "You cannot modify your own role.");
    const role = normalizeRole(body.role);
    if (target.is_master) {
        fail(400, "The Master Admin role cannot be changed.");
    }
    if (normalizeRole(target.role) === "Admin" && !admin.is_master) {
        fail(403, "Only the Master Admin can change another Admin's role.");
    }
    if (role === "Master Admin" && !admin.is_master) {
        fail(403, "Only the Master Admin can assign Master Admin role.");
    }
    await db
        .prepare("UPDATE el_users SET role = ?, approved_by = ?, approved_at = ? WHERE id = ?")
        .bind(role, admin.id, nowIso(), target.id)
        .run();
    return { ok: true };
}

async function adminForcePassword(db, admin, body) {
    const isMaster = Boolean(admin.is_master) || normalizeRole(admin.role) === "Master Admin";
    if (!isMaster) fail(403, "Only Master Admin can force-reset user passwords.");
    const target = await db.prepare("SELECT * FROM el_users WHERE id = ?").bind(toInt(body.user_id)).first();
    if (!target) fail(404, "User not found.");
    const next = String(body.new_password || body.password || "");
    if (next.length < 6) fail(400, "New password must be at least 6 characters.");
    await db.batch([
        db.prepare("UPDATE el_users SET pass_hash = ? WHERE id = ?").bind(await hashPassword(next), target.id),
        db.prepare("DELETE FROM el_sessions WHERE user_id = ? AND user_id != ?").bind(target.id, admin.id),
    ]);
    return { ok: true, message: `Password force-updated for @${target.username}.` };
}

async function adminDeleteUser(db, admin, body) {
    const target = await adminTargetUser(db, admin, body.user_id);
    if (target.is_master) fail(400, "The Master Admin cannot be deleted.");
    if (target.id === admin.id) fail(400, "You cannot delete your own account.");
    if (normalizeRole(target.role) === "Admin" && !admin.is_master) {
        fail(403, "Only the Master Admin can delete an Admin account.");
    }
    await db.batch([
        db.prepare("DELETE FROM el_sessions WHERE user_id = ?").bind(target.id),
        db.prepare("DELETE FROM el_resets WHERE user_id = ?").bind(target.id),
        db.prepare("DELETE FROM el_users WHERE id = ?").bind(target.id),
    ]);
    return { ok: true };
}

// ---------------------------------------------------------------------------
// Admin: 5-Tier Estate CRUD
// ---------------------------------------------------------------------------
const TREE_SUBQ = {
    tree: "SELECT ?1",
    block: "SELECT id FROM el_trees WHERE block_id = ?1",
    field: "SELECT t.id FROM el_trees t JOIN el_blocks b ON b.id = t.block_id WHERE b.field_id = ?1",
    division: `SELECT t.id FROM el_trees t JOIN el_blocks b ON b.id = t.block_id
               JOIN el_fields f ON f.id = b.field_id WHERE f.division_id = ?1`,
    estate: `SELECT t.id FROM el_trees t JOIN el_blocks b ON b.id = t.block_id
             JOIN el_fields f ON f.id = b.field_id JOIN el_divisions d ON d.id = f.division_id
             WHERE d.estate_id = ?1`,
};

async function adminSave(db, user, entity, body) {
    const id = toInt(body.id);
    const name = str(body.name, 80);

    if (entity === "estate") {
        const region = str(body.location_region || "", 120);
        if (!name) fail(400, "Name is required.");
        if (id) {
            await db
                .prepare("UPDATE el_estates SET name = ?, location_region = ? WHERE id = ?")
                .bind(name, region, id)
                .run();
        } else {
            await db
                .prepare("INSERT INTO el_estates (name, location_region) VALUES (?, ?)")
                .bind(name, region)
                .run();
        }
    } else if (entity === "division") {
        if (!name) fail(400, "Name is required.");
        if (id) await db.prepare("UPDATE el_divisions SET name = ? WHERE id = ?").bind(name, id).run();
        else {
            const estateId = toInt(body.estate_id);
            if (!(await db.prepare("SELECT id FROM el_estates WHERE id = ?").bind(estateId).first())) fail(400, "Unknown estate.");
            await db.prepare("INSERT INTO el_divisions (estate_id, name) VALUES (?, ?)").bind(estateId, name).run();
        }
    } else if (entity === "field") {
        const year = toInt(body.planting_year);
        const ha = toNum(body.area_ha);
        if (!name) fail(400, "Name is required.");
        if (!year || year < 1950 || year > 2100) fail(400, "Enter a valid planting year.");
        if (ha === null || ha <= 0 || ha > 10000) fail(400, "Enter a valid area in hectares.");
        if (id) {
            await db
                .prepare("UPDATE el_fields SET name = ?, planting_year = ?, area_ha = ? WHERE id = ?")
                .bind(name, year, ha, id)
                .run();
        } else {
            const divisionId = toInt(body.division_id);
            if (!(await db.prepare("SELECT id FROM el_divisions WHERE id = ?").bind(divisionId).first())) fail(400, "Unknown division.");
            await db
                .prepare("INSERT INTO el_fields (division_id, name, planting_year, area_ha) VALUES (?, ?, ?, ?)")
                .bind(divisionId, name, year, ha)
                .run();
        }
    } else if (entity === "block") {
        const note = str(body.boundary_note, 160);
        if (!name) fail(400, "Name is required.");
        if (id) {
            await db.prepare("UPDATE el_blocks SET name = ?, boundary_note = ? WHERE id = ?").bind(name, note, id).run();
        } else {
            const fieldId = toInt(body.field_id);
            if (!(await db.prepare("SELECT id FROM el_fields WHERE id = ?").bind(fieldId).first())) fail(400, "Unknown field.");
            const res = await db
                .prepare("INSERT INTO el_blocks (field_id, name, boundary_note) VALUES (?, ?, ?)")
                .bind(fieldId, name, note)
                .run();
            const count = toInt(body.tree_count) || 0;
            if (count < 0 || count > 3000) fail(400, "Tree count must be 0-3000.");
            if (count > 0) await insertTreeRange(db, res.meta.last_row_id, 1, count).run();
        }
    } else if (entity === "tree") {
        const status = body.status === "inactive" ? "inactive" : "active";
        const healthStatus = normalizeHealthStatus(body.health_status || "Healthy");
        const lat = toNum(body.lat);
        const lng = toNum(body.lng);
        const acc = toNum(body.acc);
        const treeNo = toInt(body.tree_no);
        if (!treeNo || treeNo < 1) fail(400, "Enter a valid tree number.");
        const hasGps = lat !== null && lng !== null;
        if (hasGps && (Math.abs(lat) > 90 || Math.abs(lng) > 180)) fail(400, "Invalid coordinates.");
        if (id) {
            const existing = await db.prepare("SELECT * FROM el_trees WHERE id = ?").bind(id).first();
            if (!existing) fail(404, "Tree not found.");
            const dup = await db
                .prepare("SELECT id FROM el_trees WHERE block_id = ? AND tree_no = ? AND id <> ?")
                .bind(existing.block_id, treeNo, id)
                .first();
            if (dup) fail(409, `Tree ${treeNo} already exists in this block.`);
            await db
                .prepare(
                    `UPDATE el_trees SET tree_no = ?, status = ?, health_status = ?, lat = ?, lng = ?, gps_acc = ?,
                       mapped_by = CASE WHEN ? THEN ? ELSE mapped_by END,
                       mapped_at = CASE WHEN ? THEN ? ELSE mapped_at END
                     WHERE id = ?`
                )
                .bind(
                    treeNo, status, healthStatus,
                    hasGps ? lat : null, hasGps ? lng : null, hasGps ? acc : null,
                    hasGps ? 1 : 0, user.id, hasGps ? 1 : 0, nowIso(),
                    id
                )
                .run();
        } else {
            const blockId = toInt(body.block_id);
            if (!(await db.prepare("SELECT id FROM el_blocks WHERE id = ?").bind(blockId).first())) fail(400, "Unknown block.");
            const dup = await db.prepare("SELECT id FROM el_trees WHERE block_id = ? AND tree_no = ?").bind(blockId, treeNo).first();
            if (dup) fail(409, `Tree ${treeNo} already exists in this block.`);
            await db
                .prepare(
                    `INSERT INTO el_trees (block_id, tree_no, lat, lng, gps_acc, status, health_status, mapped_by, mapped_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .bind(
                    blockId, treeNo,
                    hasGps ? lat : null, hasGps ? lng : null, hasGps ? acc : null,
                    status, healthStatus, hasGps ? user.id : null, hasGps ? nowIso() : null
                )
                .run();
        }
    } else {
        fail(404, "Unknown entity.");
    }
    return { ok: true };
}

async function adminDelete(db, entity, body) {
    const id = toInt(body.id);
    if (!id) fail(400, "Missing id.");
    if (!TREE_SUBQ[entity]) fail(404, "Unknown entity.");
    const treeIds = TREE_SUBQ[entity];
    const stmts = [
        db.prepare(`DELETE FROM el_harvest WHERE tree_id IN (${treeIds})`).bind(id),
        db.prepare(`DELETE FROM el_trees WHERE id IN (${treeIds})`).bind(id),
    ];
    if (entity === "estate") {
        stmts.push(
            db.prepare(
                `DELETE FROM el_blocks WHERE field_id IN (SELECT f.id FROM el_fields f
                 JOIN el_divisions d ON d.id = f.division_id WHERE d.estate_id = ?1)`
            ).bind(id),
            db.prepare("DELETE FROM el_fields WHERE division_id IN (SELECT id FROM el_divisions WHERE estate_id = ?1)").bind(id),
            db.prepare("DELETE FROM el_dispatch WHERE division_id IN (SELECT id FROM el_divisions WHERE estate_id = ?1)").bind(id),
            db.prepare("DELETE FROM el_divisions WHERE estate_id = ?1").bind(id),
            db.prepare("DELETE FROM el_estates WHERE id = ?1").bind(id)
        );
    } else if (entity === "division") {
        stmts.push(
            db.prepare("DELETE FROM el_blocks WHERE field_id IN (SELECT id FROM el_fields WHERE division_id = ?1)").bind(id),
            db.prepare("DELETE FROM el_fields WHERE division_id = ?1").bind(id),
            db.prepare("DELETE FROM el_dispatch WHERE division_id = ?1").bind(id),
            db.prepare("DELETE FROM el_divisions WHERE id = ?1").bind(id)
        );
    } else if (entity === "field") {
        stmts.push(
            db.prepare("DELETE FROM el_blocks WHERE field_id = ?1").bind(id),
            db.prepare("DELETE FROM el_fields WHERE id = ?1").bind(id)
        );
    } else if (entity === "block") {
        stmts.push(db.prepare("DELETE FROM el_blocks WHERE id = ?1").bind(id));
    }
    await db.batch(stmts);
    return { ok: true };
}

async function adminBatchTrees(db, body) {
    const blockId = toInt(body.block_id);
    const count = toInt(body.count);
    if (!(await db.prepare("SELECT id FROM el_blocks WHERE id = ?").bind(blockId).first())) fail(400, "Unknown block.");
    if (!count || count < 1 || count > 3000) fail(400, "Count must be 1-3000.");
    const row = await db.prepare("SELECT COALESCE(MAX(tree_no), 0) AS m FROM el_trees WHERE block_id = ?").bind(blockId).first();
    await insertTreeRange(db, blockId, row.m + 1, row.m + count).run();
    return { ok: true, from: row.m + 1, to: row.m + count };
}

async function adminSaveSettings(db, body) {
    const seasonStart = toInt(body.season_start_month) || 4;
    if (seasonStart < 1 || seasonStart > 12) fail(400, "Season start month must be 1-12.");
    await db
        .prepare("INSERT OR REPLACE INTO el_settings (key, value) VALUES ('season_start_month', ?)")
        .bind(String(seasonStart))
        .run();
    return { ok: true };
}

async function handleCalibrateTree(db, user, body) {
    requireRole(user, "Supervisor");
    const treeId = toInt(body.id || body.tree_id);
    const lat = toNum(body.lat);
    const lng = toNum(body.lng);
    const acc = toNum(body.acc) ?? 4.0;
    if (!treeId) fail(400, "Select a valid tree to calibrate.");
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        fail(400, "Enter valid Latitude and Longitude coordinates.");
    }
    await db
        .prepare("UPDATE el_trees SET lat = ?, lng = ?, gps_acc = ?, mapped_by = ?, mapped_at = ? WHERE id = ?")
        .bind(Number(lat.toFixed(6)), Number(lng.toFixed(6)), acc, user.id, nowIso(), treeId)
        .run();
    return { ok: true, lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
}

async function handleNearestTree(db, params) {
    const uLat = toNum(params.lat);
    const uLng = toNum(params.lng);
    const maxRadiusM = Math.min(5000, Math.max(1, toNum(params.max_radius_m) ?? 100));
    const blockId = toInt(params.block_id);
    if (uLat === null || uLng === null) return { tree: null };

    // Fast SQL bounding-box pre-filter before Haversine
    const latDelta = (maxRadiusM / 111320) * 1.25;
    const cosLat = Math.max(0.1, Math.cos((uLat * Math.PI) / 180));
    const lngDelta = (maxRadiusM / (111320 * cosLat)) * 1.25;

    const { results } = await db
        .prepare(
            `SELECT t.id, t.block_id, t.tree_no, t.lat, t.lng, t.gps_acc, b.field_id, f.division_id
             FROM el_trees t
             JOIN el_blocks b ON b.id = t.block_id
             JOIN el_fields f ON f.id = b.field_id
             WHERE t.status = 'active'
               AND t.lat BETWEEN ? AND ?
               AND t.lng BETWEEN ? AND ?`
        )
        .bind(uLat - latDelta, uLat + latDelta, uLng - lngDelta, uLng + lngDelta)
        .all();

    let bestTree = null;
    let bestDist = null;
    for (const r of results || []) {
        const d = Math.round(distanceM(uLat, uLng, r.lat, r.lng) * 10) / 10;
        if (bestDist === null || d < bestDist || (d === bestDist && blockId && r.block_id === blockId)) {
            bestDist = d;
            bestTree = { ...r, distance_m: d };
        }
    }
    if (bestTree && bestDist !== null && bestDist <= maxRadiusM) {
        return { tree: bestTree, distance_m: bestDist };
    }
    return { tree: null, distance_m: bestDist };
}

async function handleMapTrees(db, params) {
    const from = validDate(params.from) ? params.from : "1900-01-01";
    const to = validDate(params.to) ? params.to : "2999-12-31";
    const roundNo = toInt(params.round_no);
    const estateId = toInt(params.estate_id);
    const divisionId = toInt(params.division_id);
    const fieldId = toInt(params.field_id);
    const blockId = toInt(params.block_id);
    const isolate = ["1", "true", "yes"].includes(String(params.isolate || "0").toLowerCase());

    const hConds = ["h.harvest_date BETWEEN ? AND ?"];
    const hBinds = [from, to];
    if (roundNo === 1 || roundNo === 2 || roundNo === 3) {
        hConds.push("h.round_no = ?");
        hBinds.push(roundNo);
    }

    const tConds = ["t.status = 'active'"];
    const tBinds = [];
    if (estateId) {
        tConds.push("e.id = ?");
        tBinds.push(estateId);
    }
    if (isolate) {
        if (blockId) {
            tConds.push("b.id = ?");
            tBinds.push(blockId);
        } else if (fieldId) {
            tConds.push("f.id = ?");
            tBinds.push(fieldId);
        } else if (divisionId) {
            tConds.push("d.id = ?");
            tBinds.push(divisionId);
        }
    }

    // Only plot palms with genuine GPS coordinates (never hallucinate fake coordinates on real estates)
    const mappedConds = [...tConds, "t.lat IS NOT NULL", "t.lng IS NOT NULL"];
    const sql = `
        SELECT
            t.id,
            t.tree_no,
            t.lat,
            t.lng,
            COALESCE(t.health_status, 'Healthy') AS health_status,
            b.id AS block_id,
            b.name AS block_name,
            f.id AS field_id,
            f.name AS field_name,
            d.id AS division_id,
            d.name AS division_name,
            e.id AS estate_id,
            e.name AS estate_name,
            COALESCE(h_agg.bunches, 0) AS bunches,
            COALESCE(h_agg.fronds, 0) AS fronds
        FROM el_trees t
        JOIN el_blocks b ON b.id = t.block_id
        JOIN el_fields f ON f.id = b.field_id
        JOIN el_divisions d ON d.id = f.division_id
        JOIN el_estates e ON e.id = d.estate_id
        LEFT JOIN (
            SELECT tree_id, SUM(bunches) AS bunches, SUM(fronds) AS fronds
            FROM el_harvest h
            WHERE ${hConds.join(" AND ")}
            GROUP BY tree_id
        ) h_agg ON h_agg.tree_id = t.id
        WHERE ${mappedConds.join(" AND ")}
        ORDER BY d.id ASC, f.id ASC, b.id ASC, t.tree_no ASC
    `;

    const unmappedSql = `
        SELECT COUNT(t.id) AS cnt
        FROM el_trees t
        JOIN el_blocks b ON b.id = t.block_id
        JOIN el_fields f ON f.id = b.field_id
        JOIN el_divisions d ON d.id = f.division_id
        JOIN el_estates e ON e.id = d.estate_id
        WHERE ${tConds.join(" AND ")} AND (t.lat IS NULL OR t.lng IS NULL)
    `;

    const [mappedRes, unmappedRes] = await db.batch([
        db.prepare(sql).bind(...hBinds, ...tBinds),
        db.prepare(unmappedSql).bind(...tBinds),
    ]);

    let harvestedCount = 0;
    const trees = (mappedRes.results || []).map((r) => {
        const bunches = Number(r.bunches || 0);
        const fronds = Number(r.fronds || 0);
        const harvested = bunches > 0;
        if (harvested) harvestedCount++;
        return {
            id: r.id,
            tree_no: r.tree_no,
            tree_code: `T-${String(r.tree_no).padStart(3, "0")}`,
            lat: r.lat,
            lng: r.lng,
            health_status: r.health_status || "Healthy",
            block_id: r.block_id,
            block_name: r.block_name,
            field_id: r.field_id,
            field_name: r.field_name,
            division_id: r.division_id,
            division_name: r.division_name,
            estate_id: r.estate_id,
            estate_name: r.estate_name,
            harvested,
            bunches,
            fronds,
        };
    });

    return {
        from,
        to,
        round_no: roundNo,
        total_trees: trees.length,
        unmapped_trees: Number(unmappedRes.results[0]?.cnt || 0),
        harvested_trees: harvestedCount,
        trees,
    };
}

async function getUserRecentActivity(db, userId, limit = 5) {
    const { results } = await db
        .prepare(
            `SELECT x.id, x.harvest_date, x.round_no, x.bunches, x.fronds,
                    COALESCE(x.health_status, 'Healthy') AS health_status,
                    COALESCE(x.loose_fruit, 1) AS loose_fruit,
                    COALESCE(x.remarks, '') AS remarks,
                    t.tree_no, b.name AS block_name, f.name AS field_name,
                    d.name AS division_name, e.name AS estate_name,
                    u.full_name AS recorded_by
             FROM el_harvest x ${JOINS} LEFT JOIN el_users u ON u.id = x.user_id
             WHERE x.user_id = ?
             ORDER BY x.harvest_date DESC, x.id DESC LIMIT ?`
        )
        .bind(userId, limit)
        .all();
    return results || [];
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
async function route(request, env, url) {
    const db = env.DB;
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: SECURITY_HEADERS });
    }

    if (method === "GET" && path === "/api/health") {
        return json({ ok: true, service: "elaeis", runtime: "cloudflare-worker", timestamp: nowIso() });
    }

    const params = Object.fromEntries(url.searchParams.entries());
    const body = method === "POST" ? await request.json().catch(() => ({})) : {};

    // Public auth endpoint (Closed ERP: Username + Password Login Only)
    if (method === "POST" && path === "/api/auth/login") return json(await handleLogin(db, body));

    const user = await currentUser(request, db, params);
    if (!user) fail(401, "Please log in.");

    if (method === "GET" && path === "/api/auth/me") {
        const recent_activity = await getUserRecentActivity(db, user.id, 5);
        return json({ user: publicUser(user), recent_activity });
    }
    if (method === "GET" && path === "/api/profile/activity") {
        return json({ recent_activity: await getUserRecentActivity(db, user.id, 5) });
    }
    if (method === "POST" && (path === "/api/profile/update" || path === "/api/auth/profile")) {
        const full_name = str(body.full_name || user.full_name, 80);
        const username = str(body.username || user.username, 40).toLowerCase().replace(/^@+/, "");
        if (!full_name || !username) fail(400, "Full Name and Username are required.");
        if (!/^[a-z0-9_.-]{2,40}$/.test(username)) {
            fail(400, "Username must be 2-40 characters (letters, numbers, _, ., -).");
        }
        const dup = await db
            .prepare("SELECT id FROM el_users WHERE LOWER(username) = ? AND id != ?")
            .bind(username, user.id)
            .first();
        if (dup) fail(409, `Username '@${username}' is already taken.`);
        const stmts = [
            db.prepare("UPDATE el_users SET full_name = ?, username = ? WHERE id = ?").bind(full_name, username, user.id),
        ];
        if (body.profile_pic !== undefined) {
            const safePic = validateImagePayload(body.profile_pic);
            stmts.push(
                db
                    .prepare("INSERT OR REPLACE INTO el_settings (key, value) VALUES (?, ?)")
                    .bind(`user_pic_${user.id}`, safePic)
            );
            user.profile_pic = safePic;
        }
        if (body.cover_photo !== undefined) {
            const safeCover = validateImagePayload(body.cover_photo);
            stmts.push(
                db
                    .prepare("INSERT OR REPLACE INTO el_settings (key, value) VALUES (?, ?)")
                    .bind(`user_cover_${user.id}`, safeCover)
            );
            user.cover_photo = safeCover;
        }
        await db.batch(stmts);
        user.full_name = full_name;
        user.username = username;
        return json({ ok: true, message: "Profile updated successfully.", user: publicUser(user) });
    }
    if (method === "POST" && path === "/api/auth/logout") {
        await db.prepare("DELETE FROM el_sessions WHERE token = ?").bind(user.token).run();
        return json({ ok: true });
    }
    if (method === "POST" && path === "/api/auth/change-password") {
        return json(await handleChangePassword(db, user, body));
    }
    if (method === "POST" && path === "/api/settings/theme") {
        const validThemes = ["twitter", "dracula-dark", "dracula-light", "nord"];
        const nextTheme = validThemes.includes(body.theme) ? body.theme : "twitter";
        await db
            .prepare("INSERT OR REPLACE INTO el_settings (key, value) VALUES (?, ?)")
            .bind(`user_theme_${user.id}`, nextTheme)
            .run();
        return json({ ok: true, theme: nextTheme });
    }

    // Approved users
    if (method === "GET" && (path === "/api/bootstrap" || path === "/api/hierarchy")) {
        requireRole(user, "Harvester");
        const [hierarchy, settings, mapped_trees] = await Promise.all([
            getHierarchy(db),
            getSettings(db),
            getMappedTrees(db),
        ]);
        return json({ hierarchy, settings, mapped_trees });
    }
    if (method === "GET" && path === "/api/trees/mapped") {
        requireRole(user, "Harvester");
        return json({ trees: await getMappedTrees(db) });
    }
    if (method === "GET" && path === "/api/trees/nearest") {
        requireRole(user, "Harvester");
        return json(await handleNearestTree(db, params));
    }
    if (method === "GET" && path === "/api/map/trees") {
        requireRole(user, "Harvester");
        return json(await handleMapTrees(db, params));
    }
    if (method === "POST" && path === "/api/tree/calibrate") {
        return json(await handleCalibrateTree(db, user, body));
    }
    if (method === "GET" && path === "/api/block") {
        requireRole(user, "Harvester");
        return json(await getBlockData(db, params));
    }
    if (method === "GET" && path === "/api/report") {
        requireRole(user, "Harvester");
        return json(await getReport(db, params));
    }
    if (method === "GET" && path === "/api/analytics/agronomy") {
        requireRole(user, "Harvester");
        return json(await getAgronomyAnalytics(db, params));
    }
    if (method === "GET" && path === "/api/report.csv") {
        requireRole(user, "Harvester");
        return getReportCsv(db, params);
    }
    if (
        (method === "GET" || method === "POST") &&
        (path === "/export/excel" || path === "/api/export/excel" || path === "/api/report.xlsx" || path === "/report.xlsx")
    ) {
        requireRole(user, "Harvester");
        return getReportXlsx(db, { ...params, ...body });
    }
    if (method === "GET" && path === "/api/report/matrix") {
        requireRole(user, "Harvester");
        return json(await queryMonthlyTreeMatrix(db, params));
    }
    if (method === "POST" && path === "/api/harvest") return json(await handleHarvest(db, user, body));
    if (method === "POST" && path === "/api/sync/batch") return json(await handleSyncBatch(db, user, body));

    // Dispatch Crop Weight endpoints
    if (method === "GET" && path === "/api/dispatch") {
        requireRole(user, "Harvester");
        return json(await getDispatches(db, params));
    }
    if (method === "POST" && path === "/api/dispatch") {
        return json(await handleCreateDispatch(db, user, body));
    }
    if (method === "POST" && path === "/api/dispatch/delete") {
        return json(await handleDeleteDispatch(db, user, body));
    }

    // Admin & Master Admin (Supervisor allowed for tree pin save/calibration)
    if (path.startsWith("/api/admin/") || path === "/api/users") {
        if (method === "POST" && path === "/api/admin/tree/save") {
            requireRole(user, "Supervisor");
            return json(await adminSave(db, user, "tree", body));
        }
        requireRole(user, "Admin");
        if (method === "GET" && (path === "/api/admin/users" || path === "/api/users")) return json(await adminUsers(db));
        if (method === "POST" && path === "/api/admin/users/create") return json(await adminCreateUser(db, env, user, body));
        if (method === "POST" && path === "/api/admin/users/role") return json(await adminSetRole(db, user, body));
        if (method === "POST" && (path === "/api/admin/users/force-password" || path === "/api/admin/users/password")) {
            return json(await adminForcePassword(db, user, body));
        }
        if (method === "POST" && path === "/api/admin/users/delete") return json(await adminDeleteUser(db, user, body));
        if (method === "POST" && path === "/api/admin/trees/batch") return json(await adminBatchTrees(db, body));
        if (method === "POST" && path === "/api/admin/settings") return json(await adminSaveSettings(db, body));
        const m = path.match(/^\/api\/admin\/(estate|division|field|block|tree)\/(save|delete)$/);
        if (method === "POST" && m) {
            return json(m[2] === "save" ? await adminSave(db, user, m[1], body) : await adminDelete(db, m[1], body));
        }
    }

    fail(404, "Not found.");
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const isBackendRoute =
            url.pathname.startsWith("/api/") ||
            url.pathname === "/export/excel" ||
            url.pathname === "/report.xlsx";
        if (!isBackendRoute) {
            const assetRes = await env.ASSETS.fetch(request);
            if (assetRes.status === 404 && !url.pathname.includes(".")) {
                return env.ASSETS.fetch(new Request(new URL("/index.html", url.origin), request));
            }
            return assetRes;
        }
        if (!env.DB) {
            return json({ error: "D1 binding 'DB' is missing in wrangler.toml." }, 500);
        }
        try {
            await ensureSchema(env);
            return await route(request, env, url);
        } catch (err) {
            if (err instanceof HttpError) return json({ error: err.message }, err.status);
            console.error(err);
            return json({ error: "Server error. Please try again." }, 500);
        }
    },
};
