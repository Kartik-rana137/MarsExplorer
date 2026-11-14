"""Fetch Curiosity's stops and driven path (NASA/JPL rover location map) and keep the part in the study area.

Output: backend/data/rover.json
Usage:  python backend/pipeline/build_rover.py
"""
from __future__ import annotations

import datetime
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import AOI, DATA, MARS_RADIUS_M, http_json, write_json  # noqa: E402

WAYPOINTS_URL = "https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json"
TRAVERSE_URL = "https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_traverse.json"
LONG_STAY_SOLS = 10  # a stop this long is treated as an investigation site (drilling, detailed study)

# Names of well-documented sites, matched by sol range: (first sol, last sol, name, note, source).
# Taken from NASA's Curiosity mission blog and news releases.
NAMED_SITES = [
    (4558, 4571, "Altadena drill site",
     "Curiosity's first drilled sample in the boxwork region (8 June 2025).",
     "https://www.nasa.gov/missions/mars-science-laboratory/curiosity-rover/nasas-curiosity-mars-rover-starts-unpacking-boxwork-formations"),
    (4687, 4805, "Nevado Sajama & Valle de la Luna",
     "A boxwork ridge top and the hollow beside it, drilled as a pair about 10 m apart (November 2025).",
     "https://science.nasa.gov/blog/curiosity-blog-sols-4709-4715-drilling-high-and-low-in-the-boxwork-unit"),
    (4867, 4912, "Antofagasta crater & Atacama block",
     "Rim of a 10 m crater; drill campaign in the layered rock just above the boxwork (April 2026).",
     "https://science.nasa.gov/blog/curiosity-blog-sols-4867-4872-sand-fill-in-antofagasta-crater-and-finding-our-next-drill-target"),
]


def inside(lat: float, lon: float, pad: float = 0.0) -> bool:
    return (AOI["lat_min"] - pad <= lat <= AOI["lat_max"] + pad) and (AOI["lon_min"] - pad <= lon <= AOI["lon_max"] + pad)


def metres(a: tuple[float, float], b: tuple[float, float]) -> float:
    dlat = math.radians(b[0] - a[0])
    dlon = math.radians(b[1] - a[1]) * math.cos(math.radians(a[0]))
    return MARS_RADIUS_M * math.hypot(dlat, dlon)


def main() -> None:
    waypoints = http_json(WAYPOINTS_URL)["features"]
    stops_all = []
    for feature in waypoints:
        p = feature["properties"]
        lon, lat = feature["geometry"]["coordinates"][:2]
        stops_all.append({
            "sol": int(float(p["sol"])), "lat": round(lat, 7), "lon": round(lon, 7),
            "elev": round(float(p["elev_geoid"]), 2), "site": int(p["site"]), "drive": int(p["drive"]),
            "odometer_m": round(float(p["dist_total_m"]), 1), "tilt": round(abs(float(p.get("tilt") or 0)), 1),
        })
    stops_all.sort(key=lambda s: (s["sol"], s["odometer_m"]))
    for stop, following in zip(stops_all, stops_all[1:] + [None]):
        stop["next_sol"] = following["sol"] if following else None
    stops = [s for s in stops_all if inside(s["lat"], s["lon"])]

    # Investigation sites: places where the rover stayed put for many sols. Stays within 30 m of each
    # other are one site (the rover shuffles a few metres between neighbouring drill targets).
    sites: list[dict] = []
    for stop in stops:
        stay = (stop["next_sol"] - stop["sol"]) if stop["next_sol"] else 0
        if stay < LONG_STAY_SOLS:
            continue
        here = (stop["lat"], stop["lon"])
        if sites and metres((sites[-1]["lat"], sites[-1]["lon"]), here) < 30.0:
            site = sites[-1]
            site["until_sol"] = stop["next_sol"]
            site["stay_sols"] += stay
            if stay > site["_longest"]:
                site.update(lat=stop["lat"], lon=stop["lon"], elev=stop["elev"], _longest=stay)
        else:
            sites.append({"sol": stop["sol"], "until_sol": stop["next_sol"], "stay_sols": stay,
                          "lat": stop["lat"], "lon": stop["lon"], "elev": stop["elev"], "_longest": stay})
    for site in sites:
        del site["_longest"]
        site["name"] = f"Curiosity study site, sols {site['sol']}-{site['until_sol']}"
        site["note"] = f"Curiosity stayed here for {site['stay_sols']} sols."
        site["source"] = None
        for first, last, name, note, source in NAMED_SITES:
            if site["sol"] <= last and site["until_sol"] >= first:
                site.update(name=name, note=note, source=source)

    # Driven path: all vertices in file order, thinned to about 2 m spacing, split where it leaves the area.
    traverse = http_json(TRAVERSE_URL)["features"]
    segments: list[list[list[float]]] = []
    current: list[list[float]] = []
    for feature in traverse:
        geometry = feature["geometry"]
        lines = [geometry["coordinates"]] if geometry["type"] == "LineString" else geometry["coordinates"]
        for line in lines:
            for lon, lat, *_ in line:
                if not inside(lat, lon, pad=0.002):
                    if len(current) > 1:
                        segments.append(current)
                    current = []
                    continue
                point = [round(lat, 7), round(lon, 7)]
                if current and metres(tuple(current[-1]), tuple(point)) < 2.0:
                    continue
                if current and metres(tuple(current[-1]), tuple(point)) > 150.0:
                    segments.append(current)
                    current = []
                current.append(point)
    if len(current) > 1:
        segments.append(current)

    latest = stops_all[-1]
    out = {
        "source": "NASA/JPL-Caltech Curiosity rover location map (MMGIS): MSL_waypoints.json, MSL_traverse.json",
        "source_urls": [WAYPOINTS_URL, TRAVERSE_URL],
        "fetched": datetime.date.today().isoformat(),
        "latest": {"sol": latest["sol"], "lat": latest["lat"], "lon": latest["lon"], "odometer_m": latest["odometer_m"]},
        "stops": stops,
        "sites": sites,
        "path": segments,
    }
    write_json(DATA / "rover.json", out)
    print(f"stops in study area: {len(stops)} (sols {stops[0]['sol']}..{stops[-1]['sol']}); "
          f"long-stay sites: {len(sites)}; path segments: {len(segments)} with {sum(len(s) for s in segments)} points")
    for site in sites:
        print(f"  {site['name']}: sols {site['sol']}-{site['until_sol']} ({site['stay_sols']} sols) at {site['lat']:.5f}, {site['lon']:.5f}, {site['elev']:.0f} m")


if __name__ == "__main__":
    main()
