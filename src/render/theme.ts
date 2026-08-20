/**
 * Every colour, font and line weight the scope draws with.
 *
 * One file, by design: tuning a radar display is done by eye, and hunting
 * hex codes across a dozen render modules is how palettes drift.
 *
 * NOTE (ARCHITECTURE.md open question 1): the design doc describes the
 * background as "charcoal slate beige" without a hex, which reads as a
 * conflict between a near-black and a warm light tone. This palette assumes
 * a DARK ground. Switching to a light one is not just changing `bg` -- the
 * teal and cyan accents below would all need darkening and desaturating to
 * stay legible, so treat that as a deliberate repaint rather than a toggle.
 */
export const theme = {
  bg: '#0a0e14',

  ring: '#152b34',
  ringStrong: '#1d3b47',
  ringLabel: '#3d5a68',
  cardinal: '#24485a',

  runway: '#e6f7ff',
  runwayLabel: '#9fd4e6',

  centreline: '#1b4453',
  centrelineTick: '#2a6376',
  fafTick: '#00b8d4',

  fix: '#00b8d4',
  fixLabel: '#84dbec',
  fixHold: '#1a5566',

  text: '#c8d4e0',
  textDim: '#5a6b7c',
  accent: '#00e5ff',

  fontMono: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
} as const

export const fonts = {
  label: (px: number): string => `${px}px ${theme.fontMono}`,
} as const
