import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
// Legacy environment overrides remain explicit opt-ins; clean installs use Kepos's own home.
export const root=resolve(process.env.ORBITAL_HOME||join(process.env.KEPOS_DATA_DIR||process.env.ORBITAL_DATA_DIR||join(process.env.KEPOS_HOME||join(homedir(),'.kepos'),'data'),'orbital'));
export const dataRoot=dirname(root);
export const sessionRoot=join(dataRoot,'sessions');

/**
 * 解析任意数据目录下的数据库文件。
 * 新装用 kepos.sqlite，但已有安装的 orbital.sqlite 必须继续可用——直接改名
 * 等于让老用户丢掉全部会话与任务记录。两者都在时优先新名（迁移后不再回退）。
 * CLI、daemon、retention 与主进程都走这一条规则，保证读写同一个文件。
 */
export function keposDatabaseFile(dataDir: string): string {
 const next = join(dataDir, 'kepos.sqlite');
 const legacy = join(dataDir, 'orbital.sqlite');
 return existsSync(next) || !existsSync(legacy) ? next : legacy;
}

// 当前安装的数据库路径。刻意延迟到首次调用才探测：app.ts 依赖
// "导入 paths.ts 不绑定默认 home" 这一契约，模块加载时 existsSync 会把
// 进程钉在默认目录上，导致自定义 --home 被误判为已绑定。
let resolvedDatabasePath: string | undefined;
export function databaseFile(): string {
 return (resolvedDatabasePath ??= keposDatabaseFile(dataRoot));
}
