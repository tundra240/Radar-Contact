import { angleDelta, bearingDeg, degToRad, distanceNM, normalizeHeading, type Vec2NM } from '../core/geo'
import type { Wind } from './weather'

/**
 * The ATIS: what the field is doing, in one place.
 *
 * Every other part of the system that needs to know which runways are in
 * use asks this rather than the config, because the config records what the
 * field was set to at load and the ATIS records what it is set to now. The
 * two differ the moment anybody flips the runways, and a display reading
 * the wrong one of them is how a controller ends up vectoring to a runway
 * nobody is landing on.
 *
 * It is a value, not a controller object. Amending it returns a new one, so
 * a session's ATIS history is a list you could replay -- the same reasoning
 * as the score and the seeded traffic.
 */

/** The ICAO spelling alphabet, which is what the letter is read out as. */
export const PHONETIC: readonly string[] = [
  'Alpha',
  'Bravo',
  'Charlie',
  'Delta',
  'Echo',
  'Foxtrot',
  'Golf',
  'Hotel',
  'India',
  'Juliett',
  'Kilo',
  'Lima',
  'Mike',
  'November',
  'Oscar',
  'Papa',
  'Quebec',
  'Romeo',
  'Sierra',
  'Tango',
  'Uniform',
  'Victor',
  'Whiskey',
  'Xray',
  'Yankee',
  'Zulu',
]

/**
 * Beyond this much tailwind the runway direction is wrong.
 *
 * The number matters less than having one. Without a threshold, any wind
 * with a component down the runway would demand a flip, and a scope whose
 * runways change every time the wind wanders two degrees is unusable. This
 * is the hysteresis: a direction stays in use until it is actually bad.
 */
export const TAILWIND_LIMIT_KTS = 5

export interface Atis {
  /** Index into PHONETIC. Advances every time the broadcast changes. */
  readonly letterIndex: number
  /** Runway ids arrivals are landing on. */
  readonly arrivals: readonly string[]
  /** Runway ids departures are using. Carried and broadcast; see below. */
  readonly departures: readonly string[]
  readonly wind: Wind
}

/** Just enough of a runway to reason about wind and geometry. */
export interface RunwayFace {
  readonly id: string
  /** Direction of travel on landing, degrees true. */
  readonly bearingTrue: number
  readonly thresholdNM: Vec2NM
}

export interface AtisInit {
  readonly arrivals: readonly string[]
  readonly departures: readonly string[]
  readonly wind: Wind
  /** Where the letter starts. Defaults to Alpha. */
  readonly letterIndex?: number
}

export function makeAtis(init: AtisInit): Atis {
  return {
    letterIndex: wrapLetter(init.letterIndex ?? 0),
    arrivals: [...init.arrivals],
    departures: [...init.departures],
    wind: init.wind,
  }
}

function wrapLetter(index: number): number {
  const n = PHONETIC.length
  return ((Math.floor(index) % n) + n) % n
}

/** 'Alpha'. What the recording says. */
export function letterOf(atis: Atis): string {
  return PHONETIC[wrapLetter(atis.letterIndex)] ?? 'Alpha'
}

/** 'A'. What fits on a data block. */
export function codeOf(atis: Atis): string {
  return letterOf(atis).charAt(0).toUpperCase()
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

const sameWind = (a: Wind, b: Wind): boolean =>
  a.fromDeg === b.fromDeg && a.speedKts === b.speedKts

/**
 * A new broadcast, if anything actually changed.
 *
 * The letter advancing is the whole point of the letter: it tells a pilot
 * the information they have is stale. Advancing it for an amendment that
 * changed nothing would be lying, so an identical amendment returns the
 * very same object -- which also means callers can compare by reference to
 * see whether a broadcast happened.
 */
export function amend(atis: Atis, change: Partial<Omit<AtisInit, 'letterIndex'>>): Atis {
  const arrivals = change.arrivals ?? atis.arrivals
  const departures = change.departures ?? atis.departures
  const wind = change.wind ?? atis.wind

  if (
    sameList(arrivals, atis.arrivals) &&
    sameList(departures, atis.departures) &&
    sameWind(wind, atis.wind)
  ) {
    return atis
  }

  return {
    letterIndex: wrapLetter(atis.letterIndex + 1),
    arrivals: [...arrivals],
    departures: [...departures],
    wind,
  }
}

/** The wind as it is read out: '250/18', or 'CALM'. */
export function windString(wind: Wind): string {
  if (wind.speedKts <= 0) return 'CALM'
  const dir = String(Math.round(normalizeHeading(wind.fromDeg))).padStart(3, '0')
  return `${dir}/${Math.round(wind.speedKts)}`
}

/** The ticker line: what the field is doing, in one string. */
export function broadcast(atis: Atis): string {
  const parts = [
    `INFO ${codeOf(atis)}`,
    `ARR ${atis.arrivals.join('/') || '--'}`,
    `DEP ${atis.departures.join('/') || '--'}`,
    windString(atis.wind),
  ]
  return parts.join('  ')
}

/* ------------------------------------------------------- wind and runways */

/** Knots of wind straight down the runway. Negative is a tailwind. */
export function headwindKts(bearingTrue: number, wind: Wind): number {
  // The wind is reported FROM, the runway bearing is the direction of
  // travel, so a wind from dead ahead is zero degrees off and full headwind.
  const off = angleDelta(bearingTrue, wind.fromDeg)
  return wind.speedKts * Math.cos(degToRad(off))
}

/** Knots of wind across it, unsigned. */
export function crosswindKts(bearingTrue: number, wind: Wind): number {
  const off = angleDelta(bearingTrue, wind.fromDeg)
  return Math.abs(wind.speedKts * Math.sin(degToRad(off)))
}

/**
 * The runway faces grouped by the direction they land in.
 *
 * A field does not choose runways one at a time -- it chooses a direction,
 * and every parallel in that direction comes with it. Grouped to within a
 * few degrees, since parallels are not always published identically.
 */
export function directionsOf(runways: readonly RunwayFace[]): RunwayFace[][] {
  const groups: RunwayFace[][] = []
  for (const rwy of runways) {
    const found = groups.find(
      (g) => Math.abs(angleDelta(g[0]!.bearingTrue, rwy.bearingTrue)) <= 10,
    )
    if (found) found.push(rwy)
    else groups.push([rwy])
  }
  return groups
}

/** The direction that lands most into wind, as its runway ids. */
export function bestDirection(
  runways: readonly RunwayFace[],
  wind: Wind,
): readonly string[] {
  const groups = directionsOf(runways)
  let best: RunwayFace[] | null = null
  let bestHead = -Infinity
  for (const group of groups) {
    const head = headwindKts(group[0]!.bearingTrue, wind)
    if (head > bestHead) {
      bestHead = head
      best = group
    }
  }
  return (best ?? []).map((r) => r.id)
}

/**
 * Whether the runways in use have become the wrong ones.
 *
 * True only once the tailwind on the active direction passes the limit, so
 * a wind swinging about near the beam does not set the field flipping back
 * and forth. Answering "is there something better" instead would do exactly
 * that.
 */
export function shouldFlip(
  atis: Atis,
  runways: readonly RunwayFace[],
  wind: Wind = atis.wind,
): boolean {
  const active = runways.filter((r) => atis.arrivals.includes(r.id))
  if (active.length === 0) return runways.length > 0
  const head = headwindKts(active[0]!.bearingTrue, wind)
  if (head >= -TAILWIND_LIMIT_KTS) return false
  // Only worth flipping if the alternative is actually better.
  const better = bestDirection(runways, wind)
  return better.length > 0 && !better.every((id) => atis.arrivals.includes(id))
}

/* ------------------------------------------------------------ the feed */

/**
 * How far a point sits off a runway's extended centreline, in miles.
 *
 * Signed distance to the infinite line through the threshold along the
 * landing direction. Which side is which does not matter here; the size of
 * it does.
 */
export function crossTrackNM(fix: Vec2NM, runway: RunwayFace): number {
  const away = distanceNM(runway.thresholdNM, fix)
  if (away === 0) return 0
  const off = angleDelta(runway.bearingTrue, bearingDeg(runway.thresholdNM, fix))
  return Math.abs(away * Math.sin(degToRad(off)))
}

/**
 * Which active runway an entry fix feeds.
 *
 * The one whose extended centreline the fix is closest to, which for a pair
 * of parallels is simply the one on its side of the field. At Heathrow that
 * gives the northern fixes the northern runway and the southern fixes the
 * southern one -- and because the choice is made from the runways currently
 * in use, it turns over by itself when the field flips: a fix feeding 27R
 * feeds 09L instead, the same strip from the other end.
 *
 * Null when nothing is landing, which is a state the display has to survive
 * rather than a state to prevent.
 */
export function feedRunway(
  fix: Vec2NM,
  active: readonly RunwayFace[],
): string | null {
  let best: RunwayFace | null = null
  let bestOff = Infinity
  for (const rwy of active) {
    const off = crossTrackNM(fix, rwy)
    if (off < bestOff) {
      bestOff = off
      best = rwy
    }
  }
  return best?.id ?? null
}

/** Every entry fix and the runway it feeds, for the runways now in use. */
export function feedPlan(
  fixes: readonly { readonly name: string; readonly posNM: Vec2NM }[],
  active: readonly RunwayFace[],
): Map<string, string> {
  const plan = new Map<string, string>()
  for (const fix of fixes) {
    const runway = feedRunway(fix.posNM, active)
    if (runway !== null) plan.set(fix.name, runway)
  }
  return plan
}
