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

export type WakeCategory = 'L' | 'M' | 'H' | 'J'
export type TurnDirection = 'left' | 'right'

export interface IlsConfig {
  readonly available: boolean
  readonly glideslopeDeg: number
  readonly fafDistNM: number
  readonly minInterceptDeg: number
}

export interface Runway {
  readonly id: string
  /** Landing threshold, in world space. */
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

export interface Fix {
  readonly name: string
  readonly fullName: string
  readonly posNM: Vec2NM
  readonly latLon: LatLon
  readonly navaid: { readonly type: string; readonly freqMHz: number } | null
  readonly hold: HoldPattern | null
  /** Distance from the airport reference point, in NM. */
  readonly distanceFromArpNM: number
  /** Bearing from the airport reference point, degrees true. */
  readonly bearingFromArpTrue: number
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
  readonly runways: readonly Runway[]
  readonly fixes: readonly Fix[]
  readonly aircraftTypes: readonly AircraftType[]
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

function assertUnique(values: readonly string[], path: string): void {
  const seen = new Set<string>()
  for (const v of values) {
    if (seen.has(v)) throw new ConfigError(path, `contains duplicate "${v}"`)
    seen.add(v)
  }
}

/* ------------------------------------------------------------------ loader */

export function loadAirport(raw: unknown): Airport {
  const root = obj(raw, 'root')

  const icao = str(root['icao'], 'icao')
  const name = str(root['name'], 'name')
  const arp = latLon(root['arp'], 'arp')

  // World space is anchored on the airport reference point, so the ARP is
  // the origin and every other position is relative to it.
  const projection = makeProjection(arp)

  const sector = parseSector(root['sector'])
  const runways = arr(root['runways'], 'runways').map((r, i) =>
    parseRunway(r, `runways[${i}]`, projection),
  )
  const fixes = arr(root['fixes'], 'fixes').map((f, i) =>
    parseFix(f, `fixes[${i}]`, projection),
  )
  const aircraftTypes = arr(root['aircraftTypes'], 'aircraftTypes').map((t, i) =>
    parseAircraftType(t, `aircraftTypes[${i}]`),
  )

  assertUnique(runways.map((r) => r.id), 'runways[].id')
  assertUnique(fixes.map((f) => f.name), 'fixes[].name')
  assertUnique(aircraftTypes.map((t) => t.type), 'aircraftTypes[].type')

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
    ...fixes.map((f) => f.posNM),
  ]

  return {
    icao,
    name,
    arp,
    elevationFt: num(root['elevationFt'], 'elevationFt'),
    magVarDeg: num(root['magVarDeg'], 'magVarDeg'),
    projection,
    sector,
    runways,
    fixes,
    aircraftTypes,
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

function parseFix(raw: unknown, path: string, projection: Projection): Fix {
  const o = obj(raw, path)
  const location: LatLon = {
    lat: num(o['lat'], `${path}.lat`),
    lon: num(o['lon'], `${path}.lon`),
  }
  const posNM = projection.toWorld(location)
  const origin: Vec2NM = { x: 0, y: 0 }

  let navaid: Fix['navaid'] = null
  if (o['navaid'] !== undefined) {
    const n = obj(o['navaid'], `${path}.navaid`)
    navaid = {
      type: str(n['type'], `${path}.navaid.type`),
      freqMHz: num(n['freqMHz'], `${path}.navaid.freqMHz`),
    }
  }

  let hold: HoldPattern | null = null
  if (o['hold'] !== undefined) {
    const h = obj(o['hold'], `${path}.hold`)
    const override = h['inboundTrue']
    // Published inbound tracks are not in the open dataset, so default to
    // the leg that points at the airport. Real STAR data overrides this.
    const derived = override === undefined
    hold = {
      turns: turnDirection(h['turns'], `${path}.hold.turns`),
      legMins: num(h['legMins'], `${path}.hold.legMins`),
      inboundTrue: derived
        ? bearingDeg(posNM, origin)
        : normalizeHeading(num(override, `${path}.hold.inboundTrue`)),
      inboundIsDerived: derived,
    }
  }

  return {
    name: str(o['name'], `${path}.name`),
    fullName: str(o['fullName'], `${path}.fullName`),
    posNM,
    latLon: location,
    navaid,
    hold,
    distanceFromArpNM: distanceNM(origin, posNM),
    bearingFromArpTrue: bearingDeg(origin, posNM),
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
