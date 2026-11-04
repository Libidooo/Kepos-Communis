// 派发能力的判定：谁有权派生僚属。
//
// 单独成一个模块，因为这条规则有两个使用者（worker pool 决定加载哪些工具、
// 值守层决定能不能自动派发），而它一旦在两处各写一遍就会漂移——
// 漂移的后果是"某个入口意外获得了派生权"，这是权限问题，不是显示问题。
import type { WorkerLaunchMetadata } from './workers.ts';

/**
 * 这个任务是否可以代表（即拥有派生与裁决工具）。
 *
 * 两条约束：
 *   1. 只有第一层可以派生。僚属不能再往外派，否则责任链没有尽头。
 *   2. 值守自动派发的任务不行。它没有人类在场，
 *      一条误触发的规则若能自行派生，会在人察觉前长出一整棵树。
 */
export function canRepresent(delegationDepth: number, metadata: Pick<WorkerLaunchMetadata, 'purpose'> = {}): boolean {
  if (delegationDepth !== 0) return false;
  return metadata.purpose !== 'watch';
}

/** 值守派发的任务只拿最小只读工具集——它要做的只是"看一眼再说"。 */
export function readonlyToolsForPurpose(metadata: Pick<WorkerLaunchMetadata, 'purpose'> = {}): string[] {
  return metadata.purpose === 'watch' ? ['read'] : [];
}
