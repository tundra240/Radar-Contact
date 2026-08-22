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

/* --------------------------------------------------- how the field runs */

/**
 * One way the field can be run in a given direction.
 *
 * Segregated -- one runway landing, another departing -- is what most large
 * fields do and what Heathrow does all day: an arrival and a departure on
 * the same strip have to be separated in time, and splitting them across two
 * runways is most of where the capacity comes from. Mixed mode, everything
 * landing on everything, is the exception rather than the default, so it is
 * offered rather than assumed.
 */
export interface Configuration {
  readonly arrivals: readonly string[]
  readonly departures: readonly string[]
  readonly label: string
  readonly note: string
  readonly segregated: boolean
}

/** The ways one direction of the field can be run, segregated first. */
export function configurationsFor(direction: readonly RunwayFace[]): Configuration[] {
  const ids = direction.map((r) => r.id)
  if (ids.length === 0) return []
  if (ids.length === 1) {
    // A single strip has no choice to make: it does both, and everything
    // waits its turn.
    return [
      {
        arrivals: ids,
        departures: ids,
        label: `${ids[0]} both`,
        note: 'single runway',
        segregated: false,
      },
    ]
  }

  const out: Configuration[] = ids.map((id) => ({
    arrivals: [id],
    departures: ids.filter((other) => other !== id),
    label: `${id} lands`,
    note: `dep ${ids.filter((other) => other !== id).join('/')}`,
    segregated: true,
  }))

  out.push({
    arrivals: [...ids],
    departures: [...ids],
    label: 'Both land',
    note: 'mixed mode',
    segregated: false,
  })
  return out
}

/**
 * The same strip, from the other end.
 *
 * Found by geometry rather than by naming convention: the face pointing
 * roughly the opposite way whose centreline this one lies on. 27R and 09L
 * are one piece of concrete, and a field that turns round keeps using the
 * same concrete -- so an operation landing on the northern runway goes on
 * landing on the northern runway, under its other name.
 *
 * Parsing "27R" into "09L" would work at Heathrow and break the first time
 * an airport numbered its parallels differently at each end, which they do.
 */
export function reciprocalOf(
  face: RunwayFace,
  runways: readonly RunwayFace[],
): RunwayFace | null {
  let best: RunwayFace | null = null
  let bestOff = Infinity
  for (const other of runways) {
    if (other.id === face.id) continue
    // Facing back the other way, within a generous tolerance.
    if (Math.abs(Math.abs(angleDelta(face.bearingTrue, other.bearingTrue)) - 180) > 20) continue
    const off = crossTrackNM(other.thresholdNM, face)
    if (off < bestOff) {
      bestOff = off
      best = other
    }
  }
  return best
}

/**
 * The same operation, run in a different direction.
 *
 * Keeps which strips are landing and departing and swaps the ends, so
 * turning the field round does not silently change a segregated operation
 * into a mixed one, or move the arrivals onto the other side of the field.
 * Anything that cannot be mapped falls back to the whole direction landing,
 * which is safe rather than clever.
 */
export function flipTo(
  atis: Atis,
  direction: readonly RunwayFace[],
  runways: readonly RunwayFace[],
): { readonly arrivals: readonly string[]; readonly departures: readonly string[] } {
  const wanted = new Set(direction.map((r) => r.id))
  const carry = (ids: readonly string[]): string[] | null => {
    const out: string[] = []
    for (const id of ids) {
      // Already facing the right way: keep it.
      if (wanted.has(id)) {
        out.push(id)
        continue
      }
      const face = runways.find((r) => r.id === id)
      const other = face === undefined ? null : reciprocalOf(face, runways)
      if (other === null || !wanted.has(other.id)) return null
      out.push(other.id)
    }
    return out
  }

  const arrivals = carry(atis.arrivals)
  const departures = carry(atis.departures)
  if (arrivals === null || departures === null || arrivals.length === 0) {
    return { arrivals: direction.map((r) => r.id), departures: direction.map((r) => r.id) }
  }
  return { arrivals, departures }
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
