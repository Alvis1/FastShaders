# Eval Mode — Research & Implementation Plan

*2026-08-28. Research basis: 4 parallel research passes (SUS/instruments, logging methodology, published precedents, codebase mapping) + an adversarial citation check of all 71 gathered references (63 confirmed as cited, 8 corrected — corrections are already applied below).*

**STATUS: IMPLEMENTED 2026-08-28** (`src/eval/`, `public/eval/index.html`; browser-verified end-to-end incl. mid-session reload recovery, an EN and an LV session, and the full package). A 4-lens adversarial review (25 confirmed findings) reshaped several details — see **§7 Implementation deviations** at the end; where this plan and §7 disagree, §7 is what shipped. **The analysis pipeline exists too**: `scripts/eval-analysis.mjs` ingests the study zips → per-participant table + SUS mean/SD/95% t-CI, Sauro–Lewis grade, language split, per-item means, and a spreadsheet CSV — with each package validated (schema, quality block, SUS recomputed from the raw items) so a broken capture fails loudly; validated against two real packages. Still open: the LV SUS back-translation, the DPO/retention lines in the consent text (marked TODO in `ConsentModal.tsx`), switching delivery option B on (built, ships dark — §7.15), and the human pilot (§ Phase 7 steps 3–4 are about a real participant; step 4's script is done).

## 1. What is being built

A research/user-study mode for the web editor, entered via `…/fastshaders/eval`:

1. **Mode switch** — visiting `/fastshaders/eval` puts the app into eval mode for that tab.
2. **Consent screen** — shown before any logging starts (required for EU-grant research; see §3.6).
3. **Telemetry** — session start/end, active vs idle time, node add/remove, connection events with timestamps, undo/redo, Apply, exports, periodic graph-size/cost snapshots.
4. **SUS questionnaire** — in eval mode **EXPORT** asks "finished or continuing?" first (§7.16) and the red `!` also opens the System Usability Scale form (10 items, LV by default / EN) with a participant field, instead of the FeedbackModal.
5. **Package** — on submit, one zip: SUS results + the participant's shader (`.js` or `.zip`) + telemetry + session metadata + consent record, delivered toward the study email.

**One constraint to accept up front:** the package cannot literally *email itself*. `mailto:` cannot carry attachments (platform limitation, not CSP), and the app's own CSP (`connect-src 'self' blob: …`, `form-action 'self'` — `vite.config.ts:118–130`) blocks POSTs to third-party services by design. Two honest delivery options exist (§4.5): **A (baseline)** — download the zip + open a prefilled mailto with the SUS score inline and "attach the file that just downloaded" instructions; **B (optional)** — a tiny upload endpoint on alvismisjuns.lv, which the CSP *already permits* on that deploy target because the deploy script puts `https://alvismisjuns.lv` into `connect-src` via `FS_PREVIEW_ORIGIN`. For an in-person study, A is fully sufficient (the researcher can also just collect the downloaded zips from the machine).

---

## 2. Methodology findings (what to measure and why)

### 2.1 The instrument: SUS

**Canonical items** (Brooke 1996, verified against the original chapter PDF; © Digital Equipment Corporation 1986 — free to use, published reports must acknowledge the source):

1. I think that I would like to use this system frequently
2. I found the system unnecessarily complex
3. I thought the system was easy to use
4. I think that I would need the support of a technical person to be able to use this system
5. I found the various functions in this system were well integrated
6. I thought there was too much inconsistency in this system
7. I would imagine that most people would learn to use this system very quickly
8. I found the system very **awkward** to use *(variant — see below)*
9. I felt very confident using the system
10. I needed to learn a lot of things before I could get going with this system

Response scale: 1–5, anchored only at the ends — "Strongly disagree" (1) … "Strongly agree" (5).

**Item 8**: the original says "cumbersome". Finstad (2006) showed non-native English speakers stumble on it; the accepted substitution is "awkward", and Lewis (2018) presents the standard SUS with "awkward". **Use "awkward"** — Latvian participants answering the English form are exactly Finstad's population.

**Scoring**: odd items contribute `response − 1`, even items `5 − response`; sum × 2.5 → 0–100 in steps of 2.5. Individual item scores are explicitly not meaningful on their own. (Sanity pins for the test suite: all-1s → 50 is wrong — it's odd 0×5 + even 4×5 = 20 × 2.5 = **50**; all-5s also → 50; any uniform response → 50; max 100 = odd 5s + even 1s.)

**Administration** (from Brooke's original instructions — these become UI decisions):
- administer **immediately after use, before any debriefing or discussion** → the SUS opens in-app at session end, not by email later;
- ask for **immediate responses**, all items answered; a participant who can't answer an item should **mark the centre point** → the form requires all 10, and the intro line says exactly that;
- self-administered with the researcher stepping away — anonymity/self-administration measurably reduces social-desirability inflation (Joinson 1999).

**Interpretation benchmarks** (for the paper, not the app):
- Mean of large industrial datasets ≈ **68** = 50th percentile (Sauro 2011; Sauro & Lewis 2016 — the curved grading scale: 68 is the centre of "C"; A starts ≈ 80.8).
- Bangor, Kortum & Miller 2008 (2,324 surveys, 206 studies): mean 70.14, α = .91; acceptable > 70, marginal 50–70, not acceptable < 50.
- Adjective anchors (Bangor et al. 2009, r = .822 with SUS): OK ≈ 51, Good ≈ 71.4, Excellent ≈ 85.5.
- Per-item benchmarks exist (Lewis & Sauro 2018) for diagnosing *which* item drags a score.
- **Reporting**: mean, SD, N, 95% t-distribution CI. With SD ≈ 17.7 (typical), N = 15 gives roughly ±10 points at 95% — so with N ≈ 12–20 report the CI and interpret against 68/grades with that caveat, never a bare point grade.

**Latvian translation: none exists.** A serious search (EN + LV query variants) found **no validated Latvian SUS**; the Multi-Language SUS Toolkit (Gao, Kortum & Oswald 2020) covers no Baltic language. Options, in order of defensibility:
1. **Offer both languages, participant picks** — direct precedent: Orfanou, Tselios & Katsanos (2015) offered Greek or English by self-rated English proficiency, citing Finstad; record which language each participant used and report the split.
2. The Latvian form is then a **forward/back-translated, non-validated adaptation** — state that in the paper. Full protocol if time permits: Beaton et al. (2000) — two forward translations → reconciliation → blind back-translation → committee → cognitive pretest with 2–3 pilots. A draft LV translation is in §4.4 for your review (you are the native reconciler); at minimum have one other person back-translate it before the study.

### 2.2 Optional companion instruments

- **Creativity Support Index** (Cherry & Latulipe, TOCHI 2014) — *the* field-standard companion to SUS for creative tools (50 of the 113 CST evaluations surveyed by Remy et al. 2020 used full/partial CSI). Six factors (Exploration, Expressiveness, Immersion, Enjoyment, Results Worth Effort, Collaboration); 12 agreement statements (1–10) + 15 paired-factor comparisons; 0–100 weighted score; ~5 min. SUS answers "is it usable", CSI answers "does it support creative work and which factor is weak" — exactly the claim a shader-editor paper wants. **Recommendation: add it as a second page of the questionnaire if you can afford ~5 extra minutes per participant; otherwise ship SUS-only now and leave the modal extensible.**
- **NASA-TLX** (Hart & Staveland 1988; Hart 2006) — workload, not usability. Raw TLX (unweighted, ~1–2 min) is accepted practice. Only worth adding if you compare conditions by effort (e.g. node graph vs typing TSL).
- **UEQ-S** (Schrepp et al. 2017) — 8 items, pragmatic + hedonic quality, published benchmark, free analysis kit at ueq-online.org. The UEQ download package distributes ~30 community translations — **check whether Latvian is among them** before building anything custom. Cheapest hedonic signal, but weaker than CSI for creativity claims.

### 2.3 Telemetry methodology

- **Log semantic events, not raw input streams.** Hilbert & Redmiles (2000) — the canonical survey — argue raw event streams are voluminous and the abstraction to task-level concepts must be designed *before* collection. Since we own the app, abstraction happens at capture: `node-add`, `edge-connect`, `undo`, `code-apply` — never mousemove streams.
- **Logs tell WHAT, never WHY.** Dumais et al. (2014, and their CHI 2011 course): logs cannot reveal intent, success, experience — pair with a questionnaire (SUS, here) and the artifact itself (the shader). Fox et al. (2005): implicit signals alone predicted explicit judgments at 45%; combined signals 75%.
- **Event tuple**: `<time, participant, action, value, context>` (Dumais et al.); plus a **sequence number** per event (loss/reorder detection) and a **schema version** in the session header (schema drift is a named hazard in their course notes).
- **Clocks**: durations and ordering from `performance.now()` (monotonic — W3C High Resolution Time explicitly says `Date.now()` is unfit for durations due to clock adjustment); one ISO wall-clock anchor + `performance.timeOrigin` in the session header places the session in calendar time. Caveat: `performance.now()` may not tick during system sleep — log both clocks at anchor points.
- **Active time**: there is **no validated universal idle threshold** — the literature/industry spread is 5 s (Chartbeat engaged-time), 10 s (Meyer et al. 2017, developer telemetry), 30 s (JS idle libraries), 30 min (GA session boundary, fossilized from Catledge & Pitkow 1995's mean-gap statistic). The defensible move (per Jansen et al. 2007 — session definitions vary, so *declare yours*): record **raw transitions** (visibility, focus, input-recency heartbeats) and compute active time at export with a **declared threshold (default T = 60 s)** — the raw events stay in the zip so reviewers can recompute under any T.
- **Journaling**: `beforeunload` is unreliable; the reliable flush points are `visibilitychange → hidden` and `pagehide` (≈91% delivery measured in industry benchmarks). Buffer in memory, flush batches to localStorage (synchronous, hence safe at pagehide, unlike IndexedDB) every N events / 5 s / on hidden; recover an orphaned journal on next boot and mark it `recovered`. Cap the journal (~2 MB) — it shares the origin quota with the `fs:graph` autosave.
- **Quality checks at export** (Dumais: "make sure you believe the numbers"): sequence continuity, monotone timestamps, session-start present, active ≤ wall time, events-per-minute outliers — run automatically at package time, embed a `quality` block in the zip so a broken capture is visible **before the participant leaves**.
- **Observer effect**: keep eval mode visually identical to the real app except the consent screen, a small EVAL badge, and the swapped `!` — and keep the logger off hot paths (buffered, no per-frame work), so the instrument doesn't perturb what it measures.

### 2.4 Log-derived metrics with published precedent

| Metric | Definition | Precedent |
|---|---|---|
| Active time / wall time | Union of (visible ∧ focused ∧ input < T ago), T declared (60 s default), recomputable from raw events | Hilbert & Redmiles 2000; Chartbeat; Meyer et al. 2017 |
| Time-to-first-connection | session-start → first `edge-connect` | study-defined (industry "time-to-first-Hello-World" analog — no scholarly canon exists; say so) |
| Time-to-first-preview-change | session-start → first preview rebuild differing from the demo graph | study-defined |
| Undo count (and what was undone) | `undo` events + context | **Akers et al. 2009** (CHI; N=35 SketchUp: undo+erase episodes surfaced >90% of severe problems); Akers et al. 2012 (TOCHI) generalizes to creation-oriented tools |
| Edit→preview cycles | count of debounced preview rebuilds | **Alaboudi & LaToza 2021** (VL/HCC: edit-run cycles; ~7 runs before a fix) |
| Exploration breadth | distinct node types used; node/edge/group counts over time; final cost points | **Dr. Scratch** (Moreno-León et al. 2015 — artifact-derived metrics validated against experts); Juxtapose (Hartmann et al. 2008 — exploration as outcome) |
| Session structure | tutorial vs guided task vs free-creation phase markers (researcher presses a phase key, or derives from task script) | SketchMetaFace, Rapsai, Para (see §2.5) |

### 2.5 Study design context (for the paper)

- **Novelty**: no rigorous published usability study of a commercial node-based shader/material editor was found (Unity Shader Graph / Blender nodes / Substance). The closest: a Unity-Shader-Graph-based evolutionary tool with only informal feedback (Sasso, Loiacono & Lanzi 2023, arXiv:2312.17587), and VLMaterial (ICLR 2025) with an ad-hoc 6.8 rating. **An instrumented SUS + telemetry study of a node shader editor appears to be novel — claimable in the paper.**
- **Closest SUS anchors for a creative 3D tool** (Luo et al. 2023, SketchMetaFace, TVCG): SketchMetaFace 79, DeepSketch2Face 64, **ZBrush 41**, SimpModeling 38 — measured with amateurs. No published SUS exists for Blender/Unity/shader tools; don't invent one.
- **N**: most common CHI sample size is **12** (Caine 2016); SUS reaches correct comparative conclusions >90% of the time at n≈12–14 (Tullis & Stetson 2004); 10 users find ≥80%, 20 users ≥95% of usability problems (Faulkner 2003). **Recommendation: N = 12–15, minimum 10.**
- **Session shape** (recurring pattern across SketchMetaFace / Rapsai / Juxtapose / Para): short tutorial/warm-up → structured target task → open-ended creation → questionnaire immediately → (optional) interview. Present it as following these precedents; no single methods paper canonizes it.
- **What a single-tool study supports**: problem discovery + severity, descriptive behavioral claims, an absolute SUS vs published norms, qualitative workflow claims from artifacts. It does **not** support "better than tool X". Remy et al. (DIS 2020, 113 CST papers) documents small single-session studies as field practice — cite it to frame limitations.

### 2.6 Ethics & GDPR (EU-funded research — this is not optional garnish)

From the European Commission's Horizon Europe *Ethics and Data Protection* guidance (verified, quotes verbatim):

- A name + interaction log is **personal data**; a participant *code* with the name↔code key kept separately is *pseudonymised* personal data (still GDPR-scoped, but the recommended default — "wherever you have the possibility to enhance the level of data protection … you should apply such measures by default").
- **Data minimisation**: "collecting personal data that you do not need … may be deemed unethical and unlawful."
- **Consent** (Art. 4(11)/6(1)(a)/7): a clear affirmative act; electronic collection is fine; the information shown must include **(i)** controller identity + DPO contact, **(ii)** specific purpose, **(iii)** rights incl. withdrawal + complaint to a supervisory authority, **(iv)** third-party sharing, **(v)** retention period. Records of the consent procedure must be kept. Behavioural tracking explicitly warrants "a specific informed consent process covering the data-processing component" → the in-app consent screen before logging starts is the right shape, and the consent record ships inside the zip.
- Small, overt, consented usability telemetry hits none of the DPIA triggers; still **involve your institution's DPO**.
- ACM Code of Ethics 1.6: "Only the minimum amount of personal information necessary should be collected in a system."

**Name vs code — the one place this plan pushes back on the spec**: you asked for the participant's *name* on the SUS form. Standard practice (GDPR minimisation + Joinson's honesty findings) is a **participant code** (P01…), with the name only on the paper consent form and the code→name key held by you, apart from the data. The name would otherwise ride every copy of every zip. **Plan default**: the field is labeled "Participant code" and pre-filled from the consent screen; a `name` free-text stays possible (it's one label change) if you decide logistics demand it — but the paper's ethics paragraph is easier with codes.

---

## 3. Codebase facts the design builds on (verified anchors)

| What | Where | Notes |
|---|---|---|
| Red `!` button | `src/components/Layout/Toolbar.tsx:638–650` | local `feedbackOpen` state; `<FeedbackModal open onClose>` |
| FeedbackModal pattern | `src/components/Modals/FeedbackModal.tsx:110` | portal to body, env snapshot on open — the template for SusModal |
| Report builders | `src/utils/feedbackReport.ts` | `FEEDBACK_EMAIL='alvis.misjuns@va.lv'` (:26), `MAILTO_SAFE_CHARS=1900` (:35), `collectEnv`/`countProject` (:92 — counts on the unwrapped graph), `buildMailtoUrl` (:273) |
| Zip writer | `src/utils/zipWriter.ts:45` | `buildZip(entries: {name, data: Uint8Array}[]): Uint8Array` — deterministic, STORE |
| Shader bundle | `src/engine/exportShader.ts:107` | `buildShaderBundle(): ExportBundle` (`{kind:'js'\|'zip', fileName, mime, bytes}`) — the ONE bundle builder; byte-identical to the toolbar EXPORT |
| Store chokepoints | `src/store/useAppStore.ts` | `addNode` :1240, `removeNode` :1245, `removeEdge` :1257, `updateNodeData` :1294, `newGraph` :1331, `requestCodeSync` :1560 (Apply), `beginInteraction` :1633 / `endInteraction` :1655, `undo` :1680 / `redo` :1697 |
| The ONE connect path | `src/components/NodeEditor/NodeEditor.tsx:1069` | `applyConnection` — wire drops, drag-connect, tile drag-connect all funnel here |
| Disconnect / delete paths | `NodeEditor.tsx:1663` (drag-to-disconnect), `:810–846` (keyboard delete incl. group dissolve) | deletion has **three** paths (store.removeNode, keydown handler, group delete) — snapshots (below) are the safety net |
| Vite entries + CSP | `vite.config.ts:901` (inputs: main, designer), `:118–130` (CSP), `:132` (cspHtmlPlugin — build-only, **Vite entries only; public/ pages get NO CSP meta**) | `FS_BASE` :115; public/ ships verbatim to dist on both targets |
| Deploy | `package.json:14` → `scripts/deploy-alvismisjuns.sh` | sets `FS_PREVIEW_ORIGIN='https://alvismisjuns.lv …'` → that origin is **already in connect-src** on the alvismisjuns build (relevant to delivery option B) |
| Persisted state | `src/hooks/usePersistedState.ts:32` | `fs:*` key convention |
| i18n | `src/i18n/index.ts:103` | `t(englishKey, lang)` — falls back to English; LV chrome strings in `lv.json` `ui` map |
| Greenfield | — | no telemetry/analytics/eval code exists anywhere in src/ or public/ |

Two mapped traps: **(a)** `pushHistory` is *not* a reliable telemetry hook (no-ops during coalescing brackets and `isUndoRedo`; `newGraph` snapshots inline) — hook the actions, not history. **(b)** The sync engine's code→graph pass mutates via `setNodes`, not `addNode` — so chokepoint events measure *direct canvas actions* (which is what we want), and periodic snapshots capture net totals regardless of the path that produced them.

---

## 4. Implementation plan

### Phase 1 — Entry + mode plumbing (small)

**`public/eval/index.html`** — a tiny hand-written redirector (podest's verbatim-copy precedent):
```html
<!-- sets the flag, then hands over to the real app -->
<script>
  try { sessionStorage.setItem('fs:evalArm', '1'); } catch (e) {}
  location.replace('../');
</script>
```
- Ships verbatim to `dist/eval/index.html` → served at `/FastShaders/eval/` (Pages) and `/fastshaders/eval/` (alvismisjuns). No Vite entry, no CSP interaction, works on any static host.
- **sessionStorage, never localStorage** — the flag must die with the tab, or a participant's browser stays in eval mode forever. Reloads of the app URL mid-session keep the mode (sessionStorage survives same-tab reloads); a fresh visit to `/eval` always mints a **new session** (clears the journal).
- Asset refs (favicon) must stay **relative** (`../images/…`) — `favicons.test.ts` pins the reference form for verbatim-copied pages; add this page to its pins.

**`src/eval/evalMode.ts`** — `isEvalMode()` sampled at module init (the `bootGeometryWasCustom` precedent), session record minting, and the eval-mode store of participant code + session id (sessionStorage-backed so reloads recover).

**Toolbar badge** — a small "EVAL" chip in the toolbar (visible mode per the observer-effect rule: identical app otherwise, but the mode must be visible so nobody is covertly logged — also a GDPR posture).

### Phase 2 — Consent screen

`src/eval/ConsentModal.tsx` (portal-modal, FeedbackModal's pattern), shown at boot in eval mode **before any logging**:
- Text blocks (EN/LV via `t()`): who runs the study (controller + DPO contact — **you fill these in**, they're institution-specific), purpose, exactly what is collected (interaction events + the shader you make + questionnaire answers; no keystroke content, no audio/video), retention period, right to withdraw (closing the tab before submitting discards everything — make that true and say it), complaint right.
- Participant code field (researcher types P01… before handing over, or auto-mint `P-<n>`).
- **Agree & start** → mints session, logs `session-start` + `consent-given {textVersion}`, calls `newGraph()` (clean slate — this also overwrites the machine's `fs:graph` autosave, acceptable on a study machine; the consent screen is the right place for the researcher to notice), and tells the participant: *"When you are finished, click the red ! button to complete a short questionnaire."*
- **Decline** → `location.replace('./')` minus the flag: the normal app, no logging.

### Phase 3 — Telemetry core

**`src/eval/telemetryModel.ts`** — PURE, node-tested: event types (closed vocabulary), `deriveSummary(events, {idleThresholdMs})`, `runQualityChecks(events)`.

**`src/eval/telemetry.ts`** — DOM side: the buffer, the flush machinery, the listeners.

Event vocabulary (v1 — `schema: "fs-eval-1"`):

| Event | Payload | Source hook |
|---|---|---|
| `session-start` / `session-end` / `recovered` | — | consent modal / SUS submit / boot with orphan journal |
| `visibility` | `{state}` | `visibilitychange` |
| `focus` | `{focused}` | window focus/blur |
| `activity` | — (throttled ≥ 5 s apart) | pointerdown/keydown/wheel, capture-phase on window |
| `node-add` | `{nodeType}` | `addNode` (useAppStore.ts:1240) |
| `node-remove` | `{nodeType}` | `removeNode` :1245 + keyboard-delete handler + group-delete run |
| `edge-connect` | `{sourceType, targetType, targetHandle}` | `applyConnection` (NodeEditor.tsx:1069) |
| `edge-disconnect` | `{how: 'drag'\|'delete'\|'menu'}` | `onReconnectEnd` :1663, `removeEdge` :1257, delete paths |
| `undo` / `redo` | — | store :1680/:1697 |
| `gesture` | `{kind: 'scrub'}` | `beginInteraction`/`endInteraction` pair (:1633/:1655) |
| `code-apply` | — | `requestCodeSync` :1560 |
| `preview-rebuild` | — | store subscription on `previewCode` identity |
| `asset-drop` | `{kind: preset\|texture\|group\|node}` | `placeTilePayload` (tileDrag funnel) |
| `import` / `export` | `{kind}` | `fs:graph-imported` listener / `downloadShader` |
| `snapshot` | `{nodes, connected, connections, groups, notes, costPoints}` | every 30 s of active time + debounced 1 s after any structural event — reuses `countProject` (feedbackReport.ts:92, already unwraps collapsed groups) |
| `sus-open` / `sus-submit` | — / `{language}` | SusModal |

Each event: `{seq, t}` (+ type/payload) with `t = performance.now()` ms; the session header carries `startedIso`, `timeOrigin`, timezone, app version, UA, display, schema version, participant code.

Mechanics:
- `evalLog(type, payload?)` exported from telemetry.ts; **compiled to a no-op when `!isEvalMode()`** (module-level early-return on a boolean read once at init) — zero cost in normal sessions, and the hooks in store/NodeEditor are one-line calls.
- Buffer in memory; flush to `localStorage['fs:evalJournal']` every 20 events / 5 s / on `visibilitychange→hidden` / `pagehide` (synchronous write — reliable at teardown where IndexedDB isn't). Cap ~2 MB with an explicit `truncated` marker event. Journal key includes the session id; boot recovery appends `recovered`.
- Active time is **derived at export** from visibility/focus/activity events with declared T = 60 s (default), and the raw events stay in the package so it's recomputable — this is the methodological posture §2.3 requires.

### Phase 4 — SUS modal

`src/eval/SusModal.tsx` (+ pure `src/eval/susScore.ts`):
- Toolbar branch: in eval mode the `!` opens SusModal (Toolbar.tsx:638–650 — `evalMode ? <SusModal…> : <FeedbackModal…>`; same open-state plumbing).
- Header: participant code (pre-filled from consent, editable — or a name field if you overrule §2.6), language matches the app's LV/EN toggle; **record which language was answered**.
- Intro line (per Brooke): *"Please record your immediate response to each statement. If you cannot respond to one, mark the centre point."*
- 10 items, 5-point radios, all required; item 8 uses "awkward"; optional free-comment box at the end; Cancel returns to the session (no session-end until submit).
- Submit → `sus-submit` event → session-end → package assembly (Phase 5) → thank-you screen with the download + send instructions.
- Score is computed into the package but **not shown to the participant** (prevents pre-debrief discussion anchoring).

**Draft Latvian items** (forward translation — for your native review + one back-translation before use; scale anchors "Pilnīgi nepiekrītu" … "Pilnīgi piekrītu"):
1. Es domāju, ka es vēlētos šo sistēmu izmantot bieži.
2. Sistēma man šķita nevajadzīgi sarežģīta.
3. Man šķita, ka sistēmu ir viegli lietot.
4. Es domāju, ka man būtu vajadzīgs tehniskā speciālista atbalsts, lai spētu šo sistēmu lietot.
5. Man šķita, ka dažādās sistēmas funkcijas ir labi integrētas.
6. Man šķita, ka sistēmā ir pārāk daudz nekonsekvences.
7. Es domāju, ka lielākā daļa cilvēku iemācītos lietot šo sistēmu ļoti ātri.
8. Sistēma man šķita ļoti neērta lietošanā.
9. Lietojot sistēmu, es jutos ļoti pārliecināts/-a.
10. Man vajadzēja daudz ko apgūt, pirms varēju sākt darboties ar šo sistēmu.

### Phase 5 — Packaging & delivery

**`src/eval/evalPackage.ts`** — pure assembly (node-tested), then a thin DOM download tail:

Zip `fastshaders-eval-<participant>-<YYYYMMDD-HHMM>.zip`:
```
session.json            — header: schema, app version/build, session ids, clocks, UA, consent record
sus.json                — participant code, language, per-item responses, computed score, timestamps
telemetry-events.json   — the raw event log (recomputable ground truth)
telemetry-summary.json  — derived: active/wall time, counts, time-to-first-*, quality block
summary.csv             — one row of headline numbers (spreadsheet-friendly)
shader/<name>.js|.zip   — buildShaderBundle() verbatim (zip-in-zip is fine; STORE method)
README.txt              — schema version, metric formulas, idle threshold T, quality-check meanings
```
- `buildShaderBundle()` (exportShader.ts:107) is read imperatively exactly like the toolbar EXPORT — byte-identical shader artifact, images/mesh included when present.
- Quality checks run here; failures print into the thank-you screen (*"capture incomplete — tell the researcher"*) so a broken log is caught while the participant is still in the room.

**Delivery A (baseline, ships first)**: trigger the zip download (downloadShader's anchor pattern), then open `mailto:` to `EVAL_STUDY_EMAIL` — a new constant beside `FEEDBACK_EMAIL` (feedbackReport.ts:26 — currently `alvis.misjuns@va.lv`; **decide which address the study uses**) — subject `FastShaders eval — <participant> — <date>`, body = the headline numbers (SUS score, active time, node/connection counts — well under `MAILTO_SAFE_CHARS`) + *"Please attach the file `<zipname>` that has just downloaded (check your Downloads folder), then press Send."* Clipboard fallback per the FeedbackModal pattern. Works on every host, offline, and if the mail step is fumbled the researcher still collects the downloaded zip from the machine — that's the in-person safety net.

**Delivery B (optional, later)**: `POST` the zip to a ~30-line endpoint at `https://alvismisjuns.lv/fastshaders-eval/upload.php` (writes the file, optionally mails it). On the alvismisjuns deploy this needs **zero CSP change** — the deploy script already injects that origin into `connect-src` via `FS_PREVIEW_ORIGIN`. Keep A underneath as the fallback (the CLAUDE.md feedback rule: never quietly swap mailto for a server). Needs: server-side size cap, a shared-secret header, and a decision about the server becoming part of the data-processing story in the consent text.

### Phase 6 — Tests (project conventions: pure logic, node env)

- `src/eval/susScore.test.ts` — scoring pins: uniform responses → 50, max pattern → 100, per-item contributions, rejection of incomplete forms.
- `src/eval/telemetryModel.test.ts` — active-time derivation against synthetic transition streams; T-sensitivity (same events, T=30/60 s); quality checks fire on gap/reorder/negative-duration fixtures; summary counts.
- `src/eval/evalPackage.test.ts` — entry list for js-vs-zip bundles; deterministic bytes (zipWriter is deterministic); README carries the declared T.
- `src/eval/evalHooks.test.ts` — **source pin** (the project's drift-test culture): greps that `addNode`/`removeNode`/`removeEdge`/`undo`/`redo`/`requestCodeSync`/`applyConnection` carry `evalLog` calls, and that no `evalLog` appears outside `src/eval/` + the pinned chokepoint list (so telemetry can't quietly spread).
- `favicons.test.ts` — add the `public/eval/index.html` relative-reference pin.

### Phase 7 — Pilot (before any real participant)

1. Run a full fake session yourself: `/eval` → consent → build a shader → `!` → SUS → package. Open the zip; hand-check event log plausibility (Dumais: "LOOK at a subsample by hand").
2. Kill the tab mid-session → reboot → verify journal recovery + `recovered` marker.
3. One real pilot participant (excluded from analysis): timings, comprehension of consent + SUS wording (this doubles as the LV cognitive pretest), the mailto/attach flow on the actual study machine + mail client.
4. Dry-run the analysis: write the notebook/script that ingests a zip and produces the paper numbers *now*, so schema gaps surface before data collection.

**Rough sizes**: P1+P2 ≈ half a day; P3 ≈ a day; P4 ≈ half a day; P5A ≈ half a day; tests alongside; pilot ≈ one session + fixes.

---

## 5. Decisions you should confirm (defaults chosen so work can proceed)

| Decision | Default in this plan | Alternative |
|---|---|---|
| Participant identity | **Code (P01…)**, name only on paper consent | Name field verbatim as you specified — one label change, but weakens the ethics story (§2.6) |
| Study email | `EVAL_STUDY_EMAIL` = the existing `alvis.misjuns@va.lv` | `alvismisjuns@gmail.com` — institutional address is the better GDPR-controller fit |
| Delivery | A (download + prefilled mailto) | B upload endpoint on alvismisjuns.lv (CSP already permits; needs the PHP side) |
| Questionnaire | SUS only | SUS + CSI second page (+~5 min/participant; strongest paper claim for a creative tool) |
| LV SUS | Ship the §4.4 draft after your review + one back-translation; record language per participant | English-only with the "awkward" variant |
| Idle threshold | T = 60 s, declared, recomputable | any — the raw events make it a reporting choice, not a capture choice |
| Clean slate on entry | `newGraph()` after consent | keep the demo graph as the tutorial substrate |

## 6. Verified references

*All checked by an independent citation-verification pass; corrections applied.*

**Instrument & benchmarks** — Brooke (1996), *SUS: A 'quick and dirty' usability scale*, in Jordan et al. (Eds.), Usability Evaluation in Industry, 189–194, Taylor & Francis · Bangor, Kortum & Miller (2008), IJHCI 24(6), 574–594, doi:10.1080/10447310802205776 · Bangor, Kortum & Miller (2009), J. Usability Studies 4(3), 114–123 · Sauro (2011), *A Practical Guide to the SUS*, Measuring Usability LLC · Sauro & Lewis (2016), *Quantifying the User Experience* (2nd ed.), Morgan Kaufmann · Lewis & Sauro (2018), JUS 13(3), 158–167 · Lewis (2018), IJHCI 34(7), 577–590, doi:10.1080/10447318.2018.1455307 · Finstad (2006), JUS 1(4), 185–188 · Tullis & Stetson (2004), Proc. UPA · Kortum & Bangor (2013), IJHCI 29(2), 67–76.

**Translations** — Gao, Kortum & Oswald (2020), IJHCI 36(20), 1883–1901, doi:10.1080/10447318.2020.1801173 · Blažica & Lewis (2015), IJHCI 31(2), 112–117 (SUS-SI) · Orfanou, Tselios & Katsanos (2015), IRRODL 16(2) · Beaton, Bombardier, Guillemin & Ferraz (2000), Spine 25(24), 3186–3191.

**Companion instruments** — Cherry & Latulipe (2014), TOCHI 21(4), art. 21, doi:10.1145/2617588 (CSI) · Hart & Staveland (1988), in *Human Mental Workload*, 139–183, North-Holland · Hart (2006), Proc. HFES 50(9), 904–908, doi:10.1177/154193120605000909 · Schrepp, Hinderks & Thomaschewski (2017), IJIMAI 4(6), 103–108 (UEQ-S) · Frich, Dalsgaard, Taranu & Biskjaer (2024), Proc. ECCE, doi:10.1145/3673805.3673815 (SUS↔CSI correlation).

**Logging methodology** — Hilbert & Redmiles (2000), ACM Computing Surveys 32(4), 384–421, doi:10.1145/371578.371593 · Dumais, Jeffries, Russell, Tang & Teevan (2014), in *Ways of Knowing in HCI*, 349–372, Springer, doi:10.1007/978-1-4939-0378-8_14 · Maxwell & Hauff (2021), ECIR, LNCS 12657, 525–530 (LogUI) · Catledge & Pitkow (1995), Comp. Networks & ISDN Systems 27(6) · Jansen, Spink, Blakely & Koshman (2007), JASIST 58(6), 862–871, doi:10.1002/asi.20564 *(author list corrected — Kathuria is a different 2007 paper)* · Meyer, Barton, Murphy, Zimmermann & Fritz (2017), IEEE TSE 43(12) · Fox, Karnawat, Mydland, Dumais & White (2005), TOIS 23(2), 147–168 · Philips & Dumas (1990), Proc. HFS 34(4), 295–299 · W3C High Resolution Time Level 2 (2019) · Joinson (1999), BRMIC 31(3), 433–438.

**Precedent studies & study design** — Luo et al. (2023), SketchMetaFace, IEEE TVCG (arXiv:2307.00804) · Du et al. (2023), Rapsai, CHI, doi:10.1145/3544548.3581338 · Jacobs, Gogia, Měch & Brandt (2017), Para, CHI Best Paper · Jacobs, Brandt, Měch & Resnick (2018), Dynamic Brushes, CHI · Hartmann et al. (2008), Juxtapose, UIST · Akers, Simpson, Jeffries & Winograd (2009), CHI, doi:10.1145/1518701.1518804 · Akers et al. (2012), TOCHI 19(2), doi:10.1145/2240156.2240164 · Alaboudi & LaToza (2021), VL/HCC (arXiv:2109.02682) · Moreno-León, Robles & Román-González (2015), Dr. Scratch, RED 46 · Weintrop & Wilensky (2017), TOCE 18(1) · Faulkner (2003), BRMIC 35, 379–383 · Caine (2016), CHI, doi:10.1145/2858036.2858498 · Nielsen & Landauer (1993), INTERCHI, 206–213 · Remy et al. (2020), DIS, doi:10.1145/3357236.3395474 · Frich et al. (2019), CHI, doi:10.1145/3290605.3300619 · Shneiderman & Plaisant (2006), BELIV (MILCs) · Kölling & McKay (2016), TOCE 16(3), art. 12, doi:10.1145/2872521 · Sasso, Loiacono & Lanzi (2023), arXiv:2312.17587 *(author list corrected)* · Li et al. (2025), VLMaterial, ICLR (arXiv:2501.18623) · Rein, Ramson, Beckmann & Hirschfeld (2025), Programming 9(1) (arXiv:2412.06274) · Fraser (2015), IEEE Blocks & Beyond · Maloney et al. (2010), TOCE 10(4) · Lewis, C. M. (2010), SIGCSE · Leitão, Santos & Lopes (2012), IJAC 10(1).

**Ethics** — European Commission (2021), *Ethics and Data Protection* (Horizon Europe guidance) · European Commission (2021), *How to complete your ethics self-assessment* v2.0 · ACM Code of Ethics and Professional Conduct (2018), §1.6–1.7 · GDPR Arts. 4(11), 5(1), 6(1)(a), 7, 35, 89.

---

## 7. Implementation deviations (2026-08-28 — what actually shipped, after the adversarial review)

1. **The journal lives in sessionStorage, not localStorage.** This is a consent decision, not a convenience: sessionStorage survives the mid-session reload the recovery path exists for, and dies with the tab — which makes the consent screen's "close the tab and the study data is discarded" literally true, and keeps the journal out of the localStorage quota the `fs:graph` autosave (3 M-char image budget) lives in.
2. **The event clock is rebased across reloads.** `performance.now()` restarts per page load, so the journal persists a wall-clock anchor (`origin` = the first page's `timeOrigin`) and the recovery path adds an epoch offset to every new timestamp — without it a recovered session mixed two clock domains and every derived duration was garbage (the review's one critical correctness finding). The anchor also ships as `session.clockOriginMs`, so `t` → calendar time is reconstructible offline. A journal without a usable anchor refuses to resume (fresh session) rather than guess.
3. **Recovery re-opens presence.** The teardown flush logs `visibility hidden`; a page that loads visible never fires `visibilitychange`, so the resume path explicitly logs the current visibility + focus state — otherwise active time silently excluded everything after the first reload.
4. **Focus entering the app's own 3D-preview iframe is presence, not absence.** Clicking into the preview blurs the window; the blur handler tags `target: 'iframe'`, the presence model keeps the participant present, and the entry counts as one activity marker (input inside the sandboxed iframe is unobservable — the README documents the conservative counting).
5. **`code-apply` is logged at CodeEditor's two Apply gestures, not in `store.requestCodeSync`** — projectImport calls `requestCodeSync` on the bare-script import path, which would have counted imports as user Applies.
6. **`preview-rebuild` is debounced (250 ms) in the bridge** — `previewCode` advances per scrub frame while the real iframe rebuild is behind a 200 ms debounce; without the debounce a slider drag logged tens of phantom rebuilds per second.
7. **The clean slate is more than `newGraph()`** (`cleanSlateForStudy` in EvalGate): it also clears the custom preview mesh (store + IndexedDB — it would ride into the participant's export zip), `fs:previewUniformValues`/`fs:previewUniformBounds` (persisted BY NAME; auto-generated names collide by design, so P1's tunings would override P2's properties and be embedded in P2's package), and the undo history (newGraph's own undo entry would let one Cmd+Z resurrect the previous user's document into the study). **Deliberately NOT wiped: `fs:savedGroups`** — the machine owner's persistent library; an empty library on the study machine is a researcher setup step.
8. **Submit ends eval mode outright** (`clearEvalMode()` after packaging) — otherwise a post-submit reload silently restarted recording under the finished participant's identity with no consent act.
9. **The SUS score does NOT appear in the mailto body** — the participant reads that draft while attaching the zip, which would have defeated the hidden-score rule. The score lives only in the package.
10. **`summary.csv` is formula-escaped** (leading `=`/`+`/`-`/`@` neutralised) — the participant-typed code is the first cell of a file aimed at the researcher's spreadsheet.
11. **The consent text enumerates the technical block** (browser/platform/screen/timezone) as a fourth bullet — `session.json` carries those facts, and "nothing else is recorded" must be literally true.
12. **`gesture` events carry no `kind`** — history brackets are opened by value scrubs AND colour-picker sessions alike, and the chokepoint cannot tell them apart.
13. **A serve-only vite plugin (`fs-eval-dev-index`) maps `<base>/eval/` to the redirector in dev** — vite's SPA fallback otherwise answers the directory URL with the app's index.html, so the eval entry existed only in production builds.
14. Also: `deriveSummary` deliberately does not clamp active ≤ wall (so the quality check is real, not tautological); `counts`/`nodeAddsByType` are null-prototype (journal-supplied keys are adversarial); the SUS participant field re-reads the session record on open (the mount-time initializer ran before consent).
15. **Delivery option B is LIVE (2026-08-29).** Packages POST to
`https://alvismisjuns.lv/fastshaders-eval/upload.php` and are collected at `…/list.php` (HTTP-Basic, user `researcher`). The endpoint is deployed by `scripts/deploy-eval-endpoint.sh`, which renders the public `server/*.php` templates with secrets from the gitignored `.vscode/eval-endpoint.json` — the repo is public, so the listing password never enters it (the upload key does, and is public by construction: it only deters drive-by posting). The host turned out to be a Docker `php:8.5-apache` container behind Traefik with `/var/www/alvis/src` mounted at `/app`; the inbox therefore lives at the CONTAINER path `/app/eval-inbox-<token>`, OUTSIDE `DocumentRoot /app/public`. That placement is load-bearing and was found by testing: with the inbox under the docroot, stored packages were downloadable by URL with no password — `AllowOverride` is `None` in that image so the `.htaccess` guard is ignored, and Apache runs as the same `www-data` that owns the files so `0700` does not stop it either. Verified end-to-end against the live site: a real session's package uploaded automatically, the server copy is byte-identical to the participant's download, a direct URL to it 404s, an anonymous `list.php?get=` 401s, and `eval-analysis.mjs` parses it. The download + email path remains underneath, unchanged — an upload failure must never cost a session.
15b. **(superseded) Option B as originally shipped, dark:** (`src/eval/evalUpload.ts` + `server/fastshaders-eval-upload.php`): `EVAL_UPLOAD_URL` is empty by default, so the committed behavior is byte-identical to option A. Enabling it is a four-step deliberate act documented in the PHP file's header — set a real secret in both files, upload the endpoint to `/fastshaders-eval/upload.php` (same origin as the app, so the CSP already permits it), set the URL, and **extend the consent text to name the server transfer**. The upload is always IN ADDITION to the download (the in-person safety net), fires only after submit, and every failure mode — CSP block on GitHub Pages, network, timeout, server refusal — degrades silently to the attach-it-yourself instructions. Server hardening: POST-only, constant-time key check, the exact `evalZipFileName` pattern, 64 MB cap, zip magic check, never-overwrite storage in a web-denied inbox, optional notification mail (the file stays on the server — PHP `mail()` attachments are unreliable).
16. **EXPORT is the finish control, and the action is called SUBMIT.** In a study session EXPORT opens `EvalFinishModal` — *"Are you finished?"* with **Continue working** and **Submit** — instead of quietly downloading a bare shader, because EXPORT is the button a participant reaches for when they think they are done. Submit runs the questionnaire, then packages everything and **opens the addressed email automatically** (a `mailto:` navigation is CSP-exempt and does not unload the page, so the thank-you screen stays up behind the mail client and keeps its "Open email" button for machines with no mail handler). The one step no platform allows us to skip is the attachment — `mailto:` cannot carry files — which is why the download runs first and the message body names the file to attach; enabling option B (§15) removes even that. The `!` still opens the questionnaire directly; the consent text names EXPORT → Submit.
16b. **The finish control, in the shape it replaced.** In a study session EXPORT is what a participant reaches for when they think they are done, so it opens `EvalFinishModal` — Continue (keep working, nothing saved) or Finish (questionnaire, then the one package) — instead of quietly downloading a bare shader. The `!` still opens the questionnaire directly; the consent text now names EXPORT. There is still exactly ONE download, after the questionnaire: the SUS answers belong inside the package, and a pre-questionnaire zip would give the researcher two near-identical files per participant that `eval-analysis.mjs` would count twice. Escape/backdrop mean Continue (the non-destructive choice).
17. **Latvian is the app's default language** (`fs:lang` fallback `'lv'`; a stored preference from before still wins), and the toolbar button now labels the language it switches TO — "EN" while Latvian is on — so it is an action, not a state, and carries no `aria-pressed` (a flipping label beside it reads as a contradiction in a screen reader). The consent dialog carries its OWN copy of that switch: it is modal, so the toolbar button is unreachable behind the backdrop, and a consent form nobody can read in their language is not consent. `i18n.test.ts` pins both.
18. **The thank-you screen never hides a failed transfer.** Its three upload outcomes read distinctly — sent automatically / sending… / **could not be sent** — and the failure branch is styled as a warning that names the remedy: the file is already in Downloads, and the **Download** button (always present, and promoted to the primary green action in exactly this case) gives another copy. Verified in a browser on both branches by aborting the endpoint request. NB when testing this, scope selectors to `.csv-import-modal__panel`: the toolbar behind the dialog has its own "Download app" button, which an unscoped text match also hits.
19. **The participant code becomes the shader name.** Consent → Agree sets `shaderName` to the code, so the file inside the package is `shader/p01.js` rather than an anonymous `my-shader.js` and the artifact is identifiable on its own. It is set AFTER `cleanSlateForStudy()`, because `newGraph()` resets the name to `DEFAULT_SHADER_NAME`; an empty code keeps that default, and the participant can still rename the shader themselves. Verified in a browser: the toolbar shows the code, it survives a mid-session reload (the name is persisted), and the package's shader entry is named after it.

## 8. Experiment-grade additions (2026-08-29)

Seven gaps that a dry-run bundle exposed — each one a thing the data could not
say about itself.

20. **Task & condition identity.** `…/eval/?task=T7-fire&budget=200&costbar=off`. The redirector stows the query string (sessionStorage, so the app URL stays clean and a reload keeps it); `evalTask.ts` parses it once and it lands in `session.json.task {id, briefBudget, costBarVisible}` plus a `task-start` event. **`costbar=off` really hides the CostBar** — that is the cost-feedback manipulation, not just a label. `briefBudget` is deliberately separate from the device budget: "stay under 200" in a brief and a headset profile's `maxPoints` are different claims, and a bundle carrying one of them leaves the other ambiguous. Only an explicit `off`/`0`/`false` hides the bar, so a typo cannot silently move a participant into the other arm; ids are charset-restricted so they survive a CSV.
21. **Cost-table provenance.** `session.json.costTable {source, kind, device, budget}` — `complexity.json@<version>` or the active profile's id, with `kind` distinguishing builtin / measured / manual. A point total means nothing without the table that produced it, and the tables move with each calibration round. The analysis script raises a PROBLEM when packages priced by different tables are pooled.
22. **Device info.** `session.json.device` — cores, memory class, screen/viewport/DPR, the WebGL-reported GPU, WebGPU availability, language, timezone, reduced-motion and colour-scheme preferences. Capability-shaped (what a methods section reports), not a fingerprint.
23. **Preview screenshot.** `preview.png`, captured at submit for the blinded quality-rating panel — judges cannot run forty shaders. The stage is a sandboxed opaque origin, so the parent cannot read its canvas: it is asked for (`fs:shot` → `fs:shot-result`) and the stage re-renders in the SAME task before `toDataURL`, because a context without `preserveDrawingBuffer` is cleared at composite time. Best-effort by construction — a failure, a timeout or a non-PNG reply simply ships a package without the image, and the README says which. The bytes are magic-checked on arrival (the stage runs the participant's shader and is adversarial).
24. **Over-budget events.** `budget-crossed {direction, total, budget}`, edge-triggered from a store subscription, so `overBudgetMs` and `budgetCrossings` fall out of the summary and "did the warning change what they built" is a one-liner instead of a snapshot reconstruction.
25. **Sequence integrity around the questionnaire.** Editing is NOT locked (Cancel must stay a real way back to the session); instead three checks ship in every package: `sus-in-one-sitting` (no gap over the idle threshold inside the SUS phase — Brooke asks for an immediate response), `no-edits-after-sus-open` (otherwise the packaged shader is not the artifact that was rated), and `response-pattern` (straight-lining — which always scores exactly 50 — and odd/even inconsistency, i.e. agreeing with both a claim and its negation). Flags, not blocks: the researcher weighs them.
26. **Preview-activity pings.** The stage posts a throttled `fs:activity` on pointer/wheel/key, which ShaderPreview forwards to the log. Without it, input inside the iframe is invisible to the parent's capture-phase listeners, so a participant studying the shader for minutes was idled out of active time after the threshold. Matters more in VR checks, where the preview IS the work.
27. **Upload accounting.** `session.json.session.id` now rides the analysis table, the CSV and the inbox listing, so a package collected by the server and the same one returned by hand reconcile instead of double-counting; the analysis raises a problem when one session id appears twice. Also: at N < 5 the SUS confidence interval is printed with a warning, because a t-CI at that N routinely runs outside the 0–100 scale and must not read as a finding.

