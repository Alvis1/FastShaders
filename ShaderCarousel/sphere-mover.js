/* sphere-mover — animates an entity along z from `startZ` → 0 → `startZ`
 *
 * Linear ping-pong over `duration` ms. The sphere's center reaches the camera
 * (z=0) at the midpoint, briefly enveloping the viewer in the inverted sphere.
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

    this.startCycle = this.startCycle.bind(this);
    this.el.addEventListener("start-cycle", this.startCycle);

    // Park at startZ so the first frame is at the far position
    this.el.object3D.position.z = this.data.startZ;

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
  },
});
