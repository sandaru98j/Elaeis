import os
import math
import json
import csv
import io
import secrets
from datetime import datetime, date
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

from database import (
    init_db,
    get_connection,
    hash_password,
    verify_password,
    compute_harvest_round,
    ROLE_RANK,
)

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")


def normalize_role(role_str: str) -> str:
    r = str(role_str or "").strip().lower()
    if r in ("master admin", "master_admin", "master"):
        return "Master Admin"
    if r == "admin":
        return "Admin"
    if r == "supervisor":
        return "Supervisor"
    return "Harvester"


def role_rank(role_str: str) -> int:
    return ROLE_RANK.get(normalize_role(role_str), 1)


def distance_m(lat1, lng1, lat2, lng2):
    if None in (lat1, lng1, lat2, lng2):
        return None
    r = 6371000.0
    p1 = math.radians(float(lat1))
    p2 = math.radians(float(lat2))
    dp = math.radians(float(lat2) - float(lat1))
    dl = math.radians(float(lng2) - float(lng1))
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return round(2 * r * math.asin(math.sqrt(a)), 1)


def format_user(row) -> dict:
    d = dict(row)
    role = normalize_role(d.get("role"))
    is_master = bool(d.get("is_master")) or d.get("username", "").lower() == "sandaru98j" or role == "Master Admin"
    if is_master:
        role = "Master Admin"
    return {
        "id": d["id"],
        "username": d["username"],
        "email": d.get("email") or "",
        "phone": d.get("phone") or "",
        "full_name": d["full_name"],
        "role": role,
        "is_master": is_master,
        "theme": d.get("theme") or "twitter",
        "assigned_estate_id": d.get("assigned_estate_id") or 1,
        "created_at": d.get("created_at"),
    }


class ElaeisErpHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send_json(self, data, status=200):
        body = json.dumps(data, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _send_csv(self, csv_text: str, filename: str):
        body = csv_text.encode("utf-8-sig")
        self.send_response(200)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        try:
            return json.loads(raw)
        except Exception:
            return {}

    def _get_current_user(self, conn):
        auth = self.headers.get("Authorization", "")
        token = auth[7:].strip() if auth.startswith("Bearer ") else ""
        if not token:
            return None
        cur = conn.cursor()
        cur.execute(
            """
            SELECT u.*
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token = ?
            """,
            (token,),
        )
        row = cur.fetchone()
        if not row:
            return None
        u = format_user(row)
        u["token"] = token
        return u

    def _require_role(self, conn, min_role="Harvester"):
        user = self._get_current_user(conn)
        if not user:
            self._send_json({"error": "Authentication required. Please log in."}, status=401)
            return None
        if role_rank(user["role"]) < role_rank(min_role):
            self._send_json({"error": "Insufficient role permissions."}, status=403)
            return None
        return user

    def do_OPTIONS(self):
        self._send_json({"ok": True})

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = {k: v[0] for k, v in parse_qs(parsed.query).items()}

        if path.startswith("/api/"):
            conn = get_connection()
            try:
                self.handle_api_get(path, params, conn)
            except Exception as e:
                self._send_json({"error": str(e)}, status=500)
            finally:
                conn.close()
            return

        if path in ("/", ""):
            path = "/index.html"
        file_path = os.path.normpath(os.path.join(STATIC_DIR, path.lstrip("/")))
        if not file_path.startswith(STATIC_DIR) or not os.path.isfile(file_path):
            file_path = os.path.join(STATIC_DIR, "index.html")

        ext = os.path.splitext(file_path)[1].lower()
        mime_map = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
        }
        with open(file_path, "rb") as f:
            content = f.read()
        self.send_response(200)
        self.send_header("Content-Type", mime_map.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        data = self._read_json()

        if path.startswith("/api/"):
            conn = get_connection()
            try:
                self.handle_api_post(path, data, conn)
            except Exception as e:
                self._send_json({"error": str(e)}, status=500)
            finally:
                conn.close()
            return

        self._send_json({"error": "Not found"}, status=404)

    # -------------------------------------------------------------------------
    # GET API ROUTES
    # -------------------------------------------------------------------------
    def handle_api_get(self, path, params, conn):
        cur = conn.cursor()

        if path == "/api/auth/me":
            user = self._get_current_user(conn)
            if not user:
                return self._send_json({"error": "Not authenticated"}, status=401)
            return self._send_json({"user": user})

        if path in ("/api/bootstrap", "/api/hierarchy"):
            user = self._require_role(conn, "Harvester")
            if not user:
                return

            cur.execute("SELECT id, code, name, crop_type, location_region, total_area_ha FROM estates ORDER BY id")
            estates = [dict(r) for r in cur.fetchall()]

            cur.execute("SELECT id, estate_id, code, name, supervisor_name FROM divisions ORDER BY id")
            divisions = [dict(r) for r in cur.fetchall()]

            cur.execute("SELECT id, division_id, code, name, planting_year, area_ha FROM fields ORDER BY planting_year, id")
            fields = [dict(r) for r in cur.fetchall()]

            cur.execute(
                """
                SELECT b.id, b.field_id, b.code, b.name, b.boundary_note,
                       COUNT(t.id) AS tree_total,
                       SUM(CASE WHEN t.status = 'active' THEN 1 ELSE 0 END) AS tree_active,
                       SUM(CASE WHEN t.latitude IS NOT NULL THEN 1 ELSE 0 END) AS tree_mapped
                FROM blocks b
                LEFT JOIN trees t ON t.block_id = b.id
                GROUP BY b.id
                ORDER BY b.id
                """
            )
            blocks = [
                {
                    **dict(r),
                    "tree_total": r["tree_total"] or 0,
                    "tree_active": r["tree_active"] or 0,
                    "tree_mapped": r["tree_mapped"] or 0,
                }
                for r in cur.fetchall()
            ]

            cur.execute("SELECT key, value FROM settings")
            s_map = {r["key"]: r["value"] for r in cur.fetchall()}
            settings = {
                "gps_threshold_m": int(s_map.get("gps_threshold_m", 20)),
                "season_start_month": int(s_map.get("season_start_month", 4)),
            }

            return self._send_json(
                {
                    "hierarchy": {
                        "estates": estates,
                        "divisions": divisions,
                        "fields": fields,
                        "blocks": blocks,
                    },
                    "settings": settings,
                }
            )

        if path == "/api/block":
            user = self._require_role(conn, "Harvester")
            if not user:
                return
            block_id = int(params.get("block_id") or 1)
            mode = params.get("mode", "map")
            date_str = params.get("date") or date.today().strftime("%Y-%m-%d")
            explicit_round = int(params["round_no"]) if params.get("round_no") else None
            r_info = compute_harvest_round(date_str, explicit_round)

            cur.execute(
                """
                SELECT id, block_id, tree_number AS tree_no, latitude AS lat, longitude AS lng,
                       gps_acc, status, mapped_at
                FROM trees
                WHERE block_id = ?
                ORDER BY tree_number ASC
                """,
                (block_id,),
            )
            trees = [dict(r) for r in cur.fetchall()]

            rec_map = {}
            if mode == "harvest":
                cur.execute(
                    """
                    SELECT tree_id, bunches_cut AS bunches, fronds_cut AS fronds,
                           harvest_date, round_number AS round_no
                    FROM harvest_logs
                    WHERE block_id = ? AND year_month = ? AND round_number = ?
                    """,
                    (block_id, r_info["year_month"], r_info["round_number"]),
                )
                for r in cur.fetchall():
                    rec_map[r["tree_id"]] = dict(r)

            return self._send_json(
                {
                    "block_id": block_id,
                    "date": date_str,
                    "trees": [{**t, "rec": rec_map.get(t["id"])} for t in trees],
                }
            )

        if path == "/api/dispatch":
            user = self._require_role(conn, "Harvester")
            if not user:
                return
            cur.execute(
                """
                SELECT d.id, d.division_id, d.dispatch_date, d.year_month,
                       d.round_number AS round_no, d.weight_kg,
                       d.recorded_by_name AS recorded_by, d.created_at AS recorded_at,
                       dv.name AS division_name
                FROM dispatch_logs d
                JOIN divisions dv ON dv.id = d.division_id
                ORDER BY d.dispatch_date DESC, d.id DESC
                LIMIT 200
                """
            )
            return self._send_json({"dispatches": [dict(r) for r in cur.fetchall()]})

        if path in ("/api/report", "/api/report.csv"):
            user = self._require_role(conn, "Harvester")
            if not user:
                return
            from_d = params.get("from") or "1900-01-01"
            to_d = params.get("to") or "2999-12-31"
            round_no = int(params["round_no"]) if params.get("round_no") else None
            estate_id = int(params["estate_id"]) if params.get("estate_id") else None
            division_id = int(params["division_id"]) if params.get("division_id") else None
            field_id = int(params["field_id"]) if params.get("field_id") else None
            block_id = int(params["block_id"]) if params.get("block_id") else None
            tree_id = int(params["tree_id"]) if params.get("tree_id") else None

            # Calculate active Hectare extent & target division
            target_div_id = division_id
            total_ha = 0.0
            if field_id:
                cur.execute("SELECT area_ha, division_id FROM fields WHERE id = ?", (field_id,))
                f_row = cur.fetchone()
                if f_row:
                    total_ha = float(f_row["area_ha"])
                    if not target_div_id:
                        target_div_id = f_row["division_id"]
            elif block_id:
                cur.execute(
                    "SELECT f.area_ha, f.division_id FROM blocks b JOIN fields f ON f.id = b.field_id WHERE b.id = ?",
                    (block_id,),
                )
                f_row = cur.fetchone()
                if f_row:
                    total_ha = float(f_row["area_ha"])
                    if not target_div_id:
                        target_div_id = f_row["division_id"]
            elif tree_id:
                cur.execute(
                    """
                    SELECT f.area_ha, f.division_id
                    FROM trees t
                    JOIN blocks b ON b.id = t.block_id
                    JOIN fields f ON f.id = b.field_id
                    WHERE t.id = ?
                    """,
                    (tree_id,),
                )
                f_row = cur.fetchone()
                if f_row:
                    total_ha = float(f_row["area_ha"])
                    if not target_div_id:
                        target_div_id = f_row["division_id"]
            elif target_div_id:
                cur.execute("SELECT COALESCE(SUM(area_ha), 0) AS ha FROM fields WHERE division_id = ?", (target_div_id,))
                total_ha = float(cur.fetchone()["ha"] or 0.0)
            else:
                cur.execute("SELECT COALESCE(SUM(area_ha), 0) AS ha FROM fields")
                total_ha = float(cur.fetchone()["ha"] or 0.0)

            where_h = ["h.harvest_date >= ?", "h.harvest_date <= ?"]
            args_h = [from_d, to_d]
            if round_no in (1, 2, 3):
                where_h.append("h.round_number = ?")
                args_h.append(round_no)
            if estate_id:
                where_h.append("d.estate_id = ?")
                args_h.append(estate_id)
            if division_id:
                where_h.append("d.id = ?")
                args_h.append(division_id)
            if field_id:
                where_h.append("f.id = ?")
                args_h.append(field_id)
            if block_id:
                where_h.append("b.id = ?")
                args_h.append(block_id)
            if tree_id:
                where_h.append("t.id = ?")
                args_h.append(tree_id)

            where_sql = " AND ".join(where_h)
            cur.execute(
                f"""
                SELECT COALESCE(SUM(h.bunches_cut), 0) AS bunches,
                       COALESCE(SUM(h.fronds_cut), 0) AS fronds,
                       COUNT(h.id) AS records,
                       COUNT(DISTINCT h.tree_id) AS trees
                FROM harvest_logs h
                JOIN trees t ON t.id = h.tree_id
                JOIN blocks b ON b.id = t.block_id
                JOIN fields f ON f.id = b.field_id
                JOIN divisions d ON d.id = f.division_id
                WHERE {where_sql}
                """,
                args_h,
            )
            h_tot = dict(cur.fetchone())

            where_d = ["dispatch_date >= ?", "dispatch_date <= ?"]
            args_d = [from_d, to_d]
            if round_no in (1, 2, 3):
                where_d.append("round_number = ?")
                args_d.append(round_no)
            if target_div_id:
                where_d.append("division_id = ?")
                args_d.append(target_div_id)

            cur.execute(
                f"""
                SELECT COALESCE(SUM(weight_kg), 0) AS dispatch_kg,
                       COUNT(id) AS dispatch_records
                FROM dispatch_logs
                WHERE {' AND '.join(where_d)}
                """,
                args_d,
            )
            d_tot = dict(cur.fetchone())

            bunches = int(h_tot["bunches"] or 0)
            fronds = int(h_tot["fronds"] or 0)
            dispatch_kg = float(d_tot["dispatch_kg"] or 0.0)
            abw = round(dispatch_kg / bunches, 2) if bunches > 0 else 0.0
            yph = round(dispatch_kg / total_ha, 2) if total_ha > 0 else 0.0

            cur.execute(
                f"""
                SELECT h.id, h.harvest_date, h.round_number AS round_no,
                       h.bunches_cut AS bunches, h.fronds_cut AS fronds,
                       h.recorded_by_name AS recorded_by,
                       t.tree_number AS tree_no, b.name AS block_name,
                       f.name AS field_name, d.name AS division_name
                FROM harvest_logs h
                JOIN trees t ON t.id = h.tree_id
                JOIN blocks b ON b.id = t.block_id
                JOIN fields f ON f.id = b.field_id
                JOIN divisions d ON d.id = f.division_id
                WHERE {where_sql}
                ORDER BY h.harvest_date DESC, h.id DESC
                LIMIT 15
                """,
                args_h,
            )
            recent_logs = [dict(r) for r in cur.fetchall()]

            if path == "/api/report.csv":
                out = io.StringIO()
                writer = csv.writer(out)
                writer.writerow(
                    [
                        "Period From",
                        "Period To",
                        "Total Bunches Cut",
                        "Total Fronds Cut",
                        "Dispatched Weight (kg)",
                        "Extent (Ha)",
                        "ABW (kg/bunch)",
                        "YPH (kg/Ha)",
                    ]
                )
                writer.writerow([from_d, to_d, bunches, fronds, dispatch_kg, total_ha, abw, yph])
                return self._send_csv(out.getvalue(), f"elaes_erp_report_{date.today().isoformat()}.csv")

            return self._send_json(
                {
                    "from": from_d,
                    "to": to_d,
                    "totals": {
                        "bunches": bunches,
                        "fronds": fronds,
                        "records": int(h_tot["records"] or 0),
                        "trees": int(h_tot["trees"] or 0),
                        "dispatch_kg": dispatch_kg,
                        "dispatch_records": int(d_tot["dispatch_records"] or 0),
                        "area_ha": total_ha,
                        "abw": abw,
                        "yph": yph,
                    },
                    "recent_logs": recent_logs,
                }
            )

        if path in ("/api/admin/users", "/api/users"):
            user = self._require_role(conn, "Admin")
            if not user:
                return
            cur.execute("SELECT * FROM users ORDER BY is_master DESC, id ASC")
            users = [format_user(r) for r in cur.fetchall()]
            return self._send_json({"users": users})

        if path == "/api/admin/compliance":
            user = self._require_role(conn, "Admin")
            if not user:
                return
            cur.execute("SELECT value FROM settings WHERE key = 'gps_threshold_m'")
            r_th = cur.fetchone()
            threshold_m = float(r_th["value"]) if r_th else 20.0

            cur.execute(
                """
                SELECT h.id, h.harvest_date AS work_date, h.created_at AS recorded_at,
                       h.latitude AS user_lat, h.longitude AS user_lng, h.gps_acc AS user_acc,
                       h.bunches_cut, h.fronds_cut, h.round_number,
                       h.recorded_by_name AS full_name,
                       t.tree_number AS tree_no, t.latitude AS tree_lat, t.longitude AS tree_lng,
                       b.name AS block, f.name AS field, d.name AS division
                FROM harvest_logs h
                JOIN trees t ON t.id = h.tree_id
                JOIN blocks b ON b.id = t.block_id
                JOIN fields f ON f.id = b.field_id
                JOIN divisions d ON d.id = f.division_id
                ORDER BY h.id DESC
                LIMIT 200
                """
            )
            rows = []
            for r in cur.fetchall():
                dist = distance_m(r["tree_lat"], r["tree_lng"], r["user_lat"], r["user_lng"])
                if r["user_lat"] is None:
                    status = "no_gps"
                elif r["tree_lat"] is None:
                    status = "unmapped"
                else:
                    status = "far" if dist > threshold_m else "ok"
                rows.append(
                    {
                        "id": r["id"],
                        "work_date": r["work_date"],
                        "recorded_at": r["recorded_at"],
                        "user_lat": r["user_lat"],
                        "user_lng": r["user_lng"],
                        "user_acc": r["user_acc"],
                        "full_name": r["full_name"],
                        "tree_no": r["tree_no"],
                        "tree_lat": r["tree_lat"],
                        "tree_lng": r["tree_lng"],
                        "block": r["block"],
                        "field": r["field"],
                        "division": r["division"],
                        "detail": f"{r['bunches_cut']} Bunches / {r['fronds_cut']} Fronds (R{r['round_number']})",
                        "distance_m": dist,
                        "status": status,
                    }
                )
            return self._send_json({"threshold_m": threshold_m, "rows": rows})

        return self._send_json({"error": f"Unknown endpoint {path}"}, status=404)

    # -------------------------------------------------------------------------
    # POST API ROUTES
    # -------------------------------------------------------------------------
    def handle_api_post(self, path, data, conn):
        cur = conn.cursor()

        # 1. ERP Login (Username + Password ONLY)
        if path == "/api/auth/login":
            username = str(data.get("username") or data.get("identifier") or "").strip()
            password = str(data.get("password") or "")
            if not username or not password:
                return self._send_json({"error": "Enter your Username and Password."}, status=400)

            cur.execute("SELECT * FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1", (username,))
            user_row = cur.fetchone()
            if not user_row or not verify_password(password, user_row["password_hash"]):
                return self._send_json({"error": "Invalid username or password."}, status=401)

            token = secrets.token_hex(24)
            cur.execute("INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, user_row["id"]))
            conn.commit()
            return self._send_json({"token": token, "user": format_user(user_row)})

        # 2. Logout
        if path == "/api/auth/logout":
            user = self._get_current_user(conn)
            if user and user.get("token"):
                cur.execute("DELETE FROM sessions WHERE token = ?", (user["token"],))
                conn.commit()
            return self._send_json({"ok": True})

        # 3. Profile Password Update (Logged-in user updates their own password)
        if path == "/api/auth/change-password":
            user = self._require_role(conn, "Harvester")
            if not user:
                return
            current_pw = str(data.get("current_password") or "")
            new_pw = str(data.get("new_password") or "")
            if len(new_pw) < 6:
                return self._send_json({"error": "New password must be at least 6 characters."}, status=400)

            cur.execute("SELECT password_hash FROM users WHERE id = ?", (user["id"],))
            row = cur.fetchone()
            if not row or not verify_password(current_pw, row["password_hash"]):
                return self._send_json({"error": "Current password is incorrect."}, status=400)

            cur.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(new_pw), user["id"]))
            conn.commit()
            return self._send_json({"ok": True, "message": "Password updated successfully."})

        # 3b. User UI Theme Persistence (/settings Theme Engine)
        if path == "/api/settings/theme":
            user = self._require_role(conn, "Harvester")
            if not user:
                return
            theme = str(data.get("theme") or "twitter").strip().lower()
            if theme not in ("twitter", "dracula-dark", "dracula-light", "nord"):
                theme = "twitter"
            cur.execute("UPDATE users SET theme = ? WHERE id = ?", (theme, user["id"]))
            conn.commit()
            return self._send_json({"ok": True, "theme": theme})

        # 4. Log Tree Harvest
        if path == "/api/harvest":
            user = self._require_role(conn, "Harvester")
            if not user:
                return
            tree_id = int(data.get("tree_id") or 0)
            date_str = str(data.get("date") or date.today().strftime("%Y-%m-%d"))
            round_no = int(data.get("round_no") or compute_harvest_round(date_str)["round_number"])
            bunches = max(0, int(data.get("bunches") or 0))
            fronds = max(0, int(data.get("fronds") or 0))
            lat = data.get("lat")
            lng = data.get("lng")
            acc = data.get("acc")

            cur.execute("SELECT * FROM trees WHERE id = ?", (tree_id,))
            tree = cur.fetchone()
            if not tree:
                return self._send_json({"error": "Palm tree not found."}, status=404)

            r_info = compute_harvest_round(date_str, round_no)
            cur.execute(
                """
                INSERT INTO harvest_logs (
                    tree_id, block_id, harvest_date, year_month, day_of_month, round_number,
                    bunches_cut, fronds_cut, bunch_weight_kg, latitude, longitude, gps_acc,
                    recorded_by_id, recorded_by_name
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(tree_id, year_month, round_number) DO UPDATE SET
                    harvest_date = excluded.harvest_date,
                    day_of_month = excluded.day_of_month,
                    bunches_cut = excluded.bunches_cut,
                    fronds_cut = excluded.fronds_cut,
                    bunch_weight_kg = excluded.bunch_weight_kg,
                    latitude = excluded.latitude,
                    longitude = excluded.longitude,
                    gps_acc = excluded.gps_acc,
                    recorded_by_id = excluded.recorded_by_id,
                    recorded_by_name = excluded.recorded_by_name
                """,
                (
                    tree_id,
                    tree["block_id"],
                    r_info["date"],
                    r_info["year_month"],
                    r_info["day_of_month"],
                    r_info["round_number"],
                    bunches,
                    fronds,
                    round(bunches * 18.5, 1),
                    lat,
                    lng,
                    acc,
                    user["id"],
                    user["full_name"],
                ),
            )
            conn.commit()
            dist = distance_m(tree["latitude"], tree["longitude"], lat, lng)
            return self._send_json({"ok": True, "round": r_info["round_number"], "distance_m": dist})

        # 5. Mill Dispatch Weight Logging
        if path == "/api/dispatch":
            user = self._require_role(conn, "Harvester")
            if not user:
                return
            division_id = int(data.get("division_id") or 1)
            date_str = str(data.get("date") or date.today().strftime("%Y-%m-%d"))
            round_no = int(data.get("round_no") or compute_harvest_round(date_str)["round_number"])
            weight_kg = float(data.get("weight_kg") or 0.0)
            if weight_kg <= 0:
                return self._send_json({"error": "Enter a valid dispatch weight in kg."}, status=400)

            cur.execute(
                """
                INSERT INTO dispatch_logs (
                    division_id, dispatch_date, year_month, round_number, weight_kg, recorded_by_id, recorded_by_name
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (division_id, date_str, date_str[:7], round_no, weight_kg, user["id"], user["full_name"]),
            )
            conn.commit()
            return self._send_json({"ok": True})

        if path == "/api/dispatch/delete":
            user = self._require_role(conn, "Supervisor")
            if not user:
                return
            cur.execute("DELETE FROM dispatch_logs WHERE id = ?", (int(data.get("id") or 0),))
            conn.commit()
            return self._send_json({"ok": True})

        # 6. Directory (Admin & Master Admin User Management)
        if path == "/api/admin/users/create":
            user = self._require_role(conn, "Admin")
            if not user:
                return
            username = str(data.get("username") or "").strip().lower()
            full_name = str(data.get("full_name") or "").strip()
            role = normalize_role(data.get("role") or "Harvester")
            password = str(data.get("password") or "Uskvalley2026!")

            if not username or not full_name:
                return self._send_json({"error": "Username and Full Name are required."}, status=400)
            if role == "Master Admin" and not user["is_master"]:
                return self._send_json({"error": "Only the Master Admin can assign Master Admin role."}, status=403)

            cur.execute("SELECT id FROM users WHERE LOWER(username) = ?", (username,))
            if cur.fetchone():
                return self._send_json({"error": f"Username '@{username}' already exists."}, status=409)

            cur.execute(
                """
                INSERT INTO users (username, email, phone, full_name, role, is_master, assigned_estate_id, password_hash)
                VALUES (?, '', '', ?, ?, 0, 1, ?)
                """,
                (username, full_name, role, hash_password(password)),
            )
            conn.commit()
            return self._send_json({"ok": True, "message": f"Created ERP user @{username} ({role})."})

        if path == "/api/admin/users/role":
            user = self._require_role(conn, "Admin")
            if not user:
                return
            target_id = int(data.get("user_id") or 0)
            new_role = normalize_role(data.get("role") or "Harvester")

            cur.execute("SELECT * FROM users WHERE id = ?", (target_id,))
            target = cur.fetchone()
            if not target:
                return self._send_json({"error": "User not found."}, status=404)
            if target["is_master"] or target["username"].lower() == "sandaru98j":
                return self._send_json({"error": "Cannot modify the Master Admin role."}, status=400)
            if new_role == "Master Admin" and not user["is_master"]:
                return self._send_json({"error": "Only the Master Admin can grant Master Admin access."}, status=403)

            cur.execute("UPDATE users SET role = ? WHERE id = ?", (new_role, target_id))
            conn.commit()
            return self._send_json({"ok": True})

        if path == "/api/admin/users/force-password":
            # Strictly Master Admin (sandaru98j) ultimate control feature
            user = self._require_role(conn, "Master Admin")
            if not user or not user["is_master"]:
                return self._send_json(
                    {"error": "Only Master Admin (sandaru98j) can force-reset user passwords."},
                    status=403,
                )
            target_id = int(data.get("user_id") or 0)
            new_password = str(data.get("new_password") or "")
            if len(new_password) < 6:
                return self._send_json({"error": "New password must be at least 6 characters."}, status=400)

            cur.execute("SELECT id, username FROM users WHERE id = ?", (target_id,))
            target = cur.fetchone()
            if not target:
                return self._send_json({"error": "User not found."}, status=404)

            cur.execute(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                (hash_password(new_password), target_id),
            )
            cur.execute("DELETE FROM sessions WHERE user_id = ? AND user_id != ?", (target_id, user["id"]))
            conn.commit()
            return self._send_json(
                {"ok": True, "message": f"Password force-updated for @{target['username']}."}
            )

        if path == "/api/admin/users/delete":
            user = self._require_role(conn, "Admin")
            if not user:
                return
            target_id = int(data.get("user_id") or 0)
            cur.execute("SELECT * FROM users WHERE id = ?", (target_id,))
            target = cur.fetchone()
            if not target:
                return self._send_json({"error": "User not found."}, status=404)
            if target["is_master"] or target["username"].lower() == "sandaru98j":
                return self._send_json({"error": "Cannot delete the Master Admin account."}, status=400)

            cur.execute("DELETE FROM sessions WHERE user_id = ?", (target_id,))
            cur.execute("DELETE FROM users WHERE id = ?", (target_id,))
            conn.commit()
            return self._send_json({"ok": True})

        # 7. Estates / 5-Tier Plantation Hierarchy Management
        if path == "/api/admin/settings":
            user = self._require_role(conn, "Admin")
            if not user:
                return
            gps_th = int(data.get("gps_threshold_m") or 20)
            season_m = int(data.get("season_start_month") or 4)
            cur.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('gps_threshold_m', ?)", (str(gps_th),))
            cur.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('season_start_month', ?)", (str(season_m),))
            conn.commit()
            return self._send_json({"ok": True})

        if path == "/api/admin/trees/batch":
            user = self._require_role(conn, "Admin")
            if not user:
                return
            block_id = int(data.get("block_id") or 0)
            count = int(data.get("count") or 0)
            if block_id <= 0 or count <= 0:
                return self._send_json({"error": "Select a valid block and palm count."}, status=400)
            cur.execute("SELECT COALESCE(MAX(tree_number), 0) AS mx FROM trees WHERE block_id = ?", (block_id,))
            start_no = int(cur.fetchone()["mx"] or 0) + 1
            rows = [
                (block_id, n, f"T-{n:03d}", ((n - 1) // 10) + 1, "active")
                for n in range(start_no, start_no + count)
            ]
            cur.executemany(
                "INSERT OR IGNORE INTO trees (block_id, tree_number, tree_code, row_number, status) VALUES (?, ?, ?, ?, ?)",
                rows,
            )
            conn.commit()
            return self._send_json({"ok": True, "from": start_no, "to": start_no + count - 1})

        if path.startswith("/api/admin/") and path.endswith(("/save", "/delete")):
            user = self._require_role(conn, "Admin")
            if not user:
                return
            parts = path.strip("/").split("/")
            entity, action = parts[2], parts[3]
            item_id = int(data.get("id") or 0)

            if action == "delete":
                table_map = {
                    "estate": "estates",
                    "division": "divisions",
                    "field": "fields",
                    "block": "blocks",
                    "tree": "trees",
                }
                tbl = table_map.get(entity)
                if tbl:
                    cur.execute(f"DELETE FROM {tbl} WHERE id = ?", (item_id,))
                    conn.commit()
                return self._send_json({"ok": True})

            if entity == "estate":
                name = str(data.get("name") or "").strip()
                if item_id:
                    cur.execute("UPDATE estates SET name = ? WHERE id = ?", (name, item_id))
                else:
                    code = f"EST-{secrets.token_hex(2).upper()}"
                    cur.execute("INSERT INTO estates (code, name) VALUES (?, ?)", (code, name))
            elif entity == "division":
                name = str(data.get("name") or "").strip()
                estate_id = int(data.get("estate_id") or 1)
                if item_id:
                    cur.execute("UPDATE divisions SET name = ? WHERE id = ?", (name, item_id))
                else:
                    code = f"DIV-{secrets.token_hex(2).upper()}"
                    cur.execute(
                        "INSERT INTO divisions (estate_id, code, name) VALUES (?, ?, ?)",
                        (estate_id, code, name),
                    )
            elif entity == "field":
                name = str(data.get("name") or "").strip()
                div_id = int(data.get("division_id") or 1)
                pyear = int(data.get("planting_year") or 2014)
                area_ha = float(data.get("area_ha") or 10.0)
                if item_id:
                    cur.execute(
                        "UPDATE fields SET name = ?, planting_year = ?, area_ha = ? WHERE id = ?",
                        (name, pyear, area_ha, item_id),
                    )
                else:
                    code = f"FLD-{secrets.token_hex(2).upper()}"
                    cur.execute(
                        "INSERT INTO fields (division_id, code, name, planting_year, area_ha) VALUES (?, ?, ?, ?, ?)",
                        (div_id, code, name, pyear, area_ha),
                    )
            elif entity == "block":
                name = str(data.get("name") or "").strip()
                field_id = int(data.get("field_id") or 1)
                note = str(data.get("boundary_note") or "").strip()
                tree_count = int(data.get("tree_count") or 0)
                if item_id:
                    cur.execute(
                        "UPDATE blocks SET name = ?, boundary_note = ? WHERE id = ?",
                        (name, note, item_id),
                    )
                else:
                    code = f"BLK-{secrets.token_hex(2).upper()}"
                    cur.execute(
                        "INSERT INTO blocks (field_id, code, name, boundary_note, target_stands) VALUES (?, ?, ?, ?, ?)",
                        (field_id, code, name, note, tree_count or 280),
                    )
                    new_bid = cur.lastrowid
                    if tree_count > 0:
                        rows = [
                            (new_bid, n, f"T-{n:03d}", ((n - 1) // 10) + 1, "active")
                            for n in range(1, tree_count + 1)
                        ]
                        cur.executemany(
                            "INSERT INTO trees (block_id, tree_number, tree_code, row_number, status) VALUES (?, ?, ?, ?, ?)",
                            rows,
                        )
            elif entity == "tree":
                block_id = int(data.get("block_id") or 1)
                tree_no = int(data.get("tree_no") or 1)
                lat = data.get("lat")
                lng = data.get("lng")
                acc = data.get("acc") or 4.0
                now_s = datetime.utcnow().isoformat()
                if item_id:
                    cur.execute(
                        """
                        UPDATE trees
                        SET tree_number = ?, latitude = ?, longitude = ?, gps_acc = ?, mapped_by = ?, mapped_at = ?
                        WHERE id = ?
                        """,
                        (tree_no, lat, lng, acc, user["id"], now_s, item_id),
                    )
                else:
                    cur.execute(
                        """
                        INSERT INTO trees (block_id, tree_number, tree_code, row_number, latitude, longitude, gps_acc, status, mapped_by, mapped_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
                        ON CONFLICT(block_id, tree_number) DO UPDATE SET
                            latitude = excluded.latitude,
                            longitude = excluded.longitude,
                            gps_acc = excluded.gps_acc,
                            mapped_by = excluded.mapped_by,
                            mapped_at = excluded.mapped_at
                        """,
                        (block_id, tree_no, f"T-{tree_no:03d}", ((tree_no - 1) // 10) + 1, lat, lng, acc, user["id"], now_s),
                    )
            conn.commit()
            return self._send_json({"ok": True})

        return self._send_json({"error": f"Unknown endpoint {path}"}, status=404)


def run_server(port=None, host=None):
    init_db()
    bind_host = host or os.environ.get("HOST", "0.0.0.0")
    bind_port = int(port or os.environ.get("PORT", 8080))
    server = ThreadingHTTPServer((bind_host, bind_port), ElaeisErpHandler)
    print(f"Elaeis Corporate ERP running at http://{bind_host}:{bind_port}")
    server.serve_forever()


if __name__ == "__main__":
    run_server()
