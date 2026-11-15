// Number and time formatting shared by panels and charts.

/** Real minutes per minute of the 24-hour Mars clock (a sol is 24 h 39 min 35 s long). */
export const CLOCK_STRETCH = 88775.244 / 86400;

/** Mars clock minutes after local midnight -> "HH:MM". */
export function clock(minutes: number): string {
  const total = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** Clock time reached after `elapsedMin` real minutes from a start on the Mars clock. */
export function clockAfter(startClockMin: number, elapsedMin: number): string {
  return clock(startClockMin + elapsedMin / CLOCK_STRETCH);
}

/** 166.3 -> "2 h 46 min"; 46 -> "46 min". */
export function duration(minutes: number): string {
  const sign = minutes < 0 ? "-" : "";
  const total = Math.round(Math.abs(minutes));
  if (total < 60) return `${sign}${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${sign}${hours} h` : `${sign}${hours} h ${rest} min`;
}

export function distance(metres: number): string {
  return metres >= 1000 ? `${(metres / 1000).toFixed(2)} km` : `${Math.round(metres)} m`;
}

export function fixed(value: number | null | undefined, digits = 0, unit = ""): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "no data";
  return `${value.toFixed(digits)}${unit}`;
}

export function temperatureRange(min: number | null, max: number | null): string {
  if (min === null || max === null) return "no data";
  return `${Math.round(min)} to ${Math.round(max)} °C`;
}

/** "Very_High" -> "Very high". */
export function label(text: string | null): string {
  if (!text) return "no data";
  const spaced = text.replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Round tick positions covering [min, max] with about `count` steps of 1, 2 or 5 x 10^n. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min];
  let ticks: number[] = [];
  for (const divisions of [count, count * 2, count * 4]) {
    // Refine the step until at least two ticks fall inside the range.
    const rough = (max - min) / divisions;
    const power = Math.pow(10, Math.floor(Math.log10(rough)));
    const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? 10 * power;
    ticks = [];
    for (let value = Math.ceil(min / step - 1e-9) * step; value <= max + step * 1e-9; value += step) {
      ticks.push(Math.abs(value) < step * 1e-9 ? 0 : value);
    }
    if (ticks.length >= 2) break;
  }
  return ticks;
}
