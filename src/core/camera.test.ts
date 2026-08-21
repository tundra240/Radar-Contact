import { beforeEach, describe, expect, it } from 'vitest'
import { Camera, MAX_RANGE_NM, MIN_RANGE_NM } from './camera'
import type { Vec2NM } from './geo'

describe('Camera', () => {
  let cam: Camera

  beforeEach(() => {
    cam = new Camera({ x: 0, y: 0 }, 20)
    cam.setViewport(1000, 600)
  })

  it('derives pixels-per-NM from the shorter viewport axis', () => {
    // Range is the radius to the nearer edge: 600 / 2 / 20 = 15 px per NM.
    expect(cam.pxPerNM).toBeCloseTo(15, 9)
  })

  it('puts the camera centre at the viewport centre', () => {
    const s = cam.worldToScreen({ x: 0, y: 0 })
    expect(s.x).toBeCloseTo(500, 9)
    expect(s.y).toBeCloseTo(300, 9)
  })

  it('draws north up and east right', () => {
    const north = cam.worldToScreen({ x: 0, y: 10 })
    const east = cam.worldToScreen({ x: 10, y: 0 })

    // Screen y grows downward, so north of centre must be a SMALLER y.
    expect(north.y).toBeLessThan(300)
    expect(north.x).toBeCloseTo(500, 9)
    expect(east.x).toBeGreaterThan(500)
    expect(east.y).toBeCloseTo(300, 9)
  })

  it('round-trips world and screen space', () => {
    const points: Vec2NM[] = [
      { x: 0, y: 0 },
      { x: 12.5, y: -7.25 },
      { x: -19.9, y: 3.3 },
    ]
    for (const p of points) {
      const back = cam.screenToWorld(cam.worldToScreen(p))
      expect(back.x).toBeCloseTo(p.x, 9)
      expect(back.y).toBeCloseTo(p.y, 9)
    }
  })

  it('places the selected range exactly at the nearer edge', () => {
    const edge = cam.worldToScreen({ x: 0, y: cam.rangeNM })
    expect(edge.y).toBeCloseTo(0, 9)
  })

  it('preserves range across a resize rather than the pixel scale', () => {
    const before = cam.rangeNM
    cam.setViewport(400, 1200)
    expect(cam.rangeNM).toBe(before)
    // 400 is now the shorter axis, so the scale changed but the range did not.
    expect(cam.pxPerNM).toBeCloseTo(10, 9)
  })

  it('keeps the anchored world point under the cursor when zooming', () => {
    const anchor = { x: 720, y: 180 }
    const worldUnderCursor = cam.screenToWorld(anchor)

    cam.zoomAt(anchor, 2.5)

    const after = cam.worldToScreen(worldUnderCursor)
    expect(after.x).toBeCloseTo(anchor.x, 6)
    expect(after.y).toBeCloseTo(anchor.y, 6)
    expect(cam.rangeNM).toBeCloseTo(8, 9)
  })

  it('clamps range to the configured limits', () => {
    cam.setRangeNM(0.001)
    expect(cam.rangeNM).toBe(MIN_RANGE_NM)
    cam.setRangeNM(99_999)
    expect(cam.rangeNM).toBe(MAX_RANGE_NM)
    cam.setRangeNM(Number.NaN)
    expect(cam.rangeNM).toBe(MIN_RANGE_NM)
  })

  it('pans in the direction of the drag', () => {
    // Dragging the picture right moves the camera centre west.
    cam.panByPx(150, 0)
    expect(cam.centre.x).toBeCloseTo(-10, 9)
    cam.panByPx(0, 150)
    expect(cam.centre.y).toBeCloseTo(10, 9)
  })

  it('fits a set of points inside the viewport', () => {
    const pts: Vec2NM[] = [
      { x: 22.8, y: 10.5 },
      { x: 18.5, y: -8.4 },
      { x: -3.3, y: 15.3 },
      { x: 0.5, y: -9.9 },
    ]
    cam.fitPoints(pts)

    for (const p of pts) {
      const s = cam.worldToScreen(p)
      expect(s.x).toBeGreaterThanOrEqual(0)
      expect(s.x).toBeLessThanOrEqual(cam.width)
      expect(s.y).toBeGreaterThanOrEqual(0)
      expect(s.y).toBeLessThanOrEqual(cam.height)
    }
  })

  it('survives a degenerate viewport without producing NaN', () => {
    const c = new Camera({ x: 0, y: 0 }, 10)
    c.setViewport(0, 0)
    const s = c.worldToScreen({ x: 1, y: 1 })
    expect(Number.isFinite(s.x)).toBe(true)
    expect(Number.isFinite(s.y)).toBe(true)
  })
})

describe('Camera zoom limits', () => {
  it('defaults to a ceiling that is not absurdly far out', () => {
    const c = new Camera({ x: 0, y: 0 }, 30)
    c.setViewport(1000, 600)
    c.setRangeNM(9999)
    expect(c.rangeNM).toBe(MAX_RANGE_NM)
    expect(MAX_RANGE_NM).toBeLessThanOrEqual(100)
    // Still comfortably wider than a terminal area, so the ceiling is a
    // limit rather than a straitjacket.
    expect(MAX_RANGE_NM).toBeGreaterThanOrEqual(60)
  })

  it('takes a ceiling from the caller', () => {
    // main.ts derives this from the sector radius, so the useful zoom range
    // scales with the airspace being worked instead of being a constant.
    const c = new Camera({ x: 0, y: 0 }, 30, { maxNM: 80, minNM: 3 })
    c.setViewport(1000, 600)
    expect(c.maxRangeNM).toBe(80)
    expect(c.minRangeNM).toBe(3)

    c.setRangeNM(500)
    expect(c.rangeNM).toBe(80)
    c.setRangeNM(0.5)
    expect(c.rangeNM).toBe(3)
  })

  it('clamps zooming as well as setting', () => {
    const c = new Camera({ x: 0, y: 0 }, 40, { maxNM: 50 })
    c.setViewport(1000, 600)
    for (let i = 0; i < 30; i += 1) c.zoomAt({ x: 500, y: 300 }, 0.8)
    expect(c.rangeNM).toBe(50)
  })

  it('survives a ceiling below the floor', () => {
    const c = new Camera({ x: 0, y: 0 }, 10, { minNM: 20, maxNM: 5 })
    c.setViewport(1000, 600)
    expect(c.maxRangeNM).toBeGreaterThanOrEqual(c.minRangeNM)
    expect(Number.isFinite(c.rangeNM)).toBe(true)
  })
})
