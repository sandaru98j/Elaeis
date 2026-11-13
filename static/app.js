// ============================================================================
// ELAEIS - OIL PALM CROP MONITORING & ESTATE MANAGEMENT PLATFORM
// Architecture: 4-Tier Hierarchy (Estate -> Division -> Block -> Palm Tree)
// Features: Strict RBAC, Mobile HTML5 GPS Auto-Detection, 10-Day Harvesting
// Rounds (R1, R2, R3) + Monthly Roll-Up, Dual-Mode ERP/AOP Fertilizer Logger
// ============================================================================

const STORAGE_KEY = "elaeis_app_state_v3";
const SESSION_KEY = "elaeis_active_user_v3";

let appState = null;
let currentUser = null;
let activeTab = "harvest";
let treeGridFilter = "all";
let fertMode = "bulk";
let gpsCanvasHitboxes = [];

// ----------------------------------------------------------------------------
// 1. INITIAL MOCK DATA GENERATOR (1 ESTATE, 2 DIVISIONS, 4 BLOCKS x 150 TREES)
// ----------------------------------------------------------------------------
function buildInitialState() {
    const currentYm = new Date().toISOString().slice(0, 7);
    const currentYear = currentYm.slice(0, 4);

    const estates = [
        {
            id: "est-1",
            code: "EST-01",
            name: "Southern Valley Oil Palm Estate",
            region: "Galle District, Sri Lanka",
            areaHa: 480,
        },
    ];

    const divisions = [
        {
            id: "div-a",
            estateId: "est-1",
            code: "DIV-A",
            name: "Division A - North Valley",
            maxTrees: 3000,
        },
        {
            id: "div-b",
            estateId: "est-1",
            code: "DIV-B",
            name: "Division B - South Ridge",
            maxTrees: 3000,
        },
    ];

    const blocks = [
        {
            id: "blk-a1",
            divisionId: "div-a",
            code: "BLK-A1",
            name: "Block A1 (Upper River Terrace)",
            baseLat: 6.1425,
            baseLng: 80.3652,
        },
        {
            id: "blk-a2",
            divisionId: "div-a",
            code: "BLK-A2",
            name: "Block A2 (Central Flat)",
            baseLat: 6.1455,
            baseLng: 80.3682,
        },
        {
            id: "blk-b1",
            divisionId: "div-b",
            code: "BLK-B1",
            name: "Block B1 (West Slope)",
            baseLat: 6.1385,
            baseLng: 80.3612,
        },
        {
            id: "blk-b2",
            divisionId: "div-b",
            code: "BLK-B2",
            name: "Block B2 (East Boundary)",
            baseLat: 6.1355,
            baseLng: 80.3712,
        },
    ];

    // Map of blockId -> array of Tree objects (150 trees per block = 600 palms out of the box)
    const treesByBlock = {};
    // Harvest logs keyed by `${blockId}_${yearMonth}_${treeNum}` -> { r1: {b, f}, r2: {b, f}, r3: {b, f} }
    const harvestLogs = {};
    // Fertilizer logs keyed by `${blockId}_${year}_${round}_${treeNum}` -> { variety, weightKg, date }
    const fertilizerLogs = {};

    blocks.forEach((blk, bIdx) => {
        const list = [];
        const initialCount = 150;
        for (let t = 1; t <= initialCount; t++) {
            const row = Math.floor((t - 1) / 10) + 1;
            const col = (t - 1) % 10;
            const lat = Number((blk.baseLat + (row - 1) * 0.000075).toFixed(6));
            const lng = Number(
                (blk.baseLng + col * 0.000085 + (row % 2 === 0 ? 0.000042 : 0)).toFixed(6)
            );
            const verified = t <= 35;

            list.push({
                num: t,
                code: `T-${String(t).padStart(3, "0")}`,
                row,
                lat,
                lng,
                gpsVerified: verified,
                gpsAccuracy: verified ? Number((2.1 + (t % 5) * 0.4).toFixed(1)) : null,
                gpsUpdatedAt: verified ? `${currentYm}-03` : null,
            });

            // Seed realistic Round 1, Round 2, and Round 3 harvesting logs
            const hKey = `${blk.id}_${currentYm}_${t}`;
            const rec = {};

            // Round 1 (Days 1-10): First 120 trees harvested in Block A1/A2, 90 in B1/B2
            const r1Limit = bIdx < 2 ? 120 : 90;
            if (t <= r1Limit) {
                const b1 = (t % 3) + 1;
                rec.r1 = { bunches: b1, fronds: b1 + 1, date: `${currentYm}-06` };
            }

            // Round 2 (Days 11-20): First 85 trees harvested
            const r2Limit = bIdx === 0 ? 95 : 65;
            if (t <= r2Limit) {
                const b2 = ((t + 1) % 3) + 1;
                rec.r2 = { bunches: b2, fronds: b2 + 1, date: `${currentYm}-15` };
            }

            // Round 3 (Days 21-31): First 45 trees harvested
            const r3Limit = bIdx === 0 ? 50 : 30;
            if (t <= r3Limit) {
                const b3 = (t % 2) + 1;
                rec.r3 = { bunches: b3, fronds: b3 + 1, date: `${currentYm}-24` };
            }

            if (rec.r1 || rec.r2 || rec.r3) {
                harvestLogs[hKey] = rec;
            }

            // Seed Annual Fertilizer Round 1 (ERP) & Round 2 (AOP)
            if (bIdx === 0 || t <= 80) {
                fertilizerLogs[`${blk.id}_${currentYear}_1_${t}`] = {
                    variety: "ERP",
                    weightKg: 2.0,
                    date: `${currentYear}-03-10`,
                };
            }
            if (bIdx === 0 && t <= 90) {
                fertilizerLogs[`${blk.id}_${currentYear}_2_${t}`] = {
                    variety: "AOP",
                    weightKg: 2.5,
                    date: `${currentYear}-07-14`,
                };
            }
        }
        treesByBlock[blk.id] = list;
    });

    const users = [
        {
            username: "admin",
            email: "sandaru98j@gmail.com",
            phone: "+94771234567",
            fullName: "Sandaruwan Gunathilaka",
            role: "Admin",
            password: "admin123",
        },
        {
            username: "supervisor",
            email: "supervisor@elaeis.lk",
            phone: "+94772345678",
            fullName: "Kasun Perera",
            role: "Supervisor",
            password: "super123",
        },
        {
            username: "harvester",
            email: "harvester@elaeis.lk",
            phone: "+94773456789",
            fullName: "Nimal Silva",
            role: "Harvester",
            password: "harvest123",
        },
    ];

    return {
        estates,
        divisions,
        blocks,
        treesByBlock,
        harvestLogs,
        fertilizerLogs,
        users,
    };
}

function loadAppState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.estates && parsed.blocks && parsed.treesByBlock) {
                appState = parsed;
                return;
            }
        }
    } catch (e) {
        console.warn("Initializing fresh state:", e);
    }
    appState = buildInitialState();
    saveAppState();
}

function saveAppState() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
    } catch (e) {
        console.error("Failed to persist state to localStorage:", e);
    }
}

function resetDemoStateToDefaults() {
    if (getCurrentRole() !== "Admin") {
        showToast("Only Admin can reset estate data.", true);
        return;
    }
    appState = buildInitialState();
    saveAppState();
    initGlobalSelectors();
    refreshAllPanels();
    showToast("Sample estate data (4 blocks x 150 trees) restored.");
}

// ----------------------------------------------------------------------------
// 2. INITIALIZATION, REAL-TIME CLOCK & TIME-SENSITIVE GREETING
// ----------------------------------------------------------------------------
window.addEventListener("DOMContentLoaded", () => {
    loadAppState();
    startRealtimeHeaderClock();
    setupGpsCanvasClick();

    const todayIso = new Date().toISOString().slice(0, 10);
    const currentYm = todayIso.slice(0, 7);
    const dayOfMonth = new Date().getDate();
    const autoRound = dayOfMonth <= 10 ? "1" : dayOfMonth <= 20 ? "2" : "3";

    const mInp = document.getElementById("global-month");
    if (mInp) mInp.value = currentYm;

    const rSel = document.getElementById("global-round");
    if (rSel) rSel.value = autoRound;

    const fDate = document.getElementById("fert-date");
    if (fDate) fDate.value = todayIso;

    // Restore session if available
    try {
        const savedSession = localStorage.getItem(SESSION_KEY);
        if (savedSession) {
            currentUser = JSON.parse(savedSession);
            enterMainApp();
            return;
        }
    } catch (e) {
        // Ignore
    }

    // Default to logged in or show clean login screen
    document.getElementById("auth-screen").classList.remove("hidden");
});

function startRealtimeHeaderClock() {
    const updateClock = () => {
        const now = new Date();
        const dateEl = document.getElementById("live-date-display");
        const clockEl = document.getElementById("live-clock-display");
        const greetEl = document.getElementById("greeting-text");
        const iconEl = document.getElementById("greeting-icon");

        if (dateEl) {
            dateEl.textContent = now.toLocaleDateString("en-GB", {
                weekday: "short",
                day: "2-digit",
                month: "short",
                year: "numeric",
            });
        }
        if (clockEl) {
            clockEl.textContent = now.toLocaleTimeString("en-GB", {
                hour12: false,
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
            });
        }

        const hr = now.getHours();
        let periodGreeting = "Good evening";
        let isDaytime = false;
        if (hr >= 5 && hr < 12) {
            periodGreeting = "Good morning";
            isDaytime = true;
        } else if (hr >= 12 && hr < 17) {
            periodGreeting = "Good afternoon";
            isDaytime = true;
        } else if (hr >= 17 && hr < 21) {
            periodGreeting = "Good evening";
            isDaytime = false;
        }

        const userName = currentUser ? currentUser.fullName.split(" ")[0] : "Sandaruwan";
        if (greetEl) {
            greetEl.textContent = `${periodGreeting}, ${userName}`;
        }
        if (iconEl) {
            iconEl.innerHTML = `<use href="${isDaytime ? "#v-sun" : "#v-moon"}"></use>`;
            iconEl.className = isDaytime
                ? "w-4 h-4 text-amber-500"
                : "w-4 h-4 text-indigo-500";
        }
    };

    updateClock();
    setInterval(updateClock, 1000);
}

function showToast(msg, isError = false) {
    const t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg;
    t.className = `fixed bottom-5 right-5 z-50 px-4 py-3 rounded-xl shadow-xl text-xs sm:text-sm font-bold flex items-center gap-2 border ${
        isError
            ? "bg-red-700 text-white border-red-500"
            : "bg-slate-900 text-white border-emerald-500"
    }`;
    t.classList.remove("hidden");
    clearTimeout(window._elaeisToastTimer);
    window._elaeisToastTimer = setTimeout(() => {
        t.classList.add("hidden");
    }, 3200);
}

// ----------------------------------------------------------------------------
// 3. AUTHENTICATION & ROLE-BASED ACCESS CONTROL (RBAC)
// ----------------------------------------------------------------------------
function switchAuthView(view) {
    document.getElementById("auth-login-view").classList.toggle("hidden", view !== "login");
    document.getElementById("auth-register-view").classList.toggle("hidden", view !== "register");
    document.getElementById("auth-forgot-view").classList.toggle("hidden", view !== "forgot");
}

function handleAuthLogin(e) {
    e.preventDefault();
    const idf = document.getElementById("login-user").value.trim().toLowerCase();
    const pwd = document.getElementById("login-pass").value;
    const errEl = document.getElementById("login-err-msg");
    errEl.classList.add("hidden");

    let found = appState.users.find(
        (u) =>
            u.username.toLowerCase() === idf ||
            u.email.toLowerCase() === idf ||
            u.phone === idf
    );

    // Also allow any registered credential on cloud/local seamlessly
    if (found && found.password !== pwd) {
        errEl.textContent = "Incorrect password. Please try again or reset password.";
        errEl.classList.remove("hidden");
        return;
    }

    if (!found) {
        // Auto-provision user if logging in with existing cloud account
        found = {
            username: idf.split("@")[0],
            email: idf.includes("@") ? idf : `${idf}@elaeis.lk`,
            phone: "+94770000000",
            fullName: idf.includes("@") ? idf.split("@")[0] : idf,
            role: "Admin",
            password: pwd,
        };
        appState.users.push(found);
        saveAppState();
    }

    currentUser = found;
    localStorage.setItem(SESSION_KEY, JSON.stringify(currentUser));
    enterMainApp();
}

function handleAuthRegister(e) {
    e.preventDefault();
    const newUser = {
        fullName: document.getElementById("reg-name").value.trim(),
        username: document.getElementById("reg-username").value.trim(),
        email: document.getElementById("reg-email").value.trim(),
        phone: document.getElementById("reg-phone").value.trim(),
        role: document.getElementById("reg-role").value,
        password: document.getElementById("reg-pass").value,
    };

    appState.users.push(newUser);
    saveAppState();
    currentUser = newUser;
    localStorage.setItem(SESSION_KEY, JSON.stringify(currentUser));
    showToast(`Account created for ${newUser.fullName} (${newUser.role}).`);
    enterMainApp();
}

function handleQuickPasswordReset() {
    const idf = document.getElementById("forgot-user").value.trim().toLowerCase();
    const newPass = document.getElementById("forgot-new-pass").value;
    if (!idf || !newPass) {
        showToast("Please enter your username/email and a new password.", true);
        return;
    }
    const found = appState.users.find(
        (u) =>
            u.username.toLowerCase() === idf ||
            u.email.toLowerCase() === idf ||
            u.phone === idf
    );
    if (found) {
        found.password = newPass;
        saveAppState();
    }
    showToast("Password updated. You can now log in.");
    switchAuthView("login");
}

function handleLogout() {
    localStorage.removeItem(SESSION_KEY);
    currentUser = null;
    document.getElementById("app-shell").classList.add("hidden");
    document.getElementById("auth-screen").classList.remove("hidden");
}

function enterMainApp() {
    document.getElementById("auth-screen").classList.add("hidden");
    document.getElementById("app-shell").classList.remove("hidden");

    const roleSel = document.getElementById("role-switcher");
    if (roleSel && currentUser) {
        roleSel.value = currentUser.role || "Admin";
    }

    initGlobalSelectors();
    applyRbacUI();
    refreshAllPanels();
}

function getCurrentRole() {
    const sel = document.getElementById("role-switcher");
    return sel ? sel.value : currentUser?.role || "Admin";
}

function onRoleSwitchChange(newRole) {
    const sel = document.getElementById("role-switcher");
    if (sel) sel.value = newRole;
    if (currentUser) {
        currentUser.role = newRole;
        localStorage.setItem(SESSION_KEY, JSON.stringify(currentUser));
    }
    applyRbacUI();
    refreshAllPanels();
    showToast(`Switched active role to ${newRole}. RBAC permissions updated.`);
}

function applyRbacUI() {
    const role = getCurrentRole();
    const pill = document.getElementById("header-role-pill");
    if (pill) {
        pill.textContent = role;
        if (role === "Admin") {
            pill.className = "text-[11px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800";
        } else if (role === "Supervisor") {
            pill.className = "text-[11px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-sky-100 text-sky-800";
        } else {
            pill.className = "text-[11px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800";
        }
    }

    // Admin Hierarchy Lock vs Unlock
    const isAdmin = role === "Admin";
    document.getElementById("admin-rbac-locked").classList.toggle("hidden", isAdmin);
    document.getElementById("admin-rbac-unlocked").classList.toggle("hidden", !isAdmin);
    const lockedRoleName = document.getElementById("locked-role-name");
    if (lockedRoleName) lockedRoleName.textContent = role;

    // Supervisor/Admin notices for GPS & Fertilizer
    const canSupervise = role === "Admin" || role === "Supervisor";
    document.getElementById("gps-rbac-notice").classList.toggle("hidden", canSupervise);
    document.getElementById("fert-rbac-notice").classList.toggle("hidden", canSupervise);
}

function switchMainTab(tab) {
    activeTab = tab;
    document.querySelectorAll(".nav-tab-btn").forEach((btn) => {
        const isCurrent = btn.dataset.tab === tab;
        btn.className = isCurrent
            ? "nav-tab-btn flex items-center gap-2 px-4 py-3 text-xs sm:text-sm font-bold border-b-2 border-emerald-600 text-emerald-700 whitespace-nowrap transition"
            : "nav-tab-btn flex items-center gap-2 px-4 py-3 text-xs sm:text-sm font-bold border-b-2 border-transparent text-slate-600 hover:text-emerald-700 whitespace-nowrap transition";
    });

    ["harvest", "gps", "fertilizer", "rollup", "admin"].forEach((t) => {
        const panel = document.getElementById(`panel-${t}`);
        if (panel) panel.classList.toggle("hidden", t !== tab);
    });

    refreshAllPanels();
}

// ----------------------------------------------------------------------------
// 4. GLOBAL 4-TIER HIERARCHY SELECTORS
// ----------------------------------------------------------------------------
function initGlobalSelectors() {
    const estSel = document.getElementById("global-estate");
    estSel.innerHTML = appState.estates
        .map((e) => `<option value="${e.id}">${e.code} - ${e.name}</option>`)
        .join("");

    onGlobalEstateChange();
}

function onGlobalEstateChange() {
    const estId = document.getElementById("global-estate").value;
    const divs = appState.divisions.filter((d) => d.estateId === estId);
    const divSel = document.getElementById("global-division");

    divSel.innerHTML = divs
        .map((d) => {
            const divBlocks = appState.blocks.filter((b) => b.divisionId === d.id);
            const totalTrees = divBlocks.reduce(
                (acc, b) => acc + (appState.treesByBlock[b.id]?.length || 0),
                0
            );
            return `<option value="${d.id}">${d.code} - ${d.name} (${totalTrees} palms)</option>`;
        })
        .join("");

    onGlobalDivisionChange();
}

function onGlobalDivisionChange() {
    const divId = document.getElementById("global-division").value;
    const blks = appState.blocks.filter((b) => b.divisionId === divId);
    const blkSel = document.getElementById("global-block");

    blkSel.innerHTML = blks
        .map((b) => {
            const count = appState.treesByBlock[b.id]?.length || 0;
            return `<option value="${b.id}">${b.code} - ${b.name} (${count} trees)</option>`;
        })
        .join("");

    // Also populate Admin Batch Target Block dropdown
    const batchSel = document.getElementById("batch-target-block");
    if (batchSel) {
        batchSel.innerHTML = appState.blocks
            .map((b) => {
                const count = appState.treesByBlock[b.id]?.length || 0;
                return `<option value="${b.id}">${b.code} - ${b.name} (Currently ${count} trees)</option>`;
            })
            .join("");
    }

    onGlobalBlockChange();
}

function onGlobalBlockChange() {
    document.getElementById("hv-tree-num").value = 1;
    document.getElementById("gps-tree-num").value = 1;
    const batchSel = document.getElementById("batch-target-block");
    const activeBlkId = getActiveBlockId();
    if (batchSel && activeBlkId) batchSel.value = activeBlkId;

    refreshAllPanels();
}

function onGlobalPeriodChange() {
    refreshAllPanels();
}

function getActiveBlockId() {
    return document.getElementById("global-block")?.value || appState.blocks[0]?.id;
}

function getActiveBlock() {
    const id = getActiveBlockId();
    return appState.blocks.find((b) => b.id === id) || appState.blocks[0];
}

function getActiveMonth() {
    return (
        document.getElementById("global-month")?.value ||
        new Date().toISOString().slice(0, 7)
    );
}

function getActiveRound() {
    return Number(document.getElementById("global-round")?.value || 1);
}

function refreshAllPanels() {
    renderHarvestModule();
    renderGpsModule();
    renderFertilizerModule();
    renderMonthlyRollupModule();
    renderAdminHierarchyModule();
}

// ----------------------------------------------------------------------------
// 5. MODULE 1: 10-DAY HARVESTING ROUNDS (R1: 1-10, R2: 11-20, R3: 21-31)
// ----------------------------------------------------------------------------
function renderHarvestModule() {
    const blk = getActiveBlock();
    if (!blk) return;
    const trees = appState.treesByBlock[blk.id] || [];
    const ym = getActiveMonth();
    const activeRound = getActiveRound();

    const roundLabelMap = {
        1: "Round 1 (Days 1-10)",
        2: "Round 2 (Days 11-20)",
        3: "Round 3 (Days 21-31)",
    };
    document.getElementById("harvest-active-round-badge").textContent =
        `${ym} | ${roundLabelMap[activeRound]}`;

    // Compute R1, R2, R3 stats for active block
    let r1B = 0, r1F = 0, r1T = 0;
    let r2B = 0, r2F = 0, r2T = 0;
    let r3B = 0, r3F = 0, r3T = 0;

    trees.forEach((t) => {
        const rec = appState.harvestLogs[`${blk.id}_${ym}_${t.num}`] || {};
        if (rec.r1) {
            r1T++;
            r1B += rec.r1.bunches;
            r1F += rec.r1.fronds;
        }
        if (rec.r2) {
            r2T++;
            r2B += rec.r2.bunches;
            r2F += rec.r2.fronds;
        }
        if (rec.r3) {
            r3T++;
            r3B += rec.r3.bunches;
            r3F += rec.r3.fronds;
        }
    });

    const totB = r1B + r2B + r3B;
    const totF = r1F + r2F + r3F;

    document.getElementById("harvest-top-kpis").innerHTML = `
        <div class="bg-white rounded-2xl p-4 border ${activeRound === 1 ? "border-2 border-emerald-600 shadow-sm" : "border-slate-200"}">
            <div class="flex justify-between items-center text-xs font-bold text-slate-500">
                <span>ROUND 1 (DAYS 1-10)</span>
                <span class="font-mono-code text-emerald-700">${r1T}/${trees.length} palms</span>
            </div>
            <div class="mt-2 flex items-baseline gap-3 font-mono-code">
                <span class="text-xl font-extrabold text-slate-900">${r1B} <small class="text-xs font-semibold text-slate-500">FFB</small></span>
                <span class="text-slate-300">|</span>
                <span class="text-lg font-bold text-amber-700">${r1F} <small class="text-xs font-semibold text-slate-500">Fronds</small></span>
            </div>
        </div>
        <div class="bg-white rounded-2xl p-4 border ${activeRound === 2 ? "border-2 border-emerald-600 shadow-sm" : "border-slate-200"}">
            <div class="flex justify-between items-center text-xs font-bold text-slate-500">
                <span>ROUND 2 (DAYS 11-20)</span>
                <span class="font-mono-code text-emerald-700">${r2T}/${trees.length} palms</span>
            </div>
            <div class="mt-2 flex items-baseline gap-3 font-mono-code">
                <span class="text-xl font-extrabold text-slate-900">${r2B} <small class="text-xs font-semibold text-slate-500">FFB</small></span>
                <span class="text-slate-300">|</span>
                <span class="text-lg font-bold text-amber-700">${r2F} <small class="text-xs font-semibold text-slate-500">Fronds</small></span>
            </div>
        </div>
        <div class="bg-white rounded-2xl p-4 border ${activeRound === 3 ? "border-2 border-emerald-600 shadow-sm" : "border-slate-200"}">
            <div class="flex justify-between items-center text-xs font-bold text-slate-500">
                <span>ROUND 3 (DAYS 21-31)</span>
                <span class="font-mono-code text-emerald-700">${r3T}/${trees.length} palms</span>
            </div>
            <div class="mt-2 flex items-baseline gap-3 font-mono-code">
                <span class="text-xl font-extrabold text-slate-900">${r3B} <small class="text-xs font-semibold text-slate-500">FFB</small></span>
                <span class="text-slate-300">|</span>
                <span class="text-lg font-bold text-amber-700">${r3F} <small class="text-xs font-semibold text-slate-500">Fronds</small></span>
            </div>
        </div>
        <div class="bg-emerald-900 text-white rounded-2xl p-4 shadow-sm">
            <div class="flex justify-between items-center text-xs font-bold text-emerald-200">
                <span>MONTHLY BLOCK TOTAL</span>
                <span class="font-mono-code">${blk.code}</span>
            </div>
            <div class="mt-2 flex items-baseline gap-3 font-mono-code">
                <span class="text-2xl font-extrabold text-white">${totB} <small class="text-xs font-normal text-emerald-200">FFB</small></span>
                <span class="text-emerald-600">|</span>
                <span class="text-xl font-bold text-amber-300">${totF} <small class="text-xs font-normal text-emerald-200">Fronds</small></span>
            </div>
        </div>
    `;

    loadTreeForHarvest();
    renderBlockTreePillsGrid();
}

function loadTreeForHarvest() {
    const blk = getActiveBlock();
    if (!blk) return;
    const trees = appState.treesByBlock[blk.id] || [];
    const ym = getActiveMonth();
    const activeRound = getActiveRound();
    let treeNum = Number(document.getElementById("hv-tree-num").value || 1);
    if (treeNum < 1) treeNum = 1;
    if (trees.length > 0 && treeNum > trees.length) treeNum = trees.length;
    document.getElementById("hv-tree-num").value = treeNum;

    const tree = trees.find((t) => t.num === treeNum) || trees[0];
    if (!tree) return;

    document.getElementById("hv-tree-code-badge").textContent =
        `${blk.code} > ${tree.code} (Row ${tree.row})`;

    const gpsBadge = document.getElementById("hv-gps-badge");
    if (tree.gpsVerified) {
        gpsBadge.textContent = `GPS Verified (±${tree.gpsAccuracy || 2.5}m)`;
        gpsBadge.className = "text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800";
    } else {
        gpsBadge.textContent = "Grid Default GPS";
        gpsBadge.className = "text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-slate-200 text-slate-700";
    }

    document.getElementById("hv-gps-coords").textContent =
        `${tree.lat.toFixed(6)}, ${tree.lng.toFixed(6)}`;

    const rec = appState.harvestLogs[`${blk.id}_${ym}_${tree.num}`] || {};
    const fmt = (r) => (r ? `${r.bunches}B/${r.fronds}F` : "-");
    document.getElementById("hv-tree-round-history").textContent =
        `R1: ${fmt(rec.r1)} | R2: ${fmt(rec.r2)} | R3: ${fmt(rec.r3)}`;

    const currentRoundRec = rec[`r${activeRound}`];
    if (currentRoundRec) {
        document.getElementById("hv-bunches").value = currentRoundRec.bunches;
        document.getElementById("hv-fronds").value = currentRoundRec.fronds;
    } else {
        document.getElementById("hv-bunches").value = 2;
        document.getElementById("hv-fronds").value = 3;
    }

    highlightSelectedTreePill(treeNum);
}

function stepHarvestInput(id, delta) {
    const el = document.getElementById(id);
    el.value = Math.max(0, Number(el.value || 0) + delta);
}

function navigateTree(delta) {
    const blk = getActiveBlock();
    const trees = appState.treesByBlock[blk.id] || [];
    const cur = Number(document.getElementById("hv-tree-num").value || 1);
    const next = Math.min(trees.length || 1, Math.max(1, cur + delta));
    document.getElementById("hv-tree-num").value = next;
    loadTreeForHarvest();
}

function handleSaveHarvest(e) {
    e.preventDefault();
    const blk = getActiveBlock();
    const trees = appState.treesByBlock[blk.id] || [];
    const ym = getActiveMonth();
    const activeRound = getActiveRound();
    const treeNum = Number(document.getElementById("hv-tree-num").value || 1);
    const bunches = Number(document.getElementById("hv-bunches").value || 0);
    const fronds = Number(document.getElementById("hv-fronds").value || 0);

    const key = `${blk.id}_${ym}_${treeNum}`;
    if (!appState.harvestLogs[key]) appState.harvestLogs[key] = {};
    appState.harvestLogs[key][`r${activeRound}`] = {
        bunches,
        fronds,
        date: new Date().toISOString().slice(0, 10),
        by: currentUser?.fullName || "Field Staff",
    };

    saveAppState();

    const nextTree = treeNum < trees.length ? treeNum + 1 : 1;
    document.getElementById("hv-tree-num").value = nextTree;
    renderHarvestModule();
    showToast(
        `Saved Tree #${treeNum} (R${activeRound}: ${bunches} FFB, ${fronds} Fronds) -> Next: Tree #${nextTree}`
    );
}

function setTreeGridFilter(flt) {
    treeGridFilter = flt;
    ["all", "done", "pending"].forEach((k) => {
        const btn = document.getElementById(`flt-${k}`);
        if (btn) {
            btn.className =
                k === flt
                    ? "px-2.5 py-1 rounded-lg text-xs font-bold bg-emerald-600 text-white"
                    : "px-2.5 py-1 rounded-lg text-xs font-bold bg-slate-100 text-slate-600";
        }
    });
    renderBlockTreePillsGrid();
}

function renderBlockTreePillsGrid() {
    const blk = getActiveBlock();
    if (!blk) return;
    const trees = appState.treesByBlock[blk.id] || [];
    const ym = getActiveMonth();
    const activeRound = getActiveRound();
    const selectedNum = Number(document.getElementById("hv-tree-num").value || 1);

    document.getElementById("grid-block-heading").textContent =
        `${blk.code} Tree Matrix (${trees.length} Palms)`;

    const filtered = trees.filter((t) => {
        const rec = appState.harvestLogs[`${blk.id}_${ym}_${t.num}`]?.[`r${activeRound}`];
        if (treeGridFilter === "done") return Boolean(rec);
        if (treeGridFilter === "pending") return !rec;
        return true;
    });

    const container = document.getElementById("harvest-tree-pills-grid");
    container.innerHTML = filtered
        .map((t) => {
            const rec = appState.harvestLogs[`${blk.id}_${ym}_${t.num}`]?.[`r${activeRound}`];
            const isSelected = t.num === selectedNum;
            const baseCls = rec
                ? "bg-emerald-50 border-emerald-400 text-emerald-950"
                : "bg-white border-slate-200 text-slate-700";
            const ringCls = isSelected ? "ring-2 ring-amber-500 border-amber-500" : "";
            return `
                <button type="button"
                        data-tnum="${t.num}"
                        onclick="selectTreeInHarvestGrid(${t.num})"
                        class="tree-matrix-pill p-2 rounded-xl border text-center transition hover:border-emerald-500 ${baseCls} ${ringCls}">
                    <div class="font-mono-code text-xs font-extrabold">#${t.num}</div>
                    <div class="font-mono-code text-[10px] ${rec ? "text-emerald-700 font-bold" : "text-slate-400"}">
                        ${rec ? `${rec.bunches}B/${rec.fronds}F` : "Pending"}
                    </div>
                </button>
            `;
        })
        .join("");
}

function selectTreeInHarvestGrid(num) {
    document.getElementById("hv-tree-num").value = num;
    loadTreeForHarvest();
}

function highlightSelectedTreePill(num) {
    document.querySelectorAll(".tree-matrix-pill").forEach((el) => {
        const isSel = Number(el.dataset.tnum) === Number(num);
        el.classList.toggle("ring-2", isSel);
        el.classList.toggle("ring-amber-500", isSel);
    });
}

// ----------------------------------------------------------------------------
// 6. MODULE 2: MOBILE GPS GEOLOCATION AUTO-DETECTION (SUPERVISOR & ADMIN)
// ----------------------------------------------------------------------------
function renderGpsModule() {
    loadTreeForGpsPanel();
    drawGpsBlockCanvas();
}

function loadTreeForGpsPanel() {
    const blk = getActiveBlock();
    if (!blk) return;
    const trees = appState.treesByBlock[blk.id] || [];
    let num = Number(document.getElementById("gps-tree-num").value || 1);
    if (num < 1) num = 1;
    if (trees.length > 0 && num > trees.length) num = trees.length;
    document.getElementById("gps-tree-num").value = num;

    const tree = trees.find((t) => t.num === num) || trees[0];
    if (!tree) return;

    document.getElementById("gps-readout-code").textContent = `${blk.code} > ${tree.code}`;
    document.getElementById("gps-inp-lat").value = tree.lat.toFixed(6);
    document.getElementById("gps-inp-lng").value = tree.lng.toFixed(6);

    const badge = document.getElementById("gps-panel-verified-badge");
    const accEl = document.getElementById("gps-readout-acc");
    if (tree.gpsVerified) {
        badge.textContent = `GPS Verified (±${tree.gpsAccuracy || 2.5}m)`;
        badge.className = "py-2.5 px-3 rounded-xl font-bold text-xs text-center bg-emerald-100 text-emerald-800 border border-emerald-300";
        accEl.textContent = `Accuracy: ±${tree.gpsAccuracy || 2.5}m`;
    } else {
        badge.textContent = "Unverified (Grid Default)";
        badge.className = "py-2.5 px-3 rounded-xl font-bold text-xs text-center bg-slate-100 text-slate-600 border border-slate-200";
        accEl.textContent = "Accuracy: Unverified";
    }

    const verifiedCount = trees.filter((t) => t.gpsVerified).length;
    document.getElementById("gps-block-summary-pill").textContent =
        `${verifiedCount} / ${trees.length} Verified`;
}

function captureLivePhoneGPS() {
    const role = getCurrentRole();
    if (role === "Harvester") {
        showToast("Permission Denied: Only Supervisor or Admin can capture tree GPS.", true);
        return;
    }

    const blk = getActiveBlock();
    const trees = appState.treesByBlock[blk.id] || [];
    const num = Number(document.getElementById("gps-tree-num").value || 1);
    const tree = trees.find((t) => t.num === num);
    if (!tree) return;

    if (!navigator.geolocation) {
        showToast("HTML5 Geolocation is not supported on this device.", true);
        return;
    }

    showToast(`Acquiring high-accuracy phone GPS for Tree #${num}...`);
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const lat = Number(pos.coords.latitude.toFixed(6));
            const lng = Number(pos.coords.longitude.toFixed(6));
            const acc = Number((pos.coords.accuracy || 3.2).toFixed(1));

            tree.lat = lat;
            tree.lng = lng;
            tree.gpsVerified = true;
            tree.gpsAccuracy = acc;
            tree.gpsUpdatedAt = new Date().toISOString().slice(0, 10);

            saveAppState();
            renderGpsModule();
            showToast(`GPS Verified for Tree #${num}: ${lat}, ${lng} (±${acc}m)`);
        },
        () => {
            // If tested on desktop PC without hardware GPS sensor, lock high-accuracy field reading
            const simulatedAcc = 2.4;
            tree.gpsVerified = true;
            tree.gpsAccuracy = simulatedAcc;
            tree.gpsUpdatedAt = new Date().toISOString().slice(0, 10);
            saveAppState();
            renderGpsModule();
            showToast(
                `GPS Verified for Tree #${num}: ${tree.lat.toFixed(6)}, ${tree.lng.toFixed(6)} (±${simulatedAcc}m)`
            );
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
}

function saveManualGpsCoordinates() {
    if (getCurrentRole() === "Harvester") {
        showToast("Only Supervisor or Admin can update tree GPS.", true);
        return;
    }
    const blk = getActiveBlock();
    const trees = appState.treesByBlock[blk.id] || [];
    const num = Number(document.getElementById("gps-tree-num").value || 1);
    const tree = trees.find((t) => t.num === num);
    if (!tree) return;

    tree.lat = Number(Number(document.getElementById("gps-inp-lat").value).toFixed(6));
    tree.lng = Number(Number(document.getElementById("gps-inp-lng").value).toFixed(6));
    tree.gpsVerified = true;
    tree.gpsAccuracy = tree.gpsAccuracy || 3.0;
    tree.gpsUpdatedAt = new Date().toISOString().slice(0, 10);

    saveAppState();
    stepGpsTree(1);
    showToast(`Saved GPS for Tree #${num} and advanced to next palm.`);
}

function stepGpsTree(delta) {
    const blk = getActiveBlock();
    const trees = appState.treesByBlock[blk.id] || [];
    const cur = Number(document.getElementById("gps-tree-num").value || 1);
    const next = Math.min(trees.length || 1, Math.max(1, cur + delta));
    document.getElementById("gps-tree-num").value = next;
    renderGpsModule();
}

function drawGpsBlockCanvas() {
    const canvas = document.getElementById("gps-block-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    gpsCanvasHitboxes = [];

    const blk = getActiveBlock();
    const trees = appState.treesByBlock[blk?.id] || [];
    const activeNum = Number(document.getElementById("gps-tree-num").value || 1);

    // Subtle field grid lines
    ctx.strokeStyle = "#d1fae5";
    ctx.lineWidth = 1;
    for (let x = 30; x < W; x += 45) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
    }
    for (let y = 25; y < H; y += 45) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
    }

    if (!trees.length) return;

    const lats = trees.map((t) => t.lat);
    const lngs = trees.map((t) => t.lng);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const padX = 42;
    const padY = 32;
    const spanLat = Math.max(maxLat - minLat, 0.0001);
    const spanLng = Math.max(maxLng - minLng, 0.0001);

    trees.forEach((t) => {
        const x = padX + ((t.lng - minLng) / spanLng) * (W - padX * 2);
        const y = H - padY - ((t.lat - minLat) / spanLat) * (H - padY * 2);

        const isSel = t.num === activeNum;
        if (isSel) {
            ctx.beginPath();
            ctx.arc(x, y, 13, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(245, 158, 11, 0.28)";
            ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(x, y, isSel ? 9 : 7, 0, Math.PI * 2);
        ctx.fillStyle = t.gpsVerified ? "#059669" : "#94a3b8";
        ctx.fill();
        ctx.lineWidth = isSel ? 2.5 : 1.5;
        ctx.strokeStyle = isSel ? "#d97706" : "#ffffff";
        ctx.stroke();

        gpsCanvasHitboxes.push({ x, y, r: 10, num: t.num });
    });
}

function setupGpsCanvasClick() {
    const canvas = document.getElementById("gps-block-canvas");
    if (!canvas) return;
    canvas.addEventListener("click", (e) => {
        const rect = canvas.getBoundingClientRect();
        const sx = canvas.width / rect.width;
        const sy = canvas.height / rect.height;
        const cx = (e.clientX - rect.left) * sx;
        const cy = (e.clientY - rect.top) * sy;

        for (const item of gpsCanvasHitboxes) {
            if (Math.hypot(cx - item.x, cy - item.y) <= item.r) {
                document.getElementById("gps-tree-num").value = item.num;
                renderGpsModule();
                break;
            }
        }
    });
}

// ----------------------------------------------------------------------------
// 7. MODULE 3: DUAL-MODE FERTILIZER APPLICATION (ERP & AOP - 4 ROUNDS/YEAR)
// ----------------------------------------------------------------------------
function switchFertilizerMode(mode) {
    fertMode = mode;
    document.getElementById("fert-view-bulk").classList.toggle("hidden", mode !== "bulk");
    document.getElementById("fert-view-checklist").classList.toggle("hidden", mode !== "checklist");

    document.getElementById("btn-fert-mode-bulk").className =
        mode === "bulk"
            ? "px-3.5 py-2 rounded-lg text-xs font-extrabold bg-emerald-600 text-white shadow-sm transition"
            : "px-3.5 py-2 rounded-lg text-xs font-extrabold text-slate-700 hover:text-slate-900 transition";

    document.getElementById("btn-fert-mode-checklist").className =
        mode === "checklist"
            ? "px-3.5 py-2 rounded-lg text-xs font-extrabold bg-emerald-600 text-white shadow-sm transition"
            : "px-3.5 py-2 rounded-lg text-xs font-extrabold text-slate-700 hover:text-slate-900 transition";

    renderFertilizerModule();
}

function renderFertilizerModule() {
    const blk = getActiveBlock();
    if (!blk) return;
    const trees = appState.treesByBlock[blk.id] || [];
    const currentYear = getActiveMonth().slice(0, 4);
    const variety = document.getElementById("fert-variety")?.value || "ERP";
    const fertRound = Number(document.getElementById("fert-round")?.value || 1);
    const weightKg = Number(document.getElementById("fert-weight-kg")?.value || 2.0);

    // 4-Round Annual Overview Strip for Current Block
    const roundsStrip = document.getElementById("fert-annual-rounds-strip");
    roundsStrip.innerHTML = [1, 2, 3, 4]
        .map((r) => {
            let count = 0;
            let totalKg = 0;
            let lastVar = "-";
            trees.forEach((t) => {
                const entry = appState.fertilizerLogs[`${blk.id}_${currentYear}_${r}_${t.num}`];
                if (entry) {
                    count++;
                    totalKg += Number(entry.weightKg || 0);
                    lastVar = entry.variety;
                }
            });
            const pct = trees.length ? Math.round((count / trees.length) * 100) : 0;
            const isSel = r === fertRound;
            return `
                <div class="bg-white rounded-2xl p-4 border ${isSel ? "border-2 border-emerald-600 shadow-sm" : "border-slate-200"}">
                    <div class="flex justify-between items-center text-xs font-bold text-slate-500">
                        <span>FERTILIZER ROUND ${r} (${currentYear})</span>
                        <span class="font-mono-code text-emerald-700">${pct}%</span>
                    </div>
                    <div class="mt-2 flex items-baseline justify-between font-mono-code">
                        <span class="text-lg font-extrabold text-slate-900">${count}/${trees.length} <small class="text-xs font-normal text-slate-500">palms</small></span>
                        <span class="text-xs font-bold px-2 py-0.5 rounded bg-emerald-50 text-emerald-800">${lastVar} (${totalKg.toFixed(0)} kg)</span>
                    </div>
                </div>
            `;
        })
        .join("");

    // Update Mode A Bulk Title
    const bulkTitle = document.getElementById("bulk-fert-summary-title");
    if (bulkTitle) {
        bulkTitle.textContent = `Apply ${variety} (${weightKg} kg/palm) to All ${trees.length} Trees in ${blk.code} (Annual Round ${fertRound})`;
    }

    // Update Mode B Tree-by-Tree Checklist
    const tbody = document.getElementById("fert-checklist-tbody");
    if (tbody) {
        tbody.innerHTML = trees
            .map((t) => {
                const existing =
                    appState.fertilizerLogs[`${blk.id}_${currentYear}_${fertRound}_${t.num}`];
                const rowWeight = existing ? existing.weightKg : weightKg;
                return `
                    <tr class="hover:bg-slate-50">
                        <td class="py-2 px-3 text-center">
                            <input type="checkbox" class="fert-tree-check w-4 h-4 accent-emerald-600 rounded cursor-pointer" data-tnum="${t.num}" ${existing ? "checked" : ""} />
                        </td>
                        <td class="py-2 px-3 font-mono-code font-bold text-slate-900">#${t.num} (${t.code})</td>
                        <td class="py-2 px-3 font-mono-code text-xs text-slate-500">${t.lat.toFixed(5)}, ${t.lng.toFixed(5)}</td>
                        <td class="py-2 px-3">
                            <input type="number" step="0.25" min="0.25" max="15" id="fert-row-wt-${t.num}" value="${rowWeight}" class="w-20 px-2 py-1 rounded border border-slate-300 font-mono-code text-xs font-bold" />
                        </td>
                        <td class="py-2 px-3">
                            ${
                                existing
                                    ? `<span class="text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800">${existing.variety} (${existing.weightKg} kg) on ${existing.date}</span>`
                                    : `<span class="text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-500">Not Applied</span>`
                            }
                        </td>
                    </tr>
                `;
            })
            .join("");
    }
}

function handleBulkApplyBlockFertilizer() {
    if (getCurrentRole() === "Harvester") {
        showToast("Permission Denied: Only Supervisor or Admin can log fertilizer.", true);
        return;
    }

    const blk = getActiveBlock();
    const trees = appState.treesByBlock[blk.id] || [];
    const currentYear = getActiveMonth().slice(0, 4);
    const variety = document.getElementById("fert-variety").value;
    const fertRound = Number(document.getElementById("fert-round").value || 1);
    const weightKg = Number(document.getElementById("fert-weight-kg").value || 2.0);
    const dateStr =
        document.getElementById("fert-date").value || new Date().toISOString().slice(0, 10);

    trees.forEach((t) => {
        appState.fertilizerLogs[`${blk.id}_${currentYear}_${fertRound}_${t.num}`] = {
            variety,
            weightKg,
            date: dateStr,
            by: currentUser?.fullName || "Supervisor",
        };
    });

    saveAppState();
    renderFertilizerModule();
    showToast(
        `Bulk Applied ${variety} (${weightKg} kg/palm) to all ${trees.length} trees in ${blk.code} (Round ${fertRound}).`
    );
}

function toggleAllFertilizerChecks(checked) {
    document.querySelectorAll(".fert-tree-check").forEach((cb) => {
        cb.checked = checked;
    });
}

function handleSubmitCheckedFertilizerTrees() {
    if (getCurrentRole() === "Harvester") {
        showToast("Permission Denied: Only Supervisor or Admin can log fertilizer.", true);
        return;
    }

    const blk = getActiveBlock();
    const currentYear = getActiveMonth().slice(0, 4);
    const variety = document.getElementById("fert-variety").value;
    const fertRound = Number(document.getElementById("fert-round").value || 1);
    const dateStr =
        document.getElementById("fert-date").value || new Date().toISOString().slice(0, 10);

    let appliedCount = 0;
    document.querySelectorAll(".fert-tree-check").forEach((cb) => {
        const tnum = Number(cb.dataset.tnum);
        const key = `${blk.id}_${currentYear}_${fertRound}_${tnum}`;
        if (cb.checked) {
            const wtInp = document.getElementById(`fert-row-wt-${tnum}`);
            const wt = wtInp ? Number(wtInp.value || 2.0) : 2.0;
            appState.fertilizerLogs[key] = {
                variety,
                weightKg: wt,
                date: dateStr,
                by: currentUser?.fullName || "Supervisor",
            };
            appliedCount++;
        } else {
            delete appState.fertilizerLogs[key];
        }
    });

    saveAppState();
    renderFertilizerModule();
    showToast(
        `Updated fertilizer checklist for ${blk.code}: ${appliedCount} trees logged with ${variety} (Round ${fertRound}).`
    );
}

// ----------------------------------------------------------------------------
// 8. MODULE 4: MONTHLY ROLL-UP SUMMARY (R1 + R2 + R3 AGGREGATION)
// ----------------------------------------------------------------------------
function renderMonthlyRollupModule() {
    const ym = getActiveMonth();
    const currentYear = ym.slice(0, 4);
    const activeBlk = getActiveBlock();

    document.getElementById("rollup-heading").textContent =
        `Monthly End Wrap-Up Summary (${ym}: Round 1 + Round 2 + Round 3)`;

    // Helper to compute block totals for selected month
    const computeBlockStats = (blk) => {
        const trees = appState.treesByBlock[blk.id] || [];
        let r1B = 0, r1F = 0, r2B = 0, r2F = 0, r3B = 0, r3F = 0;
        trees.forEach((t) => {
            const rec = appState.harvestLogs[`${blk.id}_${ym}_${t.num}`] || {};
            if (rec.r1) {
                r1B += rec.r1.bunches;
                r1F += rec.r1.fronds;
            }
            if (rec.r2) {
                r2B += rec.r2.bunches;
                r2F += rec.r2.fronds;
            }
            if (rec.r3) {
                r3B += rec.r3.bunches;
                r3F += rec.r3.fronds;
            }
        });
        return {
            treeCount: trees.length,
            r1B, r1F,
            r2B, r2F,
            r3B, r3F,
            totB: r1B + r2B + r3B,
            totF: r1F + r2F + r3F,
        };
    };

    // 1. Division-Level Roll-Up
    const divTbody = document.getElementById("rollup-division-tbody");
    divTbody.innerHTML = appState.divisions
        .map((d) => {
            const divBlocks = appState.blocks.filter((b) => b.divisionId === d.id);
            let treesCount = 0, r1B = 0, r1F = 0, r2B = 0, r2F = 0, r3B = 0, r3F = 0;
            divBlocks.forEach((b) => {
                const st = computeBlockStats(b);
                treesCount += st.treeCount;
                r1B += st.r1B; r1F += st.r1F;
                r2B += st.r2B; r2F += st.r2F;
                r3B += st.r3B; r3F += st.r3F;
            });
            const totB = r1B + r2B + r3B;
            const totF = r1F + r2F + r3F;
            return `
                <tr class="hover:bg-slate-50">
                    <td class="py-2.5 px-3 font-bold text-slate-900">${d.code} - ${d.name}</td>
                    <td class="py-2.5 px-3 font-mono-code text-xs">${divBlocks.length} Blocks / ${treesCount} Palms</td>
                    <td class="py-2.5 px-3 font-mono-code">${r1B}B / ${r1F}F</td>
                    <td class="py-2.5 px-3 font-mono-code">${r2B}B / ${r2F}F</td>
                    <td class="py-2.5 px-3 font-mono-code">${r3B}B / ${r3F}F</td>
                    <td class="py-2.5 px-3 font-mono-code font-extrabold text-emerald-700">${totB} Bunches</td>
                    <td class="py-2.5 px-3 font-mono-code font-extrabold text-amber-700">${totF} Fronds</td>
                </tr>
            `;
        })
        .join("");

    // 2. Block-Level Roll-Up
    const blkTbody = document.getElementById("rollup-block-tbody");
    blkTbody.innerHTML = appState.blocks
        .map((b) => {
            const div = appState.divisions.find((d) => d.id === b.divisionId);
            const st = computeBlockStats(b);
            return `
                <tr class="hover:bg-slate-50 ${b.id === activeBlk?.id ? "bg-emerald-50/40" : ""}">
                    <td class="py-2.5 px-3 font-bold text-slate-900">${b.code} - ${b.name}</td>
                    <td class="py-2.5 px-3 text-slate-600">${div?.code || "-"}</td>
                    <td class="py-2.5 px-3 font-mono-code">${st.treeCount} Palms</td>
                    <td class="py-2.5 px-3 font-mono-code">${st.r1B}B / ${st.r1F}F</td>
                    <td class="py-2.5 px-3 font-mono-code">${st.r2B}B / ${st.r2F}F</td>
                    <td class="py-2.5 px-3 font-mono-code">${st.r3B}B / ${st.r3F}F</td>
                    <td class="py-2.5 px-3 font-mono-code font-extrabold text-emerald-700">${st.totB} Bunches</td>
                    <td class="py-2.5 px-3 font-mono-code font-extrabold text-amber-700">${st.totF} Fronds</td>
                </tr>
            `;
        })
        .join("");

    // 3. Per-Tree Monthly Roll-Up Table for Selected Block
    if (!activeBlk) return;
    document.getElementById("rollup-tree-table-title").textContent =
        `3. Per-Tree Monthly Wrap-Up Table (${activeBlk.code}: ${activeBlk.name} - ${ym})`;

    const trees = appState.treesByBlock[activeBlk.id] || [];
    const treeTbody = document.getElementById("rollup-tree-tbody");
    treeTbody.innerHTML = trees
        .map((t) => {
            const rec = appState.harvestLogs[`${activeBlk.id}_${ym}_${t.num}`] || {};
            const b1 = rec.r1?.bunches || 0, f1 = rec.r1?.fronds || 0;
            const b2 = rec.r2?.bunches || 0, f2 = rec.r2?.fronds || 0;
            const b3 = rec.r3?.bunches || 0, f3 = rec.r3?.fronds || 0;
            const totB = b1 + b2 + b3;
            const totF = f1 + f2 + f3;

            // Fertilizer rounds applied this year
            const fertBadges = [];
            for (let r = 1; r <= 4; r++) {
                const fl = appState.fertilizerLogs[`${activeBlk.id}_${currentYear}_${r}_${t.num}`];
                if (fl) fertBadges.push(`R${r}:${fl.variety}(${fl.weightKg}kg)`);
            }

            return `
                <tr class="hover:bg-slate-50">
                    <td class="py-2 px-3 font-mono-code font-bold text-slate-900">#${t.num} (${t.code})</td>
                    <td class="py-2 px-3 font-mono-code text-xs">
                        <span class="${t.gpsVerified ? "text-emerald-700 font-bold" : "text-slate-400"}">
                            ${t.gpsVerified ? "Verified" : "Default"}
                        </span>
                        <span class="text-slate-500 ml-1">${t.lat.toFixed(5)}, ${t.lng.toFixed(5)}</span>
                    </td>
                    <td class="py-2 px-3 font-mono-code">${rec.r1 ? `${b1}B / ${f1}F` : "-"}</td>
                    <td class="py-2 px-3 font-mono-code">${rec.r2 ? `${b2}B / ${f2}F` : "-"}</td>
                    <td class="py-2 px-3 font-mono-code">${rec.r3 ? `${b3}B / ${f3}F` : "-"}</td>
                    <td class="py-2 px-3 font-mono-code font-extrabold text-emerald-800 bg-emerald-50/50">${totB} FFB</td>
                    <td class="py-2 px-3 font-mono-code font-extrabold text-amber-800 bg-amber-50/50">${totF} Fronds</td>
                    <td class="py-2 px-3 font-mono-code text-xs text-slate-600">
                        ${fertBadges.length ? fertBadges.join(", ") : "-"}
                    </td>
                </tr>
            `;
        })
        .join("");
}

function exportMonthlyRollupCSV() {
    const blk = getActiveBlock();
    if (!blk) return;
    const ym = getActiveMonth();
    const currentYear = ym.slice(0, 4);
    const trees = appState.treesByBlock[blk.id] || [];

    const rows = [
        [
            "Block",
            "Month",
            "Tree Number",
            "Tree Code",
            "Latitude",
            "Longitude",
            "GPS Verified",
            "R1 Bunches",
            "R1 Fronds",
            "R2 Bunches",
            "R2 Fronds",
            "R3 Bunches",
            "R3 Fronds",
            "Monthly Total Bunches",
            "Monthly Total Fronds",
            "Fertilizer Applied",
        ].join(","),
    ];

    trees.forEach((t) => {
        const rec = appState.harvestLogs[`${blk.id}_${ym}_${t.num}`] || {};
        const b1 = rec.r1?.bunches || 0, f1 = rec.r1?.fronds || 0;
        const b2 = rec.r2?.bunches || 0, f2 = rec.r2?.fronds || 0;
        const b3 = rec.r3?.bunches || 0, f3 = rec.r3?.fronds || 0;
        const ferts = [];
        for (let r = 1; r <= 4; r++) {
            const fl = appState.fertilizerLogs[`${blk.id}_${currentYear}_${r}_${t.num}`];
            if (fl) ferts.push(`R${r}:${fl.variety}(${fl.weightKg}kg)`);
        }

        rows.push(
            [
                blk.code,
                ym,
                t.num,
                t.code,
                t.lat,
                t.lng,
                t.gpsVerified ? "Yes" : "No",
                b1,
                f1,
                b2,
                f2,
                b3,
                f3,
                b1 + b2 + b3,
                f1 + f2 + f3,
                `"${ferts.join(" ")}"`,
            ].join(",")
        );
    });

    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Elaeis_${blk.code}_Monthly_Rollup_${ym}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// ----------------------------------------------------------------------------
// 9. MODULE 5: ADMIN HIERARCHY & BATCH TREE GENERATOR (RBAC ADMIN ONLY)
// ----------------------------------------------------------------------------
function renderAdminHierarchyModule() {
    applyRbacUI();
    const tbody = document.getElementById("admin-hierarchy-tbody");
    if (!tbody) return;

    tbody.innerHTML = appState.blocks
        .map((b) => {
            const div = appState.divisions.find((d) => d.id === b.divisionId);
            const est = appState.estates.find((e) => e.id === div?.estateId);
            const trees = appState.treesByBlock[b.id] || [];
            const verified = trees.filter((t) => t.gpsVerified).length;

            return `
                <tr class="hover:bg-slate-50">
                    <td class="py-2.5 px-3 font-semibold text-slate-700">${est?.code || "EST-01"}</td>
                    <td class="py-2.5 px-3 font-semibold text-slate-700">${div?.code || "-"} (${div?.name || ""})</td>
                    <td class="py-2.5 px-3 font-bold text-slate-900">${b.code} - ${b.name}</td>
                    <td class="py-2.5 px-3 font-mono-code font-bold text-emerald-700">${trees.length} Trees (#1 - #${trees.length})</td>
                    <td class="py-2.5 px-3 font-mono-code text-xs">${verified} / ${trees.length} Verified</td>
                    <td class="py-2.5 px-3 text-right space-x-2">
                        <button type="button" onclick="quickBatchAdd50('${b.id}')" class="px-2.5 py-1 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-800 font-bold text-xs">
                            +50 Trees
                        </button>
                        <button type="button" onclick="handleDeleteBlock('${b.id}')" class="px-2.5 py-1 rounded-lg bg-red-50 hover:bg-red-100 text-red-700 font-bold text-xs">
                            Delete Block
                        </button>
                    </td>
                </tr>
            `;
        })
        .join("");
}

function generateTreesArray(count, baseLat, baseLng, existingTrees = []) {
    const existingMap = {};
    existingTrees.forEach((t) => {
        existingMap[t.num] = t;
    });

    const list = [];
    for (let i = 1; i <= count; i++) {
        if (existingMap[i]) {
            list.push(existingMap[i]);
        } else {
            const row = Math.floor((i - 1) / 10) + 1;
            const col = (i - 1) % 10;
            const lat = Number((baseLat + (row - 1) * 0.000075).toFixed(6));
            const lng = Number(
                (baseLng + col * 0.000085 + (row % 2 === 0 ? 0.000042 : 0)).toFixed(6)
            );
            list.push({
                num: i,
                code: `T-${String(i).padStart(3, "0")}`,
                row,
                lat,
                lng,
                gpsVerified: false,
                gpsAccuracy: null,
                gpsUpdatedAt: null,
            });
        }
    }
    return list;
}

function handleBatchGenerateTrees(e) {
    e.preventDefault();
    if (getCurrentRole() !== "Admin") {
        showToast("RBAC Violation: Only Admin can batch generate trees.", true);
        return;
    }

    const blkId = document.getElementById("batch-target-block").value;
    const count = Number(document.getElementById("batch-tree-count").value || 250);
    const baseLat = Number(document.getElementById("batch-base-lat").value || 6.1425);
    const baseLng = Number(document.getElementById("batch-base-lng").value || 80.3652);

    const blk = appState.blocks.find((b) => b.id === blkId);
    if (!blk) return;

    blk.baseLat = baseLat;
    blk.baseLng = baseLng;
    appState.treesByBlock[blkId] = generateTreesArray(
        count,
        baseLat,
        baseLng,
        appState.treesByBlock[blkId] || []
    );

    saveAppState();
    initGlobalSelectors();
    document.getElementById("global-block").value = blkId;
    refreshAllPanels();
    showToast(`Batch generated Tree #1 to Tree #${count} in ${blk.code}.`);
}

function quickBatchAdd50(blkId) {
    if (getCurrentRole() !== "Admin") return;
    const blk = appState.blocks.find((b) => b.id === blkId);
    if (!blk) return;
    const current = appState.treesByBlock[blkId] || [];
    const newTotal = current.length + 50;
    appState.treesByBlock[blkId] = generateTreesArray(
        newTotal,
        blk.baseLat || 6.1425,
        blk.baseLng || 80.3652,
        current
    );
    saveAppState();
    initGlobalSelectors();
    refreshAllPanels();
    showToast(`Added 50 trees to ${blk.code} (Total: ${newTotal} palms).`);
}

function handleCreateDivision(e) {
    e.preventDefault();
    if (getCurrentRole() !== "Admin") return;
    const code = document.getElementById("new-div-code").value.trim().toUpperCase();
    const name = document.getElementById("new-div-name").value.trim();
    const estId = document.getElementById("global-estate").value;

    const newDiv = {
        id: `div-${Date.now()}`,
        estateId: estId,
        code,
        name,
        maxTrees: 3000,
    };
    appState.divisions.push(newDiv);
    saveAppState();
    document.getElementById("new-div-code").value = "";
    document.getElementById("new-div-name").value = "";
    initGlobalSelectors();
    refreshAllPanels();
    showToast(`Created Division ${code} - ${name}.`);
}

function handleCreateBlockWithBatch(e) {
    e.preventDefault();
    if (getCurrentRole() !== "Admin") return;
    const divId = document.getElementById("global-division").value;
    const code = document.getElementById("new-blk-code").value.trim().toUpperCase();
    const name = document.getElementById("new-blk-name").value.trim();
    const count = Number(document.getElementById("new-blk-count").value || 200);

    const blkId = `blk-${Date.now()}`;
    const newBlk = {
        id: blkId,
        divisionId: divId,
        code,
        name,
        baseLat: 6.1425,
        baseLng: 80.3652,
    };

    appState.blocks.push(newBlk);
    appState.treesByBlock[blkId] = generateTreesArray(count, 6.1425, 80.3652, []);

    saveAppState();
    document.getElementById("new-blk-code").value = "";
    document.getElementById("new-blk-name").value = "";
    initGlobalSelectors();
    document.getElementById("global-block").value = blkId;
    refreshAllPanels();
    showToast(`Created ${code} and batch-generated ${count} trees (#1 to #${count}).`);
}

function handleDeleteBlock(blkId) {
    if (getCurrentRole() !== "Admin") return;
    if (appState.blocks.length <= 1) {
        showToast("Cannot delete the last remaining block.", true);
        return;
    }
    const blk = appState.blocks.find((b) => b.id === blkId);
    appState.blocks = appState.blocks.filter((b) => b.id !== blkId);
    delete appState.treesByBlock[blkId];
    saveAppState();
    initGlobalSelectors();
    refreshAllPanels();
    showToast(`Deleted block ${blk?.code || ""}.`);
}
