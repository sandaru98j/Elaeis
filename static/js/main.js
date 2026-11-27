// ============================================================================
// ELAEIS — Application Router, Auth Flow, Clock, Service Worker & Boot
// ============================================================================

function updateClockAndGreeting() {
    const now = new Date();
    const hr = now.getHours();
    const greeting = hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening";
    const fullName = state.user?.full_name || "User";
    const firstName = fullName.split(" ")[0] || fullName;
    const isMobile = typeof window !== "undefined" && window.innerWidth <= 768;

    const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const dateStr = now.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const today = todayStr();
    const { round, rangeLabel } = roundOfDate(today);

    if ($("hdr-greeting")) {
        $("hdr-greeting").textContent = `${greeting}, ${firstName}`;
    }
    if ($("hdr-clock")) {
        $("hdr-clock").textContent = isMobile ? timeStr : `${dateStr} • ${timeStr}`;
    }
    if ($("hdr-round-pill")) {
        $("hdr-round-pill").textContent = isMobile ? `R${round}` : `R${round} (${rangeLabel})`;
    }
    if ($("right-active-round")) {
        $("right-active-round").textContent = `Round ${round} (${rangeLabel})`;
    }
}

function showAuthScreen() {
    $("auth-screen").classList.remove("hidden");
    $("app-shell").classList.add("hidden");
    refreshIcons();
}

async function loginWithUsername(username, password) {
    try {
        const res = await api("/api/auth/login", "POST", { username, password });
        state.token = res.token;
        state.user = res.user;
        localStorage.setItem("el_token", res.token);
        await OfflineDB.setKV("cache:me", { user: res.user });
        if (res.user?.theme && THEME_REGISTRY[res.user.theme]) {
            applyTheme(res.user.theme, false);
        }
        toast(`Welcome back, @${res.user.username}`);
        await enterApplication();
    } catch (err) {
        toast(err.message || "Invalid username or password.", "err");
    }
}

async function enterApplication() {
    if (!state.user) {
        try {
            const me = await api("/api/auth/me");
            state.user = me.user;
        } catch (err) {
            // If offline, resume cached user session from IndexedDB so field workers aren't locked out!
            const cachedMe = !err.status ? await OfflineDB.getKV("cache:me") : null;
            if (cachedMe?.user) {
                state.user = cachedMe.user;
                toast("Offline session resumed from local cache", "warn");
            } else {
                state.token = "";
                localStorage.removeItem("el_token");
                showAuthScreen();
                return;
            }
        }
    }

    const isMaster = Boolean(state.user.is_master) || normalizeRole(state.user.role) === "Master Admin";
    state.user.is_master = isMaster;
    state.user.role = isMaster ? "Master Admin" : normalizeRole(state.user.role);

    if (state.user.theme && THEME_REGISTRY[state.user.theme] && !localStorage.getItem("elaeis_theme")) {
        applyTheme(state.user.theme, false);
    } else {
        applyTheme(state.theme, false);
    }

    updateClockAndGreeting();
    syncUserIdentityUI();
    $("auth-screen").classList.add("hidden");
    $("app-shell").classList.remove("hidden");

    applyRbacNavigation();
    await loadBootstrap();
    captureDeviceGps();
    switchPage(state.activePage, false);

    // Flush any previously queued offline field records once online
    if (state.online && state.pendingSyncCount > 0) {
        OfflineSync.flush(true);
    }
}

function applyRbacNavigation() {
    const userRank = ROLE_RANK[state.user?.role] || 1;
    document.querySelectorAll("[data-nav]").forEach((btn) => {
        const minRole = btn.getAttribute("data-min-role") || "Harvester";
        const allowed = userRank >= (ROLE_RANK[minRole] || 1);
        btn.classList.toggle("hidden", !allowed);
    });
    const currentMin = {
        overview: "Harvester",
        harvests: "Harvester",
        map: "Harvester",
        estates: "Admin",
        directory: "Admin",
        profile: "Harvester",
        settings: "Harvester",
        info: "Harvester",
    }[state.activePage];
    if (userRank < (ROLE_RANK[currentMin] || 1)) {
        state.activePage = "overview";
    }
}

async function loadBootstrap() {
    try {
        const data = await api("/api/bootstrap");
        state.hierarchy = data.hierarchy || { estates: [], divisions: [], fields: [], blocks: [] };
        state.settings = data.settings || { season_start_month: 4 };
        if (Array.isArray(data.mapped_trees)) {
            state.mappedTrees = data.mapped_trees;
        }
    } catch (err) {
        toast(err.message || "Offline — cached estate hierarchy unavailable", "warn");
    }

    initDashboardFilters();
    initGisMapFilters();
    initDivisionCascade("harv", () => loadHarvestBlock());
    initDivisionCascade("map", () => loadMapperBlock());
    initDispatchForm();
}

function closeMobileDrawer() {
    if ($("mobile-drawer")) $("mobile-drawer").classList.add("hidden");
}

function switchPage(page, pushUrl = true) {
    const target = PAGE_TITLES[page] ? page : "overview";
    state.activePage = target;

    if (pushUrl && window.history && typeof window.history.pushState === "function") {
        const nextPath = target === "overview" ? "/" : `/${target}`;
        if (window.location.pathname !== nextPath) {
            window.history.pushState({ page: target }, "", nextPath);
        }
    }

    if ($("hdr-page-title")) {
        $("hdr-page-title").textContent = PAGE_TITLES[target] || "Overview";
    }

    document.querySelectorAll(".page-view").forEach((sec) => {
        sec.classList.toggle("hidden", sec.id !== `page-${target}`);
    });

    document.querySelectorAll("[data-nav]").forEach((btn) => {
        const active = btn.getAttribute("data-nav") === target;
        if (btn.closest("#desktop-nav") || btn.closest("#drawer-nav")) {
            btn.classList.toggle("active", active);
        } else if (btn.closest("#mobile-nav")) {
            btn.className = `nav-btn flex flex-col items-center justify-center gap-0.5 text-[10px] font-bold min-w-0 transition ${
                active ? "text-[#0f1419] font-extrabold" : "text-[#536471]"
            }`;
        }
    });

    closeMobileDrawer();

    if (target === "overview") refreshDashboard();
    if (target === "harvests") {
        if (state.harvestView === "trees") loadHarvestBlock();
        else loadDispatches();
    }
    if (target === "map") loadGisMapPage();
    if (target === "estates") loadEstatesPage();
    if (target === "directory") loadDirectoryPage();
    if (target === "profile") loadProfilePage();
    if (target === "settings") applyTheme(state.theme, false);
    refreshIcons();
}

async function doLogout() {
    closeMobileDrawer();
    if (state.pendingSyncCount > 0) {
        const proceed = window.confirm(
            `You have ${state.pendingSyncCount} unsynced offline field record(s) queued on this device. Sign out anyway?`
        );
        if (!proceed) return;
    }
    try {
        await api("/api/auth/logout", "POST");
    } catch (_) {}
    state.token = "";
    state.user = null;
    localStorage.removeItem("el_token");
    await OfflineDB.delKV("cache:me").catch(() => {});
    showAuthScreen();
}

// ----------------------------------------------------------------------------
// Service Worker Registration & DOM Initialization
// ----------------------------------------------------------------------------
function registerServiceWorker() {
    if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
}

document.addEventListener("DOMContentLoaded", async () => {
    registerServiceWorker();
    await OfflineSync.init();

    applyTheme(state.theme, false);
    setInterval(updateClockAndGreeting, 1000);
    updateClockAndGreeting();
    updateGpsHeader();

    window.addEventListener("resize", () => {
        updateClockAndGreeting();
        updateGpsHeader();
    });

    const today = todayStr();
    const { round } = roundOfDate(today);
    if ($("harv-date")) $("harv-date").value = today;
    if ($("harv-round")) $("harv-round").value = String(round);
    if ($("disp-date")) $("disp-date").value = today;
    if ($("disp-round")) $("disp-round").value = String(round);

    window.addEventListener("popstate", () => {
        const route = getInitialRouteFromLocation();
        if (state.token) switchPage(route, false);
    });

    // Offline Sync Center Pill & Controls
    if ($("btn-sync-pill")) $("btn-sync-pill").onclick = () => OfflineSync.openModal();
    if ($("btn-right-sync-open")) $("btn-right-sync-open").onclick = () => OfflineSync.openModal();
    if ($("btn-sync-now")) $("btn-sync-now").onclick = () => OfflineSync.flush(false);
    if ($("btn-offline-preload")) $("btn-offline-preload").onclick = () => OfflineSync.preloadEstateForField();

    document.querySelectorAll("[data-toggle-pass]").forEach((btn) => {
        btn.onclick = () => {
            const inp = $(btn.getAttribute("data-toggle-pass"));
            if (inp) inp.type = inp.type === "password" ? "text" : "password";
        };
    });

    document.querySelectorAll("[data-theme-select]").forEach((card) => {
        card.onclick = () => {
            const chosen = card.getAttribute("data-theme-select");
            applyTheme(chosen, true);
            const label = THEME_REGISTRY[chosen]?.name || chosen;
            toast(`Theme switched to ${label}`);
        };
    });

    if ($("btn-theme-quick")) $("btn-theme-quick").onclick = () => switchPage("settings");

    if ($("btn-mobile-menu")) {
        $("btn-mobile-menu").onclick = () => {
            $("mobile-drawer")?.classList.remove("hidden");
            refreshIcons();
        };
    }
    if ($("btn-close-mobile-drawer")) $("btn-close-mobile-drawer").onclick = closeMobileDrawer;
    if ($("mobile-drawer-backdrop")) $("mobile-drawer-backdrop").onclick = closeMobileDrawer;

    $("form-login").onsubmit = async (e) => {
        e.preventDefault();
        await loginWithUsername($("login-username").value.trim(), $("login-password").value);
    };

    const goHomeAndRefresh = async () => {
        switchPage("overview");
        await loadBootstrap();
        await refreshDashboard();
        toast("Overview refreshed");
    };
    if ($("btn-brand-home")) $("btn-brand-home").onclick = goHomeAndRefresh;
    if ($("btn-brand-home-mobile")) $("btn-brand-home-mobile").onclick = goHomeAndRefresh;

    if ($("btn-quick-harvest")) $("btn-quick-harvest").onclick = () => switchPage("harvests");
    if ($("btn-feed-go-harvests")) $("btn-feed-go-harvests").onclick = () => switchPage("harvests");
    if ($("btn-rail-profile")) $("btn-rail-profile").onclick = () => switchPage("profile");

    if ($("btn-logout")) $("btn-logout").onclick = () => doLogout();
    if ($("btn-logout-mobile")) $("btn-logout-mobile").onclick = () => doLogout();
    if ($("btn-logout-drawer")) $("btn-logout-drawer").onclick = () => doLogout();

    $("btn-gps-ping").onclick = async () => {
        const g = await requestBrowserGps(5000);
        if (g.ok && g.lat !== null && g.lng !== null) {
            toast(`GPS: ${g.lat.toFixed(5)}, ${g.lng.toFixed(5)} (±${Math.round(g.acc)}m)`);
        } else {
            toast("GPS weak — select tree manually");
        }
    };

    document.querySelectorAll("[data-nav]").forEach((btn) => {
        btn.onclick = () => switchPage(btn.getAttribute("data-nav"));
    });

    // Overview Export & Reset
    $("btn-dash-reset").onclick = () => initDashboardFilters();
    $("btn-export-pdf").onclick = () => window.print();
    if ($("btn-export-excel")) $("btn-export-excel").onclick = () => downloadDashboardExcel();
    if ($("btn-export-csv")) $("btn-export-csv").onclick = () => downloadDashboardCsv();

    // Edit Profile Modal
    if ($("btn-open-edit-profile")) $("btn-open-edit-profile").onclick = openEditProfileModal;
    if ($("btn-ep-save-top")) $("btn-ep-save-top").onclick = () => saveEditProfile();
    if ($("form-edit-profile")) {
        $("form-edit-profile").onsubmit = (e) => {
            e.preventDefault();
            saveEditProfile();
        };
    }
    if ($("btn-ep-upload-avatar") && $("ep-avatar-input")) {
        $("btn-ep-upload-avatar").onclick = () => $("ep-avatar-input").click();
        $("ep-avatar-input").onchange = async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                state.editProfileDraft.profile_pic = await readImageFileAsDataUrl(file, 400, 400);
                syncEditProfileModalPreviews();
            } catch (err) {
                toast(err.message, "err");
            }
            e.target.value = "";
        };
    }
    if ($("btn-ep-remove-avatar")) {
        $("btn-ep-remove-avatar").onclick = () => {
            state.editProfileDraft.profile_pic = "";
            syncEditProfileModalPreviews();
        };
    }
    if ($("btn-ep-upload-cover") && $("ep-cover-input")) {
        $("btn-ep-upload-cover").onclick = () => $("ep-cover-input").click();
        $("ep-cover-input").onchange = async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                state.editProfileDraft.cover_photo = await readImageFileAsDataUrl(file, 1200, 480);
                syncEditProfileModalPreviews();
            } catch (err) {
                toast(err.message, "err");
            }
            e.target.value = "";
        };
    }
    if ($("btn-ep-remove-cover")) {
        $("btn-ep-remove-cover").onclick = () => {
            state.editProfileDraft.cover_photo = "";
            syncEditProfileModalPreviews();
        };
    }

    // Harvests Sub-Tabs
    document.querySelectorAll("[data-harv-view]").forEach((btn) => {
        btn.onclick = () => {
            const v = btn.getAttribute("data-harv-view");
            state.harvestView = v;
            document.querySelectorAll("[data-harv-view]").forEach((b) => {
                const on = b === btn;
                b.className = `harv-view-tab py-3.5 px-2 text-xs truncate ${
                    on ? "font-extrabold border-b-2 border-[#0f1419] text-[#0f1419]" : "font-semibold border-b-2 border-transparent text-[#536471]"
                } hover:bg-[#f7f9f9] transition`;
            });
            $("harv-panel-trees").classList.toggle("hidden", v !== "trees");
            $("harv-panel-dispatch").classList.toggle("hidden", v !== "dispatch");
            if (v === "trees") loadHarvestBlock();
            else loadDispatches();
        };
    });

    $("harv-round").onchange = () => loadHarvestBlock();
    $("harv-date").onchange = () => loadHarvestBlock();

    if ($("harv-autodetect-toggle")) {
        $("harv-autodetect-toggle").checked = Boolean(state.autoDetectGps);
        $("harv-autodetect-toggle").onchange = (e) => {
            state.autoDetectGps = Boolean(e.target.checked);
            try {
                localStorage.setItem("elaeis_autodetect_gps", state.autoDetectGps ? "1" : "0");
            } catch (_) {}
            if (state.autoDetectGps) autoDetectNearestTree({ openModal: false });
        };
    }

    if ($("btn-harv-autodetect")) $("btn-harv-autodetect").onclick = () => autoDetectNearestTree({ openModal: true });
    if ($("btn-mh-autodetect")) $("btn-mh-autodetect").onclick = () => autoDetectNearestTree({ openModal: true });

    if ($("harv-tree-select")) {
        $("harv-tree-select").onchange = (e) => {
            const tid = Number(e.target.value);
            if (!tid) return;
            state.harvBlock.manualOverride = true;
            state.harvBlock.selectedTreeId = tid;
            openHarvestModal(tid);
        };
    }

    const openTypedTreeForHarvest = () => {
        const rawNo = ($("harv-search")?.value || "").trim();
        const trees = state.harvBlock.trees || [];
        if (rawNo) {
            const match = trees.find((t) => t.tree_no === Number(rawNo));
            if (!match) return toast(`Palm #${rawNo} not found in current block.`, "err");
            state.harvBlock.manualOverride = true;
            state.harvBlock.selectedTreeId = match.id;
            openHarvestModal(match.id);
        } else if (state.harvBlock.selectedTreeId) {
            state.harvBlock.manualOverride = true;
            openHarvestModal(state.harvBlock.selectedTreeId);
        } else if (trees[0]) {
            openHarvestModal(trees[0].id);
        }
    };

    // Debounced tree search input for silky performance on low-end field phones
    let searchTimer = null;
    $("harv-search").oninput = (e) => {
        const val = e.target.value;
        state.harvBlock.search = val;
        const typedNo = Number(val);
        if (typedNo) {
            const match = (state.harvBlock.trees || []).find((t) => t.tree_no === typedNo);
            if (match) {
                state.harvBlock.manualOverride = true;
                state.harvBlock.selectedTreeId = match.id;
                if ($("harv-tree-select")) $("harv-tree-select").value = String(match.id);
            }
        }
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => renderHarvestGrid(), 90);
    };
    $("harv-search").onkeydown = (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            openTypedTreeForHarvest();
        }
    };
    if ($("btn-harv-log-typed")) $("btn-harv-log-typed").onclick = openTypedTreeForHarvest;

    if ($("mh-block")) {
        $("mh-block").onchange = async (e) => {
            const nextBid = Number(e.target.value);
            if (!nextBid) return;
            state.harvBlock.manualOverride = true;
            const prevTreeNo = Number($("mh-tree-no")?.value) || 1;
            await selectHarvestBlockCascade(nextBid);
            const target = state.harvBlock.trees.find((t) => t.tree_no === prevTreeNo) || state.harvBlock.trees[0];
            if (target) {
                populateHarvestTreeDropdowns(target.id);
                populateHarvestModalFields(target);
            }
        };
    }
    if ($("mh-tree-select")) {
        $("mh-tree-select").onchange = (e) => {
            const tid = Number(e.target.value);
            const target = (state.harvBlock.trees || []).find((t) => t.id === tid);
            if (target) {
                state.harvBlock.manualOverride = true;
                populateHarvestModalFields(target);
            }
        };
    }
    if ($("mh-tree-no")) {
        $("mh-tree-no").oninput = (e) => {
            const tno = Number(e.target.value);
            if (!tno) return;
            const target = (state.harvBlock.trees || []).find((t) => t.tree_no === tno);
            if (target) {
                state.harvBlock.manualOverride = true;
                populateHarvestModalFields(target);
            }
        };
    }
    if ($("btn-mh-sync-gps")) $("btn-mh-sync-gps").onclick = () => syncCalibrationInputsToMyLocation("mh-cal-lat", "mh-cal-lng");
    if ($("btn-mh-save-pin")) $("btn-mh-save-pin").onclick = () => saveHarvestModalPinCalibration(false);

    document.querySelectorAll(".harv-flt-btn").forEach((btn) => {
        btn.onclick = () => {
            state.harvBlock.filter = btn.getAttribute("data-harv-filter");
            document.querySelectorAll(".harv-flt-btn").forEach((b) => {
                b.className = `harv-flt-btn px-3 py-1 rounded-full ${
                    b === btn ? "bg-[#0f1419] text-white" : "text-[#536471]"
                }`;
            });
            renderHarvestGrid();
        };
    });
    $("btn-submit-harvest").onclick = () => submitHarvestModal();

    // Dispatch Crop Weight Form Submit (Offline-Queue Ready + Idempotent client_id)
    $("form-dispatch").onsubmit = async (e) => {
        e.preventDefault();
        const btn = $("btn-submit-dispatch");
        btn.disabled = true;
        try {
            const round_no = Number($("disp-round").value);
            const date = $("disp-date").value || todayStr();
            const division_id = Number($("disp-division").value);
            const weight_kg = Number($("disp-weight").value);
            const divObj = (state.hierarchy.divisions || []).find((d) => d.id === division_id);
            const res = await apiFieldWrite(
                "dispatch",
                "/api/dispatch",
                { round_no, date, division_id, weight_kg },
                `Dispatch ${weight_kg.toLocaleString()} kg (${divObj?.name || "Division"} • R${round_no})`
            );
            $("disp-weight").value = "";
            toast(
                res.queued
                    ? `Dispatch queued offline (${weight_kg.toLocaleString()} kg • R${round_no})`
                    : `Dispatch weight logged (${weight_kg.toLocaleString()} kg • R${round_no})`,
                res.queued ? "warn" : "ok"
            );
            await loadDispatches();
        } catch (err) {
            toast(err.message, "err");
        } finally {
            btn.disabled = false;
        }
    };

    document.querySelectorAll("[data-step]").forEach((btn) => {
        btn.onclick = () => {
            const [id, delta] = btn.getAttribute("data-step").split(":");
            const inp = $(id);
            if (!inp) return;
            inp.value = Math.max(0, Math.min(60, (Number(inp.value) || 0) + Number(delta)));
        };
    });

    // GIS Map Controls
    if ($("btn-mapview-full")) {
        $("btn-mapview-full").onclick = () => {
            if ($("mapview-division")) $("mapview-division").value = "";
            initGisMapFilters();
            state.gisMap.isolate = false;
            applyGisTreeIsolationAndStats();
            fitGisMapToActiveSelection(true);
        };
    }
    if ($("btn-mapview-isolate")) {
        $("btn-mapview-isolate").onclick = () => {
            const { hasAreaFilter } = getGisActiveScopeMeta();
            if (!hasAreaFilter && !state.gisMap.isolate) {
                toast("Select a Division, Field, or Block to isolate");
                return;
            }
            state.gisMap.isolate = !state.gisMap.isolate;
            applyGisTreeIsolationAndStats();
            fitGisMapToActiveSelection(true);
        };
    }
    if ($("btn-mapview-basemap")) {
        $("btn-mapview-basemap").onclick = () => {
            const map = state.gisMap.map;
            if (!map) return;
            const nextMode = state.gisMap.basemapMode === "satellite" ? "clean" : "satellite";
            state.gisMap.basemapMode = nextMode;
            if (nextMode === "clean") {
                if (state.gisMap.satelliteLayer) map.removeLayer(state.gisMap.satelliteLayer);
                syncGisCleanBasemapLayer();
            } else {
                if (state.gisMap.cleanLayer) map.removeLayer(state.gisMap.cleanLayer);
                if (state.gisMap.satelliteLayer) state.gisMap.satelliteLayer.addTo(map);
            }
            $("btn-mapview-basemap").classList.toggle("active", nextMode === "satellite");
            if ($("lbl-mapview-basemap")) {
                $("lbl-mapview-basemap").textContent = nextMode === "satellite" ? "Satellite" : "Clean Map";
            }
            renderGisBoundariesAndLabels();
        };
    }
    if ($("btn-mapview-boundaries")) {
        $("btn-mapview-boundaries").onclick = () => {
            state.gisMap.showBoundaries = !state.gisMap.showBoundaries;
            $("btn-mapview-boundaries").classList.toggle("active", state.gisMap.showBoundaries);
            renderGisBoundariesAndLabels();
        };
    }
    if ($("btn-mapview-labels")) {
        $("btn-mapview-labels").onclick = () => {
            state.gisMap.showLabels = !state.gisMap.showLabels;
            $("btn-mapview-labels").classList.toggle("active", state.gisMap.showLabels);
            renderGisBoundariesAndLabels();
        };
    }
    if ($("mapview-time-mode")) {
        $("mapview-time-mode").onchange = () => {
            const mode = $("mapview-time-mode").value;
            $("mapview-season")?.classList.toggle("hidden", mode !== "season");
            $("mapview-year")?.classList.toggle("hidden", mode !== "year");
            $("mapview-month")?.classList.toggle("hidden", mode !== "month");
            $("mapview-custom-dates")?.classList.toggle("hidden", mode !== "custom");
            refreshGisMapData(false);
        };
    }
    ["mapview-season", "mapview-year", "mapview-month", "mapview-from", "mapview-to", "mapview-round"].forEach((id) => {
        if ($(id)) $(id).onchange = () => refreshGisMapData(false);
    });
    if ($("btn-mapview-download")) {
        $("btn-mapview-download").onclick = (e) => {
            e.stopPropagation();
            $("mapview-download-menu")?.classList.toggle("hidden");
        };
    }
    document.addEventListener("click", (e) => {
        const wrap = $("mapview-download-wrap");
        const menu = $("mapview-download-menu");
        if (menu && !menu.classList.contains("hidden") && wrap && !wrap.contains(e.target)) {
            menu.classList.add("hidden");
        }
    });
    if ($("btn-mapview-dl-png")) {
        $("btn-mapview-dl-png").onclick = () => {
            $("mapview-download-menu")?.classList.add("hidden");
            downloadGisMapPng();
        };
    }
    if ($("btn-mapview-dl-kml")) {
        $("btn-mapview-dl-kml").onclick = () => {
            $("mapview-download-menu")?.classList.add("hidden");
            exportGisMapKml();
        };
    }

    // Estates Sub-Tabs
    document.querySelectorAll("[data-est-tab]").forEach((btn) => {
        btn.onclick = () => {
            const tab = btn.getAttribute("data-est-tab");
            state.estatesTab = tab;
            document.querySelectorAll("[data-est-tab]").forEach((b) => {
                const on = b === btn;
                b.className = `est-tab-btn py-3.5 px-2 text-xs truncate ${
                    on ? "font-extrabold border-b-2 border-[#0f1419] text-[#0f1419]" : "font-semibold border-b-2 border-transparent text-[#536471]"
                } hover:bg-[#f7f9f9] transition`;
            });
            $("est-panel-hierarchy").classList.toggle("hidden", tab !== "hierarchy");
            $("est-panel-mapper").classList.toggle("hidden", tab !== "mapper");
            if (tab === "mapper") loadMapperBlock();
        };
    });

    $("btn-mapper-add-tree").onclick = () => openMapperModal(null);
    $("btn-mp-capture").onclick = () => syncCalibrationInputsToMyLocation("mp-lat", "mp-lng");
    $("btn-mp-save").onclick = () => saveMapperModal();
    $("btn-mp-delete").onclick = () => deleteMapperTree();

    $("btn-add-estate").onclick = () => openCrudModal("estate");
    $("btn-add-division").onclick = () => openCrudModal("division");
    $("btn-add-field").onclick = () => openCrudModal("field");
    $("btn-add-block").onclick = () => openCrudModal("block");

    $("btn-ac-save").onclick = async () => {
        if (!state.crudCallback) return;
        try {
            await state.crudCallback();
            $("modal-admin-crud").classList.add("hidden");
            toast("Estate hierarchy updated");
            await loadEstatesPage();
            await loadBootstrap();
        } catch (err) {
            toast(err.message, "err");
        }
    };

    $("btn-save-settings").onclick = async () => {
        try {
            await api("/api/admin/settings", "POST", {
                season_start_month: Number($("set-season-month").value),
            });
            toast("Estate parameters saved");
            await loadEstatesPage();
        } catch (err) {
            toast(err.message, "err");
        }
    };

    $("btn-open-create-user").onclick = () => $("modal-create-user").classList.remove("hidden");
    $("form-create-user").onsubmit = async (e) => {
        e.preventDefault();
        try {
            const res = await api("/api/admin/users/create", "POST", {
                username: $("cu-username").value.trim(),
                full_name: $("cu-fullname").value.trim(),
                role: $("cu-role").value,
                password: $("cu-password").value,
            });
            $("form-create-user").reset();
            $("modal-create-user").classList.add("hidden");
            toast(res.message || "ERP user created");
            await loadDirectoryPage();
        } catch (err) {
            toast(err.message, "err");
        }
    };

    $("btn-confirm-force-password").onclick = async () => {
        if (!state.forcePwTarget) return;
        const new_password = $("fp-new-password").value;
        if (new_password.length < 6) return toast("Password must be at least 6 characters.", "err");
        try {
            const res = await api("/api/admin/users/force-password", "POST", {
                user_id: state.forcePwTarget.id,
                new_password,
            });
            $("modal-force-password").classList.add("hidden");
            toast(res.message || `Password updated for @${state.forcePwTarget.username}`);
        } catch (err) {
            toast(err.message, "err");
        }
    };

    $("form-profile-password").onsubmit = async (e) => {
        e.preventDefault();
        const current_password = $("prof-cur-password").value;
        const new_password = $("prof-new-password").value;
        const confirm_password = $("prof-confirm-password").value;
        if (new_password !== confirm_password) return toast("New passwords do not match.", "err");
        try {
            const res = await api("/api/auth/change-password", "POST", {
                current_password,
                new_password,
            });
            $("form-profile-password").reset();
            toast(res.message || "Password updated successfully");
        } catch (err) {
            toast(err.message, "err");
        }
    };

    document.querySelectorAll("[data-close-modal]").forEach((btn) => {
        btn.onclick = () => $(btn.getAttribute("data-close-modal")).classList.add("hidden");
    });

    if (state.token) {
        enterApplication();
    } else {
        showAuthScreen();
    }
});
