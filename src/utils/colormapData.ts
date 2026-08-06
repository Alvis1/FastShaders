/**
 * Colormap catalogue — the perceptually uniform / colour-vision-safe ramps the
 * scientific-visualization community actually uses, plus the two isoluminant
 * maps that matter specifically on a LIT 3D surface.
 *
 * GENERATED from upstream tables — do not hand-edit the stop strings. Each map
 * is stored as N uniformly spaced sRGB hex anchors; `sampleColormap` does the
 * piecewise-linear reconstruction. N per map was chosen as the smallest of
 * {17, 33, 65, 129, 256} whose reconstruction stays within 2/255 of the
 * original 256-entry table, so the catalogue costs a few KB instead of ~30.
 *
 * WHY THESE MAPS: a rainbow/jet ramp has no perceptual ordering and its
 * uncontrolled luminance introduces gradients the data does not contain
 * (Borland & Taylor 2007); the maps here are perceptually uniform and readable
 * with colour-vision deficiency (Crameri, Shephard & Heron, Nat. Commun. 2020).
 * Turbo is included as the ONE rainbow-family option because the more recent
 * counterpoint (Ware et al., "Rainbow Colormaps Are Not All Bad", IEEE CG&A)
 * finds rainbow maps genuinely better at resolving fine local detail — it is
 * marked `kind: 'rainbow'` so the UI can say so rather than hide it.
 *
 * THE ISOLUMINANT ENTRIES ARE NOT DECORATIVE. On a shaded 3D mesh a map with a
 * strong lightness ramp competes with shape-from-shading and flattens the
 * geometry; an isoluminant map holds perceptual lightness constant so lighting
 * reads shape and hue reads value (Kindlmann et al. 2002; Kovesi, "Good Colour
 * Maps: How to Design Them", arXiv:1509.03700). The trade-off is real — vision
 * resolves luminance far better than hue, so an isoluminant map carries less
 * fidelity for high-frequency data. That is a choice for the user to make, which
 * is why both families ship.
 *
 * PROVENANCE / LICENCE
 *   viridis, magma, inferno, plasma, cividis, coolwarm — via matplotlib (CC0).
 *     cividis: Nuñez, Anderton & Renslow, PLOS ONE 2018. coolwarm: Moreland 2009.
 *   batlow, lajolla, vik, roma — Fabio Crameri, Scientific colour maps (MIT).
 *   turbo — Copyright 2019 Google LLC, Apache-2.0 (Anton Mikhailov).
 *   isoluminant* — Peter Kovesi, CET perceptually uniform colour maps (CC-BY),
 *     via the colorcet distribution.
 *   grey — generated here as a CIE L*-linear ramp (not a raw 0→255 sRGB ramp,
 *     which is perceptually front-loaded).
 *
 * All stop values are sRGB-ENCODED, i.e. exactly what the upstream tables
 * publish. Anything sampling these for the GPU must convert to linear-light
 * first — see `srgbToLinear01` in colorUtils. Interpolating sRGB values as if
 * they were linear is precisely the error that destroys the perceptual
 * uniformity these maps exist to provide.
 */

/** How a map is meant to be read — drives UI grouping and the default choice. */
export type ColormapKind = 'sequential' | 'diverging' | 'isoluminant' | 'rainbow';

export interface ColormapDef {
  id: string;
  label: string;
  kind: ColormapKind;
  /** Comma-separated 6-digit sRGB hex anchors, uniformly spaced over [0, 1]. */
  stops: string;
}

export const COLORMAPS: ColormapDef[] = [
  {
    id: 'viridis',
    label: 'Viridis',
    kind: 'sequential',
    // 33 anchors, max reconstruction error 2/255 — matplotlib (CC0)
    stops:
      '440154,470d60,48186a,482374,472d7b,453681,424086,3f4989,3b528b,375a8d,33638d,2f6a8e,2c728e,297a8e,26818e,23898e,21908c,1f988b,1f9f88,21a685,28ae80,31b57b,3ebc74,4cc26c,5dc963,6ece58,82d34c,96d83f,abdc32,c0df24,d5e21a,eae51a,fde725',
  },
  {
    id: 'magma',
    label: 'Magma',
    kind: 'sequential',
    // 33 anchors, max reconstruction error 2/255 — matplotlib (CC0)
    stops:
      '000004,030311,0a0822,130d33,1d1146,28115a,36106a,430f76,50127c,5d177f,691c81,762181,822681,8f2a81,9c2e7f,a9327d,b63779,c33b75,cf4170,db486a,e65163,ee5c5e,f5695c,f9785d,fb8761,fd9668,fea571,feb47b,fec387,fed194,fde0a2,fceeb0,fcfdbf',
  },
  {
    id: 'inferno',
    label: 'Inferno',
    kind: 'sequential',
    // 33 anchors, max reconstruction error 2/255 — matplotlib (CC0)
    stops:
      '000004,040312,0b0724,150b37,210c4a,2e0a5a,3c0965,4a0c6b,57106d,63146e,70196e,7d1e6d,89226a,962766,a32b61,af315c,bb3755,c63e4d,d14644,db4f3b,e35932,eb6528,f1711e,f67f14,f98d0a,fb9c06,fcab0f,fbba1f,f9ca32,f5d949,f2e865,f3f586,fcffa4',
  },
  {
    id: 'plasma',
    label: 'Plasma',
    kind: 'sequential',
    // 65 anchors, max reconstruction error 1/255 — matplotlib (CC0)
    stops:
      '0d0887,19068b,220690,2a0593,310596,380499,3f049c,46039f,4c02a1,5302a3,5901a5,5f01a6,6600a7,6c00a8,7201a8,7801a8,7e03a8,8405a7,8909a6,8f0da4,9511a2,9a169f,9f1a9c,a41e99,a92396,ae2792,b22c8e,b7308b,bb3587,bf3983,c33e80,c7427c,cb4778,cf4b75,d25071,d6546d,d9596a,dc5e67,e06263,e36760,e66c5c,e87059,eb7555,ee7a52,f07f4f,f2844b,f48a48,f68f44,f89441,f99a3d,fb9f3a,fca537,fdab33,fdb130,feb72d,febd2a,fdc328,fdca26,fcd025,fbd724,f9dd25,f7e426,f5eb27,f2f227,f0f921',
  },
  {
    id: 'cividis',
    label: 'Cividis',
    kind: 'sequential',
    // 65 anchors, max reconstruction error 2/255 — matplotlib (CC0)
    stops:
      '00224e,002554,00285b,002b62,002e6a,003070,043371,113570,1a386f,213b6e,273e6e,2d416d,32436d,36466c,3b496c,3f4c6c,434e6c,47516c,4b546c,4f576c,52596d,565c6d,5a5f6e,5d626e,61656f,646770,686a71,6b6d72,6f7073,727374,757676,797877,7c7b78,807e78,848179,878478,8b8778,8f8a78,938d78,979077,9b9376,9f9676,a39a75,a79d74,aba072,afa371,b3a670,b7aa6e,bbad6c,bfb06b,c3b469,c8b766,ccba64,d0be61,d4c15f,d9c55c,ddc958,e1cc55,e6d051,ead44c,efd748,f4db42,f8df3c,fde334,fee838',
  },
  {
    id: 'batlow',
    label: 'Batlow',
    kind: 'sequential',
    // 17 anchors, max reconstruction error 2/255 — Crameri (MIT)
    stops:
      '011959,0d315d,114360,165262,226061,356a59,4d734d,667a3f,818232,a08a2b,bf9035,db954c,f29d6c,fca891,fdb4b4,fcc0d6,faccfa',
  },
  {
    id: 'lajolla',
    label: 'Lajolla',
    kind: 'sequential',
    // 33 anchors, max reconstruction error 1/255 — Crameri (MIT)
    stops:
      '191900,201c04,271e08,2f210d,372411,412716,4c2b1c,592f22,663429,753931,853d38,95423f,a64644,b64a48,c54f4a,d1564c,d95f4e,de6a4f,e1744f,e37e50,e58751,e79152,e99a52,eba353,edad54,efb755,f1c159,f4cd62,f7d972,fae588,fcef9f,fef7b6,fffecb',
  },
  {
    id: 'grey',
    label: 'Grey (L*)',
    kind: 'sequential',
    // 17 anchors, max reconstruction error 2/255 — CIE L*-linear, generated
    stops:
      '000000,141414,212121,2e2e2e,3b3b3b,4a4a4a,585858,676767,777777,878787,979797,a8a8a8,b9b9b9,cacaca,dbdbdb,ededed,ffffff',
  },
  {
    id: 'turbo',
    label: 'Turbo',
    kind: 'rainbow',
    // 33 anchors, max reconstruction error 2/255 — Google (Apache-2.0)
    stops:
      '30123b,392a73,4040a1,4456c7,466be3,467ff6,4293ff,37a7fa,29bbec,1dcdd8,18dcc3,1ee8b0,31f299,4cf97e,6bfd64,8aff4d,a3fd3c,b8f735,cced34,dee037,edd03a,f8c03a,fdae35,fe982c,fb8022,f56817,ec520f,e04009,d23105,c02302,ac1701,950d01,7a0403',
  },
  {
    id: 'coolwarm',
    label: 'Cool-Warm',
    kind: 'diverging',
    // 33 anchors, max reconstruction error 1/255 — Moreland via matplotlib (CC0)
    stops:
      '3b4cc0,445acc,4d68d7,5775e1,6282ea,6c8ef1,779af7,82a5fb,8db0fe,98b9ff,a3c2fe,aec9fc,b8d0f9,c2d5f4,ccd9ee,d5dbe6,dddddd,e5d8d1,ecd3c5,f1ccb9,f4c4ad,f7bba0,f7b194,f7a687,f49a7b,f18d6f,ec7f63,e57058,de604d,d55042,cb3e38,c0282f,b40426',
  },
  {
    id: 'vik',
    label: 'Vik',
    kind: 'diverging',
    // 33 anchors, max reconstruction error 2/255 — Crameri (MIT)
    stops:
      '001261,021f69,022b71,023779,034481,045089,0c5e92,1b6d9b,2f7ca6,478db1,609dbc,79adc7,92bdd2,acccdc,c5dbe5,dce5e9,ece5e1,eedacf,e9cbb9,e2bba4,dcab8f,d59c7b,cf8e68,c97f55,c37243,bc6331,b3531f,a5400e,932e06,832106,741506,660a07,590008',
  },
  {
    id: 'roma',
    label: 'Roma',
    kind: 'diverging',
    // 33 anchors, max reconstruction error 1/255 — Crameri (MIT)
    stops:
      '7e1700,862c06,8e3c0c,964b12,9d5818,a3651e,a97223,af7e2a,b68c32,bd9a3c,c4aa4a,caba5c,d0c971,d2d789,d1e19f,cbe8b3,c1eac2,b2e9cd,a1e4d4,8ddcd7,78d2d7,64c5d4,52b8d0,44aacc,399dc6,3190c1,2b83bc,2677b7,226ab1,1e5dab,184fa5,11409f,033198',
  },
  {
    id: 'isoluminant',
    label: 'Isoluminant',
    kind: 'isoluminant',
    // 17 anchors, max reconstruction error 1/255 — Kovesi CET (CC-BY)
    stops:
      '37b7ec,40b8de,48b9d0,4fbac2,57bbb3,60bba4,6abb94,77ba84,87b876,98b56b,a8b164,b8ad5f,c6a85d,d4a25e,e09d62,ec9767,f6906d',
  },
  {
    id: 'isoluminantDiv',
    label: 'Isoluminant Diverging',
    kind: 'isoluminant',
    // 129 anchors, max reconstruction error 2/255 — Kovesi CET (CC-BY)
    stops:
      '00cbfe,00cafd,00cafc,00cafb,00cafa,00c9f9,00c9f8,00c9f6,13c8f5,21c8f4,2bc8f3,33c8f2,3ac7f1,40c7f0,45c7ef,4ac7ee,4fc6ed,53c6ec,57c6ea,5bc6e9,5ec5e8,62c5e7,65c5e6,68c4e5,6bc4e4,6ec4e3,71c4e2,73c3e1,76c3e0,79c3de,7bc3dd,7ec2dc,80c2db,82c2da,84c1d9,87c1d8,89c1d7,8bc1d6,8dc0d5,8fc0d4,91c0d3,93bfd1,95bfd0,97bfcf,99bfce,9abecd,9cbecc,9ebecb,a0bdca,a1bdc9,a3bdc8,a5bdc7,a6bcc6,a8bcc5,aabcc3,abbbc2,adbbc1,aebbc0,b0babf,b1babe,b3babd,b4babd,b5b9bc,b7b9bb,b8b9bb,b9b8bb,bab8bb,bbb7bb,bcb7bc,bdb7bc,beb6bd,bfb6be,c0b6be,c1b5bf,c2b5c0,c3b5c0,c4b4c1,c5b4c2,c6b3c3,c6b3c3,c7b3c4,c8b2c5,c9b2c5,cab2c6,cbb1c7,ccb1c7,cdb0c8,ceb0c9,ceb0ca,cfafca,d0afcb,d1aecc,d2aecc,d3adcd,d4adce,d4adce,d5accf,d6acd0,d7abd1,d8abd1,d9aad2,d9aad3,daaad3,dba9d4,dca9d5,dda8d5,dea8d6,dfa7d7,dfa7d8,e0a6d8,e1a6d9,e2a6da,e3a5da,e3a5db,e4a4dc,e5a4dc,e6a3dd,e7a3de,e8a2df,e8a2df,e9a1e0,eaa1e1,eba0e1,eca0e2,ec9fe3,ed9fe3,ee9ee4,ef9ee5,f09de6',
  },
];
