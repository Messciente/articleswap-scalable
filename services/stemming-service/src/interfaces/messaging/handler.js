import { StemArticle } from '../../usecases/StemArticle.js';

export function createArticleHandler({ eventPublisher, kafkaConsumer, topicEnsurer, consumeTopic, produceTopic, processingRepository, logger = console }) {
  const useCase = new StemArticle();

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
            await processingRepository.markStemmed(article.id, result.stemmedContent);
          }
          await eventPublisher.publish({
            topic: produceTopic,
            key: article.id,
            value: result
          });
          logger.log(`[stemming-service] processed ${article.id} → ${article.receiver}`);
        }
      });
      logger.log(`[stemming-service] consuming "${consumeTopic}" → producing "${produceTopic}"`);
    }
  };
}
