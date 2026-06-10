/**
 * Trace ID 生成
 */
import { randomUUID } from 'node:crypto';

export function newTraceId(): string {
  return randomUUID();
}
