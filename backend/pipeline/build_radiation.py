"""Build the surface radiation record from Curiosity's Radiation Assessment Detector (RAD).

Source: NASA PDS Planetary Plasma Interactions node, dataset MSL-M-RAD-3-RDR-V1.0.
Each sol is a ~68 MB text file, so two things are fetched:
  background  the first dose reading of every Nth sol (a 48 KB range request each) -> long-term dose rate
  storm       the complete files around 20 May 2024, the largest solar particle event RAD has recorded

Dose values are the "E" detector (tissue-equivalent plastic), in micrograys per hour, as stated in the RDR SIS.

Output: backend/data/radiation.json
Usage:  python backend/pipeline/build_radiation.py [--step 2]
"""
from __future__ import annotations

import datetime
import json
import re
import statistics
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import CACHE, DATA, http_get, write_json  # noqa: E402

BASE_URL = "https://pds-ppi.igpp.ucla.edu/data/MSL-M-RAD-3-RDR-V1.0/DATA/"
WORK = CACHE / "radiation"
STORM_SOLS = range(4189, 4195)          # 18-24 May 2024
STORM_LABEL = "20 May 2024 solar particle event"
QUALITY_FACTOR = 3.05                   # mean quality factor on the surface (Hassler et al. 2014, Science 343)

FILE_RE = re.compile(r'href="(RAD_RDR_(\d{4})_(\d{3})_(\d{2})_(\d{2})_(\d{4})_V(\d{2})\.TXT)"')
DOSE_E_RE = re.compile(rb"\[DOSIMETRY_TOTAL_DOSE_E: \d+\]\s+([-+0-9.eE]+)")
DOSE_B_RE = re.compile(rb"\[DOSIMETRY_TOTAL_DOSE_B: \d+\]\s+([-+0-9.eE]+)")
START_RE = re.compile(rb'START_OBS_UTC="(\d{4})-(\d{3}) (\d\d):(\d\d):(\d\d)"')
OBS_RE = re.compile(rb"\[OBSERVATION: (\d+)\]")


def utc(year, doy, hour, minute, second=0) -> datetime.datetime:
    return datetime.datetime(int(year), 1, 1) + datetime.timedelta(days=int(doy) - 1, hours=int(hour), minutes=int(minute), seconds=int(second))


def index_files() -> dict[int, str]:
    """Map sol -> file URL by reading the archive's directory listings."""
    cache = WORK / "index.json"
    if cache.exists():
        return {int(k): v for k, v in json.loads(cache.read_text()).items()}
    listing = http_get(BASE_URL).decode("latin1")
    folders = sorted(set(re.findall(r'href="(SOL_\d+_\d+/)"', listing)))
    files: dict[int, tuple[int, str]] = {}
    for folder in folders:
        page = http_get(BASE_URL + folder).decode("latin1")
        for name, _year, _doy, _hh, _mm, sol, version in FILE_RE.findall(page):
            sol, version = int(sol), int(version)
            if sol not in files or version > files[sol][0]:
                files[sol] = (version, BASE_URL + folder + name)
        print(f"  indexed {folder} ({len(files)} sols so far)", flush=True)
    out = {sol: url for sol, (_, url) in sorted(files.items())}
    cache.write_text(json.dumps(out))
    return out


def first_reading(url: str):
    """First dose reading in a sol file: (utc iso, dose E, dose B) or None."""
    for size in (48 * 1024, 1024 * 1024):
        head = http_get(url, (0, size - 1))
        dose_e = DOSE_E_RE.search(head)
        start = START_RE.search(head)
        if dose_e and start:
            dose_b = DOSE_B_RE.search(head)
            when = utc(*[g.decode() for g in start.groups()])
            return when.isoformat(), float(dose_e.group(1)), float(dose_b.group(1)) if dose_b else None
    return None


def build_background(index: dict[int, str], step: int) -> dict[int, list]:
    cache = WORK / "background.json"
    samples: dict[int, list] = {int(k): v for k, v in json.loads(cache.read_text()).items()} if cache.exists() else {}
    wanted = [sol for sol in sorted(index) if sol % step == 0 and sol not in samples]
    lock = threading.Lock()

    def work(sol: int) -> None:
        try:
            reading = first_reading(index[sol])
        except Exception as error:  # one bad file should not stop the run
            print(f"  sol {sol}: {error}", flush=True)
            reading = None
        with lock:
            samples[sol] = list(reading) if reading else None
            if len(samples) % 200 == 0:
                cache.write_text(json.dumps(samples))
                print(f"  background readings: {len(samples)}", flush=True)

    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(work, wanted))
    cache.write_text(json.dumps(samples))
    return samples


def rolling_median(sols: list[int], values: list[float], half_window: int = 20) -> list[float]:
    out = []
    lo = 0
    hi = 0
    for sol in sols:
        while sols[lo] < sol - half_window:
            lo += 1
        while hi < len(sols) and sols[hi] <= sol + half_window:
            hi += 1
        out.append(round(statistics.median(values[lo:hi]), 3))
    return out


def storm_series(index: dict[int, str]) -> list[tuple[datetime.datetime, float]]:
    """Every dose reading in the storm-period files, as (utc, dose E)."""
    readings: list[tuple[datetime.datetime, float]] = []
    for sol in STORM_SOLS:
        local = WORK / f"sol_{sol}.txt"
        if not local.exists():
            print(f"  downloading sol {sol} (about 68 MB)", flush=True)
            local.write_bytes(http_get(index[sol], timeout=600))
        blob = local.read_bytes()
        starts = [m.start() for m in OBS_RE.finditer(blob)] + [len(blob)]
        for a, b in zip(starts, starts[1:]):
            block = blob[a:b]
            dose = DOSE_E_RE.search(block)
            start = START_RE.search(block)
            if dose and start:
                readings.append((utc(*[g.decode() for g in start.groups()]), float(dose.group(1))))
    readings.sort()
    return readings


def main() -> None:
    step = int(sys.argv[sys.argv.index("--step") + 1]) if "--step" in sys.argv else 2
    WORK.mkdir(parents=True, exist_ok=True)
    index = index_files()
    print(f"archive covers sols {min(index)}..{max(index)} ({len(index)} files)")

    samples = build_background(index, step)
    rows = sorted((sol, v) for sol, v in samples.items() if v and 0 < v[1] < 200)
    sols = [sol for sol, _ in rows]
    dose = [round(v[1], 3) for _, v in rows]
    dates = [v[0][:10] for _, v in rows]
    smooth = rolling_median(sols, dose)
    print(f"background: {len(sols)} readings; smoothed dose rate {min(smooth):.1f}..{max(smooth):.1f} uGy/h")

    readings = storm_series(index)
    t0 = readings[0][0]
    hours = [round((t - t0).total_seconds() / 3600, 3) for t, _ in readings]
    values = [round(v, 3) for _, v in readings]
    baseline = statistics.median(values[: max(20, len(values) // 6)])  # the first day is quiet
    above = [i for i, v in enumerate(values) if v > 1.5 * baseline]
    onset, end = above[0], above[-1]
    excess = 0.0
    for i in range(onset, min(end + 1, len(values) - 1)):
        excess += ((values[i] + values[i + 1]) / 2 - baseline) * (hours[i + 1] - hours[i])
    peak = max(values)
    storm = {
        "label": STORM_LABEL,
        "sols": [STORM_SOLS[0], STORM_SOLS[-1]],
        "utc_start": t0.isoformat(),
        "hours": hours,
        "dose": values,
        "baseline": round(baseline, 3),
        "peak": round(peak, 2),
        "peak_ratio": round(peak / baseline, 1),
        "peak_hour": hours[values.index(peak)],
        "onset_hour": hours[onset],
        "end_hour": hours[end],
        "excess_dose_ugy": round(excess, 0),
    }
    print(f"storm: {len(values)} readings from {t0}; baseline {baseline:.2f}, peak {peak:.1f} uGy/h "
          f"({peak / baseline:.0f}x) at +{storm['peak_hour']:.1f} h; onset +{hours[onset]:.1f} h, end +{hours[end]:.1f} h; "
          f"dose above background {excess:.0f} uGy")

    out = {
        "source": "NASA PDS PPI node, MSL RAD Reduced Data Records (MSL-M-RAD-3-RDR-V1.0)",
        "source_url": BASE_URL,
        "fetched": datetime.date.today().isoformat(),
        "unit": "micrograys per hour, RAD E detector (tissue-equivalent plastic)",
        "quality_factor": QUALITY_FACTOR,
        "quality_factor_note": "Mean radiation quality factor on the surface (Hassler et al. 2014). Dose equivalent in sieverts is estimated as absorbed dose times this factor.",
        "background": {
            "note": f"First dose reading of every {step}. sol; 'smooth' is a +/-20 sol rolling median.",
            "sol": sols, "date": dates, "dose": dose, "smooth": smooth,
        },
        "storm": storm,
    }
    write_json(DATA / "radiation.json", out)


if __name__ == "__main__":
    main()
