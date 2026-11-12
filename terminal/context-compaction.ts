export type CompactionReason = 'manual' | 'threshold' | 'overflow';

const COMPACTION_REASONS = new Set<CompactionReason>(['manual', 'threshold', 'overflow']);

export function compactionGenerationReason(reason: unknown): string {
  return COMPACTION_REASONS.has(reason as CompactionReason)
    ? `pi_compaction_${reason}`
    : 'pi_compaction';
}

export function compactionSuccessNotice(reason: unknown, tokensBefore?: unknown): string | null {
  if (reason !== 'threshold' && reason !== 'overflow') return null;
  const trigger = reason === 'threshold' ? '上下文接近上限' : '模型报告上下文溢出';
  const tokenInfo = Number.isFinite(tokensBefore) && Number(tokensBefore) > 0
    ? ` · 压缩前约 ${Math.round(Number(tokensBefore)).toLocaleString()} tokens`
    : '';
  const recovery = reason === 'overflow' ? ' · 已由引擎进入恢复重试流程' : '';
  return `自动上下文压缩完成（${trigger}）${tokenInfo}${recovery} · 原始会话记录保留`;
}

export function compactionFailureNotice(event: {
  reason?: unknown;
  errorMessage?: unknown;
  aborted?: unknown;
  willRetry?: unknown;
}): string {
  const trigger = event.reason === 'overflow'
    ? '上下文溢出恢复'
    : event.reason === 'threshold'
      ? '自动阈值压缩'
      : '手动压缩';
  const detail = typeof event.errorMessage === 'string' && event.errorMessage.trim()
    ? `：${event.errorMessage.trim().slice(0, 240)}`
    : event.aborted === true
      ? '：操作已取消'
      : '';
  const retry = event.willRetry === true ? '；引擎不会自动重试本轮' : '';
  return `${trigger}失败${detail}${retry} · 原始会话记录仍保留`;
}
