import type { Rng } from '../core/rng'
import type { AircraftType, Airline, Airport, WakeCategory } from '../data/airport'
import { allocateSquawk } from './squawk'

/**
 * Flight identity: who a generated aircraft is, as distinct from where it
 * enters and how. The spawner owns the second half.
 *
 * The whole value of this module is that the three fields are not drawn
 * independently. An airline is chosen, then a type from what that airline
 * actually flies, then a flight number from the bands that airline uses.
 * Drawing them independently is what produces an easyJet A380 or an
 * Emirates A319 -- individually plausible values, nonsense together, and
 * the kind of detail that breaks the illusion faster than anything else.
 */
export interface FlightIdentity {
  /** Radio callsign: the ICAO airline code with the flight number. */
  readonly callsign: string
  readonly airline: string
  readonly flightNumber: number
  /** ICAO type designator, e.g. A20N, A359, B77W. */
  readonly type: string
  readonly wake: WakeCategory
  readonly cruiseKts: number
  readonly approachKts: number
  /**
   * The transponder code, drawn here rather than by the spawner.
   *
   * It belongs with the callsign for the same reason the type does: it is
   * part of who the flight is rather than of how it entered, and the one
   * rule about it -- that no two aircraft on frequency share one -- is the
   * same rule this class already enforces for callsigns.
   */
  readonly squawk: string
}

/** Everything a FlightGenerator remembers between flights. */
export interface FlightGeneratorState {
  readonly issued: readonly string[]
  readonly fallbackSequence: number
}

export class FlightGenerator {
  private readonly airlines: readonly Airline[]
  /** Each operator's fleet, resolved to the type records once. */
  private readonly fleets = new Map<string, readonly AircraftType[]>()
  private fallbackSequence = 0
  /**
   * Every callsign issued this session, not just the ones still airborne.
   *
   * A flight number arrives once a day in reality, so reusing one after the
   * first aircraft has landed would be wrong -- and it would also confuse
   * anything keyed on callsign, which the strips and any later scoring are.
   */
  private readonly issued = new Set<string>()

  constructor(airport: Airport) {
    this.airlines = airport.traffic.airlines
    const byType = new Map(airport.aircraftTypes.map((t) => [t.type, t]))

    for (const airline of this.airlines) {
      const fleet = airline.fleet
        .map((code) => byType.get(code))
        .filter((t): t is AircraftType => t !== undefined)
      // The loader rejects unknown types, so an empty fleet here would mean
      // an empty list in the config. Fall back to the full list rather than
      // making the airline ungeneratable.
      this.fleets.set(airline.code, fleet.length > 0 ? fleet : airport.aircraftTypes)
    }
  }

  /**
   * The generator's whole mutable state, for saving a session.
   *
   * Only the two things it actually remembers: which callsigns have been
   * used, and the fallback counter. The airlines and their fleets come from
   * the config, so a save carries neither.
   */
  snapshot(): FlightGeneratorState {
    return {
      issued: [...this.issued],
      fallbackSequence: this.fallbackSequence,
    }
  }

  restore(state: FlightGeneratorState): void {
    this.issued.clear()
    for (const callsign of state.issued) this.issued.add(callsign)
    this.fallbackSequence = state.fallbackSequence
  }

  /** How many flights have been issued this session. */
  get count(): number {
    return this.issued.size
  }

  /** The types an operator may be given, for tests and diagnostics. */
  fleetFor(code: string): readonly AircraftType[] {
    return this.fleets.get(code) ?? []
  }

  /**
   * A flight not already in the air.
   *
   * `taken` is the set of callsigns currently in the air. Numbers already
   * issued this session are avoided as well, so a flight does not arrive
   * twice. Two aircraft the controller cannot tell apart is worse than an
   * implausible flight number, so uniqueness wins over the bands if it
   * comes to it.
   *
   * `takenSquawks` is the same question for transponder codes, and the
   * answer differs in one way: codes ARE reused once an aircraft has gone.
   * There are four thousand of them and a busy day would run out by
   * lunchtime, so only the traffic on frequency has to be unique.
   */
  next(
    rng: Rng,
    taken: ReadonlySet<string>,
    takenSquawks: ReadonlySet<string> = new Set(),
  ): FlightIdentity {
    const airline = rng.weighted(this.airlines, (a) => a.weight)
    const fleet = this.fleets.get(airline.code) ?? []
    // Weighted by the global fleet mix, so within an operator's own types
    // the common ones stay common.
    const type = rng.weighted(fleet, (t) => t.weight)

    const flightNumber = this.pickNumber(rng, airline, taken)
    const callsign = `${airline.code}${flightNumber}`
    this.issued.add(callsign)

    return {
      callsign,
      airline: airline.code,
      flightNumber,
      type: type.type,
      wake: type.wake,
      cruiseKts: type.cruiseKts,
      approachKts: type.approachKts,
      squawk: allocateSquawk(rng, takenSquawks),
    }
  }

  /**
   * A free flight number for this operator. Tries at random inside its
   * bands, then walks them in order, and only leaves the bands behind if
   * every number in them is somehow in use.
   */
  private pickNumber(rng: Rng, airline: Airline, taken: ReadonlySet<string>): number {
    const bands = airline.numbers
    const free = (n: number): boolean => {
      const callsign = `${airline.code}${n}`
      return !this.issued.has(callsign) && !taken.has(callsign)
    }

    if (bands.length > 0) {
      for (let attempt = 0; attempt < 16; attempt += 1) {
        // Weighted by width, so a wide band is picked more often than a
        // narrow one rather than equally.
        const band = rng.weighted(bands, (b) => b.max - b.min + 1)
        const candidate = rng.range(band.min, band.max)
        if (free(candidate)) return candidate
      }

      // Random attempts exhausted. Scan, which is deterministic and finds a
      // free number if the bands hold one at all.
      for (const band of bands) {
        for (let n = band.min; n <= band.max; n += 1) {
          if (free(n)) return n
        }
      }
    }

    // Every band full, or no bands configured. Guaranteed unique, at the
    // cost of a number the operator would not really use.
    do {
      this.fallbackSequence += 1
    } while (!free(9000 + this.fallbackSequence))
    return 9000 + this.fallbackSequence
  }
}
