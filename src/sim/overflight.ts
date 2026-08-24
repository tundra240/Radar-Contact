import type { Clock } from '../core/loop'
import { advance, bearingDeg, distanceNM, normalizeHeading, type Vec2NM } from '../core/geo'
import { isWithinFootprint } from './airspace'
import { makeRng, makeRngAt, type Rng } from '../core/rng'
import type { Airport, Corridor } from '../data/airport'
import {
  allowsCorridor,
  DIFFICULTIES,
  hasTransits,
  intervalSecondsFor,
  type DifficultySettings,
} from './difficulty'
import type { FlightGenerator } from './flightgen'
import { isClearForRelease } from './release'
import type { Aircraft, Route, RouteLeg } from './types'

/**
 * Traffic that is not yours.
 *
 * Every aircraft in the sector until now was an arrival: released on a
 * feeder fix, worked, and landed. This releases the other kind -- a
 * neighbouring field's inbound crossing a corner of the airspace, or a
 * continental flight passing over the top of it -- and the difference that
 * matters is not where they come from but that they need nothing from the
 * controller. They appear flying a route and they fly it out the far side.
 *
 * The controller's involvement is by exception: weather across the track,
 * or a conflict with an arrival. Then it is a vector like any other, and
 * RESUME NAV gives the aeroplane back its flight plan. See sim/route.ts.
 *
 * Built to the same rules as the arrival spawner -- simulated time, a seed
 * of its own, and a cap -- so a session stays reproducible and the transits
 * cannot crowd out the traffic the controller is actually there for.
 */

/** World origin, which is the airport reference point. */
const ARP: Vec2NM = { x: 0, y: 0 }

/**
 * How far back from its first fix a transit appears, at the least.
 *
 * The entry point is normally found by walking out past the edge of the
 * airspace, but a corridor whose first fix already lies outside it would
 * otherwise start almost on top of that fix. A transit needs a run-in --
 * enough track to be seen, identified and planned against before it is
 * anybody's problem.
 */
const MIN_RUN_IN_NM = 10

/** How far out the boundary walk looks before giving up. */
const WALK_LIMIT_NM = 120
const WALK_STEP_NM = 0.5

/** Levels are flown in thousands. */
const LEVEL_STEP_FT = 1000

/**
 * A point on the given track, clear of the airspace by `marginNM`.
 *
 * Walked rather than solved. The boundary is a polygon and not a circle,
 * so there is no closed form -- and the arrival spawner already walks it
 * for the same reason. The walk finds the furthest point along the track
 * that is still inside, which handles a track that leaves the footprint and
 * re-enters it: what matters is the last crossing, not the first.
 */
export function clearOfAirspace(
  airport: Airport,
  from: Vec2NM,
  headingDeg: number,
  marginNM: number,
): Vec2NM {
  let last = 0
  for (let r = 0; r <= WALK_LIMIT_NM; r += WALK_STEP_NM) {
    if (isWithinFootprint(airport.controlZone, advance(from, headingDeg, r))) last = r
  }
  return advance(from, headingDeg, Math.max(last + marginNM, MIN_RUN_IN_NM))
}

/** Where a transit on this corridor appears, and on what heading. */
export function corridorEntry(
  airport: Airport,
  route: Route,
  entryDistanceNM: number,
): { readonly pos: Vec2NM; readonly hdg: number } {
  const first = route[0]
  const second = route[1]
  if (first === undefined) return { pos: ARP, hdg: 0 }
  // The direction the aircraft will be travelling on its first leg. The
  // entry point is that far BEHIND the first fix, and the heading is the
  // travel direction itself -- so a transit appears already tracking its
  // route rather than somewhere off it that it has to turn onto.
  const travel =
    second === undefined ? bearingDeg(first.posNM, ARP) : bearingDeg(first.posNM, second.posNM)
  const back = normalizeHeading(travel + 180)
  return {
    pos: clearOfAirspace(airport, first.posNM, back, entryDistanceNM),
    hdg: travel,
  }
}

/**
 * The corridor as a flyable route: its published fixes, then a point out
 * past the boundary to leave on.
 *
 * The exit leg is what stops a transit stopping dead over its last fix. It
 * is not in the config because it is not a fact about the corridor -- it
 * follows from where the airspace ends, and writing it down would mean
 * maintaining it every time the boundary moved.
 */
export function corridorRoute(airport: Airport, corridor: Corridor): Route {
  const byName = new Map(airport.navaids.map((n) => [n.name, n]))
  const legs: RouteLeg[] = []
  for (const name of corridor.via) {
    const navaid = byName.get(name)
    // The loader rejects an unknown fix, so this cannot fire from config.
    if (navaid === undefined) continue
    legs.push({ fix: navaid.name, posNM: navaid.posNM })
  }

  const last = legs[legs.length - 1]
  const previous = legs[legs.length - 2]
  if (last === undefined) return legs
  const outbound =
    previous === undefined
      ? bearingDeg(ARP, last.posNM)
      : bearingDeg(previous.posNM, last.posNM)

  return [
    ...legs,
    {
      // Named for where it is going, so the readout reads like a flight
      // plan rather than ending on a coordinate.
      fix: corridor.destination,
      posNM: clearOfAirspace(airport, last.posNM, outbound, WALK_STEP_NM),
    },
  ]
}

/**
 * A cruising level for a track, by the semicircular rule: easterly tracks
 * take odd thousands and westerly ones even.
 *
 * Worth the few lines. It is what real flight levels obey, and it does
 * something the simulation needs anyway -- opposing traffic on the same
 * corridor is a thousand feet apart by construction, so the controller is
 * never handed a head-on that was there before they touched anything.
 */
export function semicircularLevelFt(rng: Rng, corridor: Corridor, trackDeg: number): number {
  const eastbound = normalizeHeading(trackDeg) < 180
  const wanted = eastbound ? 1 : 0

  const levels: number[] = []
  const first = Math.ceil(corridor.minAltFt / LEVEL_STEP_FT)
  const last = Math.floor(corridor.maxAltFt / LEVEL_STEP_FT)
  for (let thousands = first; thousands <= last; thousands += 1) {
    if (thousands % 2 === wanted) levels.push(thousands * LEVEL_STEP_FT)
  }

  // A band too narrow to hold a level of the right parity still has to
  // produce one. The rule is a convention, not a constraint on the config.
  if (levels.length === 0) return Math.round(corridor.maxAltFt / LEVEL_STEP_FT) * LEVEL_STEP_FT
  return levels[rng.range(0, levels.length - 1)] as number
}

/** Where a transit appears, and the way it is pointing when it does. */
interface Entry {
  readonly pos: Vec2NM
  readonly hdg: number
}

/** Everything the generator remembers between releases. */
export interface OverflightState {
  readonly seed: number
  readonly draws: number
  readonly sinceLastSpawn: number
  readonly waitSeconds: number
  readonly spawned: number
  /** When each corridor was last used, as pairs so it survives JSON. */
  readonly lastUsedAt: readonly (readonly [string, number])[]
}

export interface OverflightOptions {
  readonly airport: Airport
  /** The session's difficulty, which sets the rate and picks the corridors. */
  readonly difficulty?: DifficultySettings
  /** Shared with the arrival spawner, so no two flights take one callsign. */
  readonly flights: FlightGenerator
  readonly seed?: number
  readonly rng?: Rng
}

/**
 * How long a corridor rests after use.
 *
 * Two transits nose to tail on the same track are one transit as far as the
 * controller is concerned, and they make the sector look busier than it is
 * without adding anything to work.
 */
const CORRIDOR_REST_SECONDS = 300

export class Overflights {
  private readonly airport: Airport
  private readonly flights: FlightGenerator
  private rng: Rng
  private readonly corridors: readonly Corridor[]
  private readonly difficulty: DifficultySettings
  /** Routes never move, and building one walks the boundary six times. */
  private readonly routes = new Map<string, Route>()
  private readonly lastUsedAt = new Map<string, number>()

  private sinceLastSpawn = 0
  private waitSeconds: number
  private spawnCount = 0

  constructor(opts: OverflightOptions) {
    this.airport = opts.airport
    this.flights = opts.flights
    const config = opts.airport.overflights
    this.difficulty = opts.difficulty ?? DIFFICULTIES.normal
    // Only the corridors this setting flies. Easy has none at all, and a
    // setting with none is a sector with no transits in it.
    this.corridors = (config?.corridors ?? []).filter((c) =>
      allowsCorridor(this.difficulty, c.crossing),
    )
    this.rng = opts.rng ?? makeRng(opts.seed ?? config?.seed ?? 0)
    this.waitSeconds = config?.firstSpawnSeconds ?? 0
  }

  get seed(): number {
    return this.rng.seed
  }

  /**
   * How many transits may be up at once on this setting.
   *
   * Worth reading back: it is the difference between a quiet sector and a
   * busy one, and it is derived from the rate rather than configured, so
   * the only honest way to check it is to ask.
   */
  get concurrentCap(): number {
    return this.cap(this.airport.overflights?.maxConcurrent ?? 1)
  }

  get spawned(): number {
    return this.spawnCount
  }

  snapshot(): OverflightState {
    return {
      seed: this.rng.seed,
      draws: this.rng.draws,
      sinceLastSpawn: this.sinceLastSpawn,
      waitSeconds: this.waitSeconds,
      spawned: this.spawnCount,
      lastUsedAt: [...this.lastUsedAt.entries()],
    }
  }

  restore(state: OverflightState): void {
    // Closed form: resuming a session must not replay an hour of draws.
    this.rng = makeRngAt(state.seed, state.draws)
    this.sinceLastSpawn = state.sinceLastSpawn
    this.waitSeconds = state.waitSeconds
    this.spawnCount = state.spawned
    this.lastUsedAt.clear()
    for (const [id, at] of state.lastUsedAt) this.lastUsedAt.set(id, at)
  }

  /**
   * One step of the transit flow: bank the time, and release when it is due
   * and there is room.
   *
   * `traffic` is the world as it stands after the step, so the cap counts
   * what is actually on the display.
   */
  update(dtSeconds: number, clock: Clock, traffic: readonly Aircraft[]): readonly Aircraft[] {
    const config = this.airport.overflights
    if (config === null || this.corridors.length === 0) return []

    if (!hasTransits(this.difficulty)) return []

    this.sinceLastSpawn += Math.max(0, dtSeconds)
    if (this.sinceLastSpawn < this.waitSeconds) return []

    const airborne = traffic.filter((a) => a.role === 'overflight').length
    if (airborne >= this.cap(config.maxConcurrent)) {
      // Full. Bank nothing and look again shortly, rather than releasing a
      // backlog the moment one leaves.
      this.sinceLastSpawn = 0
      this.waitSeconds = CORRIDOR_REST_SECONDS / 4
      return []
    }

    const corridor = this.pick(clock.elapsedSeconds)
    this.sinceLastSpawn = 0
    this.waitSeconds = this.nextWait(
      intervalSecondsFor(this.difficulty.transitsPerHour),
      config.intervalJitter,
    )
    if (corridor === null) return []

    // Where it would appear, before anything is committed. A corridor whose
    // near end is occupied all the way back is full, and a release into it
    // would put two transits on one blip.
    const entry = this.entryFor(corridor, traffic)
    if (entry === null) return []

    this.lastUsedAt.set(corridor.id, clock.elapsedSeconds)
    this.spawnCount += 1
    return [this.release(corridor, entry, clock, traffic)]
  }

  /**
   * Release a transit now, on command, without waiting for the cadence.
   *
   * The counterpart to the arrival spawner's, and it makes the same two
   * choices for the same reasons. The corridor cooldown is skipped, since
   * that exists only to space the automatic flow and a deliberate press is
   * not the automatic flow. The concurrency cap is not: a manual trigger
   * should not be able to fill the sector with traffic the controller had
   * no hand in asking for.
   *
   * Returns an empty array when it cannot place one, so the caller can tell
   * "none available" from "here is one" without a second question.
   */
  spawnNow(clock: Clock, existing: readonly Aircraft[]): Aircraft[] {
    const config = this.airport.overflights
    if (config === null || this.corridors.length === 0) return []

    if (!hasTransits(this.difficulty)) return []
    const airborne = existing.filter((a) => a.role === 'overflight').length
    if (airborne >= this.cap(config.maxConcurrent)) return []

    // Every corridor with room in it, cooldown ignored -- but still
    // weighted, so pressing the key repeatedly gives the same mix as
    // leaving it alone would. The cooldown is what spaces the automatic
    // flow and a deliberate press is not the automatic flow; having
    // somewhere to put the aeroplane is a different question, and skipping
    // THAT is what let two transits appear on the same point at the same
    // level, which is a separation loss nobody asked for.
    const open = this.corridors
      .map((c) => ({ corridor: c, entry: this.entryFor(c, existing) }))
      .filter((o): o is { corridor: Corridor; entry: Entry } => o.entry !== null)
    if (open.length === 0) return []

    const chosen = this.rng.weighted(open, (o) => o.corridor.weight)
    this.lastUsedAt.set(chosen.corridor.id, clock.elapsedSeconds)
    this.spawnCount += 1
    return [this.release(chosen.corridor, chosen.entry, clock, existing)]
  }

  /**
   * How many transits may be up at once.
   *
   * The published figure is what the field can hold; the difficulty scales
   * it down, so an easier session is quieter in the air as well as slower
   * to release.
   */
  private cap(published: number): number {
    const wanted = Math.ceil(this.difficulty.transitsPerHour / 3)
    return Math.max(1, Math.min(published, wanted))
  }

  /** The corridors not resting, weighted, or null if they are all resting. */
  private pick(nowSeconds: number): Corridor | null {
    const free = this.corridors.filter((c) => {
      const used = this.lastUsedAt.get(c.id)
      return used === undefined || nowSeconds - used >= CORRIDOR_REST_SECONDS
    })
    if (free.length === 0) return null
    return this.rng.weighted(free, (c) => c.weight)
  }

  private nextWait(interval: number, jitter: number): number {
    const spread = interval * jitter
    return Math.max(30, interval - spread + this.rng.next() * spread * 2)
  }

  /** The route for a corridor, built once and kept. */
  routeFor(corridor: Corridor): Route {
    const cached = this.routes.get(corridor.id)
    if (cached !== undefined) return cached
    const route = corridorRoute(this.airport, corridor)
    this.routes.set(corridor.id, route)
    return route
  }

  /**
   * Where this corridor's next transit would appear, or null if it is full.
   *
   * The corridor's own entry point when that is clear, and further back
   * along the inbound track when it is not -- which is how transits are
   * handed over anyway, in trail rather than abreast. Answered BEFORE a
   * release commits to anything, because drawing a callsign spends it: the
   * issued set is session-long and a name spent on a spawn that did not
   * happen is a name gone for good.
   */
  private entryFor(corridor: Corridor, traffic: readonly Aircraft[]): Entry | null {
    const config = this.airport.overflights
    const route = this.routeFor(corridor)
    const entry = corridorEntry(this.airport, route, config?.entryDistanceNM ?? 6)
    // The level is drawn after the corridor is chosen, so the check uses the
    // middle of the band this corridor flies rather than one level out of
    // it. The lateral rule is doing the work here anyway -- a corridor
    // entry point is a fixed point, and two transits released onto it are
    // on the same point whatever levels they draw.
    const altFt = (corridor.minAltFt + corridor.maxAltFt) / 2
    return isClearForRelease(entry.pos, altFt, traffic) ? entry : null
  }

  private release(
    corridor: Corridor,
    entry: Entry,
    clock: Clock,
    traffic: readonly Aircraft[],
  ): Aircraft {
    const route = this.routeFor(corridor)
    const operators = new Set(corridor.operators)
    // Draw until the operator suits the corridor, then stop caring: an
    // implausible operator is a small cost and a missing aeroplane is not.
    let identity = this.flights.next(this.rng, new Set(traffic.map((a) => a.callsign)))
    for (let attempt = 0; attempt < 8 && operators.size > 0; attempt += 1) {
      if (operators.has(identity.airline)) break
      identity = this.flights.next(this.rng, new Set(traffic.map((a) => a.callsign)))
    }

    const altFt = semicircularLevelFt(this.rng, corridor, entry.hdg)
    // Its filed speed, but never more aeroplane than it is.
    const iasKts = Math.min(corridor.speedKts, identity.cruiseKts)

    return {
      callsign: identity.callsign,
      type: identity.type,
      wake: identity.wake,
      role: 'overflight',

      pos: entry.pos,
      altFt,
      hdg: entry.hdg,
      iasKts,
      gsKts: iasKts,
      vsFpm: 0,

      // Level, on its own navigation, and carrying no clearance from
      // anybody here. The cleared heading is the track it is making good,
      // so a vector has something to start from and RESUME NAV has
      // something to hand back.
      clearedHdg: entry.hdg,
      clearedAltFt: altFt,
      clearedSpdKts: iasKts,
      navMode: 'LNAV',
      clearedApproach: null,
      hold: null,
      route,
      routeLeg: 0,

      // Not an arrival: it entered on no feeder fix and it is going
      // somewhere else.
      originFix: null,
      destination: corridor.destination,
      entered: false,
      trail: [],
      trailAt: clock.elapsedSeconds,
      spawnedAt: clock.elapsedSeconds,
    }
  }
}

/** How far a transit still has to run inside the sector. Diagnostics and tests. */
export function distanceToRunNM(a: Aircraft): number {
  let total = 0
  let from = a.pos
  for (const leg of a.route.slice(a.routeLeg)) {
    total += distanceNM(from, leg.posNM)
    from = leg.posNM
  }
  return total
}
