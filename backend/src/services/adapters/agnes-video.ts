/**
 * Agnes Video V2.0 视频生成 Adapter
 * 创建任务: POST /v1/videos
 * 获取结果（推荐）: GET /agnesapi?video_id=xxx
 * 获取结果（兼容旧版）: GET /v1/videos/{task_id}
 * 模型: agnes-video-v2.0
 */
import type {
  VideoProviderAdapter,
  ProviderRequest,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'
import { joinProviderUrl } from './url'

export class AgnesVideoAdapter implements VideoProviderAdapter {
  provider = 'agnes'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const model = record.model || config.model || 'agnes-video-v2.0'

    const body: any = {
      model,
      prompt: record.prompt || '',
    }

    if (record.referenceMode === 'single' && record.imageUrl) {
      body.image = record.imageUrl
    } else if (record.referenceMode === 'first_last') {
      const images: string[] = []
      if (record.firstFrameUrl) images.push(record.firstFrameUrl)
      if (record.lastFrameUrl) images.push(record.lastFrameUrl)
      if (images.length > 0) {
        body.extra_body = {
          image: images,
          mode: 'keyframes',
        }
      }
    } else if (record.referenceMode === 'multiple' && record.referenceImageUrls) {
      try {
        const refs = JSON.parse(record.referenceImageUrls)
        if (Array.isArray(refs) && refs.length > 0) {
          body.extra_body = {
            image: refs,
            mode: 'keyframes',
          }
        }
      } catch {}
    }

    const aspectRatio = record.aspectRatio || '16:9'
    const [w, h] = this.parseAspectRatio(aspectRatio)
    body.width = w
    body.height = h

    // 根据分辨率限制最大帧数
    const maxFrames = this.getMaxFrames(w, h)
    body.num_frames = this.computeNumFrames(record.duration, maxFrames)
    body.frame_rate = 24

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/videos'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    if (result.id || result.task_id || result.video_id) {
      return {
        isAsync: true,
        taskId: result.video_id || result.task_id || result.id,
      }
    }
    const videoUrl = result.url || result.video_url
    if (videoUrl) {
      return { isAsync: false, videoUrl }
    }
    throw new Error('No task_id or video_id in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    const url = joinProviderUrl(config.baseUrl, '', '/agnesapi')
    return {
      url: `${url}?video_id=${taskId}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const status = result.status
    if (status === 'completed') {
      return {
        status: 'completed',
        videoUrl: result.url || result.video_url || null,
      }
    }
    if (status === 'failed') {
      return { status: 'failed', error: result.error?.message || result.error || 'Video generation failed' }
    }
    return { status: status || 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    return result.url || result.video_url || null
  }

  private getMaxFrames(width: number, height: number): number {
    // 根据分辨率限制最大帧数
    const maxDim = Math.max(width, height)
    if (maxDim >= 1920) return 241  // 1080p
    if (maxDim >= 1280) return 481  // 720p
    return 961  // 480p
  }

  private computeNumFrames(duration?: number | null, maxFrames: number = 241): number {
    const seconds = Math.round(Number(duration || 5))
    const targetFrames = Math.min(maxFrames, Math.max(9, seconds * 24))
    return this.nearest8n1(targetFrames, maxFrames)
  }

  private nearest8n1(target: number, maxFrames: number = 441): number {
    // num_frames must follow 8n+1 rule and be <= maxFrames
    const n = Math.round((target - 1) / 8)
    return Math.min(maxFrames, Math.max(9, n * 8 + 1))
  }

  private parseAspectRatio(ratio: string): [number, number] {
    switch (ratio) {
      case '1:1': return [1080, 1080]
      case '4:3': return [1440, 1080]
      case '3:4': return [1080, 1440]
      case '9:16': return [1080, 1920]
      default: return [1920, 1080]
    }
  }
}
