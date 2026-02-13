/**
 * DeformNode Component
 * Green node - 1 point (minimal VR impact)
 */

import React from 'react';
import { NodeProps } from 'reactflow';
import { BaseNode } from './BaseNode';

export const DeformNode: React.FC<NodeProps> = (props) => {
  return <BaseNode {...props} />;
};

export default DeformNode;
