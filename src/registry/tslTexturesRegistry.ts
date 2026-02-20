import * as tslTextures from 'tsl-textures';
import { Color, Vector2, Vector3 } from 'three';
import type { NodeDefinition, PortDefinition, TSLDataType } from '@/types';

// Known TSL node refs that appear in tsl-textures defaults
// Maps the default key name to the port dataType
const TSL_REF_PORTS: Record<string, TSLDataType> = {
  position: 'vec3',
  time: 'float',
};

export type ParamKind = 'number' | 'color' | 'vec3' | 'vec2' | 'tslRef' | 'meta';

export interface ParamClassification {
  kind: ParamKind;
  key: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultValue: any;
  tslRefDataType?: TSLDataType;
}

function classifyParam(key: string, value: unknown): ParamClassification {
  if (key.startsWith('$')) return { kind: 'meta', key, defaultValue: value };

  // TSL node refs: position, time, or anything with .isNode
  if (key in TSL_REF_PORTS) return { kind: 'tslRef', key, defaultValue: value, tslRefDataType: TSL_REF_PORTS[key] };
  if (value && typeof value === 'object' && 'isNode' in value && (value as { isNode: boolean }).isNode) {
    return { kind: 'tslRef', key, defaultValue: value, tslRefDataType: 'any' };
  }

  if (value instanceof Color) return { kind: 'color', key, defaultValue: value };
  if (value instanceof Vector3) return { kind: 'vec3', key, defaultValue: value };
  if (value instanceof Vector2) return { kind: 'vec2', key, defaultValue: value };
  if (typeof value === 'number') return { kind: 'number', key, defaultValue: value };

  // Unknown type — skip
  return { kind: 'meta', key, defaultValue: value };
}

function camelToLabel(s: string): string {
  return s.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim();
}

// Cache classifications per function name
const classificationCache = new Map<string, ParamClassification[]>();

export function getParamClassifications(exportName: string): ParamClassification[] {
  if (classificationCache.has(exportName)) return classificationCache.get(exportName)!;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = (tslTextures as any)[exportName];
  if (!fn?.defaults) return [];

  const defaults = fn.defaults as Record<string, unknown>;
  const result: ParamClassification[] = [];
  for (const [key, value] of Object.entries(defaults)) {
    result.push(classifyParam(key, value));
  }
  classificationCache.set(exportName, result);
  return result;
}

export function buildTSLTextureDefinitions(): NodeDefinition[] {
  const definitions: NodeDefinition[] = [];

  for (const [exportName, exportValue] of Object.entries(tslTextures)) {
    if (typeof exportValue !== 'function') continue;
    if (!('defaults' in exportValue) || !(exportValue as { defaults?: unknown }).defaults) continue;

    const defaults = (exportValue as { defaults: Record<string, unknown> }).defaults;
    const displayName = (defaults.$name as string) ?? camelToLabel(exportName);
    const isPositionNode = !!defaults.$positionNode;

    const inputs: PortDefinition[] = [];
    const defaultValues: Record<string, string | number> = {};
    const classifications = getParamClassifications(exportName);

    for (const param of classifications) {
      if (param.kind === 'meta') continue;

      if (param.kind === 'tslRef') {
        inputs.push({
          id: param.key,
          label: camelToLabel(param.key),
          dataType: param.tslRefDataType ?? 'any',
        });
      } else if (param.kind === 'number') {
        inputs.push({
          id: param.key,
          label: camelToLabel(param.key),
          dataType: 'float',
        });
        defaultValues[param.key] = param.defaultValue;
      } else if (param.kind === 'color') {
        const col = param.defaultValue as Color;
        defaultValues[param.key] = '#' + col.getHexString();
      } else if (param.kind === 'vec3') {
        const v = param.defaultValue as Vector3;
        defaultValues[`${param.key}_x`] = Math.round(v.x * 10000) / 10000;
        defaultValues[`${param.key}_y`] = Math.round(v.y * 10000) / 10000;
        defaultValues[`${param.key}_z`] = Math.round(v.z * 10000) / 10000;
      } else if (param.kind === 'vec2') {
        const v = param.defaultValue as Vector2;
        defaultValues[`${param.key}_x`] = Math.round(v.x * 10000) / 10000;
        defaultValues[`${param.key}_y`] = Math.round(v.y * 10000) / 10000;
      }
    }

    definitions.push({
      type: `tslTex_${exportName}`,
      label: displayName,
      category: 'texture',
      tslFunction: exportName,
      tslImportModule: 'tsl-textures',
      inputs,
      outputs: [{
        id: 'out',
        label: isPositionNode ? 'Position' : 'Color',
        dataType: isPositionNode ? 'vec3' : 'color',
      }],
      defaultValues: Object.keys(defaultValues).length > 0 ? defaultValues : undefined,
    });
  }

  return definitions;
}
