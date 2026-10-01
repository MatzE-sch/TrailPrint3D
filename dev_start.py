# Dev launcher: starts a normal (GUI) Blender session with TrailPrint3D loaded
# straight from this git checkout -- no build, no install, no zip.
#
#   blender --python dev_start.py
#
# Press F8 in any Blender window to re-load the addon after editing a file.
# Set TP3D_AUTORELOAD=1 to also reload automatically whenever a .py in the
# addon changes on disk.
#
# Why not the Extensions system: blender_manifest.toml pins cp313 wheels, so
# Blender builds running Python 3.14 (e.g. Manjaro's 5.2) refuse to enable the
# extension. This loads the package as a plain legacy addon instead; relative
# imports and __package__ lookups behave identically. Compiled dependencies
# (shapely, numpy) come from whatever Blender's Python already provides; the
# pure-Python wheels bundled in TrailPrint3D/wheels/ (e.g. pyshp) are put on
# sys.path straight from the .whl files.
#
# premium/ is a separate (private) git checkout at the repo root, linked into
# the package as TrailPrint3D/premium -- see _ensure_premium_link().

import glob
import os
import sys
import importlib
import zipfile

import bpy
import addon_utils

REPO = os.path.dirname(os.path.abspath(__file__))
ADDON = "TrailPrint3D"
ADDON_DIR = os.path.join(REPO, ADDON)


def _ensure_premium_link():
    """premium/ lives at the repo root but must be importable as
    TrailPrint3D.premium for register() to detect it."""
    link = os.path.join(ADDON_DIR, "premium")
    src = os.path.join(REPO, "premium")
    if os.path.exists(link) or not os.path.isdir(src):
        return
    try:
        os.symlink(os.path.relpath(src, ADDON_DIR), link)
        print(f"[dev] linked {link} -> ../premium")
    except OSError as e:
        print(f"[dev] could not link premium/: {e}")


def _add_pure_wheels():
    """Make the bundled pure-Python wheels importable (zipimport). Wheels that
    carry native modules are skipped -- e.g. shapelysmooth's is tagged
    py3-none-any but only contains a Windows .pyd."""
    for whl in sorted(glob.glob(os.path.join(ADDON_DIR, "wheels", "*-py3-none-any.whl"))):
        if whl in sys.path:
            continue
        try:
            names = zipfile.ZipFile(whl).namelist()
        except (OSError, zipfile.BadZipFile) as e:
            print(f"[dev] skipping unreadable wheel {os.path.basename(whl)}: {e}")
            continue
        if any(n.endswith((".so", ".pyd", ".dll", ".dylib")) for n in names):
            continue
        sys.path.append(whl)
        print(f"[dev] using wheel {os.path.basename(whl)}")


def load():
    if REPO not in sys.path:
        sys.path.insert(0, REPO)
    _add_pure_wheels()
    _ensure_premium_link()
    addon_utils.enable(ADDON, default_set=True, persistent=True)


def reload():
    """Full reload: unregister, drop every addon module from sys.modules, re-import."""
    try:
        addon_utils.disable(ADDON, default_set=False)
    except Exception as e:                                    # noqa: BLE001
        print(f"[dev] unregister raised (continuing): {e}")

    for name in [n for n in list(sys.modules)
                 if n == ADDON or n.startswith(ADDON + ".")]:
        del sys.modules[name]
    importlib.invalidate_caches()

    addon_utils.enable(ADDON, default_set=True, persistent=True)
    print("[dev] TrailPrint3D reloaded")


class TP3D_OT_dev_reload(bpy.types.Operator):
    bl_idname = "tp3d.dev_reload"
    bl_label = "Reload TrailPrint3D (dev)"

    def execute(self, context):
        reload()
        for win in context.window_manager.windows:
            for area in win.screen.areas:
                area.tag_redraw()
        self.report({'INFO'}, "TrailPrint3D reloaded")
        return {'FINISHED'}


# --- optional file watcher -------------------------------------------------

_mtimes = {}


def _scan():
    stamps = {}
    for root, dirs, files in os.walk(ADDON_DIR, followlinks=True):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for f in files:
            if f.endswith(".py"):
                p = os.path.join(root, f)
                try:
                    stamps[p] = os.path.getmtime(p)
                except OSError:
                    pass
    return stamps


def _watch():
    global _mtimes
    stamps = _scan()
    if stamps != _mtimes:
        _mtimes = stamps
        reload()
    return 1.0


def main():
    # Never write this dev-only addon entry into the real user preferences.
    bpy.context.preferences.use_preferences_save = False

    load()

    kc = bpy.context.window_manager.keyconfigs.addon or \
         bpy.context.window_manager.keyconfigs.active
    if kc:
        km = kc.keymaps.new(name="Window", space_type='EMPTY')
        km.keymap_items.new(TP3D_OT_dev_reload.bl_idname, 'F8', 'PRESS')

    print(f"[dev] TrailPrint3D loaded from {ADDON_DIR} -- press F8 to reload")

    if os.environ.get("TP3D_AUTORELOAD") == "1":
        global _mtimes
        _mtimes = _scan()
        bpy.app.timers.register(_watch, first_interval=1.0, persistent=True)
        print("[dev] auto-reload on file change: ON")


bpy.utils.register_class(TP3D_OT_dev_reload)
main()
