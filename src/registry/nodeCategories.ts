import type { NodeCategory } from '@/types';

export interface CategoryInfo {
  id: NodeCategory;
  label: string;
  icon: string;
}

export const CATEGORIES: CategoryInfo[] = [
  { id: 'input', label: 'Inputs', icon: 'I' },
  { id: 'type', label: 'Types', icon: 'T' },
  { id: 'arithmetic', label: 'Arithmetic', icon: '+' },
  { id: 'math', label: 'Math', icon: 'f' },
  { id: 'interpolation', label: 'Interpolation', icon: '~' },
  { id: 'vector', label: 'Vector', icon: 'V' },
  { id: 'noise', label: 'Noise', icon: 'N' },
  { id: 'color', label: 'Color', icon: 'C' },
  { id: 'output', label: 'Output', icon: 'O' },
];
