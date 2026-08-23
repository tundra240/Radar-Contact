import { loadAirport, type Airport } from './airport'
import fleet from './fleet.json'
import egll from './egll.json'
import lpfr from './lpfr.json'
import lfmn from './lfmn.json'
import lebl from './lebl.json'

/**
 * The fields you can work, and the one place that knows they exist.
 *
 * Adding a fifth is a JSON file and a line in the table below. Nothing in
 * the simulation names an airport: everything reads the loaded profile, so
 * the only code that has ever had to know about Heathrow specifically is
 * the code that used to import it.
 *
 * The fleet is merged in rather than repeated. Aircraft performance is not
 * a property of an aerodrome -- an A320 is an A320 wherever it lands -- and
 * a copy in each profile is a copy that can drift out of step with the wake
 * table it is supposed to agree with.
 */

/** Every profile, before the shared parts are folded in. */
const PROFILES: Record<string, unknown> = {
  LPFR: lpfr,
  EGLL: egll,
  LFMN: lfmn,
  LEBL: lebl,
}

/**
 * In the order they are offered: gentlest first.
 *
 * A deliberate progression rather than alphabetical. Faro is one runway and
 * one stream, Heathrow is four stacks feeding two parallels, Nice is the
 * same volume with mountains taking half the airspace away, and Barcelona
 * is dependent runways with transits through the middle of the arrivals.
 */
export const AIRPORT_IDS: readonly string[] = ['LPFR', 'EGLL', 'LFMN', 'LEBL']

export const DEFAULT_AIRPORT = 'EGLL'

/** Loaded profiles, kept: parsing one walks every airspace boundary in it. */
const loaded = new Map<string, Airport>()

/**
 * A field by ICAO code, falling back to the default for one we do not have.
 *
 * Falls back rather than throwing for the same reason the difficulty does:
 * a remembered choice from a later version, or a hand-edited setting,
 * should put you somewhere sensible rather than at a blank screen.
 */
export function airportOf(icao: string): Airport {
  const wanted = PROFILES[icao] === undefined ? DEFAULT_AIRPORT : icao
  const already = loaded.get(wanted)
  if (already !== undefined) return already

  const built = loadAirport({
    ...(PROFILES[wanted] as Record<string, unknown>),
    // The profile carries an empty list and takes the real one from here,
    // so a field cannot accidentally ship its own idea of what an A320 is.
    aircraftTypes: fleet.aircraftTypes,
  })
  loaded.set(wanted, built)
  return built
}

/** Enough to draw a menu of them without loading every one. */
export interface AirportSummary {
  readonly icao: string
  readonly name: string
  readonly shortName: string
  readonly tier: string
  readonly challenge: string
  readonly brief: string
}

export function airportSummaries(): readonly AirportSummary[] {
  return AIRPORT_IDS.map((icao) => {
    const raw = PROFILES[icao] as {
      name: string
      shortName: string
      tier: string
      challenge: string
      brief: string
    }
    return {
      icao,
      name: raw.name,
      shortName: raw.shortName,
      tier: raw.tier,
      challenge: raw.challenge,
      brief: raw.brief,
    }
  })
}
