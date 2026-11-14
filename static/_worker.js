// ============================================================================
// ELAEIS — Palm-based Crop Monitoring System
// Cloudflare Worker API + D1 (SQLite)
//
// Hierarchy : Estate > Division > Field (year, ha) > Block > Tree
// Scope     : Harvest (Bunches & Fronds) + Mill Dispatch Weight (kg)
// Analytics : Total Bunches, Total Fronds, Dispatch Weight, ABW, YPH
// ============================================================================

const PBKDF2_ITER = 20000;
const SESSION_DAYS = 30;
const RESET_MINUTES = 30;
const ROLE_RANK = { pending: 0, harvester: 1, supervisor: 2, admin: 3 };

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
    `CREATE TABLE IF NOT EXISTS el_dispatch (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        division_id INTEGER NOT NULL,
        dispatch_date TEXT NOT NULL,
        year_month TEXT NOT NULL,
        round_no INTEGER NOT NULL,
        weight_kg REAL NOT NULL,
        user_id INTEGER NOT NULL,
        recorded_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS el_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_el_trees_block ON el_trees (block_id)`,
    `CREATE INDEX IF NOT EXISTS idx_el_harvest_date ON el_harvest (harvest_date)`,
    `CREATE INDEX IF NOT EXISTS idx_el_harvest_tree ON el_harvest (tree_id)`,
    `CREATE INDEX IF NOT EXISTS idx_el_dispatch_date ON el_dispatch (dispatch_date)`,
    `CREATE INDEX IF NOT EXISTS idx_el_dispatch_div ON el_dispatch (division_id, year_month, round_no)`,
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

function validateStrongPassword(pw) {
    const s = String(pw || "");
    if (s.length < 8) return "Password must be at least 8 characters.";
    if (!/[A-Z]/.test(s)) return "Password must include at least 1 uppercase letter.";
    if (!/[0-9]/.test(s)) return "Password must include at least 1 number.";
    if (!/[^A-Za-z0-9]/.test(s)) return "Password must include at least 1 special character.";
    return null;
}

// ---------------------------------------------------------------------------
// Schema bootstrap + Uskvalley seed
// ---------------------------------------------------------------------------
let schemaReady = false;

async function ensureSchema(env) {
    if (schemaReady) return;
    const db = env.DB;
    await db.batch(SCHEMA.map((s) => db.prepare(s)));
    const lock = await db
        .prepare("INSERT OR IGNORE INTO el_settings (key, value) VALUES ('seeded_v3', ?)")
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
    const curRound = roundOf(today).round;

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
        db.prepare("INSERT OR IGNORE INTO el_settings (key, value) VALUES ('gps_threshold_m', '20')"),
        db.prepare("INSERT OR IGNORE INTO el_settings (key, value) VALUES ('season_start_month', '4')"),
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

    // Pre-map GPS coordinates on Block 1 (Trees 1..150)
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

    // Seed sample harvest logs across Rounds 1, 2, 3 so Round-by-Round and Month-by-Month comparisons work out of the box
    const sampleHarvest = [
        // [tree_no, date, ym, round, bunches, fronds, user_id, dLat, dLng, acc]
        [1, `${ym}-04`, ym, 1, 12, 8, 3, 0.00002, 0.00001, 4.1],
        [2, `${ym}-04`, ym, 1, 10, 7, 3, 0.00003, -0.00002, 3.9],
        [3, `${ym}-05`, ym, 1, 14, 9, 3, 0.00042, 0.00035, 6.2], // >20m violation
        [4, `${ym}-05`, ym, 1, 11, 8, 2, 0.00001, 0.00002, 3.5],
        [5, today, ym, curRound, 15, 10, 3, 0.00002, 0.00002, 4.0],
        [6, today, ym, curRound, 9, 6, 3, 0.00075, -0.00048, 8.0], // >20m violation
        [7, today, ym, curRound, 13, 8, 3, 0.00001, -0.00001, 3.7],
        [8, today, ym, curRound, 11, 7, 2, 0.00002, 0.00001, 4.2],
        [12, today, ym, curRound, 14, 9, 3, 0.00003, 0.00001, 4.4],
        [121, today, ym, curRound, 16, 10, 2, 0.00001, 0.00001, 3.2],
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

    // Seed sample Mill Dispatch Crop Weight logs (in kg)
    const sampleDispatches = [
        [1, `${ym}-05`, ym, 1, 895.0, 2, now],
        [1, today, ym, curRound, 1480.0, 2, now],
        [2, today, ym, curRound, 640.0, 2, now],
    ];
    for (const [divId, dt, ymo, rnd, wkg, uid, recAt] of sampleDispatches) {
        stmts.push(
            db
                .prepare(
                    `INSERT INTO el_dispatch (division_id, dispatch_date, year_month, round_no, weight_kg, user_id, recorded_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`
                )
                .bind(divId, dt, ymo, rnd, wkg, uid, recAt)
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
// Auth (Strictly Email + Password Login, Clean Pending Sign-Up)
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
    if (user.role === "pending") fail(403, "Pending admin approval.");
    if ((ROLE_RANK[user.role] ?? 0) < ROLE_RANK[minRole]) {
        fail(403, "You do not have permission for this action.");
    }
}

async function findUserByEmailOrId(db, identifier) {
    const idf = str(identifier, 120).toLowerCase();
    if (!idf) return null;
    return db
        .prepare("SELECT * FROM el_users WHERE LOWER(email) = ? OR LOWER(username) = ? OR phone = ? LIMIT 1")
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
    const username = str(body.username, 40).toLowerCase();
    const email = str(body.email, 120).toLowerCase();
    const phone = normPhone(body.phone);
    const password = String(body.password || "");
    const confirm_password = body.confirm_password !== undefined ? String(body.confirm_password) : password;

    if (full_name.length < 2) fail(400, "Enter your full name.");
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
        fail(400, "Username must be 3-32 characters (letters, numbers, ., _, -).");
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, "Enter a valid email address.");
    if (!/^\+?\d{9,15}$/.test(phone)) fail(400, "Enter a valid mobile number.");
    const pwErr = validateStrongPassword(password);
    if (pwErr) fail(400, pwErr);
    if (password !== confirm_password) fail(400, "Passwords do not match.");

    const clash = await db
        .prepare("SELECT email, username, phone FROM el_users WHERE LOWER(email) = ? OR LOWER(username) = ? OR phone = ?")
        .bind(email, username, phone)
        .first();
    if (clash) {
        if (clash.email.toLowerCase() === email) fail(409, "Email is already registered.");
        if (clash.username.toLowerCase() === username) fail(409, "Username is already taken.");
        fail(409, "Mobile number is already registered.");
    }

    const pass_hash = await hashPassword(password);
    await db
        .prepare(
            `INSERT INTO el_users (username, email, phone, full_name, role, pass_hash)
             VALUES (?, ?, ?, ?, 'pending', ?)`
        )
        .bind(username, email, phone, full_name, pass_hash)
        .run();

    return {
        ok: true,
        message: "Account created successfully. Pending admin approval.",
    };
}

async function handleLogin(db, body) {
    const identifier = str(body.identifier || body.email || body.username, 120).toLowerCase();
    if (!identifier) fail(400, "Enter your Username or Email.");
    const user = await db
        .prepare("SELECT * FROM el_users WHERE LOWER(email) = ? OR LOWER(username) = ? LIMIT 1")
        .bind(identifier, identifier)
        .first();
    const ok = user && (await verifyPassword(String(body.password || ""), user.pass_hash));
    if (!ok) fail(401, "Invalid username/email or password.");
    if (user.role === "pending") {
        fail(403, "Account created successfully. Pending admin approval.");
    }
    await db.prepare("DELETE FROM el_sessions WHERE user_id = ? AND expires_at <= ?").bind(user.id, nowIso()).run();
    const token = await createSession(db, user.id);
    return { token, user: publicUser(user) };
}

async function handleForgot(db, body) {
    const channel = body.channel === "sms" ? "sms" : "email";
    const idf = str(body.identifier || body.email || body.phone, 120);
    if (!idf) fail(400, "Enter your registered Email or Mobile No.");
    const user = await findUserByEmailOrId(db, idf);
    if (!user) fail(404, "No account found with that Email or Mobile No.");
    const code = randomCode();
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
    return { ok: true, otp_code: code };
}

async function handleReset(db, body) {
    const user = await findUserByEmailOrId(db, body.identifier || body.email);
    const code = str(body.code, 6);
    const next = String(body.new_password || "");
    const confirm = body.confirm_password !== undefined ? String(body.confirm_password) : next;
    if (!/^\d{6}$/.test(code)) fail(400, "Enter a valid 6-digit verification code.");
    const pwErr = validateStrongPassword(next);
    if (pwErr) fail(400, pwErr);
    if (next !== confirm) fail(400, "Passwords do not match.");
    if (!user) fail(400, "Invalid or expired recovery code.");

    const reset = await db
        .prepare(
            `SELECT * FROM el_resets WHERE user_id = ? AND used = 0 AND expires_at > ?
             ORDER BY id DESC LIMIT 1`
        )
        .bind(user.id, nowIso())
        .first();
    if (!reset) fail(400, "Invalid or expired recovery code.");

    if (!safeEqual(reset.code, code)) {
        const attempts = reset.attempts + 1;
        await db
            .prepare("UPDATE el_resets SET attempts = ?, used = ? WHERE id = ?")
            .bind(attempts, attempts >= 5 ? 1 : 0, reset.id)
            .run();
        fail(400, "Invalid or expired recovery code.");
    }

    await db.batch([
        db.prepare("UPDATE el_users SET pass_hash = ? WHERE id = ?").bind(await hashPassword(next), user.id),
        db.prepare("UPDATE el_resets SET used = 1 WHERE id = ?").bind(reset.id),
        db.prepare("DELETE FROM el_sessions WHERE user_id = ?").bind(user.id),
    ]);
    return { ok: true };
}

// ---------------------------------------------------------------------------
// Hierarchy & Block Data (Bunches & Fronds Only)
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
        const { yearMonth, round } = roundOf(date, params.round_no);
        const { results } = await db
            .prepare(
                `SELECT h.tree_id, h.bunches, h.fronds, h.harvest_date, h.round_no
                 FROM el_harvest h JOIN el_trees t ON t.id = h.tree_id
                 WHERE t.block_id = ? AND h.year_month = ? AND h.round_no = ?`
            )
            .bind(blockId, yearMonth, round)
            .all();
        results.forEach((r) => (records[r.tree_id] = r));
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
    const { yearMonth, round } = roundOf(date, body.round_no);
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

// ---------------------------------------------------------------------------
// Dispatch Crop Weight Logger
// ---------------------------------------------------------------------------
async function getDispatches(db, params) {
    const divId = toInt(params.division_id);
    const roundNo = toInt(params.round_no);
    const where = [];
    const binds = [];
    if (divId) {
        where.push("x.division_id = ?");
        binds.push(divId);
    }
    if (roundNo) {
        where.push("x.round_no = ?");
        binds.push(roundNo);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const { results } = await db
        .prepare(
            `SELECT x.id, x.division_id, d.name AS division_name, x.dispatch_date, x.year_month,
                    x.round_no, x.weight_kg, u.full_name AS recorded_by, x.recorded_at
             FROM el_dispatch x
             JOIN el_divisions d ON d.id = x.division_id
             LEFT JOIN el_users u ON u.id = x.user_id
             ${clause}
             ORDER BY x.dispatch_date DESC, x.id DESC LIMIT 200`
        )
        .bind(...binds)
        .all();
    return { dispatches: results };
}

async function handleCreateDispatch(db, user, body) {
    requireRole(user, "harvester");
    const divisionId = toInt(body.division_id);
    const roundNo = toInt(body.round_no);
    const date = str(body.date, 10);
    const weightKg = toNum(body.weight_kg);

    if (!divisionId) fail(400, "Select a division.");
    const div = await db.prepare("SELECT id FROM el_divisions WHERE id = ?").bind(divisionId).first();
    if (!div) fail(404, "Division not found.");
    if (roundNo !== 1 && roundNo !== 2 && roundNo !== 3) fail(400, "Select Round 1, 2, or 3.");
    if (!validDate(date)) fail(400, "Select a valid date.");
    if (weightKg === null || weightKg <= 0 || weightKg > 500000) {
        fail(400, "Enter a valid dispatch crop weight in kg.");
    }

    const yearMonth = date.slice(0, 7);
    await db
        .prepare(
            `INSERT INTO el_dispatch (division_id, dispatch_date, year_month, round_no, weight_kg, user_id, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(divisionId, date, yearMonth, roundNo, weightKg, user.id, nowIso())
        .run();

    return { ok: true };
}

async function handleDeleteDispatch(db, user, body) {
    requireRole(user, "supervisor");
    const id = toInt(body.id);
    if (!id) fail(400, "Missing dispatch ID.");
    await db.prepare("DELETE FROM el_dispatch WHERE id = ?").bind(id).run();
    return { ok: true };
}

// ---------------------------------------------------------------------------
// Advanced Yield Analytics Engine (Bunches, Fronds, Dispatch Weight, ABW, YPH)
// ---------------------------------------------------------------------------
const JOINS = `JOIN el_trees t ON t.id = x.tree_id
    JOIN el_blocks b ON b.id = t.block_id
    JOIN el_fields f ON f.id = b.field_id
    JOIN el_divisions d ON d.id = f.division_id
    JOIN el_estates e ON e.id = d.estate_id`;

async function getReport(db, params) {
    const from = validDate(params.from) ? params.from : "1900-01-01";
    const to = validDate(params.to) ? params.to : "2999-12-31";
    const roundFilter = toInt(params.round_no);

    const estateId = toInt(params.estate_id);
    const divisionId = toInt(params.division_id);
    const fieldId = toInt(params.field_id);
    const blockId = toInt(params.block_id);
    const treeId = toInt(params.tree_id);

    // 1. Determine Hectares (area_ha) for YPH calculation
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
    const haRow = await db.prepare(haSql).bind(...haBinds).first();
    const totalHa = Number(haRow?.total_ha || 0);

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

    // 3. Build Dispatch filter clauses (Dispatch is logged at Division level)
    // Resolve target division if field/block/tree is selected
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

    // 4. Execute batch queries strictly for the 5 Core KPIs
    const [hTot, dTot] = await db.batch([
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
    ]);

    const totalBunches = Number(hTot.results[0]?.bunches || 0);
    const totalFronds = Number(hTot.results[0]?.fronds || 0);
    const totalDispatchKg = Number(dTot.results[0]?.dispatch_kg || 0);

    // Formulas:
    // ABW = Total Dispatched Weight / Total Bunches
    // YPH = Total Dispatched Weight / Total Hectares of selected Division/Field
    const abw = totalBunches > 0 ? Number((totalDispatchKg / totalBunches).toFixed(2)) : 0;
    const yph = totalHa > 0 ? Number((totalDispatchKg / totalHa).toFixed(2)) : 0;

    return {
        from,
        to,
        totals: {
            bunches: totalBunches,
            fronds: totalFronds,
            records: Number(hTot.results[0]?.records || 0),
            trees: Number(hTot.results[0]?.trees || 0),
            dispatch_kg: totalDispatchKg,
            dispatch_records: Number(dTot.results[0]?.dispatch_records || 0),
            area_ha: totalHa,
            abw,
            yph,
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
    const lines = [
        "Metric,Value",
        `From Date,${rep.from}`,
        `To Date,${rep.to}`,
        `Total Bunches Cut,${rep.totals.bunches}`,
        `Total Fronds Cut,${rep.totals.fronds}`,
        `Total Dispatched Weight (kg),${rep.totals.dispatch_kg}`,
        `Selected Area (Ha),${rep.totals.area_ha}`,
        `Average Bunch Weight ABW (kg/bunch),${rep.totals.abw}`,
        `Yield Per Hectare YPH (kg/Ha),${rep.totals.yph}`,
    ];
    return new Response(lines.join("\n"), {
        headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="elaeis_kpi_report_${rep.from}_${rep.to}.csv"`,
            "Cache-Control": "no-store",
        },
    });
}

// ---------------------------------------------------------------------------
// Admin: GPS Compliance Log (Harvest Only)
// ---------------------------------------------------------------------------
async function getCompliance(db, params) {
    const from = validDate(params.from) ? params.from : "1900-01-01";
    const to = validDate(params.to) ? params.to : "2999-12-31";
    const settings = await getSettings(db);

    const { results } = await db
        .prepare(
            `SELECT 'harvest' AS activity, x.id, x.recorded_at, x.harvest_date AS work_date,
                    x.round_no, x.user_lat, x.user_lng, x.user_acc, u.full_name, u.role,
                    t.tree_no, t.lat AS tree_lat, t.lng AS tree_lng,
                    b.name AS block, f.name AS field, d.name AS division,
                    x.bunches || ' Bunches / ' || x.fronds || ' Fronds (R' || x.round_no || ')' AS detail
             FROM el_harvest x ${JOINS} JOIN el_users u ON u.id = x.user_id
             WHERE x.harvest_date BETWEEN ? AND ?
             ORDER BY x.recorded_at DESC LIMIT 1000`
        )
        .bind(from, to)
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
// Admin: Users
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
                        u.full_name, u.email, u.phone
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

    // Approved users
    if (method === "GET" && path === "/api/bootstrap") {
        requireRole(user, "harvester");
        const [hierarchy, settings] = await Promise.all([getHierarchy(db), getSettings(db)]);
        return json({ hierarchy, settings });
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

    // Dispatch Crop Weight endpoints
    if (method === "GET" && path === "/api/dispatch") {
        requireRole(user, "harvester");
        return json(await getDispatches(db, params));
    }
    if (method === "POST" && path === "/api/dispatch") {
        return json(await handleCreateDispatch(db, user, body));
    }
    if (method === "POST" && path === "/api/dispatch/delete") {
        return json(await handleDeleteDispatch(db, user, body));
    }

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
