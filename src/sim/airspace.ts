import { advance, distanceNM, type Vec2NM } from '../core/geo'

/**
 * The area of responsibility, as actual controlled airspace.
 *
 * It used to be a forty mile circle, which is easy to test against and is
 * not what any controller works. This is the published thing: at Heathrow,
 * the London CTR from the surface to 2,500 ft and London TMA 1 from 2,500
 * up to FL195, both closed rings straight out of the sector file.
 *
 * So the test is three-dimensional, and that is the point rather than an
 * accident of the data. An aircraft is the controller's when it is inside
 * one of these volumes laterally AND between its floor and its ceiling.
 * Below the base of the TMA and outside the CTR there is no controlled
 * airspace at all, which is exactly the shape of the real thing.
 *
 * Note what is NOT here: nothing loads, chooses or projects these. A volume
 * arrives already in world space with its limits attached, in the same way
 * a hold or an approach clearance does, so the flight model still knows
 * nothing about the airport it is flying at.
 */

export interface ControlVolume {
  /** A closed ring in world space. The last point need not repeat the first. */
  readonly polygon: readonly Vec2NM[]
  readonly floorFt: number
  readonly ceilingFt: number
  /** For saying which piece of airspace something is in. */
  readonly label: string
}

export type ControlZone = readonly ControlVolume[]

/**
 * Whether a point is inside a closed ring.
 *
 * Ray casting, counting crossings of the horizontal line through the point.
 * Chosen over a winding number because these rings are simple -- published
 * airspace does not self-intersect -- and because it needs no trigonometry
 * and no tolerance.
 */
export function inPolygon(polygon: readonly Vec2NM[], at: Vec2NM): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i] as Vec2NM
    const b = polygon[j] as Vec2NM
    const straddles = a.y > at.y !== b.y > at.y
    if (!straddles) continue
    const crossesLeft = at.x < ((b.x - a.x) * (at.y - a.y)) / (b.y - a.y) + a.x
    if (crossesLeft) inside = !inside
  }
  return inside
}

interface Bounds {
  readonly minX: number
  readonly maxX: number
  readonly minY: number
  readonly maxY: number
}

/**
 * Bounding boxes, worked out once per volume and remembered.
 *
 * This is asked of every aircraft on every tick of a twenty hertz
 * simulation, and a ray cast around a forty-two sided ring is not free. The
 * box rejects the far-away cases for four comparisons. A WeakMap rather
 * than a field on the type, so the volumes stay plain data that anything
 * can construct -- a test included -- without knowing this exists.
 */
const bounds = new WeakMap<ControlVolume, Bounds>()

function boundsOf(volume: ControlVolume): Bounds {
  const known = bounds.get(volume)
  if (known !== undefined) return known

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const p of volume.polygon) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }

  const box = { minX, maxX, minY, maxY }
  bounds.set(volume, box)
  return box
}

/** Inside this volume, laterally and vertically. */
export function inVolume(volume: ControlVolume, at: Vec2NM, altFt: number): boolean {
  // Cheapest first: the vertical limits, then the bounding box, and only
  // then the ring itself.
  if (altFt < volume.floorFt || altFt > volume.ceilingFt) return false
  return inFootprint(volume, at)
}

/** The lateral half of the test, box first. */
function inFootprint(volume: ControlVolume, at: Vec2NM): boolean {
  const box = boundsOf(volume)
  if (at.x < box.minX || at.x > box.maxX || at.y < box.minY || at.y > box.maxY) return false
  return inPolygon(volume.polygon, at)
}

/** Inside the area of responsibility: somewhere in it, at this level. */
export function isControlled(zone: ControlZone, at: Vec2NM, altFt: number): boolean {
  return zone.some((v) => inVolume(v, at, altFt))
}

/**
 * Inside the footprint of the airspace, whatever the level.
 *
 * The lateral question on its own, for the things that are only lateral:
 * where the boundary is drawn, and how far out an arrival has to appear.
 */
export function isWithinFootprint(zone: ControlZone, at: Vec2NM): boolean {
  return zone.some((v) => inFootprint(v, at))
}

/**
 * The outermost rings: the footprint of the airspace as a set of outlines.
 *
 * A volume whose every vertex lies inside another is dropped, because it
 * adds nothing to the footprint. At Heathrow that leaves one ring -- the
 * CTR sits entirely inside the TMA laterally -- which is what lets the
 * boundary be drawn, and the rest of the map masked off, in a single path.
 */
export function footprint(zone: ControlZone): readonly (readonly Vec2NM[])[] {
  return zone
    .filter((v, i) =>
      !zone.some(
        (other, j) => j !== i && v.polygon.every((p) => inPolygon(other.polygon, p)),
      ),
    )
    .map((v) => v.polygon)
}

/** The furthest any part of the airspace reaches from a point. */
export function reachNM(zone: ControlZone, from: Vec2NM): number {
  let furthest = 0
  for (const v of zone) {
    for (const p of v.polygon) furthest = Math.max(furthest, distanceNM(from, p))
  }
  return furthest
}

/**
 * How far out along a bearing the airspace ends, from a point inside it.
 *
 * Walked rather than solved: the rings have up to forty-two sides and can
 * be re-entered along a line, so what is wanted is the LAST crossing and
 * not the first. Stepping out and remembering the last point that was still
 * inside gives that, and a tenth of a mile is finer than any use of it.
 */
export function exitRangeNM(zone: ControlZone, from: Vec2NM, courseDeg: number): number {
  const STEP_NM = 0.1
  const limit = reachNM(zone, from) + STEP_NM
  let last = 0
  for (let r = 0; r <= limit; r += STEP_NM) {
    if (isWithinFootprint(zone, advance(from, courseDeg, r))) last = r
  }
  return last
}

/** Which piece of airspace a point is in, for a readout. Null if none. */
export function volumeAt(zone: ControlZone, at: Vec2NM, altFt: number): ControlVolume | null {
  return zone.find((v) => inVolume(v, at, altFt)) ?? null
}
