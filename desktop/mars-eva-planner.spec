# PyInstaller recipe for the desktop app. From the repository root, after `npm run build` in frontend:
#     desktop/.venv/Scripts/pyinstaller desktop/mars-eva-planner.spec --noconfirm
# Windows: dist/MarsEVAPlanner.exe, a single file.   macOS: dist/Mars EVA Planner.app
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules, copy_metadata

ROOT = Path(SPECPATH).parent
BACKEND = ROOT / "backend"
DATA = BACKEND / "data"
WEB = ROOT / "frontend" / "dist"
if not (WEB / "index.html").exists():
    sys.exit("Build the frontend first: run `npm run build` in the frontend folder.")

# Only what the running app reads: not the pipeline's raw downloads in data/cache.
datas = [(str(DATA / name), "data") for name in ("terrain.npz", "terrain.json", "rover.json", "weather.json", "radiation.json",
                                                  "forecast_check.json")]
datas += [(str(DATA / "overlays"), "data/overlays"), (str(DATA / "photos"), "data/photos"), (str(WEB), "web")]
# The libraries' licence files travel with the app, as their licences ask.
for package in ("numpy", "scipy", "contourpy", "fastapi", "starlette", "pydantic", "uvicorn", "pywebview"):
    datas += copy_metadata(package)

a = Analysis(
    [str(ROOT / "desktop" / "launcher.py")],
    pathex=[str(BACKEND)],
    datas=datas,
    hiddenimports=["app.main", "app.local_server"] + collect_submodules("uvicorn"),  # uvicorn loads its parts by name
    excludes=["tkinter", "imagecodecs", "matplotlib", "IPython", "pytest", "PIL"],
)
pyz = PYZ(a.pure)
icon = str(ROOT / "desktop" / "icon.png")  # converted to .ico or .icns by PyInstaller (needs Pillow)

if sys.platform == "darwin":
    exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="Mars EVA Planner", console=False, icon=icon)
    collected = COLLECT(exe, a.binaries, a.datas, name="Mars EVA Planner")
    app = BUNDLE(
        collected,
        name="Mars EVA Planner.app",
        icon=icon,
        bundle_identifier="org.marsexplorer.evaplanner",
        info_plist={
            "CFBundleShortVersionString": "1.1.1",
            "NSHighResolutionCapable": True,
            "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},  # the window talks to http://127.0.0.1
        },
    )
else:
    exe = EXE(pyz, a.scripts, a.binaries, a.datas, [], name="MarsEVAPlanner", console=False, icon=icon, upx=False)
