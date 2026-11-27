import json
import os
import re
import sqlite3
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class WorkerParityAndFrontendIntegrityTest(unittest.TestCase):
    def read(self, rel_path):
        with open(os.path.join(ROOT, rel_path), "r", encoding="utf-8") as f:
            return f.read()

    def test_worker_and_pages_worker_byte_identical(self):
        w1 = self.read("worker.js")
        w2 = self.read("static/_worker.js")
        self.assertEqual(w1, w2, "worker.js and static/_worker.js must stay byte-for-byte identical")

    def test_worker_and_server_endpoint_parity(self):
        worker_src = self.read("worker.js")
        server_src = self.read("server.py")

        required_endpoints = [
            "/api/health",
            "/api/auth/login",
            "/api/auth/me",
            "/api/auth/logout",
            "/api/auth/change-password",
            "/api/profile/activity",
            "/api/profile/update",
            "/api/settings/theme",
            "/api/bootstrap",
            "/api/hierarchy",
            "/api/trees/mapped",
            "/api/trees/nearest",
            "/api/map/trees",
            "/api/tree/calibrate",
            "/api/block",
            "/api/report",
            "/api/report.csv",
            "/api/report/matrix",
            "/api/analytics/agronomy",
            "/api/harvest",
            "/api/sync/batch",
            "/api/dispatch",
            "/api/dispatch/delete",
            "/api/export/excel",
            "/api/admin/users",
            "/api/admin/users/create",
            "/api/admin/users/role",
            "/api/admin/users/force-password",
            "/api/admin/users/delete",
            "/api/admin/trees/batch",
            "/api/admin/settings",
        ]
        for ep in required_endpoints:
            self.assertIn(ep, worker_src, f"Endpoint missing in worker.js: {ep}")
            self.assertIn(ep, server_src, f"Endpoint missing in server.py: {ep}")

        # Verify dynamic 5-tier entity CRUD route exists in both backends
        self.assertIn("/api/admin/tree/save", worker_src)
        self.assertIn('path.startswith("/api/admin/") and path.endswith(("/save", "/delete"))', server_src)

    def test_zero_hardcoded_estate_names_in_ui(self):
        forbidden = ["uskvalley", "baduraliya", "trafalgar", "morawaka"]
        ui_files = [
            "static/index.html",
            "static/styles.css",
            "static/manifest.webmanifest",
            "static/sw.js",
        ]
        js_dir = os.path.join(ROOT, "static", "js")
        for fn in sorted(os.listdir(js_dir)):
            if fn.endswith(".js"):
                ui_files.append(f"static/js/{fn}")

        for rel in ui_files:
            content = self.read(rel).lower()
            for word in forbidden:
                self.assertNotIn(word, content, f"Hardcoded estate reference '{word}' found in {rel}")

    def test_frontend_modularization_and_sw_precache(self):
        self.assertFalse(
            os.path.exists(os.path.join(ROOT, "static", "app.js")),
            "Legacy monolithic static/app.js should be removed after modularization",
        )
        html = self.read("static/index.html")
        sw = self.read("static/sw.js")
        scripts = re.findall(r'<script src="(/js/[^"]+\.js)"></script>', html)
        self.assertGreaterEqual(len(scripts), 8, "Expected modular JS files loaded in index.html")

        for s in scripts:
            full = os.path.join(ROOT, "static", s.lstrip("/"))
            self.assertTrue(os.path.isfile(full), f"Referenced module missing: {s}")
            self.assertIn(f'"{s}"', sw, f"Module {s} must be precached in static/sw.js for offline boot")

    def test_schema_sql_executes_cleanly_in_sqlite(self):
        sql = self.read("schema.sql")
        conn = sqlite3.connect(":memory:")
        try:
            conn.executescript(sql)
            tables = {
                r[0]
                for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
            }
            for expected in ("users", "sessions", "estates", "divisions", "fields", "blocks", "trees", "harvest_logs", "dispatch_logs", "settings"):
                self.assertIn(expected, tables)
        finally:
            conn.close()

    def test_manifest_json_valid(self):
        manifest = json.loads(self.read("static/manifest.webmanifest"))
        self.assertEqual(manifest["display"], "standalone")
        self.assertTrue(manifest["icons"])

    def test_js_files_non_empty_and_no_unclosed_delimiters(self):
        js_files = ["worker.js", "static/_worker.js", "static/sw.js"] + [
            f"static/js/{fn}"
            for fn in sorted(os.listdir(os.path.join(ROOT, "static", "js")))
            if fn.endswith(".js")
        ]
        regex_prev_chars = set("=({[,!&|?:;~+-*%^<>")
        regex_prev_words = {"return", "case", "throw", "in", "of", "typeof", "void", "delete", "await", "yield", "else"}
        for rel in js_files:
            src = self.read(rel)
            self.assertGreater(len(src.strip()), 100, f"{rel} unexpectedly short")

            def scan_code(idx, stop_on_close_brace=False):
                n = len(src)
                depth = {"{": 0, "(": 0, "[": 0}
                close_map = {"}": "{", ")": "(", "]": "["}
                last_sig = ";"
                last_word = ""
                while idx < n:
                    ch = src[idx]
                    nxt = src[idx + 1] if idx + 1 < n else ""
                    if ch == "/" and nxt == "/":
                        nl = src.find("\n", idx)
                        idx = n if nl == -1 else nl + 1
                        continue
                    if ch == "/" and nxt == "*":
                        end = src.find("*/", idx + 2)
                        self.assertNotEqual(end, -1, f"Unclosed block comment in {rel}")
                        idx = end + 2
                        continue
                    if ch == "/" and (last_sig in regex_prev_chars or last_word in regex_prev_words):
                        idx += 1
                        in_class = False
                        while idx < n:
                            c2 = src[idx]
                            if c2 == "\\":
                                idx += 2
                                continue
                            if c2 == "[":
                                in_class = True
                            elif c2 == "]":
                                in_class = False
                            elif c2 == "/" and not in_class:
                                idx += 1
                                while idx < n and src[idx].isalpha():
                                    idx += 1
                                break
                            idx += 1
                        last_sig = "R"
                        last_word = ""
                        continue
                    if ch in ("'", '"'):
                        q = ch
                        idx += 1
                        while idx < n:
                            if src[idx] == "\\":
                                idx += 2
                                continue
                            if src[idx] == q:
                                idx += 1
                                break
                            idx += 1
                        last_sig = "S"
                        last_word = ""
                        continue
                    if ch == "`":
                        idx += 1
                        while idx < n:
                            if src[idx] == "\\":
                                idx += 2
                                continue
                            if src[idx] == "$" and idx + 1 < n and src[idx + 1] == "{":
                                idx = scan_code(idx + 2, stop_on_close_brace=True)
                                continue
                            if src[idx] == "`":
                                idx += 1
                                break
                            idx += 1
                        last_sig = "S"
                        last_word = ""
                        continue
                    if ch.isalpha() or ch == "_" or ch == "$":
                        start = idx
                        while idx < n and (src[idx].isalnum() or src[idx] in "_$"):
                            idx += 1
                        last_word = src[start:idx]
                        last_sig = "W"
                        continue
                    if stop_on_close_brace and ch == "}" and depth["{"] == 0:
                        self.assertEqual(depth["("], 0, f"Unbalanced parens in template expr in {rel}")
                        self.assertEqual(depth["["], 0, f"Unbalanced brackets in template expr in {rel}")
                        return idx + 1
                    if ch in depth:
                        depth[ch] += 1
                    elif ch in close_map:
                        depth[close_map[ch]] -= 1
                    if not ch.isspace():
                        last_sig = ch
                        last_word = ""
                    idx += 1
                self.assertEqual(depth["{"], 0, f"Unbalanced curly braces in {rel}: {depth}")
                self.assertEqual(depth["("], 0, f"Unbalanced parens in {rel}: {depth}")
                self.assertEqual(depth["["], 0, f"Unbalanced brackets in {rel}: {depth}")
                return idx

            scan_code(0)


if __name__ == "__main__":
    unittest.main()
