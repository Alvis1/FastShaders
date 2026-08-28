/**
 * System Usability Scale — items and scoring. PURE, node-tested.
 *
 * Item texts are Brooke's originals (Brooke, J. (1996). SUS: A 'quick and
 * dirty' usability scale. In Jordan et al. (Eds.), Usability Evaluation in
 * Industry, 189–194. Taylor & Francis; © Digital Equipment Corporation 1986 —
 * free to use, published reports must acknowledge the source), with ONE
 * accepted substitution: item 8 says "awkward" instead of "cumbersome"
 * (Finstad 2006 — non-native English speakers stumble on "cumbersome", and
 * this study's participants are exactly that population; Lewis 2018 presents
 * the standard SUS with the substitution).
 *
 * The Latvian items are a FORWARD TRANSLATION drafted for this study — no
 * validated Latvian SUS exists (verified 2026-08-28; the Multi-Language SUS
 * Toolkit covers no Baltic language). Before the study runs they need a
 * native review plus one blind back-translation (Beaton et al. 2000), and the
 * paper must label the Latvian form a non-validated adaptation. The answered
 * language is recorded per participant (Orfanou et al. 2015 precedent).
 *
 * Scoring (Brooke's rule): odd items contribute `response − 1`, even items
 * `5 − response`; the sum × 2.5 gives 0–100 in steps of 2.5. Individual item
 * scores are not meaningful on their own. Any uniform response pattern scores
 * exactly 50 — a property the tests pin.
 */

export const SUS_ITEM_COUNT = 10;
export const SUS_SCALE_MIN = 1;
export const SUS_SCALE_MAX = 5;

export const SUS_ITEMS_EN: readonly string[] = [
  'I think that I would like to use this system frequently',
  'I found the system unnecessarily complex',
  'I thought the system was easy to use',
  'I think that I would need the support of a technical person to be able to use this system',
  'I found the various functions in this system were well integrated',
  'I thought there was too much inconsistency in this system',
  'I would imagine that most people would learn to use this system very quickly',
  'I found the system very awkward to use',
  'I felt very confident using the system',
  'I needed to learn a lot of things before I could get going with this system',
];

export const SUS_ITEMS_LV: readonly string[] = [
  'Es domāju, ka es vēlētos šo sistēmu izmantot bieži',
  'Sistēma man šķita nevajadzīgi sarežģīta',
  'Man šķita, ka sistēmu ir viegli lietot',
  'Es domāju, ka man būtu vajadzīgs tehniskā speciālista atbalsts, lai spētu šo sistēmu lietot',
  'Man šķita, ka dažādās sistēmas funkcijas ir labi integrētas',
  'Man šķita, ka sistēmā ir pārāk daudz nekonsekvences',
  'Es domāju, ka lielākā daļa cilvēku iemācītos lietot šo sistēmu ļoti ātri',
  'Sistēma man šķita ļoti neērta lietošanā',
  'Lietojot sistēmu, es jutos ļoti pārliecināts/-a',
  'Man vajadzēja daudz ko apgūt, pirms varēju sākt darboties ar šo sistēmu',
];

/** Scale-end anchors (Brooke's form labels only the two ends). */
export const SUS_ANCHOR_LOW_EN = 'Strongly disagree';
export const SUS_ANCHOR_HIGH_EN = 'Strongly agree';
export const SUS_ANCHOR_LOW_LV = 'Pilnīgi nepiekrītu';
export const SUS_ANCHOR_HIGH_LV = 'Pilnīgi piekrītu';

/**
 * Contribution of one item (0–4). `index` is 0-based, so even indexes are the
 * odd-numbered (positively-worded) items.
 */
export function susContribution(index: number, response: number): number {
  return index % 2 === 0 ? response - 1 : 5 - response;
}

/**
 * Overall SUS score, or null when the form is not a complete valid response
 * set (all 10 items answered, each an integer 1–5 — Brooke: "all items should
 * be checked").
 */
export function computeSusScore(responses: readonly number[]): number | null {
  if (responses.length !== SUS_ITEM_COUNT) return null;
  let sum = 0;
  for (let i = 0; i < SUS_ITEM_COUNT; i++) {
    const r = responses[i];
    if (!Number.isInteger(r) || r < SUS_SCALE_MIN || r > SUS_SCALE_MAX) return null;
    sum += susContribution(i, r);
  }
  return sum * 2.5;
}
