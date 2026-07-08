/**
 * XiaoMi (MiMo) TTS 语音合成 Adapter
 * 使用 Chat Completions 格式，支持预置音色
 *
 * 端点: POST /v1/chat/completions
 * 认证: api-key header
 * 模型: mimo-v2.5-tts (默认，预置音色)
 *       mimo-v2.5-tts-voicedesign (文本设计音色)
 *       mimo-v2.5-tts-voiceclone (音频复刻音色)
 *
 * 预置音色: mimo_default, 冰糖, 茉莉, 苏打, 白桦, Mia, Chloe, Milo, Dean
 *
 * 响应: choices[0].message.audio.data (base64 编码的音频)
 */
import type { TTSProviderAdapter } from './types'
import { joinProviderUrl } from './url'

export interface TTSParams {
  text: string
  voice: string
  speed?: number
  model?: string
  emotion?: string
}

export interface TTSResult {
  audioHex: string
  audioLength: number
  sampleRate: number
  bitrate: number
  format: string
  channel: number
}

const PRESET_VOICES = [
  'mimo_default', '冰糖', '茉莉', '苏打', '白桦',
  'Mia', 'Chloe', 'Milo', 'Dean',
]

const DEFAULT_MODEL = 'mimo-v2.5-tts'

export class XiaomiTTSAdapter implements TTSProviderAdapter {
  readonly provider = 'xiaomi'

  buildGenerateRequest(config: any, params: TTSParams): {
    url: string
    method: string
    headers: Record<string, string>
    body: any
  } {
    const url = joinProviderUrl(config.baseUrl, '/v1', '/chat/completions')
    const model = params.model || config.model || DEFAULT_MODEL

    const headers: Record<string, string> = {
      'api-key': config.apiKey,
      'Content-Type': 'application/json',
    }

    const messages: any[] = []

    if (params.emotion) {
      messages.push({ role: 'user', content: params.emotion })
    }

    messages.push({ role: 'assistant', content: params.text })

    const body: any = {
      model,
      messages,
      audio: {
        format: 'wav',
        voice: params.voice,
      },
    }

    return { url, method: 'POST', headers, body }
  }

  parseResponse(result: any): TTSResult {
    const audioData = result.choices?.[0]?.message?.audio?.data
    if (!audioData) {
      throw new Error('No audio data in XiaoMi TTS response')
    }

    const audioBuffer = Buffer.from(audioData, 'base64')

    return {
      audioHex: audioBuffer.toString('hex'),
      audioLength: audioBuffer.length,
      sampleRate: 24000,
      bitrate: 128000,
      format: 'wav',
      channel: 1,
    }
  }
}
