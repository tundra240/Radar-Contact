import { advance, bearingDeg, type Vec2NM } from '../core/geo'
import { exitRangeNM } from '../sim/airspace'
import type { Airport, Navaid } from '../data/airport'
import { corridorEntry, corridorRoute } from '../sim/overflight'
import type { Aircraft, HoldClearance } from '../sim/types'
import type { Weather, WeatherCell } from '../sim/weather'
import type { ScriptedAircraft, ScriptedStorm } from './types'

/**
 * Turning a lesson's description of a situation into aircraft and weather.
 *
 * A step says "an arrival over BIG at 10,000 feet" and this produces the
 * aeroplane the spawner would have produced, in the same place, carrying
 * the same clearance. That last part matters more than it looks: an arrival
 * appears out along its hold's inbound leg holding a pattern, and enters
 * the hold on its own when it gets there. Placing one any other way would
 * mean the hold step of the lesson taught something the sector does not
 * actually do.
 *
 * Nothing here is random. A lesson taken twice is the same lesson, which is
 * the one property a lesson has to have and a session deliberately does
 * not.
 */

const ARP: Vec2NM = { x: 0, y: 0 }

/** Fallback for a lesson that does not name a type. */
const DEFAULT_TYPE = 'A320'

/**
 * Where a scripted arrival appears: the spawner's own entry point, out
 * along the radial through its fix and clear of the airspace.
 *
 * Computed the same way rather than shared, because the spawner's is
 * private to it and a lesson wanting a different distance is a reasonable
 * thing to want.
 */
export function entryPointFor(airport: Airport, fix: Navaid, beforeNM?: number): Vec2NM {
  const radial = bearingDeg(ARP, fix.posNM)
  const edge = exitRangeNM(airport.controlZone, ARP, radial)
  return advance(ARP, radial, edge + (beforeNM ?? airport.traffic.entryDistanceNM))
}

/** The pattern an arrival carries to its fix, if that fix has one. */
function holdFor(fix: Navaid): HoldClearance | null {
  if (fix.hold === null) return null
  return {
    fix: fix.name,
    posNM: fix.posNM,
    inboundTrue: fix.hold.inboundTrue,
    turns: fix.hold.turns,
    legMins: fix.hold.legMins,
  }
}

function typeOf(airport: Airport, wanted: string | undefined): {
  readonly type: string
  readonly wake: Aircraft['wake']
} {
  const found = airport.aircraftTypes.find((t) => t.type === (wanted ?? DEFAULT_TYPE))
  const fallback = airport.aircraftTypes[0]
  if (found !== undefined) return { type: found.type, wake: found.wake }
  // A lesson naming a type this airport does not carry gets the first one
  // rather than nothing: the lesson is about the vectoring.
  return { type: fallback?.type ?? DEFAULT_TYPE, wake: fallback?.wake ?? 'M' }
}

/** One scripted arrival, placed exactly where the spawner would place it. */
function buildArrival(
  airport: Airport,
  spec: ScriptedAircraft,
  elapsedSeconds: number,
  index: number,
): Aircraft | null {
  const fix = airport.navaids.find((n) => n.name === spec.fix)
  if (fix === undefined) return null

  const at = entryPointFor(airport, fix, spec.beforeNM)
  const hold = holdFor(fix)
  const { type, wake } = typeOf(airport, spec.type)

  return {
    callsign: spec.callsign ?? `TUT${index + 1}`,
    type,
    wake,
    role: 'arrival',
    pos: at,
    altFt: spec.altFt,
    // Pointed at its fix from wherever it appears.
    hdg: bearingDeg(at, fix.posNM),
    iasKts: spec.iasKts,
    gsKts: spec.iasKts,
    vsFpm: 0,
    clearedHdg: hold === null ? bearingDeg(at, fix.posNM) : null,
    clearedAltFt: spec.altFt,
    clearedSpdKts: spec.iasKts,
    navMode: hold === null ? 'VECTOR' : 'HOLD',
    clearedApproach: null,
    hold,
    route: [],
    routeLeg: 0,
    originFix: fix.name,
    destination: null,
    entered: false,
    trail: [],
    trailAt: elapsedSeconds,
    spawnedAt: elapsedSeconds,
  }
}

/** One scripted transit, on a corridor from the airport config. */
function buildOverflight(
  airport: Airport,
  spec: ScriptedAircraft,
  elapsedSeconds: number,
  index: number,
): Aircraft | null {
  const corridor = airport.overflights?.corridors.find((c) => c.id === spec.corridor)
  if (corridor === undefined) return null

  const route = corridorRoute(airport, corridor)
  const entry = corridorEntry(airport, route, airport.overflights?.entryDistanceNM ?? 6)
  const { type, wake } = typeOf(airport, spec.type)

  return {
    callsign: spec.callsign ?? `TUT${index + 1}`,
    type,
    wake,
    role: 'overflight',
    pos: entry.pos,
    altFt: spec.altFt,
    hdg: entry.hdg,
    iasKts: spec.iasKts,
    gsKts: spec.iasKts,
    vsFpm: 0,
    clearedHdg: entry.hdg,
    clearedAltFt: spec.altFt,
    clearedSpdKts: spec.iasKts,
    navMode: 'LNAV',
    clearedApproach: null,
    hold: null,
    route,
    routeLeg: 0,
    originFix: null,
    destination: corridor.destination,
    entered: false,
    trail: [],
    trailAt: elapsedSeconds,
    spawnedAt: elapsedSeconds,
  }
}

/**
 * The traffic a step asks for.
 *
 * A spec that names a fix or a corridor this airport does not have is
 * dropped rather than thrown: a lesson written against another field should
 * degrade to a shorter lesson, not to a blank screen.
 */
export function buildTraffic(
  airport: Airport,
  specs: readonly ScriptedAircraft[],
  elapsedSeconds: number,
): readonly Aircraft[] {
  const out: Aircraft[] = []
  specs.forEach((spec, i) => {
    const built =
      spec.kind === 'overflight'
        ? buildOverflight(airport, spec, elapsedSeconds, i)
        : buildArrival(airport, spec, elapsedSeconds, i)
    if (built !== null) out.push(built)
  })
  return out
}

/** Which callsign each ref ended up as, for the engine's goals. */
export function refsOf(
  specs: readonly ScriptedAircraft[],
  built: readonly Aircraft[],
): Record<string, string> {
  const refs: Record<string, string> = {}
  let at = 0
  for (const spec of specs) {
    const aircraft = built[at]
    // buildTraffic drops what it cannot place, so the two lists are only
    // aligned while everything placed. Matching on the callsign the spec
    // asked for keeps the mapping right when one was dropped.
    if (aircraft === undefined) continue
    if (spec.callsign !== undefined && aircraft.callsign !== spec.callsign) continue
    refs[spec.ref] = aircraft.callsign
    at += 1
  }
  return refs
}

/**
 * A storm sitting over a named fix.
 *
 * Born before the moment it is wanted and lasting well past it, so it is
 * already at full strength when the step arrives rather than growing from
 * nothing while the instruction is read. A lesson about avoiding a red core
 * needs the red core to be there.
 */
export function buildWeather(
  airport: Airport,
  storms: readonly ScriptedStorm[],
  elapsedSeconds: number,
): readonly WeatherCell[] {
  const out: WeatherCell[] = []
  for (const storm of storms) {
    const fix = airport.navaids.find((n) => n.name === storm.overFix)
    if (fix === undefined) continue
    const lifeSeconds = Math.max(60, storm.lifeMinutes * 60)
    out.push({
      originNM: fix.posNM,
      radiusNM: storm.radiusNM,
      peak: storm.peak,
      // A plain circle. The wobble that makes generated cells look like
      // weather is drawn from the seed, and a lesson wants the storm in a
      // known place rather than an interesting shape.
      lobes: [
        { harmonic: 2, amp: 0.18, phase: 0.6, driftDegPerMin: 3 },
        { harmonic: 3, amp: 0.1, phase: 2.1, driftDegPerMin: -2 },
      ],
      // Half a life ago, so it is at its peak right now.
      bornSeconds: elapsedSeconds - lifeSeconds / 2,
      lifeSeconds,
      driftOffsetDeg: 0,
      // Anchored. A storm the lesson says is over OCK should still be over
      // OCK when the player looks up from the instruction.
      driftFactor: 0,
    })
  }
  return out
}

/** Whether this schedule currently carries any hand-placed cell. */
export function hasScripted(weather: Weather): boolean {
  return weather.scripted.length > 0
}
