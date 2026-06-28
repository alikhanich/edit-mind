import { readFileSync } from 'fs'

import { createVectorDbClient } from '@vector/services/client'

import { AUDIO_BATCH_SIZE } from '@shared/constants/embedding'
import { logger } from '@shared/services/logger'
import { cleanupAudio, extractFullAudioRaw, hasAudioStream } from '@media-utils/utils/audio'
import { embedAudioData } from '../services'
import type { Scene } from '@shared/types'
import { sceneToVectorFormat } from '@vector/utils/shared'
import { embedAudios } from '@embedding-media/services/embed'

const SAMPLE_RATE = 48000

export const embedAudioScenes = async (
  scenes: Scene[],
  videoFullPath: string,
  onProgress?: (batchIndex: number, totalBatches: number) => Promise<void>
): Promise<void> => {
  try {
    const { audio_collection } = await createVectorDbClient()

    if (!audio_collection) {
      throw new Error('Audio Collection not initialized')
    }

    const hasAudio = await hasAudioStream(videoFullPath)

    if (!hasAudio) {
      logger.warn(`Skipped audio embedding for "${videoFullPath}" because no audio track was found.`)
      return
    }

    const fullAudioPath = await extractFullAudioRaw(videoFullPath, SAMPLE_RATE)
    let fullAudio: Float32Array
    try {
      const buf = readFileSync(fullAudioPath)
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      fullAudio = new Float32Array(ab)
    } finally {
      await cleanupAudio(fullAudioPath)
    }

    const totalBatches = Math.ceil(scenes.length / AUDIO_BATCH_SIZE)
    for (let i = 0; i < scenes.length; i += AUDIO_BATCH_SIZE) {
      const batch = scenes.slice(i, i + AUDIO_BATCH_SIZE)
      const batchNumber = i / AUDIO_BATCH_SIZE + 1

      logger.info(`Processing ${batch.length} scenes for audio embeddings`)

      const audioEmbeddingsPromise = batch.map(async (scene) => {
        try {
          const startSample = Math.floor(scene.startTime * SAMPLE_RATE)
          const endSample = Math.floor(scene.endTime * SAMPLE_RATE)
          const slice = fullAudio.slice(startSample, endSample)

          const embedding = await embedAudioData(slice)
          const { metadata, id } = await sceneToVectorFormat(scene)

          return { id, embedding, metadata, success: true }
        } catch (error) {
          logger.error(`Failed to process audio embedding for ${scene.id}: ${error}`)
          return { id: scene.id, embedding: null, metadata: {}, success: false }
        }
      })

      const audioEmbeddingsResults = await Promise.all(audioEmbeddingsPromise)
      const validAudioEmbeddings = audioEmbeddingsResults.filter((r) => r.success && r.embedding)

      if (validAudioEmbeddings.length === 0) {
        logger.warn(`No valid Audio embeddings found for batch ${i / AUDIO_BATCH_SIZE + 1}, skipping...`)
        continue
      }

      logger.info(`Storing ${validAudioEmbeddings.length} audio embeddings`)
      await embedAudios(
        validAudioEmbeddings.map((doc) => ({
          id: doc.id,
          metadata: doc.metadata,
          embedding: doc.embedding!,
        }))
      )
      logger.info(`Batch ${batchNumber}/${totalBatches} complete: ${validAudioEmbeddings.length} audio embeddings stored`)

      if (onProgress) {
        await onProgress(batchNumber, totalBatches)
      }
    }
  } catch (err) {
    logger.error(`Error in embedAudioScenes for ${videoFullPath}: ${err}`)
    throw err
  }
}
