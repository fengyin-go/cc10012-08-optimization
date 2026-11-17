/**
 * 聚合域持久化：独立于通用条目存储的 localStorage 键。
 *
 * 不变量（每次写入都保持）：
 * - datasets 中每个方案编号最多只有一份生效聚合结果数据集；
 * - 成功重算后旧数据集整体移入 archives，绝不就地覆盖成半组数据；
 * - 重算失败只写 failures，datasets 保持上一份完整数据集不动。
 */
import type { AggregateStoreState } from './types'
import { PRECISION_POLICY, type PrecisionPolicy } from './standards'

const AGGREGATE_STORAGE_KEY = 'data-explore-studio:aggregate-datasets'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function emptyState(): AggregateStoreState {
  return { datasets: {}, archives: {}, failures: {}, policies: {}, configSignatures: {} }
}

function readState(): AggregateStoreState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return emptyState()
  }
  const raw = window.localStorage.getItem(AGGREGATE_STORAGE_KEY)
  if (!raw) {
    return emptyState()
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AggregateStoreState>
    return {
      datasets: parsed.datasets ?? {},
      archives: parsed.archives ?? {},
      failures: parsed.failures ?? {},
      policies: parsed.policies ?? {},
      configSignatures: parsed.configSignatures ?? {},
    }
  } catch {
    return emptyState()
  }
}

let memoryState: AggregateStoreState | null = null

export function aggregateState(): AggregateStoreState {
  if (memoryState === null) {
    memoryState = readState()
  }
  return memoryState
}

/** 整体持久化：一次写入一个完整状态，调用方负责先构造好再提交（原子提交语义）。 */
export function persistAggregateState(state: AggregateStoreState): void {
  memoryState = clone(state)
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(AGGREGATE_STORAGE_KEY, JSON.stringify(memoryState))
  }
}

export function getPolicy(planCode: string): PrecisionPolicy {
  return aggregateState().policies[planCode] ?? PRECISION_POLICY.COEXIST
}

export function setPolicy(planCode: string, policy: PrecisionPolicy): void {
  const state = aggregateState()
  persistAggregateState({ ...state, policies: { ...state.policies, [planCode]: policy } })
}

export function getConfigSignature(planCode: string): string | undefined {
  return aggregateState().configSignatures[planCode]
}

export function setConfigSignature(planCode: string, signature: string): void {
  const state = aggregateState()
  persistAggregateState({
    ...state,
    configSignatures: { ...state.configSignatures, [planCode]: signature },
  })
}

export function resetAggregateState(): void {
  persistAggregateState(emptyState())
}

export function aggregateStorageKey(): string {
  return AGGREGATE_STORAGE_KEY
}
