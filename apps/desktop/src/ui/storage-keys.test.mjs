import { describe, expect, it } from 'vitest';
import { ALLOWANCES_KEY, PROJECTS_KEY, readStored } from './storage-keys.mjs';

const storageWith = (entries) => ({ getItem: (key) => (key in entries ? entries[key] : null) });

describe('stored projects after the rename', () => {
  it('reads the new key when present, even if an earlier key exists', () => {
    expect(readStored(storageWith({ [PROJECTS_KEY]: 'new', 'worktreeai-ui-v1': 'old' }), PROJECTS_KEY)).toBe('new');
  });

  it('falls back to the earlier keys so saved projects and allowances survive', () => {
    const storage = storageWith({ 'worktreeai-ui-v1': '[{"id":"p1"}]', 'worktreeai-demo-allowances': '{"OpenAI":50}' });
    expect(readStored(storage, PROJECTS_KEY)).toBe('[{"id":"p1"}]');
    expect(readStored(storage, ALLOWANCES_KEY)).toBe('{"OpenAI":50}');
  });

  it('returns null when nothing was ever saved', () => {
    expect(readStored(storageWith({}), PROJECTS_KEY)).toBeNull();
    expect(readStored(storageWith({}), 'unrelated')).toBeNull();
  });
});
