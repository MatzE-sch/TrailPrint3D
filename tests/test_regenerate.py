"""Unit tests for utils/regenerate.py -- regenerating replaces the previous result.

Covers:
  - tag_generated() / is_unmoved() — generation tag + transform snapshot
  - replace_previous() — an unmoved, overlapping earlier generation is
    removed (all of its unmoved objects); moved results, adjacent tiles
    (Extend mode) and only-slightly-overlapping maps are kept
  - _strip_suffixes() — "Rectangle.001" -> "Rectangle", derived names
    ("Rectangle.001_POI_Frame") and poiMap references follow
  - replacing_previous_generation() — nothing is replaced if the run raises

No network, no terrain: maps are flat boxes tagged as MAP objects.

Run with:
  blender --background --factory-startup --python-exit-code 1 -P tests/test_regenerate.py
  or, as part of the full suite:
  & "C:\Program Files\Blender Foundation\Blender 5.1\blender.exe" --background --factory-startup --python-exit-code 1 -P tests/run_all_tests.py
"""  # noqa: W605

import os
import sys
import traceback

import bpy  # type: ignore  — provided by Blender's Python

# ---------------------------------------------------------------------------
# Path setup — makes TrailPrint3D importable as a package from source
# ---------------------------------------------------------------------------
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

if "TrailPrint3D" not in bpy.context.preferences.addons:
    bpy.ops.preferences.addon_enable(module="TrailPrint3D")

from TrailPrint3D.utils import regenerate

# ---------------------------------------------------------------------------
# Minimal test runner (matches the pattern used by the other tests/*.py files)
# ---------------------------------------------------------------------------
_passed = 0
_failed = 0


def _run(name, fn):
    global _passed, _failed
    _clear_scene()
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
# Scene helpers
# ---------------------------------------------------------------------------

def _clear_scene():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)


def _box(name, x0, y0, x1, y1, obj_type="MAP"):
    """A flat box mesh object covering x0..x1 / y0..y1 (world space)."""
    verts = [(x0, y0, 0), (x1, y0, 0), (x1, y1, 0), (x0, y1, 0),
             (x0, y0, 1), (x1, y0, 1), (x1, y1, 1), (x0, y1, 1)]
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    if obj_type:
        obj["Object type"] = obj_type
    bpy.context.view_layer.update()
    return obj


def _generation(*objs):
    """Tag *objs* as one finished generation (what a run leaves behind)."""
    return regenerate.replace_previous(list(objs))


def _names():
    return sorted(o.name for o in bpy.data.objects)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_tag_and_is_unmoved():
    obj = _box("Map", 0, 0, 10, 10)
    assert not regenerate.is_unmoved(obj), "untagged object counts as moved"
    regenerate.tag_generated(obj, "gen")
    assert obj[regenerate.GEN_ID] == "gen"
    assert regenerate.is_unmoved(obj)
    obj.location.x += 0.5
    bpy.context.view_layer.update()
    assert not regenerate.is_unmoved(obj), "a nudged object counts as moved"


def test_overlapping_unmoved_generation_is_replaced():
    old_map = _box("Rectangle", 0, 0, 100, 100)
    old_trail = _box("Trail", 10, 10, 20, 20, obj_type="TRAIL")
    _generation(old_map, old_trail)
    new_map = _box("Rectangle.001", 5, 5, 105, 105)
    removed = _generation(new_map)
    assert removed == 2, f"expected map + trail removed, got {removed}"
    assert _names() == ["Rectangle"], _names()
    assert new_map.name == "Rectangle", "suffix stripped once the original is gone"


def test_moved_map_is_kept():
    old_map = _box("Rectangle", 0, 0, 100, 100)
    old_trail = _box("Trail", 10, 10, 20, 20, obj_type="TRAIL")
    _generation(old_map, old_trail)
    old_map.location.x += 0.01  # nudged: user wants to keep it
    bpy.context.view_layer.update()
    removed = _generation(_box("Rectangle.001", 0, 0, 100, 100))
    assert removed == 0, f"moved map must not be replaced, removed {removed}"
    assert "Rectangle" in bpy.data.objects and "Trail" in bpy.data.objects
    assert "Rectangle.001" in bpy.data.objects, "no rename while the original exists"


def test_moved_member_of_replaced_generation_is_kept():
    old_map = _box("Rectangle", 0, 0, 100, 100)
    old_trail = _box("Trail", 10, 10, 20, 20, obj_type="TRAIL")
    _generation(old_map, old_trail)
    old_trail.location.z += 5
    bpy.context.view_layer.update()
    removed = _generation(_box("Rectangle.001", 0, 0, 100, 100))
    assert removed == 1, f"only the unmoved map goes, removed {removed}"
    assert "Trail" in bpy.data.objects


def test_adjacent_tile_is_kept():
    _generation(_box("Tile", 0, 0, 100, 100))
    removed = _generation(_box("Tile.001", 100, 0, 200, 100))
    assert removed == 0, f"edge-sharing neighbour must stay, removed {removed}"
    assert _names() == ["Tile", "Tile.001"], _names()


def test_small_overlap_is_kept():
    _generation(_box("A", 0, 0, 100, 100))
    # 30 % of the smaller map's footprint < _OVERLAP_SHARE
    removed = _generation(_box("B", 70, 0, 170, 100))
    assert removed == 0, f"neighbours overlapping a little must stay, removed {removed}"


def test_generation_without_map_replaces_nothing():
    _generation(_box("Rectangle", 0, 0, 100, 100))
    removed = _generation(_box("Trail", 0, 0, 100, 100, obj_type="TRAIL"))
    assert removed == 0
    assert "Rectangle" in bpy.data.objects


def test_derived_names_follow_rename():
    old_map = _box("Rectangle", 0, 0, 100, 100)
    old_frame = _box("Rectangle_POI_Frame", 0, 0, 100, 100, obj_type="POI_FRAME")
    old_frame["poiMap"] = "Rectangle"
    _generation(old_map, old_frame)
    new_map = _box("Rectangle.001", 0, 0, 100, 100)
    new_frame = _box("Rectangle.001_POI_Frame", 0, 0, 100, 100, obj_type="POI_FRAME")
    new_frame["poiMap"] = "Rectangle.001"
    new_text = _box("Rectangle.001_POI_Text", 0, 0, 100, 100, obj_type="POI_TEXT")
    new_text["poiMap"] = "Rectangle.001"
    removed = _generation(new_map, new_frame, new_text)
    assert removed == 2, removed
    assert _names() == ["Rectangle", "Rectangle_POI_Frame", "Rectangle_POI_Text"], _names()
    assert new_frame["poiMap"] == "Rectangle" and new_text["poiMap"] == "Rectangle"


def test_context_manager_replaces_previous():
    with regenerate.replacing_previous_generation():
        _box("Rectangle", 0, 0, 100, 100)
    with regenerate.replacing_previous_generation():
        _box("Rectangle", 0, 0, 100, 100)  # becomes Rectangle.001
    assert _names() == ["Rectangle"], _names()
    assert bpy.data.objects["Rectangle"].get(regenerate.GEN_ID)


def test_context_manager_keeps_previous_on_error():
    with regenerate.replacing_previous_generation():
        _box("Rectangle", 0, 0, 100, 100)
    try:
        with regenerate.replacing_previous_generation():
            _box("Rectangle", 0, 0, 100, 100)
            raise RuntimeError("generation failed")
    except RuntimeError:
        pass
    assert _names() == ["Rectangle", "Rectangle.001"], _names()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    _run("tag_generated / is_unmoved", test_tag_and_is_unmoved)
    _run("replace_previous: overlapping unmoved generation replaced", test_overlapping_unmoved_generation_is_replaced)
    _run("replace_previous: moved map kept", test_moved_map_is_kept)
    _run("replace_previous: moved member of a replaced generation kept", test_moved_member_of_replaced_generation_is_kept)
    _run("replace_previous: adjacent tile kept", test_adjacent_tile_is_kept)
    _run("replace_previous: small overlap kept", test_small_overlap_is_kept)
    _run("replace_previous: generation without a map replaces nothing", test_generation_without_map_replaces_nothing)
    _run("_strip_suffixes: derived names + poiMap follow", test_derived_names_follow_rename)
    _run("replacing_previous_generation: replaces previous run", test_context_manager_replaces_previous)
    _run("replacing_previous_generation: keeps previous on error", test_context_manager_keeps_previous_on_error)

    _assert_all_passed()
