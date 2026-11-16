"""Estimated conditions for Mars days after Curiosity's record ends.

The planner normally replays what Curiosity measured on a sol. For a day in the future there is no measurement, so
it estimates one, and the estimate is marked as such everywhere it is shown.

Weather (temperature, sunrise and sunset, UV, air pressure)
    Mars repeats its seasons every Mars year of 668.6 sols, and Curiosity has measured more than seven of them. A
    future day is estimated from the same days of the year (the same sol, plus or minus a week) in every past year:
    the middle value is the estimate, and the 10th to 90th percentile is the likely range. Air pressure uses only the
    most recent year with that season: Curiosity has been climbing Mount Sharp, where the air is thinner, so older
    years were measured lower down, and in the most recent year it was in the study area.

Background radiation
    Radiation from deep space follows the Sun's activity cycle of about 11 years (highest when the Sun is quiet). A
    cycle is fitted to the radiation detector's record and shifted to meet the latest reading, with the shift fading
    over two years. The likely range is how far the same method was off when it was tried from earlier points in the
    record, for the same distance ahead.

Dust storms and solar storms cannot be predicted. backtest() checks the method by predicting Curiosity's last
measured Mars year from the years before it.
"""
from __future__ import annotations

import datetime
import math
from collections import Counter

import numpy as np

MARS_YEAR_SOLS = 668.5991
SOL_DAYS = 88775.244 / 86400            # Earth days in a sol
SOL_YEARS = SOL_DAYS / 365.25           # Earth years in a sol
WINDOW_SOLS = 7                         # same days of the year: the matching sol, plus or minus a week
HORIZON_MARS_YEARS = 2                  # estimates reach this far past the record
CYCLE_YEARS = np.arange(8.0, 14.01, 0.1)  # solar cycle lengths tried when fitting the radiation record
FADE_YEARS = 2.0                        # how long the fitted cycle takes to forget the latest reading
EPOCH = datetime.date(2012, 8, 6)       # Curiosity's landing day, as a reference for Earth dates

NUMERIC = ("air_min_c", "air_max_c", "ground_min_c", "ground_max_c", "pressure_pa")
LATEST_YEAR_ONLY = {"pressure_pa"}

WARNINGS = [
    "This day is in the future: these are estimates from past Mars years, not measurements.",
    "Dust storms cannot be predicted. In a dust storm, days are darker, nights are warmer and the sky is hazy.",
    "Solar storms cannot be predicted. Use the solar storm test to check the way back to shelter.",
]


class Forecast:
    """Estimates for sols after the record. `until_sol` hides later data, for testing the method on past years."""

    def __init__(self, weather: dict, radiation: dict | None, until_sol: int | None = None) -> None:
        sols = np.asarray(weather["sol"], dtype=int)
        keep = sols <= (until_sol if until_sol is not None else sols.max())
        self.first_sol = int(sols[keep].min())
        self.last_sol = int(sols[keep].max())
        self.until_sol = self.last_sol + int(round(HORIZON_MARS_YEARS * MARS_YEAR_SOLS))

        # Every measurement in an array indexed by sol, with gaps as NaN (or None), so a season is a slice.
        size = self.last_sol + 1
        self._columns: dict[str, np.ndarray] = {}
        for key in NUMERIC + ("ls", "sunrise_min", "sunset_min"):
            column = np.full(size, np.nan)
            for sol, value, kept in zip(sols, weather[key], keep):
                if kept and value is not None:
                    column[sol] = float(value)
            self._columns[key] = column
        self._uv = [None] * size
        for sol, value, kept in zip(sols, weather["uv"], keep):
            if kept:
                self._uv[sol] = value

        # Earth date of a sol: a straight line through the record's dates (one sol is 1.0275 days).
        days = [((datetime.date.fromisoformat(d) - EPOCH).days, s) for d, s, k in zip(weather["date"], sols, keep) if d and k]
        day_numbers, day_sols = np.array([d for d, _ in days], float), np.array([s for _, s in days], float)
        self._day_slope, self._day_offset = np.polyfit(day_sols, day_numbers, 1)

        self.radiation = _RadiationTrend(radiation, until_sol) if radiation else None

    # ---- dates ----------------------------------------------------------------------------------------

    def date_of(self, sol: float) -> str:
        return (EPOCH + datetime.timedelta(days=float(self._day_offset + self._day_slope * sol))).isoformat()

    def sol_on(self, day: datetime.date) -> int:
        return int(round(((day - EPOCH).days - self._day_offset) / self._day_slope))

    def today_sol(self) -> int:
        return self.sol_on(datetime.datetime.now(datetime.timezone.utc).date())

    # ---- weather --------------------------------------------------------------------------------------

    def _seasons(self, sol: int) -> list[tuple[float, slice]]:
        """The same days of the year in each past year, most recent first: (matching sol, the sols around it)."""
        out = []
        k = 1
        while (centre := sol - k * MARS_YEAR_SOLS) >= self.first_sol - WINDOW_SOLS:
            middle = int(round(centre))
            if middle - WINDOW_SOLS <= self.last_sol:
                out.append((centre, slice(max(self.first_sol, middle - WINDOW_SOLS), min(self.last_sol, middle + WINDOW_SOLS) + 1)))
            k += 1
        return out

    def weather(self, sol: int) -> tuple[dict, dict]:
        """Estimated weather for a sol after the record: (values like a measured day, how they were estimated)."""
        if sol <= self.last_sol:
            raise ValueError(f"sol {sol} was measured; estimates start after sol {self.last_sol}")
        if sol > self.until_sol:
            raise ValueError(f"Estimates reach only to sol {self.until_sol} ({self.date_of(self.until_sol)}), "
                             f"{HORIZON_MARS_YEARS} Mars years after Curiosity's latest measurement.")
        matches = self._seasons(sol)
        seasons = [s for _, s in matches]
        values: dict = {"date": self.date_of(sol)}
        ranges: dict[str, list[float]] = {}
        for key in NUMERIC:
            column = self._columns[key]
            parts = [column[s][np.isfinite(column[s])] for s in seasons]
            parts = [p for p in parts if p.size >= 3]
            if key in LATEST_YEAR_ONLY:
                parts = parts[:1]
            if not parts:
                values[key] = None
                continue
            pooled = np.concatenate(parts)
            middle = float(np.median(pooled))
            low, high = float(np.percentile(pooled, 10)), float(np.percentile(pooled, 90))
            if key in LATEST_YEAR_ONLY:  # one year says little about how much the next one differs: allow 2 % either way
                low, high = min(low, middle * 0.98), max(high, middle * 1.02)
            values[key] = round(middle, 1)
            ranges[key] = [round(low, 1), round(high, 1)]
        for key in ("sunrise_min", "sunset_min"):
            column = self._columns[key]
            pooled = np.concatenate([column[s][np.isfinite(column[s])] for s in seasons] or [np.array([])])
            values[key] = int(round(float(np.median(pooled)))) if pooled.size else None
        values["ls"] = self._ls(matches)
        uv = Counter(v for s in seasons for v in self._uv[s] if v)
        values["uv"] = uv.most_common(1)[0][0] if uv else None

        used = [centre for centre, s in matches if np.isfinite(self._columns["air_min_c"][s]).any()]
        estimate = {
            "years_used": len(used),
            "same_season_sols": [int(round(centre)) for centre in used],
            "ranges": ranges,
            "method": (f"Estimated from the same time of year in {len(used)} past Mars years that Curiosity measured. "
                       "Most likely value shown; the range is what 8 in 10 of those days fell within."),
            "warnings": WARNINGS,
        }
        return values, estimate

    def _ls(self, matches: list[tuple[float, slice]]) -> float | None:
        """Solar longitude (position in the Mars year): the same as at the matching sol of the latest past year."""
        column = self._columns["ls"]
        for centre, season in matches:
            measured = [i for i in range(season.start, season.stop) if np.isfinite(column[i])]
            if measured:
                nearest = min(measured, key=lambda i: abs(i - centre))
                # Ls moves about 0.54 degrees a sol on average; the nearest measured sol is at most a week away.
                return round(float(column[nearest] + (centre - nearest) * 360.0 / MARS_YEAR_SOLS) % 360.0, 1)
        return None


class _RadiationTrend:
    """Background dose rate after the radiation record: the solar cycle, fitted and joined to the latest reading."""

    def __init__(self, radiation: dict, until_sol: int | None) -> None:
        background = radiation["background"]
        sols = np.asarray(background["sol"], dtype=float)
        dose = np.asarray(background["smooth"], dtype=float)
        keep = sols <= (until_sol if until_sol is not None else sols.max())
        self.sols, self.dose = sols[keep], dose[keep]
        self.last_sol = int(self.sols[-1])
        self.model = _fit_cycle(self.sols, self.dose)
        # How far the method was off before, by distance ahead: fit up to earlier points, compare with what followed.
        errors: list[tuple[float, float]] = []
        for cut in np.arange(self.sols[0] + 3 * MARS_YEAR_SOLS, self.last_sol - 60, 0.5 * MARS_YEAR_SOLS):
            past = self.sols <= cut
            trend = _Trend(self.sols[past], self.dose[past])
            later = (self.sols > cut) & (self.sols <= cut + HORIZON_MARS_YEARS * MARS_YEAR_SOLS)
            for s, actual in zip(self.sols[later], self.dose[later]):
                errors.append(((s - cut) * SOL_YEARS, abs(trend.rate(s) - actual)))
        self.error_years = np.array([e[0] for e in errors]) if errors else np.array([0.0])
        self.error_size = np.array([e[1] for e in errors]) if errors else np.array([1.0])
        self.trend = _Trend(self.sols, self.dose, self.model)

    def margin(self, years_ahead: float) -> float:
        """Likely error (90th percentile of past errors) this far ahead, never shrinking with distance."""
        margins = []
        for edge in (0.5, 1.0, 2.0, 3.0, 4.0):
            close = self.error_years <= edge
            margins.append(float(np.percentile(self.error_size[close], 90)) if close.any() else 1.0)
            if years_ahead <= edge:
                break
        return max(0.5, max(margins))

    def rate(self, sol: float) -> tuple[float, float, float]:
        """(estimate, low, high) in micrograys per hour."""
        rate = self.trend.rate(sol)
        margin = self.margin(max(0.0, (sol - self.last_sol) * SOL_YEARS))
        return rate, max(0.1, rate - margin), rate + margin


def _fit_cycle(sols: np.ndarray, dose: np.ndarray) -> tuple[float, float, float, float]:
    """Least-squares mean + sinusoid, trying cycle lengths of 8 to 14 years: (period years, mean, sin, cos)."""
    t = sols * SOL_YEARS
    best = None
    for period in CYCLE_YEARS:
        w = 2 * math.pi / period
        design = np.column_stack([np.ones_like(t), np.sin(w * t), np.cos(w * t)])
        coef, *_ = np.linalg.lstsq(design, dose, rcond=None)
        error = float(np.sum((dose - design @ coef) ** 2))
        if best is None or error < best[0]:
            best = (error, float(period), *map(float, coef))
    return best[1:]


class _Trend:
    def __init__(self, sols: np.ndarray, dose: np.ndarray, model: tuple | None = None) -> None:
        self.period, self.mean, self.a, self.b = model or _fit_cycle(sols, dose)
        self.last_sol = float(sols[-1])
        self.offset = float(np.median(dose[-10:])) - self._cycle(self.last_sol)

    def _cycle(self, sol: float) -> float:
        w = 2 * math.pi / self.period
        t = sol * SOL_YEARS
        return self.mean + self.a * math.sin(w * t) + self.b * math.cos(w * t)

    def rate(self, sol: float) -> float:
        fade = math.exp(-max(0.0, sol - self.last_sol) * SOL_YEARS / FADE_YEARS)
        return max(0.1, self._cycle(sol) + self.offset * fade)


def backtest(weather: dict, radiation: dict | None) -> dict:
    """Predict Curiosity's last measured Mars year from the years before it, and compare with what it measured."""
    sols = np.asarray(weather["sol"], dtype=int)
    cut = int(sols.max() - MARS_YEAR_SOLS)
    forecast = Forecast(weather, radiation, until_sol=cut)
    errors: dict[str, list[float]] = {key: [] for key in ("sunrise_min", "sunset_min", "air_min_c", "air_max_c", "pressure_pa")}
    inside = {key: 0 for key in errors}
    for i, sol in enumerate(sols):
        if sol <= cut:
            continue
        values, estimate = forecast.weather(int(sol))
        for key in errors:
            actual = weather[key][i]
            if actual is None or values.get(key) is None:
                continue
            errors[key].append(abs(values[key] - float(actual)))
            low, high = estimate["ranges"].get(key, (values[key], values[key]))
            inside[key] += int(low <= float(actual) <= high)
    out = {
        "tested_sols": [cut + 1, int(sols.max())],
        "typical_error": {key: round(float(np.mean(v)), 1) for key, v in errors.items() if v},
        "share_inside_range": {key: round(inside[key] / len(v), 2) for key, v in errors.items() if v and key not in ("sunrise_min", "sunset_min")},
    }
    if radiation and forecast.radiation:
        background = radiation["background"]
        rad_errors, rad_inside = [], []
        for s, actual in zip(background["sol"], background["smooth"]):
            if s > cut:
                estimate, low, high = forecast.radiation.rate(s)
                rad_errors.append(abs(estimate - actual))
                rad_inside.append(low <= actual <= high)
        if rad_errors:
            out["typical_error"]["radiation_ugy_h"] = round(float(np.mean(rad_errors)), 2)
            out["share_inside_range"]["radiation_ugy_h"] = round(float(np.mean(rad_inside)), 2)
    return out
