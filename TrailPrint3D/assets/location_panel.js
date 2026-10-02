// Shared "go to location" panel -- reused by every 2D-map picker page via
// __LOCATION_PANEL_JS__ in picker_server.py. Collapsed to a single
// pin-icon button by default; expands to a small panel offering either a
// city-name lookup (via Nominatim) or direct lat/lon entry. Requires `map`
// to already be defined by the including page (see map_init.js).
//
// Every looked-up place stays on the map as a point (several at once) --
// right-click one for a menu (copy coordinates, delete). Pasting a "lat lon"
// pair into either field fills both, and the ⇄ button swaps them (moving the
// point those fields just placed) when a pasted pair was the wrong way round.
//
// Optional integration hooks for the including page (all may be absent):
//   tp3dLocationPointsState() / tp3dRestoreLocationPoints(list)
//       -- [[lat, lng], ...] for the page's saved state (see map_generator).
//   window.tp3dRecordChange()   -- undo history (assets/undo_history.js).
//   tp3dSnapProviders           -- markers a drawn rectangle's corners snap
//                                  to (see assets/rect_editor.js).
var searchPoints = []; // L.marker per looked-up place
var lastFieldPoint = null; // the point the lat/lon fields placed last (for ⇄)

// Markers a rectangle being drawn snaps its corners to -- providers append
// a function returning their current markers (see rect_editor.js).
var tp3dSnapProviders = [function () { return searchPoints; }];

// A discrete edit: record it as its own undo step, then save. (Order
// matters -- saveState records too, but as a mergeable drag-style change.)
function tp3dCommitChange() {
    if (typeof window.tp3dRecordChange === 'function') window.tp3dRecordChange();
    if (typeof saveState === 'function') saveState();
}

document.getElementById('coordSearchToggle').addEventListener('click', function() {
    var body = document.getElementById('coordSearchBody');
    var open = body.classList.toggle('open');
    this.classList.toggle('active', open);
});

// ── Right-click menu (shared: points here, POIs on pages that have them) ──
function tp3dShowContextMenu(ev, title, items) {
    var menu = document.getElementById('tp3dCtxMenu');
    if (!menu) {
        menu = document.createElement('div');
        menu.id = 'tp3dCtxMenu';
        document.body.appendChild(menu);
    }
    menu.innerHTML = '';
    if (title) {
        var t = document.createElement('div');
        t.className = 'ctx-title';
        t.textContent = title;
        menu.appendChild(t);
    }
    items.forEach(function(it) {
        var el = document.createElement('div');
        el.className = 'ctx-item' + (it.danger ? ' danger' : '');
        el.textContent = it.label;
        el.addEventListener('click', function(e) {
            e.stopPropagation();
            tp3dHideContextMenu();
            it.action();
        });
        menu.appendChild(el);
    });
    menu.style.display = 'block';
    menu.style.left = Math.min(ev.clientX, window.innerWidth - menu.offsetWidth - 4) + 'px';
    menu.style.top = Math.min(ev.clientY, window.innerHeight - menu.offsetHeight - 4) + 'px';
}
function tp3dHideContextMenu() {
    var menu = document.getElementById('tp3dCtxMenu');
    if (menu) menu.style.display = 'none';
}
document.addEventListener('mousedown', function(e) {
    var menu = document.getElementById('tp3dCtxMenu');
    if (menu && !menu.contains(e.target)) tp3dHideContextMenu();
});
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') tp3dHideContextMenu(); });
map.on('movestart zoomstart', tp3dHideContextMenu);

// ── Points ──────────────────────────────────────────────────────────────
function pointLabel(lat, lng) { return lat.toFixed(6) + ', ' + lng.toFixed(6); }

function addSearchPoint(lat, lon) {
    var m = L.marker([lat, lon]).addTo(map);
    m.bindTooltip(pointLabel(lat, lon), { direction: 'top', offset: [0, -34] });
    m.on('contextmenu', function(e) {
        L.DomEvent.preventDefault(e.originalEvent);
        var ll = m.getLatLng();
        tp3dShowContextMenu(e.originalEvent, pointLabel(ll.lat, ll.lng), [
            { label: 'Copy coordinates', action: function() {
                if (navigator.clipboard) navigator.clipboard.writeText(ll.lat + ' ' + ll.lng).catch(function() {});
            } },
            { label: 'Delete point', danger: true, action: function() {
                removeSearchPoint(m);
                tp3dCommitChange();
            } }
        ]);
    });
    searchPoints.push(m);
    return m;
}

function removeSearchPoint(m) {
    map.removeLayer(m);
    searchPoints = searchPoints.filter(function(o) { return o !== m; });
    if (lastFieldPoint === m) lastFieldPoint = null;
}

function clearSearchPoints() {
    searchPoints.forEach(function(m) { map.removeLayer(m); });
    searchPoints = [];
    lastFieldPoint = null;
}

function tp3dLocationPointsState() {
    return searchPoints.map(function(m) { var ll = m.getLatLng(); return [ll.lat, ll.lng]; });
}

function tp3dRestoreLocationPoints(list) {
    clearSearchPoints();
    (list || []).forEach(function(pt) { addSearchPoint(pt[0], pt[1]); });
}

function flyToMarker(lat, lon, zoom) {
    var m = addSearchPoint(lat, lon);
    map.flyTo([lat, lon], zoom);
    tp3dCommitChange();
    return m;
}

function goToCoords() {
    var latInput = document.getElementById('latInput');
    var lonInput = document.getElementById('lonInput');
    var lat = parseFloat(latInput.value);
    var lon = parseFloat(lonInput.value);
    var latOk = !isNaN(lat) && lat >= -90 && lat <= 90;
    var lonOk = !isNaN(lon) && lon >= -180 && lon <= 180;
    latInput.style.borderColor = latOk ? '' : '#cc4444';
    lonInput.style.borderColor = lonOk ? '' : '#cc4444';
    if (!latOk || !lonOk) return;
    lastFieldPoint = flyToMarker(lat, lon, 15);
}

// "47.4514, 10.4105", "47.4514 10.4105", "47,4514; 10,4105" ... -> [lat, lon]
function parseLatLon(text) {
    text = (text || '').trim();
    var parts = text.split(/[\s;]+/).filter(Boolean);
    if (parts.length !== 2) {
        // Only a comma between them ("47.45,10.41")?
        parts = text.split(',').map(function(p) { return p.trim(); }).filter(Boolean);
    }
    if (parts.length !== 2) return null;
    var nums = parts.map(function(p) { return parseFloat(p.replace(/,$/, '').replace(',', '.')); });
    if (isNaN(nums[0]) || isNaN(nums[1])) return null;
    if (nums[0] < -90 || nums[0] > 90 || nums[1] < -180 || nums[1] > 180) return null;
    return nums;
}

// ⇄ between the two fields (injected here so every page's own markup gets it):
// swap them; if they already placed a point, move it.
(function addSwapButton() {
    var lonInput = document.getElementById('lonInput');
    var btn = document.createElement('button');
    btn.id = 'swapLatLon';
    btn.type = 'button';
    btn.textContent = '⇄';
    btn.title = 'Swap lat and lon (if the pasted pair was the wrong way round)';
    lonInput.parentNode.insertBefore(btn, lonInput);
    btn.addEventListener('click', function() {
        var latInput = document.getElementById('latInput');
        var t = latInput.value;
        latInput.value = lonInput.value;
        lonInput.value = t;
        var lat = parseFloat(latInput.value), lon = parseFloat(lonInput.value);
        var ok = !isNaN(lat) && lat >= -90 && lat <= 90 && !isNaN(lon) && lon >= -180 && lon <= 180;
        latInput.style.borderColor = ok || latInput.value === '' ? '' : '#cc4444';
        lonInput.style.borderColor = ok || lonInput.value === '' ? '' : '#cc4444';
        if (!ok) return;
        if (lastFieldPoint && searchPoints.indexOf(lastFieldPoint) >= 0) {
            lastFieldPoint.setLatLng([lat, lon]);
            lastFieldPoint.setTooltipContent(pointLabel(lat, lon));
            map.flyTo([lat, lon], Math.max(map.getZoom(), 13));
            tp3dCommitChange();
        } else {
            goToCoords();
        }
    });
})();

document.getElementById('coordSearchBtn').addEventListener('click', goToCoords);
['latInput', 'lonInput'].forEach(function(id) {
    var el = document.getElementById(id);
    el.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); goToCoords(); }
    });
    el.addEventListener('input', function() { this.style.borderColor = ''; });
});

// Pasting a "lat lon" pair into either field (or the city box) fills both
// fields and jumps there; anything else pastes normally.
['latInput', 'lonInput', 'citySearchInput'].forEach(function(id) {
    document.getElementById(id).addEventListener('paste', function(e) {
        var text = (e.clipboardData || window.clipboardData).getData('text');
        var ll = parseLatLon(text);
        if (!ll) return;
        e.preventDefault();
        document.getElementById('latInput').value = ll[0];
        document.getElementById('lonInput').value = ll[1];
        goToCoords();
    });
});

// City lookup uses OpenStreetMap's Nominatim geocoder -- free, no
// API key, CORS-enabled for browser fetches. Only fires on explicit
// user action (button/Enter), never as-you-type, and never while a
// previous lookup is still in flight (the button stays disabled), to stay
// within its 1-request-per-second usage policy. Nominatim identifies
// browser apps by their Referer (a page can't set its own User-Agent), so
// the referrer policy is pinned here the same way map_init.js pins it for
// tiles. A non-OK response (e.g. 403/429 if we ever get blocked or rate-
// limited) is treated as a failed lookup rather than parsed as results.
function searchCity() {
    var input = document.getElementById('citySearchInput');
    var btn = document.getElementById('citySearchBtn');
    var q = input.value.trim();
    if (!q || btn.disabled) return;
    btn.disabled = true;
    fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q), {
        referrerPolicy: 'strict-origin-when-cross-origin'
    })
        .then(function(r) {
            if (!r.ok) throw new Error('Nominatim HTTP ' + r.status);
            return r.json();
        })
        .then(function(results) {
            btn.disabled = false;
            if (!results || !results.length) {
                input.style.borderColor = '#cc4444';
                return;
            }
            input.style.borderColor = '';
            flyToMarker(parseFloat(results[0].lat), parseFloat(results[0].lon), 12);
        })
        .catch(function() {
            btn.disabled = false;
            input.style.borderColor = '#cc4444';
        });
}

document.getElementById('citySearchBtn').addEventListener('click', searchCity);
document.getElementById('citySearchInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); searchCity(); }
});
document.getElementById('citySearchInput').addEventListener('input', function() {
    this.style.borderColor = '';
});
