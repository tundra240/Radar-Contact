// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import type { Command } from '../commands/types'
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
  originFix: 'LAM',
  trail: [],
  spawnedAt: 0,
}

function ac(over: Partial<Aircraft>): Aircraft {
  return { ...base, ...over }
}

interface Harness {
  bay: StripBay
  mount: HTMLElement
  commands: Command[]
  selections: (string | null)[]
  layoutChanges: number
}

function mountBay(extra?: { demo?: boolean }): Harness {
  document.body.innerHTML = ''
  const mount = document.createElement('div')
  document.body.appendChild(mount)

  const commands: Command[] = []
  const selections: (string | null)[] = []
  const state = { layoutChanges: 0 }

  const opts: StripBayOptions = {
    mount,
    onCommand: (c) => commands.push(c),
    onSelect: (s) => selections.push(s),
    onLayoutChange: () => {
      state.layoutChanges += 1
    },
    quickDescendFt: 3000,
    quickSpeedKts: 160,
    defaultRunway: '27R',
    ...(extra?.demo !== undefined ? { demo: extra.demo } : {}),
  }

  const bay = new StripBay(opts)
  return {
    bay,
    mount,
    commands,
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
    expect(empty?.textContent).toMatch(/no active traffic/i)
    expect((empty as HTMLElement).hidden).toBe(false)
  })

  it('reports the active count', () => {
    expect(document.querySelector('.strip-count')?.textContent).toBe('0 ACTIVE')
    h.bay.update([base, ac({ callsign: 'VIR45' })], null)
    expect(document.querySelector('.strip-count')?.textContent).toBe('2 ACTIVE')
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
    h.bay.update([ac({ navMode: 'GS_TRACKING', clearedApproach: '27R' })], null)
    const strip = strips()[0]
    expect(strip?.dataset['mode']).toBe('GS_TRACKING')
    expect(strip?.querySelector('.strip-status')?.textContent).toBe('ESTABLISHED 27R')
  })
})

describe('syncing with the world', () => {
  const roster = [
    ac({ callsign: 'BAW178', navMode: 'VECTOR' }),
    ac({ callsign: 'VIR45', navMode: 'HOLD' }),
    ac({ callsign: 'SWR318', navMode: 'GS_TRACKING', clearedApproach: '27R' }),
  ]

  it('orders strips by what needs attention soonest', () => {
    h.bay.update(roster, null)
    // Established, then vectoring, then holding.
    expect(callsigns()).toEqual(['SWR318', 'BAW178', 'VIR45'])
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

  it('moves a strip rather than rebuilding it when its phase changes', () => {
    h.bay.update(roster, null)
    const holding = strips().find((s) => s.dataset['callsign'] === 'VIR45')
    expect(callsigns().indexOf('VIR45')).toBe(2)

    // The holding aircraft is now established, so it belongs at the top.
    h.bay.update(
      roster.map((a) =>
        a.callsign === 'VIR45'
          ? ac({ ...a, navMode: 'GS_TRACKING' as NavMode, clearedApproach: '27L' })
          : a,
      ),
      null,
    )
    expect(callsigns()[0] === 'VIR45' || callsigns()[1] === 'VIR45').toBe(true)
    // Same element, moved -- not recreated, so focus and scroll survive.
    expect(strips().find((s) => s.dataset['callsign'] === 'VIR45')).toBe(holding)
  })

  it('copes with every aircraft disappearing at once', () => {
    h.bay.update(roster, null)
    h.bay.update([], null)
    expect(strips()).toHaveLength(0)
    expect((document.querySelector('.strip-empty') as HTMLElement).hidden).toBe(false)
    expect(document.querySelector('.strip-count')?.textContent).toBe('0 ACTIVE')
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

describe('quick actions', () => {
  const actions = (strip: HTMLElement): HTMLButtonElement[] =>
    [...strip.querySelectorAll<HTMLButtonElement>('.strip-action')]

  it('issues a descent to the sector intercept altitude', () => {
    h.bay.update([base], null)
    const [descend] = actions(strips()[0] as HTMLElement)
    expect(descend?.textContent).toBe('DES 3000')
    descend?.click()
    expect(h.commands).toEqual([{ kind: 'altitude', callsign: 'BAW178', ft: 3000 }])
  })

  it('issues a speed reduction', () => {
    h.bay.update([base], null)
    const slow = actions(strips()[0] as HTMLElement)[1]
    expect(slow?.textContent).toBe('SPD 160')
    slow?.click()
    expect(h.commands).toEqual([{ kind: 'speed', callsign: 'BAW178', kts: 160 }])
  })

  it('clears the approach to the active runway by default', () => {
    h.bay.update([base], null)
    actions(strips()[0] as HTMLElement)[2]?.click()
    expect(h.commands).toEqual([
      { kind: 'approach', callsign: 'BAW178', runway: '27R' },
    ])
  })

  it('clears the approach to the runway already assigned', () => {
    // Otherwise the button would quietly re-clear an aircraft onto the
    // other runway, which is a genuinely dangerous thing for a UI to do.
    h.bay.update([ac({ navMode: 'VECTOR', clearedApproach: '27L' })], null)
    actions(strips()[0] as HTMLElement)[2]?.click()
    expect(h.commands).toEqual([
      { kind: 'approach', callsign: 'BAW178', runway: '27L' },
    ])
  })

  it('does not select the strip when a button is pressed', () => {
    // The click would otherwise bubble and steal the selection.
    h.bay.update([base], null)
    actions(strips()[0] as HTMLElement)[0]?.click()
    expect(h.commands).toHaveLength(1)
    expect(h.selections).toEqual([])
  })

  it('disables the approach button once there is nothing left to clear', () => {
    for (const navMode of ['LOC_ARMED', 'LOC_CAPTURED', 'GS_TRACKING', 'LANDED'] as NavMode[]) {
      h.bay.update([ac({ navMode, clearedApproach: '27R' })], null)
      const approach = actions(strips()[0] as HTMLElement)[2]
      expect(approach?.disabled, navMode).toBe(true)
    }
  })

  it('leaves the approach button live while still being vectored', () => {
    for (const navMode of ['VECTOR', 'HOLD', 'GO_AROUND'] as NavMode[]) {
      h.bay.update([ac({ navMode })], null)
      expect(actions(strips()[0] as HTMLElement)[2]?.disabled, navMode).toBe(false)
    }
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
