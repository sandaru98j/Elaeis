import sqlite3
import hashlib
import secrets
import json
import os
from datetime import datetime, date

DB_DIR = os.environ.get("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))
os.makedirs(DB_DIR, exist_ok=True)
DB_PATH = os.environ.get("ELAEIS_DB_PATH", os.path.join(DB_DIR, "elaeis.db"))


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


def compute_harvest_round(date_str: str) -> dict:
    """
    Malaysian / Tropical Palm 3-Round Monthly Harvesting System:
    - Round 1: Days 1 to 10
    - Round 2: Days 11 to 20
    - Round 3: Days 21 to 28/29/30/31 (end of month)
    """
    try:
        dt = datetime.strptime(date_str[:10], "%Y-%m-%d").date()
    except Exception:
        dt = date.today()

    day = dt.day
    if day <= 10:
        round_no = 1
        round_label = "Round 1 (Days 1â€“10)"
    elif day <= 20:
        round_no = 2
        round_label = "Round 2 (Days 11â€“20)"
    else:
        round_no = 3
        round_label = "Round 3 (Days 21â€“End)"

    return {
        "date": dt.strftime("%Y-%m-%d"),
        "year_month": dt.strftime("%Y-%m"),
        "month_name": dt.strftime("%B %Y"),
        "day_of_month": day,
        "round_number": round_no,
        "round_label": round_label,
    }


def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_connection()
    cur = conn.cursor()

    cur.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            phone TEXT UNIQUE NOT NULL,
            full_name TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'Supervisor',
            assigned_estate_id INTEGER,
            password_hash TEXT NOT NULL,
            reset_token TEXT,
            reset_expires TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS estates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            crop_type TEXT NOT NULL DEFAULT 'Oil Palm (Elaeis guineensis)',
            location_region TEXT DEFAULT 'Johor, Malaysia',
            total_area_ha REAL DEFAULT 0,
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
            planting_year INTEGER DEFAULT 2018,
            area_ha REAL DEFAULT 25.0,
            FOREIGN KEY (division_id) REFERENCES divisions(id) ON DELETE CASCADE,
            UNIQUE(division_id, code)
        );

        CREATE TABLE IF NOT EXISTS blocks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            field_id INTEGER NOT NULL,
            code TEXT NOT NULL,
            name TEXT NOT NULL,
            palm_variety TEXT DEFAULT 'DxP Tenera',
            area_ha REAL DEFAULT 10.0,
            target_stands INTEGER DEFAULT 148,
            FOREIGN KEY (field_id) REFERENCES fields(id) ON DELETE CASCADE,
            UNIQUE(field_id, code)
        );

        CREATE TABLE IF NOT EXISTS trees (
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
            last_fertilizer_type TEXT DEFAULT 'NPK 12:12:17:2',
            last_fertilizer_kg REAL DEFAULT 2.5,
            last_fertilizer_date TEXT DEFAULT '',
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
            loose_fruits_count INTEGER DEFAULT 0,
            weed_growth TEXT DEFAULT 'Clean Circle',
            fertilizer_type TEXT DEFAULT 'None',
            fertilizer_kg REAL DEFAULT 0.0,
            pruning_status TEXT DEFAULT 'Standard Stacked',
            pest_disease TEXT DEFAULT 'Healthy',
            custom_data_json TEXT DEFAULT '{}',
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            recorded_by_id INTEGER,
            recorded_by_name TEXT DEFAULT 'System',
            remarks TEXT DEFAULT '',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (tree_id) REFERENCES trees(id) ON DELETE CASCADE,
            FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS custom_field_defs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            field_key TEXT UNIQUE NOT NULL,
            field_label TEXT NOT NULL,
            field_type TEXT NOT NULL DEFAULT 'text',
            options_csv TEXT DEFAULT '',
            unit TEXT DEFAULT '',
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        """
    )

    # Seed default users if empty
    cur.execute("SELECT COUNT(*) as cnt FROM users")
    if cur.fetchone()["cnt"] == 0:
        default_users = [
            (
                "admin",
                "admin@elaeis.my",
                "+60123456789",
                "Ahmad Razak (Estate Manager)",
                "Admin",
                1,
                hash_password("admin123"),
            ),
            (
                "supervisor1",
                "kumar@elaeis.my",
                "+60198765432",
                "S. Kumar (Field Conductor)",
                "Supervisor",
                1,
                hash_password("super123"),
            ),
            (
                "harvester1",
                "faizal@elaeis.my",
                "+60172233445",
                "Mohd Faizal (Harvesting Team Lead)",
                "Harvester",
                1,
                hash_password("harvest123"),
            ),
        ]
        cur.executemany(
            """
            INSERT INTO users (username, email, phone, full_name, role, assigned_estate_id, password_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            default_users,
        )

    # Seed default custom agronomic field definitions if empty
    cur.execute("SELECT COUNT(*) as cnt FROM custom_field_defs")
    if cur.fetchone()["cnt"] == 0:
        cur.executemany(
            """
            INSERT INTO custom_field_defs (field_key, field_label, field_type, options_csv, unit)
            VALUES (?, ?, ?, ?, ?)
            """,
            [
                ("circle_raking", "Circle Raking / Mulching", "select", "Done,Partial,Pending,EFB Mulched", ""),
                ("soil_moisture", "Soil Moisture Condition", "select", "Optimal,Moist,Dry,Waterlogged", ""),
                ("frond_spiral_angle", "Canopy / Frond Condition", "select", "Green Optimal,Yellowish (Mg Def),Boron Hook Leaf,Normal", ""),
            ],
        )

    # Seed hierarchy (Estate -> Division -> Field -> Block -> Trees) if empty
    cur.execute("SELECT COUNT(*) as cnt FROM estates")
    if cur.fetchone()["cnt"] == 0:
        seed_plantation_data(cur)

    conn.commit()
    conn.close()


def seed_plantation_data(cur):
    # 1. Estates
    cur.execute(
        """
        INSERT INTO estates (code, name, crop_type, location_region, total_area_ha)
        VALUES ('EST-01', 'Seri Sawit Makmur Estate', 'Oil Palm (DxP Tenera)', 'Kluang, Johor (Malaysia Standard)', 1250.0)
        """
    )
    est1_id = cur.lastrowid

    cur.execute(
        """
        INSERT INTO estates (code, name, crop_type, location_region, total_area_ha)
        VALUES ('EST-02', 'Bagan Golden Coconut & Palm Estate', 'Coconut & Oil Palm Mixed', 'Bagan Datuk, Perak', 640.0)
        """
    )
    est2_id = cur.lastrowid

    # 2. Divisions
    cur.execute(
        "INSERT INTO divisions (estate_id, code, name, supervisor_name) VALUES (?, 'DIV-A', 'Division A (North Valley)', 'En. Zainal Abidin')",
        (est1_id,),
    )
    div_a_id = cur.lastrowid

    cur.execute(
        "INSERT INTO divisions (estate_id, code, name, supervisor_name) VALUES (?, 'DIV-B', 'Division B (South Terrace)', 'Mr. S. Kumar')",
        (est1_id,),
    )
    div_b_id = cur.lastrowid

    cur.execute(
        "INSERT INTO divisions (estate_id, code, name, supervisor_name) VALUES (?, 'DIV-C', 'Division C (Coastal Tall)', 'En. Hafizuddin')",
        (est2_id,),
    )
    div_c_id = cur.lastrowid

    # 3. Fields
    cur.execute(
        "INSERT INTO fields (division_id, code, name, planting_year, area_ha) VALUES (?, 'FLD-01', 'Field 01 - Mature Prime (2017)', 2017, 45.0)",
        (div_a_id,),
    )
    fld1_id = cur.lastrowid

    cur.execute(
        "INSERT INTO fields (division_id, code, name, planting_year, area_ha) VALUES (?, 'FLD-02', 'Field 02 - Gentle Slope (2019)', 2019, 38.5)",
        (div_a_id,),
    )
    fld2_id = cur.lastrowid

    cur.execute(
        "INSERT INTO fields (division_id, code, name, planting_year, area_ha) VALUES (?, 'FLD-03', 'Field 03 - Riverine Flat (2018)', 2018, 50.0)",
        (div_b_id,),
    )
    fld3_id = cur.lastrowid

    cur.execute(
        "INSERT INTO fields (division_id, code, name, planting_year, area_ha) VALUES (?, 'FLD-04', 'Field 04 - Matag Hybrid Sector', 2020, 30.0)",
        (div_c_id,),
    )
    fld4_id = cur.lastrowid

    # 4. Blocks
    cur.execute(
        "INSERT INTO blocks (field_id, code, name, palm_variety, area_ha, target_stands) VALUES (?, 'BLK-101', 'Block 101 (Main Harvesting Plot)', 'Yangambi DxP Tenera', 15.0, 20)",
        (fld1_id,),
    )
    blk101_id = cur.lastrowid

    cur.execute(
        "INSERT INTO blocks (field_id, code, name, palm_variety, area_ha, target_stands) VALUES (?, 'BLK-102', 'Block 102 (East Road Block)', 'Calix 600 DxP', 15.0, 15)",
        (fld1_id,),
    )
    blk102_id = cur.lastrowid

    cur.execute(
        "INSERT INTO blocks (field_id, code, name, palm_variety, area_ha, target_stands) VALUES (?, 'BLK-201', 'Block 201 (Hill Terrace A)', 'Yangambi DxP Tenera', 18.0, 12)",
        (fld2_id,),
    )
    blk201_id = cur.lastrowid

    cur.execute(
        "INSERT INTO blocks (field_id, code, name, palm_variety, area_ha, target_stands) VALUES (?, 'BLK-301', 'Block 301 (South Stream)', 'AVROS DxP', 20.0, 10)",
        (fld3_id,),
    )
    blk301_id = cur.lastrowid

    cur.execute(
        "INSERT INTO blocks (field_id, code, name, palm_variety, area_ha, target_stands) VALUES (?, 'BLK-401', 'Block 401 (Matag Coconut Block)', 'MATAG Hybrid Coconut', 12.0, 10)",
        (fld4_id,),
    )
    blk401_id = cur.lastrowid

    # 5. Seed Trees with realistic triangular plantation grid GPS coordinates (9m x 9m triangular spacing)
    today = date.today()
    ym = today.strftime("%Y-%m")

    def create_block_trees(block_id, count, base_lat, base_lng, plant_year, seed_harvest=True):
        weeds = ["Clean Circle", "Clean Circle", "Light Weeds", "Clean Circle", "Moderate Weeds"]
        ferts = ["NPK 12:12:17:2", "MOP (Muriate of Potash)", "NPK 15:15:6:4", "Kieserite + Boron"]
        for i in range(1, count + 1):
            row_no = ((i - 1) // 5) + 1
            col_no = (i - 1) % 5
            lat_offset = (row_no - 1) * 0.000075
            lng_offset = col_no * 0.000085 + (0.000042 if row_no % 2 == 0 else 0.0)
            lat = round(base_lat + lat_offset, 6)
            lng = round(base_lng + lng_offset, 6)
            tree_code = f"T-{i:03d}"
            weed = weeds[(i - 1) % len(weeds)]
            fert = ferts[(i - 1) % len(ferts)]

            cur.execute(
                """
                INSERT INTO trees (
                    block_id, tree_number, tree_code, row_number,
                    latitude, longitude, planting_year, health_status,
                    weed_status, last_fertilizer_type, last_fertilizer_kg, last_fertilizer_date, notes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    block_id,
                    i,
                    tree_code,
                    row_no,
                    lat,
                    lng,
                    plant_year,
                    "Healthy" if i % 11 != 0 else "Nutrient Deficiency (Mg)",
                    weed,
                    fert,
                    2.5,
                    f"{ym}-02",
                    f"Row {row_no}, Palm #{i} - Standard triangular spacing",
                ),
            )
            tree_id = cur.lastrowid

            if seed_harvest:
                # Round 1 (Days 1-10): e.g., Day 04
                r1_bunches = (i % 3) + 1
                r1_fronds = r1_bunches + 1
                cur.execute(
                    """
                    INSERT INTO harvest_logs (
                        tree_id, block_id, harvest_date, year_month, day_of_month, round_number,
                        bunches_cut, fronds_cut, bunch_weight_kg, loose_fruits_count,
                        weed_growth, fertilizer_type, fertilizer_kg, pruning_status, pest_disease,
                        custom_data_json, latitude, longitude, recorded_by_id, recorded_by_name, remarks
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        tree_id,
                        block_id,
                        f"{ym}-04",
                        ym,
                        4,
                        1,
                        r1_bunches,
                        r1_fronds,
                        round(r1_bunches * 18.5, 1),
                        r1_bunches * 12,
                        weed,
                        fert if i <= 10 else "None",
                        2.5 if i <= 10 else 0.0,
                        "Standard Stacked",
                        "Healthy",
                        json.dumps({"circle_raking": "Done", "soil_moisture": "Optimal"}),
                        lat,
                        lng,
                        2,
                        "S. Kumar (Field Conductor)",
                        "Round 1 harvest & frond stacking completed",
                    ),
                )

                # Round 2 (Days 11-20): e.g., Day 14 (first 16 trees)
                if i <= 16:
                    r2_bunches = ((i + 1) % 3) + 1
                    r2_fronds = r2_bunches + (1 if i % 2 == 0 else 2)
                    cur.execute(
                        """
                        INSERT INTO harvest_logs (
                            tree_id, block_id, harvest_date, year_month, day_of_month, round_number,
                            bunches_cut, fronds_cut, bunch_weight_kg, loose_fruits_count,
                            weed_growth, fertilizer_type, fertilizer_kg, pruning_status, pest_disease,
                            custom_data_json, latitude, longitude, recorded_by_id, recorded_by_name, remarks
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            tree_id,
                            block_id,
                            f"{ym}-14",
                            ym,
                            14,
                            2,
                            r2_bunches,
                            r2_fronds,
                            round(r2_bunches * 19.2, 1),
                            r2_bunches * 10,
                            weed,
                            "None",
                            0.0,
                            "Standard Stacked",
                            "Healthy",
                            json.dumps({"circle_raking": "Done", "soil_moisture": "Moist"}),
                            lat,
                            lng,
                            3,
                            "Mohd Faizal (Harvesting Team Lead)",
                            "Round 2 cycle cut",
                        ),
                    )

                # Round 3 (Days 21-End): e.g., Day 24 (first 10 trees)
                if i <= 10:
                    r3_bunches = (i % 2) + 1
                    r3_fronds = r3_bunches + 1
                    cur.execute(
                        """
                        INSERT INTO harvest_logs (
                            tree_id, block_id, harvest_date, year_month, day_of_month, round_number,
                            bunches_cut, fronds_cut, bunch_weight_kg, loose_fruits_count,
                            weed_growth, fertilizer_type, fertilizer_kg, pruning_status, pest_disease,
                            custom_data_json, latitude, longitude, recorded_by_id, recorded_by_name, remarks
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            tree_id,
                            block_id,
                            f"{ym}-24",
                            ym,
                            24,
                            3,
                            r3_bunches,
                            r3_fronds,
                            round(r3_bunches * 18.0, 1),
                            r3_bunches * 8,
                            weed,
                            "Borate (High Grade)" if i % 4 == 0 else "None",
                            0.15 if i % 4 == 0 else 0.0,
                            "Standard Stacked",
                            "Healthy",
                            json.dumps({"circle_raking": "Done", "soil_moisture": "Optimal"}),
                            lat,
                            lng,
                            3,
                            "Mohd Faizal (Harvesting Team Lead)",
                            "Round 3 end-of-month harvesting cycle",
                        ),
                    )

    create_block_trees(blk101_id, 20, 2.032500, 103.318500, 2017, seed_harvest=True)
    create_block_trees(blk102_id, 15, 2.033200, 103.319500, 2017, seed_harvest=True)
    create_block_trees(blk201_id, 12, 2.034100, 103.317800, 2019, seed_harvest=False)
    create_block_trees(blk301_id, 10, 2.029800, 103.321000, 2018, seed_harvest=False)
    create_block_trees(blk401_id, 10, 3.989200, 100.785400, 2020, seed_harvest=True)

