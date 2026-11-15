"""Mars EVA Planner as a desktop app for Windows and macOS.

Runs the planner's backend on this computer and shows the planner in its own window. PyInstaller packs this file, the
backend, its data and the built frontend into one app (see mars-eva-planner.spec). To try it from the repository
without packing, build the frontend first (`npm run build` in frontend), then run:
    desktop/.venv/Scripts/python desktop/launcher.py        (macOS: desktop/.venv/bin/python)
With --check it opens no window: it plans the default walk, prints the verdict and exits (0 if all went well).
"""
from __future__ import annotations

import json
import os
import sys
import traceback
from html import escape
from pathlib import Path
from urllib.request import Request, urlopen

import webview

APP_NAME = "Mars EVA Planner"
PORT = 41801  # the same each time, so the page's saved settings (kept per address) survive a restart
FROZEN = getattr(sys, "frozen", False)


def bundle_paths() -> tuple[Path, Path, Path]:
    """Where the backend code, its data and the built frontend are."""
    if FROZEN:
        root = Path(sys._MEIPASS)  # set by PyInstaller
        return root, root / "data", root / "web"
    repo = Path(__file__).resolve().parents[1]
    return repo / "backend", repo / "backend" / "data", repo / "frontend" / "dist"


def user_folder() -> Path:
    """A writable folder for the window's saved settings, downloaded photo lists and the log."""
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    folder = base / APP_NAME
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def page(title: str, text: str) -> str:
    """The plain page shown while the backend loads, or if it cannot start."""
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>
      html, body {{ height: 100%; margin: 0; background: #1c1412; color: #f3e6dc;
                   font: 15px/1.5 "Segoe UI", -apple-system, system-ui, sans-serif; }}
      body {{ display: grid; place-items: center; text-align: center; }}
      .planet {{ width: 72px; height: 72px; margin: 0 auto 20px; border-radius: 50%;
                 background: radial-gradient(circle at 35% 35%, #e0622a, #c1440e 55%, #7a2a08); }}
      h1 {{ font-size: 20px; font-weight: 600; margin: 0 0 6px; }}
      p {{ margin: 0; color: #c9b3a5; max-width: 520px; white-space: pre-wrap; }}
    </style></head><body><div><div class="planet"></div><h1>{escape(title)}</h1><p>{escape(text)}</p></div></body></html>"""


def boot(window: webview.Window, web: Path) -> None:
    """Runs once the window is open: start the backend, then show the planner."""
    try:
        if not (web / "index.html").exists():
            raise RuntimeError(f"The built frontend is missing from {web}.\nRun `npm run build` in the frontend folder.")
        from app.local_server import start_in_background

        window.load_url(start_in_background(PORT))
    except Exception as error:
        traceback.print_exc()
        window.load_html(page("The planner could not start", str(error)))


def self_check() -> None:
    """--check: start the packed backend, plan the default walk and fetch the page, without opening a window."""
    from app.local_server import start_in_background

    url = start_in_background(0)
    site = json.load(urlopen(url + "api/site", timeout=60))
    camp = {"lat": site["default_camp"]["lat"], "lon": site["default_camp"]["lon"]}
    body = json.dumps({"camp": camp, "stops": site["default_stops"]}).encode()
    request = Request(url + "api/plan", data=body, headers={"Content-Type": "application/json"})
    plan = json.load(urlopen(request, timeout=120))
    page_ok = b"Mars EVA Planner" in urlopen(url, timeout=60).read()
    heights_ok = urlopen(url + site["elevation_grid"]["url"].lstrip("/"), timeout=60).status == 200
    print(f"verdict: {plan['verdict']}; walk {plan['route']['totals']['dist_m']} m; page: {page_ok}; drive grid: {heights_ok}")
    if not (page_ok and heights_ok and plan["verdict"] in ("go", "marginal", "no-go")):
        raise SystemExit(1)


def main() -> None:
    backend, data, web = bundle_paths()
    if not FROZEN:
        sys.path.insert(0, str(backend))
    home = user_folder()
    if sys.stdout is None or (FROZEN and sys.platform == "win32"):  # no console to show it: keep the log in a file
        sys.stdout = sys.stderr = open(home / "log.txt", "w", encoding="utf-8", buffering=1)
    os.environ.setdefault("MARS_EVA_DATA_DIR", str(data))
    os.environ.setdefault("MARS_EVA_FRONTEND_DIST", str(web))
    os.environ.setdefault("MARS_EVA_CACHE_DIR", str(home / "cache"))
    if "--check" in sys.argv:
        self_check()
        return

    webview.settings["ALLOW_DOWNLOADS"] = True  # saving a route file
    window = webview.create_window(APP_NAME, html=page(APP_NAME, "Loading the terrain…"), width=1440, height=900,
                                   min_size=(960, 640), background_color="#1c1412", text_select=True)
    webview.start(boot, (window, web), private_mode=False, storage_path=str(home / "window"))


if __name__ == "__main__":
    main()
