import type { NodeCategory } from '@/types';

export interface CategoryInfo {
  id: NodeCategory;
  label: string;
}

export const CATEGORIES: CategoryInfo[] = [
  { id: 'input', label: 'Inputs' },
  { id: 'type', label: 'Types' },
  { id: 'arithmetic', label: 'Arithmetic' },
  { id: 'math', label: 'Math' },
  { id: 'interpolation', label: 'Interpolation' },
  { id: 'logic', label: 'Logic' },
  { id: 'vector', label: 'Vector' },
  { id: 'sdf', label: 'Distance fields' },
  { id: 'noise', label: 'Noise' },
  { id: 'dataviz', label: 'DataViz' },
  { id: 'texture', label: 'Textures' },
  { id: 'presets', label: 'Presets' },
  { id: 'unknown', label: 'Unknown' },
  { id: 'output', label: 'Output' },
];
