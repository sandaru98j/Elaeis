import io
import json
import os
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile
from http.server import ThreadingHTTPServer

import database
import server


class ElaeisServerIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmpdir = tempfile.TemporaryDirectory()
        cls.db_path = os.path.join(cls.tmpdir.name, "test_elaeis.db")
        database.DB_PATH = cls.db_path
        database.init_db(force_reseed_users=True)

        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.ElaeisErpHandler)
        cls.port = cls.httpd.server_address[1]
        cls.base_url = f"http://127.0.0.1:{cls.port}"
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmpdir.cleanup()

    def request(self, path, method="GET", body=None, token=None):
        headers = {}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(f"{self.base_url}{path}", data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req) as resp:
                raw = resp.read()
                ct = resp.headers.get("Content-Type", "")
                if "application/json" in ct:
                    return resp.status, json.loads(raw.decode("utf-8")), dict(resp.headers)
                return resp.status, raw, dict(resp.headers)
        except urllib.error.HTTPError as e:
            raw = e.read()
            code = e.code
            hdrs = dict(e.headers)
            e.close()
            try:
                parsed = json.loads(raw.decode("utf-8"))
            except Exception:
                parsed = raw
            return code, parsed, hdrs

    def login(self, username, password=None):
        pw = password or database.INITIAL_ERP_PASSWORD
        status, data, _ = self.request("/api/auth/login", "POST", {"username": username, "password": pw})
        self.assertEqual(status, 200, f"Login failed for {username}: {data}")
        return data["token"], data["user"]

    def test_01_health_and_static_pwa_assets(self):
        status, data, _ = self.request("/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])
        self.assertEqual(data["service"], "elaeis")

        status, raw, headers = self.request("/manifest.webmanifest")
        self.assertEqual(status, 200)
        self.assertIn("manifest+json", headers.get("Content-Type", ""))
        manifest = json.loads(raw.decode("utf-8"))
        self.assertEqual(manifest["short_name"], "Elaeis")

        status, raw, _ = self.request("/sw.js")
        self.assertEqual(status, 200)
        self.assertIn(b"SHELL_ASSETS", raw)

    def test_02_auth_and_rbac_hierarchy(self):
        # Invalid password rejected
        status, _, _ = self.request("/api/auth/login", "POST", {"username": "sandaru98j", "password": "wrong"})
        self.assertEqual(status, 401)

        master_tok, master = self.login("sandaru98j")
        self.assertTrue(master["is_master"])
        self.assertEqual(master["role"], "Master Admin")

        admin_tok, admin = self.login("sandun")
        self.assertEqual(admin["role"], "Admin")
        self.assertFalse(admin["is_master"])

        harv_tok, harv = self.login("ajith")
        self.assertEqual(harv["role"], "Harvester")

        # Harvester cannot access admin users or force password
        status, _, _ = self.request("/api/admin/users", token=harv_tok)
        self.assertEqual(status, 403)
        status, _, _ = self.request("/api/admin/users/force-password", "POST", {"user_id": harv["id"], "new_password": "Password1!"}, token=admin_tok)
        self.assertEqual(status, 403)

        # Admin cannot demote Master Admin or themselves
        status, _, _ = self.request("/api/admin/users/role", "POST", {"user_id": master["id"], "role": "Harvester"}, token=admin_tok)
        self.assertEqual(status, 400)
        status, _, _ = self.request("/api/admin/users/role", "POST", {"user_id": admin["id"], "role": "Harvester"}, token=admin_tok)
        self.assertEqual(status, 400)

        # Master Admin can create and delete a temporary user
        status, data, _ = self.request(
            "/api/admin/users/create",
            "POST",
            {"username": "temp_tester", "full_name": "Temp Tester", "role": "Supervisor", "password": "TempPass1!"},
            token=master_tok,
        )
        self.assertEqual(status, 200, data)

        status, users_data, _ = self.request("/api/admin/users", token=master_tok)
        temp_u = next(u for u in users_data["users"] if u["username"] == "temp_tester")
        status, _, _ = self.request("/api/admin/users/delete", "POST", {"user_id": temp_u["id"]}, token=master_tok)
        self.assertEqual(status, 200)

    def test_03_dynamic_estate_rollout_no_wipe_and_dynamic_exports(self):
        master_tok, _ = self.login("sandaru98j")

        # Rename Estate #1 to a custom real-world estate name
        custom_name = "Nakiyadeniya Palm Estate"
        status, _, _ = self.request(
            "/api/admin/estate/save",
            "POST",
            {"id": 1, "name": custom_name, "location_region": "Galle, Sri Lanka"},
            token=master_tok,
        )
        self.assertEqual(status, 200)

        # Re-run init_db() — MUST NOT wipe or revert the renamed estate!
        database.init_db(force_reseed_users=False)

        status, boot, _ = self.request("/api/bootstrap", token=master_tok)
        self.assertEqual(status, 200)
        est1 = next(e for e in boot["hierarchy"]["estates"] if e["id"] == 1)
        self.assertEqual(est1["name"], custom_name)
        self.assertEqual(est1["location_region"], "Galle, Sri Lanka")

        # Excel export must use dynamic estate slug in filename & valid OpenXML ZIP structure
        status, xlsx_bytes, headers = self.request("/api/export/excel?estate_id=1", token=master_tok)
        self.assertEqual(status, 200)
        cd = headers.get("Content-Disposition", "")
        self.assertIn("Nakiyadeniya_Palm_Estate_Harvest_Report_", cd)
        self.assertNotIn("Uskvalley", cd)

        zf = zipfile.ZipFile(io.BytesIO(xlsx_bytes))
        names = set(zf.namelist())
        self.assertIn("xl/workbook.xml", names)
        self.assertIn("xl/worksheets/sheet1.xml", names)

        # CSV export must also use dynamic estate slug and NOT contain Uskvalley
        status, csv_bytes, headers = self.request("/api/report.csv?estate_id=1", token=master_tok)
        self.assertEqual(status, 200)
        self.assertIn("Nakiyadeniya_Palm_Estate_KPI_Report_", headers.get("Content-Disposition", ""))
        self.assertIn(custom_name, csv_bytes.decode("utf-8-sig"))

    def test_04_offline_dispatch_idempotency_and_batch_sync(self):
        harv_tok, _ = self.login("ajith")
        sup_tok, _ = self.login("raveendra")

        # Dispatch idempotency with client_id
        cid = "offline-disp-unique-001"
        payload = {"division_id": 1, "date": "2026-11-15", "round_no": 2, "weight_kg": 1234.5, "client_id": cid}
        s1, d1, _ = self.request("/api/dispatch", "POST", payload, token=harv_tok)
        s2, d2, _ = self.request("/api/dispatch", "POST", payload, token=harv_tok)
        self.assertEqual(s1, 200)
        self.assertEqual(s2, 200)
        self.assertTrue(d2.get("deduplicated"))
        self.assertEqual(d1["id"], d2["id"])

        # Offline batch sync with harvest (agronomy fields), dispatch, and a deliberately failing op
        batch_body = {
            "operations": [
                {
                    "client_id": "op-harv-1",
                    "type": "harvest",
                    "payload": {
                        "tree_id": 1,
                        "date": "2026-11-15",
                        "round_no": 2,
                        "bunches": 6,
                        "fronds": 9,
                        "health_status": "Ganoderma / Disease",
                        "loose_fruit": 0,
                        "remarks": "Basal stem rot suspected",
                    },
                },
                {
                    "client_id": "op-disp-2",
                    "type": "dispatch",
                    "payload": {
                        "division_id": 1,
                        "date": "2026-11-15",
                        "round_no": 2,
                        "weight_kg": 500.0,
                    },
                },
                {
                    "client_id": "op-bad-3",
                    "type": "calibrate",
                    "payload": {"tree_id": 1, "lat": 6.1421, "lng": 80.3651},
                },
            ]
        }
        # Harvester runs batch: harvest & dispatch succeed, calibrate fails with 403 without rolling back the rest!
        status, res, _ = self.request("/api/sync/batch", "POST", batch_body, token=harv_tok)
        self.assertEqual(status, 200)
        self.assertEqual(res["synced"], 2)
        self.assertEqual(res["failed"], 1)
        by_cid = {r["client_id"]: r for r in res["results"]}
        self.assertTrue(by_cid["op-harv-1"]["ok"])
        self.assertTrue(by_cid["op-disp-2"]["ok"])
        self.assertFalse(by_cid["op-bad-3"]["ok"])
        self.assertEqual(by_cid["op-bad-3"]["status"], 403)

        # Supervisor succeeds on calibrate via batch sync
        status, sup_res, _ = self.request(
            "/api/sync/batch",
            "POST",
            {"operations": [{"client_id": "op-cal-sup", "type": "calibrate", "payload": {"tree_id": 1, "lat": 6.142123, "lng": 80.365456}}]},
            token=sup_tok,
        )
        self.assertEqual(status, 200)
        self.assertEqual(sup_res["synced"], 1)

        # Verify block endpoint returns persisted agronomy telemetry
        status, blk, _ = self.request("/api/block?block_id=1&mode=harvest&date=2026-11-15&round_no=2", token=harv_tok)
        self.assertEqual(status, 200)
        tree1 = next(t for t in blk["trees"] if t["id"] == 1)
        self.assertEqual(tree1["health_status"], "Ganoderma / Disease")
        self.assertEqual(tree1["rec"]["bunches"], 6)
        self.assertEqual(tree1["rec"]["fronds"], 9)
        self.assertEqual(tree1["rec"]["loose_fruit"], 0)
        self.assertEqual(tree1["rec"]["remarks"], "Basal stem rot suspected")

    def test_05_agronomy_analytics_and_nearest_tree_bbox(self):
        tok, _ = self.login("sandaru98j")

        status, agro, _ = self.request("/api/analytics/agronomy?from=2026-01-01&to=2026-12-31&estate_id=1", token=tok)
        self.assertEqual(status, 200)
        self.assertEqual(len(agro["rounds"]), 3)
        self.assertGreaterEqual(len(agro["divisions"]), 1)
        self.assertGreaterEqual(agro["summary"]["flagged_trees"], 1)
        self.assertIn(agro["summary"]["pruning_status"], ("Optimal", "Under-Pruned", "Over-Pruned", "No Data"))

        # Bounding-box nearest tree lookup
        status, near, _ = self.request("/api/trees/nearest?lat=6.142123&lng=80.365456&max_radius_m=50", token=tok)
        self.assertEqual(status, 200)
        self.assertIsNotNone(near["tree"])
        self.assertEqual(near["tree"]["id"], 1)

        # Far away coordinate returns None quickly
        status, far, _ = self.request("/api/trees/nearest?lat=45.0&lng=10.0&max_radius_m=100", token=tok)
        self.assertEqual(status, 200)
        self.assertIsNone(far["tree"])

    def test_06_unmapped_real_estate_blocks_do_not_hallucinate_gps(self):
        tok, _ = self.login("sandaru98j")
        # Create a 2nd real estate with a division, field, block, and 10 unmapped palms
        self.request("/api/admin/estate/save", "POST", {"name": "Second Real Estate"}, token=tok)
        _, boot, _ = self.request("/api/bootstrap", token=tok)
        est2 = next(e for e in boot["hierarchy"]["estates"] if e["name"] == "Second Real Estate")

        self.request("/api/admin/division/save", "POST", {"estate_id": est2["id"], "name": "North Div"}, token=tok)
        _, boot, _ = self.request("/api/bootstrap", token=tok)
        div2 = next(d for d in boot["hierarchy"]["divisions"] if d["estate_id"] == est2["id"])

        self.request("/api/admin/field/save", "POST", {"division_id": div2["id"], "name": "F-2026", "planting_year": 2026, "area_ha": 12.5}, token=tok)
        _, boot, _ = self.request("/api/bootstrap", token=tok)
        fld2 = next(f for f in boot["hierarchy"]["fields"] if f["division_id"] == div2["id"])

        self.request("/api/admin/block/save", "POST", {"field_id": fld2["id"], "name": "Block 1", "tree_count": 10}, token=tok)

        # GIS map for Estate 2 must show 0 mapped trees and 10 unmapped trees (never fake coordinates!)
        status, map_res, _ = self.request(f"/api/map/trees?estate_id={est2['id']}", token=tok)
        self.assertEqual(status, 200)
        self.assertEqual(map_res["total_trees"], 0)
        self.assertEqual(map_res["unmapped_trees"], 10)

        # Report scoped to Estate 2 must return exact 12.5 Ha and 0 dispatches (not leaking Estate 1!)
        status, rep, _ = self.request(f"/api/report?estate_id={est2['id']}", token=tok)
        self.assertEqual(status, 200)
        self.assertEqual(rep["estate_name"], "Second Real Estate")
        self.assertAlmostEqual(rep["totals"]["area_ha"], 12.5, places=2)
        self.assertEqual(rep["totals"]["dispatch_kg"], 0.0)


if __name__ == "__main__":
    unittest.main()
