# TouchFree Receiver Kit

Drive your own 3D character, live, from [TouchFree](https://bigskyinteractive.com)
— the camera-based, touch-free body and hand tracker. TouchFree solves the
skeleton on the sender and broadcasts finished bone rotations; this kit is
everything a receiver needs.

## The fastest way to use it: hand it to your AI

Give your AI assistant (Claude, ChatGPT, Copilot, …) these two files and one
sentence:

> Read `RECEIVER_KIT.md` and `vmc_mixamo.js`, then build me a web page that
> drives my glTF character from TouchFree.

`RECEIVER_KIT.md` is a complete integration brief written for an AI: the wire
contract, the coordinate conventions, the module's API, and the pitfalls the
module already solves. `vmc_mixamo.js` is the whole rigging translation in
one dependency-free ES module.

## Using avatar software instead?

Unity, Unreal, VSeeFace, Warudo, VNyan and Blender don't need this kit's code
at all: enable the **Avatar Stream (VMC)** on TouchFree's Output page and
point your software at it (default port 39539). TouchFree speaks the standard
VMC protocol.

## What's here

| File | What it is |
|---|---|
| `RECEIVER_KIT.md` | The integration brief — written to be handed to an AI assistant |
| `vmc_mixamo.js` | The rigging translation: one self-contained ES module, no dependencies |
| `examples/minimal.html` | The smallest complete working page |

## Versioning

The wire format is frozen as schema **`tf-bones-1`** and guarded by a
byte-identical golden test in the TouchFree product. Releases of this kit are
tagged to the schema they speak; a schema change will always be a new tag,
never a silent edit.

## License

MIT — see [LICENSE](LICENSE).
