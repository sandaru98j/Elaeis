# Elaeis — Uskvalley Estate Corporate ERP

**Elaeis** is a closed corporate Enterprise Resource Planning (ERP) and precision field telemetry system engineered exclusively for **Uskvalley Estate, Baduraliya**. Designed around oil palm (*Elaeis guineensis*) plantation management standards, Elaeis tracks 10-day harvesting rounds, tree-by-tree yield telemetry, mill dispatch crop weights, and live GPS compliance across a 5-tier plantation hierarchy.

---

## 5-Tier Plantation Hierarchy

```text
Uskvalley Estate
 └── Division (Uskvalley / Trafalgar / Morawaka)
      └── Field (Planting Year & Extent in Hectares)
           └── Block (Boundary Definition & Target Stands)
                └── Geo-Tagged Palm Tree (Palm #1 .. #N with Latitude/Longitude)
```

---

## Key Features

### 1. Closed Corporate Authentication & Strict Role Hierarchy
- **Strict Username & Password Authentication:** Public sign-ups, email logins, and phone/OTP recovery flows are disabled. Access is strictly restricted to provisioned corporate accounts using `@username` and password credentials.
- **4-Tier Role-Based Access Control (RBAC):**
  ```text
  Master Admin > Admin > Supervisor > Harvester
  ```
  - **Master Admin (`@sandaru98j`):** Full system authority, 5-tier estate configuration, user provisioning, role assignment, and direct **Force Password Reset** across all corporate accounts without requiring the user's previous password.
  - **Admin (Estate Manager):** Full access to Analytics, 5-Tier Estate CRUD, GPS Tree Mapper, GPS Compliance Audits, and Corporate Directory management.
  - **Supervisor:** Field & division supervision, harvesting round oversight, and mill dispatch crop weight management.
  - **Harvester:** Streamlined mobile access to the 2D Palm Harvest Logger, Mill Dispatch logging, personal Profile security, and UI Theme settings.
- **Standard Profile Security:** Users can securely update their own credentials at any time via the masked **Change Password** workflow (`Current Password`, `New Password`, `Confirm New Password`) on the `/profile` page.

### 2. Mobile-Responsive Twitter/X-Style 3-Column UI
- **Adaptive 3-Column Shell:** Inspired by the high-contrast Twitter/X desktop layout—featuring a persistent left navigation rail, a wide center telemetry feed, and a live right-hand estate pulse sidebar.
- **Mobile & Android WebView Optimized:** Built with strict viewport containment (`max-w-full`, `box-border`, `minmax(0, 1fr)` grid tracks, and horizontal scroll wrappers `overflow-x-auto` on data tables) to eliminate horizontal bleed or cut-offs on small screens.
- **Dual Mobile Navigation (`< 768px`):** Automatically collapses the desktop sidebar into both a top **Hamburger Slide-Over Drawer** and a fixed **Bottom Navigation Bar** on mobile devices.
- **Structured Card Detail Views:** Replaces raw data dumps with clean, padded (`p-4` / `p-6`) CSS Grid and Flexbox cards, complete with an interactive **Record Detail Modal** for inspecting individual harvest logs and GPS compliance audits.

### 3. 4-Theme CSS Custom Property Engine (`/settings`)
Accessible from the navigation menu at `/settings`, the built-in theme engine dynamically toggles `data-theme` on the document root and swaps CSS custom properties in real time, persisting the user's preference in both `localStorage` and their corporate database profile:
1. **Twitter / X (Default):** Crisp white background (`#ffffff`), stark ink typography (`#0f1419`), and signature Twitter Blue (`#1d9bf0`) & Emerald (`#00ba7c`) accents.
2. **Dracula Dark:** Deep purple-slate background (`#282a36`), vibrant purple/pink accents (`#bd93f9` / `#ff79c6`), and high-contrast light text (`#f8f8f2`).
3. **Dracula Light:** High-contrast daytime Alucard variant with warm alabaster surfaces (`#faf8f5`) and sharp royal purple accents (`#7c3aed`).
4. **Nord:** Arctic, north-bluish palette featuring Polar Night slate backgrounds (`#2e3440` / `#3b4252`) and Frosty Blue accents (`#88c0d0`).

### 4. Precision Harvesting, Mill Dispatch & Yield Analytics
- **10-Day Harvesting Rounds:** Automatically classifies operations into **Round 1** (Days 1–10), **Round 2** (Days 11–20), and **Round 3** (Days 21–End of Month).
- **5 Core Estate KPIs:** Real-time computation of **Total Bunches Cut**, **Total Fronds Cut**, **Dispatched Crop Weight (kg)**, **Average Bunch Weight (ABW)**, and **Yield Per Hectare (YPH)** with cascading filters and one-click CSV/PDF export.
- **Silent GPS Compliance Auditing:** Captures device coordinates during palm harvesting and flags logs exceeding the configurable distance threshold (default `20m`) from the registered palm location.

---

## Running Locally

```bash
python server.py
```

The ERP server initializes `elaeis.db` (SQLite) automatically and listens at `http://127.0.0.1:8080`.

## Deploying on Cloudflare Pages + Cloudflare D1

1. Connect the repository to **Cloudflare Pages** with the build output directory set to `static`.
2. Bind a Cloudflare D1 database named `elaeis-db` under **Settings → Bindings → D1 Database** with the variable name `DB`.
