// ============================================================================
// ELAEIS — Dedicated Full-Screen GIS Satellite Map (60fps Canvas + Turf.js)
// Dynamic Estate Branding + Genuine GPS Mapping + PNG & Google Earth KML Export
// ============================================================================

const AERIAL_PALM_FROND_PATHS = [
    "M32 30 C28 19, 27 10, 32 3 C37 10, 36 19, 32 30 Z",
    "M34 30 C41 21, 48 15, 55 10 C50 18, 43 25, 34 30 Z",
    "M34 32 C45 28, 54 27, 61 32 C54 37, 45 36, 34 32 Z",
    "M34 34 C43 39, 50 46, 55 54 C48 49, 41 43, 34 34 Z",
    "M32 34 C36 45, 37 54, 32 61 C27 54, 28 45, 32 34 Z",
    "M30 34 C23 43, 16 49, 9 54 C14 46, 21 39, 30 34 Z",
    "M30 32 C19 36, 10 37, 3 32 C10 27, 19 28, 30 32 Z",
    "M30 30 C21 25, 14 18, 9 10 C16 15, 23 21, 30 30 Z",
];

function getThemePalmColors() {
    const fallback = THEME_PALM_COLORS[state.theme] || THEME_PALM_COLORS.twitter;
    if (typeof window === "undefined" || !document.documentElement) return fallback;
    const cs = getComputedStyle(document.documentElement);
    const harv = cs.getPropertyValue("--map-palm-harvested").trim() || fallback.harvested;
    const unharv = cs.getPropertyValue("--map-palm-unharvested").trim() || fallback.unharvested;
    return { harvested: harv, unharvested: unharv };
}

function buildAerialPalmSvgString(fillColor) {
    const pathsXml = AERIAL_PALM_FROND_PATHS.map((d) => `<path d="${d}" />`).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
        <g fill="${fillColor}" stroke="#0f1419" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">
            ${pathsXml}
            <circle cx="32" cy="32" r="5.2" fill="${fillColor}" stroke="#0f1419" stroke-width="1.8" />
        </g>
    </svg>`;
}

function createAerialPalmSpriteCanvas(fillColor) {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (!ctx) return canvas;

    ctx.fillStyle = fillColor;
    ctx.strokeStyle = "#0f1419";
    ctx.lineWidth = 2.2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    if (typeof Path2D === "function") {
        for (const d of AERIAL_PALM_FROND_PATHS) {
            const p = new Path2D(d);
            ctx.fill(p);
            ctx.stroke(p);
        }
    } else {
        for (let i = 0; i < 8; i++) {
            const angle = (i * Math.PI) / 4;
            ctx.save();
            ctx.translate(32, 32);
            ctx.rotate(angle);
            ctx.beginPath();
            ctx.moveTo(0, -2);
            ctx.quadraticCurveTo(-5, -15, 0, -29);
            ctx.quadraticCurveTo(5, -15, 0, -2);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.restore();
        }
    }

    ctx.beginPath();
    ctx.arc(32, 32, 5.2, 0, Math.PI * 2);
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.lineWidth = 1.8;
    ctx.stroke();

    return canvas;
}

function rebuildGisPalmSpritesAndRedraw() {
    const { harvested, unharvested } = getThemePalmColors();
    state.gisMap.sprites.harvestedColor = harvested;
    state.gisMap.sprites.unharvestedColor = unharvested;
    state.gisMap.sprites.harvested = createAerialPalmSpriteCanvas(harvested);
    state.gisMap.sprites.unharvested = createAerialPalmSpriteCanvas(unharvested);
    state.gisMap.sprites.svgHarvestedUrl =
        "data:image/svg+xml;charset=utf-8," + encodeURIComponent(buildAerialPalmSvgString(harvested));
    state.gisMap.sprites.svgUnharvestedUrl =
        "data:image/svg+xml;charset=utf-8," + encodeURIComponent(buildAerialPalmSvgString(unharvested));

    if (state.gisMap.map && state.gisMap.basemapMode === "clean") {
        syncGisCleanBasemapLayer();
    }
    if (state.gisMap.boundaryLayer) {
        renderGisBoundariesAndLabels();
    }
    if (state.gisMap.palmCanvasLayer) {
        state.gisMap.palmCanvasLayer.redraw();
    }
}

function getPalmIconPixelSize(zoom) {
    if (zoom <= 13) return 5.5;
    if (zoom === 14) return 7;
    if (zoom === 15) return 9.5;
    if (zoom === 16) return 14;
    if (zoom === 17) return 20;
    if (zoom === 18) return 26;
    return 32;
}

function createPalmCanopyCanvasLayer() {
    if (!window.L) return null;
    const LayerClass = window.L.Layer.extend({
        onAdd(map) {
            this._map = map;
            const pane = map.getPanes().overlayPane;
            const canvas = window.L.DomUtil.create("canvas", "leaflet-zoom-animated palm-canopy-canvas", pane);
            canvas.style.position = "absolute";
            canvas.style.top = "0";
            canvas.style.left = "0";
            canvas.style.pointerEvents = "none";
            canvas.style.zIndex = "450";
            this._canvas = canvas;
            this._ctx = canvas.getContext("2d");

            map.on("moveend zoomend resize viewreset", this.redraw, this);
            map.on("zoomanim", this._onZoomAnim, this);
            map.on("click", this._onMapClick, this);
            map.on("mousemove", this._onMapMouseMove, this);
            this.redraw();
        },
        onRemove(map) {
            map.off("moveend zoomend resize viewreset", this.redraw, this);
            map.off("zoomanim", this._onZoomAnim, this);
            map.off("click", this._onMapClick, this);
            map.off("mousemove", this._onMapMouseMove, this);
            if (this._canvas && this._canvas.parentNode) {
                this._canvas.parentNode.removeChild(this._canvas);
            }
            this._canvas = null;
            this._ctx = null;
            this._map = null;
        },
        _onZoomAnim(e) {
            if (!this._map || !this._canvas) return;
            const scale = this._map.getZoomScale(e.zoom);
            const offset = this._map._latLngBoundsToNewLayerBounds(this._map.getBounds(), e.zoom, e.center).min;
            window.L.DomUtil.setTransform(this._canvas, offset, scale);
        },
        redraw() {
            const map = this._map;
            const canvas = this._canvas;
            const ctx = this._ctx;
            if (!map || !canvas || !ctx) return;

            const size = map.getSize();
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            const topLeft = map.containerPointToLayerPoint([0, 0]);
            window.L.DomUtil.setPosition(canvas, topLeft);

            canvas.width = Math.round(size.x * dpr);
            canvas.height = Math.round(size.y * dpr);
            canvas.style.width = `${size.x}px`;
            canvas.style.height = `${size.y}px`;

            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, size.x, size.y);

            if (!state.gisMap.sprites.harvested) {
                rebuildGisPalmSpritesAndRedraw();
            }
            const sprHarv = state.gisMap.sprites.harvested;
            const sprUnharv = state.gisMap.sprites.unharvested;
            if (!sprHarv || !sprUnharv) return;

            const zoom = map.getZoom();
            const iconSize = getPalmIconPixelSize(zoom);
            const half = iconSize / 2;

            const bounds = map.getBounds().pad(0.08);
            const sLat = bounds.getSouth();
            const nLat = bounds.getNorth();
            const wLng = bounds.getWest();
            const eLng = bounds.getEast();

            const trees = state.gisMap.visibleTrees || [];
            for (let i = 0; i < trees.length; i++) {
                const t = trees[i];
                if (t.lat < sLat || t.lat > nLat || t.lng < wLng || t.lng > eLng) continue;
                const pt = map.latLngToContainerPoint([t.lat, t.lng]);
                ctx.drawImage(t.harvested ? sprHarv : sprUnharv, pt.x - half, pt.y - half, iconSize, iconSize);
            }
        },
        _findTreeAtPoint(containerPoint) {
            const map = this._map;
            if (!map || !containerPoint) return null;
            const zoom = map.getZoom();
            const iconSize = getPalmIconPixelSize(zoom);
            const hitRadius = Math.max(11, iconSize * 0.72);
            const maxDistSq = hitRadius * hitRadius;

            const bounds = map.getBounds().pad(0.02);
            const sLat = bounds.getSouth();
            const nLat = bounds.getNorth();
            const wLng = bounds.getWest();
            const eLng = bounds.getEast();

            let bestTree = null;
            let bestDistSq = maxDistSq;
            const trees = state.gisMap.visibleTrees || [];
            for (let i = 0; i < trees.length; i++) {
                const t = trees[i];
                if (t.lat < sLat || t.lat > nLat || t.lng < wLng || t.lng > eLng) continue;
                const pt = map.latLngToContainerPoint([t.lat, t.lng]);
                const dx = pt.x - containerPoint.x;
                const dy = pt.y - containerPoint.y;
                const dSq = dx * dx + dy * dy;
                if (dSq <= bestDistSq) {
                    bestDistSq = dSq;
                    bestTree = t;
                }
            }
            return bestTree;
        },
        _onMapMouseMove(e) {
            if (!this._map) return;
            const container = this._map.getContainer();
            if (!container) return;
            const hit = this._findTreeAtPoint(e.containerPoint);
            container.style.cursor = hit ? "pointer" : "";
        },
        _onMapClick(e) {
            if (!this._map) return;
            const tree = this._findTreeAtPoint(e.containerPoint);
            if (!tree) return;
            const { harvested, unharvested } = getThemePalmColors();
            const statusColor = tree.harvested ? harvested : unharvested;
            const statusLabel = tree.harvested ? "Harvested" : "Not Harvested";

            const html = `
                <div class="min-w-[195px] space-y-2 text-xs">
                    <div class="flex items-center justify-between gap-2 border-b border-[#eff3f4] pb-1.5">
                        <span class="font-mono-code font-extrabold text-sm">${esc(tree.tree_code)} (Palm #${tree.tree_no})</span>
                        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold text-white" style="background:${statusColor};">
                            ${statusLabel}
                        </span>
                    </div>
                    <div class="text-[11px] opacity-80 font-semibold">
                        ${esc(tree.block_name)} &bull; ${esc(tree.field_name)}<br/>
                        <span class="text-[10px] opacity-75">${esc(tree.division_name)}</span>
                        ${tree.health_status && tree.health_status !== "Healthy" ? `<br/><span class="text-[10px] font-bold text-amber-600">Health: ${esc(tree.health_status)}</span>` : ""}
                    </div>
                    <div class="grid grid-cols-2 gap-1.5 pt-1 text-center">
                        <div class="p-1.5 rounded-lg bg-[#f7f9f9] border border-[#eff3f4]">
                            <div class="text-[9px] font-bold uppercase opacity-70">Bunches Cut</div>
                            <div class="font-mono-code font-extrabold text-xs mt-0.5">${tree.bunches}</div>
                        </div>
                        <div class="p-1.5 rounded-lg bg-[#f7f9f9] border border-[#eff3f4]">
                            <div class="text-[9px] font-bold uppercase opacity-70">Fronds Cut</div>
                            <div class="font-mono-code font-extrabold text-xs mt-0.5">${tree.fronds}</div>
                        </div>
                    </div>
                    <button type="button" onclick="window.__openGisTreeHarvest(${tree.block_id}, ${tree.id})" class="x-btn-primary w-full !py-1.5 !text-[11px] mt-1">
                        Log / Edit Harvest
                    </button>
                </div>
            `;
            window.L.popup({ closeButton: true, offset: [0, -4] })
                .setLatLng([tree.lat, tree.lng])
                .setContent(html)
                .openOn(this._map);
        },
    });
    return new LayerClass();
}

window.__openGisTreeHarvest = async (blockId, treeId) => {
    await selectHarvestBlockCascade(blockId);
    openHarvestModal(treeId);
};

// ----------------------------------------------------------------------------
// Turf.js Curved Outer Boundary Algorithm (10m Margin from Outermost Trees)
// ----------------------------------------------------------------------------
function extractOutermostPerimeterTrees(treesGroup, bins = 24) {
    if (!treesGroup || treesGroup.length <= 70) return treesGroup || [];
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;
    for (let i = 0; i < treesGroup.length; i++) {
        const t = treesGroup[i];
        if (t.lat < minLat) minLat = t.lat;
        if (t.lat > maxLat) maxLat = t.lat;
        if (t.lng < minLng) minLng = t.lng;
        if (t.lng > maxLng) maxLng = t.lng;
    }
    const latSpan = Math.max(0.00001, maxLat - minLat);
    const lngSpan = Math.max(0.00001, maxLng - minLng);

    const rowMin = new Array(bins).fill(null);
    const rowMax = new Array(bins).fill(null);
    const colMin = new Array(bins).fill(null);
    const colMax = new Array(bins).fill(null);

    for (let i = 0; i < treesGroup.length; i++) {
        const t = treesGroup[i];
        const rBin = Math.min(bins - 1, Math.max(0, Math.floor(((t.lat - minLat) / latSpan) * bins)));
        const cBin = Math.min(bins - 1, Math.max(0, Math.floor(((t.lng - minLng) / lngSpan) * bins)));

        if (!rowMin[rBin] || t.lng < rowMin[rBin].lng) rowMin[rBin] = t;
        if (!rowMax[rBin] || t.lng > rowMax[rBin].lng) rowMax[rBin] = t;
        if (!colMin[cBin] || t.lat < colMin[cBin].lat) colMin[cBin] = t;
        if (!colMax[cBin] || t.lat > colMax[cBin].lat) colMax[cBin] = t;
    }

    const picked = new Map();
    for (let b = 0; b < bins; b++) {
        if (rowMin[b]) picked.set(rowMin[b].id, rowMin[b]);
        if (rowMax[b]) picked.set(rowMax[b].id, rowMax[b]);
        if (colMin[b]) picked.set(colMin[b].id, colMin[b]);
        if (colMax[b]) picked.set(colMax[b].id, colMax[b]);
    }
    return Array.from(picked.values());
}

function buildCurved10mBoundaryFeature(treesGroup, meta) {
    if (!window.turf || !treesGroup || !treesGroup.length) return null;
    const turf = window.turf;
    const perimeterTrees = extractOutermostPerimeterTrees(treesGroup, meta.level === "block" ? 24 : 32);
    const pts = perimeterTrees.map((t) => turf.point([Number(t.lng), Number(t.lat)]));
    const fc = turf.featureCollection(pts);

    let hull = null;
    if (pts.length === 1) {
        hull = pts[0];
    } else if (pts.length === 2) {
        hull = turf.lineString(pts.map((p) => p.geometry.coordinates));
    } else {
        try {
            hull = turf.concave(fc, { maxEdge: 0.05, units: "kilometers" });
        } catch (_) {
            hull = null;
        }
        if (!hull || hull.geometry?.type !== "Polygon") {
            const bridgeEdge = meta.level === "block" ? 0.09 : meta.level === "field" ? 0.16 : 0.35;
            try {
                hull = turf.concave(fc, { maxEdge: bridgeEdge, units: "kilometers" });
            } catch (_) {
                hull = null;
            }
        }
        if (!hull || hull.geometry?.type !== "Polygon") {
            try {
                hull = turf.convex(fc);
            } catch (_) {
                hull = null;
            }
        }
    }

    if (!hull) return null;

    let buffered = null;
    try {
        buffered = turf.buffer(hull, 10, { units: "meters", steps: 16 });
    } catch (_) {
        buffered = hull;
    }
    if (!buffered) return null;

    if (typeof turf.polygonSmooth === "function" && buffered.geometry?.type === "Polygon") {
        try {
            const smoothed = turf.polygonSmooth(buffered, { iterations: 2 });
            if (smoothed?.features?.[0]) {
                buffered = smoothed.features[0];
            }
        } catch (_) {}
    }

    let centerCoords = null;
    try {
        const com = turf.centerOfMass(buffered);
        centerCoords = com?.geometry?.coordinates || null;
    } catch (_) {}

    buffered.properties = {
        ...meta,
        center_lng: centerCoords ? centerCoords[0] : null,
        center_lat: centerCoords ? centerCoords[1] : null,
    };
    return buffered;
}

function ensureGisHierarchyBoundaries(allTrees) {
    if (!window.turf) return;
    if (!allTrees || !allTrees.length) {
        state.gisMap.boundaries = { estates: [], divisions: [], fields: [], blocks: [] };
        state.gisMap.boundariesCacheKey = "";
        return;
    }
    const sig = `${allTrees.length}:${allTrees[0]?.lat}:${allTrees[allTrees.length - 1]?.lng}`;
    if (state.gisMap.boundariesCacheKey === sig && state.gisMap.boundaries.blocks.length) {
        return;
    }

    const byEstate = new Map();
    const byDivision = new Map();
    const byField = new Map();
    const byBlock = new Map();

    for (let i = 0; i < allTrees.length; i++) {
        const t = allTrees[i];
        if (!byBlock.has(t.block_id)) {
            byBlock.set(t.block_id, {
                id: t.block_id,
                name: `${t.field_name} • ${t.block_name}`,
                short_name: t.block_name,
                field_id: t.field_id,
                division_id: t.division_id,
                estate_id: t.estate_id,
                trees: [],
            });
        }
        byBlock.get(t.block_id).trees.push(t);
    }

    const blockFeatures = [];
    for (const blk of byBlock.values()) {
        const perim = extractOutermostPerimeterTrees(blk.trees, 24);
        const feat = buildCurved10mBoundaryFeature(perim, {
            level: "block",
            id: blk.id,
            name: blk.name,
            short_name: blk.short_name,
            block_id: blk.id,
            field_id: blk.field_id,
            division_id: blk.division_id,
            estate_id: blk.estate_id,
        });
        if (feat) blockFeatures.push(feat);

        const sampleTree = blk.trees[0];
        if (!byField.has(blk.field_id)) {
            byField.set(blk.field_id, {
                id: blk.field_id,
                name: sampleTree.field_name,
                division_id: blk.division_id,
                estate_id: blk.estate_id,
                trees: [],
            });
        }
        byField.get(blk.field_id).trees.push(...perim);

        if (!byDivision.has(blk.division_id)) {
            byDivision.set(blk.division_id, {
                id: blk.division_id,
                name: sampleTree.division_name,
                estate_id: blk.estate_id,
                trees: [],
            });
        }
        byDivision.get(blk.division_id).trees.push(...perim);

        if (!byEstate.has(blk.estate_id)) {
            byEstate.set(blk.estate_id, {
                id: blk.estate_id,
                name: sampleTree.estate_name || getActiveEstateName(),
                trees: [],
            });
        }
        byEstate.get(blk.estate_id).trees.push(...perim);
    }

    const fieldFeatures = [];
    for (const fld of byField.values()) {
        const feat = buildCurved10mBoundaryFeature(fld.trees, {
            level: "field",
            id: fld.id,
            name: fld.name,
            field_id: fld.id,
            division_id: fld.division_id,
            estate_id: fld.estate_id,
        });
        if (feat) fieldFeatures.push(feat);
    }

    const divisionFeatures = [];
    for (const div of byDivision.values()) {
        const feat = buildCurved10mBoundaryFeature(div.trees, {
            level: "division",
            id: div.id,
            name: div.name,
            division_id: div.id,
            estate_id: div.estate_id,
        });
        if (feat) divisionFeatures.push(feat);
    }

    const estateFeatures = [];
    for (const est of byEstate.values()) {
        const feat = buildCurved10mBoundaryFeature(est.trees, {
            level: "estate",
            id: est.id,
            name: est.name,
            estate_id: est.id,
        });
        if (feat) estateFeatures.push(feat);
    }

    state.gisMap.boundaries = {
        estates: estateFeatures,
        divisions: divisionFeatures,
        fields: fieldFeatures,
        blocks: blockFeatures,
    };
    state.gisMap.boundariesCacheKey = sig;
}

function getBoundaryStyleForLevel(level) {
    const isLightClean =
        state.gisMap.basemapMode === "clean" && (state.theme === "twitter" || state.theme === "dracula-light");
    const strokeMain = isLightClean ? "#0f1419" : "#ffffff";
    const strokeDiv = isLightClean ? "#1e293b" : "#f8fafc";
    const strokeFld = isLightClean ? "#334155" : "#e2e8f0";
    const strokeBlk = isLightClean ? "rgba(15, 20, 25, 0.55)" : "rgba(255, 255, 255, 0.68)";

    if (level === "estate") {
        return { color: strokeMain, weight: 3, opacity: 0.96, fillColor: strokeMain, fillOpacity: 0.01, interactive: false };
    }
    if (level === "division") {
        return { color: strokeDiv, weight: 2.2, dashArray: "12, 6", opacity: 0.9, fillColor: strokeDiv, fillOpacity: 0.02, interactive: false };
    }
    if (level === "field") {
        return { color: strokeFld, weight: 1.6, dashArray: "5, 5", opacity: 0.84, fillColor: strokeFld, fillOpacity: 0.02, interactive: false };
    }
    return { color: strokeBlk, weight: 1.2, opacity: 0.75, fillColor: strokeMain, fillOpacity: 0.03, interactive: false };
}

function getVisibleBoundaryFeatures() {
    const { estates, divisions, fields, blocks } = state.gisMap.boundaries;
    const divId = Number($("mapview-division")?.value || 0);
    const fldId = Number($("mapview-field")?.value || 0);
    const blkId = Number($("mapview-block")?.value || 0);
    const isolate = state.gisMap.isolate && (divId || fldId || blkId);

    if (!isolate) return [...estates, ...divisions, ...fields, ...blocks];
    if (blkId) return blocks.filter((f) => f.properties.block_id === blkId);
    if (fldId) {
        return [
            ...fields.filter((f) => f.properties.field_id === fldId),
            ...blocks.filter((f) => f.properties.field_id === fldId),
        ];
    }
    if (divId) {
        return [
            ...divisions.filter((f) => f.properties.division_id === divId),
            ...fields.filter((f) => f.properties.division_id === divId),
            ...blocks.filter((f) => f.properties.division_id === divId),
        ];
    }
    return [...estates, ...divisions, ...fields, ...blocks];
}

function getZoomFilteredLabelFeatures() {
    if (!state.gisMap.map) return [];
    const zoom = state.gisMap.map.getZoom();
    const { estates, divisions, fields, blocks } = state.gisMap.boundaries;
    const divId = Number($("mapview-division")?.value || 0);
    const fldId = Number($("mapview-field")?.value || 0);
    const blkId = Number($("mapview-block")?.value || 0);
    const isolate = state.gisMap.isolate && (divId || fldId || blkId);

    if (isolate) {
        if (blkId) return blocks.filter((f) => f.properties.block_id === blkId);
        if (fldId) {
            return zoom >= 16
                ? blocks.filter((f) => f.properties.field_id === fldId)
                : fields.filter((f) => f.properties.field_id === fldId);
        }
        if (divId) {
            if (zoom >= 17) return blocks.filter((f) => f.properties.division_id === divId);
            if (zoom >= 15) return fields.filter((f) => f.properties.division_id === divId);
            return divisions.filter((f) => f.properties.division_id === divId);
        }
    }

    if (zoom <= 13) return estates;
    if (zoom <= 15) return divisions;
    if (zoom === 16) return fields;
    return blocks;
}

function renderGisBoundariesAndLabels() {
    const map = state.gisMap.map;
    if (!map || !window.L) return;

    if (state.gisMap.boundaryLayer) state.gisMap.boundaryLayer.clearLayers();
    else state.gisMap.boundaryLayer = window.L.layerGroup().addTo(map);

    if (state.gisMap.labelLayer) state.gisMap.labelLayer.clearLayers();
    else state.gisMap.labelLayer = window.L.layerGroup().addTo(map);

    if (state.gisMap.showBoundaries) {
        for (const feat of getVisibleBoundaryFeatures()) {
            const style = getBoundaryStyleForLevel(feat.properties?.level);
            window.L.geoJSON(feat, { style }).addTo(state.gisMap.boundaryLayer);
        }
    }

    if (state.gisMap.showLabels) {
        for (const feat of getZoomFilteredLabelFeatures()) {
            const p = feat.properties || {};
            if (p.center_lat === null || p.center_lng === null) continue;
            const lvlClass = p.level === "estate" ? "lbl-estate" : p.level === "division" ? "lbl-division" : "";
            const icon = window.L.divIcon({
                className: "gis-boundary-label-icon",
                html: `<div class="gis-boundary-label ${lvlClass}">${esc(p.name)}</div>`,
                iconSize: [0, 0],
            });
            window.L.marker([p.center_lat, p.center_lng], { icon, interactive: false }).addTo(state.gisMap.labelLayer);
        }
    }
}

function ensureLeafletGisMap() {
    if (state.gisMap.map || !window.L) return state.gisMap.map;
    const container = $("gis-map-canvas");
    if (!container) return null;

    const map = window.L.map(container, {
        center: [6.1448, 80.372],
        zoom: 15,
        minZoom: 3,
        maxZoom: 20,
        zoomControl: true,
        preferCanvas: true,
    });

    state.gisMap.satelliteLayer = window.L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        {
            maxZoom: 20,
            maxNativeZoom: 18,
            crossOrigin: true,
            attribution: "Tiles &copy; Esri",
        }
    );

    state.gisMap.satelliteLayer.addTo(map);
    state.gisMap.boundaryLayer = window.L.layerGroup().addTo(map);
    state.gisMap.labelLayer = window.L.layerGroup().addTo(map);

    rebuildGisPalmSpritesAndRedraw();
    state.gisMap.palmCanvasLayer = createPalmCanopyCanvasLayer();
    if (state.gisMap.palmCanvasLayer) {
        state.gisMap.palmCanvasLayer.addTo(map);
    }

    map.on("zoomend", () => {
        renderGisBoundariesAndLabels();
    });

    state.gisMap.map = map;
    return map;
}

function syncGisCleanBasemapLayer() {
    const map = state.gisMap.map;
    if (!map || !window.L) return;
    if (state.gisMap.cleanLayer) map.removeLayer(state.gisMap.cleanLayer);
    const isDarkTheme = state.theme === "dracula-dark" || state.theme === "nord";
    const tileUrl = isDarkTheme
        ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
    state.gisMap.cleanLayer = window.L.tileLayer(tileUrl, {
        maxZoom: 20,
        crossOrigin: true,
        attribution: "&copy; OpenStreetMap &copy; CARTO",
    });
    if (state.gisMap.basemapMode === "clean") {
        state.gisMap.cleanLayer.addTo(map);
    }
}

function initGisMapFilters() {
    const divEl = $("mapview-division");
    const fldEl = $("mapview-field");
    const blkEl = $("mapview-block");
    if (!divEl || !fldEl || !blkEl) return;

    const { divisions, fields, blocks } = state.hierarchy;
    const activeEstate = getActiveEstate();
    const scopedDivs = activeEstate ? divisions.filter((d) => d.estate_id === activeEstate.id) : divisions;
    const divList = scopedDivs.length ? scopedDivs : divisions;
    const divIds = new Set(divList.map((d) => d.id));
    const scopedFields = fields.filter((f) => divIds.has(f.division_id));

    divEl.innerHTML =
        `<option value="">All Divisions (${esc(getActiveEstateName())})</option>` +
        divList.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("");

    const popMapFields = () => {
        const did = Number(divEl.value);
        const list = did ? scopedFields.filter((f) => f.division_id === did) : scopedFields;
        fldEl.innerHTML =
            `<option value="">All Fields</option>` +
            list.map((f) => `<option value="${f.id}">${esc(f.name)} (${Number(f.area_ha).toFixed(1)} Ha)</option>`).join("");
        popMapBlocks();
    };

    const popMapBlocks = () => {
        const did = Number(divEl.value);
        const fid = Number(fldEl.value);
        let list = blocks;
        if (fid) {
            list = blocks.filter((b) => b.field_id === fid);
        } else if (did) {
            const fIds = new Set(scopedFields.filter((f) => f.division_id === did).map((f) => f.id));
            list = blocks.filter((b) => fIds.has(b.field_id));
        } else {
            const fIds = new Set(scopedFields.map((f) => f.id));
            list = blocks.filter((b) => fIds.has(b.field_id));
        }
        blkEl.innerHTML =
            `<option value="">All Blocks</option>` +
            list
                .map((b) => {
                    const f = scopedFields.find((x) => x.id === b.field_id);
                    return `<option value="${b.id}">${esc(f ? `${f.name} • ${b.name}` : b.name)}</option>`;
                })
                .join("");
    };

    divEl.onchange = () => {
        popMapFields();
        onGisAreaSelectionChanged(true);
    };
    fldEl.onchange = () => {
        popMapBlocks();
        onGisAreaSelectionChanged(true);
    };
    blkEl.onchange = () => {
        onGisAreaSelectionChanged(true);
    };

    populateDynamicYearSelect("mapview-season", "season");
    populateDynamicYearSelect("mapview-year", "year");

    if (!state.gisMap.initializedFilters) {
        const today = todayStr();
        const sMonth = String(state.settings.season_start_month || 4).padStart(2, "0");
        if ($("mapview-time-mode")) $("mapview-time-mode").value = "month";
        if ($("mapview-month")) $("mapview-month").value = today.slice(0, 7);
        if ($("mapview-from")) $("mapview-from").value = `${today.slice(0, 4)}-${sMonth}-01`;
        if ($("mapview-to")) $("mapview-to").value = today;
        if ($("mapview-round")) $("mapview-round").value = "";
        state.gisMap.initializedFilters = true;
    }

    popMapFields();
}

function getGisTimeQuery() {
    const mode = $("mapview-time-mode")?.value || "month";
    const sMonth = String(state.settings.season_start_month || 4).padStart(2, "0");
    const roundVal = $("mapview-round")?.value || "";
    const today = todayStr();

    let from = `${today.slice(0, 7)}-01`;
    let to = `${today.slice(0, 7)}-31`;
    let label = formatMonthYearLabel(today.slice(0, 7));

    if (mode === "season") {
        const yr = Number($("mapview-season")?.value) || new Date().getFullYear();
        from = `${yr}-${sMonth}-01`;
        to = `${yr + 1}-03-31`;
        label = `Season ${yr}/${String(yr + 1).slice(2)}`;
    } else if (mode === "year") {
        const yr = Number($("mapview-year")?.value) || new Date().getFullYear();
        from = `${yr}-01-01`;
        to = `${yr}-12-31`;
        label = `Year ${yr}`;
    } else if (mode === "month") {
        const ym = $("mapview-month")?.value || today.slice(0, 7);
        from = `${ym}-01`;
        to = `${ym}-31`;
        label = formatMonthYearLabel(ym);
    } else if (mode === "custom") {
        from = $("mapview-from")?.value || `${today.slice(0, 4)}-${sMonth}-01`;
        to = $("mapview-to")?.value || today;
        label = `${formatShortDateLabel(from)} – ${formatShortDateLabel(to)}`;
    }

    const roundLabel = roundVal ? `R${roundVal}` : "Entire Month";
    return { from, to, round_no: roundVal, periodLabel: `${label} (${roundLabel})` };
}

function getGisActiveScopeMeta() {
    const divId = Number($("mapview-division")?.value || 0);
    const fldId = Number($("mapview-field")?.value || 0);
    const blkId = Number($("mapview-block")?.value || 0);
    const { divisions, fields, blocks } = state.hierarchy;
    const activeEstate = getActiveEstate();
    const estDivs = activeEstate ? divisions.filter((d) => d.estate_id === activeEstate.id) : divisions;

    const parts = [];
    if (divId) {
        const d = divisions.find((x) => x.id === divId);
        if (d) parts.push(d.name);
    }
    if (fldId) {
        const f = fields.find((x) => x.id === fldId);
        if (f) parts.push(f.name);
    }
    if (blkId) {
        const b = blocks.find((x) => x.id === blkId);
        if (b) parts.push(b.name);
    }

    const hasAreaFilter = Boolean(divId || fldId || blkId);
    const divLabel = estDivs.length === 1 ? "1 Division" : `All ${estDivs.length} Divisions`;
    const scopeName = parts.length ? parts.join(" • ") : `Full Estate (${divLabel})`;
    return { divId, fldId, blkId, hasAreaFilter, scopeName };
}

function applyGisTreeIsolationAndStats() {
    const all = state.gisMap.allTrees || [];
    const { divId, fldId, blkId, hasAreaFilter, scopeName } = getGisActiveScopeMeta();
    const isolate = state.gisMap.isolate && hasAreaFilter;

    let visible = all;
    if (isolate) {
        visible = all.filter((t) => {
            if (blkId && t.block_id !== blkId) return false;
            if (fldId && t.field_id !== fldId) return false;
            if (divId && t.division_id !== divId) return false;
            return true;
        });
    }
    state.gisMap.visibleTrees = visible;

    let harvCount = 0;
    for (let i = 0; i < visible.length; i++) {
        if (visible[i].harvested) harvCount++;
    }
    const unharvCount = visible.length - harvCount;

    if ($("gis-leg-harvested")) $("gis-leg-harvested").textContent = harvCount.toLocaleString();
    if ($("gis-leg-unharvested")) $("gis-leg-unharvested").textContent = unharvCount.toLocaleString();
    if ($("gis-leg-scope")) {
        const unmappedTxt = state.gisMap.unmappedCount > 0 ? ` • ${state.gisMap.unmappedCount.toLocaleString()} unmapped` : "";
        $("gis-leg-scope").textContent = `${isolate ? "Isolated" : "Full Map"} • 10m Buffer${unmappedTxt}`;
    }

    const { periodLabel } = getGisTimeQuery();
    if ($("mapview-summary-badge")) {
        $("mapview-summary-badge").textContent = `${scopeName}${isolate ? " [Isolated]" : ""} • ${harvCount.toLocaleString()} / ${visible.length.toLocaleString()} Harvested • ${periodLabel}`;
    }

    const isoBtn = $("btn-mapview-isolate");
    const isoLbl = $("lbl-mapview-isolate");
    if (isoBtn && isoLbl) {
        isoBtn.classList.toggle("active", Boolean(state.gisMap.isolate));
        isoLbl.textContent = state.gisMap.isolate ? "Isolate: On" : "Isolate: Off";
    }

    const emptyNotice = $("gis-empty-notice");
    if (emptyNotice) {
        emptyNotice.classList.toggle("hidden", visible.length > 0);
    }

    renderGisBoundariesAndLabels();
    if (state.gisMap.palmCanvasLayer) {
        state.gisMap.palmCanvasLayer.redraw();
    }
}

function fitGisMapToActiveSelection(animate = true) {
    const map = state.gisMap.map;
    if (!map || !window.L) return;

    const { divId, fldId, blkId } = getGisActiveScopeMeta();
    const all = state.gisMap.allTrees || [];
    let targetTrees = all;
    if (blkId) targetTrees = all.filter((t) => t.block_id === blkId);
    else if (fldId) targetTrees = all.filter((t) => t.field_id === fldId);
    else if (divId) targetTrees = all.filter((t) => t.division_id === divId);
    if (!targetTrees.length) targetTrees = all;
    if (!targetTrees.length) return;

    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;
    for (let i = 0; i < targetTrees.length; i++) {
        const t = targetTrees[i];
        if (t.lat < minLat) minLat = t.lat;
        if (t.lat > maxLat) maxLat = t.lat;
        if (t.lng < minLng) minLng = t.lng;
        if (t.lng > maxLng) maxLng = t.lng;
    }
    const bounds = window.L.latLngBounds([minLat - 0.00015, minLng - 0.00015], [maxLat + 0.00015, maxLng + 0.00015]);
    map.fitBounds(bounds, { padding: [26, 26], maxZoom: blkId ? 18 : fldId ? 17 : divId ? 16 : 15, animate });
}

function onGisAreaSelectionChanged(zoomToArea = true) {
    const { hasAreaFilter } = getGisActiveScopeMeta();
    if (hasAreaFilter && !state.gisMap.isolate) {
        state.gisMap.isolate = true;
    } else if (!hasAreaFilter) {
        state.gisMap.isolate = false;
    }
    applyGisTreeIsolationAndStats();
    if (zoomToArea) fitGisMapToActiveSelection(true);
}

async function refreshGisMapData(fitView = false) {
    const { from, to, round_no } = getGisTimeQuery();
    const qs = new URLSearchParams({ from, to });
    const activeEstate = getActiveEstate();
    if (activeEstate?.id) qs.set("estate_id", String(activeEstate.id));
    if (round_no) qs.set("round_no", round_no);

    try {
        const data = await api(`/api/map/trees?${qs.toString()}`);
        state.gisMap.allTrees = data.trees || [];
        state.gisMap.unmappedCount = Number(data.unmapped_trees || 0);
        ensureGisHierarchyBoundaries(state.gisMap.allTrees);
        applyGisTreeIsolationAndStats();
        if (fitView) fitGisMapToActiveSelection(false);
    } catch (err) {
        toast(err.message || "Map data unavailable offline", "warn");
    }
}

async function loadGisMapPage() {
    ensureLeafletGisMap();
    initGisMapFilters();
    setTimeout(() => {
        if (state.gisMap.map) state.gisMap.map.invalidateSize();
    }, 60);

    const isFirstLoad = !state.gisMap.allTrees.length;
    await refreshGisMapData(isFirstLoad);
}

// ----------------------------------------------------------------------------
// Dynamic-Estate PNG Snapshot & Google Earth KML Export
// ----------------------------------------------------------------------------
async function downloadGisMapPng() {
    const map = state.gisMap.map;
    const container = $("gis-map-canvas");
    if (!map || !container) return;

    const rect = container.getBoundingClientRect();
    const w = Math.max(600, Math.round(rect.width));
    const h = Math.max(420, Math.round(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const outCanvas = document.createElement("canvas");
    outCanvas.width = Math.round(w * dpr);
    outCanvas.height = Math.round(h * dpr);
    const ctx = outCanvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const isLightClean =
        state.gisMap.basemapMode === "clean" && (state.theme === "twitter" || state.theme === "dracula-light");
    ctx.fillStyle = isLightClean ? "#f8fafc" : "#0e1b14";
    ctx.fillRect(0, 0, w, h);

    const tileImgs = container.querySelectorAll(".leaflet-tile-pane img.leaflet-tile");
    tileImgs.forEach((img) => {
        if (!img.complete || !img.naturalWidth) return;
        const r = img.getBoundingClientRect();
        try {
            ctx.drawImage(img, r.left - rect.left, r.top - rect.top, r.width, r.height);
        } catch (_) {}
    });

    if (state.gisMap.showBoundaries) {
        for (const feat of getVisibleBoundaryFeatures()) {
            const st = getBoundaryStyleForLevel(feat.properties?.level);
            const geom = feat.geometry;
            if (!geom) continue;
            const rings =
                geom.type === "Polygon"
                    ? geom.coordinates
                    : geom.type === "MultiPolygon"
                    ? geom.coordinates.flat()
                    : [];

            ctx.save();
            ctx.strokeStyle = st.color;
            ctx.lineWidth = st.weight;
            ctx.globalAlpha = st.opacity ?? 0.9;
            ctx.setLineDash(st.dashArray ? String(st.dashArray).split(",").map((n) => Number(n.trim())) : []);

            for (const ring of rings) {
                if (!ring || !ring.length) continue;
                ctx.beginPath();
                ring.forEach(([lng, lat], idx) => {
                    const pt = map.latLngToContainerPoint([lat, lng]);
                    if (idx === 0) ctx.moveTo(pt.x, pt.y);
                    else ctx.lineTo(pt.x, pt.y);
                });
                ctx.closePath();
                ctx.stroke();
            }
            ctx.restore();
        }
    }

    const zoom = map.getZoom();
    const iconSize = getPalmIconPixelSize(zoom);
    const half = iconSize / 2;
    const sprHarv = state.gisMap.sprites.harvested;
    const sprUnharv = state.gisMap.sprites.unharvested;
    const visibleTrees = state.gisMap.visibleTrees || [];
    let harvCount = 0;

    for (let i = 0; i < visibleTrees.length; i++) {
        const t = visibleTrees[i];
        if (t.harvested) harvCount++;
        const pt = map.latLngToContainerPoint([t.lat, t.lng]);
        if (pt.x < -iconSize || pt.x > w + iconSize || pt.y < -iconSize || pt.y > h + iconSize) continue;
        ctx.drawImage(t.harvested ? sprHarv : sprUnharv, pt.x - half, pt.y - half, iconSize, iconSize);
    }

    if (state.gisMap.showLabels) {
        ctx.save();
        ctx.font = "bold 11px 'Plus Jakarta Sans', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        for (const feat of getZoomFilteredLabelFeatures()) {
            const p = feat.properties || {};
            if (p.center_lat === null || p.center_lng === null) continue;
            const pt = map.latLngToContainerPoint([p.center_lat, p.center_lng]);
            if (pt.x < 20 || pt.x > w - 20 || pt.y < 20 || pt.y > h - 20) continue;
            const txt = String(p.name || "");
            const tw = ctx.measureText(txt).width + 16;
            const th = 20;
            ctx.fillStyle = "rgba(15, 20, 25, 0.82)";
            ctx.beginPath();
            if (typeof ctx.roundRect === "function") ctx.roundRect(pt.x - tw / 2, pt.y - th / 2, tw, th, 10);
            else ctx.rect(pt.x - tw / 2, pt.y - th / 2, tw, th);
            ctx.fill();
            ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.fillStyle = "#ffffff";
            ctx.fillText(txt, pt.x, pt.y);
        }
        ctx.restore();
    }

    const estateName = getActiveEstateName();
    const { scopeName } = getGisActiveScopeMeta();
    const { periodLabel } = getGisTimeQuery();
    const { harvested: harvHex, unharvested: unharvHex } = getThemePalmColors();
    const unharvCount = visibleTrees.length - harvCount;

    const pad = 14;
    const boxW = Math.min(w - 28, 540);
    const boxH = 54;
    const boxX = pad;
    const boxY = h - boxH - pad;

    ctx.save();
    ctx.fillStyle = "rgba(15, 20, 25, 0.88)";
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") ctx.roundRect(boxX, boxY, boxW, boxH, 14);
    else ctx.rect(boxX, boxY, boxW, boxH);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 12px 'Plus Jakarta Sans', sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(`${estateName} • ${scopeName} (${periodLabel})`, boxX + 14, boxY + 10);

    const legY = boxY + 32;
    ctx.fillStyle = harvHex;
    ctx.beginPath();
    ctx.arc(boxX + 19, legY + 5, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 11px 'JetBrains Mono', monospace";
    const harvTxt = `Harvested: ${harvCount.toLocaleString()}`;
    ctx.fillText(harvTxt, boxX + 29, legY);

    const nextX = boxX + 42 + ctx.measureText(harvTxt).width;
    ctx.fillStyle = unharvHex;
    ctx.beginPath();
    ctx.arc(nextX + 5, legY + 5, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    const unharvTxt = `Not Harvested: ${unharvCount.toLocaleString()}  |  Total: ${visibleTrees.length.toLocaleString()} Palms`;
    ctx.fillText(unharvTxt, nextX + 15, legY);
    ctx.restore();

    const safeScope = scopeName.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const filename = `${getEstateSlug(estateName)}_Map_${safeScope}_${todayStr()}.png`;

    outCanvas.toBlob((blob) => {
        if (!blob) return toast("Could not generate PNG image.", "err");
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast(`${filename} downloaded`);
    }, "image/png");
}

function hexToKmlColor(hexStr, alphaHex = "ff") {
    const clean = String(hexStr || "#00BA7C").replace("#", "").trim();
    if (clean.length !== 6) return `${alphaHex}7cba00`;
    const r = clean.slice(0, 2);
    const g = clean.slice(2, 4);
    const b = clean.slice(4, 6);
    return `${alphaHex}${b}${g}${r}`.toLowerCase();
}

function unharvestedHexOrFallback(hex) {
    return /^#[0-9a-fA-F]{6}$/.test(hex || "") ? hex : "#536471";
}

function exportGisMapKml() {
    const visibleTrees = state.gisMap.visibleTrees || [];
    const visibleBoundaries = getVisibleBoundaryFeatures();
    const estateName = getActiveEstateName();
    const { scopeName } = getGisActiveScopeMeta();
    const { periodLabel } = getGisTimeQuery();
    const { harvested: harvHex, unharvested: unharvHex } = getThemePalmColors();

    const kmlHarvColor = hexToKmlColor(harvHex, "ff");
    const kmlUnharvColor = hexToKmlColor(unharvestedHexOrFallback(unharvHex), "ff");

    const boundaryPlacemarks = visibleBoundaries
        .map((feat) => {
            const p = feat.properties || {};
            const geom = feat.geometry;
            if (!geom) return "";
            const ring =
                geom.type === "Polygon"
                    ? geom.coordinates[0]
                    : geom.type === "MultiPolygon"
                    ? geom.coordinates[0]?.[0]
                    : null;
            if (!ring || !ring.length) return "";
            const coordsStr = ring.map(([lng, lat]) => `${lng},${lat},0`).join(" ");
            const styleId =
                p.level === "estate"
                    ? "boundEstate"
                    : p.level === "division"
                    ? "boundDivision"
                    : p.level === "field"
                    ? "boundField"
                    : "boundBlock";
            return `
            <Placemark>
                <name>${esc(p.name || "Boundary")}</name>
                <description>${esc((p.level || "boundary").toUpperCase())} • 10m Curved Outer Buffer</description>
                <styleUrl>#${styleId}</styleUrl>
                <Polygon>
                    <outerBoundaryIs>
                        <LinearRing>
                            <coordinates>${coordsStr}</coordinates>
                        </LinearRing>
                    </outerBoundaryIs>
                </Polygon>
            </Placemark>`;
        })
        .join("");

    const palmPlacemarks = visibleTrees
        .map((t) => {
            const styleId = t.harvested ? "palmHarvested" : "palmUnharvested";
            const statusTxt = t.harvested ? "Harvested" : "Not Harvested";
            return `
            <Placemark>
                <name>${esc(t.tree_code)}</name>
                <description>${esc(t.block_name)} • ${esc(t.field_name)} (${esc(t.division_name)}) | Status: ${statusTxt} | Bunches: ${t.bunches} | Fronds: ${t.fronds}</description>
                <styleUrl>#${styleId}</styleUrl>
                <ExtendedData>
                    <Data name="TreeCode"><value>${esc(t.tree_code)}</value></Data>
                    <Data name="Block"><value>${esc(t.block_name)}</value></Data>
                    <Data name="Field"><value>${esc(t.field_name)}</value></Data>
                    <Data name="Division"><value>${esc(t.division_name)}</value></Data>
                    <Data name="Status"><value>${statusTxt}</value></Data>
                    <Data name="BunchesCut"><value>${t.bunches}</value></Data>
                    <Data name="FrondsCut"><value>${t.fronds}</value></Data>
                </ExtendedData>
                <Point>
                    <coordinates>${t.lng},${t.lat},0</coordinates>
                </Point>
            </Placemark>`;
        })
        .join("");

    const kmlXml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
    <Document>
        <name>${esc(estateName)} — ${esc(scopeName)} (${esc(periodLabel)})</name>
        <description>Elaeis GIS Export • ${visibleTrees.length} Palms • 10m Curved Outer Boundaries</description>
        <Style id="palmHarvested">
            <IconStyle>
                <color>${kmlHarvColor}</color>
                <scale>0.85</scale>
                <Icon><href>https://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon>
            </IconStyle>
            <LabelStyle><scale>0</scale></LabelStyle>
        </Style>
        <Style id="palmUnharvested">
            <IconStyle>
                <color>${kmlUnharvColor}</color>
                <scale>0.7</scale>
                <Icon><href>https://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon>
            </IconStyle>
            <LabelStyle><scale>0</scale></LabelStyle>
        </Style>
        <Style id="boundEstate">
            <LineStyle><color>ffffffff</color><width>3</width></LineStyle>
            <PolyStyle><color>0affffff</color></PolyStyle>
        </Style>
        <Style id="boundDivision">
            <LineStyle><color>fff8fafc</color><width>2.2</width></LineStyle>
            <PolyStyle><color>0df8fafc</color></PolyStyle>
        </Style>
        <Style id="boundField">
            <LineStyle><color>ffe2e8f0</color><width>1.6</width></LineStyle>
            <PolyStyle><color>0de2e8f0</color></PolyStyle>
        </Style>
        <Style id="boundBlock">
            <LineStyle><color>b8ffffff</color><width>1.2</width></LineStyle>
            <PolyStyle><color>12ffffff</color></PolyStyle>
        </Style>
        <Folder>
            <name>Boundaries (10m Curved Outer Buffer)</name>
            ${boundaryPlacemarks}
        </Folder>
        <Folder>
            <name>Oil Palm Trees (${visibleTrees.length})</name>
            ${palmPlacemarks}
        </Folder>
    </Document>
</kml>`;

    const safeScope = scopeName.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const filename = `${getEstateSlug(estateName)}_Map_${safeScope}_${todayStr()}.kml`;
    const blob = new Blob([kmlXml], { type: "application/vnd.google-earth.kml+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(`${filename} exported`);
}
