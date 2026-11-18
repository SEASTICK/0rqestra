import { describe, expect, it } from 'vitest';
import { PROJECTS_KEY, readStored } from './storage-keys.mjs';

const storageWith = (entries) => ({ getItem: (key) => (key in entries ? entries[key] : null) });

describe('stored projects after the rename', () => {
  it('reads the current key when present, even if the earlier key exists', () => {
    expect(readStored(storageWith({ [PROJECTS_KEY]: 'new', 'worktreeai-ui-v1': 'old' }), PROJECTS_KEY)).toBe('new');
  });

  it('falls back to the earlier key so saved projects survive', () => {
    expect(readStored(storageWith({ 'worktreeai-ui-v1': '[{"id":"p1"}]' }), PROJECTS_KEY)).toBe('[{"id":"p1"}]');
  });

  it('returns null when nothing was ever saved', () => {
    expect(readStored(storageWith({}), PROJECTS_KEY)).toBeNull();
    expect(readStored(storageWith({}), 'unrelated')).toBeNull();
  });
});
