// ============================================================================
// ELAEIS CLOUDFLARE WORKER (worker.js) + CLOUDFLARE D1 (SQLite) BACKEND
// Hierarchy: Estate > Division > Field > Block > Geo-Tagged Palm Tree
// 3 Monthly Rounds: Round 1 (Days 1-10), Round 2 (Days 11-20), Round 3 (Days 21-End)
// ============================================================================

function computeHarvestRound(dateStr) {
    const todayIso = new Date().toISOString().slice(0, 10);
    const clean = dateStr && dateStr.length >= 10 ? dateStr.slice(0, 10) : todayIso;
    const parts = clean.split("-");
    const yearMonth = `${parts[0]}-${parts[1]}`;
    const day = parseInt(parts[2], 10) || 1;

    let roundNumber = 1;
    let roundLabel = "Round 1 (Days 1-10)";
    if (day >= 11 && day <= 20) {
        roundNumber = 2;
        roundLabel = "Round 2 (Days 11-20)";
    } else if (day >= 21) {
        roundNumber = 3;
        roundLabel = "Round 3 (Days 21-End)";
    }
    return {
        date: clean,
        year_month: yearMonth,
        month_name: yearMonth,
        day_of_month: day,
        round_number: roundNumber,
        round_label: roundLabel,
    };
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        },
    });
}

// ----------------------------------------------------------------------------
// CLOUDFLARE D1 AUTO-INITIALIZATION & CLEAN ENGLISH / SRI LANKAN DATA MIGRATION
// ----------------------------------------------------------------------------
let d1Initialized = false;

async function ensureD1Initialized(db) {
    if (d1Initialized) return;
    await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            phone TEXT UNIQUE NOT NULL,
            full_name TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'Supervisor',
            assigned_estate_id INTEGER DEFAULT 1,
            password_hash TEXT NOT NULL,
            reset_token TEXT,
            reset_expires TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS estates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            crop_type TEXT NOT NULL DEFAULT 'Oil Palm (Tenera)',
            location_region TEXT DEFAULT 'Southern Province, Sri Lanka',
            total_area_ha REAL DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS divisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            estate_id INTEGER NOT NULL,
            code TEXT NOT NULL,
            name TEXT NOT NULL,
            supervisor_name TEXT DEFAULT ''
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS fields (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            division_id INTEGER NOT NULL,
            code TEXT NOT NULL,
            name TEXT NOT NULL,
            planting_year INTEGER DEFAULT 2018,
            area_ha REAL DEFAULT 25.0
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS blocks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            field_id INTEGER NOT NULL,
            code TEXT NOT NULL,
            name TEXT NOT NULL,
            palm_variety TEXT DEFAULT 'Tenera Hybrid',
            area_ha REAL DEFAULT 10.0,
            target_stands INTEGER DEFAULT 20
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS trees (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            block_id INTEGER NOT NULL,
            tree_number INTEGER NOT NULL,
            tree_code TEXT NOT NULL,
            row_number INTEGER DEFAULT 1,
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            planting_year INTEGER DEFAULT 2018,
            health_status TEXT DEFAULT 'Healthy',
            weed_status TEXT DEFAULT 'Clean Circle',
            last_fertilizer_type TEXT DEFAULT 'YPM Palm Mixture',
            last_fertilizer_kg REAL DEFAULT 2.5,
            last_fertilizer_date TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            UNIQUE(block_id, tree_number)
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS harvest_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tree_id INTEGER NOT NULL,
            block_id INTEGER NOT NULL,
            harvest_date TEXT NOT NULL,
            year_month TEXT NOT NULL,
            day_of_month INTEGER NOT NULL,
            round_number INTEGER NOT NULL,
            bunches_cut INTEGER NOT NULL DEFAULT 0,
            fronds_cut INTEGER NOT NULL DEFAULT 0,
            bunch_weight_kg REAL DEFAULT 0.0,
            loose_fruits_count INTEGER DEFAULT 0,
            weed_growth TEXT DEFAULT 'Clean Circle',
            fertilizer_type TEXT DEFAULT 'None',
            fertilizer_kg REAL DEFAULT 0.0,
            pruning_status TEXT DEFAULT 'Standard Stacked',
            pest_disease TEXT DEFAULT 'Healthy',
            custom_data_json TEXT DEFAULT '{}',
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            recorded_by_id INTEGER DEFAULT 1,
            recorded_by_name TEXT DEFAULT 'System',
            remarks TEXT DEFAULT '',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS custom_field_defs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            field_key TEXT UNIQUE NOT NULL,
            field_label TEXT NOT NULL,
            field_type TEXT NOT NULL DEFAULT 'text',
            options_csv TEXT DEFAULT '',
            unit TEXT DEFAULT '',
            is_active INTEGER DEFAULT 1
        )`),
    ]);

    const estateCount = await db.prepare("SELECT COUNT(*) AS cnt FROM estates").first("cnt");
    if (!estateCount) {
        const ym = new Date().toISOString().slice(0, 7);
        const stmts = [
            db.prepare("INSERT OR IGNORE INTO users (username, email, phone, full_name, role, assigned_estate_id, password_hash) VALUES ('admin', 'admin@elaeis.lk', '+94771234567', 'Estate Administrator', 'Admin', 1, 'admin123')"),
            db.prepare("INSERT OR IGNORE INTO users (username, email, phone, full_name, role, assigned_estate_id, password_hash) VALUES ('supervisor1', 'supervisor@elaeis.lk', '+94772345678', 'Field Supervisor', 'Supervisor', 1, 'super123')"),
            db.prepare("INSERT OR IGNORE INTO users (username, email, phone, full_name, role, assigned_estate_id, password_hash) VALUES ('harvester1', 'officer@elaeis.lk', '+94773456789', 'Field Officer', 'Harvester', 1, 'harvest123')"),
            db.prepare("INSERT OR IGNORE INTO custom_field_defs (field_key, field_label, field_type, options_csv) VALUES ('circle_mulching', 'Circle Mulching', 'select', 'Completed,Partial,Pending')"),
            db.prepare("INSERT OR IGNORE INTO custom_field_defs (field_key, field_label, field_type, options_csv) VALUES ('soil_moisture', 'Soil Moisture', 'select', 'Optimal,Moist,Dry,Waterlogged')"),
            db.prepare("INSERT INTO estates (id, code, name, crop_type, location_region, total_area_ha) VALUES (1, 'EST-01', 'Southern Valley Estate', 'Oil Palm (Tenera)', 'Galle District, Sri Lanka', 450.0)"),
            db.prepare("INSERT INTO estates (id, code, name, crop_type, location_region, total_area_ha) VALUES (2, 'EST-02', 'Western Hills Estate', 'Coconut & Oil Palm', 'Kalutara District, Sri Lanka', 320.0)"),
            db.prepare("INSERT INTO divisions (id, estate_id, code, name, supervisor_name) VALUES (1, 1, 'DIV-A', 'North Division', 'N. Perera')"),
            db.prepare("INSERT INTO divisions (id, estate_id, code, name, supervisor_name) VALUES (2, 1, 'DIV-B', 'South Division', 'K. Silva')"),
            db.prepare("INSERT INTO fields (id, division_id, code, name, planting_year, area_ha) VALUES (1, 1, 'FLD-01', 'Field 01 - Mature Block (2018)', 2018, 25.0)"),
            db.prepare("INSERT INTO blocks (id, field_id, code, name, palm_variety, area_ha, target_stands) VALUES (1, 1, 'BLK-101', 'Block 101 (Main Section)', 'Tenera Hybrid', 12.0, 20)"),
        ];

        for (let i = 1; i <= 20; i++) {
            const rowNo = Math.floor((i - 1) / 5) + 1;
            const colNo = (i - 1) % 5;
            const lat = Number((6.1425 + (rowNo - 1) * 0.000075).toFixed(6));
            const lng = Number((80.3652 + colNo * 0.000085 + (rowNo % 2 === 0 ? 0.000042 : 0)).toFixed(6));
            const code = `T-${String(i).padStart(3, "0")}`;
            stmts.push(
                db.prepare("INSERT INTO trees (id, block_id, tree_number, tree_code, row_number, latitude, longitude, planting_year, health_status, weed_status, last_fertilizer_type, last_fertilizer_kg, last_fertilizer_date) VALUES (?, 1, ?, ?, ?, ?, ?, 2018, 'Healthy', 'Clean Circle', 'YPM Palm Mixture', 2.5, ?)").bind(i, i, code, rowNo, lat, lng, `${ym}-02`)
            );
            const r1b = (i % 3) + 1;
            const r1f = r1b + 1;
            stmts.push(
                db.prepare("INSERT INTO harvest_logs (tree_id, block_id, harvest_date, year_month, day_of_month, round_number, bunches_cut, fronds_cut, bunch_weight_kg, weed_growth, fertilizer_type, fertilizer_kg, latitude, longitude, recorded_by_name) VALUES (?, 1, ?, ?, 4, 1, ?, ?, ?, 'Clean Circle', 'YPM Palm Mixture', 2.5, ?, ?, 'Field Supervisor')").bind(i, `${ym}-04`, ym, r1b, r1f, Number((r1b * 18.0).toFixed(1)), lat, lng)
            );
            if (i <= 15) {
                const r2b = ((i + 1) % 3) + 1;
                const r2f = r2b + 1;
                stmts.push(
                    db.prepare("INSERT INTO harvest_logs (tree_id, block_id, harvest_date, year_month, day_of_month, round_number, bunches_cut, fronds_cut, bunch_weight_kg, weed_growth, fertilizer_type, fertilizer_kg, latitude, longitude, recorded_by_name) VALUES (?, 1, ?, ?, 14, 2, ?, ?, ?, 'Clean Circle', 'None', 0, ?, ?, 'Field Officer')").bind(i, `${ym}-14`, ym, r2b, r2f, Number((r2b * 18.0).toFixed(1)), lat, lng)
                );
            }
        }
        await db.batch(stmts);
    } else {
        // Ensure existing D1 database seed rows are updated to clean English & Sri Lankan coordinates
        await db.batch([
            db.prepare("UPDATE estates SET name = 'Southern Valley Estate', crop_type = 'Oil Palm (Tenera)', location_region = 'Galle District, Sri Lanka' WHERE code = 'EST-01'"),
            db.prepare("UPDATE estates SET name = 'Western Hills Estate', crop_type = 'Coconut & Oil Palm', location_region = 'Kalutara District, Sri Lanka' WHERE code = 'EST-02'"),
            db.prepare("UPDATE divisions SET name = 'North Division', supervisor_name = 'N. Perera' WHERE code = 'DIV-A'"),
            db.prepare("UPDATE divisions SET name = 'South Division', supervisor_name = 'K. Silva' WHERE code = 'DIV-B'"),
            db.prepare("UPDATE fields SET name = 'Field 01 - Mature Block (2018)' WHERE code = 'FLD-01'"),
            db.prepare("UPDATE blocks SET name = 'Block 101 (Main Section)', palm_variety = 'Tenera Hybrid' WHERE code = 'BLK-101'"),
            db.prepare("UPDATE users SET full_name = 'Estate Administrator', email = 'admin@elaeis.lk', phone = '+94771234567' WHERE username = 'admin'"),
            db.prepare("UPDATE users SET full_name = 'Field Supervisor', email = 'supervisor@elaeis.lk', phone = '+94772345678' WHERE username = 'supervisor1'"),
            db.prepare("UPDATE users SET full_name = 'Field Officer', email = 'officer@elaeis.lk', phone = '+94773456789' WHERE username = 'harvester1'"),
            db.prepare("UPDATE trees SET latitude = ROUND(6.1425 + (row_number - 1) * 0.000075, 6), longitude = ROUND(80.3652 + ((tree_number - 1) % 5) * 0.000085, 6) WHERE latitude < 4.0"),
        ]);
    }
    d1Initialized = true;
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;

        if (request.method === "OPTIONS") {
            return jsonResponse({ ok: true });
        }

        if (!path.startsWith("/api/")) {
            return env.ASSETS.fetch(request);
        }

        if (!env.DB) {
            return jsonResponse(
                {
                    error: "Please bind a Cloudflare D1 database named 'DB' in wrangler.toml.",
                },
                500
            );
        }

        try {
            await ensureD1Initialized(env.DB);
            return await handleD1Api(request, url, path, env.DB);
        } catch (err) {
            return jsonResponse({ error: String(err.message || err) }, 500);
        }
    },
};

async function handleD1Api(request, url, path, db) {
    const params = Object.fromEntries(url.searchParams.entries());

    if (request.method === "GET") {
        if (path === "/api/auth/me") {
            const auth = request.headers.get("Authorization") || "";
            const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
            if (!token) return jsonResponse({ authenticated: false }, 401);
            const user = await db
                .prepare(
                    "SELECT u.id, u.username, u.email, u.phone, u.full_name, u.role, u.assigned_estate_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?"
                )
                .bind(token)
                .first();
            if (!user) return jsonResponse({ authenticated: false }, 401);
            return jsonResponse({ authenticated: true, user });
        }

        if (path === "/api/hierarchy") {
            const estates = (await db.prepare("SELECT * FROM estates ORDER BY id").all()).results;
            const divisions = (await db.prepare("SELECT * FROM divisions ORDER BY id").all()).results;
            const fields = (await db.prepare("SELECT * FROM fields ORDER BY id").all()).results;
            const blocks = (
                await db
                    .prepare(
                        "SELECT b.*, COUNT(t.id) AS registered_trees FROM blocks b LEFT JOIN trees t ON t.block_id = b.id GROUP BY b.id ORDER BY b.id"
                    )
                    .all()
            ).results;
            return jsonResponse({ estates, divisions, fields, blocks });
        }

        if (path === "/api/custom-fields") {
            const custom_fields = (
                await db.prepare("SELECT * FROM custom_field_defs WHERE is_active = 1 ORDER BY id").all()
            ).results;
            return jsonResponse({ custom_fields });
        }

        if (path === "/api/users") {
            const users = (
                await db
                    .prepare(
                        "SELECT id, username, email, phone, full_name, role, assigned_estate_id, created_at FROM users ORDER BY id"
                    )
                    .all()
            ).results;
            return jsonResponse({ users });
        }

        if (path === "/api/trees/lookup") {
            const blockId = Number(params.block_id || 1);
            const treeNumber = Number(params.tree_number || 1);
            const roundInfo = computeHarvestRound(params.date);

            const tree = await db
                .prepare("SELECT * FROM trees WHERE block_id = ? AND tree_number = ?")
                .bind(blockId, treeNumber)
                .first();

            const blkMeta = await db
                .prepare("SELECT COUNT(*) AS total, MAX(tree_number) AS max_num FROM trees WHERE block_id = ?")
                .bind(blockId)
                .first();

            if (!tree) {
                return jsonResponse({
                    exists: false,
                    tree_number: treeNumber,
                    tree_code: `T-${String(treeNumber).padStart(3, "0")}`,
                    suggested_latitude: 6.1428,
                    suggested_longitude: 80.3655,
                    round_info: roundInfo,
                    block_total_trees: blkMeta?.total || 0,
                    max_tree_number: blkMeta?.max_num || 0,
                });
            }

            const existingLog = await db
                .prepare(
                    "SELECT * FROM harvest_logs WHERE tree_id = ? AND year_month = ? AND round_number = ? ORDER BY id DESC LIMIT 1"
                )
                .bind(tree.id, roundInfo.year_month, roundInfo.round_number)
                .first();

            const mrRows = (
                await db
                    .prepare(
                        "SELECT round_number, bunches_cut, fronds_cut, harvest_date FROM harvest_logs WHERE tree_id = ? AND year_month = ?"
                    )
                    .bind(tree.id, roundInfo.year_month)
                    .all()
            ).results;
            const monthRounds = {};
            for (const r of mrRows) monthRounds[r.round_number] = r;

            return jsonResponse({
                exists: true,
                tree,
                round_info: roundInfo,
                existing_log: existingLog || null,
                month_rounds: monthRounds,
                block_total_trees: blkMeta?.total || 0,
                max_tree_number: blkMeta?.max_num || 0,
                next_tree_number: treeNumber + 1,
            });
        }

        if (path === "/api/reports/block-rounds") {
            const blockId = Number(params.block_id || 1);
            const ym = params.year_month || new Date().toISOString().slice(0, 7);

            const blockInfo = await db
                .prepare(
                    "SELECT b.*, f.name AS field_name, d.name AS division_name, e.name AS estate_name FROM blocks b JOIN fields f ON f.id = b.field_id JOIN divisions d ON d.id = f.division_id JOIN estates e ON e.id = d.estate_id WHERE b.id = ?"
                )
                .bind(blockId)
                .first();

            const trees = (
                await db.prepare("SELECT * FROM trees WHERE block_id = ? ORDER BY tree_number ASC").bind(blockId).all()
            ).results;
            const logs = (
                await db
                    .prepare("SELECT * FROM harvest_logs WHERE block_id = ? AND year_month = ?")
                    .bind(blockId, ym)
                    .all()
            ).results;

            const logMap = {};
            for (const lg of logs) logMap[`${lg.tree_id}_${lg.round_number}`] = lg;

            const summary = {
                total_trees: trees.length,
                r1_trees_harvested: 0,
                r1_bunches: 0,
                r1_fronds: 0,
                r2_trees_harvested: 0,
                r2_bunches: 0,
                r2_fronds: 0,
                r3_trees_harvested: 0,
                r3_bunches: 0,
                r3_fronds: 0,
                total_bunches: 0,
                total_fronds: 0,
                total_weight_kg: 0,
            };

            const matrix = trees.map((t) => {
                const r1 = logMap[`${t.id}_1`] || null;
                const r2 = logMap[`${t.id}_2`] || null;
                const r3 = logMap[`${t.id}_3`] || null;
                const b1 = r1 ? r1.bunches_cut : 0;
                const f1 = r1 ? r1.fronds_cut : 0;
                const b2 = r2 ? r2.bunches_cut : 0;
                const f2 = r2 ? r2.fronds_cut : 0;
                const b3 = r3 ? r3.bunches_cut : 0;
                const f3 = r3 ? r3.fronds_cut : 0;
                const wTot =
                    (r1 ? r1.bunch_weight_kg : 0) +
                    (r2 ? r2.bunch_weight_kg : 0) +
                    (r3 ? r3.bunch_weight_kg : 0);

                if (r1) {
                    summary.r1_trees_harvested++;
                    summary.r1_bunches += b1;
                    summary.r1_fronds += f1;
                }
                if (r2) {
                    summary.r2_trees_harvested++;
                    summary.r2_bunches += b2;
                    summary.r2_fronds += f2;
                }
                if (r3) {
                    summary.r3_trees_harvested++;
                    summary.r3_bunches += b3;
                    summary.r3_fronds += f3;
                }

                const totB = b1 + b2 + b3;
                const totF = f1 + f2 + f3;
                summary.total_bunches += totB;
                summary.total_fronds += totF;
                summary.total_weight_kg = Number((summary.total_weight_kg + wTot).toFixed(1));

                return {
                    tree_id: t.id,
                    tree_number: t.tree_number,
                    tree_code: t.tree_code,
                    row_number: t.row_number,
                    latitude: t.latitude,
                    longitude: t.longitude,
                    health_status: t.health_status,
                    weed_status: t.weed_status,
                    last_fertilizer_type: t.last_fertilizer_type,
                    last_fertilizer_kg: t.last_fertilizer_kg,
                    round_1: r1,
                    round_2: r2,
                    round_3: r3,
                    total_bunches: totB,
                    total_fronds: totF,
                    total_weight_kg: Number(wTot.toFixed(1)),
                    rounds_done: (r1 ? 1 : 0) + (r2 ? 1 : 0) + (r3 ? 1 : 0),
                };
            });

            return jsonResponse({ block: blockInfo || {}, year_month: ym, summary, trees_matrix: matrix });
        }

        if (path === "/api/reports/export-csv") {
            const blockId = Number(params.block_id || 1);
            const ym = params.year_month || new Date().toISOString().slice(0, 7);

            const bInfo =
                (await db
                    .prepare(
                        "SELECT b.*, f.name AS field_name, d.name AS division_name, e.name AS estate_name FROM blocks b JOIN fields f ON f.id = b.field_id JOIN divisions d ON d.id = f.division_id JOIN estates e ON e.id = d.estate_id WHERE b.id = ?"
                    )
                    .bind(blockId)
                    .first()) || {};

            const trees = (
                await db.prepare("SELECT * FROM trees WHERE block_id = ? ORDER BY tree_number ASC").bind(blockId).all()
            ).results;
            const logs = (
                await db
                    .prepare("SELECT * FROM harvest_logs WHERE block_id = ? AND year_month = ?")
                    .bind(blockId, ym)
                    .all()
            ).results;
            const logMap = {};
            for (const lg of logs) logMap[`${lg.tree_id}_${lg.round_number}`] = lg;

            const rows = [
                [
                    "Estate",
                    "Division",
                    "Field",
                    "Block",
                    "Year-Month",
                    "Tree No",
                    "Tree Code",
                    "Row No",
                    "GPS Latitude",
                    "GPS Longitude",
                    "R1 (1-10) Date",
                    "R1 Bunches",
                    "R1 Fronds",
                    "R2 (11-20) Date",
                    "R2 Bunches",
                    "R2 Fronds",
                    "R3 (21-End) Date",
                    "R3 Bunches",
                    "R3 Fronds",
                    "Monthly Total Bunches",
                    "Monthly Total Fronds",
                    "Weed Status",
                    "Fertilizer",
                ].join(","),
            ];

            for (const t of trees) {
                const r1 = logMap[`${t.id}_1`] || {};
                const r2 = logMap[`${t.id}_2`] || {};
                const r3 = logMap[`${t.id}_3`] || {};
                const b1 = r1.bunches_cut || 0,
                    f1 = r1.fronds_cut || 0;
                const b2 = r2.bunches_cut || 0,
                    f2 = r2.fronds_cut || 0;
                const b3 = r3.bunches_cut || 0,
                    f3 = r3.fronds_cut || 0;
                rows.push(
                    [
                        `"${bInfo.estate_name || ""}"`,
                        `"${bInfo.division_name || ""}"`,
                        `"${bInfo.field_name || ""}"`,
                        `"${bInfo.code || ""}"`,
                        ym,
                        t.tree_number,
                        t.tree_code,
                        t.row_number,
                        t.latitude,
                        t.longitude,
                        r1.harvest_date || "-",
                        b1,
                        f1,
                        r2.harvest_date || "-",
                        b2,
                        f2,
                        r3.harvest_date || "-",
                        b3,
                        f3,
                        b1 + b2 + b3,
                        f1 + f2 + f3,
                        `"${t.weed_status}"`,
                        `"${t.last_fertilizer_type}"`,
                    ].join(",")
                );
            }

            return new Response(rows.join("\n"), {
                status: 200,
                headers: {
                    "Content-Type": "text/csv; charset=utf-8",
                    "Content-Disposition": `attachment; filename="Elaeis_Block_${bInfo.code || "Report"}_${ym}.csv"`,
                },
            });
        }

        if (path === "/api/dashboard") {
            const ym = params.year_month || new Date().toISOString().slice(0, 7);
            const todayRound = computeHarvestRound(new Date().toISOString().slice(0, 10));

            const cEst = await db.prepare("SELECT COUNT(*) AS c FROM estates").first("c");
            const cDiv = await db.prepare("SELECT COUNT(*) AS c FROM divisions").first("c");
            const cFld = await db.prepare("SELECT COUNT(*) AS c FROM fields").first("c");
            const cBlk = await db.prepare("SELECT COUNT(*) AS c FROM blocks").first("c");
            const cTr = await db.prepare("SELECT COUNT(*) AS c FROM trees").first("c");

            const rRows = (
                await db
                    .prepare(
                        "SELECT round_number, COUNT(DISTINCT tree_id) AS trees_harvested, COALESCE(SUM(bunches_cut),0) AS bunches, COALESCE(SUM(fronds_cut),0) AS fronds, COALESCE(SUM(bunch_weight_kg),0) AS weight_kg FROM harvest_logs WHERE year_month = ? GROUP BY round_number"
                    )
                    .bind(ym)
                    .all()
            ).results;

            const rounds = {
                1: { round_number: 1, trees_harvested: 0, bunches: 0, fronds: 0, weight_kg: 0 },
                2: { round_number: 2, trees_harvested: 0, bunches: 0, fronds: 0, weight_kg: 0 },
                3: { round_number: 3, trees_harvested: 0, bunches: 0, fronds: 0, weight_kg: 0 },
            };
            for (const r of rRows) {
                if (rounds[r.round_number]) rounds[r.round_number] = r;
            }

            const blockSummaries = (
                await db
                    .prepare(
                        `SELECT b.id AS block_id, b.code AS block_code, b.name AS block_name,
                                f.name AS field_name, d.name AS division_name, e.name AS estate_name,
                                COUNT(DISTINCT t.id) AS total_trees,
                                COALESCE(SUM(CASE WHEN h.round_number = 1 THEN h.bunches_cut ELSE 0 END), 0) AS r1_bunches,
                                COALESCE(SUM(CASE WHEN h.round_number = 1 THEN h.fronds_cut ELSE 0 END), 0) AS r1_fronds,
                                COUNT(DISTINCT CASE WHEN h.round_number = 1 THEN h.tree_id END) AS r1_trees,
                                COALESCE(SUM(CASE WHEN h.round_number = 2 THEN h.bunches_cut ELSE 0 END), 0) AS r2_bunches,
                                COALESCE(SUM(CASE WHEN h.round_number = 2 THEN h.fronds_cut ELSE 0 END), 0) AS r2_fronds,
                                COUNT(DISTINCT CASE WHEN h.round_number = 2 THEN h.tree_id END) AS r2_trees,
                                COALESCE(SUM(CASE WHEN h.round_number = 3 THEN h.bunches_cut ELSE 0 END), 0) AS r3_bunches,
                                COALESCE(SUM(CASE WHEN h.round_number = 3 THEN h.fronds_cut ELSE 0 END), 0) AS r3_fronds,
                                COUNT(DISTINCT CASE WHEN h.round_number = 3 THEN h.tree_id END) AS r3_trees,
                                COALESCE(SUM(h.bunches_cut), 0) AS total_bunches,
                                COALESCE(SUM(h.fronds_cut), 0) AS total_fronds,
                                COALESCE(SUM(h.bunch_weight_kg), 0) AS total_weight_kg
                         FROM blocks b
                         JOIN fields f ON f.id = b.field_id
                         JOIN divisions d ON d.id = f.division_id
                         JOIN estates e ON e.id = d.estate_id
                         LEFT JOIN trees t ON t.block_id = b.id
                         LEFT JOIN harvest_logs h ON h.tree_id = t.id AND h.year_month = ?
                         GROUP BY b.id`
                    )
                    .bind(ym)
                    .all()
            ).results;

            const recentLogs = (
                await db
                    .prepare(
                        `SELECT h.*, t.tree_number, t.tree_code, b.code AS block_code, e.name AS estate_name
                         FROM harvest_logs h
                         JOIN trees t ON t.id = h.tree_id
                         JOIN blocks b ON b.id = h.block_id
                         JOIN fields f ON f.id = b.field_id
                         JOIN divisions d ON d.id = f.division_id
                         JOIN estates e ON e.id = d.estate_id
                         ORDER BY h.id DESC LIMIT 12`
                    )
                    .all()
            ).results;

            return jsonResponse({
                year_month: ym,
                today_round: todayRound,
                counts: { estates: cEst, divisions: cDiv, fields: cFld, blocks: cBlk, trees: cTr },
                rounds,
                block_summaries: blockSummaries,
                recent_logs: recentLogs,
            });
        }
    }

    if (request.method === "POST") {
        const data = await request.json();

        if (path === "/api/auth/login") {
            const idf = String(data.identifier || "").trim();
            const pwd = String(data.password || "");
            const user = await db
                .prepare(
                    "SELECT * FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?) OR phone = ?"
                )
                .bind(idf, idf, idf)
                .first();

            if (!user || (user.password_hash !== pwd && !user.password_hash.endsWith(pwd))) {
                return jsonResponse({ error: "Invalid login credentials." }, 401);
            }
            const token = crypto.randomUUID();
            await db.prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)").bind(token, user.id).run();
            return jsonResponse({ token, user });
        }

        if (path === "/api/auth/register" || path === "/api/users") {
            await db
                .prepare(
                    "INSERT INTO users (username, email, phone, full_name, role, assigned_estate_id, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?)"
                )
                .bind(
                    data.username,
                    data.email,
                    data.phone,
                    data.full_name,
                    data.role || "Harvester",
                    Number(data.assigned_estate_id || 1),
                    data.password
                )
                .run();
            return jsonResponse({ message: `User '${data.full_name}' created.` });
        }

        if (path === "/api/auth/forgot-password") {
            const idf = String(data.identifier || "").trim();
            const user = await db
                .prepare("SELECT * FROM users WHERE LOWER(username)=LOWER(?) OR LOWER(email)=LOWER(?) OR phone=?")
                .bind(idf, idf, idf)
                .first();
            if (!user) return jsonResponse({ error: "No matching user found." }, 404);
            const otp = String(Math.floor(100000 + Math.random() * 900000));
            await db.prepare("UPDATE users SET reset_token = ? WHERE id = ?").bind(otp, user.id).run();
            return jsonResponse({
                message: "Recovery code generated.",
                recovery_code_demo: otp,
                user_hint: `${user.username} (${user.phone})`,
            });
        }

        if (path === "/api/auth/reset-password") {
            const idf = String(data.identifier || "").trim();
            const user = await db
                .prepare(
                    "SELECT * FROM users WHERE (LOWER(username)=LOWER(?) OR LOWER(email)=LOWER(?) OR phone=?) AND reset_token=?"
                )
                .bind(idf, idf, idf, String(data.reset_token || "").trim())
                .first();
            if (!user) return jsonResponse({ error: "Invalid recovery code." }, 400);
            await db
                .prepare("UPDATE users SET password_hash = ?, reset_token = NULL WHERE id = ?")
                .bind(data.new_password, user.id)
                .run();
            return jsonResponse({ message: "Password updated." });
        }

        if (path === "/api/harvest") {
            const blockId = Number(data.block_id);
            const treeNumber = Number(data.tree_number);
            const rInfo = computeHarvestRound(data.harvest_date);
            const lat = Number(data.latitude || 6.1425);
            const lng = Number(data.longitude || 80.3652);

            let tree = await db
                .prepare("SELECT * FROM trees WHERE block_id = ? AND tree_number = ?")
                .bind(blockId, treeNumber)
                .first();

            if (!tree) {
                const rowNo = Math.floor((treeNumber - 1) / 5) + 1;
                const tCode = `T-${String(treeNumber).padStart(3, "0")}`;
                await db
                    .prepare(
                        "INSERT INTO trees (block_id, tree_number, tree_code, row_number, latitude, longitude, health_status, weed_status, last_fertilizer_type, last_fertilizer_kg) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
                    )
                    .bind(
                        blockId,
                        treeNumber,
                        tCode,
                        rowNo,
                        lat,
                        lng,
                        data.pest_disease || "Healthy",
                        data.weed_growth || "Clean Circle",
                        data.fertilizer_type || "YPM Palm Mixture",
                        Number(data.fertilizer_kg || 0)
                    )
                    .run();
                tree = await db
                    .prepare("SELECT * FROM trees WHERE block_id = ? AND tree_number = ?")
                    .bind(blockId, treeNumber)
                    .first();
            } else {
                await db
                    .prepare("UPDATE trees SET latitude=?, longitude=?, health_status=?, weed_status=? WHERE id=?")
                    .bind(lat, lng, data.pest_disease || "Healthy", data.weed_growth || "Clean Circle", tree.id)
                    .run();
            }

            const existing = await db
                .prepare("SELECT id FROM harvest_logs WHERE tree_id = ? AND year_month = ? AND round_number = ?")
                .bind(tree.id, rInfo.year_month, rInfo.round_number)
                .first();

            if (existing) {
                await db
                    .prepare(
                        "UPDATE harvest_logs SET harvest_date=?, day_of_month=?, bunches_cut=?, fronds_cut=?, bunch_weight_kg=?, weed_growth=?, fertilizer_type=?, fertilizer_kg=?, pruning_status=?, pest_disease=?, custom_data_json=?, latitude=?, longitude=?, remarks=? WHERE id=?"
                    )
                    .bind(
                        rInfo.date,
                        rInfo.day_of_month,
                        Number(data.bunches_cut || 0),
                        Number(data.fronds_cut || 0),
                        Number(data.bunch_weight_kg || 0),
                        data.weed_growth || "Clean Circle",
                        data.fertilizer_type || "None",
                        Number(data.fertilizer_kg || 0),
                        data.pruning_status || "Standard Stacked",
                        data.pest_disease || "Healthy",
                        JSON.stringify(data.custom_data || {}),
                        lat,
                        lng,
                        data.remarks || "",
                        existing.id
                    )
                    .run();
            } else {
                await db
                    .prepare(
                        "INSERT INTO harvest_logs (tree_id, block_id, harvest_date, year_month, day_of_month, round_number, bunches_cut, fronds_cut, bunch_weight_kg, weed_growth, fertilizer_type, fertilizer_kg, pruning_status, pest_disease, custom_data_json, latitude, longitude, remarks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
                    )
                    .bind(
                        tree.id,
                        blockId,
                        rInfo.date,
                        rInfo.year_month,
                        rInfo.day_of_month,
                        rInfo.round_number,
                        Number(data.bunches_cut || 0),
                        Number(data.fronds_cut || 0),
                        Number(data.bunch_weight_kg || 0),
                        data.weed_growth || "Clean Circle",
                        data.fertilizer_type || "None",
                        Number(data.fertilizer_kg || 0),
                        data.pruning_status || "Standard Stacked",
                        data.pest_disease || "Healthy",
                        JSON.stringify(data.custom_data || {}),
                        lat,
                        lng,
                        data.remarks || ""
                    )
                    .run();
            }

            return jsonResponse({
                message: `Saved Tree #${treeNumber} (${rInfo.round_label}): ${data.bunches_cut} Bunches, ${data.fronds_cut} Fronds`,
                tree_number: treeNumber,
                next_tree_number: treeNumber + 1,
                round_info: rInfo,
            });
        }

        if (path === "/api/hierarchy/create") {
            if (data.level === "block") {
                const res = await db
                    .prepare(
                        "INSERT INTO blocks (field_id, code, name, palm_variety, area_ha, target_stands) VALUES (?, ?, ?, 'Tenera Hybrid', 12.0, ?)"
                    )
                    .bind(
                        Number(data.field_id || 1),
                        data.code,
                        data.name,
                        Number(data.auto_generate_trees || 20)
                    )
                    .run();
                const blkId = res.meta?.last_row_id || 2;
                const count = Number(data.auto_generate_trees || 20);
                const baseLat = Number(data.base_latitude || 6.1425);
                const baseLng = Number(data.base_longitude || 80.3652);
                const stmts = [];
                for (let i = 1; i <= count; i++) {
                    const rNo = Math.floor((i - 1) / 5) + 1;
                    const cNo = (i - 1) % 5;
                    const tLat = Number((baseLat + (rNo - 1) * 0.000075).toFixed(6));
                    const tLng = Number((baseLng + cNo * 0.000085 + (rNo % 2 === 0 ? 0.000042 : 0)).toFixed(6));
                    stmts.push(
                        db
                            .prepare(
                                "INSERT INTO trees (block_id, tree_number, tree_code, row_number, latitude, longitude, planting_year) VALUES (?, ?, ?, ?, ?, ?, 2020)"
                            )
                            .bind(blkId, i, `T-${String(i).padStart(3, "0")}`, rNo, tLat, tLng)
                    );
                }
                if (stmts.length) await db.batch(stmts);
            }
            return jsonResponse({ message: "Block and geo-tagged palms created." });
        }

        if (path === "/api/custom-fields") {
            const label = String(data.field_label || "").trim();
            const key = label.toLowerCase().replace(/[^a-z0-9]+/g, "_");
            await db
                .prepare(
                    "INSERT OR REPLACE INTO custom_field_defs (field_key, field_label, field_type, options_csv, is_active) VALUES (?, ?, ?, ?, 1)"
                )
                .bind(key, label, data.field_type || "select", data.options_csv || "")
                .run();
            return jsonResponse({ message: `Custom field '${label}' added.` });
        }
    }

    return jsonResponse({ error: "Endpoint not found" }, 404);
}
