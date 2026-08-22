import { advance, bearingDeg, degToRad, distanceNM, normalizeHeading, type Vec2NM } from '../core/geo'
import { makeRng, type Rng } from '../core/rng'

/**
 * Wind, and weather on the radar.
 *
 * Two things that belong together because one drives the other: the cells
 * drift downwind, and the same wind pushes the aircraft about.
 *
 * Nothing here is stored in a save. Weather is a *schedule* -- a seed and a
 * config -- and which cells exist at a given moment is a pure function of
 * that schedule and the clock. So a loaded session regenerates exactly the
 * weather it was saved with, half-grown cells included, without the save
 * carrying a single polygon.
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
  /** Where the cell formed. It drifts from here. */
  readonly originNM: Vec2NM
  /** Nominal radius at full development. */
  readonly radiusNM: number
  /** How bad the core gets at its worst, 0..1. Reached at mid-life only. */
  readonly peak: number
  readonly lobes: readonly Lobe[]
  /** Session time it formed, in seconds. Negative: before you sat down. */
  readonly bornSeconds: number
  /** How long it lasts, forming to collapse. */
  readonly lifeSeconds: number
}

export interface WeatherConfig {
  readonly wind: Wind
  /**
   * How many cells form per hour, on average.
   *
   * With a life of a few minutes each, this is what makes weather an event
   * rather than a fixture: a low rate means most of the hour has nothing in
   * it, and you meet a cell once or twice a session rather than sitting
   * under six of them from the moment you log on.
   */
  readonly cellsPerHour: number
  readonly minLifeMinutes: number
  readonly maxLifeMinutes: number
  /**
   * The share of cells that ever develop a red core, 0..1.
   *
   * Small on purpose. A thunderstorm you get every session is not a
   * thunderstorm, it is scenery -- and the distribution this replaced let
   * three cells in ten core out, which with six of them on the scope put
   * red on nine sessions in ten.
   */
  readonly heavyChance: number
  readonly minRadiusNM: number
  readonly maxRadiusNM: number
  /** Cells drift at this fraction of the wind speed. */
  readonly driftFactor: number
  /** Cells form within this range of the field. */
  readonly spreadNM: number
}

/**
 * A weather schedule: everything needed to say what exists when, and
 * nothing about what exists now.
 */
export interface Weather {
  readonly wind: Wind
  readonly driftFactor: number
  readonly seed: number
  readonly config: WeatherConfig
}

/**
 * The schedule for a session.
 *
 * Takes the generator only for its seed. Cells are drawn per hour-slot from
 * a seed derived from this one, which is what lets the timeline run forward
 * indefinitely without being generated up front.
 */
export function makeWeather(rng: Rng, config: WeatherConfig): Weather {
  return { wind: config.wind, driftFactor: config.driftFactor, seed: rng.seed, config }
}

/* ---------------------------------------------------------- the schedule */

const SECONDS_PER_HOUR = 3600

/** How many harmonics deform each cell. Three is lumpy; ten is noise. */
const LOBE_COUNT = 4

/**
 * A generator for the cells forming in one hour-slot of session time.
 *
 * Derived from the session seed and the slot index, so slot -1 -- the hour
 * before you logged on -- is as well defined as slot 5, and asking the same
 * question twice gets the same answer without anything being stored.
 */
function slotRng(seed: number, slot: number): Rng {
  return makeRng((seed ^ Math.imul(slot, 0x9e3779b9)) >>> 0)
}

/**
 * A Poisson count for the given mean.
 *
 * Poisson rather than a fixed rate because cells form independently, and
 * that is what a Poisson process is. It also gives the clustering that
 * makes it read as weather: two showers in one hour and then nothing for
 * three, instead of one an hour like a metronome.
 */
function poisson(rng: Rng, mean: number): number {
  if (!(mean > 0)) return 0
  const limit = Math.exp(-mean)
  let k = 0
  let p = 1
  // Capped, so a nonsense config cannot spin here forever.
  while (k < 64) {
    p *= rng.next()
    if (p <= limit) break
    k += 1
  }
  return k
}

/** The cells that form during one hour-slot of session time. */
function cellsBornIn(weather: Weather, slot: number): WeatherCell[] {
  const config = weather.config
  const rng = slotRng(weather.seed, slot)
  const count = poisson(rng, config.cellsPerHour)
  const cells: WeatherCell[] = []

  for (let i = 0; i < count; i += 1) {
    const minLife = Math.max(1, config.minLifeMinutes)
    const maxLife = Math.max(minLife, config.maxLifeMinutes)
    cells.push({
      // Placed by bearing and range rather than in a square, so the spread
      // is actually round and cells are not clustered in the corners.
      originNM: advance(
        { x: 0, y: 0 },
        rng.range(0, 359),
        Math.sqrt(rng.next()) * config.spreadNM,
      ),
      radiusNM: config.minRadiusNM + rng.next() * (config.maxRadiusNM - config.minRadiusNM),
      peak: drawPeak(rng, config.heavyChance),
      lobes: Array.from({ length: LOBE_COUNT }, (_unused, n) => ({
        harmonic: n + 2,
        // Shallower for the finer harmonics, or the outline turns to fur.
        amp: (0.18 / (n + 1)) * rng.next(),
        phase: rng.range(0, 359),
      })),
      bornSeconds: slot * SECONDS_PER_HOUR + rng.next() * SECONDS_PER_HOUR,
      lifeSeconds: (minLife + rng.next() * (maxLife - minLife)) * 60,
    })
  }
  return cells
}

/**
 * How bad a cell gets at its worst.
 *
 * Two cases rather than one skewed curve, because the interesting question
 * -- does this one core out to red -- deserves to be a number in the config
 * you can read and change, not a consequence of an exponent.
 */
function drawPeak(rng: Rng, heavyChance: number): number {
  if (rng.chance(heavyChance)) return HEAVY_AT + rng.next() * (1 - HEAVY_AT)
  // Skewed to the weak end, so most of what is left is a green shower and
  // only some of it works up to amber.
  return 0.1 + Math.pow(rng.next(), 1.4) * (MODERATE_AT * 2 - 0.1)
}

/**
 * The cells in existence at a given moment.
 *
 * Scans the slots that could still hold a living cell -- this hour and as
 * many previous ones as the longest life reaches back through -- so a cell
 * born before the session began is found too. That is deliberate: it is
 * what makes logging on into weather already in progress possible without
 * being special-cased.
 */
export function activeCells(weather: Weather, elapsedSeconds: number): WeatherCell[] {
  const maxLifeSeconds = Math.max(1, weather.config.maxLifeMinutes) * 60
  const reachBack = Math.ceil(maxLifeSeconds / SECONDS_PER_HOUR)
  const slot = Math.floor(elapsedSeconds / SECONDS_PER_HOUR)
  const out: WeatherCell[] = []

  for (let s = slot - reachBack; s <= slot; s += 1) {
    for (const cell of cellsBornIn(weather, s)) {
      if (envelopeOf(cell, elapsedSeconds) > 0) out.push(cell)
    }
  }
  return out
}

/**
 * How far through its life a cell is, as a share of full strength: nothing
 * at formation, everything half way through, nothing again at collapse.
 *
 * A half sine rather than a triangle, so it grows and dies smoothly and
 * there is no frame where a contour appears at full size.
 */
export function envelopeOf(cell: WeatherCell, elapsedSeconds: number): number {
  if (cell.lifeSeconds <= 0) return 0
  const age = (elapsedSeconds - cell.bornSeconds) / cell.lifeSeconds
  if (age <= 0 || age >= 1) return 0
  return Math.sin(Math.PI * age)
}

/**
 * How big the cell is now, as a share of its nominal radius.
 *
 * Never all the way to nothing: a cell that shrank to a point would read as
 * a disappearing dot rather than as rain thinning out, and the intensity
 * envelope already takes it off the scope.
 */
export function radiusScaleOf(envelope: number): number {
  return 0.45 + 0.55 * Math.max(0, Math.min(1, envelope))
}

/* ------------------------------------------------------ geometry and bands */

/** Where a cell has drifted to, by the clock. Downwind from where it formed. */
export function cellCentreNM(
  cell: WeatherCell,
  weather: Weather,
  elapsedSeconds: number,
): Vec2NM {
  const hours = Math.max(0, elapsedSeconds - cell.bornSeconds) / SECONDS_PER_HOUR
  const drift = windVector(weather.wind, weather.driftFactor * hours)
  return { x: cell.originNM.x + drift.x, y: cell.originNM.y + drift.y }
}

/**
 * The cell's edge in a given direction, at full development.
 *
 * A circle plus a few harmonics: cheap, smooth, and it reads as weather
 * rather than as a drawn shape, which a circle never does. Scale by
 * `radiusScaleOf` for the size it is at a given moment.
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
  for (const cell of activeCells(weather, elapsedSeconds)) {
    const envelope = envelopeOf(cell, elapsedSeconds)
    const now = cell.peak * envelope
    if (now <= 0) continue
    const centre = cellCentreNM(cell, weather, elapsedSeconds)
    const away = distanceNM(centre, at)
    const edge = cellRadiusNM(cell, bearingDeg(centre, at)) * radiusScaleOf(envelope)
    if (away >= edge) continue
    // Domed rather than linear, so the core is a core and not a point.
    const fraction = away / edge
    worst = Math.max(worst, now * (1 - fraction * fraction))
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
 * How far out a band's contour lies, as a fraction of the cell's current
 * edge, or null when the cell is not that bad at the moment.
 *
 * Inverts the dome: intensity = now * (1 - f^2), so the contour for a
 * threshold t sits at f = sqrt(1 - t/now). Which gives for free that a cell
 * too weak -- or too young, or too far gone -- to reach a band has no
 * contour for it, so a shower is one green blob rather than a storm with
 * rings of zero size, and a growing cell greens up before it ambers.
 */
export function contourFraction(
  cell: WeatherCell,
  band: Intensity,
  envelope: number,
): number | null {
  const threshold = band === 'heavy' ? HEAVY_AT : band === 'moderate' ? MODERATE_AT : 0
  const now = cell.peak * Math.max(0, envelope)
  if (now <= threshold) return null
  return Math.sqrt(1 - threshold / now)
}

/** Whether weather here is bad enough that an aircraft would ask to avoid it. */
export function isAvoidable(intensity: number): boolean {
  return intensity >= MODERATE_AT
}
