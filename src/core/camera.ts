import type { Vec2NM } from './geo'

/**
 * The world -> screen transform: the only place in the codebase that knows
 * about pixels. Everything upstream works in nautical miles with +y north;
 * the camera is where y flips to screen-down.
 *
 * The camera deals exclusively in CSS pixels. Device-pixel-ratio scaling is
 * applied once as a canvas context transform by the caller, so nothing here
 * has to think about it.
 *
 * See ARCHITECTURE.md section 2.
 */

/** A point in CSS pixels, relative to the canvas top-left. */
export interface Vec2Px {
  readonly x: number
  readonly y: number
}

/** Zoom limits, expressed as the scope's radius in NM. */
export const MIN_RANGE_NM = 2
export const MAX_RANGE_NM = 80

export class Camera {
  /** World-space point displayed at the centre of the viewport. */
  private centreNM: Vec2NM

  /**
   * Scope radius in NM: the distance from the centre of the viewport to the
   * nearer edge. This, rather than a pixel scale, is the primary state --
   * so resizing the window preserves the range the controller selected
   * instead of silently rescaling the picture.
   */
  private range: number

  private widthPx = 1
  private heightPx = 1

  private readonly minRange: number
  private readonly maxRange: number

  /**
   * The zoom ceiling is a constructor argument rather than a constant,
   * because how far out is useful depends on the size of the sector being
   * worked. Callers should derive it from the area of responsibility;
   * MAX_RANGE_NM is only a fallback.
   */
  constructor(
    centreNM: Vec2NM = { x: 0, y: 0 },
    rangeNM = 30,
    limits: { minNM?: number; maxNM?: number } = {},
  ) {
    this.minRange = Math.max(0.1, limits.minNM ?? MIN_RANGE_NM)
    this.maxRange = Math.max(this.minRange, limits.maxNM ?? MAX_RANGE_NM)
    this.centreNM = centreNM
    this.range = this.clamp(rangeNM)
  }

  get minRangeNM(): number {
    return this.minRange
  }

  get maxRangeNM(): number {
    return this.maxRange
  }

  private clamp(rangeNM: number): number {
    if (!Number.isFinite(rangeNM)) return this.minRange
    return Math.min(this.maxRange, Math.max(this.minRange, rangeNM))
  }

  get centre(): Vec2NM {
    return this.centreNM
  }

  get rangeNM(): number {
    return this.range
  }

  get width(): number {
    return this.widthPx
  }

  get height(): number {
    return this.heightPx
  }

  /** Pixels per nautical mile, derived from the viewport and the range. */
  get pxPerNM(): number {
    return Math.min(this.widthPx, this.heightPx) / 2 / this.range
  }

  /** Call on mount and on every resize, in CSS pixels. */
  setViewport(widthPx: number, heightPx: number): void {
    this.widthPx = Math.max(1, widthPx)
    this.heightPx = Math.max(1, heightPx)
  }

  setRangeNM(rangeNM: number): void {
    this.range = this.clamp(rangeNM)
  }

  setCentre(centreNM: Vec2NM): void {
    this.centreNM = centreNM
  }

  worldToScreen(p: Vec2NM): Vec2Px {
    const s = this.pxPerNM
    return {
      x: this.widthPx / 2 + (p.x - this.centreNM.x) * s,
      // Negated: world y is north, screen y is down.
      y: this.heightPx / 2 - (p.y - this.centreNM.y) * s,
    }
  }

  screenToWorld(p: Vec2Px): Vec2NM {
    const s = this.pxPerNM
    return {
      x: this.centreNM.x + (p.x - this.widthPx / 2) / s,
      y: this.centreNM.y - (p.y - this.heightPx / 2) / s,
    }
  }

  /** Scalar conversion, for radii and line lengths. */
  nmToPx(nm: number): number {
    return nm * this.pxPerNM
  }

  pxToNM(px: number): number {
    return px / this.pxPerNM
  }

  /** Drags the view by a screen-space delta. */
  panByPx(dxPx: number, dyPx: number): void {
    const s = this.pxPerNM
    this.centreNM = {
      x: this.centreNM.x - dxPx / s,
      y: this.centreNM.y + dyPx / s,
    }
  }

  /**
   * Zooms about a fixed screen point, so the world position under the
   * cursor stays under the cursor. `factor` above 1 zooms in.
   */
  zoomAt(anchor: Vec2Px, factor: number): void {
    const before = this.screenToWorld(anchor)
    this.range = this.clamp(this.range / factor)
    const s = this.pxPerNM

    // Solve worldToScreen(before) === anchor for the new centre.
    this.centreNM = {
      x: before.x - (anchor.x - this.widthPx / 2) / s,
      y: before.y + (anchor.y - this.heightPx / 2) / s,
    }
  }

  /**
   * Half-diagonal of the viewport in NM. Anything further than this from
   * the centre cannot be visible, which is the cheap broad-phase cull.
   */
  visibleRadiusNM(): number {
    return Math.hypot(this.widthPx, this.heightPx) / 2 / this.pxPerNM
  }

  /** Fits a set of world points into the viewport, with a margin factor. */
  fitPoints(points: readonly Vec2NM[], margin = 1.15): void {
    if (points.length === 0) return

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of points) {
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }

    this.centreNM = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }

    // Range is the radius to the nearer edge, so compare half-extents
    // against the aspect-limited axis.
    const halfW = (maxX - minX) / 2
    const halfH = (maxY - minY) / 2
    const aspect = this.widthPx / this.heightPx
    const needed = aspect >= 1 ? Math.max(halfH, halfW / aspect) : Math.max(halfW, halfH * aspect)

    this.setRangeNM(Math.max(needed * margin, this.minRange))
  }
}
