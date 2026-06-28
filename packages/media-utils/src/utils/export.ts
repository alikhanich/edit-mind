import type { ExportedScene } from '@shared/types';
import { spawnFFmpeg } from '@media-utils/lib/ffmpeg'
import path from 'path'
import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { logger } from '@shared/services/logger'
import { buildEncodingArgs } from '@media-utils/lib/ffmpegGpu'
import { USE_FFMPEG_GPU } from '@media-utils/constants'
import { validateScenes } from './validation'


export const trimVideoScenes = async (scenes: ExportedScene[], tempExportDir: string): Promise<string[]> => {
  const clipPaths: string[] = []

  if (!existsSync(tempExportDir)) {
    await mkdir(tempExportDir, { recursive: true })
  }

  logger.info(`Trimming ${scenes.length} video scenes (GPU: ${USE_FFMPEG_GPU})`)
  const validatedScenes = validateScenes(scenes)

  for (let i = 0; i < validatedScenes.length; i++) {
    const scene = validatedScenes[i]
    

    const clipPath = path.join(tempExportDir, `scene_${i + 1}_${path.basename(scene.source)}`)
    clipPaths.push(clipPath)

    const encodingArgs = buildEncodingArgs({ encoder: 'h264' })

    const buildArgs = (args: string[]) => [
      '-ss', scene.startTime.toString(),
      '-i', scene.source,
      '-t', (scene.endTime - scene.startTime).toString(),
      ...args,
      '-y', clipPath,
    ]

    const runFFmpeg = (args: string[]): Promise<{ code: number; stderr: string }> =>
      spawnFFmpeg(args).then(
        (proc) =>
          new Promise((resolve, reject) => {
            let stderr = ''
            proc.stderr?.on('data', (d) => { stderr += d.toString() })
            proc.on('close', (code) => resolve({ code: code ?? -1, stderr }))
            proc.on('error', (err) => reject(new Error(`Failed to spawn FFmpeg: ${err.message}`)))
          })
      )

    try {
      let result = await runFFmpeg(buildArgs(encodingArgs))

      if (result.code !== 0 && USE_FFMPEG_GPU) {
        logger.warn(`GPU encoding failed for scene ${i + 1}, retrying with CPU encoder`)
        const cpuArgs = buildEncodingArgs({ encoder: 'h264', forceGPU: false })
        result = await runFFmpeg(buildArgs(cpuArgs))
      }

      if (result.code !== 0) {
        throw new Error(`FFmpeg exited with code ${result.code}: ${result.stderr}`)
      }

      logger.info(`Trimmed scene ${i + 1}/${scenes.length}: ${clipPath}`)
    } catch (error) {
      logger.error({ error }, `Failed to trim scene ${i + 1}`)
      throw error
    }
  }

  logger.info(`Successfully trimmed ${clipPaths.length} scenes`)
  return clipPaths
}