"""Ground photos: what Curiosity saw from the stop nearest to a point.

Photos come from NASA's Curiosity raw image service. Each image record carries the rover position it was
taken from (site and drive counters) and where the camera mast pointed, so photos can be matched to a
stop and labelled with a compass direction. Results are cached on disk under data/photos.
"""
from __future__ import annotations

import json
import math
import threading
import urllib.parse
from pathlib import Path
from urllib.request import Request, urlopen

import numpy as np

API_URL = "https://mars.nasa.gov/api/v1/raw_image_items/"
CAMERAS = {"NAV_LEFT_B": "Navcam", "NAV_RIGHT_B": "Navcam", "MAST_LEFT": "Mastcam"}
COMPASS = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")
SHARPNESS = {"full": 0, "downsampled": 1, "mixed": 2, "subframe": 3}  # preference order of image products
MAX_SOLS_PER_STOP = 3
MARS_RADIUS_M = 3_396_190.0


class PhotoService:
    def __init__(self, data_dir: Path, stops: list[dict]) -> None:
        self.cache_dir = data_dir / "photos"
        self.stops = stops
        self._lat = np.array([s["lat"] for s in stops])
        self._lon = np.array([s["lon"] for s in stops])
        self._lock = threading.Lock()

    def stops_by_distance(self, lat: float, lon: float) -> list[tuple[dict, float]]:
        north = np.radians(self._lat - lat) * MARS_RADIUS_M
        east = np.radians(self._lon - lon) * MARS_RADIUS_M * math.cos(math.radians(lat))
        distance = np.hypot(north, east)
        order = np.argsort(distance)
        return [(self.stops[i], float(distance[i])) for i in order]

    def near(self, lat: float, lon: float, search_m: float = 150.0, max_tries: int = 4) -> dict:
        """Photos from the closest stop that has any, looking at up to `max_tries` stops within `search_m`."""
        ranked = self.stops_by_distance(lat, lon)
        nearest_stop, nearest_distance = ranked[0]
        result = {"stop": None, "distance_m": round(nearest_distance), "photos": [], "error": None}
        for stop, distance in ranked[:max_tries]:
            if distance > max(search_m, nearest_distance):
                break
            try:
                photos = self.for_stop(stop)
            except Exception as error:  # the image service is slow or unreachable
                result["error"] = f"NASA image service unavailable ({type(error).__name__})"
                break
            if photos:
                result.update(stop={k: stop[k] for k in ("sol", "lat", "lon", "elev", "site", "drive")},
                              distance_m=round(distance), photos=photos)
                return result
        if result["stop"] is None:
            result["stop"] = {k: nearest_stop[k] for k in ("sol", "lat", "lon", "elev", "site", "drive")}
        return result

    def for_stop(self, stop: dict) -> list[dict]:
        cache = self.cache_dir / f"{stop['site']}_{stop['drive']}.json"
        if cache.exists():
            return json.loads(cache.read_text(encoding="utf-8"))
        with self._lock:
            if cache.exists():
                return json.loads(cache.read_text(encoding="utf-8"))
            last_sol = stop["sol"] + MAX_SOLS_PER_STOP - 1
            if stop.get("next_sol"):
                last_sol = min(last_sol, max(stop["sol"], stop["next_sol"] - 1))
            items: list[dict] = []
            for instrument in CAMERAS:
                items.extend(self._query(instrument, stop["sol"], last_sol))
            photos = self._select(items, stop["site"], stop["drive"])
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(photos, separators=(",", ":")), encoding="utf-8")
            return photos

    @staticmethod
    def _query(instrument: str, first_sol: int, last_sol: int) -> list[dict]:
        query = urllib.parse.urlencode({
            "order": "date_taken asc", "per_page": 200, "page": 0,
            "condition_1": "msl:mission", "condition_2": f"{first_sol}:sol:gte", "condition_3": f"{last_sol}:sol:lte",
            "search": instrument, "extended": "thumbnail::sample_type::noteq",
        })
        request = Request(f"{API_URL}?{query}", headers={"User-Agent": "Mozilla/5.0 (compatible; eva-planner)"})
        with urlopen(request, timeout=25) as response:
            return json.loads(response.read().decode("utf-8")).get("items", [])

    @staticmethod
    def _select(items: list[dict], site: int, drive: int) -> list[dict]:
        """Pick a spread of views around the compass: sharpest Navcam frame per direction, plus colour Mastcam frames."""
        best: dict[tuple[str, int], tuple[tuple, dict]] = {}
        for item in items:
            camera = CAMERAS.get(item.get("instrument"))
            extended = item.get("extended") or {}
            if camera is None or item.get("site") != site or item.get("drive") != drive or item.get("is_thumbnail"):
                continue
            try:
                azimuth = float(extended["mast_az"]) % 360
                elevation = float(extended["mast_el"])
            except (KeyError, TypeError, ValueError):
                continue
            if not -45 <= elevation <= 20:  # skip shots of the rover deck and of the sky
                continue
            url = item.get("https_url") or item.get("url")
            if not url:
                continue
            sector = int(((azimuth + 22.5) % 360) // 45)
            rank = (SHARPNESS.get(extended.get("sample_type"), 4), abs(elevation + 8))
            photo = {
                "url": url, "camera": camera, "sol": item.get("sol"), "azimuth": round(azimuth),
                "elevation": round(elevation), "compass": COMPASS[sector], "taken_utc": item.get("date_taken"),
            }
            key = (camera, sector)
            if key not in best or rank < best[key][0]:
                best[key] = (rank, photo)
        navcam = [photo for (camera, _), (_, photo) in best.items() if camera == "Navcam"]
        mastcam = [photo for (camera, _), (_, photo) in best.items() if camera == "Mastcam"]
        navcam.sort(key=lambda p: p["azimuth"])
        mastcam.sort(key=lambda p: p["azimuth"])
        return navcam + mastcam[:4]
