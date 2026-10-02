"""Tests for export.py: default file name, export folder memory, plain 3MF.

Covers:
  - default_export_name() — "TrailPrint3D-export-<date>_<time>", used when
    neither an export name nor a GPX file gives one
  - remember_export_dir() / last_export_dir() / resolve_export_path() /
    prefill_export_path() — the last export folder is remembered (in a
    temporary settings file here, never the user's real one)
  - export_selected_to_3mf() — without a slicer profile it asks the 3MF
    addon for a spec-compliant 3MF (no printer/filament data), keeping the
    colours. Checked with a stand-in 3MF API, and -- if the 3MF extension
    is installed -- once more on a real exported file.

Run with:
  blender --background --factory-startup --python-exit-code 1 -P tests/test_export.py
  or, as part of the full suite:
  & "C:\Program Files\Blender Foundation\Blender 5.1\blender.exe" --background --factory-startup --python-exit-code 1 -P tests/run_all_tests.py
"""  # noqa: W605

import os
import re
import shutil
import sys
import tempfile
import traceback
import zipfile

import addon_utils  # type: ignore
import bpy  # type: ignore  — provided by Blender's Python

# ---------------------------------------------------------------------------
# Path setup — makes TrailPrint3D importable as a package from source
# ---------------------------------------------------------------------------
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

if "TrailPrint3D" not in bpy.context.preferences.addons:
    bpy.ops.preferences.addon_enable(module="TrailPrint3D")

from TrailPrint3D import export
from TrailPrint3D.utils.primitives import setupColors

# ---------------------------------------------------------------------------
# Minimal test runner (matches the pattern used by the other tests/*.py files)
# ---------------------------------------------------------------------------
_passed = 0
_failed = 0
_skipped = 0


class _Skip(Exception):
    pass


def _run(name, fn):
    global _passed, _failed, _skipped
    _reset()
    try:
        fn()
        print(f"  PASS  {name}")
        _passed += 1
    except _Skip as e:
        print(f"  SKIP  {name} - {e}")
        _skipped += 1
    except Exception as e:  # noqa: BLE001 - wide exception needeed to keep test runner going
        print(f"  FAIL  {name} - exception occurred: {e}")
        traceback.print_exc()
        _failed += 1


def _assert_all_passed():
    print(f"\n{'='*60}")
    print(f"  {_passed} passed, {_failed} failed" + (f" ({_skipped} skipped)" if _skipped else ""))
    print(f"{'='*60}\n")
    if _failed:
        raise SystemExit(1)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
_TMP = tempfile.mkdtemp(prefix="tp3d_test_export_")
_SETTINGS = os.path.join(_TMP, "TP3D-settings.json")
_OUT = os.path.join(_TMP, "out", "")
# Never read or write the user's real settings file.
export._settings_file = lambda: _SETTINGS

_DEFAULT_NAME = re.compile(r"^TrailPrint3D-export-\d{4}-\d{2}-\d{2}_\d{4}$")


def _reset():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    shutil.rmtree(_OUT, ignore_errors=True)
    os.makedirs(_OUT)
    tp3d = bpy.context.scene.tp3d
    tp3d.export_path = _OUT
    tp3d.modelname = ""
    tp3d.tex_use_texture = False
    tp3d.slicer_profile_name = "NONE"
    # Last: setting export_path above already remembers it.
    if os.path.exists(_SETTINGS):
        os.remove(_SETTINGS)


def _coloured_cubes():
    """Two selected cubes, one BASE and one BLACK, like a map + its frame."""
    setupColors()
    objs = []
    for i, mat in enumerate(("BASE", "BLACK")):
        bpy.ops.mesh.primitive_cube_add(size=10, location=(i * 20, 0, 5))
        obj = bpy.context.active_object
        obj.name = f"Part_{mat}"
        obj.data.materials.append(bpy.data.materials[mat])
        objs.append(obj)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objs:
        obj.select_set(True)
    return objs


class _FakeResult:
    status = "FINISHED"
    warnings = []


class _Fake3MF:
    """Stand-in for the 3MF addon's API: records what it was asked to do."""

    def __init__(self):
        self.calls = []

    def export_3mf(self, **kwargs):
        self.calls.append(kwargs)
        return _FakeResult()


def _with_fake_api(fn):
    fake = _Fake3MF()
    real = export.get_threemf_api
    export.get_threemf_api = lambda: fake
    try:
        fn()
    finally:
        export.get_threemf_api = real
    return fake


def _real_3mf_available():
    if export.get_threemf_api() is not None:
        return True
    for module in ("bl_ext.blender_org.ThreeMF_io", "io_mesh_3mf"):
        try:
            addon_utils.enable(module, default_set=True)
        except Exception:  # noqa: BLE001 - not installed under this name
            continue
    from TrailPrint3D import threemf_discovery
    threemf_discovery._cached_api = None
    return export.get_threemf_api() is not None


# ---------------------------------------------------------------------------
# Tests: names and folders
# ---------------------------------------------------------------------------

def test_default_export_name_format():
    name = export.default_export_name()
    assert _DEFAULT_NAME.match(name), name
    assert export._sanitize_filename(name) == name, "safe as a file name as is"


def test_remember_and_resolve_export_dir():
    tp3d = bpy.context.scene.tp3d
    assert export.last_export_dir() == ""
    export.remember_export_dir(_TMP)
    assert export.last_export_dir() == os.path.join(_TMP, ""), export.last_export_dir()
    tp3d.export_path = ""
    assert export.resolve_export_path(tp3d) == os.path.join(_TMP, ""), "falls back to the last folder"
    tp3d.export_path = _OUT
    assert export.resolve_export_path(tp3d) == _OUT, "the scene's own folder wins"


def test_picking_a_folder_remembers_it():
    bpy.context.scene.tp3d.export_path = _TMP
    assert export.last_export_dir() == os.path.join(_TMP, ""), export.last_export_dir()


def test_missing_folder_is_not_remembered():
    export.remember_export_dir(os.path.join(_TMP, "does-not-exist"))
    assert export.last_export_dir() == ""
    export.remember_export_dir(_TMP)
    shutil.rmtree(_TMP + "_gone", ignore_errors=True)
    os.makedirs(_TMP + "_gone")
    export.remember_export_dir(_TMP + "_gone")
    os.rmdir(_TMP + "_gone")
    assert export.last_export_dir() == "", "a folder deleted since is not offered"


def test_prefill_export_path():
    tp3d = bpy.context.scene.tp3d
    export.remember_export_dir(_TMP)
    tp3d.export_path = ""
    export.prefill_export_path(bpy.context.scene)
    assert tp3d.export_path == os.path.join(_TMP, ""), tp3d.export_path
    tp3d.export_path = _OUT
    export.prefill_export_path(bpy.context.scene)
    assert tp3d.export_path == _OUT, "an existing setting is not overwritten"


# ---------------------------------------------------------------------------
# Tests: 3MF export
# ---------------------------------------------------------------------------

def test_3mf_plain_by_default():
    _coloured_cubes()
    fake = _with_fake_api(export.export_selected_to_3mf)
    assert len(fake.calls) == 1, fake.calls
    kwargs = fake.calls[0]
    assert kwargs["use_orca_format"] == "STANDARD", f"printer data would be embedded: {kwargs['use_orca_format']}"
    if "slicer_profile" in kwargs:
        assert kwargs["slicer_profile"] == "NONE", kwargs["slicer_profile"]
    assert not bpy.context.scene.objects.get("Part_BASE.001"), "export duplicates cleaned up"


def test_3mf_default_file_name():
    _coloured_cubes()
    fake = _with_fake_api(export.export_selected_to_3mf)
    path = fake.calls[0]["filepath"]
    assert os.path.dirname(path) == os.path.dirname(_OUT), path
    stem = os.path.splitext(os.path.basename(path))[0]
    assert _DEFAULT_NAME.match(stem), f"no name given -> default name, got {stem!r}"


def test_3mf_model_name_wins():
    _coloured_cubes()
    bpy.context.scene.tp3d.modelname = "Oberstdorf"
    fake = _with_fake_api(export.export_selected_to_3mf)
    assert os.path.basename(fake.calls[0]["filepath"]) == "Oberstdorf.3mf", fake.calls[0]["filepath"]
    fake = _with_fake_api(lambda: export.export_selected_to_3mf("Explicit"))
    assert os.path.basename(fake.calls[0]["filepath"]) == "Explicit.3mf", fake.calls[0]["filepath"]


def test_real_3mf_plain_with_colours():
    if not _real_3mf_available():
        raise _Skip("3MF extension not installed")
    _coloured_cubes()
    bpy.context.scene.tp3d.modelname = "plain"
    export.export_selected_to_3mf()
    path = os.path.join(_OUT, "plain.3mf")
    assert os.path.isfile(path), os.listdir(_OUT)
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        model = z.read("3D/3dmodel.model").decode("utf-8")
    assert not [n for n in names if n.startswith("Metadata/")], f"printer/project data embedded: {names}"
    colours = set(re.findall(r'<base name="(\w+)"', model))
    assert {"BASE", "BLACK"} <= colours, f"colours lost: {colours}"


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    try:
        _run("default_export_name: format", test_default_export_name_format)
        _run("export folder: remembered and resolved", test_remember_and_resolve_export_dir)
        _run("export folder: picking one in the panel remembers it", test_picking_a_folder_remembers_it)
        _run("export folder: missing folder not remembered", test_missing_folder_is_not_remembered)
        _run("export folder: prefill_export_path", test_prefill_export_path)

        _run("3mf: plain (STANDARD) without a slicer profile", test_3mf_plain_by_default)
        _run("3mf: default file name", test_3mf_default_file_name)
        _run("3mf: model name / explicit name win", test_3mf_model_name_wins)
        _run("3mf: real export has no printer data, keeps colours", test_real_3mf_plain_with_colours)
    finally:
        shutil.rmtree(_TMP, ignore_errors=True)

    _assert_all_passed()
