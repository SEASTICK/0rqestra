// Where the window keeps its projects in the browser storage of the app.
//
// Compatibility (not shown to users): the project was called WorkTreeAI before it became
// 0rqestra, and its storage keys carried that name. Projects saved under the earlier key are still
// read, so nobody loses them; the next save writes the current key. The demo-allowance keys exist
// only so that the clean-up after Demo mode was removed (migrate-demo.mjs) can delete them.

export const PROJECTS_KEY = 'orqestra-ui-v1';
const LEGACY_PROJECTS_KEY = 'worktreeai-ui-v1';

export const ALLOWANCES_KEY = 'orqestra-demo-allowances';
export const LEGACY_ALLOWANCES_KEY = 'worktreeai-demo-allowances';

const EARLIER_KEYS = { [PROJECTS_KEY]: LEGACY_PROJECTS_KEY };

export function readStored(storage, key) {
  const current = storage.getItem(key);
  if (current !== null && current !== undefined) return current;
  const earlier = EARLIER_KEYS[key];
  return earlier ? storage.getItem(earlier) : null;
}
