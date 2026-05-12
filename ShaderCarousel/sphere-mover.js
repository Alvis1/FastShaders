/* sphere-mover — animates an entity along z from `startZ` → 0 → `startZ`
 *
 * Linear ping-pong over `duration` ms. The sphere's center reaches the camera
 * (z=0) at the midpoint, briefly enveloping the viewer in the inverted sphere.
 * Scale is coupled to distance: 0 at startZ, the entity's captured base scale
 * at centerZ — so the sphere appears to emerge from nothing in the distance,
 * grow as it approaches, and shrink back to nothing on the way out.
 *
 * Drive externally via the `start-cycle` event; emits `cycle-complete` when
 * the position returns to `startZ`. The benchmark component listens for this
 * to advance to the next shader.
 */

/* global AFRAME */

AFRAME.registerComponent("sphere-mover", {
  schema: {
    startZ: { type: "number", default: -10 },
    centerZ: { type: "number", default: 0 },
    duration: { type: "number", default: 10000 }, // ms, full ping-pong cycle
    autostart: { type: "boolean", default: false },
  },

  init: function () {
    this.cycleStartTime = null;
    this.running = false;
    // Capture the entity's authored scale once — we lerp 0..baseScale every tick.
    this.baseScale = this.el.object3D.scale.x || 1;

    this.startCycle = this.startCycle.bind(this);
    this.el.addEventListener("start-cycle", this.startCycle);

    // Park at startZ scale=0 so the first frame is fully off-screen
    this.el.object3D.position.z = this.data.startZ;
    this.el.object3D.scale.setScalar(0);

    if (this.data.autostart) {
      // defer one tick so other components finish init first
      setTimeout(() => this.startCycle(), 0);
    }
  },

  remove: function () {
    this.el.removeEventListener("start-cycle", this.startCycle);
  },

  startCycle: function () {
    this.cycleStartTime = null; // captured on next tick — uses A-Frame's clock
    this.running = true;
  },

  tick: function (time) {
    if (!this.running) return;

    if (this.cycleStartTime === null) {
      this.cycleStartTime = time;
    }

    const elapsed = time - this.cycleStartTime;
    const duration = this.data.duration;
    const t = elapsed / duration; // 0..1

    if (t >= 1) {
      this.el.object3D.position.z = this.data.startZ;
      this.el.object3D.scale.setScalar(0);
      this.running = false;
      this.cycleStartTime = null;
      this.el.emit("cycle-complete", null, false);
      return;
    }

    // Ping-pong: 0..0.5 → startZ→centerZ; 0.5..1 → centerZ→startZ
    const startZ = this.data.startZ;
    const centerZ = this.data.centerZ;
    const z = t < 0.5
      ? startZ + (centerZ - startZ) * (t * 2)
      : centerZ + (startZ - centerZ) * ((t - 0.5) * 2);

    this.el.object3D.position.z = z;

    // Scale couples linearly to distance from centerZ: full size at the camera
    // pass-through, zero at the far end. Equivalent to a triangle wave on `t`.
    const span = Math.abs(startZ - centerZ) || 1;
    const proximity = 1 - Math.abs(z - centerZ) / span; // 0 at startZ, 1 at centerZ
    this.el.object3D.scale.setScalar(this.baseScale * proximity);
  },
});
