import { GenerateWordCloud } from '../../usecases/GenerateWordCloud.js';
import { MinioObjectStorage } from '../../infrastructure/storage/MinioObjectStorage.js';

export function createArticleHandler({ eventPublisher, kafkaConsumer, topicEnsurer, consumeTopic, produceTopic, publicBaseUrl, processingRepository, logger = console }) {
  const objectStorage = new MinioObjectStorage({
    endPoint: process.env.MINIO_ENDPOINT,
    port: process.env.MINIO_PORT,
    useSSL: process.env.MINIO_USE_SSL,
    accessKey: process.env.MINIO_ACCESS_KEY,
    secretKey: process.env.MINIO_SECRET_KEY,
    bucket: process.env.MINIO_BUCKET || 'wordclouds'
  });

  const useCase = new GenerateWordCloud({ objectStorage, publicBaseUrl });

  return {
    async start() {
      await Promise.all([
        topicEnsurer.ensure(consumeTopic),
        topicEnsurer.ensure(produceTopic)
      ]);
      await kafkaConsumer.subscribe({
        topic: consumeTopic,
        handler: async (article) => {
          const result = await useCase.execute(article);
          if (processingRepository) {
            await processingRepository.markWordcloudGenerated(article.id, result.wordcloudUrl);
          }
          await eventPublisher.publish({
            topic: produceTopic,
            key: article.id,
            value: result
          });
          logger.log(`[wordcloud-service] generated ${article.id} → ${result.wordcloudUrl}`);
        }
      });
      logger.log(`[wordcloud-service] consuming "${consumeTopic}" → producing "${produceTopic}"`);
    }
  };
}
