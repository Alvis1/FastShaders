# Funding / institution logos

Shown in the FastShaders "About / Contact" popover (click the **FastShaders**
brand in the toolbar), beside the funding acknowledgment. Referenced by
[`src/components/Layout/Toolbar.tsx`](../../src/components/Layout/Toolbar.tsx).

| File               | Logo                                              | Source                                                                 |
| ------------------ | ------------------------------------------------- | ---------------------------------------------------------------------- |
| `eu-cofunded.svg`  | "Co-funded by the European Union" emblem          | Built to the EU visual-identity spec (official 12-star flag + Arial statement). Emblem geometry & wording are the EU's; the SVG is app-generated. |
| `nap2027.svg`      | National Development Plan 2027 (NAP2027)           | Official logo package from zm.gov.lv (`nap-logo.zip`) — colour, English, with name. |
| `via.svg`          | Vidzeme University of Applied Sciences (ViA)       | Wikimedia Commons `File:Vidzemes_Augstskola_logo.svg` (CC BY-SA 4.0).  |

## Notes

- All three are self-contained SVGs (no external refs), so they inline cleanly
  and scale crisply at the ~26–30px display height used in the popover.
- The EU emblem was **built**, not downloaded: the only generic
  "Co-funded by the European Union" file on Wikimedia was actually the *Health
  Programme* variant. This one uses the official flag geometry (Reflex Blue
  `#003399`, 12 upright `#FFCC00` stars in a circle) plus the mandated
  "Co-funded by the European Union" statement in Arial — the compliant form for
  the Cohesion Policy 2021–2027 programming period.
- Each `<img>` has an `onError` guard that hides it if the file is ever missing,
  so the popover never shows a broken-image icon.

## Replacing a logo

Drop a new file here with the same name (SVG preferred; PNG works too — if you
switch formats, update the matching `src` extension in `Toolbar.tsx`).
Transparent backgrounds look best on the popover's light surface.
