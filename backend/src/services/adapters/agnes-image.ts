/**
 * Agnes Image 图片生成 Adapter
 * 端点: /v1/images/generations
 * 
 * 与 OpenAI DALL-E 的关键差异：
 * 1. response_format 必须放在 extra_body 内，不能放顶层
 * 2. 图生图参考图放在 extra_body.image 数组中
 * 3. 文生图 Base64 使用 return_base64: true，图生图 Base64 使用 extra_body.response_format: "b64_json"
 * 
 * 响应格式与 DALL-E 兼容：{ data: [{ url: "..." }] } 或 { data: [{ b64_json: "..." }] }
 */
import type {
  ImageProviderAdapter,
  ProviderRequest,
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
} from './types'
import { joinProviderUrl } from './url'

export class AgnesImageAdapter implements ImageProviderAdapter {
  provider = 'agnes'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const size = record.size || '1024x768'

    const body: any = {
      model: record.model || 'agnes-image-2.1-flash',
      prompt: record.prompt,
      size,
    }

    const extraBody: any = {}

    const referenceImages = this.parseReferenceImages(record.referenceImages)
    if (referenceImages.length > 0) {
      extraBody.image = referenceImages
    }

    // 只有 extra_body 内有实际内容时才添加
    if (Object.keys(extraBody).length > 0) {
      body.extra_body = extraBody
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/images/generations'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    // 优先检查同步响应：data[0].url 或 data[0].b64_json
    const imageUrl = result.data?.[0]?.url
    if (imageUrl) {
      return { isAsync: false, imageUrl }
    }
    const b64 = result.data?.[0]?.b64_json
    if (b64) {
      return { isAsync: false, imageUrl: undefined }
    }
    // 兼容 result.url 格式
    if (result.url) {
      return { isAsync: false, imageUrl: result.url }
    }
    // 只有明确有 task_id 且没有 url 时才认为是异步模式
    if (result.task_id) {
      return { isAsync: true, taskId: result.task_id }
    }
    // result.id 是响应对象本身的 ID，不是异步任务 ID，不作为异步判断依据
    throw new Error('No image URL in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '/v1', `/images/task/${taskId}`),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): ImagePollResponse {
    if (result.status === 'completed') {
      return {
        status: 'completed',
        imageUrl: result.image_url || result.data?.[0]?.url || null,
      }
    }
    if (result.status === 'failed') {
      return { status: 'failed', error: result.error?.message || 'Generation failed' }
    }
    return { status: result.status || 'processing' }
  }

  extractImageUrl(result: any): string | null {
    return result.data?.[0]?.url || result.image_url || null
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    const b64 = result.data?.[0]?.b64_json
    if (b64) {
      return { data: b64, mimeType: 'image/png' }
    }
    return null
  }

  private parseReferenceImages(raw: string | null | undefined): string[] {
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.map((item: any) => String(item || '').trim()).filter(Boolean)
    } catch {
      return []
    }
  }
}
