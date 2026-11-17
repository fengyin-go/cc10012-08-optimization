/**
 * 聚合编排服务：沿着取数链路更新聚合结果数据集的唯一入口。
 *
 * 取数链路：页面动作 -> local-service -> aggregate-service
 *   -> engine.runAggregation（读取 source-data 目标字段）
 *   -> aggregate-store 原子提交（旧数据集归档，失败保留上一份）。
 *
 * 提交语义：每次成功重算只写入一份新的生效数据集，旧数据集整体移入归档；
 * 重算失败时生效数据集保持不变，下游任何时刻读到的都是完整一组。
 */
import {
  DATASET_STATUS,
  PRECISION_POLICY,
  type PrecisionPolicy,
  type SchemaVersion,
} from './standards'
import {
  nextSchemaVersion,
  planConfigSignature,
  runAggregation,
  type RunOutcome,
} from './engine'
import { planFromRow } from './source-data'
import {
  aggregateState,
  getConfigSignature,
  getPolicy,
  persistAggregateState,
  setConfigSignature,
  setPolicy,
} from './aggregate-store'
import type { AggregateDataset, AggregatePlan } from './types'

export type RerunResult =
  | {
      ok: true
      dataset: AggregateDataset
      reason: string
      reusedGroupCount: number
      recomputedGroupCount: number
      versionChanged: boolean
    }
  | {
      ok: false
      message: string
      reason: string
      /** 失败后仍在生效的上一份完整数据集 */
      retained: AggregateDataset | null
    }

export type RerunHooks = {
  now?: number
  reason?: string
  failGroup?: string | null
}

/** 从 aggregate 条目行构造完整方案（含版本与来源指纹，指纹由引擎取数后回填）。 */
export function buildPlan(row: {
  id: number
  [field: string]: string | number | boolean
}): AggregatePlan {
  const base = planFromRow(row)
  const previous = aggregateState().datasets[base.code] ?? null
  const schemaVersion: SchemaVersion = previous
    ? previous.schemaVersion
    : ('v1' as SchemaVersion)
  return {
    ...base,
    schemaVersion,
    sourceFingerprint: previous?.planSnapshot.sourceFingerprint ?? '',
  }
}

/**
 * 执行（或重算）一个方案的聚合结果数据集。
 * 配置相对上一版发生变化时先推动方案版本，保证旧缓存键不可能命中新结果。
 */
export function rerunPlan(
  row: { id: number; [field: string]: string | number | boolean },
  hooks: RerunHooks = {},
): RerunResult {
  const now = hooks.now ?? Date.now()
  const plan = buildPlan(row)
  const state = aggregateState()
  const previous = state.datasets[plan.code] ?? null
  const signature = planConfigSignature(plan)
  const lastSignature = getConfigSignature(plan.code)
  const versionChanged = previous !== null && lastSignature !== undefined && lastSignature !== signature

  if (versionChanged) {
    plan.schemaVersion = nextSchemaVersion(previous!.schemaVersion)
  }

  const baseReason =
    previous === null ? '首次计算' : versionChanged ? '方案配置变更触发版本更新' : '手动重算'
  // 外部显式原因（如缓存到期）与内部原因叠加保留，留痕里两种事实都可见。
  const reason = hooks.reason
    ? versionChanged
      ? `${hooks.reason}；同时${baseReason}`
      : hooks.reason
    : baseReason
  const outcome: RunOutcome = runAggregation(plan, {
    now,
    previous,
    reason,
    precisionPolicy: getPolicy(plan.code),
    failGroup: hooks.failGroup ?? null,
  })

  if (!outcome.ok) {
    // 失败留痕：生效数据集一行不动，确保下游不会看到半组数据。
    persistAggregateState({
      ...aggregateState(),
      failures: {
        ...aggregateState().failures,
        [plan.code]: { message: outcome.message, at: new Date(now).toISOString(), trace: outcome.trace },
      },
    })
    return { ok: false, message: outcome.message, reason, retained: outcome.previous }
  }

  const nextState = aggregateState()
  const archives = { ...nextState.archives }
  if (previous) {
    const archived: AggregateDataset = {
      ...previous,
      status: DATASET_STATUS.ARCHIVED,
    }
    archives[plan.code] = [...(archives[plan.code] ?? []), archived]
  }
  // 原子提交：一次性写入新的完整数据集 + 归档 + 清理失败标记 + 记录配置指纹。
  const failures = { ...nextState.failures }
  delete failures[plan.code]
  persistAggregateState({
    ...nextState,
    datasets: { ...nextState.datasets, [plan.code]: outcome.dataset },
    archives,
    failures,
  })
  setConfigSignature(plan.code, signature)

  return {
    ok: true,
    dataset: outcome.dataset,
    reason,
    reusedGroupCount: outcome.reusedGroupCount,
    recomputedGroupCount: outcome.recomputedGroupCount,
    versionChanged,
  }
}

/**
 * 模拟「缓存时间到期」并立即重算。
 * 若到期同时方案版本也已更新，引擎按缓存键整体失效处理，旧精度结果不能继续命中。
 */
export function expireCacheAndRerun(
  row: { id: number; [field: string]: string | number | boolean },
  hooks: RerunHooks = {},
): RerunResult {
  return rerunPlan(row, { ...hooks, reason: hooks.reason ?? '缓存时间到期触发重算' })
}
/** 切换精度冲突策略并留痕（不立即重算，下一次重算按新策略权衡）。 */
export function changePrecisionPolicy(planCode: string, policy: PrecisionPolicy): void {
  setPolicy(planCode, policy)
}

export function activeDataset(planCode: string): AggregateDataset | null {
  return aggregateState().datasets[planCode] ?? null
}

export function allDatasets(): AggregateDataset[] {
  return Object.values(aggregateState().datasets).sort((a, b) => a.planCode.localeCompare(b.planCode))
}

export function archivedDatasets(planCode: string): AggregateDataset[] {
  return aggregateState().archives[planCode] ?? []
}

export function latestFailure(planCode: string) {
  return aggregateState().failures[planCode] ?? null
}

/** 把生效数据集标记为「重算失败沿用上一版」（失败发生后页面状态展示用）。 */
export function markFallbackAfterFailure(planCode: string): AggregateDataset | null {
  const state = aggregateState()
  const current = state.datasets[planCode]
  if (!current || !state.failures[planCode]) {
    return current ?? null
  }
  const updated: AggregateDataset = { ...current, status: DATASET_STATUS.FALLBACK }
  persistAggregateState({
    ...state,
    datasets: { ...state.datasets, [planCode]: updated },
  })
  return updated
}

export { PRECISION_POLICY }
