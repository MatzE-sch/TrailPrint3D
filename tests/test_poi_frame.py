"""Tests for the POI label frame (utils/poi_frame.py).

Builds frames on a synthetic hilly map (no network, no .blend files) and
checks what matters for printing them (upside down, on top of the map):
  - frame + inlaid text are built, watertight, one colour each (BLACK/WHITE)
  - no overhang steeper than 45° once flipped, no text over thin air
  - the frame never cuts into the terrain (it rests on it with clearance)
  - linking: Object type, poiMap/poiMapUid, export group, the map's generation
  - rebuilding replaces the previous frame; warnings for skipped/overlapping labels
  - Map Generator glue: store_picker_pois(), poi_state_for_picker(),
    apply_picker_result() (incl. a POI-only send)

Run with:
  blender --background --factory-startup --python-exit-code 1 -P tests/test_poi_frame.py
  or, as part of the full suite:
  & "C:\Program Files\Blender Foundation\Blender 5.1\blender.exe" --background --factory-startup --python-exit-code 1 -P tests/run_all_tests.py
"""  # noqa: W605

import math
import os
import sys
import traceback

import bmesh  # type: ignore
import bpy  # type: ignore  — provided by Blender's Python
from mathutils.bvhtree import BVHTree  # type: ignore

# ---------------------------------------------------------------------------
# Path setup — makes TrailPrint3D importable as a package from source
# ---------------------------------------------------------------------------
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

if "TrailPrint3D" not in bpy.context.preferences.addons:
    bpy.ops.preferences.addon_enable(module="TrailPrint3D")

from shapely.geometry import Polygon
from shapely.ops import unary_union
from shapely.validation import make_valid

from TrailPrint3D import const
from TrailPrint3D.utils import poi_frame as pf
from TrailPrint3D.utils import regenerate

# ---------------------------------------------------------------------------
# Minimal test runner (matches the pattern used by the other tests/*.py files)
# ---------------------------------------------------------------------------
_passed = 0
_failed = 0


def _run(name, fn):
    global _passed, _failed
    _reset()
    try:
        fn()
        print(f"  PASS  {name}")
        _passed += 1
    except Exception as e:  # noqa: BLE001 - wide exception needeed to keep test runner going
        print(f"  FAIL  {name} - exception occurred: {e}")
        traceback.print_exc()
        _failed += 1


def _assert_all_passed():
    print(f"\n{'='*60}")
    print(f"  {_passed} passed, {_failed} failed")
    print(f"{'='*60}\n")
    if _failed:
        raise SystemExit(1)


# ---------------------------------------------------------------------------
# Synthetic map
# ---------------------------------------------------------------------------
# An 80 x 80 mm tile around Oberstdorf at a real Map Generator scale. The
# object sits at its true world position (thousands of mm from the origin),
# like generated maps do.
_SCALE_HOR = 3.75  # mm per km
_CENTER_LAT, _CENTER_LON = 47.40, 10.28
_HALF = 40.0
_GRID = 41


def _world_xy(lat, lon):
    x = const.R * math.radians(lon) * _SCALE_HOR
    y = const.R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * _SCALE_HOR
    return x, y


def _latlon(x, y):
    """Inverse of _world_xy."""
    k = const.R * _SCALE_HOR
    return math.degrees(2 * math.atan(math.exp(y / k)) - math.pi / 2), math.degrees(x / k)


_CX, _CY = _world_xy(_CENTER_LAT, _CENTER_LON)


def _height(x, y):
    """Rolling hills plus one steep peak: 3..~17 mm."""
    peak = 8.0 * math.exp(-((x - 12) ** 2 + (y + 10) ** 2) / 60.0)
    return 3.0 + 2.5 * (math.sin(x / 7.0) * math.cos(y / 9.0) + 1.0) + peak


def _make_map(name="Rectangle"):
    """Closed terrain solid: height-field top, vertical walls, flat floor at z=0."""
    step = 2 * _HALF / (_GRID - 1)
    verts, faces = [], []
    for j in range(_GRID):
        for i in range(_GRID):
            x, y = -_HALF + i * step, -_HALF + j * step
            verts.append((x, y, _height(x, y)))
    for j in range(_GRID - 1):
        for i in range(_GRID - 1):
            a = j * _GRID + i
            faces.append((a, a + 1, a + 1 + _GRID, a + _GRID))
    # Boundary ring (counter-clockwise seen from above), walls down to z=0.
    ring = ([i for i in range(_GRID)]
            + [j * _GRID + _GRID - 1 for j in range(1, _GRID)]
            + [(_GRID - 1) * _GRID + i for i in range(_GRID - 2, -1, -1)]
            + [j * _GRID for j in range(_GRID - 2, 0, -1)])
    base = len(verts)
    for idx in ring:
        x, y, _z = verts[idx]
        verts.append((x, y, 0.0))
    n = len(ring)
    for k in range(n):
        a, b = ring[k], ring[(k + 1) % n]
        faces.append((a, base + k, base + (k + 1) % n, b))
    faces.append(tuple(base + k for k in range(n)))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    # Outward normals, like a generated map (booleans depend on them).
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = (_CX, _CY, 0.0)
    obj["Object type"] = "MAP"
    obj["Horizontal Scale"] = _SCALE_HOR
    bpy.context.view_layer.update()
    return obj


def _add_poi(name, dx, dy, direction="AUTO", angle=0.0):
    """Add a POI to the scene list at (dx, dy) mm from the tile centre."""
    lat, lon = _latlon(_CX + dx, _CY + dy)
    poi = bpy.context.scene.tp3d.pois.add()
    poi.name, poi.lat, poi.lon = name, lat, lon
    poi.direction = direction
    if direction == "CUSTOM":
        poi.angle = angle
    return poi


def _default_pois():
    _add_poi("Oberstdorf", -10, 5)
    _add_poi("Nebelhorn", 15, 20, "CUSTOM", 90)
    _add_poi("Freibergsee", -5, -25)


def _reset():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    tp3d = bpy.context.scene.tp3d
    tp3d.pois.clear()
    for prop in pf.POI_SETTING_PROPS:
        tp3d.property_unset(prop)


def _frames_and_texts():
    objs = bpy.context.scene.objects
    return ([o for o in objs if o.get("Object type") == "POI_FRAME"],
            [o for o in objs if o.get("Object type") == "POI_TEXT"])


# ---------------------------------------------------------------------------
# Mesh checks
# ---------------------------------------------------------------------------

def _non_manifold(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    n = sum(1 for e in bm.edges if not e.is_manifold)
    bm.free()
    return n


def _faces_xy(obj, pred):
    """Union of the top-view footprints of the faces matching pred(normal, centre)."""
    mw = obj.matrix_world
    rot = mw.to_3x3()
    out = []
    for p in obj.data.polygons:
        n = (rot @ p.normal).normalized()
        if pred(n, mw @ p.center):
            ring = [((mw @ obj.data.vertices[i].co).x, (mw @ obj.data.vertices[i].co).y) for i in p.vertices]
            out.append(make_valid(Polygon(ring)))
    return unary_union(out)


def _printability(frame, text, text_depth):
    """(overhanging faces, unsupported text area in mm²) for the flipped print.

    Printed upside down, the frame's top (largest Z) lies on the bed; any
    other face pointing up in Blender points down in the print and must be
    at least 45° steep -- except the floor of the text pockets, which the
    text itself fills.
    """
    mw = frame.matrix_world
    rot = mw.to_3x3()
    top_z = max((mw @ v.co).z for v in frame.data.vertices)
    pocket_z = top_z - text_depth
    bad = 0
    for p in frame.data.polygons:
        n = (rot @ p.normal).normalized()
        cz = (mw @ p.center).z
        on_top = abs(cz - top_z) < 1e-3
        pocket_floor = n.z > 0.999 and abs(cz - pocket_z) < 0.05
        if n.z > 0.72 and not on_top and not pocket_floor:  # 0.72 ~ cos(44°)
            bad += 1
    unsupported = 0.0
    if text is not None:
        floor = _faces_xy(frame, lambda n, c: n.z > 0.999 and abs(c.z - pocket_z) < 0.02)
        letters = _faces_xy(text, lambda n, c: n.z > 0.999)
        unsupported = letters.difference(floor.buffer(0.01)).area
    return bad, unsupported


def _bvh(obj):
    mw = obj.matrix_world
    return BVHTree.FromPolygons([mw @ v.co for v in obj.data.vertices],
                                [tuple(p.vertices) for p in obj.data.polygons])


# ---------------------------------------------------------------------------
# Tests: geometry
# ---------------------------------------------------------------------------

def test_builds_frame_and_text():
    map_obj = _make_map()
    _default_pois()
    built, warnings = pf.generate_poi_frames(bpy.context.scene.tp3d, [map_obj])
    assert len(built) == 1, f"one frame expected, got {built} ({warnings})"
    frames, texts = _frames_and_texts()
    assert [f.name for f in frames] == ["Rectangle_POI_Frame"], frames
    assert [t.name for t in texts] == ["Rectangle_POI_Text"], texts
    assert not [w for w in warnings if "skipped" in w or "watertight" in w], warnings


def test_watertight_and_one_colour_each():
    map_obj = _make_map()
    _default_pois()
    pf.generate_poi_frames(bpy.context.scene.tp3d, [map_obj])
    (frame,), (text,) = _frames_and_texts()
    assert _non_manifold(frame) == 0, f"frame has {_non_manifold(frame)} non-manifold edges"
    assert _non_manifold(text) == 0, f"text has {_non_manifold(text)} non-manifold edges"
    assert [m.name for m in frame.data.materials] == ["BLACK"], [m.name for m in frame.data.materials]
    assert {m.name for m in text.data.materials} == {"WHITE"}, [m.name for m in text.data.materials]


def test_printable_at_several_text_sizes():
    map_obj = _make_map()
    _default_pois()
    tp3d = bpy.context.scene.tp3d
    for size in (2.5, 3.75, 6.0):
        tp3d.poi_labelSize = size
        pf.generate_poi_frames(tp3d, [map_obj])
        bpy.context.view_layer.update()
        frames, texts = _frames_and_texts()
        assert len(frames) == 1 and len(texts) == 1, f"text {size}: rebuild left {frames} {texts}"
        assert _non_manifold(frames[0]) == 0, f"text {size}: frame not watertight"
        bad, unsupported = _printability(frames[0], texts[0], tp3d.poi_textDepth)
        assert bad == 0, f"text {size}: {bad} faces overhang more than 45°"
        assert unsupported < 0.01, f"text {size}: {unsupported:.3f} mm² of text over thin air"


def test_frame_rests_on_terrain():
    map_obj = _make_map()
    assert _non_manifold(map_obj) == 0
    assert all(p.normal.z < -0.99 for p in map_obj.data.polygons if p.center.z < 1e-6), "test map inside out"
    _default_pois()
    pf.generate_poi_frames(bpy.context.scene.tp3d, [map_obj])
    (frame,), (text,) = _frames_and_texts()
    hits = _bvh(frame).overlap(_bvh(map_obj))
    assert not hits, f"frame cuts into the terrain ({len(hits)} intersecting face pairs)"
    # ... and it does reach down onto it (not floating at the plate height).
    frame_min = min((frame.matrix_world @ v.co).z for v in frame.data.vertices)
    assert frame_min < 3.0 + 1.0, f"frame bottom at z={frame_min:.2f} never reaches the terrain"
    # Everything stays within the tile's outline.
    for obj in (frame, text):
        xs = [(obj.matrix_world @ v.co).x - _CX for v in obj.data.vertices]
        ys = [(obj.matrix_world @ v.co).y - _CY for v in obj.data.vertices]
        assert max(map(abs, xs + ys)) <= _HALF + 1e-3, f"{obj.name} sticks out of the tile"


def test_linked_to_map_and_generation():
    map_obj = _make_map()
    regenerate.tag_generated(map_obj, "gen-1")
    _default_pois()
    pf.generate_poi_frames(bpy.context.scene.tp3d, [map_obj])
    uid = pf.map_uid(map_obj)
    for obj in sum(_frames_and_texts(), []):
        assert obj["poiMap"] == "Rectangle" and obj["poiMapUid"] == uid, obj.name
        assert obj["ExportGroup"] == 3, obj.name
        assert obj[regenerate.GEN_ID] == "gen-1", f"{obj.name} not part of its map's generation"
        assert regenerate.is_unmoved(obj), f"{obj.name}: generation matrix not recorded"


def test_rebuild_replaces_previous_frame():
    map_obj = _make_map()
    _default_pois()
    tp3d = bpy.context.scene.tp3d
    pf.generate_poi_frames(tp3d, [map_obj])
    tp3d.pois.remove(0)
    pf.generate_poi_frames(tp3d, [map_obj])
    frames, texts = _frames_and_texts()
    assert [f.name for f in frames] == ["Rectangle_POI_Frame"], frames
    assert [t.name for t in texts] == ["Rectangle_POI_Text"], texts


def test_two_maps_each_get_their_own_frame():
    map_a = _make_map("A")
    map_b = _make_map("B")
    map_b.location.x += 2 * _HALF  # neighbouring tile, POIs only on A
    map_b["Horizontal Scale"] = _SCALE_HOR
    bpy.context.view_layer.update()
    _default_pois()
    built, _warnings = pf.generate_poi_frames(bpy.context.scene.tp3d, [map_a, map_b])
    assert [f.name for f in built] == ["A_POI_Frame"], built
    # Rebuilding B's (empty) frame must not remove A's.
    pf.remove_poi_frame(map_b)
    assert "A_POI_Frame" in bpy.data.objects


# ---------------------------------------------------------------------------
# Tests: warnings
# ---------------------------------------------------------------------------

def test_no_enabled_pois():
    map_obj = _make_map()
    _add_poi("Off", 0, 0).enabled = False
    built, warnings = pf.generate_poi_frames(bpy.context.scene.tp3d, [map_obj])
    assert built == [] and warnings == ["No enabled points of interest in the list."], warnings


def test_poi_outside_map_is_ignored():
    map_obj = _make_map()
    _add_poi("Far away", 300, 0)
    built, _warnings = pf.generate_poi_frames(bpy.context.scene.tp3d, [map_obj])
    assert built == [], built
    assert not any(_frames_and_texts()), "nothing to build for a POI off the map"


def test_poi_on_frame_is_skipped():
    map_obj = _make_map()
    _add_poi("Inside", 0, 0)
    _add_poi("On the edge", _HALF - 0.3, 0)
    built, warnings = pf.generate_poi_frames(bpy.context.scene.tp3d, [map_obj])
    assert len(built) == 1, warnings
    assert any("On the edge" in w and "skipped" in w for w in warnings), warnings


def test_overlapping_labels_warn():
    map_obj = _make_map()
    _add_poi("Alpha", -10, 10, "CUSTOM", 90)
    _add_poi("Bravo", -9, 12, "CUSTOM", 90)
    _built, warnings = pf.generate_poi_frames(bpy.context.scene.tp3d, [map_obj])
    assert any("overlap" in w for w in warnings), warnings


# ---------------------------------------------------------------------------
# Tests: Map Generator glue
# ---------------------------------------------------------------------------

class _Overlay:
    """Stand-in for the progress overlay apply_picker_result() reports to."""

    def __init__(self):
        self.steps = []

    def update(self, *args):
        pass

    def add_completed_step(self, text):
        self.steps.append(text)


def test_store_picker_pois():
    tp3d = bpy.context.scene.tp3d
    pf.store_picker_pois(tp3d, [
        {"name": "Auto", "lat": 47.4, "lon": 10.2, "angle": None, "enabled": True},
        {"name": "Dragged", "lat": 47.41, "lon": 10.21, "angle": 270, "enabled": False},
        {"name": "Broken", "lat": "north", "lon": 10.2},
    ], {"textSize": 5})
    assert [p.name for p in tp3d.pois] == ["Auto", "Dragged"], [p.name for p in tp3d.pois]
    auto, dragged = tp3d.pois
    assert auto.direction == "AUTO" and auto.enabled
    assert dragged.direction == "CUSTOM" and abs(dragged.angle - (-90)) < 1e-6 and not dragged.enabled
    assert abs(tp3d.poi_labelSize - 5) < 1e-6, "edited setting applied"
    assert abs(tp3d.poi_frameWall - 1.0) < 1e-6, "unedited settings untouched"


def test_poi_state_for_picker_round_trip():
    tp3d = bpy.context.scene.tp3d
    _add_poi("Auto", 0, 0)
    _add_poi("Custom", 5, 5, "CUSTOM", 45)
    state = pf.poi_state_for_picker(tp3d)
    assert [p["angle"] for p in state["pois"]] == [None, 45], state["pois"]
    assert state["settings"]["textSize"] == tp3d.poi_labelSize
    before = [(p.name, round(p.lat, 9), round(p.lon, 9), p.direction) for p in tp3d.pois]
    pf.store_picker_pois(tp3d, state["pois"])
    after = [(p.name, round(p.lat, 9), round(p.lon, 9), p.direction) for p in tp3d.pois]
    assert before == after, (before, after)


def test_apply_picker_result_without_pois_key():
    _add_poi("Keep me", 0, 0)
    built = pf.apply_picker_result(bpy.context, {"bounds": {}}, [], _Overlay(), 0.5)
    assert built == [] and len(bpy.context.scene.tp3d.pois) == 1, "older pages must not clear the list"


def test_apply_picker_result_empty_list_clears():
    _add_poi("Deleted in the page", 0, 0)
    built = pf.apply_picker_result(bpy.context, {"pois": [], "poiFrame": True}, [], _Overlay(), 0.5)
    assert built == [] and len(bpy.context.scene.tp3d.pois) == 0


def test_apply_picker_result_frame_off():
    map_obj = _make_map()
    lat, lon = _latlon(_CX, _CY)
    data = {"pois": [{"name": "Centre", "lat": lat, "lon": lon, "angle": None}], "poiFrame": False}
    built = pf.apply_picker_result(bpy.context, data, [map_obj], _Overlay(), 0.5)
    assert built == [] and len(bpy.context.scene.tp3d.pois) == 1


def test_apply_picker_result_poi_only_send():
    _make_map()
    lat, lon = _latlon(_CX - 10, _CY + 5)
    data = {"pois": [{"name": "Centre", "lat": lat, "lon": lon, "angle": None}], "poiFrame": True}
    overlay = _Overlay()
    built = pf.apply_picker_result(bpy.context, data, [], overlay, 0.5)  # no new map: label the scene's
    assert [f.name for f in built] == ["Rectangle_POI_Frame"], built
    assert overlay.steps, "progress step reported"


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    _run("generate: frame + text built", test_builds_frame_and_text)
    _run("generate: watertight, BLACK frame / WHITE text", test_watertight_and_one_colour_each)
    _run("generate: printable (45°, text supported) at 2.5/3.75/6 mm", test_printable_at_several_text_sizes)
    _run("generate: rests on the terrain without cutting into it", test_frame_rests_on_terrain)
    _run("generate: linked to its map and its generation", test_linked_to_map_and_generation)
    _run("generate: rebuild replaces the previous frame", test_rebuild_replaces_previous_frame)
    _run("generate: one frame per map with POIs", test_two_maps_each_get_their_own_frame)

    _run("warnings: no enabled POIs", test_no_enabled_pois)
    _run("warnings: POI outside the map ignored", test_poi_outside_map_is_ignored)
    _run("warnings: POI on the frame skipped", test_poi_on_frame_is_skipped)
    _run("warnings: overlapping labels", test_overlapping_labels_warn)

    _run("picker: store_picker_pois", test_store_picker_pois)
    _run("picker: poi_state_for_picker round trip", test_poi_state_for_picker_round_trip)
    _run("picker: page without POIs keeps the list", test_apply_picker_result_without_pois_key)
    _run("picker: empty POI list clears", test_apply_picker_result_empty_list_clears)
    _run("picker: frame unticked builds nothing", test_apply_picker_result_frame_off)
    _run("picker: POI-only send labels the scene's maps", test_apply_picker_result_poi_only_send)

    _assert_all_passed()
