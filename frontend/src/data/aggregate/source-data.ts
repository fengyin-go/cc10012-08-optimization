/**
 * 取数链路：分组统计从这里读取目标字段的原始取值。
 *
 * 纯前端离线版没有真实数仓，用确定性的示例源记录模拟取数结果，
 * 但链路结构与真实环境一致：loadSourceRecords -> 来源指纹 -> 聚合引擎读取目标字段。
 * 来源指纹参与缓存键，源数据一变指纹就变，旧缓存不可能继续命中。
 */
import type { AggregatePlan, SourceRecord } from './types'
import { PRECISION_SCALE } from './standards'

/** 示例取数覆盖的窗口与分组：用于演示「只改窗口时其他窗口沿用原结果」。 */
export const DEMO_WINDOWS = ['10分钟', '30分钟', '60分钟'] as const
export const DEMO_GROUPS = ['华东', '华北', '华南', '西南'] as const

/** 方案默认执行参数：种子行里是占位文本，由这里归一化成可计算的业务值。 */
export const PLAN_DEFAULTS = {
  aggregateFunction: 'SUM',
  targetField: '交易金额',
  groupDimension: '区域',
  timeWindow: '10分钟',
  filterCondition: '交易状态=成功',
  precision: PRECISION_SCALE.TWO,
  cacheTtlSeconds: 600,
} as const

/**
 * 确定性取数：同一方案任意时刻取到的源记录一致，保证重算结果可复核。
 * 金额按编号线性生成，并刻意拉开档位，覆盖统一标准里的高值/常规/低值判定。
 */
export function loadSourceRecords(planCode: string): SourceRecord[] {
  const seed = hashSeed(planCode)
  const records: SourceRecord[] = []
  let id = 1
  DEMO_WINDOWS.forEach((window, w) => {
    DEMO_GROUPS.forEach((group, g) => {
      const count = 3 + ((seed + g + w) % 3)
      for (let i = 0; i < count; i += 1) {
        const base = (seed * 17 + g * 131 + w * 53 + i * 29) % 1200
        const amount = Number((base + 35 + g * 12 + w * 210).toFixed(4))
        records.push({ id: id++, group, amount, window })
      }
    })
  })
  return records
}

/** FNV-1a 字符串哈希：生成稳定的 32 位来源指纹/方案种子。 */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function hashSeed(input: string): number {
  return parseInt(fnv1a(input), 16)
}

/** 来源指纹：源记录任何取值变化都会改变指纹，进而改变缓存键。 */
export function sourceFingerprint(records: SourceRecord[]): string {
  const material = records
    .map((record) => `${record.id}:${record.group}:${record.window}:${record.amount}`)
    .join('|')
  return `fp-${fnv1a(material)}`
}

/**
 * 从聚合模块的 EntryRow 归一化出聚合方案。
 * 页面编辑后写入的是标准业务值；种子占位文本则回落到 PLAN_DEFAULTS。
 */
export function planFromRow(row: {
  id: number
  [field: string]: string | number | boolean
}): Omit<AggregatePlan, 'schemaVersion' | 'sourceFingerprint'> {
  const code = String(row['方案编号'] ?? `AGGR-${row.id}`)
  const records = loadSourceRecords(code)
  const precision = parsePrecision(row['输出精度'])
  const ttl = parseTtl(row['缓存时间'])
  const windowText = String(row['时间窗口'] ?? '')
  const timeWindow = /\d+\s*分钟/.test(windowText) ? windowText.replace(/\s/g, '') : PLAN_DEFAULTS.timeWindow
  return {
    rowId: Number(row.id),
    code,
    aggregateFunction: normalizeText(row['聚合函数'], PLAN_DEFAULTS.aggregateFunction),
    targetField: normalizeText(row['目标字段'], PLAN_DEFAULTS.targetField),
    groupDimension: normalizeText(row['分组维度'], PLAN_DEFAULTS.groupDimension),
    timeWindow,
    filterCondition: normalizeText(row['筛选条件'], PLAN_DEFAULTS.filterCondition),
    precision,
    cacheTtlSeconds: ttl,
    status: String(row.status ?? '草稿'),
  }
}

function normalizeText(value: unknown, fallback: string): string {
  const text = String(value ?? '').trim()
  if (!text || text.includes('样例')) {
    return fallback
  }
  return text
}

function parsePrecision(value: unknown): 2 | 4 {
  const text = String(value ?? '')
  if (text.includes('4')) {
    return PRECISION_SCALE.FOUR
  }
  if (text.includes('2')) {
    return PRECISION_SCALE.TWO
  }
  return PRECISION_SCALE.TWO
}

function parseTtl(value: unknown): number {
  const matched = String(value ?? '').match(/\d+/)
  if (!matched) {
    return PLAN_DEFAULTS.cacheTtlSeconds
  }
  const parsed = Number(matched[0])
  return Number.isFinite(parsed) && parsed > 0 ? parsed : PLAN_DEFAULTS.cacheTtlSeconds
}
