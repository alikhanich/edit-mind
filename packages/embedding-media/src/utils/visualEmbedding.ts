import { createVectorDbClient } from '@vector/services/client'
import { VISUAL_BATCH_SIZE } from '@shared/constants/embedding'
import { logger } from '@shared/services/logger'
import { existsSync } from 'fs'
import { embedSceneFrames } from '../services'
import type { Scene } from '@shared/types'
import { sceneToVectorFormat } from '@vector/utils/shared'
import { embedVisuals } from '@embedding-media/services/embed'

export const embedVisualScenes = async (
  scenes: Scene[],
  videoFullPath: string,
  onProgress?: (batchIndex: number, totalBatches: number) => Promise<void>
): Promise<void> => {
  try {
    const { visual_collection } = await createVectorDbClient()
    if (!visual_collection) {
      throw new Error('Visual Collection not initialized')
    }

    const totalBatches = Math.ceil(scenes.length / VISUAL_BATCH_SIZE)
    for (let i = 0; i < scenes.length; i += VISUAL_BATCH_SIZE) {
      const batch = scenes.slice(i, i + VISUAL_BATCH_SIZE)
      const batchNumber = i / VISUAL_BATCH_SIZE + 1
      logger.info(`Processing batch ${batchNumber}, scenes ${i} to ${i + batch.length - 1}`)

      // Step 1: use pre-saved thumbnails from frame analysis — no ffmpeg extraction needed
      const keyframesBatch = batch.map((scene) => {
        const thumbnail = scene.thumbnailUrl
        if (thumbnail && existsSync(thumbnail)) return [thumbnail]
        return []
      })

      // Step 2: embed sequentially — prevents competing GPU kernel launches across scenes
      const visualEmbeddingsResults = []
      for (let j = 0; j < batch.length; j++) {
        const scene = batch[j]
        const keyframes = keyframesBatch[j]
        try {
          const { metadata, id } = await sceneToVectorFormat(scene)
          const embedding = keyframes.length > 0 ? await embedSceneFrames(keyframes) : null
          visualEmbeddingsResults.push({ id, embedding, metadata, success: true })
        } catch (error) {
          logger.error(`Failed to process visual embedding for scene ${scene.id}: ${error}`)
          visualEmbeddingsResults.push({ id: scene.id, embedding: null, metadata: {}, success: false })
        }
      }

      const validVisualEmbeddings = visualEmbeddingsResults.filter((r) => r.success && r.embedding)

      if (validVisualEmbeddings.length === 0) {
        logger.warn(`No valid visual embeddings found for batch ${i / VISUAL_BATCH_SIZE + 1}, skipping...`)
        continue
      }

      logger.info(`Storing ${validVisualEmbeddings.length} visual embeddings`)
      await embedVisuals(
        validVisualEmbeddings.map((doc) => ({
          id: doc.id,
          metadata: doc.metadata,
          embedding: doc.embedding!,
        }))
      )

      logger.info(`Batch ${batchNumber}/${totalBatches} complete`)

      if (onProgress) {
        await onProgress(batchNumber, totalBatches)
      }
    }
  } catch (err) {
    logger.error(`Error in embedVisualScenes for ${videoFullPath}: ${err}`)
    throw err
  }
}
