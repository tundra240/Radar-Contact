/**
 * The single instruction type every input path produces.
 *
 * Strip quick-buttons, the mouse rubber-band and the typed console all
 * build these, so there is one validation path, one readback format, and a
 * log that -- with the seeded RNG -- makes a session replayable. See
 * ARCHITECTURE.md section 3, decision 5.
 *
 * Nothing applies these yet: commands/apply.ts arrives in Day 2. Until
 * then the sink is whatever the caller supplies, which keeps the strip bay
 * testable without a simulation behind it.
 */
export type Command =
  | { readonly kind: 'heading'; readonly callsign: string; readonly deg: number }
  | { readonly kind: 'altitude'; readonly callsign: string; readonly ft: number }
  | { readonly kind: 'speed'; readonly callsign: string; readonly kts: number }
  | { readonly kind: 'approach'; readonly callsign: string; readonly runway: string }
  | { readonly kind: 'hold'; readonly callsign: string; readonly fix: string }
  | { readonly kind: 'handoff'; readonly callsign: string }

/** Where issued commands go. Day 2 points this at commands/apply.ts. */
export type CommandSink = (command: Command) => void

/** One-line readback, for the console log and for tests. */
export function describeCommand(c: Command): string {
  switch (c.kind) {
    case 'heading':
      return `${c.callsign} HDG ${String(Math.round(c.deg)).padStart(3, '0')}`
    case 'altitude':
      return `${c.callsign} DES ${c.ft}`
    case 'speed':
      return `${c.callsign} SPD ${c.kts}`
    case 'approach':
      return `${c.callsign} CLEARED ILS ${c.runway}`
    case 'hold':
      return `${c.callsign} HOLD ${c.fix}`
    case 'handoff':
      return `${c.callsign} HANDOFF`
  }
}
