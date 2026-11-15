"""HTTP API of the Mars EVA planner.

Run from the repository root:
    backend/.venv/Scripts/python -m uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port 8001
Interactive API docs are then at http://localhost:8001/docs
"""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import site
from .conditions import Conditions
from .mission import OverlayStore, PlanError, build_escape, build_plan
from .photos import PhotoService
from .planner import Planner
from .terrain import Terrain

BACKEND_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BACKEND_DIR / "data"
FRONTEND_DIST = BACKEND_DIR.parent / "frontend" / "dist"

terrain = Terrain.load(DATA_DIR)
planner = Planner(terrain)
conditions = Conditions(DATA_DIR)
rover = json.loads((DATA_DIR / "rover.json").read_text(encoding="utf-8"))
photos = PhotoService(DATA_DIR, rover["stops"])
overlays = OverlayStore()

app = FastAPI(title="Mars EVA planner API", version="1.0",
              description="Route planning and safe-return limits for a crew on foot in the Mount Sharp boxwork region.")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ---- request models ----------------------------------------------------------------------------------

def _range(name: str):
    default, low, high, _ = site.PARAMETERS[name]
    return Field(default, ge=low, le=high)


class Point(BaseModel):
    lat: float
    lon: float


class Stop(Point):
    name: str = ""
    work_min: float = Field(site.DEFAULT_WORK_MIN, ge=0, le=300, description="Time spent working at the stop, minutes")


class Params(BaseModel):
    flat_speed: float = _range("flat_speed")              # walking speed on level ground, m/s
    max_slope: float = _range("max_slope")                # steepest ground the crew will walk on, degrees
    life_support_h: float = _range("life_support_h")      # suit life support capacity, hours
    reserve_min: float = _range("reserve_min")            # life support kept untouched, minutes
    start_clock_min: float = _range("start_clock_min")    # EVA start, Mars local clock minutes after midnight
    sunset_buffer_min: float = _range("sunset_buffer_min")  # be back this long before sunset, minutes
    storm_warning_min: float = _range("storm_warning_min")  # time to reach shelter after a solar storm alert


class PlanRequest(BaseModel):
    camp: Point
    stops: list[Stop] = Field(default_factory=list, max_length=12)
    params: Params = Field(default_factory=Params)
    sol: int | None = Field(None, description="Curiosity mission sol whose measured conditions to use; latest if omitted")


class EscapeRequest(BaseModel):
    camp: Point
    position: Point
    params: Params = Field(default_factory=Params)


# ---- endpoints ---------------------------------------------------------------------------------------

@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "grid": [terrain.rows, terrain.cols], "weather_sols": [conditions.first_sol, conditions.latest_sol]}


@app.get("/api/site")
def get_site() -> dict:
    """Everything the map needs to start: layers, the study area, rover data, defaults and data sources."""
    sites = rover["sites"]
    by_name = {s["name"]: s for s in sites}
    default_stops = [{"name": name, "lat": by_name[name]["lat"], "lon": by_name[name]["lon"], "work_min": site.DEFAULT_WORK_MIN}
                     for name in site.DEFAULT_STOP_SITES if name in by_name]
    return {
        **site.SITE,
        "bounds": terrain.bounds,
        "grid": {"rows": terrain.rows, "cols": terrain.cols, "cell_m": terrain.meta["cell_m"],
                 "elev_min": terrain.meta["elev_min"], "elev_max": terrain.meta["elev_max"]},
        "tiles": site.TILES,
        "slope_layer": {"url": "/overlays/slope.png", "bounds": terrain.bounds,
                        "classes_deg": terrain.meta["slope_classes_deg"], "colours": terrain.meta["slope_colours"],
                        "method": terrain.meta["slope_method"]},
        "validation": terrain.meta.get("validation"),
        "default_camp": site.DEFAULT_CAMP,
        "default_stops": default_stops,
        "default_work_min": site.DEFAULT_WORK_MIN,
        "parameters": {name: {"default": d, "min": lo, "max": hi, "step": step} for name, (d, lo, hi, step) in site.PARAMETERS.items()},
        "targets": sites,
        "rover": {"path": rover["path"], "latest": rover["latest"], "fetched": rover["fetched"],
                  "stops": [{"sol": s["sol"], "lat": s["lat"], "lon": s["lon"]} for s in rover["stops"]]},
        "sols": {"first": conditions.first_sol, "latest": conditions.latest_sol},
        "storm": conditions.storm_summary(),
        "sources": site.SOURCES,
        "model_notes": site.MODEL_NOTES,
    }


@app.get("/api/conditions")
def get_conditions(sol: int | None = Query(None, description="Mission sol; latest if omitted")) -> dict:
    """Weather and background radiation Curiosity measured on (or nearest to) a sol."""
    return conditions.for_sol(sol)


@app.get("/api/conditions/history")
def get_history() -> dict:
    """Long-term temperature and radiation series for charts."""
    return conditions.history()


@app.post("/api/plan")
def post_plan(request: PlanRequest) -> dict:
    """Plan the walk from base camp through the stops and back, with turn-back limits and the safe-return area."""
    try:
        with planner.lock:
            return build_plan(planner, conditions, overlays, request.camp, request.stops, request.params, request.sol)
    except (PlanError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post("/api/escape")
def post_escape(request: EscapeRequest) -> dict:
    """Fastest walk back to base camp from a position, judged against the storm warning time."""
    try:
        with planner.lock:
            return build_escape(planner, conditions, request.camp, request.position, request.params)
    except (PlanError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.get("/api/photos")
def get_photos(lat: float, lon: float) -> dict:
    """Photos Curiosity took from its stop nearest to a point."""
    return photos.near(lat, lon)


@app.get("/api/overlay/{key}.png")
def get_overlay(key: str) -> Response:
    image = overlays.get(key)
    if image is None:
        raise HTTPException(status_code=404, detail="overlay expired; request the plan again")
    return Response(content=image, media_type="image/png", headers={"Cache-Control": "public, max-age=3600"})


app.mount("/overlays", StaticFiles(directory=DATA_DIR / "overlays"), name="overlays")
if FRONTEND_DIST.exists():  # serve the built frontend when it is there (production-style, single port)
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
