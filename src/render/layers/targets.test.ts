import { describe, expect, it } from 'vitest'
import { Camera } from '../../core/camera'
import type { Aircraft } from '../../sim/types'
import { palettes, setPalette, theme } from '../theme'
import { PICK_RADIUS_PX, blockBox, blockLines, drawTargets, pickTarget } from './targets'

/**
 * The target symbology, checked against a recording canvas: where the
 * marks land, what ink they are drawn in, and what drops out as the scope
 * zooms out.
 */

interface Dot {
  x: number
  y: number
  r: number
  alpha: number
  style: string
}
interface Rect {
  x: number
  y: number
  w: number
  h: number
}
interface Line {
  from: { x: number; y: number }
  to: { x: number; y: number }
  style: string
}
interface Label {
  s: string
  x: number
  y: number
  style: string
  align: string
}

function recorder(): {
  ctx: CanvasRenderingContext2D
  dots: Dot[]
  rects: Rect[]
  lines: Line[]
  labels: Label[]
  alphaAtEnd: () => number
} {
  const dots: Dot[] = []
  const rects: Rect[] = []
  const lines: Line[] = []
  const labels: Label[] = []
  let path: { x: number; y: number }[] = []
  const noop = (): void => {}
  const stub: Record<string, unknown> = {
    beginPath: () => {
      path = []
    },
    closePath: noop,
    moveTo: (x: number, y: number) => path.push({ x, y }),
    lineTo: (x: number, y: number) => path.push({ x, y }),
    rect: (x: number, y: number, w: number, h: number) => {
      rects.push({ x, y, w, h })
    },
    arc: (x: number, y: number, r: number) => {
      dots.push({
        x,
        y,
        r,
        alpha: Number(stub['globalAlpha']),
        style: String(stub['fillStyle']),
      })
    },
    stroke: () => {
      const from = path[0]
      const to = path[path.length - 1]
      if (from && to && path.length >= 2) {
        lines.push({ from, to, style: String(stub['strokeStyle']) })
      }
    },
    fill: noop,
    fillText: (s: string, x: number, y: number) => {
      labels.push({
        s,
        x,
        y,
        style: String(stub['fillStyle']),
        align: String(stub['textAlign']),
      })
    },
    fillRect: noop,
    save: noop,
    restore: noop,
    setLineDash: noop,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: 'butt',
    globalAlpha: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
  }
  return {
    ctx: stub as unknown as CanvasRenderingContext2D,
    dots,
    rects,
    lines,
    labels,
    alphaAtEnd: () => Number(stub['globalAlpha']),
  }
}

function plane(over: Partial<Aircraft> = {}): Aircraft {
  return {
    callsign: 'BAW123',
    type: 'A320',
    wake: 'M',
    pos: { x: 0, y: 0 },
    altFt: 7000,
    hdg: 90,
    gsKts: 240,
    vsFpm: 0,
    clearedHdg: 90,
    clearedAltFt: 7000,
    clearedSpdKts: 240,
    navMode: 'VECTOR',
    clearedApproach: null,
    originFix: 'LAM',
    trail: [],
    trailAt: 0,
    spawnedAt: 0,
    ...over,
  }
}

function render(traffic: readonly Aircraft[], selected: string | null = null, rangeNM = 20) {
  const cam = new Camera({ x: 0, y: 0 }, rangeNM, { maxNM: 200 })
  cam.setViewport(1000, 600)
  const rec = recorder()
  drawTargets(rec.ctx, cam, traffic, selected)
  return { ...rec, cam }
}

describe('drawTargets', () => {
  it('draws nothing at all for an empty scope', () => {
    const r = render([])
    expect(r.dots).toHaveLength(0)
    expect(r.rects).toHaveLength(0)
    expect(r.labels).toHaveLength(0)
  })

  it('marks the target where the aircraft is', () => {
    const r = render([plane({ pos: { x: 5, y: 0 } })])
    const p = r.cam.worldToScreen({ x: 5, y: 0 })
    const box = r.rects[0] as Rect
    expect(box).toBeDefined()
    // The square is centred on the position, so its centre is the target.
    expect(box.x + box.w / 2).toBeCloseTo(p.x, 6)
    expect(box.y + box.h / 2).toBeCloseTo(p.y, 6)
  })

  it('reaches one minute ahead along the heading', () => {
    // Due east at 240 knots: four miles in a minute, and east is +x.
    const r = render([plane({ hdg: 90, gsKts: 240 })])
    const vector = r.lines[0] as Line
    expect(vector).toBeDefined()
    expect(vector.to.x - vector.from.x).toBeCloseTo(r.cam.nmToPx(4), 1)
    expect(vector.to.y - vector.from.y).toBeCloseTo(0, 6)
  })

  it('points the vector north as up', () => {
    const r = render([plane({ hdg: 0, gsKts: 300 })])
    const vector = r.lines[0] as Line
    // Screen y grows downward, so northbound must decrease it.
    expect(vector.to.y).toBeLessThan(vector.from.y)
    expect(vector.to.x).toBeCloseTo(vector.from.x, 6)
  })

  it('lays one trail dot per recorded sweep', () => {
    const trail = [
      { x: -1, y: 0 },
      { x: -2, y: 0 },
      { x: -3, y: 0 },
    ]
    const r = render([plane({ trail })])
    expect(r.dots).toHaveLength(3)
    for (let i = 0; i < trail.length; i += 1) {
      const want = r.cam.worldToScreen(trail[i] as { x: number; y: number })
      expect(r.dots[i]?.x).toBeCloseTo(want.x, 6)
      expect(r.dots[i]?.y).toBeCloseTo(want.y, 6)
    }
  })

  it('fades the trail with age and hands the canvas back opaque', () => {
    const r = render([
      plane({
        trail: [
          { x: -1, y: 0 },
          { x: -2, y: 0 },
          { x: -3, y: 0 },
          { x: -4, y: 0 },
        ],
      }),
    ])
    const alphas = r.dots.map((d) => d.alpha)
    for (let i = 1; i < alphas.length; i += 1) {
      expect(alphas[i] as number).toBeLessThan(alphas[i - 1] as number)
    }
    expect(alphas[alphas.length - 1] as number).toBeGreaterThan(0)
    // Leaving the alpha turned down would fade everything drawn after this.
    expect(r.alphaAtEnd()).toBe(1)
  })

  it('draws the trail in the trail ink and the target in the target ink', () => {
    setPalette('dark')
    const r = render([plane({ trail: [{ x: -1, y: 0 }] })])
    expect(r.dots[0]?.style).toBe(palettes.dark.trail)
    expect(r.lines.some((l) => l.style === palettes.dark.target)).toBe(true)
    setPalette('beige')
  })

  it('changes the ink for the selected target rather than adding a mark', () => {
    const two = [plane({ callsign: 'BAW123' }), plane({ callsign: 'VIR7', pos: { x: 3, y: 3 } })]
    const plain = render(two)
    const picked = render(two, 'BAW123')

    // Same geometry, one square each, whatever is selected.
    expect(picked.rects).toHaveLength(plain.rects.length)
    expect(picked.labels.some((l) => l.s === 'BAW123' && l.style === theme.accent)).toBe(true)
    expect(picked.labels.some((l) => l.s === 'VIR7' && l.style === theme.target)).toBe(true)
  })

  it('draws every trail before any target, so no block is buried', () => {
    const r = render([
      plane({ callsign: 'BAW1', trail: [{ x: -1, y: 0 }] }),
      plane({ callsign: 'BAW2', pos: { x: 6, y: 6 }, trail: [{ x: 5, y: 6 }] }),
    ])
    expect(r.dots).toHaveLength(2)
    expect(r.labels.length).toBeGreaterThan(0)
  })

  it('drops the data block when the scope is too coarse for it', () => {
    const close = render([plane()], null, 10)
    const wide = render([plane()], null, 200)
    expect(close.labels.length).toBeGreaterThan(0)
    // The symbol and its vector survive; only the text goes.
    expect(wide.labels).toHaveLength(0)
    expect(wide.rects).toHaveLength(1)
    expect(wide.lines.length).toBeGreaterThan(0)
  })

  it('turns the block inward at the right-hand edge', () => {
    const cam = new Camera({ x: 0, y: 0 }, 20, { maxNM: 200 })
    cam.setViewport(1000, 600)
    const edge = cam.screenToWorld({ x: 980, y: 300 })
    const r = render([plane({ pos: edge })])
    const callsign = r.labels.find((l) => l.s === 'BAW123') as Label
    expect(callsign.align).toBe('right')
    expect(callsign.x).toBeLessThan(980)
  })
})

describe('blockLines', () => {
  it('reads callsign, level and speed', () => {
    expect(blockLines(plane({ altFt: 7000, gsKts: 240 }))).toEqual(['BAW123', '070', '240 A320'])
  })

  it('flags a heavy', () => {
    expect(blockLines(plane({ wake: 'H' }))[0]).toBe('BAW123 H')
    expect(blockLines(plane({ wake: 'J' }))[0]).toBe('BAW123 H')
    expect(blockLines(plane({ wake: 'M' }))[0]).toBe('BAW123')
  })

  it('shows the cleared level only while the aircraft is going there', () => {
    const descending = plane({ altFt: 12000, vsFpm: -1500, clearedAltFt: 7000 })
    expect(blockLines(descending)[1]).toBe('120v070')

    const climbing = plane({ altFt: 4000, vsFpm: 1200, clearedAltFt: 9000 })
    expect(blockLines(climbing)[1]).toBe('040^090')

    // Level: one number, not the same number printed twice.
    expect(blockLines(plane({ altFt: 7000, vsFpm: 0, clearedAltFt: 7000 }))[1]).toBe('070')
  })

  it('treats a drift inside the deadband as level', () => {
    expect(blockLines(plane({ vsFpm: 40, clearedAltFt: 9000 }))[1]).toBe('070')
  })

  it('rounds speed to five knots so the digits can be read', () => {
    expect(blockLines(plane({ gsKts: 238 }))[2]).toBe('240 A320')
    expect(blockLines(plane({ gsKts: 232 }))[2]).toBe('230 A320')
  })
})

describe('pickTarget', () => {
  const cam = (rangeNM = 20): Camera => {
    const c = new Camera({ x: 0, y: 0 }, rangeNM, { maxNM: 200 })
    c.setViewport(1000, 600)
    return c
  }

  it('finds nothing on an empty scope', () => {
    expect(pickTarget(cam(), [], { x: 500, y: 300 })).toBe(null)
  })

  it('picks the aircraft the cursor is on', () => {
    const c = cam()
    const a = plane({ pos: { x: 4, y: -2 } })
    const p = c.worldToScreen(a.pos)
    expect(pickTarget(c, [a], p)?.callsign).toBe('BAW123')
  })

  it('forgives a few pixels, because a target moves while you aim', () => {
    const c = cam()
    const a = plane()
    const p = c.worldToScreen(a.pos)
    expect(pickTarget(c, [a], { x: p.x + PICK_RADIUS_PX - 1, y: p.y })).not.toBe(null)
  })

  it('gives up beyond the radius rather than picking the nearest thing', () => {
    const c = cam()
    const a = plane()
    const p = c.worldToScreen(a.pos)
    // Well clear of both the symbol and its block, which is up and right.
    expect(pickTarget(c, [a], { x: p.x - 60, y: p.y + 60 })).toBe(null)
  })

  it('counts the data block as part of the target', () => {
    // The block is the biggest part of a target and the part a controller
    // actually points at.
    const c = cam()
    const a = plane()
    const p = c.worldToScreen(a.pos)
    const box = blockBox(c, a, p)
    const middle = { x: box.x + box.w / 2, y: box.y + box.h / 2 }
    expect(Math.hypot(middle.x - p.x, middle.y - p.y)).toBeGreaterThan(PICK_RADIUS_PX)
    expect(pickTarget(c, [a], middle)?.callsign).toBe('BAW123')
  })

  it('does not pick a block that is not being drawn', () => {
    // Zoomed out past the decluttering threshold there is no block on the
    // screen, and an invisible hit box is a trap.
    const wide = cam(200)
    const a = plane()
    const p = wide.worldToScreen(a.pos)
    const box = blockBox(wide, a, p)
    expect(pickTarget(wide, [a], { x: box.x + box.w / 2, y: box.y + box.h / 2 })).toBe(null)
  })

  it('resolves an overlap to whichever symbol is nearest', () => {
    const c = cam()
    const near = plane({ callsign: 'NEAR', pos: { x: 4, y: 0 } })
    const far = plane({ callsign: 'FAR', pos: { x: 4.3, y: 0 } })
    const at = c.worldToScreen(near.pos)
    // Order reversed, so a result of NEAR cannot just be the first match.
    expect(pickTarget(c, [far, near], at)?.callsign).toBe('NEAR')
  })
})
