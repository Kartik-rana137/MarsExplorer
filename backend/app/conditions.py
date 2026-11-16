"""Conditions at Gale Crater for a chosen sol: Curiosity's weather record (REMS) and radiation (RAD).

Sols Curiosity measured are replayed as measured. Later sols, up to two Mars years ahead, are estimated by
forecast.py and marked `"estimated": true`, with how they were estimated and the likely ranges.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .forecast import Forecast

MARS_SOL_S = 88_775.244
CLOCK_MIN_S = MARS_SOL_S / 1440   # one minute of the 24-hour Mars clock, in seconds
CLOCK_STRETCH = CLOCK_MIN_S / 60  # real minutes per Mars clock minute (1.0275)

# Gale Crater is just south of the equator, so seasons follow the southern hemisphere.
SEASONS = ((90, "autumn"), (180, "winter"), (270, "spring"), (360.01, "summer"))


def clock(minutes: float) -> str:
    """Mars clock minutes after local midnight -> 'HH:MM' (wraps past midnight)."""
    minutes = int(round(minutes)) % 1440
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


class Conditions:
    def __init__(self, data_dir: Path) -> None:
        self.weather = json.loads((data_dir / "weather.json").read_text(encoding="utf-8"))
        self.sols = np.asarray(self.weather["sol"])
        radiation_file = data_dir / "radiation.json"
        self.radiation = json.loads(radiation_file.read_text(encoding="utf-8")) if radiation_file.exists() else None
        if self.radiation:
            background = self.radiation["background"]
            self._rad_sols = np.asarray(background["sol"], dtype=float)
            self._rad_smooth = np.asarray(background["smooth"], dtype=float)
            storm = self.radiation["storm"]
            self._storm_hours = np.asarray(storm["hours"], dtype=float) - storm["onset_hour"]
            self._storm_dose = np.asarray(storm["dose"], dtype=float)
        self.forecast = Forecast(self.weather, self.radiation)
        # How well the estimates did when tried on the last measured Mars year (written by pipeline/check_forecast.py).
        check_file = data_dir / "forecast_check.json"
        self.forecast_check = json.loads(check_file.read_text(encoding="utf-8")) if check_file.exists() else None

    @property
    def first_sol(self) -> int:
        return int(self.sols[0])

    @property
    def latest_sol(self) -> int:
        return int(self.sols[-1])

    def _value(self, key: str, index: int):
        """Value at a sol, or the nearest sol within five that has one (the feed has gaps)."""
        column = self.weather[key]
        for offset in (0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5):
            i = index + offset
            if 0 <= i < len(column) and column[i] is not None:
                return column[i]
        return None

    @property
    def forecast_until(self) -> int:
        """The last sol that can be estimated."""
        return self.forecast.until_sol

    def for_sol(self, sol: int | None = None) -> dict:
        """Conditions on a sol: measured (the nearest sol Curiosity reported) or, after the record, estimated.
        Raises ValueError for a sol beyond `forecast_until`."""
        requested = self.latest_sol if sol is None else int(sol)
        if requested > self.latest_sol:
            values, estimate = self.forecast.weather(requested)
            used = requested
        else:
            index = int(np.argmin(np.abs(self.sols - requested)))
            keys = ("ls", "air_min_c", "air_max_c", "ground_min_c", "ground_max_c", "pressure_pa", "uv", "sunrise_min", "sunset_min")
            values = {key: self._value(key, index) for key in keys}
            values["date"] = self.weather["date"][index]
            estimate = None
            used = int(self.sols[index])
        ls = values["ls"]
        sunrise, sunset = values["sunrise_min"], values["sunset_min"]
        return {
            "sol": used,
            "requested_sol": requested,
            "date": values["date"],
            "ls": ls,
            "season": next(name for limit, name in SEASONS if ls < limit) if ls is not None else None,
            "dust_season": bool(ls is not None and ls >= 180),
            "air_min_c": values["air_min_c"],
            "air_max_c": values["air_max_c"],
            "ground_min_c": values["ground_min_c"],
            "ground_max_c": values["ground_max_c"],
            "pressure_pa": values["pressure_pa"],
            "uv": values["uv"],
            "sunrise_min": sunrise,
            "sunset_min": sunset,
            "sunrise": clock(sunrise),
            "sunset": clock(sunset),
            "daylight_h": round((sunset - sunrise) * CLOCK_MIN_S / 3600, 2),
            "radiation": self.background_dose(used),
            "estimated": estimate is not None,
            "estimate": estimate,
        }

    def background_dose(self, sol: int) -> dict | None:
        """Everyday (galactic cosmic ray) dose rate around a sol: RAD's long-term record, or after its last reading,
        an estimate from the solar cycle (marked `estimated`, with a likely range)."""
        if not self.radiation:
            return None
        last = int(self._rad_sols[-1])
        low_high = None
        if sol > last and self.forecast.radiation:
            rate, low, high = self.forecast.radiation.rate(sol)
            low_high = [round(low, 1), round(high, 1)]
        else:
            rate = float(np.interp(sol, self._rad_sols, self._rad_smooth))
        q = self.radiation["quality_factor"]
        return {
            "dose_ugy_h": round(rate, 2),
            "dose_usv_h": round(rate * q, 1),
            "dose_ugy_sol": round(rate * MARS_SOL_S / 3600, 0),
            "quality_factor": q,
            "extrapolated": sol > last,
            "estimated": low_high is not None,
            "range_ugy_h": low_high,
            "last_measured_sol": last,
        }

    def radiation_outlook(self, step: int = 10) -> dict | None:
        """The estimated dose rate from the last reading to the last sol that can be estimated, for the chart."""
        if not self.radiation or not self.forecast.radiation:
            return None
        sols = list(range(int(self._rad_sols[-1]) + step, self.forecast_until + 1, step))
        rates = [self.forecast.radiation.rate(s) for s in sols]
        return {
            "sol": sols,
            "date": [self.forecast.date_of(s) for s in sols],
            "dose_ugy_h": [round(r[0], 2) for r in rates],
            "low": [round(r[1], 2) for r in rates],
            "high": [round(r[2], 2) for r in rates],
        }

    def storm_dose(self, start_h: float, hours: float) -> float:
        """Dose (micrograys) received outdoors from `start_h` hours after storm onset, for `hours`, using the
        dose-rate profile RAD recorded during the 20 May 2024 event."""
        if not self.radiation or hours <= 0:
            return 0.0
        grid = np.linspace(start_h, start_h + hours, max(2, int(hours * 60) + 1))
        rate = np.interp(grid, self._storm_hours, self._storm_dose)
        return float(np.sum((rate[1:] + rate[:-1]) / 2 * np.diff(grid)))

    def storm_summary(self) -> dict | None:
        if not self.radiation:
            return None
        storm = self.radiation["storm"]
        return {
            "label": storm["label"],
            "utc_start": storm["utc_start"],
            "baseline_ugy_h": storm["baseline"],
            "peak_ugy_h": storm["peak"],
            "peak_ratio": storm["peak_ratio"],
            "hours_to_peak": round(storm["peak_hour"] - storm["onset_hour"], 1),
            "duration_h": round(storm["end_hour"] - storm["onset_hour"], 1),
            "excess_dose_ugy": storm["excess_dose_ugy"],
            "hours": [round(h, 2) for h in self._storm_hours.tolist()],
            "dose": storm["dose"],
        }

    def history(self) -> dict:
        """Thinned long-term series for charts."""
        step = 4
        weather = {key: self.weather[key][::step] for key in ("sol", "date", "air_min_c", "air_max_c")}
        out = {"weather": weather, "radiation": None, "radiation_estimate": self.radiation_outlook()}
        if self.radiation:
            background = self.radiation["background"]
            out["radiation"] = {"sol": background["sol"][::3], "date": background["date"][::3],
                                "dose_ugy_h": background["smooth"][::3], "unit": self.radiation["unit"]}
        return out
