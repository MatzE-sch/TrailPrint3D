// Map Generator extras -- inlined by picker_server.py (MAP_TOOLS_JS token)
// into generators/map_generator.html and premium/generators/map_generator_pe.html.
// Include AFTER the page's own saveState/effectiveBounds/bindLiveEdit and the
// rect editor, BEFORE the undo history (both are inlined tokens too -- never
// write a token's literal __NAME__ in an asset: the server substitutes them
// one after another, so a later token inside earlier inlined text is
// replaced as well).
//
// 1. Size / Scale. Scale 1:N relates print mm to real ground mm at the area's
//    centre: the backend maps 1 Mercator-km to scaleHor = size / extent mm
//    (fixed_scale = objSize / neutral extent of the sent bounds), and ground
//    distance = Mercator distance * cos(lat), so N = cos(lat) * extent_km *
//    1e6 / size. A checkbox in front of each field decides which one is set
//    by hand (the other is derived from the drawn area); with both set the
//    area's size is fixed -- it's resized about its centre and only the move
//    handle stays (rect_editor.js reads tp3dSizeLocked()).
// 2. Clicking an existing (purple) map loads it as the editable area, same
//    shape and size -- e.g. to regenerate it (the backend replaces the
//    unmoved old result).
//
// Page markup: #sizeEnabled / #scaleEnabled checkboxes, #objSizeInput,
// #scaleInput, #scaleHint. The page persists tp3dSizeScaleState() and
// restores it via tp3dRestoreSizeScale().
var TP3D_EARTH_R = 6371.0; // must match constants.R

function tp3dMercY(lat) { return Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)); }
function tp3dInvMercY(y) { return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI; }

// Same as the backend's convert_to_neutral_coordinates extent (km).
function tp3dNeutralExtentKm(b) {
    var dx = TP3D_EARTH_R * Math.abs(b.east - b.west) * Math.PI / 180;
    var dy = TP3D_EARTH_R * Math.abs(tp3dMercY(b.north) - tp3dMercY(b.south));
    return Math.max(dx, dy);
}

function tp3dSizeScaleMode() {
    var size = document.getElementById('sizeEnabled').checked;
    var scale = document.getElementById('scaleEnabled').checked;
    return size && scale ? 'both' : (scale ? 'scale' : 'size');
}
window.tp3dSizeLocked = function() { return tp3dSizeScaleMode() === 'both'; };

var tp3dLockApplied = null;

function tp3dApplySizeScaleUI() {
    var m = tp3dSizeScaleMode();
    document.getElementById('objSizeInput').readOnly = (m === 'scale');
    document.getElementById('scaleInput').readOnly = (m === 'size');
    document.getElementById('scaleHint').style.display = m === 'both' ? 'block' : 'none';
    var locked = m === 'both';
    if (locked === tp3dLockApplied || !rectLayer) { tp3dLockApplied = rectLayer ? locked : tp3dLockApplied; return; }
    tp3dLockApplied = locked;
    // Re-bind the area's handles for the new lock state.
    if (locked) {
        if (rectLayer.editing) rectLayer.editing.disable();
        editHandles.clearLayers();
        syncCenterHandles = null;
    } else if (drawMode === 'center') {
        if (!shapeCenter) shapeCenter = boundsCenter(coords);
        bindCenterEdit();
    } else {
        bindLiveEdit(rectLayer);
    }
    bindCornerDrag(rectLayer);
}

// Derive the disabled value from the area, or (both set) resize the area.
function tp3dSyncSizeScale() {
    var sizeEl = document.getElementById('objSizeInput');
    var scaleEl = document.getElementById('scaleInput');
    if (coords) {
        var eb = effectiveBounds(coords);
        var ext = tp3dNeutralExtentKm(eb);
        var cos = Math.cos((eb.north + eb.south) / 2 * Math.PI / 180);
        var size = parseFloat(sizeEl.value) || OBJ_SIZE;
        var n = parseFloat(scaleEl.value);
        var m = tp3dSizeScaleMode();
        if (m === 'size' && ext > 0) {
            scaleEl.value = Math.round(cos * ext * 1e6 / size);
        } else if (m === 'scale' && n > 0 && ext > 0) {
            sizeEl.value = Math.max(5, Math.round(cos * ext * 1e6 / n)); // Object Size is whole mm
        } else if (m === 'both' && n > 0 && ext > 0) {
            var k = size * n / (cos * 1e6) / ext;
            if (Math.abs(k - 1) > 1e-4) {
                var cx = (coords.east + coords.west) / 2 * Math.PI / 180;
                var cy = (tp3dMercY(coords.north) + tp3dMercY(coords.south)) / 2;
                var hx = Math.abs(coords.east - coords.west) / 2 * Math.PI / 180 * k;
                var hy = Math.abs(tp3dMercY(coords.north) - tp3dMercY(coords.south)) / 2 * k;
                coords.north = tp3dInvMercY(cy + hy); coords.south = tp3dInvMercY(cy - hy);
                coords.east = (cx + hx) * 180 / Math.PI; coords.west = (cx - hx) * 180 / Math.PI;
                if (shapeCenter) shapeCenter = boundsCenter(coords);
                if (rectLayer) rectLayer.setBounds([[coords.south, coords.west], [coords.north, coords.east]]);
                syncMoveHandlePosition();
                tp3dOnShapeChanged();
            }
        }
    }
    tp3dApplySizeScaleUI();
}

function tp3dSizeScaleState() {
    return {
        sizeEnabled: document.getElementById('sizeEnabled').checked,
        scaleEnabled: document.getElementById('scaleEnabled').checked,
        scale: document.getElementById('scaleInput').value
    };
}

function tp3dRestoreSizeScale(s) {
    if (!s) return;
    if (s.scale) document.getElementById('scaleInput').value = s.scale;
    if (s.sizeEnabled != null) document.getElementById('sizeEnabled').checked = s.sizeEnabled;
    if (s.scaleEnabled != null) document.getElementById('scaleEnabled').checked = s.scaleEnabled;
    if (!document.getElementById('sizeEnabled').checked && !document.getElementById('scaleEnabled').checked) {
        document.getElementById('sizeEnabled').checked = true;
    }
    tp3dLockApplied = null;
    tp3dSyncSizeScale();
}

['sizeEnabled', 'scaleEnabled'].forEach(function(id) {
    document.getElementById(id).addEventListener('change', function() {
        // At least one of the two stays set by hand.
        if (!document.getElementById('sizeEnabled').checked && !document.getElementById('scaleEnabled').checked) {
            document.getElementById(id === 'sizeEnabled' ? 'scaleEnabled' : 'sizeEnabled').checked = true;
        }
        saveState();
    });
});
['objSizeInput', 'scaleInput'].forEach(function(id) {
    document.getElementById(id).addEventListener('input', function() {
        if (!this.readOnly) saveState();
    });
});

// Every edit ends in saveState() -- keep size/scale (or the fixed area) in
// sync right before it's saved.
(function wrapSaveState() {
    var orig = saveState;
    saveState = function() {
        tp3dSyncSizeScale();
        return orig.apply(this, arguments);
    };
})();

// ── Existing maps ────────────────────────────────────────────────────────
var TP3D_SHAPE_FROM_BLENDER = { CIRCLE: 'circle', OCTAGON: 'octagon', HEXAGON: 'hexagon' };

function tp3dEditExistingMap(m) {
    if (typeof poiMode !== 'undefined' && poiMode) return;
    var b = m.bounds;
    var shape = m.shape === 'hexagon' ? 'hexagon' : (TP3D_SHAPE_FROM_BLENDER[m.blenderShape] || 'rectangle');
    var area = { north: b.north, south: b.south, east: b.east, west: b.west };
    if (shape !== 'rectangle') {
        // effectiveBounds squares every non-rectangle shape to its SHORTER
        // side; the tile was built from its LONGER one -- square the area to
        // that so the loaded shape is the same size.
        var midLat = (b.north + b.south) / 2;
        var mLat = 111320, mLng = 111320 * Math.cos(midLat * Math.PI / 180);
        var side = Math.max((b.north - b.south) * mLat, (b.east - b.west) * mLng);
        var cLng = (b.east + b.west) / 2;
        area = { north: midLat + side / mLat / 2, south: midLat - side / mLat / 2,
                 east: cLng + side / mLng / 2, west: cLng - side / mLng / 2 };
    }
    currentShape = shape;
    document.querySelectorAll('.shape-btn[data-shape]').forEach(function(btn) {
        btn.classList.toggle('active', btn.getAttribute('data-shape') === shape);
    });
    if (m.scaleHor) {
        // Same size and scale as the existing tile (backend: objSize =
        // scaleHor * neutral extent of the sent bounds).
        var eb = effectiveBounds(area);
        document.getElementById('objSizeInput').value = Math.max(5, Math.round(m.scaleHor * tp3dNeutralExtentKm(eb)));
        document.getElementById('scaleInput').value = Math.round(Math.cos((eb.north + eb.south) / 2 * Math.PI / 180) * 1e6 / m.scaleHor);
    }
    tp3dSetDrawnArea(area);
    map.fitBounds([[area.south, area.west], [area.north, area.east]], { padding: [60, 60] });
    saveState();
}

function tp3dBindExistingMapEdit(layer, m) {
    if (m.shape === 'custom' || !m.bounds) return;
    layer.on('click', function() { tp3dEditExistingMap(m); });
    if (m.name) layer.bindTooltip(m.name + ' — click to edit', { sticky: true });
}
