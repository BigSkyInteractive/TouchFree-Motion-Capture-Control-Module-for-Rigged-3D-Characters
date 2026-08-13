/*
Claire — a Mixamo character driven live from the body data.

THE RECEIVER IS ONE MODULE. All rigging translation — name mapping, bind
capture, Unity->glTF conversion, the parents-first exact chain solve, easing,
idle — lives in vmc_mixamo.js (VmcMixamoRig). This page owns everything that
is a PAGE: the scene and set, the lights, the camera framing that follows how
the performer is framed, the WebSocket, and the hint text. It holds no
retarget maths of its own; a second copy in the page is how a fix becomes
invisible on screen.

THE RIG IS NORMALIZED. claire_normalized.glb (tools/normalize_glb_rig.py) has
every humanoid rest rotation at identity, which is what VRM mandates and what
Unity's Avatar constructs internally — so the incoming rotation IS the bone's
world rotation and there is no per-model correction to get wrong. The
translator still measures the bind pose it is given, so a non-normalized rig
degrades honestly rather than silently.

THE WIRE IS PINNED. body_state.payload.schema must be "tf-bones-1"
(docs/V6/V6_BONE_AUTHORITY.md, frozen by tools/test_wire_golden.py). A
mismatch faults the page loudly and stops driving the rig — garbage motion
blamed on the rig is worse than a plain message.

The mirror is CSS on the canvas (index.html), never a negative scale in the
scene: a mirrored world matrix has determinant -1 and rotations cannot be
recovered from it. The data stays anatomical — the performer's right hand
drives RightHand, exactly as every VMC receiver must be given.
*/
import * as THREE from './lib/three.module.min.js';
import { GLTFLoader } from './lib/loaders/GLTFLoader.js';
import { VmcMixamoRig, normName } from './vmc_mixamo.js';

// The wire contract this page speaks. Must match edge/broadcaster.BONES_SCHEMA.
const SCHEMA = 'tf-bones-1';

const $ = (id) => document.getElementById(id);
const fault = (msg) => {
  const el = $('fault');
  el.textContent = msg;
  el.style.display = 'block';
  console.error('[claire]', msg);
};

// ---------------------------------------------------------------- scene
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
$('stage').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x11121a);
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
camera.position.set(0, 1.25, 3.2);
camera.lookAt(0, 1.0, 0);

// MATCH THE CAMERA'S FRAMING, so what is off screen for the performer is off
// screen for her too.
//
// MediaPipe does not stop at the edge of the picture: it ESTIMATES landmarks it
// cannot see. Stand close enough to be cropped at the chest and it still
// reports hips, knees and ankles, invented from the part of you it can see, and
// those inventions wander. Driving a rig from them is why her legs and hips
// flopped -- the rig was faithfully following guesses.
//
// Rather than smooth the guesses or freeze the limbs, frame her the way the
// camera frames the performer. Cropped at the chest in the room means cropped
// at the chest on screen: the invented parts are simply not in shot, which is
// both the honest picture and the one that matches what the user sees of
// themselves.
//
// Bones that count as "at least down to the hips" for the whole-person test.
const SEEN_BELOW_HIPS = new Set(
  ['Hips', 'LeftLowerLeg', 'RightLowerLeg', 'LeftFoot', 'RightFoot']);

const FRAME_MARKS = [
  { kp: 0, bone: 'Head' },                                   // nose
  { kp: 5, bone: 'LeftUpperArm' }, { kp: 6, bone: 'RightUpperArm' },
  { kp: 9, bone: 'LeftHand' }, { kp: 10, bone: 'RightHand' },
  { kp: 11, bone: 'Hips' }, { kp: 12, bone: 'Hips' },
  { kp: 13, bone: 'LeftLowerLeg' }, { kp: 14, bone: 'RightLowerLeg' },
  { kp: 15, bone: 'LeftFoot' }, { kp: 16, bone: 'RightFoot' },
];

// How much of the picture the performer fills, and where. Null until a body
// arrives, which is when framing has any meaning.
let frameTarget = null;      // the framing just measured
let frameSmooth = null;      // that measurement, low-passed
// THE TOP OF HER HEAD. The Head BONE sits at the base of the skull, so framing
// to it leaves the whole cranium outside the picture -- which is exactly how she
// came out cropped. This rig carries the crown as its own bone,
// mixamorig:HeadTop_End, so the real top is read from the skeleton and follows
// her when she moves.
//
// A bounding box was tried first and gave 0.41 against a head bone at 1.39:
// Box3.setFromObject measures a skinned mesh's BIND-POSE geometry, not where
// the skeleton actually puts it. The number was nonsense and only printing it
// showed that.
let headTopBone = null;
// The backdrop's world size, measured once when its texture loads. The camera's
// pull-back limit comes from this.
let backdropSize = null;

const FRAME = {
  // HEADROOM. Without this the camera frames the performer's exact extent, so
  // the topmost landmark -- the nose -- lands on the edge of the picture and
  // the top of her head is outside it. A person is taller than their nose.
  margin: 1.35,

  // HOW FAST THE MEASUREMENT MAY CHANGE. The jerking forward and back is not
  // the easing being too quick, it is the TARGET jumping: the span comes from
  // whichever landmarks are visible AND inside the picture, so an ankle
  // flickering across the frame edge changes the measured height of the person
  // in one step, and the camera lunges to match. Low-passing the measurement
  // absorbs that; easing alone cannot, because it faithfully follows a target
  // that is itself jumping.
  smooth: 0.04,

  // How fast the camera then moves toward the smoothed framing.
  ease: 0.06,

  // WHERE HER EYES SIT, as a fraction DOWN the frame. 0 is the top edge, 1 the
  // bottom. 1/3 down is two thirds UP -- the standard portrait line, and it
  // leaves the lower part of the picture for the counter.
  eyeFrac: 0.333,

  // Closest the camera may come, in metres. Nearer than this and she fills the
  // frame with no room for the set.
  minDist: 1.6,

  // Where her eyes are between the Head bone and the crown, as a fraction. Not
  // a guess about anatomy in general: read off THIS rig, whose head bone is at
  // 1.395 and crown at 1.765.
  eyeUpFromHeadBone: 0.68,

  // And a hard speed limit, in metres per second. A landmark appearing or
  // disappearing can move the measurement a long way in one frame; this is what
  // guarantees the camera never snaps however wrong the measurement goes.
  maxRate: 0.5,

  // HOW MUCH OF THE MEASURED ZOOM TRAVEL IS USED. The full range pulled the
  // camera far enough back that the counter left the picture; half the
  // excursion keeps the framing responsive without leaving the set
  // (Tim, 2026-08-12: "the zoom movement should be half of what it is").
  zoomScale: 0.5,

  // The desk stays in shot: at least this many metres of the counter,
  // below its surface, must remain inside the bottom of the picture.
  counterMarginM: 0.15,
};

// A landmark counts only if it is confident AND actually inside the picture.
// Confidence alone is not enough -- MediaPipe reports a perfectly confident
// ankle a foot below the bottom of frame.
const IN_FRAME_VIS = 0.5;   // the server's own threshold (edge/body_detector.py)

// ---------------------------------------------------------------- the set
//
// The shop is TWO PLANES IN THE SCENE, not layers over the canvas: a backdrop
// behind her and a counter in front. Put in the 3D world, the camera that
// already tracks how the performer is framed gives correct parallax for free --
// step closer and the counter grows and drops away while the far wall barely
// moves, because that is what perspective does. Scaling DOM layers by hand
// would be re-deriving perspective badly.
//
// Every number here is in METRES and meant to be tuned. She is about 1.7 m
// tall standing on y = 0.
const SET = {
  backdrop: {
    image: 'images/store-back-wall.jpg',
    width: 7.0,     // wide enough that it still fills frame when the camera pulls back
    y: 1.35,        // centre height; her eyes are near 1.55
    z: -2.2,        // behind her
  },
  counter: {
    image: 'images/store-counter.png',   // keyed to alpha by tools/chroma_key.py
    width: 3.2,
    z: 0.75,        // in FRONT of her, between her and the camera
    // Where the counter SURFACE should sit, and where that surface falls inside
    // the picture. tools/chroma_key.py measured the artwork starting 42% down,
    // so the plane is positioned from that rather than by eye -- change the
    // picture and only this fraction needs revisiting.
    topY: 1.02,     // a shop counter is about a metre tall
    topFrac: 0.42,
  },
};

function addPlane(url, width, y, z, { transparent = false, topFrac = null,
                                      topY = null, onSized = null } = {}) {
  const tex = new THREE.TextureLoader().load(url, (t) => {
    // Size from the image's real aspect: guessing it distorts the artwork, and
    // the counter's perspective is drawn in, so a stretched one reads wrong.
    const h = width * (t.image.height / t.image.width);
    mesh.scale.set(1, h / width, 1);
    if (onSized) onSized(width, h);
    if (topFrac !== null && topY !== null) {
      // Put the drawn surface at topY: the plane's own top is that much higher.
      mesh.position.y = topY + h * topFrac - h / 2;
    }
  });
  tex.colorSpace = THREE.SRGBColorSpace;
  // THE CANVAS IS MIRRORED (index.html flips it so she reads as a reflection),
  // which would flip the artwork and its lettering with it. Flip the TEXTURE
  // back so the set reads correctly on screen. Doing it here rather than
  // flipping the files keeps the source images as they were generated.
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.x = -1;
  tex.offset.x = 1;

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, width),
    new THREE.MeshBasicMaterial({
      map: tex,
      transparent,
      // A keyed PNG has soft edges; discarding nearly-clear pixels stops them
      // writing depth and cutting a halo out of whatever is behind.
      alphaTest: transparent ? 0.5 : 0,
      toneMapped: false,     // it is already lit artwork, not geometry to light
    }));
  mesh.position.set(0, y, z);
  mesh.renderOrder = transparent ? 2 : 0;
  scene.add(mesh);
  return mesh;
}

addPlane(SET.backdrop.image, SET.backdrop.width, SET.backdrop.y, SET.backdrop.z,
         { onSized: (w, h) => { backdropSize = { w, h }; } });
const counterMesh = addPlane(
  SET.counter.image, SET.counter.width, SET.counter.topY, SET.counter.z,
  { transparent: true, topFrac: SET.counter.topFrac, topY: SET.counter.topY });

// The set is lit artwork, so the scene background no longer shows through.
// Keep a dark clear colour for the moment before the textures load.

// Three lights, not one. A single light makes a skinned mesh read as a flat
// cutout, which is the look this whole exercise exists to get away from.
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x30203a, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 2.0);
key.position.set(2.5, 4, 3);
scene.add(key);
const rim = new THREE.DirectionalLight(0xff6fb0, 1.2);
rim.position.set(-3, 2, -2.5);
scene.add(rim);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- model
// THE TRANSLATOR. Defaults match how this page always ran: ease 0.35 bridges
// 30 Hz data to a 60 fps render; arms relax to idle after 250 ms of absence;
// fingers hold their shape rather than springing open.
const rig = new VmcMixamoRig(THREE);

// The palm normal at bind, per hand, for the test seam below. Built from the
// same three points the sender measures on the performer -- wrist, index
// knuckle, little knuckle -- so screen and wire can be compared directly.
const bindPalm = {};

new GLTFLoader().load('claire_normalized.glb', (gltf) => {
  scene.add(gltf.scene);
  gltf.scene.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
  scene.updateMatrixWorld(true);

  // THE CROWN. Searched over every node, not only bones: Mixamo exports
  // HeadTop_End as a leaf that glTF may carry as a plain Object3D rather than
  // a Bone, so looking for it inside an isBone branch finds nothing.
  gltf.scene.traverse((o) => {
    if (!headTopBone
        && normName(o.name).replace(/^mixamorig/, '') === 'headtopend') {
      headTopBone = o;
    }
  });

  const problem = rig.bind(gltf.scene);
  if (problem) { fault(problem); return; }

  // Palm normal at bind: cross(hand direction, index knuckle -> little
  // knuckle), mirrored between the hands because they are mirror images.
  gltf.scene.traverse((o) => {
    if (!o.isBone) return;
    const k = normName(o.name).replace(/^mixamorig/, '');
    for (const side of ['Left', 'Right']) {
      if (k === (side + 'handindex1').toLowerCase()) bindPalm[side + '_idx'] = o;
      if (k === (side + 'handpinky1').toLowerCase()) bindPalm[side + '_lit'] = o;
    }
  });
  for (const side of ['Left', 'Right']) {
    const dir = rig._bindDir[side + 'Hand'];
    const idx = bindPalm[side + '_idx'], lit = bindPalm[side + '_lit'];
    if (!dir || !idx || !lit) continue;
    const a = idx.getWorldPosition(new THREE.Vector3());
    const b = lit.getWorldPosition(new THREE.Vector3());
    const across = side === 'Left' ? a.clone().sub(b) : b.clone().sub(a);
    const n = new THREE.Vector3().crossVectors(dir, across);
    if (n.lengthSq() > 1e-10) bindPalm[side + 'Hand'] = n.normalize();
  }

  $('hint').textContent = 'step into view';
}, undefined,
   (e) => fault('Could not load claire_normalized.glb: ' + e.message));

// ---------------------------------------------------------------- data
let schemaFaulted = false;

// HER FEET STAY ON THE FLOOR: the legs are not driven on this page.
//
// A page decision, not a translator one. MediaPipe ESTIMATES landmarks it
// cannot see (section 9 of the Mixamo doc), so a performer framed at the
// chest still produces hips, knees and ankles -- invented, wandering -- and
// a rig faithfully follows them, which is legs flailing under a counter.
// Undriven bones ease to the model's own bind pose: standing straight,
// feet planted. The Hips bone still drives, so she leans and turns.
const UNDRIVEN = new Set([
  'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot',
  'RightUpperLeg', 'RightLowerLeg', 'RightFoot',
]);

function onBody(payload) {
  // THE SCHEMA PIN. The wire is frozen as tf-bones-1; a different tag means a
  // sender this page was not written against, and driving the rig from it
  // produces plausible garbage that gets blamed on the rig. Fault once,
  // loudly, and stop.
  if (payload.schema !== SCHEMA) {
    if (!schemaFaulted) {
      schemaFaulted = true;
      fault(`This page speaks ${SCHEMA}; the server sent `
            + `${payload.schema === undefined ? 'no schema tag' : payload.schema}. `
            + 'Update whichever is older.');
    }
    return;
  }
  if (payload.bones) {
    const kept = {};
    for (const name in payload.bones) {
      if (!UNDRIVEN.has(name)) kept[name] = payload.bones[name];
    }
    rig.apply({ ...payload, bones: kept });
  } else {
    rig.apply(payload);
  }
  if (rig.ready) {
    const f = measureFraming(payload);
    if (f) frameTarget = f;    // keep the last good framing if this frame has none
  }
}

// A test seam. tools/test_claire_rig.py drives this with rotations produced by
// the REAL server retarget and reads back where her hands and feet land, so the
// page is checked against the server rather than against a second copy of the
// maths written in the test. Costs a few properties and no behaviour.
window.__claireRig = {
  onBody,
  boneWorldPosition(name) {
    const b = rig.bones[name];
    if (!b) return null;
    const v = new THREE.Vector3();
    b.getWorldPosition(v);
    return [v.x, v.y, v.z];
  },
  // The set's measured extents, so a test can check the camera never pulls
  // back past where the backdrop stops covering the picture.
  setExtents() {
    return { backdropZ: SET.backdrop.z, backdropY: SET.backdrop.y,
             backdropW: backdropSize ? backdropSize.w : null,
             backdropH: backdropSize ? backdropSize.h : null };
  },
  // Where a hand's palm actually faces right now, in scene space. The whole
  // point of the roll work, so a test can read it instead of assuming.
  palmNormal(side) {
    const hand = rig.bones[`${side}Hand`];
    const bp = bindPalm[`${side}Hand`];
    if (!hand || !bp) return null;
    const q = hand.getWorldQuaternion(new THREE.Quaternion());
    const bindQ = rig._bindWorldAll.get(hand).clone().invert();
    const n = bp.clone().applyQuaternion(q.clone().multiply(bindQ));
    return [n.x, n.y, n.z];
  },
  // Snap to the idle posture, so a test can read where a puppet at rest
  // actually puts its arms instead of taking the maths on trust.
  restPose() {
    for (const n in rig.bones) {
      if (rig._restLocal[n]) rig.bones[n].quaternion.copy(rig._restLocal[n]);
    }
    scene.updateMatrixWorld(true);
  },
  settle() {                     // jump straight to the target, skipping easing
    for (const n in rig.bones) rig.bones[n].quaternion.copy(rig._target[n]);
    scene.updateMatrixWorld(true);
  },
  get ready() { return rig.ready; },
  // One frame of easing, so a test can settle the framing without waiting on
  // requestAnimationFrame.
  step() { scene.updateMatrixWorld(true); applyFraming(1 / 60); },
  cameraState() {
    return { y: camera.position.y, z: camera.position.z, fov: camera.fov };
  },
  // What the framing is actually working from. Exists so a value can be read
  // rather than assumed -- the head-bone-versus-crown difference was invisible
  // until it was printed.
  framingRefs() {
    const v = new THREE.Vector3();
    if (rig.bones.Head) rig.bones.Head.getWorldPosition(v);
    const c = new THREE.Vector3();
    if (headTopBone) headTopBone.getWorldPosition(c);
    // The counter SURFACE, which is the edge a viewer sees. The mesh's
    // bounding box top is the transparent keyed-out area above it and says
    // nothing about whether the counter is visible.
    return { counter: counterMesh
               ? { surfaceY: SET.counter.topY, z: SET.counter.z }
               : null,
             headBoneY: rig.bones.Head ? v.y : null,
             crownY: headTopBone ? c.y : null,
             target: frameTarget, smooth: frameSmooth };
  },
};

// WHERE THE PERFORMER SITS IN THE PICTURE, as a fraction of frame height, and
// which of their body that span covers. Returns null when too little of them is
// in shot to say anything.
function measureFraming(payload) {
  const kp = payload.keypoints;
  const fh = payload.frame_h, fw = payload.frame_w;
  if (!kp || !fh || !fw) return null;

  let topN = 1, botN = 0;          // normalised image y, 0 top, 1 bottom
  let topBone = null, botBone = null;
  for (const { kp: i, bone } of FRAME_MARKS) {
    const p = kp[i];
    if (!p || p[3] < IN_FRAME_VIS) continue;
    const x = p[0], y = p[1];
    // Inside the picture, not merely confident.
    if (x < 0 || x > fw || y < 0 || y > fh) continue;
    if (!rig.bones[bone]) continue;
    const ny = y / fh;
    if (ny < topN) { topN = ny; topBone = bone; }
    if (ny > botN) { botN = ny; botBone = bone; }
  }
  if (!topBone || !botBone || botN - topN < 0.05) return null;

  // ONLY REFRAME ON A WHOLE PERSON. The span comes from whichever landmarks are
  // visible AND inside the picture, so a performer half out of shot produces a
  // span that changes every time a limb crosses the frame edge -- and the
  // camera chases it. Somebody sitting at a keyboard at the edge of frame had
  // her rocking back and forth continuously.
  //
  // Head down to hips is the test: that is a person, not a fragment. Anything
  // less returns null and the last good framing is kept.
  if (topBone !== 'Head' || !(botBone === 'Hips' || SEEN_BELOW_HIPS.has(botBone))) {
    return null;
  }

  // The same two body points on HER, in world space.
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  rig.bones[topBone].getWorldPosition(a);
  rig.bones[botBone].getWorldPosition(b);
  const spanY = Math.abs(a.y - b.y);
  if (spanY < 0.02) return null;

  // Fill the same fraction of the viewport that the performer fills of theirs.
  // For a perspective camera, a height H centred at distance d covers
  // H / (2 d tan(fov/2)) of the view, so d follows from the fraction wanted.
  // Divide by the margin so she fills LESS of the frame than the performer
  // fills theirs, which is the same as standing the camera further back.
  const frac = Math.min(1, botN - topN) / FRAME.margin;
  const fov = THREE.MathUtils.degToRad(camera.fov);
  let dist = spanY / (2 * frac * Math.tan(fov / 2));

  // THE SET HAS EDGES. Pull back far enough and the backdrop stops covering
  // the picture -- the wall becomes an object floating in the middle of the
  // view and the counter lifts off the bottom. So the camera may not go
  // further than the distance at which the backdrop still fills the frame.
  //
  // Derived from the backdrop's own measured size rather than a typed-in
  // number, so replacing the artwork does not silently break it.
  const t = Math.tan(fov / 2);
  if (backdropSize) {
    const byHeight = backdropSize.h / (2 * t) + SET.backdrop.z;
    const byWidth = backdropSize.w / (2 * t * camera.aspect) + SET.backdrop.z;
    dist = Math.min(dist, byHeight, byWidth);
  }
  dist = Math.max(dist, FRAME.minDist);

  // Half the excursion above the closest distance -- the measured range is
  // kept for responsiveness, its travel compressed so the camera never
  // wanders far from the set. Applied after the clamps so the scale acts on
  // the real usable range.
  dist = FRAME.minDist + (dist - FRAME.minDist) * FRAME.zoomScale;

  // Vertically, put the span where it sits in their picture rather than
  // centring it: cropped at the chest, the head belongs near the top, not in
  // the middle.
  const midWorld = (a.y + b.y) / 2;
  const halfView = dist * Math.tan(fov / 2);

  // HER EYES SIT AT A FIXED HEIGHT IN FRAME. Nothing about where the
  // performer happens to sit in their own picture enters this -- only the
  // distance above does.
  //
  // The camera looks horizontally at height lookY, so the viewport covers
  // lookY +/- halfView and a point at fraction f DOWN from the top sits at
  // world height lookY + halfView - 2*f*halfView. Setting that to her shoulder
  // height and solving:
  //
  //     lookY = shoulderY + halfView * (2f - 1)
  //
  // Checks at the extremes, which is the only way to be sure of the sign:
  // f = 0   -> lookY = shoulderY - halfView, viewport TOP    = shoulderY
  // f = 0.5 -> lookY = shoulderY,            centred
  // f = 1   -> lookY = shoulderY + halfView, viewport BOTTOM = shoulderY
  // Eye height is read from the rig rather than guessed: the Head bone sits at
  // the base of the skull and HeadTop_End is the crown, so her eyes lie a fixed
  // way up between them. Measured on this model, head bone 1.395 and crown
  // 1.765, which puts eyes near 1.65.
  const hb = new THREE.Vector3(), ct = new THREE.Vector3();
  let lookY = midWorld;
  if (rig.bones.Head && headTopBone) {
    rig.bones.Head.getWorldPosition(hb);
    headTopBone.getWorldPosition(ct);
    const eyeY = hb.y + (ct.y - hb.y) * FRAME.eyeUpFromHeadBone;
    lookY = eyeY + halfView * (2 * FRAME.eyeFrac - 1);
  }

  // THE DESK STAYS IN SHOT. The camera looks horizontally at lookY, so at
  // the counter's plane the picture covers lookY +/- (dist - z) tan(fov/2);
  // the bottom edge must reach counterMarginM below the counter surface or
  // the desk leaves the frame. Solving bottom <= topY - margin for lookY
  // gives the cap.
  const counterBand = (dist - SET.counter.z) * t;
  lookY = Math.min(lookY,
                   SET.counter.topY - FRAME.counterMarginM + counterBand);

  return { dist, lookY, midWorld };
}

function applyFraming(dtSeconds) {
  if (!frameTarget) return;

  // 1. Low-pass the MEASUREMENT. This is what absorbs a landmark crossing the
  //    edge of frame, which is the thing that made her lunge.
  if (!frameSmooth) {
    frameSmooth = { dist: frameTarget.dist, lookY: frameTarget.lookY };
  } else {
    frameSmooth.dist += (frameTarget.dist - frameSmooth.dist) * FRAME.smooth;
    frameSmooth.lookY += (frameTarget.lookY - frameSmooth.lookY) * FRAME.smooth;
  }

  // 2. Ease the camera toward the smoothed framing.
  let z = camera.position.z + (frameSmooth.dist - camera.position.z) * FRAME.ease;
  let y = camera.position.y + (frameSmooth.lookY - camera.position.y) * FRAME.ease;

  // 3. And cap the speed, so nothing can produce a snap. Framed in metres per
  //    second rather than per frame so it does not change with frame rate.
  const cap = FRAME.maxRate * Math.max(0.001, dtSeconds);
  z = camera.position.z + THREE.MathUtils.clamp(z - camera.position.z, -cap, cap);
  y = camera.position.y + THREE.MathUtils.clamp(y - camera.position.y, -cap, cap);

  camera.position.set(0, y, z);
  camera.lookAt(0, y, 0);
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(proto + '//' + location.host + '/ws');
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'body_state') onBody(m.payload);
  };
  ws.onclose = () => setTimeout(connect, 2000);
}

// Say when the layer is off rather than sitting there looking broken.
fetch('/api/kiosk/status').then((r) => r.json()).then((d) => {
  if (d.config && d.config.body_landmarks_enabled === false) {
    fault('Body landmarks are off. Turn them on in the Kiosk Manager, Control page.');
  } else {
    connect();
  }
}).catch(() => connect());

// ---------------------------------------------------------------- loop
let lastFrameMs = performance.now();

function frame() {
  requestAnimationFrame(frame);
  if (rig.ready) {
    rig.step();
    // Bones first, THEN framing: the framing is measured against where her
    // body actually is this frame, so it has to read the pose after it moved,
    // not the one before.
    scene.updateMatrixWorld(true);
    const now = performance.now();
    applyFraming((now - lastFrameMs) / 1000);
    lastFrameMs = now;
  }
  $('hint').style.opacity = (rig.ready && rig.lost()) ? '1' : '0';
  renderer.render(scene, camera);
}
frame();

// One line proving the GPU is real. ANGLE silently falls back to a software
// renderer, which is 60 fps against about 2, and nothing else says so.
const dbg = renderer.getContext().getExtension('WEBGL_debug_renderer_info');
if (dbg) {
  console.log('[claire] GL renderer:',
              renderer.getContext().getParameter(dbg.UNMASKED_RENDERER_WEBGL));
}
