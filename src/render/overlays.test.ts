import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OVERLAYS,
  DENSITY_ORDER,
  OVERLAY_ITEMS,
  OVERLAY_PRESETS,
  countEnabled,
  densityOf,
  nextDensity,
  type Overlays,
} from './overlays'

describe('overlay presets', () => {
  it('covers every overlay key in the control list', () => {
    // The panel is built from OVERLAY_ITEMS, so a key missing here would be
    // impossible to switch off from the UI.
    const keys = Object.keys(OVERLAY_PRESETS.full).sort()
    expect(OVERLAY_ITEMS.map((i) => i.key).sort()).toEqual(keys)
  })

  it('orders the presets from least to most', () => {
    const counts = DENSITY_ORDER.map((d) => countEnabled(OVERLAY_PRESETS[d]))
    expect(counts).toEqual([...counts].sort((a, b) => a - b))
    expect(countEnabled(OVERLAY_PRESETS.full)).toBe(OVERLAY_ITEMS.length)
  })

  it('keeps the approach geometry on at every preset', () => {
    // Range rings and centrelines are how you actually run an approach, so
    // even the minimal preset leaves them alone.
    for (const d of DENSITY_ORDER) {
      expect(OVERLAY_PRESETS[d].rangeRings, d).toBe(true)
      expect(OVERLAY_PRESETS[d].centrelines, d).toBe(true)
    }
  })

  it('defaults to standard', () => {
    expect(densityOf(DEFAULT_OVERLAYS)).toBe('standard')
  })

  it('names a preset and reports anything else as custom', () => {
    for (const d of DENSITY_ORDER) {
      expect(densityOf(OVERLAY_PRESETS[d])).toBe(d)
    }
    const tweaked: Overlays = { ...OVERLAY_PRESETS.minimal, navaids: true }
    expect(densityOf(tweaked)).toBe('custom')
  })

  it('cycles through the presets and wraps', () => {
    expect(nextDensity('minimal')).toBe('standard')
    expect(nextDensity('standard')).toBe('full')
    expect(nextDensity('full')).toBe('minimal')
  })

  it('lands a custom mix back on a known preset', () => {
    // indexOf returns -1 for 'custom', so this pins the wrap arithmetic
    // rather than leaving it to produce undefined.
    const next = nextDensity('custom')
    expect(DENSITY_ORDER).toContain(next)
  })
})
