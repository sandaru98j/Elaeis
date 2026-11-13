// ============================================================================
// ELAEIS — PALM BASIS CROP MONITORING SYSTEM â€” FRONTEND APPLICATION LOGIC
// Hierarchy: Estate -> Division -> Field -> Block -> Geo-Tagged Tree
// 3 Monthly Rounds: Round 1 (1-10), Round 2 (11-20), Round 3 (21-28/29/30/31)
// ============================================================================

let authToken = localStorage.getItem("elaeis_auth_token") || "";
let currentUser = null;

let hierarchyData = {
    estates: [],
    divisions: [],
    fields: [],
    blocks: [],
};

let customFieldDefs = [];
let currentBlockMatrix = null;
let mapTreeHitboxes = [];

// ----------------------------------------------------------------------------
// INITIALIZATION
// ----------------------------------------------------------------------------
window.addEventListener("DOMContentLoaded", async () => {
    const todayIso = new Date().toISOString().slice(0, 10);
    const currentYm = todayIso.slice(0, 7);

    const dateInp = document.getElementById("inp-harvest-date");
    if (dateInp) dateInp.value = todayIso;

    const monthPicker = document.getElementById("report-month-picker");
    if (monthPicker) monthPicker.value = currentYm;

    setupMapClickHandler();

    if (authToken) {
        const res = await apiGet("/api/auth/me");
        if (res && res.authenticated) {
            currentUser = res.user;
            enterAppShell();
            return;
        }
    }
    showAuthScreen();
});

// ----------------------------------------------------------------------------
// API HELPERS
// ----------------------------------------------------------------------------
async function apiGet(url) {
    try {
        const resp = await fetch(url, {
            headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
        });
        return await resp.json();
    } catch (err) {
        console.error("GET error:", err);
        return null;
    }
}

async function apiPost(url, payload) {
    try {
        const resp = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
            },
            body: JSON.stringify(payload),
        });
        const data = await resp.json();
        return { ok: resp.ok, status: resp.status, data };
    } catch (err) {
        return { ok: false, data: { error: String(err) } };
    }
}

function showToast(msg, isError = false) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.style.background = isError ? "#dc2626" : "#14532d";
    el.classList.remove("hidden");
    clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(() => {
        el.classList.add("hidden");
    }, 3600);
}

// ----------------------------------------------------------------------------
// AUTHENTICATION (USERNAME / EMAIL / PHONE LOGIN + FORGOT PASSWORD)
// ----------------------------------------------------------------------------
function showAuthScreen() {
    document.getElementById("auth-screen").classList.remove("hidden");
    document.getElementById("app-shell").classList.add("hidden");
}

function showAuthPanel(panel) {
    document.getElementById("login-panel").classList.toggle("hidden", panel !== "login");
    document.getElementById("forgot-panel").classList.toggle("hidden", panel !== "forgot");
    document.getElementById("register-panel").classList.toggle("hidden", panel !== "register");
}

function fillDemoLogin(identifier, password) {
    document.getElementById("login-identifier").value = identifier;
    document.getElementById("login-password").value = password;
}

async function handleLogin(e) {
    e.preventDefault();
    const identifier = document.getElementById("login-identifier").value.trim();
    const password = document.getElementById("login-password").value;
    const errEl = document.getElementById("login-error");
    errEl.classList.add("hidden");

    const res = await apiPost("/api/auth/login", { identifier, password });
    if (!res.ok) {
        errEl.textContent = res.data.error || "Sign in failed";
        errEl.classList.remove("hidden");
        return;
    }

    authToken = res.data.token;
    currentUser = res.data.user;
    localStorage.setItem("elaeis_auth_token", authToken);
    showToast(`Welcome, ${currentUser.full_name}!`);
    enterAppShell();
}

async function requestPasswordReset() {
    const identifier = document.getElementById("forgot-identifier").value.trim();
    if (!identifier) {
        showToast("Please enter your Username, Email, or Phone Number", true);
        return;
    }
    const res = await apiPost("/api/auth/forgot-password", { identifier });
    if (!res.ok) {
        showToast(res.data.error || "Account not found", true);
        return;
    }

    document.getElementById("reset-step-2").classList.remove("hidden");
    const banner = document.getElementById("recovery-code-banner");
    banner.innerHTML = `
        <strong>Recovery OTP Sent!</strong>
        Account: ${res.data.user_hint}<br/>
        Demo OTP Code: <span style="font-size:1.1rem;font-weight:800;color:#b45309;">${res.data.recovery_code_demo}</span>
    `;
    document.getElementById("reset-token-input").value = res.data.recovery_code_demo;
}

async function confirmPasswordReset() {
    const identifier = document.getElementById("forgot-identifier").value.trim();
    const reset_token = document.getElementById("reset-token-input").value.trim();
    const new_password = document.getElementById("reset-new-password").value;
    const res = await apiPost("/api/auth/reset-password", {
        identifier,
        reset_token,
        new_password,
    });
    if (!res.ok) {
        showToast(res.data.error || "Reset failed", true);
        return;
    }
    showToast(res.data.message);
    showAuthPanel("login");
    document.getElementById("login-identifier").value = identifier;
}

async function handleSelfRegister(e) {
    e.preventDefault();
    const payload = {
        full_name: document.getElementById("reg-fullname").value.trim(),
        username: document.getElementById("reg-username").value.trim(),
        email: document.getElementById("reg-email").value.trim(),
        phone: document.getElementById("reg-phone").value.trim(),
        role: document.getElementById("reg-role").value,
        password: document.getElementById("reg-password").value,
    };
    const res = await apiPost("/api/auth/register", payload);
    if (!res.ok) {
        showToast(res.data.error || "Registration failed", true);
        return;
    }
    showToast("Account created! Signing you in...");
    fillDemoLogin(payload.username, payload.password);
    showAuthPanel("login");
}

function logoutUser() {
    localStorage.removeItem("elaeis_auth_token");
    authToken = "";
    currentUser = null;
    showAuthScreen();
}

// ----------------------------------------------------------------------------
// ENTER MAIN APP SHELL & LOAD HIERARCHY
// ----------------------------------------------------------------------------
async function enterAppShell() {
    document.getElementById("auth-screen").classList.add("hidden");
    document.getElementById("app-shell").classList.remove("hidden");

    if (currentUser) {
        document.getElementById("current-user-label").textContent =
            `${currentUser.full_name} [${currentUser.role}]`;
    }

    await loadCustomFields();
    await loadHierarchy();
    await loadDashboard();
    await loadUsersList();
}

function switchTab(tabName) {
    document.querySelectorAll(".nav-tab").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.tab === tabName);
    });
    document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.classList.toggle("hidden", panel.id !== `tab-${tabName}`);
    });

    if (tabName === "report") {
        loadBlockRoundReport();
    } else if (tabName === "dashboard") {
        loadDashboard();
    } else if (tabName === "users") {
        loadUsersList();
    } else if (tabName === "hierarchy") {
        updateNewBlockParentInfo();
    }
}

// ----------------------------------------------------------------------------
// 5-LEVEL CASCADING HIERARCHY (ESTATE -> DIVISION -> FIELD -> BLOCK -> TREE)
// ----------------------------------------------------------------------------
async function loadHierarchy() {
    const data = await apiGet("/api/hierarchy");
    if (!data) return;
    hierarchyData = data;

    const estSel = document.getElementById("sel-estate");
    estSel.innerHTML = hierarchyData.estates
        .map((e) => `<option value="${e.id}">${e.code} â€” ${e.name}</option>`)
        .join("");

    onEstateChange();
}

function onEstateChange() {
    const estateId = Number(document.getElementById("sel-estate").value);
    const divs = hierarchyData.divisions.filter((d) => d.estate_id === estateId);
    const divSel = document.getElementById("sel-division");
    divSel.innerHTML = divs
        .map((d) => `<option value="${d.id}">${d.code} â€” ${d.name}</option>`)
        .join("");
    onDivisionChange();
}

function onDivisionChange() {
    const divId = Number(document.getElementById("sel-division").value);
    const flds = hierarchyData.fields.filter((f) => f.division_id === divId);
    const fldSel = document.getElementById("sel-field");
    fldSel.innerHTML = flds
        .map((f) => `<option value="${f.id}">${f.code} â€” ${f.name}</option>`)
        .join("");
    onFieldChange();
}

function onFieldChange() {
    const fldId = Number(document.getElementById("sel-field").value);
    const blks = hierarchyData.blocks.filter((b) => b.field_id === fldId);
    const blkSel = document.getElementById("sel-block");
    blkSel.innerHTML = blks
        .map(
            (b) =>
                `<option value="${b.id}">${b.code} â€” ${b.name} (${b.registered_trees} Palms)</option>`
        )
        .join("");
    updateNewBlockParentInfo();
    onBlockChange();
}

async function onBlockChange() {
    document.getElementById("inp-tree-number").value = 1;
    await lookupCurrentTree();
    await refreshBlockRightPanel();
    if (!document.getElementById("tab-report").classList.contains("hidden")) {
        await loadBlockRoundReport();
    }
}

function updateNewBlockParentInfo() {
    const estSel = document.getElementById("sel-estate");
    const divSel = document.getElementById("sel-division");
    const fldSel = document.getElementById("sel-field");
    const infoEl = document.getElementById("new-blk-parent-info");
    if (infoEl && estSel.selectedOptions[0] && divSel.selectedOptions[0] && fldSel.selectedOptions[0]) {
        infoEl.value = `${estSel.selectedOptions[0].text} â†’ ${divSel.selectedOptions[0].text} â†’ ${fldSel.selectedOptions[0].text}`;
    }
}

// ----------------------------------------------------------------------------
// ROUND CALCULATION (1-10 = ROUND 1, 11-20 = ROUND 2, 21-END = ROUND 3)
// ----------------------------------------------------------------------------
function computeClientRound(dateStr) {
    const parts = (dateStr || "").split("-");
    const day = parts.length === 3 ? parseInt(parts[2], 10) : new Date().getDate();
    const ym = parts.length >= 2 ? `${parts[0]}-${parts[1]}` : new Date().toISOString().slice(0, 7);

    let roundNumber = 1;
    let roundLabel = "Round 1 (Days 1â€“10)";
    if (day >= 11 && day <= 20) {
        roundNumber = 2;
        roundLabel = "Round 2 (Days 11â€“20)";
    } else if (day >= 21) {
        roundNumber = 3;
        roundLabel = "Round 3 (Days 21â€“End)";
    }
    return { day, yearMonth: ym, roundNumber, roundLabel };
}

function onHarvestDateChange() {
    const dateVal = document.getElementById("inp-harvest-date").value;
    const r = computeClientRound(dateVal);
    document.getElementById("inp-auto-month").value = r.yearMonth;
    document.getElementById("inp-auto-round").value = r.roundLabel;
    document.getElementById("form-round-badge").textContent = `${r.yearMonth} â€¢ ${r.roundLabel}`;
    lookupCurrentTree();
    refreshBlockRightPanel();
}

// ----------------------------------------------------------------------------
// TREE LOOKUP & RAPID TREE-BY-TREE HARVESTING WORKFLOW
// ----------------------------------------------------------------------------
async function lookupCurrentTree() {
    const blockId = Number(document.getElementById("sel-block").value || 0);
    const treeNumber = Number(document.getElementById("inp-tree-number").value || 1);
    const dateVal = document.getElementById("inp-harvest-date").value;

    if (!blockId || treeNumber < 1) return;

    const rInfo = computeClientRound(dateVal);
    document.getElementById("inp-auto-month").value = rInfo.yearMonth;
    document.getElementById("inp-auto-round").value = rInfo.roundLabel;
    document.getElementById("form-round-badge").textContent = `${rInfo.yearMonth} â€¢ ${rInfo.roundLabel}`;

    const data = await apiGet(
        `/api/trees/lookup?block_id=${blockId}&tree_number=${treeNumber}&date=${dateVal}`
    );
    if (!data) return;

    const statusTag = document.getElementById("tree-status-tag");
    const miniHist = document.getElementById("tree-3round-mini-history");

    if (data.exists) {
        const t = data.tree;
        statusTag.textContent = `${t.tree_code} (Row ${t.row_number}) â€¢ Registered GPS`;
        statusTag.className = "badge badge-green";
        document.getElementById("inp-latitude").value = t.latitude;
        document.getElementById("inp-longitude").value = t.longitude;

        const mr = data.month_rounds || {};
        const r1Txt = mr[1] ? `${mr[1].bunches_cut}B/${mr[1].fronds_cut}F` : "â€”";
        const r2Txt = mr[2] ? `${mr[2].bunches_cut}B/${mr[2].fronds_cut}F` : "â€”";
        const r3Txt = mr[3] ? `${mr[3].bunches_cut}B/${mr[3].fronds_cut}F` : "â€”";
        miniHist.textContent = `This Month â†’ R1(1-10): ${r1Txt} | R2(11-20): ${r2Txt} | R3(21-End): ${r3Txt}`;

        if (data.existing_log) {
            const lg = data.existing_log;
            document.getElementById("inp-bunches-cut").value = lg.bunches_cut;
            document.getElementById("inp-fronds-cut").value = lg.fronds_cut;
            document.getElementById("inp-bunch-weight").value = lg.bunch_weight_kg;
            document.getElementById("inp-weed-growth").value = lg.weed_growth || t.weed_status;
            document.getElementById("inp-fertilizer-type").value = lg.fertilizer_type || "None";
            document.getElementById("inp-fertilizer-kg").value = lg.fertilizer_kg || 0;
            document.getElementById("inp-pest-disease").value = lg.pest_disease || t.health_status;
            document.getElementById("inp-pruning-status").value = lg.pruning_status || "Standard Stacked";
            document.getElementById("inp-remarks").value = lg.remarks || "";
            populateCustomFieldValues(lg.custom_data_json);
        } else {
            // Default fresh entry for this round
            document.getElementById("inp-bunches-cut").value = 1;
            document.getElementById("inp-fronds-cut").value = 2;
            document.getElementById("inp-bunch-weight").value = 18.5;
            document.getElementById("inp-weed-growth").value = t.weed_status || "Clean Circle";
            document.getElementById("inp-fertilizer-type").value = "None";
            document.getElementById("inp-fertilizer-kg").value = 0.0;
            document.getElementById("inp-pest-disease").value = t.health_status || "Healthy";
            document.getElementById("inp-remarks").value = "";
            populateCustomFieldValues("{}");
        }
    } else {
        statusTag.textContent = `New Tree #${treeNumber} (Will Auto-Register with GPS)`;
        statusTag.className = "badge badge-amber";
        document.getElementById("inp-latitude").value = data.suggested_latitude;
        document.getElementById("inp-longitude").value = data.suggested_longitude;
        miniHist.textContent = "New palm number in this block â€” saving will register its GPS.";
        document.getElementById("inp-bunches-cut").value = 1;
        document.getElementById("inp-fronds-cut").value = 2;
        document.getElementById("inp-bunch-weight").value = 18.5;
        document.getElementById("inp-remarks").value = "";
    }

    highlightActiveTreePill(treeNumber);
}

function adjustCounter(inputId, delta) {
    const inp = document.getElementById(inputId);
    const nextVal = Math.max(0, Number(inp.value || 0) + delta);
    inp.value = nextVal;
    if (inputId === "inp-bunches-cut") {
        autoCalcWeight();
    }
}

function autoCalcWeight() {
    const bunches = Number(document.getElementById("inp-bunches-cut").value || 0);
    document.getElementById("inp-bunch-weight").value = (bunches * 18.5).toFixed(1);
}

function captureDeviceGPS() {
    if (!navigator.geolocation) {
        showToast("Geolocation is not supported by this browser", true);
        return;
    }
    showToast("Acquiring high-accuracy satellite GPS coordinates...");
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            document.getElementById("inp-latitude").value = pos.coords.latitude.toFixed(6);
            document.getElementById("inp-longitude").value = pos.coords.longitude.toFixed(6);
            showToast(
                `Live GPS Locked: ${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`
            );
        },
        () => {
            showToast("Using block grid interpolated GPS coordinates.", false);
        },
        { enableHighAccuracy: true, timeout: 6000 }
    );
}

async function submitTreeHarvest(e) {
    e.preventDefault();
    const blockId = Number(document.getElementById("sel-block").value);
    const treeNumber = Number(document.getElementById("inp-tree-number").value);
    const harvestDate = document.getElementById("inp-harvest-date").value;

    const customData = {};
    customFieldDefs.forEach((cf) => {
        const el = document.getElementById(`cf-inp-${cf.field_key}`);
        if (el) customData[cf.field_key] = el.value;
    });

    const payload = {
        block_id: blockId,
        tree_number: treeNumber,
        harvest_date: harvestDate,
        latitude: Number(document.getElementById("inp-latitude").value),
        longitude: Number(document.getElementById("inp-longitude").value),
        bunches_cut: Number(document.getElementById("inp-bunches-cut").value),
        fronds_cut: Number(document.getElementById("inp-fronds-cut").value),
        bunch_weight_kg: Number(document.getElementById("inp-bunch-weight").value),
        weed_growth: document.getElementById("inp-weed-growth").value,
        fertilizer_type: document.getElementById("inp-fertilizer-type").value,
        fertilizer_kg: Number(document.getElementById("inp-fertilizer-kg").value),
        pest_disease: document.getElementById("inp-pest-disease").value,
        pruning_status: document.getElementById("inp-pruning-status").value,
        custom_data: customData,
        remarks: document.getElementById("inp-remarks").value.trim(),
    };

    const res = await apiPost("/api/harvest", payload);
    if (!res.ok) {
        showToast(res.data.error || "Failed to save tree harvest", true);
        return;
    }

    showToast(`âœ… ${res.data.message} â†’ Advancing to Tree #${res.data.next_tree_number}`);

    // Auto-advance to Next Tree Number!
    document.getElementById("inp-tree-number").value = res.data.next_tree_number;
    await lookupCurrentTree();
    await refreshBlockRightPanel();

    // Focus Bunches Cut input for rapid entry
    const bunchInput = document.getElementById("inp-bunches-cut");
    if (bunchInput) {
        bunchInput.focus();
        bunchInput.select();
    }
}

function stepTreeNumber(delta) {
    const inp = document.getElementById("inp-tree-number");
    const nextTree = Math.max(1, Number(inp.value || 1) + delta);
    inp.value = nextTree;
    lookupCurrentTree();
}

function selectTreeFromGrid(treeNo) {
    document.getElementById("inp-tree-number").value = treeNo;
    lookupCurrentTree();
}

function highlightActiveTreePill(treeNo) {
    document.querySelectorAll(".tree-pill").forEach((el) => {
        el.classList.toggle("active-tree", Number(el.dataset.tree) === Number(treeNo));
    });
}

// ----------------------------------------------------------------------------
// RIGHT PANEL: BLOCK 3-ROUND PROGRESS & VISUAL TREE PILLS
// ----------------------------------------------------------------------------
async function refreshBlockRightPanel() {
    const blockId = Number(document.getElementById("sel-block").value || 0);
    if (!blockId) return;

    const dateVal = document.getElementById("inp-harvest-date").value;
    const rInfo = computeClientRound(dateVal);

    const data = await apiGet(
        `/api/reports/block-rounds?block_id=${blockId}&year_month=${rInfo.yearMonth}`
    );
    if (!data) return;

    const s = data.summary;
    document.getElementById("right-block-title").textContent =
        `${data.block.code || "Block"} â€” ${rInfo.yearMonth} Progress`;

    const currentRoundHarvested =
        rInfo.roundNumber === 1
            ? s.r1_trees_harvested
            : rInfo.roundNumber === 2
            ? s.r2_trees_harvested
            : s.r3_trees_harvested;

    document.getElementById("block-round-progress-badge").textContent =
        `Round ${rInfo.roundNumber}: ${currentRoundHarvested} / ${s.total_trees} Trees Cut`;

    document.getElementById("blk-stat-r1").textContent = `${s.r1_bunches}B / ${s.r1_fronds}F`;
    document.getElementById("blk-trees-r1").textContent = `${s.r1_trees_harvested}/${s.total_trees} palms`;

    document.getElementById("blk-stat-r2").textContent = `${s.r2_bunches}B / ${s.r2_fronds}F`;
    document.getElementById("blk-trees-r2").textContent = `${s.r2_trees_harvested}/${s.total_trees} palms`;

    document.getElementById("blk-stat-r3").textContent = `${s.r3_bunches}B / ${s.r3_fronds}F`;
    document.getElementById("blk-trees-r3").textContent = `${s.r3_trees_harvested}/${s.total_trees} palms`;

    const activeTreeNo = Number(document.getElementById("inp-tree-number").value || 1);
    const pillsContainer = document.getElementById("block-tree-pills");
    pillsContainer.innerHTML = data.trees_matrix
        .map((t) => {
            const roundObj =
                rInfo.roundNumber === 1
                    ? t.round_1
                    : rInfo.roundNumber === 2
                    ? t.round_2
                    : t.round_3;
            const isDone = Boolean(roundObj);
            const subText = isDone ? `${roundObj.bunches_cut}BÂ·${roundObj.fronds_cut}F` : "Pending";
            const activeCls = t.tree_number === activeTreeNo ? "active-tree" : "";
            return `
                <div class="tree-pill ${isDone ? "done" : ""} ${activeCls}"
                     data-tree="${t.tree_number}"
                     onclick="selectTreeFromGrid(${t.tree_number})"
                     title="GPS: ${t.latitude}, ${t.longitude}">
                    <div>#${t.tree_number}</div>
                    <div style="font-size:0.68rem;font-weight:500;">${subText}</div>
                </div>
            `;
        })
        .join("");
}

// ----------------------------------------------------------------------------
// TAB 2: 3-ROUND BLOCK REPORT, MATRIX TABLE & INTERACTIVE GPS CANVAS MAP
// ----------------------------------------------------------------------------
async function loadBlockRoundReport() {
    const blockId = Number(document.getElementById("sel-block").value || 1);
    const ym =
        document.getElementById("report-month-picker").value ||
        new Date().toISOString().slice(0, 7);

    const data = await apiGet(`/api/reports/block-rounds?block_id=${blockId}&year_month=${ym}`);
    if (!data) return;
    currentBlockMatrix = data;

    const b = data.block;
    const s = data.summary;

    document.getElementById("report-header-title").textContent =
        `3-Round Harvesting & Geo-Location Report â€” ${b.code}: ${b.name} (${ym})`;
    document.getElementById("report-hierarchy-subtitle").textContent =
        `${b.estate_name} â†’ ${b.division_name} â†’ ${b.field_name} â†’ ${b.name} â€¢ Variety: ${b.palm_variety} â€¢ Total Registered Palms: ${s.total_trees}`;

    document.getElementById("report-rounds-summary").innerHTML = `
        <div class="round-card">
            <div class="round-card-header">
                <h3>Round 1 Cycle</h3>
                <span class="round-days-tag">Days 1 â€“ 10</span>
            </div>
            <div class="round-metrics">
                <div>
                    <div class="round-metric-val">${s.r1_trees_harvested}/${s.total_trees}</div>
                    <div class="round-metric-lbl">Palms Harvested</div>
                </div>
                <div>
                    <div class="round-metric-val" style="color:#16a34a;">${s.r1_bunches}</div>
                    <div class="round-metric-lbl">Bunches Cut</div>
                </div>
                <div>
                    <div class="round-metric-val" style="color:#d97706;">${s.r1_fronds}</div>
                    <div class="round-metric-lbl">Fronds Cut</div>
                </div>
            </div>
        </div>
        <div class="round-card">
            <div class="round-card-header">
                <h3>Round 2 Cycle</h3>
                <span class="round-days-tag">Days 11 â€“ 20</span>
            </div>
            <div class="round-metrics">
                <div>
                    <div class="round-metric-val">${s.r2_trees_harvested}/${s.total_trees}</div>
                    <div class="round-metric-lbl">Palms Harvested</div>
                </div>
                <div>
                    <div class="round-metric-val" style="color:#16a34a;">${s.r2_bunches}</div>
                    <div class="round-metric-lbl">Bunches Cut</div>
                </div>
                <div>
                    <div class="round-metric-val" style="color:#d97706;">${s.r2_fronds}</div>
                    <div class="round-metric-lbl">Fronds Cut</div>
                </div>
            </div>
        </div>
        <div class="round-card">
            <div class="round-card-header">
                <h3>Round 3 Cycle</h3>
                <span class="round-days-tag">Days 21 â€“ 28/29/30/31</span>
            </div>
            <div class="round-metrics">
                <div>
                    <div class="round-metric-val">${s.r3_trees_harvested}/${s.total_trees}</div>
                    <div class="round-metric-lbl">Palms Harvested</div>
                </div>
                <div>
                    <div class="round-metric-val" style="color:#16a34a;">${s.r3_bunches}</div>
                    <div class="round-metric-lbl">Bunches Cut</div>
                </div>
                <div>
                    <div class="round-metric-val" style="color:#d97706;">${s.r3_fronds}</div>
                    <div class="round-metric-lbl">Fronds Cut</div>
                </div>
            </div>
        </div>
    `;

    const tbody = document.getElementById("report-matrix-tbody");
    const fmtRoundCell = (r) => {
        if (!r) return `<span class="badge badge-gray">Not Cut</span>`;
        return `
            <div><strong>${r.bunches_cut} Bunches</strong> | <span>${r.fronds_cut} Fronds</span></div>
            <div style="font-size:0.72rem;color:var(--text-muted);">ðŸ“… ${r.harvest_date}</div>
        `;
    };

    tbody.innerHTML =
        data.trees_matrix
            .map(
                (t) => `
            <tr>
                <td>
                    <strong>#${t.tree_number}</strong>
                    <div style="font-size:0.74rem;color:var(--text-muted);">${t.tree_code} (Row ${t.row_number})</div>
                </td>
                <td style="font-family:monospace;font-size:0.8rem;">
                    ðŸ“ ${t.latitude.toFixed(6)}, ${t.longitude.toFixed(6)}
                </td>
                <td style="background:#f9fefb;">${fmtRoundCell(t.round_1)}</td>
                <td style="background:#f8fbff;">${fmtRoundCell(t.round_2)}</td>
                <td style="background:#fffdf7;">${fmtRoundCell(t.round_3)}</td>
                <td><span class="badge badge-green" style="font-size:0.85rem;">${t.total_bunches} Bunches</span></td>
                <td><span class="badge badge-amber" style="font-size:0.85rem;">${t.total_fronds} Fronds</span></td>
                <td><strong>${t.total_weight_kg} kg</strong></td>
                <td>${t.weed_status}</td>
                <td>
                    <div><strong>${t.last_fertilizer_type}</strong> (${t.last_fertilizer_kg}kg)</div>
                    <div style="font-size:0.74rem;color:var(--text-muted);">${t.health_status}</div>
                </td>
                <td class="no-print">
                    <button class="btn btn-sm btn-outline" onclick="jumpToEditTree(${t.tree_number})">
                        Edit Tree
                    </button>
                </td>
            </tr>
        `
            )
            .join("") +
        `
        <tr style="background:#e9f0ec;font-weight:800;">
            <td colspan="2">BLOCK MONTHLY TOTAL (${s.total_trees} Geo-Tagged Palms)</td>
            <td>${s.r1_bunches} Bunches | ${s.r1_fronds} Fronds (${s.r1_trees_harvested} trees)</td>
            <td>${s.r2_bunches} Bunches | ${s.r2_fronds} Fronds (${s.r2_trees_harvested} trees)</td>
            <td>${s.r3_bunches} Bunches | ${s.r3_fronds} Fronds (${s.r3_trees_harvested} trees)</td>
            <td>${s.total_bunches} Bunches</td>
            <td>${s.total_fronds} Fronds</td>
            <td>${s.total_weight_kg} kg</td>
            <td colspan="3"></td>
        </tr>
        `;

    renderBlockGisCanvas(data.trees_matrix);
}

function jumpToEditTree(treeNo) {
    switchTab("harvest");
    document.getElementById("inp-tree-number").value = treeNo;
    lookupCurrentTree();
}

function downloadBlockCSV() {
    const blockId = Number(document.getElementById("sel-block").value || 1);
    const ym =
        document.getElementById("report-month-picker").value ||
        new Date().toISOString().slice(0, 7);
    window.open(`/api/reports/export-csv?block_id=${blockId}&year_month=${ym}`, "_blank");
}

// ----------------------------------------------------------------------------
// INTERACTIVE GEO-LOCATION PALM MAP ON HTML5 CANVAS
// ----------------------------------------------------------------------------
function renderBlockGisCanvas(trees) {
    const canvas = document.getElementById("block-map-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    mapTreeHitboxes = [];

    // Draw background grid
    ctx.fillStyle = "#ecfdf5";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#d1fae5";
    ctx.lineWidth = 1;
    for (let x = 40; x < W; x += 55) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
    }
    for (let y = 30; y < H; y += 55) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
    }

    if (!trees || trees.length === 0) {
        ctx.fillStyle = "#14532d";
        ctx.font = "bold 16px sans-serif";
        ctx.fillText("No trees registered in this block yet.", 40, 60);
        return;
    }

    const lats = trees.map((t) => t.latitude);
    const lngs = trees.map((t) => t.longitude);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);

    const padX = 95;
    const padY = 58;
    const spanLat = Math.max(maxLat - minLat, 0.0001);
    const spanLng = Math.max(maxLng - minLng, 0.0001);

    trees.forEach((t) => {
        const x = padX + ((t.longitude - minLng) / spanLng) * (W - padX * 2);
        const y = H - padY - ((t.latitude - minLat) / spanLat) * (H - padY * 2);

        // Color based on how many rounds harvested (0, 1, 2, or 3 rounds)
        let fill = "#94a3b8";
        if (t.rounds_done === 3) fill = "#15803d";
        else if (t.rounds_done === 2) fill = "#0284c7";
        else if (t.rounds_done === 1) fill = "#d97706";

        // Outer halo
        ctx.beginPath();
        ctx.arc(x, y, 21, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = fill;
        ctx.stroke();

        // Inner palm circle
        ctx.beginPath();
        ctx.arc(x, y, 16, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();

        // Tree number label
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 11px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(`#${t.tree_number}`, x, y + 4);

        // GPS & Bunches/Fronds caption below pin
        ctx.fillStyle = "#0f172a";
        ctx.font = "600 10px monospace";
        ctx.fillText(`${t.total_bunches}B/${t.total_fronds}F`, x, y + 34);
        ctx.fillStyle = "#475569";
        ctx.font = "9px monospace";
        ctx.fillText(`${t.latitude.toFixed(5)},${t.longitude.toFixed(5)}`, x, y + 45);

        mapTreeHitboxes.push({ x, y, r: 22, tree_number: t.tree_number });
    });

    // Legend
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.fillRect(14, 12, 540, 28);
    ctx.strokeStyle = "#cbd5e1";
    ctx.strokeRect(14, 12, 540, 28);
    ctx.font = "bold 11px sans-serif";
    ctx.fillStyle = "#15803d";
    ctx.fillText("â— 3 Rounds Done", 26, 30);
    ctx.fillStyle = "#0284c7";
    ctx.fillText("â— 2 Rounds Done", 145, 30);
    ctx.fillStyle = "#d97706";
    ctx.fillText("â— 1 Round Done", 265, 30);
    ctx.fillStyle = "#64748b";
    ctx.fillText("â— 0 Rounds (Pending)", 380, 30);
}

function setupMapClickHandler() {
    const canvas = document.getElementById("block-map-canvas");
    if (!canvas) return;
    canvas.addEventListener("click", (e) => {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const cx = (e.clientX - rect.left) * scaleX;
        const cy = (e.clientY - rect.top) * scaleY;

        for (const item of mapTreeHitboxes) {
            const dist = Math.hypot(cx - item.x, cy - item.y);
            if (dist <= item.r) {
                showToast(`Opening Tree #${item.tree_number} in Harvest Editor...`);
                jumpToEditTree(item.tree_number);
                break;
            }
        }
    });
}

// ----------------------------------------------------------------------------
// TAB 3: ESTATE DASHBOARD
// ----------------------------------------------------------------------------
async function loadDashboard() {
    const data = await apiGet("/api/dashboard");
    if (!data) return;

    const tr = data.today_round;
    document.getElementById("live-round-pill").textContent =
        `ðŸ“… ${tr.date} â€¢ ${tr.round_label}`;

    const r1 = data.rounds[1];
    const r2 = data.rounds[2];
    const r3 = data.rounds[3];
    const totBunches = r1.bunches + r2.bunches + r3.bunches;
    const totFronds = r1.fronds + r2.fronds + r3.fronds;
    const totWeight = (r1.weight_kg + r2.weight_kg + r3.weight_kg).toFixed(1);

    document.getElementById("dashboard-kpi-grid").innerHTML = `
        <div class="kpi-card">
            <div class="kpi-label">Plantation Hierarchy</div>
            <div class="kpi-value">${data.counts.estates} Estates</div>
            <div class="kpi-sub">${data.counts.divisions} Divisions â€¢ ${data.counts.fields} Fields â€¢ ${data.counts.blocks} Blocks</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-label">Geo-Tagged Palms</div>
            <div class="kpi-value">${data.counts.trees} Trees</div>
            <div class="kpi-sub">100% Exact GPS Latitude &amp; Longitude</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-label">Monthly Bunches Cut</div>
            <div class="kpi-value" style="color:#16a34a;">${totBunches} FFB</div>
            <div class="kpi-sub">Est. Weight: ${totWeight} kg (${(totWeight / 1000).toFixed(2)} MT)</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-label">Monthly Fronds Cut</div>
            <div class="kpi-value" style="color:#d97706;">${totFronds} Fronds</div>
            <div class="kpi-sub">Subtending Fronds Pruned &amp; Stacked</div>
        </div>
    `;

    document.getElementById("dashboard-rounds-grid").innerHTML = [1, 2, 3]
        .map((rn) => {
            const rd = data.rounds[rn];
            const isCurrent = tr.round_number === rn;
            const daySpan = rn === 1 ? "Days 1 â€“ 10" : rn === 2 ? "Days 11 â€“ 20" : "Days 21 â€“ 28/29/30/31";
            return `
                <div class="round-card ${isCurrent ? "active-round" : ""}">
                    <div class="round-card-header">
                        <h3>Round ${rn} ${isCurrent ? "â€¢ (ACTIVE CYCLE)" : ""}</h3>
                        <span class="round-days-tag">${daySpan}</span>
                    </div>
                    <div class="round-metrics">
                        <div>
                            <div class="round-metric-val">${rd.trees_harvested}</div>
                            <div class="round-metric-lbl">Trees Cut</div>
                        </div>
                        <div>
                            <div class="round-metric-val" style="color:#16a34a;">${rd.bunches}</div>
                            <div class="round-metric-lbl">Bunches Cut</div>
                        </div>
                        <div>
                            <div class="round-metric-val" style="color:#d97706;">${rd.fronds}</div>
                            <div class="round-metric-lbl">Fronds Cut</div>
                        </div>
                    </div>
                </div>
            `;
        })
        .join("");

    document.getElementById("dashboard-blocks-tbody").innerHTML = data.block_summaries
        .map(
            (b) => `
            <tr>
                <td>
                    <strong>${b.estate_name}</strong>
                    <div style="font-size:0.76rem;color:var(--text-muted);">${b.division_name} â†’ ${b.field_name}</div>
                </td>
                <td><strong>${b.block_code}</strong><div style="font-size:0.75rem;">${b.block_name}</div></td>
                <td><span class="badge badge-blue">${b.total_trees} Palms</span></td>
                <td>${b.r1_trees}/${b.total_trees} trees â€¢ <strong>${b.r1_bunches}B</strong> â€¢ ${b.r1_fronds}F</td>
                <td>${b.r2_trees}/${b.total_trees} trees â€¢ <strong>${b.r2_bunches}B</strong> â€¢ ${b.r2_fronds}F</td>
                <td>${b.r3_trees}/${b.total_trees} trees â€¢ <strong>${b.r3_bunches}B</strong> â€¢ ${b.r3_fronds}F</td>
                <td><span class="badge badge-green">${b.total_bunches} Bunches</span></td>
                <td><span class="badge badge-amber">${b.total_fronds} Fronds</span></td>
                <td><strong>${b.total_weight_kg.toFixed(1)} kg</strong></td>
            </tr>
        `
        )
        .join("");

    document.getElementById("dashboard-recent-tbody").innerHTML = data.recent_logs
        .map(
            (lg) => `
            <tr>
                <td>
                    <strong>${lg.harvest_date}</strong>
                    <div><span class="badge badge-green">Round ${lg.round_number}</span></div>
                </td>
                <td>
                    <strong>${lg.block_code} â†’ Tree #${lg.tree_number} (${lg.tree_code})</strong>
                    <div style="font-size:0.74rem;color:var(--text-muted);">${lg.estate_name}</div>
                </td>
                <td style="font-family:monospace;font-size:0.78rem;">${lg.latitude.toFixed(6)}, ${lg.longitude.toFixed(6)}</td>
                <td><strong>${lg.bunches_cut} Bunches</strong> (${lg.bunch_weight_kg} kg)</td>
                <td><strong>${lg.fronds_cut} Fronds</strong></td>
                <td>
                    <div>Weed: ${lg.weed_growth}</div>
                    <div style="font-size:0.74rem;color:var(--text-muted);">Fert: ${lg.fertilizer_type} (${lg.fertilizer_kg}kg)</div>
                </td>
                <td>${lg.recorded_by_name}</td>
            </tr>
        `
        )
        .join("");
}

// ----------------------------------------------------------------------------
// TAB 4: DYNAMIC CUSTOM AGRONOMIC FIELDS & HIERARCHY BUILDER
// ----------------------------------------------------------------------------
async function loadCustomFields() {
    const res = await apiGet("/api/custom-fields");
    if (!res) return;
    customFieldDefs = res.custom_fields || [];

    const container = document.getElementById("dynamic-custom-fields");
    if (container) {
        container.innerHTML = customFieldDefs
            .map((cf) => {
                if (cf.field_type === "select") {
                    const opts = (cf.options_csv || "")
                        .split(",")
                        .map((o) => o.trim())
                        .filter(Boolean);
                    return `
                        <div class="form-group" style="margin-bottom:0;">
                            <label>${cf.field_label}</label>
                            <select id="cf-inp-${cf.field_key}">
                                ${opts.map((o) => `<option value="${o}">${o}</option>`).join("")}
                            </select>
                        </div>
                    `;
                }
                return `
                    <div class="form-group" style="margin-bottom:0;">
                        <label>${cf.field_label}</label>
                        <input type="${cf.field_type === "number" ? "number" : "text"}" id="cf-inp-${cf.field_key}" placeholder="${cf.field_label}" />
                    </div>
                `;
            })
            .join("");
    }

    const listEl = document.getElementById("custom-fields-list");
    if (listEl) {
        listEl.innerHTML = customFieldDefs
            .map(
                (cf) => `
                <span class="badge badge-green" style="margin: 3px; padding: 6px 10px;">
                    âœ“ ${cf.field_label} (${cf.field_type})
                </span>
            `
            )
            .join("");
    }
}

function populateCustomFieldValues(jsonStr) {
    let parsed = {};
    try {
        parsed = JSON.parse(jsonStr || "{}");
    } catch (e) {
        parsed = {};
    }
    customFieldDefs.forEach((cf) => {
        const el = document.getElementById(`cf-inp-${cf.field_key}`);
        if (el && parsed[cf.field_key] !== undefined) {
            el.value = parsed[cf.field_key];
        }
    });
}

async function handleAddCustomField(e) {
    e.preventDefault();
    const payload = {
        field_label: document.getElementById("cf-label").value.trim(),
        field_type: document.getElementById("cf-type").value,
        options_csv: document.getElementById("cf-options").value.trim(),
    };
    const res = await apiPost("/api/custom-fields", payload);
    if (!res.ok) {
        showToast(res.data.error || "Could not add custom field", true);
        return;
    }
    showToast(res.data.message);
    document.getElementById("cf-label").value = "";
    await loadCustomFields();
}

async function handleCreateBlock(e) {
    e.preventDefault();
    const fieldId = Number(document.getElementById("sel-field").value);
    const payload = {
        level: "block",
        field_id: fieldId,
        code: document.getElementById("new-blk-code").value.trim(),
        name: document.getElementById("new-blk-name").value.trim(),
        auto_generate_trees: Number(document.getElementById("new-blk-trees").value),
        base_latitude: Number(document.getElementById("new-blk-lat").value),
        base_longitude: Number(document.getElementById("new-blk-lng").value),
    };
    const res = await apiPost("/api/hierarchy/create", payload);
    if (!res.ok) {
        showToast(res.data.error || "Could not create block", true);
        return;
    }
    showToast("New Block & Geo-Tagged Palm Grid created!");
    await loadHierarchy();
}

// ----------------------------------------------------------------------------
// TAB 5: USER MANAGEMENT & ASSIGNMENT
// ----------------------------------------------------------------------------
async function loadUsersList() {
    const res = await apiGet("/api/users");
    if (!res || !res.users) return;
    document.getElementById("users-list-tbody").innerHTML = res.users
        .map(
            (u) => `
            <tr>
                <td><strong>${u.full_name}</strong></td>
                <td><code>${u.username}</code></td>
                <td>${u.email}</td>
                <td>${u.phone}</td>
                <td><span class="badge badge-blue">${u.role}</span></td>
            </tr>
        `
        )
        .join("");
}

async function handleAdminCreateUser(e) {
    e.preventDefault();
    const payload = {
        full_name: document.getElementById("usr-fullname").value.trim(),
        username: document.getElementById("usr-username").value.trim(),
        phone: document.getElementById("usr-phone").value.trim(),
        email: document.getElementById("usr-email").value.trim(),
        role: document.getElementById("usr-role").value,
        password: document.getElementById("usr-password").value,
        assigned_estate_id: Number(document.getElementById("sel-estate").value || 1),
    };
    const res = await apiPost("/api/users", payload);
    if (!res.ok) {
        showToast(res.data.error || "Failed to create user", true);
        return;
    }
    showToast(res.data.message);
    await loadUsersList();
}

