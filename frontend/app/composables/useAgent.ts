import { toast } from 'vue-sonner'
import { api } from './useApi'

const POLL_INTERVAL = 2000
const MAX_POLL_DURATION = 5 * 60 * 1000

export function useAgent() {
  const running = ref(false)
  const runningType = ref<string | null>(null)
  const progress = ref<string | null>(null)
  let pollTimer: ReturnType<typeof setInterval> | null = null

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  async function pollTask(taskId: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now()

      pollTimer = setInterval(async () => {
        if (Date.now() - startTime > MAX_POLL_DURATION) {
          stopPolling()
          reject(new Error('任务执行超时'))
          return
        }

        try {
          const data = await api.get<any>(`/agent/tasks/${taskId}`)

          if (data.status === 'done') {
            stopPolling()
            resolve(data.result)
            return
          }

          if (data.status === 'failed') {
            stopPolling()
            reject(new Error(data.error_msg || '任务执行失败'))
            return
          }

          progress.value = data.status === 'running' ? '执行中...' : '等待中...'
        } catch (err: any) {
          stopPolling()
          reject(err)
        }
      }, POLL_INTERVAL)
    })
  }

  async function run(type: string, msg: string, dramaId: number, episodeId: number, onDone?: () => void) {
    if (running.value) { toast.warning('操作执行中'); return }
    running.value = true
    runningType.value = type
    progress.value = '提交中...'

    try {
      const { task_id } = await api.post<any>(`/agent/${type}/chat`, {
        message: msg,
        drama_id: dramaId,
        episode_id: episodeId,
      })

      progress.value = '执行中...'
      await pollTask(task_id)

      toast.success('完成')
      onDone?.()
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      stopPolling()
      running.value = false
      runningType.value = null
      progress.value = null
    }
  }

  return { running, runningType, progress, run }
}
