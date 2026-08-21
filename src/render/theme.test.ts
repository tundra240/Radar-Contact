import { afterEach, describe, expect, it } from 'vitest'
import {
  airspaceColour,
  formatLevel,
  PALETTE_ORDER,
  cyclePalette,
  isPaletteName,
  nextPaletteName,
  palettes,
  paletteName,
  setPalette,
  theme,
} from './theme'

afterEach(() => {
  // The active palette is module state shared by every render module, so
  // leaving it switched would leak into other tests.
  setPalette('beige')
})

describe('palettes', () => {
  it('starts on beige', () => {
    expect(paletteName()).toBe('beige')
    expect(theme.bg).toBe(palettes.beige.bg)
  })

  it('defines every colour in every palette', () => {
    // Guards the failure mode of adding a colour to one scheme and getting
    // `undefined` as a fillStyle in another, which silently draws black.
    const reference = Object.keys(palettes.beige).sort()
    for (const name of PALETTE_ORDER) {
      const p = palettes[name]
      expect(Object.keys(p).sort(), name).toEqual(reference)
      for (const key of reference) {
        expect(p[key as keyof typeof p], `${name}.${key}`).toBeTruthy()
      }
    }
  })

  it('recognises its own names and rejects anything else', () => {
    for (const name of PALETTE_ORDER) expect(isPaletteName(name)).toBe(true)
    expect(isPaletteName('chartreuse')).toBe(false)
    expect(isPaletteName(null)).toBe(false)
  })

  it('switches the whole scheme through the shared object', () => {
    const ref = theme
    setPalette('dark')
    expect(paletteName()).toBe('dark')
    expect(theme.bg).toBe(palettes.dark.bg)
    // Identity must be preserved: render modules captured this reference at
    // import time and would otherwise keep drawing the old colours.
    expect(theme).toBe(ref)
  })

  it('cycles through every scheme and wraps', () => {
    expect(nextPaletteName()).toBe('dark')
    expect(cyclePalette()).toBe('dark')
    expect(cyclePalette()).toBe('amber')
    expect(cyclePalette()).toBe('beige')
    expect(theme.bg).toBe(palettes.beige.bg)
  })

  it('keeps one light ground and two dark ones', () => {
    const lum = (hex: string): number => {
      const n = parseInt(hex.slice(1), 16)
      return (((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) / 255
    }
    expect(lum(palettes.beige.bg)).toBeGreaterThan(0.6)
    expect(lum(palettes.dark.bg)).toBeLessThan(0.15)
    expect(lum(palettes.amber.bg)).toBeLessThan(0.15)
  })

  it('gives the amber tube a warm cast rather than a neutral one', () => {
    // A monochrome scheme that is not actually tinted is just a dark theme.
    const n = parseInt(palettes.amber.bg.slice(1), 16)
    expect((n >> 16) & 255).toBeGreaterThan(n & 255)
    const a = parseInt(palettes.amber.accent.slice(1), 16)
    expect((a >> 16) & 255).toBeGreaterThan(a & 255)
  })
})

describe('airspaceColour', () => {
  it('separates the upper area, the zones and class G', () => {
    expect(airspaceColour('A')).toBe(theme.airspaceHigh)
    expect(airspaceColour('D')).toBe(theme.airspaceControl)
    expect(airspaceColour('G')).toBe(theme.airspaceLocal)
  })

  it('follows the active palette', () => {
    setPalette('dark')
    expect(airspaceColour('A')).toBe(palettes.dark.airspaceHigh)
  })
})

describe('formatLevel', () => {
  it('reads limits the way a chart does', () => {
    expect(formatLevel(0)).toBe('SFC')
    expect(formatLevel(2500)).toBe('2500')
    expect(formatLevel(19500)).toBe('FL195')
  })
})

/* ------------------------------------------------------------- contrast */

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const chan = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return (
    0.2126 * chan((n >> 16) & 255) +
    0.7152 * chan((n >> 8) & 255) +
    0.0722 * chan(n & 255)
  )
}

function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

describe('palette legibility', () => {
  // Symbology the controller reads values off. 3:1 is the threshold for a
  // graphical object; anything below it is a display you squint at.
  const SYMBOLOGY = [
    'runway',
    'runwayLabel',
    'navaid',
    'navaidLabel',
    'navaidFreq',
    'hold',
    'fafTick',
    'accent',
    'neighbour',
    'neighbourLabel',
    'airspaceHigh',
    'airspaceControl',
    'airspaceLocal',
    'airspaceLabel',
    'ringLabel',
    'warn',
    // The per-mile ticks are how spacing is judged by eye, so they carry
    // information and belong here rather than with the grid.
    'centrelineTick',
    // The FIR limit is a real airspace boundary, so it is read rather than
    // merely sensed.
    'fir',
  ] as const

  // Grid furniture is meant to recede. An upper bound matters as much as a
  // lower one: rings that shout compete with the traffic.
  // The coastline belongs here rather than with the symbology: it is a
  // backdrop for orientation, and 2400 points of shoreline drawn loudly
  // would bury the traffic it is supposed to give context to.
  const FURNITURE = ['ring', 'ringStrong', 'cardinal', 'centreline', 'coast'] as const

  for (const name of PALETTE_ORDER) {
    describe(name, () => {
      const p = palettes[name]

      it('keeps primary text and runways well clear of the ground', () => {
        expect(contrast(p.text, p.bg), 'text').toBeGreaterThanOrEqual(4.5)
        expect(contrast(p.runway, p.bg), 'runway').toBeGreaterThanOrEqual(4.5)
      })

      it('keeps every symbology colour readable on the ground', () => {
        for (const key of SYMBOLOGY) {
          expect(contrast(p[key], p.bg), key).toBeGreaterThanOrEqual(3)
        }
      })

      it('keeps dim text usable', () => {
        expect(contrast(p.textDim, p.bg), 'textDim').toBeGreaterThanOrEqual(3.5)
      })

      it('keeps the grid faint but visible', () => {
        for (const key of FURNITURE) {
          const r = contrast(p[key], p.bg)
          expect(r, `${key} too invisible`).toBeGreaterThan(1.25)
          expect(r, `${key} too loud`).toBeLessThan(4)
        }
      })

      it('keeps the chrome readable against its own faces', () => {
        // Chrome sits on the panel face, not on the scope ground, so it is
        // measured against that instead.
        expect(contrast(p.chromeText, p.chromeFace), 'chromeText').toBeGreaterThanOrEqual(4.5)
        expect(contrast(p.chromeDim, p.chromeFace), 'chromeDim').toBeGreaterThanOrEqual(3)
        expect(contrast(p.chromeDim, p.chromeWell), 'chromeDim on well').toBeGreaterThanOrEqual(3)
        expect(contrast(p.accent, p.chromeFace), 'accent on face').toBeGreaterThanOrEqual(3)
        expect(
          contrast(p.chromeTitleText, p.chromeTitleBar),
          'title bar lettering',
        ).toBeGreaterThanOrEqual(4.5)
      })

      it('gives the bevel edges something to work with', () => {
        // A raised edge needs the highlight lighter than the face and the
        // shadow darker, or the whole effect collapses.
        expect(luminance(p.chromeLight)).toBeGreaterThan(luminance(p.chromeFace))
        expect(luminance(p.chromeShadow)).toBeLessThan(luminance(p.chromeFace))
        expect(contrast(p.chromeLight, p.chromeShadow)).toBeGreaterThan(2)
      })
    })
  }
})
