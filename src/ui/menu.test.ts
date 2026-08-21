// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { SPEEDS, formatSpeed, type Speed } from '../core/loop'
import {
  OVERLAY_ITEMS,
  OVERLAY_PRESETS,
  densityOf,
  type Overlays,
} from '../render/overlays'
import { PALETTE_ORDER, type PaletteName } from '../render/theme'
import { Menu, type MenuState } from './menu'

/**
 * The menu is a view: it reports clicks and is told what to show. These
 * tests hold it to both halves of that -- that every control reaches its
 * callback, and that `paint` is the only thing that changes what is
 * displayed, so a change made by keyboard cannot leave the menu lying.
 */

const state = (over: Partial<MenuState> = {}): MenuState => ({
  overlays: OVERLAY_PRESETS.standard,
  palette: 'beige',
  speed: 1,
  paused: false,
  muted: false,
  ...over,
})

interface Harness {
  menu: Menu
  mount: HTMLElement
  overlays: Overlays[]
  palettes: PaletteName[]
  speeds: Speed[]
  pauses: number
  sounds: number
  saves: number
  loads: number
}

let live: Menu | null = null

function mountMenu(): Harness {
  document.body.innerHTML = ''
  const mount = document.createElement('div')
  document.body.appendChild(mount)

  const h: Harness = {
    menu: null as unknown as Menu,
    mount,
    overlays: [],
    palettes: [],
    speeds: [],
    pauses: 0,
    sounds: 0,
    saves: 0,
    loads: 0,
  }

  h.menu = new Menu({
    mount,
    onOverlays: (next) => h.overlays.push(next),
    onPalette: (next) => h.palettes.push(next),
    onSpeed: (next) => h.speeds.push(next),
    onTogglePause: () => {
      h.pauses += 1
    },
    onSave: () => {
      h.saves += 1
    },
    onLoad: () => {
      h.loads += 1
    },
    onToggleSound: () => {
      h.sounds += 1
    },
  })
  live = h.menu
  h.menu.paint(state())
  return h
}

afterEach(() => {
  // The menu listens on document for Escape and outside clicks, so a menu
  // left mounted would keep answering events in the next test.
  live?.destroy()
  live = null
})

const button = (mount: HTMLElement): HTMLButtonElement => {
  const b = mount.querySelector<HTMLButtonElement>('.menu-button')
  if (!b) throw new Error('no menu button')
  return b
}

const panel = (mount: HTMLElement): HTMLDivElement => {
  const p = mount.querySelector<HTMLDivElement>('.menu-panel')
  if (!p) throw new Error('no menu panel')
  return p
}

/** Finds a control by its visible text, which is how a player finds it. */
function keyed(mount: HTMLElement, text: string): HTMLButtonElement {
  const all = [...mount.querySelectorAll<HTMLButtonElement>('.menu-key')]
  const found = all.find((b) => b.textContent === text)
  if (!found) throw new Error(`no key labelled ${text} in ${all.map((b) => b.textContent).join(',')}`)
  return found
}

/** The checkbox on the row whose label reads `text`. */
function checkbox(mount: HTMLElement, text: string): HTMLInputElement {
  const rows = [...mount.querySelectorAll<HTMLLabelElement>('.menu-row')]
  const row = rows.find((r) => r.textContent === text)
  if (!row) throw new Error(`no row labelled ${text}`)
  const box = row.querySelector<HTMLInputElement>('input')
  if (!box) throw new Error(`row ${text} has no checkbox`)
  return box
}

const clickOutside = (): void => {
  document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
}

const press = (key: string): void => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
}

describe('opening and closing', () => {
  it('starts closed', () => {
    const { mount } = mountMenu()
    expect(panel(mount).hidden).toBe(true)
    expect(button(mount).getAttribute('aria-expanded')).toBe('false')
  })

  it('opens and closes from its own button', () => {
    const { mount, menu } = mountMenu()
    button(mount).click()
    expect(menu.open).toBe(true)
    expect(panel(mount).hidden).toBe(false)
    expect(button(mount).getAttribute('aria-expanded')).toBe('true')
    button(mount).click()
    expect(menu.open).toBe(false)
    expect(panel(mount).hidden).toBe(true)
  })

  it('reads as pressed in while it is showing', () => {
    // The affordance a toolbar toggle of this era had, and the only clue
    // that the button and the panel are the same control.
    const { mount, menu } = mountMenu()
    expect(button(mount).classList.contains('is-open')).toBe(false)
    menu.setOpen(true)
    expect(button(mount).classList.contains('is-open')).toBe(true)
  })

  it('closes on Escape', () => {
    const { menu } = mountMenu()
    menu.setOpen(true)
    press('Escape')
    expect(menu.open).toBe(false)
  })

  it('closes when something else is clicked', () => {
    const { menu } = mountMenu()
    menu.setOpen(true)
    clickOutside()
    expect(menu.open).toBe(false)
  })

  it('stays open while its own controls are used', () => {
    // Otherwise setting three overlays would mean opening the menu three
    // times.
    const { mount, menu } = mountMenu()
    menu.setOpen(true)
    checkbox(mount, 'Range rings').click()
    keyed(mount, formatSpeed(2)).click()
    expect(menu.open).toBe(true)
  })

  it('ignores Escape when already closed', () => {
    const { menu } = mountMenu()
    press('Escape')
    expect(menu.open).toBe(false)
  })
})

describe('simulation rate', () => {
  it('offers every rate the loop supports', () => {
    // Enumerated from SPEEDS, so a rate cannot exist in the loop without
    // being reachable here.
    const { mount } = mountMenu()
    for (const speed of SPEEDS) {
      expect(() => keyed(mount, formatSpeed(speed))).not.toThrow()
    }
  })

  it('reports the rate that was picked', () => {
    const { mount, speeds } = mountMenu()
    keyed(mount, formatSpeed(4)).click()
    keyed(mount, formatSpeed(0.5)).click()
    expect(speeds).toEqual([4, 0.5])
  })

  it('shows the running rate pressed in', () => {
    const { mount, menu } = mountMenu()
    menu.paint(state({ speed: 2 }))
    expect(keyed(mount, formatSpeed(2)).classList.contains('is-active')).toBe(true)
    expect(keyed(mount, formatSpeed(1)).classList.contains('is-active')).toBe(false)
  })

  it('shows no rate as running while paused', () => {
    // Paused is not a rate: showing 1x pressed in while the clock is
    // stopped would say the simulation is running.
    const { mount, menu } = mountMenu()
    menu.paint(state({ paused: true, speed: 1 }))
    for (const speed of SPEEDS) {
      expect(keyed(mount, formatSpeed(speed)).classList.contains('is-active')).toBe(false)
    }
  })

  it('flips the pause control between pause and resume', () => {
    const h = mountMenu()
    const pause = h.mount.querySelector<HTMLButtonElement>('.menu-pause')
    if (!pause) throw new Error('no pause button')
    expect(pause.textContent).toBe('||')
    h.menu.paint(state({ paused: true }))
    expect(pause.textContent).toBe('>')
    expect(pause.title).toContain('Resume')
    pause.click()
    expect(h.pauses).toBe(1)
  })
})

describe('display scheme', () => {
  it('offers every scheme, by name', () => {
    // Named buttons rather than a cycling toggle: picking beats pressing
    // until the one you want comes round.
    const { mount } = mountMenu()
    for (const name of PALETTE_ORDER) {
      expect(() => keyed(mount, name.toUpperCase())).not.toThrow()
    }
  })

  it('reports the scheme that was picked', () => {
    const { mount, palettes } = mountMenu()
    keyed(mount, 'AMBER').click()
    expect(palettes).toEqual(['amber'])
  })

  it('shows the active scheme pressed in', () => {
    const { mount, menu } = mountMenu()
    menu.paint(state({ palette: 'dark' }))
    expect(keyed(mount, 'DARK').classList.contains('is-active')).toBe(true)
    expect(keyed(mount, 'BEIGE').classList.contains('is-active')).toBe(false)
  })

  it('follows a scheme change made by keyboard', () => {
    // D still cycles the palette without opening the menu, so paint has to
    // be what decides the display -- not the last button pressed here.
    const { mount, menu } = mountMenu()
    keyed(mount, 'BEIGE').click()
    menu.paint(state({ palette: 'amber' }))
    expect(keyed(mount, 'AMBER').classList.contains('is-active')).toBe(true)
    expect(keyed(mount, 'BEIGE').classList.contains('is-active')).toBe(false)
  })
})

describe('interface sound', () => {
  it('is shown set when sound is on', () => {
    const { mount, menu } = mountMenu()
    expect(checkbox(mount, 'Interface sound').checked).toBe(true)
    menu.paint(state({ muted: true }))
    expect(checkbox(mount, 'Interface sound').checked).toBe(false)
  })

  it('reports a toggle', () => {
    const h = mountMenu()
    checkbox(h.mount, 'Interface sound').click()
    expect(h.sounds).toBe(1)
  })
})

describe('overlays', () => {
  it('has a control for every optional layer', () => {
    // The invariant from render/overlays.ts: a layer cannot exist in the
    // render path without being switchable.
    const { mount } = mountMenu()
    for (const item of OVERLAY_ITEMS) {
      expect(() => checkbox(mount, item.label)).not.toThrow()
    }
  })

  it('reports the whole record with one key flipped', () => {
    const h = mountMenu()
    const standard = OVERLAY_PRESETS.standard
    checkbox(h.mount, 'Range rings').click()
    expect(h.overlays).toHaveLength(1)
    expect(h.overlays[0]).toEqual({ ...standard, rangeRings: false })
  })

  it('builds each change on the state it was last painted with', () => {
    // Not on its own idea of the state: main.ts owns the record, and a
    // change it rejected or altered must not be assumed to have stuck.
    const h = mountMenu()
    h.menu.paint(state({ overlays: OVERLAY_PRESETS.minimal }))
    checkbox(h.mount, 'Other aerodromes').click()
    expect(h.overlays[0]).toEqual({ ...OVERLAY_PRESETS.minimal, aerodromes: true })
  })

  it('cycles the presets from one button', () => {
    const h = mountMenu()
    const preset = h.mount.querySelector<HTMLButtonElement>('.menu-preset')
    if (!preset) throw new Error('no preset button')
    expect(preset.textContent).toBe('PRESET: STANDARD')
    preset.click()
    expect(h.overlays[0]).toEqual(OVERLAY_PRESETS.full)
  })

  it('names a hand-made combination as custom', () => {
    const h = mountMenu()
    const mixed: Overlays = { ...OVERLAY_PRESETS.standard, navaidFreqs: true }
    h.menu.paint(state({ overlays: mixed }))
    expect(densityOf(mixed)).toBe('custom')
    const preset = h.mount.querySelector<HTMLButtonElement>('.menu-preset')
    expect(preset?.textContent).toBe('PRESET: CUSTOM')
  })

  it('keeps the boxes in step with a record set from outside', () => {
    const { mount, menu } = mountMenu()
    menu.paint(state({ overlays: OVERLAY_PRESETS.minimal }))
    expect(checkbox(mount, 'Range rings').checked).toBe(true)
    expect(checkbox(mount, 'Controlled airspace').checked).toBe(false)
    menu.paint(state({ overlays: OVERLAY_PRESETS.full }))
    expect(checkbox(mount, 'Controlled airspace').checked).toBe(true)
  })
})

describe('structure', () => {
  it('groups the controls under headings', () => {
    const { mount } = mountMenu()
    const headings = [...mount.querySelectorAll('.menu-heading')].map((h) => h.textContent)
    expect(headings).toEqual(['Simulation', 'Display scheme', 'Session', 'Overlays'])
  })

  it('mounts exactly one panel, inside the element it was given', () => {
    const { mount } = mountMenu()
    expect(mount.querySelectorAll('.menu-panel')).toHaveLength(1)
    expect(mount.querySelector('.menu')?.parentElement).toBe(mount)
  })

  it('takes itself out of the document when destroyed', () => {
    const { mount, menu } = mountMenu()
    menu.destroy()
    expect(mount.querySelector('.menu')).toBeNull()
    // And stops answering the document, so a stale menu cannot swallow an
    // Escape meant for whatever replaced it.
    expect(() => press('Escape')).not.toThrow()
  })
})

describe('saving and loading', () => {
  const sessionButtons = (mount: HTMLElement): HTMLButtonElement[] => {
    const section = [...mount.querySelectorAll('.menu-section')].find(
      (s) => s.querySelector('.menu-heading')?.textContent === 'Session',
    )
    if (!section) throw new Error('no Session section')
    return [...section.querySelectorAll<HTMLButtonElement>('button')]
  }

  it('offers a save and a load', () => {
    const { mount } = mountMenu()
    expect(sessionButtons(mount).map((b) => b.textContent)).toEqual(['SAVE', 'LOAD'])
  })

  it('reports a save', () => {
    const h = mountMenu()
    sessionButtons(h.mount)[0]?.click()
    expect(h.saves).toBe(1)
    expect(h.loads).toBe(0)
  })

  it('reports a load', () => {
    const h = mountMenu()
    sessionButtons(h.mount)[1]?.click()
    expect(h.loads).toBe(1)
    expect(h.saves).toBe(0)
  })

  it('says what each one does, since neither is undoable', () => {
    const { mount } = mountMenu()
    for (const b of sessionButtons(mount)) {
      expect(b.title.length, b.textContent ?? '').toBeGreaterThan(10)
    }
  })
})
