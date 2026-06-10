/**
 * 反幻觉守卫 + 可选项菜单 + 失败检测的单元测试
 */
import { describe, it, expect } from 'vitest';
import {
  parseNeedInputMarker,
  parseOptionsMenuMarker,
  stripStructuredMarkers,
  isFailureSignal,
} from '../../src/agent/types.js';

describe('parseNeedInputMarker', () => {
  it('parses single field', () => {
    const r = parseNeedInputMarker('hello [NEED_INPUT:password]');
    expect(r).toEqual([
      { field: 'password', prompt: '请提供 password', sensitive: true },
    ]);
  });
  it('parses multiple fields', () => {
    const r = parseNeedInputMarker('[NEED_INPUT:host|user|password] please');
    expect(r?.length).toBe(3);
    expect(r?.[0].field).toBe('host');
    expect(r?.[2].sensitive).toBe(true);
  });
  it('returns null when no marker', () => {
    expect(parseNeedInputMarker('no marker here')).toBeNull();
  });
  it('does not flag non-sensitive fields', () => {
    const r = parseNeedInputMarker('[NEED_INPUT:host]');
    expect(r?.[0].sensitive).toBe(false);
  });
});

describe('parseOptionsMenuMarker', () => {
  it('parses simple options', () => {
    const r = parseOptionsMenuMarker('[OPTIONS:host|10.222.10.21=web-01,10.222.10.22=db-01]');
    expect(r).not.toBeNull();
    expect(r?.field).toBe('host');
    expect(r?.options.length).toBe(2);
    expect(r?.options[0].value).toBe('10.222.10.21');
    expect(r?.options[0].label).toBe('web-01');
  });
  it('handles options without explicit label (uses value as label)', () => {
    const r = parseOptionsMenuMarker('[OPTIONS:host|10.222.10.21,10.222.10.22]');
    expect(r?.options[0].value).toBe('10.222.10.21');
    expect(r?.options[0].label).toBe('10.222.10.21');
  });
  it('returns null when missing field', () => {
    expect(parseOptionsMenuMarker('[OPTIONS:justOnePart]')).toBeNull();
  });
});

describe('stripStructuredMarkers', () => {
  it('removes both NEED_INPUT and OPTIONS markers', () => {
    const r = stripStructuredMarkers(
      'Connecting now [NEED_INPUT:password] and [OPTIONS:host|a,b]'
    );
    expect(r).toBe('Connecting now  and');
  });
  it('preserves content without markers', () => {
    expect(stripStructuredMarkers('plain text')).toBe('plain text');
  });
});

describe('isFailureSignal', () => {
  const keywords = ['No authentication method', 'permission denied'];
  it('detects isError=true', () => {
    const r = isFailureSignal('ssh_ssh_connect', 'id1', true, 'irrelevant', keywords);
    expect(r.isError).toBe(true);
  });
  it('detects matched keyword (case-insensitive)', () => {
    const r = isFailureSignal(
      'ssh_ssh_connect',
      'id1',
      false,
      'Server returned: No Authentication Method available',
      keywords
    );
    expect(r.isError).toBe(true);
    expect(r.matchedKeyword).toBe('No authentication method');
  });
  it('returns no failure on success content', () => {
    const r = isFailureSignal(
      'ssh_ssh_execute',
      'id1',
      false,
      'OK\nroot@web-01:~#',
      keywords
    );
    expect(r.isError).toBe(false);
  });

  // ============ Phase 3 扩 failureKeywords ============
  it('detects "no such file or directory" (Phase 3 new keyword)', () => {
    const r = isFailureSignal(
      'ssh_ssh_exec',
      'id1',
      false,
      'ls: cannot access /tmp/nonexistent: No such file or directory',
      ['no such file or directory']
    );
    expect(r.isError).toBe(true);
    expect(r.matchedKeyword).toBe('no such file or directory');
  });

  it('detects "cannot access" (Phase 3 new keyword)', () => {
    const r = isFailureSignal(
      'ssh_ssh_exec',
      'id1',
      false,
      'cat: /var/log/foo: cannot access: Permission denied',
      ['cannot access']
    );
    expect(r.isError).toBe(true);
  });

  it('detects "Connection lost" (Phase 3 new keyword)', () => {
    const r = isFailureSignal(
      'ssh_ssh_exec',
      'id1',
      false,
      'Error: Connection lost after 30s',
      ['Connection lost']
    );
    expect(r.isError).toBe(true);
  });
});
