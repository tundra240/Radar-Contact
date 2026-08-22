import { advance, bearingDeg, degToRad, distanceNM, normalizeHeading, type Vec2NM } from '../core/geo'
import type { Rng } from '../core/rng'

/**
 * Wind, and weather on the radar.
 *
 * Two things that belong together because one drives the other: the cells
 * drift downwind, and the same wind pushes the aircraft about.
 *
 * Nothing here is stored in a save. The cells are a pure function of the
 * session seed and the config, and where they have got to is a pure
 * function of elapsed time -- so a loaded session regenerates exactly the
 * weather it was saved with, without the save carrying a single polygon.
 */

/* ------------------------------------------------------------------- wind */

export interface Wind {
  /** The direction the wind is FROM, degrees true, as an ATIS reports it. */
  readonly fromDeg: number
  readonly speedKts: number
}

/**
 * The wind as a velocity: where the air is going, in knots.
 *
 * Reported from, flown towards -- the reciprocal is the whole of the
 * confusion in this subject, so it is converted once, here.
 *
 * `strength` scales it. Applied to aircraft at a fraction of full, because
 * a full twenty-knot crosswind at 180 kt is an eight degree drift angle,
 * and vectoring against that stops being a game and becomes an exercise in
 * anticipating the wind.
 */
export function windVector(wind: Wind, strength = 1): Vec2NM {
  const towards = normalizeHeading(wind.fromDeg + 180)
  return advance({ x: 0, y: 0 }, towards, wind.speedKts * strength)
}

/* ------------------------------------------------------------- the cells */

export type Intensity = 'light' | 'moderate' | 'heavy'

/** Where each band begins, as a fraction of full intensity. */
export const MODERATE_AT = 1 / 3
export const HEAVY_AT = 2 / 3

/** One term of the wobble that turns a circle into a weather cell. */
export interface Lobe {
  readonly harmonic: number
  readonly amp: number
  readonly phase: number
}

export interface WeatherCell {
  /** Where the cell was at the start of the session. */
  readonly originNM: Vec2NM
  /** Nominal radius of the outer, lightest contour. */
  readonly radiusNM: number
  /** How bad the core is, 0..1. Below MODERATE_AT it is only ever light. */
  readonly peak: number
  readonly lobes: readonly Lobe[]
}

export interface Weather {
  readonly wind: Wind
  readonly cells: readonly WeatherCell[]
  /** Cells move at this fraction of the wind speed. */
  readonly driftFactor: number
}

export interface WeatherConfig {
  readonly wind: Wind
  /**
   * The chance that a session gets any precipitation at all, 0..1.
   *
   * Deliberately low. Weather that is always on the scope is not weather,
   * it is terrain: it stops being something you react to and becomes part
   * of the chart. Most sessions are clear.
   *
   * The wind is not gated by this. Wind is always there.
   */
  readonly chance: number
  /** The most cells a session with weather gets. Fewer is the common case. */
  readonly maxCells: number
  readonly minRadiusNM: number
  readonly maxRadiusNM: number
  readonly driftFactor: number
  /** Cells are placed within this of the field. */
  readonly spreadNM: number
}

/** How many harmonics deform each cell. Three is lumpy; ten is noise. */
const LOBE_COUNT = 4

/**
 * How many cells a session gets: usually none, occasionally a few.
 *
 * Two draws rather than one, because they answer different questions. The
 * first is whether today has weather at all -- most days do not. The second
 * is how much, and it is skewed low, so an occurrence is a shower or two far
 * more often than it is a front lying across the whole area.
 *
 * The count is settled before any cell is placed, so a clear session draws
 * one number and stops.
 */
export function cellCount(rng: Rng, config: WeatherConfig): number {
  const most = Math.max(0, Math.floor(config.maxCells))
  if (most === 0) return 0
  if (!rng.chance(config.chance)) return 0
  // Squared, so half of the wet sessions are a single cell and the full
  // four are the exception. The rarity is meant to be felt twice: most
  // sessions have nothing, and most of the rest have one thing.
  return 1 + Math.floor(Math.pow(rng.next(), 2) * most)
}

/**
 * Weather for a session, from the seeded generator.
 *
 * Seeded rather than random so that a scenario is repeatable and a bug
 * report is actionable, for the same reasons the traffic is. Most sessions
 * come back with no cells at all -- see `cellCount`.
 */
export function makeWeather(rng: Rng, config: WeatherConfig): Weather {
  const cells: WeatherCell[] = []
  for (let i = 0, count = cellCount(rng, config); i < count; i += 1) {
    cells.push({
      // Placed by bearing and range rather than in a square, so the spread
      // is actually round and cells are not clustered in the corners.
      originNM: advance(
        { x: 0, y: 0 },
        rng.range(0, 359),
        Math.sqrt(rng.next()) * config.spreadNM,
      ),
      radiusNM: config.minRadiusNM + rng.next() * (config.maxRadiusNM - config.minRadiusNM),
      // Skewed towards the weaker end: a scope of solid red is not weather,
      // it is a wall.
      peak: 0.25 + Math.pow(rng.next(), 1.6) * 0.75,
      lobes: Array.from({ length: LOBE_COUNT }, (_unused, n) => ({
        harmonic: n + 2,
        // Shallower for the finer harmonics, or the outline turns to fur.
        amp: (0.18 / (n + 1)) * rng.next(),
        phase: rng.range(0, 359),
      })),
    })
  }
  return { wind: config.wind, cells, driftFactor: config.driftFactor }
}

/** Where a cell has drifted to, by the clock. */
export function cellCentreNM(
  cell: WeatherCell,
  weather: Weather,
  elapsedSeconds: number,
): Vec2NM {
  const hours = Math.max(0, elapsedSeconds) / 3600
  const drift = windVector(weather.wind, weather.driftFactor * hours)
  return { x: cell.originNM.x + drift.x, y: cell.originNM.y + drift.y }
}

/**
 * The cell's edge in a given direction.
 *
 * A circle plus a few harmonics: cheap, smooth, and it reads as weather
 * rather than as a drawn shape, which a circle never does.
 */
export function cellRadiusNM(cell: WeatherCell, towardsDeg: number): number {
  let wobble = 1
  for (const lobe of cell.lobes) {
    wobble += lobe.amp * Math.cos(degToRad(lobe.harmonic * towardsDeg + lobe.phase))
  }
  return cell.radiusNM * Math.max(0.25, wobble)
}

/** Precipitation intensity at a point, 0 for clear air. */
export function intensityAt(weather: Weather, at: Vec2NM, elapsedSeconds: number): number {
  let worst = 0
  for (const cell of weather.cells) {
    const centre = cellCentreNM(cell, weather, elapsedSeconds)
    const away = distanceNM(centre, at)
    const edge = cellRadiusNM(cell, bearingDeg(centre, at))
    if (away >= edge) continue
    // Domed rather than linear, so the core is a core and not a point.
    const fraction = away / edge
    worst = Math.max(worst, cell.peak * (1 - fraction * fraction))
  }
  return worst
}

/** Which band an intensity falls in, or null for clear air. */
export function bandOf(intensity: number): Intensity | null {
  if (intensity >= HEAVY_AT) return 'heavy'
  if (intensity >= MODERATE_AT) return 'moderate'
  if (intensity > 0) return 'light'
  return null
}

/**
 * How far out a band's contour lies, as a fraction of the cell's edge, or
 * null when the cell never gets that bad.
 *
 * Inverts the dome: intensity = peak * (1 - f^2), so the contour for a
 * threshold t sits at f = sqrt(1 - t/peak).
 */
export function contourFraction(cell: WeatherCell, band: Intensity): number | null {
  const threshold = band === 'heavy' ? HEAVY_AT : band === 'moderate' ? MODERATE_AT : 0
  if (cell.peak <= threshold) return null
  return Math.sqrt(1 - threshold / cell.peak)
}

/** Whether weather here is bad enough that an aircraft would ask to avoid it. */
export function isAvoidable(intensity: number): boolean {
  return intensity >= MODERATE_AT
}
