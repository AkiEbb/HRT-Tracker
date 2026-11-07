import { createIdbRecordStore, hasIndexedDb, type RecordStore } from '~/lib/record-store'

/**
 * 拿到本地记录库。SSR 阶段 `store` 是 `null`——页面据此显示空态，
 * 而不是在服务端假装有一个空数据库（那会让首屏与客户端不一致）。
 */
export function useRecordStore() {
  const store = shallowRef<RecordStore | null>(null)
  const error = ref<string | null>(null)

  onMounted(() => {
    if (!hasIndexedDb()) {
      error.value = '这个浏览器不支持 IndexedDB，记录无法保存'
      return
    }
    try {
      store.value = createIdbRecordStore()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  })

  return { store, error }
}
