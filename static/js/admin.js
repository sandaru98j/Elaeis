// ============================================================================
// ELAEIS — Estates Hierarchy CRUD, GPS Tree Mapper, Corporate Directory & Profile
// ============================================================================

async function loadEstatesPage() {
    try {
        const boot = await api("/api/bootstrap");
        state.hierarchy = boot.hierarchy;
        state.settings = boot.settings || { season_start_month: 4 };
        if (Array.isArray(boot.mapped_trees)) {
            state.mappedTrees = boot.mapped_trees;
        }
    } catch (err) {
        toast(err.message || "Loaded cached hierarchy", "warn");
    }

    if ($("set-season-month")) {
        $("set-season-month").value = state.settings.season_start_month || 4;
    }

    renderAdminHierarchy();
    if (state.estatesTab === "mapper") await loadMapperBlock();
    refreshIcons();
}

async function loadMapperBlock() {
    const bid = Number($("map-block")?.value);
    if (!bid) return;
    try {
        const data = await api(`/api/block?block_id=${bid}&mode=map`);
        const merged = await OfflineSync.applyPendingToBlockTrees(bid, todayStr(), 1, data.trees || []);
        state.mapBlock.block_id = bid;
        state.mapBlock.trees = merged;
        state.mapBlock.trees.forEach((t) => syncMappedTreeInCache({ ...t, block_id: bid }));
    } catch (err) {
        toast(err.message || "Unable to load block for mapper", "warn");
        return;
    }

    const mapped = state.mapBlock.trees.filter((t) => t.lat !== null && t.lng !== null).length;
    $("map-stats-label").textContent = `${mapped} / ${state.mapBlock.trees.length} GPS Mapped`;

    const grid = $("map-grid");
    if (!grid) return;

    const parts = new Array(state.mapBlock.trees.length);
    for (let i = 0; i < state.mapBlock.trees.length; i++) {
        const t = state.mapBlock.trees[i];
        const hasGps = t.lat !== null && t.lng !== null;
        parts[i] = `<div data-map-tree="${t.id}" class="palm-card ${hasGps ? "mapped-gps" : ""} ${t._pendingSync ? "pending-sync-palm" : ""}">
            <div class="w-full flex items-center justify-between text-[10px] font-mono-code text-[#536471]">
                <span>#${t.tree_no}</span>
                <span class="${hasGps ? "text-[#0f1419]" : "text-[#cfd9de]"}">${INLINE_SVG_PIN}</span>
            </div>
            <div class="text-[10px] font-mono-code font-bold ${hasGps ? "text-[#0f1419]" : "text-[#536471]"} text-center leading-tight mt-1">
                ${hasGps ? `${Number(t.lat).toFixed(4)}<br/>${Number(t.lng).toFixed(4)}` : "Unmapped"}
            </div>
        </div>`;
    }
    grid.innerHTML = parts.join("");

    if (!grid._delegatedBound) {
        grid.addEventListener("click", (e) => {
            const card = e.target.closest("[data-map-tree]");
            if (!card) return;
            openMapperModal(Number(card.getAttribute("data-map-tree")));
        });
        grid._delegatedBound = true;
    }
}

async function openMapperModal(treeId = null) {
    const trees = state.mapBlock.trees || [];
    const existing = treeId ? trees.find((t) => t.id === treeId) : null;
    state.modalTree = existing;

    const nextNo = trees.reduce((m, t) => Math.max(m, t.tree_no), 0) + 1;
    $("mp-title").textContent = existing ? `Edit Palm #${existing.tree_no} GPS` : "Map New Palm (Live GPS)";
    $("mp-tree-no").value = existing ? existing.tree_no : nextNo;
    $("btn-mp-delete").classList.toggle("hidden", !existing);
    updateGpsAccuracyPills();

    if (existing && existing.lat !== null && existing.lng !== null) {
        $("mp-lat").value = existing.lat;
        $("mp-lng").value = existing.lng;
    } else {
        const gps = await captureDeviceGps();
        $("mp-lat").value = gps.lat ?? "";
        $("mp-lng").value = gps.lng ?? "";
    }
    $("modal-mapper").classList.remove("hidden");
    refreshIcons();
}

async function saveMapperModal() {
    const bid = state.mapBlock.block_id;
    if (!bid) return;
    try {
        const treeNo = Number($("mp-tree-no").value);
        const lat = Number($("mp-lat").value);
        const lng = Number($("mp-lng").value);
        if (!Number.isFinite(treeNo) || treeNo < 1) return toast("Enter a valid Palm Number.", "err");
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
            return toast("Enter valid Latitude and Longitude coordinates.", "err");
        }

        const res = await apiFieldWrite(
            "tree_save",
            "/api/admin/tree/save",
            {
                id: state.modalTree?.id || null,
                block_id: bid,
                tree_no: treeNo,
                lat: Number(lat.toFixed(6)),
                lng: Number(lng.toFixed(6)),
                acc: state.gps.acc || 4.0,
                status: "active",
            },
            `Map Palm #${treeNo} (${lat.toFixed(4)}, ${lng.toFixed(4)})`
        );

        if (state.modalTree?.id) {
            syncMappedTreeInCache({
                id: state.modalTree.id,
                block_id: bid,
                tree_no: treeNo,
                lat: Number(lat.toFixed(6)),
                lng: Number(lng.toFixed(6)),
                gps_acc: state.gps.acc || 4.0,
            });
        }
        $("modal-mapper").classList.add("hidden");
        toast(res.queued ? "Palm GPS queued for offline sync" : "Palm GPS coordinates saved", res.queued ? "warn" : "ok");
        await loadMapperBlock();
    } catch (err) {
        toast(err.message, "err");
    }
}

async function deleteMapperTree() {
    if (!state.modalTree) return;
    try {
        await api("/api/admin/tree/delete", "POST", { id: state.modalTree.id });
        syncMappedTreeInCache({ id: state.modalTree.id, lat: null, lng: null });
        $("modal-mapper").classList.add("hidden");
        toast(`Deleted Palm #${state.modalTree.tree_no}`);
        await loadMapperBlock();
    } catch (err) {
        toast(err.message, "err");
    }
}

function renderAdminHierarchy() {
    const { estates, divisions, fields, blocks } = state.hierarchy;

    $("crud-estates").innerHTML = estates
        .map(
            (e) => `
        <div class="p-3.5 rounded-xl bg-[#f7f9f9] border border-[#eff3f4] flex items-center justify-between gap-2 text-xs">
            <div class="min-w-0">
                <div class="font-extrabold text-[#0f1419] truncate">${esc(e.name)}</div>
                ${e.location_region ? `<div class="text-[11px] text-[#536471] truncate">${esc(e.location_region)}</div>` : ""}
            </div>
            <div class="flex items-center gap-1 shrink-0">
                <button type="button" data-edit-estate="${e.id}" class="p-1.5 rounded-lg text-[#536471] hover:text-[#0f1419]"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                <button type="button" data-del-entity="estate:${e.id}" class="p-1.5 rounded-lg text-[#536471] hover:text-[#f4212e]"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
            </div>
        </div>`
        )
        .join("");

    $("crud-divisions").innerHTML = divisions
        .map((d) => {
            const est = estates.find((e) => e.id === d.estate_id);
            return `
            <div class="p-3.5 rounded-xl bg-[#f7f9f9] border border-[#eff3f4] flex items-center justify-between gap-2 text-xs">
                <div class="min-w-0">
                    <div class="font-extrabold text-[#0f1419] truncate">${esc(d.name)}</div>
                    <div class="text-[11px] text-[#536471] truncate">${esc(est?.name || "Estate")}</div>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                    <button type="button" data-edit-division="${d.id}" class="p-1.5 rounded-lg text-[#536471] hover:text-[#0f1419]"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                    <button type="button" data-del-entity="division:${d.id}" class="p-1.5 rounded-lg text-[#536471] hover:text-[#f4212e]"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                </div>
            </div>`;
        })
        .join("");

    $("crud-fields").innerHTML = fields
        .map((f) => {
            const div = divisions.find((d) => d.id === f.division_id);
            return `
            <div class="p-3.5 rounded-xl bg-[#f7f9f9] border border-[#eff3f4] flex items-center justify-between gap-2 text-xs">
                <div class="min-w-0">
                    <div class="flex flex-wrap items-center gap-1.5">
                        <span class="font-extrabold text-[#0f1419]">${esc(f.name)}</span>
                        <span class="px-2 py-0.5 rounded-md bg-white border border-[#cfd9de] font-mono-code text-[10px] font-bold">${f.planting_year}</span>
                        <span class="px-2 py-0.5 rounded-md bg-white border border-[#cfd9de] font-mono-code text-[10px] font-bold">${Number(f.area_ha).toFixed(2)} Ha</span>
                    </div>
                    <div class="text-[11px] text-[#536471] mt-0.5 truncate">${esc(div?.name || "")}</div>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                    <button type="button" data-edit-field="${f.id}" class="p-1.5 rounded-lg text-[#536471] hover:text-[#0f1419]"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                    <button type="button" data-del-entity="field:${f.id}" class="p-1.5 rounded-lg text-[#536471] hover:text-[#f4212e]"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                </div>
            </div>`;
        })
        .join("");

    $("crud-blocks").innerHTML = blocks
        .map((b) => {
            const fld = fields.find((f) => f.id === b.field_id);
            return `
            <div class="p-3.5 rounded-xl bg-[#f7f9f9] border border-[#eff3f4] flex items-center justify-between gap-2 text-xs">
                <div class="min-w-0">
                    <div class="flex flex-wrap items-center gap-1.5">
                        <span class="font-extrabold text-[#0f1419]">${esc(b.name)}</span>
                        <span class="px-2 py-0.5 rounded-md bg-white border border-[#cfd9de] font-mono-code text-[10px] font-bold">${b.tree_total} palms</span>
                        <span class="px-2 py-0.5 rounded-md bg-white border border-[#cfd9de] font-mono-code text-[10px] text-[#536471]">${b.tree_mapped || 0} GPS</span>
                    </div>
                    <div class="text-[11px] text-[#536471] mt-0.5 truncate">${esc(fld ? `${fld.name} (${fld.planting_year})` : "")} ${b.boundary_note ? `• ${esc(b.boundary_note)}` : ""}</div>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                    <button type="button" data-batch-block="${b.id}" class="px-2.5 py-1 rounded-full bg-white border border-[#cfd9de] text-[#0f1419] font-mono-code text-[10px] font-bold">+Palms</button>
                    <button type="button" data-edit-block="${b.id}" class="p-1.5 rounded-lg text-[#536471] hover:text-[#0f1419]"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                    <button type="button" data-del-entity="block:${b.id}" class="p-1.5 rounded-lg text-[#536471] hover:text-[#f4212e]"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                </div>
            </div>`;
        })
        .join("");

    document.querySelectorAll("[data-del-entity]").forEach((btn) => {
        btn.onclick = async () => {
            const [ent, id] = btn.getAttribute("data-del-entity").split(":");
            try {
                await api(`/api/admin/${ent}/delete`, "POST", { id: Number(id) });
                toast(`Removed ${ent}`);
                await loadEstatesPage();
                await loadBootstrap();
            } catch (err) {
                toast(err.message, "err");
            }
        };
    });

    document.querySelectorAll("[data-edit-estate]").forEach((b) => {
        b.onclick = () => openCrudModal("estate", estates.find((x) => x.id === Number(b.getAttribute("data-edit-estate"))));
    });
    document.querySelectorAll("[data-edit-division]").forEach((b) => {
        b.onclick = () => openCrudModal("division", divisions.find((x) => x.id === Number(b.getAttribute("data-edit-division"))));
    });
    document.querySelectorAll("[data-edit-field]").forEach((b) => {
        b.onclick = () => openCrudModal("field", fields.find((x) => x.id === Number(b.getAttribute("data-edit-field"))));
    });
    document.querySelectorAll("[data-edit-block]").forEach((b) => {
        b.onclick = () => openCrudModal("block", blocks.find((x) => x.id === Number(b.getAttribute("data-edit-block"))));
    });
    document.querySelectorAll("[data-batch-block]").forEach((b) => {
        b.onclick = () => openCrudModal("batch", blocks.find((x) => x.id === Number(b.getAttribute("data-batch-block"))));
    });
}

function openCrudModal(type, item = null) {
    const body = $("ac-body");
    const { estates, divisions, fields } = state.hierarchy;

    if (type === "estate") {
        $("ac-title").textContent = item ? "Edit Estate" : "Add Estate";
        body.innerHTML = `
            <input id="ac-name" type="text" placeholder="Estate Name" value="${esc(item?.name || "")}" class="x-input" />
            <input id="ac-region" type="text" placeholder="Location / Region (optional)" value="${esc(item?.location_region || "")}" class="x-input" />`;
        state.crudCallback = () =>
            api("/api/admin/estate/save", "POST", {
                id: item?.id,
                name: $("ac-name").value,
                location_region: $("ac-region").value,
            });
    } else if (type === "division") {
        $("ac-title").textContent = item ? "Edit Division" : "Add Division";
        body.innerHTML = `
            <select id="ac-parent" class="x-input ${item ? "hidden" : ""}">
                ${estates.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join("")}
            </select>
            <input id="ac-name" type="text" placeholder="Division Name" value="${esc(item?.name || "")}" class="x-input" />`;
        state.crudCallback = () =>
            api("/api/admin/division/save", "POST", {
                id: item?.id,
                estate_id: Number($("ac-parent").value),
                name: $("ac-name").value,
            });
    } else if (type === "field") {
        $("ac-title").textContent = item ? "Edit Field" : "Add Field (Year & Ha)";
        body.innerHTML = `
            <select id="ac-parent" class="x-input ${item ? "hidden" : ""}">
                ${divisions.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("")}
            </select>
            <input id="ac-name" type="text" placeholder="Field Name (e.g. Field 7)" value="${esc(item?.name || "")}" class="x-input" />
            <div class="grid grid-cols-2 gap-2">
                <input id="ac-year" type="number" placeholder="Planting Year" value="${item?.planting_year || new Date().getFullYear()}" class="x-input font-mono-code" />
                <input id="ac-ha" type="number" step="0.01" placeholder="Area Ha" value="${item?.area_ha || 10.0}" class="x-input font-mono-code" />
            </div>`;
        state.crudCallback = () =>
            api("/api/admin/field/save", "POST", {
                id: item?.id,
                division_id: Number($("ac-parent").value),
                name: $("ac-name").value,
                planting_year: Number($("ac-year").value),
                area_ha: Number($("ac-ha").value),
            });
    } else if (type === "block") {
        $("ac-title").textContent = item ? "Edit Block" : "Add Block";
        body.innerHTML = `
            <select id="ac-parent" class="x-input ${item ? "hidden" : ""}">
                ${fields.map((f) => `<option value="${f.id}">${esc(f.name)} (${f.planting_year} - ${f.area_ha}Ha)</option>`).join("")}
            </select>
            <input id="ac-name" type="text" placeholder="Block Name (e.g. Block C)" value="${esc(item?.name || "")}" class="x-input" />
            <input id="ac-note" type="text" placeholder="Boundary note" value="${esc(item?.boundary_note || "")}" class="x-input" />
            ${
                item
                    ? ""
                    : `<input id="ac-count" type="number" min="0" max="3000" value="280" placeholder="Initial Palm Count (~300)" class="x-input font-mono-code" />`
            }`;
        state.crudCallback = () =>
            api("/api/admin/block/save", "POST", {
                id: item?.id,
                field_id: Number($("ac-parent").value),
                name: $("ac-name").value,
                boundary_note: $("ac-note").value,
                tree_count: item ? undefined : Number($("ac-count").value),
            });
    } else if (type === "batch") {
        $("ac-title").textContent = `Batch Generate Palms • ${item?.name}`;
        body.innerHTML = `<input id="ac-batch-count" type="number" min="1" max="3000" value="50" placeholder="Number of palms to add" class="x-input font-mono-code" />`;
        state.crudCallback = () =>
            api("/api/admin/trees/batch", "POST", {
                block_id: item.id,
                count: Number($("ac-batch-count").value),
            });
    }

    $("modal-admin-crud").classList.remove("hidden");
}

// ----------------------------------------------------------------------------
// Corporate Directory & RBAC User Management
// ----------------------------------------------------------------------------
async function loadDirectoryPage() {
    try {
        const uData = await api("/api/admin/users");
        state.adminUsers = uData;
        renderDirectoryUsers();
        refreshIcons();
    } catch (err) {
        toast(err.message || "Directory requires an online connection", "warn");
    }
}

function renderDirectoryUsers() {
    const users = state.adminUsers.users || [];
    const isMasterViewer = Boolean(state.user?.is_master) || normalizeRole(state.user?.role) === "Master Admin";

    if ($("adm-total-users-badge")) $("adm-total-users-badge").textContent = users.length;
    if ($("master-admin-banner")) $("master-admin-banner").classList.toggle("hidden", !isMasterViewer);

    $("adm-users-list").innerHTML = users
        .map((u) => {
            const uMaster = Boolean(u.is_master) || normalizeRole(u.role) === "Master Admin";
            const uRole = uMaster ? "Master Admin" : normalizeRole(u.role);
            const initials = (u.full_name || "U")
                .split(" ")
                .filter(Boolean)
                .map((w) => w[0])
                .join("")
                .slice(0, 2)
                .toUpperCase();

            return `
            <div class="erp-detail-card !p-4 sm:!p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div class="flex items-center gap-3 min-w-0">
                    <div class="w-10 h-10 rounded-full ${uMaster ? "bg-[#0f1419] text-white" : "bg-[#eff3f4] text-[#0f1419]"} flex items-center justify-center font-extrabold text-xs shrink-0">
                        ${esc(initials)}
                    </div>
                    <div class="min-w-0">
                        <div class="flex flex-wrap items-center gap-2">
                            <span class="text-sm font-extrabold text-[#0f1419] truncate">${esc(u.full_name)}</span>
                            <span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold ${
                                uMaster ? "bg-[#0f1419] text-white" : "bg-[#eff3f4] text-[#0f1419]"
                            }">${esc(uRole)}</span>
                        </div>
                        <div class="text-xs font-mono-code text-[#536471]">@${esc(u.username)}</div>
                    </div>
                </div>

                <div class="flex flex-wrap items-center gap-2">
                    ${
                        isMasterViewer
                            ? `<button type="button" data-force-pw-user="${u.id}" class="x-btn-outline !py-1.5 !px-3 !text-xs">
                                   <i data-lucide="key-round" class="w-3.5 h-3.5"></i>
                                   <span>Reset Password</span>
                               </button>`
                            : ""
                    }
                    ${
                        uMaster
                            ? `<span class="px-3 py-1.5 rounded-full bg-[#f7f9f9] border border-[#cfd9de] text-xs font-bold text-[#0f1419]">Master Admin</span>`
                            : `
                        <select data-user-role="${u.id}" class="x-input !w-auto !py-1.5 !px-3 !rounded-full text-xs font-bold">
                            <option value="Harvester" ${uRole === "Harvester" ? "selected" : ""}>Harvester</option>
                            <option value="Supervisor" ${uRole === "Supervisor" ? "selected" : ""}>Supervisor</option>
                            <option value="Admin" ${uRole === "Admin" ? "selected" : ""}>Admin</option>
                        </select>
                        <button type="button" data-del-user="${u.id}" title="Remove User" class="p-2 rounded-full border border-[#cfd9de] hover:text-[#f4212e] text-[#536471]">
                            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                        </button>`
                    }
                </div>
            </div>`;
        })
        .join("");

    document.querySelectorAll("[data-user-role]").forEach((sel) => {
        sel.onchange = async () => {
            try {
                await api("/api/admin/users/role", "POST", {
                    user_id: Number(sel.getAttribute("data-user-role")),
                    role: sel.value,
                });
                toast(`Updated role to ${sel.value}`);
                await loadDirectoryPage();
            } catch (err) {
                toast(err.message, "err");
                await loadDirectoryPage();
            }
        };
    });

    document.querySelectorAll("[data-force-pw-user]").forEach((btn) => {
        btn.onclick = () => {
            const uid = Number(btn.getAttribute("data-force-pw-user"));
            const target = users.find((x) => x.id === uid);
            if (!target) return;
            state.forcePwTarget = target;
            $("fp-title").textContent = `Force Reset Password • ${target.full_name}`;
            $("fp-subtitle").textContent = `@${target.username}`;
            $("fp-new-password").value = "";
            $("modal-force-password").classList.remove("hidden");
        };
    });

    document.querySelectorAll("[data-del-user]").forEach((btn) => {
        btn.onclick = async () => {
            try {
                await api("/api/admin/users/delete", "POST", { user_id: Number(btn.getAttribute("data-del-user")) });
                toast("User removed from Directory");
                await loadDirectoryPage();
            } catch (err) {
                toast(err.message, "err");
            }
        };
    });
}

// ----------------------------------------------------------------------------
// Profile View & Edit Profile Modal
// ----------------------------------------------------------------------------
function syncUserIdentityUI() {
    if (!state.user) return;
    const u = state.user;
    const initials = (u.full_name || "U")
        .split(" ")
        .filter(Boolean)
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();

    const hasAvatar = Boolean(u.profile_pic);
    const hasCover = Boolean(u.cover_photo);

    if ($("rail-user-avatar-initials")) {
        $("rail-user-avatar-initials").textContent = initials;
        $("rail-user-avatar-initials").classList.toggle("hidden", hasAvatar);
    }
    if ($("rail-user-avatar-img")) {
        if (hasAvatar) $("rail-user-avatar-img").src = u.profile_pic;
        $("rail-user-avatar-img").classList.toggle("hidden", !hasAvatar);
    }
    if ($("rail-user-name")) $("rail-user-name").textContent = u.full_name;
    if ($("rail-user-handle")) $("rail-user-handle").textContent = `@${u.username}`;
    if ($("rail-user-role")) $("rail-user-role").textContent = u.role;

    if ($("drawer-user-name")) $("drawer-user-name").textContent = u.full_name;
    if ($("drawer-user-handle")) $("drawer-user-handle").textContent = `@${u.username} • ${u.role}`;

    if ($("prof-avatar-inner")) {
        $("prof-avatar-inner").textContent = initials;
        $("prof-avatar-inner").classList.toggle("hidden", hasAvatar);
    }
    if ($("prof-avatar-img")) {
        if (hasAvatar) $("prof-avatar-img").src = u.profile_pic;
        $("prof-avatar-img").classList.toggle("hidden", !hasAvatar);
    }
    if ($("prof-cover-img")) {
        if (hasCover) $("prof-cover-img").src = u.cover_photo;
        $("prof-cover-img").classList.toggle("hidden", !hasCover);
    }
    if ($("prof-fullname")) $("prof-fullname").textContent = u.full_name;
    if ($("prof-username")) $("prof-username").textContent = `@${u.username}`;
    if ($("prof-role-badge")) $("prof-role-badge").textContent = u.role;
    if ($("prof-theme-label")) {
        $("prof-theme-label").textContent = THEME_REGISTRY[state.theme]?.name || "Default";
    }
}

async function loadProfilePage() {
    syncUserIdentityUI();
    try {
        const res = await api("/api/profile/activity");
        state.profileActivity = res.recent_activity || [];
    } catch (_) {
        state.profileActivity = [];
    }
    renderProfileActivity();
    refreshIcons();
}

function renderProfileActivity() {
    const listEl = $("prof-activity-list");
    if (!listEl) return;
    const logs = state.profileActivity || [];
    if (!logs.length) {
        listEl.innerHTML = `<div class="erp-detail-card !p-6 text-center text-xs text-[#536471]">No recent harvest activity.</div>`;
        return;
    }

    listEl.innerHTML = logs
        .map(
            (l, idx) => `
        <div data-prof-act-idx="${idx}" class="erp-detail-card cursor-pointer space-y-2.5">
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
                <span class="px-2.5 py-0.5 rounded-full bg-[#0f1419] text-white font-mono-code font-bold text-[10px] shrink-0">
                    Round ${l.round_no}
                </span>
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
        </div>`
        )
        .join("");

    listEl.onclick = (e) => {
        const card = e.target.closest("[data-prof-act-idx]");
        if (!card) return;
        const item = logs[Number(card.getAttribute("data-prof-act-idx"))];
        if (!item) return;
        openItemDetailModal({
            badge: `Harvest Log #${item.id} • Round ${item.round_no}`,
            title: `Palm #${item.tree_no} — ${item.block_name}`,
            fields: [
                { label: "Estate", value: item.estate_name || getActiveEstateName() },
                { label: "Division", value: item.division_name || "Division" },
                { label: "Field & Block", value: `${item.field_name} • ${item.block_name}` },
                { label: "Bunches Cut", value: `${item.bunches} Fresh Fruit Bunches`, mono: true },
                { label: "Fronds Cut", value: `${item.fronds} Pruned Fronds`, mono: true },
                { label: "Palm Health", value: item.health_status || "Healthy" },
                { label: "Harvest Date", value: item.harvest_date, mono: true },
                { label: "Logged By", value: item.recorded_by || state.user?.full_name || "Staff" },
            ],
        });
    };
}

function readImageFileAsDataUrl(file, maxW = 900, maxH = 900) {
    return new Promise((resolve, reject) => {
        if (!file) return reject(new Error("No file selected."));
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Could not read image file."));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error("Invalid image format."));
            img.onload = () => {
                let w = img.width;
                let h = img.height;
                if (w > maxW || h > maxH) {
                    const ratio = Math.min(maxW / w, maxH / h);
                    w = Math.round(w * ratio);
                    h = Math.round(h * ratio);
                }
                const canvas = document.createElement("canvas");
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext("2d");
                ctx.drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL("image/jpeg", 0.82));
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

function syncEditProfileModalPreviews() {
    const u = state.user || {};
    const initials = (u.full_name || "U")
        .split(" ")
        .filter(Boolean)
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();

    const draftAvatar = state.editProfileDraft.profile_pic;
    const draftCover = state.editProfileDraft.cover_photo;

    if ($("ep-avatar-initials")) {
        $("ep-avatar-initials").textContent = initials;
        $("ep-avatar-initials").classList.toggle("hidden", Boolean(draftAvatar));
    }
    if ($("ep-avatar-preview")) {
        if (draftAvatar) $("ep-avatar-preview").src = draftAvatar;
        $("ep-avatar-preview").classList.toggle("hidden", !draftAvatar);
    }
    if ($("btn-ep-remove-avatar")) {
        $("btn-ep-remove-avatar").classList.toggle("hidden", !draftAvatar);
    }
    if ($("ep-cover-preview")) {
        if (draftCover) $("ep-cover-preview").src = draftCover;
        $("ep-cover-preview").classList.toggle("hidden", !draftCover);
    }
    if ($("btn-ep-remove-cover")) {
        $("btn-ep-remove-cover").classList.toggle("hidden", !draftCover);
    }
}

function openEditProfileModal() {
    if (!state.user) return;
    state.editProfileDraft = {
        profile_pic: state.user.profile_pic || "",
        cover_photo: state.user.cover_photo || "",
    };
    if ($("ep-fullname")) $("ep-fullname").value = state.user.full_name || "";
    if ($("ep-username")) $("ep-username").value = state.user.username || "";
    syncEditProfileModalPreviews();
    $("modal-edit-profile")?.classList.remove("hidden");
    refreshIcons();
}

async function saveEditProfile() {
    const full_name = ($("ep-fullname")?.value || "").trim();
    const username = ($("ep-username")?.value || "").trim().toLowerCase().replace(/^@+/, "");
    if (!full_name || !username) {
        return toast("Name and Username are required.", "err");
    }
    try {
        const res = await api("/api/profile/update", "POST", {
            full_name,
            username,
            profile_pic: state.editProfileDraft.profile_pic,
            cover_photo: state.editProfileDraft.cover_photo,
        });
        if (res.user) {
            state.user = { ...state.user, ...res.user };
            OfflineDB.setKV("cache:me", { user: state.user }).catch(() => {});
        }
        $("modal-edit-profile")?.classList.add("hidden");
        syncUserIdentityUI();
        updateClockAndGreeting();
        await loadProfilePage();
        toast(res.message || "Profile updated");
    } catch (err) {
        toast(err.message, "err");
    }
}
