// ============================================================================
// ELAEIS — High-Performance Field Harvest Logger & Mill Dispatch
// Optimized 2D Palm Grid (inline SVGs + event delegation + offline queue overlay)
// ============================================================================

function syncMappedTreeInCache(treeObj) {
    if (!treeObj || !treeObj.id) return;
    const idx = state.mappedTrees.findIndex((t) => t.id === treeObj.id);
    if (treeObj.lat !== null && treeObj.lat !== undefined && treeObj.lng !== null && treeObj.lng !== undefined) {
        const entry = {
            id: treeObj.id,
            block_id: treeObj.block_id || state.harvBlock.block_id || state.mapBlock.block_id,
            tree_no: treeObj.tree_no,
            lat: Number(treeObj.lat),
            lng: Number(treeObj.lng),
            gps_acc: treeObj.gps_acc || 4.0,
        };
        if (idx >= 0) state.mappedTrees[idx] = entry;
        else state.mappedTrees.push(entry);
    } else if (idx >= 0) {
        state.mappedTrees.splice(idx, 1);
    }
}

function populateHarvestTreeDropdowns(selectedTreeId = null) {
    const trees = state.harvBlock.trees || [];
    const curId = selectedTreeId || state.harvBlock.selectedTreeId || trees[0]?.id || "";
    state.harvBlock.selectedTreeId = curId ? Number(curId) : null;

    const harvSel = $("harv-tree-select");
    if (harvSel) {
        harvSel.innerHTML =
            `<option value="">Select Palm (${trees.length})...</option>` +
            trees
                .map((t) => {
                    const statusTxt = t.rec ? ` • ${t.rec.bunches}B/${t.rec.fronds}F` : "";
                    return `<option value="${t.id}" ${Number(curId) === t.id ? "selected" : ""}>Palm #${t.tree_no}${statusTxt}</option>`;
                })
                .join("");
    }

    const mhBlockSel = $("mh-block");
    if (mhBlockSel && state.hierarchy.blocks?.length) {
        const { fields, blocks } = state.hierarchy;
        mhBlockSel.innerHTML = blocks
            .map((b) => {
                const fld = fields.find((f) => f.id === b.field_id);
                const label = fld ? `${fld.name} • ${b.name}` : b.name;
                return `<option value="${b.id}" ${b.id === state.harvBlock.block_id ? "selected" : ""}>${esc(label)}</option>`;
            })
            .join("");
    }

    const mhTreeSel = $("mh-tree-select");
    if (mhTreeSel) {
        mhTreeSel.innerHTML = trees
            .map((t) => {
                const statusTxt = t.rec ? ` (${t.rec.bunches}B/${t.rec.fronds}F)` : "";
                return `<option value="${t.id}" ${Number(curId) === t.id ? "selected" : ""}>Palm #${t.tree_no}${statusTxt}</option>`;
            })
            .join("");
    }
}

async function selectHarvestBlockCascade(blockId) {
    const bid = Number(blockId);
    if (!bid) return;
    const { fields, blocks } = state.hierarchy;
    const blk = blocks.find((b) => b.id === bid);
    if (!blk) return;
    const fld = fields.find((f) => f.id === blk.field_id);
    const divEl = $("harv-division");
    const fldEl = $("harv-field");
    const blkEl = $("harv-block");
    if (divEl && fld && Number(divEl.value) !== fld.division_id) {
        divEl.value = String(fld.division_id);
        const fList = fields.filter((f) => f.division_id === fld.division_id);
        if (fldEl) {
            fldEl.innerHTML = fList
                .map((f) => `<option value="${f.id}">${esc(f.name)} (${f.planting_year} - ${Number(f.area_ha).toFixed(2)} Ha)</option>`)
                .join("");
        }
    }
    if (fldEl && fld && Number(fldEl.value) !== fld.id) {
        fldEl.value = String(fld.id);
    }
    if (blkEl && fld) {
        const bList = blocks.filter((b) => b.field_id === fld.id);
        blkEl.innerHTML = bList
            .map((b) => `<option value="${b.id}">${esc(b.name)} (${b.tree_total} palms)</option>`)
            .join("");
        blkEl.value = String(bid);
    }
    await loadHarvestBlock(bid);
}

async function loadHarvestBlock(explicitBlockId = null) {
    const bid = Number(explicitBlockId || $("harv-block")?.value);
    if (!bid) return;
    const date = $("harv-date").value || todayStr();
    const roundNo = Number($("harv-round").value) || roundOfDate(date).round;
    const { rangeLabel } = roundOfDate(date, roundNo);
    $("harv-auto-meta").textContent = `Round ${roundNo} (${rangeLabel}) • ${date}`;

    try {
        const data = await api(`/api/block?block_id=${bid}&mode=harvest&date=${date}&round_no=${roundNo}`);
        const mergedTrees = await OfflineSync.applyPendingToBlockTrees(bid, date, roundNo, data.trees || []);
        state.harvBlock.block_id = bid;
        state.harvBlock.trees = mergedTrees;
        state.harvBlock.trees.forEach((t) => syncMappedTreeInCache({ ...t, block_id: bid }));
        populateHarvestTreeDropdowns(state.harvBlock.selectedTreeId);
        renderHarvestGrid();
    } catch (err) {
        toast(err.message || "Could not load block data", "warn");
    }
}

function renderHarvestGrid() {
    const trees = state.harvBlock.trees || [];
    const doneCount = trees.filter((t) => t.rec).length;
    const pendingCount = trees.filter((t) => t.rec?.pending_sync || t._pendingSync).length;
    $("harv-progress-pill").textContent =
        pendingCount > 0
            ? `${doneCount} / ${trees.length} Cut • ${pendingCount} Queued`
            : `${doneCount} / ${trees.length} Cut`;

    const flt = state.harvBlock.filter;
    const q = state.harvBlock.search.trim();
    const filtered = trees.filter((t) => {
        if (q && String(t.tree_no) !== q) return false;
        if (flt === "done" && !t.rec) return false;
        if (flt === "pending" && t.rec) return false;
        return true;
    });

    const grid = $("harv-grid");
    if (!grid) return;

    const parts = new Array(filtered.length);
    for (let i = 0; i < filtered.length; i++) {
        const t = filtered[i];
        const done = Boolean(t.rec);
        const isPendingSync = Boolean(t.rec?.pending_sync || t._pendingSync);
        const isSelected = state.harvBlock.selectedTreeId === t.id;
        const flaggedHealth = t.health_status && t.health_status !== "Healthy";

        const badges = [];
        if (isPendingSync) {
            badges.push(`<span class="w-2 h-2 rounded-full bg-amber-400" title="Queued for Sync"></span>`);
        } else if (flaggedHealth) {
            badges.push(`<span class="w-2 h-2 rounded-full bg-red-500" title="${esc(t.health_status)}"></span>`);
        } else if (t.lat !== null && t.lat !== undefined) {
            badges.push(`<span class="w-1.5 h-1.5 rounded-full ${done ? "bg-[#00ba7c]" : "bg-[#0f1419]"}" title="GPS Mapped"></span>`);
        }

        parts[i] = `<div data-harv-tree="${t.id}" class="palm-card ${done ? "done-harvest" : ""} ${isPendingSync ? "pending-sync-palm" : ""} ${isSelected ? "selected-palm" : ""}">
            <div class="w-full flex items-center justify-between text-[10px] font-mono-code ${done ? "opacity-80" : "text-[#536471]"}">
                <span>#${t.tree_no}</span>
                <span class="flex items-center gap-1">${badges.join("")}</span>
            </div>
            <div class="my-1">${done ? INLINE_SVG_CHECK : INLINE_SVG_PALM}</div>
            <div class="text-[11px] font-mono-code font-extrabold">
                ${done ? `${t.rec.bunches}B / ${t.rec.fronds}F` : "Tap"}
            </div>
        </div>`;
    }
    grid.innerHTML = parts.join("");

    // Single delegated click listener (zero 600-node listener churn)
    if (!grid._delegatedBound) {
        grid.addEventListener("click", (e) => {
            const card = e.target.closest("[data-harv-tree]");
            if (!card) return;
            state.harvBlock.manualOverride = true;
            openHarvestModal(Number(card.getAttribute("data-harv-tree")));
        });
        grid._delegatedBound = true;
    }
}

function highlightSelectedPalmCard(treeId) {
    const grid = $("harv-grid");
    if (!grid) return;
    const prev = grid.querySelector(".palm-card.selected-palm");
    if (prev) prev.classList.remove("selected-palm");
    const next = grid.querySelector(`[data-harv-tree="${treeId}"]`);
    if (next) next.classList.add("selected-palm");
}

function populateHarvestModalFields(tree) {
    if (!tree) return;
    state.modalTree = tree;
    state.harvBlock.selectedTreeId = tree.id;

    const date = $("harv-date").value || todayStr();
    const roundNo = Number($("harv-round").value) || roundOfDate(date).round;
    const { rangeLabel } = roundOfDate(date, roundNo);
    const blk = state.hierarchy.blocks.find((b) => b.id === (tree.block_id || state.harvBlock.block_id));

    $("mh-tree-badge").textContent = `#${tree.tree_no}`;
    $("mh-title").textContent = `Palm #${tree.tree_no}${blk ? ` • ${blk.name}` : ""}`;
    $("mh-sub").textContent = `Round ${roundNo} (${rangeLabel}) • ${date}`;
    $("mh-bunches").value = tree.rec ? tree.rec.bunches : 0;
    $("mh-fronds").value = tree.rec ? tree.rec.fronds : 0;

    if ($("mh-health")) $("mh-health").value = tree.rec?.health_status || tree.health_status || "Healthy";
    if ($("mh-loose-fruit")) $("mh-loose-fruit").checked = tree.rec ? tree.rec.loose_fruit !== 0 : true;
    if ($("mh-remarks")) $("mh-remarks").value = tree.rec?.remarks || "";

    if ($("mh-block")) $("mh-block").value = String(tree.block_id || state.harvBlock.block_id || "");
    if ($("mh-tree-select")) $("mh-tree-select").value = String(tree.id);
    if ($("mh-tree-no")) $("mh-tree-no").value = String(tree.tree_no);
    if ($("harv-tree-select")) $("harv-tree-select").value = String(tree.id);

    const canCalibrate = (ROLE_RANK[state.user?.role] || 1) >= ROLE_RANK.Supervisor;
    const calSec = $("mh-calibration-section");
    if (calSec) {
        calSec.classList.toggle("hidden", !canCalibrate);
        if ($("mh-cal-lat")) $("mh-cal-lat").value = tree.lat !== null && tree.lat !== undefined ? tree.lat : "";
        if ($("mh-cal-lng")) $("mh-cal-lng").value = tree.lng !== null && tree.lng !== undefined ? tree.lng : "";
    }

    updateGpsAccuracyPills();
    highlightSelectedPalmCard(tree.id);
}

function openHarvestModal(treeId = null, { fromAutoDetect = false } = {}) {
    const trees = state.harvBlock.trees || [];
    const tree =
        (treeId ? trees.find((t) => t.id === Number(treeId)) : null) ||
        trees.find((t) => t.id === state.harvBlock.selectedTreeId) ||
        trees[0];
    if (!tree) return;
    if (!fromAutoDetect) {
        state.harvBlock.manualOverride = true;
    }
    populateHarvestTreeDropdowns(tree.id);
    populateHarvestModalFields(tree);
    $("modal-harvest").classList.remove("hidden");
    refreshIcons();

    if (!fromAutoDetect && state.autoDetectGps && !treeId) {
        autoDetectNearestTree({ openModal: true });
    }
}

async function autoDetectNearestTree({ openModal = true } = {}) {
    const btn1 = $("btn-harv-autodetect");
    const btn2 = $("btn-mh-autodetect");
    if (btn1) btn1.disabled = true;
    if (btn2) btn2.disabled = true;
    updateGpsAccuracyPills("GPS...");

    try {
        const gpsRes = await requestBrowserGps(5500);
        if (!gpsRes.ok || gpsRes.lat === null || gpsRes.lng === null) {
            updateGpsAccuracyPills();
            toast("GPS weak — select tree manually");
            return null;
        }

        const candidateMap = new Map();
        for (const t of state.mappedTrees || []) {
            if (t.lat !== null && t.lat !== undefined && t.lng !== null && t.lng !== undefined) {
                candidateMap.set(t.id, t);
            }
        }
        for (const t of state.harvBlock.trees || []) {
            if (t.lat !== null && t.lat !== undefined && t.lng !== null && t.lng !== undefined) {
                candidateMap.set(t.id, { ...t, block_id: t.block_id || state.harvBlock.block_id });
            }
        }

        let nearest = null;
        let minDist = Infinity;
        const curBlockId = state.harvBlock.block_id;

        for (const t of candidateMap.values()) {
            const dist = distanceMeters(gpsRes.lat, gpsRes.lng, t.lat, t.lng);
            if (dist < minDist || (dist === minDist && curBlockId && t.block_id === curBlockId)) {
                minDist = dist;
                nearest = t;
            }
        }

        if (!nearest || !Number.isFinite(minDist) || minDist > 100) {
            toast("GPS weak — select tree manually");
            return null;
        }

        state.harvBlock.manualOverride = false;
        if (nearest.block_id && nearest.block_id !== state.harvBlock.block_id) {
            await selectHarvestBlockCascade(nearest.block_id);
        }

        const matchedTree =
            state.harvBlock.trees.find((t) => t.id === nearest.id || t.tree_no === nearest.tree_no) || nearest;
        state.harvBlock.selectedTreeId = matchedTree.id;
        state.harvBlock.search = "";
        if ($("harv-search")) $("harv-search").value = String(matchedTree.tree_no);

        populateHarvestTreeDropdowns(matchedTree.id);
        populateHarvestModalFields(matchedTree);

        if (openModal) {
            $("modal-harvest").classList.remove("hidden");
            refreshIcons();
        }

        const cardEl = document.querySelector(`[data-harv-tree="${matchedTree.id}"]`);
        if (cardEl && typeof cardEl.scrollIntoView === "function") {
            cardEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }

        toast(`Palm #${matchedTree.tree_no} auto-detected (${Math.round(minDist)}m • GPS ±${Math.round(gpsRes.acc)}m)`);
        return matchedTree;
    } finally {
        if (btn1) btn1.disabled = false;
        if (btn2) btn2.disabled = false;
    }
}

async function syncCalibrationInputsToMyLocation(latInputId, lngInputId) {
    const latEl = $(latInputId);
    const lngEl = $(lngInputId);
    if (!latEl || !lngEl) return;

    updateGpsAccuracyPills("GPS...");
    const gpsRes = await requestBrowserGps(5500);
    if (gpsRes.ok && gpsRes.lat !== null && gpsRes.lng !== null) {
        latEl.value = gpsRes.lat;
        lngEl.value = gpsRes.lng;
        toast(`Synced to your location (${gpsRes.lat.toFixed(5)}, ${gpsRes.lng.toFixed(5)} • ±${Math.round(gpsRes.acc)}m)`);
    } else {
        if (state.gps.lat !== null && state.gps.lng !== null) {
            latEl.value = Number(state.gps.lat).toFixed(6);
            lngEl.value = Number(state.gps.lng).toFixed(6);
        }
        toast("GPS weak — adjust coordinates manually");
    }
}

async function saveHarvestModalPinCalibration(silent = false) {
    const tree = state.modalTree;
    if (!tree) return false;
    const canCalibrate = (ROLE_RANK[state.user?.role] || 1) >= ROLE_RANK.Supervisor;
    if (!canCalibrate) return false;

    const rawLat = $("mh-cal-lat")?.value;
    const rawLng = $("mh-cal-lng")?.value;
    if (rawLat === "" || rawLng === "" || rawLat === undefined || rawLng === undefined) return false;

    const nextLat = Number(rawLat);
    const nextLng = Number(rawLng);
    if (!Number.isFinite(nextLat) || !Number.isFinite(nextLng) || Math.abs(nextLat) > 90 || Math.abs(nextLng) > 180) {
        if (!silent) toast("Enter valid Latitude and Longitude coordinates.", "err");
        return false;
    }

    const fixedLat = Number(nextLat.toFixed(6));
    const fixedLng = Number(nextLng.toFixed(6));
    const changed = Number(tree.lat) !== fixedLat || Number(tree.lng) !== fixedLng;
    if (!changed && silent) return false;

    const res = await apiFieldWrite(
        "calibrate",
        "/api/tree/calibrate",
        {
            id: tree.id,
            tree_id: tree.id,
            lat: fixedLat,
            lng: fixedLng,
            acc: state.gps.acc || 4.0,
        },
        `Calibrate Palm #${tree.tree_no} GPS`
    );

    tree.lat = fixedLat;
    tree.lng = fixedLng;
    if (res.queued) tree._pendingSync = true;
    syncMappedTreeInCache({ ...tree, block_id: tree.block_id || state.harvBlock.block_id });
    if (!silent) {
        toast(res.queued ? `Palm #${tree.tree_no} GPS queued for sync` : `Palm #${tree.tree_no} GPS pin calibrated`, res.queued ? "warn" : "ok");
        renderHarvestGrid();
    }
    return true;
}

async function submitHarvestModal() {
    const tree = state.modalTree;
    if (!tree) return;
    const btn = $("btn-submit-harvest");
    btn.disabled = true;
    try {
        await saveHarvestModalPinCalibration(true).catch(() => {});

        let logLat = null;
        let logLng = null;
        let logAcc = null;

        const hasTreeCoords = tree.lat !== null && tree.lat !== undefined && tree.lng !== null && tree.lng !== undefined;
        const gpsIsFreshAndStrong =
            state.gps.live &&
            state.gps.lat !== null &&
            state.gps.lng !== null &&
            (state.gps.acc === null || state.gps.acc <= 50);

        if (state.harvBlock.manualOverride) {
            if (
                gpsIsFreshAndStrong &&
                (!hasTreeCoords || distanceMeters(state.gps.lat, state.gps.lng, tree.lat, tree.lng) <= 100)
            ) {
                logLat = state.gps.lat;
                logLng = state.gps.lng;
                logAcc = state.gps.acc;
            } else if (hasTreeCoords) {
                logLat = Number(tree.lat);
                logLng = Number(tree.lng);
                logAcc = tree.gps_acc || null;
            }
        } else if (gpsIsFreshAndStrong) {
            logLat = state.gps.lat;
            logLng = state.gps.lng;
            logAcc = state.gps.acc;
        } else if (hasTreeCoords) {
            logLat = Number(tree.lat);
            logLng = Number(tree.lng);
            logAcc = tree.gps_acc || null;
        }

        const date = $("harv-date").value || todayStr();
        const round_no = Number($("harv-round").value) || roundOfDate(date).round;
        const bunches = Number($("mh-bunches").value) || 0;
        const fronds = Number($("mh-fronds").value) || 0;
        const health_status = $("mh-health")?.value || "Healthy";
        const loose_fruit = $("mh-loose-fruit") ? ($("mh-loose-fruit").checked ? 1 : 0) : 1;
        const remarks = ($("mh-remarks")?.value || "").trim();

        const res = await apiFieldWrite(
            "harvest",
            "/api/harvest",
            {
                tree_id: tree.id,
                round_no,
                date,
                bunches,
                fronds,
                lat: logLat,
                lng: logLng,
                acc: logAcc,
                health_status,
                loose_fruit,
                remarks,
            },
            `Palm #${tree.tree_no}: ${bunches}B / ${fronds}F (R${round_no})`
        );

        $("modal-harvest").classList.add("hidden");
        toast(
            res.queued
                ? `Saved offline (Palm #${tree.tree_no}: ${bunches}B / ${fronds}F — queued)`
                : `Harvest logged (Palm #${tree.tree_no}: ${bunches}B / ${fronds}F)`,
            res.queued ? "warn" : "ok"
        );

        // Update local block state immediately for instant UI responsiveness
        tree.rec = {
            tree_id: tree.id,
            bunches,
            fronds,
            harvest_date: date,
            round_no,
            health_status,
            loose_fruit,
            remarks,
            pending_sync: Boolean(res.queued),
        };
        tree.health_status = health_status;
        tree._pendingSync = Boolean(res.queued);
        renderHarvestGrid();
        populateHarvestTreeDropdowns(tree.id);

        if (!res.queued) {
            loadHarvestBlock();
            if (state.activePage === "map" && typeof refreshGisMapData === "function") {
                refreshGisMapData(false);
            }
        }
    } catch (err) {
        toast(err.message, "err");
    } finally {
        btn.disabled = false;
    }
}

// ----------------------------------------------------------------------------
// Mill Dispatch Crop Weight Logger (Offline-Queue Ready + Idempotent client_id)
// ----------------------------------------------------------------------------
function initDispatchForm() {
    const divEl = $("disp-division");
    if (!divEl) return;
    const { divisions } = state.hierarchy;
    const activeEstate = getActiveEstate();
    const scoped = activeEstate ? divisions.filter((d) => d.estate_id === activeEstate.id) : divisions;
    const list = scoped.length ? scoped : divisions;
    divEl.innerHTML = list.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("");
}

async function loadDispatches() {
    const activeEstate = getActiveEstate();
    const qs = activeEstate ? `?estate_id=${activeEstate.id}` : "";
    let remote = [];
    try {
        const data = await api(`/api/dispatch${qs}`);
        remote = data.dispatches || [];
    } catch (_) {
        remote = [];
    }

    const pending = await OfflineSync.getPendingDispatches();
    state.dispatches = [...pending, ...remote];

    const totalKg = state.dispatches.reduce((s, d) => s + Number(d.weight_kg || 0), 0);
    $("disp-total-badge").textContent = `Total: ${totalKg.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg`;

    const tbody = $("disp-tbody");
    if (!state.dispatches.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-[#536471]">No mill dispatch crop weights logged yet</td></tr>`;
        return;
    }

    const canDelete = (ROLE_RANK[state.user?.role] || 0) >= ROLE_RANK.Supervisor;
    tbody.innerHTML = state.dispatches
        .map(
            (d) => `
        <tr class="hover:bg-[#f7f9f9]">
            <td class="py-3.5 px-4 font-mono-code text-[#0f1419] whitespace-nowrap">
                ${esc(d.dispatch_date)}
                ${d.pending_sync ? `<span class="ml-1.5 px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-bold">Queued</span>` : ""}
            </td>
            <td class="py-3.5 px-4 whitespace-nowrap">
                <span class="px-2.5 py-0.5 rounded-full bg-[#0f1419] text-white font-mono-code font-bold text-[11px]">
                    R${d.round_no}
                </span>
            </td>
            <td class="py-3.5 px-4 font-bold text-[#0f1419] whitespace-nowrap">${esc(d.division_name)}</td>
            <td class="py-3.5 px-4 font-mono-code font-extrabold text-[#0f1419] whitespace-nowrap">${Number(d.weight_kg).toLocaleString(undefined, { maximumFractionDigits: 1 })} kg</td>
            <td class="py-3.5 px-4 text-[#536471] whitespace-nowrap">${esc(d.recorded_by || "Staff")}</td>
            <td class="py-3.5 px-4 text-right whitespace-nowrap">
                ${
                    d.pending_sync
                        ? `<button type="button" data-del-pending-dispatch="${esc(d.id)}" class="p-1.5 rounded-full text-amber-600 hover:text-[#f4212e]" title="Discard queued dispatch">
                               <i data-lucide="trash-2" class="w-4 h-4"></i>
                           </button>`
                        : canDelete
                        ? `<button type="button" data-del-dispatch="${d.id}" class="p-1.5 rounded-full text-[#536471] hover:text-[#f4212e]">
                               <i data-lucide="trash-2" class="w-4 h-4"></i>
                           </button>`
                        : ""
                }
            </td>
        </tr>`
        )
        .join("");

    document.querySelectorAll("[data-del-dispatch]").forEach((btn) => {
        btn.onclick = async () => {
            try {
                await api("/api/dispatch/delete", "POST", { id: Number(btn.getAttribute("data-del-dispatch")) });
                toast("Dispatch weight removed");
                await loadDispatches();
            } catch (err) {
                toast(err.message, "err");
            }
        };
    });
    document.querySelectorAll("[data-del-pending-dispatch]").forEach((btn) => {
        btn.onclick = async () => {
            await OfflineDB.removeQueue(btn.getAttribute("data-del-pending-dispatch"));
            await OfflineSync.refreshCount();
            OfflineSync.updateIndicators();
            toast("Queued dispatch discarded");
            await loadDispatches();
        };
    });
    refreshIcons();
}
