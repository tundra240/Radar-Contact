import { afterEach, describe, expect, it } from 'vitest'
import {
  airspaceColour,
  formatLevel,
  palettes,
  paletteName,
  setPalette,
  theme,
  togglePalette,
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

  it('defines every colour in both palettes', () => {
    // Guards the failure mode of adding a colour to one scheme and getting
    // `undefined` as a fillStyle in the other, which silently draws black.
    const beige = Object.keys(palettes.beige).sort()
    const dark = Object.keys(palettes.dark).sort()
    expect(dark).toEqual(beige)
    for (const key of beige) {
      const k = key as keyof typeof palettes.beige
      expect(palettes.beige[k], `beige.${key}`).toBeTruthy()
      expect(palettes.dark[k], `dark.${key}`).toBeTruthy()
    }
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

  it('toggles back and forth', () => {
    expect(togglePalette()).toBe('dark')
    expect(togglePalette()).toBe('beige')
    expect(theme.bg).toBe(palettes.beige.bg)
  })

  it('keeps the two grounds genuinely light and dark', () => {
    const lum = (hex: string): number => {
      const n = parseInt(hex.slice(1), 16)
      return (((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) / 255
    }
    expect(lum(palettes.beige.bg)).toBeGreaterThan(0.6)
    expect(lum(palettes.dark.bg)).toBeLessThan(0.15)
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
