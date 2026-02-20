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
  { id: 'vector', label: 'Vector' },
  { id: 'noise', label: 'Noise' },
  { id: 'color', label: 'Color' },
  { id: 'texture', label: 'Textures' },
  { id: 'output', label: 'Output' },
];
