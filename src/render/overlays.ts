/**
 * Which optional layers the scope draws.
 *
 * The distinction is operational versus contextual. The runways being
 * worked, the holding fixes, the sector boundary and the readouts are
 * always drawn -- they are the job. Everything here is context that helps
 * or clutters depending on what you are doing, so it is the controller's
 * choice.
 */
export interface Overlays {
  /** Control zones, control areas and the TMA. */
  readonly airspace: boolean
  /** Class G aerodrome traffic zones, which are numerous and small. */
  readonly trafficZones: boolean
  readonly airspaceLabels: boolean
  /** Navaids that are not approach holds; holds are always drawn. */
  readonly navaids: boolean
  readonly navaidFreqs: boolean
  readonly aerodromes: boolean
  readonly rangeRings: boolean
  readonly centrelines: boolean
  /** The shoreline, as a backdrop to orient the picture against. */
  readonly coastline: boolean
  /** The Thames, which is the strongest orientation cue London has. */
  readonly rivers: boolean
  /** The lateral limit of the London FIR -- the edge of UK airspace. */
  readonly firBoundary: boolean
}

export type OverlayKey = keyof Overlays

/** Display order and wording for the control panel. */
export const OVERLAY_ITEMS: readonly { readonly key: OverlayKey; readonly label: string }[] = [
  { key: 'rangeRings', label: 'Range rings' },
  { key: 'centrelines', label: 'Extended centrelines' },
  { key: 'airspace', label: 'Controlled airspace' },
  { key: 'trafficZones', label: 'Traffic zones (ATZ)' },
  { key: 'airspaceLabels', label: 'Airspace labels' },
  { key: 'aerodromes', label: 'Other aerodromes' },
  { key: 'navaids', label: 'Other navaids' },
  { key: 'navaidFreqs', label: 'Navaid frequencies' },
  { key: 'coastline', label: 'Coastline' },
  { key: 'rivers', label: 'River Thames' },
  { key: 'firBoundary', label: 'FIR boundary' },
]

export type DensityName = 'minimal' | 'standard' | 'full'

export const OVERLAY_PRESETS: Record<DensityName, Overlays> = {
  /** Just the geometry needed to run an approach. */
  minimal: {
    airspace: false,
    trafficZones: false,
    airspaceLabels: false,
    navaids: false,
    navaidFreqs: false,
    aerodromes: false,
    rangeRings: true,
    centrelines: true,
    coastline: false,
    rivers: false,
    firBoundary: false,
  },
  /** Enough surrounding context to stay oriented. */
  standard: {
    airspace: true,
    trafficZones: false,
    airspaceLabels: true,
    navaids: true,
    navaidFreqs: false,
    aerodromes: true,
    rangeRings: true,
    centrelines: true,
    coastline: true,
    rivers: true,
    firBoundary: true,
  },
  /** Everything the data supports. */
  full: {
    airspace: true,
    trafficZones: true,
    airspaceLabels: true,
    navaids: true,
    navaidFreqs: true,
    aerodromes: true,
    rangeRings: true,
    centrelines: true,
    coastline: true,
    rivers: true,
    firBoundary: true,
  },
}

export const DENSITY_ORDER: readonly DensityName[] = ['minimal', 'standard', 'full']

export const DEFAULT_OVERLAYS: Overlays = OVERLAY_PRESETS.standard

/** Names the current combination, or reports it as a custom mix. */
export function densityOf(overlays: Overlays): DensityName | 'custom' {
  for (const name of DENSITY_ORDER) {
    const preset = OVERLAY_PRESETS[name]
    if (OVERLAY_ITEMS.every((i) => preset[i.key] === overlays[i.key])) return name
  }
  return 'custom'
}

/** The next preset in the cycle, for a single-button control. */
export function nextDensity(current: DensityName | 'custom'): DensityName {
  const i = DENSITY_ORDER.indexOf(current as DensityName)
  return DENSITY_ORDER[(i + 1) % DENSITY_ORDER.length] ?? 'standard'
}

export function countEnabled(overlays: Overlays): number {
  return OVERLAY_ITEMS.filter((i) => overlays[i.key]).length
}
