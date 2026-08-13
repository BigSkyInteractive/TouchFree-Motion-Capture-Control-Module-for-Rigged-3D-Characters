# TouchFree Receiver Kit — build your own live character

This document is written to be handed, together with one file
(`vmc_mixamo.js`), to an AI assistant. Give both to Claude, ChatGPT, or a
similar tool and say: "build me a web page that drives my 3D character from
TouchFree using these." Everything the assistant needs is below; it should
not need to guess at anything.

TouchFree is a camera-based body and hand tracker. It runs on a machine on
your network and broadcasts a person's skeleton as finished BONE ROTATIONS,
solved and smoothed on the sender. A receiver never computes rotations from
landmarks; it applies them to a rig. That split is the design: every
receiver, on every platform, shows the same body.

---

## 1. Choose your transport (two ways in, same bones)

| You are building | Use | How |
|---|---|---|
| A web page (three.js) | **`body_state` WebSocket** | `ws://<touchfree-host>:8080/ws`, JSON messages |
| Unity, Unreal, VSeeFace, Warudo, VNyan, Blender | **VMC protocol** (OSC over UDP) | Enable the Avatar Stream on TouchFree's Output page; default port 39539 |

Avatar apps speak VMC natively — point them at the port and map your avatar;
no code needed. The rest of this kit is for the web path.

## 2. The wire contract (schema `tf-bones-1`)

Listen on the WebSocket for messages with `type === "body_state"`. The
`payload` carries:

- `payload.schema` — the string `"tf-bones-1"`. **Pin it.** If it ever
  differs, your receiver and the sender disagree about the format; show an
  error instead of animating garbage.
- `payload.person_present` — someone is there to be shown.
- `payload.bones` — the skeleton: Unity `HumanBodyBones` names mapped to
  quaternions `[x, y, z, w]`. Up to 15 body bones (`Hips`, `Spine`, `Head`,
  `Left/RightUpperArm`, `Left/RightLowerArm`, `Left/RightHand`,
  `Left/RightUpperLeg`, `Left/RightLowerLeg`, `Left/RightFoot`) plus 30
  finger bones (`LeftThumbProximal` … `RightLittleDistal`) when hand
  tracking is on.
- `payload.keypoints`, `payload.frame_w/h` — 2D landmark positions in the
  camera picture, for framing logic (optional).
- `payload.hands[side].landmarks_raw` — the raw 21 hand points (optional;
  the rig path does not need them).

What a bone rotation IS — the four facts that matter:

1. **Local**, relative to the bone's parent. Not a world orientation.
2. **A delta from the canonical rest pose** — the VRM 1.0 T-pose: standing
   toward +Z, arms along X, palms down, fingers along X, thumbs between +X
   and +Z. It is NOT the bone's absolute orientation.
3. **Unity's convention**: left-handed, +y up, +z the way the body faces,
   the person's own right at +x. (glTF/three.js is right-handed; the two
   differ in x alone, so converting a quaternion is `(x, y, z, w) →
   (x, -y, -z, w)`. The module does this.)
4. **Absent when unseen.** A bone the sender could not resolve is missing
   from the object that frame — never zeroed. Hold or relax it; never snap
   it to identity.

There are no bone positions and no fingertip data: rotations only. Your
model's own geometry supplies lengths, and the palm's direction is encoded
in the Hand bone's rotation.

## 3. The module: `vmc_mixamo.js`

A single self-contained ES module, no dependencies (you pass the three.js
namespace in). It does ALL the rigging translation:

```js
import { VmcMixamoRig } from './vmc_mixamo.js';

const rig = new VmcMixamoRig(THREE);
const problem = rig.bind(gltf.scene);   // after the model is in the scene
if (problem) showError(problem);        // names any missing body bone

ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type !== 'body_state') return;
  if (m.payload.schema !== 'tf-bones-1') { showError('schema mismatch'); return; }
  rig.apply(m.payload);
};

function frame() {                      // your render loop
  requestAnimationFrame(frame);
  rig.step();
  renderer.render(scene, camera);
}
```

What it handles so your assistant does not reinvent it (each of these was a
measured, shipped bug at some point):

- glTF name sanitising (`mixamorig:Hips` → `mixamorigHips`): matches on the
  normalised tail, so lookups survive any exporter.
- Unity→glTF conversion, per local rotation.
- The exact one-pass chain solve, parents first — never reading last
  frame's scene graph (that makes fingers writhe).
- A constant bind-time rest-direction correction per bone, so a rig whose
  thumb (or any bone) rests off the canonical axis is aimed correctly with
  a FIXED twist offset. Per-frame direction swings are the classic mistake:
  a shortest arc has no twist control and rolls fingers with the pose.
- Easing (30 Hz data on a 60 fps render), a gentle ramp for bones returning
  after absence, and arms relaxing to an idle after 250 ms of no data.
  Fingers hold their shape instead of springing open.

Public knobs (constructor `opts`): `ease` (default 0.5), `restAfterMs`
(250), `restEase` (0.05), `acquireRampMs` (400), `prefix` (`'mixamorig'`).

## 4. The model requirements

- A humanoid rig exported as **glTF/GLB**, in **T-pose**. Mixamo characters
  work directly (download as T-pose, convert FBX→GLB in Blender).
- Bone names: Mixamo's (`LeftArm`, `LeftForeArm`, `LeftHand`,
  `LeftHandIndex1` …). A different naming scheme means editing the module's
  `BONES` table — it is a plain map at the top of the file.
- Fingers are optional: a model without finger bones drives its body and
  reports nothing missing.
- A **normalized** rig (every rest rotation identity, the VRM convention)
  is ideal but not required — the module measures the bind pose it is
  given and corrects.

## 5. Conventions your page must respect

- **Mirror in CSS, never in the scene.** A viewer-facing page wants a
  mirror (`transform: scaleX(-1)` on the canvas). A negative scale inside
  the scene corrupts every rotation read from world matrices.
- The data stays **anatomical**: the person's real right hand drives
  `RightHand`, always.
- One page, one WebSocket, reconnect on close. The sender broadcasts at
  ~30 Hz; do not poll.

## 6. Checklist for the assistant

1. Load three.js, GLTFLoader, and the model; add to scene; `rig.bind`.
2. Connect the WebSocket; pin the schema; `rig.apply` per message.
3. `rig.step()` each render frame.
4. Mirror via CSS if the page shows the user themself.
5. Optional: use `rig.lost()` to fade in a "step into view" hint, and
   `payload.keypoints` to frame the character the way the camera frames
   the person.

A working reference implementation of all of this — scene, framing,
lighting, hint, schema pin — ships with TouchFree as the Claire demo page
(`claire_rig.js` beside the module). It is the page this module was
extracted from, and it is the answer to "show me how it's integrated."
