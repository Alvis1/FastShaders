/**
 * BaseNode Component
 * Reusable base component for all nodes with VR performance display
 */

import React from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { NodeData } from '../../../core/types';
import styles from './BaseNode.module.css';

interface BaseNodeProps extends NodeProps {
  data: NodeData;
}

export const BaseNode: React.FC<BaseNodeProps> = ({ data, selected }) => {
  const { label, complexity, vrImpact, color, inputs = [], outputs = [] } = data;

  // Determine VR impact indicator color
  const getVRImpactColor = (impact: string) => {
    switch (impact) {
      case 'minimal':
        return 'var(--complexity-comfortable)';
      case 'low':
        return 'var(--complexity-acceptable)';
      case 'medium':
        return 'var(--complexity-heavy)';
      case 'high':
        return 'var(--complexity-critical)';
      default:
        return 'var(--border-color)';
    }
  };

  return (
    <div
      className={`${styles.baseNode} ${selected ? styles.selected : ''}`}
      style={{
        borderColor: color,
        borderLeftWidth: '4px',
        borderLeftColor: color,
      }}
    >
      {/* Input Handles */}
      {inputs.map((input, index) => (
        <Handle
          key={input.id}
          type="target"
          position={Position.Left}
          id={input.id}
          style={{
            top: `${((index + 1) * 100) / (inputs.length + 1)}%`,
            background: 'var(--border-color)',
          }}
          title={input.label}
        />
      ))}

      {/* Node Header */}
      <div className={styles.header}>
        <div className={styles.labelContainer}>
          <span
            className={styles.vrIndicator}
            style={{ backgroundColor: getVRImpactColor(vrImpact) }}
            title={`VR Impact: ${vrImpact}`}
          />
          <span className={styles.label}>{label}</span>
        </div>
        <div className={styles.complexity} title="VR Performance Cost">
          {complexity > 0 ? `${complexity} pt${complexity !== 1 ? 's' : ''}` : ''}
        </div>
      </div>

      {/* Output Handles */}
      {outputs.map((output, index) => (
        <Handle
          key={output.id}
          type="source"
          position={Position.Right}
          id={output.id}
          style={{
            top: `${((index + 1) * 100) / (outputs.length + 1)}%`,
            background: color,
          }}
          title={output.label}
        />
      ))}
    </div>
  );
};

export default BaseNode;
