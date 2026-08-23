// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { Logon, validateInitials, type LogonDetails } from './logon'

/**
 * The main menu is a gate: nothing starts until it reports a valid logon.
 * These hold it to that, and to not inventing a settings implementation of
 * its own.
 */

interface Harness {
  logon: Logon
  mount: HTMLElement
  logons: LogonDetails[]
  tutorials: LogonDetails[]
  fields: string[]
  settings: number
}

let live: Logon | null = null

function mountLogon(over: { initials?: string; enforceAirspace?: boolean } = {}): Harness {
  const initials = over.initials ?? ''
  document.body.innerHTML = ''
  const mount = document.createElement('div')
  document.body.appendChild(mount)

  const h: Harness = {
    logon: null as unknown as Logon,
    mount,
    logons: [],
    tutorials: [],
    fields: [],
    settings: 0,
  }

  h.logon = new Logon({
    mount,
    title: 'EGLL APPROACH',
    subtitle: 'London Heathrow',
    position: 'EGLL_APP',
    facts: ['Sector 40 NM -- 1500 to FL150', '4 holds -- LAM BIG BNN OCK'],
    initials,
    enforceAirspace: over.enforceAirspace ?? true,
    difficulty: 'normal',
    mode: 'career',
    startPaused: true,
    airports: [
      {
        icao: 'LPFR',
        name: 'Faro',
        shortName: 'Faro',
        tier: 'easy',
        challenge: 'One runway and open sea.',
        brief: 'One runway and the sea.',
      },
      {
        icao: 'EGLL',
        name: 'London Heathrow',
        shortName: 'Heathrow',
        tier: 'normal',
        challenge: 'Four stacks and two parallels.',
        brief: 'Four stacks and two parallels.',
      },
    ],
    airport: 'EGLL',
    onAirport: (icao) => h.fields.push(icao),
    onLogon: (d) => h.logons.push(d),
    onTutorial: (d) => h.tutorials.push(d),
    onSettings: () => {
      h.settings += 1
    },
  })
  live = h.logon
  return h
}

afterEach(() => {
  live?.destroy()
  live = null
})

const input = (m: HTMLElement): HTMLInputElement => {
  const el = m.querySelector<HTMLInputElement>('.logon-input')
  if (!el) throw new Error('no initials field')
  return el
}

const button = (m: HTMLElement, cls: string): HTMLButtonElement => {
  const el = m.querySelector<HTMLButtonElement>(cls)
  if (!el) throw new Error(`no ${cls}`)
  return el
}

const error = (m: HTMLElement): HTMLElement => {
  const el = m.querySelector<HTMLElement>('.logon-error')
  if (!el) throw new Error('no error line')
  return el
}

/** Simulates typing, which is what triggers the input handler. */
function type(el: HTMLInputElement, value: string): void {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('validateInitials', () => {
  it('accepts two or three letters', () => {
    expect(validateInitials('NF')).toBe('NF')
    expect(validateInitials('abc')).toBe('ABC')
    expect(validateInitials('  nf  ')).toBe('NF')
  })

  it('rejects anything that is not a set of initials', () => {
    expect(validateInitials('')).toBeNull()
    expect(validateInitials('N')).toBeNull()
    expect(validateInitials('ABCD')).toBeNull()
    expect(validateInitials('N1')).toBeNull()
    expect(validateInitials('N F')).toBeNull()
  })
})

describe('the main menu', () => {
  it('shows what the radar has loaded', () => {
    // The boot summary doubles as a data check: an empty list here means
    // the airport config did not load.
    const { mount } = mountLogon()
    const facts = [...mount.querySelectorAll('.logon-facts li')].map((l) => l.textContent)
    expect(facts).toHaveLength(2)
    expect(facts[0]).toContain('40 NM')
  })

  it('names the position being worked', () => {
    const { mount } = mountLogon()
    expect(mount.querySelector('.logon-output')?.textContent).toBe('EGLL_APP')
    expect(mount.querySelector('.logon-brand')?.textContent).toBe('EGLL APPROACH')
  })

  it('asks for no credential of any kind', () => {
    // It is a position logon, not an account. A password box would imply
    // something is being checked, and nothing is.
    const { mount } = mountLogon()
    expect(mount.querySelector('input[type="password"]')).toBeNull()
    expect(mount.querySelectorAll('input[type="text"]')).toHaveLength(1)
    expect(mount.querySelector('.logon-foot')?.textContent).toMatch(/no password/i)
  })

  it('reports a valid logon with the position', () => {
    const h = mountLogon()
    type(input(h.mount), 'NF')
    button(h.mount, '.logon-go').click()
    expect(h.logons).toEqual([
      {
        initials: 'NF',
        position: 'EGLL_APP',
        enforceAirspace: true,
        difficulty: 'normal',
        mode: 'career',
        startPaused: true,
      },
    ])
  })

  it('upper-cases and filters as you type', () => {
    // Operating initials are always written in capitals, and correcting it
    // after the fact reads as a rejection.
    const h = mountLogon()
    type(input(h.mount), 'n7f!')
    expect(input(h.mount).value).toBe('NF')
  })

  it('refuses a logon it cannot use, and says why', () => {
    const h = mountLogon()
    type(input(h.mount), 'N')
    button(h.mount, '.logon-go').click()
    expect(h.logons).toHaveLength(0)
    expect(error(h.mount).hidden).toBe(false)
    expect(error(h.mount).textContent).toMatch(/letters/)
    expect(input(h.mount).getAttribute('aria-invalid')).toBe('true')
  })

  it('clears the complaint as soon as you start fixing it', () => {
    const h = mountLogon()
    button(h.mount, '.logon-go').click()
    expect(error(h.mount).hidden).toBe(false)
    type(input(h.mount), 'NF')
    expect(error(h.mount).hidden).toBe(true)
    expect(input(h.mount).hasAttribute('aria-invalid')).toBe(false)
  })

  it('logs on from the keyboard', () => {
    const h = mountLogon()
    type(input(h.mount), 'ABC')
    input(h.mount).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(h.logons).toEqual([
      {
        initials: 'ABC',
        position: 'EGLL_APP',
        enforceAirspace: true,
        difficulty: 'normal',
        mode: 'career',
        startPaused: true,
      },
    ])
  })

  it('prefills remembered initials', () => {
    expect(input(mountLogon({ initials: 'NF' }).mount).value).toBe('NF')
  })

  it('hands the display settings off rather than reimplementing them', () => {
    // The same options menu the scope uses, so a change made before logging
    // on is the change that applies afterwards.
    const h = mountLogon()
    button(h.mount, '.logon-settings').click()
    expect(h.settings).toBe(1)
    // The checkboxes it does carry are decisions about the shift rather
    // than about the display: the airspace rule, which cannot be changed
    // part way through one, and whether the clock is running when you
    // arrive, which can only be answered before it is.
    const boxes = h.mount.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    expect(boxes).toHaveLength(2)
    for (const box of boxes) expect(box.className).toContain('logon-toggle')
  })

  it('stays up until it is dismissed', () => {
    const h = mountLogon()
    expect(h.logon.visible).toBe(true)
    h.logon.hide()
    expect(h.logon.visible).toBe(false)
    expect(h.mount.querySelector<HTMLElement>('.logon')?.hidden).toBe(true)
    h.logon.show()
    expect(h.logon.visible).toBe(true)
  })

  it('is a modal dialog as far as assistive technology is concerned', () => {
    const el = mountLogon().mount.querySelector('.logon')
    expect(el?.getAttribute('role')).toBe('dialog')
    expect(el?.getAttribute('aria-modal')).toBe('true')
  })
})

describe('the airspace rule', () => {
  const toggle = (mount: HTMLElement): HTMLInputElement => {
    const box = mount.querySelector<HTMLInputElement>('.logon-toggle')
    if (!box) throw new Error('no airspace toggle')
    return box
  }

  it('starts from what the last session chose', () => {
    expect(toggle(mountLogon({ enforceAirspace: true }).mount).checked).toBe(true)
    expect(toggle(mountLogon({ enforceAirspace: false }).mount).checked).toBe(false)
  })

  it('reports it with the logon, on', () => {
    const h = mountLogon()
    type(input(h.mount), 'NF')
    button(h.mount, '.logon-go').click()
    expect(h.logons[0]?.enforceAirspace).toBe(true)
  })

  it('reports it with the logon, off', () => {
    const h = mountLogon()
    type(input(h.mount), 'NF')
    toggle(h.mount).checked = false
    button(h.mount, '.logon-go').click()
    expect(h.logons[0]?.enforceAirspace).toBe(false)
  })

  it('says what it means, since it changes how the game plays', () => {
    const { mount } = mountLogon()
    const row = mount.querySelector('.logon-check')
    expect(row?.getAttribute('title') ?? '').toMatch(/dimmed/i)
    expect(mount.querySelector('.logon-note')?.textContent ?? '').toMatch(/inside/i)
  })
})

describe('starting the tutorial from the menu', () => {
  it('offers it beside logging on', () => {
    // The choice belongs here rather than on the tool rail: it is a decision
    // about what this sitting is for, and that is answered before there is
    // any traffic rather than half way through working it.
    const { mount } = mountLogon({ initials: 'NF' })
    expect(mount.querySelector('.logon-tutorial')).not.toBeNull()
  })

  it('comes on position the same way a free session does', () => {
    // The lesson stops the clock, replaces the traffic and expects
    // clearances to be accepted, so it is a way INTO a session rather than
    // an alternative to one.
    const h = mountLogon({ initials: 'nf' })
    button(h.mount, '.logon-tutorial').click()
    expect(h.tutorials).toHaveLength(1)
    expect(h.tutorials[0]?.initials).toBe('NF')
    expect(h.tutorials[0]?.position).toBe('EGLL_APP')
    // And not down the other path: one press is one session.
    expect(h.logons).toHaveLength(0)
  })

  it('carries the airspace choice into the lesson', () => {
    const h = mountLogon({ initials: 'NF', enforceAirspace: true })
    const box = h.mount.querySelector<HTMLInputElement>('.logon-toggle')
    if (box === null) throw new Error('no airspace toggle')
    box.checked = false
    button(h.mount, '.logon-tutorial').click()
    expect(h.tutorials[0]?.enforceAirspace).toBe(false)
  })

  it('checks the initials like the other way in', () => {
    // One validation path. A lesson started without initials would be a
    // session with nobody on position.
    const h = mountLogon({ initials: 'X' })
    button(h.mount, '.logon-tutorial').click()
    expect(h.tutorials).toHaveLength(0)
    expect(h.mount.querySelector<HTMLElement>('.logon-error')?.hidden).toBe(false)
  })
})

describe('choosing a sector', () => {
  const fields = (mount: HTMLElement): HTMLButtonElement[] => [
    ...mount.querySelectorAll<HTMLButtonElement>('.logon-sector'),
  ]

  it('names them rather than showing the code', () => {
    // Somebody choosing where to fly knows "Heathrow". "EGLL" is what the
    // strip bay calls it afterwards.
    const { mount } = mountLogon()
    expect(fields(mount).map((b) => b.textContent)).toEqual(['Faro', 'Heathrow'])
  })

  it('keeps the code where it is still useful', () => {
    const { mount } = mountLogon()
    expect(fields(mount)[0]?.title).toContain('LPFR')
  })

  it('lights the one that is loaded, not the one under the cursor', () => {
    // Hovering is reading, not choosing. An earlier version repainted on
    // hover in a way that made the panel change shape under the pointer.
    const { mount } = mountLogon()
    const nice = fields(mount)[0]
    nice?.dispatchEvent(new Event('pointerenter'))
    const lit = fields(mount).filter((b) => b.classList.contains('is-on'))
    expect(lit.map((b) => b.textContent)).toEqual(['Heathrow'])
  })

  it('describes the one under the cursor without changing the choice', () => {
    const h = mountLogon()
    const faro = fields(h.mount)[0]
    faro?.dispatchEvent(new Event('pointerenter'))
    expect(h.mount.querySelector('.logon-sector-note')?.textContent).toContain('EASY')
    expect(h.fields).toEqual([])
  })

  it('asks for a different sector when one is pressed', () => {
    const h = mountLogon()
    fields(h.mount)[0]?.click()
    expect(h.fields).toEqual(['LPFR'])
  })
})
