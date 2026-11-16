"""Check the estimates for future days: predict Curiosity's last measured Mars year from the years before it, and
compare with what it measured. The result is shown in the app beside every estimate.

Run after build_weather.py or build_radiation.py.

Output: backend/data/forecast_check.json
Usage:  python backend/pipeline/check_forecast.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, write_json  # noqa: E402  (also puts the backend folder on the import path)

from app.forecast import backtest  # noqa: E402


def main() -> None:
    weather = json.loads((DATA / "weather.json").read_text(encoding="utf-8"))
    radiation_file = DATA / "radiation.json"
    radiation = json.loads(radiation_file.read_text(encoding="utf-8")) if radiation_file.exists() else None
    result = backtest(weather, radiation)
    result["note"] = ("Each estimate method was run as if Curiosity's record ended one Mars year earlier, and its estimates "
                      "for that last year were compared with what Curiosity measured. typical_error is the mean difference; "
                      "share_inside_range is how often the measurement fell inside the likely range shown.")
    write_json(DATA / "forecast_check.json", result, compact=False)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
