// Points of interest + live POI label-frame preview -- inlined by
// picker_server.py (POI_LAYER_JS token) into the Map Generator pages.
//
// "Add POI" toggles a placement mode: each map click asks for a label and
// drops a draggable marker. Blender builds a label frame from these
// (utils/poi_frame.py): a thin wall along the tile edge plus one bridge per
// POI, the name on the bridge's flat plate next to the frame, a tapered tip
// and a 45° leg down to the POI. The preview below mirrors its top-view
// layout; drag a bridge's frame-end handle to set its angle by hand
// (double-click: shortest path again); right-click a POI for a menu.
//
// The including page provides the POI sidebar markup (#addPoi, #poiList,
// #poiFrameRow/#poiFrameCheck, #poiSettingsSection with #poiFrameWidth,
// #poiTextSize, #poiBridgeWidth), the globals `pois = []` / `poiMode = false`
// (declared with its other state -- updateStatus reads them early), and its
// usual map, coords, currentShape, effectiveBounds, existingMaps,
// geojsonPaths, svgAspect, OBJ_SIZE, PORT, saveState, regularPolygonPoints,
// beveledSquarePoints. Optional: TP3D_SHAPE_ROTATION_DEG + rotatePointsDeg
// (pages with a shape rotation). Include after location_panel.js,
// rect_editor.js and map_tools.js.
var poiLayer = new L.FeatureGroup();
map.addLayer(poiLayer);
var poiSettings = { frameWidth: 1, bridgeWidth: 0, tipWidth: 0.5, textSize: 3.75 };
// Only settings edited here are sent back -- the rest stay whatever
// Blender has (so they keep following Blender's defaults).
var poiSettingsEdited = {};
var poiPreviewLayer = new L.FeatureGroup();
var poiHandleLayer = new L.FeatureGroup();
map.addLayer(poiPreviewLayer);
map.addLayer(poiHandleLayer);
var poiNotes = new Map(); // poi -> preview note ("shrunk to 1.6 mm", ...)
var poiDragging = false;
// Mirrors utils/poi_frame.py constants.
var POI_TEXT_MARGIN = 1.0, POI_MIN_RUN = 0.5, POI_MIN_TEXT = 1.5, POI_PLATE_TAPER = 1.5, POI_CHAMFER = 2.0;
var POI_BAND_GLYPHS = 'Hbdfghjklpqy', POI_LABEL_SIDE_MARGIN = 0.5;
// Served by Blender (/poi_font): the font the labels are built with.
var POI_FONT = 'TP3DPoiFont, Inter, "DejaVu Sans", Arial, sans-serif';

// Corners of a rectangle being drawn snap onto POIs (rect_editor.js).
tp3dSnapProviders.push(function() { return pois.map(function(p) { return p.marker; }); });

function poisPayload() {
    return pois.map(function(p) {
        return { name: p.name, lat: p.lat, lon: p.lon, angle: p.angle, enabled: p.enabled };
    });
}

var POI_SETTING_FIELDS = [['poiFrameWidth', 'frameWidth'], ['poiTextSize', 'textSize'], ['poiBridgeWidth', 'bridgeWidth']];

function readPoiSettings() {
    POI_SETTING_FIELDS.forEach(function(f) {
        var v = parseFloat(document.getElementById(f[0]).value);
        if (!isNaN(v)) poiSettings[f[1]] = v;
    });
}

function editedPoiSettings() {
    var out = {};
    POI_SETTING_FIELDS.forEach(function(f) {
        if (poiSettingsEdited[f[0]]) out[f[1]] = poiSettings[f[1]];
    });
    return out;
}

function writePoiSettings() {
    POI_SETTING_FIELDS.forEach(function(f) { document.getElementById(f[0]).value = poiSettings[f[1]]; });
}

function setPoiMode(on) {
    poiMode = on;
    document.getElementById('addPoi').classList.toggle('active', on);
    document.getElementById('addPoi').textContent = on ? 'Click map to place… (Esc)' : 'Add POI';
    document.getElementById('map').classList.toggle('poi-mode', on);
}

function updatePoiList() {
    var listEl = document.getElementById('poiList');
    listEl.innerHTML = '';
    pois.forEach(function(p) {
        var row = document.createElement('div');
        row.className = 'poi-row';
        var name = document.createElement('span');
        name.className = 'poi-name';
        var note = poiNotes.get(p);
        name.textContent = '● ' + (p.name || '(no label)') + (p.angle != null ? ' ↻' : '');
        if (note) {
            name.textContent += ' — ' + note.text;
            name.style.color = note.bad ? '#ff7070' : '#ffb347';
        }
        if (!p.enabled) name.style.opacity = '0.45';
        name.title = 'Click to rename, double-click to zoom there, right-click the marker for more'
            + (p.angle != null ? '\nBridge angle set by hand (double-click its handle for auto)' : '');
        name.addEventListener('click', function() { renamePoi(p); });
        name.addEventListener('dblclick', function() { map.flyTo([p.lat, p.lon], Math.max(map.getZoom(), 14)); });
        var del = document.createElement('button');
        del.textContent = '×';
        del.title = 'Remove';
        del.addEventListener('click', function() { removePoi(p); });
        row.appendChild(name);
        row.appendChild(del);
        listEl.appendChild(row);
    });
    document.getElementById('poiFrameRow').style.display = pois.length ? 'flex' : 'none';
    document.getElementById('poiSettingsSection').style.display = pois.length ? 'block' : 'none';
}

// A discrete POI edit: refresh, record its own undo step, save.
function poiCommit() {
    updatePoiList();
    updateSendState();
    updateStatus();
    if (typeof window.tp3dRecordChange === 'function') window.tp3dRecordChange();
    saveState();
}

function refreshPoiMarker(p) {
    p.marker.unbindTooltip();
    // With the frame preview on, the label is already drawn on its
    // bridge -- only show the name tag on hover then.
    var permanent = !document.getElementById('poiFrameCheck').checked;
    if (p.name) p.marker.bindTooltip(p.name, { permanent: permanent, direction: 'right', offset: [8, 0], className: 'poi-label' });
}

function addPoi(lat, lon, name, silent, angle, enabled) {
    var marker = L.marker([lat, lon], {
        draggable: true,
        icon: L.divIcon({ className: '', html: '<div class="poi-dot"></div>', iconSize: [12, 12], iconAnchor: [6, 6] })
    });
    var p = { name: name || '', lat: lat, lon: lon, marker: marker,
              angle: (typeof angle === 'number') ? angle : null, enabled: enabled !== false };
    marker.on('drag', function() {
        var ll = marker.getLatLng();
        p.lat = ll.lat; p.lon = ll.lng;
        renderPoiPreview(true);
    });
    marker.on('dragend', function() {
        renderPoiPreview();
        poiCommit();
    });
    marker.on('click', function() { renamePoi(p); });
    marker.on('contextmenu', function(e) {
        L.DomEvent.preventDefault(e.originalEvent);
        tp3dShowContextMenu(e.originalEvent, p.name || '(no label)', [
            { label: 'Rename…', action: function() { renamePoi(p); } },
            { label: bridgeSnapLabel(p), action: function() { snapBridge(p); } },
            { label: p.angle != null ? 'Reset bridge to shortest path' : null, action: function() {
                p.angle = null; renderPoiPreview(); poiCommit();
            } },
            { label: 'Delete POI', danger: true, action: function() { removePoi(p); } }
        ].filter(function(it) { return it.label; }));
    });
    poiLayer.addLayer(marker);
    pois.push(p);
    refreshPoiMarker(p);
    if (silent) { updatePoiList(); updateSendState(); updateStatus(); }
    else poiCommit();
}

// Snap a POI's bridge straight onto the edge it currently runs into:
// perpendicular to that edge (horizontal for the left/right sides of
// a rectangle, vertical for top/bottom).
function bridgeSnapLabel(p) {
    if (!document.getElementById('poiFrameCheck').checked || p.edgeNormal == null) return null;
    var a = Math.round(p.edgeNormal);
    var arrow = { 0: ' →', 180: ' ←', '-180': ' ←', 90: ' ↑', '-90': ' ↓' }[a] || '';
    return 'Bridge straight to edge' + arrow;
}
function snapBridge(p) {
    if (p.edgeNormal == null) return;
    p.angle = Math.round(p.edgeNormal * 10) / 10;
    renderPoiPreview();
    poiCommit();
}

function clearPois() {
    poiLayer.clearLayers();
    pois = [];
}

function setPois(list) {
    clearPois();
    (list || []).forEach(function(p) { addPoi(p.lat, p.lon, p.name, true, p.angle, p.enabled); });
    renderPoiPreview();
}

function renamePoi(p) {
    var name = prompt('Label for this point of interest:', p.name);
    if (name === null) return;
    p.name = name.trim();
    refreshPoiMarker(p);
    renderPoiPreview();
    poiCommit();
}

function removePoi(p) {
    poiLayer.removeLayer(p.marker);
    pois = pois.filter(function(o) { return o !== p; });
    renderPoiPreview();
    poiCommit();
}

// Blender's POI list is the source of truth when it has entries --
// it may have been edited there (directions, POIs added at the 3D
// cursor) since the page last saved its own copy.
function loadPoiState() {
    // Re-measure once the served font arrives (canvas metrics use the
    // fallback font until then).
    if (document.fonts) document.fonts.load('100px TP3DPoiFont').then(function() { renderPoiPreview(); }).catch(function() {});
    return fetch('http://127.0.0.1:' + PORT + '/get_poi_state', { cache: 'no-store' })
        .then(function(r) { return r.json(); })
        .then(function(s) {
            if (!s) return;
            if (s.settings) {
                Object.keys(poiSettings).forEach(function(k) {
                    if (typeof s.settings[k] === 'number') poiSettings[k] = s.settings[k];
                });
                writePoiSettings();
            }
            if (s.pois && s.pois.length) setPois(s.pois);
            renderPoiPreview();
        })
        .catch(function() { renderPoiPreview(); });
}

// ── Preview geometry (tile-local mm, same space as Blender's x/y) ──
function tileToMM(s) {
    return function(lat, lng) {
        return [TP3D_EARTH_R * (lng * Math.PI / 180) * s, TP3D_EARTH_R * tp3dMercY(lat) * s];
    };
}
function tileFromMM(s) {
    return function(x, y) {
        return L.latLng(tp3dInvMercY(y / (TP3D_EARTH_R * s)), (x / (TP3D_EARTH_R * s)) * 180 / Math.PI);
    };
}

// The tile a POI frame would be built on: the drawn area (its true
// shape, rotated like shapeRotation rotates it in Blender, at the
// scale the backend derives: size / extent of the sent bounds) -- or,
// for a POI-only send, the maps already in the scene.
// A tile shape's outline inscribed in lat/lng bounds, like the page's own
// shape preview draws it.
function poiTileOutline(b, shape) {
    var cLat = (b.north + b.south) / 2, cLng = (b.east + b.west) / 2;
    var rLat = (b.north - b.south) / 2, rLng = (b.east - b.west) / 2;
    if (shape === 'hexagon') return regularPolygonPoints(cLat, cLng, rLat, rLng, 6, 0);
    if (shape === 'octagon') return beveledSquarePoints(cLat, cLng, rLat, rLng);
    if (shape === 'circle') return regularPolygonPoints(cLat, cLng, rLat, rLng, 48, 0);
    return [[b.north, b.west], [b.north, b.east], [b.south, b.east], [b.south, b.west]];
}

var POI_SHAPE_FROM_BLENDER = { CIRCLE: 'circle', OCTAGON: 'octagon', HEXAGON: 'hexagon' };
function previewTiles() {
    if (coords) {
        var eb = effectiveBounds(coords);
        var ext = tp3dNeutralExtentKm(eb);
        if (!(ext > 0)) return [];
        var b = currentShape === 'svg' ? svgInscribedBounds(eb, svgAspect) : eb;
        var shape = currentShape === 'svg' ? 'rectangle' : currentShape;
        var c = boundsCenter(eb);
        var ring = poiTileOutline(b, shape);
        if (typeof TP3D_SHAPE_ROTATION_DEG !== 'undefined' && TP3D_SHAPE_ROTATION_DEG)
            ring = rotatePointsDeg(ring, c.lat, c.lng, TP3D_SHAPE_ROTATION_DEG);
        return [{ latlngs: ring, scale: (parseFloat(document.getElementById('objSizeInput').value) || OBJ_SIZE) / ext }];
    }
    if (geojsonPaths.length) return []; // its outline only exists in Blender
    return existingMaps.filter(function(m) { return m.scaleHor; }).map(function(m) {
        var ring = (m.shape === 'custom' && m.polygon && m.polygon.length) ? m.polygon[0]
            : poiTileOutline(m.bounds, m.shape === 'hexagon' ? 'hexagon' : (POI_SHAPE_FROM_BLENDER[m.blenderShape] || 'rectangle'));
        return { latlngs: ring, scale: m.scaleHor };
    });
}

function signedArea(pts) {
    var a = 0;
    for (var i = 0; i < pts.length; i++) {
        var p = pts[i], q = pts[(i + 1) % pts.length];
        a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
}

// Inset a (roughly convex) polygon by d: offset every edge inward and
// intersect neighbouring offset edges (mitre join, like the backend).
function insetPolygon(pts, d) {
    var sign = signedArea(pts) > 0 ? 1 : -1;
    var lines = pts.map(function(p, i) {
        var q = pts[(i + 1) % pts.length];
        var dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy) || 1;
        var nx = -dy / len * sign, ny = dx / len * sign;
        return { p: [p[0] + nx * d, p[1] + ny * d], d: [dx, dy] };
    });
    var out = [];
    for (var i = 0; i < lines.length; i++) {
        var a = lines[(i - 1 + lines.length) % lines.length], b = lines[i];
        var den = a.d[0] * b.d[1] - a.d[1] * b.d[0];
        if (Math.abs(den) < 1e-12) { out.push(b.p); continue; }
        var t = ((b.p[0] - a.p[0]) * b.d[1] - (b.p[1] - a.p[1]) * b.d[0]) / den;
        out.push([a.p[0] + a.d[0] * t, a.p[1] + a.d[1] * t]);
    }
    return out;
}

function pointInPolygon(pt, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
        if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function nearestOnRing(pt, ring) {
    var best = null, bestD = Infinity;
    for (var i = 0; i < ring.length; i++) {
        var a = ring[i], b = ring[(i + 1) % ring.length];
        var dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
        var t = l2 > 0 ? Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / l2)) : 0;
        var q = [a[0] + dx * t, a[1] + dy * t], d = Math.hypot(q[0] - pt[0], q[1] - pt[1]);
        if (d < bestD) { bestD = d; best = q; }
    }
    return best;
}

function rayHitRing(pt, angleDeg, ring) {
    var hit = rayHitRingSeg(pt, angleDeg, ring);
    return hit ? hit.point : null;
}

// Like rayHitRing, plus the direction of the ring edge that was hit.
function rayHitRingSeg(pt, angleDeg, ring) {
    var ux = Math.cos(angleDeg * Math.PI / 180), uy = Math.sin(angleDeg * Math.PI / 180);
    var best = null, bestT = Infinity, bestDir = null;
    for (var i = 0; i < ring.length; i++) {
        var a = ring[i], b = ring[(i + 1) % ring.length];
        var ex = b[0] - a[0], ey = b[1] - a[1];
        var den = ux * ey - uy * ex;
        if (Math.abs(den) < 1e-12) continue;
        var t = ((a[0] - pt[0]) * ey - (a[1] - pt[1]) * ex) / den;
        var s = ((a[0] - pt[0]) * uy - (a[1] - pt[1]) * ux) / den;
        if (t > 1e-9 && s >= 0 && s <= 1 && t < bestT) {
            bestT = t; best = [pt[0] + ux * t, pt[1] + uy * t];
            var el = Math.hypot(ex, ey) || 1;
            bestDir = [ex / el, ey / el];
        }
    }
    return best ? { point: best, dir: bestDir } : null;
}

// ── Label metrics (same font as Blender; see utils/poi_frame.py) ──
var _measureCtx = null;
function measureCtx() {
    if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d');
    _measureCtx.font = '100px ' + POI_FONT;
    return _measureCtx;
}
function capPx() { return measureCtx().measureText('H').actualBoundingBoxAscent || 72; }
// Ink width per 1 mm of cap height -- Blender sizes by the glyphs' outline.
function textWidthPerCapMM(text) {
    var m = measureCtx().measureText(text);
    var ink = (m.actualBoundingBoxLeft || 0) + (m.actualBoundingBoxRight || 0);
    return (ink > 0 ? ink : m.width) / capPx();
}
// The font's vertical glyph band (ascenders to descenders) in cap
// heights, and the em offset that centres that band -- not the div's
// line box -- on the bridge.
function bandMetrics() {
    var cap = capPx();
    var m = measureCtx().measureText(POI_BAND_GLYPHS);
    var asc = m.actualBoundingBoxAscent || 75, desc = m.actualBoundingBoxDescent || 25;
    var fa = m.fontBoundingBoxAscent || 97, fd = m.fontBoundingBoxDescent || 24;
    var baselineTop = (100 - (fa + fd)) / 2 + fa;      // line-height: 1
    var bandCenterTop = baselineTop - (asc - desc) / 2;
    return { perCap: (asc + desc) / cap, shiftYEm: (50 - bandCenterTop) / 100 };
}
// Offset (em) from the advance box's centre to the ink's centre.
function inkCenterShiftEm(text) {
    var m = measureCtx().measureText(text);
    var inkCenter = ((m.actualBoundingBoxRight || 0) - (m.actualBoundingBoxLeft || 0)) / 2;
    return (m.width / 2 - inkCenter) / 100;
}

// Mirrors build_poi_frame()'s per-POI layout (top view).
function layoutBridge(p, inner, outer, toMM) {
    var pt = toMM(p.lat, p.lon);
    if (!pointInPolygon(pt, inner)) return { error: 'on/outside the frame' };
    var q = p.angle != null ? rayHitRing(pt, p.angle, inner) : nearestOnRing(pt, inner);
    if (!q) return { error: 'no frame edge that way' };
    var dx = q[0] - pt[0], dy = q[1] - pt[1], dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return { error: 'touches the frame' };
    var u = [dx / dist, dy / dist], n = [-u[1], u[0]];
    var st = poiSettings;
    // The leg's run depends on terrain height (unknown here), but the
    // label only ever shrinks once the leg is at its minimum run.
    var size = st.textSize, note = null, textLen = 0;
    if (p.name) {
        var perCap = textWidthPerCapMM(p.name);
        var available = dist - POI_MIN_RUN - 2 * POI_TEXT_MARGIN;
        if (perCap * size > available) {
            size = Math.max(available, 0) / perCap;
            if (size < POI_MIN_TEXT) note = { text: 'too short, label dropped', bad: true };
            else note = { text: 'shrunk to ' + size.toFixed(1) + ' mm', bad: false };
        }
        if (!note || !note.bad) textLen = perCap * size;
    }
    var bw = st.bridgeWidth > 0 ? st.bridgeWidth
        : bandMetrics().perCap * st.textSize + 2 * POI_LABEL_SIDE_MARGIN;
    var plateHalf = bw / 2, tipHalf = Math.min(st.tipWidth, bw) / 2;
    var flatStart = Math.max(dist - (textLen ? textLen + 2 * POI_TEXT_MARGIN : 0), 0);
    var taperStart = Math.max(flatStart - POI_PLATE_TAPER, 0);
    function at(s, off) { return [pt[0] + u[0] * s + n[0] * off, pt[1] + u[1] * s + n[1] * off]; }
    var angle = Math.atan2(u[1], u[0]) * 180 / Math.PI;
    // Like the backend: each side of the plate runs on to the map edge,
    // so shallow bridges still meet the frame along their full width.
    function edgeHit(off) {
        return rayHitRing(at(0, off), angle, outer) || at(dist + st.frameWidth, off);
    }
    // Direction straight out through the map edge the bridge runs into.
    var edgeNormal = null;
    var edgeHitSeg = rayHitRingSeg(at(0, 0), angle, outer);
    if (edgeHitSeg) {
        var ed = edgeHitSeg.dir, en = [ed[1], -ed[0]];
        if (en[0] * u[0] + en[1] * u[1] < 0) en = [-en[0], -en[1]];
        edgeNormal = Math.atan2(en[1], en[0]) * 180 / Math.PI;
    }
    // Plan-view 45° chamfers where the plate meets the frame wall.
    var chamfers = [];
    [-1, 1].forEach(function(side) {
        var hit = rayHitRingSeg(at(0, plateHalf * side), angle, inner);
        if (!hit) return;
        var a = hit.point, d = hit.dir;
        // Walk along the wall away from the bridge.
        if ((d[0] * n[0] + d[1] * n[1]) * side < 0) d = [-d[0], -d[1]];
        chamfers.push([[a[0] - u[0] * POI_CHAMFER, a[1] - u[1] * POI_CHAMFER], a,
                       [a[0] + d[0] * POI_CHAMFER, a[1] + d[1] * POI_CHAMFER]]);
    });
    var theta = angle;
    if (theta > 90 || theta <= -90) theta += 180;
    return {
        handle: edgeHit(0), note: note, chamfers: chamfers, edgeNormal: edgeNormal,
        slopePoly: [at(0, tipHalf), at(taperStart, tipHalf), at(taperStart, -tipHalf), at(0, -tipHalf)],
        flatPoly: [at(taperStart, tipHalf), at(flatStart, plateHalf), edgeHit(plateHalf),
                   edgeHit(-plateHalf), at(flatStart, -plateHalf), at(taperStart, -tipHalf)],
        label: textLen ? { text: p.name, center: at(dist - POI_TEXT_MARGIN - textLen / 2, 0), size: size, theta: theta } : null
    };
}

function renderPoiPreview(skipHandles) {
    if (!poiPreviewLayer) return; // updateStatus() can run before this block has initialised
    poiPreviewLayer.clearLayers();
    if (!skipHandles) poiHandleLayer.clearLayers();
    poiNotes = new Map();
    var active = pois.filter(function(p) { return p.enabled; });
    if (!active.length || !document.getElementById('poiFrameCheck').checked) {
        updatePoiListNotes();
        return;
    }
    var frameStyle = { color: '#ffd24d', weight: 1, opacity: 0.9, fillColor: '#1a1a1a', fillOpacity: 0.75, interactive: false };
    var slopeStyle = { color: '#ffd24d', weight: 1, opacity: 0.9, fillColor: '#1a1a1a', fillOpacity: 0.4, interactive: false };
    var claimed = new Set();
    previewTiles().forEach(function(tile) {
        var toMM = tileToMM(tile.scale), fromMM = tileFromMM(tile.scale);
        var outer = tile.latlngs.map(function(ll) { return toMM(ll[0], ll[1]); });
        var inner = insetPolygon(outer, poiSettings.frameWidth);
        var mine = active.filter(function(p) { return !claimed.has(p) && pointInPolygon(toMM(p.lat, p.lon), outer); });
        if (!mine.length) return;
        mine.forEach(function(p) { claimed.add(p); });
        var toLL = function(ring) { return ring.map(function(c) { return fromMM(c[0], c[1]); }); };
        poiPreviewLayer.addLayer(L.polygon([toLL(outer), toLL(inner)], frameStyle));

        var pxPerMM = map.latLngToLayerPoint(fromMM(outer[0][0], outer[0][1]))
            .distanceTo(map.latLngToLayerPoint(fromMM(outer[0][0] + 1, outer[0][1])));
        var capRatio = capPx() / 100;
        mine.forEach(function(p) {
            var lay = layoutBridge(p, inner, outer, toMM);
            p.edgeNormal = lay.edgeNormal;
            if (lay.error) { poiNotes.set(p, { text: lay.error, bad: true }); return; }
            if (lay.note) poiNotes.set(p, lay.note);
            poiPreviewLayer.addLayer(L.polygon(toLL(lay.slopePoly), slopeStyle));
            poiPreviewLayer.addLayer(L.polygon(toLL(lay.flatPoly), frameStyle));
            lay.chamfers.forEach(function(c) { poiPreviewLayer.addLayer(L.polygon(toLL(c), frameStyle)); });
            if (lay.label) {
                var fontPx = lay.label.size * pxPerMM / capRatio;
                var shiftPx = inkCenterShiftEm(lay.label.text) * fontPx;
                var shiftYPx = bandMetrics().shiftYEm * fontPx;
                var html = '<div style="position:absolute; left:0; top:0; transform: translate(-50%, -50%) rotate(' + (-lay.label.theta) + 'deg) translate(' + shiftPx.toFixed(2) + 'px, ' + shiftYPx.toFixed(2) + 'px);'
                    + ' font: ' + fontPx.toFixed(2) + 'px ' + POI_FONT.replace(/"/g, "'") + '; line-height: 1; color: #fff; white-space: nowrap; pointer-events: none;'
                    + (lay.note ? ' color: #ffb347;' : '') + '">' + escapeHtml(lay.label.text) + '</div>';
                poiPreviewLayer.addLayer(L.marker(fromMM(lay.label.center[0], lay.label.center[1]), {
                    icon: L.divIcon({ className: '', html: html, iconSize: [0, 0] }), interactive: false, keyboard: false
                }));
            }
            if (!skipHandles) addBridgeHandle(p, lay.handle, toMM, fromMM);
        });
    });
    active.forEach(function(p) {
        if (!claimed.has(p)) poiNotes.set(p, { text: 'not inside a tile', bad: true });
    });
    updatePoiListNotes();
}

var _lastNotesKey = '';
function updatePoiListNotes() {
    // Only rebuild the sidebar list when a note actually changed --
    // this runs on every drag frame.
    var key = pois.map(function(p) { var n = poiNotes.get(p); return n ? n.text : ''; }).join('|')
        + pois.map(function(p) { return p.angle != null ? 'a' : ''; }).join('');
    if (key !== _lastNotesKey) { _lastNotesKey = key; updatePoiList(); }
}

function addBridgeHandle(p, q, toMM, fromMM) {
    var handle = L.marker(fromMM(q[0], q[1]), {
        draggable: true,
        icon: L.divIcon({ className: '', html: '<div class="poi-handle"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }),
        title: 'Drag to set the bridge angle — double-click for auto (shortest path)'
    });
    handle.on('dragstart', function() { poiDragging = true; });
    handle.on('drag', function() {
        var pt = toMM(p.lat, p.lon);
        var ll = handle.getLatLng(), h = toMM(ll.lat, ll.lng);
        p.angle = Math.round(Math.atan2(h[1] - pt[1], h[0] - pt[0]) * 180 / Math.PI * 10) / 10;
        renderPoiPreview(true);
    });
    handle.on('dragend', function() {
        poiDragging = false;
        renderPoiPreview();
        poiCommit();
    });
    handle.on('dblclick', function(e) {
        L.DomEvent.stop(e);
        p.angle = null;
        renderPoiPreview();
        poiCommit();
    });
    poiHandleLayer.addLayer(handle);
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function(c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

map.on('zoomend', function() { if (!poiDragging) renderPoiPreview(); });
POI_SETTING_FIELDS.forEach(function(f) {
    document.getElementById(f[0]).addEventListener('input', function() {
        poiSettingsEdited[f[0]] = true;
        readPoiSettings();
        renderPoiPreview();
    });
});
document.getElementById('objSizeInput').addEventListener('input', function() { renderPoiPreview(); });

document.getElementById('addPoi').addEventListener('click', function() { setPoiMode(!poiMode); });
document.getElementById('poiFrameCheck').addEventListener('change', function() {
    pois.forEach(refreshPoiMarker);
    renderPoiPreview();
    poiCommit();
});
document.addEventListener('keydown', function(e) { if (e.key === 'Escape' && poiMode) setPoiMode(false); });
map.on('click', function(e) {
    if (!poiMode) return;
    var name = prompt('Label for this point of interest:', '');
    if (name === null) return;
    addPoi(e.latlng.lat, e.latlng.lng, name.trim());
    renderPoiPreview();
});
