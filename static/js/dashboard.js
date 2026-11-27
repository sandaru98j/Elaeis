// ============================================================================
// ELAEIS — Overview Dashboard, Agronomy & Round Analytics, Exports
// Zero hardcoded estate names: dynamically driven by database hierarchy
// ============================================================================

function initDivisionCascade(prefix, onChange) {
    const divEl = $(`${prefix}-division`);
    const fldEl = $(`${prefix}-field`);
    const blkEl = $(`${prefix}-block`);
    if (!divEl || !fldEl || !blkEl) return;

    const { divisions, fields, blocks } = state.hierarchy;
    const activeEstate = getActiveEstate();
    const scopedDivisions = activeEstate
        ? divisions.filter((d) => d.estate_id === activeEstate.id)
        : divisions;
    const divList = scopedDivisions.length ? scopedDivisions : divisions;

    divEl.innerHTML = divList.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("");

    const syncFields = () => {
        const did = Number(divEl.value);
        const fList = fields.filter((f) => f.division_id === did);
        fldEl.innerHTML = fList
            .map((f) => `<option value="${f.id}">${esc(f.name)} (${f.planting_year} - ${Number(f.area_ha).toFixed(2)} Ha)</option>`)
            .join("");
        syncBlocks();
    };
    const syncBlocks = () => {
        const fid = Number(fldEl.value);
        const bList = blocks.filter((b) => b.field_id === fid);
        blkEl.innerHTML = bList
            .map((b) => `<option value="${b.id}">${esc(b.name)} (${b.tree_total} palms)</option>`)
            .join("");
        onChange();
    };

    divEl.onchange = syncFields;
    fldEl.onchange = syncBlocks;
    blkEl.onchange = onChange;

    syncFields();
}

function initDashboardFilters() {
    const estEl = $("flt-estate");
    const divEl = $("flt-division");
    const fldEl = $("flt-field");
    const blkEl = $("flt-block");
    const treeEl = $("flt-tree");
    const { estates, divisions, fields, blocks } = state.hierarchy;

    const activeEstate = getActiveEstate();
    if (estEl) {
        if (estates.length) {
            estEl.innerHTML = estates
                .map((e) => `<option value="${e.id}" ${activeEstate && e.id === activeEstate.id ? "selected" : ""}>${esc(e.name)}</option>`)
                .join("");
            estEl.disabled = estates.length <= 1;
        } else {
            estEl.innerHTML = `<option value="">No Estate Configured</option>`;
            estEl.disabled = true;
        }
    }

    const popDivs = () => {
        const eid = Number(estEl?.value || activeEstate?.id || 0);
        if (eid) setActiveEstateId(eid);
        const list = eid ? divisions.filter((d) => d.estate_id === eid) : divisions;
        divEl.innerHTML =
            `<option value="">All Divisions</option>` +
            list.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("");
        popFields();
    };
    const popFields = () => {
        const eid = Number(estEl?.value || activeEstate?.id || 0);
        const did = Number(divEl.value);
        let list = fields;
        if (did) {
            list = fields.filter((f) => f.division_id === did);
        } else if (eid) {
            const divIds = new Set(divisions.filter((d) => d.estate_id === eid).map((d) => d.id));
            list = fields.filter((f) => divIds.has(f.division_id));
        }
        fldEl.innerHTML =
            `<option value="">All Fields</option>` +
            list
                .map((f) => `<option value="${f.id}">${esc(f.name)} (${f.planting_year} - ${Number(f.area_ha).toFixed(2)} Ha)</option>`)
                .join("");
        popBlocks();
    };
    const popBlocks = () => {
        const eid = Number(estEl?.value || activeEstate?.id || 0);
        const did = Number(divEl.value);
        const fid = Number(fldEl.value);
        let list = blocks;
        if (fid) {
            list = blocks.filter((b) => b.field_id === fid);
        } else if (did) {
            const divFieldIds = new Set(fields.filter((f) => f.division_id === did).map((f) => f.id));
            list = blocks.filter((b) => divFieldIds.has(b.field_id));
        } else if (eid) {
            const divIds = new Set(divisions.filter((d) => d.estate_id === eid).map((d) => d.id));
            const estFieldIds = new Set(fields.filter((f) => divIds.has(f.division_id)).map((f) => f.id));
            list = blocks.filter((b) => estFieldIds.has(b.field_id));
        }
        blkEl.innerHTML =
            `<option value="">All Blocks</option>` +
            list.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join("");
        popTrees();
    };
    const popTrees = async () => {
        const bid = Number(blkEl.value);
        if (!bid) {
            treeEl.innerHTML = `<option value="">All Palms</option>`;
            refreshDashboard();
            return;
        }
        try {
            const bData = await api(`/api/block?block_id=${bid}&mode=map`);
            state.dashTrees = bData.trees || [];
        } catch (_) {
            state.dashTrees = [];
        }
        treeEl.innerHTML =
            `<option value="">All Palms (${state.dashTrees.length})</option>` +
            state.dashTrees.map((t) => `<option value="${t.id}">Palm #${t.tree_no}</option>`).join("");
        refreshDashboard();
    };

    if (estEl) {
        estEl.onchange = () => {
            setActiveEstateId(Number(estEl.value));
            popDivs();
            // Keep Harvest/Map cascades aligned with newly selected Estate
            initDivisionCascade("harv", () => loadHarvestBlock());
            initDivisionCascade("map", () => loadMapperBlock());
            initDispatchForm();
            if (typeof initGisMapFilters === "function") initGisMapFilters();
        };
    }
    divEl.onchange = popFields;
    fldEl.onchange = popBlocks;
    blkEl.onchange = popTrees;
    treeEl.onchange = refreshDashboard;

    populateDynamicYearSelect("flt-season-year", "season");

    const today = todayStr();
    const sMonth = String(state.settings.season_start_month || 4).padStart(2, "0");
    $("flt-time-mode").value = "std";
    $("flt-month").value = today.slice(0, 7);
    $("flt-from").value = `${today.slice(0, 4)}-${sMonth}-01`;
    $("flt-to").value = today;
    $("flt-round").value = "";

    const syncTimeSlots = () => {
        const mode = $("flt-time-mode").value;
        $("flt-time-slot-std").classList.toggle("hidden", mode !== "std");
        $("flt-time-slot-month").classList.toggle("hidden", mode !== "month");
        $("flt-time-custom").classList.toggle("hidden", mode !== "custom");
        refreshDashboard();
    };

    $("flt-time-mode").onchange = syncTimeSlots;
    $("flt-season-year").onchange = refreshDashboard;
    $("flt-month").onchange = refreshDashboard;
    $("flt-round").onchange = refreshDashboard;
    $("flt-from").onchange = refreshDashboard;
    $("flt-to").onchange = refreshDashboard;

    syncTimeSlots();
    popDivs();
}

function getDashboardQuery() {
    const mode = $("flt-time-mode").value;
    const yr = Number($("flt-season-year").value) || new Date().getFullYear();
    const seasonLabel = `${yr}/${String(yr + 1).slice(2)}`;
    const sMonth = String(state.settings.season_start_month || 4).padStart(2, "0");
    const roundVal = $("flt-round").value;

    let from = `${yr}-${sMonth}-01`;
    let to = todayStr();
    let periodBadgeText = `YTD: ${formatShortDateLabel(from)} - ${formatShortDateLabel(to)}`;

    if (mode === "std") {
        from = `${yr}-${sMonth}-01`;
        to = todayStr();
        periodBadgeText = `YTD: ${formatShortDateLabel(from)} - ${formatShortDateLabel(to)}`;
        const stdLbl = $("flt-std-label");
        if (stdLbl) stdLbl.textContent = `${formatShortDateLabel(from)} to ${formatShortDateLabel(to)}`;
    } else if (mode === "month") {
        const ym = $("flt-month").value || todayStr().slice(0, 7);
        from = `${ym}-01`;
        to = `${ym}-31`;
        periodBadgeText = `Month: ${formatMonthYearLabel(ym)}`;
    } else if (mode === "custom") {
        from = $("flt-from").value || `${yr}-${sMonth}-01`;
        to = $("flt-to").value || todayStr();
        periodBadgeText = `Range: ${formatShortDateLabel(from)} - ${formatShortDateLabel(to)}`;
    }

    const yearMonth = mode === "month" ? ($("flt-month").value || todayStr().slice(0, 7)) : (to || todayStr()).slice(0, 7);
    const q = new URLSearchParams({ from, to, year_month: yearMonth });

    const selectedEstateId = Number($("flt-estate")?.value || getActiveEstate()?.id || 0);
    if (selectedEstateId) {
        q.set("estate_id", String(selectedEstateId));
    }
    if (roundVal) {
        q.set("round_no", roundVal);
    }

    const estateObj =
        (state.hierarchy.estates || []).find((e) => e.id === selectedEstateId) || getActiveEstate();
    const estateName = estateObj?.name || "Plantation Estate";
    const roundBadgeText = roundVal ? `Filter: Round ${roundVal}` : "Filter: Entire Month";
    const scopeParts = [];

    const addPart = (id, param) => {
        const el = $(id);
        if (el && el.value) {
            q.set(param, el.value);
            const rawTxt = el.options[el.selectedIndex]?.text || "";
            if (rawTxt) scopeParts.push(rawTxt);
        }
    };
    addPart("flt-division", "division_id");
    addPart("flt-field", "field_id");
    addPart("flt-block", "block_id");
    addPart("flt-tree", "tree_id");

    if ($("dash-estate-heading")) $("dash-estate-heading").textContent = estateName;
    if ($("badge-season")) $("badge-season").textContent = `Season ${seasonLabel}`;
    if ($("badge-period")) $("badge-period").textContent = periodBadgeText;
    if ($("badge-filter-round")) $("badge-filter-round").textContent = roundBadgeText;
    if ($("badge-scope") && $("badge-scope-sep")) {
        const hasScope = scopeParts.length > 0;
        $("badge-scope").textContent = scopeParts.join(" • ");
        $("badge-scope").classList.toggle("hidden", !hasScope);
        $("badge-scope-sep").classList.toggle("hidden", !hasScope);
    }

    return q.toString();
}

function renderAgronomySection(agro) {
    if (!agro) return;
    const sum = agro.summary || {};

    if ($("agro-coverage-pct")) $("agro-coverage-pct").textContent = `${Number(sum.coverage_pct || 0).toFixed(1)}%`;
    if ($("agro-coverage-sub")) {
        $("agro-coverage-sub").textContent = `${Number(sum.harvested_trees || 0).toLocaleString()} / ${Number(sum.active_trees || 0).toLocaleString()} palms`;
    }
    if ($("agro-coverage-bar")) {
        $("agro-coverage-bar").style.width = `${Math.min(100, Math.max(0, Number(sum.coverage_pct || 0)))}%`;
    }

    if ($("agro-fbr")) $("agro-fbr").textContent = Number(sum.fbr || 0).toFixed(2);
    if ($("agro-pruning-badge")) {
        const st = sum.pruning_status || "No Data";
        $("agro-pruning-badge").textContent = st;
        const cls =
            st === "Optimal"
                ? "bg-emerald-100 text-emerald-800"
                : st === "Over-Pruned"
                ? "bg-red-100 text-red-700"
                : st === "Under-Pruned"
                ? "bg-amber-100 text-amber-800"
                : "bg-[#eff3f4] text-[#536471]";
        $("agro-pruning-badge").className = `px-2 py-0.5 rounded-full text-[10px] font-bold ${cls}`;
    }

    if ($("agro-loose-pct")) $("agro-loose-pct").textContent = `${Number(sum.loose_fruit_pct ?? 100).toFixed(1)}%`;
    if ($("agro-flagged-cnt")) $("agro-flagged-cnt").textContent = String(sum.flagged_trees || 0);

    // Round-by-Round Comparison Cards (R1 / R2 / R3)
    const roundsEl = $("agro-rounds-grid");
    if (roundsEl) {
        const rounds = agro.rounds || [];
        roundsEl.innerHTML = rounds
            .map(
                (r) => `
            <div class="erp-card !p-3.5 space-y-2">
                <div class="flex items-center justify-between gap-2">
                    <span class="px-2.5 py-0.5 rounded-full bg-[#0f1419] text-white font-mono-code font-bold text-[10px]">
                        Round ${r.round_no}
                    </span>
                    <span class="text-[11px] font-mono-code font-bold text-[#536471]">
                        ${Number(r.coverage_pct || 0).toFixed(1)}% cov
                    </span>
                </div>
                <div class="grid grid-cols-2 gap-2 text-xs">
                    <div>
                        <div class="text-[10px] text-[#536471] font-bold uppercase">Bunches</div>
                        <div class="font-mono-code font-extrabold text-[#0f1419]">${Number(r.bunches || 0).toLocaleString()}</div>
                    </div>
                    <div>
                        <div class="text-[10px] text-[#536471] font-bold uppercase">Fronds</div>
                        <div class="font-mono-code font-extrabold text-[#0f1419]">${Number(r.fronds || 0).toLocaleString()}</div>
                    </div>
                    <div>
                        <div class="text-[10px] text-[#536471] font-bold uppercase">Dispatch</div>
                        <div class="font-mono-code font-bold text-[#0f1419]">${Number(r.dispatch_kg || 0).toLocaleString()} kg</div>
                    </div>
                    <div>
                        <div class="text-[10px] text-[#536471] font-bold uppercase">ABW / FBR</div>
                        <div class="font-mono-code font-bold text-[#0f1419]">${Number(r.abw || 0).toFixed(1)}kg &bull; ${Number(r.fbr || 0).toFixed(2)}</div>
                    </div>
                </div>
            </div>`
            )
            .join("");
    }

    // Division Performance Leaderboard
    const divTbody = $("agro-division-tbody");
    if (divTbody) {
        const divs = agro.divisions || [];
        if (!divs.length) {
            divTbody.innerHTML = `<tr><td colspan="7" class="py-5 text-center text-xs text-[#536471]">No division data in this filter window.</td></tr>`;
        } else {
            divTbody.innerHTML = divs
                .map(
                    (d) => `
                <tr class="hover:bg-[#f7f9f9]">
                    <td class="py-2.5 px-3 font-extrabold text-[#0f1419] whitespace-nowrap">${esc(d.name)}</td>
                    <td class="py-2.5 px-3 font-mono-code text-[#536471] whitespace-nowrap">${Number(d.area_ha || 0).toFixed(2)} Ha</td>
                    <td class="py-2.5 px-3 font-mono-code font-bold text-[#0f1419] whitespace-nowrap">${Number(d.coverage_pct || 0).toFixed(1)}%</td>
                    <td class="py-2.5 px-3 font-mono-code font-bold text-[#0f1419] whitespace-nowrap">${Number(d.bunches || 0).toLocaleString()}</td>
                    <td class="py-2.5 px-3 font-mono-code text-[#536471] whitespace-nowrap">${Number(d.fbr || 0).toFixed(2)}</td>
                    <td class="py-2.5 px-3 font-mono-code font-bold text-[#0f1419] whitespace-nowrap">${Number(d.abw || 0).toFixed(2)} kg</td>
                    <td class="py-2.5 px-3 font-mono-code font-extrabold text-[#0f1419] text-right whitespace-nowrap">${Number(d.yph || 0).toFixed(1)} kg/Ha</td>
                </tr>`
                )
                .join("");
        }
    }
}

async function refreshDashboard() {
    const qs = getDashboardQuery();
    let rep = null;
    try {
        rep = await api(`/api/report?${qs}`);
    } catch (err) {
        toast(err.message || "Unable to load report while offline", "warn");
        return;
    }

    const tot = rep.totals || {};
    state.recentLogs = rep.recent_logs || [];

    const bunchesTxt = Number(tot.bunches || 0).toLocaleString();
    const frondsTxt = Number(tot.fronds || 0).toLocaleString();
    const dispTxt = `${Number(tot.dispatch_kg || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} kg`;
    const abwTxt = `${Number(tot.abw || 0).toFixed(2)} kg`;
    const yphTxt = `${Number(tot.yph || 0).toFixed(2)} kg/Ha`;
    const haTxt = `${Number(tot.area_ha || 0).toFixed(2)} Ha`;

    $("kpi-bunches").textContent = bunchesTxt;
    $("kpi-harvest-trees").textContent = `${tot.trees || 0} palms harvested`;
    $("kpi-fronds").textContent = frondsTxt;
    $("kpi-harvest-recs").textContent = `${tot.records || 0} harvest logs`;
    $("kpi-dispatch-kg").textContent = dispTxt;
    $("kpi-dispatch-recs").textContent = `${tot.dispatch_records || 0} mill dispatches`;
    $("kpi-abw").textContent = abwTxt;
    $("kpi-yph").textContent = yphTxt;
    $("kpi-area-ha").textContent = `Extent: ${haTxt}`;

    if ($("right-kpi-bunches")) $("right-kpi-bunches").textContent = bunchesTxt;
    if ($("right-kpi-fronds")) $("right-kpi-fronds").textContent = frondsTxt;
    if ($("right-kpi-dispatch")) $("right-kpi-dispatch").textContent = dispTxt;
    if ($("right-kpi-abw")) $("right-kpi-abw").textContent = abwTxt;
    if ($("right-kpi-yph")) $("right-kpi-yph").textContent = yphTxt;
    if ($("right-extent-ha")) $("right-extent-ha").textContent = haTxt;

    // Fetch Agronomy & Round Comparison Analytics in parallel
    api(`/api/analytics/agronomy?${qs}`)
        .then((agro) => {
            state.agronomy = agro;
            renderAgronomySection(agro);
        })
        .catch(() => {});

    // Render Structured Recent Harvest Cards
    const feedEl = $("overview-feed-list");
    if (feedEl) {
        const logs = state.recentLogs;
        if (!logs.length) {
            feedEl.innerHTML = `<div class="erp-detail-card md:col-span-2 !p-6 text-center text-xs text-[#536471]">No harvest logs recorded in this filter window.</div>`;
        } else {
            feedEl.innerHTML = logs
                .map((l, idx) => {
                    const flagged = l.health_status && l.health_status !== "Healthy";
                    return `
                <div data-feed-idx="${idx}" class="erp-detail-card cursor-pointer space-y-3">
                    <div class="flex items-start justify-between gap-2">
                        <div class="flex items-center gap-2.5 min-w-0">
                            <div class="w-9 h-9 rounded-full bg-[#0f1419] text-white font-mono-code font-extrabold text-xs flex items-center justify-center shrink-0">
                                #${l.tree_no || "-"}
                            </div>
                            <div class="min-w-0">
                                <div class="font-extrabold text-xs sm:text-sm text-[#0f1419] truncate">
                                    Palm #${l.tree_no || "-"} &bull; ${esc(l.block_name || "Block")}
                                </div>
                                <div class="text-[11px] text-[#536471] truncate">
                                    ${esc(l.division_name || "Division")} &rarr; ${esc(l.field_name || "Field")}
                                </div>
                            </div>
                        </div>
                        <div class="flex items-center gap-1 shrink-0">
                            ${flagged ? `<span class="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-bold text-[10px]">${esc(l.health_status)}</span>` : ""}
                            <span class="px-2.5 py-0.5 rounded-full bg-[#0f1419] text-white font-mono-code font-bold text-[10px]">
                                Round ${l.round_no}
                            </span>
                        </div>
                    </div>

                    <div class="grid grid-cols-3 gap-2 pt-2 border-t border-[#eff3f4] text-center">
                        <div class="p-2 rounded-xl bg-[#f7f9f9]">
                            <div class="text-[10px] font-bold uppercase text-[#536471]">Bunches</div>
                            <div class="text-xs font-mono-code font-extrabold text-[#0f1419] mt-0.5">${l.bunches}</div>
                        </div>
                        <div class="p-2 rounded-xl bg-[#f7f9f9]">
                            <div class="text-[10px] font-bold uppercase text-[#536471]">Fronds</div>
                            <div class="text-xs font-mono-code font-extrabold text-[#0f1419] mt-0.5">${l.fronds}</div>
                        </div>
                        <div class="p-2 rounded-xl bg-[#f7f9f9]">
                            <div class="text-[10px] font-bold uppercase text-[#536471]">Date</div>
                            <div class="text-[11px] font-mono-code font-bold text-[#0f1419] mt-0.5 truncate">${esc(l.harvest_date)}</div>
                        </div>
                    </div>

                    <div class="flex items-center justify-between text-[11px] text-[#536471]">
                        <span>Harvester: <strong class="text-[#0f1419]">${esc(l.recorded_by || "Staff")}</strong></span>
                        <span class="font-bold underline">Inspect &rarr;</span>
                    </div>
                </div>`;
                })
                .join("");

            feedEl.onclick = (e) => {
                const card = e.target.closest("[data-feed-idx]");
                if (!card) return;
                const item = state.recentLogs[Number(card.getAttribute("data-feed-idx"))];
                if (!item) return;
                const fields = [
                    { label: "Estate", value: item.estate_name || getActiveEstateName() },
                    { label: "Division", value: item.division_name || "Division" },
                    { label: "Field & Block", value: `${item.field_name} • ${item.block_name}` },
                    { label: "Bunches Cut", value: `${item.bunches} Fresh Fruit Bunches`, mono: true },
                    { label: "Fronds Cut", value: `${item.fronds} Pruned Fronds`, mono: true },
                    { label: "Palm Health", value: item.health_status || "Healthy" },
                    { label: "Loose Fruit", value: item.loose_fruit === 0 ? "Not Collected" : "Collected" },
                    { label: "Harvest Date", value: item.harvest_date, mono: true },
                    { label: "Recorded By", value: item.recorded_by || "Field Harvester" },
                ];
                if (item.remarks) {
                    fields.push({ label: "Field Notes", value: item.remarks, full: true });
                }
                openItemDetailModal({
                    badge: `Harvest Log #${item.id} • Round ${item.round_no}`,
                    title: `Palm #${item.tree_no} — ${item.block_name}`,
                    fields,
                });
            };
        }
    }
    refreshIcons();
}

function extractFilenameFromDisposition(cdHeader, fallback) {
    if (!cdHeader) return fallback;
    const match = cdHeader.match(/filename="?([^";\n]+)"?/i);
    return match && match[1] ? match[1] : fallback;
}

async function downloadDashboardExcel() {
    const qs = getDashboardQuery();
    const qParams = new URLSearchParams(qs);
    const ym = qParams.get("year_month") || todayStr().slice(0, 7);
    const fallbackName = `${getEstateSlug()}_Harvest_Report_${ym}.xlsx`;
    const headers = {};
    if (state.token) headers["Authorization"] = `Bearer ${state.token}`;

    let blob = null;
    let filename = fallbackName;

    for (const endpoint of [`/api/export/excel?${qs}`, `/export/excel?${qs}`, `/api/report.xlsx?${qs}`]) {
        try {
            const res = await fetch(endpoint, { method: "GET", headers });
            const ct = (res.headers.get("content-type") || "").toLowerCase();
            if (res.ok && (ct.includes("spreadsheetml") || ct.includes("octet-stream") || ct.includes("excel"))) {
                filename = extractFilenameFromDisposition(res.headers.get("content-disposition"), fallbackName);
                blob = await res.blob();
                break;
            }
        } catch (_) {}
    }

    if (!blob) {
        return toast("Excel export requires a network connection.", "warn");
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(`${filename} downloaded`);
}

async function downloadDashboardCsv() {
    const qs = getDashboardQuery();
    const fallbackName = `${getEstateSlug()}_KPI_Report_${todayStr()}.csv`;
    const headers = {};
    if (state.token) headers["Authorization"] = `Bearer ${state.token}`;

    try {
        const res = await fetch(`/api/report.csv?${qs}`, { method: "GET", headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const filename = extractFilenameFromDisposition(res.headers.get("content-disposition"), fallbackName);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast(`${filename} downloaded`);
    } catch (_) {
        toast("CSV export requires a network connection.", "warn");
    }
}
