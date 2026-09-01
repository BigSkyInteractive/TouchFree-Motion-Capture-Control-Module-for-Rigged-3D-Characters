# TouchFree Receiver kit for VMC motion capture to Unity Standard Rigged 3D Charactes / three.js

Webcam **motion capture without wearables**: [TouchFree](https://bigskyinteractive.com)
tracks a person's body and hands with Body and Hand VMC Output from TouchFree Desktop.

Solves the skeleton into **Unity-standard Humanoid bone
rotations** — the **VMC protocol's** own vocabulary — and broadcasts them.
This kit is everything a receiver needs to drive a rigged 3D character from
that stream: a **Mixamo model translation** module for three.js, a complete
integration brief written for AI assistants, and the full production demo.

**TouchFree → VMC, based on the Unity standard, translated to Adobe Mixamo 3D character rigs.**

## Quickstart: hand it to your AI

Give your AI assistant (Claude, ChatGPT, Copilot, …) two files from this
repo and one sentence:

> Read `RECEIVER_KIT.md` and `vmc_mixamo.js`, then build me a web page that
> drives my glTF character from TouchFree.

`RECEIVER_KIT.md` is a complete, self-contained brief: the wire contract
(schema `tf-bones-1`), the coordinate conventions (Unity left-handed →
glTF right-handed), the module API, and the pitfalls the module already
solves. Your assistant should not need to guess at anything.

## Using avatar software instead? (VSeeFace, Warudo, Unity, Blender)

No code needed: TouchFree speaks the standard **VMC protocol** (Virtual
Motion Capture, OSC over UDP). Enable the Avatar Stream on TouchFree's
Output page and point your avatar software at it (default port 39539).
Bone names are Unity `HumanBodyBones`; rotations are deltas from the
**VRM 1.0 T-pose**, so a VRM avatar applies them directly.

## The full demo: Claire

[`claire/`](claire/) is the complete shipping demo — a Mixamo character in
a three.js scene, driven live: body, hands, and all thirty finger joints,
with camera framing that follows the performer. Its
[README](claire/README.md) documents the whole translation chain and every
technique the code uses, from Unity→glTF handedness to the constant
bind-time retargeting correction that keeps Mixamo thumbs honest.

## What's in this repository

| Path | What it is |
|---|---|
| [`RECEIVER_KIT.md`](RECEIVER_KIT.md) | The integration brief — written to be handed to an AI assistant |
| [`vmc_mixamo.js`](vmc_mixamo.js) | The rigging translation: Unity Humanoid bones → Mixamo rig, one dependency-free ES module |
| [`examples/minimal.html`](examples/minimal.html) | The smallest complete working page |
| [`claire/`](claire/) | The full production demo: scene, set, framing, character |

## How the translation works

1. **Sender-side solve.** TouchFree turns MediaPipe landmarks into finished
   bone rotations — local, parent-relative quaternions `[x, y, z, w]`,
   measured from the canonical VRM T-pose. Receivers never do landmark
   math; every receiver shows the same body.
2. **Two transports, same bones.** The VMC protocol for avatar apps; JSON
   over WebSocket (`body_state`, schema `tf-bones-1`) for web pages.
3. **Receiver-side retargeting.** `vmc_mixamo.js` maps Unity bone names to
   Mixamo's, converts handedness, solves the bone chain exactly in one
   pass, and corrects each bone through its own measured bind direction —
   the same job Unity's Humanoid Avatar does internally, written out for
   three.js.

## Also from TouchFree

Building **2D experiences** from the landmark stream instead of driving a
3D rig:

- [touchfree-fluid-body](https://github.com/BigSkyInteractive/touchfree-fluid-body)
  — body tracking driving a WebGL fluid simulation, fully configurable
  from one JSON
- [touchfree-puppet-2d](https://github.com/BigSkyInteractive/touchfree-puppet-2d)
  — a layered 2D cartoon puppet that copies the person, Character
  Animator-style

## Versioning

The wire format is frozen as schema **`tf-bones-1`** and guarded by a
byte-identical golden test in the TouchFree product. Releases of this kit
are tagged to the schema they speak; a schema change is always a new tag,
never a silent edit.

## Keywords

MediaPipe motion capture · VMC protocol · Virtual Motion Capture · Unity
Humanoid bones · HumanBodyBones · Mixamo retargeting · three.js rigged
character · VRM T-pose · BlazePose · hand tracking · finger tracking ·
webcam mocap · markerless motion capture · glTF avatar · VTuber tooling

## License

Code: MIT — see [LICENSE](LICENSE). The Claire character in `claire/` is an
Adobe Mixamo asset included as part of the demo project under the Mixamo
license (see [claire/README.md](claire/README.md)).
