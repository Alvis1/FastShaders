/**
 * What a paste or a drop holds: the first picture, found without trusting the
 * transfer's shape (a clipboard can throw, hold no files, or hold a screenshot
 * as an item only).
 */
import { describe, expect, it } from 'vitest';
import { dragMayHoldPicture, pictureFrom } from './pictureTransfer';

const file = (name: string, type: string) => new File(['x'], name, { type });
const transfer = (over: Record<string, unknown>) => over as unknown as DataTransfer;

describe('pictureFrom', () => {
  it('takes the first picture among the files, by name or by type', () => {
    const png = file('a.png', 'image/png');
    expect(pictureFrom(transfer({ files: [file('a.js', 'text/javascript'), png, file('b.jpg', 'image/jpeg')] }))).toBe(png);
    const untyped = file('photo.webp', '');
    expect(pictureFrom(transfer({ files: [untyped] }))).toBe(untyped);
  });

  it('takes a pasted screenshot, which is an item and no file', () => {
    const shot = file('image.png', 'image/png');
    const items = [
      { kind: 'string', type: 'text/plain', getAsFile: () => null },
      { kind: 'file', type: 'image/png', getAsFile: () => shot },
    ];
    expect(pictureFrom(transfer({ files: [], items }))).toBe(shot);
  });

  it('is null for text, for other files and for nothing', () => {
    expect(pictureFrom(null)).toBeNull();
    expect(pictureFrom(undefined)).toBeNull();
    expect(pictureFrom(transfer({}))).toBeNull();
    expect(pictureFrom(transfer({ files: [file('waves.js', 'text/javascript')], items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] }))).toBeNull();
    expect(pictureFrom(transfer({ files: [], items: [{ kind: 'file', type: 'image/png', getAsFile: () => null }] }))).toBeNull();
  });

  it('never throws on a transfer that does', () => {
    const hostile = transfer({ get files(): never { throw new Error('denied'); } });
    expect(() => pictureFrom(hostile)).not.toThrow();
    expect(pictureFrom(hostile)).toBeNull();
  });
});

describe('dragMayHoldPicture', () => {
  it('only a FILE drag can, and one that names a picture type does', () => {
    expect(dragMayHoldPicture(transfer({ types: ['Files'], items: [{ kind: 'file', type: 'image/jpeg' }] }))).toBe(true);
    expect(dragMayHoldPicture(transfer({ types: ['application/reactflow-type'], items: [] }))).toBe(false);
    expect(dragMayHoldPicture(transfer({ types: ['text/plain'] }))).toBe(false);
    expect(dragMayHoldPicture(null)).toBe(false);
  });

  it('a file drag whose types are hidden is let through: the drop decides', () => {
    expect(dragMayHoldPicture(transfer({ types: ['Files'], items: [] }))).toBe(true);
    expect(dragMayHoldPicture(transfer({ types: ['Files'], items: [{ kind: 'file', type: '' }] }))).toBe(true);
  });

  it('a drag of named non-pictures is not one', () => {
    expect(dragMayHoldPicture(transfer({ types: ['Files'], items: [{ kind: 'file', type: 'text/javascript' }, { kind: 'file', type: 'model/gltf-binary' }] }))).toBe(false);
  });
});
