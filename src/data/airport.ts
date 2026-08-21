import {
  advance,
  bearingDeg,
  distanceNM,
  makeProjection,
  normalizeHeading,
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

export const FT_PER_NM = 6076.11548556
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
  readonly maxConcurrent: number
  /** A fix with traffic this close is not given another arrival. */
  readonly minFixSpacingNM: number
  /** Nor one that recently had an arrival. */
  readonly minFixSpacingSeconds: number
  readonly airlines: readonly Airline[]
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
   * Boundary line work: one or more OPEN polylines, stroked without
   * closure. This is what the VATSIM UK sector file actually contains --
   * each record is an independent boundary line, and only two of sixty
   * regions chained into a closed ring. Closing them would invent edges of
   * up to 30 NM. The trade-off is that a `lines` volume cannot answer
   * "is this aircraft inside the zone"; that needs ordered closed rings.
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
  readonly traffic: TrafficConfig
  readonly runways: readonly Runway[]
  readonly navaids: readonly Navaid[]
  readonly airports: readonly NeighbourAirport[]
  readonly airspace: readonly AirspaceVolume[]
  /** Coastline and FIR limit. Empty when the config omits the section. */
  readonly geography: readonly GeographyFeature[]
  readonly aircraftTypes: readonly AircraftType[]
  /** Navaids that carry a holding pattern, in config order. */
  readonly holdingFixes: readonly Navaid[]
  /** Runways currently accepting arrivals, in config order. */
  readonly arrivalRunways: readonly Runway[]
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
  const navaids = arr(root['navaids'], 'navaids').map((n, i) =>
    parseNavaid(n, `navaids[${i}]`, projection),
  )
  const airports = arr(root['airports'], 'airports').map((a, i) =>
    parseNeighbour(a, `airports[${i}]`, projection),
  )
  const aircraftTypes = arr(root['aircraftTypes'], 'aircraftTypes').map((t, i) =>
    parseAircraftType(t, `aircraftTypes[${i}]`),
  )
  const traffic = parseTraffic(root['traffic'], new Set(aircraftTypes.map((t) => t.type)))

  assertUnique(runways.map((r) => r.id), 'runways[].id')
  assertUnique(navaids.map((n) => n.name), 'navaids[].name')
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

  const byId = new Map(runways.map((r) => [r.id, r]))
  const arrivalRunways = sector.activeArrivalRunways.map((id) => {
    const rwy = byId.get(id)
    if (!rwy) {
      throw new ConfigError(
        'sector.activeArrivalRunways',
        `references unknown runway "${id}"`,
      )
    }
    return rwy
  })

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
    traffic,
    runways,
    navaids,
    airports,
    airspace,
    geography,
    aircraftTypes,
    holdingFixes: navaids.filter((n) => n.hold !== null),
    arrivalRunways,
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
  }
}

function parseTraffic(raw: unknown, knownTypes: ReadonlySet<string>): TrafficConfig {
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

    return {
      code,
      weight: num(ao['weight'], `${path}.weight`),
      fleet,
      numbers,
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
  return {
    runwayExaggeration: ex,
    exaggerationCutoffPxPerNM: num(
      o['exaggerationCutoffPxPerNM'],
      'render.exaggerationCutoffPxPerNM',
    ),
    neighbourRunwayMinPx: num(o['neighbourRunwayMinPx'], 'render.neighbourRunwayMinPx'),
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
 * A point on the extended centreline, `distNM` before the threshold on the
 * approach side. Distance 0 is the threshold itself.
 */
export function centrelinePoint(runway: Runway, distNM: number): Vec2NM {
  return advance(runway.thresholdNM, runway.bearingTrue + 180, distNM)
}

/**
 * Glideslope altitude in feet AMSL at a given distance before the
 * threshold, using a straight-line approximation of the glide path.
 */
export function glideslopeAltFt(runway: Runway, distNM: number): number {
  const rise = Math.tan((runway.ils.glideslopeDeg * Math.PI) / 180) * distNM * FT_PER_NM
  return runway.thresholdElevationFt + rise
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
