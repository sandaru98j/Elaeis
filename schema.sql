-- Corporate ERP Schema for Elaeis (Palm-based Crop Monitoring System)
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
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS estates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    crop_type TEXT NOT NULL DEFAULT 'Oil Palm (Elaeis guineensis)',
    location_region TEXT DEFAULT '',
    total_area_ha REAL DEFAULT 0.0,
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
    planting_year INTEGER DEFAULT 2015,
    area_ha REAL DEFAULT 10.0,
    UNIQUE(division_id, code)
);

CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    field_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    boundary_note TEXT DEFAULT '',
    palm_variety TEXT DEFAULT 'DxP Tenera',
    area_ha REAL DEFAULT 5.0,
    target_stands INTEGER DEFAULT 285,
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
    planting_year INTEGER DEFAULT 2015,
    status TEXT DEFAULT 'active',
    health_status TEXT DEFAULT 'Healthy',
    mapped_by INTEGER,
    mapped_at TEXT,
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
    latitude REAL,
    longitude REAL,
    gps_acc REAL DEFAULT 4.2,
    health_status TEXT DEFAULT 'Healthy',
    loose_fruit INTEGER DEFAULT 1,
    recorded_by_id INTEGER,
    recorded_by_name TEXT DEFAULT 'System',
    remarks TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tree_id, year_month, round_number)
);

CREATE TABLE IF NOT EXISTS dispatch_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    division_id INTEGER NOT NULL,
    dispatch_date TEXT NOT NULL,
    year_month TEXT NOT NULL,
    round_number INTEGER NOT NULL,
    weight_kg REAL NOT NULL,
    client_id TEXT,
    recorded_by_id INTEGER,
    recorded_by_name TEXT DEFAULT 'System',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_client_id ON dispatch_logs (client_id) WHERE client_id IS NOT NULL;
