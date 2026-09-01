# Z1 Control UX mockups

These images are the agreed UX baselines for the Surface Pro kiosk. They are
design references, not pixel-perfect implementation specifications.

## Locked baselines

- `baseline-idle-jog.png` — default Surface view while the machine is idle.
  The Surface acts as a dedicated digital jog pendant: XY, Z and guarded A-axis
  movement, step/continuous modes, position readout, and machine actions. No
  camera belongs on this primary jog surface.
- `baseline-active-job-overview.png` — overview while a job is running. Camera,
  progress, coordinates, machine state and job controls are visible together.

## State and device behavior

- Surface kiosk default while idle: Jog.
- Running job: Active Job / Overview.
- Tool change, rotation pause or other required input: dedicated attention
  state with one clear next action.
- After a completed job: return to Jog.
- Phone default: Overview / Camera.
- Start view and automatic state switching are configurable per device.
- Jog controls may remain spatially stable while unavailable, but must be
  visibly locked whenever the machine is not freshly Idle.

## Safety interaction contract

- Releasing touch, losing pointer capture, losing the connection, receiving
  stale status, or leaving Idle stops or rejects jog motion.
- Continuous jog requires continuous deliberate contact; step mode moves one
  selected increment per activation.
- The A axis is visually separated and guarded against accidental activation.
- Software STOP is prominent but never represented as a replacement for the
  machine's physical emergency stop.
- Saved positions, if added, must use a verified safe motion sequence (safe Z
  before XY) and may not imply obstacle awareness the machine does not have.

## Committed jog prototypes

The first Surface implementation must make these three input methods available
against the same jog backend and safety policy. The operator can switch between
them without losing the selected step, speed, coordinate system or current
machine state.

1. `baseline-idle-jog.png` — conventional directional control. This is the
   control case for physical testing, not an assumed final winner.
2. `concept-virtual-mpg.png` — axis-first interaction inspired by physical MPG
   pendants. Select exactly one axis and turn a virtual incremental wheel for
   fine positioning. Longer travel uses a deliberate press-and-hold negative or
   positive control, so repeated tapping is never required. The virtual wheel
   has no inertial/coasting motion after release. A remains guarded.
3. `concept-spatial-map.png` — only its top-down XY destination map is committed
   for integration, opened from a compact action in the main Jog view. Touching
   the map chooses and previews an XY target; it does not move the machine by
   itself. Z remains under the normal jog controls. A may be added to the dialog
   later, but is not part of the first map experiment.

The map is not a claim of obstacle awareness. A move requires a deliberate
hold-to-run confirmation and an explicit, verified safe-Z-then-XY sequence.
Named locations such as front, clamp access and tool change may coexist with
free XY target selection.

### Current XY-map backend gap

The first web implementation deliberately provides only the map's XY target
preview. The existing `target` jog WebSocket message begins a move as soon as
it is accepted, so it cannot truthfully provide the required hold-to-run
interaction. Do not wire the map preview to that message. Server work is still
needed for a server-authoritative target preview, continuous hold lease and
verified safe-Z-then-XY execution before the map can move the machine.

The current jog service exposes X/Y/Z only. A-axis controls remain absent from
the Surface prototype until the backend can enforce the same motion lease and
safety policy for that axis.

## Physical evaluation

The three methods are intentionally implemented before choosing a winner. Test
them on the Surface and real Z1 for representative setup tasks:

- move from an arbitrary position to the front/clamping area;
- make coarse then fine X/Y/Z adjustments;
- approach a known edge or probing position;
- reach a repeated saved/setup position;
- stop continuous movement by releasing touch and by breaking the connection.

Record task time, number of touches, accidental selections, overshoot, and the
operator's confidence. The preferred input method is stored per device. The
other methods remain available unless physical testing shows one to be unsafe
or consistently inferior.

## External design references

- Carbide 3D Jog Pendant: selected axis + incremental wheel, separate held
  continuous-jog controls, and explicit behavior on disconnect.
  <https://carbide3d.com/hub/docs/jog-pendant-quick-start/>
- Carbide Motion Rapid Positioning: named corners/center reduce tedious long
  manual traverses.
  <https://carbide3d.com/carbidemotion/>
- Haas RJH-Touch XL: setup, offsets, tool changes and jogging are kept near the
  workpiece, with precise speed control.
  <https://www.haascnc.com/productivity/control/rjh-touch-xl.html>
- MASSO Jogging: explicit step/continuous modes, held continuous movement and
  visible soft-limit feedback.
  <https://docs.masso.com.au/getting-started-guides/machining-with-masso/keyboard-and-key-shortcuts/rapid-jog>
- Tormach PathPilot: metric step sizes from 0.01 mm to 10 mm and separate
  continuous velocity mode; jogging is not permitted during program execution.
  <https://knowledgebase.tormach.com/1100mx/pathpilot-tools-and-features-1100mx>
