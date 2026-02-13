/**
 * Shader and VR Performance Types
 * Defines structures for shader compilation and VR performance tracking
 */

import { Material } from 'three';

/**
 * VR Performance levels
 */
export type VRPerformanceLevel = 'comfortable' | 'acceptable' | 'heavy' | 'critical';

/**
 * VR Performance budget
 */
export interface VRPerformanceBudget {
  targetFPS: number;
  budgets: {
    comfortable: number;    // 0-100 points: 90+ FPS
    acceptable: number;     // 101-200 points: 72-90 FPS
    heavy: number;          // 201-300 points: 60-72 FPS
    critical: number;       // 300+ points: <60 FPS
  };
  notes?: string;
}

/**
 * Operation cost from complexity.json
 */
export interface OperationCost {
  cost: number;
  category: string;
  vrImpact: 'minimal' | 'low' | 'medium' | 'high';
  notes: string;
}

/**
 * Complexity data structure (from complexity.json)
 */
export interface ComplexityData {
  vrPerformance: VRPerformanceBudget;
  operations: Record<string, OperationCost>;
  optimizationSuggestions?: Record<string, string>;
}

/**
 * VR Performance metrics
 */
export interface VRPerformanceMetrics {
  totalComplexity: number;
  level: VRPerformanceLevel;
  estimatedFPS: number;
  budgetPercentage: number;
  nodeComplexities: Record<string, number>;
  warnings: string[];
  suggestions: string[];
}

/**
 * Shader compilation result
 */
export interface ShaderCompilationResult {
  success: boolean;
  material?: Material;
  errors?: CompilationError[];
  warnings?: string[];
}

/**
 * Compilation error
 */
export interface CompilationError {
  message: string;
  line?: number;
  type: 'syntax' | 'runtime' | 'validation';
  severity: 'error' | 'warning';
}

/**
 * Preview geometry types
 */
export type PreviewGeometry = 'sphere' | 'plane' | 'cube' | 'torus' | 'custom';

/**
 * Preview mode
 */
export type PreviewMode = 'standard' | 'vr' | 'split';

/**
 * Preview state
 */
export interface PreviewState {
  mode: PreviewMode;
  geometry: PreviewGeometry;
  material: Material | null;
  vrEnabled: boolean;
  showFPS: boolean;
  showVRMetrics: boolean;
  currentFPS?: number;
  errors: CompilationError[];
}

/**
 * Export format
 */
export type ExportFormat = 'tsl' | 'aframe';

/**
 * Export options
 */
export interface ExportOptions {
  format: ExportFormat;
  componentName?: string;      // For A-Frame export
  includeComments?: boolean;
  includeSchema?: boolean;      // Generate A-Frame schema from inputs
  optimizeForVR?: boolean;
}

/**
 * Export result
 */
export interface ExportResult {
  success: boolean;
  code?: string;
  filename?: string;
  errors?: string[];
}

/**
 * A-Frame component schema property
 */
export interface AFrameSchemaProperty {
  type: 'boolean' | 'number' | 'string' | 'color' | 'vec2' | 'vec3' | 'vec4';
  default: any;
  description?: string;
}

/**
 * A-Frame component schema
 */
export interface AFrameComponentSchema {
  [key: string]: AFrameSchemaProperty;
}

/**
 * A-Frame export metadata
 */
export interface AFrameExportMetadata {
  componentName: string;
  schema: AFrameComponentSchema;
  vrOptimized: boolean;
  estimatedComplexity: number;
  performanceLevel: VRPerformanceLevel;
}
