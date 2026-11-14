"""Build the terrain grid for the study area from the MSL Gale Crater 1 m elevation mosaic.

Source: USGS Astrogeology / MSL project, "MSL Gale Merged DEM 1m v3" (HiRISE stereo), a 3.9 GB GeoTIFF.
Only the rows covering the study area are downloaded (HTTP range requests, about 330 MB).

Stages (each caches its result under backend/data/cache/terrain):
  download  fetch the compressed rows
  decode    decompress and crop to a 1 m elevation array
  grid      derive the planner grid (elevation + steepest slope per cell) and the slope map overlay
  validate  compare the grid with Curiosity's recorded elevation and tilt (run build_rover.py first)

Usage:  python backend/pipeline/build_terrain.py [download|decode|grid|validate|all]
"""
from __future__ import annotations

import json
import math
import struct
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import AOI, CACHE, DATA, MARS_RADIUS_M, http_get, png_palette, write_json  # noqa: E402

DEM_URL = "https://planetarymaps.usgs.gov/mosaic/Mars/MSL/MSL_Gale_DEM_Mosaic_1m_v3.tif"
CELL_M = 4          # planner grid cell size, metres
SMOOTH_SIGMA_M = 3.0  # Gaussian smoothing before taking slopes: about the real resolution of the stereo elevation data
OVERLAY_M = 2       # resolution of the slope map overlay, metres
WORK = CACHE / "terrain"

# Slope classes for the map overlay: upper bound in degrees and RGBA colour.
SLOPE_CLASSES = [
    (10, (0, 0, 0, 0)),          # easy ground: transparent, imagery shows through
    (15, (246, 211, 77, 150)),   # moderate
    (20, (240, 138, 52, 175)),   # steep
    (25, (214, 60, 48, 195)),    # very steep
    (90, (120, 22, 62, 215)),    # cliff
]


def read_layout() -> dict:
    """Read just enough of the remote GeoTIFF to locate rows: tags, strip table and georeferencing."""
    head = http_get(DEM_URL, (0, 15))
    if head[:4] != b"II*\x00":
        raise RuntimeError("expected a little-endian classic TIFF")
    ifd = struct.unpack("<I", head[4:8])[0]
    count = struct.unpack("<H", http_get(DEM_URL, (ifd, ifd + 1)))[0]
    raw = http_get(DEM_URL, (ifd + 2, ifd + 2 + count * 12 - 1))
    tags = {}
    for i in range(count):
        tag, kind, n, value = struct.unpack("<HHII", raw[i * 12:(i + 1) * 12])
        tags[tag] = (kind, n, value)

    def inline(tag: int) -> int:
        return tags[tag][2] & 0xFFFF

    def array(tag: int, dtype: str, size: int) -> np.ndarray:
        _, n, offset = tags[tag]
        return np.frombuffer(http_get(DEM_URL, (offset, offset + n * size - 1)), dtype=dtype)

    layout = {
        "width": inline(256), "height": inline(257), "bits": inline(258), "compression": inline(259),
        "rows_per_strip": inline(278), "predictor": inline(317) if 317 in tags else 1,
        "sample_format": inline(339) if 339 in tags else 1,
    }
    expected = {"bits": 32, "compression": 5, "rows_per_strip": 1, "predictor": 1, "sample_format": 3}
    for key, value in expected.items():
        if layout[key] != value:
            raise RuntimeError(f"unexpected TIFF layout: {key}={layout[key]} (expected {value})")
    scale = array(33550, "<f8", 8)
    tie = array(33922, "<f8", 8)
    layout.update(x_left=float(tie[3] - tie[0] * scale[0]), y_top=float(tie[4] + tie[1] * scale[1]),
                  pixel_m=float(scale[0]))
    layout["strip_offsets"] = array(273, "<u4", 4).astype(np.int64)
    layout["strip_bytes"] = array(279, "<u4", 4).astype(np.int64)
    return layout


def window(layout: dict) -> dict:
    """Pixel window of the study area, snapped outward to whole planner cells."""
    px = layout["pixel_m"]
    col0 = math.floor((math.radians(AOI["lon_min"]) * MARS_RADIUS_M - layout["x_left"]) / px)
    col1 = math.ceil((math.radians(AOI["lon_max"]) * MARS_RADIUS_M - layout["x_left"]) / px)
    row0 = math.floor((layout["y_top"] - math.radians(AOI["lat_max"]) * MARS_RADIUS_M) / px)
    row1 = math.ceil((layout["y_top"] - math.radians(AOI["lat_min"]) * MARS_RADIUS_M) / px)
    col1 += (-(col1 - col0)) % CELL_M
    row1 += (-(row1 - row0)) % CELL_M
    return {"row0": row0, "row1": row1, "col0": col0, "col1": col1}


def stage_download() -> None:
    WORK.mkdir(parents=True, exist_ok=True)
    layout = read_layout()
    win = window(layout)
    offsets, sizes = layout["strip_offsets"], layout["strip_bytes"]
    start = int(offsets[win["row0"]])
    end = int(offsets[win["row1"] - 1] + sizes[win["row1"] - 1])  # exclusive
    rows = slice(win["row0"], win["row1"])
    if not np.all(offsets[rows][1:] == offsets[rows][:-1] + sizes[rows][:-1]):
        raise RuntimeError("rows are not stored contiguously; cannot fetch them as one range")
    meta = {**{k: v for k, v in layout.items() if not isinstance(v, np.ndarray)}, **win,
            "byte_start": start, "byte_end": end, "url": DEM_URL}
    np.save(WORK / "strip_offsets.npy", offsets[rows] - start)
    np.save(WORK / "strip_bytes.npy", sizes[rows])
    (WORK / "layout.json").write_text(json.dumps(meta, indent=2))
    total = end - start
    print(f"window rows {win['row0']}..{win['row1']} cols {win['col0']}..{win['col1']}: {total / 1e6:.0f} MB to fetch")

    blob = WORK / "rows.bin"
    done_file = WORK / "rows.done.json"
    chunk = 8 * 1024 * 1024
    chunks = [(i, start + i * chunk, min(start + (i + 1) * chunk, end)) for i in range(math.ceil(total / chunk))]
    done = set(json.loads(done_file.read_text())) if done_file.exists() and blob.exists() else set()
    if not blob.exists() or blob.stat().st_size != total:
        with open(blob, "wb") as handle:
            handle.truncate(total)
        done = set()
    lock = threading.Lock()
    t0 = time.time()

    def fetch(item):
        index, a, b = item
        data = http_get(DEM_URL, (a, b - 1), timeout=180)
        with lock:
            with open(blob, "r+b") as handle:
                handle.seek(a - start)
                handle.write(data)
            done.add(index)
            done_file.write_text(json.dumps(sorted(done)))
            got = len(done) * chunk
            print(f"  {min(got, total) / 1e6:6.0f} / {total / 1e6:.0f} MB  ({time.time() - t0:.0f} s)", flush=True)

    todo = [c for c in chunks if c[0] not in done]
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(fetch, todo))
    print("download complete")


def stage_decode() -> None:
    import imagecodecs

    meta = json.loads((WORK / "layout.json").read_text())
    offsets = np.load(WORK / "strip_offsets.npy")
    sizes = np.load(WORK / "strip_bytes.npy")
    blob = np.memmap(WORK / "rows.bin", dtype=np.uint8, mode="r")
    width = meta["width"]
    c0, c1 = meta["col0"], meta["col1"]
    out = np.empty((len(offsets), c1 - c0), dtype=np.float32)
    t0 = time.time()
    row_bytes = width * 4
    for i, (offset, size) in enumerate(zip(offsets, sizes)):
        # Passing the expected size makes the decoder fill exactly one row (its own size guess can be off).
        raw = imagecodecs.lzw_decode(bytes(blob[offset:offset + size]), out=row_bytes)
        if len(raw) != row_bytes:
            raise RuntimeError(f"row {i}: decoded {len(raw)} bytes, expected {row_bytes}")
        out[i] = np.frombuffer(raw, dtype="<f4")[c0:c1]
    out[out < -30000] = np.nan  # the mosaic marks missing data as -32767
    np.save(WORK / "dem_1m.npy", out)
    print(f"decoded {out.shape[0]} x {out.shape[1]} px in {time.time() - t0:.1f} s; "
          f"elevation {np.nanmin(out):.1f}..{np.nanmax(out):.1f} m; missing {np.isnan(out).mean() * 100:.2f}%")


def block_reduce(a: np.ndarray, factor: int, func) -> np.ndarray:
    h, w = a.shape
    return func(a.reshape(h // factor, factor, w // factor, factor), axis=(1, 3))


def fill_missing(dem: np.ndarray) -> np.ndarray:
    """Replace missing samples with the nearest valid one so smoothing does not spread the gaps."""
    missing = np.isnan(dem)
    if not missing.any():
        return dem
    from scipy import ndimage

    nearest = ndimage.distance_transform_edt(missing, return_distances=False, return_indices=True)
    return dem[tuple(nearest)]


def stage_grid() -> None:
    from scipy import ndimage

    meta = json.loads((WORK / "layout.json").read_text())
    dem = np.load(WORK / "dem_1m.npy")
    px = meta["pixel_m"]
    missing = np.isnan(dem)
    filled = fill_missing(dem)

    # Planner elevation: mean of each CELL_M x CELL_M block of the 1 m data.
    elev = block_reduce(filled, CELL_M, np.mean).astype(np.float32)
    cell_missing = block_reduce(missing, CELL_M, np.any)
    elev[cell_missing] = np.nan

    # Slope: smooth the 1 m data to its real resolution, take the gradient, keep the worst value per cell.
    lat_mid = math.degrees((meta["y_top"] - (meta["row0"] + meta["row1"]) / 2 * px) / MARS_RADIUS_M)
    east_scale = math.cos(math.radians(lat_mid))  # projected metres are stretched east-west by 1/cos(lat)
    smooth = ndimage.gaussian_filter(filled, SMOOTH_SIGMA_M / px)
    dz_dy, dz_dx = np.gradient(smooth, px, px * east_scale)
    slope_1m = np.degrees(np.arctan(np.hypot(dz_dx, dz_dy))).astype(np.float32)
    slope = block_reduce(slope_1m, CELL_M, np.max)
    slope[cell_missing] = np.nan

    rows, cols = elev.shape
    lat_north = math.degrees((meta["y_top"] - meta["row0"] * px) / MARS_RADIUS_M)
    lon_west = math.degrees((meta["x_left"] + meta["col0"] * px) / MARS_RADIUS_M)
    cell_deg = math.degrees(CELL_M * px / MARS_RADIUS_M)
    grid = {
        "rows": rows, "cols": cols, "cell_m": CELL_M * px, "cell_deg": cell_deg,
        "lat_north": lat_north, "lon_west": lon_west,
        "lat_south": lat_north - rows * cell_deg, "lon_east": lon_west + cols * cell_deg,
        "cell_east_m": CELL_M * px * east_scale, "cell_north_m": CELL_M * px,
        "elev_min": float(np.nanmin(elev)), "elev_max": float(np.nanmax(elev)),
        "source": "MSL Gale Merged DEM 1 m v3 (USGS Astrogeology / MSL project, from HiRISE stereo images)",
        "source_url": DEM_URL,
        "slope_method": (f"steepest slope inside each {CELL_M} m cell, from the 1 m elevation data "
                         f"smoothed with a {SMOOTH_SIGMA_M:g} m Gaussian"),
        "slope_classes_deg": [upper for upper, _ in SLOPE_CLASSES],
        "slope_colours": ["#%02x%02x%02x" % colour[:3] for _, colour in SLOPE_CLASSES],
    }
    DATA.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(DATA / "terrain.npz", elev=elev, slope=slope.astype(np.float16))
    write_json(DATA / "terrain.json", grid, compact=False)
    print(f"planner grid {rows} x {cols} cells of {CELL_M} m; terrain.npz {(DATA / 'terrain.npz').stat().st_size / 1e6:.1f} MB")

    # Map overlay: slope classes at 2 m resolution (worst value in each 2 m block).
    overlay = block_reduce(slope_1m, OVERLAY_M, np.max)
    overlay[block_reduce(missing, OVERLAY_M, np.any)] = -1.0
    classes = np.full(overlay.shape, len(SLOPE_CLASSES), dtype=np.uint8)  # last index = missing data
    lower = 0.0
    for index, (upper, _) in enumerate(SLOPE_CLASSES):
        classes[(overlay >= lower) & (overlay < upper)] = index
        lower = upper
    palette = [colour for _, colour in SLOPE_CLASSES] + [(90, 90, 90, 160)]
    overlays = DATA / "overlays"
    overlays.mkdir(exist_ok=True)
    (overlays / "slope.png").write_bytes(png_palette(classes, palette))
    print(f"wrote overlays/slope.png ({(overlays / 'slope.png').stat().st_size / 1024:.0f} KB, "
          f"{classes.shape[1]} x {classes.shape[0]} px)")
    finite = slope[np.isfinite(slope)]
    print("  share of cells steeper than: " + ", ".join(f"{limit} deg {(finite > limit).mean() * 100:.0f}%" for limit in (10, 15, 20, 25, 30)))


def stage_validate() -> None:
    """Compare the grid with what Curiosity itself recorded at its stops (needs data/rover.json)."""
    grid = json.loads((DATA / "terrain.json").read_text())
    terrain = np.load(DATA / "terrain.npz")
    elev, slope = terrain["elev"], terrain["slope"].astype(np.float32)
    stops = json.loads((DATA / "rover.json").read_text())["stops"]
    rows = np.array([(grid["lat_north"] - s["lat"]) / grid["cell_deg"] for s in stops]).astype(int)
    cols = np.array([(s["lon"] - grid["lon_west"]) / grid["cell_deg"] for s in stops]).astype(int)
    keep = (rows >= 0) & (rows < grid["rows"]) & (cols >= 0) & (cols < grid["cols"])
    rows, cols = rows[keep], cols[keep]
    rover_elev = np.array([s["elev"] for s in stops])[keep]
    rover_tilt = np.array([s["tilt"] for s in stops])[keep]
    diff = elev[rows, cols] - rover_elev
    cell_slope = slope[rows, cols]
    validation = {
        "stops_compared": int(keep.sum()),
        "elevation_difference_m": {"median": round(float(np.median(diff)), 2), "std": round(float(diff.std()), 2)},
        "rover_tilt_deg": {"median": round(float(np.median(rover_tilt)), 1), "p90": round(float(np.percentile(rover_tilt, 90)), 1),
                           "max": round(float(rover_tilt.max()), 1)},
        "grid_slope_at_stops_deg": {"median": round(float(np.median(cell_slope)), 1), "p90": round(float(np.percentile(cell_slope, 90)), 1),
                                    "max": round(float(cell_slope.max()), 1)},
        "slope_tilt_correlation": round(float(np.corrcoef(cell_slope, rover_tilt)[0, 1]), 2),
        "note": "Grid values sampled at Curiosity's stops versus the elevation and tilt the rover recorded there.",
    }
    grid["validation"] = validation
    write_json(DATA / "terrain.json", grid, compact=False)
    print(json.dumps(validation, indent=2))


if __name__ == "__main__":
    stage = sys.argv[1] if len(sys.argv) > 1 else "all"
    if stage in ("download", "all"):
        stage_download()
    if stage in ("decode", "all"):
        stage_decode()
    if stage in ("grid", "all"):
        stage_grid()
    if stage in ("validate", "all") and (DATA / "rover.json").exists():
        stage_validate()
