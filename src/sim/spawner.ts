import type { Clock } from '../core/loop'
import { advance, bearingDeg, distanceNM, type Vec2NM } from '../core/geo'
import { exitRangeNM } from './airspace'
import { makeRng, type Rng } from '../core/rng'
import type { Airport, Navaid } from '../data/airport'
import { FlightGenerator } from './flightgen'
import type { Aircraft, HoldClearance } from './types'

/**
 * Arrival traffic flow.
 *
 * Reads the holding fixes and their entry bands from the airport config and
 * releases one arrival at a time onto them, on a timer that tightens as the
 * session goes on.
 *
 * Two things make it a flow manager rather than a metronome:
 *
 * - **It will not stack an arrival on top of existing traffic.** A fix with
 *   an aircraft near it, or one that has just had an arrival, is skipped.
 *   Spawning regardless would hand the controller a separation loss that
 *   existed before they touched anything.
 * - **It runs on simulated time.** The cadence is a delta-time accumulator
 *   fed by the simulation step, so it follows the rate control, stops dead
 *   when paused, and produces the same stream for a given seed however the
 *   session was played. Banking the step rather than comparing against a
 *   timestamp also means nothing depends on the clock's origin.
 */

/** World origin, which is the airport reference point. */
const ARP: Vec2NM = { x: 0, y: 0 }

/**
 * Levels in a stack are a thousand feet apart, so two aircraft holding
 * over the same fix are never at the same level. This is also the vertical
 * distance that counts as separated when deciding whether the entry gate
 * is clear.
 */
const STACK_STEP_FT = 1000



/** A place to put an arrival: which fix, and which level of its stack. */
interface Slot {
  readonly fix: Navaid
  readonly altFt: number
}

export interface SpawnerOptions {
  readonly airport: Airport
  /**
   * The traffic seed. Defaults to the one in the airport config, which is
   * fixed -- so a caller that wants a different session every time has to
   * say so. `main.ts` does.
   */
  readonly seed?: number
  /** Overrides the seed entirely, for tests that drive the draws directly. */
  readonly rng?: Rng
}

export class Spawner {
  private readonly airport: Airport
  private readonly rng: Rng
  private readonly fixes: readonly Navaid[]
  private readonly flights: FlightGenerator

  /** Simulated seconds banked since the last release. */
  private sinceLastSpawn = 0
  /** The gap being waited out. Re-chosen after every release. */
  private waitSeconds: number
  private readonly lastUsedAt = new Map<string, number>()
  /** Entry points never move, and finding one walks the boundary. */
  private readonly gates = new Map<string, Vec2NM>()
  private spawnCount = 0
  private deferCount = 0

  /** How long to wait before trying again when a spawn had to be held. */
  private static readonly RETRY_SECONDS = 10

  constructor(opts: SpawnerOptions) {
    this.airport = opts.airport
    this.rng = opts.rng ?? makeRng(opts.seed ?? opts.airport.traffic.seed)
    // Only holds with an entry band: a navaid with neither is a fix on the
    // chart, not a place traffic arrives from.
    this.flights = new FlightGenerator(opts.airport)
    this.fixes = opts.airport.navaids.filter((n) => n.hold !== null && n.entry !== null)
    this.waitSeconds = opts.airport.traffic.firstSpawnSeconds
  }

  /**
   * The seed this session is running on. Worth being able to read back: it
   * is the whole of what makes a session reproducible.
   */
  get seed(): number {
    return this.rng.seed
  }

  get spawned(): number {
    return this.spawnCount
  }

  /** Times a spawn was due but held back. High means the sector is full. */
  get deferred(): number {
    return this.deferCount
  }

  get entryFixes(): readonly Navaid[] {
    return this.fixes
  }

  /** Simulated seconds until the next release is due. */
  nextInSeconds(): number {
    return Math.max(0, this.waitSeconds - this.sinceLastSpawn)
  }

  /**
   * Current gap between arrivals, ramping from the opening interval down to
   * the floor over the configured window. Pressure builds rather than
   * arriving all at once.
   */
  intervalSeconds(clock: Clock): number {
    const t = this.airport.traffic
    const rampSeconds = Math.max(1, t.rampMinutes * 60)
    const progress = Math.min(1, Math.max(0, clock.elapsedSeconds / rampSeconds))
    return t.initialIntervalSeconds + (t.minIntervalSeconds - t.initialIntervalSeconds) * progress
  }

  /** Position in the ramp: 0 at the opening cadence, 1 at the fastest. */
  rampProgress(clock: Clock): number {
    const rampSeconds = Math.max(1, this.airport.traffic.rampMinutes * 60)
    return Math.min(1, Math.max(0, clock.elapsedSeconds / rampSeconds))
  }

  /**
   * Called once per simulation step. Returns the arrivals to add, which is
   * at most one -- the caller owns the aircraft list, so the spawner never
   * mutates the world.
   */
  update(dtSeconds: number, clock: Clock, existing: readonly Aircraft[]): Aircraft[] {
    this.sinceLastSpawn += Math.max(0, dtSeconds)
    if (this.sinceLastSpawn < this.waitSeconds) return []

    if (existing.length >= this.airport.traffic.maxConcurrent) {
      this.hold()
      return []
    }

    const slot = this.chooseSlot(clock, existing, { ignoreCooldown: false })
    if (!slot) {
      this.hold()
      return []
    }

    return [this.release(slot, clock, existing)]
  }

  /**
   * Release an arrival now, on command, without waiting for the cadence.
   *
   * Skips the per-fix cooldown, which exists only to space the automatic
   * flow, but still refuses to put an aircraft on top of another or to
   * exceed the concurrency cap: a manual trigger should not be able to
   * manufacture a separation loss the controller had no hand in. Returns
   * an empty array when it cannot place one.
   */
  spawnNow(clock: Clock, existing: readonly Aircraft[]): Aircraft[] {
    if (existing.length >= this.airport.traffic.maxConcurrent) {
      this.deferCount += 1
      return []
    }

    const slot = this.chooseSlot(clock, existing, { ignoreCooldown: true })
    if (!slot) {
      this.deferCount += 1
      return []
    }

    return [this.release(slot, clock, existing)]
  }

  private release(slot: Slot, clock: Clock, existing: readonly Aircraft[]): Aircraft {
    const aircraft = this.build(slot, clock, existing)
    this.lastUsedAt.set(slot.fix.name, clock.elapsedSeconds)
    this.spawnCount += 1
    // A release resets the cadence either way, so a manual one is not
    // immediately followed by an automatic one.
    this.sinceLastSpawn = 0
    this.waitSeconds = this.nextInterval(clock)
    return aircraft
  }

  /** Wait a little and try again, without losing the ramp. */
  private hold(): void {
    this.deferCount += 1
    this.sinceLastSpawn = 0
    this.waitSeconds = Spawner.RETRY_SECONDS
  }

  private nextInterval(clock: Clock): number {
    const t = this.airport.traffic
    const base = this.intervalSeconds(clock)
    // Jitter either side so arrivals are not metronomic, then clamped to
    // the configured band: the cadence is stated as a range, and jitter
    // should vary it within that rather than take it outside.
    const jittered = base * (1 + t.intervalJitter * (this.rng.next() * 2 - 1))
    return Math.min(t.initialIntervalSeconds, Math.max(t.minIntervalSeconds, jittered))
  }

  /**
   * A place to put an arrival: a fix, and a level in its stack.
   *
   * Both, together, because they are not independent. An arrival holds over
   * its fix rather than passing through it, so what makes a fix usable is
   * not that the airspace over it is empty -- it will not be, for long --
   * but that there is a level free in the stack.
   *
   * Returns null when every fix is full, which is the signal to hold the
   * release back.
   */
  private chooseSlot(
    clock: Clock,
    existing: readonly Aircraft[],
    opts: { ignoreCooldown: boolean },
  ): Slot | null {
    const t = this.airport.traffic
    const slots: Slot[] = []

    for (const fix of this.fixes) {
      if (!opts.ignoreCooldown) {
        const last = this.lastUsedAt.get(fix.name)
        if (last !== undefined && clock.elapsedSeconds - last < t.minFixSpacingSeconds) continue
      }

      const altFt = this.entryLevel(fix, existing)
      if (altFt === null) continue

      // Nothing already sitting where this one would appear, at this
      // level. Traffic a thousand feet away is separated -- that is the
      // entire point of a stack -- so only a conflict at the same level
      // blocks the release, and the four fixes do not throttle each other
      // through airspace they share.
      const gate = this.entryPoint(fix)
      const blocked = existing.some(
        (a) =>
          distanceNM(a.pos, gate) < t.minFixSpacingNM &&
          Math.abs(a.altFt - altFt) < STACK_STEP_FT,
      )
      if (blocked) continue

      slots.push({ fix, altFt })
    }

    if (slots.length === 0) return null
    return this.rng.pick(slots)
  }

  /**
   * Where an arrival appears: out along the hold's inbound leg, so it is
   * routing to the fix when you first see it rather than materialising on
   * top of it.
   */
  /**
   * Where an arrival appears: outside the boundary, on the radial through
   * its fix.
   *
   * Measured from the boundary rather than from the fix, so every feed
   * hands traffic over at the same range whether its fix is ten miles out
   * or twenty-five. An arrival is therefore visible, and identifiable, for
   * a couple of minutes before it becomes the controller's to work.
   */
  private entryPoint(fix: Navaid): Vec2NM {
    const cached = this.gates.get(fix.name)
    if (cached !== undefined) return cached

    // Out along the radial through the fix until the airspace ends, then
    // the configured distance beyond it. Measured against the real boundary
    // rather than a radius, so every feed hands traffic over the same
    // distance outside the airspace however far out its own edge lies --
    // which at Heathrow ranges from seventeen miles to thirty-five.
    const radial = bearingDeg(ARP, fix.posNM)
    const edge = exitRangeNM(this.airport.controlZone, ARP, radial)
    const gate = advance(ARP, radial, edge + this.airport.traffic.entryDistanceNM)
    this.gates.set(fix.name, gate)
    return gate
  }

  /** The pattern an arrival carries to its fix, if that fix has one. */
  private clearanceFor(fix: Navaid): HoldClearance | null {
    if (fix.hold === null) return null
    return {
      fix: fix.name,
      posNM: fix.posNM,
      inboundTrue: fix.hold.inboundTrue,
      turns: fix.hold.turns,
      legMins: fix.hold.legMins,
    }
  }

  /**
   * The level an arrival joins the stack at, or null when it is full.
   *
   * A stack is entered from the top: an arrival goes in above everything
   * already holding, and is descended through the layers as the ones below
   * it are taken out. If the band is exhausted upwards but there are gaps
   * lower down -- because an aircraft was pulled out of the middle -- it
   * takes the lowest gap instead. Refusing an arrival while a level sits
   * empty would starve the flow to no purpose.
   */
  private entryLevel(fix: Navaid, existing: readonly Aircraft[]): number | null {
    const levels = this.stackLevels(fix)
    if (levels.length === 0) return null

    const used = new Set<number>()
    for (const a of existing) {
      // Holding at THIS fix, by the clearance it is carrying. An aircraft
      // vectored out of the hold releases its level in the same moment,
      // because the clearance is what goes.
      if (a.hold?.fix !== fix.name) continue
      // Where it is going, not where it is: an aircraft descending to 7,000
      // owns 7,000 from the moment it is told to.
      used.add(Math.round(a.clearedAltFt / STACK_STEP_FT) * STACK_STEP_FT)
    }

    const free = levels.filter((ft) => !used.has(ft))
    if (free.length === 0) return null
    const top = used.size === 0 ? -Infinity : Math.max(...used)
    return free.find((ft) => ft > top) ?? (free[0] as number)
  }

  /** Every thousand-foot level inside the fix's band and the sector. */
  private stackLevels(fix: Navaid): readonly number[] {
    const band = fix.entry
    const sector = this.airport.sector
    const floor = Math.max(band?.minAltFt ?? sector.floorFt, sector.floorFt)
    const ceiling = Math.min(band?.maxAltFt ?? sector.ceilingFt, sector.ceilingFt)

    const out: number[] = []
    for (
      let ft = Math.ceil(floor / STACK_STEP_FT) * STACK_STEP_FT;
      ft <= ceiling;
      ft += STACK_STEP_FT
    ) {
      out.push(ft)
    }
    return out
  }

  private build(slot: Slot, clock: Clock, existing: readonly Aircraft[]): Aircraft {
    const airport = this.airport
    const { fix, altFt } = slot
    // Who the flight is comes from the generator; where and how it enters
    // is this module's business.
    const flight = this.flights.next(this.rng, new Set(existing.map((a) => a.callsign)))

    // Groundspeed only for now: indicated airspeed and the wind that
    // separates the two are not modelled yet, so the sector speed limit is
    // applied to groundspeed directly. That is a simplification, and the
    // place to revisit when wind arrives.
    // Standard entry speed, never above what the type can do, and never
    // above the sector limit when entering below the limit altitude.
    let gsKts = Math.min(airport.traffic.entrySpeedKts, flight.cruiseKts)
    if (altFt < airport.sector.speedLimitBelowFt) {
      gsKts = Math.min(gsKts, airport.sector.speedLimitKts)
    }

    // An arrival arrives already holding: it appears out along the hold's
    // inbound leg, tracks direct to the fix, and enters the pattern when it
    // gets there -- all of which sim/hold.ts does from the clearance alone,
    // with no entry procedure to choose. So traffic parks itself over the
    // right fix at the right level and waits to be dealt with, which is
    // what an approach controller is actually handed.
    const hold = this.clearanceFor(fix)
    const at = this.entryPoint(fix)
    // Pointed at its fix from wherever it appears, which is no longer the
    // same as the hold's inbound leg: a hold turned to fit the airspace
    // faces a different way from the radial the arrival comes down.
    const hdg = bearingDeg(at, fix.posNM)

    return {
      callsign: flight.callsign,
      type: flight.type,
      wake: flight.wake,
      pos: at,
      altFt,
      hdg,
      gsKts,
      vsFpm: 0,
      // Nobody has vectored it. In the hold it is navigating itself, so a
      // cleared heading would be a vector on the strip that nothing flies.
      clearedHdg: hold === null ? hdg : null,
      clearedAltFt: altFt,
      clearedSpdKts: gsKts,
      navMode: hold === null ? 'VECTOR' : 'HOLD',
      clearedApproach: null,
      hold,
      originFix: fix.name,
      // Released outside the boundary: it is not the controller's yet.
      entered: false,
      trail: [],
      trailAt: clock.elapsedSeconds,
      spawnedAt: clock.elapsedSeconds,
    }
  }

}
