/**
 * doctor 子命令：环境自检
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONFIG_DIR, PROJECT_ROOT, loadAndValidate } from '../config/loader.js';
import { getLogger } from '../observability/logging.js';

const log = getLogger().child({ component: 'doctor' });

export interface CheckItem {
  name: string;
  ok: boolean;
  detail?: string;
}

export async function runDoctor(): Promise<number> {
  const checks: CheckItem[] = [];

  // 1) Node version
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'Node.js version >= 18',
    ok: nodeMajor >= 18,
    detail: `node ${process.versions.node}`,
  });

  // 2) Config files exist
  for (const f of ['providers.yaml', 'agent.yaml', 'permissions.yaml', 'tools.yaml']) {
    const p = resolve(CONFIG_DIR, f);
    checks.push({
      name: `config file ${f}`,
      ok: existsSync(p),
      detail: existsSync(p) ? `${p}` : `missing`,
    });
  }

  // 3) Config validate
  const v = loadAndValidate();
  checks.push({
    name: 'config validates',
    ok: v.ok,
    detail: v.ok ? 'all good' : v.error,
  });

  // 4) Sessions/logs directories
  for (const d of ['sessions', 'logs']) {
    const p = resolve(PROJECT_ROOT, d);
    checks.push({
      name: `dir ${d}/`,
      ok: existsSync(p),
      detail: existsSync(p) ? `${p}` : `missing`,
    });
  }

  // 5) Audit path writable
  try {
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const testPath = resolve(PROJECT_ROOT, 'logs', '.doctor.tmp');
    writeFileSync(testPath, 'ok');
    unlinkSync(testPath);
    checks.push({ name: 'logs/ writable', ok: true });
  } catch (err) {
    checks.push({ name: 'logs/ writable', ok: false, detail: String(err) });
  }

  // 输出
  let allOk = true;
  for (const c of checks) {
    const mark = c.ok ? '✓' : '✗';
    // eslint-disable-next-line no-console
    console.log(`${mark} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
    if (!c.ok) allOk = false;
  }

  // eslint-disable-next-line no-console
  console.log(allOk ? '\nAll checks passed.' : '\nSome checks failed.');
  return allOk ? 0 : 1;
}
