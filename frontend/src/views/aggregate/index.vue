<template>
  <section class="page" data-module="aggregate">
    <header class="page-head">
      <div>
        <h2>聚合计算管理</h2>
        <p class="page-desc">
          维护聚合方案与聚合结果数据集：缓存键、精度、分组金额可核对；按分组维度重算受影响分组，
          重算失败保留上一份完整数据集，方案与结果随归档文件一起留存。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出聚合方案清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>结果数据集</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td>
            <button class="link" type="button" @click="inspect(row)">
              {{ datasetBadge(row) }}
            </button>
          </td>
          <td class="row-actions wrap">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="openEdit(row)">编辑重算</button>
            <button class="link" type="button" @click="recompute(row)">按分组重算</button>
            <button class="link" type="button" @click="expire(row)">缓存到期重算</button>
            <button class="link danger" type="button" @click="simulateFailure(row)">模拟重算失败</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无聚合计算数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条聚合计算记录 · 聚合结果数据集存储键：{{ storageKeyText }}</span>
      <span v-if="noticeMessage" :class="errorMessage ? 'error-text' : 'ok-text'">{{ noticeMessage }}</span>
    </footer>

    <!-- 聚合结果数据集复核区 -->
    <section v-if="selected" class="dataset-panel">
      <header class="dataset-head">
        <div>
          <h3>聚合结果数据集复核 · {{ selectedCode }}</h3>
          <p class="page-desc">
            分组统计读取目标字段后形成数据集；阈值、范围与判定条件采用统一业务标准
            （标准版本 {{ standardRevision }}）。
          </p>
        </div>
        <div class="row-actions">
          <button class="btn" type="button" @click="exportDataset(selectedCode)">导出结果清单</button>
          <button class="btn primary" type="button" @click="archiveDataset(selectedCode)">输出归档文件</button>
          <button class="btn ghost" type="button" @click="selected = null">收起</button>
        </div>
      </header>

      <div v-if="failureNote" class="notice error">
        <strong>最近一次重算失败（{{ failureNote.at }}）：</strong>{{ failureNote.message }}
        —— 生效中的仍是上一份完整数据集，未写入半组数据。
      </div>

      <template v-if="dataset">
        <div class="kv-grid">
          <div><span>数据集编号</span><strong>{{ dataset.datasetId }}</strong></div>
          <div><span>数据集状态</span><strong>{{ dataset.status }}</strong></div>
          <div><span>方案版本</span><strong>{{ dataset.schemaVersion }}</strong></div>
          <div><span>分组总数</span><strong>{{ dataset.groups.length }}</strong></div>
          <div><span>本次重算</span><strong>{{ recomputedCount }} 组</strong></div>
          <div><span>结果复用</span><strong>{{ reusedCount }} 组</strong></div>
          <div class="kv-wide"><span>缓存键规则</span><strong>{{ dataset.cacheKeyRule }}</strong></div>
          <div class="kv-wide">
            <span>精度冲突策略</span>
            <select :value="policyValue" @change="changePolicy(($event.target as HTMLSelectElement).value)">
              <option value="coexist">双精度并存（按精度分层，导出拆分）</option>
              <option value="unify">统一到新精度（旧精度归档留痕）</option>
            </select>
          </div>
        </div>

        <h4>分组统计（缓存键、精度、分组金额可核对；字段与取值可检查）</h4>
        <table class="data-table compact">
          <thead>
            <tr>
              <th v-for="column in groupColumns" :key="column">{{ column }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(group, index) in groupRows" :key="index">
              <td v-for="column in groupColumns" :key="column">{{ group[column] ?? '—' }}</td>
            </tr>
          </tbody>
        </table>

        <h4>重算范围与留痕</h4>
        <div class="kv-grid">
          <div><span>触发原因</span><strong>{{ dataset.trace.reason }}</strong></div>
          <div><span>版本变化</span><strong>{{ dataset.trace.fromVersion }} → {{ dataset.trace.toVersion }}</strong></div>
          <div><span>精度依据</span><strong>{{ dataset.trace.basis.precision }}位小数</strong></div>
          <div><span>窗口依据</span><strong>{{ dataset.trace.basis.timeWindow }}</strong></div>
          <div><span>来源指纹</span><strong>{{ dataset.trace.basis.sourceFingerprint }}</strong></div>
          <div><span>缓存TTL</span><strong>{{ dataset.trace.basis.cacheTtlSeconds }}秒</strong></div>
          <div class="kv-wide"><span>受影响重算范围</span><strong>{{ dataset.trace.affectedGroups.join('；') || '—' }}</strong></div>
          <div class="kv-wide"><span>未受影响沿用范围</span><strong>{{ dataset.trace.unaffectedGroups.join('；') || '—' }}</strong></div>
          <div class="kv-wide"><span>冲突权衡留痕</span><strong>{{ dataset.trace.policyRationale }}</strong></div>
        </div>

        <h4>随结果归档：聚合方案快照 / 业务标准快照</h4>
        <div class="snapshot-grid">
          <pre>{{ planSnapshotText }}</pre>
          <pre>{{ standardSnapshotText }}</pre>
        </div>

        <h4>历史归档（返回页面后仍可复核，每次成功提交只保留一份生效数据集）</h4>
        <table v-if="archives.length" class="data-table compact">
          <thead>
            <tr><th>数据集编号</th><th>方案版本</th><th>状态</th><th>分组数</th><th>触发原因</th><th>生成时间</th></tr>
          </thead>
          <tbody>
            <tr v-for="item in archives" :key="item.datasetId">
              <td>{{ item.datasetId }}</td>
              <td>{{ item.schemaVersion }}</td>
              <td>{{ item.status }}</td>
              <td>{{ item.groups.length }}</td>
              <td>{{ item.trace.reason }}</td>
              <td>{{ item.updatedAt }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="page-desc">暂无历史归档。</p>

        <h4>归档文件复核（上传本模块输出的 ZIP，读回清单与留痕）</h4>
        <input type="file" accept=".zip" @change="readArchive" />
        <pre v-if="archivePreview" class="archive-preview">{{ archivePreview }}</pre>
      </template>

      <div v-else class="notice">
        该方案尚未产出聚合结果数据集。点击「启用方案」或「按分组重算」后，
        数据集、缓存键与分组统计将在这里展示并支持归档。
      </div>
    </section>

    <!-- 方案编辑弹窗：改时间窗口/输出精度即推动方案版本并按分组重算 -->
    <div v-if="editing" class="modal-mask" @click.self="editing = null">
      <form class="modal-card" @submit.prevent="saveEdit">
        <h3>编辑聚合方案 · {{ editing['方案编号'] }}</h3>
        <label class="filter-item">
          <span>时间窗口</span>
          <select v-model="editForm.timeWindow">
            <option v-for="window in windowOptions" :key="window" :value="window">{{ window }}</option>
          </select>
        </label>
        <label class="filter-item">
          <span>输出精度</span>
          <select v-model="editForm.precision">
            <option value="2位小数">2位小数</option>
            <option value="4位小数">4位小数</option>
          </select>
        </label>
        <label class="filter-item">
          <span>缓存时间（秒）</span>
          <input v-model.number="editForm.cacheTtlSeconds" type="number" min="1" />
        </label>
        <p class="page-desc">
          保存即更新方案：配置指纹变化会推动方案版本，引擎按分组维度评估重算范围；
          同一窗口已有两种精度结果时按当前策略权衡并留痕。
        </p>
        <div class="row-actions">
          <button class="btn primary" type="submit">保存并重算</button>
          <button class="btn ghost" type="button" @click="editing = null">取消</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  archiveAggregateDataset,
  downloadEntries,
  expireAggregateCache,
  exportAggregateDataset,
  getAggregateArchives,
  getAggregateDataset,
  getAggregateFailure,
  listEntries,
  moduleMeta,
  parseAggregateArchive,
  recomputeAggregate,
  runAggregateAction,
  setAggregatePolicy,
  updateAggregatePlanRow,
  aggregateGroupRows,
} from '@/api/local-service'
import { aggregateStorageKey } from '@/data/aggregate/aggregate-store'
import { DEMO_WINDOWS } from '@/data/aggregate/source-data'
import {
  GROUP_CSV_COLUMNS,
} from '@/data/aggregate/archive'
import {
  PRECISION_POLICY,
  STANDARD_REVISION,
  type PrecisionPolicy,
} from '@/data/aggregate/standards'
import type { AggregateDataset } from '@/data/aggregate/types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('aggregate')
const columns = ['方案编号', '聚合函数', '目标字段', '分组维度', '时间窗口', '筛选条件', '输出精度', '缓存时间']
const actions = ['提交校验', '启用方案', '停用方案']
const statuses = ['草稿', '待校验', '已启用', '已停用']
const groupColumns = GROUP_CSV_COLUMNS
const windowOptions = [...DEMO_WINDOWS]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const selected = ref<EntryRow | null>(null)
const editing = ref<EntryRow | null>(null)
const editForm = ref({ timeWindow: '10分钟', precision: '2位小数', cacheTtlSeconds: 600 })
const archivePreview = ref('')

const storageKeyText = aggregateStorageKey()
const standardRevision = STANDARD_REVISION

const stats = computed(() => [
  { label: '聚合方案总数', value: rows.value.length },
  { label: '已启用方案', value: rows.value.filter((row) => row.status === '已启用').length },
  { label: '待校验方案', value: rows.value.filter((row) => row.status === '待校验').length },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const selectedCode = computed(() => (selected.value ? String(selected.value['方案编号']) : ''))
const dataset = computed<AggregateDataset | null>(() =>
  selectedCode.value ? getAggregateDataset(selectedCode.value) : null,
)
const archives = computed(() => (selectedCode.value ? getAggregateArchives(selectedCode.value) : []))
const failureNote = computed(() => (selectedCode.value ? getAggregateFailure(selectedCode.value) : null))
const policyValue = computed<PrecisionPolicy>(() =>
  selectedCode.value && getAggregateDataset(selectedCode.value)
    ? (getAggregateDataset(selectedCode.value)!.trace.precisionPolicy as PrecisionPolicy)
    : PRECISION_POLICY.COEXIST,
)
const groupRows = computed(() => (dataset.value ? aggregateGroupRows(dataset.value) : []))
const recomputedCount = computed(
  () => dataset.value?.groups.filter((group) => group.origin.includes('重算')).length ?? 0,
)
const reusedCount = computed(
  () => dataset.value?.groups.filter((group) => !group.origin.includes('重算')).length ?? 0,
)
const planSnapshotText = computed(() =>
  dataset.value ? JSON.stringify(dataset.value.planSnapshot, null, 2) : '',
)
const standardSnapshotText = computed(() =>
  dataset.value ? JSON.stringify(dataset.value.standardSnapshot, null, 2) : '',
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    if (selected.value) {
      const refreshed = rows.value.find((row) => Number(row.id) === Number(selected.value?.id))
      selected.value = refreshed ?? null
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '聚合计算列表读取失败'
  }
}

function flash(message: string, ok: boolean) {
  noticeMessage.value = message
  errorMessage.value = ok ? '' : message
}

function runAction(action: string, row: EntryRow) {
  const result = runAggregateAction(Number(row.id), action)
  flash(result.message, result.ok)
  reload()
  inspect(row)
}

function recompute(row: EntryRow) {
  const result = recomputeAggregate(Number(row.id))
  flash(result.message, result.ok)
  reload()
  inspect(row)
}

function expire(row: EntryRow) {
  const result = expireAggregateCache(Number(row.id))
  flash(result.message, result.ok)
  reload()
  inspect(row)
}

function simulateFailure(row: EntryRow) {
  const result = recomputeAggregate(Number(row.id), '华东')
  flash(result.message, false)
  reload()
  inspect(row)
}

function openEdit(row: EntryRow) {
  editing.value = row
  editForm.value = {
    timeWindow: String(row['时间窗口'] ?? '10分钟'),
    precision: String(row['输出精度'] ?? '2位小数'),
    cacheTtlSeconds: Number(String(row['缓存时间'] ?? '600').replace(/\D/g, '')) || 600,
  }
}

function saveEdit() {
  if (!editing.value) {
    return
  }
  const result = updateAggregatePlanRow(Number(editing.value.id), {
    时间窗口: editForm.value.timeWindow,
    输出精度: editForm.value.precision,
    缓存时间: `${editForm.value.cacheTtlSeconds}秒`,
  })
  flash(result.message, result.ok)
  editing.value = null
  reload()
  inspect(rows.value.find((row) => Number(row.id) === Number(result.dataset?.rowId)) ?? selected.value)
}

function inspect(row: EntryRow | null) {
  selected.value = row
  archivePreview.value = ''
}

function datasetBadge(row: EntryRow): string {
  const current = getAggregateDataset(String(row['方案编号']))
  if (!current) {
    return '未产出（点击重算）'
  }
  return `${current.datasetId} · ${current.groups.length}组 · ${current.status}`
}

function changePolicy(value: string) {
  if (!selectedCode.value) {
    return
  }
  setAggregatePolicy(selectedCode.value, value as PrecisionPolicy)
  flash(`精度冲突策略已切换为：${value === PRECISION_POLICY.COEXIST ? '双精度并存' : '统一新精度'}，下次重算生效`, true)
}

function exportDataset(planCode: string) {
  const result = exportAggregateDataset(planCode)
  flash(result.message, result.ok)
}

function archiveDataset(planCode: string) {
  const result = archiveAggregateDataset(planCode)
  flash(result.message, result.ok)
}

async function readArchive(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    return
  }
  try {
    const parsed = await parseAggregateArchive(file)
    const names = Object.keys(parsed)
    const manifest = names.find((name) => name.endsWith('manifest.csv'))
    const trace = names.find((name) => name.endsWith('recompute-trace.csv'))
    archivePreview.value = [
      `归档条目（${names.length}）：`,
      ...names,
      '',
      manifest ? `# ${manifest}\n${parsed[manifest]}` : '',
      trace ? `\n# ${trace}\n${parsed[trace]}` : '',
    ]
      .filter(Boolean)
      .join('\n')
    flash('归档文件已读回，可与页面数据集逐项复核', true)
  } catch (error) {
    flash(error instanceof Error ? error.message : '归档解析失败', false)
  } finally {
    input.value = ''
  }
}

onMounted(reload)
</script>

<style scoped>
.wrap { flex-wrap: wrap; row-gap: 6px; max-width: 360px; }
.link.danger { color: #b42318; }
.dataset-panel {
  margin-top: 18px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px;
}
.dataset-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.dataset-panel h3 { margin: 0 0 4px; font-size: 16px; }
.dataset-panel h4 { margin: 18px 0 8px; font-size: 14px; }
.kv-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 14px; }
.kv-grid > div { background: #f8fafc; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.kv-grid .kv-wide { grid-column: span 3; }
.kv-grid span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 2px; word-break: break-all; }
.kv-grid strong { font-size: 13px; font-weight: 600; word-break: break-all; }
.data-table.compact th, .data-table.compact td { font-size: 12px; padding: 6px 8px; word-break: break-all; }
.snapshot-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.snapshot-grid pre, .archive-preview {
  margin: 0;
  background: #0f172a;
  color: #dbeafe;
  border-radius: 8px;
  padding: 10px;
  font-size: 11px;
  max-height: 280px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
.notice { margin-top: 12px; padding: 10px 12px; background: #eef2f7; border-radius: 8px; font-size: 13px; }
.notice.error, .notice:has(strong) { background: #fef3f2; border: 1px solid #fda29b; color: #7a271a; }
.ok-text { color: #067647; }
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal-card {
  width: 420px;
  background: #fff;
  border-radius: 12px;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.modal-card h3 { margin: 0; font-size: 16px; }
</style>
