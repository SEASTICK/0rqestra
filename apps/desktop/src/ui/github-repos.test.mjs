import { describe, expect, it } from 'vitest';
import { filterRepos, when } from './github-repos.mjs';

const repos = [
  { fullName: 'SEASTICK/0rqestra', description: 'Ett team av AI-agenter', archived: false },
  { fullName: 'SEASTICK/quantbot', description: '', archived: false },
  { fullName: 'SEASTICK/old', description: 'quant experiments', archived: true },
  { fullName: 'school/lab', description: 'Kemi quantum labb' },
];

describe('The repository list in From GitHub', () => {
  it('leaves out archived repositories and searches name and description, ignoring case', () => {
    expect(filterRepos(repos, '').map((r) => r.fullName)).toEqual(['SEASTICK/0rqestra', 'SEASTICK/quantbot', 'school/lab']);
    expect(filterRepos(repos, 'QUANT').map((r) => r.fullName)).toEqual(['SEASTICK/quantbot', 'school/lab']);
    expect(filterRepos(repos, 'agenter').map((r) => r.fullName)).toEqual(['SEASTICK/0rqestra']);
    expect(filterRepos(repos, 'nothing')).toEqual([]);
    expect(filterRepos(null, 'x')).toEqual([]);
  });

  it('says how long ago a push was', () => {
    const now = Date.parse('2026-11-25T12:00:00Z');
    expect(when('2026-11-25T08:00:00Z', now)).toBe('today');
    expect(when('2026-11-24T08:00:00Z', now)).toBe('yesterday');
    expect(when('2026-11-10T08:00:00Z', now)).toBe('15 days ago');
    expect(when('2026-08-10T08:00:00Z', now)).toBe('3 months ago');
    expect(when('2024-08-10T08:00:00Z', now)).toBe('2 years ago');
    expect(when('2026-10-20T08:00:00Z', now)).toBe('1 month ago');
    expect(when('2025-10-20T08:00:00Z', now)).toBe('1 year ago');
    expect(when(null, now)).toBe('');
    expect(when('not a date', now)).toBe('');
  });
});
