import type { Clock } from '../core/loop'
import { bearingDeg, distanceNM, type Vec2NM } from '../core/geo'
import { makeRng, type Rng } from '../core/rng'
import type { Airport, Navaid } from '../data/airport'
import { FlightGenerator } from './flightgen'
import type { Aircraft } from './types'

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

export interface SpawnerOptions {
  readonly airport: Airport
  /** Defaults to the seed in the airport config. */
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
  private spawnCount = 0
  private deferCount = 0

  /** How long to wait before trying again when a spawn had to be held. */
  private static readonly RETRY_SECONDS = 10

  constructor(opts: SpawnerOptions) {
    this.airport = opts.airport
    this.rng = opts.rng ?? makeRng(opts.airport.traffic.seed)
    // Only holds with an entry band: a navaid with neither is a fix on the
    // chart, not a place traffic arrives from.
    this.flights = new FlightGenerator(opts.airport)
    this.fixes = opts.airport.navaids.filter((n) => n.hold !== null && n.entry !== null)
    this.waitSeconds = opts.airport.traffic.firstSpawnSeconds
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

    const fix = this.chooseFix(clock, existing, { ignoreCooldown: false })
    if (!fix) {
      this.hold()
      return []
    }

    return [this.release(fix, clock, existing)]
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

    const fix = this.chooseFix(clock, existing, { ignoreCooldown: true })
    if (!fix) {
      this.deferCount += 1
      return []
    }

    return [this.release(fix, clock, existing)]
  }

  private release(fix: Navaid, clock: Clock, existing: readonly Aircraft[]): Aircraft {
    const aircraft = this.build(fix, clock, existing)
    this.lastUsedAt.set(fix.name, clock.elapsedSeconds)
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
   * An eligible fix has no traffic close to it and has not just been used.
   * Returns null when every fix is busy, which is the signal to hold.
   */
  private chooseFix(
    clock: Clock,
    existing: readonly Aircraft[],
    opts: { ignoreCooldown: boolean },
  ): Navaid | null {
    const t = this.airport.traffic
    const eligible = this.fixes.filter((fix) => {
      if (!opts.ignoreCooldown) {
        const last = this.lastUsedAt.get(fix.name)
        if (last !== undefined && clock.elapsedSeconds - last < t.minFixSpacingSeconds) {
          return false
        }
      }
      return !existing.some((a) => distanceNM(a.pos, fix.posNM) < t.minFixSpacingNM)
    })

    if (eligible.length === 0) return null
    return this.rng.pick(eligible)
  }

  private build(fix: Navaid, clock: Clock, existing: readonly Aircraft[]): Aircraft {
    const airport = this.airport
    // Who the flight is comes from the generator; where and how it enters
    // is this module's business.
    const flight = this.flights.next(this.rng, new Set(existing.map((a) => a.callsign)))
    const altFt = this.entryAltitude(fix)

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

    // Inbound heading, computed from the fix to the airport reference
    // point, so an arrival is flying towards the field the moment it
    // appears. Taken from geometry rather than off the hold, so a fix
    // without a published hold still works.
    const hdg = bearingDeg(fix.posNM, ARP)

    return {
      callsign: flight.callsign,
      type: flight.type,
      wake: flight.wake,
      pos: fix.posNM,
      altFt,
      hdg,
      gsKts,
      vsFpm: 0,
      // Arrives level, tracking the hold's inbound leg towards the field,
      // and under nobody's instruction yet beyond what it is already doing.
      clearedHdg: hdg,
      clearedAltFt: altFt,
      clearedSpdKts: gsKts,
      navMode: 'VECTOR',
      clearedApproach: null,
      originFix: fix.name,
      trail: [],
      trailAt: clock.elapsedSeconds,
      spawnedAt: clock.elapsedSeconds,
    }
  }

  /** A whole thousand inside the fix's band, kept within the sector. */
  private entryAltitude(fix: Navaid): number {
    const band = fix.entry
    const sector = this.airport.sector
    const floor = Math.max(band?.minAltFt ?? sector.floorFt, sector.floorFt)
    const ceiling = Math.min(band?.maxAltFt ?? sector.ceilingFt, sector.ceilingFt)
    if (ceiling <= floor) return floor

    const lowest = Math.ceil(floor / 1000)
    const highest = Math.floor(ceiling / 1000)
    if (highest < lowest) return floor
    return this.rng.range(lowest, highest) * 1000
  }
}
