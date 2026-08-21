import { describe, expect, it } from 'vitest'
import { Camera } from '../../core/camera'
import type { Aircraft } from '../../sim/types'
import { palettes, setPalette, theme } from '../theme'
import {
  PICK_RADIUS_PX,
  blockBox,
  blockLines,
  dragHeading,
  drawTargets,
  drawVectorDrag,
  pickTarget,
} from './targets'

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
  dashed: boolean
  alpha: number
}
interface Label {
  s: string
  x: number
  y: number
  style: string
  align: string
  alpha: number
}

function recorder(): {
  ctx: CanvasRenderingContext2D
  dots: Dot[]
  rects: Rect[]
  lines: Line[]
  labels: Label[]
  dashes: number[][]
  alphaAtEnd: () => number
  dashAtEnd: () => number[]
} {
  const dots: Dot[] = []
  const rects: Rect[] = []
  const lines: Line[] = []
  const labels: Label[] = []
  const dashes: number[][] = []
  let dash: number[] = []
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
        lines.push({
          from,
          to,
          style: String(stub['strokeStyle']),
          dashed: dash.length > 0,
          alpha: Number(stub['globalAlpha']),
        })
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
        alpha: Number(stub['globalAlpha']),
      })
    },
    fillRect: noop,
    save: noop,
    restore: noop,
    setLineDash: (d: number[]) => {
      dash = d
      dashes.push(d)
    },
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
    dashes,
    alphaAtEnd: () => Number(stub['globalAlpha']),
    dashAtEnd: () => dash,
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
    hold: null,
    originFix: 'LAM',
    entered: true,
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

describe('dragHeading', () => {
  const cam = (): Camera => {
    const c = new Camera({ x: 0, y: 0 }, 20, { maxNM: 200 })
    c.setViewport(1000, 600)
    return c
  }

  it('reads the bearing from the aircraft to the cursor', () => {
    const a = plane({ pos: { x: 0, y: 0 } })
    expect(dragHeading(a, { x: 5, y: 0 })).toBe(90)
    expect(dragHeading(a, { x: -5, y: 0 })).toBe(270)
    expect(dragHeading(a, { x: 0, y: -5 })).toBe(180)
  })

  it('gives due north as zero, which is what the command wants', () => {
    // headingLabel turns it back into 360 for the readout.
    expect(dragHeading(plane({ pos: { x: 0, y: 0 } }), { x: 0, y: 5 })).toBe(0)
  })

  it('measures from where the aircraft is, not from the origin', () => {
    const a = plane({ pos: { x: 10, y: 10 } })
    expect(dragHeading(a, { x: 10, y: 20 })).toBe(0)
    expect(dragHeading(a, { x: 20, y: 10 })).toBe(90)
  })

  it('rounds to a whole degree and never returns 360', () => {
    const a = plane({ pos: { x: 0, y: 0 } })
    // A hair west of north rounds to 360, which has to come back as zero.
    expect(dragHeading(a, { x: -0.001, y: 10 })).toBe(0)
    expect(Number.isInteger(dragHeading(a, { x: 3, y: 7 }))).toBe(true)
  })

  it('agrees with the line that was drawn', () => {
    // The readout and the clearance must come from the same arithmetic, or
    // the aircraft flies somewhere other than where you pointed.
    const c = cam()
    const a = plane({ pos: { x: 2, y: 3 } })
    const cursor = { x: 700, y: 200 }
    const viaScreen = dragHeading(a, c.screenToWorld(cursor))
    const r = recorder()
    drawVectorDrag(r.ctx, c, { aircraft: a, toPx: cursor })
    const readout = r.labels[0]?.s ?? ''
    expect(readout.startsWith(String(viaScreen === 0 ? 360 : viaScreen).padStart(3, '0'))).toBe(true)
  })
})

describe('drawVectorDrag', () => {
  const render = (aircraft = plane({ pos: { x: 0, y: 0 } }), toPx = { x: 700, y: 200 }) => {
    const cam = new Camera({ x: 0, y: 0 }, 20, { maxNM: 200 })
    cam.setViewport(1000, 600)
    const rec = recorder()
    drawVectorDrag(rec.ctx, cam, { aircraft, toPx })
    return { ...rec, cam, aircraft, toPx }
  }

  it('draws a dashed line from the target to the cursor', () => {
    const r = render()
    const from = r.cam.worldToScreen(r.aircraft.pos)
    const elastic = r.lines.find((l) => l.dashed)
    expect(elastic).toBeDefined()
    expect((elastic as Line).from.x).toBeCloseTo(from.x, 6)
    expect((elastic as Line).from.y).toBeCloseTo(from.y, 6)
    expect((elastic as Line).to).toEqual(r.toPx)
  })

  it('hands the dash pattern back, so nothing after it comes out dashed', () => {
    // The airspace boundaries are drawn with dashes of their own, and a
    // leftover pattern would quietly restyle everything downstream.
    expect(render().dashAtEnd()).toEqual([])
  })

  it('reads out the heading in three digits and the distance in miles', () => {
    const r = render(plane({ pos: { x: 0, y: 0 } }))
    const text = r.labels[0]?.s ?? ''
    expect(text).toMatch(/^\d{3}/)
    expect(text).toMatch(/\d+\.\d NM$/)
  })

  it('writes north as 360 rather than 000', () => {
    const cam = new Camera({ x: 0, y: 0 }, 20, { maxNM: 200 })
    cam.setViewport(1000, 600)
    const north = cam.worldToScreen({ x: 0, y: 8 })
    const r = render(plane({ pos: { x: 0, y: 0 } }), north)
    expect(r.labels[0]?.s.startsWith('360')).toBe(true)
  })

  it('measures the distance to the cursor, not to anywhere else', () => {
    const cam = new Camera({ x: 0, y: 0 }, 20, { maxNM: 200 })
    cam.setViewport(1000, 600)
    const six = cam.worldToScreen({ x: 6, y: 0 })
    const r = render(plane({ pos: { x: 0, y: 0 } }), six)
    expect(r.labels[0]?.s).toContain('6.0 NM')
  })

  it('marks the aircraft the line comes out of', () => {
    const r = render()
    const from = r.cam.worldToScreen(r.aircraft.pos)
    expect(r.dots.some((d) => Math.hypot(d.x - from.x, d.y - from.y) < 0.001)).toBe(true)
  })

  it('puts the readout on a filled panel so the map cannot be read through it', () => {
    const r = render()
    expect(r.rects.length).toBeGreaterThan(0)
  })

  it('turns the readout inward at the right-hand edge', () => {
    const near = render(plane({ pos: { x: 0, y: 0 } }), { x: 990, y: 300 })
    const label = near.labels[0]
    expect(label).toBeDefined()
    expect((label as Label).x).toBeLessThan(990)
  })

  it('drops the readout below the cursor at the top of the display', () => {
    const top = render(plane({ pos: { x: 0, y: 0 } }), { x: 400, y: 4 })
    expect((top.labels[0] as Label).y).toBeGreaterThan(4)
  })
})

describe('picking out of a stack', () => {
  const cam = (): Camera => {
    const c = new Camera({ x: 0, y: 0 }, 40, { maxNM: 200 })
    c.setViewport(1400, 800)
    return c
  }

  /** Four aircraft holding over one fix, a mile apart round the pattern. */
  const stack = [
    plane({ callsign: 'ONE1', pos: { x: 13.0, y: 9.0 }, altFt: 8000 }),
    plane({ callsign: 'TWO2', pos: { x: 13.6, y: 9.4 }, altFt: 9000 }),
    plane({ callsign: 'THREE3', pos: { x: 12.4, y: 9.6 }, altFt: 10000 }),
    plane({ callsign: 'FOUR4', pos: { x: 13.2, y: 8.4 }, altFt: 11000 }),
  ]

  it('finds more than one candidate under a single press', () => {
    // Otherwise the preference below is solving a problem that is not there.
    const c = cam()
    const at = c.worldToScreen({ x: 13, y: 9 })
    const hits = stack.filter((a) => {
      const p = c.worldToScreen(a.pos)
      return Math.hypot(p.x - at.x, p.y - at.y) <= PICK_RADIUS_PX
    })
    expect(hits.length).toBeGreaterThan(1)
  })

  it('gives the selected aircraft the press, not merely the nearest', () => {
    const c = cam()
    const at = c.worldToScreen({ x: 13, y: 9 })
    // Nearest is ONE1, sitting exactly under the cursor.
    expect(pickTarget(c, stack, at)?.callsign).toBe('ONE1')
    // But if another one in the stack is selected, that is the one meant.
    expect(pickTarget(c, stack, at, undefined, 'TWO2')?.callsign).toBe('TWO2')
    expect(pickTarget(c, stack, at, undefined, 'FOUR4')?.callsign).toBe('FOUR4')
  })

  it('ignores a preference that is not under the cursor at all', () => {
    const c = cam()
    const at = c.worldToScreen({ x: 13, y: 9 })
    const away = plane({ callsign: 'FAR9', pos: { x: -30, y: -30 } })
    expect(pickTarget(c, [...stack, away], at, undefined, 'FAR9')?.callsign).toBe('ONE1')
  })

  it('still finds nothing on empty scope, whatever is selected', () => {
    const c = cam()
    expect(pickTarget(c, stack, { x: 40, y: 760 }, undefined, 'TWO2')).toBe(null)
  })
})

describe('traffic outside the area of responsibility', () => {
  const render = (traffic: readonly Aircraft[]) => {
    const cam = new Camera({ x: 0, y: 0 }, 60, { maxNM: 200 })
    cam.setViewport(1000, 600)
    const rec = recorder()
    drawTargets(rec.ctx, cam, traffic, null)
    return { ...rec, cam }
  }

  it('draws it dimmer than traffic that is yours', () => {
    // It is there to be seen and planned around, and it will not take an
    // instruction, so it must not look like it would.
    const mine = render([plane({ callsign: 'MINE', entered: true })])
    const coming = render([plane({ callsign: 'COMING', entered: false, pos: { x: 48, y: 0 } })])
    const alphaOf = (labels: Label[]): number => labels[0]?.alpha ?? -1
    expect(alphaOf(coming.labels)).toBeLessThan(alphaOf(mine.labels))
    expect(alphaOf(coming.labels)).toBeGreaterThan(0)
  })

  it('still draws it, rather than hiding it', () => {
    // Knowing what is about to arrive is most of knowing what to do with
    // what is already here.
    const r = render([plane({ callsign: 'COMING', entered: false })])
    expect(r.rects.length).toBeGreaterThan(0)
    expect(r.labels.some((l) => l.s === 'COMING')).toBe(true)
  })

  it('dims its trail too, without flattening the fade', () => {
    const trail = [
      { x: -1, y: 0 },
      { x: -2, y: 0 },
      { x: -3, y: 0 },
    ]
    const coming = render([plane({ entered: false, trail })])
    const mine = render([plane({ entered: true, trail })])
    for (let i = 0; i < trail.length; i += 1) {
      expect(coming.dots[i]?.alpha).toBeLessThan(mine.dots[i]?.alpha as number)
    }
    // And the fade with age survives the dimming.
    expect(coming.dots[2]?.alpha).toBeLessThan(coming.dots[0]?.alpha as number)
  })

  it('hands the canvas back at full strength', () => {
    // A leaked alpha would dim the chrome, the readouts and everything else
    // drawn after the traffic.
    const r = render([
      plane({ callsign: 'COMING', entered: false }),
      plane({ callsign: 'MINE', entered: true, pos: { x: 5, y: 5 } }),
    ])
    expect(r.alphaAtEnd()).toBe(1)
  })

  it('does not dim the one that is yours just because a neighbour is not', () => {
    const r = render([
      plane({ callsign: 'COMING', entered: false, pos: { x: 48, y: 0 } }),
      plane({ callsign: 'MINE', entered: true, pos: { x: 5, y: 5 } }),
    ])
    const mine = r.labels.find((l) => l.s === 'MINE')
    expect(mine?.alpha).toBe(1)
  })
})
