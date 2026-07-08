/**
 * AI 音色管理
 * GET  /api/v1/ai-voices       - 获取音色列表
 * POST /api/v1/ai-voices/sync  - 从 MiniMax 同步音色
 */
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, now } from '../utils/response.js'
import { joinProviderUrl } from '../services/adapters/url.js'

const app = new Hono()

function ensureXiaomiVoices() {
  const existing = db.select().from(schema.aiVoices)
    .where(eq(schema.aiVoices.provider, 'xiaomi'))
    .all()
  if (existing.length > 0) return

  const ts = now()
  const voices = [
    { voiceId: 'mimo_default', voiceName: 'MiMo-默认', description: '["默认音色","中性","通用"]', language: '中文' },
    { voiceId: '冰糖', voiceName: '冰糖', description: '["女性","甜美女声","活泼清亮"]', language: '中文' },
    { voiceId: '茉莉', voiceName: '茉莉', description: '["女性","温柔知性","优雅大方"]', language: '中文' },
    { voiceId: '苏打', voiceName: '苏打', description: '["男性","阳光活力","年轻开朗"]', language: '中文' },
    { voiceId: '白桦', voiceName: '白桦', description: '["男性","成熟稳重","深沉磁性"]', language: '中文' },
    { voiceId: 'Mia', voiceName: 'Mia', description: '["女性","温柔自然","美式英语"]', language: '英语' },
    { voiceId: 'Chloe', voiceName: 'Chloe', description: '["女性","活泼甜美","英语女声"]', language: '英语' },
    { voiceId: 'Milo', voiceName: 'Milo', description: '["男性","温暖治愈","年轻男声"]', language: '英语' },
    { voiceId: 'Dean', voiceName: 'Dean', description: '["男性","沉稳磁性","成熟男声"]', language: '英语' },
  ]

  db.insert(schema.aiVoices).values(
    voices.map(v => ({ ...v, provider: 'xiaomi', createdAt: ts }))
  ).run()
}

// GET /ai-voices?provider=minimax
app.get('/', async (c) => {
  const provider = c.req.query('provider') || 'minimax'
  
  // Ensure xiaomi voices exist in database
  if (provider === 'xiaomi') {
    ensureXiaomiVoices()
  }
  
  let rows = db.select().from(schema.aiVoices)
    .where(eq(schema.aiVoices.provider, provider))
    .all()

  // If no voices found for xiaomi, try to ensure and query again
  if (rows.length === 0 && provider === 'xiaomi') {
    ensureXiaomiVoices()
    rows = db.select().from(schema.aiVoices)
      .where(eq(schema.aiVoices.provider, provider))
      .all()
  }

  const parsed = rows.map(r => ({
    voice_id: r.voiceId,
    voice_name: r.voiceName,
    description: r.description ? JSON.parse(r.description) : [],
    language: r.language,
    provider: r.provider,
  }))

  return success(c, parsed)
})

// POST /ai-voices/sync
app.post('/sync', async (c) => {
  // 从数据库获取 minimax 的音频配置
  const rows = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, 'audio'))
    .all()
    .filter(r => r.isActive && r.provider === 'minimax')

  if (rows.length === 0) {
    return badRequest(c, 'No active minimax audio config found')
  }

  const config = rows[0]
  if (!config.apiKey) {
    return badRequest(c, 'MiniMax API key not configured')
  }

  // 调用 MiniMax get_voice API
  const resp = await fetch(joinProviderUrl(config.baseUrl, '/v1', '/get_voice'), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ voice_type: 'all' }),
  })

  if (!resp.ok) {
    return badRequest(c, `MiniMax API error: ${resp.status}`)
  }

  const result = await resp.json() as any
  if (result.base_resp?.status_code !== 0) {
    return badRequest(c, result.base_resp?.status_msg || 'Failed to fetch voices')
  }

  const voices = (result.system_voice || []).filter((v: any) => shouldKeepVoice(v))
  const ts = now()

  // 先清空旧数据
  db.delete(schema.aiVoices).where(eq(schema.aiVoices.provider, 'minimax')).run()

  // 批量插入新数据
  const insertRows = voices.map((v: any) => ({
    voiceId: v.voice_id,
    voiceName: v.voice_name,
    description: JSON.stringify(v.description || []),
    language: extractLanguage(v.voice_id, v.voice_name),
    provider: 'minimax',
    createdAt: ts,
  }))

  if (insertRows.length > 0) {
    db.insert(schema.aiVoices).values(insertRows).run()
  }

  return success(c, { count: insertRows.length, message: `Synced ${insertRows.length} voices` })
})

/**
 * 从 voice_id 或 voice_name 推断语言
 */
function extractLanguage(voiceId: string, voiceName: string): string {
  const text = `${voiceId} ${voiceName}`.toLowerCase()
  if (text.includes('cantonese') || text.includes('粤')) return '粤语'
  if (text.includes('english') || text.includes('aussie')) return '英语'
  if (text.includes('japanese') || text.includes('日语')) return '日语'
  if (text.includes('korean') || text.includes('韩')) return '韩语'
  if (text.includes('spanish')) return '西班牙语'
  if (text.includes('portuguese')) return '葡萄牙语'
  if (text.includes('french')) return '法语'
  if (text.includes('indonesian')) return '印尼语'
  if (text.includes('german')) return '德语'
  if (text.includes('russian')) return '俄语'
  if (text.includes('italian')) return '意大利语'
  if (text.includes('arabic')) return '阿拉伯语'
  if (text.includes('turkish')) return '土耳其语'
  if (text.includes('ukrainian')) return '乌克兰语'
  if (text.includes('dutch')) return '荷兰语'
  if (text.includes('vietnamese')) return '越南语'
  if (text.includes('chinese') || text.includes('mandarin') || text.includes('中文')) return '中文'
  return '其他'
}

function shouldKeepVoice(voice: { voice_id: string, voice_name: string }) {
  const language = extractLanguage(voice.voice_id, voice.voice_name)
  if (language !== '中文' && language !== '粤语') return false

  const text = `${voice.voice_id} ${voice.voice_name}`.toLowerCase()

  const excludedPatterns = [
    'jingpin',
    '-beta',
    'cartoon_pig',
    'cute_boy',
    'lovely_girl',
    'clever_boy',
    'robot_armor',
    'news_anchor',
    'male_announcer',
    'radio_host',
    'hk_flight_attendant',
  ]

  return !excludedPatterns.some(pattern => text.includes(pattern))
}

export default app
