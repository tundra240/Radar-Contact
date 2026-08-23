import { distanceNM, type Vec2NM } from '../core/geo'
import type { Aircraft } from './types'

/**
 * Ground you must stay above, and ground you must stay high over.
 *
 * Two rules that look the same on a map and are not the same thing at all.
 *
 * Terrain is a fact: the Maritime Alps behind Nice are nine thousand feet
 * whatever anybody thinks about it, and an aircraft vectored into them at
 * four thousand has hit a mountain. A minimum safe altitude is what keeps
 * you off it.
 *
 * A noise abatement zone is an agreement: the airspace over a town where
 * traffic is not to be vectored low, because people live there. Breaking it
 * costs the operator money rather than the aeroplane, so it is scored
 * rather than fatal.
 *
 * They share a shape and nothing else, which is why the shape is the only
 * thing they share here.
 */

/** Where a zone is. Circles for a hill, polygons for a coastline. */
export type ZoneShape =
  | { readonly kind: 'circle'; readonly centreNM: Vec2NM; readonly radiusNM: number }
  | { readonly kind: 'polygon'; readonly verticesNM: readonly Vec2NM[] }

export interface TerrainZone {
  readonly id: string
  readonly label: string
  readonly shape: ZoneShape
  /**
   * The lowest an aircraft may be over this ground.
   *
   * Not the height of the hill: the height of the hill plus the margin a
   * controller is required to keep, which is the number that actually gets
   * used and the only one worth writing down twice.
   */
  readonly minimumSafeFt: number
  /** How high the ground itself gets, for the label on the scope. */
  readonly peakFt: number
}

export interface NoiseZone {
  readonly id: string
  readonly label: string
  readonly shape: ZoneShape
  /** Below this over this ground is a noise violation. */
  readonly floorFt: number
  /** What one costs. Charged once per aircraft, not once per tick. */
  readonly penaltyPoints: number
}

/** Whether a point is inside a zone's footprint, ignoring height. */
export function inShape(shape: ZoneShape, at: Vec2NM): boolean {
  if (shape.kind === 'circle') return distanceNM(at, shape.centreNM) <= shape.radiusNM
  return inPolygon(shape.verticesNM, at)
}

/**
 * Ray casting, the same rule sim/airspace.ts uses for a control volume.
 *
 * Repeated rather than shared because the two take different shapes -- that
 * one has already flattened everything to a ring, and this one has not --
 * and a parameter to bridge them would be more indirection than the six
 * lines are worth.
 */
function inPolygon(ring: readonly Vec2NM[], at: Vec2NM): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i]
    const b = ring[j]
    if (a === undefined || b === undefined) continue
    const crosses = a.y > at.y !== b.y > at.y
    if (!crosses) continue
    const x = ((b.x - a.x) * (at.y - a.y)) / (b.y - a.y) + a.x
    if (at.x < x) inside = !inside
  }
  return inside
}

/* ------------------------------------------------------------- terrain */

/**
 * The terrain an aircraft is over and below the safe height for, or null.
 *
 * Checked against where the aircraft IS rather than where it has been
 * cleared to: an aircraft descending through a minimum is not yet below it,
 * and warning on the clearance would cry wolf every time somebody set up a
 * descent that finishes clear of the hill.
 */
export function terrainBelow(
  terrain: readonly TerrainZone[],
  a: Aircraft,
): TerrainZone | null {
  for (const zone of terrain) {
    if (a.altFt >= zone.minimumSafeFt) continue
    if (inShape(zone.shape, a.pos)) return zone
  }
  return null
}

/** Everyone currently below a minimum safe altitude. */
export function belowMinimumSafe(
  terrain: readonly TerrainZone[],
  traffic: readonly Aircraft[],
): ReadonlySet<string> {
  const out = new Set<string>()
  if (terrain.length === 0) return out
  for (const a of traffic) {
    // Landed traffic is on the runway, which is by definition survivable
    // ground, and traffic that is not yours is not yours to descend.
    if (a.navMode === 'LANDED' || !a.entered) continue
    if (terrainBelow(terrain, a) !== null) out.add(a.callsign)
  }
  return out
}

/**
 * The lowest an aircraft at this position may safely be.
 *
 * The highest minimum of every zone it is over, or null where there is no
 * terrain under it at all. For a readout rather than for the alerting,
 * which asks the question the other way round.
 */
export function minimumSafeAt(
  terrain: readonly TerrainZone[],
  at: Vec2NM,
): TerrainZone | null {
  let worst: TerrainZone | null = null
  for (const zone of terrain) {
    if (!inShape(zone.shape, at)) continue
    if (worst === null || zone.minimumSafeFt > worst.minimumSafeFt) worst = zone
  }
  return worst
}

/* --------------------------------------------------------------- noise */

/** The noise zone an aircraft is infringing, or null. */
export function noiseBelow(noise: readonly NoiseZone[], a: Aircraft): NoiseZone | null {
  for (const zone of noise) {
    if (a.altFt >= zone.floorFt) continue
    if (inShape(zone.shape, a.pos)) return zone
  }
  return null
}

/**
 * Everyone currently infringing a noise zone.
 *
 * Aircraft on an approach are excluded. A noise abatement floor is a rule
 * about where you may vector traffic, not a rule that forbids landing: an
 * aeroplane on the glidepath is below every floor near the field by the
 * time it gets there, and charging for that would charge for the whole
 * point of the exercise.
 */
export function infringingNoise(
  noise: readonly NoiseZone[],
  traffic: readonly Aircraft[],
): ReadonlySet<string> {
  const out = new Set<string>()
  if (noise.length === 0) return out
  for (const a of traffic) {
    if (!a.entered) continue
    if (a.navMode === 'LANDED' || onFinal(a.navMode)) continue
    if (noiseBelow(noise, a) !== null) out.add(a.callsign)
  }
  return out
}

/** Established on an approach, and therefore excused the noise floor. */
function onFinal(navMode: Aircraft['navMode']): boolean {
  return navMode === 'LOC_CAPTURED' || navMode === 'GS_TRACKING'
}
