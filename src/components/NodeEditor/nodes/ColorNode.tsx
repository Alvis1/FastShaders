import { memo, useCallback, useRef, type ChangeEvent } from 'react';
import { Position, type NodeProps } from '@xyflow/react';
import type { ColorFlowNode } from '@/types';
import { useAppStore } from '@/store/useAppStore';
import { hexToRgb01 } from '@/utils/colorUtils';
import { TypedHandle } from '../handles/TypedHandle';
import './ColorNode.css';

export const ColorNode = memo(function ColorNode({
  id,
  data,
  selected,
}: NodeProps<ColorFlowNode>) {
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const varName = useAppStore((s) => s.nodeVarNames[id]);
  const pickerRef = useRef<HTMLInputElement>(null);
  const hex = String(data.values?.hex ?? '#ff0000');

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      updateNodeData(id, { values: { ...data.values, hex: e.target.value } } as Partial<ColorFlowNode['data']>);
    },
    [id, data.values, updateNodeData],
  );

  const openPicker = useCallback(() => {
    pickerRef.current?.click();
  }, []);

  return (
    <div
      className={`color-node ${selected ? 'color-node--selected' : ''}`}
      style={{ background: hex }}
      onDoubleClick={openPicker}
    >
      <span
        className="color-node__label"
        style={{ color: (() => {
          const [r, g, b] = hexToRgb01(hex);
          // sRGB relative luminance
          return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45
            ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.85)';
        })() }}
      >{varName ?? 'Color'}</span>
      <input
        ref={pickerRef}
        type="color"
        className="color-node__picker"
        value={hex}
        onChange={handleChange}
      />
      <TypedHandle
        type="source"
        position={Position.Right}
        id="out"
        dataType="color"
      />
    </div>
  );
});
