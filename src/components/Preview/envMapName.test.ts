/**
 * The Light dropdown's env entry is NAMED AFTER THE IMAGE only when the image
 * really is the environment map — i.e. when graphToCode takes the
 * texture-object/IBL path, which it does for an Image node's Color socket
 * (`out`) alone. An Alpha/R/G/B edge into Environment is emitted as a scalar
 * `vec3(imageN.a)` ambient, so the option must read the generic
 * 'Environment', exactly as any other non-IBL env source does.
 *
 * A SOURCE pin for the selector (the vitest env is `node`; ShaderPreview has
 * never had a rendering test — see previewRebuild.test.ts), plus the engine
 * half it must agree with, checked behaviourally.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeNode, makeEdge } from '@/test-utils';
import { graphToCode } from '@/engine/graphToCode';
import { IMAGE_CHANNEL_COMPONENTS } from '@/utils/imageChannels';

const SRC = readFileSync(resolve(__dirname, 'ShaderPreview.tsx'), 'utf8');

function envSelectorBody(): string {
  const at = SRC.indexOf('const envMapName = useAppStore((s) => {');
  expect(at, 'the envMapName selector was renamed').toBeGreaterThan(-1);
  return SRC.slice(at, SRC.indexOf('\n  });\n', at));
}

describe('the env-map name follows the engine env gate', () => {
  it('graphToCode takes the IBL path only from the Color socket', () => {
    const image = () =>
      makeNode('i', 'imageNode', {
        imageB64: `data:image/webp;base64,${btoa('abc')}`,
        width: 2,
        height: 2,
        fileName: 'sky.webp',
        colorSpace: 'color',
      });
    const env = (handle: string) =>
      graphToCode([image(), makeNode('out', 'output')], [makeEdge('i', handle, 'out', 'env')]).code;
    expect(env('out')).toMatch(/env: texture\(/);
    for (const handle of IMAGE_CHANNEL_COMPONENTS.keys()) {
      expect(env(handle), handle).not.toMatch(/env: texture\(/);
    }
  });

  it('the selector names a channel-socket image edge generically, with the same predicate', () => {
    const body = envSelectorBody();
    expect(body).toContain(
      "if (src.data.registryType !== 'imageNode' || isImageChannelHandle(edge.sourceHandle)) return 'Environment';",
    );
    expect(SRC).toMatch(/^import \{ isImageChannelHandle \} from '@\/utils\/imageChannels';$/m);
  });
});
