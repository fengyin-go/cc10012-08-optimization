/**
 * 聚合域规则验证脚本（由 esbuild 打包后用 Node 运行，不经过浏览器）。
 * 覆盖：按分组重算、缓存到期+版本更新不命中、失败保留完整数据集、单份提交、
 * 双精度并存/统一策略、AGGR-0003 窗口变更、归档 ZIP 往返、导出与明细一致。
 */
import { resetAggregateState, aggregateState } from '../src/data/aggregate/aggregate-store'
import { rerunPlan, expireCacheAndRerun, changePrecisionPolicy } from '../src/data/aggregate/aggregate-service'
import { SEED_ROWS } from '../src/data/seed'
import { PRECISION_POLICY, GROUP_ORIGIN, DATASET_STATUS } from '../src/data/aggregate/standards'
import {
  buildZip,
  parseZip,
  buildArchiveEntries,
  exportCsvContents,
  groupToRow,
  splitByPrecision,
} from '../src/data/aggregate/archive'
import type { EntryRow } from '../src/data/types'

// localStorage 垫片：纯 Node 环境模拟浏览器持久化。
const storage = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() {
    return storage.size
  },
}

let failures = 0
function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

const T0 = Date.UTC(2026, 10, 17, 2, 0, 0)
const rowByCode = (code: string): EntryRow =>
  SEED_ROWS.aggregate.find((row) => row['方案编号'] === code) as EntryRow
const cloneRow = (row: EntryRow, patch: Record<string, string | number>): EntryRow => ({ ...row, ...patch })

console.log('\n[场景1] AGGR-0003 首次计算：全量重算，提交一份完整数据集')
resetAggregateState()
let row = rowByCode('AGGR-0003')
let r1 = rerunPlan(row, { now: T0 })
check('首次运行成功', r1.ok)
if (r1.ok) {
  check('数据集覆盖 3窗口×4分组=12组', r1.dataset.groups.length === 12, `实际 ${r1.dataset.groups.length}`)
  check('12组全部为重算', r1.recomputedGroupCount === 12 && r1.reusedGroupCount === 0)
  check('生效数据集只有一份', Object.keys(aggregateState().datasets).length === 1)
  check('每组带缓存键与到期时间', r1.dataset.groups.every((g) => g.cacheKey.startsWith('aggr:') && g.cacheExpireAt !== null))
  check('金额按2位小数表达', r1.dataset.groups.every((g) => g.groupAmount === Number(g.groupAmount.toFixed(2))))
  check('记录数与字段取值可核对', r1.dataset.groups.every((g) => g.recordCount === g.sourceValues.length && g.recordCount >= 1))
  check('方案与标准随结果归档', !!r1.dataset.planSnapshot && r1.dataset.standardSnapshot.standardRevision.length > 0)
}

console.log('\n[场景2] AGGR-0003 只把 10分钟窗口改为 30分钟：受影响分组重算，60分钟窗口沿用原结果')
const oldDataset = r1.ok ? r1.dataset : null
row = cloneRow(rowByCode('AGGR-0003'), { 时间窗口: '30分钟' })
const r2 = rerunPlan(row, { now: T0 + 1000 })
check('窗口变更运行成功', r2.ok)
if (r2.ok && oldDataset) {
  check('方案版本已推进到 v2', r2.dataset.schemaVersion === 'v2', `实际 ${r2.dataset.schemaVersion}`)
  const recomputed = r2.dataset.groups.filter((g) => g.origin === GROUP_ORIGIN.RECOMPUTED)
  const reused = r2.dataset.groups.filter((g) => g.origin === GROUP_ORIGIN.REUSED)
  check('仅10分钟与30分钟两组窗口共8组重算', recomputed.length === 8, `实际 ${recomputed.length}`)
  check('60分钟窗口4组沿用原结果', reused.length === 4 && reused.every((g) => g.window === '60分钟'), `实际 ${reused.length}`)
  const old60 = oldDataset.groups.filter((g) => g.window === '60分钟').map((g) => `${g.groupValue}:${g.groupAmount}`).sort()
  const new60 = r2.dataset.groups.filter((g) => g.window === '60分钟').map((g) => `${g.groupValue}:${g.groupAmount}`).sort()
  check('60分钟窗口金额与原结果完全一致', JSON.stringify(old60) === JSON.stringify(new60))
  check('留痕记录了受影响/未受影响范围', r2.dataset.trace.affectedGroups.length === 8 && r2.dataset.trace.unaffectedGroups.length === 4)
  check('旧数据集已进入归档且标记为已归档', aggregateState().archives['AGGR-0003'].length === 1 && aggregateState().archives['AGGR-0003'][0].status === DATASET_STATUS.ARCHIVED)
  check('生效数据集仍只有一份', Object.keys(aggregateState().datasets).length === 1)
}

console.log('\n[场景3] 同窗口两位小数历史结果 + 四位小数新请求（coexist 双精度并存）')
row = cloneRow(rowByCode('AGGR-0003'), { 时间窗口: '30分钟', 输出精度: '4位小数' })
const r3 = rerunPlan(row, { now: T0 + 2000 })
check('四位小数重算成功', r3.ok)
if (r3.ok) {
  const buckets = splitByPrecision(r3.dataset.groups)
  check('数据集同时保留2位与4位两种精度', buckets.has(2) && buckets.has(4))
  const currentWindowGroups = r3.dataset.groups.filter((g) => g.window === '30分钟')
  const currentWindowFour = currentWindowGroups.filter((g) => g.precision === 4)
  check('当前30分钟窗口4组4位小数结果均已重算', currentWindowFour.length === 4 && currentWindowFour.every((g) => g.origin === GROUP_ORIGIN.RECOMPUTED))
  check('旧2位小数30分钟分组保留并标注沿用', (buckets.get(2) ?? []).some((g) => g.window === '30分钟' && g.origin === GROUP_ORIGIN.REUSED))
  check('冲突权衡已留痕', r3.dataset.trace.policyRationale.includes('双精度并存') && r3.dataset.trace.precisionPolicy === PRECISION_POLICY.COEXIST)
  check('精度依据写入留痕', r3.dataset.trace.basis.precision === 4)
  const files = exportCsvContents(r3.dataset)
  check('导出按精度拆成2个文件、不拼接', files.length === 2 && files.map((f) => f.filename).every((name) => name.includes('2位小数') || name.includes('4位小数')))
  check('导出文件名带精度', files.every((f) => /-(\d)位小数\.csv$/.test(f.filename)))
  const fourFile = files.find((f) => f.filename.includes('4位小数'))!
  const fourRows = fourFile.content.trim().split('\n').length - 1
  check('4位小数清单行数=4位精度分组数', fourRows === (buckets.get(4) ?? []).length)
  check('明细行与导出行同源（groupToRow）', JSON.stringify(Object.keys(groupToRow(r3.dataset.groups[0]))) !== '')
}

console.log('\n[场景4] 切换 unify 策略后再改精度：统一新精度，旧精度仅归档留痕')
changePrecisionPolicy('AGGR-0003', PRECISION_POLICY.UNIFY)
row = cloneRow(rowByCode('AGGR-0003'), { 时间窗口: '30分钟', 输出精度: '2位小数' })
const r4 = rerunPlan(row, { now: T0 + 3000 })
check('unify 重算成功', r4.ok)
if (r4.ok) {
  check('新数据集只含2位小数分组', r4.dataset.groups.every((g) => g.precision === 2))
  check('12组全部重算（unify 精度变更全量）', r4.recomputedGroupCount === 12)
  check('留痕说明统一口径与归档处理', r4.dataset.trace.policyRationale.includes('统一'))
  const archived = aggregateState().archives['AGGR-0003']
  check('历史4位小数数据集在归档中可复核', archived.some((d) => d.groups.some((g) => g.precision === 4)))
}

console.log('\n[场景5] 缓存时间到期与方案版本更新同时发生：旧精度结果不能继续命中')
resetAggregateState()
row = rowByCode('AGGR-0003')
const base = rerunPlan(row, { now: T0 })
check('基线数据集成功', base.ok)
row = cloneRow(rowByCode('AGGR-0003'), { 时间窗口: '30分钟', 输出精度: '4位小数', 缓存时间: '1秒' })
const expired = expireCacheAndRerun(row, { now: T0 + 10_000 })
check('到期重算成功', expired.ok)
if (expired.ok) {
  check('触发原因包含缓存到期', expired.dataset.trace.reason.includes('缓存时间到期'))
  const fourGroups = expired.dataset.groups.filter((g) => g.precision === 4)
  check('新精度分组无任何缓存命中、全部重算', fourGroups.length === 12 && fourGroups.every((g) => g.origin === GROUP_ORIGIN.RECOMPUTED))
  check('旧2位小数结果未被新键命中', fourGroups.every((g) => g.origin === GROUP_ORIGIN.RECOMPUTED))
  const oldKeys = new Set(base.ok ? base.dataset.groups.map((g) => g.cacheKey) : [])
  check('重算分组的新缓存键均不同于旧数据集键', fourGroups.every((g) => !oldKeys.has(g.cacheKey)))
}

console.log('\n[场景6] 重算失败：保留上一份完整数据集，不出现半组数据')
resetAggregateState()
row = rowByCode('AGGR-0003')
const okRun = rerunPlan(row, { now: T0 })
const beforeId = okRun.ok ? okRun.dataset.datasetId : ''
const failed = rerunPlan(row, { now: T0 + 1000, failGroup: '华东' })
check('失败结果被识别', !failed.ok)
check('失败时返回上一份完整数据集', failed.retained !== null && failed.retained?.datasetId === beforeId)
const stateAfterFail = aggregateState()
check('生效数据集未被覆盖', stateAfterFail.datasets['AGGR-0003']?.datasetId === beforeId)
check('生效数据集仍是完整12组', stateAfterFail.datasets['AGGR-0003']?.groups.length === 12)
check('失败信息单独留痕', !!stateAfterFail.failures['AGGR-0003']?.message)
const recovered = rerunPlan(row, { now: T0 + 2000 })
check('恢复后成功提交新数据集', recovered.ok && recovered.ok && recovered.dataset.datasetId !== beforeId)
check('失败标记已清除', !aggregateState().failures['AGGR-0003'])

console.log('\n[场景7] 归档 ZIP：生成、解析往返，方案与结果随归档')
resetAggregateState()
row = rowByCode('AGGR-0003')
const arc = rerunPlan(row, { now: T0 })
if (arc.ok) {
  const entries = buildArchiveEntries(arc.dataset)
  const zip = buildZip(entries)
  check('ZIP 以本地文件头签名开头', zip[0] === 0x50 && zip[1] === 0x4b)
  const parsed = parseZip(zip)
  const names = Object.keys(parsed)
  check('归档包含方案/标准/留痕/清单/数据集', names.some((n) => n.includes('plan-snapshot')) && names.some((n) => n.includes('standard-snapshot')) && names.some((n) => n.includes('recompute-trace')) && names.some((n) => n.includes('manifest')) && names.some((n) => n.includes('dataset.json')))
  check('分组CSV按精度独立成文件', names.filter((n) => n.includes('groups-precision-')).length === 1)
  const datasetEntry = names.find((n) => n.endsWith('dataset.json'))!
  check('dataset.json 可还原完整数据集', JSON.parse(parsed[datasetEntry]).datasetId === arc.dataset.datasetId)
  const standardEntry = names.find((n) => n.endsWith('standard-snapshot.json'))!
  check('归档内业务标准阈值与运行时一致', JSON.parse(parsed[standardEntry]).amountThresholds.HIGH_AMOUNT === 10000)
}

console.log('\n[场景8] 导出清单与明细页一致')
if (arc.ok) {
  const detailRows = arc.dataset.groups.map((g) => groupToRow(g))
  const exports = exportCsvContents(arc.dataset)
  const exportedLines = exports.flatMap((f) => f.content.replace(/^﻿/, '').trim().split('\n').slice(1))
  check('导出行数=明细分组行数', exportedLines.length === detailRows.length)
  const firstDetail = detailRows[0]
  const firstExport = exportedLines[0]
  check('导出首行包含明细首行的分组与金额', firstExport.includes(String(firstDetail['分组取值'])) && firstExport.includes(String(firstDetail['分组金额'])))
}

console.log(`\n${failures === 0 ? '全部通过' : `存在 ${failures} 个失败项`}`)
process.exit(failures === 0 ? 0 : 1)
