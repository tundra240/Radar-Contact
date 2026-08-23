import {
  footprint,
  inPolygon,
  isWithinFootprint,
  reachNM,
  type ControlVolume,
  type ControlZone,
} from '../sim/airspace'
import type { NoiseZone, TerrainZone, ZoneShape } from '../sim/zones'
import {
  FT_PER_NM,
  advance,
  angleDelta,
  bearingDeg,
  degToRad,
  distanceNM,
  glidepathRiseFt,
  makeProjection,
  normalizeHeading,
  type BoundsNM,
  type LatLon,
  type Projection,
  type Vec2NM,
} from '../core/geo'

/**
 * Loads an airport configuration, validates it, and projects every
 * published lat/lon into world space (nautical miles from the airport
 * reference point) exactly once.
 *
 * After this module, nothing else in the codebase touches latitude or
 * longitude, and nothing branches on a specific ICAO code -- adding an
 * airport means adding a JSON file. See ARCHITECTURE.md sections 2 and 4.
 */


export const M_PER_NM = 1852

export type WakeCategory = 'L' | 'M' | 'H' | 'J'
export type TurnDirection = 'left' | 'right'
export type AirspaceClass = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G'

/** How a volume's geometry was arrived at, so the display can be honest. */
export type Derivation = 'aip' | 'rule' | 'approx'

export interface IlsConfig {
  readonly available: boolean
  readonly glideslopeDeg: number
  readonly fafDistNM: number
  readonly minInterceptDeg: number
}

export interface Runway {
  readonly id: string
  /** Landing threshold, in world space. Always the true position. */
  readonly thresholdNM: Vec2NM
  readonly thresholdLatLon: LatLon
  /** Direction of travel on landing, degrees true. */
  readonly bearingTrue: number
  readonly lengthNM: number
  readonly thresholdElevationFt: number
  /** Departure end of the paved surface, derived from bearing and length. */
  readonly farEndNM: Vec2NM
  readonly ils: IlsConfig
}

export interface HoldPattern {
  readonly turns: TurnDirection
  readonly legMins: number
  /** Inbound leg, degrees true. Derived unless overridden in config. */
  readonly inboundTrue: number
  readonly inboundIsDerived: boolean
}

/** Altitude band an arrival may enter the sector at, over a hold. */
export interface EntryBand {
  readonly minAltFt: number
  readonly maxAltFt: number
}

/**
 * The weather for a session: the wind, and how much precipitation to put on
 * the scope.
 *
 * All gameplay values. Real weather comes from a real forecast, and the
 * point of these is a scope that has to be vectored around rather than a
 * faithful met report.
 */
export interface WeatherSettings {
  /** Direction the wind is FROM, degrees true, and its speed. */
  readonly wind: { readonly fromDeg: number; readonly speedKts: number }
  /**
   * How much of the wind an aircraft actually feels, 0..1.
   *
   * Deliberately not all of it. A full twenty-knot crosswind at 180 kt is
   * an eight degree drift angle, and vectoring against that stops being a
   * game and becomes an exercise in anticipating the wind. A third of it
   * gives groundspeeds that visibly differ upwind and down, and a drift
   * that has to be corrected but not fought.
   */
  readonly windEffect: number
  /**
   * How many cells form per hour of session time, on average.
   *
   * Kept low on purpose. Weather that is on the scope every session is not
   * weather, it is terrain, and a hazard you meet every time stops being a
   * hazard. Combined with a life of a few minutes, a low rate means you
   * usually log on to a clear scope and meet a cell once or twice an hour.
   * The wind is not gated by any of this -- wind is always there.
   */
  readonly cellsPerHour: number
  /** How long a cell lasts, forming to collapse. */
  readonly minLifeMinutes: number
  readonly maxLifeMinutes: number
  /** The share of cells that ever develop a red core, 0..1. Small. */
  readonly heavyChance: number
  readonly minRadiusNM: number
  readonly maxRadiusNM: number
  /** Cells drift at this fraction of the wind speed, on average. */
  readonly driftFactor: number
  /**
   * How far either side of the wind an individual cell's track may lie.
   *
   * Zero would move every cell on exactly the same vector, and a field that
   * translates as one piece reads as a picture being panned rather than as
   * weather. A spread makes them fan out and separate as they cross.
   */
  readonly driftSpreadDeg: number
  /** And how much faster or slower than the mean one may move, as a fraction. */
  readonly driftSpeedSpread: number
  /** How fast an outline reshapes itself, degrees of phase per minute. */
  readonly shapeDriftDegPerMin: number
  /** Cells are placed within this range of the field. */
  readonly spreadNM: number
}

export interface Airline {
  readonly code: string
  readonly weight: number
  /**
   * Types this operator actually flies. The generator picks from here
   * rather than from the whole fleet list, because an easyJet A380 or an
   * Emirates A319 breaks the illusion faster than almost anything else.
   */
  readonly fleet: readonly string[]
  /** Bands its flight numbers fall in. Plausible, not authoritative. */
  readonly numbers: readonly FlightNumberRange[]
  /**
   * Which holding fixes this operator arrives over, and how often, keyed by
   * fix name.
   *
   * An arrival does not pick its corridor at random: it comes down the one
   * that faces where it has flown from. Transatlantic traffic enters over
   * Bovingdon to the north-west, the Middle East and Asia over Biggin to
   * the south-east, Iberia over Ockham to the south-west, and northern
   * Europe over Lambourne to the north-east. So an American 777 arriving
   * over Biggin is wrong in a way a controller would notice immediately.
   *
   * Weights rather than probabilities -- they happen to be written as
   * percentages, and nothing depends on them summing to a hundred. An empty
   * table means no preference, and so does one whose fixes all happen to be
   * full: sim/spawner.ts falls back to any fix with room rather than
   * holding an arrival for the sake of its geography.
   */
  readonly preferredFixes: Readonly<Record<string, number>>
}

export interface FlightNumberRange {
  readonly min: number
  readonly max: number
}

/**
 * Arrival flow settings. All gameplay values rather than published data:
 * real arrival rates and altitudes depend on the STAR, the flow and the
 * day. This is the first thing to tune if the traffic feels wrong.
 */
/**
 * How hard the field itself is, before any difficulty setting.
 *
 * The same four words the session settings use, and deliberately so: a
 * player who has decided Pro is what they are after should be able to read
 * one word on a sector and know whether it is that sort of place. They are
 * still two different things -- the tier is the aerodrome, the difficulty
 * is how much traffic you ask it for -- but there is no reason for them to
 * be measured on different scales.
 */
export type AirportTier = 'easy' | 'normal' | 'hard' | 'pro'

export interface TrafficConfig {
  /** Fixes the arrival stream, so a scenario can be repeated exactly. */
  readonly seed: number
  readonly firstSpawnSeconds: number
  /** Gap between arrivals at the start, before the ramp. */
  readonly initialIntervalSeconds: number
  /** Gap the ramp works down to. */
  readonly minIntervalSeconds: number
  readonly rampMinutes: number
  /** Fraction either side of the interval, so arrivals are not metronomic. */
  readonly intervalJitter: number
  /**
   * Standard entry groundspeed. Capped by the type's cruise, so a slower
   * aircraft is never made to exceed it, and by the sector speed limit
   * below the limit altitude.
   */
  readonly entrySpeedKts: number
  /**
   * How far OUTSIDE the sector boundary an arrival appears, on the radial
   * through its fix -- so every feed hands traffic over at the same range,
   * and an arrival is visible for a couple of minutes before it becomes the
   * controller's to work.
   */
  readonly entryDistanceNM: number
  readonly maxConcurrent: number
  /** A fix with traffic this close is not given another arrival. */
  readonly minFixSpacingNM: number
  /** Nor one that recently had an arrival. */
  readonly minFixSpacingSeconds: number
  readonly airlines: readonly Airline[]
}

/**
 * One transit corridor: a route across the sector that is not this
 * airport's traffic.
 *
 * Held as a list of published fixes and nothing else. Where the aircraft
 * appears and where it leaves are not in the config, because they are not
 * facts about the corridor -- they follow from the boundary, and writing
 * them down would mean maintaining them every time the airspace changed.
 * sim/overflight.ts projects the first and last legs out past the edge.
 */
export interface Corridor {
  readonly id: string
  readonly label: string
  /** Published navaids, in the order they are flown. At least two. */
  readonly via: readonly string[]
  /** Where it is going, as an ICAO code. Never this field. */
  readonly destination: string
  readonly minAltFt: number
  readonly maxAltFt: number
  readonly speedKts: number
  readonly weight: number
  /** Operators that plausibly fly it. Empty falls back to all of them. */
  readonly operators: readonly string[]
  /**
   * How much this corridor gets in the way, which is what decides whether a
   * given difficulty flies it.
   *
   * A fact about the corridor and this field's geometry, so it belongs in
   * the airport file: sim/difficulty.ts says which classes are in use and
   * knows nothing about which corridors exist anywhere.
   */
  readonly crossing: 'clear' | 'crossing' | 'overhead'
}

/**
 * Traffic that crosses the sector without landing on it.
 *
 * Optional in the config, and absent means a field with no transits rather
 * than an error: a quiet regional airport genuinely has none, and requiring
 * the section would make every new airport file carry an empty one.
 */
export interface OverflightConfig {
  readonly seed: number
  readonly firstSpawnSeconds: number
  readonly intervalSeconds: number
  readonly intervalJitter: number
  readonly maxConcurrent: number
  /** How far outside the boundary a transit appears, along its own track. */
  readonly entryDistanceNM: number
  /** And how far past it the final leg runs, so it flies out rather than stopping. */
  readonly exitDistanceNM: number
  readonly corridors: readonly Corridor[]
}

export interface Navaid {
  readonly name: string
  readonly fullName: string
  readonly posNM: Vec2NM
  readonly latLon: LatLon
  readonly station: { readonly type: string; readonly freqMHz: number } | null
  /** Non-null when this navaid is one of the approach holding fixes. */
  readonly hold: HoldPattern | null
  /** Altitude band arrivals enter at. Only meaningful with a hold. */
  readonly entry: EntryBand | null
  readonly distanceFromArpNM: number
  readonly bearingFromArpTrue: number
}

export interface NeighbourAirport {
  readonly icao: string
  readonly name: string
  readonly iata: string | null
  readonly kind: string
  readonly posNM: Vec2NM
  readonly latLon: LatLon
  readonly elevationFt: number
  readonly primaryRunway: {
    readonly ident: string
    readonly bearingTrue: number
    readonly lengthNM: number
  } | null
  readonly distanceFromArpNM: number
  readonly bearingFromArpTrue: number
}

export type AirspaceShape =
  | { readonly kind: 'circle'; readonly centreNM: Vec2NM; readonly radiusNM: number }
  | { readonly kind: 'polygon'; readonly verticesNM: readonly Vec2NM[] }
  /**
   * Boundary line work: one or more polylines, stroked as they are given.
   * This is what the VATSIM UK sector file actually contains -- each record
   * is an independent boundary line, and chaining records together into
   * regions fails, because the file stores a boundary once and shares it
   * between the areas either side. Closing across those gaps would invent
   * edges of up to 30 NM, so it is not attempted.
   *
   * Individual records are a different question, and a happier one:
   * **twenty-nine of the fifty-one are already closed rings in the file**,
   * including the London CTR and London TMA 1. Those can be asked "is this
   * aircraft inside", and `controlZone` below is built from the ones that
   * can.
   */
  | { readonly kind: 'lines'; readonly pathsNM: readonly (readonly Vec2NM[])[] }

/** Where a volume's vertical extent came from. */
export type VerticalSource = 'file' | 'rule' | 'assumed'

export interface AirspaceVolume {
  readonly id: string
  readonly label: string
  readonly airspaceClass: AirspaceClass
  readonly floorFt: number
  readonly ceilingFt: number
  /** True when the drawn boundary is a stand-in for the real one. */
  readonly approximate: boolean
  readonly derivation: Derivation
  readonly verticalSource: VerticalSource
  readonly shape: AirspaceShape
}

/* --------------------------------------------------------------- geography

   The map the airspace sits on: the shoreline, the Thames, and the lateral
   limit of the flight information region. None of them is an airspace volume
   -- there is no class and no vertical extent to any of them -- so they are
   their own section rather than being forced into the airspace schema.    */

export type GeographyKind = 'coastline' | 'river' | 'fir'

/**
 * Where a geographic line came from. Deliberately a different vocabulary
 * from airspace `Derivation`: a coastline is not published in an AIP, and
 * calling a surveyed shoreline "aip" would be a small lie in the data.
 */
export type GeographySource = 'survey' | 'aip'

/**
 * One polyline, with its world-space bounding box precomputed.
 *
 * The bounds exist so the renderer can reject a whole path with two
 * comparisons instead of projecting every point in it. A coastline is a few
 * thousand points and most of it is off-screen at any useful zoom, so this
 * is the difference between a cheap layer and a wasteful one.
 */
export interface GeoPath {
  readonly pointsNM: readonly Vec2NM[]
  readonly minNM: Vec2NM
  readonly maxNM: Vec2NM
  /**
   * True width of the feature at each point, in NM, or null where the
   * source has no width to give.
   *
   * Only rivers carry this. A coastline has no width -- it is the edge of
   * something -- and neither does a FIR boundary. The Thames is a 60 m
   * stream at Windsor and over a kilometre wide at Gravesend, and drawing
   * it at one width throws away the most recognisable thing about it.
   */
  readonly widthsNM: readonly number[] | null
}

export interface GeographyFeature {
  readonly id: string
  readonly label: string
  readonly kind: GeographyKind
  readonly derivation: GeographySource
  /** Human-readable provenance, carried so the display can be honest. */
  readonly source: string
  readonly paths: readonly GeoPath[]
}

export interface RenderSettings {
  /** Display-only magnification of the painted runway strip. */
  readonly runwayExaggeration: number
  /** Zoom past which exaggeration has faded to true scale. */
  readonly exaggerationCutoffPxPerNM: number
  readonly neighbourRunwayMinPx: number
  /**
   * Speed the drawn holding patterns are sized for. A display choice, not a
   * rule: it sets how long the legs are and how wide the turns come out,
   * and nothing in the simulation reads it.
   */
  readonly holdSpeedKts: number
}

export interface Sector {
  readonly radiusNM: number
  readonly ceilingFt: number
  readonly floorFt: number
  readonly speedLimitKts: number
  readonly speedLimitBelowFt: number
  readonly interceptAltMaxFt: number
  readonly rangeRingsNM: readonly number[]
  readonly defaultRangeNM: number
  readonly activeArrivalRunways: readonly string[]
  /**
   * Runways departures use.
   *
   * Separate from the arrival runways because at most real fields they are
   * different ones: Heathrow runs segregated, landing on one and departing
   * off the other, and swaps them at three in the afternoon so the same
   * neighbourhoods are not overflown all day.
   */
  readonly activeDepartureRunways: readonly string[]
}

export interface AircraftType {
  readonly type: string
  readonly wake: WakeCategory
  readonly cruiseKts: number
  readonly approachKts: number
  /** Share of the fleet mix. Zero excludes a type without deleting it. */
  readonly weight: number
}

export interface Airport {
  readonly icao: string
  readonly name: string
  readonly arp: LatLon
  readonly elevationFt: number
  readonly magVarDeg: number
  readonly projection: Projection
  readonly sector: Sector
  readonly render: RenderSettings
  /**
   * Which tier this field belongs to, and what makes it that.
   *
   * A property of the aerodrome rather than of the session: Faro is a
   * gentle place to control whatever settings you pick, and Barcelona is
   * not. The session's difficulty scales the traffic on top of this; the
   * tier is what the menu sorts by and what the brief describes.
   */
  readonly tier: AirportTier
  /**
   * What to call it in a list.
   *
   * Not the ICAO code and not the full name: a chooser wants "Heathrow",
   * which is neither "EGLL" nor "London Heathrow". Explicit rather than
   * derived from the long name, because the rule that turns one into the
   * other is different at every field.
   */
  readonly shortName: string
  /**
   * The one line that says why this field is worth flying.
   *
   * Sized for a chooser rather than a briefing: shown at a fixed height so
   * moving across the list cannot make the panel change shape underneath
   * the cursor, which is what the paragraph used to do.
   */
  readonly challenge: string
  /** A paragraph on how the place works and what catches people out. */
  readonly brief: string
  /**
   * Where the numbers in this profile came from.
   *
   * Carried onto the loaded airport rather than left in the file, because
   * the four profiles are not of equal quality: Heathrow is surveyed from
   * the AIP and the other three are constructed. Anything that presents a
   * field to a player should be able to find that out, and a test can
   * insist a constructed profile says so.
   */
  readonly provenance: Readonly<Record<string, string>>
  /** High ground, and the lowest anything may be over it. */
  readonly terrain: readonly TerrainZone[]
  /** Where traffic may not be vectored low, and what it costs. */
  readonly noise: readonly NoiseZone[]
  readonly traffic: TrafficConfig
  /** Transit corridors, or null for a field configured without any. */
  readonly overflights: OverflightConfig | null
  readonly runways: readonly Runway[]
  readonly navaids: readonly Navaid[]
  readonly airports: readonly NeighbourAirport[]
  readonly weather: WeatherSettings
  readonly airspace: readonly AirspaceVolume[]
  /**
   * The area of responsibility: the published controlled airspace over this
   * field, rather than a radius around it. See sim/airspace.ts.
   */
  readonly controlZone: ControlZone
  /**
   * The outline of that airspace: the rings to draw, and the shape to mask
   * the rest of the map outside. Worked out once, because it is asked for
   * on every frame and the answer never changes.
   */
  readonly controlFootprint: readonly (readonly Vec2NM[])[]
  /** Coastline, river and FIR limit. Empty when the config omits it. */
  readonly geography: readonly GeographyFeature[]
  /**
   * The outer edge of the drawn map, or null when there is no map.
   *
   * The camera is fenced into this: past the edge of the coastline data
   * there is nothing but empty ground, and being able to drag out there
   * reads as a broken display rather than as freedom.
   */
  readonly mapBoundsNM: BoundsNM | null
  readonly aircraftTypes: readonly AircraftType[]
  /** Navaids that carry a holding pattern, in config order. */
  readonly holdingFixes: readonly Navaid[]
  /** Runways currently accepting arrivals, in config order. */
  readonly arrivalRunways: readonly Runway[]
  readonly departureRunways: readonly Runway[]
  /** Every notable world-space point, for an initial camera fit. */
  readonly extentNM: readonly Vec2NM[]
}

/* ---------------------------------------------------------------- helpers */

class ConfigError extends Error {
  constructor(path: string, message: string) {
    super(`airport config: ${path} ${message}`)
    this.name = 'ConfigError'
  }
}

function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(path, 'must be an object')
  }
  return value as Record<string, unknown>
}

function num(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigError(path, 'must be a finite number')
  }
  return value
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError(path, 'must be a non-empty string')
  }
  return value
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new ConfigError(path, 'must be a boolean')
  return value
}

function arr(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigError(path, 'must be a non-empty array')
  }
  return value
}

function latLon(value: unknown, path: string): LatLon {
  const o = obj(value, path)
  const lat = num(o['lat'], `${path}.lat`)
  const lon = num(o['lon'], `${path}.lon`)
  if (lat < -90 || lat > 90) throw new ConfigError(`${path}.lat`, 'must be within -90..90')
  if (lon < -180 || lon > 180) throw new ConfigError(`${path}.lon`, 'must be within -180..180')
  return { lat, lon }
}

function latLonAt(o: Record<string, unknown>, path: string): LatLon {
  return latLon({ lat: o['lat'], lon: o['lon'] }, path)
}

function wake(value: unknown, path: string): WakeCategory {
  const s = str(value, path)
  if (s !== 'L' && s !== 'M' && s !== 'H' && s !== 'J') {
    throw new ConfigError(path, `must be one of L, M, H, J (got ${s})`)
  }
  return s
}

function turnDirection(value: unknown, path: string): TurnDirection {
  const s = str(value, path)
  if (s !== 'left' && s !== 'right') {
    throw new ConfigError(path, `must be "left" or "right" (got ${s})`)
  }
  return s
}

function airspaceClass(value: unknown, path: string): AirspaceClass {
  const s = str(value, path)
  if (!'ABCDEFG'.includes(s) || s.length !== 1) {
    throw new ConfigError(path, `must be a single letter A-G (got ${s})`)
  }
  return s as AirspaceClass
}

function assertUnique(values: readonly string[], path: string): void {
  const seen = new Set<string>()
  for (const v of values) {
    if (seen.has(v)) throw new ConfigError(path, `contains duplicate "${v}"`)
    seen.add(v)
  }
}

function parseHold(
  raw: unknown,
  path: string,
  posNM: Vec2NM,
): HoldPattern | null {
  if (raw === undefined) return null
  const h = obj(raw, path)
  const override = h['inboundTrue']
  // Published inbound tracks are not in the open dataset, so default to the
  // leg that points at the airport. Real STAR data overrides this.
  const derived = override === undefined
  return {
    turns: turnDirection(h['turns'], `${path}.turns`),
    legMins: num(h['legMins'], `${path}.legMins`),
    inboundTrue: derived
      ? bearingDeg(posNM, { x: 0, y: 0 })
      : normalizeHeading(num(override, `${path}.inboundTrue`)),
    inboundIsDerived: derived,
  }
}

/* ------------------------------------------------------------------ loader */

export function loadAirport(raw: unknown): Airport {
  const root = obj(raw, 'root')

  const icao = str(root['icao'], 'icao')
  const arp = latLon(root['arp'], 'arp')

  // World space is anchored on the airport reference point, so the ARP is
  // the origin and every other position is relative to it.
  const projection = makeProjection(arp)

  const sector = parseSector(root['sector'])
  const render = parseRender(root['render'])

  const runways = arr(root['runways'], 'runways').map((r, i) =>
    parseRunway(r, `runways[${i}]`, projection),
  )
  // Parsed here and refitted below, once the airspace it has to fit inside
  // has been read.
  const rawNavaids = arr(root['navaids'], 'navaids').map((n, i) =>
    parseNavaid(n, `navaids[${i}]`, projection),
  )
  // Optional, and empty is a legitimate answer: a field with no charted
  // neighbours is a field with no charted neighbours. Requiring one would
  // make every new profile invent an aerodrome to satisfy the parser.
  const airports =
    root['airports'] === undefined
      ? []
      : arr(root['airports'], 'airports').map((a, i) =>
          parseNeighbour(a, `airports[${i}]`, projection),
        )
  const aircraftTypes = arr(root['aircraftTypes'], 'aircraftTypes').map((t, i) =>
    parseAircraftType(t, `aircraftTypes[${i}]`),
  )
  const traffic = parseTraffic(
    root['traffic'],
    new Set(aircraftTypes.map((t) => t.type)),
    // The fixes an arrival can actually be released over, which is what a
    // routing preference has to name to mean anything.
    new Set(
      rawNavaids.filter((n) => n.hold !== null && n.entry !== null).map((n) => n.name),
    ),
  )

  const overflights = parseOverflights(
    root['overflights'],
    new Set(rawNavaids.map((n) => n.name)),
    new Set(traffic.airlines.map((a) => a.code)),
  )

  assertUnique(runways.map((r) => r.id), 'runways[].id')
  assertUnique(rawNavaids.map((n) => n.name), 'navaids[].name')
  assertUnique(airports.map((a) => a.icao), 'airports[].icao')
  assertUnique(aircraftTypes.map((t) => t.type), 'aircraftTypes[].type')

  // Airspace volumes may be anchored on an aerodrome by ICAO code rather
  // than by explicit coordinates, so the lookup covers the field being
  // controlled as well as every neighbour.
  const anchors = new Map<string, Vec2NM>([[icao, { x: 0, y: 0 }]])
  for (const a of airports) anchors.set(a.icao, a.posNM)

  const airspace = arr(root['airspace'], 'airspace').map((v, i) =>
    parseAirspace(v, `airspace[${i}]`, projection, anchors),
  )
  const controlZone = deriveControlZone(airspace)
  const navaids = rawNavaids.map((n) => fitHoldToAirspace(n, controlZone))
  assertUnique(airspace.map((v) => v.id), 'airspace[].id')

  // Optional: an airport config without a map around it is still a valid
  // airport config, and a second field would only ever be added by hand.
  const geography =
    root['geography'] === undefined
      ? []
      : arr(root['geography'], 'geography').map((f, i) =>
          parseGeography(f, `geography[${i}]`, projection),
        )
  assertUnique(geography.map((f) => f.id), 'geography[].id')

  const mapBoundsNM = boundsOfGeography(geography)

  const byId = new Map(runways.map((r) => [r.id, r]))
  const resolve = (ids: readonly string[], field: string): Runway[] =>
    ids.map((id) => {
      const rwy = byId.get(id)
      if (!rwy) throw new ConfigError(field, `references unknown runway "${id}"`)
      return rwy
    })

  const arrivalRunways = resolve(sector.activeArrivalRunways, 'sector.activeArrivalRunways')
  const departureRunways = resolve(
    sector.activeDepartureRunways,
    'sector.activeDepartureRunways',
  )

  // Note what is NOT here: the geography. The extent drives the initial
  // camera fit, and a coastline reaching 200 NM out would open the scope to
  // a range at which the airport is a dot.
  const extentNM: Vec2NM[] = [
    ...runways.flatMap((r) => [r.thresholdNM, r.farEndNM]),
    ...navaids.map((n) => n.posNM),
    ...airports.map((a) => a.posNM),
  ]

  return {
    icao,
    name: str(root['name'], 'name'),
    arp,
    elevationFt: num(root['elevationFt'], 'elevationFt'),
    magVarDeg: num(root['magVarDeg'], 'magVarDeg'),
    projection,
    sector,
    render,
    tier: parseTier(root['tier']),
    shortName: str(root['shortName'], 'shortName'),
    challenge: str(root['challenge'], 'challenge'),
    brief: str(root['brief'], 'brief'),
    provenance: parseProvenance(root['provenance']),
    terrain: parseTerrain(root['terrain'], projection),
    noise: parseNoise(root['noise'], projection),
    traffic,
    overflights,
    runways,
    navaids,
    airports,
    airspace,
    weather: parseWeather(root['weather']),
    controlZone,
    controlFootprint: footprint(controlZone),
    geography,
    mapBoundsNM,
    aircraftTypes,
    holdingFixes: navaids.filter((n) => n.hold !== null),
    arrivalRunways,
    departureRunways,
    extentNM,
  }
}

function parseSector(raw: unknown): Sector {
  const o = obj(raw, 'sector')
  const rings = arr(o['rangeRingsNM'], 'sector.rangeRingsNM').map((v, i) =>
    num(v, `sector.rangeRingsNM[${i}]`),
  )
  const active = arr(o['activeArrivalRunways'], 'sector.activeArrivalRunways').map((v, i) =>
    str(v, `sector.activeArrivalRunways[${i}]`),
  )
  // Optional, and empty is a legitimate answer: a field with nothing
  // departing is an arrivals-only position, which is what this was before
  // departure runways existed at all.
  const departing =
    o['activeDepartureRunways'] === undefined
      ? []
      : arr(o['activeDepartureRunways'], 'sector.activeDepartureRunways').map((v, i) =>
          str(v, `sector.activeDepartureRunways[${i}]`),
        )

  const ceilingFt = num(o['ceilingFt'], 'sector.ceilingFt')
  const floorFt = num(o['floorFt'], 'sector.floorFt')
  if (floorFt >= ceilingFt) {
    throw new ConfigError('sector.floorFt', 'must be below sector.ceilingFt')
  }

  return {
    radiusNM: num(o['radiusNM'], 'sector.radiusNM'),
    ceilingFt,
    floorFt,
    speedLimitKts: num(o['speedLimitKts'], 'sector.speedLimitKts'),
    speedLimitBelowFt: num(o['speedLimitBelowFt'], 'sector.speedLimitBelowFt'),
    interceptAltMaxFt: num(o['interceptAltMaxFt'], 'sector.interceptAltMaxFt'),
    rangeRingsNM: rings,
    defaultRangeNM: num(o['defaultRangeNM'], 'sector.defaultRangeNM'),
    activeArrivalRunways: active,
    activeDepartureRunways: departing,
  }
}

function parseWeather(raw: unknown): WeatherSettings {
  const o = obj(raw, 'weather')
  const w = obj(o['wind'], 'weather.wind')

  const fromDeg = num(w['fromDeg'], 'weather.wind.fromDeg')
  if (fromDeg < 0 || fromDeg > 360) {
    throw new ConfigError('weather.wind.fromDeg', 'must be a bearing within 0..360')
  }
  const speedKts = num(w['speedKts'], 'weather.wind.speedKts')
  if (speedKts < 0) throw new ConfigError('weather.wind.speedKts', 'must not be negative')

  const windEffect = num(o['windEffect'], 'weather.windEffect')
  if (windEffect < 0 || windEffect > 1) {
    throw new ConfigError('weather.windEffect', 'must be a fraction within 0..1')
  }

  const cellsPerHour = num(o['cellsPerHour'], 'weather.cellsPerHour')
  if (cellsPerHour < 0) throw new ConfigError('weather.cellsPerHour', 'must not be negative')

  const minLifeMinutes = num(o['minLifeMinutes'], 'weather.minLifeMinutes')
  const maxLifeMinutes = num(o['maxLifeMinutes'], 'weather.maxLifeMinutes')
  if (minLifeMinutes <= 0) throw new ConfigError('weather.minLifeMinutes', 'must be positive')
  if (maxLifeMinutes < minLifeMinutes) {
    throw new ConfigError('weather.maxLifeMinutes', 'must not be below the minimum')
  }

  const heavyChance = num(o['heavyChance'], 'weather.heavyChance')
  if (heavyChance < 0 || heavyChance > 1) {
    throw new ConfigError('weather.heavyChance', 'must be a probability within 0..1')
  }

  const minRadiusNM = num(o['minRadiusNM'], 'weather.minRadiusNM')
  const maxRadiusNM = num(o['maxRadiusNM'], 'weather.maxRadiusNM')
  if (minRadiusNM <= 0) throw new ConfigError('weather.minRadiusNM', 'must be positive')
  if (maxRadiusNM < minRadiusNM) {
    throw new ConfigError('weather.maxRadiusNM', 'must not be below the minimum')
  }

  const driftFactor = num(o['driftFactor'], 'weather.driftFactor')
  if (driftFactor < 0) throw new ConfigError('weather.driftFactor', 'must not be negative')

  const driftSpreadDeg = num(o['driftSpreadDeg'], 'weather.driftSpreadDeg')
  if (driftSpreadDeg < 0 || driftSpreadDeg > 180) {
    throw new ConfigError('weather.driftSpreadDeg', 'must be within 0..180')
  }

  const driftSpeedSpread = num(o['driftSpeedSpread'], 'weather.driftSpeedSpread')
  if (driftSpeedSpread < 0 || driftSpeedSpread >= 1) {
    // At one, a cell could be drawn stationary while the rest of the field
    // moves, which looks like a bug rather than like weather.
    throw new ConfigError('weather.driftSpeedSpread', 'must be a fraction below 1')
  }

  const shapeDriftDegPerMin = num(o['shapeDriftDegPerMin'], 'weather.shapeDriftDegPerMin')
  if (shapeDriftDegPerMin < 0) {
    throw new ConfigError('weather.shapeDriftDegPerMin', 'must not be negative')
  }

  const spreadNM = num(o['spreadNM'], 'weather.spreadNM')
  if (spreadNM <= 0) throw new ConfigError('weather.spreadNM', 'must be positive')

  return {
    wind: { fromDeg: normalizeHeading(fromDeg), speedKts },
    windEffect,
    cellsPerHour,
    minLifeMinutes,
    maxLifeMinutes,
    heavyChance,
    minRadiusNM,
    maxRadiusNM,
    driftFactor,
    driftSpreadDeg,
    driftSpeedSpread,
    shapeDriftDegPerMin,
    spreadNM,
  }
}

/**
 * The transit corridors, or null when the file carries none.
 *
 * Validated against the navaids for the same reason the airline routing
 * tables are: a mistyped fix here would otherwise become a corridor that
 * silently never generates, which is the worst way for a typo to behave.
 */
function parseOverflights(
  raw: unknown,
  knownNavaids: ReadonlySet<string>,
  knownAirlines: ReadonlySet<string>,
): OverflightConfig | null {
  if (raw === undefined || raw === null) return null
  const o = obj(raw, 'overflights')

  const jitter = num(o['intervalJitter'], 'overflights.intervalJitter')
  if (jitter < 0 || jitter >= 1) {
    throw new ConfigError('overflights.intervalJitter', 'must be within 0..1')
  }
  const interval = num(o['intervalSeconds'], 'overflights.intervalSeconds')
  if (interval <= 0) throw new ConfigError('overflights.intervalSeconds', 'must be positive')

  const corridors = arr(o['corridors'], 'overflights.corridors').map((c, i) => {
    const p = `overflights.corridors[${i}]`
    const co = obj(c, p)

    const via = arr(co['via'], `${p}.via`).map((v, j) => str(v, `${p}.via[${j}]`))
    if (via.length < 2) {
      // One fix is a point, not a route: there would be no track to
      // project the entry and the exit from.
      throw new ConfigError(`${p}.via`, 'must name at least two fixes')
    }
    for (const fix of via) {
      if (!knownNavaids.has(fix)) {
        throw new ConfigError(`${p}.via`, `references unknown navaid "${fix}"`)
      }
    }

    const minAltFt = num(co['minAltFt'], `${p}.minAltFt`)
    const maxAltFt = num(co['maxAltFt'], `${p}.maxAltFt`)
    if (maxAltFt < minAltFt) {
      throw new ConfigError(`${p}.maxAltFt`, 'must not be below minAltFt')
    }

    const operators = arr(co['operators'], `${p}.operators`).map((v, j) =>
      str(v, `${p}.operators[${j}]`),
    )
    for (const code of operators) {
      if (!knownAirlines.has(code)) {
        throw new ConfigError(`${p}.operators`, `references unknown airline "${code}"`)
      }
    }

    return {
      id: str(co['id'], `${p}.id`),
      label: str(co['label'], `${p}.label`),
      via,
      destination: str(co['destination'], `${p}.destination`),
      minAltFt,
      maxAltFt,
      speedKts: num(co['speedKts'], `${p}.speedKts`),
      weight: num(co['weight'], `${p}.weight`),
      operators,
      crossing: oneOfCrossing(co['crossing'], `${p}.crossing`),
    }
  })

  return {
    seed: num(o['seed'], 'overflights.seed'),
    firstSpawnSeconds: num(o['firstSpawnSeconds'], 'overflights.firstSpawnSeconds'),
    intervalSeconds: interval,
    intervalJitter: jitter,
    maxConcurrent: num(o['maxConcurrent'], 'overflights.maxConcurrent'),
    entryDistanceNM: num(o['entryDistanceNM'], 'overflights.entryDistanceNM'),
    exitDistanceNM: num(o['exitDistanceNM'], 'overflights.exitDistanceNM'),
    corridors,
  }
}

/** A corridor's class, defaulting to the cautious reading. */
function oneOfCrossing(raw: unknown, path: string): 'clear' | 'crossing' | 'overhead' {
  // Absent means crossing rather than clear: a corridor nobody has thought
  // about should not quietly turn up on the gentlest setting.
  if (raw === undefined || raw === null) return 'crossing'
  const value = str(raw, path)
  if (value === 'clear' || value === 'crossing' || value === 'overhead') return value
  throw new ConfigError(path, 'must be clear, crossing or overhead')
}

/**
 * A zone's footprint: a circle, or a ring of coordinates.
 *
 * Deliberately fewer shapes than the airspace parser offers. Terrain and
 * noise are areas rather than published volumes -- nobody needs a multi-path
 * mountain -- and two shapes cover every case either of them has.
 */
function parseZoneShape(o: Record<string, unknown>, path: string, projection: Projection): ZoneShape {
  const kind = str(o['kind'], `${path}.kind`)
  if (kind === 'circle') {
    const radiusNM = num(o['radiusNM'], `${path}.radiusNM`)
    if (radiusNM <= 0) throw new ConfigError(`${path}.radiusNM`, 'must be positive')
    return {
      kind: 'circle',
      centreNM: projection.toWorld(latLon(o['centre'], `${path}.centre`)),
      radiusNM,
    }
  }
  if (kind === 'polygon') {
    const verts = arr(o['vertices'], `${path}.vertices`)
    if (verts.length < 3) throw new ConfigError(`${path}.vertices`, 'needs at least three')
    return {
      kind: 'polygon',
      verticesNM: verts.map((v, i) =>
        projection.toWorld(latLon(v, `${path}.vertices[${i}]`)),
      ),
    }
  }
  throw new ConfigError(`${path}.kind`, 'must be circle or polygon')
}

/** High ground. Optional: most fields are flat enough not to need any. */
function parseTerrain(raw: unknown, projection: Projection): TerrainZone[] {
  if (raw === undefined || raw === null) return []
  return arr(raw, 'terrain').map((t, i) => {
    const p = `terrain[${i}]`
    const o = obj(t, p)
    const peakFt = num(o['peakFt'], `${p}.peakFt`)
    const minimumSafeFt = num(o['minimumSafeFt'], `${p}.minimumSafeFt`)
    if (minimumSafeFt <= peakFt) {
      // The minimum is the hill plus the margin. One at or below the summit
      // is not a minimum safe altitude, it is a hill with a number on it.
      throw new ConfigError(`${p}.minimumSafeFt`, 'must be above peakFt')
    }
    const massif = o['massif']
    const summit = o['summit']
    return {
      id: str(o['id'], `${p}.id`),
      label: str(o['label'], `${p}.label`),
      shape: parseZoneShape(o, p, projection),
      ...(massif === undefined ? {} : { massif: str(massif, `${p}.massif`) }),
      ...(summit === undefined
        ? {}
        : { summitNM: projection.toWorld(latLon(summit, `${p}.summit`)) }),
      minimumSafeFt,
      peakFt,
    }
  })
}

/** Noise abatement areas. Optional, and empty at a field with none. */
function parseNoise(raw: unknown, projection: Projection): NoiseZone[] {
  if (raw === undefined || raw === null) return []
  return arr(raw, 'noise').map((n, i) => {
    const p = `noise[${i}]`
    const o = obj(n, p)
    return {
      id: str(o['id'], `${p}.id`),
      label: str(o['label'], `${p}.label`),
      shape: parseZoneShape(o, p, projection),
      floorFt: num(o['floorFt'], `${p}.floorFt`),
      penaltyPoints: num(o['penaltyPoints'], `${p}.penaltyPoints`),
    }
  })
}

/** Free-form notes on where the data came from. Optional, and empty is fine. */
function parseProvenance(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {}
  const o = obj(raw, 'provenance')
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(o)) out[key] = String(value)
  return out
}

function parseTier(raw: unknown): AirportTier {
  const value = str(raw, 'tier')
  if (value === 'easy' || value === 'normal' || value === 'hard' || value === 'pro') {
    return value
  }
  throw new ConfigError('tier', 'must be easy, normal, hard or pro')
}

function parseTraffic(
  raw: unknown,
  knownTypes: ReadonlySet<string>,
  knownFixes: ReadonlySet<string>,
): TrafficConfig {
  const o = obj(raw, 'traffic')

  const initial = num(o['initialIntervalSeconds'], 'traffic.initialIntervalSeconds')
  const min = num(o['minIntervalSeconds'], 'traffic.minIntervalSeconds')
  if (min <= 0) throw new ConfigError('traffic.minIntervalSeconds', 'must be positive')
  if (min > initial) {
    // The ramp works downwards, so a floor above the starting gap would
    // make the traffic get lighter over time.
    throw new ConfigError(
      'traffic.minIntervalSeconds',
      'must not exceed traffic.initialIntervalSeconds',
    )
  }

  const jitter = num(o['intervalJitter'], 'traffic.intervalJitter')
  if (jitter < 0 || jitter >= 1) {
    throw new ConfigError('traffic.intervalJitter', 'must be within 0..1')
  }

  const maxConcurrent = num(o['maxConcurrent'], 'traffic.maxConcurrent')
  if (maxConcurrent < 1) throw new ConfigError('traffic.maxConcurrent', 'must be at least 1')

  const airlines = arr(o['airlines'], 'traffic.airlines').map((a, i) => {
    const path = `traffic.airlines[${i}]`
    const ao = obj(a, path)
    const code = str(ao['code'], `${path}.code`)

    const fleet = arr(ao['fleet'], `${path}.fleet`).map((v, j) =>
      str(v, `${path}.fleet[${j}]`),
    )
    for (const type of fleet) {
      if (!knownTypes.has(type)) {
        // Catches a typo in a fleet list at load rather than as an aircraft
        // that can never be generated.
        throw new ConfigError(`${path}.fleet`, `references unknown type "${type}"`)
      }
    }

    const numbers = arr(ao['numbers'], `${path}.numbers`).map((v, j) => {
      const rangePath = `${path}.numbers[${j}]`
      if (!Array.isArray(v) || v.length !== 2) {
        throw new ConfigError(rangePath, 'must be a pair [min, max]')
      }
      const min = num(v[0], `${rangePath}[0]`)
      const max = num(v[1], `${rangePath}[1]`)
      if (min < 1) throw new ConfigError(rangePath, 'must start at 1 or above')
      if (max < min) throw new ConfigError(rangePath, 'must not end below its start')
      return { min, max }
    })

    const prefsPath = `${path}.preferredFixes`
    const prefsRaw = obj(ao['preferredFixes'], prefsPath)
    const preferredFixes: Record<string, number> = {}
    for (const [fix, weight] of Object.entries(prefsRaw)) {
      if (!knownFixes.has(fix)) {
        // Catches a typo in a routing table at load rather than as an
        // operator that quietly arrives from everywhere.
        throw new ConfigError(prefsPath, `references unknown holding fix "${fix}"`)
      }
      const w = num(weight, `${prefsPath}.${fix}`)
      if (w < 0) throw new ConfigError(`${prefsPath}.${fix}`, 'must not be negative')
      preferredFixes[fix] = w
    }

    return {
      code,
      weight: num(ao['weight'], `${path}.weight`),
      fleet,
      numbers,
      preferredFixes,
    }
  })
  if (!airlines.some((a) => a.weight > 0)) {
    throw new ConfigError('traffic.airlines', 'needs at least one positive weight')
  }

  return {
    seed: num(o['seed'], 'traffic.seed'),
    firstSpawnSeconds: num(o['firstSpawnSeconds'], 'traffic.firstSpawnSeconds'),
    initialIntervalSeconds: initial,
    minIntervalSeconds: min,
    rampMinutes: num(o['rampMinutes'], 'traffic.rampMinutes'),
    intervalJitter: jitter,
    entrySpeedKts: num(o['entrySpeedKts'], 'traffic.entrySpeedKts'),
    entryDistanceNM: num(o['entryDistanceNM'], 'traffic.entryDistanceNM'),
    maxConcurrent,
    minFixSpacingNM: num(o['minFixSpacingNM'], 'traffic.minFixSpacingNM'),
    minFixSpacingSeconds: num(o['minFixSpacingSeconds'], 'traffic.minFixSpacingSeconds'),
    airlines,
  }
}

function parseEntry(raw: unknown, path: string): EntryBand | null {
  if (raw === undefined) return null
  const o = obj(raw, path)
  const minAltFt = num(o['minAltFt'], `${path}.minAltFt`)
  const maxAltFt = num(o['maxAltFt'], `${path}.maxAltFt`)
  if (maxAltFt < minAltFt) {
    throw new ConfigError(`${path}.maxAltFt`, 'must not be below minAltFt')
  }
  return { minAltFt, maxAltFt }
}

function parseRender(raw: unknown): RenderSettings {
  const o = obj(raw, 'render')
  const ex = num(o['runwayExaggeration'], 'render.runwayExaggeration')
  if (ex < 1) throw new ConfigError('render.runwayExaggeration', 'must be at least 1')
  const holdSpeed = num(o['holdSpeedKts'], 'render.holdSpeedKts')
  if (holdSpeed <= 0) throw new ConfigError('render.holdSpeedKts', 'must be positive')

  return {
    runwayExaggeration: ex,
    exaggerationCutoffPxPerNM: num(
      o['exaggerationCutoffPxPerNM'],
      'render.exaggerationCutoffPxPerNM',
    ),
    neighbourRunwayMinPx: num(o['neighbourRunwayMinPx'], 'render.neighbourRunwayMinPx'),
    holdSpeedKts: holdSpeed,
  }
}

function parseRunway(raw: unknown, path: string, projection: Projection): Runway {
  const o = obj(raw, path)
  const thresholdLatLon = latLon(o['threshold'], `${path}.threshold`)
  const thresholdNM = projection.toWorld(thresholdLatLon)
  const bearingTrue = normalizeHeading(num(o['bearingTrue'], `${path}.bearingTrue`))

  const lengthFt = num(o['lengthFt'], `${path}.lengthFt`)
  if (lengthFt <= 0) throw new ConfigError(`${path}.lengthFt`, 'must be positive')
  const lengthNM = lengthFt / FT_PER_NM

  const ilsRaw = obj(o['ils'], `${path}.ils`)
  const ils: IlsConfig = {
    available: bool(ilsRaw['available'], `${path}.ils.available`),
    glideslopeDeg: num(ilsRaw['glideslopeDeg'], `${path}.ils.glideslopeDeg`),
    fafDistNM: num(ilsRaw['fafDistNM'], `${path}.ils.fafDistNM`),
    minInterceptDeg: num(ilsRaw['minInterceptDeg'], `${path}.ils.minInterceptDeg`),
  }

  return {
    id: str(o['id'], `${path}.id`),
    thresholdNM,
    thresholdLatLon,
    bearingTrue,
    lengthNM,
    thresholdElevationFt: num(o['thresholdElevationFt'], `${path}.thresholdElevationFt`),
    farEndNM: advance(thresholdNM, bearingTrue, lengthNM),
    ils,
  }
}

function parseNavaid(raw: unknown, path: string, projection: Projection): Navaid {
  const o = obj(raw, path)
  const location = latLonAt(o, path)
  const posNM = projection.toWorld(location)
  const origin: Vec2NM = { x: 0, y: 0 }

  let station: Navaid['station'] = null
  if (o['navaid'] !== undefined) {
    const n = obj(o['navaid'], `${path}.navaid`)
    station = {
      type: str(n['type'], `${path}.navaid.type`),
      freqMHz: num(n['freqMHz'], `${path}.navaid.freqMHz`),
    }
  }

  return {
    name: str(o['name'], `${path}.name`),
    fullName: str(o['fullName'], `${path}.fullName`),
    posNM,
    latLon: location,
    station,
    hold: parseHold(o['hold'], `${path}.hold`, posNM),
    entry: parseEntry(o['entry'], `${path}.entry`),
    distanceFromArpNM: distanceNM(origin, posNM),
    bearingFromArpTrue: bearingDeg(origin, posNM),
  }
}

function parseNeighbour(
  raw: unknown,
  path: string,
  projection: Projection,
): NeighbourAirport {
  const o = obj(raw, path)
  const location = latLonAt(o, path)
  const posNM = projection.toWorld(location)
  const origin: Vec2NM = { x: 0, y: 0 }

  let primaryRunway: NeighbourAirport['primaryRunway'] = null
  if (o['primaryRunway'] !== undefined) {
    const r = obj(o['primaryRunway'], `${path}.primaryRunway`)
    const lengthFt = num(r['lengthFt'], `${path}.primaryRunway.lengthFt`)
    if (lengthFt <= 0) {
      throw new ConfigError(`${path}.primaryRunway.lengthFt`, 'must be positive')
    }
    primaryRunway = {
      ident: str(r['ident'], `${path}.primaryRunway.ident`),
      bearingTrue: normalizeHeading(
        num(r['bearingTrue'], `${path}.primaryRunway.bearingTrue`),
      ),
      lengthNM: lengthFt / FT_PER_NM,
    }
  }

  const iata = o['iata']

  return {
    icao: str(o['icao'], `${path}.icao`),
    name: str(o['name'], `${path}.name`),
    iata: typeof iata === 'string' && iata.length > 0 ? iata : null,
    kind: str(o['kind'], `${path}.kind`),
    posNM,
    latLon: location,
    elevationFt: num(o['elevationFt'], `${path}.elevationFt`),
    primaryRunway,
    distanceFromArpNM: distanceNM(origin, posNM),
    bearingFromArpTrue: bearingDeg(origin, posNM),
  }
}

function parseAirspace(
  raw: unknown,
  path: string,
  projection: Projection,
  anchors: ReadonlyMap<string, Vec2NM>,
): AirspaceVolume {
  const o = obj(raw, path)

  const floorFt = num(o['floorFt'], `${path}.floorFt`)
  const ceilingFt = num(o['ceilingFt'], `${path}.ceilingFt`)
  if (ceilingFt <= floorFt) {
    throw new ConfigError(`${path}.ceilingFt`, 'must be above floorFt')
  }

  const derivation = parseDerivation(o['derivation'], `${path}.derivation`)
  const verticalSource = parseVerticalSource(o['verticalSource'], `${path}.verticalSource`)

  const kind = str(o['kind'], `${path}.kind`)
  let shape: AirspaceShape

  if (kind === 'circle') {
    const radiusNM = num(o['radiusNM'], `${path}.radiusNM`)
    if (radiusNM <= 0) throw new ConfigError(`${path}.radiusNM`, 'must be positive')

    let centreNM: Vec2NM
    if (o['centreAirport'] !== undefined) {
      const ref = str(o['centreAirport'], `${path}.centreAirport`)
      const anchor = anchors.get(ref)
      if (!anchor) {
        throw new ConfigError(
          `${path}.centreAirport`,
          `references unknown aerodrome "${ref}"`,
        )
      }
      centreNM = anchor
    } else {
      centreNM = projection.toWorld(latLon(o['centre'], `${path}.centre`))
    }
    shape = { kind: 'circle', centreNM, radiusNM }
  } else if (kind === 'polygon') {
    const verts = arr(o['vertices'], `${path}.vertices`)
    if (verts.length < 3) {
      throw new ConfigError(`${path}.vertices`, 'must have at least 3 points')
    }
    shape = {
      kind: 'polygon',
      verticesNM: verts.map((v, i) =>
        projection.toWorld(latLon(v, `${path}.vertices[${i}]`)),
      ),
    }
  } else if (kind === 'lines') {
    const paths = arr(o['paths'], `${path}.paths`)
    shape = {
      kind: 'lines',
      pathsNM: paths.map((line, i) => {
        const pts = arr(line, `${path}.paths[${i}]`)
        if (pts.length < 2) {
          throw new ConfigError(`${path}.paths[${i}]`, 'must have at least 2 points')
        }
        return pts.map((v, j) =>
          projection.toWorld(latLon(v, `${path}.paths[${i}][${j}]`)),
        )
      }),
    }
  } else {
    throw new ConfigError(
      `${path}.kind`,
      `must be "circle", "polygon" or "lines" (got ${kind})`,
    )
  }

  return {
    id: str(o['id'], `${path}.id`),
    label: str(o['label'], `${path}.label`),
    airspaceClass: airspaceClass(o['class'], `${path}.class`),
    floorFt,
    ceilingFt,
    // Not a config field: a boundary is a stand-in exactly when it did not
    // come from the published source, so deriving this keeps the flag and
    // the provenance from ever disagreeing.
    approximate: derivation !== 'aip',
    derivation,
    verticalSource,
    shape,
  }
}

function parseGeography(
  raw: unknown,
  path: string,
  projection: Projection,
): GeographyFeature {
  const o = obj(raw, path)

  const kind = str(o['kind'], `${path}.kind`)
  if (kind !== 'coastline' && kind !== 'river' && kind !== 'fir') {
    throw new ConfigError(
      `${path}.kind`,
      `must be "coastline", "river" or "fir" (got ${kind})`,
    )
  }

  const derivation = str(o['derivation'], `${path}.derivation`)
  if (derivation !== 'survey' && derivation !== 'aip') {
    throw new ConfigError(`${path}.derivation`, `must be survey or aip (got ${derivation})`)
  }

  const paths = arr(o['paths'], `${path}.paths`).map((line, i) => {
    const pts = arr(line, `${path}.paths[${i}]`)
    if (pts.length < 2) {
      throw new ConfigError(`${path}.paths[${i}]`, 'must have at least 2 points')
    }

    const widthsM: number[] = []
    const pointsNM = pts.map((v, j) => {
      const where = `${path}.paths[${i}][${j}]`
      const w = obj(v, where)['w']
      // All or nothing: a partial width profile would silently draw part of
      // a river at true width and the rest as a hairline.
      if (w !== undefined) {
        const metres = num(w, `${where}.w`)
        if (metres <= 0) throw new ConfigError(`${where}.w`, 'must be positive')
        widthsM.push(metres)
      }
      return projection.toWorld(latLon(v, where))
    })

    if (widthsM.length !== 0 && widthsM.length !== pointsNM.length) {
      throw new ConfigError(
        `${path}.paths[${i}]`,
        'must give a width for every point or for none',
      )
    }

    return geoPath(
      pointsNM,
      widthsM.length === 0 ? null : widthsM.map((m) => m / M_PER_NM),
    )
  })

  return {
    id: str(o['id'], `${path}.id`),
    label: str(o['label'], `${path}.label`),
    kind,
    derivation,
    source: str(o['source'], `${path}.source`),
    paths,
  }
}

/**
 * The union of every drawn path's bounding box: how far the map reaches.
 *
 * Built from the per-path boxes the renderer already culls on, so it costs
 * nothing and cannot disagree with what is actually drawn.
 */
function boundsOfGeography(features: readonly GeographyFeature[]): BoundsNM | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const f of features) {
    for (const p of f.paths) {
      if (p.minNM.x < minX) minX = p.minNM.x
      if (p.minNM.y < minY) minY = p.minNM.y
      if (p.maxNM.x > maxX) maxX = p.maxNM.x
      if (p.maxNM.y > maxY) maxY = p.maxNM.y
    }
  }
  if (!Number.isFinite(minX)) return null
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } }
}

/** Wraps a projected polyline with the bounding box the renderer culls on. */
function geoPath(
  pointsNM: readonly Vec2NM[],
  widthsNM: readonly number[] | null,
): GeoPath {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pointsNM) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return {
    pointsNM,
    minNM: { x: minX, y: minY },
    maxNM: { x: maxX, y: maxY },
    widthsNM,
  }
}

function parseDerivation(raw: unknown, path: string): Derivation {
  if (raw === undefined) return 'approx'
  const s = str(raw, path)
  if (s !== 'aip' && s !== 'rule' && s !== 'approx') {
    throw new ConfigError(path, `must be aip, rule or approx (got ${s})`)
  }
  return s
}

function parseVerticalSource(raw: unknown, path: string): VerticalSource {
  if (raw === undefined) return 'file'
  const s = str(raw, path)
  if (s !== 'file' && s !== 'rule' && s !== 'assumed') {
    throw new ConfigError(path, `must be file, rule or assumed (got ${s})`)
  }
  return s
}

function parseAircraftType(raw: unknown, path: string): AircraftType {
  const o = obj(raw, path)
  return {
    type: str(o['type'], `${path}.type`),
    wake: wake(o['wake'], `${path}.wake`),
    cruiseKts: num(o['cruiseKts'], `${path}.cruiseKts`),
    approachKts: num(o['approachKts'], `${path}.approachKts`),
    weight: o['weight'] === undefined ? 1 : num(o['weight'], `${path}.weight`),
  }
}

/* -------------------------------------------------------------- geometry */

/**
 * A rate-one turn: 3 degrees a second, which is 180 degrees in a minute.
 *
 * The same figure `sim/autopilot.ts` flies at. It is stated here rather than
 * imported from there because the drawn pattern is display geometry and must
 * not make the data layer depend on the simulation.
 */
export const STANDARD_TURN_DEG_PER_SEC = 3

export interface HoldGeometry {
  /** Speed the pattern is drawn for. Leg length and radius both scale. */
  readonly speedKts: number
  readonly turnDegPerSec?: number
  /** Points used for each 180 degree turn. */
  readonly arcSteps?: number
}

/**
 * The racetrack for a holding pattern, as a closed ring of world-space
 * points.
 *
 * A hold is two straight legs joined by two half-circles. The fix is at the
 * **downstream end of the inbound leg** -- that is the point the aircraft
 * crosses before turning outbound, which is why the fix symbol sits at one
 * end of the pattern rather than in the middle of it.
 *
 * Both dimensions come out of the speed: the legs are `legMins` of flying,
 * and the turn radius is what a rate-one turn gives at that speed. At 220 kt
 * and a one-minute leg that is a 3.7 NM leg and a 1.2 NM radius, so the
 * whole pattern is about 3.7 by 2.3 NM -- which is why it is a thin sliver
 * on a 40 NM scope and not the fat oval charts draw.
 *
 * The turns are generated as short chords rather than canvas arcs so that
 * the whole pattern is one polyline in world space: it can then be measured
 * in a test, and the renderer needs no knowledge of canvas angle
 * conventions or of which way the y axis points.
 */
export function holdRacetrack(
  fixNM: Vec2NM,
  hold: HoldPattern,
  geometry: HoldGeometry,
): readonly Vec2NM[] {
  const turnRate = geometry.turnDegPerSec ?? STANDARD_TURN_DEG_PER_SEC
  const steps = Math.max(2, geometry.arcSteps ?? 12)

  const legNM = (geometry.speedKts * hold.legMins) / 60
  // Distance per second over radians per second.
  const radiusNM = geometry.speedKts / 3600 / degToRad(turnRate)

  const inbound = hold.inboundTrue
  // Which side the pattern lies on, and which way the arcs sweep.
  const side = hold.turns === 'right' ? 90 : -90

  // The inbound leg, ending at the fix.
  const legStart = advance(fixNM, inbound + 180, legNM)
  // First turn: at the fix, through 180 degrees onto the outbound leg.
  const firstCentre = advance(fixNM, inbound + side, radiusNM)
  const outboundStart = advance(fixNM, inbound + side, radiusNM * 2)
  const outboundEnd = advance(outboundStart, inbound + 180, legNM)
  // Second turn: at the far end, back onto the inbound leg.
  const secondCentre = advance(outboundEnd, inbound + 180 + side, radiusNM)

  return [
    legStart,
    fixNM,
    ...arcPoints(firstCentre, fixNM, side * 2, steps),
    outboundEnd,
    // The last point of this arc is legStart again, so it is dropped: the
    // ring is closed by the renderer rather than by a duplicate point.
    ...arcPoints(secondCentre, outboundEnd, side * 2, steps).slice(0, -1),
  ]
}

/**
 * Points along a turn, excluding where it started and including where it
 * ends. A positive sweep is clockwise, which for a compass bearing from the
 * centre of the turn is the direction a right turn goes.
 */
function arcPoints(
  centre: Vec2NM,
  from: Vec2NM,
  sweepDeg: number,
  steps: number,
): readonly Vec2NM[] {
  const radius = distanceNM(centre, from)
  const start = bearingDeg(centre, from)
  const out: Vec2NM[] = []
  for (let k = 1; k <= steps; k += 1) {
    out.push(advance(centre, start + (sweepDeg * k) / steps, radius))
  }
  return out
}

/**
 * A point on the extended centreline, `distNM` before the threshold on the
 * approach side. Distance 0 is the threshold itself.
 */
/**
 * The furthest anything exists from the field: the ring arrivals are
 * released on, plus a little. Beyond it there is nothing to see and nothing
 * to control, so the world lets go of it.
 */
export function outerLimitNM(airport: Airport): number {
  return reachNM(airport.controlZone, { x: 0, y: 0 }) + airport.traffic.entryDistanceNM + 5
}

/** Within this, two positions are the same point on the boundary. */
const RING_TOLERANCE_NM = 0.05

/** Controlled airspace. Class F and G are not the controller's to own. */
const CONTROLLED_CLASSES = new Set(['A', 'B', 'C', 'D', 'E'])

/**
 * The area of responsibility, derived from the published airspace.
 *
 * Any controlled volume that is a closed ring in the file AND encloses the
 * airport reference point is part of this field's airspace. That is a rule
 * rather than a list of names: at Heathrow it picks the London CTR from the
 * surface to 2,500 ft and London TMA 1 from there to FL195, and it would
 * pick up a third piece the day the sector file gained one, without anybody
 * remembering to add it.
 *
 * Volumes that merely sit nearby are excluded by the same rule, which is
 * why Gatwick's CTR and the seven Farnborough CTAs -- all closed rings, all
 * controlled -- are not in it.
 */
/*
   A nominal racetrack, for deciding which way a derived hold should face.
   Measured off the flight model at holding speed: a one-minute leg is about
   four miles and a rate-one reversal about two and a half wide. It does not
   have to be exact -- it is deciding between orientations, not drawing
   anything.                                                             */
const NOMINAL_LEG_NM = 4.2
const NOMINAL_WIDTH_NM = 2.6
/**
 * How far to the wrong side of the inbound track joining the pattern takes
 * an aeroplane. Measured off the flight model rather than guessed.
 */
const ENTRY_SWING_NM = 2
/** Candidate inbound tracks, in degrees. Five is finer than the question. */
const ORIENTATION_STEP_DEG = 5

/** Whether a pattern on this inbound track stays inside the airspace. */
function patternFits(
  posNM: Vec2NM,
  inboundTrue: number,
  turns: TurnDirection,
  zone: ControlZone,
): boolean {
  const outbound = normalizeHeading(inboundTrue + 180)
  const across = normalizeHeading(inboundTrue + (turns === 'right' ? 90 : -90))
  for (const [along, side] of patternSamples()) {
    const at = advance(advance(posNM, outbound, along), across, side)
    if (!isWithinFootprint(zone, at)) return false
  }
  return true
}

/**
 * Points on the flown pattern, as offsets from the fix: along the outbound
 * track, and across it towards the turn.
 *
 * A racetrack is not a rectangle and this used to sample one -- along from
 * the fix outwards, across on the turn side only. Everything an aeroplane
 * does outside that box went unchecked, so orientations whose flown path
 * left the airspace passed the test. At Bovingdon the worst of it was half a
 * mile beyond the fix and nearly two miles to the wrong side, both of them
 * places the old sample set never looked.
 *
 * So the shape sampled is the one that is actually flown: the two legs, the
 * half-width bulge of each reversal past the end it turns at, and the swing
 * to the far side that joining the pattern costs. Deliberately not a
 * bounding box round all of that -- the corners of one are places no
 * aeroplane ever reaches, and rejecting orientations for them cost Lambourne
 * a perfectly good hold.
 */
function patternSamples(): readonly (readonly [number, number])[] {
  const L = NOMINAL_LEG_NM
  const W = NOMINAL_WIDTH_NM
  const turn = W / 2

  const samples: (readonly [number, number])[] = []
  // The rectangle between the two legs.
  for (const along of [0, L / 2, L]) {
    for (const side of [0, W / 2, W]) samples.push([along, side])
  }
  // The reversals, which bulge a turn radius past the end they happen at.
  samples.push([-turn, turn], [L + turn, turn])
  // And the swing to the far side on the way in, which happens at the fix.
  samples.push([0, -ENTRY_SWING_NM], [-turn / 2, -ENTRY_SWING_NM])
  return samples
}

/**
 * Turns a derived hold to face a way that keeps its pattern in the airspace.
 *
 * Published inbound tracks are not in the open dataset, so the default is
 * the leg that points at the field. At three of Heathrow's four stacks that
 * is fine. At Bovingdon it is not: the fix sits under two miles from the
 * edge of the TMA, so a pattern laid radially outward spends more than half
 * of every circuit outside controlled airspace -- and an aircraft holding
 * there would be lost for nothing.
 *
 * So a derived leg is refitted: of the orientations whose pattern fits, take
 * the one nearest the field. Nothing published is being overridden -- an
 * explicit `inboundTrue` in the config still wins outright -- and no
 * geometry is invented. It replaces one approximation with a better one, and
 * the result is closer to the real thing: Bovingdon's actual hold is aligned
 * along the TMA rather than pointed at Heathrow, for exactly this reason.
 */
function fitHoldToAirspace(navaid: Navaid, zone: ControlZone): Navaid {
  const hold = navaid.hold
  if (hold === null || !hold.inboundIsDerived || zone.length === 0) return navaid
  if (patternFits(navaid.posNM, hold.inboundTrue, hold.turns, zone)) return navaid

  const toField = bearingDeg(navaid.posNM, { x: 0, y: 0 })
  let best: number | null = null
  for (let deg = 0; deg < 360; deg += ORIENTATION_STEP_DEG) {
    if (!patternFits(navaid.posNM, deg, hold.turns, zone)) continue
    if (best === null || Math.abs(angleDelta(deg, toField)) < Math.abs(angleDelta(best, toField))) {
      best = deg
    }
  }
  // Nothing fits: keep pointing at the field and let it protrude. Better a
  // hold in the wrong place than a hold facing an arbitrary direction.
  if (best === null) return navaid

  return { ...navaid, hold: { ...hold, inboundTrue: best } }
}

function deriveControlZone(volumes: readonly AirspaceVolume[]): ControlZone {
  const zone: ControlVolume[] = []

  for (const volume of volumes) {
    if (!CONTROLLED_CLASSES.has(volume.airspaceClass)) continue

    const rings =
      volume.shape.kind === 'polygon'
        ? [volume.shape.verticesNM]
        : volume.shape.kind === 'lines'
          ? volume.shape.pathsNM
          : []

    for (const ring of rings) {
      const first = ring[0]
      const last = ring[ring.length - 1]
      if (first === undefined || last === undefined || ring.length < 4) continue
      if (distanceNM(first, last) > RING_TOLERANCE_NM) continue
      // The reference point is the field, and world space is anchored on it.
      if (!inPolygon(ring, { x: 0, y: 0 })) continue
      zone.push({
        polygon: ring,
        floorFt: volume.floorFt,
        ceilingFt: volume.ceilingFt,
        label: volume.label,
      })
    }
  }

  return zone
}

export function centrelinePoint(runway: Runway, distNM: number): Vec2NM {
  return advance(runway.thresholdNM, runway.bearingTrue + 180, distNM)
}

/**
 * Glideslope altitude in feet AMSL at a given distance before the
 * threshold, using a straight-line approximation of the glide path.
 */
export function glideslopeAltFt(runway: Runway, distNM: number): number {
  return runway.thresholdElevationFt + glidepathRiseFt(runway.ils.glideslopeDeg, distNM)
}

/**
 * Display magnification for the painted runway strip at a given zoom.
 *
 * Runways are about two miles long in a forty mile sector, so at low zoom
 * they collapse to a handful of pixels. This scales the painted strip up,
 * fading linearly back to true scale as the scope zooms in, so close-in
 * work is never looking at a distorted picture. Applied FROM the threshold,
 * so the threshold and everything derived from it stay exactly put.
 */
export function runwayScaleAt(render: RenderSettings, pxPerNM: number): number {
  const k = render.runwayExaggeration
  const cutoff = render.exaggerationCutoffPxPerNM
  if (k <= 1 || cutoff <= 0) return 1
  if (pxPerNM >= cutoff) return 1
  return k + (1 - k) * (pxPerNM / cutoff)
}
