import test from 'node:test';
import assert from 'node:assert/strict';

import { createArticleHandler } from '../src/interfaces/messaging/handler.js';
import {
  detectTokenLanguage,
  StemArticle,
  stemMixedLanguageText,
  stemToken,
  tokenizeText
} from '../src/usecases/StemArticle.js';

test('tokenizeText keeps readable punctuation and technical chunks', () => {
  assert.deepEqual(tokenizeText('API, Kafka 3.7, https://example.com/a?b=1'), [
    'API',
    ',',
    ' ',
    'Kafka',
    ' ',
    '3.7',
    ',',
    ' ',
    'https://example.com/a?b=1'
  ]);
});

test('stems Indonesian article with SastrawiJS', () => {
  assert.equal(stemMixedLanguageText('Pengembangan aplikasi sangat menyenangkan.'), 'kembang aplikasi sangat senang.');
  assert.equal(detectTokenLanguage('pengembangan'), 'id');
});

test('stems English article with Porter stemmer', () => {
  assert.equal(stemMixedLanguageText('Users can share articles quickly.'), 'user can share article quick.');
  assert.equal(detectTokenLanguage('quickly'), 'en');
});

test('stems mixed Indonesian and English per token', () => {
  assert.equal(
    stemMixedLanguageText('Pengembangan aplikasi scalable sangat menyenangkan karena users can share articles quickly.'),
    'kembang aplikasi scalable sangat senang karena user can share article quick.'
  );
});

test('does not stem technical terms, numbers, URLs, emails, code-like tokens, or symbols', () => {
  const input = 'API Kafka Redis Docker PostgreSQL storage recycle worker-1 test@example.com https://example.com const user_id = 42;';

  assert.equal(stemMixedLanguageText(input), input);
  assert.equal(stemToken('scalable'), 'scalable');
  assert.equal(stemToken('Kafka'), 'Kafka');
  assert.equal(stemToken('storage'), 'storage');
  assert.equal(stemToken('recycle'), 'recycle');
});

test('StemArticle usecase writes mixed-language stemmedContent', async () => {
  const result = await new StemArticle().execute({
    id: 'article-1',
    content: 'Pengembangan aplikasi scalable sangat menyenangkan karena users can share articles quickly.'
  });

  assert.equal(result.stemmedContent, 'kembang aplikasi scalable sangat senang karena user can share article quick.');
  assert.equal(typeof result.stemmedAt, 'string');
});

test('Kafka handler preserves existing topics, stores stemmed content, and publishes article-stemmed event', async () => {
  const ensuredTopics = [];
  const publishedEvents = [];
  const storedStemmedContent = [];
  let subscribedTopic = '';
  let subscribedHandler = null;

  const handler = createArticleHandler({
    consumeTopic: 'article-submissions',
    produceTopic: 'article-stemmed',
    topicEnsurer: {
      ensure: async (topic) => ensuredTopics.push(topic)
    },
    kafkaConsumer: {
      subscribe: async ({ topic, handler: articleHandler }) => {
        subscribedTopic = topic;
        subscribedHandler = articleHandler;
      }
    },
    processingRepository: {
      markStemmed: async (articleId, stemmedContent) => storedStemmedContent.push({ articleId, stemmedContent })
    },
    eventPublisher: {
      publish: async (event) => publishedEvents.push(event)
    },
    logger: { log: () => {} }
  });

  await handler.start();
  await subscribedHandler({
    id: 'article-1',
    receiver: 'wordcloud-service',
    content: 'Pengembangan aplikasi scalable sangat menyenangkan karena users can share articles quickly.'
  });

  assert.deepEqual(ensuredTopics, ['article-submissions', 'article-stemmed']);
  assert.equal(subscribedTopic, 'article-submissions');
  assert.deepEqual(storedStemmedContent, [{
    articleId: 'article-1',
    stemmedContent: 'kembang aplikasi scalable sangat senang karena user can share article quick.'
  }]);
  assert.equal(publishedEvents.length, 1);
  assert.equal(publishedEvents[0].topic, 'article-stemmed');
  assert.equal(publishedEvents[0].key, 'article-1');
  assert.equal(publishedEvents[0].value.stemmedContent, 'kembang aplikasi scalable sangat senang karena user can share article quick.');
});
