import { afterEach, describe, expect, it } from 'vitest'

import { Camera } from '../core/camera'
import type { Vec2NM } from '../core/geo'
import { airportOf } from '../data/airports'
import type { TerrainZone } from '../sim/zones'
import { drawTerrain } from './terrain'
import { setPalette, theme } from './theme'

interface Mark {
  readonly style: string
  readonly alpha: number
  readonly points: readonly { x: number; y: number }[]
}

interface Words {
  readonly s: string
  readonly x: number
  readonly y: number
  /** The face it was set in, so a test can work out how wide it is. */
  readonly font: string
}

/**
 * Just enough canvas to see what was drawn.
 *
 * save and restore are modelled rather than ignored: this layer leans on
 * them to keep its alpha off everything drawn afterwards, and a no-op pair
 * would hide exactly the bug that matters.
 */
function recorder(): {
  ctx: CanvasRenderingContext2D
  fills: Mark[]
  strokes: Mark[]
  texts: Words[]
} {
  const fills: Mark[] = []
  const strokes: Mark[] = []
  const texts: Words[] = []
  const saved: unknown[][] = []
  const keys = ['globalAlpha', 'fillStyle', 'strokeStyle', 'font', 'lineWidth']
  let path: { x: number; y: number }[] = []
  const noop = (): void => {}
  const stub: Record<string, unknown> = {
    globalAlpha: 1,
    fillStyle: '#000',
    strokeStyle: '#000',
    font: '',
    lineWidth: 1,
    beginPath: () => {
      path = []
    },
    closePath: noop,
    moveTo: (x: number, y: number) => path.push({ x, y }),
    lineTo: (x: number, y: number) => path.push({ x, y }),
    fill: () =>
      fills.push({
        style: String(stub['fillStyle']),
        alpha: Number(stub['globalAlpha']),
        points: [...path],
      }),
    stroke: () =>
      strokes.push({
        style: String(stub['strokeStyle']),
        alpha: Number(stub['globalAlpha']),
        points: [...path],
      }),
    fillText: (s: string, x: number, y: number) =>
      texts.push({ s, x, y, font: String(stub['font']) }),
    save: () => saved.push(keys.map((k) => stub[k])),
    restore: () => {
      const was = saved.pop()
      if (was === undefined) return
      keys.forEach((k, i) => {
        stub[k] = was[i]
      })
    },
  }
  return { ctx: stub as unknown as CanvasRenderingContext2D, fills, strokes, texts }
}

/** Lowest first, which is the order the layer draws them in. */
function drawOrder(terrain: readonly TerrainZone[]): readonly TerrainZone[] {
  return [...terrain].sort((a, b) => a.minimumSafeFt - b.minimumSafeFt)
}

function camera(centre: Vec2NM = { x: 0, y: 0 }, rangeNM = 40): Camera {
  const cam = new Camera(centre, rangeNM, { maxNM: 400 })
  cam.setViewport(1000, 700)
  return cam
}

const nice = airportOf('LFMN')
const barcelona = airportOf('LEBL')

function drawn(icao: 'LFMN' | 'LEBL', cam = camera()): ReturnType<typeof recorder> {
  const rec = recorder()
  drawTerrain(rec.ctx, cam, airportOf(icao).terrain)
  return rec
}

afterEach(() => {
  setPalette('traconDark')
})

describe('contour bands', () => {
  it('gives a massif more than one outline', () => {
    // The whole point. One shape with one number in it can only say "not
    // here"; the useful question is how far in you can take somebody at six
    // thousand feet, and that needs the ground drawn at more than one
    // height.
    const alps = nice.terrain.filter((t) => t.massif === 'maritime-alps')
    expect(alps.length).toBeGreaterThan(2)
    const heights = alps.map((t) => t.minimumSafeFt).sort((a, b) => a - b)
    expect(new Set(heights).size).toBe(heights.length)
  })

  it('shades the ground more heavily the higher it gets', () => {
    // Drawn low to high, so the washes stack and the summit comes out the
    // densest part of the massif without anything having to arrange it.
    const alphas = drawn('LFMN').fills.map((f) => f.alpha)
    const bands = alphas.slice(0, nice.terrain.length)
    for (let i = 1; i < bands.length; i += 1) {
      expect(bands[i]!, `band ${i} is no denser than the one below`).toBeGreaterThan(bands[i - 1]!)
    }
  })

  it('walks the ramp rather than drawing everything in one ink', () => {
    const inks = new Set(drawn('LEBL').fills.map((f) => f.style))
    expect(inks.size).toBeGreaterThan(3)
    expect(inks.has(theme.terrainLow)).toBe(false)
  })

  it('follows the palette', () => {
    setPalette('beige')
    const beige = new Set(drawn('LEBL').fills.map((f) => f.style))
    setPalette('traconDark')
    const dark = new Set(drawn('LEBL').fills.map((f) => f.style))
    for (const ink of beige) expect(dark.has(ink)).toBe(false)
  })

  it('costs a flat field nothing', () => {
    const rec = recorder()
    drawTerrain(rec.ctx, camera(), airportOf('EGLL').terrain)
    expect(rec.fills).toHaveLength(0)
    expect(rec.strokes).toHaveLength(0)
    expect(rec.texts).toHaveLength(0)
  })
})

describe('hachures', () => {
  /** Every tick as a base and a tip. Each is one moveTo and one lineTo. */
  function ticks(rec: ReturnType<typeof recorder>, index: number): Mark['points'][] {
    // Two strokes a band, in order: the contour itself, then its ticks.
    const marks = rec.strokes[index * 2 + 1]
    expect(marks, `no hachure pass for band ${index}`).toBeDefined()
    const out: Mark['points'][] = []
    for (let i = 0; i + 1 < marks!.points.length; i += 2) {
      out.push([marks!.points[i]!, marks!.points[i + 1]!])
    }
    return out
  }

  it('ticks every contour', () => {
    const rec = drawn('LEBL')
    // A contour and a hachure pass each.
    expect(rec.strokes.length).toBe(barcelona.terrain.length * 2)
    for (let i = 0; i < barcelona.terrain.length; i += 1) {
      expect(ticks(rec, i).length, `band ${i} has no ticks`).toBeGreaterThan(4)
    }
  })

  it('points them at the high ground, which is what a hachure is for', () => {
    // Garraf is a single band with a recorded summit, so where uphill lies
    // is not a matter of opinion.
    const cam = camera()
    const rec = drawn('LEBL', cam)
    const garraf = drawOrder(barcelona.terrain).findIndex((t) => t.id === 'garraf')
    const summit = cam.worldToScreen(barcelona.terrain.find((t) => t.id === 'garraf')!.summitNM!)

    for (const [base, tip] of ticks(rec, garraf)) {
      const towards = { x: summit.x - base!.x, y: summit.y - base!.y }
      const tick = { x: tip!.x - base!.x, y: tip!.y - base!.y }
      expect(
        tick.x * towards.x + tick.y * towards.y,
        `a tick at ${base!.x.toFixed(0)},${base!.y.toFixed(0)} points downhill`,
      ).toBeGreaterThan(0)
    }
  })

  it('keeps them short enough to read as ticks and not as a second outline', () => {
    for (const [base, tip] of ticks(drawn('LEBL'), 0)) {
      expect(Math.hypot(tip!.x - base!.x, tip!.y - base!.y)).toBeLessThan(8)
    }
  })
})

describe('lettering', () => {
  it('does not write one hill over another', () => {
    // Sant Llorenc and Montserrat sit close enough at a wide range that
    // their captions used to land on each other's names. Whichever loses,
    // the display must not end up with two labels in one place: an
    // overlapped number is worse than a missing one, because it still looks
    // like a number.
    const said = drawn('LEBL').texts
    const boxes = said.map((t) => {
      const size = Number(/(\d+)px/.exec(t.font)?.[1] ?? 9)
      const w = t.s.length * size * 0.62
      return { s: t.s, x: t.x - w / 2, y: t.y - size / 2, w, h: size }
    })
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!
        const b = boxes[j]!
        const over =
          a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
        expect(over, `"${a.s}" is written over "${b.s}"`).toBe(false)
      }
    }
  })

  it('drops the lower hill rather than shuffling a name off its own ground', () => {
    // Everything still on the display has to be somewhere it belongs, so
    // the fallback when a name will not fit is to lose it -- and the one
    // lost is the lower of the two, because the higher is the one that
    // would kill you.
    const said = drawn('LEBL', camera({ x: 0, y: 0 }, 70)).texts.map((t) => t.s)
    expect(said.some((t) => t.startsWith('MONTSERRAT '))).toBe(true)
  })

  it('names a massif once, however many bands it has', () => {
    const said = drawn('LEBL').texts.map((t) => t.s)
    expect(said.filter((s) => s.startsWith('MONTSERRAT ')).length).toBe(1)
    expect(said).toContain('MONTSERRAT 6000 MSA')
    // The lower band of the same hill is numbered, not named: seven
    // two-line labels would be a paragraph laid over the scope.
    expect(said.some((s) => s.includes('MONTSERRAT SLOPES'))).toBe(false)
    expect(said).toContain('4400')
  })

  it('gives the summit the height that explains the minimum', () => {
    expect(drawn('LEBL').texts.map((t) => t.s)).toContain('terrain to 4055 ft')
  })

  it('draws nothing over open water', () => {
    // Fifteen miles out to sea off Nice, close in. There is no ground here
    // and the layer should be silent rather than reaching for something to
    // label.
    expect(drawn('LFMN', camera({ x: 0, y: -15 }, 6)).texts).toHaveLength(0)
  })

  it('numbers the contour being flown over, however close in', () => {
    // Zoomed right in over the foothills. The field is off the bottom of
    // the display and so is the seaward edge of every band, so a number
    // placed on the edge nearest the field would be a number nobody sees --
    // and the minimum is the one thing on this layer a controller needs at
    // exactly this zoom.
    const cam = camera({ x: 0, y: 12 }, 5)
    const rec = drawn('LFMN', cam)
    const said = rec.texts.filter((t) => t.s === '4300')
    expect(said.length, 'the ridge underneath went unnumbered').toBe(1)
    expect(said[0]!.x).toBeGreaterThan(0)
    expect(said[0]!.x).toBeLessThan(cam.width)
    expect(said[0]!.y).toBeGreaterThan(0)
    expect(said[0]!.y).toBeLessThan(cam.height)
  })

  it('pulls a name back onto its own hillside when the summit is off the glass', () => {
    // Only onto ground that is still part of the band: a name dragged out
    // over the sea would be labelling somewhere an aeroplane can safely be.
    const cam = camera({ x: -2, y: 26 }, 9)
    const alps = drawn('LFMN', cam).texts.find((t) => t.s.startsWith('MARITIME ALPS'))
    expect(alps, 'the range being flown into went unnamed').toBeDefined()
    expect(alps!.y).toBeGreaterThan(0)
    expect(alps!.y).toBeLessThan(cam.height)
  })

  it('leaves a hill too small to letter unlettered', () => {
    // Zoomed right out, Mont Agel is a few pixels across. A name on it
    // would be bigger than the hill.
    const said = drawn('LFMN', camera({ x: 0, y: 0 }, 260)).texts.map((s) => s.s)
    expect(said.some((s) => s.startsWith('MONT AGEL'))).toBe(false)
    // The Alps, at the same range, are still most of the display.
    expect(said.some((s) => s.startsWith('MARITIME ALPS'))).toBe(true)
  })

  it('names a hill off its widest contour, not off its summit', () => {
    // Zoomed out, the top band of a massif drops below the size threshold
    // long before the mountain does. Culling on that alone took the name
    // off Montserrat while its lower slopes still covered a good part of
    // the scope.
    const wide = drawn('LEBL', camera({ x: 0, y: 0 }, 70)).texts.map((t) => t.s)
    expect(wide.some((s) => s.startsWith('MONTSERRAT '))).toBe(true)
    expect(wide.some((s) => s.startsWith('MONTSENY '))).toBe(true)
  })
})
