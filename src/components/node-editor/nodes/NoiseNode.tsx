/**
 * NoiseNode Component
 * Orange node - 50 points (high VR impact)
 */

import { NodeProps } from 'reactflow';
import { BaseNode } from './BaseNode';

export const NoiseNode = (props: NodeProps) => {
  return <BaseNode {...props} />;
};

export default NoiseNode;
