import sqlite3
import hashlib
import secrets
import json
import os
from datetime import datetime, date

DB_DIR = os.environ.get("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))
os.makedirs(DB_DIR, exist_ok=True)
DB_PATH = os.environ.get("ELAEIS_DB_PATH", os.path.join(DB_DIR, "elaeis.db"))

INITIAL_ERP_PASSWORD = "Uskvalley2026!"

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
            recorded_by_id INTEGER,
            recorded_by_name TEXT DEFAULT 'System',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (division_id) REFERENCES divisions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """
    )

    cur.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('season_start_month', '4')")

    # Ensure theme, profile_pic, and cover_photo columns exist on existing SQLite databases
    for col_sql in (
        "ALTER TABLE users ADD COLUMN theme TEXT DEFAULT 'twitter'",
        "ALTER TABLE users ADD COLUMN profile_pic TEXT DEFAULT ''",
        "ALTER TABLE users ADD COLUMN cover_photo TEXT DEFAULT ''",
    ):
        try:
            cur.execute(col_sql)
        except Exception:
            pass

    # Seed or refresh ERP users if empty, if force_reseed_users is True, or if master admin sandaru98j is missing
    cur.execute("SELECT COUNT(*) as cnt FROM users WHERE LOWER(username) = 'sandaru98j'")
    has_master = cur.fetchone()["cnt"] > 0
    if force_reseed_users or not has_master:
        seed_erp_users(cur)

    # Seed Uskvalley Estate 5-tier hierarchy if empty or still using old demo estate name
    cur.execute("SELECT name FROM estates WHERE id = 1")
    est_row = cur.fetchone()
    if not est_row or "Uskvalley" not in est_row["name"]:
        cur.execute("DELETE FROM harvest_logs")
        cur.execute("DELETE FROM dispatch_logs")
        cur.execute("DELETE FROM trees")
        cur.execute("DELETE FROM blocks")
        cur.execute("DELETE FROM fields")
        cur.execute("DELETE FROM divisions")
        cur.execute("DELETE FROM estates")
        seed_plantation_data(cur)

    conn.commit()
    conn.close()


def seed_plantation_data(cur):
    # Level 1: Estate
    cur.execute(
        """
        INSERT INTO estates (id, code, name, crop_type, location_region, total_area_ha)
        VALUES (1, 'EST-USK', 'Uskvalley Estate', 'Oil Palm (Elaeis guineensis)', 'Baduraliya, Sri Lanka', 147.25)
        """
    )

    # Level 2: Divisions
    divisions = [
        (1, 1, "DIV-USK", "Uskvalley Division", "Raveendra"),
        (2, 1, "DIV-TRF", "Trafalgar Division", "Pasindu"),
        (3, 1, "DIV-MRW", "Morawaka Division", "Kavindu"),
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

    # Level 4 & 5: Blocks & Palm Trees
    block_counts = [
        285, 268, 312, 294, 320, 305, 290, 264, 248, 240,
        308, 282, 274, 296, 265, 258, 301, 277, 289, 252,
    ]
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
                row_no = ((tno - 1) // 10) + 1
                is_mapped = block_id == 1 and tno <= 150
                lat = round(6.1420 + ((tno - 1) // 10) * 0.00008, 6) if is_mapped else None
                lng = round(80.3650 + ((tno - 1) % 10) * 0.00008, 6) if is_mapped else None
                acc = 3.8 if is_mapped else None
                mapped_at = now_str if is_mapped else None
                tree_rows.append(
                    (block_id, tno, f"T-{tno:03d}", row_no, lat, lng, acc, pyear, "active", mapped_at)
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

    # Seed initial harvest logs on Block 1 across Rounds 1, 2, and 3
    sample_harvest = [
        (1, f"{ym}-04", ym, 4, 1, 12, 8, 8, "Ajith", 0.00002, 0.00001, 4.1),
        (1, f"{ym}-14", ym, 14, 2, 11, 7, 1, "Sandaruwan Gunathilaka", 0.00001, 0.00002, 3.8),
        (2, f"{ym}-04", ym, 4, 1, 10, 7, 8, "Ajith", 0.00003, -0.00002, 3.9),
        (2, f"{ym}-22", ym, 22, 3, 9, 6, 1, "Sandaruwan Gunathilaka", 0.00002, -0.00001, 3.9),
        (3, f"{ym}-05", ym, 5, 1, 14, 9, 9, "Baba", 0.00042, 0.00035, 6.2),
        (4, f"{ym}-05", ym, 5, 1, 11, 8, 3, "Raveendra", 0.00001, 0.00002, 3.5),
        (5, today_str, ym, int(today_str[8:10]), cur_round, 15, 10, 8, "Ajith", 0.00002, 0.00002, 4.0),
        (6, today_str, ym, int(today_str[8:10]), cur_round, 9, 6, 9, "Baba", 0.00075, -0.00048, 8.0),
        (7, today_str, ym, int(today_str[8:10]), cur_round, 13, 8, 1, "Sandaruwan Gunathilaka", 0.00001, -0.00001, 3.7),
        (8, today_str, ym, int(today_str[8:10]), cur_round, 11, 7, 3, "Raveendra", 0.00002, 0.00001, 4.2),
    ]
    for tno, hdate, ymo, dom, rnd, bunches, fronds, uid, uname, dlat, dlng, acc in sample_harvest:
        base_lat = 6.1420 + ((tno - 1) // 10) * 0.00008
        base_lng = 80.3650 + ((tno - 1) % 10) * 0.00008
        cur.execute("SELECT id FROM trees WHERE block_id = 1 AND tree_number = ?", (tno,))
        t_row = cur.fetchone()
        if t_row:
            cur.execute(
                """
                INSERT OR IGNORE INTO harvest_logs (
                    tree_id, block_id, harvest_date, year_month, day_of_month, round_number,
                    bunches_cut, fronds_cut, bunch_weight_kg, latitude, longitude, gps_acc,
                    recorded_by_id, recorded_by_name
                ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    t_row["id"],
                    hdate,
                    ymo,
                    dom,
                    rnd,
                    bunches,
                    fronds,
                    round(bunches * 18.5, 1),
                    round(base_lat + dlat, 6),
                    round(base_lng + dlng, 6),
                    acc,
                    uid,
                    uname,
                ),
            )

    # Seed initial Mill Dispatch Crop Weights
    sample_dispatches = [
        (1, f"{ym}-05", ym, 1, 895.0, 3, "Raveendra"),
        (1, today_str, ym, cur_round, 1480.0, 3, "Raveendra"),
        (2, today_str, ym, cur_round, 640.0, 4, "Pasindu"),
    ]
    cur.executemany(
        """
        INSERT INTO dispatch_logs (division_id, dispatch_date, year_month, round_number, weight_kg, recorded_by_id, recorded_by_name)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        sample_dispatches,
    )


if __name__ == "__main__":
    init_db(force_reseed_users=True)
    print(f"Database initialized and ERP users seeded successfully at {DB_PATH}")
