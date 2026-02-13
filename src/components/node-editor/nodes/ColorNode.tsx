/**
 * ColorNode Component
 * Yellow node - 2 points (minimal VR impact)
 */

import React from 'react';
import { NodeProps } from 'reactflow';
import { BaseNode } from './BaseNode';

export const ColorNode: React.FC<NodeProps> = (props) => {
  return <BaseNode {...props} />;
};

export default ColorNode;
