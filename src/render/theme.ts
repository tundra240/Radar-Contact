/**
 * Every colour, font and line weight the scope draws with.
 *
 * One file, by design: tuning a radar display is done by eye, and hunting
 * hex codes across a dozen render modules is how palettes drift.
 *
 * Two complete palettes live here. `beige` is the shipped look -- a warm
 * chart-paper ground with dim, saturated accents, after the early-2000s
 * terminal displays that drew dark symbology on a light ground. `dark` is
 * the earlier near-black scheme, kept intact so switching is one line
 * rather than a rewrite. Accents are NOT shared between them: a colour that
 * glows on black turns to mud on beige, so each palette is tuned whole.
 */

export interface Palette {
  readonly bg: string

  readonly ringFaint: string
  readonly ring: string
  readonly ringStrong: string
  readonly cardinal: string
  readonly ringLabel: string

  /** Airspace boundaries, keyed loosely by class. */
  readonly airspaceHigh: string
  readonly airspaceControl: string
  readonly airspaceLocal: string
  readonly airspaceLabel: string

  readonly runway: string
  readonly runwayLabel: string
  readonly centreline: string
  readonly centrelineTick: string
  readonly fafTick: string

  readonly navaid: string
  readonly navaidLabel: string
  readonly navaidFreq: string
  readonly hold: string

  readonly neighbour: string
  readonly neighbourLabel: string

  readonly text: string
  readonly textDim: string
  readonly accent: string
  readonly warn: string
}

export const palettes: Record<'beige' | 'dark', Palette> = {
  beige: {
    bg: '#c9bfa3',

    ringFaint: '#bcb094',
    ring: '#a89b76',
    ringStrong: '#8a7d55',
    cardinal: '#94875f',
    ringLabel: '#5f5636',

    airspaceHigh: '#2d4f7c',
    airspaceControl: '#7a2f5f',
    airspaceLocal: '#6b5a20',
    airspaceLabel: '#4a4028',

    runway: '#17150f',
    runwayLabel: '#2f2a1c',
    centreline: '#6f6547',
    centrelineTick: '#574e33',
    fafTick: '#0a6b74',

    navaid: '#0d6a73',
    navaidLabel: '#0a4d54',
    navaidFreq: '#6a6040',
    hold: '#8a5000',

    neighbour: '#463f2b',
    neighbourLabel: '#3a3423',

    text: '#241f14',
    textDim: '#5f5636',
    accent: '#0a6b74',
    warn: '#a32000',
  },

  dark: {
    bg: '#0a0e14',

    ringFaint: '#121c24',
    ringStrong: '#1d3b47',
    ring: '#152b34',
    cardinal: '#24485a',
    ringLabel: '#3d5a68',

    airspaceHigh: '#2f5f8f',
    airspaceControl: '#a04080',
    airspaceLocal: '#8a7a30',
    airspaceLabel: '#7f8c99',

    runway: '#e6f7ff',
    runwayLabel: '#9fd4e6',
    centreline: '#1b4453',
    centrelineTick: '#2a6376',
    fafTick: '#00b8d4',

    navaid: '#00b8d4',
    navaidLabel: '#84dbec',
    navaidFreq: '#4a6b78',
    hold: '#c98a2a',

    neighbour: '#5a6b7c',
    neighbourLabel: '#7f8c99',

    text: '#c8d4e0',
    textDim: '#5a6b7c',
    accent: '#00e5ff',
    warn: '#ff5252',
  },
}

/** The active palette. Change this one word to swap the whole display. */
export const theme: Palette = palettes.beige

export const FONT_MONO = 'ui-monospace, "Cascadia Mono", Consolas, monospace'

export const fonts = {
  label: (px: number): string => `${px}px ${FONT_MONO}`,
  bold: (px: number): string => `bold ${px}px ${FONT_MONO}`,
} as const

/**
 * Airspace boundary colour by class: the high-level control area, the
 * control zones around each field, and the local class G traffic zones.
 */
export function airspaceColour(airspaceClass: string): string {
  if (airspaceClass === 'A' || airspaceClass === 'B' || airspaceClass === 'C') {
    return theme.airspaceHigh
  }
  if (airspaceClass === 'D' || airspaceClass === 'E') return theme.airspaceControl
  return theme.airspaceLocal
}

/** Vertical limit as it would appear on a chart: SFC, feet, or a level. */
export function formatLevel(ft: number): string {
  if (ft <= 0) return 'SFC'
  if (ft >= 10000) return `FL${Math.round(ft / 100)}`
  return String(ft)
}
