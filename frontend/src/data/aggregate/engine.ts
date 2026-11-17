/**
 * 聚合引擎：聚合结果数据集的复用与重算都在这里完成。
 *
 * 核心规则：
 * 1. 缓存键 = 方案编号 + 方案版本 + 精度 + 时间窗口 + 来源指纹 + 分组值 + 标准版本，
 *    任一变化（含方案版本更新、缓存到期）都会让旧精度结果无法继续命中。
 * 2. 按「分组维度」逐组判定重算范围，只重算受影响分组；其他窗口/分组沿用原结果。
 * 3. 任一分组重算失败即整体判定失败：不提交半成品，保留上一份完整数据集。
 * 4. 同窗口两种精度并存时按策略处理，全程留痕；导出侧按精度拆分，绝不拼接。
 */
import {
  DATASET_STATUS,
  GROUP_ORIGIN,
  PRECISION_POLICY,
  PRECISION_SCALE,
  SCHEMA_VERSION,
  STANDARD_REVISION,
  judgeAmountLevel,
  standardSnapshot,
  type GroupOrigin,
  type PrecisionPolicy,
  type PrecisionScale,
  type SchemaVersion,
} from './standards'
import { DEMO_GROUPS, DEMO_WINDOWS, fnv1a, loadSourceRecords, sourceFingerprint } from './source-data'
import type {
  AggregateDataset,
  AggregateGroup,
  AggregatePlan,
  RecomputeTrace,
  SourceRecord,
} from './types'

export type RunOptions = {
  /** 当前时间戳（毫秒），缓存是否到期按它判定，测试可注入 */
  now: number
  /** 上一份完整数据集（首次运行为 null） */
  previous: AggregateDataset | null
  /** 触发原因，写入留痕 */
  reason: string
  /** 同窗口两种精度并存时的处理策略 */
  precisionPolicy: PrecisionPolicy
  /** 注入失败：指定分组重算时抛错，用于验证「失败保留上一份完整数据集」 */
  failGroup?: string | null
}

export type RunOutcome =
  | { ok: true; dataset: AggregateDataset; reusedGroupCount: number; recomputedGroupCount: number }
  | { ok: false; message: string; trace: RecomputeTrace; previous: AggregateDataset | null }

/** 构造分组级缓存键：页面展示与命中判定共用同一规则。 */
export function buildCacheKey(plan: AggregatePlan, groupValue: string, window: string): string {
  const material = [
    plan.code,
    plan.schemaVersion,
    `p${plan.precision}`,
    `w${window}`,
    plan.sourceFingerprint,
    `g${groupValue}`,
    STANDARD_REVISION,
  ].join('|')
  return `aggr:${fnv1a(material)}`
}

/** 数据集级缓存键规则（人类可读，随数据集归档，页面可核对）。 */
export function buildCacheKeyRule(plan: AggregatePlan): string {
  return [
    '方案编号',
    '方案版本',
    '输出精度',
    '时间窗口',
    '来源指纹',
    '分组取值',
    '业务标准版本',
  ].join(' + ') + ` → hash（TTL=${plan.cacheTtlSeconds}秒）`
}

/** 缓存是否仍有效：版本/指纹/精度/窗口任一不一致或已到期都不得命中。 */
export function isCacheFresh(group: AggregateGroup, plan: AggregatePlan, now: number): boolean {
  if (group.precision !== plan.precision) {
    return false
  }
  if (group.cacheExpireAt === null || group.cacheExpireAt <= now) {
    return false
  }
  const expectedKey = buildCacheKey(plan, group.groupValue, group.window)
  return group.cacheKey === expectedKey
}

/** 方案配置指纹：用于判断配置是否发生变化并推动方案版本。 */
export function planConfigSignature(plan: Omit<AggregatePlan, 'schemaVersion' | 'sourceFingerprint'>): string {
  return fnv1a(
    [
      plan.code,
      plan.aggregateFunction,
      plan.targetField,
      plan.groupDimension,
      plan.timeWindow,
      plan.filterCondition,
      plan.precision,
      plan.cacheTtlSeconds,
    ].join('|'),
  )
}

export function nextSchemaVersion(current: SchemaVersion): SchemaVersion {
  if (current === SCHEMA_VERSION.V1) {
    return SCHEMA_VERSION.V2
  }
  if (current === SCHEMA_VERSION.V2) {
    return SCHEMA_VERSION.V3
  }
  const matched = /^v3\.(\d+)$/.exec(current)
  return matched ? (`v3.${Number(matched[1]) + 1}` as SchemaVersion) : ('v3.1' as SchemaVersion)
}

function roundAmount(value: number, precision: PrecisionScale): number {
  const factor = 10 ** precision
  return Math.round((value + Number.EPSILON) * factor) / factor
}

function aggregateValues(values: number[], fn: string): number {
  if (values.length === 0) {
    return 0
  }
  switch (fn) {
    case 'AVG':
      return values.reduce((sum, value) => sum + value, 0) / values.length
    case 'COUNT':
      return values.length
    case 'MAX':
      return Math.max(...values)
    case 'MIN':
      return Math.min(...values)
    case 'SUM':
    default:
      return values.reduce((sum, value) => sum + value, 0)
  }
}

export function groupKey(groupValue: string, window: string, precision: PrecisionScale): string {
  return `${window}__${groupValue}__p${precision}`
}

/**
 * 重算范围评估（按分组维度逐组给出）：
 * - 时间窗口变化：仅新旧两个窗口的分组受影响，其他窗口继续使用原结果（AGGR-0003 场景）；
 * - 输出精度变化：coexist 下仅当前窗口分组按新精度重算，其他窗口保留历史精度；
 *   unify 下全部分组统一按新精度重算，旧精度组归档留痕；
 * - 目标字段/筛选/聚合函数/来源指纹变化，或缓存到期（含与版本更新同时发生）：
 *   缓存键整体失效，全部分组重算，旧精度结果不能继续命中。
 * 方案版本号本身不单独触发全量：版本更新必然伴随语义变更，范围以语义 diff 为准，
 * 这样只改窗口时其他窗口才能继续沿用原结果。
 */
export function evaluateScope(
  previous: AggregateDataset | null,
  plan: AggregatePlan,
  reason: string,
  precisionPolicy: PrecisionPolicy,
): { affected: Set<string>; allAffected: boolean } {
  if (!previous) {
    return { affected: new Set(), allAffected: true }
  }
  const prevPlan = previous.planSnapshot
  const windowChanged = prevPlan.timeWindow !== plan.timeWindow
  const precisionChanged = prevPlan.precision !== plan.precision
  const sourceChanged = prevPlan.sourceFingerprint !== plan.sourceFingerprint
  const semanticChanged =
    prevPlan.targetField !== plan.targetField ||
    prevPlan.filterCondition !== plan.filterCondition ||
    prevPlan.aggregateFunction !== plan.aggregateFunction

  if (reason.includes('缓存到期') || sourceChanged || semanticChanged) {
    return { affected: new Set(), allAffected: true }
  }
  if (precisionChanged) {
    if (precisionPolicy === PRECISION_POLICY.UNIFY) {
      return { affected: new Set(), allAffected: true }
    }
    const affected = new Set<string>()
    for (const group of previous.groups) {
      if (group.window === plan.timeWindow) {
        affected.add(groupKey(group.groupValue, group.window, group.precision))
      }
    }
    return { affected, allAffected: false }
  }
  if (windowChanged) {
    const affected = new Set<string>()
    for (const group of previous.groups) {
      if (group.window === prevPlan.timeWindow || group.window === plan.timeWindow) {
        affected.add(groupKey(group.groupValue, group.window, group.precision))
      }
    }
    return { affected, allAffected: false }
  }
  return { affected: new Set(), allAffected: true }
}

/** 读取目标字段后形成单个分组统计（取数链路的聚合更新点）。 */
export function computeGroup(
  plan: AggregatePlan,
  records: SourceRecord[],
  groupValue: string,
  window: string,
  now: number,
  origin: GroupOrigin,
  failGroup?: string | null,
): AggregateGroup {
  if (failGroup && groupValue === failGroup) {
    throw new Error(`分组「${groupValue}」取数失败：目标字段 ${plan.targetField} 读取超时`)
  }
  const targetValues = records
    .filter((record) => record.group === groupValue && record.window === window)
    .map((record) => record.amount)
  const rawAmount = aggregateValues(targetValues, plan.aggregateFunction)
  const groupAmount = roundAmount(rawAmount, plan.precision)
  const cacheKey = buildCacheKey(plan, groupValue, window)
  return {
    groupValue,
    window,
    precision: plan.precision,
    groupAmount,
    recordCount: targetValues.length,
    targetField: plan.targetField,
    sourceValues: targetValues,
    amountLevel: judgeAmountLevel(groupAmount, targetValues.length),
    origin,
    cacheKey,
    cacheExpireAt: origin === GROUP_ORIGIN.CACHE_HIT ? null : now + plan.cacheTtlSeconds * 1000,
  }
}

/**
 * 执行聚合：返回完整新数据集或失败结果。
 * 失败时调用方必须沿用上一份数据集，本函数不会产出半组数据。
 * 数据集覆盖取数链路中的全部「窗口 × 分组」，当前方案窗口下的分组按新精度产出，
 * 其余窗口分组在不受影响时直接沿用。
 */
export function runAggregation(plan: AggregatePlan, options: RunOptions): RunOutcome {
  const { now, previous, reason, precisionPolicy } = options
  const startedAt = new Date(now).toISOString()
  const scope = evaluateScope(previous, plan, reason, precisionPolicy)
  const sourceRecords = loadSourceRecords(plan.code)
  const fingerprint = sourceFingerprint(sourceRecords)
  const planWithFingerprint: AggregatePlan = { ...plan, sourceFingerprint: fingerprint }

  const previousByKey = new Map<string, AggregateGroup>()
  previous?.groups.forEach((group) => {
    previousByKey.set(groupKey(group.groupValue, group.window, group.precision), group)
  })

  // 分组宇宙：全部窗口 × 全部分组维度取值，保证数据集始终完整。
  const universe = DEMO_WINDOWS.flatMap((window) =>
    DEMO_GROUPS.map((groupValue) => ({ window, groupValue })),
  )

  const affectedGroupLabels: string[] = []
  const unaffectedGroupLabels: string[] = []
  const precisionConflicts: string[] = []
  const nextGroups: AggregateGroup[] = []

  try {
    for (const { window, groupValue } of universe) {
      const isCurrentWindow = window === planWithFingerprint.timeWindow
      const key = groupKey(groupValue, window, planWithFingerprint.precision)
      const oldGroup = previousByKey.get(key)

      // 同窗口存在另一种精度的历史结果：记录冲突并留痕，两种精度都能表达业务值。
      const otherPrecisionGroup = previous?.groups.find(
        (group) =>
          group.window === window &&
          group.groupValue === groupValue &&
          group.precision !== planWithFingerprint.precision,
      )
      if (otherPrecisionGroup) {
        precisionConflicts.push(
          `${groupValue}@${window}: 历史${otherPrecisionGroup.precision}位小数 vs 新请求${planWithFingerprint.precision}位小数`,
        )
      }

      // 非当前方案窗口：只在历史结果完整且不在重算范围内时沿用，缺失则按当前精度补齐。
      if (!isCurrentWindow) {
        if (!scope.allAffected && oldGroup && !scope.affected.has(key)) {
          if (isCacheFresh(oldGroup, planWithFingerprint, now)) {
            nextGroups.push({ ...oldGroup, origin: GROUP_ORIGIN.CACHE_HIT })
          } else {
            nextGroups.push({ ...oldGroup, origin: GROUP_ORIGIN.REUSED })
          }
          unaffectedGroupLabels.push(key)
          continue
        }
      }

      // 当前窗口：全量重算/落在受影响范围/缓存键不一致或到期，均不得命中旧缓存。
      if (!scope.allAffected && oldGroup && !scope.affected.has(key) && isCacheFresh(oldGroup, planWithFingerprint, now)) {
        nextGroups.push({ ...oldGroup, origin: GROUP_ORIGIN.CACHE_HIT })
        unaffectedGroupLabels.push(key)
        continue
      }

      affectedGroupLabels.push(key)
      nextGroups.push(
        computeGroup(
          planWithFingerprint,
          sourceRecords,
          groupValue,
          window,
          now,
          GROUP_ORIGIN.RECOMPUTED,
          options.failGroup ?? null,
        ),
      )
    }

    // coexist：把上一份数据集中未被新精度覆盖的旧精度分组保留下来（标注沿用），
    // 使同一窗口的两位/四位小数结果都能复核；unify：旧精度分组不进入新数据集，仅归档留痕。
    if (previous && precisionPolicy === PRECISION_POLICY.COEXIST) {
      for (const group of previous.groups) {
        const already = nextGroups.some(
          (item) =>
            item.groupValue === group.groupValue &&
            item.window === group.window &&
            item.precision === group.precision,
        )
        if (!already) {
          nextGroups.push({ ...group, origin: GROUP_ORIGIN.REUSED })
          unaffectedGroupLabels.push(groupKey(group.groupValue, group.window, group.precision))
        }
      }
    }

    if (nextGroups.length === 0) {
      throw new Error('取数链路未返回任何分组，拒绝产出空数据集')
    }

    const finishedAt = new Date(now + 1).toISOString()
    const trace: RecomputeTrace = {
      reason,
      fromVersion: previous?.schemaVersion ?? planWithFingerprint.schemaVersion,
      toVersion: planWithFingerprint.schemaVersion,
      affectedGroups: affectedGroupLabels,
      unaffectedGroups: unaffectedGroupLabels,
      basis: {
        precision: planWithFingerprint.precision,
        timeWindow: planWithFingerprint.timeWindow,
        sourceFingerprint: fingerprint,
        cacheTtlSeconds: planWithFingerprint.cacheTtlSeconds,
      },
      precisionPolicy,
      policyRationale: buildPolicyRationale(precisionPolicy, precisionConflicts),
      startedAt,
      finishedAt,
      success: true,
    }

    const sequence = previous ? datasetSequence(previous.datasetId) + 1 : 1
    const dataset: AggregateDataset = {
      datasetId: `AGDS-${planWithFingerprint.code}-${String(sequence).padStart(4, '0')}`,
      planCode: planWithFingerprint.code,
      rowId: planWithFingerprint.rowId,
      status: DATASET_STATUS.ACTIVE,
      schemaVersion: planWithFingerprint.schemaVersion,
      cacheKeyRule: buildCacheKeyRule(planWithFingerprint),
      groups: nextGroups,
      trace,
      planSnapshot: planWithFingerprint,
      standardSnapshot: standardSnapshot(),
      supersedes: previous?.datasetId ?? null,
      createdAt: previous?.createdAt ?? finishedAt,
      updatedAt: finishedAt,
    }
    return {
      ok: true,
      dataset,
      reusedGroupCount: nextGroups.filter(
        (group) => group.origin !== GROUP_ORIGIN.RECOMPUTED,
      ).length,
      recomputedGroupCount: nextGroups.filter(
        (group) => group.origin === GROUP_ORIGIN.RECOMPUTED,
      ).length,
    }
  } catch (error) {
    const finishedAt = new Date(now + 1).toISOString()
    const trace: RecomputeTrace = {
      reason,
      fromVersion: previous?.schemaVersion ?? planWithFingerprint.schemaVersion,
      toVersion: planWithFingerprint.schemaVersion,
      affectedGroups: affectedGroupLabels,
      unaffectedGroups: unaffectedGroupLabels,
      basis: {
        precision: planWithFingerprint.precision,
        timeWindow: planWithFingerprint.timeWindow,
        sourceFingerprint: fingerprint,
        cacheTtlSeconds: planWithFingerprint.cacheTtlSeconds,
      },
      precisionPolicy,
      policyRationale: buildPolicyRationale(precisionPolicy, precisionConflicts),
      startedAt,
      finishedAt,
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    }
    return {
      ok: false,
      message: error instanceof Error ? error.message : '聚合重算失败',
      trace,
      previous,
    }
  }
}

function buildPolicyRationale(policy: PrecisionPolicy, conflicts: string[]): string {
  if (conflicts.length === 0) {
    return '本次无精度冲突；默认保留各精度分组的精度依据，导出按精度拆分。'
  }
  if (policy === PRECISION_POLICY.COEXIST) {
    return [
      '权衡：两种精度都能表达业务值，选择双精度并存，避免重算覆盖历史口径；',
      `冲突分组：${conflicts.join('；')}；`,
      '处理：各分组保留精度依据与重算范围，导出按精度拆分为独立文件，禁止跨精度拼接。',
    ].join('')
  }
  return [
    '权衡：统一口径便于跨组对比，选择全部按新请求精度重算；',
    `冲突分组：${conflicts.join('；')}；`,
    '处理：旧精度分组随上一份数据集整体归档留痕，新数据集只保留新精度分组。',
  ].join('')
}

function datasetSequence(datasetId: string): number {
  const matched = /-(\d{4})$/.exec(datasetId)
  return matched ? Number(matched[1]) : 0
}
