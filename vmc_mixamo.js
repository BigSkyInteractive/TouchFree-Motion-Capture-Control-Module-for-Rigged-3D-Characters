/**
 * vmc_mixamo.js — drive a Mixamo-rigged character from TouchFree's VMC output.
 *
 * STATUS: LIVE, and THE ONLY receiver implementation — claire_rig.js imports
 * this module and nothing else does the translation. Confirmed on screen in
 * TouchFree Dev 2026-08-12; the previous implementation
 * (humanoid_retarget.js) was deleted the same day.
 *
 * SELF-CONTAINED ON PURPOSE: this one file, plus three.js and a Mixamo GLB,
 * is everything a third party needs to drive their own character from the
 * body_state stream. It imports nothing (THREE comes in through the
 * constructor) and holds no page state. Wire contract: body_state payloads
 * with payload.schema "tf-bones-1" (docs/V6/V6_OUTPUT.md).
 *
 * SHARING THIS: hand docs/V6/V6_RECEIVER_KIT.md plus this file to any AI
 * assistant -- the kit is a complete, self-contained integration brief
 * written for one.
 *
 * ONE MODULE, ONE JOB. Give it a loaded glTF/GLB scene and feed it the
 * `body_state` payload from the WebSocket; it poses the rig. It knows nothing
 * about cameras, lights, framing, backdrops or which character is loaded, and
 * it holds no state belonging to a page.
 *
 *     import { VmcMixamoRig } from './vmc_mixamo.js';
 *
 *     const rig = new VmcMixamoRig(THREE);
 *     const problem = rig.bind(gltf.scene);      // null, or a message to show
 *     ws.onmessage = (e) => {
 *       const m = JSON.parse(e.data);
 *       if (m.type === 'body_state') rig.apply(m.payload);
 *     };
 *     function frame() {                          // in the render loop
 *       rig.step();
 *       renderer.render(scene, camera);
 *     }
 *
 * WHAT ARRIVES. `payload.bones` is Unity `HumanBodyBones` names mapped to
 * quaternions (x, y, z, w). Each is a LOCAL rotation, parent-relative, measured
 * from the canonical humanoid rest pose — the VRM 1.0 T-pose: facing +Z, arms
 * along X, palms toward -Y, four fingers parallel to X, thumb between +X and
 * +Z. A bone the sender could not see is ABSENT from the object, never zeroed.
 *
 * THE MIRROR IS IN CSS, NOT IN THE SCENE. A page showing users themselves
 * wants a reflection, so put `transform: scaleX(-1)` on the canvas.
 *
 * Mirroring the scene instead — a negative scale on a wrapper group — looks
 * equivalent and is not: it gives the world matrix a negative determinant, and
 * the retarget below calls getWorldQuaternion on parent bones, which decomposes
 * that matrix. Rotation cannot be recovered reliably from a mirrored matrix,
 * and the measured result was arms rising while the performer's arms went down,
 * with left/right and forward/back still correct. Flipping the finished image
 * touches no matrices at all.
 *
 * THE DATA STAYS ANATOMICAL either way: the performer's right hand drives
 * RightHand. That is what every OSC and VMC receiver must be given, and the
 * reflection is purely what the viewer sees.
 */

// ---------------------------------------------------------------------------
// The humanoid standard: names, hierarchy, canonical rest pose.
// None of this is about any particular model.
// ---------------------------------------------------------------------------

export const FINGERS = [['Thumb', 'Thumb'], ['Index', 'Index'],
                        ['Middle', 'Middle'], ['Ring', 'Ring'],
                        ['Little', 'Pinky']];
export const PARTS = ['Proximal', 'Intermediate', 'Distal'];

export const PARENT = {
  Hips: null, Spine: 'Hips', Head: 'Spine',
  LeftUpperArm: 'Spine', LeftLowerArm: 'LeftUpperArm', LeftHand: 'LeftLowerArm',
  RightUpperArm: 'Spine', RightLowerArm: 'RightUpperArm',
  RightHand: 'RightLowerArm',
  LeftUpperLeg: 'Hips', LeftLowerLeg: 'LeftUpperLeg', LeftFoot: 'LeftLowerLeg',
  RightUpperLeg: 'Hips', RightLowerLeg: 'RightUpperLeg',
  RightFoot: 'RightLowerLeg',
};
for (const side of ['Left', 'Right']) {
  for (const [unity] of FINGERS) {
    PARENT[`${side}${unity}Proximal`] = `${side}Hand`;
    PARENT[`${side}${unity}Intermediate`] = `${side}${unity}Proximal`;
    PARENT[`${side}${unity}Distal`] = `${side}${unity}Intermediate`;
  }
}

// PARENTS BEFORE CHILDREN. Each bone is solved against its parent's already
// known rotation, so the order is not cosmetic: a finger is four deep and would
// never arrive if walked out of order.
export const ORDER = [
  'Hips', 'Spine', 'Head',
  'LeftUpperArm', 'LeftLowerArm', 'LeftHand',
  'RightUpperArm', 'RightLowerArm', 'RightHand',
  'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot',
  'RightUpperLeg', 'RightLowerLeg', 'RightFoot',
];
for (const side of ['Left', 'Right']) {
  for (const [unity] of FINGERS) {
    for (const part of PARTS) ORDER.push(`${side}${unity}${part}`);
  }
}

// Unity HumanBodyBones name -> Mixamo bone name.
export const BONES = {
  Hips: 'Hips', Spine: 'Spine', Head: 'Head',
  LeftUpperArm: 'LeftArm', LeftLowerArm: 'LeftForeArm', LeftHand: 'LeftHand',
  RightUpperArm: 'RightArm', RightLowerArm: 'RightForeArm',
  RightHand: 'RightHand',
  LeftUpperLeg: 'LeftUpLeg', LeftLowerLeg: 'LeftLeg', LeftFoot: 'LeftFoot',
  RightUpperLeg: 'RightUpLeg', RightLowerLeg: 'RightLeg',
  RightFoot: 'RightFoot',
};
for (const side of ['Left', 'Right']) {
  for (const [unity, mixamo] of FINGERS) {
    PARTS.forEach((part, i) => {
      BONES[`${side}${unity}${part}`] = `${side}Hand${mixamo}${i + 1}`;
    });
  }
}

// WHERE EACH BONE POINTS IN THE CANONICAL REST POSE, in Unity's convention.
// x is negated on the way into a glTF scene; the two frames differ in x alone.
export const REST_DIR = {
  Spine: [0, 1, 0], Head: [0, 1, 0],
  LeftUpperArm: [-1, 0, 0], LeftLowerArm: [-1, 0, 0], LeftHand: [-1, 0, 0],
  RightUpperArm: [1, 0, 0], RightLowerArm: [1, 0, 0], RightHand: [1, 0, 0],
  LeftUpperLeg: [0, -1, 0], LeftLowerLeg: [0, -1, 0], LeftFoot: [0, 0, 1],
  RightUpperLeg: [0, -1, 0], RightLowerLeg: [0, -1, 0], RightFoot: [0, 0, 1],
};
// VRM 1.0's T-pose: "The four fingers, index, middle, ring, and little, of each
// hand must be in parallel to the X axis", and the thumb "directed between the
// +X axis and +Z axis". These must match what the sender measures from, bone
// for bone.
for (const side of ['Left', 'Right']) {
  const sx = side === 'Left' ? -1 : 1;
  const R = Math.SQRT1_2;
  for (const [unity] of FINGERS) {
    const along = unity === 'Thumb' ? [sx * R, 0, R] : [sx, 0, 0];
    for (const part of PARTS) REST_DIR[`${side}${unity}${part}`] = along;
  }
}

// WHERE A BONE HANGS WHEN NOTHING IS DRIVING IT. Arms only: a character with
// nothing driving an arm lets it hang, it does not keep the last thing it was
// told. Fingers are deliberately absent — a hand that stops arriving holds its
// shape rather than springing open.
export const IDLE_DIR = {
  LeftUpperArm: [0.34, -0.94, 0.02], RightUpperArm: [-0.34, -0.94, 0.02],
  LeftLowerArm: [0.20, -0.96, 0.14], RightLowerArm: [-0.20, -0.96, 0.14],
};

// NAMES CHANGE ON IMPORT. glTF holds "mixamorig:Hips"; three.js sanitises node
// names so they are valid in animation binding paths, and it becomes
// "mixamorigHips". Looking up the name that is in the FILE finds nothing, and
// the failure is total and silent — every bone missing at once. So match on the
// tail: strip any prefix and any separator, compare case-insensitively. That
// survives the sanitising, a different exporter's prefix, and no prefix at all.
export const normName = (n) =>
  n.replace(/^.*?[:|]/, '').replace(/[^a-z0-9]/gi, '').toLowerCase();

/**
 * UNITY -> glTF. The two frames differ in x alone, so negating that axis keeps
 * x and w and negates the other two. Converting each LOCAL rotation separately
 * is valid because a change of basis distributes over composition:
 * (M R1 M^-1)(M R2 M^-1) = M (R1 R2) M^-1.
 *
 * Its absence is what made a character a mess: arms up when the performer's
 * were down, an arm twisting backwards on a reach forward.
 */
export function unityToGltf(q, out) {
  return q ? out.set(q[0], -q[1], -q[2], q[3]) : out.set(0, 0, 0, 1);
}

// ---------------------------------------------------------------------------

export class VmcMixamoRig {
  /**
   * @param THREE  the three.js namespace, so this module pulls in no copy of it
   * @param opts   { ease, restAfterMs, restEase, prefix }
   */
  constructor(THREE, opts = {}) {
    this.T = THREE;
    // How fast a bone eases toward the newest rotation. Body data arrives at
    // 30 Hz and pages render at 60+, so without easing every second frame is a
    // step. The sender already filters the landmarks and the solve; this only
    // bridges the rate gap, which is why it is high.
    //
    // 0.5 at 60 fps closes 90% of a step in ~55 ms (0.35 took ~89 ms). The
    // old value was chosen when the wire ran at 26 Hz with 72 ms gaps and no
    // sender-side rotation smoothing; the pipeline doc lists it as a latency
    // reduction candidate now that neither condition holds — the sender
    // smooths, rate-clamps and crossfades before anything reaches here.
    this.ease = opts.ease ?? 0.5;
    this.restAfterMs = opts.restAfterMs ?? 250;
    this.restEase = opts.restEase ?? 0.05;
    // A bone RETURNING after an absence ramps up to full easing over this
    // window instead of chasing its new target at full speed. MediaPipe's
    // first estimates on reacquisition land far from the settled ones, so
    // full-speed pursuit of them reads as a jerk on every acquire.
    this.acquireRampMs = opts.acquireRampMs ?? 400;
    this.prefix = opts.prefix ?? 'mixamorig';

    this.bones = {};        // standard name -> THREE.Bone
    this.ready = false;
    this.present = false;
    this.lastMessageMs = 0;

    this._restWorld = {};   // its world rotation in the BIND pose
    this._bindDir = {};     // the direction it POINTS at rest
    this._bindWorldAll = new Map();   // EVERY bone, including undriven links
    this._restLocal = {};   // where it belongs when nothing drives it
    this._target = {};      // what it is being eased toward
    this._wantWorld = {};   // the world rotation it should have this frame
    this._lastSeenMs = {};
    this._returnedAt = {};  // when a bone came back after an absence
    this._w = {};           // the SOURCE chain's world rotations
    for (const n of ORDER) this._w[n] = new THREE.Quaternion();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Quaternion();
    this._identity = new THREE.Quaternion();
    this._c0 = {};          // constant rest-direction correction, per bone
  }

  /**
   * Index the rig and capture its bind pose. Call once, after the model is in
   * the scene and its world matrices are current.
   *
   * @returns null on success, or a message naming what is missing.
   */
  bind(root) {
    const T = this.T;
    const byName = {};
    root.traverse((o) => {
      if (!o.isBone) return;
      const k = normName(o.name);
      byName[k] = o;
      // Bind world rotation of EVERY bone. The exact localisation in apply()
      // needs the undriven links — Spine1, Neck, the shoulders — that sit
      // between driven ones, not only the driven bones themselves.
      this._bindWorldAll.set(o, o.getWorldQuaternion(new T.Quaternion()));
      const bare = k.replace(new RegExp('^' + this.prefix), '');
      if (bare && !(bare in byName)) byName[bare] = o;
    });

    const missing = [];
    for (const [name, rigName] of Object.entries(BONES)) {
      const b = byName[normName(rigName)]
             || byName[normName(this.prefix + rigName)];
      if (!b) { missing.push(rigName); continue; }
      this.bones[name] = b;
      this._target[name] = b.quaternion.clone();
      // Captured BEFORE anything is applied, so it is the artist's pose rather
      // than a frame of tracking.
      this._restLocal[name] = b.quaternion.clone();
      this._restWorld[name] = b.getWorldQuaternion(new T.Quaternion());

      // THE DIRECTION THIS BONE POINTS AT REST. A hand has five bone
      // children, and WHICH ONE defines the axis matters: the generic
      // parent-table lookup finds the Thumb first (the finger table starts
      // with it), which measured the hand's axis as wrist->THUMB-knuckle,
      // ~27 deg off — C0 then 'corrected' the whole hand by that skew
      // (hand widened and skewed off the thumb, fingers bending back toward
      // it; Tim, 2026-08-13). The canonical hand axis is wrist->MIDDLE
      // knuckle — the same definition the sender measures — so the Hand
      // bones name their reference child explicitly.
      const REF_CHILD = { LeftHand: 'LeftMiddleProximal',
                          RightHand: 'RightMiddleProximal' };
      const childName = REF_CHILD[name] || Object.keys(PARENT).find(
        (k) => PARENT[k] === name && BONES[k]);
      let ref = null;
      if (childName && byName[normName(BONES[childName])]) {
        ref = byName[normName(BONES[childName])];
      } else if (b.children.length === 1 && b.children[0].isBone) {
        ref = b.children[0];
      }
      const bpos = b.getWorldPosition(new T.Vector3());
      let bv = null;
      if (ref) bv = ref.getWorldPosition(new T.Vector3()).sub(bpos);
      else if (b.parent && b.parent.isBone) {
        bv = bpos.clone().sub(b.parent.getWorldPosition(new T.Vector3()));
      }
      if (bv && bv.lengthSq() > 1e-10) this._bindDir[name] = bv.normalize();

      // THE CONSTANT REST-DIRECTION CORRECTION, measured once at bind.
      // C0 carries this bone's measured bind direction onto its canonical
      // axis, so apply() can use ONE formula for every bone:
      //
      //     worldWanted = delta * C0 * bindWorld
      //
      // For a bone already resting on the canonical axis C0 is identity and
      // the formula collapses to delta * bindWorld. For this model's thumb
      // (bind direction 30.2 deg off the canonical VRM thumb axis) C0 aims
      // the geometry correctly -- and because it is CONSTANT, the finger's
      // twist about its own axis follows the sender's rotation with a fixed
      // offset. The previous per-frame live-direction swing had no twist
      // control at all: a shortest arc leaves roll wherever its path lands,
      // which changes with how the arm is held -- fingers twisting
      // unnaturally toward or away from the body depending on pose
      // (Tim, 2026-08-13).
      const rd = REST_DIR[name];
      if (rd && this._bindDir[name]) {
        this._c0[name] = new T.Quaternion().setFromUnitVectors(
          this._bindDir[name],
          new T.Vector3(-rd[0], rd[1], rd[2]).normalize());
      }
    }

    // A MISSING FINGER IS NOT A MAPPING ERROR. Plenty of rigs have no fingers,
    // and the sender only emits them while hand tracking is on, so a
    // finger-less model should still drive its body. A missing BODY bone is an
    // error: the name table does not match the rig.
    const fingerNames = new Set();
    for (const side of ['Left', 'Right']) {
      for (const [, mixamo] of FINGERS) {
        PARTS.forEach((_, i) => fingerNames.add(`${side}Hand${mixamo}${i + 1}`));
      }
    }
    const missingBody = missing.filter((n) => !fingerNames.has(n));
    if (missingBody.length) {
      return 'Model is missing bones the mapping expects: '
             + missingBody.join(', ');
    }

    this._buildIdle();
    this.ready = true;
    return null;
  }

  /**
   * The pose each arm falls to with nothing driving it, solved once so it can
   * be eased toward rather than recomputed.
   *
   * ORDER MATTERS. Solving the forearm against the parent's BIND rotation while
   * the upper arm has already swung down put the hand on the centreline —
   * measured elbow +0.20 but hand +0.02, the forearm folding back across the
   * body instead of hanging.
   */
  _buildIdle() {
    const T = this.T;
    const want = {};
    for (const name of ORDER) {
      const dir = IDLE_DIR[name];
      const b = this.bones[name];
      if (!dir || !b || !this._bindDir[name]) continue;
      const W = new T.Quaternion().setFromUnitVectors(
        this._bindDir[name].clone(),
        new T.Vector3(dir[0], dir[1], dir[2]).normalize());
      want[name] = W.multiply(this._bindWorldAll.get(b).clone());
      const p = PARENT[name];
      const parentWorld = (p && want[p])
        ? want[p].clone()
        : (this._bindWorldAll.get(b.parent) || new T.Quaternion()).clone();
      this._restLocal[name] = parentWorld.invert().multiply(want[name].clone());
    }
  }

  /** Feed one `body_state` payload. */
  apply(payload) {
    const T = this.T;
    this.present = !!payload.person_present;
    this.lastMessageMs = performance.now();
    const incoming = payload.bones;
    if (!incoming || !this.ready) return;

    for (const name of ORDER) {
      const q = incoming[name];
      if (q) {
        // Mark a RETURN before the seen-time is refreshed, so step() can
        // ramp this bone in gently instead of jerking to its first new
        // estimates.
        if (this.lastMessageMs - (this._lastSeenMs[name] || 0)
            > this.restAfterMs) {
          this._returnedAt[name] = this.lastMessageMs;
        }
        this._lastSeenMs[name] = this.lastMessageMs;
      }
      // A bone the sender could not see is ABSENT, not zeroed. Its own target
      // is left alone. Its slot in the world chain still takes its parent's
      // rotation, so the bones BELOW it stay attached rather than inheriting a
      // stale frame.
      unityToGltf(q, this._q);
      const parent = PARENT[name];
      if (parent) this._w[name].copy(this._w[parent]).multiply(this._q);
      else this._w[name].copy(this._q);

      if (!q) {
        // A BONE THAT STOPS ARRIVING RETURNS TO REST, after a delay so a single
        // dropped frame cannot twitch it. Holding is what put legs up behind a
        // character: one bad frame drives a limb somewhere impossible, the
        // landmark drops out, and the impossible pose is frozen there.
        if (this._restLocal[name] && this.bones[name]
            && this.lastMessageMs - (this._lastSeenMs[name] || 0)
               > this.restAfterMs) {
          this._target[name].slerp(this._restLocal[name], this.restEase);
        }
        continue;
      }

      const bone = this.bones[name];
      if (!bone || !bone.parent) continue;

      // NO SCENE READ HERE. Taking the parent's CURRENT world rotation reads
      // last frame's, so a bone is solved against a parent that has not been
      // updated yet. A two-bone chain limps to the right answer over a few
      // frames; a FINGER is four deep and never arrives, which is what makes
      // hands writhe.
      //
      // Solve it exactly instead. Walking parents-first, every driven bone's
      // wanted world rotation is known this pass, and the undriven links keep
      // their bind rotations:
      //
      //   parentEffective = want(nearest driven ancestor)
      //                   * inv(bind(ancestor)) * bind(parent)
      let anc = bone.parent;
      let ancName = null;
      while (anc && anc.isBone) {
        ancName = Object.keys(this.bones).find((n) => this.bones[n] === anc);
        if (ancName && this._wantWorld[ancName]) break;
        ancName = null;
        anc = anc.parent;
      }
      if (ancName) {
        this._p.copy(this._wantWorld[ancName])
          .multiply(this._bindWorldAll.get(anc).clone().invert())
          .multiply(this._bindWorldAll.get(bone.parent));
      } else {
        this._p.copy(this._bindWorldAll.get(bone.parent) || this._identity);
      }

      // THE ROTATIONS ARE DELTAS FROM A T-POSE, NOT BONE ORIENTATIONS.
      //
      //   worldWanted = delta * bindWorld
      //   local       = inv(parentEffective) * worldWanted
      //
      // Assigning the delta straight to bone.quaternion throws away the model's
      // own rest orientation, which for a Mixamo rig is nowhere near identity —
      // every bone snaps to an absolute frame and the body hangs off the hips
      // in whatever direction that frame points.
      //
      // AND THROUGH C0, the constant rest-direction correction measured at
      // bind (see bind()): worldWanted = delta * C0 * bindWorld. Identity
      // for every bone already resting on its canonical axis; for this
      // model's off-axis thumb it aims the geometry correctly with a FIXED
      // twist offset. Its per-frame predecessor — a live shortest-arc swing
      // — had no twist control and rolled the fingers with the pose.
      if (this._c0[name]) {
        this._target[name].copy(this._w[name]).multiply(this._c0[name])
          .multiply(this._restWorld[name]);
      } else {
        this._target[name].copy(this._w[name]).multiply(this._restWorld[name]);
      }
      (this._wantWorld[name] || (this._wantWorld[name] = new T.Quaternion()))
        .copy(this._target[name]);
      this._target[name].premultiply(this._p.invert());
    }
  }

  /** Ease every bone one frame toward its target. Call in the render loop. */
  step(ease = this.ease) {
    if (!this.ready) return;
    const now = performance.now();
    for (const name in this.bones) {
      let e = ease;
      const ret = this._returnedAt[name];
      if (ret !== undefined) {
        const t = (now - ret) / this.acquireRampMs;
        if (t >= 1) {
          delete this._returnedAt[name];
        } else {
          // From a quarter speed up to full over the ramp: moving from the
          // first frame (so a return is never a freeze), never at a rate
          // that reads as a snap.
          e = ease * (0.25 + 0.75 * Math.max(0, t));
        }
      }
      this.bones[name].quaternion.slerp(this._target[name], e);
    }
  }

  /** True when no usable data has arrived recently. */
  lost(timeoutMs = 1000) {
    return !this.present || performance.now() - this.lastMessageMs > timeoutMs;
  }
}
