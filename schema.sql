-- Cloudflare D1 (SQLite) Schema for Palm Basis Crop Monitoring System
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
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
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
    UNIQUE(estate_id, code)
);

CREATE TABLE IF NOT EXISTS fields (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    division_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    planting_year INTEGER DEFAULT 2018,
    area_ha REAL DEFAULT 25.0,
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
    UNIQUE(block_id, tree_number)
);

CREATE TABLE IF NOT EXISTS harvest_logs (
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
    recorded_by_id INTEGER,
    recorded_by_name TEXT DEFAULT 'System',
    remarks TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
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
