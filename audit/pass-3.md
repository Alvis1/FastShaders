# Pass 3 — Compatibility (cap: 10 findings)

Verifiable-in-source items only.

- **WebGL vs. WebGPU branch:** trace where the renderer is selected. Is the WebGL fallback exercised, or just declared?
- **A-Frame XR session:** trace what happens on `enter-vr`. What's torn down and reinitialized? Are RTT and post-processing paths skipped for XR (they usually must be on Quest)?
- **`.fastshader` format:** grep for the schema. Is there a `version` field? What's the load-time migration path? What happens on unknown fields?
- **localStorage autosave:** where is it written, what's the quota check, what's the two-tabs-open behavior?
- **File System Access API:** if used, is there a fallback for browsers that don't expose it?
- **Quest 3 specifics, source-verifiable only:** texture format/size assumptions, anisotropy assumptions, any `EXT_disjoint_timer_query_webgl2` usage without a presence check.
- **Three.js import surface:** do NOT guess at API diffs across forks — that's not knowable from training data. Instead, list every distinct `three` / `three/*` import path used in the project so the reviewer can cross-reference manually.
