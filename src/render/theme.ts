/**
 * Every colour, font and line weight the scope draws with.
 *
 * One file, by design: tuning a radar display is done by eye, and hunting
 * hex codes across a dozen render modules is how palettes drift.
 *
 * Two complete palettes live here, described where they are defined
 * below. Accents are NOT shared between them: a colour that glows on black
 * turns to mud on beige, so each palette is tuned whole against its own
 * ground and the contrast is asserted in theme.test.ts.
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

  /**
   * Precipitation, in three bands. Green, amber, red on a colour tube; on
   * the monochrome one they cannot be told apart by hue, so they are
   * separated by brightness the way a single-gun display had to do it.
   */
  readonly wxLight: string
  readonly wxModerate: string
  readonly wxHeavy: string

  /**
   * Traffic. The boldest ink in every palette, because the map is context
   * and the traffic is the job. The trail is the same mark one step
   * quieter, so a history never competes with the target it belongs to.
   */
  readonly target: string
  readonly trail: string

  readonly neighbour: string
  readonly neighbourLabel: string

  /**
   * The map underneath the airspace: the coastline, and the lateral limit
   * of the flight information region. The coast is furniture -- it is
   * there to orient you and must not compete with traffic -- while the FIR
   * boundary is a real airspace limit and is read as one.
   */
  readonly coast: string
  readonly fir: string

  readonly text: string
  readonly textDim: string
  readonly accent: string
  readonly warn: string

  /**
   * Chrome: the raised and sunken panel faces that give the interface its
   * period look. Bevels are drawn as a light edge on the top and left and a
   * shadow edge on the bottom and right, so both need to exist per palette
   * rather than being derived with a filter.
   */
  readonly chromeFace: string
  readonly chromeLight: string
  readonly chromeShadow: string
  readonly chromeText: string
  readonly chromeDim: string
  readonly chromeWell: string
  /** Panel caption strip -- the most period detail in the whole interface. */
  readonly chromeTitleBar: string
  readonly chromeTitleText: string
}

/**
 * Two period palettes.
 *
 * `beige` takes its cue from the desktop software of the era rather than
 * from a modern light theme: a warm tan tube, an interface face in the
 * canonical #d4d0c8 with white and grey bevels, and symbology drawn from
 * the VGA system colours -- navy, teal, olive, maroon, purple. Those
 * colours are dark and saturated, which is exactly what stays readable on
 * a light ground where a modern neon would turn to mud.
 *
 * `dark` is the same instrument as a colour CRT: near-black with bright
 * cyan symbology and phosphor amber for anything the controller is holding
 * in mind.
 *
 * Accents are never shared between the two. Each palette is tuned whole
 * against its own ground, and theme.test.ts asserts the contrast so a
 * later tweak cannot quietly make the display unreadable.
 */
export const palettes = {
  beige: {
    bg: '#c3bda9',

    ringFaint: '#b4ae9a',
    ring: '#9a9482',
    ringStrong: '#7c7663',
    cardinal: '#8a8472',
    ringLabel: '#55503f',

    // VGA system navy, purple and olive: class A, the control zones, and
    // class G, in that order of authority.
    airspaceHigh: '#000080',
    airspaceControl: '#7a0060',
    airspaceLocal: '#6b6a00',
    airspaceLabel: '#46422f',

    runway: '#1a1a14',
    runwayLabel: '#2b2a1e',
    centreline: '#6b6552',
    centrelineTick: '#524d3c',
    fafTick: '#006e74',

    navaid: '#00686e',
    navaidLabel: '#00565c',
    navaidFreq: '#5f5a48',
    hold: '#8a4e00',

    // Dark and saturated, because a pale green on tan is a smudge.
    wxLight: '#2f6b2a',
    wxModerate: '#7a5c00',
    wxHeavy: '#8f1f14',

    // VGA dark green: the one bold ink the rest of this palette leaves
    // free, so traffic cannot be mistaken for a runway or a boundary.
    target: '#0e4a1c',
    trail: '#5f7a66',

    neighbour: '#46422f',
    neighbourLabel: '#3a3625',

    // Slate for the shoreline, against the tan ground; a darker slate
    // for the FIR limit, kept clear of the navy and purple used by the
    // controlled airspace.
    coast: '#7f8c96',
    fir: '#2f4858',

    text: '#1c1a14',
    textDim: '#4e4939',
    accent: '#006e74',
    warn: '#a00000',

    // The canonical button face of the era, with a white highlight and a
    // mid-grey shadow. Nothing dates an interface faster than getting
    // these three wrong.
    chromeFace: '#d4d0c8',
    chromeLight: '#ffffff',
    chromeShadow: '#808080',
    chromeText: '#1c1a14',
    chromeDim: '#565246',
    chromeWell: '#aeaaa2',
    // Navy with white lettering: nothing else says this decade so quickly.
    chromeTitleBar: '#000080',
    chromeTitleText: '#ffffff',
  },

  dark: {
    bg: '#080e13',

    ringFaint: '#0d1a21',
    ring: '#13303c',
    ringStrong: '#1d4756',
    cardinal: '#245363',
    ringLabel: '#3f6d80',

    airspaceHigh: '#5a8ad8',
    airspaceControl: '#d060b0',
    airspaceLocal: '#b0a030',
    airspaceLabel: '#8092a0',

    runway: '#e8f8ff',
    runwayLabel: '#9fd4e6',
    centreline: '#1b4152',
    centrelineTick: '#2d7089',
    fafTick: '#00e0c8',

    navaid: '#00c8d8',
    navaidLabel: '#7fdcea',
    navaidFreq: '#4a707e',
    // Phosphor amber, for the fixes traffic is actually holding at.
    hold: '#ffb000',

    wxLight: '#29a05a',
    wxModerate: '#d9c020',
    wxHeavy: '#e0452f',

    target: '#40ff80',
    trail: '#217a42',

    neighbour: '#5a6b7a',
    neighbourLabel: '#8092a0',

    // Dim slate for the shoreline; a lighter slate for the FIR limit,
    // kept clear of the blue and magenta used by controlled airspace.
    coast: '#26414c',
    fir: '#6a7f95',

    text: '#c4dae6',
    textDim: '#5c7382',
    accent: '#00e5ff',
    warn: '#ff5252',

    chromeFace: '#18222b',
    chromeLight: '#3d5162',
    chromeShadow: '#040709',
    chromeText: '#c4dae6',
    chromeDim: '#6c8494',
    chromeWell: '#0d151c',
    chromeTitleBar: '#123c52',
    chromeTitleText: '#cfe6f2',
  },
  /**
   * An amber phosphor tube. Monochrome by intent, which means the airspace
   * classes cannot be told apart by hue -- they are separated by brightness
   * instead, the way a single-gun display had to. The brightest thing on
   * the scope is what traffic is holding at.
   */
  amber: {
    bg: '#140d03',

    ringFaint: '#241804',
    ring: '#3d2a08',
    ringStrong: '#5c400e',
    cardinal: '#4e360b',
    ringLabel: '#a87516',

    airspaceHigh: '#8a6412',
    airspaceControl: '#c28a1a',
    airspaceLocal: '#805c12',
    airspaceLabel: '#a87c28',

    runway: '#ffd9a0',
    runwayLabel: '#e6b055',
    centreline: '#4a3308',
    centrelineTick: '#96690f',
    fafTick: '#ffb000',

    navaid: '#e89600',
    navaidLabel: '#ffc860',
    navaidFreq: '#96702a',
    hold: '#fff2cc',

    // A brightness ladder rather than three hues.
    wxLight: '#946820',
    wxModerate: '#bd8720',
    wxHeavy: '#f5b43e',

    target: '#ffe9bd',
    trail: '#a87516',

    neighbour: '#96702a',
    neighbourLabel: '#c2913a',

    // Monochrome, so the two are separated by brightness: the shoreline
    // sits with the grid furniture, the FIR limit well above it.
    coast: '#5c4210',
    fir: '#b8801a',

    text: '#ffcf80',
    textDim: '#b3822c',
    accent: '#ffb000',
    warn: '#ff6a1a',

    chromeFace: '#2b1d07',
    chromeLight: '#634516',
    chromeShadow: '#0d0801',
    chromeText: '#ffcf80',
    chromeDim: '#bb8c32',
    chromeWell: '#170f03',
    chromeTitleBar: '#5c3f0d',
    chromeTitleText: '#ffe4ad',
  },
} satisfies Record<string, Palette>

export type PaletteName = keyof typeof palettes

/**
 * Cycle order for the display control. Beige first because it is the
 * shipped look; amber last because it is the most opinionated.
 */
export const PALETTE_ORDER: readonly PaletteName[] = ['beige', 'dark', 'amber']

export function isPaletteName(value: unknown): value is PaletteName {
  return typeof value === 'string' && (PALETTE_ORDER as readonly string[]).includes(value)
}

type Writable<T> = { -readonly [K in keyof T]: T[K] }

/** Beige is the shipped default; the button switches away from it. */
const DEFAULT_PALETTE: PaletteName = 'beige'

/**
 * The active palette, exported as a live object rather than a value. Every
 * render module holds this same reference, so switching schemes mutates it
 * in place and the next frame simply picks up the new colours -- no
 * re-wiring, no palette argument threaded through every draw call.
 */
const active: Writable<Palette> = { ...palettes[DEFAULT_PALETTE] }
export const theme: Palette = active

let activeName: PaletteName = DEFAULT_PALETTE

export function paletteName(): PaletteName {
  return activeName
}

export function setPalette(name: PaletteName): void {
  Object.assign(active, palettes[name])
  activeName = name
}

/** The next scheme in the cycle, without switching to it. */
export function nextPaletteName(): PaletteName {
  const i = PALETTE_ORDER.indexOf(activeName)
  return PALETTE_ORDER[(i + 1) % PALETTE_ORDER.length] ?? 'beige'
}

/** Advances to the next scheme and returns it. */
export function cyclePalette(): PaletteName {
  setPalette(nextPaletteName())
  return activeName
}

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
