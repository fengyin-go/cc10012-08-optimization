/**
 * 聚合域类型：聚合方案（配置）、聚合结果数据集（产出）、分组统计、重算留痕。
 *
 * 关键约束：
 * - 一个方案任意时刻只保留一份「生效中」的聚合结果数据集（原子提交）；
 * - 分组统计按「分组维度 + 精度」唯一，禁止把不同精度的组拼在同一份导出里；
 * - 每次重算的范围、依据、冲突处理都要在数据集里留痕，返回页面仍可复核。
 */
import type {
  DatasetStatus,
  GroupOrigin,
  PrecisionPolicy,
  PrecisionScale,
  SchemaVersion,
} from './standards'

/** 取数链路中的一条源记录（分组统计读取目标字段后的原始取值）。 */
export type SourceRecord = {
  id: number
  /** 分组维度取值，例如 区域=华东 */
  group: string
  /** 目标字段原始数值（未按精度处理） */
  amount: number
  /** 业务时间窗口标签，例如 10分钟/30分钟 */
  window: string
}

/** 聚合方案配置：由聚合计算页面的方案行 + 可编辑的执行参数构成。 */
export type AggregatePlan = {
  /** 对应 aggregate 模块行 id */
  rowId: number
  /** 方案编号，例如 AGGR-0003 */
  code: string
  aggregateFunction: string
  /** 目标字段：分组统计读取的字段名 */
  targetField: string
  /** 分组维度（按它逐组重算） */
  groupDimension: string
  /** 时间窗口，例如 10分钟 */
  timeWindow: string
  /** 筛选条件原文 */
  filterCondition: string
  /** 输出精度（小数位） */
  precision: PrecisionScale
  /** 缓存时间（秒）；到期后旧精度结果不得继续命中 */
  cacheTtlSeconds: number
  /** 方案版本：任何配置变更都会推新版本 */
  schemaVersion: SchemaVersion
  /** 取数来源指纹：来源数据变化时指纹变化，缓存键随之变化 */
  sourceFingerprint: string
  status: string
}

/** 单个分组的统计结果。 */
export type AggregateGroup = {
  /** 分组维度取值 */
  groupValue: string
  /** 时间窗口 */
  window: string
  /** 输出精度（小数位），每组自带精度依据 */
  precision: PrecisionScale
  /** 聚合后的分组金额，已按 precision 保留小数 */
  groupAmount: number
  /** 参与聚合的源记录数（与精度一致地可核对） */
  recordCount: number
  /** 目标字段名与取值样本，供页面「字段与取值可检查」 */
  targetField: string
  sourceValues: number[]
  /** 统一业务标准下的金额判定 */
  amountLevel: string
  /** 该组本次结果的来源判定 */
  origin: GroupOrigin
  /** 计算时使用的缓存键片段，便于页面核对缓存键 */
  cacheKey: string
  /** 命中缓存时的缓存到期时间戳（毫秒），未命中为空 */
  cacheExpireAt: number | null
}

/** 重算范围评估与执行留痕。 */
export type RecomputeTrace = {
  /** 触发原因，例如 时间窗口变更 / 输出精度变更 / 缓存到期 / 方案版本更新 */
  reason: string
  /** 变更前方案版本 */
  fromVersion: SchemaVersion
  /** 变更后方案版本 */
  toVersion: SchemaVersion
  /** 受影响、需要按分组维度重算的分组 */
  affectedGroups: string[]
  /** 不受影响、继续沿用原结果的分组/窗口 */
  unaffectedGroups: string[]
  /** 重算依据：精度依据、窗口依据、来源指纹 */
  basis: {
    precision: PrecisionScale
    timeWindow: string
    sourceFingerprint: string
    cacheTtlSeconds: number
  }
  /** 精度冲突处理策略（同窗口两种精度并存时） */
  precisionPolicy: PrecisionPolicy
  /** 冲突处理的权衡说明，留痕用 */
  policyRationale: string
  /** 重算开始/结束时间 */
  startedAt: string
  finishedAt: string
  /** 是否成功；失败时不提交半成品，沿用上一份完整数据集 */
  success: boolean
  /** 失败原因（如有） */
  errorMessage?: string
}

/**
 * 聚合结果数据集：一次提交只写入一份。
 * 同一方案的历史数据集以归档形式保留在数据集自身的 archive 里，存储层始终只有一份生效数据集。
 */
export type AggregateDataset = {
  /** 数据集编号，例如 AGDS-AGGR-0003-0002 */
  datasetId: string
  /** 所属方案编号 */
  planCode: string
  /** 所属方案行 id */
  rowId: number
  status: DatasetStatus
  /** 产出时的方案版本 */
  schemaVersion: SchemaVersion
  /** 完整缓存键规则（页面可核对） */
  cacheKeyRule: string
  /** 分组统计结果（完整一组，失败不会出现半组） */
  groups: AggregateGroup[]
  /** 本次产出的重算留痕 */
  trace: RecomputeTrace
  /** 随结果归档的聚合方案快照 */
  planSnapshot: AggregatePlan
  /** 随结果归档的业务标准快照 */
  standardSnapshot: ReturnType<typeof import('./standards').standardSnapshot>
  /** 上一份数据集编号（重算失败沿用时指向它） */
  supersedes: string | null
  createdAt: string
  updatedAt: string
}

/** 存储在 localStorage 里的聚合域状态。 */
export type AggregateStoreState = {
  /** 方案编号 -> 唯一生效数据集 */
  datasets: Record<string, AggregateDataset>
  /** 数据集编号 -> 历史归档（每次成功重算后把旧数据集移入，保证页面可复核） */
  archives: Record<string, AggregateDataset[]>
  /** 方案编号 -> 最近一次失败信息（旧数据集保留，错误单独留痕） */
  failures: Record<string, { message: string; at: string; trace: RecomputeTrace }>
  /** 方案编号 -> 精度冲突处理策略，默认双精度并存 */
  policies: Record<string, PrecisionPolicy>
  /** 方案编号 -> 最近一次已应用配置的指纹，用于识别配置是否变化并推动方案版本 */
  configSignatures: Record<string, string>
}

/** 归档文件（zip）内单个条目的描述。 */
export type ArchiveEntry = {
  filename: string
  content: string
}
