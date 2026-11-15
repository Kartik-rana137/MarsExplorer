"""Starts the planner's backend inside the Android app. Called by MainActivity.java.

The build (android/app/build.gradle.kts) puts the backend package `app`, its data and the built frontend next to this
file. Chaquopy unpacks the data and the frontend on first start; they are read-only, so new photo lists are saved
under the app's private folder instead.
"""
from __future__ import annotations

import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
PORT = 41801  # the same each time, so the page's saved settings (kept per address) survive a restart


def start() -> str:
    """Start the backend (once) and return the address the app's web view should open."""
    os.environ.setdefault("MARS_EVA_DATA_DIR", str(HERE / "data"))
    os.environ.setdefault("MARS_EVA_FRONTEND_DIST", str(HERE / "web"))
    os.environ.setdefault("MARS_EVA_CACHE_DIR", str(Path(os.environ["HOME"]) / "cache"))
    from app.local_server import start_in_background

    return start_in_background(PORT)
