// ============================================================================
// ELAEIS — Palm-based Crop Monitoring System
// Cloudflare Worker API + D1 (SQLite)
//
// Hierarchy : Estate > Division > Field (year, ha) > Block > Tree
// Roles     : pending (normal user, no access) < harvester < supervisor < admin
//             The seeded Master Admin can never be demoted or deleted.
// ============================================================================

const PBKDF2_ITER = 20000; // kept moderate to stay inside Workers CPU limits
const SESSION_DAYS = 30;
const RESET_MINUTES = 30;
const ROLE_RANK = { pending: 0, harvester: 1, supervisor: 2, admin: 3 };
const WEED = ["clean", "moderate", "heavy"];
const SANITATION = ["good", "medium", "bad"];

const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS el_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        phone TEXT NOT NULL UNIQUE,
        full_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'pending',
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
        name TEXT NOT NULL
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
        recorded_at TEXT NOT NULL,
        UNIQUE (tree_id, year_month, round_no)
    )`,
    `CREATE TABLE IF NOT EXISTS el_maintenance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tree_id INTEGER NOT NULL,
        work_date TEXT NOT NULL,
        fertilizer_id INTEGER,
        fertilizer_kg REAL,
        weed TEXT,
        sanitation TEXT,
        user_id INTEGER NOT NULL,
        user_lat REAL,
        user_lng REAL,
        user_acc REAL,
        recorded_at TEXT NOT NULL,
        UNIQUE (tree_id, work_date)
    )`,
    `CREATE TABLE IF NOT EXISTS el_fertilizers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        std_kg REAL NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
    )`,
    `CREATE TABLE IF NOT EXISTS el_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_el_trees_block ON el_trees (block_id)`,
    `CREATE INDEX IF NOT EXISTS idx_el_harvest_date ON el_harvest (harvest_date)`,
    `CREATE INDEX IF NOT EXISTS idx_el_harvest_tree ON el_harvest (tree_id)`,
    `CREATE INDEX IF NOT EXISTS idx_el_maint_date ON el_maintenance (work_date)`,
    `CREATE INDEX IF NOT EXISTS idx_el_maint_tree ON el_maintenance (tree_id)`,
    `CREATE INDEX IF NOT EXISTS idx_el_sessions_user ON el_sessions (user_id)`,
];

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            ...extraHeaders,
        },
    });
}

const fail = (status, message) => {
    throw new HttpError(status, message);
};

const nowIso = () => new Date().toISOString();
const addMinutes = (m) => new Date(Date.now() + m * 60000).toISOString();
const normPhone = (s) => String(s || "").replace(/[\s\-()]/g, "");
const toInt = (v) => {
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

function randomCode() {
    const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
    return String(n).padStart(6, "0");
}

function roundOf(dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || "")) fail(400, "Invalid date.");
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
    return 2 * R * Math.asin(Math.sqrt(a));
}

function publicUser(u) {
    return {
        id: u.id,
        username: u.username,
        email: u.email,
        phone: u.phone,
        full_name: u.full_name,
        role: u.role,
        is_master: Boolean(u.is_master),
    };
}

function validDate(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(s || "");
}

// ---------------------------------------------------------------------------
// Schema bootstrap + Uskvalley seed (runs once per database)
// ---------------------------------------------------------------------------
let schemaReady = false;

async function ensureSchema(env) {
    if (schemaReady) return;
    const db = env.DB;
    await db.batch(SCHEMA.map((s) => db.prepare(s)));
    const lock = await db
        .prepare("INSERT OR IGNORE INTO el_settings (key, value) VALUES ('seeded_v2', ?)")
        .bind(nowIso())
        .run();
    if (lock.meta && lock.meta.changes === 1) {
        await seed(env);
    }
    schemaReady = true;
}

async function seed(env) {
    const db = env.DB;
    const adminPass = env.ADMIN_PASSWORD || "Elaeis@2026";
    const adminHash = await hashPassword(adminPass);
    const now = nowIso();
    const today = now.slice(0, 10);
    const ym = today.slice(0, 7);

    const fields = [
        // [id, division_id, name, year, ha]
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
        ["Block A", "Valley stream boundary"],
        ["Block B", "Ridge road boundary"],
    ];
    const treeCounts = [285, 268, 312, 294, 320, 305, 290, 264, 248, 240, 308, 282, 274, 296, 265, 258, 301, 277, 289, 252];

    const stmts = [
        db
            .prepare(
                `INSERT OR IGNORE INTO el_users (id, username, email, phone, full_name, role, is_master, pass_hash, approved_at)
                 VALUES (1, 'admin', 'sandaru98j@gmail.com', '+94770000000', 'Sandaruwan Gunathilaka', 'admin', 1, ?, ?)`
            )
            .bind(adminHash, now),
        db
            .prepare(
                `INSERT OR IGNORE INTO el_users (id, username, email, phone, full_name, role, is_master, pass_hash, approved_by, approved_at)
                 VALUES (2, 'supervisor', 'supervisor@uskvalley.lk', '+94771111111', 'Kasun Perera', 'supervisor', 0, ?, 1, ?)`
            )
            .bind(adminHash, now),
        db
            .prepare(
                `INSERT OR IGNORE INTO el_users (id, username, email, phone, full_name, role, is_master, pass_hash, approved_by, approved_at)
                 VALUES (3, 'harvester', 'harvester@uskvalley.lk', '+94772222222', 'Nimal Silva', 'harvester', 0, ?, 1, ?)`
            )
            .bind(adminHash, now),
        db
            .prepare(
                `INSERT OR IGNORE INTO el_users (id, username, email, phone, full_name, role, is_master, pass_hash)
                 VALUES (4, 'ruwan', 'ruwan@uskvalley.lk', '+94773333333', 'Ruwan Fernando', 'pending', 0, ?)`
            )
            .bind(adminHash),
        db.prepare("INSERT OR IGNORE INTO el_settings (key, value) VALUES ('gps_threshold_m', '20')"),
        db.prepare("INSERT OR IGNORE INTO el_settings (key, value) VALUES ('season_start_month', '4')"),
        db.prepare(
            "INSERT OR IGNORE INTO el_fertilizers (id, code, name, std_kg) VALUES (1, 'ERP', 'Eppawala Rock Phosphate', 2.0)"
        ),
        db.prepare(
            "INSERT OR IGNORE INTO el_fertilizers (id, code, name, std_kg) VALUES (2, 'AOP', 'Adult Oil Palm Mixture', 2.5)"
        ),
        db.prepare("INSERT OR IGNORE INTO el_estates (id, name) VALUES (1, 'Uskvalley Estate')"),
        db.prepare("INSERT OR IGNORE INTO el_divisions (id, estate_id, name) VALUES (1, 1, 'Uskvalley Division')"),
        db.prepare("INSERT OR IGNORE INTO el_divisions (id, estate_id, name) VALUES (2, 1, 'Trafalgar Division')"),
        db.prepare("INSERT OR IGNORE INTO el_divisions (id, estate_id, name) VALUES (3, 1, 'Morawaka Division')"),
    ];

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

    // Pre-map GPS coordinates on Block 1 (Trees 1..150) so GPS Mapper & Compliance Log have real plantation coordinates
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

    // Seed sample harvest & maintenance logs (including Tree 121 and both compliant <=20m and red-flagged >20m GPS entries)
    const sampleHarvest = [
        // [tree_no, date, ym, round, bunches, fronds, user_id, dLat, dLng, acc]
        [1, today, ym, roundOf(today).round, 3, 2, 3, 0.00002, 0.00001, 4.1],
        [2, today, ym, roundOf(today).round, 2, 2, 3, 0.00003, -0.00002, 3.9],
        [3, today, ym, roundOf(today).round, 4, 3, 3, 0.00042, 0.00035, 6.2], // >20m violation (~60m away)
        [4, today, ym, roundOf(today).round, 2, 1, 2, 0.00001, 0.00002, 3.5],
        [5, today, ym, roundOf(today).round, 3, 2, 3, 0.00002, 0.00002, 4.0],
        [6, today, ym, roundOf(today).round, 1, 2, 3, 0.00075, -0.00048, 8.0], // >20m violation (~98m away)
        [7, today, ym, roundOf(today).round, 3, 2, 3, 0.00001, -0.00001, 3.7],
        [8, today, ym, roundOf(today).round, 2, 2, 2, 0.00002, 0.00001, 4.2],
        [12, today, ym, roundOf(today).round, 4, 2, 3, 0.00003, 0.00001, 4.4],
        [121, today, ym, roundOf(today).round, 3, 2, 2, 0.00001, 0.00001, 3.2],
    ];
    for (const [tno, dt, ymo, rnd, b, f, uid, dLat, dLng, acc] of sampleHarvest) {
        const baseLat = 6.1420 + Math.floor((tno - 1) / 10) * 0.00008;
        const baseLng = 80.3650 + ((tno - 1) % 10) * 0.00008;
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

    const sampleMaint = [
        // [tree_no, date, fert_id, kg, weed, sanitation, user_id, dLat, dLng, acc]
        [1, today, 1, 2.0, "clean", "good", 2, 0.00001, 0.00002, 3.6],
        [2, today, 1, 2.0, "clean", "good", 2, 0.00002, -0.00001, 3.8],
        [3, today, 2, 2.5, "moderate", "medium", 2, 0.00002, 0.00002, 4.1],
        [4, today, 2, 2.5, "heavy", "bad", 2, 0.00055, 0.00040, 7.5], // >20m violation (~75m away)
        [5, today, 1, 2.0, "clean", "good", 2, 0.00001, 0.00001, 3.4],
        [121, today, 2, 2.5, "clean", "good", 2, 0.00001, -0.00001, 3.3],
    ];
    for (const [tno, dt, fid, kg, weed, san, uid, dLat, dLng, acc] of sampleMaint) {
        const baseLat = 6.1420 + Math.floor((tno - 1) / 10) * 0.00008;
        const baseLng = 80.3650 + ((tno - 1) % 10) * 0.00008;
        stmts.push(
            db
                .prepare(
                    `INSERT OR IGNORE INTO el_maintenance
                     (tree_id, work_date, fertilizer_id, fertilizer_kg, weed, sanitation, user_id, user_lat, user_lng, user_acc, recorded_at)
                     SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                     FROM el_trees WHERE block_id = 1 AND tree_no = ?`
                )
                .bind(dt, fid, kg, weed, san, uid, Number((baseLat + dLat).toFixed(6)), Number((baseLng + dLng).toFixed(6)), acc, now, tno)
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
    const map = Object.fromEntries(results.map((r) => [r.key, r.value]));
    return {
        gps_threshold_m: Number(map.gps_threshold_m || 20),
        season_start_month: Number(map.season_start_month || 4),
    };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
async function currentUser(request, db) {
    const header = request.headers.get("Authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) return null;
    const user = await db
        .prepare(
            `SELECT u.* FROM el_sessions s JOIN el_users u ON u.id = s.user_id
             WHERE s.token = ? AND s.expires_at > ?`
        )
        .bind(token, nowIso())
        .first();
    return user ? { ...user, token } : null;
}

function requireRole(user, minRole) {
    if (!user) fail(401, "Please log in.");
    if (user.role === "pending") fail(403, "Your account is waiting for admin approval.");
    if ((ROLE_RANK[user.role] ?? 0) < ROLE_RANK[minRole]) {
        fail(403, "You do not have permission for this action.");
    }
}

async function findUserByIdentifier(db, identifier) {
    const idf = str(identifier, 120);
    if (!idf) return null;
    return db
        .prepare("SELECT * FROM el_users WHERE username = ? OR email = ? OR phone = ? LIMIT 1")
        .bind(idf, idf, normPhone(idf))
        .first();
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

async function handleRegister(db, body) {
    const full_name = str(body.full_name, 80);
    const username = str(body.username, 32);
    const email = str(body.email, 120).toLowerCase();
    const phone = normPhone(body.phone);
    const password = String(body.password || "");

    if (full_name.length < 2) fail(400, "Enter your full name.");
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) fail(400, "Username: 3-32 letters, numbers, . _ -");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, "Enter a valid email address.");
    if (!/^\+?\d{9,15}$/.test(phone)) fail(400, "Enter a valid mobile number.");
    if (password.length < 8) fail(400, "Password must be at least 8 characters.");

    const clash = await db
        .prepare("SELECT username, email, phone FROM el_users WHERE username = ? OR email = ? OR phone = ?")
        .bind(username, email, phone)
        .first();
    if (clash) {
        if (clash.username.toLowerCase() === username.toLowerCase()) fail(409, "Username is already taken.");
        if (clash.email.toLowerCase() === email) fail(409, "Email is already registered.");
        fail(409, "Mobile number is already registered.");
    }

    const pass_hash = await hashPassword(password);
    const res = await db
        .prepare(
            `INSERT INTO el_users (username, email, phone, full_name, role, pass_hash)
             VALUES (?, ?, ?, ?, 'pending', ?)`
        )
        .bind(username, email, phone, full_name, pass_hash)
        .run();
    const user = await db.prepare("SELECT * FROM el_users WHERE id = ?").bind(res.meta.last_row_id).first();
    const token = await createSession(db, user.id);
    return { token, user: publicUser(user) };
}

async function handleLogin(db, body) {
    const user = await findUserByIdentifier(db, body.identifier);
    const ok = user && (await verifyPassword(String(body.password || ""), user.pass_hash));
    if (!ok) fail(401, "Incorrect login details.");
    await db.prepare("DELETE FROM el_sessions WHERE user_id = ? AND expires_at <= ?").bind(user.id, nowIso()).run();
    const token = await createSession(db, user.id);
    return { token, user: publicUser(user) };
}

async function handleForgot(db, body) {
    const channel = body.channel === "email" ? "email" : "sms";
    const user = await findUserByIdentifier(db, body.identifier);
    let code = null;
    if (user) {
        code = randomCode();
        await db
            .prepare("UPDATE el_resets SET used = 1 WHERE user_id = ? AND used = 0")
            .bind(user.id)
            .run();
        await db
            .prepare(
                `INSERT INTO el_resets (user_id, code, channel, created_at, expires_at)
                 VALUES (?, ?, ?, ?, ?)`
            )
            .bind(user.id, code, channel, nowIso(), addMinutes(RESET_MINUTES))
            .run();
    }
    return { ok: true, demo_code: code };
}

async function handleReset(db, body) {
    const user = await findUserByIdentifier(db, body.identifier);
    const code = str(body.code, 6);
    const next = String(body.new_password || "");
    if (next.length < 8) fail(400, "Password must be at least 8 characters.");
    if (!user) fail(400, "Invalid or expired code.");

    const reset = await db
        .prepare(
            `SELECT * FROM el_resets WHERE user_id = ? AND used = 0 AND expires_at > ?
             ORDER BY id DESC LIMIT 1`
        )
        .bind(user.id, nowIso())
        .first();
    if (!reset) fail(400, "Invalid or expired code.");

    if (!safeEqual(reset.code, code)) {
        const attempts = reset.attempts + 1;
        await db
            .prepare("UPDATE el_resets SET attempts = ?, used = ? WHERE id = ?")
            .bind(attempts, attempts >= 5 ? 1 : 0, reset.id)
            .run();
        fail(400, "Invalid or expired code.");
    }

    await db.batch([
        db.prepare("UPDATE el_users SET pass_hash = ? WHERE id = ?").bind(await hashPassword(next), user.id),
        db.prepare("UPDATE el_resets SET used = 1 WHERE id = ?").bind(reset.id),
        db.prepare("DELETE FROM el_sessions WHERE user_id = ?").bind(user.id),
    ]);
    return { ok: true };
}

async function handleChangePassword(db, user, body) {
    if (!(await verifyPassword(String(body.current || ""), user.pass_hash))) {
        fail(400, "Current password is incorrect.");
    }
    const next = String(body.next || "");
    if (next.length < 8) fail(400, "Password must be at least 8 characters.");
    await db.batch([
        db.prepare("UPDATE el_users SET pass_hash = ? WHERE id = ?").bind(await hashPassword(next), user.id),
        db.prepare("DELETE FROM el_sessions WHERE user_id = ? AND token <> ?").bind(user.id, user.token),
    ]);
    return { ok: true };
}

// ---------------------------------------------------------------------------
// Hierarchy & block data
// ---------------------------------------------------------------------------
async function getHierarchy(db) {
    const [estates, divisions, fields, blocks] = await db.batch([
        db.prepare("SELECT id, name FROM el_estates ORDER BY name"),
        db.prepare("SELECT id, estate_id, name FROM el_divisions ORDER BY name"),
        db.prepare("SELECT id, division_id, name, planting_year, area_ha FROM el_fields ORDER BY planting_year, name"),
        db.prepare(
            `SELECT b.id, b.field_id, b.name, b.boundary_note,
                    COUNT(t.id) AS tree_total,
                    SUM(CASE WHEN t.status = 'active' THEN 1 ELSE 0 END) AS tree_active,
                    SUM(CASE WHEN t.lat IS NOT NULL THEN 1 ELSE 0 END) AS tree_mapped
             FROM el_blocks b LEFT JOIN el_trees t ON t.block_id = b.id
             GROUP BY b.id ORDER BY b.name`
        ),
    ]);
    return {
        estates: estates.results,
        divisions: divisions.results,
        fields: fields.results,
        blocks: blocks.results.map((b) => ({
            ...b,
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
            `SELECT id, tree_no, lat, lng, gps_acc, status, mapped_at
             FROM el_trees WHERE block_id = ? ORDER BY tree_no`
        )
        .bind(blockId)
        .all();

    const records = {};
    if (mode === "harvest") {
        const { yearMonth, round } = roundOf(date);
        const { results } = await db
            .prepare(
                `SELECT h.tree_id, h.bunches, h.fronds, h.harvest_date
                 FROM el_harvest h JOIN el_trees t ON t.id = h.tree_id
                 WHERE t.block_id = ? AND h.year_month = ? AND h.round_no = ?`
            )
            .bind(blockId, yearMonth, round)
            .all();
        results.forEach((r) => (records[r.tree_id] = r));
    } else if (mode === "maintenance") {
        const month = date.slice(0, 7);
        const { results } = await db
            .prepare(
                `SELECT m.tree_id, m.work_date, m.fertilizer_kg, m.weed, m.sanitation, f.code AS fertilizer_code
                 FROM el_maintenance m
                 JOIN el_trees t ON t.id = m.tree_id
                 LEFT JOIN el_fertilizers f ON f.id = m.fertilizer_id
                 WHERE t.block_id = ? AND substr(m.work_date, 1, 7) = ?
                 ORDER BY m.work_date ASC`
            )
            .bind(blockId, month)
            .all();
        // Later rows overwrite earlier ones, keeping the latest state per tree this month.
        results.forEach((r) => {
            const prev = records[r.tree_id] || {};
            records[r.tree_id] = {
                work_date: r.work_date,
                fertilizer_code: r.fertilizer_code || prev.fertilizer_code || null,
                fertilizer_kg: r.fertilizer_code ? r.fertilizer_kg : prev.fertilizer_kg || null,
                weed: r.weed || prev.weed || null,
                sanitation: r.sanitation || prev.sanitation || null,
            };
        });
    }

    return {
        block_id: blockId,
        date,
        trees: trees.map((t) => ({ ...t, rec: records[t.id] || null })),
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

function distanceInfo(tree, gps) {
    if (tree.lat === null || tree.lng === null || gps.lat === null) return null;
    return Math.round(distanceM(tree.lat, tree.lng, gps.lat, gps.lng) * 10) / 10;
}

async function handleHarvest(db, user, body) {
    requireRole(user, "harvester");
    const tree = await requireTree(db, body.tree_id);
    const date = str(body.date, 10);
    const { yearMonth, round } = roundOf(date);
    const bunches = toInt(body.bunches);
    const fronds = toInt(body.fronds);
    if (bunches === null || bunches < 0 || bunches > 60) fail(400, "Bunches must be 0-60.");
    if (fronds === null || fronds < 0 || fronds > 60) fail(400, "Fronds must be 0-60.");
    const gps = readGps(body);

    await db
        .prepare(
            `INSERT INTO el_harvest
               (tree_id, harvest_date, year_month, round_no, bunches, fronds, user_id, user_lat, user_lng, user_acc, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (tree_id, year_month, round_no) DO UPDATE SET
               harvest_date = excluded.harvest_date, bunches = excluded.bunches, fronds = excluded.fronds,
               user_id = excluded.user_id, user_lat = excluded.user_lat, user_lng = excluded.user_lng,
               user_acc = excluded.user_acc, recorded_at = excluded.recorded_at`
        )
        .bind(tree.id, date, yearMonth, round, bunches, fronds, user.id, gps.lat, gps.lng, gps.acc, nowIso())
        .run();

    return { ok: true, round, distance_m: distanceInfo(tree, gps) };
}

async function handleMaintenance(db, user, body) {
    requireRole(user, "supervisor");
    const tree = await requireTree(db, body.tree_id);
    const date = str(body.date, 10);
    if (!validDate(date)) fail(400, "Invalid date.");

    let fertilizerId = toInt(body.fertilizer_id);
    let fertilizerKg = toNum(body.fertilizer_kg);
    if (fertilizerId) {
        const fert = await db.prepare("SELECT id FROM el_fertilizers WHERE id = ? AND active = 1").bind(fertilizerId).first();
        if (!fert) fail(400, "Unknown fertilizer.");
        if (fertilizerKg === null || fertilizerKg <= 0 || fertilizerKg > 50) fail(400, "Fertilizer kg must be 0-50.");
    } else {
        fertilizerId = null;
        fertilizerKg = null;
    }
    const weed = WEED.includes(body.weed) ? body.weed : null;
    const sanitation = SANITATION.includes(body.sanitation) ? body.sanitation : null;
    if (!fertilizerId && !weed && !sanitation) fail(400, "Enter fertilizer, weed, or sanitation.");
    const gps = readGps(body);

    await db
        .prepare(
            `INSERT INTO el_maintenance
               (tree_id, work_date, fertilizer_id, fertilizer_kg, weed, sanitation, user_id, user_lat, user_lng, user_acc, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (tree_id, work_date) DO UPDATE SET
               fertilizer_id = COALESCE(excluded.fertilizer_id, el_maintenance.fertilizer_id),
               fertilizer_kg = COALESCE(excluded.fertilizer_kg, el_maintenance.fertilizer_kg),
               weed = COALESCE(excluded.weed, el_maintenance.weed),
               sanitation = COALESCE(excluded.sanitation, el_maintenance.sanitation),
               user_id = excluded.user_id, user_lat = excluded.user_lat, user_lng = excluded.user_lng,
               user_acc = excluded.user_acc, recorded_at = excluded.recorded_at`
        )
        .bind(tree.id, date, fertilizerId, fertilizerKg, weed, sanitation, user.id, gps.lat, gps.lng, gps.acc, nowIso())
        .run();

    return { ok: true, distance_m: distanceInfo(tree, gps) };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
const JOINS = `JOIN el_trees t ON t.id = x.tree_id
    JOIN el_blocks b ON b.id = t.block_id
    JOIN el_fields f ON f.id = b.field_id
    JOIN el_divisions d ON d.id = f.division_id
    JOIN el_estates e ON e.id = d.estate_id`;

function reportScope(params) {
    const from = validDate(params.from) ? params.from : "1900-01-01";
    const to = validDate(params.to) ? params.to : "2999-12-31";
    const where = [];
    const binds = [];
    let group;
    if (toInt(params.tree_id)) {
        where.push("t.id = ?");
        binds.push(toInt(params.tree_id));
        group = { level: "Month", key: "substr(DATE, 1, 7)", label: "substr(DATE, 1, 7)" };
    } else if (toInt(params.block_id)) {
        where.push("t.block_id = ?");
        binds.push(toInt(params.block_id));
        group = { level: "Tree", key: "t.id", label: "'Tree ' || t.tree_no" };
    } else if (toInt(params.field_id)) {
        where.push("b.field_id = ?");
        binds.push(toInt(params.field_id));
        group = { level: "Block", key: "b.id", label: "b.name" };
    } else if (toInt(params.division_id)) {
        where.push("f.division_id = ?");
        binds.push(toInt(params.division_id));
        group = {
            level: "Field",
            key: "f.id",
            label: "f.name || ' (' || f.planting_year || ' - ' || printf('%.2f', f.area_ha) || ' Ha)'",
        };
    } else if (toInt(params.estate_id)) {
        where.push("d.estate_id = ?");
        binds.push(toInt(params.estate_id));
        group = { level: "Division", key: "d.id", label: "d.name" };
    } else {
        group = { level: "Estate", key: "e.id", label: "e.name" };
    }
    return { from, to, where, binds, group };
}

async function getReport(db, params) {
    const s = reportScope(params);
    const extra = s.where.length ? " AND " + s.where.join(" AND ") : "";
    const hWhere = `WHERE x.harvest_date BETWEEN ? AND ?${extra}`;
    const mWhere = `WHERE x.work_date BETWEEN ? AND ?${extra}`;
    const binds = [s.from, s.to, ...s.binds];
    const spanDays = (Date.parse(s.to) - Date.parse(s.from)) / 86400000;
    const bucketLen = !Number.isFinite(spanDays) || spanDays > 62 ? 7 : 10;
    const hKey = s.group.key.replaceAll("DATE", "x.harvest_date");
    const hLabel = s.group.label.replaceAll("DATE", "x.harvest_date");
    const mKey = s.group.key.replaceAll("DATE", "x.work_date");
    const mLabel = s.group.label.replaceAll("DATE", "x.work_date");

    const q = (sql) => db.prepare(sql).bind(...binds);
    const [hTot, mTot, fertByType, weed, sanit, hSeries, mSeries, hGroup, mGroup] = await db.batch([
        q(`SELECT COALESCE(SUM(bunches), 0) AS bunches, COALESCE(SUM(fronds), 0) AS fronds,
                  COUNT(*) AS records, COUNT(DISTINCT x.tree_id) AS trees
           FROM el_harvest x ${JOINS} ${hWhere}`),
        q(`SELECT COALESCE(SUM(fertilizer_kg), 0) AS fert_kg,
                  SUM(CASE WHEN fertilizer_id IS NOT NULL THEN 1 ELSE 0 END) AS fert_records,
                  COUNT(DISTINCT CASE WHEN fertilizer_id IS NOT NULL THEN x.tree_id END) AS fert_trees,
                  COUNT(*) AS records
           FROM el_maintenance x ${JOINS} ${mWhere}`),
        q(`SELECT fz.code, COALESCE(SUM(x.fertilizer_kg), 0) AS kg, COUNT(*) AS records
           FROM el_maintenance x ${JOINS} JOIN el_fertilizers fz ON fz.id = x.fertilizer_id
           ${mWhere} GROUP BY fz.code ORDER BY kg DESC`),
        q(`SELECT x.weed AS k, COUNT(*) AS n FROM el_maintenance x ${JOINS}
           ${mWhere} AND x.weed IS NOT NULL GROUP BY x.weed`),
        q(`SELECT x.sanitation AS k, COUNT(*) AS n FROM el_maintenance x ${JOINS}
           ${mWhere} AND x.sanitation IS NOT NULL GROUP BY x.sanitation`),
        q(`SELECT substr(x.harvest_date, 1, ${bucketLen}) AS p, SUM(bunches) AS bunches, SUM(fronds) AS fronds
           FROM el_harvest x ${JOINS} ${hWhere} GROUP BY p ORDER BY p`),
        q(`SELECT substr(x.work_date, 1, ${bucketLen}) AS p, COALESCE(SUM(fertilizer_kg), 0) AS fert_kg
           FROM el_maintenance x ${JOINS} ${mWhere} GROUP BY p ORDER BY p`),
        q(`SELECT ${hKey} AS k, ${hLabel} AS label, SUM(bunches) AS bunches, SUM(fronds) AS fronds
           FROM el_harvest x ${JOINS} ${hWhere} GROUP BY k ORDER BY bunches DESC LIMIT 60`),
        q(`SELECT ${mKey} AS k, ${mLabel} AS label, COALESCE(SUM(fertilizer_kg), 0) AS fert_kg
           FROM el_maintenance x ${JOINS} ${mWhere} GROUP BY k`),
    ]);

    const series = {};
    hSeries.results.forEach((r) => (series[r.p] = { p: r.p, bunches: r.bunches, fronds: r.fronds, fert_kg: 0 }));
    mSeries.results.forEach((r) => {
        series[r.p] = series[r.p] || { p: r.p, bunches: 0, fronds: 0, fert_kg: 0 };
        series[r.p].fert_kg = r.fert_kg;
    });

    const breakdown = {};
    hGroup.results.forEach((r) => (breakdown[r.k] = { label: r.label, bunches: r.bunches, fronds: r.fronds, fert_kg: 0 }));
    mGroup.results.forEach((r) => {
        breakdown[r.k] = breakdown[r.k] || { label: r.label, bunches: 0, fronds: 0, fert_kg: 0 };
        breakdown[r.k].fert_kg = r.fert_kg;
    });

    return {
        from: s.from,
        to: s.to,
        bucket: bucketLen === 7 ? "month" : "day",
        totals: { ...hTot.results[0], ...mTot.results[0], maint_records: mTot.results[0].records },
        fertilizer: fertByType.results,
        weed: Object.fromEntries(weed.results.map((r) => [r.k, r.n])),
        sanitation: Object.fromEntries(sanit.results.map((r) => [r.k, r.n])),
        series: Object.values(series).sort((a, b) => (a.p < b.p ? -1 : 1)),
        group_level: s.group.level,
        breakdown: Object.values(breakdown)
            .sort((a, b) => b.bunches - a.bunches || b.fert_kg - a.fert_kg)
            .slice(0, 40),
    };
}

function csvCell(v) {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function getReportCsv(db, params) {
    const s = reportScope(params);
    const extra = s.where.length ? " AND " + s.where.join(" AND ") : "";
    const binds = [s.from, s.to, ...s.binds];
    const [h, m] = await db.batch([
        db
            .prepare(
                `SELECT 'Harvest' AS activity, x.harvest_date AS date, 'R' || x.round_no AS round,
                        e.name AS estate, d.name AS division, f.name AS field, f.planting_year, f.area_ha,
                        b.name AS block, t.tree_no, x.bunches, x.fronds, NULL AS fertilizer, NULL AS fertilizer_kg,
                        NULL AS weed, NULL AS sanitation, u.full_name AS recorded_by, x.recorded_at
                 FROM el_harvest x ${JOINS} JOIN el_users u ON u.id = x.user_id
                 WHERE x.harvest_date BETWEEN ? AND ?${extra} ORDER BY x.harvest_date LIMIT 20000`
            )
            .bind(...binds),
        db
            .prepare(
                `SELECT 'Field Care' AS activity, x.work_date AS date, NULL AS round,
                        e.name AS estate, d.name AS division, f.name AS field, f.planting_year, f.area_ha,
                        b.name AS block, t.tree_no, NULL AS bunches, NULL AS fronds, fz.code AS fertilizer,
                        x.fertilizer_kg, x.weed, x.sanitation, u.full_name AS recorded_by, x.recorded_at
                 FROM el_maintenance x ${JOINS} JOIN el_users u ON u.id = x.user_id
                 LEFT JOIN el_fertilizers fz ON fz.id = x.fertilizer_id
                 WHERE x.work_date BETWEEN ? AND ?${extra} ORDER BY x.work_date LIMIT 20000`
            )
            .bind(...binds),
    ]);
    const cols = [
        "activity", "date", "round", "estate", "division", "field", "planting_year", "area_ha", "block",
        "tree_no", "bunches", "fronds", "fertilizer", "fertilizer_kg", "weed", "sanitation", "recorded_by", "recorded_at",
    ];
    const lines = [cols.join(",")];
    [...h.results, ...m.results].forEach((r) => lines.push(cols.map((c) => csvCell(r[c])).join(",")));
    return new Response(lines.join("\n"), {
        headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="elaeis_report_${s.from}_${s.to}.csv"`,
            "Cache-Control": "no-store",
        },
    });
}

// ---------------------------------------------------------------------------
// Admin: compliance log
// ---------------------------------------------------------------------------
async function getCompliance(db, params) {
    const from = validDate(params.from) ? params.from : "1900-01-01";
    const to = validDate(params.to) ? params.to : "2999-12-31";
    const userId = toInt(params.user_id);
    const userClause = userId ? " AND x.user_id = ?" : "";
    const binds = userId ? [from, to, userId, from, to, userId] : [from, to, from, to];
    const settings = await getSettings(db);

    const { results } = await db
        .prepare(
            `SELECT * FROM (
                SELECT 'harvest' AS activity, x.id, x.recorded_at, x.harvest_date AS work_date,
                       x.user_lat, x.user_lng, x.user_acc, u.full_name, u.role,
                       t.tree_no, t.lat AS tree_lat, t.lng AS tree_lng,
                       b.name AS block, f.name AS field, d.name AS division,
                       x.bunches || ' B / ' || x.fronds || ' F' AS detail
                FROM el_harvest x ${JOINS} JOIN el_users u ON u.id = x.user_id
                WHERE x.harvest_date BETWEEN ? AND ?${userClause}
                UNION ALL
                SELECT 'maintenance', x.id, x.recorded_at, x.work_date,
                       x.user_lat, x.user_lng, x.user_acc, u.full_name, u.role,
                       t.tree_no, t.lat, t.lng, b.name, f.name, d.name,
                       TRIM(COALESCE(fz.code || ' ' || x.fertilizer_kg || 'kg ', '') ||
                            COALESCE('Weed:' || x.weed || ' ', '') ||
                            COALESCE('San:' || x.sanitation, ''))
                FROM el_maintenance x ${JOINS} JOIN el_users u ON u.id = x.user_id
                LEFT JOIN el_fertilizers fz ON fz.id = x.fertilizer_id
                WHERE x.work_date BETWEEN ? AND ?${userClause}
             ) ORDER BY recorded_at DESC LIMIT 1000`
        )
        .bind(...binds)
        .all();

    const rows = results.map((r) => {
        let distance = null;
        let status;
        if (r.user_lat === null) status = "no_gps";
        else if (r.tree_lat === null) status = "unmapped";
        else {
            distance = Math.round(distanceM(r.tree_lat, r.tree_lng, r.user_lat, r.user_lng) * 10) / 10;
            status = distance > settings.gps_threshold_m ? "far" : "ok";
        }
        return { ...r, distance_m: distance, status };
    });
    return { threshold_m: settings.gps_threshold_m, rows };
}

// ---------------------------------------------------------------------------
// Admin: users
// ---------------------------------------------------------------------------
async function adminUsers(db) {
    const [users, resets] = await db.batch([
        db.prepare(
            `SELECT id, username, email, phone, full_name, role, is_master, created_at, approved_at
             FROM el_users ORDER BY CASE role WHEN 'pending' THEN 0 ELSE 1 END, full_name`
        ),
        db
            .prepare(
                `SELECT r.id, r.code, r.channel, r.created_at, r.expires_at, u.id AS user_id,
                        u.full_name, u.username, u.phone, u.email
                 FROM el_resets r JOIN el_users u ON u.id = r.user_id
                 WHERE r.used = 0 AND r.expires_at > ? ORDER BY r.id DESC`
            )
            .bind(nowIso()),
    ]);
    return {
        users: users.results.map((u) => ({ ...u, is_master: Boolean(u.is_master) })),
        resets: resets.results,
    };
}

async function adminTargetUser(db, admin, userId) {
    const target = await db.prepare("SELECT * FROM el_users WHERE id = ?").bind(toInt(userId)).first();
    if (!target) fail(404, "User not found.");
    if (target.is_master && !admin.is_master) fail(403, "Only the Master Admin can change this account.");
    return target;
}

async function adminSetRole(db, admin, body) {
    const target = await adminTargetUser(db, admin, body.user_id);
    if (!(body.role in ROLE_RANK)) fail(400, "Unknown role.");
    if (target.is_master) fail(400, "The Master Admin role cannot be changed.");
    if (target.id === admin.id) fail(400, "You cannot change your own role.");
    await db
        .prepare("UPDATE el_users SET role = ?, approved_by = ?, approved_at = ? WHERE id = ?")
        .bind(body.role, admin.id, nowIso(), target.id)
        .run();
    if (body.role === "pending") {
        await db.prepare("DELETE FROM el_sessions WHERE user_id = ?").bind(target.id).run();
    }
    return { ok: true };
}

async function adminSetPassword(db, admin, body) {
    const target = await adminTargetUser(db, admin, body.user_id);
    const next = String(body.password || "");
    if (next.length < 8) fail(400, "Password must be at least 8 characters.");
    await db.batch([
        db.prepare("UPDATE el_users SET pass_hash = ? WHERE id = ?").bind(await hashPassword(next), target.id),
        db.prepare("DELETE FROM el_sessions WHERE user_id = ?").bind(target.id),
        db.prepare("UPDATE el_resets SET used = 1 WHERE user_id = ?").bind(target.id),
    ]);
    return { ok: true };
}

async function adminDeleteUser(db, admin, body) {
    const target = await adminTargetUser(db, admin, body.user_id);
    if (target.is_master) fail(400, "The Master Admin cannot be deleted.");
    if (target.id === admin.id) fail(400, "You cannot delete your own account.");
    const used = await db
        .prepare(
            `SELECT (SELECT COUNT(*) FROM el_harvest WHERE user_id = ?1) +
                    (SELECT COUNT(*) FROM el_maintenance WHERE user_id = ?1) AS n`
        )
        .bind(target.id)
        .first();
    if (used.n > 0) fail(400, "User has field records. Set role to Normal User instead.");
    await db.batch([
        db.prepare("DELETE FROM el_sessions WHERE user_id = ?").bind(target.id),
        db.prepare("DELETE FROM el_resets WHERE user_id = ?").bind(target.id),
        db.prepare("DELETE FROM el_users WHERE id = ?").bind(target.id),
    ]);
    return { ok: true };
}

// ---------------------------------------------------------------------------
// Admin: estate CRUD
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
        if (!name) fail(400, "Name is required.");
        if (id) await db.prepare("UPDATE el_estates SET name = ? WHERE id = ?").bind(name, id).run();
        else await db.prepare("INSERT INTO el_estates (name) VALUES (?)").bind(name).run();
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
                    `UPDATE el_trees SET tree_no = ?, status = ?, lat = ?, lng = ?, gps_acc = ?,
                       mapped_by = CASE WHEN ? THEN ? ELSE mapped_by END,
                       mapped_at = CASE WHEN ? THEN ? ELSE mapped_at END
                     WHERE id = ?`
                )
                .bind(
                    treeNo, status,
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
                    `INSERT INTO el_trees (block_id, tree_no, lat, lng, gps_acc, status, mapped_by, mapped_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .bind(
                    blockId, treeNo,
                    hasGps ? lat : null, hasGps ? lng : null, hasGps ? acc : null,
                    status, hasGps ? user.id : null, hasGps ? nowIso() : null
                )
                .run();
        }
    } else if (entity === "fertilizer") {
        const code = str(body.code, 12).toUpperCase();
        const stdKg = toNum(body.std_kg);
        const active = body.active === false || body.active === 0 || body.active === "0" ? 0 : 1;
        if (!code) fail(400, "Code is required.");
        if (!name) fail(400, "Name is required.");
        if (stdKg === null || stdKg <= 0 || stdKg > 50) fail(400, "Standard kg must be 0-50.");
        const dup = await db
            .prepare("SELECT id FROM el_fertilizers WHERE code = ? AND id <> ?")
            .bind(code, id || 0)
            .first();
        if (dup) fail(409, "Fertilizer code already exists.");
        if (id) {
            await db
                .prepare("UPDATE el_fertilizers SET code = ?, name = ?, std_kg = ?, active = ? WHERE id = ?")
                .bind(code, name, stdKg, active, id)
                .run();
        } else {
            await db
                .prepare("INSERT INTO el_fertilizers (code, name, std_kg, active) VALUES (?, ?, ?, ?)")
                .bind(code, name, stdKg, active)
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

    if (entity === "fertilizer") {
        const used = await db.prepare("SELECT COUNT(*) AS n FROM el_maintenance WHERE fertilizer_id = ?").bind(id).first();
        if (used.n > 0) {
            await db.prepare("UPDATE el_fertilizers SET active = 0 WHERE id = ?").bind(id).run();
            return { ok: true, deactivated: true };
        }
        await db.prepare("DELETE FROM el_fertilizers WHERE id = ?").bind(id).run();
        return { ok: true };
    }

    if (!TREE_SUBQ[entity]) fail(404, "Unknown entity.");
    const treeIds = TREE_SUBQ[entity];
    const stmts = [
        db.prepare(`DELETE FROM el_harvest WHERE tree_id IN (${treeIds})`).bind(id),
        db.prepare(`DELETE FROM el_maintenance WHERE tree_id IN (${treeIds})`).bind(id),
        db.prepare(`DELETE FROM el_trees WHERE id IN (${treeIds})`).bind(id),
    ];
    if (entity === "estate") {
        stmts.push(
            db.prepare(
                `DELETE FROM el_blocks WHERE field_id IN (SELECT f.id FROM el_fields f
                 JOIN el_divisions d ON d.id = f.division_id WHERE d.estate_id = ?1)`
            ).bind(id),
            db.prepare("DELETE FROM el_fields WHERE division_id IN (SELECT id FROM el_divisions WHERE estate_id = ?1)").bind(id),
            db.prepare("DELETE FROM el_divisions WHERE estate_id = ?1").bind(id),
            db.prepare("DELETE FROM el_estates WHERE id = ?1").bind(id)
        );
    } else if (entity === "division") {
        stmts.push(
            db.prepare("DELETE FROM el_blocks WHERE field_id IN (SELECT id FROM el_fields WHERE division_id = ?1)").bind(id),
            db.prepare("DELETE FROM el_fields WHERE division_id = ?1").bind(id),
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
    const threshold = toNum(body.gps_threshold_m);
    const seasonStart = toInt(body.season_start_month);
    if (threshold === null || threshold < 1 || threshold > 1000) fail(400, "GPS threshold must be 1-1000 m.");
    if (!seasonStart || seasonStart < 1 || seasonStart > 12) fail(400, "Season start month must be 1-12.");
    await db.batch([
        db.prepare("INSERT OR REPLACE INTO el_settings (key, value) VALUES ('gps_threshold_m', ?)").bind(String(threshold)),
        db.prepare("INSERT OR REPLACE INTO el_settings (key, value) VALUES ('season_start_month', ?)").bind(String(seasonStart)),
    ]);
    return { ok: true };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
async function route(request, env, url) {
    const db = env.DB;
    const path = url.pathname;
    const method = request.method;
    const params = Object.fromEntries(url.searchParams.entries());
    const body = method === "POST" ? await request.json().catch(() => ({})) : {};

    // Public auth endpoints
    if (method === "POST" && path === "/api/auth/register") return json(await handleRegister(db, body));
    if (method === "POST" && path === "/api/auth/login") return json(await handleLogin(db, body));
    if (method === "POST" && path === "/api/auth/forgot") return json(await handleForgot(db, body));
    if (method === "POST" && path === "/api/auth/reset") return json(await handleReset(db, body));

    const user = await currentUser(request, db);
    if (!user) fail(401, "Please log in.");

    if (method === "GET" && path === "/api/auth/me") return json({ user: publicUser(user) });
    if (method === "POST" && path === "/api/auth/logout") {
        await db.prepare("DELETE FROM el_sessions WHERE token = ?").bind(user.token).run();
        return json({ ok: true });
    }
    if (method === "POST" && path === "/api/auth/change-password") {
        return json(await handleChangePassword(db, user, body));
    }

    // Approved users
    if (method === "GET" && path === "/api/bootstrap") {
        requireRole(user, "harvester");
        const [hierarchy, settings, ferts] = await Promise.all([
            getHierarchy(db),
            getSettings(db),
            db
                .prepare(
                    user.role === "admin"
                        ? "SELECT * FROM el_fertilizers ORDER BY code"
                        : "SELECT * FROM el_fertilizers WHERE active = 1 ORDER BY code"
                )
                .all(),
        ]);
        return json({ hierarchy, settings, fertilizers: ferts.results });
    }
    if (method === "GET" && path === "/api/block") {
        requireRole(user, "harvester");
        return json(await getBlockData(db, params));
    }
    if (method === "GET" && path === "/api/report") {
        requireRole(user, "harvester");
        return json(await getReport(db, params));
    }
    if (method === "GET" && path === "/api/report.csv") {
        requireRole(user, "harvester");
        return getReportCsv(db, params);
    }
    if (method === "POST" && path === "/api/harvest") return json(await handleHarvest(db, user, body));
    if (method === "POST" && path === "/api/maintenance") return json(await handleMaintenance(db, user, body));

    // Admin only
    if (path.startsWith("/api/admin/")) {
        requireRole(user, "admin");
        if (method === "GET" && path === "/api/admin/users") return json(await adminUsers(db));
        if (method === "GET" && path === "/api/admin/compliance") return json(await getCompliance(db, params));
        if (method === "POST" && path === "/api/admin/users/role") return json(await adminSetRole(db, user, body));
        if (method === "POST" && path === "/api/admin/users/password") return json(await adminSetPassword(db, user, body));
        if (method === "POST" && path === "/api/admin/users/delete") return json(await adminDeleteUser(db, user, body));
        if (method === "POST" && path === "/api/admin/trees/batch") return json(await adminBatchTrees(db, body));
        if (method === "POST" && path === "/api/admin/settings") return json(await adminSaveSettings(db, body));
        const m = path.match(/^\/api\/admin\/(estate|division|field|block|tree|fertilizer)\/(save|delete)$/);
        if (method === "POST" && m) {
            return json(m[2] === "save" ? await adminSave(db, user, m[1], body) : await adminDelete(db, m[1], body));
        }
    }

    fail(404, "Not found.");
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (!url.pathname.startsWith("/api/")) {
            return env.ASSETS.fetch(request);
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
