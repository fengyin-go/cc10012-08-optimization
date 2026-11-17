import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'
import {
  activeDataset,
  allDatasets,
  archivedDatasets,
  changePrecisionPolicy,
  expireCacheAndRerun,
  latestFailure,
  markFallbackAfterFailure,
  rerunPlan,
} from '@/data/aggregate/aggregate-service'
import { resetAggregateState } from '@/data/aggregate/aggregate-store'
import {
  archiveFilename,
  buildArchiveEntries,
  buildZip,
  exportCsvContents,
  groupToRow,
} from '@/data/aggregate/archive'
import type { AggregateDataset } from '@/data/aggregate/types'
import type { PrecisionPolicy } from '@/data/aggregate/standards'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  // 聚合模块重置时同步清空聚合结果数据集，避免旧数据集指向已重置的方案版本。
  if (key === 'aggregate') {
    resetAggregateState()
  }
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// ---------------------------------------------------------------------------
// 聚合计算域：聚合结果数据集的复用、重算、归档、导出统一从这里走，
// 页面组件不直接碰引擎/存储，保证「沿着同一条取数链路」更新。
// ---------------------------------------------------------------------------

function findAggregateRow(id: number): EntryRow {
  const rows = listRows('aggregate')
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    throw new Error(`没有找到编号为 ${id} 的聚合方案`)
  }
  return row
}

export type AggregateRerunView = {
  ok: boolean
  message: string
  reason: string
  dataset: AggregateDataset | null
  retained: AggregateDataset | null
  reusedGroupCount?: number
  recomputedGroupCount?: number
  versionChanged?: boolean
}

function toRerunView(result: ReturnType<typeof rerunPlan>): AggregateRerunView {
  if (result.ok) {
    return {
      ok: true,
      message: `聚合结果数据集已提交：${result.dataset.datasetId}，重算 ${result.recomputedGroupCount} 组、复用 ${result.reusedGroupCount} 组`,
      reason: result.reason,
      dataset: result.dataset,
      retained: null,
      reusedGroupCount: result.reusedGroupCount,
      recomputedGroupCount: result.recomputedGroupCount,
      versionChanged: result.versionChanged,
    }
  }
  return {
    ok: false,
    message: `重算失败，已保留上一份完整数据集：${result.message}`,
    reason: result.reason,
    dataset: null,
    retained: result.retained,
  }
}

/** 聚合方案动作：状态流转与结果数据集重算在同一条链路内完成。 */
export function runAggregateAction(id: number, action: string): AggregateRerunView {
  const row = findAggregateRow(id)
  const statusResult = runAction('aggregate', id, action)
  if (!statusResult.ok) {
    return { ok: false, message: statusResult.message, reason: action, dataset: null, retained: activeDataset(String(row['方案编号'])) }
  }
  // 启用方案意味着方案要对下游生效：同步产出/刷新聚合结果数据集。
  if (action === '启用方案') {
    const rerun = rerunPlan(findAggregateRow(id))
    if (!rerun.ok) {
      markFallbackAfterFailure(String(row['方案编号']))
    }
    return toRerunView(rerun)
  }
  return {
    ok: true,
    message: statusResult.message,
    reason: action,
    dataset: activeDataset(String(row['方案编号'])),
    retained: null,
  }
}

/** 手动重算（按分组维度只重算受影响分组）。 */
export function recomputeAggregate(id: number, failGroup?: string | null): AggregateRerunView {
  const row = findAggregateRow(id)
  const result = rerunPlan(row, failGroup ? { failGroup } : undefined)
  if (!result.ok) {
    markFallbackAfterFailure(String(row['方案编号']))
  }
  return toRerunView(result)
}

/** 模拟缓存时间到期后重算；与版本更新同时发生时旧精度结果不能命中。 */
export function expireAggregateCache(id: number): AggregateRerunView {
  const row = findAggregateRow(id)
  const result = expireCacheAndRerun(row)
  if (!result.ok) {
    markFallbackAfterFailure(String(row['方案编号']))
  }
  return toRerunView(result)
}

/**
 * 取数链路的方案更新点：页面改了时间窗口/输出精度等字段后先落条目存储，
 * 再由编排服务识别配置指纹变化、推动方案版本并重算受影响分组。
 */
export function updateAggregatePlanRow(
  id: number,
  fields: Record<string, string | number>,
): AggregateRerunView {
  const rows = listRows('aggregate')
  const index = rows.findIndex((item) => Number(item.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的聚合方案`, reason: '方案更新', dataset: null, retained: null }
  }
  const next = [...rows]
  next[index] = { ...next[index], ...fields }
  saveRows('aggregate', next)
  const result = rerunPlan(next[index])
  if (!result.ok) {
    markFallbackAfterFailure(String(next[index]['方案编号']))
  }
  return toRerunView(result)
}

export function getAggregateDataset(planCode: string): AggregateDataset | null {
  return activeDataset(planCode)
}

export function allAggregateDatasets(): AggregateDataset[] {
  return allDatasets()
}

export function getAggregateArchives(planCode: string): AggregateDataset[] {
  return archivedDatasets(planCode)
}

export function getAggregateFailure(planCode: string) {
  return latestFailure(planCode)
}

export function setAggregatePolicy(planCode: string, policy: PrecisionPolicy): void {
  changePrecisionPolicy(planCode, policy)
}

/** 导出聚合结果清单：按精度拆成独立 CSV，明细页展示哪些行就导出哪些行。 */
export function exportAggregateDataset(planCode: string): ActionResult {
  const dataset = activeDataset(planCode)
  if (!dataset) {
    return { ok: false, message: '该方案还没有聚合结果数据集，请先启用方案或执行重算' }
  }
  const files = exportCsvContents(dataset)
  files.forEach((file) => {
    downloadBlob(new Blob([file.content], { type: 'text/csv;charset=utf-8' }), file.filename)
  })
  return {
    ok: true,
    message: `已按 ${files.length} 种精度导出 ${files.length} 个清单文件，不同精度未拼接`,
  }
}

/** 聚合结果数据集输出归档文件（ZIP：方案 + 标准 + 分组统计 + 留痕 + 清单）。 */
export function archiveAggregateDataset(planCode: string): ActionResult {
  const dataset = activeDataset(planCode)
  if (!dataset) {
    return { ok: false, message: '该方案还没有聚合结果数据集，无法归档' }
  }
  const bytes = buildZip(buildArchiveEntries(dataset))
  downloadBlob(new Blob([bytes.buffer as ArrayBuffer], { type: 'application/zip' }), archiveFilename(dataset))
  return { ok: true, message: `归档文件已生成：${archiveFilename(dataset)}` }
}

/** 明细页行数据：与导出清单共用 groupToRow，保证两边字段与行数一致。 */
export function aggregateGroupRows(dataset: AggregateDataset): Record<string, string | number>[] {
  return dataset.groups.map((group) => groupToRow(group))
}

/** 读回归档 ZIP 复核（浏览器 File.text 解析由页面配合，这里给出字节解析）。 */
export async function parseAggregateArchive(file: File): Promise<Record<string, string>> {
  const { parseZip } = await import('@/data/aggregate/archive')
  const buffer = await file.arrayBuffer()
  return parseZip(new Uint8Array(buffer))
}
