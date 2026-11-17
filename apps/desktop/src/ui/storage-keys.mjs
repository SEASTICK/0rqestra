// Where the window keeps its projects and demo allowances in the browser storage of the app.
// The keys were renamed with the project. Data saved under the earlier names is still read, so
// nobody loses projects when the app updates; the next save writes the new keys.

export const PROJECTS_KEY = 'orqestra-ui-v1';
export const ALLOWANCES_KEY = 'orqestra-demo-allowances';

const EARLIER_KEYS = {
  [PROJECTS_KEY]: 'worktreeai-ui-v1',
  [ALLOWANCES_KEY]: 'worktreeai-demo-allowances',
};

export function readStored(storage, key) {
  const current = storage.getItem(key);
  if (current !== null && current !== undefined) return current;
  const earlier = EARLIER_KEYS[key];
  return earlier ? storage.getItem(earlier) : null;
}
