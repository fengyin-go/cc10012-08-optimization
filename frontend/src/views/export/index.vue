<template>
  <section class="page" data-module="export">
    <header class="page-head">
      <div>
        <h2>数据导出管理</h2>
        <p class="page-desc">
          维护数据导出任务，并承接聚合结果数据集的清单导出与归档：清单字段、行数与聚合计算明细页完全一致，
          不同精度拆分为独立文件不拼接；归档为 ZIP，聚合方案与聚合结果随结果一起留存。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出数据导出清单</button>
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
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无数据导出数据，可先登记导出任务</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">聚合结果数据集导出与归档</h3>
    <p class="page-desc">
      下表直接读取聚合计算页的生效聚合结果数据集（同一条取数链路，无第二份口径）；
      「导出清单」按精度拆分 CSV，内容与聚合页分组明细表逐行一致；「输出归档文件」生成含方案、标准、留痕的 ZIP。
    </p>
    <table v-if="aggregateDatasets.length" class="data-table">
      <thead>
        <tr>
          <th>数据集编号</th>
          <th>方案编号</th>
          <th>方案版本</th>
          <th>状态</th>
          <th>分组数</th>
          <th>精度分布</th>
          <th>重算/复用</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="dataset in aggregateDatasets" :key="dataset.datasetId">
          <td>{{ dataset.datasetId }}</td>
          <td>{{ dataset.planCode }}</td>
          <td>{{ dataset.schemaVersion }}</td>
          <td>{{ dataset.status }}</td>
          <td>{{ dataset.groups.length }}</td>
          <td>{{ precisionText(dataset) }}</td>
          <td>{{ originText(dataset) }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="exportDataset(dataset.planCode)">导出清单</button>
            <button class="link" type="button" @click="archiveDataset(dataset.planCode)">输出归档文件</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else class="page-desc">暂无聚合结果数据集，请先在「聚合计算」页启用方案或执行重算。</p>

    <footer class="page-foot">
      <span>共 {{ total }} 条数据导出记录 · {{ aggregateDatasets.length }} 份聚合结果数据集</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  archiveAggregateDataset,
  downloadEntries,
  exportAggregateDataset,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  allAggregateDatasets,
} from '@/api/local-service'
import { GROUP_ORIGIN } from '@/data/aggregate/standards'
import type { AggregateDataset } from '@/data/aggregate/types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('export')
const columns = ['任务编号', '查询SQL', '导出格式', '字段列表', '分隔符', '编码格式', '压缩方式', '目标路径']
const actions = ['提交执行', '启动导出', '终止导出', '归档文件']
const statuses = ['草稿', '待执行', '执行中', '已完成', '已失败']
const stats = [{ label: '导出任务总数', value: 0 }, { label: '执行中任务', value: 0 }, { label: '已完成任务', value: 0 }]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const aggregateDatasets = ref<AggregateDataset[]>([])

function precisionText(dataset: AggregateDataset): string {
  const counts = new Map<number, number>()
  for (const group of dataset.groups) {
    counts.set(group.precision, (counts.get(group.precision) ?? 0) + 1)
  }
  return [...counts.entries()].map(([precision, count]) => `${precision}位小数×${count}`).join('；')
}

function originText(dataset: AggregateDataset): string {
  const recomputed = dataset.groups.filter((group) => group.origin === GROUP_ORIGIN.RECOMPUTED).length
  const reused = dataset.groups.length - recomputed
  return `重算${recomputed}组 / 复用${reused}组`
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function exportDataset(planCode: string) {
  const result = exportAggregateDataset(planCode)
  errorMessage.value = result.ok ? '' : result.message
}

function archiveDataset(planCode: string) {
  const result = archiveAggregateDataset(planCode)
  errorMessage.value = result.ok ? '' : result.message
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    aggregateDatasets.value = allAggregateDatasets()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '数据导出列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.section-title { margin: 22px 0 6px; font-size: 15px; }
</style>
