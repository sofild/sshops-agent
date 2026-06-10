/**
 * Error 类型测试
 */
import { describe, it, expect } from 'vitest';
import {
  MissingInfoError,
  HallucinationGuardError,
  CircuitOpenError,
  InvalidOptionError,
  TurnTimeoutError,
  SessionMigrationError,
} from '../../src/utils/errors.js';

describe('New error types', () => {
  it('MissingInfoError has fields', () => {
    const e = new MissingInfoError('missing', ['host', 'password']);
    expect(e.code).toBe('MISSING_INFO');
    expect(e.fields).toEqual(['host', 'password']);
  });
  it('HallucinationGuardError carries tool info', () => {
    const e = new HallucinationGuardError('hallucinated', 'ssh_ssh_connect', 'permission denied');
    expect(e.code).toBe('HALLUCINATION_GUARD');
    expect(e.toolName).toBe('ssh_ssh_connect');
    expect(e.matchedKeyword).toBe('permission denied');
  });
  it('CircuitOpenError carries count', () => {
    const e = new CircuitOpenError('open', 5);
    expect(e.code).toBe('CIRCUIT_OPEN');
    expect(e.consecutiveErrors).toBe(5);
  });
  it('InvalidOptionError carries input', () => {
    const e = new InvalidOptionError('bad', '5');
    expect(e.code).toBe('INVALID_OPTION');
    expect(e.input).toBe('5');
  });
  it('TurnTimeoutError carries turn', () => {
    const e = new TurnTimeoutError('timeout', 12);
    expect(e.code).toBe('TURN_TIMEOUT');
    expect(e.turn).toBe(12);
  });
  it('SessionMigrationError', () => {
    const e = new SessionMigrationError('cannot migrate');
    expect(e.code).toBe('SESSION_MIGRATION');
  });
});
