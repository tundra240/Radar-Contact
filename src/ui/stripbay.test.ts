// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import type { Aircraft, NavMode } from '../sim/types'
import { StripBay, type StripBayOptions } from './stripbay'

const base: Aircraft = {
  callsign: 'BAW178',
  type: 'A320',
  wake: 'M',
  pos: { x: 10, y: 5 },
  altFt: 7000,
  hdg: 250,
  gsKts: 240,
  vsFpm: -1200,
  clearedHdg: 250,
  clearedAltFt: 5000,
  clearedSpdKts: 220,
  navMode: 'VECTOR',
  clearedApproach: null,
  hold: null,
  originFix: 'LAM',
  trail: [],
  trailAt: 0,
  spawnedAt: 0,
}

function ac(over: Partial<Aircraft>): Aircraft {
  return { ...base, ...over }
}

/** An approach clearance, for the fields a strip and a status line read. */
const ILS_27R = {
  runway: '27R',
  thresholdNM: { x: 1.4, y: -0.3 },
  courseTrue: 270,
  thresholdElevationFt: 83,
  glideslopeDeg: 3,
  fafDistNM: 10,
  maxInterceptDeg: 30,
  interceptAltMaxFt: 3000,
}

interface Harness {
  bay: StripBay
  mount: HTMLElement
  menus: { callsign: string; at: { x: number; y: number } }[]
  selections: (string | null)[]
  layoutChanges: number
}

function mountBay(extra?: { demo?: boolean }): Harness {
  document.body.innerHTML = ''
  const mount = document.createElement('div')
  document.body.appendChild(mount)

  const menus: { callsign: string; at: { x: number; y: number } }[] = []
  const selections: (string | null)[] = []
  const state = { layoutChanges: 0 }

  const opts: StripBayOptions = {
    mount,
    onContextMenu: (callsign, at) => menus.push({ callsign, at: { x: at.x, y: at.y } }),
    onSelect: (s) => selections.push(s),
    onLayoutChange: () => {
      state.layoutChanges += 1
    },
    ...(extra?.demo !== undefined ? { demo: extra.demo } : {}),
  }

  const bay = new StripBay(opts)
  return {
    bay,
    mount,
    menus,
    selections,
    get layoutChanges() {
      return state.layoutChanges
    },
  } as Harness
}

const strips = (): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>('.strip')]

const callsigns = (): string[] => strips().map((s) => s.dataset['callsign'] ?? '')

let h: Harness

beforeEach(() => {
  h = mountBay()
})

describe('strip bay structure', () => {
  it('starts empty and says why', () => {
    expect(strips()).toHaveLength(0)
    const empty = document.querySelector('.strip-empty')
    expect(empty?.textContent).toMatch(/nothing on frequency/i)
    expect((empty as HTMLElement).hidden).toBe(false)
  })

  it('counts the sequence and the stack separately', () => {
    // How much is parked is as much of the picture as how much is running.
    const count = (): string | undefined =>
      document.querySelector('.strip-count')?.textContent ?? undefined
    expect(count()).toBe('0 SEQ / 0 HOLD')
    h.bay.update([base, ac({ callsign: 'VIR45' })], null)
    expect(count()).toBe('2 SEQ / 0 HOLD')
    h.bay.update([base, ac({ callsign: 'VIR45', navMode: 'HOLD' })], null)
    expect(count()).toBe('1 SEQ / 1 HOLD')
  })

  it('hides the empty notice once there is traffic', () => {
    h.bay.update([base], null)
    expect((document.querySelector('.strip-empty') as HTMLElement).hidden).toBe(true)
  })

  it('badges placeholder traffic only when asked', () => {
    expect(document.querySelector('.strip-badge')).toBeNull()
    const demo = mountBay({ demo: true })
    demo.bay.update([base], null)
    expect(document.querySelector('.strip-badge')?.textContent).toBe('DEMO')
  })
})

describe('strip content', () => {
  it('shows the callsign, wake indicator and type', () => {
    h.bay.update(
      [
        ac({ callsign: 'VIR45', wake: 'H', type: 'B789' }),
        ac({ callsign: 'UAE29', wake: 'J', type: 'A388' }),
        ac({ callsign: 'EZY812', wake: 'M', type: 'A320' }),
      ],
      null,
    )
    const heads = strips().map((s) => s.querySelector('.strip-head')?.textContent ?? '')
    expect(heads.some((t) => t.includes('VIR45 H') && t.includes('B789'))).toBe(true)
    expect(heads.some((t) => t.includes('UAE29 J'))).toBe(true)
    // A medium gets no indicator at all.
    expect(heads.some((t) => t.startsWith('EZY812  '))).toBe(true)
  })

  it('shows Mode C altitude with a trend and the cleared level', () => {
    h.bay.update([ac({ altFt: 7000, clearedAltFt: 5000, vsFpm: -1200 })], null)
    const alt = document.querySelector('.strip-alt')?.textContent ?? ''
    expect(alt).toContain('070')
    expect(alt).toContain('050')
    // Descending arrow, written as an escape in the source.
    expect(alt).toContain(String.fromCharCode(0x2193))
  })

  it('shows actual and cleared heading and speed', () => {
    h.bay.update([ac({ hdg: 95, clearedHdg: 250, gsKts: 240, clearedSpdKts: 220 })], null)
    expect(document.querySelector('.strip-hdg')?.textContent).toBe('HDG 095/250')
    expect(document.querySelector('.strip-spd')?.textContent).toBe('SPD 240/220')
  })

  it('omits the cleared heading when the aircraft has none', () => {
    h.bay.update([ac({ hdg: 95, clearedHdg: null })], null)
    expect(document.querySelector('.strip-hdg')?.textContent).toBe('HDG 095')
  })

  it('carries the nav mode as a styling hook', () => {
    h.bay.update([ac({ navMode: 'GS_TRACKING', clearedApproach: ILS_27R })], null)
    const strip = strips()[0]
    expect(strip?.dataset['mode']).toBe('GS_TRACKING')
    expect(strip?.querySelector('.strip-status')?.textContent).toBe('ESTABLISHED 27R')
  })
})

describe('syncing with the world', () => {
  const roster = [
    ac({ callsign: 'BAW178', navMode: 'VECTOR', pos: { x: 12, y: 0 } }),
    ac({ callsign: 'VIR45', navMode: 'HOLD', pos: { x: 13, y: 9 } }),
    ac({
      callsign: 'SWR318',
      navMode: 'GS_TRACKING',
      clearedApproach: ILS_27R,
      pos: { x: 6, y: 0 },
    }),
  ]

  it('orders the bay as the arrival sequence, nearest the field first', () => {
    h.bay.update(roster, null)
    expect(callsigns()).toEqual(['SWR318', 'BAW178', 'VIR45'])
  })

  it('sequences by distance to run rather than by phase of flight', () => {
    // The bay's order is the plan, and the plan is what order they land in.
    h.bay.update(
      [
        ac({ callsign: 'FAR1', navMode: 'GS_TRACKING', pos: { x: 25, y: 0 } }),
        ac({ callsign: 'NEAR2', navMode: 'VECTOR', pos: { x: 5, y: 0 } }),
      ],
      null,
    )
    expect(callsigns()).toEqual(['NEAR2', 'FAR1'])
  })

  it('keeps the stack below the sequence however close it is', () => {
    // Holding traffic is parked. It is not in the sequence until it is
    // taken out of the hold, whatever its distance says.
    h.bay.update(
      [
        ac({ callsign: 'HELD1', navMode: 'HOLD', pos: { x: 2, y: 0 } }),
        ac({ callsign: 'WORK2', navMode: 'VECTOR', pos: { x: 30, y: 0 } }),
      ],
      null,
    )
    expect(callsigns()).toEqual(['WORK2', 'HELD1'])
  })

  it('stacks holding traffic lowest first, since that is what comes out next', () => {
    h.bay.update(
      [
        ac({ callsign: 'HIGH1', navMode: 'HOLD', altFt: 11000 }),
        ac({ callsign: 'LOW2', navMode: 'HOLD', altFt: 7000 }),
      ],
      null,
    )
    expect(callsigns()).toEqual(['LOW2', 'HIGH1'])
  })

  it('reuses the same element for an aircraft across updates', () => {
    h.bay.update(roster, null)
    const before = strips()[0]
    h.bay.update(roster.map((a) => ac({ ...a, altFt: a.altFt - 500 })), null)
    expect(strips()[0]).toBe(before)
  })

  it('writes nothing to the DOM when nothing has changed', async () => {
    // The bay refreshes five times a second forever. If an idle tick
    // touched the DOM it would fight text selection and scrolling, so an
    // unchanged snapshot must be genuinely inert.
    h.bay.update(roster, null)

    const records: MutationRecord[] = []
    const observer = new MutationObserver((r) => records.push(...r))
    observer.observe(h.mount, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    })

    h.bay.update(roster, null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    observer.disconnect()

    expect(records.map((r) => `${r.type} on ${r.target.nodeName}`)).toEqual([])
  })

  it('writes only the field that changed', async () => {
    h.bay.update(roster, null)
    const records: MutationRecord[] = []
    const observer = new MutationObserver((r) => records.push(...r))
    observer.observe(h.mount, { childList: true, subtree: true, characterData: true })

    h.bay.update(
      roster.map((a) => (a.callsign === 'BAW178' ? ac({ ...a, altFt: 6000 }) : a)),
      null,
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    observer.disconnect()

    // One altitude cell, and nothing else on any strip.
    expect(records.length).toBeGreaterThan(0)
    const touched = new Set(
      records.map((r) => (r.target as Element).className ?? (r.target as Element).nodeName),
    )
    expect([...touched].join(',')).toContain('strip-alt')
    expect([...touched].join(',')).not.toContain('strip-status')
  })

  it('adds and removes strips as traffic comes and goes', () => {
    h.bay.update(roster, null)
    expect(strips()).toHaveLength(3)

    h.bay.update(roster.filter((a) => a.callsign !== 'VIR45'), null)
    expect(callsigns()).not.toContain('VIR45')
    expect(strips()).toHaveLength(2)

    h.bay.update([...roster, ac({ callsign: 'AAL106' })], null)
    expect(strips()).toHaveLength(4)
    expect(callsigns()).toContain('AAL106')
  })

  it('moves a strip rather than rebuilding it when it joins the sequence', () => {
    h.bay.update(roster, null)
    const holding = strips().find((s) => s.dataset['callsign'] === 'VIR45')
    expect(callsigns().indexOf('VIR45')).toBe(2)

    // Taken out of the hold and now the closest thing to the field, so it
    // goes to the front of the sequence.
    h.bay.update(
      roster.map((a) =>
        a.callsign === 'VIR45'
          ? ac({ ...a, navMode: 'VECTOR' as NavMode, pos: { x: 3, y: 0 } })
          : a,
      ),
      null,
    )
    expect(callsigns()[0]).toBe('VIR45')
    // Same element, moved -- not recreated, so focus and scroll survive.
    expect(strips().find((s) => s.dataset['callsign'] === 'VIR45')).toBe(holding)
  })

  it('copes with every aircraft disappearing at once', () => {
    h.bay.update(roster, null)
    h.bay.update([], null)
    expect(strips()).toHaveLength(0)
    expect((document.querySelector('.strip-empty') as HTMLElement).hidden).toBe(false)
    expect(document.querySelector('.strip-count')?.textContent).toBe('0 SEQ / 0 HOLD')
  })
})

describe('selection', () => {
  it('reports a click on a strip', () => {
    h.bay.update([base], null)
    strips()[0]?.click()
    expect(h.selections).toEqual(['BAW178'])
  })

  it('marks the selected strip for the eye and for assistive tech', () => {
    h.bay.update([base, ac({ callsign: 'VIR45' })], 'VIR45')
    const selected = strips().filter((s) => s.classList.contains('is-selected'))
    expect(selected).toHaveLength(1)
    expect(selected[0]?.dataset['callsign']).toBe('VIR45')
    expect(selected[0]?.getAttribute('aria-selected')).toBe('true')
  })

  it('moves the marker when the selection changes', () => {
    h.bay.update([base, ac({ callsign: 'VIR45' })], 'VIR45')
    h.bay.update([base, ac({ callsign: 'VIR45' })], 'BAW178')
    const selected = strips().filter((s) => s.classList.contains('is-selected'))
    expect(selected[0]?.dataset['callsign']).toBe('BAW178')
  })

  it('is reachable from the keyboard', () => {
    h.bay.update([base], null)
    const strip = strips()[0]
    expect(strip?.tabIndex).toBe(0)
    strip?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(h.selections).toEqual(['BAW178'])
  })
})

describe('right-click', () => {
  const stripFor = (callsign: string): HTMLElement => {
    const el = strips().find((s) => s.textContent?.includes(callsign))
    if (!el) throw new Error(`no strip for ${callsign}`)
    return el
  }

  const rightClick = (el: HTMLElement, at = { x: 300, y: 200 }): MouseEvent => {
    const e = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: at.x,
      clientY: at.y,
    })
    el.dispatchEvent(e)
    return e
  }

  it('opens the tag menu for the strip that was clicked, at the cursor', () => {
    h.bay.update([base, ac({ callsign: 'VIR22' })], null)
    rightClick(stripFor('VIR22'), { x: 640, y: 480 })
    expect(h.menus).toEqual([{ callsign: 'VIR22', at: { x: 640, y: 480 } }])
  })

  it('suppresses the browser menu, which would open on top of its own', () => {
    h.bay.update([base], null)
    expect(rightClick(stripFor('BAW178')).defaultPrevented).toBe(true)
  })

  it('leaves the selection alone', () => {
    // main.ts picks the target up as it opens the menu. The bay reporting a
    // selection as well would report it twice.
    h.bay.update([base], null)
    rightClick(stripFor('BAW178'))
    expect(h.selections).toEqual([])
  })

  it('opens from the keyboard, anchored on the strip', () => {
    h.bay.update([base], null)
    stripFor('BAW178').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }),
    )
    expect(h.menus).toHaveLength(1)
    expect(h.menus[0]?.callsign).toBe('BAW178')
  })

  it('opens from Shift+F10 too, which is the other platform route', () => {
    h.bay.update([base], null)
    stripFor('BAW178').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }),
    )
    expect(h.menus).toHaveLength(1)
  })

  it('puts nothing pressable on a strip at all', () => {
    // The strip is a view. Every instruction goes through the tag menu, so
    // there is nothing left on a strip to catch a stray click.
    h.bay.update([base], null)
    expect(stripFor('BAW178').querySelectorAll('button')).toHaveLength(0)
  })
})

describe('collapsing the bay', () => {
  it('starts open', () => {
    expect(h.bay.collapsed).toBe(false)
    expect(h.mount.querySelector('.strip-bay')?.classList.contains('is-collapsed')).toBe(
      false,
    )
  })

  it('collapses and restores, telling the caller to re-measure', () => {
    // The scope grows into the space, so the camera has to be told.
    const before = h.layoutChanges
    h.bay.setCollapsed(true)
    expect(h.bay.collapsed).toBe(true)
    expect(h.mount.querySelector('.strip-bay')?.classList.contains('is-collapsed')).toBe(true)
    expect(h.layoutChanges).toBeGreaterThan(before)

    h.bay.setCollapsed(false)
    expect(h.bay.collapsed).toBe(false)
  })

  it('collapses from its own control', () => {
    const button = h.mount.querySelector<HTMLButtonElement>('.strip-collapse')
    button?.click()
    expect(h.bay.collapsed).toBe(true)
    expect(button?.getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps the strips while collapsed rather than discarding them', () => {
    h.bay.update([base], null)
    h.bay.setCollapsed(true)
    // Hidden by CSS, still in the DOM: reopening must not lose state.
    expect(strips()).toHaveLength(1)
  })
})

describe('what a strip says that the scope does not', () => {
  const text = (callsign: string, sel: string): string => {
    const strip = strips().find((s) => s.dataset['callsign'] === callsign)
    if (!strip) throw new Error(`no strip for ${callsign}`)
    return strip.querySelector(sel)?.textContent ?? ''
  }
  const gapEl = (callsign: string): HTMLElement => {
    const strip = strips().find((s) => s.dataset['callsign'] === callsign)
    if (!strip) throw new Error(`no strip for ${callsign}`)
    return strip.querySelector('.strip-gap') as HTMLElement
  }

  it('numbers the sequence, and marks the stack as not in it', () => {
    h.bay.update(
      [
        ac({ callsign: 'ONE1', pos: { x: 5, y: 0 } }),
        ac({ callsign: 'TWO2', pos: { x: 12, y: 0 } }),
        ac({ callsign: 'HELD3', navMode: 'HOLD', pos: { x: 20, y: 0 } }),
      ],
      null,
    )
    expect(text('ONE1', '.strip-seq')).toBe('1')
    expect(text('TWO2', '.strip-seq')).toBe('2')
    expect(text('HELD3', '.strip-seq')).toBe('--')
  })

  it('shows how far each one still has to run', () => {
    h.bay.update([ac({ callsign: 'ONE1', pos: { x: 12, y: 5 } })], null)
    expect(text('ONE1', '.strip-fld')).toBe('FLD 13.0')
  })

  it('shows the gap to the aircraft ahead against what the pair needs', () => {
    // Two mediums: no wake requirement, so the 3 NM radar minimum applies.
    h.bay.update(
      [
        ac({ callsign: 'ONE1', wake: 'M', pos: { x: 6, y: 0 } }),
        ac({ callsign: 'TWO2', wake: 'M', pos: { x: 10, y: 0 } }),
      ],
      null,
    )
    expect(text('TWO2', '.strip-gap')).toBe('GAP 4.0/3')
    expect(gapEl('TWO2').classList.contains('is-tight')).toBe(false)
  })

  it('says NO 1 for the aircraft with nobody to follow', () => {
    // Left blank it would read as a gap of zero, which is the opposite of
    // what it means.
    h.bay.update([ac({ callsign: 'ONE1', pos: { x: 6, y: 0 } })], null)
    expect(text('ONE1', '.strip-gap')).toBe('NO 1')
  })

  it('asks for more room behind a heavy, and flags it when there is not', () => {
    // A medium four miles behind a heavy needs five: that is tight.
    h.bay.update(
      [
        ac({ callsign: 'HVY1', wake: 'H', type: 'B77W', pos: { x: 6, y: 0 } }),
        ac({ callsign: 'MED2', wake: 'M', pos: { x: 10, y: 0 } }),
      ],
      null,
    )
    expect(text('MED2', '.strip-gap')).toBe('GAP 4.0/5')
    expect(gapEl('MED2').classList.contains('is-tight')).toBe(true)
  })

  it('asks for seven behind an A380', () => {
    h.bay.update(
      [
        ac({ callsign: 'SUP1', wake: 'J', type: 'A388', pos: { x: 6, y: 0 } }),
        ac({ callsign: 'MED2', wake: 'M', pos: { x: 14, y: 0 } }),
      ],
      null,
    )
    expect(text('MED2', '.strip-gap')).toBe('GAP 8.0/7')
    expect(gapEl('MED2').classList.contains('is-tight')).toBe(false)
  })

  it('clears the tight flag again once the gap is opened up', () => {
    const tight = [
      ac({ callsign: 'HVY1', wake: 'H', pos: { x: 6, y: 0 } }),
      ac({ callsign: 'MED2', wake: 'M', pos: { x: 10, y: 0 } }),
    ]
    h.bay.update(tight, null)
    expect(gapEl('MED2').classList.contains('is-tight')).toBe(true)
    h.bay.update([tight[0] as Aircraft, ac({ callsign: 'MED2', wake: 'M', pos: { x: 13, y: 0 } })], null)
    expect(gapEl('MED2').classList.contains('is-tight')).toBe(false)
  })

  it('says a stack strip is in the stack rather than faking a gap', () => {
    h.bay.update([ac({ callsign: 'HELD1', navMode: 'HOLD', pos: { x: 14, y: 0 } })], null)
    expect(text('HELD1', '.strip-gap')).toBe('IN STACK')
    expect(text('HELD1', '.strip-fld')).toBe('FLD 14.0')
  })
})
