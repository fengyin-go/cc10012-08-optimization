/**
 * 聚合域统一业务标准（唯一事实来源）。
 *
 * 聚合引擎的阈值、取值范围、判定条件、精度规则、状态枚举全部集中在这里，
 * 页面展示、缓存命中判定、重算范围评估、导出/归档共用同一套标准，
 * 不允许在引擎或页面里再各写一份魔法值。
 */

/** 输出精度：小数点位数。同一业务窗口允许并存的两种历史精度。 */
export const PRECISION_SCALE = {
  TWO: 2,
  FOUR: 4,
} as const

export type PrecisionScale = (typeof PRECISION_SCALE)[keyof typeof PRECISION_SCALE]

/** 聚合方案版本：每次配置变更（时间窗口 / 输出精度 / 目标字段等）递增。 */
export const SCHEMA_VERSION = {
  V1: 'v1',
  V2: 'v2',
  V3: 'v3',
} as const

export type SchemaVersion = (typeof SCHEMA_VERSION)[keyof typeof SCHEMA_VERSION]

/** 聚合结果数据集生命周期状态。 */
export const DATASET_STATUS = {
  /** 首次计算完成的完整数据集 */
  ACTIVE: '生效中',
  /** 重算失败后保留的上一份完整数据集 */
  FALLBACK: '重算失败-沿用上一版',
  /** 被新数据集替代后的归档留痕 */
  ARCHIVED: '已归档',
} as const

export type DatasetStatus = (typeof DATASET_STATUS)[keyof typeof DATASET_STATUS]

/** 分组结果的来源判定（同一套判定条件，页面与导出都引用它）。 */
export const GROUP_ORIGIN = {
  /** 缓存键（方案版本+精度+窗口+来源指纹）全部匹配且未过期，直接复用 */
  CACHE_HIT: '缓存命中-原结果复用',
  /** 落在本次重算范围内，按分组维度重新取数计算 */
  RECOMPUTED: '重算-按分组维度重取',
  /** 不在重算范围、历史完整结果直接保留 */
  REUSED: '未受影响-原结果沿用',
} as const

export type GroupOrigin = (typeof GROUP_ORIGIN)[keyof typeof GROUP_ORIGIN]

/** 同一窗口两种精度并存时的冲突处理策略。 */
export const PRECISION_POLICY = {
  /** 两种精度都保留，按精度分层各成一组，导出按精度拆文件不拼接 */
  COEXIST: 'coexist',
  /** 全部按新请求精度统一重算，旧精度组归档留痕 */
  UNIFY: 'unify',
} as const

export type PrecisionPolicy = (typeof PRECISION_POLICY)[keyof typeof PRECISION_POLICY]

export const PRECISION_POLICY_LABEL: Record<PrecisionPolicy, string> = {
  [PRECISION_POLICY.COEXIST]: '双精度并存（按精度分层，导出拆分）',
  [PRECISION_POLICY.UNIFY]: '统一到新精度（旧精度归档留痕）',
}

/**
 * 阈值与判定条件：金额健康度判定。
 * 分组金额、页面提示、归档判定都走这一套，不允许各处自行定义阈值。
 */
export const AMOUNT_THRESHOLDS = {
  /** 分组记录数下限：低于该值视为样本不足，仅作观察不参与预警判定 */
  MIN_RECORD_COUNT: 1,
  /** 分组金额上界：超过即判定为高值组 */
  HIGH_AMOUNT: 10000,
  /** 分组金额下界：低于即判定为低值组（可能存在漏数） */
  LOW_AMOUNT: 100,
  /** 金额允许的业务取值范围（含边界），超出判定为越界数据 */
  AMOUNT_RANGE: { min: 0, max: 1_000_000 } as const,
} as const

/** 统一判定：分组金额落在哪个业务档；样本不足时仅作观察，不参与金额档判定。 */
export function judgeAmountLevel(
  amount: number,
  recordCount: number = AMOUNT_THRESHOLDS.MIN_RECORD_COUNT,
): '高值组' | '常规组' | '低值组' | '越界' | '样本不足' {
  if (recordCount < AMOUNT_THRESHOLDS.MIN_RECORD_COUNT) {
    return '样本不足'
  }
  if (!Number.isFinite(amount) || amount < AMOUNT_THRESHOLDS.AMOUNT_RANGE.min || amount > AMOUNT_THRESHOLDS.AMOUNT_RANGE.max) {
    return '越界'
  }
  if (amount > AMOUNT_THRESHOLDS.HIGH_AMOUNT) {
    return '高值组'
  }
  if (amount < AMOUNT_THRESHOLDS.LOW_AMOUNT) {
    return '低值组'
  }
  return '常规组'
}

/** 支持的聚合函数白名单（判定条件的一部分）。 */
export const SUPPORTED_FUNCTIONS = ['SUM', 'AVG', 'COUNT', 'MAX', 'MIN'] as const
export type AggregateFunction = (typeof SUPPORTED_FUNCTIONS)[number]

/**
 * 标准版本号：业务标准本身变更时递增，会随聚合结果数据集一起归档，
 * 保证历史数据集可按当时标准复核。
 */
export const STANDARD_REVISION = 'std-2026.11'

/** 标准快照：归档时冻结一份，保证复核口径一致。 */
export function standardSnapshot() {
  return {
    standardRevision: STANDARD_REVISION,
    precisionScales: [PRECISION_SCALE.TWO, PRECISION_SCALE.FOUR],
    amountThresholds: JSON.parse(JSON.stringify(AMOUNT_THRESHOLDS)) as typeof AMOUNT_THRESHOLDS,
    supportedFunctions: [...SUPPORTED_FUNCTIONS],
  }
}
