"""Fetch Curiosity's daily weather record (REMS instrument) for Gale Crater.

Output: backend/data/weather.json  (one entry per sol, stored column-wise)
Usage:  python backend/pipeline/build_weather.py
"""
from __future__ import annotations

import datetime
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, http_json, write_json  # noqa: E402

FEED_URL = "https://mars.nasa.gov/rss/api/?feed=weather&category=msl&feedtype=json"


def number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def clock_minutes(value):
    """'06:46' -> 406 (minutes after local midnight on the 24-hour Mars clock)."""
    try:
        hours, minutes = str(value).split(":")[:2]
        return int(hours) * 60 + int(minutes)
    except (ValueError, AttributeError):
        return None


def main() -> None:
    records = http_json(FEED_URL, timeout=180)["soles"]
    records.sort(key=lambda r: int(r["sol"]))
    columns = {
        "sol": [int(r["sol"]) for r in records],
        "date": [r.get("terrestrial_date") for r in records],
        "ls": [number(r.get("ls")) for r in records],                 # solar longitude: position in the Mars year
        "air_min_c": [number(r.get("min_temp")) for r in records],
        "air_max_c": [number(r.get("max_temp")) for r in records],
        "ground_min_c": [number(r.get("min_gts_temp")) for r in records],
        "ground_max_c": [number(r.get("max_gts_temp")) for r in records],
        "pressure_pa": [number(r.get("pressure")) for r in records],
        "uv": [r.get("local_uv_irradiance_index") if r.get("local_uv_irradiance_index") not in (None, "--") else None for r in records],
        "sky": [r.get("atmo_opacity") if r.get("atmo_opacity") not in (None, "--") else None for r in records],
        "sunrise_min": [clock_minutes(r.get("sunrise")) for r in records],
        "sunset_min": [clock_minutes(r.get("sunset")) for r in records],
    }
    out = {
        "source": "NASA/JPL-Caltech/CAB, Curiosity REMS daily weather report",
        "source_url": FEED_URL,
        "fetched": datetime.date.today().isoformat(),
        "note": "Times are local Mars clock times; one Mars clock hour is 1/24 of a sol (61.65 Earth minutes).",
        **columns,
    }
    write_json(DATA / "weather.json", out)
    sols = columns["sol"]
    have_temp = sum(v is not None for v in columns["air_min_c"])
    print(f"{len(sols)} sols ({sols[0]}..{sols[-1]}, {columns['date'][0]} to {columns['date'][-1]}); "
          f"air temperature on {have_temp}; sunrise on {sum(v is not None for v in columns['sunrise_min'])}")


if __name__ == "__main__":
    main()
