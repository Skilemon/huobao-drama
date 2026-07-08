/**
 * Agent 聊天路由 — 异步任务模式
 * POST /:type/chat → 创建任务，立即返回 task_id
 * GET /tasks/:id → 查询任务状态和结果
 */
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { createAgent, validAgentTypes } from '../agents/index.js'
import { db, schema } from '../db/index.js'
import { success, badRequest, notFound, now } from '../utils/response.js'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

function normalizeToolName(entry: any) {
  return entry?.toolName
    || entry?.tool?.toolName
    || entry?.tool?.id
    || entry?.name
    || entry?.type
    || null
}

function normalizeToolResult(entry: any) {
  const result = entry?.result ?? entry?.output ?? entry?.data ?? null
  return typeof result === 'string' ? result : JSON.stringify(result)
}

// 后台执行 Agent 任务
async function executeAgentTask(taskId: number, agentType: string, episodeId: number, dramaId: number, message: string) {
  const startTime = performance.now()
  const ts = now()

  // 更新状态为 running
  db.update(schema.agentTasks)
    .set({ status: 'running', updatedAt: ts })
    .where(eq(schema.agentTasks.id, taskId))
    .run()
  logTaskStart('Agent', `${agentType} task=${taskId}`, { dramaId, episodeId })

  const agent = createAgent(agentType, episodeId, dramaId)
  if (!agent) {
    const errorMsg = 'Agent not found'
    db.update(schema.agentTasks)
      .set({ status: 'failed', errorMsg, updatedAt: now(), completedAt: now() })
      .where(eq(schema.agentTasks.id, taskId))
      .run()
    logTaskError('Agent', agentType, { taskId, reason: errorMsg })
    return
  }

  try {
    const abortController = new AbortController()
    const timeoutMs = 5 * 60 * 1000
    const timeout = setTimeout(() => abortController.abort(), timeoutMs)

    let result: any
    try {
      result = await agent.generate(
        [{ role: 'user', content: message }],
        { maxSteps: 20, abortSignal: abortController.signal as any },
      )
    } finally {
      clearTimeout(timeout)
    }

    if (abortController.signal.aborted) {
      const errorMsg = `Agent execution timed out after ${timeoutMs / 1000}s`
      db.update(schema.agentTasks)
        .set({ status: 'failed', errorMsg, updatedAt: now(), completedAt: now() })
        .where(eq(schema.agentTasks.id, taskId))
        .run()
      logTaskError('Agent', agentType, { taskId, reason: 'timeout', timeoutMs })
      return
    }

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskSuccess('Agent', `${agentType} task=${taskId}`, { elapsedSeconds: elapsed })

    // 收集 tool calls 和 results
    const toolCalls = result.toolCalls || []
    const toolResults = result.toolResults || []
    const normalizedToolCalls = toolCalls.map((tc: any) => ({
      toolName: normalizeToolName(tc),
      args: tc?.args ?? tc?.input ?? null,
    }))
    const normalizedToolResults = toolResults.map((tr: any) => ({
      toolName: normalizeToolName(tr),
      result: normalizeToolResult(tr),
    }))

    logTaskProgress('Agent', 'tool-summary', {
      agentType,
      taskId,
      toolCalls: normalizedToolCalls.map((tc: any) => tc.toolName),
      toolResults: normalizedToolResults.map((tr: any) => tr.toolName),
    })

    const taskResult = JSON.stringify({
      text: result.text || '',
      toolCalls: normalizedToolCalls,
      toolResults: normalizedToolResults,
    })

    db.update(schema.agentTasks)
      .set({ status: 'done', result: taskResult, updatedAt: now(), completedAt: now() })
      .where(eq(schema.agentTasks.id, taskId))
      .run()
  } catch (err: any) {
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskError('Agent', agentType, { taskId, elapsedSeconds: elapsed, error: err.message })
    console.error(err.stack || err)

    db.update(schema.agentTasks)
      .set({ status: 'failed', errorMsg: err.message || 'Agent execution failed', updatedAt: now(), completedAt: now() })
      .where(eq(schema.agentTasks.id, taskId))
      .run()
  }
}

// POST /agent/:type/chat — 创建异步任务
app.post('/:type/chat', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) {
    return badRequest(c, `Invalid agent type: ${agentType}`)
  }

  const body = await c.req.json()
  const { message, drama_id, episode_id } = body

  if (!episode_id || !drama_id) {
    return badRequest(c, 'drama_id and episode_id are required')
  }

  const ts = now()
  const res = db.insert(schema.agentTasks).values({
    agentType,
    dramaId: drama_id,
    episodeId: episode_id,
    message,
    status: 'pending',
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const taskId = Number(res.lastInsertRowid)
  logTaskStart('Agent', `${agentType} enqueue`, { taskId, dramaId: drama_id, episodeId: episode_id })

  // 后台执行，不 await
  executeAgentTask(taskId, agentType, episode_id, drama_id, message).catch(err => {
    logTaskError('Agent', agentType, { taskId, error: err.message })
    console.error(`Agent task ${taskId} failed:`, err)
  })

  return success(c, { task_id: taskId, status: 'pending' })
})

// GET /agent/tasks/:id — 查询任务状态
app.get('/tasks/:id', async (c) => {
  const taskId = Number(c.req.param('id'))
  if (!taskId || isNaN(taskId)) {
    return badRequest(c, 'Invalid task id')
  }

  const [task] = db.select().from(schema.agentTasks)
    .where(eq(schema.agentTasks.id, taskId))
    .all()

  if (!task) {
    return notFound(c, 'Task not found')
  }

  let result: any = null
  if (task.result) {
    try { result = JSON.parse(task.result) } catch { result = null }
  }

  return success(c, {
    id: task.id,
    agent_type: task.agentType,
    status: task.status,
    result,
    error_msg: task.errorMsg,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    completed_at: task.completedAt,
  })
})

// GET /agent/:type/debug
app.get('/:type/debug', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) return badRequest(c, 'Invalid agent type')
  return success(c, { agent_type: agentType, valid: true })
})

export default app
