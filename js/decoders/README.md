# glTF decoders (vendored from three.js r184)

These are three.js's own glTF decoders — the two MESH decoders (Draco, meshopt)
and the Basis Universal TEXTURE transcoder. They are copied byte for byte and
never edited. Loader 0.8's `FastShaders.decoders` section hands them to
GLTFLoader, so a Draco- or meshopt-compressed model decodes instead of failing,
and a `KHR_texture_basisu` (KTX2) texture is transcoded for the GPU instead of
falling back or refusing.

| File | Copied from (three 0.184.0) | Bytes | sha256 |
|---|---|---|---|
| `draco_wasm_wrapper.js` | `examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js` | 58,456 | `8bb2952d2ba7d67e1414f8df819410cb0434a666be53f671fff75f68843d76f6` |
| `draco_decoder.wasm` | `examples/jsm/libs/draco/gltf/draco_decoder.wasm` | 192,420 | `a680d927bed9cb864ddbd63521868891af2bfbe755092761b4837487618df8ac` |
| `meshopt_decoder.module.js` | `examples/jsm/libs/meshopt_decoder.module.js` | 29,256 | `d428e73a000057c6c94bfcedc3412d0c2dc14ca8800e88553aab05113ad2bf19` |
| `basis_transcoder.js` | `examples/jsm/libs/basis/basis_transcoder.js` | 57,529 | `8478b5b6d6b74e7d3082b89f6417321d8d1dc0307f2b30d4484bb11b441696a1` |
| `basis_transcoder.wasm` | `examples/jsm/libs/basis/basis_transcoder.wasm` | 527,333 | `6cf17dc889352c42e9acf8897107978d127005fe3386c36a0e3845e27967630a` |

## Why the glTF Draco build

three ships two Draco builds. The glTF build is the one the
KHR_draco_mesh_compression extension is encoded against (Draco's
`gltf_2.0_draco_extension` branch), and it is 93 KB smaller than the default
build (250,876 bytes against 344,510). Only the WebAssembly pair is shipped:
DRACOLoader picks the JS decoder only where there is no WebAssembly, and every
browser FastShaders supports has it.

`meshopt_decoder.module.js` is an ES module (it ends in
`export { MeshoptDecoder };`). It is loaded ONLY through `import()`, never as a
classic `<script>`, which is why A-Frame's own `meshoptDecoderPath` route cannot
use it.

## The Basis Universal transcoder

`basis_transcoder.js` + `basis_transcoder.wasm` are what three's `KTX2Loader`
runs, and neither file is ever loaded by the page itself: KTX2Loader builds a
Worker whose source is the `.js` text CONCATENATED into it, and hands that
worker the `.wasm` as `transcoderBinary` bytes in its init message. So the
worker never fetches, exactly as the Draco worker never does — only the
LoadingManager in front of the loader ever resolves these two names.

## Rules

- **Never edit these files.** Re-copy them from `node_modules/three` when three
  is bumped. The FastShaders app's `src/vendorSync.test.ts` pins them byte for
  byte to three's copies, so a bump fails until they are re-copied (or the drift
  is deliberately accepted).
- **They are fetched BY URL.** Every page that loads loader 0.8 from jsdelivr
  resolves `decoders/<file>` beside the loader script, so once a 0.8 export
  exists these paths are FROZEN, exactly like the loader files: never rename or
  move them.
- **Publishing:** push this repository, then purge all six files on jsdelivr
  (`https://purge.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@master/js/decoders/<file>`).
  jsdelivr caches branch refs and caches a 404, so an unpurged file keeps
  failing for everyone who opens an export. The basis pair is FROZEN from the
  moment loader 0.8 ships, like the rest: check each file's sha256 on the CDN
  after purging (the basis pair must start `8478b5b6d6b74e7d` / `6cf17dc889352c42`).

## Licences

- **meshoptimizer** (`meshopt_decoder.module.js`): MIT License, Copyright (C)
  2016-2026 Arseny Kapoulkine. The notice is the first two lines of the file.
- **Draco** (`draco_wasm_wrapper.js`, `draco_decoder.wasm`): Apache License 2.0,
  Copyright The Draco Authors (https://github.com/google/draco). The
  licence requires its text to travel with redistributed copies (the app's
  `dist/`, the desktop app, jsdelivr), so the full text follows. It is the
  canonical text of https://www.apache.org/licenses/LICENSE-2.0.txt.
- **Basis Universal transcoder** (`basis_transcoder.js`,
  `basis_transcoder.wasm`): Apache License 2.0, Copyright Binomial LLC
  (https://github.com/BinomialLLC/basis_universal). Same licence, same
  requirement — the one text below covers both, so nothing further is appended.

---

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```
