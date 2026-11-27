import sqlite3
import hashlib
import secrets
import json
import math
import os
from datetime import datetime, date

DB_DIR = os.environ.get("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))
os.makedirs(DB_DIR, exist_ok=True)
DB_PATH = os.environ.get("ELAEIS_DB_PATH", os.path.join(DB_DIR, "elaeis.db"))

INITIAL_ERP_PASSWORD = os.environ.get("ERP_INITIAL_PASSWORD", "Elaeis2026!")
DEFAULT_ESTATE_NAME = os.environ.get("ELAEIS_ESTATE_NAME", "Primary Plantation Estate")
DEFAULT_ESTATE_REGION = os.environ.get("ELAEIS_ESTATE_REGION", "")

ROLE_RANK = {
    "Harvester": 1,
    "Supervisor": 2,
    "Admin": 3,
    "Master Admin": 4,
}


def hash_password(password: str, salt: str = None) -> str:
    if not salt:
        salt = secrets.token_hex(16)
    pwd_hash = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), 100000
    ).hex()
    return f"{salt}${pwd_hash}"


def verify_password(password: str, stored_hash: str) -> bool:
    if not stored_hash or "$" not in stored_hash:
        return False
    salt, _ = stored_hash.split("$", 1)
    return secrets.compare_digest(hash_password(password, salt), stored_hash)


def compute_harvest_round(date_str: str, explicit_round: int = None) -> dict:
    """
    10-Day Monthly Harvesting Rounds:
    - Round 1: Days 1 to 10
    - Round 2: Days 11 to 20
    - Round 3: Days 21 to End of Month
    """
    try:
        dt = datetime.strptime(str(date_str)[:10], "%Y-%m-%d").date()
    except Exception:
        dt = date.today()

    day = dt.day
    if explicit_round in (1, 2, 3):
        round_no = int(explicit_round)
    elif day <= 10:
        round_no = 1
    elif day <= 20:
        round_no = 2
    else:
        round_no = 3

    labels = {
        1: "Round 1 (Days 1-10)",
        2: "Round 2 (Days 11-20)",
        3: "Round 3 (Days 21-End)",
    }

    return {
        "date": dt.strftime("%Y-%m-%d"),
        "year_month": dt.strftime("%Y-%m"),
        "month_name": dt.strftime("%B %Y"),
        "day_of_month": day,
        "round_number": round_no,
        "round_label": labels[round_no],
    }


def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def seed_erp_users(cur):
    """
    Wipes legacy default users and seeds the exact corporate ERP roster.
    Initial password for all seeded accounts: Uskvalley2026!
    Role hierarchy: Master Admin > Admin > Supervisor > Harvester
    """
    cur.execute("DELETE FROM sessions")
    cur.execute("DELETE FROM users")
    cur.execute("DELETE FROM sqlite_sequence WHERE name = 'users'")

    default_pwd_hash = hash_password(INITIAL_ERP_PASSWORD)

    # (id, username, full_name, role, is_master, assigned_estate_id)
    erp_users = [
        # Master Admin
        (1, "sandaru98j", "Sandaruwan Gunathilaka", "Master Admin", 1, 1),
        # Admin (Manager)
        (2, "sandun", "Sandun (Estate Manager)", "Admin", 0, 1),
        # Supervisors
        (3, "raveendra", "Raveendra", "Supervisor", 0, 1),
        (4, "pasindu", "Pasindu", "Supervisor", 0, 1),
        (5, "kavindu", "Kavindu", "Supervisor", 0, 1),
        (6, "muditha", "Muditha", "Supervisor", 0, 1),
        (7, "rajasekaran", "Rajasekaran", "Supervisor", 0, 1),
        # Harvesters
        (8, "ajith", "Ajith", "Harvester", 0, 1),
        (9, "baba", "Baba", "Harvester", 0, 1),
    ]

    cur.executemany(
        """
        INSERT INTO users (id, username, email, phone, full_name, role, is_master, assigned_estate_id, password_hash)
        VALUES (?, ?, '', '', ?, ?, ?, ?, ?)
        """,
        [(uid, u, fn, r, m, est_id, default_pwd_hash) for (uid, u, fn, r, m, est_id) in erp_users],
    )


def init_db(force_reseed_users: bool = False):
    conn = get_connection()
    cur = conn.cursor()

    # Check if an older schema exists in elaeis.db and upgrade tables cleanly
    cur.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'")
    existing_users_sql = cur.fetchone()
    cur.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='blocks'")
    existing_blocks_sql = cur.fetchone()
    if (
        (existing_users_sql and ("email TEXT UNIQUE NOT NULL" in existing_users_sql["sql"] or "is_master" not in existing_users_sql["sql"]))
        or (existing_blocks_sql and "boundary_note" not in existing_blocks_sql["sql"])
    ):
        cur.executescript(
            """
            DROP TABLE IF EXISTS sessions;
            DROP TABLE IF EXISTS users;
            DROP TABLE IF EXISTS harvest_logs;
            DROP TABLE IF EXISTS dispatch_logs;
            DROP TABLE IF EXISTS trees;
            DROP TABLE IF EXISTS blocks;
            DROP TABLE IF EXISTS fields;
            DROP TABLE IF EXISTS divisions;
            DROP TABLE IF EXISTS estates;
            DROP TABLE IF EXISTS custom_field_defs;
            """
        )

    cur.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL COLLATE NOCASE,
            email TEXT DEFAULT '',
            phone TEXT DEFAULT '',
            full_name TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'Harvester',
            is_master INTEGER NOT NULL DEFAULT 0,
            assigned_estate_id INTEGER DEFAULT 1,
            theme TEXT DEFAULT 'twitter',
            profile_pic TEXT DEFAULT '',
            cover_photo TEXT DEFAULT '',
            password_hash TEXT NOT NULL,
            reset_token TEXT,
            reset_expires TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            expires_at TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS estates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            crop_type TEXT NOT NULL DEFAULT 'Oil Palm (Elaeis guineensis)',
            location_region TEXT DEFAULT 'Baduraliya, Sri Lanka',
            total_area_ha REAL DEFAULT 147.25,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS divisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            estate_id INTEGER NOT NULL,
            code TEXT NOT NULL,
            name TEXT NOT NULL,
            supervisor_name TEXT DEFAULT '',
            FOREIGN KEY (estate_id) REFERENCES estates(id) ON DELETE CASCADE,
            UNIQUE(estate_id, code)
        );

        CREATE TABLE IF NOT EXISTS fields (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            division_id INTEGER NOT NULL,
            code TEXT NOT NULL,
            name TEXT NOT NULL,
            planting_year INTEGER DEFAULT 2011,
            area_ha REAL DEFAULT 11.0,
            FOREIGN KEY (division_id) REFERENCES divisions(id) ON DELETE CASCADE,
            UNIQUE(division_id, code)
        );

        CREATE TABLE IF NOT EXISTS blocks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            field_id INTEGER NOT NULL,
            code TEXT NOT NULL,
            name TEXT NOT NULL,
            boundary_note TEXT DEFAULT '',
            palm_variety TEXT DEFAULT 'DxP Tenera',
            area_ha REAL DEFAULT 5.5,
            target_stands INTEGER DEFAULT 285,
            FOREIGN KEY (field_id) REFERENCES fields(id) ON DELETE CASCADE,
            UNIQUE(field_id, code)
        );

        CREATE TABLE IF NOT EXISTS trees (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            block_id INTEGER NOT NULL,
            tree_number INTEGER NOT NULL,
            tree_code TEXT NOT NULL,
            row_number INTEGER DEFAULT 1,
            latitude REAL,
            longitude REAL,
            gps_acc REAL DEFAULT 4.0,
            planting_year INTEGER DEFAULT 2011,
            status TEXT DEFAULT 'active',
            health_status TEXT DEFAULT 'Healthy',
            mapped_by INTEGER,
            mapped_at TEXT,
            notes TEXT DEFAULT '',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE,
            UNIQUE(block_id, tree_number)
        );

        CREATE TABLE IF NOT EXISTS harvest_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tree_id INTEGER NOT NULL,
            block_id INTEGER NOT NULL,
            harvest_date TEXT NOT NULL,
            year_month TEXT NOT NULL,
            day_of_month INTEGER NOT NULL,
            round_number INTEGER NOT NULL CHECK (round_number IN (1, 2, 3)),
            bunches_cut INTEGER NOT NULL DEFAULT 0,
            fronds_cut INTEGER NOT NULL DEFAULT 0,
            bunch_weight_kg REAL DEFAULT 0.0,
            latitude REAL,
            longitude REAL,
            gps_acc REAL DEFAULT 4.2,
            health_status TEXT DEFAULT 'Healthy',
            loose_fruit INTEGER DEFAULT 1,
            recorded_by_id INTEGER,
            recorded_by_name TEXT DEFAULT 'System',
            remarks TEXT DEFAULT '',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (tree_id) REFERENCES trees(id) ON DELETE CASCADE,
            FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE,
            UNIQUE(tree_id, year_month, round_number)
        );

        CREATE TABLE IF NOT EXISTS dispatch_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            division_id INTEGER NOT NULL,
            dispatch_date TEXT NOT NULL,
            year_month TEXT NOT NULL,
            round_number INTEGER NOT NULL CHECK (round_number IN (1, 2, 3)),
            weight_kg REAL NOT NULL,
            client_id TEXT,
            recorded_by_id INTEGER,
            recorded_by_name TEXT DEFAULT 'System',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (division_id) REFERENCES divisions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_trees_block ON trees (block_id);
        CREATE INDEX IF NOT EXISTS idx_trees_coords ON trees (latitude, longitude);
        CREATE INDEX IF NOT EXISTS idx_harvest_date ON harvest_logs (harvest_date);
        CREATE INDEX IF NOT EXISTS idx_harvest_ym_round ON harvest_logs (year_month, round_number);
        CREATE INDEX IF NOT EXISTS idx_dispatch_date ON dispatch_logs (dispatch_date);
        """
    )

    cur.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('season_start_month', '4')")

    # Safe additive column migrations for existing SQLite databases
    for col_sql in (
        "ALTER TABLE users ADD COLUMN theme TEXT DEFAULT 'twitter'",
        "ALTER TABLE users ADD COLUMN profile_pic TEXT DEFAULT ''",
        "ALTER TABLE users ADD COLUMN cover_photo TEXT DEFAULT ''",
        "ALTER TABLE trees ADD COLUMN health_status TEXT DEFAULT 'Healthy'",
        "ALTER TABLE harvest_logs ADD COLUMN health_status TEXT DEFAULT 'Healthy'",
        "ALTER TABLE harvest_logs ADD COLUMN loose_fruit INTEGER DEFAULT 1",
        "ALTER TABLE dispatch_logs ADD COLUMN client_id TEXT",
    ):
        try:
            cur.execute(col_sql)
        except Exception:
            pass

    cur.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_client_id ON dispatch_logs (client_id) WHERE client_id IS NOT NULL"
    )

    # Seed initial ERP users only if no Master Admin exists or force_reseed_users is True
    cur.execute("SELECT COUNT(*) as cnt FROM users WHERE is_master = 1")
    has_master = cur.fetchone()["cnt"] > 0
    if force_reseed_users or not has_master:
        seed_erp_users(cur)

    # Seed starter 5-tier plantation hierarchy ONLY if no estates exist yet (never wipe renamed real estates!)
    cur.execute("SELECT COUNT(*) AS cnt FROM estates")
    has_estates = cur.fetchone()["cnt"] > 0
    if not has_estates:
        seed_plantation_data(cur)

    conn.commit()
    conn.close()


BLOCK_STAND_COUNTS = [
    560, 540, 580, 550, 590, 565, 545, 535, 520, 515,
    575, 545, 550, 565, 540, 530, 570, 545, 560, 540,
]


def compute_palm_coordinates(block_id: int, tree_no: int) -> tuple[float, float]:
    """
    Deterministic natural hillside contour coordinate generator for Uskvalley Estate
    (Baduraliya, Sri Lanka ~ 6.1420 N, 80.3650 E).
    Separates the 3 Divisions, 10 Fields, and 20 Blocks with natural farm road & stream
    corridors while curving palm rows along hillside contours.
    """
    b_idx = max(0, int(block_id) - 1)
    field_idx = b_idx // 2
    block_in_field = b_idx % 2

    if field_idx <= 5:
        # Division 1 (Uskvalley Division): Fields 1..6 (2 cols x 3 rows)
        f_col = field_idx % 2
        f_row = field_idx // 2
        field_base_lat = 6.1420 + f_row * 0.00255
        field_base_lng = 80.3650 + f_col * 0.00485
    elif field_idx <= 7:
        # Division 2 (Trafalgar Division): Fields 7..8 (Northeast sector)
        f_row = field_idx - 6
        field_base_lat = 6.1452 + f_row * 0.00255
        field_base_lng = 80.3756
    elif field_idx <= 9:
        # Division 3 (Morawaka Division): Fields 9..10 (Southeast sector)
        f_row = field_idx - 8
        field_base_lat = 6.14175 - f_row * 0.00255
        field_base_lng = 80.3756
    else:
        extra = field_idx - 10
        field_base_lat = 6.1392 - ((extra // 2) + 1) * 0.00255
        field_base_lng = 80.3650 + (extra % 2) * 0.00485

    block_base_lat = field_base_lat
    block_base_lng = field_base_lng + block_in_field * 0.00235

    cols = 23
    idx = max(0, int(tree_no) - 1)
    row = idx // cols
    col = idx % cols

    # Triangular oil palm spacing offset on odd rows
    stag_lng = 0.000040 if (row % 2 == 1) else 0.0

    # Smooth natural contour wave (anchored at 0 for tree #1 at row=0, col=0)
    u = (col / 22.0) * math.pi
    v = (row / 24.0) * math.pi
    phase = b_idx * 0.65
    curve_lat = math.sin(u + phase) * 0.00011 - math.sin(phase) * 0.00011
    curve_lng = math.sin(v + phase * 0.7) * 0.00011 - math.sin(phase * 0.7) * 0.00011
    arch_lat = math.sin(u) * (0.00008 if block_in_field == 0 else -0.00008)

    lat = round(block_base_lat + row * 0.000075 + curve_lat + arch_lat, 6)
    lng = round(block_base_lng + col * 0.000078 + stag_lng + curve_lng, 6)
    return lat, lng


def ensure_full_estate_gis_trees(cur):
    """
    Upgrades existing SQLite databases so all 20 blocks across the 3 Divisions and 10 Fields
    contain the full 11,020 geo-tagged oil palm stand with natural contoured coordinates.
    """
    cur.execute("SELECT COUNT(*) AS cnt FROM trees WHERE latitude IS NOT NULL AND longitude IS NOT NULL")
    mapped_cnt = cur.fetchone()["cnt"]
    if mapped_cnt >= 11000:
        return

    now_str = datetime.now().isoformat()
    today_str = date.today().strftime("%Y-%m-%d")
    ym = today_str[:7]
    cur_round = compute_harvest_round(today_str)["round_number"]

    cur.execute("SELECT b.id, b.field_id, f.planting_year FROM blocks b JOIN fields f ON f.id = b.field_id ORDER BY b.id")
    blocks_list = [dict(r) for r in cur.fetchall()]

    for b in blocks_list:
        bid = b["id"]
        pyear = b["planting_year"] or 2011
        target_count = BLOCK_STAND_COUNTS[bid - 1] if 1 <= bid <= len(BLOCK_STAND_COUNTS) else 540
        cur.execute("UPDATE blocks SET target_stands = ? WHERE id = ?", (target_count, bid))

        cur.execute("SELECT id, tree_number FROM trees WHERE block_id = ? ORDER BY tree_number", (bid,))
        existing_rows = cur.fetchall()
        existing_nos = set()
        update_batch = []
        for r in existing_rows:
            tno = r["tree_number"]
            existing_nos.add(tno)
            lat, lng = compute_palm_coordinates(bid, tno)
            row_no = ((tno - 1) // 23) + 1
            update_batch.append((lat, lng, 3.8, row_no, now_str, r["id"]))

        if update_batch:
            cur.executemany(
                "UPDATE trees SET latitude = ?, longitude = ?, gps_acc = COALESCE(gps_acc, ?), row_number = ?, mapped_at = COALESCE(mapped_at, ?) WHERE id = ?",
                update_batch,
            )

        new_rows = []
        for tno in range(1, target_count + 1):
            if tno in existing_nos:
                continue
            lat, lng = compute_palm_coordinates(bid, tno)
            row_no = ((tno - 1) // 23) + 1
            new_rows.append((bid, tno, f"T-{tno:03d}", row_no, lat, lng, 3.8, pyear, "active", now_str))

        if new_rows:
            cur.executemany(
                """
                INSERT OR IGNORE INTO trees (
                    block_id, tree_number, tree_code, row_number,
                    latitude, longitude, gps_acc, planting_year, status, mapped_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                new_rows,
            )

    # Seed realistic harvest distribution across all 20 blocks if only initial demo logs exist
    cur.execute("SELECT COUNT(*) AS hcnt FROM harvest_logs")
    if cur.fetchone()["hcnt"] < 100:
        seed_sample_estate_harvests(cur, today_str, ym, cur_round)


def seed_sample_estate_harvests(cur, today_str: str, ym: str, cur_round: int):
    harvesters = [
        (8, "Ajith"),
        (9, "Baba"),
        (3, "Raveendra"),
        (4, "Pasindu"),
        (5, "Kavindu"),
    ]
    dom = int(today_str[8:10])
    batch_logs = []
    div_bunches = {1: {1: 0, cur_round: 0}, 2: {1: 0, cur_round: 0}, 3: {1: 0, cur_round: 0}}

    cur.execute(
        """
        SELECT t.id, t.block_id, t.tree_number, t.latitude, t.longitude, f.division_id
        FROM trees t
        JOIN blocks b ON b.id = t.block_id
        JOIN fields f ON f.id = b.field_id
        ORDER BY t.block_id, t.tree_number
        """
    )
    for r in cur.fetchall():
        tid = r["id"]
        bid = r["block_id"]
        tno = r["tree_number"]
        did = r["division_id"]
        # Deterministic realistic harvest pattern (~32% of palms harvested across the estate)
        if (tno + bid * 3) % 3 == 0:
            uid, uname = harvesters[(tid + bid) % len(harvesters)]
            bunches = 2 + ((tno * 7 + bid) % 5)
            fronds = 2 + ((tno * 3 + bid) % 4)
            is_r1 = (tno + bid) % 2 == 0
            rnd = 1 if is_r1 else cur_round
            hdate = f"{ym}-05" if is_r1 else today_str
            hdom = 5 if is_r1 else dom
            batch_logs.append(
                (
                    tid,
                    bid,
                    hdate,
                    ym,
                    hdom,
                    rnd,
                    bunches,
                    fronds,
                    round(bunches * 18.5, 1),
                    r["latitude"],
                    r["longitude"],
                    3.9,
                    uid,
                    uname,
                )
            )
            div_bunches[did][rnd] = div_bunches.get(did, {}).get(rnd, 0) + bunches

    if batch_logs:
        cur.executemany(
            """
            INSERT OR IGNORE INTO harvest_logs (
                tree_id, block_id, harvest_date, year_month, day_of_month, round_number,
                bunches_cut, fronds_cut, bunch_weight_kg, latitude, longitude, gps_acc,
                recorded_by_id, recorded_by_name
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            batch_logs,
        )

        # Keep mill dispatch weights aligned with harvested bunches (~18.5 kg ABW)
        cur.execute("DELETE FROM dispatch_logs")
        disp_rows = []
        for did, rmap in div_bunches.items():
            sup_id, sup_name = (3, "Raveendra") if did == 1 else (4, "Pasindu") if did == 2 else (5, "Kavindu")
            for rnd, b_cnt in rmap.items():
                if b_cnt > 0:
                    ddate = f"{ym}-05" if rnd == 1 else today_str
                    disp_rows.append((did, ddate, ym, rnd, round(b_cnt * 18.4, 1), sup_id, sup_name))
        if disp_rows:
            cur.executemany(
                """
                INSERT INTO dispatch_logs (division_id, dispatch_date, year_month, round_number, weight_kg, recorded_by_id, recorded_by_name)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                disp_rows,
            )


def seed_plantation_data(cur):
    # Level 1: Estate (configurable via ELAEIS_ESTATE_NAME for real estate rollouts)
    cur.execute(
        """
        INSERT INTO estates (id, code, name, crop_type, location_region, total_area_ha)
        VALUES (1, 'EST-01', ?, 'Oil Palm (Elaeis guineensis)', ?, 147.25)
        """,
        (DEFAULT_ESTATE_NAME, DEFAULT_ESTATE_REGION),
    )

    # Level 2: Divisions
    divisions = [
        (1, 1, "DIV-01", "Division 1", "Raveendra"),
        (2, 1, "DIV-02", "Division 2", "Pasindu"),
        (3, 1, "DIV-03", "Division 3", "Kavindu"),
    ]
    cur.executemany(
        "INSERT INTO divisions (id, estate_id, code, name, supervisor_name) VALUES (?, ?, ?, ?, ?)",
        divisions,
    )

    # Level 3: Fields (Planting Year & Area in Hectares Ha)
    fields = [
        (1, 1, "FLD-01", "Field 1", 2011, 11.00),
        (2, 1, "FLD-02", "Field 2", 2011, 16.50),
        (3, 1, "FLD-03", "Field 3", 2011, 28.00),
        (4, 1, "FLD-04", "Field 4", 2013, 19.00),
        (5, 1, "FLD-05", "Field 5", 2014, 3.75),
        (6, 1, "FLD-06", "Field 6", 2015, 1.75),
        (7, 2, "FLD-07", "Field 1", 2012, 22.50),
        (8, 2, "FLD-08", "Field 2", 2014, 14.25),
        (9, 3, "FLD-09", "Field 1", 2013, 18.00),
        (10, 3, "FLD-10", "Field 2", 2016, 12.50),
    ]
    cur.executemany(
        "INSERT INTO fields (id, division_id, code, name, planting_year, area_ha) VALUES (?, ?, ?, ?, ?, ?)",
        fields,
    )

    # Level 4 & 5: Blocks & Palm Trees (11,020 Geo-Tagged Oil Palms across 20 Blocks)
    block_counts = BLOCK_STAND_COUNTS
    block_id = 0
    now_str = datetime.now().isoformat()
    today_str = date.today().strftime("%Y-%m-%d")
    ym = today_str[:7]
    cur_round = compute_harvest_round(today_str)["round_number"]

    for fid, did, fcode, fname, pyear, fha in fields:
        for b_idx, (bname, bnote) in enumerate(
            [("Block A", "Valley stream boundary"), ("Block B", "Ridge road boundary")], start=1
        ):
            block_id += 1
            palm_count = block_counts[block_id - 1]
            bcode = f"BLK-{fid:02d}{'A' if b_idx == 1 else 'B'}"
            cur.execute(
                """
                INSERT INTO blocks (id, field_id, code, name, boundary_note, palm_variety, area_ha, target_stands)
                VALUES (?, ?, ?, ?, ?, 'DxP Tenera', ?, ?)
                """,
                (block_id, fid, bcode, bname, bnote, round(fha / 2.0, 2), palm_count),
            )

            tree_rows = []
            for tno in range(1, palm_count + 1):
                row_no = ((tno - 1) // 23) + 1
                lat, lng = compute_palm_coordinates(block_id, tno)
                tree_rows.append(
                    (block_id, tno, f"T-{tno:03d}", row_no, lat, lng, 3.8, pyear, "active", now_str)
                )

            cur.executemany(
                """
                INSERT INTO trees (
                    block_id, tree_number, tree_code, row_number,
                    latitude, longitude, gps_acc, planting_year, status, mapped_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                tree_rows,
            )

    seed_sample_estate_harvests(cur, today_str, ym, cur_round)


if __name__ == "__main__":
    init_db(force_reseed_users=True)
    print(f"Database initialized and ERP users seeded successfully at {DB_PATH}")
