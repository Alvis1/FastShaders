# Pass 4 — Security (cap: 12 findings)

**Run this pass first.** Cost of a missed finding is highest here because FastShaders loads user-supplied files.

**Threat model:** a malicious `.fastshader` file emailed to a user. Trace the load path end-to-end.

- **AST execution flow:** `rg "parser\.parse|new Function\(|\beval\("`. For each hit, trace the input source. Is the AST whitelisted by node type, or can arbitrary user JS reach a runtime evaluator?
- **JSON deserialization:** `rg "JSON\.parse"`. For each hit, check whether `__proto__`, `constructor`, `prototype` keys are stripped or rejected. Is there schema validation (zod, ajv, manual)?
- **XSS surfaces:** `rg "dangerouslySetInnerHTML|innerHTML|outerHTML"`. Check Monaco language registration for user-provided content. Check React Flow node labels — escaped or rendered as HTML?
- **A-Frame XR export:** the exported HTML/JS — does it interpolate user-controlled strings into a `<script>` tag or HTML attributes? That's stored XSS when the export is shared.
- **URL handling:** `rg "fetch\(|new Image\(|texture.*load"`. Are any URLs user-derived? Allowlist or CORS check?
- **Dependencies:** if the environment allows it, run `npm audit --json` and report the top 5 by severity with the affected package and what the project does with it. **If network is unavailable, skip this item — do not invent CVEs from training data.**
- **CSP:** check `index.html` and `vite.config.*` for any CSP. If none, propose a policy that won't break Monaco workers or Three.js shader compilation.
