// ============================================================================
// ELAEIS — Field Offline-First IndexedDB Cache & Sync Queue Engine
// Guarantees zero field data loss across zero-connectivity plantation blocks
// ============================================================================

const OfflineDB = (() => {
    const DB_NAME = "elaeis_field_offline_v1";
    const DB_VERSION = 1;
    let dbPromise = null;

    function open() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve) => {
            if (typeof indexedDB === "undefined") {
                resolve(null);
                return;
            }
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains("kv")) {
                    db.createObjectStore("kv", { keyPath: "key" });
                }
                if (!db.objectStoreNames.contains("blocks")) {
                    db.createObjectStore("blocks", { keyPath: "key" });
                }
                if (!db.objectStoreNames.contains("queue")) {
                    const qStore = db.createObjectStore("queue", { keyPath: "client_id" });
                    qStore.createIndex("created_at", "created_at", { unique: false });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
        return dbPromise;
    }

    async function tx(storeName, mode, fn) {
        const db = await open();
        if (!db) return null;
        return new Promise((resolve) => {
            try {
                const t = db.transaction(storeName, mode);
                const store = t.objectStore(storeName);
                const req = fn(store);
                if (req && typeof req === "object" && "onsuccess" in req) {
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => resolve(null);
                } else {
                    t.oncomplete = () => resolve(true);
                    t.onerror = () => resolve(null);
                }
            } catch (_) {
                resolve(null);
            }
        });
    }

    return {
        async getKV(key) {
            const row = await tx("kv", "readonly", (s) => s.get(key));
            return row ? row.value : null;
        },
        async setKV(key, value) {
            return tx("kv", "readwrite", (s) => s.put({ key, value, updated_at: Date.now() }));
        },
        async delKV(key) {
            return tx("kv", "readwrite", (s) => s.delete(key));
        },
        async getBlock(key) {
            const row = await tx("blocks", "readonly", (s) => s.get(key));
            return row ? row.value : null;
        },
        async setBlock(key, value) {
            return tx("blocks", "readwrite", (s) => s.put({ key, value, updated_at: Date.now() }));
        },
        async listQueue() {
            const items = (await tx("queue", "readonly", (s) => s.getAll())) || [];
            return items.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
        },
        async putQueue(item) {
            return tx("queue", "readwrite", (s) => s.put(item));
        },
        async removeQueue(clientId) {
            return tx("queue", "readwrite", (s) => s.delete(clientId));
        },
        async clearQueue() {
            return tx("queue", "readwrite", (s) => s.clear());
        },
    };
})();

const OfflineSync = {
    async init() {
        state.online = typeof navigator !== "undefined" ? navigator.onLine !== false : true;
        await this.refreshCount();
        this.updateIndicators();

        window.addEventListener("online", () => {
            state.online = true;
            this.updateIndicators();
            toast("Back online — syncing field records...");
            this.flush();
        });

        window.addEventListener("offline", () => {
            state.online = false;
            this.updateIndicators();
            toast("Offline mode active — field logs will queue locally", "warn");
        });

        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible" && navigator.onLine) {
                state.online = true;
                this.flush(true);
            }
        });

        // Periodic background sync when online and queue has pending items
        setInterval(() => {
            if (navigator.onLine && state.token && state.pendingSyncCount > 0 && !state.syncing) {
                this.flush(true);
            }
        }, 25000);
    },

    async refreshCount() {
        const items = await OfflineDB.listQueue();
        state.pendingSyncCount = items.length;
        return items;
    },

    async enqueue(type, payload, summary) {
        const clientId = payload.client_id || generateClientId(type);
        const item = {
            client_id: clientId,
            type,
            payload: { ...payload, client_id: clientId },
            summary: summary || `${type} record`,
            created_at: Date.now(),
            retries: 0,
            status: "pending",
            last_error: "",
        };
        await OfflineDB.putQueue(item);
        await this.refreshCount();
        this.updateIndicators();
        return item;
    },

    async applyPendingToBlockTrees(blockId, date, roundNo, trees) {
        const queue = await OfflineDB.listQueue();
        if (!queue.length || !Array.isArray(trees)) return trees;
        const { yearMonth, round } = roundOfDate(date, roundNo);

        const byTreeId = new Map(trees.map((t) => [Number(t.id), { ...t }]));

        for (const item of queue) {
            const p = item.payload || {};
            if (item.type === "harvest") {
                const tid = Number(p.tree_id);
                const t = byTreeId.get(tid);
                if (!t) continue;
                const opRound = roundOfDate(p.date || date, p.round_no);
                if (opRound.yearMonth === yearMonth && opRound.round === round) {
                    t.rec = {
                        tree_id: tid,
                        bunches: Number(p.bunches || 0),
                        fronds: Number(p.fronds || 0),
                        harvest_date: p.date || date,
                        round_no: opRound.round,
                        health_status: p.health_status || t.health_status || "Healthy",
                        loose_fruit: p.loose_fruit === 0 || p.loose_fruit === false ? 0 : 1,
                        remarks: p.remarks || "",
                        pending_sync: true,
                    };
                    if (p.health_status) t.health_status = p.health_status;
                    t._pendingSync = true;
                }
            } else if (item.type === "calibrate" || item.type === "tree_save") {
                const tid = Number(p.id || p.tree_id);
                const t = byTreeId.get(tid);
                if (t && p.lat !== undefined && p.lng !== undefined) {
                    t.lat = Number(p.lat);
                    t.lng = Number(p.lng);
                    t._pendingSync = true;
                }
            }
        }
        return Array.from(byTreeId.values());
    },

    async getPendingDispatches() {
        const queue = await OfflineDB.listQueue();
        const divisions = state.hierarchy.divisions || [];
        return queue
            .filter((item) => item.type === "dispatch")
            .map((item) => {
                const p = item.payload || {};
                const div = divisions.find((d) => d.id === Number(p.division_id));
                return {
                    id: item.client_id,
                    division_id: Number(p.division_id),
                    division_name: div?.name || `Division #${p.division_id}`,
                    dispatch_date: p.date || todayStr(),
                    year_month: (p.date || todayStr()).slice(0, 7),
                    round_no: Number(p.round_no || 1),
                    weight_kg: Number(p.weight_kg || 0),
                    recorded_by: state.user?.full_name || "You",
                    recorded_at: new Date(item.created_at).toISOString(),
                    pending_sync: true,
                };
            });
    },

    async flush(silent = false) {
        if (state.syncing || !state.token) return { synced: 0, failed: 0 };
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
            state.online = false;
            this.updateIndicators();
            if (!silent) toast("Still offline — will sync automatically once connected", "warn");
            return { synced: 0, failed: 0 };
        }

        const queue = await OfflineDB.listQueue();
        if (!queue.length) {
            this.updateIndicators();
            if (!silent) toast("All field records are up to date");
            return { synced: 0, failed: 0 };
        }

        state.syncing = true;
        this.updateIndicators();

        let totalSynced = 0;
        let totalFailed = 0;

        try {
            // Send in chunks of 50 operations
            for (let i = 0; i < queue.length; i += 50) {
                const chunk = queue.slice(i, i + 50);
                const res = await fetch("/api/sync/batch", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${state.token}`,
                    },
                    body: JSON.stringify({
                        operations: chunk.map((q) => ({
                            client_id: q.client_id,
                            type: q.type,
                            payload: q.payload,
                        })),
                    }),
                });

                if (res.status === 401) {
                    if (!silent) toast("Session expired — please sign in again to sync queued data", "err");
                    break;
                }
                if (!res.ok) {
                    throw new Error(`Sync HTTP ${res.status}`);
                }

                const data = await res.json();
                state.online = true;

                for (const r of data.results || []) {
                    if (r.ok) {
                        await OfflineDB.removeQueue(r.client_id);
                        totalSynced++;
                    } else {
                        totalFailed++;
                        const existing = chunk.find((c) => c.client_id === r.client_id);
                        if (existing) {
                            existing.retries = (existing.retries || 0) + 1;
                            existing.status = "failed";
                            existing.last_error = r.error || `Error ${r.status}`;
                            await OfflineDB.putQueue(existing);
                        }
                    }
                }
            }

            if (totalSynced > 0) {
                await OfflineDB.setKV("last_sync_at", new Date().toISOString());
                if (!silent) {
                    toast(
                        totalFailed > 0
                            ? `Synced ${totalSynced} record(s); ${totalFailed} need attention`
                            : `Synced ${totalSynced} offline field record(s)`,
                        totalFailed > 0 ? "warn" : "ok"
                    );
                }
                // Refresh current screen so server state is reflected immediately
                if (state.activePage === "harvests") {
                    if (state.harvestView === "trees" && typeof loadHarvestBlock === "function") loadHarvestBlock();
                    else if (typeof loadDispatches === "function") loadDispatches();
                } else if (state.activePage === "overview" && typeof refreshDashboard === "function") {
                    refreshDashboard();
                } else if (state.activePage === "map" && typeof refreshGisMapData === "function") {
                    refreshGisMapData(false);
                }
            } else if (totalFailed > 0 && !silent) {
                toast(`${totalFailed} queued record(s) failed — inspect Sync Queue`, "err");
            }
        } catch (_) {
            state.online = navigator.onLine !== false ? false : false;
            if (!silent) toast("Network unreachable — field records remain safely queued", "warn");
        } finally {
            state.syncing = false;
            await this.refreshCount();
            this.updateIndicators();
            this.renderSyncModal();
        }

        return { synced: totalSynced, failed: totalFailed };
    },

    async preloadEstateForField() {
        if (!state.token) return;
        const btn = $("btn-offline-preload");
        const statusEl = $("sync-preload-status");
        if (btn) btn.disabled = true;
        if (statusEl) {
            statusEl.classList.remove("hidden");
            statusEl.textContent = "Caching hierarchy & mapped trees...";
        }

        try {
            const boot = await api("/api/bootstrap");
            if (boot?.hierarchy) {
                state.hierarchy = boot.hierarchy;
                state.settings = boot.settings || { season_start_month: 4 };
                if (Array.isArray(boot.mapped_trees)) state.mappedTrees = boot.mapped_trees;
            }

            const date = $("harv-date")?.value || todayStr();
            const roundNo = Number($("harv-round")?.value) || roundOfDate(date).round;
            const blocks = state.hierarchy.blocks || [];

            for (let i = 0; i < blocks.length; i++) {
                const b = blocks[i];
                if (statusEl) {
                    statusEl.textContent = `Caching blocks (${i + 1}/${blocks.length}): ${b.name}...`;
                }
                const data = await api(`/api/block?block_id=${b.id}&mode=harvest&date=${date}&round_no=${roundNo}`);
                if (data) {
                    await OfflineDB.setBlock(`block:${b.id}:${date.slice(0, 7)}:${roundNo}`, data);
                }
            }

            await api("/api/dispatch").catch(() => null);
            await OfflineDB.setKV("last_preload_at", new Date().toISOString());
            if (statusEl) {
                statusEl.textContent = `Ready for offline field work (${blocks.length} blocks cached)`;
            }
            toast(`Preloaded ${blocks.length} blocks for offline field use`);
        } catch (err) {
            if (statusEl) statusEl.textContent = "Preload requires an active connection.";
            toast(err.message || "Could not preload blocks while offline", "err");
        } finally {
            if (btn) btn.disabled = false;
            this.renderSyncModal();
        }
    },

    updateIndicators() {
        const pill = $("btn-sync-pill");
        const dot = $("sync-dot");
        const lbl = $("sync-label");
        const rightBadge = $("right-online-badge");
        const pending = state.pendingSyncCount || 0;

        let text = "Online";
        let dotClass = "bg-[#00ba7c]";
        let pillExtra = "";

        if (state.syncing) {
            text = `Syncing (${pending})...`;
            dotClass = "bg-[#1d9bf0] animate-pulse";
            pillExtra = "border-[#1d9bf0]";
        } else if (!state.online) {
            text = pending > 0 ? `Offline • ${pending} Queued` : "Offline";
            dotClass = "bg-amber-500 animate-pulse";
            pillExtra = "border-amber-500 text-amber-700";
        } else if (pending > 0) {
            text = `${pending} Pending Sync`;
            dotClass = "bg-amber-500";
            pillExtra = "border-amber-500";
        }

        if (dot) dot.className = `w-2 h-2 rounded-full shrink-0 ${dotClass}`;
        if (lbl) lbl.textContent = text;
        if (pill) pill.className = `x-status-pill x-status-pill-gps ${pillExtra}`;

        if (rightBadge) {
            const rightColor = !state.online
                ? "text-amber-600"
                : pending > 0
                ? "text-amber-600"
                : "text-[#00ba7c]";
            rightBadge.className = `inline-flex items-center gap-1 text-[11px] font-mono-code font-bold ${rightColor}`;
            rightBadge.innerHTML = `<span class="w-2 h-2 rounded-full ${dotClass}"></span> ${esc(text)}`;
        }
    },

    async renderSyncModal() {
        const listEl = $("sync-queue-list");
        if (!listEl) return;
        const queue = await OfflineDB.listQueue();
        const lastSync = await OfflineDB.getKV("last_sync_at");
        const lastPreload = await OfflineDB.getKV("last_preload_at");

        if ($("sync-modal-status")) {
            $("sync-modal-status").textContent = state.online
                ? `Connected • ${queue.length} queued`
                : `Offline Mode • ${queue.length} queued locally`;
        }
        if ($("sync-modal-meta")) {
            const parts = [];
            if (lastSync) parts.push(`Last sync: ${new Date(lastSync).toLocaleTimeString()}`);
            if (lastPreload) parts.push(`Preloaded: ${new Date(lastPreload).toLocaleTimeString()}`);
            $("sync-modal-meta").textContent = parts.join(" • ") || "Preload blocks at the office before heading to zero-signal areas.";
        }

        if (!queue.length) {
            listEl.innerHTML = `<div class="erp-card text-center text-xs text-[#536471] !py-6">No pending offline field records. Everything is synced.</div>`;
            return;
        }

        listEl.innerHTML = queue
            .map(
                (item) => `
            <div class="erp-card !p-3 flex items-start justify-between gap-2 text-xs">
                <div class="min-w-0 space-y-0.5">
                    <div class="flex items-center gap-1.5">
                        <span class="px-2 py-0.5 rounded-full text-[10px] font-mono-code font-bold uppercase ${
                            item.status === "failed" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800"
                        }">${esc(item.type)}</span>
                        <span class="font-extrabold text-[#0f1419] truncate">${esc(item.summary)}</span>
                    </div>
                    <div class="text-[10px] font-mono-code text-[#536471]">
                        Queued ${new Date(item.created_at).toLocaleString()}
                    </div>
                    ${
                        item.last_error
                            ? `<div class="text-[10px] font-bold text-[#f4212e]">${esc(item.last_error)}</div>`
                            : ""
                    }
                </div>
                <button type="button" data-discard-sync="${esc(item.client_id)}" title="Discard queued record" class="p-1.5 rounded-full text-[#536471] hover:text-[#f4212e] shrink-0">
                    <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                </button>
            </div>`
            )
            .join("");

        listEl.querySelectorAll("[data-discard-sync]").forEach((btn) => {
            btn.onclick = async () => {
                await OfflineDB.removeQueue(btn.getAttribute("data-discard-sync"));
                await this.refreshCount();
                this.updateIndicators();
                await this.renderSyncModal();
                toast("Queued item removed");
            };
        });
        refreshIcons();
    },

    async openModal() {
        await this.renderSyncModal();
        $("modal-offline-sync")?.classList.remove("hidden");
        refreshIcons();
    },
};
