/**
 * 聚合结果数据集归档与导出。
 *
 * - 归档文件为标准 ZIP（STORE 不压缩，纯前端可复现），内含方案快照、业务标准、
 *   分组统计 CSV（按精度拆成独立文件，绝不把不同精度的组拼在一起）、留痕与清单；
 * - 导出清单与明细页字段、行数完全一致，共享同一个分组行构造器；
 * - ZIP 读写同时提供解析能力，归档文件可重新读回复核。
 */
import { GROUP_ORIGIN, PRECISION_POLICY, type PrecisionScale } from './standards'
import type { AggregateDataset, AggregateGroup, ArchiveEntry } from './types'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** DOS 时间/日期编码，供 ZIP 条目头使用。 */
function dosTime(date: Date): { time: number; date: number } {
  return {
    time: ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f),
    date: (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f),
  }
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/**
 * 生成 ZIP（STORE，method=0）字节。无第三方依赖，浏览器端直接可下载。
 */
export function buildZip(entries: ArchiveEntry[]): Uint8Array {
  const { time, date } = dosTime(new Date())
  const localChunks: Uint8Array[] = []
  const centralChunks: Uint8Array[] = []
  let offset = 0

  entries.forEach((entry) => {
    const nameBytes = utf8(entry.filename)
    const dataBytes = utf8(entry.content)
    const crc = crc32(dataBytes)

    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true) // 版本
    local.setUint16(6, 0x0800, true) // UTF-8 标志位
    local.setUint16(8, 0, true) // STORE
    local.setUint16(10, time, true)
    local.setUint16(12, date, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, dataBytes.length, true)
    local.setUint32(22, dataBytes.length, true)
    local.setUint16(26, nameBytes.length, true)
    local.setUint16(28, 0, true)
    localChunks.push(new Uint8Array(local.buffer), nameBytes, dataBytes)

    const central = new DataView(new ArrayBuffer(46))
    central.setUint32(0, 0x02014b50, true)
    central.setUint16(4, 20, true)
    central.setUint16(6, 20, true)
    central.setUint16(8, 0x0800, true)
    central.setUint16(10, 0, true)
    central.setUint16(12, time, true)
    central.setUint16(14, date, true)
    central.setUint32(16, crc, true)
    central.setUint32(20, dataBytes.length, true)
    central.setUint32(24, dataBytes.length, true)
    central.setUint16(28, nameBytes.length, true)
    central.setUint32(42, offset, true)
    centralChunks.push(new Uint8Array(central.buffer), nameBytes)

    offset += 30 + nameBytes.length + dataBytes.length
  })

  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const centralOffset = offset
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, centralSize, true)
  end.setUint32(16, centralOffset, true)

  const total = offset + centralSize + 22
  const output = new Uint8Array(total)
  let cursor = 0
  for (const chunk of [...localChunks, ...centralChunks, new Uint8Array(end.buffer)]) {
    output.set(chunk, cursor)
    cursor += chunk.length
  }
  return output
}

/** 解析 ZIP（仅需支持本模块写出的 STORE 条目），返回文件名 -> 文本内容。 */
export function parseZip(bytes: Uint8Array): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder('utf-8')
  const result: Record<string, string> = {}
  let cursor = 0
  while (cursor + 4 <= bytes.length && view.getUint32(cursor, true) === 0x04034b50) {
    const method = view.getUint16(cursor + 8, true)
    const compressedSize = view.getUint32(cursor + 18, true)
    const nameLength = view.getUint16(cursor + 26, true)
    const extraLength = view.getUint16(cursor + 28, true)
    const nameStart = cursor + 30
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength))
    const dataStart = nameStart + nameLength + extraLength
    if (method === 0) {
      result[name] = decoder.decode(bytes.subarray(dataStart, dataStart + compressedSize))
    } else {
      throw new Error(`归档内 ${name} 使用了不支持的压缩方式 ${method}`)
    }
    cursor = dataStart + compressedSize
  }
  return result
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 明细页与导出清单共用的分组行（字段、顺序、行数完全一致）。 */
export function groupToRow(group: AggregateGroup): Record<string, string | number> {
  return {
    分组取值: group.groupValue,
    时间窗口: group.window,
    输出精度: `${group.precision}位小数`,
    分组金额: group.groupAmount.toFixed(group.precision),
    记录数: group.recordCount,
    目标字段: group.targetField,
    字段取值: group.sourceValues.map((value) => value.toFixed(group.precision)).join(' | '),
    金额判定: group.amountLevel,
    来源判定: group.origin,
    缓存键: group.cacheKey,
    缓存到期: group.cacheExpireAt ? new Date(group.cacheExpireAt).toISOString() : '—',
  }
}

export const GROUP_CSV_COLUMNS = [
  '分组取值',
  '时间窗口',
  '输出精度',
  '分组金额',
  '记录数',
  '目标字段',
  '字段取值',
  '金额判定',
  '来源判定',
  '缓存键',
  '缓存到期',
]

function groupsCsv(groups: AggregateGroup[]): string {
  const lines = [GROUP_CSV_COLUMNS.join(',')]
  for (const group of groups) {
    const row = groupToRow(group)
    lines.push(GROUP_CSV_COLUMNS.map((column) => csvCell(row[column])).join(','))
  }
  return `﻿${lines.join('\n')}`
}

/** 按精度拆分分组：每个精度一个独立 CSV，禁止跨精度拼接。 */
export function splitByPrecision(groups: AggregateGroup[]): Map<PrecisionScale, AggregateGroup[]> {
  const buckets = new Map<PrecisionScale, AggregateGroup[]>()
  for (const group of groups) {
    const bucket = buckets.get(group.precision) ?? []
    bucket.push(group)
    buckets.set(group.precision, bucket)
  }
  return buckets
}

function planCsv(dataset: AggregateDataset): string {
  const plan = dataset.planSnapshot
  const rows: [string, unknown][] = [
    ['数据集编号', dataset.datasetId],
    ['方案编号', plan.code],
    ['方案版本', plan.schemaVersion],
    ['聚合函数', plan.aggregateFunction],
    ['目标字段', plan.targetField],
    ['分组维度', plan.groupDimension],
    ['时间窗口', plan.timeWindow],
    ['筛选条件', plan.filterCondition],
    ['输出精度', `${plan.precision}位小数`],
    ['缓存时间(秒)', plan.cacheTtlSeconds],
    ['来源指纹', plan.sourceFingerprint],
    ['缓存键规则', dataset.cacheKeyRule],
    ['数据集状态', dataset.status],
    ['上一版数据集', dataset.supersedes ?? '—'],
    ['生成时间', dataset.updatedAt],
  ]
  return `﻿${rows.map(([key, value]) => [csvCell(key), csvCell(value)].join(',')).join('\n')}`
}

function traceCsv(dataset: AggregateDataset): string {
  const trace = dataset.trace
  const rows: [string, unknown][] = [
    ['触发原因', trace.reason],
    ['版本变化', `${trace.fromVersion} -> ${trace.toVersion}`],
    ['重算分组数', trace.affectedGroups.length],
    ['重算范围', trace.affectedGroups.join('；') || '—'],
    ['沿用分组数', trace.unaffectedGroups.length],
    ['沿用范围', trace.unaffectedGroups.join('；') || '—'],
    ['精度依据', `${trace.basis.precision}位小数`],
    ['窗口依据', trace.basis.timeWindow],
    ['来源指纹依据', trace.basis.sourceFingerprint],
    ['缓存TTL依据(秒)', trace.basis.cacheTtlSeconds],
    ['精度冲突策略', trace.precisionPolicy === PRECISION_POLICY.COEXIST ? '双精度并存' : '统一新精度'],
    ['权衡留痕', trace.policyRationale],
    ['开始时间', trace.startedAt],
    ['结束时间', trace.finishedAt],
    ['是否成功', trace.success ? '成功' : `失败：${trace.errorMessage ?? ''}`],
  ]
  return `﻿${rows.map(([key, value]) => [csvCell(key), csvCell(value)].join(',')).join('\n')}`
}

function manifestCsv(dataset: AggregateDataset, precisionFiles: string[]): string {
  const lines = ['文件,说明,行数/条目数']
  lines.push(`plan-snapshot.csv,聚合方案与缓存键规则,15`)
  lines.push(`standard-snapshot.json,统一业务标准（阈值/范围/判定条件）,1`)
  lines.push(`recompute-trace.csv,重算范围与精度冲突留痕,15`)
  for (const filename of precisionFiles) {
    const precision = /precision-(\d+)/.exec(filename)?.[1] ?? ''
    const count = dataset.groups.filter((group) => String(group.precision) === precision).length
    lines.push(`${filename},${precision}位小数分组统计（独立精度不拼接）,${count}`)
  }
  lines.push(`dataset.json,聚合结果数据集完整快照,1`)
  return `﻿${lines.join('\n')}`
}

/** 构造归档 ZIP 的全部条目。 */
export function buildArchiveEntries(dataset: AggregateDataset): ArchiveEntry[] {
  const root = `${dataset.planCode}_${dataset.datasetId}`
  const entries: ArchiveEntry[] = [
    { filename: `${root}/plan-snapshot.csv`, content: planCsv(dataset) },
    { filename: `${root}/standard-snapshot.json`, content: JSON.stringify(dataset.standardSnapshot, null, 2) },
    { filename: `${root}/recompute-trace.csv`, content: traceCsv(dataset) },
  ]
  const precisionFiles: string[] = []
  for (const [precision, groups] of splitByPrecision(dataset.groups)) {
    const filename = `${root}/groups-precision-${precision}.csv`
    precisionFiles.push(filename)
    entries.push({ filename, content: groupsCsv(groups) })
  }
  entries.push({ filename: `${root}/manifest.csv`, content: manifestCsv(dataset, precisionFiles) })
  entries.push({ filename: `${root}/dataset.json`, content: JSON.stringify(dataset, null, 2) })
  return entries
}

/** 归档文件名。 */
export function archiveFilename(dataset: AggregateDataset): string {
  return `${dataset.planCode}_${dataset.datasetId}.zip`
}

/** 导出清单文件名（单精度时与明细一致；多精度时返回多个，各导各的）。 */
export function exportFilenames(dataset: AggregateDataset): string[] {
  return [...splitByPrecision(dataset.groups).keys()].map(
    (precision) => `${dataset.planCode}-聚合结果清单-${precision}位小数.csv`,
  )
}

/** 单精度导出 CSV 内容；多精度场景按返回数组逐个下载，杜绝拼接。 */
export function exportCsvContents(dataset: AggregateDataset): { filename: string; content: string }[] {
  return [...splitByPrecision(dataset.groups).entries()].map(([precision, groups]) => ({
    filename: `${dataset.planCode}-聚合结果清单-${precision}位小数.csv`,
    content: groupsCsv(groups),
  }))
}

/** 页面统计口径：来源判定分布（复用同一枚举，避免页面自创说法）。 */
export function originSummary(dataset: AggregateDataset): { label: string; count: number }[] {
  return [
    { label: GROUP_ORIGIN.RECOMPUTED, count: dataset.groups.filter((g) => g.origin === GROUP_ORIGIN.RECOMPUTED).length },
    { label: GROUP_ORIGIN.CACHE_HIT, count: dataset.groups.filter((g) => g.origin === GROUP_ORIGIN.CACHE_HIT).length },
    { label: GROUP_ORIGIN.REUSED, count: dataset.groups.filter((g) => g.origin === GROUP_ORIGIN.REUSED).length },
  ]
}
