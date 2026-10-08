import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCommits, validateIdentity } from './check-public-commit-metadata.mjs';

test('accepts valid GitHub noreply user and bot identities', () => {
  assert.deepEqual(validateIdentity('Ada Lovelace', '123+ada@users.noreply.github.com'), []);
  assert.deepEqual(validateIdentity('GitHub Actions[bot]', '41898282+github-actions[bot]@users.noreply.github.com'), []);
  assert.deepEqual(validateIdentity('Legacy account', 'legacy-user@noreply.github.com'), []);
  assert.deepEqual(validateIdentity('GitHub', 'noreply@github.com'), []);
});

test('accepts Claude public automation identities for authors and committers', () => {
  for (const name of ['Claude', 'Claude Code', 'CLAUDE']) {
    assert.deepEqual(validateIdentity(name, 'noreply@anthropic.com'), []);
  }
  assert.deepEqual(validateIdentity('Claude', 'NOREPLY@ANTHROPIC.COM'), []);
  assert.deepEqual(validateIdentity('claude[bot]', '209825114+claude[bot]@users.noreply.github.com'), []);
  assert.deepEqual(validateIdentity('Claude Code', '208546643+claude-code-action[bot]@users.noreply.github.com'), []);
  assert.deepEqual(validateIdentity('dependabot[bot]', '49699333+dependabot[bot]@users.noreply.github.com'), []);
  assert.deepEqual(validateIdentity('renovate[bot]', '29139614+renovate[bot]@users.noreply.github.com'), []);
  assert.deepEqual(validateCommits([{
    hash: '0123456789abcdef',
    authorName: 'Claude', authorEmail: 'noreply@anthropic.com',
    committerName: 'Claude Code', committerEmail: 'noreply@anthropic.com',
  }]), []);
});

test('bot exceptions require the exact public name and address and preserve human checks', () => {
  for (const [name, email] of [
    ['Example Person', 'noreply@anthropic.com'],
    ['Claude', 'example@anthropic.com'],
    ['Claude', 'noreply@anthropic.com.example.invalid'],
    ['Claude', 'noreply+example@anthropic.com'],
    ['Claude', 'noreply@example.invalid'],
  ]) {
    assert.ok(validateIdentity(name, email).length);
  }
  assert.ok(validateIdentity(' Claude ', 'noreply@anthropic.com').some((item) => item.includes('blank')));
  assert.ok(validateIdentity('Claude\u0000', 'noreply@anthropic.com').some((item) => item.includes('control')));
  const findings = validateCommits([{
    hash: '0123456789abcdef',
    authorName: 'Claude', authorEmail: 'noreply@anthropic.com',
    committerName: 'Example Person', committerEmail: 'private@example.invalid',
  }]);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /: committer email must use /u);
  assert.ok(!findings.join('\n').includes('private@example.invalid'));
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
  assert.match(findings[0], /^0123456789ab: author email must use a GitHub noreply domain or an approved public bot identity$/u);
  assert.match(findings[1], /^0123456789ab: committer email must use a GitHub noreply domain or an approved public bot identity$/u);
  assert.ok(!findings.join('\n').includes('private@example.com'));
});
