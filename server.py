import os
import re
import math
import json
import csv
import io
import base64
import zipfile
import secrets
import sqlite3
from xml.sax.saxutils import escape as xml_escape
from datetime import datetime, date, timedelta, timezone
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

from database import (
    init_db,
    get_connection,
    hash_password,
    verify_password,
    compute_harvest_round,
    compute_palm_coordinates,
    INITIAL_ERP_PASSWORD,
    ROLE_RANK,
)

VALID_HEALTH_STATUSES = [
    "Healthy",
    "Ganoderma / Disease",
    "Nutrient Deficient",
    "Pest / Rhinoceros",
    "Fallen / Vacant",
]


def normalize_health_status(val: str) -> str:
    s = str(val or "").strip()
    if not s:
        return "Healthy"
    for candidate in VALID_HEALTH_STATUSES:
        if candidate.lower() == s.lower():
            return candidate
    return "Healthy"


def slugify_filename(name: str, fallback: str = "Elaeis") -> str:
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", str(name or "").strip()).strip("_")[:48]
    return cleaned or fallback

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
UPLOADS_DIR = os.path.join(STATIC_DIR, "uploads")
os.makedirs(UPLOADS_DIR, exist_ok=True)
MAX_IMAGE_BYTES = 5 * 1024 * 1024  # 5 MB limit for uploaded profile/cover images
SESSION_TTL_DAYS = 30


class ErpHttpError(Exception):
    """Safe, user-facing HTTP exception that never leaks internal stack traces."""
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


def safe_int(val, default=None, min_val=None, max_val=None):
    if val is None or val == "":
        return default
    try:
        n = int(float(val))
    except (ValueError, TypeError):
        return default
    if min_val is not None and n < min_val:
        return min_val
    if max_val is not None and n > max_val:
        return max_val
    return n


def safe_float(val, default=None, min_val=None, max_val=None):
    if val is None or val == "":
        return default
    try:
        n = float(val)
        if not math.isfinite(n):
            return default
    except (ValueError, TypeError):
        return default
    if min_val is not None and n < min_val:
        return min_val
    if max_val is not None and n > max_val:
        return max_val
    return n


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
    is_master = bool(d.get("is_master")) or role == "Master Admin"
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
        "profile_pic": d.get("profile_pic") or "",
        "cover_photo": d.get("cover_photo") or "",
        "assigned_estate_id": d.get("assigned_estate_id") or 1,
        "created_at": d.get("created_at"),
    }


def save_uploaded_image(image_value: str, prefix: str, user_id: int) -> str:
    """
    Accepts either a base64 Data URI ('data:image/png;base64,...') or an existing safe path/URL.
    Validates payload size, MIME type, and path safety before writing to static/uploads/.
    """
    val = str(image_value or "").strip()
    if not val:
        return ""
    safe_prefix = "avatar" if prefix == "avatar" else "cover"
    if val.startswith("data:image/"):
        match = re.match(r"^data:image/([a-zA-Z0-9+.-]+);base64,(.+)$", val, re.DOTALL)
        if not match:
            raise ErpHttpError("Invalid image Data URI format.", status=400)
        ext_raw = match.group(1).lower()
        if ext_raw not in ("jpeg", "jpg", "png", "webp", "gif"):
            raise ErpHttpError("Unsupported image format. Use PNG, JPG, WEBP, or GIF.", status=400)
        ext = "jpg" if ext_raw in ("jpeg", "jpg") else ext_raw
        try:
            raw_bytes = base64.b64decode(match.group(2), validate=False)
        except Exception:
            raise ErpHttpError("Corrupted base64 image payload.", status=400)
        if len(raw_bytes) > MAX_IMAGE_BYTES:
            raise ErpHttpError("Image exceeds the 5 MB maximum upload size.", status=400)
        filename = f"{safe_prefix}_{int(user_id)}_{secrets.token_hex(6)}.{ext}"
        file_path = os.path.normpath(os.path.join(UPLOADS_DIR, filename))
        if not file_path.startswith(UPLOADS_DIR):
            raise ErpHttpError("Invalid upload destination.", status=400)
        with open(file_path, "wb") as f:
            f.write(raw_bytes)
        return f"/uploads/{filename}"
    if val.startswith("/uploads/") and ".." not in val:
        return val
    if val.startswith("https://"):
        return val[:500]
    raise ErpHttpError("Invalid image URL or upload path.", status=400)


def get_user_recent_activity(conn, user: dict, limit: int = 5) -> list:
    """
    Fetches the user's most recent harvest logs (default last 5) for the Twitter/X-style Profile feed.
    """
    cur = conn.cursor()
    cur.execute(
        """
        SELECT h.id, h.harvest_date, h.year_month, h.round_number AS round_no,
               h.bunches_cut AS bunches, h.fronds_cut AS fronds,
               COALESCE(h.health_status, 'Healthy') AS health_status,
               COALESCE(h.loose_fruit, 1) AS loose_fruit,
               COALESCE(h.remarks, '') AS remarks,
               h.recorded_by_name AS recorded_by, h.created_at,
               t.tree_number AS tree_no, b.name AS block_name,
               f.name AS field_name, d.name AS division_name, e.name AS estate_name
        FROM harvest_logs h
        JOIN trees t ON t.id = h.tree_id
        JOIN blocks b ON b.id = t.block_id
        JOIN fields f ON f.id = b.field_id
        JOIN divisions d ON d.id = f.division_id
        JOIN estates e ON e.id = d.estate_id
        WHERE h.recorded_by_id = ? OR LOWER(h.recorded_by_name) = LOWER(?)
        ORDER BY h.harvest_date DESC, h.id DESC
        LIMIT ?
        """,
        (user["id"], user["full_name"], limit),
    )
    return [dict(r) for r in cur.fetchall()]


def resolve_scope_estate_name(conn, params: dict) -> str:
    cur = conn.cursor()
    estate_id = safe_int(params.get("estate_id"), min_val=1)
    if estate_id:
        cur.execute("SELECT name FROM estates WHERE id = ?", (estate_id,))
        row = cur.fetchone()
        if row and row["name"]:
            return str(row["name"])
    cur.execute("SELECT name FROM estates ORDER BY id ASC LIMIT 1")
    row = cur.fetchone()
    return str(row["name"]) if (row and row["name"]) else "Elaeis"


EXCEL_MATRIX_HEADERS = [
    "Estate",
    "Division",
    "Field",
    "Block",
    "Tree Number",
    "R1 Bunches",
    "R1 Fronds",
    "R2 Bunches",
    "R2 Fronds",
    "R3 Bunches",
    "R3 Fronds",
    "Month Total Bunches",
    "Month Total Fronds",
]


def query_monthly_tree_matrix(conn, params: dict) -> tuple[str, list]:
    """
    Aggregates and pivots harvest_logs by tree_id for a selected year_month (e.g. '2026-11')
    into Round 1 (days 1-10), Round 2 (days 11-20), and Round 3 (days 21-end).
    """
    cur = conn.cursor()
    year_month = (
        params.get("year_month")
        or params.get("month")
        or (params.get("to") or "")[:7]
        or (params.get("from") or "")[:7]
        or date.today().strftime("%Y-%m")
    )
    if not re.match(r"^\d{4}-\d{2}$", year_month):
        year_month = date.today().strftime("%Y-%m")

    where_clauses = ["h.year_month = ?"]
    sql_args = [year_month]

    estate_id = safe_int(params.get("estate_id"), min_val=1)
    division_id = safe_int(params.get("division_id"), min_val=1)
    field_id = safe_int(params.get("field_id"), min_val=1)
    block_id = safe_int(params.get("block_id"), min_val=1)
    tree_id = safe_int(params.get("tree_id"), min_val=1)

    if estate_id:
        where_clauses.append("e.id = ?")
        sql_args.append(estate_id)
    if division_id:
        where_clauses.append("d.id = ?")
        sql_args.append(division_id)
    if field_id:
        where_clauses.append("f.id = ?")
        sql_args.append(field_id)
    if block_id:
        where_clauses.append("b.id = ?")
        sql_args.append(block_id)
    if tree_id:
        where_clauses.append("t.id = ?")
        sql_args.append(tree_id)

    round_expr = "COALESCE(h.round_number, CASE WHEN h.day_of_month <= 10 THEN 1 WHEN h.day_of_month <= 20 THEN 2 ELSE 3 END)"

    sql = f"""
        SELECT
            e.name AS estate_name,
            d.name AS division_name,
            f.name AS field_name,
            b.name AS block_name,
            t.id AS tree_id,
            t.tree_number AS tree_number,
            COALESCE(SUM(CASE WHEN {round_expr} = 1 THEN h.bunches_cut ELSE 0 END), 0) AS r1_bunches,
            COALESCE(SUM(CASE WHEN {round_expr} = 1 THEN h.fronds_cut ELSE 0 END), 0) AS r1_fronds,
            COALESCE(SUM(CASE WHEN {round_expr} = 2 THEN h.bunches_cut ELSE 0 END), 0) AS r2_bunches,
            COALESCE(SUM(CASE WHEN {round_expr} = 2 THEN h.fronds_cut ELSE 0 END), 0) AS r2_fronds,
            COALESCE(SUM(CASE WHEN {round_expr} = 3 THEN h.bunches_cut ELSE 0 END), 0) AS r3_bunches,
            COALESCE(SUM(CASE WHEN {round_expr} = 3 THEN h.fronds_cut ELSE 0 END), 0) AS r3_fronds
        FROM harvest_logs h
        JOIN trees t ON t.id = h.tree_id
        JOIN blocks b ON b.id = t.block_id
        JOIN fields f ON f.id = b.field_id
        JOIN divisions d ON d.id = f.division_id
        JOIN estates e ON e.id = d.estate_id
        WHERE {' AND '.join(where_clauses)}
        GROUP BY t.id, e.name, d.name, f.name, b.name, t.tree_number
        ORDER BY e.id ASC, d.id ASC, f.id ASC, b.id ASC, t.tree_number ASC
    """
    cur.execute(sql, sql_args)
    return year_month, [dict(r) for r in cur.fetchall()]


def generate_monthly_tree_matrix_xlsx(conn, params: dict) -> tuple[bytes, str]:
    """
    Generates the Monthly Tree-by-Tree 3-Round Matrix Excel (.xlsx) report using openpyxl
    (with a standards-compliant OpenXML .xlsx fallback if openpyxl is unavailable).
    Returns (xlsx_bytes, "<Estate>_Harvest_Report_<YYYY-MM>.xlsx").
    """
    year_month, rows = query_monthly_tree_matrix(conn, params)
    estate_name = (rows[0]["estate_name"] if rows else None) or resolve_scope_estate_name(conn, params)
    slug = slugify_filename(estate_name, "Elaeis")
    filename = f"{slug}_Harvest_Report_{year_month}.xlsx"

    try:
        from openpyxl import Workbook
        from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
        from openpyxl.utils import get_column_letter

        wb = Workbook()
        ws = wb.active
        ws.title = f"Tree Matrix {year_month}"

        header_font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
        header_fill = PatternFill(start_color="0F1419", end_color="0F1419", fill_type="solid")
        total_fill = PatternFill(start_color="F7F9F9", end_color="F7F9F9", fill_type="solid")
        bold_font = Font(name="Calibri", size=11, bold=True, color="0F1419")
        regular_font = Font(name="Calibri", size=11, color="0F1419")
        thin_border = Border(
            left=Side(style="thin", color="CFD9DE"),
            right=Side(style="thin", color="CFD9DE"),
            top=Side(style="thin", color="CFD9DE"),
            bottom=Side(style="thin", color="CFD9DE"),
        )

        # Write Header Row
        ws.append(EXCEL_MATRIX_HEADERS)
        for col_idx in range(1, len(EXCEL_MATRIX_HEADERS) + 1):
            cell = ws.cell(row=1, column=col_idx)
            cell.font = header_font
            cell.fill = header_fill
            cell.alignment = Alignment(horizontal="center" if col_idx > 5 else "left", vertical="center")
            cell.border = thin_border

        # Write Pivoted Tree Rows (1 Row per Tree)
        for idx, r in enumerate(rows, start=2):
            r1_b = int(r["r1_bunches"] or 0)
            r1_f = int(r["r1_fronds"] or 0)
            r2_b = int(r["r2_bunches"] or 0)
            r2_f = int(r["r2_fronds"] or 0)
            r3_b = int(r["r3_bunches"] or 0)
            r3_f = int(r["r3_fronds"] or 0)

            row_values = [
                str(r["estate_name"]),
                str(r["division_name"]),
                str(r["field_name"]),
                str(r["block_name"]),
                f"Palm #{r['tree_number']}",
                r1_b,
                r1_f,
                r2_b,
                r2_f,
                r3_b,
                r3_f,
                f"=F{idx}+H{idx}+J{idx}",
                f"=G{idx}+I{idx}+K{idx}",
            ]
            ws.append(row_values)

            for col_idx in range(1, 14):
                c = ws.cell(row=idx, column=col_idx)
                c.border = thin_border
                if col_idx >= 12:
                    c.font = bold_font
                    c.fill = total_fill
                    c.alignment = Alignment(horizontal="right", vertical="center")
                elif col_idx >= 6:
                    c.font = regular_font
                    c.alignment = Alignment(horizontal="right", vertical="center")
                else:
                    c.font = regular_font
                    c.alignment = Alignment(horizontal="left", vertical="center")

        # Auto-fit column widths
        col_widths = [18, 20, 14, 14, 15, 13, 13, 13, 13, 13, 13, 22, 22]
        for i, w in enumerate(col_widths, start=1):
            ws.column_dimensions[get_column_letter(i)].width = w
        ws.freeze_panes = "A2"

        buf = io.BytesIO()
        wb.save(buf)
        return buf.getvalue(), filename

    except ImportError:
        return _build_xlsx_zip_fallback(year_month, rows), filename


def _build_xlsx_zip_fallback(year_month: str, rows: list) -> bytes:
    """
    Pure-Python OpenXML (.xlsx) generator fallback when openpyxl is not installed.
    Writes the exact 13-column structure with text cells, integer cells, and Excel SUM formulas.
    """
    col_letters = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M"]
    sheet_rows_xml = []

    # Row 1: Headers
    header_cells = []
    for c_idx, h_text in enumerate(EXCEL_MATRIX_HEADERS):
        ref = f"{col_letters[c_idx]}1"
        header_cells.append(f'<c r="{ref}" s="1" t="inlineStr"><is><t>{xml_escape(h_text)}</t></is></c>')
    sheet_rows_xml.append(f'<row r="1" ht="24" customHeight="1">{"".join(header_cells)}</row>')

    # Rows 2..N: Pivoted Tree Rows
    for idx, r in enumerate(rows, start=2):
        r1_b = int(r["r1_bunches"] or 0)
        r1_f = int(r["r1_fronds"] or 0)
        r2_b = int(r["r2_bunches"] or 0)
        r2_f = int(r["r2_fronds"] or 0)
        r3_b = int(r["r3_bunches"] or 0)
        r3_f = int(r["r3_fronds"] or 0)
        tot_b = r1_b + r2_b + r3_b
        tot_f = r1_f + r2_f + r3_f

        text_cols = [
            str(r["estate_name"]),
            str(r["division_name"]),
            str(r["field_name"]),
            str(r["block_name"]),
            f"Palm #{r['tree_number']}",
        ]
        int_cols = [r1_b, r1_f, r2_b, r2_f, r3_b, r3_f]

        cells = []
        for c_idx, val in enumerate(text_cols):
            ref = f"{col_letters[c_idx]}{idx}"
            cells.append(f'<c r="{ref}" s="2" t="inlineStr"><is><t>{xml_escape(val)}</t></is></c>')
        for offset, val in enumerate(int_cols):
            ref = f"{col_letters[5 + offset]}{idx}"
            cells.append(f'<c r="{ref}" s="3" t="n"><v>{val}</v></c>')

        # Column L: Month Total Bunches (Formula + cached integer value)
        cells.append(f'<c r="L{idx}" s="4" t="n"><f>F{idx}+H{idx}+J{idx}</f><v>{tot_b}</v></c>')
        # Column M: Month Total Fronds (Formula + cached integer value)
        cells.append(f'<c r="M{idx}" s="4" t="n"><f>G{idx}+I{idx}+K{idx}</f><v>{tot_f}</v></c>')

        sheet_rows_xml.append(f'<row r="{idx}" ht="20" customHeight="1">{"".join(cells)}</row>')

    sheet_xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>
    <col min="1" max="2" width="20" customWidth="1"/>
    <col min="3" max="5" width="15" customWidth="1"/>
    <col min="6" max="11" width="13" customWidth="1"/>
    <col min="12" max="13" width="22" customWidth="1"/>
  </cols>
  <sheetData>{"".join(sheet_rows_xml)}</sheetData>
</worksheet>"""

    styles_xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="3">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FF0F1419"/><name val="Calibri"/></font>
  </fonts>
  <fills count="4">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF0F1419"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF7F9F9"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFCFD9DE"/></left>
      <right style="thin"><color rgb="FFCFD9DE"/></right>
      <top style="thin"><color rgb="FFCFD9DE"/></top>
      <bottom style="thin"><color rgb="FFCFD9DE"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="5">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
    <xf numFmtId="1" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="1" fontId="2" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
  </cellXfs>
</styleSheet>"""

    workbook_xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Tree Matrix {xml_escape(year_month)}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>"""

    wb_rels_xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"""

    root_rels_xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"""

    content_types_xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>"""

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types_xml)
        zf.writestr("_rels/.rels", root_rels_xml)
        zf.writestr("xl/workbook.xml", workbook_xml)
        zf.writestr("xl/_rels/workbook.xml.rels", wb_rels_xml)
        zf.writestr("xl/styles.xml", styles_xml)
        zf.writestr("xl/worksheets/sheet1.xml", sheet_xml)
    return out.getvalue()


class ElaeisErpHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send_security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")

    def _send_json(self, data, status=200):
        body = json.dumps(data, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self._send_security_headers()
        self.end_headers()
        self.wfile.write(body)

    def _send_csv(self, csv_text: str, filename: str):
        body = csv_text.encode("utf-8-sig")
        self.send_response(200)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Access-Control-Expose-Headers", "Content-Disposition")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._send_security_headers()
        self.end_headers()
        self.wfile.write(body)

    def _send_xlsx(self, xlsx_bytes: bytes, filename: str = "Elaeis_Harvest_Report.xlsx"):
        self.send_response(200)
        self.send_header(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(xlsx_bytes)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Expose-Headers", "Content-Disposition")
        self._send_security_headers()
        self.end_headers()
        self.wfile.write(xlsx_bytes)

    def _read_json(self):
        length = safe_int(self.headers.get("Content-Length", 0), default=0, min_val=0, max_val=15 * 1024 * 1024)
        if length == 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8", errors="replace")
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}

    def _get_current_user(self, conn, params=None):
        auth = self.headers.get("Authorization", "")
        token = auth[7:].strip() if auth.startswith("Bearer ") else ""
        if not token and isinstance(params, dict):
            token = str(params.get("token") or "").strip()
        if not token:
            return None
        now_iso = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
        cur = conn.cursor()
        cur.execute(
            """
            SELECT u.*
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token = ? AND (s.expires_at IS NULL OR s.expires_at > ?)
            """,
            (token, now_iso),
        )
        row = cur.fetchone()
        if not row:
            return None
        u = format_user(row)
        u["token"] = token
        return u

    def _require_role(self, conn, min_role="Harvester", params=None):
        user = self._get_current_user(conn, params=params)
        if not user:
            self._send_json({"error": "Authentication required. Please log in."}, status=401)
            return None
        if role_rank(user["role"]) < role_rank(min_role):
            self._send_json({"error": "Insufficient role permissions for this operation."}, status=403)
            return None
        return user

    def _handle_route_error(self, err: Exception):
        if isinstance(err, ErpHttpError):
            self._send_json({"error": err.message}, status=err.status)
        elif isinstance(err, sqlite3.IntegrityError):
            self._send_json(
                {"error": "Database constraint conflict: record already exists or references invalid data."},
                status=409,
            )
        elif isinstance(err, sqlite3.Error):
            self._send_json(
                {"error": "A database error occurred while processing your request."},
                status=500,
            )
        elif isinstance(err, (ValueError, TypeError)):
            self._send_json(
                {"error": "Invalid input parameter format provided."},
                status=400,
            )
        else:
            self._send_json(
                {"error": "An internal server error occurred. Please try again."},
                status=500,
            )

    def do_OPTIONS(self):
        self._send_json({"ok": True})

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = {k: v[0] for k, v in parse_qs(parsed.query).items()}

        if path.startswith("/api/") or path in ("/export/excel", "/report.xlsx"):
            conn = get_connection()
            try:
                self.handle_api_get(path, params, conn)
            except Exception as err:
                self._handle_route_error(err)
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
            ".webmanifest": "application/manifest+json; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".gif": "image/gif",
            ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }
        with open(file_path, "rb") as f:
            content = f.read()
        self.send_response(200)
        self.send_header("Content-Type", mime_map.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(content)))
        self._send_security_headers()
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        data = self._read_json()

        if path.startswith("/api/") or path in ("/export/excel", "/report.xlsx"):
            conn = get_connection()
            try:
                if path in ("/export/excel", "/api/export/excel", "/api/report.xlsx", "/report.xlsx"):
                    merged_params = {**params, **data}
                    user = self._require_role(conn, "Harvester", params=merged_params)
                    if user:
                        xlsx_bytes, filename = generate_monthly_tree_matrix_xlsx(conn, merged_params)
                        self._send_xlsx(xlsx_bytes, filename)
                else:
                    self.handle_api_post(path, data, conn)
            except Exception as err:
                self._handle_route_error(err)
            finally:
                conn.close()
            return

        self._send_json({"error": "Not found"}, status=404)

    # -------------------------------------------------------------------------
    # GET API ROUTES
    # -------------------------------------------------------------------------
    def handle_api_get(self, path, params, conn):
        cur = conn.cursor()

        if path == "/api/health":
            return self._send_json(
                {
                    "ok": True,
                    "service": "elaeis",
                    "runtime": "python-sqlite",
                    "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                }
            )

        if path == "/api/auth/me":
            user = self._get_current_user(conn, params=params)
            if not user:
                return self._send_json({"error": "Not authenticated"}, status=401)
            recent_activity = get_user_recent_activity(conn, user, limit=5)
            return self._send_json({"user": user, "recent_activity": recent_activity})

        if path == "/api/profile/activity":
            user = self._require_role(conn, "Harvester", params=params)
            if not user:
                return
            recent_activity = get_user_recent_activity(conn, user, limit=5)
            return self._send_json({"recent_activity": recent_activity})

        if path in ("/export/excel", "/api/export/excel", "/api/report.xlsx", "/report.xlsx"):
            user = self._require_role(conn, "Harvester", params=params)
            if not user:
                return
            xlsx_bytes, filename = generate_monthly_tree_matrix_xlsx(conn, params)
            return self._send_xlsx(xlsx_bytes, filename)

        if path == "/api/report/matrix":
            user = self._require_role(conn, "Harvester", params=params)
            if not user:
                return
            year_month, rows = query_monthly_tree_matrix(conn, params)
            return self._send_json({"year_month": year_month, "rows": rows})

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
                "season_start_month": int(s_map.get("season_start_month", 4)),
            }

            cur.execute(
                """
                SELECT id, block_id, tree_number AS tree_no, latitude AS lat, longitude AS lng, gps_acc
                FROM trees
                WHERE status = 'active' AND latitude IS NOT NULL AND longitude IS NOT NULL
                ORDER BY block_id ASC, tree_number ASC
                """
            )
            mapped_trees = [dict(r) for r in cur.fetchall()]

            return self._send_json(
                {
                    "hierarchy": {
                        "estates": estates,
                        "divisions": divisions,
                        "fields": fields,
                        "blocks": blocks,
                    },
                    "settings": settings,
                    "mapped_trees": mapped_trees,
                }
            )

        if path == "/api/trees/mapped":
            user = self._require_role(conn, "Harvester")
            if not user:
                return
            cur.execute(
                """
                SELECT id, block_id, tree_number AS tree_no, latitude AS lat, longitude AS lng, gps_acc
                FROM trees
                WHERE status = 'active' AND latitude IS NOT NULL AND longitude IS NOT NULL
                ORDER BY block_id ASC, tree_number ASC
                """
            )
            return self._send_json({"trees": [dict(r) for r in cur.fetchall()]})

        if path == "/api/trees/nearest":
            user = self._require_role(conn, "Harvester")
            if not user:
                return
            u_lat = safe_float(params.get("lat"))
            u_lng = safe_float(params.get("lng"))
            max_radius_m = safe_float(params.get("max_radius_m"), default=100.0, min_val=1.0, max_val=5000.0)
            block_id = safe_int(params.get("block_id"), min_val=1)
            if u_lat is None or u_lng is None:
                return self._send_json({"tree": None})

            lat_delta = (max_radius_m / 111320.0) * 1.25
            cos_lat = max(0.1, math.cos(math.radians(u_lat)))
            lng_delta = (max_radius_m / (111320.0 * cos_lat)) * 1.25

            cur.execute(
                """
                SELECT t.id, t.block_id, t.tree_number AS tree_no, t.latitude AS lat, t.longitude AS lng,
                       t.gps_acc, b.field_id, f.division_id
                FROM trees t
                JOIN blocks b ON b.id = t.block_id
                JOIN fields f ON f.id = b.field_id
                WHERE t.status = 'active'
                  AND t.latitude BETWEEN ? AND ?
                  AND t.longitude BETWEEN ? AND ?
                """,
                (u_lat - lat_delta, u_lat + lat_delta, u_lng - lng_delta, u_lng + lng_delta),
            )
            best_tree = None
            best_dist = None
            for r in cur.fetchall():
                d = distance_m(u_lat, u_lng, r["lat"], r["lng"])
                if d is None:
                    continue
                if best_dist is None or d < best_dist or (d == best_dist and block_id and r["block_id"] == block_id):
                    best_dist = d
                    best_tree = {**dict(r), "distance_m": d}

            if best_tree and best_dist is not None and best_dist <= max_radius_m:
                return self._send_json({"tree": best_tree, "distance_m": best_dist})
            return self._send_json({"tree": None, "distance_m": best_dist})

        if path == "/api/map/trees":
            user = self._require_role(conn, "Harvester", params=params)
            if not user:
                return
            from_d = params.get("from") or "1900-01-01"
            to_d = params.get("to") or "2999-12-31"
            round_no = safe_int(params.get("round_no"), min_val=1, max_val=3)
            estate_id = safe_int(params.get("estate_id"), min_val=1)
            division_id = safe_int(params.get("division_id"), min_val=1)
            field_id = safe_int(params.get("field_id"), min_val=1)
            block_id = safe_int(params.get("block_id"), min_val=1)
            isolate = str(params.get("isolate") or "0").lower() in ("1", "true", "yes")

            h_conds = ["h.harvest_date >= ?", "h.harvest_date <= ?"]
            h_args = [from_d, to_d]
            if round_no in (1, 2, 3):
                h_conds.append("h.round_number = ?")
                h_args.append(round_no)

            t_conds = ["t.status = 'active'"]
            t_args = []
            if estate_id:
                t_conds.append("e.id = ?")
                t_args.append(estate_id)
            if isolate:
                if block_id:
                    t_conds.append("b.id = ?")
                    t_args.append(block_id)
                elif field_id:
                    t_conds.append("f.id = ?")
                    t_args.append(field_id)
                elif division_id:
                    t_conds.append("d.id = ?")
                    t_args.append(division_id)

            mapped_conds = t_conds + ["t.latitude IS NOT NULL", "t.longitude IS NOT NULL"]
            sql = f"""
                SELECT
                    t.id,
                    t.tree_number AS tree_no,
                    t.tree_code,
                    t.latitude AS lat,
                    t.longitude AS lng,
                    COALESCE(t.health_status, 'Healthy') AS health_status,
                    b.id AS block_id,
                    b.name AS block_name,
                    f.id AS field_id,
                    f.name AS field_name,
                    d.id AS division_id,
                    d.name AS division_name,
                    e.id AS estate_id,
                    e.name AS estate_name,
                    COALESCE(h_agg.bunches, 0) AS bunches,
                    COALESCE(h_agg.fronds, 0) AS fronds
                FROM trees t
                JOIN blocks b ON b.id = t.block_id
                JOIN fields f ON f.id = b.field_id
                JOIN divisions d ON d.id = f.division_id
                JOIN estates e ON e.id = d.estate_id
                LEFT JOIN (
                    SELECT tree_id,
                           SUM(bunches_cut) AS bunches,
                           SUM(fronds_cut) AS fronds
                    FROM harvest_logs h
                    WHERE {' AND '.join(h_conds)}
                    GROUP BY tree_id
                ) h_agg ON h_agg.tree_id = t.id
                WHERE {' AND '.join(mapped_conds)}
                ORDER BY d.id ASC, f.id ASC, b.id ASC, t.tree_number ASC
            """
            cur.execute(sql, h_args + t_args)

            trees_out = []
            harvested_count = 0
            for r in cur.fetchall():
                bunches = int(r["bunches"] or 0)
                fronds = int(r["fronds"] or 0)
                is_harv = bunches > 0
                if is_harv:
                    harvested_count += 1
                trees_out.append(
                    {
                        "id": r["id"],
                        "tree_no": r["tree_no"],
                        "tree_code": r["tree_code"] or f"T-{int(r['tree_no']):03d}",
                        "lat": r["lat"],
                        "lng": r["lng"],
                        "health_status": r["health_status"] or "Healthy",
                        "block_id": r["block_id"],
                        "block_name": r["block_name"],
                        "field_id": r["field_id"],
                        "field_name": r["field_name"],
                        "division_id": r["division_id"],
                        "division_name": r["division_name"],
                        "estate_id": r["estate_id"],
                        "estate_name": r["estate_name"],
                        "harvested": is_harv,
                        "bunches": bunches,
                        "fronds": fronds,
                    }
                )

            cur.execute(
                f"""
                SELECT COUNT(t.id) AS cnt
                FROM trees t
                JOIN blocks b ON b.id = t.block_id
                JOIN fields f ON f.id = b.field_id
                JOIN divisions d ON d.id = f.division_id
                JOIN estates e ON e.id = d.estate_id
                WHERE {' AND '.join(t_conds)} AND (t.latitude IS NULL OR t.longitude IS NULL)
                """,
                t_args,
            )
            unmapped_count = int(cur.fetchone()["cnt"] or 0)

            return self._send_json(
                {
                    "from": from_d,
                    "to": to_d,
                    "round_no": round_no,
                    "total_trees": len(trees_out),
                    "unmapped_trees": unmapped_count,
                    "harvested_trees": harvested_count,
                    "trees": trees_out,
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
                       gps_acc, status, COALESCE(health_status, 'Healthy') AS health_status, mapped_at
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
                           harvest_date, round_number AS round_no,
                           COALESCE(health_status, 'Healthy') AS health_status,
                           COALESCE(loose_fruit, 1) AS loose_fruit,
                           COALESCE(remarks, '') AS remarks
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
            div_id = safe_int(params.get("division_id"), min_val=1)
            estate_id = safe_int(params.get("estate_id"), min_val=1)
            round_no = safe_int(params.get("round_no"), min_val=1, max_val=3)
            where_d = []
            args_d = []
            if div_id:
                where_d.append("d.division_id = ?")
                args_d.append(div_id)
            if estate_id:
                where_d.append("dv.estate_id = ?")
                args_d.append(estate_id)
            if round_no:
                where_d.append("d.round_number = ?")
                args_d.append(round_no)
            clause = f"WHERE {' AND '.join(where_d)}" if where_d else ""
            cur.execute(
                f"""
                SELECT d.id, d.division_id, d.dispatch_date, d.year_month,
                       d.round_number AS round_no, d.weight_kg, d.client_id,
                       d.recorded_by_name AS recorded_by, d.created_at AS recorded_at,
                       dv.name AS division_name
                FROM dispatch_logs d
                JOIN divisions dv ON dv.id = d.division_id
                {clause}
                ORDER BY d.dispatch_date DESC, d.id DESC
                LIMIT 200
                """,
                args_d,
            )
            return self._send_json({"dispatches": [dict(r) for r in cur.fetchall()]})

        if path == "/api/analytics/agronomy":
            user = self._require_role(conn, "Harvester", params=params)
            if not user:
                return
            from_d = params.get("from") or "1900-01-01"
            to_d = params.get("to") or "2999-12-31"
            estate_id = safe_int(params.get("estate_id"), min_val=1)
            division_id = safe_int(params.get("division_id"), min_val=1)
            field_id = safe_int(params.get("field_id"), min_val=1)
            block_id = safe_int(params.get("block_id"), min_val=1)
            round_no = safe_int(params.get("round_no"), min_val=1, max_val=3)

            scope_where = ["t.status = 'active'"]
            scope_args = []
            if block_id:
                scope_where.append("b.id = ?")
                scope_args.append(block_id)
            elif field_id:
                scope_where.append("f.id = ?")
                scope_args.append(field_id)
            elif division_id:
                scope_where.append("d.id = ?")
                scope_args.append(division_id)
            elif estate_id:
                scope_where.append("e.id = ?")
                scope_args.append(estate_id)
            scope_sql = " AND ".join(scope_where)

            h_where = ["h.harvest_date >= ?", "h.harvest_date <= ?"]
            h_args = [from_d, to_d]
            if block_id:
                h_where.append("b.id = ?")
                h_args.append(block_id)
            elif field_id:
                h_where.append("f.id = ?")
                h_args.append(field_id)
            elif division_id:
                h_where.append("d.id = ?")
                h_args.append(division_id)
            elif estate_id:
                h_where.append("e.id = ?")
                h_args.append(estate_id)

            h_where_rnd = list(h_where)
            h_args_rnd = list(h_args)
            if round_no:
                h_where_rnd.append("h.round_number = ?")
                h_args_rnd.append(round_no)

            d_where = ["x.dispatch_date >= ?", "x.dispatch_date <= ?"]
            d_args = [from_d, to_d]
            if division_id:
                d_where.append("d.id = ?")
                d_args.append(division_id)
            elif estate_id:
                d_where.append("d.estate_id = ?")
                d_args.append(estate_id)

            d_where_rnd = list(d_where)
            d_args_rnd = list(d_args)
            if round_no:
                d_where_rnd.append("x.round_number = ?")
                d_args_rnd.append(round_no)

            div_where = []
            div_args = []
            if division_id:
                div_where.append("d.id = ?")
                div_args.append(division_id)
            elif estate_id:
                div_where.append("d.estate_id = ?")
                div_args.append(estate_id)
            div_clause = f"WHERE {' AND '.join(div_where)}" if div_where else ""

            cur.execute(
                f"""
                SELECT d.id AS division_id, COUNT(t.id) AS active_trees
                FROM trees t
                JOIN blocks b ON b.id = t.block_id
                JOIN fields f ON f.id = b.field_id
                JOIN divisions d ON d.id = f.division_id
                JOIN estates e ON e.id = d.estate_id
                WHERE {scope_sql}
                GROUP BY d.id
                """,
                scope_args,
            )
            stand_by_div = {r["division_id"]: int(r["active_trees"] or 0) for r in cur.fetchall()}
            total_active = sum(stand_by_div.values())

            cur.execute(
                f"""
                SELECT h.round_number AS round_no,
                       COALESCE(SUM(h.bunches_cut), 0) AS bunches,
                       COALESCE(SUM(h.fronds_cut), 0) AS fronds,
                       COUNT(DISTINCT h.tree_id) AS harvested_trees
                FROM harvest_logs h
                JOIN trees t ON t.id = h.tree_id
                JOIN blocks b ON b.id = t.block_id
                JOIN fields f ON f.id = b.field_id
                JOIN divisions d ON d.id = f.division_id
                JOIN estates e ON e.id = d.estate_id
                WHERE {' AND '.join(h_where)}
                GROUP BY h.round_number
                """,
                h_args,
            )
            rh_map = {int(r["round_no"]): dict(r) for r in cur.fetchall()}

            cur.execute(
                f"""
                SELECT x.round_number AS round_no, COALESCE(SUM(x.weight_kg), 0) AS dispatch_kg
                FROM dispatch_logs x JOIN divisions d ON d.id = x.division_id
                WHERE {' AND '.join(d_where)}
                GROUP BY x.round_number
                """,
                d_args,
            )
            rd_map = {int(r["round_no"]): float(r["dispatch_kg"] or 0.0) for r in cur.fetchall()}

            rounds = []
            for rn in (1, 2, 3):
                rh = rh_map.get(rn, {})
                b_cnt = int(rh.get("bunches") or 0)
                f_cnt = int(rh.get("fronds") or 0)
                h_trees = int(rh.get("harvested_trees") or 0)
                d_kg = rd_map.get(rn, 0.0)
                rounds.append(
                    {
                        "round_no": rn,
                        "bunches": b_cnt,
                        "fronds": f_cnt,
                        "fbr": round(f_cnt / b_cnt, 2) if b_cnt > 0 else 0.0,
                        "harvested_trees": h_trees,
                        "coverage_pct": round((h_trees / total_active) * 100.0, 1) if total_active > 0 else 0.0,
                        "dispatch_kg": round(d_kg, 1),
                        "abw": round(d_kg / b_cnt, 2) if b_cnt > 0 else 0.0,
                    }
                )

            cur.execute(f"SELECT d.id, d.name, d.estate_id FROM divisions d {div_clause} ORDER BY d.id ASC", div_args)
            div_rows = [dict(r) for r in cur.fetchall()]

            cur.execute(
                f"""
                SELECT f.division_id, COALESCE(SUM(f.area_ha), 0) AS area_ha
                FROM fields f JOIN divisions d ON d.id = f.division_id {div_clause}
                GROUP BY f.division_id
                """,
                div_args,
            )
            ha_by_div = {r["division_id"]: float(r["area_ha"] or 0.0) for r in cur.fetchall()}

            cur.execute(
                f"""
                SELECT d.id AS division_id,
                       COALESCE(SUM(h.bunches_cut), 0) AS bunches,
                       COALESCE(SUM(h.fronds_cut), 0) AS fronds,
                       COUNT(DISTINCT h.tree_id) AS harvested_trees
                FROM harvest_logs h
                JOIN trees t ON t.id = h.tree_id
                JOIN blocks b ON b.id = t.block_id
                JOIN fields f ON f.id = b.field_id
                JOIN divisions d ON d.id = f.division_id
                JOIN estates e ON e.id = d.estate_id
                WHERE {' AND '.join(h_where_rnd)}
                GROUP BY d.id
                """,
                h_args_rnd,
            )
            harv_by_div = {r["division_id"]: dict(r) for r in cur.fetchall()}

            cur.execute(
                f"""
                SELECT d.id AS division_id, COALESCE(SUM(x.weight_kg), 0) AS dispatch_kg
                FROM dispatch_logs x JOIN divisions d ON d.id = x.division_id
                WHERE {' AND '.join(d_where_rnd)}
                GROUP BY d.id
                """,
                d_args_rnd,
            )
            disp_by_div = {r["division_id"]: float(r["dispatch_kg"] or 0.0) for r in cur.fetchall()}

            divisions_out = []
            for dv in div_rows:
                did = dv["id"]
                area_ha = ha_by_div.get(did, 0.0)
                active_t = stand_by_div.get(did, 0)
                hv = harv_by_div.get(did, {})
                b_cnt = int(hv.get("bunches") or 0)
                f_cnt = int(hv.get("fronds") or 0)
                h_trees = int(hv.get("harvested_trees") or 0)
                d_kg = disp_by_div.get(did, 0.0)
                divisions_out.append(
                    {
                        "id": did,
                        "name": dv["name"],
                        "area_ha": round(area_ha, 2),
                        "active_trees": active_t,
                        "harvested_trees": h_trees,
                        "coverage_pct": round((h_trees / active_t) * 100.0, 1) if active_t > 0 else 0.0,
                        "bunches": b_cnt,
                        "fronds": f_cnt,
                        "fbr": round(f_cnt / b_cnt, 2) if b_cnt > 0 else 0.0,
                        "dispatch_kg": round(d_kg, 1),
                        "abw": round(d_kg / b_cnt, 2) if b_cnt > 0 else 0.0,
                        "yph": round(d_kg / area_ha, 2) if area_ha > 0 else 0.0,
                    }
                )

            cur.execute(
                f"""
                SELECT COALESCE(t.health_status, 'Healthy') AS health_status, COUNT(t.id) AS cnt
                FROM trees t
                JOIN blocks b ON b.id = t.block_id
                JOIN fields f ON f.id = b.field_id
                JOIN divisions d ON d.id = f.division_id
                JOIN estates e ON e.id = d.estate_id
                WHERE {scope_sql}
                GROUP BY COALESCE(t.health_status, 'Healthy')
                """,
                scope_args,
            )
            health_breakdown = {}
            flagged_trees = 0
            for r in cur.fetchall():
                k = r["health_status"] or "Healthy"
                c = int(r["cnt"] or 0)
                health_breakdown[k] = c
                if k != "Healthy":
                    flagged_trees += c

            cur.execute(
                f"""
                SELECT COUNT(h.id) AS total_logs,
                       SUM(CASE WHEN COALESCE(h.loose_fruit, 1) = 1 THEN 1 ELSE 0 END) AS loose_collected
                FROM harvest_logs h
                JOIN trees t ON t.id = h.tree_id
                JOIN blocks b ON b.id = t.block_id
                JOIN fields f ON f.id = b.field_id
                JOIN divisions d ON d.id = f.division_id
                JOIN estates e ON e.id = d.estate_id
                WHERE {' AND '.join(h_where_rnd)}
                """,
                h_args_rnd,
            )
            l_row = cur.fetchone()
            total_logs = int(l_row["total_logs"] or 0)
            loose_col = int(l_row["loose_collected"] or 0)
            loose_pct = round((loose_col / total_logs) * 100.0, 1) if total_logs > 0 else 100.0

            sum_b = sum(x["bunches"] for x in divisions_out)
            sum_f = sum(x["fronds"] for x in divisions_out)
            sum_ht = sum(x["harvested_trees"] for x in divisions_out)
            fbr = round(sum_f / sum_b, 2) if sum_b > 0 else 0.0
            pruning_status = (
                "No Data" if sum_b == 0 else ("Over-Pruned" if fbr > 2.0 else ("Under-Pruned" if fbr < 0.7 else "Optimal"))
            )

            return self._send_json(
                {
                    "from": from_d,
                    "to": to_d,
                    "rounds": rounds,
                    "divisions": divisions_out,
                    "health": {
                        "breakdown": health_breakdown,
                        "flagged_trees": flagged_trees,
                        "loose_fruit_pct": loose_pct,
                    },
                    "summary": {
                        "active_trees": total_active,
                        "harvested_trees": sum_ht,
                        "coverage_pct": round((sum_ht / total_active) * 100.0, 1) if total_active > 0 else 0.0,
                        "fbr": fbr,
                        "pruning_status": pruning_status,
                        "flagged_trees": flagged_trees,
                        "loose_fruit_pct": loose_pct,
                    },
                }
            )

        if path in ("/api/report", "/api/report.csv"):
            user = self._require_role(conn, "Harvester")
            if not user:
                return
            from_d = params.get("from") or "1900-01-01"
            to_d = params.get("to") or "2999-12-31"
            round_no = safe_int(params.get("round_no"), min_val=1, max_val=3)
            estate_id = safe_int(params.get("estate_id"), min_val=1)
            division_id = safe_int(params.get("division_id"), min_val=1)
            field_id = safe_int(params.get("field_id"), min_val=1)
            block_id = safe_int(params.get("block_id"), min_val=1)
            tree_id = safe_int(params.get("tree_id"), min_val=1)

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
            elif estate_id:
                cur.execute(
                    "SELECT COALESCE(SUM(f.area_ha), 0) AS ha FROM fields f JOIN divisions d ON d.id = f.division_id WHERE d.estate_id = ?",
                    (estate_id,),
                )
                total_ha = float(cur.fetchone()["ha"] or 0.0)
            else:
                cur.execute("SELECT COALESCE(SUM(area_ha), 0) AS ha FROM fields")
                total_ha = float(cur.fetchone()["ha"] or 0.0)

            stand_where = ["t.status = 'active'"]
            stand_args = []
            if tree_id:
                stand_where.append("t.id = ?")
                stand_args.append(tree_id)
            elif block_id:
                stand_where.append("b.id = ?")
                stand_args.append(block_id)
            elif field_id:
                stand_where.append("f.id = ?")
                stand_args.append(field_id)
            elif division_id:
                stand_where.append("d.id = ?")
                stand_args.append(division_id)
            elif estate_id:
                stand_where.append("d.estate_id = ?")
                stand_args.append(estate_id)
            cur.execute(
                f"""
                SELECT COUNT(t.id) AS active_trees,
                       SUM(CASE WHEN COALESCE(t.health_status, 'Healthy') != 'Healthy' THEN 1 ELSE 0 END) AS flagged_trees
                FROM trees t
                JOIN blocks b ON b.id = t.block_id
                JOIN fields f ON f.id = b.field_id
                JOIN divisions d ON d.id = f.division_id
                WHERE {' AND '.join(stand_where)}
                """,
                stand_args,
            )
            st_row = cur.fetchone()
            active_trees = int(st_row["active_trees"] or 0)
            flagged_trees = int(st_row["flagged_trees"] or 0)

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

            where_d = ["x.dispatch_date >= ?", "x.dispatch_date <= ?"]
            args_d = [from_d, to_d]
            if round_no in (1, 2, 3):
                where_d.append("x.round_number = ?")
                args_d.append(round_no)
            if target_div_id:
                where_d.append("x.division_id = ?")
                args_d.append(target_div_id)
            elif estate_id:
                where_d.append("d.estate_id = ?")
                args_d.append(estate_id)

            cur.execute(
                f"""
                SELECT COALESCE(SUM(x.weight_kg), 0) AS dispatch_kg,
                       COUNT(x.id) AS dispatch_records
                FROM dispatch_logs x
                JOIN divisions d ON d.id = x.division_id
                WHERE {' AND '.join(where_d)}
                """,
                args_d,
            )
            d_tot = dict(cur.fetchone())

            bunches = int(h_tot["bunches"] or 0)
            fronds = int(h_tot["fronds"] or 0)
            harvested_trees = int(h_tot["trees"] or 0)
            dispatch_kg = float(d_tot["dispatch_kg"] or 0.0)
            abw = round(dispatch_kg / bunches, 2) if bunches > 0 else 0.0
            yph = round(dispatch_kg / total_ha, 2) if total_ha > 0 else 0.0
            fbr = round(fronds / bunches, 2) if bunches > 0 else 0.0
            coverage_pct = round((harvested_trees / active_trees) * 100.0, 1) if active_trees > 0 else 0.0
            estate_name = resolve_scope_estate_name(conn, params)

            cur.execute(
                f"""
                SELECT h.id, h.harvest_date, h.round_number AS round_no,
                       h.bunches_cut AS bunches, h.fronds_cut AS fronds,
                       COALESCE(h.health_status, 'Healthy') AS health_status,
                       COALESCE(h.loose_fruit, 1) AS loose_fruit,
                       COALESCE(h.remarks, '') AS remarks,
                       h.recorded_by_name AS recorded_by,
                       t.tree_number AS tree_no, b.name AS block_name,
                       f.name AS field_name, d.name AS division_name, e.name AS estate_name
                FROM harvest_logs h
                JOIN trees t ON t.id = h.tree_id
                JOIN blocks b ON b.id = t.block_id
                JOIN fields f ON f.id = b.field_id
                JOIN divisions d ON d.id = f.division_id
                JOIN estates e ON e.id = d.estate_id
                WHERE {where_sql}
                ORDER BY h.harvest_date DESC, h.id DESC
                LIMIT 15
                """,
                args_h,
            )
            recent_logs = [dict(r) for r in cur.fetchall()]

            if path == "/api/report.csv":
                slug = slugify_filename(estate_name, "Elaeis")
                out = io.StringIO()
                writer = csv.writer(out)
                writer.writerow(["Metric", "Value"])
                writer.writerow(["Estate", estate_name])
                writer.writerow(["From Date", from_d])
                writer.writerow(["To Date", to_d])
                writer.writerow(["Total Bunches Cut", bunches])
                writer.writerow(["Total Fronds Cut", fronds])
                writer.writerow(["Frond-to-Bunch Ratio (FBR)", fbr])
                writer.writerow(["Active Palms", active_trees])
                writer.writerow(["Harvested Palms", harvested_trees])
                writer.writerow(["Harvest Coverage (%)", coverage_pct])
                writer.writerow(["Flagged Health Palms", flagged_trees])
                writer.writerow(["Total Dispatched Weight (kg)", dispatch_kg])
                writer.writerow(["Selected Area (Ha)", total_ha])
                writer.writerow(["Average Bunch Weight ABW (kg/bunch)", abw])
                writer.writerow(["Yield Per Hectare YPH (kg/Ha)", yph])
                return self._send_csv(out.getvalue(), f"{slug}_KPI_Report_{from_d}_{to_d}.csv")

            return self._send_json(
                {
                    "from": from_d,
                    "to": to_d,
                    "estate_name": estate_name,
                    "totals": {
                        "bunches": bunches,
                        "fronds": fronds,
                        "records": int(h_tot["records"] or 0),
                        "trees": harvested_trees,
                        "active_trees": active_trees,
                        "flagged_trees": flagged_trees,
                        "coverage_pct": coverage_pct,
                        "fbr": fbr,
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

            now_iso = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
            expires_iso = (datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=SESSION_TTL_DAYS)).isoformat()
            cur.execute("DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at <= ?", (now_iso,))
            token = secrets.token_hex(32)
            cur.execute(
                "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
                (token, user_row["id"], expires_iso),
            )
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

        # 3c. Edit Profile (Full Name, Username, Profile Picture & Cover Photo)
        if path in ("/api/profile/update", "/api/auth/profile"):
            user = self._require_role(conn, "Harvester")
            if not user:
                return
            full_name = str(data.get("full_name") or user["full_name"]).strip()
            username = str(data.get("username") or user["username"]).strip().lower().lstrip("@")
            if not full_name or not username:
                return self._send_json({"error": "Full Name and Username are required."}, status=400)
            if not re.match(r"^[a-z0-9_.-]{2,40}$", username):
                return self._send_json(
                    {"error": "Username must be 2-40 characters (letters, numbers, _, ., -)."},
                    status=400,
                )

            cur.execute("SELECT id FROM users WHERE LOWER(username) = ? AND id != ?", (username, user["id"]))
            if cur.fetchone():
                return self._send_json({"error": f"Username '@{username}' is already taken."}, status=409)

            profile_pic = user.get("profile_pic") or ""
            cover_photo = user.get("cover_photo") or ""

            if "profile_pic" in data and data["profile_pic"] is not None:
                profile_pic = save_uploaded_image(data["profile_pic"], "avatar", user["id"])
            if "cover_photo" in data and data["cover_photo"] is not None:
                cover_photo = save_uploaded_image(data["cover_photo"], "cover", user["id"])

            cur.execute(
                """
                UPDATE users
                SET full_name = ?, username = ?, profile_pic = ?, cover_photo = ?
                WHERE id = ?
                """,
                (full_name, username, profile_pic, cover_photo, user["id"]),
            )
            cur.execute(
                "UPDATE harvest_logs SET recorded_by_name = ? WHERE recorded_by_id = ?",
                (full_name, user["id"]),
            )
            cur.execute(
                "UPDATE dispatch_logs SET recorded_by_name = ? WHERE recorded_by_id = ?",
                (full_name, user["id"]),
            )
            conn.commit()

            cur.execute("SELECT * FROM users WHERE id = ?", (user["id"],))
            updated_user = format_user(cur.fetchone())
            return self._send_json(
                {
                    "ok": True,
                    "message": "Profile updated successfully.",
                    "user": updated_user,
                }
            )
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

        # 4. Log Tree Harvest (Supports Agronomy Telemetry + Offline Sync)
        if path == "/api/harvest":
            user = self._require_role(conn, "Harvester")
            if not user:
                return
            res = self._apply_harvest_op(conn, user, data)
            conn.commit()
            return self._send_json(res)

        # 4b. Offline-First Batch Sync Endpoint (/api/sync/batch)
        if path == "/api/sync/batch":
            user = self._require_role(conn, "Harvester")
            if not user:
                return
            ops = data.get("operations") if isinstance(data.get("operations"), list) else []
            if len(ops) > 200:
                return self._send_json({"error": "Maximum 200 operations per sync batch."}, status=400)
            results = []
            synced = 0
            failed = 0
            for op in ops:
                cid = str((op or {}).get("client_id") or "")[:80]
                op_type = str((op or {}).get("type") or "").strip().lower()
                payload = (op or {}).get("payload") if isinstance((op or {}).get("payload"), dict) else {}
                try:
                    if op_type == "harvest":
                        out_data = self._apply_harvest_op(conn, user, payload)
                    elif op_type == "dispatch":
                        merged = {**payload, "client_id": payload.get("client_id") or cid or None}
                        out_data = self._apply_dispatch_op(conn, user, merged)
                    elif op_type == "calibrate":
                        if role_rank(user["role"]) < role_rank("Supervisor"):
                            raise ErpHttpError("Supervisor role required to calibrate tree GPS.", status=403)
                        out_data = self._apply_calibrate_op(conn, user, payload)
                    elif op_type == "tree_save":
                        if role_rank(user["role"]) < role_rank("Supervisor"):
                            raise ErpHttpError("Supervisor role required to save tree pin.", status=403)
                        out_data = self._apply_tree_save_op(conn, user, payload)
                    else:
                        raise ErpHttpError(f"Unsupported sync operation type '{op_type}'.", status=400)
                    conn.commit()
                    synced += 1
                    results.append({"client_id": cid, "type": op_type, "ok": True, "status": 200, "data": out_data})
                except ErpHttpError as e:
                    conn.rollback()
                    failed += 1
                    results.append({"client_id": cid, "type": op_type, "ok": False, "status": e.status, "error": e.message})
                except Exception:
                    conn.rollback()
                    failed += 1
                    results.append({"client_id": cid, "type": op_type, "ok": False, "status": 500, "error": "Operation failed during sync."})
            return self._send_json({"ok": True, "synced": synced, "failed": failed, "results": results})

        # 5. Mill Dispatch Weight Logging (Idempotent via client_id)
        if path == "/api/dispatch":
            user = self._require_role(conn, "Harvester")
            if not user:
                return
            res = self._apply_dispatch_op(conn, user, data)
            conn.commit()
            return self._send_json(res)

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
            username = str(data.get("username") or "").strip().lower().lstrip("@")
            full_name = str(data.get("full_name") or "").strip()
            role = normalize_role(data.get("role") or "Harvester")
            password = str(data.get("password") or INITIAL_ERP_PASSWORD)

            if not username or not full_name:
                return self._send_json({"error": "Username and Full Name are required."}, status=400)
            if not re.match(r"^[a-z0-9_.-]{2,40}$", username):
                return self._send_json(
                    {"error": "Username must be 2-40 characters (letters, numbers, _, ., -)."},
                    status=400,
                )
            if len(password) < 6:
                return self._send_json({"error": "Password must be at least 6 characters."}, status=400)
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
            target_id = safe_int(data.get("user_id"), default=0)
            new_role = normalize_role(data.get("role") or "Harvester")

            if target_id == user["id"]:
                return self._send_json({"error": "You cannot modify your own role."}, status=400)

            cur.execute("SELECT * FROM users WHERE id = ?", (target_id,))
            target = cur.fetchone()
            if not target:
                return self._send_json({"error": "User not found."}, status=404)
            if target["is_master"]:
                return self._send_json({"error": "Cannot modify the Master Admin role."}, status=400)
            if normalize_role(target["role"]) == "Admin" and not user["is_master"]:
                return self._send_json({"error": "Only the Master Admin can change another Admin's role."}, status=403)
            if new_role == "Master Admin" and not user["is_master"]:
                return self._send_json({"error": "Only the Master Admin can grant Master Admin access."}, status=403)

            cur.execute("UPDATE users SET role = ? WHERE id = ?", (new_role, target_id))
            conn.commit()
            return self._send_json({"ok": True})

        if path in ("/api/admin/users/force-password", "/api/admin/users/password"):
            # Strictly Master Admin ultimate control feature
            user = self._require_role(conn, "Master Admin")
            if not user:
                return
            if not user["is_master"]:
                return self._send_json(
                    {"error": "Only Master Admin can force-reset user passwords."},
                    status=403,
                )
            target_id = safe_int(data.get("user_id"), default=0)
            new_password = str(data.get("new_password") or data.get("password") or "")
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
            target_id = safe_int(data.get("user_id"), default=0)
            if target_id == user["id"]:
                return self._send_json({"error": "You cannot delete your own account."}, status=400)
            cur.execute("SELECT * FROM users WHERE id = ?", (target_id,))
            target = cur.fetchone()
            if not target:
                return self._send_json({"error": "User not found."}, status=404)
            if target["is_master"]:
                return self._send_json({"error": "Cannot delete the Master Admin account."}, status=400)
            if normalize_role(target["role"]) == "Admin" and not user["is_master"]:
                return self._send_json({"error": "Only the Master Admin can delete an Admin account."}, status=403)

            cur.execute("DELETE FROM sessions WHERE user_id = ?", (target_id,))
            cur.execute("DELETE FROM users WHERE id = ?", (target_id,))
            conn.commit()
            return self._send_json({"ok": True})

        # 7. Estates / 5-Tier Plantation Hierarchy Management
        if path == "/api/admin/settings":
            user = self._require_role(conn, "Admin")
            if not user:
                return
            season_m = safe_int(data.get("season_start_month"), default=4, min_val=1, max_val=12)
            cur.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('season_start_month', ?)", (str(season_m),))
            conn.commit()
            return self._send_json({"ok": True})

        if path == "/api/tree/calibrate":
            user = self._require_role(conn, "Supervisor")
            if not user:
                return
            res = self._apply_calibrate_op(conn, user, data)
            conn.commit()
            return self._send_json(res)

        if path == "/api/admin/trees/batch":
            user = self._require_role(conn, "Admin")
            if not user:
                return
            block_id = int(data.get("block_id") or 0)
            count = int(data.get("count") or 0)
            if block_id <= 0 or count <= 0 or count > 3000:
                return self._send_json({"error": "Select a valid block and palm count (1-3000)."}, status=400)
            cur.execute("SELECT COALESCE(MAX(tree_number), 0) AS mx FROM trees WHERE block_id = ?", (block_id,))
            start_no = int(cur.fetchone()["mx"] or 0) + 1
            rows = [
                (block_id, n, f"T-{n:03d}", ((n - 1) // 23) + 1, "active")
                for n in range(start_no, start_no + count)
            ]
            cur.executemany(
                "INSERT OR IGNORE INTO trees (block_id, tree_number, tree_code, row_number, status) VALUES (?, ?, ?, ?, ?)",
                rows,
            )
            conn.commit()
            return self._send_json({"ok": True, "from": start_no, "to": start_no + count - 1})

        if path.startswith("/api/admin/") and path.endswith(("/save", "/delete")):
            parts = path.strip("/").split("/")
            entity, action = parts[2], parts[3]
            required_role = "Supervisor" if (entity == "tree" and action == "save") else "Admin"
            user = self._require_role(conn, required_role)
            if not user:
                return
            item_id = int(data.get("id") or 0)

            if action == "delete":
                if entity == "estate":
                    cur.execute("DELETE FROM estates WHERE id = ?", (item_id,))
                elif entity == "division":
                    cur.execute("DELETE FROM divisions WHERE id = ?", (item_id,))
                elif entity == "field":
                    cur.execute("DELETE FROM fields WHERE id = ?", (item_id,))
                elif entity == "block":
                    cur.execute("DELETE FROM blocks WHERE id = ?", (item_id,))
                elif entity == "tree":
                    cur.execute("DELETE FROM trees WHERE id = ?", (item_id,))
                else:
                    return self._send_json({"error": "Unknown hierarchy entity."}, status=404)
                conn.commit()
                return self._send_json({"ok": True})

            if entity == "estate":
                name = str(data.get("name") or "").strip()
                region = str(data.get("location_region") or "").strip()[:120]
                if not name:
                    return self._send_json({"error": "Estate name is required."}, status=400)
                if item_id:
                    cur.execute("UPDATE estates SET name = ?, location_region = ? WHERE id = ?", (name, region, item_id))
                else:
                    code = f"EST-{secrets.token_hex(2).upper()}"
                    cur.execute("INSERT INTO estates (code, name, location_region) VALUES (?, ?, ?)", (code, name, region))
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
                self._apply_tree_save_op(conn, user, data)
            conn.commit()
            return self._send_json({"ok": True})

        return self._send_json({"error": f"Unknown endpoint {path}"}, status=404)

    def _apply_harvest_op(self, conn, user: dict, data: dict) -> dict:
        cur = conn.cursor()
        tree_id = safe_int(data.get("tree_id"), default=0)
        date_str = str(data.get("date") or date.today().strftime("%Y-%m-%d"))[:10]
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", date_str):
            raise ErpHttpError("Invalid date.", status=400)
        explicit_round = safe_int(data.get("round_no"), min_val=1, max_val=3)
        bunches = safe_int(data.get("bunches"), default=None)
        fronds = safe_int(data.get("fronds"), default=None)
        if bunches is None or bunches < 0 or bunches > 60:
            raise ErpHttpError("Bunches must be 0-60.", status=400)
        if fronds is None or fronds < 0 or fronds > 60:
            raise ErpHttpError("Fronds must be 0-60.", status=400)
        lat = safe_float(data.get("lat"))
        lng = safe_float(data.get("lng"))
        acc = safe_float(data.get("acc"))

        cur.execute("SELECT * FROM trees WHERE id = ?", (tree_id,))
        tree = cur.fetchone()
        if not tree:
            raise ErpHttpError("Palm tree not found.", status=404)
        if tree["status"] != "active":
            raise ErpHttpError("This tree is marked inactive.", status=400)

        if lat is None or lng is None or abs(lat) > 90 or abs(lng) > 180:
            lat = tree["latitude"]
            lng = tree["longitude"]
            if acc is None:
                acc = tree["gps_acc"]

        health_status = normalize_health_status(data.get("health_status") or tree["health_status"] or "Healthy")
        loose_raw = data.get("loose_fruit", 1)
        loose_fruit = 0 if loose_raw in (False, 0, "0", "false", "False") else 1
        remarks = str(data.get("remarks") or "").strip()[:240]

        r_info = compute_harvest_round(date_str, explicit_round)
        cur.execute(
            """
            INSERT INTO harvest_logs (
                tree_id, block_id, harvest_date, year_month, day_of_month, round_number,
                bunches_cut, fronds_cut, bunch_weight_kg, latitude, longitude, gps_acc,
                health_status, loose_fruit, remarks, recorded_by_id, recorded_by_name
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tree_id, year_month, round_number) DO UPDATE SET
                harvest_date = excluded.harvest_date,
                day_of_month = excluded.day_of_month,
                bunches_cut = excluded.bunches_cut,
                fronds_cut = excluded.fronds_cut,
                bunch_weight_kg = excluded.bunch_weight_kg,
                latitude = excluded.latitude,
                longitude = excluded.longitude,
                gps_acc = excluded.gps_acc,
                health_status = excluded.health_status,
                loose_fruit = excluded.loose_fruit,
                remarks = excluded.remarks,
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
                health_status,
                loose_fruit,
                remarks,
                user["id"],
                user["full_name"],
            ),
        )
        if data.get("health_status"):
            cur.execute("UPDATE trees SET health_status = ? WHERE id = ?", (health_status, tree_id))
        return {
            "ok": True,
            "round": r_info["round_number"],
            "lat": lat,
            "lng": lng,
            "health_status": health_status,
            "loose_fruit": loose_fruit,
        }

    def _apply_dispatch_op(self, conn, user: dict, data: dict) -> dict:
        cur = conn.cursor()
        division_id = safe_int(data.get("division_id"), min_val=1)
        date_str = str(data.get("date") or date.today().strftime("%Y-%m-%d"))[:10]
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", date_str):
            raise ErpHttpError("Select a valid date.", status=400)
        round_no = safe_int(data.get("round_no"))
        if round_no not in (1, 2, 3):
            raise ErpHttpError("Select Round 1, 2, or 3.", status=400)
        weight_kg = safe_float(data.get("weight_kg"))
        if weight_kg is None or weight_kg <= 0 or weight_kg > 500000:
            raise ErpHttpError("Enter a valid dispatch weight in kg.", status=400)
        if not division_id:
            raise ErpHttpError("Select a division.", status=400)
        cur.execute("SELECT id FROM divisions WHERE id = ?", (division_id,))
        if not cur.fetchone():
            raise ErpHttpError("Division not found.", status=404)

        client_id = str(data.get("client_id") or "").strip()[:80] or None
        if client_id:
            cur.execute("SELECT id FROM dispatch_logs WHERE client_id = ?", (client_id,))
            existing = cur.fetchone()
            if existing:
                return {"ok": True, "id": existing["id"], "deduplicated": True}

        cur.execute(
            """
            INSERT INTO dispatch_logs (
                division_id, dispatch_date, year_month, round_number, weight_kg, client_id, recorded_by_id, recorded_by_name
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (division_id, date_str, date_str[:7], round_no, weight_kg, client_id, user["id"], user["full_name"]),
        )
        return {"ok": True, "id": cur.lastrowid}

    def _apply_calibrate_op(self, conn, user: dict, data: dict) -> dict:
        cur = conn.cursor()
        tree_id = safe_int(data.get("id") or data.get("tree_id"), default=0)
        lat = safe_float(data.get("lat"))
        lng = safe_float(data.get("lng"))
        acc = safe_float(data.get("acc"), default=4.0)
        if not tree_id:
            raise ErpHttpError("Select a valid tree to calibrate.", status=400)
        if lat is None or lng is None or abs(lat) > 90 or abs(lng) > 180:
            raise ErpHttpError("Enter valid Latitude and Longitude coordinates.", status=400)
        now_s = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
        cur.execute(
            """
            UPDATE trees
            SET latitude = ?, longitude = ?, gps_acc = ?, mapped_by = ?, mapped_at = ?
            WHERE id = ?
            """,
            (round(lat, 6), round(lng, 6), acc, user["id"], now_s, tree_id),
        )
        return {"ok": True, "lat": round(lat, 6), "lng": round(lng, 6)}

    def _apply_tree_save_op(self, conn, user: dict, data: dict) -> dict:
        cur = conn.cursor()
        item_id = safe_int(data.get("id"), default=0)
        block_id = safe_int(data.get("block_id"), default=0)
        tree_no = safe_int(data.get("tree_no"), default=0)
        if tree_no < 1:
            raise ErpHttpError("Enter a valid tree number.", status=400)
        lat = safe_float(data.get("lat"))
        lng = safe_float(data.get("lng"))
        acc = safe_float(data.get("acc"), default=4.0)
        status = "inactive" if data.get("status") == "inactive" else "active"
        health_status = normalize_health_status(data.get("health_status") or "Healthy")
        if (lat is not None and abs(lat) > 90) or (lng is not None and abs(lng) > 180):
            raise ErpHttpError("Invalid coordinates.", status=400)
        now_s = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
        if item_id:
            cur.execute(
                """
                UPDATE trees
                SET tree_number = ?, status = ?, health_status = ?, latitude = ?, longitude = ?, gps_acc = ?, mapped_by = ?, mapped_at = ?
                WHERE id = ?
                """,
                (tree_no, status, health_status, lat, lng, acc, user["id"], now_s, item_id),
            )
        else:
            if not block_id:
                raise ErpHttpError("Unknown block.", status=400)
            cur.execute(
                """
                INSERT INTO trees (block_id, tree_number, tree_code, row_number, latitude, longitude, gps_acc, status, health_status, mapped_by, mapped_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(block_id, tree_number) DO UPDATE SET
                    status = excluded.status,
                    health_status = excluded.health_status,
                    latitude = excluded.latitude,
                    longitude = excluded.longitude,
                    gps_acc = excluded.gps_acc,
                    mapped_by = excluded.mapped_by,
                    mapped_at = excluded.mapped_at
                """,
                (block_id, tree_no, f"T-{tree_no:03d}", ((tree_no - 1) // 10) + 1, lat, lng, acc, status, health_status, user["id"], now_s),
            )
        return {"ok": True}


def run_server(port=None, host=None):
    init_db()
    bind_host = host or os.environ.get("HOST", "0.0.0.0")
    bind_port = int(port or os.environ.get("PORT", 8080))
    server = ThreadingHTTPServer((bind_host, bind_port), ElaeisErpHandler)
    print(f"Elaeis Corporate ERP running at http://{bind_host}:{bind_port}")
    server.serve_forever()


if __name__ == "__main__":
    run_server()
