// The repository list in "From GitHub" (GithubSetup.jsx), free of React so it is unit-tested.

export function when(iso, now = Date.now()) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '';
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  const unit = (n, word) => `${n} ${word}${n === 1 ? '' : 's'} ago`;
  return days < 1 ? 'today' : days === 1 ? 'yesterday' : days < 31 ? unit(days, 'day') : days < 365 ? unit(Math.floor(days / 30), 'month') : unit(Math.floor(days / 365), 'year');
}

// Archived repositories are left out (nothing can be pushed to them); the search matches name and description.
export function filterRepos(repos, query) {
  const q = String(query || '').trim().toLowerCase();
  const list = (repos || []).filter((r) => !r.archived);
  return q ? list.filter((r) => r.fullName.toLowerCase().includes(q) || String(r.description || '').toLowerCase().includes(q)) : list;
}
