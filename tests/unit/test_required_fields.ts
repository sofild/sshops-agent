/**
 * 必填字段校验 + pattern 匹配的单元测试
 */
import { describe, it, expect } from 'vitest';
import { patternToRegex, matchAnyPattern, buildDefaultPolicy } from '../../src/permissions/models.js';

describe('patternToRegex', () => {
  it('matches simple glob', () => {
    expect(patternToRegex('ssh_*_connect').test('ssh_ssh_connect')).toBe(true);
    expect(patternToRegex('ssh_*_connect').test('ssh_list_connects')).toBe(false);
  });
  it('escapes regex metacharacters', () => {
    expect(patternToRegex('a.b').test('a.b')).toBe(true);
    expect(patternToRegex('a.b').test('axb')).toBe(false);
  });
});

describe('matchAnyPattern', () => {
  it('returns first matching pattern', () => {
    expect(matchAnyPattern('ssh_ssh_connect', ['ssh_*_connect', 'ssh_*_execute'])).toBe('ssh_*_connect');
  });
  it('returns null when no match', () => {
    expect(matchAnyPattern('local:eat', ['ssh_*_connect'])).toBe(null);
  });
});

describe('buildDefaultPolicy', () => {
  it('merges required fields defaults with user overrides', () => {
    const p = buildDefaultPolicy({
      requiredFields: { 'my_custom_tool': ['host', 'user'] },
    });
    expect(p.requiredFields['ssh_*_connect']).toContain('host');
    expect(p.requiredFields['my_custom_tool']).toEqual(['host', 'user']);
  });
  it('merges optionsMenuTools defaults with user additions', () => {
    const p = buildDefaultPolicy({
      optionsMenuTools: ['my_special_tool'],
    });
    expect(p.optionsMenuTools).toContain('my_special_tool');
    expect(p.optionsMenuTools).toContain('ssh_*_connect');
  });
});
