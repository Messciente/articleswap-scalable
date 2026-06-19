import { Router } from 'express';
import { z } from 'zod';

const ArticleSubmissionSchema = z.object({
  articleId: z.string().uuid().optional(),
  title:     z.string().min(1, 'title is required').max(255, 'title too long (max 255)'),
  content:   z.string().optional(),
  fileData:  z.string().optional(),
  fileName:  z.string().max(255).optional(),
  sender:    z.string().min(1, 'sender is required').max(50),
  receiver:  z.string().min(1, 'receiver is required').max(50)
}).refine(
  (d) => Boolean(d.content) || Boolean(d.fileData),
  { message: 'Either content or fileData must be provided' }
).refine(
  (d) => !d.fileData || (d.fileName && d.fileName.toLowerCase().endsWith('.pdf')),
  { message: 'Uploaded file must be a PDF', path: ['fileName'] }
);

const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * HTTP routes for article submission + retrieval.
 *
 * POST /api/articles       — submit new article (text or file)
 * GET  /api/articles       — list articles (filters: sender, receiver, status)
 * GET  /api/articles/:id   — fetch by id (sans file_data to keep response light)
 */
export function createArticlesRoute({ submitArticleUseCase, getArticleUseCase, listArticlesUseCase, readCache }) {
  const router = Router();

  router.post('/articles', async (req, res) => {
    const parsed = ArticleSubmissionSchema.safeParse(req.body);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; ');
      return res.status(400).json({ error: 'Invalid request body', issues });
    }

    // Server-side file size guard (base64 inflates ~33%)
    if (parsed.data.fileData) {
      const approxBytes = Math.floor((parsed.data.fileData.length * 3) / 4);
      if (approxBytes > MAX_FILE_BYTES) {
        return res.status(413).json({
          error: `File too large (${(approxBytes / 1024 / 1024).toFixed(2)} MB, max ${MAX_FILE_BYTES / 1024 / 1024} MB)`
        });
      }
    }

    try {
      const result = await submitArticleUseCase.execute(parsed.data);
      readCache?.deleteWhere((key) => key.startsWith('list:'));
      return res.status(202).json({
        message: 'Article submitted successfully',
        articleId: result.articleId,
        status: 'PENDING'
      });
    } catch (error) {
      if (error.code === 'DUPLICATE_ARTICLE') {
        return res.status(409).json({ error: error.message });
      }
      const status = error.status || 500;
      const body = { error: status >= 500 ? 'Internal server error' : error.message };
      console.error('[articles-route] submit error:', error);
      return res.status(status).json(body);
    }
  });

  router.get('/articles', async (req, res) => {
    if (!listArticlesUseCase) {
      return res.status(503).json({ error: 'ListArticles use case not available' });
    }
    try {
      const cacheKey = `list:${JSON.stringify(req.query)}`;
      const cached = readCache?.get(cacheKey);
      if (cached) return res.json({ ...cached, cached: true });

      const { limit, offset, sender, receiver, status } = req.query;
      const result = await listArticlesUseCase.execute({
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
        sender: sender || undefined,
        receiver: receiver || undefined,
        status: status || undefined
      });
      readCache?.set(cacheKey, result);
      return res.json(result);
    } catch (error) {
      const status = error.status || 500;
      const body = { error: status >= 500 ? 'Internal server error' : error.message };
      return res.status(status).json(body);
    }
  });

  router.get('/articles/:id', async (req, res) => {
    try {
      const cacheKey = `article:${req.params.id}`;
      const cached = readCache?.get(cacheKey);
      if (cached) return res.json({ ...cached, cached: true });

      const article = await getArticleUseCase.execute(req.params.id);
      if (!article) {
        return res.status(404).json({ error: 'Article not found' });
      }
      // Strip file_data (heavy base64) — return only metadata.
      const { file_data, ...rest } = article;
      const response = {
        ...rest,
        hasFile: Boolean(file_data),
        fileName: article.file_name
      };
      readCache?.set(cacheKey, response);
      return res.json(response);
    } catch (error) {
      const status = error.status || 500;
      const body = { error: status >= 500 ? 'Internal server error' : error.message };
      return res.status(status).json(body);
    }
  });

  return router;
}
