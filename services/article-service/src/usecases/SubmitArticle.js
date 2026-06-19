import { Article, ValidationError } from '../domain/Article.js';
import { extractPdfText } from '../infrastructure/pdf/extractPdfText.js';

export class SubmitArticle {
  constructor({ eventPublisher, articleRepository }) {
    this.eventPublisher = eventPublisher;
    this.articleRepository = articleRepository;
  }

  async execute(payload) {
    if (!payload?.title || (!payload.content && !payload.fileData) || !payload.sender || !payload.receiver) {
      throw new ValidationError('Missing required fields: title, sender, receiver, and either content or a file');
    }

    const normalizedPayload = { ...payload };
    if (normalizedPayload.fileData && !normalizedPayload.content) {
      normalizedPayload.content = await extractPdfText(normalizedPayload.fileData);
      if (!normalizedPayload.content) {
        throw new ValidationError('PDF text extraction returned empty content');
      }
    }

    const article = Article.fromSubmitPayload(normalizedPayload);
    if (payload.articleId) {
      article.id = payload.articleId;
    }

    if (this.articleRepository) {
      try {
        await this.articleRepository.create(article);
      } catch (err) {
        if (err.code === '23505') {
          const dup = new Error(`Article ID ${article.id} already exists`);
          dup.code = 'DUPLICATE_ARTICLE';
          dup.status = 409;
          throw dup;
        }
        throw err;
      }
    }

    try {
      await this.eventPublisher.publish({
        topic: process.env.KAFKA_TOPIC || 'article-submissions',
        key: article.id,
        value: article.toEventPayload()
      });
    } catch (err) {
      if (this.articleRepository) {
        await this.articleRepository.updateStatus(article.id, 'FAILED').catch(() => {});
      }
      throw err;
    }

    return { articleId: article.id };
  }
}
