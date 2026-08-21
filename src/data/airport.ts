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

export interface Navaid {
  readonly name: string
  readonly fullName: string
  readonly posNM: Vec2NM
  readonly latLon: LatLon
  readonly station: { readonly type: string; readonly freqMHz: number } | null
  /** Non-null when this navaid is one of the approach holding fixes. */
  readonly hold: HoldPattern | null
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

export interface AirspaceVolume {
  readonly id: string
  readonly label: string
  readonly airspaceClass: AirspaceClass
  readonly floorFt: number
  readonly ceilingFt: number
  /** True when the drawn boundary is a stand-in for the real one. */
  readonly approximate: boolean
  readonly derivation: Derivation
  readonly shape: AirspaceShape
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
  readonly runways: readonly Runway[]
  readonly navaids: readonly Navaid[]
  readonly airports: readonly NeighbourAirport[]
  readonly airspace: readonly AirspaceVolume[]
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
    runways,
    navaids,
    airports,
    airspace,
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

  const approximate = bool(o['approximate'], `${path}.approximate`)
  const rawDeriv = o['derivation']
  let derivation: Derivation
  if (rawDeriv === undefined) {
    // Default follows the honesty flag: an approximated boundary is an
    // approximation, an exact one is assumed to come from the AIP.
    derivation = approximate ? 'approx' : 'aip'
  } else {
    const s = str(rawDeriv, `${path}.derivation`)
    if (s !== 'aip' && s !== 'rule' && s !== 'approx') {
      throw new ConfigError(`${path}.derivation`, `must be aip, rule or approx (got ${s})`)
    }
    derivation = s
  }

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
    // Not used by the shipped config, but this is the path real AIP
    // boundaries take when they replace the circular stand-ins.
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
  } else {
    throw new ConfigError(`${path}.kind`, `must be "circle" or "polygon" (got ${kind})`)
  }

  return {
    id: str(o['id'], `${path}.id`),
    label: str(o['label'], `${path}.label`),
    airspaceClass: airspaceClass(o['class'], `${path}.class`),
    floorFt,
    ceilingFt,
    approximate,
    derivation,
    shape,
  }
}

function parseAircraftType(raw: unknown, path: string): AircraftType {
  const o = obj(raw, path)
  return {
    type: str(o['type'], `${path}.type`),
    wake: wake(o['wake'], `${path}.wake`),
    cruiseKts: num(o['cruiseKts'], `${path}.cruiseKts`),
    approachKts: num(o['approachKts'], `${path}.approachKts`),
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
