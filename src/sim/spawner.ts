import type { Clock } from '../core/loop'
import { distanceNM } from '../core/geo'
import { makeRng, type Rng } from '../core/rng'
import type { Airport, Navaid } from '../data/airport'
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
 * - **It runs on simulated time.** Everything is driven by the tick clock,
 *   so it follows the rate control, stops dead when paused, and produces
 *   the same stream for a given seed however the session was played.
 */

export interface SpawnerOptions {
  readonly airport: Airport
  /** Defaults to the seed in the airport config. */
  readonly rng?: Rng
}

export class Spawner {
  private readonly airport: Airport
  private readonly rng: Rng
  private readonly fixes: readonly Navaid[]

  private nextSpawnAt: number
  private readonly lastUsedAt = new Map<string, number>()
  private spawnCount = 0
  private deferCount = 0
  private sequence = 0

  /** How long to wait before trying again when a spawn had to be held. */
  private static readonly RETRY_SECONDS = 10

  constructor(opts: SpawnerOptions) {
    this.airport = opts.airport
    this.rng = opts.rng ?? makeRng(opts.airport.traffic.seed)
    // Only holds with an entry band: a navaid with neither is a fix on the
    // chart, not a place traffic arrives from.
    this.fixes = opts.airport.navaids.filter((n) => n.hold !== null && n.entry !== null)
    this.nextSpawnAt = opts.airport.traffic.firstSpawnSeconds
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

  nextInSeconds(clock: Clock): number {
    return Math.max(0, this.nextSpawnAt - clock.elapsedSeconds)
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

  /**
   * Called once per simulation step. Returns the arrivals to add, which is
   * at most one -- the caller owns the aircraft list, so the spawner never
   * mutates the world.
   */
  update(clock: Clock, existing: readonly Aircraft[]): Aircraft[] {
    if (clock.elapsedSeconds < this.nextSpawnAt) return []

    const t = this.airport.traffic

    if (existing.length >= t.maxConcurrent) {
      this.hold(clock)
      return []
    }

    const fix = this.chooseFix(clock, existing)
    if (!fix) {
      this.hold(clock)
      return []
    }

    const aircraft = this.build(fix, clock, existing)
    this.lastUsedAt.set(fix.name, clock.elapsedSeconds)
    this.spawnCount += 1
    this.scheduleNext(clock)
    return [aircraft]
  }

  /** Push the next attempt out a little without losing the ramp. */
  private hold(clock: Clock): void {
    this.deferCount += 1
    this.nextSpawnAt = clock.elapsedSeconds + Spawner.RETRY_SECONDS
  }

  private scheduleNext(clock: Clock): void {
    const t = this.airport.traffic
    const base = this.intervalSeconds(clock)
    // Jitter either side, so arrivals are not metronomic.
    const spread = 1 + t.intervalJitter * (this.rng.next() * 2 - 1)
    this.nextSpawnAt = clock.elapsedSeconds + Math.max(5, base * spread)
  }

  /**
   * An eligible fix has no traffic close to it and has not just been used.
   * Returns null when every fix is busy, which is the signal to hold.
   */
  private chooseFix(clock: Clock, existing: readonly Aircraft[]): Navaid | null {
    const t = this.airport.traffic
    const eligible = this.fixes.filter((fix) => {
      const last = this.lastUsedAt.get(fix.name)
      if (last !== undefined && clock.elapsedSeconds - last < t.minFixSpacingSeconds) {
        return false
      }
      return !existing.some((a) => distanceNM(a.pos, fix.posNM) < t.minFixSpacingNM)
    })

    if (eligible.length === 0) return null
    return this.rng.pick(eligible)
  }

  private build(fix: Navaid, clock: Clock, existing: readonly Aircraft[]): Aircraft {
    const airport = this.airport
    const type = this.rng.weighted(airport.aircraftTypes, (t) => t.weight)
    const altFt = this.entryAltitude(fix)

    // Groundspeed only for now: indicated airspeed and the wind that
    // separates the two are not modelled yet, so the sector speed limit is
    // applied to groundspeed directly. That is a simplification, and the
    // place to revisit when wind arrives.
    const limited = altFt < airport.sector.speedLimitBelowFt
    const gsKts = limited
      ? Math.min(type.cruiseKts, airport.sector.speedLimitKts)
      : type.cruiseKts

    const hdg = fix.hold?.inboundTrue ?? 0

    return {
      callsign: this.callsign(existing),
      type: type.type,
      wake: type.wake,
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

  /**
   * A callsign not already in use. Retries with a different flight number
   * rather than risking two aircraft the controller cannot tell apart.
   */
  private callsign(existing: readonly Aircraft[]): string {
    const taken = new Set(existing.map((a) => a.callsign))
    const airlines = this.airport.traffic.airlines

    for (let attempt = 0; attempt < 24; attempt += 1) {
      const airline = this.rng.weighted(airlines, (a) => a.weight)
      const number = this.rng.range(1, 1999)
      const candidate = `${airline.code}${number}`
      if (!taken.has(candidate)) return candidate
    }

    // Exhausted the retries, which needs a great deal of traffic. Fall back
    // to something guaranteed unique rather than issuing a duplicate.
    this.sequence += 1
    const airline = this.rng.weighted(airlines, (a) => a.weight)
    return `${airline.code}${9000 + this.sequence}`
  }
}
