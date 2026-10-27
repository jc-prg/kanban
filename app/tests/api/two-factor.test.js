import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { generateChallenge, verifyChallenge, discardChallenge } = require('../../backend/twoFactor');

describe('2FA challenges — one code per session', () => {
  it('2FA-1: repeated sends for the same session reuse the pending challenge', () => {
    const a = generateChallenge('session-1');
    const b = generateChallenge('session-1');
    expect(a.isNew).toBe(true);
    expect(b.isNew).toBe(false);
    expect(b.challengeId).toBe(a.challengeId);
    expect(b.code).toBe(a.code);
  });

  it('2FA-2: different sessions get different challenges', () => {
    const a = generateChallenge('session-2a');
    const b = generateChallenge('session-2b');
    expect(b.isNew).toBe(true);
    expect(b.challengeId).not.toBe(a.challengeId);
  });

  it('2FA-3: force (resend) replaces the pending challenge and invalidates the old code', () => {
    const a = generateChallenge('session-3');
    const b = generateChallenge('session-3', { force: true });
    expect(b.isNew).toBe(true);
    expect(b.challengeId).not.toBe(a.challengeId);
    expect(verifyChallenge(a.challengeId, a.code)).toBe(false);
    expect(verifyChallenge(b.challengeId, b.code)).toBe(true);
  });

  it('2FA-4: a correct code is single-use; next send creates a new challenge', () => {
    const a = generateChallenge('session-4');
    expect(verifyChallenge(a.challengeId, a.code)).toBe(true);
    expect(verifyChallenge(a.challengeId, a.code)).toBe(false);
    expect(generateChallenge('session-4').isNew).toBe(true);
  });

  it('2FA-5: a wrong code does not burn the challenge until max attempts', () => {
    const a = generateChallenge('session-5');
    const wrong = a.code === '123456' ? '654321' : '123456';
    expect(verifyChallenge(a.challengeId, wrong)).toBe(false);
    expect(verifyChallenge(a.challengeId, a.code)).toBe(true);

    const b = generateChallenge('session-5');
    for (let i = 0; i < 5; i++) verifyChallenge(b.challengeId, wrong);
    expect(verifyChallenge(b.challengeId, b.code)).toBe(false);
  });

  it('2FA-6: discardChallenge lets the next send start fresh', () => {
    const a = generateChallenge('session-6');
    discardChallenge(a.challengeId);
    const b = generateChallenge('session-6');
    expect(b.isNew).toBe(true);
    expect(verifyChallenge(a.challengeId, a.code)).toBe(false);
  });
});
