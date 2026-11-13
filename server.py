import os
import json
import csv
import io
import secrets
from datetime import datetime, date, timedelta
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

from database import (
    init_db,
    get_connection,
    hash_password,
    verify_password,
    compute_harvest_round,
)

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")


class ElaeisMonitoringHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Clean console logging
        pass

    def _send_json(self, data, status=200):
        body = json.dumps(data, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
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
        token = ""
        if auth.startswith("Bearer "):
            token = auth[7:].strip()
        if not token:
            return None
        cur = conn.cursor()
        cur.execute(
            """
            SELECT u.id, u.username, u.email, u.phone, u.full_name, u.role, u.assigned_estate_id
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token = ?
            """,
            (token,),
        )
        row = cur.fetchone()
        return dict(row) if row else None

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

        # Serve static frontend files
        if path == "/" or path == "":
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
        content_type = mime_map.get(ext, "application/octet-stream")
        with open(file_path, "rb") as f:
            content = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
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
    # GET API HANDLERS
    # -------------------------------------------------------------------------
    def handle_api_get(self, path, params, conn):
        cur = conn.cursor()

        if path == "/api/auth/me":
            user = self._get_current_user(conn)
            if not user:
                return self._send_json({"authenticated": False}, status=401)
            return self._send_json({"authenticated": True, "user": user})

        if path == "/api/round-info":
            date_str = params.get("date", date.today().strftime("%Y-%m-%d"))
            return self._send_json(compute_harvest_round(date_str))

        if path == "/api/hierarchy":
            cur.execute("SELECT * FROM estates ORDER BY id")
            estates = [dict(r) for r in cur.fetchall()]

            cur.execute("SELECT * FROM divisions ORDER BY id")
            divisions = [dict(r) for r in cur.fetchall()]

            cur.execute("SELECT * FROM fields ORDER BY id")
            fields = [dict(r) for r in cur.fetchall()]

            cur.execute(
                """
                SELECT b.*, COUNT(t.id) AS registered_trees
                FROM blocks b
                LEFT JOIN trees t ON t.block_id = b.id
                GROUP BY b.id
                ORDER BY b.id
                """
            )
            blocks = [dict(r) for r in cur.fetchall()]

            return self._send_json(
                {
                    "estates": estates,
                    "divisions": divisions,
                    "fields": fields,
                    "blocks": blocks,
                }
            )

        if path == "/api/custom-fields":
            cur.execute("SELECT * FROM custom_field_defs WHERE is_active = 1 ORDER BY id")
            fields = [dict(r) for r in cur.fetchall()]
            return self._send_json({"custom_fields": fields})

        if path == "/api/users":
            cur.execute(
                """
                SELECT u.id, u.username, u.email, u.phone, u.full_name, u.role,
                       u.assigned_estate_id, e.name AS estate_name, u.created_at
                FROM users u
                LEFT JOIN estates e ON e.id = u.assigned_estate_id
                ORDER BY u.id
                """
            )
            return self._send_json({"users": [dict(r) for r in cur.fetchall()]})

        if path == "/api/trees/lookup":
            block_id = int(params.get("block_id", 0))
            tree_number = int(params.get("tree_number", 1))
            date_str = params.get("date", date.today().strftime("%Y-%m-%d"))
            round_info = compute_harvest_round(date_str)

            cur.execute(
                """
                SELECT t.*, b.code AS block_code, b.name AS block_name,
                       f.code AS field_code, f.name AS field_name,
                       d.code AS division_code, d.name AS division_name,
                       e.code AS estate_code, e.name AS estate_name
                FROM trees t
                JOIN blocks b ON b.id = t.block_id
                JOIN fields f ON f.id = b.field_id
                JOIN divisions d ON d.id = f.division_id
                JOIN estates e ON e.id = d.estate_id
                WHERE t.block_id = ? AND t.tree_number = ?
                """,
                (block_id, tree_number),
            )
            tree_row = cur.fetchone()

            # Total trees in block
            cur.execute(
                "SELECT COUNT(*) AS total, MAX(tree_number) AS max_num FROM trees WHERE block_id = ?",
                (block_id,),
            )
            blk_meta = dict(cur.fetchone())

            if not tree_row:
                # Suggest interpolated GPS based on last tree in block
                cur.execute(
                    "SELECT latitude, longitude, row_number FROM trees WHERE block_id = ? ORDER BY tree_number DESC LIMIT 1",
                    (block_id,),
                )
                last_t = cur.fetchone()
                sug_lat = round(last_t["latitude"] + 0.000075, 6) if last_t else 2.032500
                sug_lng = round(last_t["longitude"] + 0.000085, 6) if last_t else 103.318500
                return self._send_json(
                    {
                        "exists": False,
                        "tree_number": tree_number,
                        "tree_code": f"T-{tree_number:03d}",
                        "suggested_latitude": sug_lat,
                        "suggested_longitude": sug_lng,
                        "round_info": round_info,
                        "block_total_trees": blk_meta["total"] or 0,
                        "max_tree_number": blk_meta["max_num"] or 0,
                    }
                )

            tree = dict(tree_row)
            # Check if harvest log already exists for this tree + year_month + round_number
            cur.execute(
                """
                SELECT * FROM harvest_logs
                WHERE tree_id = ? AND year_month = ? AND round_number = ?
                ORDER BY id DESC LIMIT 1
                """,
                (tree["id"], round_info["year_month"], round_info["round_number"]),
            )
            existing_log = cur.fetchone()

            # Also get all 3 rounds summary for this tree in current year_month
            cur.execute(
                """
                SELECT round_number, bunches_cut, fronds_cut, harvest_date, weed_growth, fertilizer_type
                FROM harvest_logs
                WHERE tree_id = ? AND year_month = ?
                ORDER BY round_number
                """,
                (tree["id"], round_info["year_month"]),
            )
            month_rounds = {r["round_number"]: dict(r) for r in cur.fetchall()}

            return self._send_json(
                {
                    "exists": True,
                    "tree": tree,
                    "round_info": round_info,
                    "existing_log": dict(existing_log) if existing_log else None,
                    "month_rounds": month_rounds,
                    "block_total_trees": blk_meta["total"] or 0,
                    "max_tree_number": blk_meta["max_num"] or 0,
                    "next_tree_number": tree_number + 1,
                }
            )

        if path == "/api/reports/block-rounds":
            block_id = int(params.get("block_id", 1))
            year_month = params.get("year_month", date.today().strftime("%Y-%m"))

            # Block & Hierarchy metadata
            cur.execute(
                """
                SELECT b.*, f.code AS field_code, f.name AS field_name,
                       d.code AS division_code, d.name AS division_name,
                       e.code AS estate_code, e.name AS estate_name, e.crop_type
                FROM blocks b
                JOIN fields f ON f.id = b.field_id
                JOIN divisions d ON d.id = f.division_id
                JOIN estates e ON e.id = d.estate_id
                WHERE b.id = ?
                """,
                (block_id,),
            )
            blk_row = cur.fetchone()
            block_info = dict(blk_row) if blk_row else {}

            # All trees in block
            cur.execute(
                "SELECT * FROM trees WHERE block_id = ? ORDER BY tree_number ASC",
                (block_id,),
            )
            trees = [dict(r) for r in cur.fetchall()]

            # All harvest logs for this block and year_month
            cur.execute(
                """
                SELECT * FROM harvest_logs
                WHERE block_id = ? AND year_month = ?
                ORDER BY round_number ASC, id ASC
                """,
                (block_id, year_month),
            )
            logs = [dict(r) for r in cur.fetchall()]

            # Index logs by (tree_id, round_number)
            log_map = {}
            for lg in logs:
                log_map[(lg["tree_id"], lg["round_number"])] = lg

            matrix = []
            summary = {
                "total_trees": len(trees),
                "r1_trees_harvested": 0,
                "r1_bunches": 0,
                "r1_fronds": 0,
                "r2_trees_harvested": 0,
                "r2_bunches": 0,
                "r2_fronds": 0,
                "r3_trees_harvested": 0,
                "r3_bunches": 0,
                "r3_fronds": 0,
                "total_bunches": 0,
                "total_fronds": 0,
                "total_weight_kg": 0.0,
            }

            for t in trees:
                tid = t["id"]
                r1 = log_map.get((tid, 1))
                r2 = log_map.get((tid, 2))
                r3 = log_map.get((tid, 3))

                b1 = r1["bunches_cut"] if r1 else 0
                f1 = r1["fronds_cut"] if r1 else 0
                b2 = r2["bunches_cut"] if r2 else 0
                f2 = r2["fronds_cut"] if r2 else 0
                b3 = r3["bunches_cut"] if r3 else 0
                f3 = r3["fronds_cut"] if r3 else 0

                w_tot = (
                    (r1["bunch_weight_kg"] if r1 else 0.0)
                    + (r2["bunch_weight_kg"] if r2 else 0.0)
                    + (r3["bunch_weight_kg"] if r3 else 0.0)
                )

                if r1:
                    summary["r1_trees_harvested"] += 1
                    summary["r1_bunches"] += b1
                    summary["r1_fronds"] += f1
                if r2:
                    summary["r2_trees_harvested"] += 1
                    summary["r2_bunches"] += b2
                    summary["r2_fronds"] += f2
                if r3:
                    summary["r3_trees_harvested"] += 1
                    summary["r3_bunches"] += b3
                    summary["r3_fronds"] += f3

                tot_b = b1 + b2 + b3
                tot_f = f1 + f2 + f3
                summary["total_bunches"] += tot_b
                summary["total_fronds"] += tot_f
                summary["total_weight_kg"] = round(summary["total_weight_kg"] + w_tot, 1)

                matrix.append(
                    {
                        "tree_id": tid,
                        "tree_number": t["tree_number"],
                        "tree_code": t["tree_code"],
                        "row_number": t["row_number"],
                        "latitude": t["latitude"],
                        "longitude": t["longitude"],
                        "health_status": t["health_status"],
                        "weed_status": t["weed_status"],
                        "last_fertilizer_type": t["last_fertilizer_type"],
                        "last_fertilizer_kg": t["last_fertilizer_kg"],
                        "round_1": r1,
                        "round_2": r2,
                        "round_3": r3,
                        "total_bunches": tot_b,
                        "total_fronds": tot_f,
                        "total_weight_kg": round(w_tot, 1),
                        "rounds_done": (1 if r1 else 0) + (1 if r2 else 0) + (1 if r3 else 0),
                    }
                )

            return self._send_json(
                {
                    "block": block_info,
                    "year_month": year_month,
                    "summary": summary,
                    "trees_matrix": matrix,
                }
            )

        if path == "/api/reports/export-csv":
            block_id = int(params.get("block_id", 1))
            year_month = params.get("year_month", date.today().strftime("%Y-%m"))

            cur.execute(
                """
                SELECT b.*, f.code AS field_code, f.name AS field_name,
                       d.code AS division_code, d.name AS division_name,
                       e.code AS estate_code, e.name AS estate_name
                FROM blocks b
                JOIN fields f ON f.id = b.field_id
                JOIN divisions d ON d.id = f.division_id
                JOIN estates e ON e.id = d.estate_id
                WHERE b.id = ?
                """,
                (block_id,),
            )
            b_info = dict(cur.fetchone() or {})

            cur.execute("SELECT * FROM trees WHERE block_id = ? ORDER BY tree_number ASC", (block_id,))
            trees = [dict(r) for r in cur.fetchall()]

            cur.execute(
                "SELECT * FROM harvest_logs WHERE block_id = ? AND year_month = ?",
                (block_id, year_month),
            )
            log_map = {(r["tree_id"], r["round_number"]): dict(r) for r in cur.fetchall()}

            output = io.StringIO()
            writer = csv.writer(output)
            writer.writerow(
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
                    "R1 (Days 1-10) Date",
                    "R1 Bunches Cut",
                    "R1 Fronds Cut",
                    "R2 (Days 11-20) Date",
                    "R2 Bunches Cut",
                    "R2 Fronds Cut",
                    "R3 (Days 21-End) Date",
                    "R3 Bunches Cut",
                    "R3 Fronds Cut",
                    "Monthly Total Bunches",
                    "Monthly Total Fronds",
                    "Est Weight (kg)",
                    "Weed Growth Status",
                    "Last Fertilizer Type",
                    "Fertilizer (kg)",
                    "Palm Health Status",
                ]
            )

            for t in trees:
                tid = t["id"]
                r1 = log_map.get((tid, 1), {})
                r2 = log_map.get((tid, 2), {})
                r3 = log_map.get((tid, 3), {})
                b1, f1 = r1.get("bunches_cut", 0), r1.get("fronds_cut", 0)
                b2, f2 = r2.get("bunches_cut", 0), r2.get("fronds_cut", 0)
                b3, f3 = r3.get("bunches_cut", 0), r3.get("fronds_cut", 0)
                w_tot = (
                    r1.get("bunch_weight_kg", 0.0)
                    + r2.get("bunch_weight_kg", 0.0)
                    + r3.get("bunch_weight_kg", 0.0)
                )

                writer.writerow(
                    [
                        b_info.get("estate_name", ""),
                        b_info.get("division_name", ""),
                        b_info.get("field_name", ""),
                        b_info.get("code", ""),
                        year_month,
                        t["tree_number"],
                        t["tree_code"],
                        t["row_number"],
                        t["latitude"],
                        t["longitude"],
                        r1.get("harvest_date", "-"),
                        b1,
                        f1,
                        r2.get("harvest_date", "-"),
                        b2,
                        f2,
                        r3.get("harvest_date", "-"),
                        b3,
                        f3,
                        b1 + b2 + b3,
                        f1 + f2 + f3,
                        round(w_tot, 1),
                        t["weed_status"],
                        t["last_fertilizer_type"],
                        t["last_fertilizer_kg"],
                        t["health_status"],
                    ]
                )

            filename = f"Elaeis_Block_{b_info.get('code', 'Report')}_{year_month}.csv"
            return self._send_csv(output.getvalue(), filename)

        if path == "/api/dashboard":
            year_month = params.get("year_month", date.today().strftime("%Y-%m"))
            today_round = compute_harvest_round(date.today().strftime("%Y-%m-%d"))

            cur.execute("SELECT COUNT(*) AS c FROM estates")
            total_estates = cur.fetchone()["c"]
            cur.execute("SELECT COUNT(*) AS c FROM divisions")
            total_divisions = cur.fetchone()["c"]
            cur.execute("SELECT COUNT(*) AS c FROM fields")
            total_fields = cur.fetchone()["c"]
            cur.execute("SELECT COUNT(*) AS c FROM blocks")
            total_blocks = cur.fetchone()["c"]
            cur.execute("SELECT COUNT(*) AS c FROM trees")
            total_trees = cur.fetchone()["c"]

            # Round breakdown for selected year_month
            cur.execute(
                """
                SELECT round_number,
                       COUNT(DISTINCT tree_id) AS trees_harvested,
                       COALESCE(SUM(bunches_cut), 0) AS bunches,
                       COALESCE(SUM(fronds_cut), 0) AS fronds,
                       COALESCE(SUM(bunch_weight_kg), 0) AS weight_kg
                FROM harvest_logs
                WHERE year_month = ?
                GROUP BY round_number
                """,
                (year_month,),
            )
            rounds_data = {
                1: {"round_number": 1, "label": "Round 1 (1â€“10)", "trees_harvested": 0, "bunches": 0, "fronds": 0, "weight_kg": 0.0},
                2: {"round_number": 2, "label": "Round 2 (11â€“20)", "trees_harvested": 0, "bunches": 0, "fronds": 0, "weight_kg": 0.0},
                3: {"round_number": 3, "label": "Round 3 (21â€“End)", "trees_harvested": 0, "bunches": 0, "fronds": 0, "weight_kg": 0.0},
            }
            for r in cur.fetchall():
                rn = r["round_number"]
                if rn in rounds_data:
                    rounds_data[rn].update(dict(r))

            # Block-level summary table
            cur.execute(
                """
                SELECT b.id AS block_id, b.code AS block_code, b.name AS block_name,
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
                GROUP BY b.id
                ORDER BY b.id
                """,
                (year_month,),
            )
            block_summaries = [dict(r) for r in cur.fetchall()]

            # Recent harvest activity feed
            cur.execute(
                """
                SELECT h.*, t.tree_number, t.tree_code, b.code AS block_code,
                       f.code AS field_code, d.code AS division_code, e.name AS estate_name
                FROM harvest_logs h
                JOIN trees t ON t.id = h.tree_id
                JOIN blocks b ON b.id = h.block_id
                JOIN fields f ON f.id = b.field_id
                JOIN divisions d ON d.id = f.division_id
                JOIN estates e ON e.id = d.estate_id
                ORDER BY h.id DESC
                LIMIT 12
                """
            )
            recent_logs = [dict(r) for r in cur.fetchall()]

            return self._send_json(
                {
                    "year_month": year_month,
                    "today_round": today_round,
                    "counts": {
                        "estates": total_estates,
                        "divisions": total_divisions,
                        "fields": total_fields,
                        "blocks": total_blocks,
                        "trees": total_trees,
                    },
                    "rounds": rounds_data,
                    "block_summaries": block_summaries,
                    "recent_logs": recent_logs,
                }
            )

        return self._send_json({"error": f"Unknown endpoint {path}"}, status=404)

    # -------------------------------------------------------------------------
    # POST API HANDLERS
    # -------------------------------------------------------------------------
    def handle_api_post(self, path, data, conn):
        cur = conn.cursor()

        # 1. Login with Username, Email, OR Phone Number
        if path == "/api/auth/login":
            identifier = str(data.get("identifier", "")).strip()
            password = str(data.get("password", ""))
            if not identifier or not password:
                return self._send_json(
                    {"error": "Please enter your Username, Email, or Phone Number and Password."},
                    status=400,
                )

            cur.execute(
                """
                SELECT * FROM users
                WHERE LOWER(username) = LOWER(?)
                   OR LOWER(email) = LOWER(?)
                   OR phone = ?
                """,
                (identifier, identifier, identifier),
            )
            user_row = cur.fetchone()
            if not user_row or not verify_password(password, user_row["password_hash"]):
                return self._send_json(
                    {"error": "Invalid credentials. Check your username/email/phone and password."},
                    status=401,
                )

            token = secrets.token_hex(24)
            cur.execute(
                "INSERT INTO sessions (token, user_id) VALUES (?, ?)",
                (token, user_row["id"]),
            )
            conn.commit()

            user_dict = {
                "id": user_row["id"],
                "username": user_row["username"],
                "email": user_row["email"],
                "phone": user_row["phone"],
                "full_name": user_row["full_name"],
                "role": user_row["role"],
                "assigned_estate_id": user_row["assigned_estate_id"],
            }
            return self._send_json({"token": token, "user": user_dict})

        # 2. Register / Assign New User
        if path == "/api/auth/register" or path == "/api/users":
            username = str(data.get("username", "")).strip()
            email = str(data.get("email", "")).strip()
            phone = str(data.get("phone", "")).strip()
            full_name = str(data.get("full_name", "")).strip()
            role = str(data.get("role", "Harvester")).strip()
            assigned_estate_id = data.get("assigned_estate_id") or 1
            password = str(data.get("password", "")).strip()

            if not (username and email and phone and full_name and password):
                return self._send_json(
                    {"error": "All fields (Username, Email, Phone, Full Name, Password) are required."},
                    status=400,
                )

            try:
                cur.execute(
                    """
                    INSERT INTO users (username, email, phone, full_name, role, assigned_estate_id, password_hash)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        username,
                        email,
                        phone,
                        full_name,
                        role,
                        int(assigned_estate_id),
                        hash_password(password),
                    ),
                )
                conn.commit()
                new_id = cur.lastrowid
                return self._send_json(
                    {
                        "message": f"User '{full_name}' ({role}) created successfully.",
                        "user_id": new_id,
                    }
                )
            except Exception as e:
                return self._send_json(
                    {"error": f"Could not create user (Username, Email, or Phone may already exist): {e}"},
                    status=400,
                )

        # 3. Forgot Password (by Username, Email, or Phone Number)
        if path == "/api/auth/forgot-password":
            identifier = str(data.get("identifier", "")).strip()
            if not identifier:
                return self._send_json(
                    {"error": "Please enter your Username, Email, or Phone Number."},
                    status=400,
                )

            cur.execute(
                """
                SELECT id, username, email, phone, full_name FROM users
                WHERE LOWER(username) = LOWER(?)
                   OR LOWER(email) = LOWER(?)
                   OR phone = ?
                """,
                (identifier, identifier, identifier),
            )
            user_row = cur.fetchone()
            if not user_row:
                return self._send_json(
                    {"error": "No account found matching that Username, Email, or Phone Number."},
                    status=404,
                )

            otp_code = f"{secrets.randbelow(900000) + 100000}"
            expires = (datetime.now() + timedelta(minutes=30)).isoformat()
            cur.execute(
                "UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?",
                (otp_code, expires, user_row["id"]),
            )
            conn.commit()

            return self._send_json(
                {
                    "message": f"Recovery code generated for {user_row['full_name']} ({user_row['email']} / {user_row['phone']}).",
                    "recovery_code_demo": otp_code,
                    "user_hint": f"{user_row['username']} ({user_row['phone']})",
                }
            )

        # 4. Reset Password using OTP Code
        if path == "/api/auth/reset-password":
            identifier = str(data.get("identifier", "")).strip()
            reset_token = str(data.get("reset_token", "")).strip()
            new_password = str(data.get("new_password", "")).strip()

            if not (identifier and reset_token and new_password):
                return self._send_json(
                    {"error": "Identifier, recovery code, and new password are required."},
                    status=400,
                )

            cur.execute(
                """
                SELECT id, reset_token FROM users
                WHERE (LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?) OR phone = ?)
                  AND reset_token = ?
                """,
                (identifier, identifier, identifier, reset_token),
            )
            user_row = cur.fetchone()
            if not user_row:
                return self._send_json(
                    {"error": "Invalid recovery code or account identifier."},
                    status=400,
                )

            cur.execute(
                "UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?",
                (hash_password(new_password), user_row["id"]),
            )
            conn.commit()
            return self._send_json({"message": "Password reset successfully! You can now sign in."})

        # 5. Record Tree Harvest & Upkeep -> Auto-Advance to Next Tree
        if path == "/api/harvest":
            user = self._get_current_user(conn)
            recorded_by_id = user["id"] if user else 1
            recorded_by_name = user["full_name"] if user else "Field Supervisor"

            block_id = int(data.get("block_id", 0))
            tree_number = int(data.get("tree_number", 0))
            harvest_date = str(data.get("harvest_date") or date.today().strftime("%Y-%m-%d"))
            bunches_cut = int(data.get("bunches_cut", 0))
            fronds_cut = int(data.get("fronds_cut", 0))
            bunch_weight_kg = float(data.get("bunch_weight_kg") or round(bunches_cut * 18.5, 1))
            loose_fruits_count = int(data.get("loose_fruits_count") or 0)
            weed_growth = str(data.get("weed_growth") or "Clean Circle")
            fertilizer_type = str(data.get("fertilizer_type") or "None")
            fertilizer_kg = float(data.get("fertilizer_kg") or 0.0)
            pruning_status = str(data.get("pruning_status") or "Standard Stacked")
            pest_disease = str(data.get("pest_disease") or "Healthy")
            custom_data = data.get("custom_data") or {}
            remarks = str(data.get("remarks") or "")

            if block_id <= 0 or tree_number <= 0:
                return self._send_json({"error": "Valid Block and Tree Number are required."}, status=400)

            round_info = compute_harvest_round(harvest_date)

            # Find or auto-create tree in block
            cur.execute(
                "SELECT * FROM trees WHERE block_id = ? AND tree_number = ?",
                (block_id, tree_number),
            )
            tree_row = cur.fetchone()

            lat = float(data.get("latitude") or (tree_row["latitude"] if tree_row else 2.032500))
            lng = float(data.get("longitude") or (tree_row["longitude"] if tree_row else 103.318500))

            if not tree_row:
                row_no = ((tree_number - 1) // 5) + 1
                tree_code = f"T-{tree_number:03d}"
                cur.execute(
                    """
                    INSERT INTO trees (
                        block_id, tree_number, tree_code, row_number,
                        latitude, longitude, planting_year, health_status,
                        weed_status, last_fertilizer_type, last_fertilizer_kg, last_fertilizer_date, notes
                    ) VALUES (?, ?, ?, ?, ?, ?, 2018, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        block_id,
                        tree_number,
                        tree_code,
                        row_no,
                        lat,
                        lng,
                        pest_disease,
                        weed_growth,
                        fertilizer_type if fertilizer_type != "None" else "NPK 12:12:17:2",
                        fertilizer_kg,
                        round_info["date"] if fertilizer_type != "None" else "",
                        remarks,
                    ),
                )
                tree_id = cur.lastrowid
            else:
                tree_id = tree_row["id"]
                # Update tree's latest status & GPS if modified
                fert_type_to_save = (
                    fertilizer_type
                    if fertilizer_type != "None"
                    else tree_row["last_fertilizer_type"]
                )
                fert_kg_to_save = (
                    fertilizer_kg
                    if fertilizer_type != "None"
                    else tree_row["last_fertilizer_kg"]
                )
                fert_date_to_save = (
                    round_info["date"]
                    if fertilizer_type != "None"
                    else tree_row["last_fertilizer_date"]
                )
                cur.execute(
                    """
                    UPDATE trees
                    SET latitude = ?, longitude = ?, health_status = ?, weed_status = ?,
                        last_fertilizer_type = ?, last_fertilizer_kg = ?, last_fertilizer_date = ?
                    WHERE id = ?
                    """,
                    (
                        lat,
                        lng,
                        pest_disease,
                        weed_growth,
                        fert_type_to_save,
                        fert_kg_to_save,
                        fert_date_to_save,
                        tree_id,
                    ),
                )

            # Upsert harvest log for (tree_id, year_month, round_number)
            cur.execute(
                """
                SELECT id FROM harvest_logs
                WHERE tree_id = ? AND year_month = ? AND round_number = ?
                """,
                (tree_id, round_info["year_month"], round_info["round_number"]),
            )
            existing = cur.fetchone()
            if existing:
                cur.execute(
                    """
                    UPDATE harvest_logs
                    SET harvest_date = ?, day_of_month = ?, bunches_cut = ?, fronds_cut = ?,
                        bunch_weight_kg = ?, loose_fruits_count = ?, weed_growth = ?,
                        fertilizer_type = ?, fertilizer_kg = ?, pruning_status = ?,
                        pest_disease = ?, custom_data_json = ?, latitude = ?, longitude = ?,
                        recorded_by_id = ?, recorded_by_name = ?, remarks = ?
                    WHERE id = ?
                    """,
                    (
                        round_info["date"],
                        round_info["day_of_month"],
                        bunches_cut,
                        fronds_cut,
                        bunch_weight_kg,
                        loose_fruits_count,
                        weed_growth,
                        fertilizer_type,
                        fertilizer_kg,
                        pruning_status,
                        pest_disease,
                        json.dumps(custom_data),
                        lat,
                        lng,
                        recorded_by_id,
                        recorded_by_name,
                        remarks,
                        existing["id"],
                    ),
                )
                log_id = existing["id"]
                action_word = "Updated"
            else:
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
                        round_info["date"],
                        round_info["year_month"],
                        round_info["day_of_month"],
                        round_info["round_number"],
                        bunches_cut,
                        fronds_cut,
                        bunch_weight_kg,
                        loose_fruits_count,
                        weed_growth,
                        fertilizer_type,
                        fertilizer_kg,
                        pruning_status,
                        pest_disease,
                        json.dumps(custom_data),
                        lat,
                        lng,
                        recorded_by_id,
                        recorded_by_name,
                        remarks,
                    ),
                )
                log_id = cur.lastrowid
                action_word = "Saved"

            conn.commit()

            return self._send_json(
                {
                    "message": f"{action_word} Tree #{tree_number} ({round_info['round_label']}): {bunches_cut} Bunches, {fronds_cut} Fronds",
                    "log_id": log_id,
                    "tree_number": tree_number,
                    "next_tree_number": tree_number + 1,
                    "round_info": round_info,
                }
            )

        # 6. Hierarchy Creation Endpoints (Estate / Division / Field / Block / Tree)
        if path == "/api/hierarchy/create":
            level = data.get("level")
            if level == "estate":
                cur.execute(
                    "INSERT INTO estates (code, name, crop_type, location_region, total_area_ha) VALUES (?, ?, ?, ?, ?)",
                    (
                        data.get("code", "").strip(),
                        data.get("name", "").strip(),
                        data.get("crop_type", "Oil Palm (DxP Tenera)"),
                        data.get("location_region", "Malaysia"),
                        float(data.get("total_area_ha") or 100.0),
                    ),
                )
            elif level == "division":
                cur.execute(
                    "INSERT INTO divisions (estate_id, code, name, supervisor_name) VALUES (?, ?, ?, ?)",
                    (
                        int(data["estate_id"]),
                        data.get("code", "").strip(),
                        data.get("name", "").strip(),
                        data.get("supervisor_name", ""),
                    ),
                )
            elif level == "field":
                cur.execute(
                    "INSERT INTO fields (division_id, code, name, planting_year, area_ha) VALUES (?, ?, ?, ?, ?)",
                    (
                        int(data["division_id"]),
                        data.get("code", "").strip(),
                        data.get("name", "").strip(),
                        int(data.get("planting_year") or 2020),
                        float(data.get("area_ha") or 25.0),
                    ),
                )
            elif level == "block":
                cur.execute(
                    "INSERT INTO blocks (field_id, code, name, palm_variety, area_ha, target_stands) VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        int(data["field_id"]),
                        data.get("code", "").strip(),
                        data.get("name", "").strip(),
                        data.get("palm_variety", "DxP Tenera"),
                        float(data.get("area_ha") or 15.0),
                        int(data.get("target_stands") or 20),
                    ),
                )
                blk_id = cur.lastrowid
                # Auto-generate initial palm trees with GPS grid if requested
                auto_trees = int(data.get("auto_generate_trees") or 0)
                base_lat = float(data.get("base_latitude") or 2.035000)
                base_lng = float(data.get("base_longitude") or 103.320000)
                for i in range(1, auto_trees + 1):
                    r_no = ((i - 1) // 5) + 1
                    c_no = (i - 1) % 5
                    t_lat = round(base_lat + (r_no - 1) * 0.000075, 6)
                    t_lng = round(base_lng + c_no * 0.000085 + (0.000042 if r_no % 2 == 0 else 0), 6)
                    cur.execute(
                        """
                        INSERT INTO trees (block_id, tree_number, tree_code, row_number, latitude, longitude, planting_year)
                        VALUES (?, ?, ?, ?, ?, ?, 2020)
                        """,
                        (blk_id, i, f"T-{i:03d}", r_no, t_lat, t_lng),
                    )
            elif level == "tree":
                block_id = int(data["block_id"])
                tree_number = int(data["tree_number"])
                cur.execute(
                    """
                    INSERT OR REPLACE INTO trees (
                        block_id, tree_number, tree_code, row_number,
                        latitude, longitude, planting_year, health_status, weed_status, last_fertilizer_type
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        block_id,
                        tree_number,
                        f"T-{tree_number:03d}",
                        int(data.get("row_number") or 1),
                        float(data["latitude"]),
                        float(data["longitude"]),
                        int(data.get("planting_year") or 2019),
                        data.get("health_status", "Healthy"),
                        data.get("weed_status", "Clean Circle"),
                        data.get("last_fertilizer_type", "NPK 12:12:17:2"),
                    ),
                )
            else:
                return self._send_json({"error": "Invalid hierarchy level"}, status=400)

            conn.commit()
            return self._send_json({"message": f"{level.capitalize()} created successfully!"})

        # 7. Add Dynamic Agronomic Field Definition
        if path == "/api/custom-fields":
            label = str(data.get("field_label", "")).strip()
            field_type = str(data.get("field_type", "text")).strip()
            options_csv = str(data.get("options_csv", "")).strip()
            unit = str(data.get("unit", "")).strip()
            if not label:
                return self._send_json({"error": "Field label is required"}, status=400)
            key = "".join(c if c.isalnum() else "_" for c in label.lower()).strip("_")
            cur.execute(
                """
                INSERT OR REPLACE INTO custom_field_defs (field_key, field_label, field_type, options_csv, unit, is_active)
                VALUES (?, ?, ?, ?, ?, 1)
                """,
                (key, label, field_type, options_csv, unit),
            )
            conn.commit()
            return self._send_json({"message": f"Custom field '{label}' added to harvesting & upkeep form!"})

        return self._send_json({"error": f"Unknown endpoint {path}"}, status=404)


def run_server(port=None, host=None):
    init_db()
    bind_host = host or os.environ.get("HOST", "0.0.0.0")
    bind_port = int(port or os.environ.get("PORT", 8080))
    server = ThreadingHTTPServer((bind_host, bind_port), ElaeisMonitoringHandler)
    print(f"Elaeis — Palm Basis Crop Monitoring System running at http://{bind_host}:{bind_port}")
    server.serve_forever()


if __name__ == "__main__":
    run_server()

