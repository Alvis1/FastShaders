---
name: eval-results
description: Check the FastShaders study inboxes (alvismisjuns.lv staging + imgame.va.lv) for new study packages, download the ones not yet on disk into private/evalTests/new/<date>/, and summarise each (arm, participant, version, active time, SUS, likely-test flags). Use when the user asks "any new results?", "are there evalpro/eval/evalp results?", "check the inbox", or "download the study packages".
---

# Check and download study results

Run from the repo root:

```bash
node .claude/skills/eval-results/fetch.mjs          # download what is new
node .claude/skills/eval-results/fetch.mjs --list   # only look
```

How it works:

- **Logins:** taken from the gitignored `.vscode/eval-endpoint.json`. The top-level block is imgame.va.lv. The `_retiredAlvismisjuns` block is alvismisjuns.lv, which has been the LIVE staging inbox since 2026-11-10. Never print, copy or commit the passwords.
- **Download:** goes through `list.php?get=<file>` with basic auth. Each zip is tested with `unzip -t` and lands only when it is complete. A stalled or partial download is deleted, and the run exits 1, so re-run it.
- **"New":** a package counts as new when no file with its name (ignoring a browser's ` (1)` suffix) exists anywhere under `private/evalTests/`, and it is not listed in `private/evalTests/ignored.txt`.
- **Untrusted packages:** participants make them. The script reads them with `unzip -p` and parses JSON only. Don't extract them into the repo or run anything from them.

## Report to the user

For each new package, give its participant code, arm (`/eval`, `/evalp`, `/evalpro`), app version, host, consent version, date, active minutes, SUS score and browser. Also repeat any ⚠ flags: a code that looks like a test, every SUS answer the same, or under 5 active minutes. Then:

- **Your own test runs:** if the owner says a package was theirs, add its filename to `private/evalTests/ignored.txt` (one per line, `#` comments allowed) and delete the downloaded copy. Suggest deleting it from the inbox too, so it never reaches the analysis or the hand copy to ViA.
- **Real packages:** they wait in `private/evalTests/new/<date>/`. Ask which group folder they belong in (e.g. `202610/JRMS/4gr`, `202610/LMA`), and move them there when the owner names it. For numbers, run `npm run eval:analysis -- <folder>`.
- **Copy to ViA:** remind the owner that real packages from the alvismisjuns staging inbox still have to be copied to imgame.va.lv by hand.

The study data is participant-level, so keep it in `private/` (gitignored) and never publish it without the owner asking.
