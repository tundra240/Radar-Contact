# Sequencing -- how to build an arrival stream

A tutorial on the one skill the whole game is about: turning four separate streams of
arrivals into a single landing sequence per runway, spaced as tightly as the rules allow,
without anyone losing separation on the way there.

This document covers **how to talk to aircraft and how to sequence them**. Display schemes,
overlays and the rest of the interface are in [README.md](README.md); the code layout is in
[ARCHITECTURE.md](ARCHITECTURE.md).

> **What is live today.** The scope, the map, the four holds and their geometry are drawn from
> real data. Arrivals appear twelve miles out, track direct to their VOR and enter the hold on
> their own, stacked in 1,000 ft layers -- so the sector fills up and waits for you. They take
> headings, altitudes, speeds
> and holding instructions -- an aircraft sent to a hold flies the real racetrack and stays
> there until you vector it out -- **and they land**: clear one for the ILS, and if you have
> lined it up properly it captures the localiser, picks up the glidepath and flies it to the
> numbers. Line it up badly and it flies straight through, which is the job. Traffic is
> different every
> session -- the console prints the seed at logon, and `?seed=<number>` in the address flies the
> same one again. Every figure below marked *(config)* is read
> live from `src/data/egll.json`, so it is what the game actually enforces.

---

## Talking to aircraft

There are three ways in, and they all do exactly the same thing.

### What is yours, and what is not

**Your airspace is the real thing.** Not a circle around the field: the **London CTR** from the
surface to 2,500 ft, and **London TMA 1** from there up to FL195 -- both straight out of the
sector file. Everything outside is washed back towards the background: still there, still
readable, but plainly not the bit you are working.

It is not the same size in every direction, and that matters. To the south-east the boundary is
nearly 40 NM out; to the south-west it is barely 11. Traffic off BIG has a long run in; traffic
off BNN is yours almost as soon as you see it.

**And it has a floor.** Below 2,500 ft, controlled airspace is only the CTR -- about 11 miles
around the field. Try to descend an aircraft below the base of the TMA further out than that and
the clearance is refused: *"below controlled airspace where it is"*. That is not the game being
awkward, it is where the airspace stops.

Arrivals appear **outside** that circle and fly in. You can see them coming for a couple of
minutes, read their callsign and type off the tag, and start planning where they fit. What you
cannot do is touch them: any clearance for an aircraft outside the boundary is refused with
*"not in your airspace yet"*. They are drawn dimmer to say so, they carry no sequence number,
and the strip bay lists them at the bottom marked **INBOUND** with the distance still to run.

The moment one crosses the boundary it is yours -- full brightness, a sequence number, and it
will take instructions.

### Saving and coming back

**SAVE** and **LOAD** live in the menu, under *Session*. Saving takes the shift exactly as it
stands: every aircraft where it is and what it has been cleared for, the clock, the score, who
is on position, and where the next arrival is in its gap. Loading puts it all back.

A loaded session always arrives **paused**, so you get to read the picture before it starts
moving again. Press space when you are ready.

There is one slot, and saving overwrites it. A save is tied to the airport it was flown at and
to this version of the game; anything else is refused with a reason rather than loaded into a
world it does not fit.

### Keeping score

**SCORE** on the status bar. Landing an aircraft is worth **+100**; losing one off the boundary
without landing it costs **50**. Losing one costs less than landing one earns, so a session
where you land most of the traffic still climbs -- it is a penalty, not a punishment. The
`LANDED n LOST n` cell breaks the same figure into its two halves, and every landing and every
loss is named in the console as it happens.

### Drag the vector you want

**Press on an aircraft and drag.** A line comes out of the target and follows the cursor, with
the heading and the distance written beside it; let go and that heading is the clearance. It is
the quickest way to turn something, and the only one where you are aiming at the picture rather
than at a number.

Press on the target square or on its data block -- the block is bigger and easier to hit. The
line is drawn from where the aircraft *is*, not from where it was when you pressed, so it stays
attached while the aircraft flies. A press that barely moves is treated as a click and just
selects, and **Escape** abandons a drag you have changed your mind about.

Pressing on empty scope pans the picture instead, so the two never fight.

One thing worth knowing if you are pulling traffic out of a stack: four aircraft holding over
the same fix are within a mile of each other, which at normal range is a smaller gap than the
cursor can resolve. Select the one you want first -- click its strip -- and the scope will then
give the press to that aircraft rather than to whichever is nearest.

### Point at it

**Right-click an aircraft -- the target on the scope, or its strip in the bay -- and its
clearances open at the cursor.** Pick HEADING, ALTITUDE, SPEED, APPROACH or HOLD, then pick the
value. HANDOFF goes straight out with nothing to choose. The menu closes the moment it has
issued something, so a clearance is two clicks.

Right-clicking the data block works as well as the square, and is easier: the block is the
bigger thing and it is what you are already reading. Escape closes the menu, and so does
clicking anywhere else. Left-click picks a target up without instructing it, and left-clicking
empty scope lets it go.

Everything on offer is something the sector and the aeroplane will accept. The levels come from
the sector floor and ceiling, and the speed list from that type's approach speed and the
terminal area limit -- so an A319 is offered 140 kt where an A320 is offered 150, and an
aircraft already cleared below FL100 is not offered 280 kt just because it is still up there.
Nothing in the menu is a number that gets refused when you pick it.

The heading page has the nudges first -- L30 to R30, worked out from the heading the aircraft is
actually flying -- and then every ten degrees, because a specific heading is a specific heading.

### Reading the strip bay

The strip bay is **not** a second copy of the radar labels. It carries the three things the
scope cannot tell you.

**The order.** The bay is the arrival sequence: nearest the field at the top, and the number in
the margin is where that aircraft sits in the queue. Holding traffic drops to the bottom -- it
is parked, not sequenced -- lowest first, because the bottom of a stack is what comes out of it
next.

**FLD.** How far that aircraft still has to run to the field, in miles.

**GAP.** The gap to the aircraft in front, and what that gap needs to be: `GAP 4.2/5` means
four point two miles where five are required. **The gap is measured in distance to run, not as
the range between the two aircraft** -- two aircraft on opposite base legs can be twenty miles
apart and still be heading for the same slot, and a gap of nothing is exactly what you want to
be told about that.

A gap below the requirement is flagged in red. That is the single most useful thing on the
display: it is the difference between a sequence and a queue of aeroplanes that will not fit.

The required figure comes from the two aircraft's wake categories, not from a fixed number --
which is why the same four miles is fine behind an A320 and not behind a 777. See
*Wake turbulence changes the order, not just the gap* below.

### Or type it

The console takes anything the mouse cannot say -- a level, a speed, several instructions at
once -- and one line does everything you want to say to one aircraft:

```
  BAW178 H270 A30 S180
```

That is: turn BAW178 onto heading 270, descend to 3,000 ft, reduce to 180 kt. Order does not
matter and you can give one instruction or all three.

| Instruction | Written | Means |
|---|---|---|
| Heading | `H270`, `HDG 270`, `HEADING 270` | Turn onto 270 degrees |
| Altitude | `A30`, `A3000`, `ALT 30` | Cleared 3,000 ft |
| Climb | `C90`, `CLIMB 9000` | Same field, said the other way |
| Descend | `D30`, `DES 3000` | Same again |
| Speed | `S180`, `SPD 180` | Reduce or increase to 180 kt |
| Hold | `HOLD LAM` | Enter the published hold at LAM |

Four things worth knowing:

- **Altitudes can be written either way.** Three digits or fewer is hundreds of feet, so `A30`
  is 3,000 ft and `A150` is FL150. Four or more is feet, so `A3000` is also 3,000 ft. They
  mean the same thing.
- **You can shorten the callsign.** `178` or `BAW1` will find BAW178, as long as only one
  aircraft matches. If two do, the line is refused rather than guessed at.
- **You can leave the callsign out.** Click a target or its strip to select it, then type
  `A30` on its own.
- **The up arrow recalls what you typed**, including a line that was refused -- which is
  usually one character away from a good one.

### A clearance is a target, not a teleport

The aircraft does not snap to what you told it. It turns at 3 degrees a second, climbs and
descends at 1,500 fpm, and changes speed at about 1.5 kt a second. The strip shows both
numbers -- what the radar sees and what you cleared -- so `070 v 030` is an aircraft at 7,000
ft on its way down to 3,000.

That gap is the whole game. A turn onto a 30 degree closing heading takes ten seconds to even
start pointing the right way, and an aircraft cleared down from the top of a stack needs eight
minutes and thirty miles to get there. Section 2 has the arithmetic.

### Refusals

A clearance the aircraft or the sector cannot accept is **refused with a reason**, in red, and
nothing changes. The line is not quietly adjusted into something legal -- if you ask an A320
for 90 kt you are told it will not fly below 140, rather than being given 140 and left thinking
90 was accepted.

The things that get refused: a level outside the sector (1,500 ft to FL150), a speed outside
what the type can fly, more than 250 kt below 10,000 ft, and a heading past 360. A line with
several instructions is **all or nothing** -- if the speed is refused, the turn does not happen
either, so you never have to work out which half took effect.

---

## 1. The four stacks

Heathrow arrivals do not appear at the edge of the sector on a random bearing. They arrive
over one of four VOR holds -- the *stacks* -- and which one they arrive over was decided long
before they reached you, by the direction they came from.

Distances and bearings below are computed by the loader from the published navaid
coordinates, measured from the airport reference point *(config)*:

| Fix | Navaid | Position from the field | Frequency |
|---|---|---|---|
| **BNN** | Bovingdon | 15.7 NM on 348 -- almost due north | 113.75 |
| **LAM** | Lambourne | 25.1 NM on 065 -- north-east, the furthest out | 115.60 |
| **BIG** | Biggin | 20.3 NM on 114 -- south-east | 115.10 |
| **OCK** | Ockham | 10.0 NM on 177 -- almost due south, very close in | 115.30 |

### What each stack feeds

Assignment follows the arrival route, so in practice a stack serves a whole quadrant of the
world rather than a list of airports:

**BNN (Bovingdon)** -- the north-west and west. This is the **North Atlantic stack**: the
transatlantic wave from North America comes in over the top of Ireland or Wales and is fed
down to Bovingdon, and with it Ireland, Scotland, the north-west of England and the Iceland
routings. In the early-morning arrivals peak BNN is where the long-haul heavies are, which
matters for spacing -- see section 5.

**LAM (Lambourne)** -- the north and north-east. Scandinavia, the Baltic, Poland, northern
Germany, the Low Countries, and domestic traffic from Scotland and north-east England routed
down the eastern side of the country.

**BIG (Biggin)** -- the south-east and east. Everything that crosses the Channel or the
North Sea from the continent: France, Belgium, Germany, Italy, Greece and Turkey, plus Middle
East and Asia traffic that has routed over the European mainland.

**OCK (Ockham)** -- the south and south-west. Iberia, southern France, the Canaries, Africa,
South America, the Channel Islands and the south-west of England.

### The layout is not symmetrical, and that is the first thing to internalise

It is tempting to picture the four stacks as tidy diagonal corners -- north-east, south-east,
north-west, south-west. They are not. **BNN and LAM are both to the north** and **BIG and OCK
are both to the south**, and the four sit at wildly different distances. That asymmetry is the
source of most of the difficulty:

- **OCK is 10 NM out.** An aircraft leaving Ockham is already nearly overhead the field. You
  have almost no track miles to spend, so an OCK arrival is committed to its slot in the
  sequence more or less immediately.
- **LAM is 25 NM out** -- two and a half times further. A Lambourne arrival can be stretched,
  shortened, or left in the hold while you fit something else in front of it.
- **BNN sits nearly due north** at 15.7 NM, so its traffic has to be turned through most of a
  right angle to reach a westerly final approach track.
- **BIG at 20.3 NM to the south-east** has room, but its traffic crosses the extended
  centreline if you take it round the wrong way.

Track miles are the currency of sequencing. Knowing, without having to think about it, how
many each stack gives you is what separates a smooth stream from a mess.

---

## 2. How a stack actually works

A hold is a vertical queue. Aircraft enter at the top and are stacked in **1,000 ft layers**,
which is exactly the vertical separation minimum -- so a stack is the densest legal way to
park aircraft over a single point.

All four Heathrow holds are flown with **right turns on a one-minute inbound leg** *(config)*,
so an aircraft in the hold is somewhere on a predictable racetrack rather than anywhere in a
circle.

> **A note on the inbound legs.** Published hold inbound tracks are not in the open dataset
> the config was built from, so the loader currently derives each one as the bearing from the
> fix back to the field -- LAM 245, BIG 294, BNN 168, OCK 357 -- and flags it
> `inboundIsDerived`. The real published tracks differ, and can be supplied per fix with an
> `inboundTrue` override without touching any code.

### Take them off the bottom

The one rule of stack discipline: **the aircraft at the bottom of the stack leaves first.**
When it goes, everything above it descends one layer and the queue steps down.

Pulling an aircraft out of the middle is the classic beginner error. To get it out you have to
descend it through levels that are still occupied, and you have stranded the aircraft
underneath it at a level it cannot leave. The stack is first-in-first-out by construction, and
the only real flexibility you have is in choosing *which stack* to take from next.

### The descent is the constraint, not the turn

The sector runs from **1,500 ft to FL150** *(config)*, and the intercept altitude is
**3,000 ft** *(config)*. At a 1,500 fpm descent rate, getting an aircraft from the top of a
stack down to the intercept altitude takes:

| From | Height to lose | Time at 1,500 fpm | Track miles at 250 kt |
|---|---|---|---|
| FL150, top of stack | 12,000 ft | 8 min | about 33 NM |
| 7,000 ft, near the bottom | 4,000 ft | under 3 min | about 11 NM |

Thirty-three miles is most of the sector radius. An aircraft at the top of a stack **cannot**
be turned onto final immediately however much you want the slot -- it has to be worked down
first. That is why the stack exists at all, and why the sequence you can build is constrained
by the descent profile rather than by the geometry.

---

## 3. Two runways, two sequences

The MVP lands both **27R and 27L** *(config)*, so you are not building one stream, you are
building two independent ones -- and the landing rate is the sum of the two.

27R is the **northern** runway, 27L the **southern**: the loader puts the 27R threshold
0.42 NM north of the reference point and 27L 0.35 NM south of it.

The sequencing principle is to **keep the flows from crossing**. Northern stacks feed the
northern runway, southern stacks the southern one:

| Stack | Side | Natural runway in westerlies |
|---|---|---|
| BNN | north | 27R |
| LAM | north | 27R |
| BIG | south | 27L |
| OCK | south | 27L |

Followed strictly, that gives two clean, non-interacting streams. Two caveats worth knowing:

- **It is a principle, not a procedure.** Real runway allocation also has to consider which
  terminal a flight is parking at, so crossing traffic genuinely happens and is managed
  deliberately rather than avoided absolutely.
- **Balance beats purity.** If three of your four stacks are feeding 27R and OCK is empty, you
  are running one runway at capacity and the other at a trickle. Crossing an aircraft to the
  quiet runway costs track miles and attention, but an idle runway costs movements.

---

## 4. The shape of a vector from hold to touchdown

Every arrival flies the same four-phase shape. Learning it as a shape rather than as a list of
instructions is what makes the sequence start to feel automatic.

```
   1. LEAVE THE HOLD                 2. DOWNWIND / BASE
      off the bottom, on a              a leg roughly across the
      heading toward the base           final approach track --
      leg, descending                   where spacing is made

              |                                 |
              v                                 v

        (stack) - - - - - - - - - - - - - - - +
                                              |
                                              |
   4. INTERCEPT               3. CLOSING HEADING
      30 deg or less to          turn in, level at 3,000 ft,
      the centreline, at         30 deg of cut or less
      or below 3,000 ft
                                              |
   ==============[ 27R ]======================+
       threshold      FAF at 10 NM
```

**1. Leaving the hold.** Bottom of the stack, descending, on a heading that takes it toward
where you want its base leg to be. This is the moment its position in the sequence is fixed.

**2. Downwind and base.** The base leg is where sequencing is actually done. It runs roughly
across the final approach track, and its length is how you set the gap behind the aircraft in
front: extend it and the gap grows, cut it short and the gap closes.

**3. The closing heading.** Turn toward the centreline with a cut of **30 deg or less**
*(config: `minInterceptDeg`)*, and be **level at or below 3,000 ft** *(config:
`interceptAltMaxFt`)* before you get there. A steeper cut than 30 deg and the aircraft goes
straight through the localizer instead of capturing it.

**4. Localizer and glideslope.** The **FAF is 10 NM** from the threshold *(config)* and the
glideslope is **3 deg** *(config)*.

Note that reaching the FAF and reaching the glideslope are **not the same event**. A 3 degree
slope climbs about 318 ft per mile, which puts it at roughly 3,262 ft over the 10 NM FAF. An
aircraft levelled at 3,000 ft is therefore *below* the glideslope at the FAF and captures it
from underneath, at about 9.2 NM. That is correct procedure, and it is the reason the intercept
altitude is 3,000 rather than a figure matched to the FAF.

---

## 5. Spacing: the two dials

The separation minima are **3.0 NM laterally**, or **1,000 ft vertically** where you have less
than 3 NM. On final the aircraft are co-altitude on the same track, so only the lateral figure
is available to you -- which is exactly what makes final approach the hard part.

There are two ways to change a gap, and they work on different timescales.

**Track miles -- the coarse dial.** Making an aircraft fly further is the only way to open a
gap by a large amount. The base leg is where you do it. Once an aircraft is on the closing
heading, this dial is gone.

**Speed -- the fine dial.** Speed control adjusts spacing without adding distance, and it is
what you use from about the base leg inwards. The conventional profile:

| Phase | Speed |
|---|---|
| In the sector, below FL100 | 250 kt *(config: `speedLimitKts` below `speedLimitBelowFt`)* |
| Downwind and base | about 220 kt |
| Closing heading | about 180 kt |
| Final | 160 kt to 4 NM, then approach speed |

Approach speeds in the config run from 135 kt for an A319 to about 152 kt for a B77W, so the
aircraft in your stream do not all decelerate alike. A heavy that is slow to slow down will
eat a gap you thought was safe.

### Wake turbulence changes the order, not just the gap

The config carries wake categories **L, M, H and J** -- light, medium, heavy and super
*(config)*. The MVP applies a flat 3 NM to everything, with the real 4 / 5 / 6 NM minima
behind heavier aircraft parked as post-MVP work, but the sequencing consequence is worth
building the habit for now:

- An **A388 (J)** or a **B77W (H)** ahead of an **A319 (M)** needs far more than 3 NM, which
  costs you a movement.
- Two heavies in a row cost less than a heavy followed by a medium.
- Because BNN carries the transatlantic long-haul, the northern runway tends to accumulate the
  wake-expensive pairings. That is an argument for watching 27R's spacing harder than 27L's.

So the order you take aircraft out of the stacks in is not only about who has been waiting
longest. It is also about not creating an expensive wake pairing when a cheap one was
available.

---

## 6. The errors that cost the most

| Error | What it looks like | What it costs |
|---|---|---|
| Pulling from the middle of a stack | An aircraft descending through an occupied level | A separation loss, and a stranded aircraft below it |
| Descending too late | It reaches the centreline above 3,000 ft | No capture -- it flies through and must be re-sequenced |
| Cutting in too steeply | More than 30 deg on the closing heading | Straight through the localizer |
| Over-spacing | A tidy stream with 6 NM gaps | Roughly a third of the landing rate, silently |
| Turning in too close | Two aircraft inside 3 NM on final, co-altitude | A separation loss with no vertical escape left |
| Loading one runway | Three stacks feeding 27R, OCK idle | Half the capacity |

Over-spacing is the one that never feels like a mistake. Nothing flashes, nobody is unsafe, and
the score is quietly halved. Sequencing well means running consistently *at* the minimum, not
comfortably above it.

---

## 7. A worked sequence

A Bovingdon arrival onto 27R, as an illustration of the shape:

1. **BNN, bottom of the stack, 7,000 ft.** It is 15.7 NM north of the field, and 27R's final
   approach track runs east to west. It has to end up on that track, westbound, at or below
   3,000 ft, with 30 deg or less of cut.
2. **Leave the hold** on a southerly heading, descending. There are about 11 NM of descent to
   fly to reach 3,000 ft at 250 kt, which is roughly what the geometry gives you -- so the
   descent starts as it leaves the hold, not later.
3. **Downwind, then base.** Turn it onto a base leg to the south, staying north of the extended
   centreline, and set the length of that leg from where the previous 27R arrival is. Reduce to
   about 220 kt.
4. **Closing heading.** Level at 3,000 ft, turn to about 240 -- a 30 deg cut onto the 270 final
   approach track. Reduce to 180 kt.
5. **Cleared the approach.** It captures the localizer, picks the glideslope up from below at
   about 9.2 NM, and 160 kt to 4 NM stops it closing on the aircraft ahead.

The next 27R arrival -- another BNN level, or something out of LAM -- is then built to the same
shape, with its base leg set to leave exactly 3 NM, plus whatever the wake pairing demands,
behind this one at the threshold.
