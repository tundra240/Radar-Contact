/**
 * Geodesy and angle helpers.
 *
 * This module owns the boundary between GEO space (lat/lon, as published on
 * charts and stored in airport config) and WORLD space (nautical miles east
 * and north of an origin, where all physics, separation and ILS geometry
 * happen). Nothing here knows about pixels -- that is core/camera.ts.
 *
 * See ARCHITECTURE.md section 2.
 */

/** A geographic position in signed decimal degrees. */
export interface LatLon {
  readonly lat: number
  readonly lon: number
}

/**
 * A position in world space: nautical miles from the projection origin,
 * +x east and +y NORTH. Note that y points north, not down -- flipping it
 * for the screen is the camera's job, never the simulation's.
 */
export interface Vec2NM {
  readonly x: number
  readonly y: number
}

/**
 * An axis-aligned rectangle in world space, in NM. Used for the extent of
 * the drawn map and for the fence that keeps the camera inside it.
 */
export interface BoundsNM {
  readonly min: Vec2NM
  readonly max: Vec2NM
}

/**
 * One nautical mile is one minute of latitude by definition, so this is
 * exact rather than an approximation.
 */
export const NM_PER_DEG_LAT = 60

/** Mean Earth radius in nautical miles, for the haversine reference. */
const EARTH_RADIUS_NM = 3440.065

export const degToRad = (deg: number): number => (deg * Math.PI) / 180
export const radToDeg = (rad: number): number => (rad * 180) / Math.PI

/** Wraps any angle into [0, 360). */
export function normalizeHeading(deg: number): number {
  return ((deg % 360) + 360) % 360
}

/**
 * Signed shortest angular difference from `from` to `to`, in (-180, 180].
 * Positive means turn right (clockwise).
 *
 * Every turn decision in the simulation goes through this. Hand-rolled
 * wraparound arithmetic is the single most reliable source of bugs in this
 * genre -- 350 to 010 must be +20, not -340.
 */
/**
 * A heading as it is written and spoken: three digits, with due north as
 * three-six-zero rather than zero.
 *
 * Lives here rather than in whichever module happened to need it first,
 * because the scope and the tag menu both print headings and two copies
 * would eventually disagree about north.
 */
export function headingLabel(deg: number): string {
  return String(deg === 0 ? 360 : deg).padStart(3, '0')
}

export function angleDelta(from: number, to: number): number {
  const d = ((to - from) % 360 + 540) % 360 - 180
  // Normalize -180 to +180 so the range is (-180, 180] and a reciprocal
  // turn is unambiguously to the right.
  return d === -180 ? 180 : d
}

/**
 * Converts between geo space and world space about a fixed origin.
 *
 * Uses an equirectangular local tangent plane: latitude scales exactly,
 * longitude is compressed by the cosine of the MEAN of the origin and point
 * latitudes. Taking the mean rather than just the origin latitude keeps the
 * error small across a terminal area while remaining exactly invertible,
 * because the inverse recovers latitude first and can then reconstruct the
 * identical cosine term.
 */
export interface Projection {
  readonly origin: LatLon
  toWorld(p: LatLon): Vec2NM
  toLatLon(p: Vec2NM): LatLon
}

export function makeProjection(origin: LatLon): Projection {
  const { lat: lat0, lon: lon0 } = origin

  return {
    origin,

    toWorld({ lat, lon }: LatLon): Vec2NM {
      const meanLat = (lat + lat0) / 2
      return {
        x: (lon - lon0) * NM_PER_DEG_LAT * Math.cos(degToRad(meanLat)),
        y: (lat - lat0) * NM_PER_DEG_LAT,
      }
    },

    toLatLon({ x, y }: Vec2NM): LatLon {
      const lat = lat0 + y / NM_PER_DEG_LAT
      const meanLat = (lat + lat0) / 2
      return {
        lat,
        lon: lon0 + x / (NM_PER_DEG_LAT * Math.cos(degToRad(meanLat))),
      }
    },
  }
}

/** Straight-line distance between two world-space points, in NM. */
export function distanceNM(a: Vec2NM, b: Vec2NM): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/**
 * Compass bearing from `a` to `b` in world space: degrees clockwise from
 * north, in [0, 360).
 */
export function bearingDeg(a: Vec2NM, b: Vec2NM): number {
  return normalizeHeading(radToDeg(Math.atan2(b.x - a.x, b.y - a.y)))
}

/** Unit vector pointing along a compass heading. */
export function headingToUnitVector(deg: number): Vec2NM {
  const rad = degToRad(deg)
  return { x: Math.sin(rad), y: Math.cos(rad) }
}

/** Advances a world position along a heading by a distance in NM. */
export function advance(from: Vec2NM, headingDeg: number, distNM: number): Vec2NM {
  const u = headingToUnitVector(headingDeg)
  return { x: from.x + u.x * distNM, y: from.y + u.y * distNM }
}

/**
 * Great-circle distance in NM. Not used by the simulation, which works
 * entirely in the projected plane; this exists as an independent oracle so
 * the projection's distortion can be measured in tests.
 */
export function haversineNM(a: LatLon, b: LatLon): number {
  const dLat = degToRad(b.lat - a.lat)
  const dLon = degToRad(b.lon - a.lon)
  const lat1 = degToRad(a.lat)
  const lat2 = degToRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)))
}
