"""Pre-fetch Curiosity's ground photos for the named study sites, so the first click on them is instant.

The backend fetches photos for any other stop on demand and caches them in the same place (data/photos).

Usage:  python backend/pipeline/build_photos.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA  # noqa: E402  (also puts the backend folder on the import path)

from app.photos import PhotoService  # noqa: E402


def main() -> None:
    rover = json.loads((DATA / "rover.json").read_text(encoding="utf-8"))
    service = PhotoService(DATA, rover["stops"])
    for site in rover["sites"]:
        result = service.near(site["lat"], site["lon"])
        stop = result["stop"] or {}
        print(f"{site['name']}: {len(result['photos'])} photos from sol {stop.get('sol')} "
              f"({result['distance_m']} m away){' - ' + result['error'] if result['error'] else ''}", flush=True)


if __name__ == "__main__":
    main()
