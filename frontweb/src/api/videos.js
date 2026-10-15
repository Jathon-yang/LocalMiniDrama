import request from '@/utils/request'

export const videosAPI = {
  list(params) {
    return request.get('/videos', { params: params || {} })
  },
  /** 创建单条分镜视频生成任务，body: { drama_id, storyboard_id, prompt, image_url?, model?, ... } */
  create(body) {
    return request.post('/videos', body)
  },
  /** 失败后复用已存上游 task 继续轮询，返回 video_generations 记录（含 task_id） */
  resumePoll(id) {
    return request.post(`/videos/${id}/resume-poll`)
  },
  /**
   * 手动上传视频替换分镜视频。需传 File 对象和 storyboard_id。
   * @param {File} file
   * @param {{ storyboardId: number|string, dramaId?: number|string, prompt?: string }} opts
   */
  uploadManual(file, opts = {}) {
    const form = new FormData()
    form.append('file', file)
    form.append('storyboard_id', String(opts.storyboardId))
    if (opts.dramaId != null && opts.dramaId !== '') form.append('drama_id', String(opts.dramaId))
    if (opts.prompt) form.append('prompt', String(opts.prompt))
    return request.post('/videos/upload-manual', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
}
