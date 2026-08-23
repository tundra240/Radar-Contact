import type { TutorialModule } from '../types'

/**
 * The first lesson: everything a controller needs before they are left
 * alone with the sector.
 *
 * This file is data. There is no code in it and there is not meant to be:
 * it is the demonstration that a lesson can be written without touching the
 * engine, the simulation or the interface, and the moment one of those has
 * to change to add a step, the model in types.ts is wrong rather than the
 * lesson.
 *
 * The shape of it is six phases -- look at the display, watch one arrival
 * hold, work that arrival onto the ILS, meet the ATIS, meet the traffic
 * that is not yours, and then do the whole thing at once with weather in
 * the way.
 *
 * Every instruction names the control and the value. That is deliberate and
 * it was learned the hard way: an earlier draft of the descent step said
 * "or type BAW214 D30 S180 if you prefer the keyboard", and the command line
 * had been taken out of the interface some time before -- so the lesson
 * offered a way to do it that did not exist, beside a way it never really
 * described. Anyone who tried the sentence rather than guessing at the menu
 * got stuck there with nothing to press. Nothing here says "issue a
 * clearance" and leaves the how to the reader.
 */
export const BASICS: TutorialModule = {
  id: 'basics',
  title: 'Approach control: the basics',
  summary: 'The scope, the hold, a vectored ILS, the ATIS, transits and weather.',
  steps: [
    /* ---- phase 1: the display, with the clock stopped ------------------ */
    {
      id: 'welcome',
      title: 'Welcome to London Terminal Control',
      text:
        'This is Heathrow approach. The white outline is your airspace. The four orange ' +
        'racetracks are the holds arrivals wait in -- BNN north-west, LAM north-east, ' +
        'BIG south-east, OCK south-west. The clock is stopped, so nothing moves until you ' +
        'let it. Press Continue.',
      spotlight: { kind: 'scope' },
      goal: { kind: 'continue' },
      button: 'Continue',
      scene: { paused: true, traffic: [], weather: [] },
    },
    {
      id: 'time',
      title: 'The clock',
      text:
        'Two controls on the rail, both highlighted. The upper one starts and stops the ' +
        'clock. The lower one steps the rate: press it and it goes x1, x2, x4, x0.5 and ' +
        'round again. Whatever it is set to shows in the RATE column along the top. ' +
        'Press Continue.',
      spotlight: { kind: 'elements', selectors: ['.pause-button', '.rate-button'] },
      goal: { kind: 'continue' },
      button: 'Continue',
    },

    /* ---- phase 2: an arrival, and the hold ----------------------------- */
    {
      id: 'inbound',
      title: 'An inbound',
      text:
        'BAW214 has appeared south-east of the field at 10,000 feet, tracking to BIG on ' +
        'its own. It needs about seven minutes to get there. Press the rate button until ' +
        'the RATE column reads x4, and watch it run in.',
      // The aircraft as well as the control: the instruction is about
      // watching one while pressing the other, and dimming the aeroplane
      // the step is asking you to watch would be the wrong way round.
      spotlight: {
        kind: 'group',
        of: [
          { kind: 'aircraft', ref: 'inbound' },
          { kind: 'elements', selectors: ['.rate-button'] },
        ],
      },
      goal: { kind: 'speed', to: 4 },
      button: null,
      scene: {
        paused: false,
        speed: 1,
        traffic: [
          {
            ref: 'inbound',
            kind: 'arrival',
            fix: 'BIG',
            altFt: 10000,
            iasKts: 250,
            callsign: 'BAW214',
            type: 'A320',
          },
        ],
      },
    },
    {
      id: 'hold',
      title: 'The holding pattern',
      text:
        'Nothing to press here. Reaching BIG with no further clearance, BAW214 turns onto ' +
        'the published racetrack and orbits -- a one-minute leg each way, so about two ' +
        'minutes a circuit. The clock stops by itself once it is established.',
      spotlight: { kind: 'aircraft', ref: 'inbound' },
      goal: { kind: 'holding', ref: 'inbound' },
      button: null,
      // Stopped the moment it is established, so the pattern can be looked
      // at rather than flown past while the instruction is being read.
      pauseOnGoal: true,
    },
    {
      id: 'hold-read',
      title: 'Reading the stack',
      text:
        'Its strip is in the bay on the right: callsign and type, then level, heading and ' +
        'speed, with HOLDING BIG underneath. More arrivals would stack above it a ' +
        'thousand feet apart, and that vertical gap is the whole of what keeps them apart ' +
        'over one point. Press Continue.',
      spotlight: { kind: 'aircraft', ref: 'inbound' },
      goal: { kind: 'continue' },
      button: 'Continue',
    },

    /* ---- phase 3: working the aircraft --------------------------------- */
    {
      id: 'select',
      title: 'Selecting an aircraft',
      text:
        'LEFT-click BAW214 -- either the small square or the block of text beside it. ' +
        'The square fills in to show it is yours, and its strip lights up in the bay. The ' +
        'clock is running again from here.',
      spotlight: { kind: 'aircraft', ref: 'inbound' },
      goal: { kind: 'select', ref: 'inbound' },
      button: null,
      scene: { paused: false, speed: 1 },
    },
    {
      id: 'descend',
      title: 'Descent and speed',
      text:
        'RIGHT-click BAW214 to open its command menu. Choose ALTITUDE, then pick 3000 ' +
        '-- the level it needs to meet the glidepath. The menu closes when you pick. ' +
        'Right-click it again, choose SPEED, and pick 180.',
      spotlight: { kind: 'aircraft', ref: 'inbound' },
      goal: {
        kind: 'every',
        of: [
          { kind: 'altitude', ft: 3000, ref: 'inbound' },
          { kind: 'airspeed', kts: 180, ref: 'inbound' },
        ],
      },
      button: null,
    },
    {
      id: 'downwind',
      title: 'Vectoring off the hold',
      text:
        'A heading is dragged, not picked from a list. Press and hold on BAW214, pull ' +
        'the elastic line out to the EAST -- to the right of the aircraft -- and let go. ' +
        'Aim for 090; the heading follows the line as you drag it. That takes BAW214 out ' +
        'of the hold and onto the downwind leg for 27R.',
      spotlight: { kind: 'aircraft', ref: 'inbound' },
      goal: { kind: 'heading', deg: 90, ref: 'inbound' },
      button: null,
    },

    /* ---- phase 4: the ATIS and the ILS --------------------------------- */
    {
      id: 'atis',
      title: 'The ATIS',
      text:
        'The board on the left is the ATIS: the letter it is on, the wind, and the ' +
        'runways in use -- ARR 27R, DEP 27L. The wind decides which way the field runs, ' +
        'and every arrival is aimed at the runway named there. The highlighted button ' +
        'puts the board away and brings it back. Press Continue.',
      spotlight: { kind: 'elements', selectors: ['.atis-button', '.atis-box'] },
      goal: { kind: 'continue' },
      button: 'Continue',
    },
    {
      id: 'base',
      title: 'Base leg and the intercept',
      text:
        'Two drags on BAW214, in order. First pull a heading NORTH, to 360, to come off ' +
        'the downwind leg. Then pull one to 240 -- south-west -- which closes on the 27R ' +
        'localiser at about thirty degrees. Shallower than thirty and the beam captures; ' +
        'come at it square and the aircraft flies straight through it.',
      spotlight: { kind: 'aircraft', ref: 'inbound' },
      goal: {
        kind: 'inOrder',
        of: [
          { kind: 'heading', deg: 360, ref: 'inbound' },
          { kind: 'heading', deg: 240, ref: 'inbound' },
        ],
      },
      button: null,
    },
    {
      id: 'clear-ils',
      title: 'Cleared for the approach',
      text:
        'RIGHT-click BAW214, choose APPROACH, then pick ILS 27R. That arms the ' +
        'approach: the aircraft captures the localiser once the geometry actually allows ' +
        'it, and follows the glidepath down from there without further instruction.',
      spotlight: { kind: 'aircraft', ref: 'inbound' },
      goal: { kind: 'approach', ref: 'inbound' },
      button: null,
      resetOn: ['goAround'],
    },

    /* ---- phase 5: traffic that is not yours ---------------------------- */
    {
      id: 'transit',
      title: 'Traffic crossing the sector',
      text:
        'EZY63 is not yours to land: a Gatwick inbound crossing at FL140 on its own ' +
        'flight plan. It is drawn in steel blue rather than green, and its data block ' +
        'carries EGKK where an arrival carries nothing. It wants no instruction from you ' +
        '-- but it is in your airspace and it counts for separation. Press Continue.',
      spotlight: { kind: 'aircraft', ref: 'transit' },
      goal: { kind: 'continue' },
      button: 'Continue',
      scene: {
        paused: false,
        speed: 1,
        traffic: [
          {
            ref: 'transit',
            kind: 'overflight',
            corridor: 'KK-EAST',
            altFt: 14000,
            iasKts: 280,
            callsign: 'EZY63',
          },
        ],
      },
    },
    {
      id: 'resume-nav',
      title: 'Vector it, then give it back',
      text:
        'Separation is 3 miles apart OR 1,000 feet apart -- either one on its own is ' +
        'enough. Drag EZY63 onto any heading, as though something were in its way. Then ' +
        'RIGHT-click it and choose RESUME NAV, which hands the flight plan back and lets ' +
        'it carry on to Gatwick by itself.',
      spotlight: { kind: 'aircraft', ref: 'transit' },
      goal: {
        kind: 'inOrder',
        of: [
          { kind: 'vector', ref: 'transit' },
          { kind: 'resumeNav', ref: 'transit' },
        ],
      },
      button: null,
    },

    /* ---- phase 6: weather, and doing it all at once -------------------- */
    {
      id: 'weather',
      title: 'Weather',
      text:
        'A cell has grown over OCK, south-west of the field. Three bands: faint at the ' +
        'edge, brighter through the middle, red in the core. An aircraft vectored into ' +
        'the red calls up asking to be taken out of it, and its target turns red until ' +
        'you do. Plan round the core rather than through it. Press Continue.',
      spotlight: { kind: 'fix', name: 'OCK' },
      goal: { kind: 'continue' },
      button: 'Continue',
      scene: {
        paused: true,
        traffic: [],
        weather: [{ overFix: 'OCK', radiusNM: 7, peak: 0.95, lifeMinutes: 45 }],
      },
    },
    {
      id: 'checkride',
      title: 'Checkride',
      text:
        'Three arrivals, a storm over OCK, one runway. For each: descend it to 3000, drag ' +
        'it onto a base leg, then APPROACH and ILS 27R. Land all three. Keep every pair 3 ' +
        'miles or 1,000 feet apart the whole way, and keep them out of the red. Lose ' +
        'separation and the step starts again.',
      spotlight: { kind: 'none' },
      goal: { kind: 'allLanded' },
      button: null,
      resetOn: ['conflict', 'goAround'],
      scene: {
        paused: false,
        speed: 1,
        weather: [{ overFix: 'OCK', radiusNM: 7, peak: 0.95, lifeMinutes: 45 }],
        traffic: [
          {
            ref: 'one',
            kind: 'arrival',
            fix: 'BIG',
            altFt: 9000,
            iasKts: 250,
            callsign: 'BAW51',
            type: 'A320',
          },
          {
            ref: 'two',
            kind: 'arrival',
            fix: 'BIG',
            altFt: 11000,
            iasKts: 250,
            callsign: 'VIR12',
            type: 'A359',
          },
          {
            ref: 'three',
            kind: 'arrival',
            fix: 'OCK',
            altFt: 10000,
            iasKts: 250,
            callsign: 'EIN802',
            type: 'A320',
          },
        ],
      },
    },
  ],
}
