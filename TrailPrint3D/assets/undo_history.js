// Shared undo/redo (Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y) for picker pages --
// inlined by picker_server.py (UNDO_HISTORY_JS token). Place it near the END
// of the page's script, after saveState and the page's own state functions.
//
// Each undo step is a snapshot of every registered "domain" (the drawn area,
// the location-panel points, a page's POIs, ...). A step is recorded after
// each saveState() call -- every edit already ends in one -- but only when
// the snapshot actually changed (map panning also saves). Calls closer
// together than TP3D_UNDO_MERGE_MS (a drag) collapse into one step. Pages
// can also call window.tp3dRecordChange() directly.
//
// Domains: tp3dUndoRegister(name, capture, apply) -- capture() returns a
// JSON-able value, apply(value) restores it without recording anything.
// The page calls tp3dUndoBaseline() once its saved state has been restored
// (anything earlier isn't undoable).
var TP3D_UNDO_MERGE_MS = 500;
var tp3dUndoDomains = [];
var tp3dUndoStack = [], tp3dRedoStack = [];
var tp3dUndoLast = null, tp3dUndoLastJson = null, tp3dUndoLastTime = 0;
var tp3dUndoApplying = false;

function tp3dUndoRegister(name, capture, apply) {
    tp3dUndoDomains.push({ name: name, capture: capture, apply: apply });
}

function tp3dUndoCapture() {
    var st = {};
    tp3dUndoDomains.forEach(function(d) { st[d.name] = d.capture(); });
    return JSON.parse(JSON.stringify(st));
}

function tp3dUndoBaseline() {
    tp3dUndoLast = tp3dUndoCapture();
    tp3dUndoLastJson = JSON.stringify(tp3dUndoLast);
    tp3dUndoLastTime = 0;
}

window.tp3dRecordChange = function(merge) {
    if (tp3dUndoApplying || tp3dUndoLast === null) return;
    var cur = tp3dUndoCapture(), json = JSON.stringify(cur);
    if (json === tp3dUndoLastJson) return;
    var now = Date.now();
    if (!merge || now - tp3dUndoLastTime > TP3D_UNDO_MERGE_MS) {
        tp3dUndoStack.push(tp3dUndoLast);
        if (tp3dUndoStack.length > 200) tp3dUndoStack.shift();
        tp3dRedoStack = [];
    }
    tp3dUndoLastTime = now;
    tp3dUndoLast = cur;
    tp3dUndoLastJson = json;
};

function tp3dUndoApply(st) {
    tp3dUndoApplying = true;
    try {
        tp3dUndoDomains.forEach(function(d) { if (d.name in st) d.apply(st[d.name]); });
        if (typeof saveState === 'function') saveState();
    } finally {
        tp3dUndoApplying = false;
    }
    tp3dUndoBaseline();
}

function tp3dUndo() {
    if (!tp3dUndoStack.length) return;
    tp3dRedoStack.push(tp3dUndoCapture());
    tp3dUndoApply(tp3dUndoStack.pop());
}

function tp3dRedo() {
    if (!tp3dRedoStack.length) return;
    tp3dUndoStack.push(tp3dUndoCapture());
    tp3dUndoApply(tp3dRedoStack.pop());
}

// Every edit ends in saveState() -- record right after it. (Rebinding the
// global name catches every later call by name; listeners that captured the
// original function, like map 'moveend', only move the view anyway.)
(function wrapSaveState() {
    var orig = saveState;
    saveState = function() {
        var r = orig.apply(this, arguments);
        window.tp3dRecordChange(true);
        return r;
    };
})();

document.addEventListener('keydown', function(e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    // Text/number fields keep their own native undo.
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    var key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); tp3dUndo(); }
    else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); tp3dRedo(); }
});

// Built-in domains: the location-panel points (location_panel.js) and, on
// pages using rect_editor.js, the drawn area with its shape/draw mode.
if (typeof tp3dLocationPointsState === 'function') {
    tp3dUndoRegister('points', tp3dLocationPointsState, tp3dRestoreLocationPoints);
}
if (typeof tp3dSetDrawnArea === 'function') {
    tp3dUndoRegister('area', function() {
        return { coords: coords ? { north: coords.north, south: coords.south, east: coords.east, west: coords.west } : null,
                 shape: currentShape, drawMode: drawMode, center: shapeCenter };
    }, function(a) {
        if (a.drawMode && a.drawMode !== drawMode) {
            drawMode = a.drawMode;
            document.querySelectorAll('.draw-mode-btn').forEach(function(b) {
                b.classList.toggle('active', b.getAttribute('data-mode') === drawMode);
            });
        }
        if (a.shape && a.shape !== currentShape) {
            currentShape = a.shape;
            document.querySelectorAll('.shape-btn[data-shape]').forEach(function(b) {
                b.classList.toggle('active', b.getAttribute('data-shape') === currentShape);
            });
        }
        tp3dSetDrawnArea(a.coords, a.center);
    });
}
// Map Generator: Size / Scale fields and their checkboxes (map_tools.js).
if (typeof tp3dSizeScaleState === 'function') {
    tp3dUndoRegister('sizeScale', function() {
        return { state: tp3dSizeScaleState(), size: document.getElementById('objSizeInput').value };
    }, function(v) {
        document.getElementById('objSizeInput').value = v.size;
        tp3dRestoreSizeScale(v.state);
    });
}
