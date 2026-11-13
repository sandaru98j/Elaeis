# Elaeis — Palm Basis Crop Monitoring System

**Elaeis** is a web-based plantation crop & harvesting monitoring system modeled on Malaysian oil palm (*Elaeis guineensis*) and coconut estate standards.

## Plantation Hierarchy
`Estate -> Division -> Field -> Block -> Geo-Tagged Palm Tree`

## Key Features
- **Rapid Tree-by-Tree Harvesting & Upkeep Logger**: Enter a Tree Number to auto-detect Date, Month (`YYYY-MM`), and Monthly Harvesting Round (`Round 1: Days 1–10`, `Round 2: Days 11–20`, `Round 3: Days 21–End`), load exact GPS coordinates, record Bunches Cut & Fronds Cut, and automatically advance to `Tree N + 1`.
- **3-Round Monthly Block Matrix & GIS Map**: Interactive HTML5 Canvas geo-location map of every palm in a block + tree-by-tree 3-round summary report + CSV/Excel export.
- **Extensible Palm Upkeep Tracking**: Record Weed Growth around the palm circle, Fertilizer Type & Amount (kg), Frond Stacking standard, Pest/Disease status, plus dynamic custom monitoring fields.
- **Authentication & Role Management**: Sign in with **Username**, **Email**, or **Phone Number**, with Forgot Password OTP recovery and role assignment (`Admin`, `Supervisor`, `Harvester`).

## Running Locally
```bash
python server.py
```
Runs at `http://127.0.0.1:8080` with SQLite database `elaeis.db`.

## Deploying on Cloudflare Pages + Cloudflare D1 (Free)
1. Connect https://github.com/sandaru98j/Elaeis to **Cloudflare Pages**.
2. Set **Build output directory** to `static`.
3. Create a Cloudflare D1 database named `elaeis-db` and bind it to your Pages project under **Settings → Bindings → D1 Database** with variable name `DB`.
