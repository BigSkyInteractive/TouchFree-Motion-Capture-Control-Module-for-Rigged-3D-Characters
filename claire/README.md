# Claire — MediaPipe webcam motion capture driving a Mixamo character in three.js

A complete, shipping example of **MediaPipe-to-VMC motion capture**: one
webcam, no suit, no wearables, driving a **Mixamo character** live in the
browser through **Unity-standard Humanoid bone rotations**. This is the
production demo page from [TouchFree](https://bigskyinteractive.com), posted
whole: scene, set, camera framing, and the full rigging translation.

## The translation chain

```
webcam
  → MediaPipe BlazePose (33 body landmarks) + MediaPipe Hand Landmarker (21 per hand)
  → TouchFree sender: bone solve, smoothing, handoff blending
      · Unity HumanBodyBones names (the VMC standard's own vocabulary)
      · local, parent-relative quaternions [x, y, z, w]
      · deltas from the VRM 1.0 T-pose (arms along X, palms down)
  → wire: VMC protocol (OSC/UDP) for avatar apps,
          or the same bones as JSON over WebSocket (schema tf-bones-1)
  → VmcMixamoRig (vmc_mixamo.js): Unity → glTF handedness,
      name mapping, exact one-pass chain solve, bind-pose retargeting
  → Mixamo rig, skinned and rendered in three.js
```

The design principle throughout: **rotations are solved once, on the
sender**. A receiver never computes a rotation from landmarks; every
receiver on every platform shows the same body.

## What this example demonstrates (the hard-won parts)

Each of these was a real, measured bug before it was a technique. They are
documented in the code where they live:

- **Unity Humanoid → glTF/three.js handedness**: the frames differ in x
  alone; every local quaternion converts as `(x, y, z, w) → (x, −y, −z, w)`.
- **glTF name sanitising**: `mixamorig:Hips` becomes `mixamorigHips` on
  import; lookups must match the normalised tail or every bone fails
  silently at once.
- **The exact one-pass chain solve**: never read a parent's world rotation
  from the scene graph mid-update — that is last frame's, and a finger four
  bones deep never converges (it writhes).
- **Constant bind-time rest-direction correction (C0)**: a Mixamo rig's
  thumb rests ~30° off the canonical VRM thumb axis. The correction must be
  a constant measured at bind — a per-frame shortest-arc swing has no twist
  control and rolls fingers with the pose.
- **Mirror in CSS, never in the scene**: a negative scale corrupts every
  rotation recovered from world matrices.
- **Camera framing that follows the performer**: MediaPipe estimates
  landmarks it cannot see, so the page frames the character the way the
  camera frames the person and never animates invented legs.

## Running it

The page expects a TouchFree sender broadcasting `body_state` on
`ws://<host>:8080/ws` (schema `tf-bones-1`). Serve this folder from the
TouchFree machine (it ships as a TouchFree content page) or from any static
server on the same origin, and open `index.html`. To adapt it to your own
character, start with `../RECEIVER_KIT.md` — a complete integration brief
you can hand directly to an AI assistant.

## Files

| File | Role |
|---|---|
| `index.html` | The page shell, canvas, CSS mirror |
| `claire_rig.js` | The page: scene, set, lights, camera framing, WebSocket, schema pin |
| `vmc_mixamo.js` | The rigging translation module (same file as the kit root) |
| `claire_normalized.glb` | The character — a Mixamo rig, normalized (every rest rotation identity, the VRM convention) |
| `lib/` | three.js (MIT), vendored |
| `images/` | The shop set artwork |

## Licensing

The **code** is MIT (repository license). **Claire herself is an Adobe
Mixamo character**, included here as part of this demo project under the
Mixamo license — she is not covered by the MIT license and is not offered
for standalone reuse. The set artwork is Big Sky Interactive's, included
for the demo.
