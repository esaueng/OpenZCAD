import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCommits, validateIdentity } from './check-public-commit-metadata.mjs';

test('accepts valid GitHub noreply user and bot identities', () => {
  assert.deepEqual(validateIdentity('Ada Lovelace', '123+ada@users.noreply.github.com'), []);
  assert.deepEqual(validateIdentity('GitHub Actions[bot]', '41898282+github-actions[bot]@users.noreply.github.com'), []);
  assert.deepEqual(validateIdentity('Legacy account', 'legacy-user@noreply.github.com'), []);
  assert.deepEqual(validateIdentity('GitHub', 'noreply@github.com'), []);
});

test('rejects malformed, public, and placeholder identities without echoing values', () => {
  assert.ok(validateIdentity('Your Name', 'ada@example.com').length >= 2);
  assert.ok(validateIdentity('runner', 'runner@users.noreply.github.com').some((item) => item.includes('placeholder')));
  assert.ok(validateIdentity('Ada\nLovelace', 'ada@users.noreply.github.com').some((item) => item.includes('control')));
  assert.ok(validateIdentity('Ada Lovelace', 'ada@gmail.com').some((item) => item.includes('GitHub noreply')));
  const findings = validateCommits([{
    hash: '0123456789abcdef',
    authorName: 'Ada Lovelace', authorEmail: 'private@example.com',
    committerName: 'Ada Lovelace', committerEmail: 'committer@example.net',
  }]);
  assert.equal(findings.length, 2);
  assert.match(findings[0], /^0123456789ab: author email must use a GitHub noreply domain$/u);
  assert.match(findings[1], /^0123456789ab: committer email must use a GitHub noreply domain$/u);
  assert.ok(!findings.join('\n').includes('private@example.com'));
});
