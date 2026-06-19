import pg from 'pg';

/**
 * Postgres-backed article repository. Concrete implementation of the
 * `articleRepository` port used by SubmitArticle + GetArticle use cases.
 */
export class PostgresArticleRepository {
  constructor({ pool }) {
    if (!pool) throw new Error('PostgresArticleRepository requires a pg.Pool');
    this.pool = pool;
  }

  /**
   * Insert a new article row. Returns the persisted row.
   * Throws an error with `code === '23505'` (Postgres unique violation)
   * if the articleId already exists.
   *
   * @param {Article} article Article domain entity.
   * @returns {Promise<object>} Persisted row from DB.
   */
  async create(article) {
    const fileData = article.file?.data ?? null;
    const fileName = article.file?.name ?? null;
    const fileSize = fileData ? Math.floor((fileData.length * 3) / 4) : null; // base64 → bytes approx

    const sql = `
      INSERT INTO articles
        (id, title, content, file_name, file_data, file_size, sender, receiver, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, title, content, file_name, file_size, sender, receiver, status, created_at, updated_at
    `;
    const values = [
      article.id,
      article.title,
      article.content || null,
      fileName,
      fileData,
      fileSize,
      article.sender,
      article.receiver,
      'PENDING'
    ];
    const result = await this.pool.query(sql, values);
    return result.rows[0];
  }

  /**
   * Find article by primary key. Returns null if not found.
   *
   * @param {string} id Article UUID.
   * @returns {Promise<object|null>} Article row (file_data included) or null.
   */
  async findById(id) {
    const result = await this.pool.query(
      `SELECT a.id, a.title, a.content, a.file_name, a.file_data, a.file_size,
              a.sender, a.receiver, a.status, a.created_at, a.updated_at,
              stemmed.stemmed_content,
              wordcloud.wordcloud_url,
              delivery.delivered_at,
              delivery.read_at
         FROM articles a
         LEFT JOIN article_processing stemmed
           ON stemmed.article_id = a.id AND stemmed.stage = 'STEMMED'
         LEFT JOIN article_processing wordcloud
           ON wordcloud.article_id = a.id AND wordcloud.stage = 'WORDCLOUD_GENERATED'
         LEFT JOIN article_delivery delivery
           ON delivery.article_id = a.id AND delivery.receiver = a.receiver
        WHERE a.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Update article status. Used by downstream services (stemming, wordcloud,
   * forwarding-inbox) to mark progression.
   *
   * @param {string} id Article UUID.
   * @param {string} status New status (PENDING|STEMMED|WORDCLOUD_GENERATED|DELIVERED|FAILED).
   * @returns {Promise<number>} Rows affected (0 or 1).
   */
  async updateStatus(id, status) {
    const result = await this.pool.query(
      `UPDATE articles
          SET status = $1, updated_at = NOW()
        WHERE id = $2`,
      [status, id]
    );
    return result.rowCount;
  }

  /**
   * List articles with optional filters + pagination.
   * Heavy `file_data` column is excluded from the result set to keep
   * responses small.
   *
   * @param {object} [opts]
   * @param {number} [opts.limit=20] Max rows to return (1-100).
   * @param {number} [opts.offset=0] Rows to skip.
   * @param {string} [opts.sender]   Filter by sender.
   * @param {string} [opts.receiver] Filter by receiver.
   * @param {string} [opts.status]   Filter by status.
   * @returns {Promise<object[]>} Article rows ordered by created_at desc.
   */
  async list({ limit = 20, offset = 0, sender, receiver, status } = {}) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const safeOffset = Math.max(0, Number(offset) || 0);

    const result = await this.pool.query(
      `SELECT a.id, a.title, a.sender, a.receiver, a.status,
              a.file_name, a.file_size, a.created_at, a.updated_at,
              (a.file_data IS NOT NULL) AS has_file,
              wordcloud.wordcloud_url,
              stemmed.stemmed_content,
              delivery.delivered_at
         FROM articles a
         LEFT JOIN article_processing stemmed
           ON stemmed.article_id = a.id AND stemmed.stage = 'STEMMED'
         LEFT JOIN article_processing wordcloud
           ON wordcloud.article_id = a.id AND wordcloud.stage = 'WORDCLOUD_GENERATED'
         LEFT JOIN article_delivery delivery
           ON delivery.article_id = a.id AND delivery.receiver = a.receiver
        WHERE ($1::text IS NULL OR a.sender   = $1)
          AND ($2::text IS NULL OR a.receiver = $2)
          AND ($3::text IS NULL OR a.status   = $3)
        ORDER BY a.created_at DESC
        LIMIT $4 OFFSET $5`,
      [sender || null, receiver || null, status || null, safeLimit, safeOffset]
    );
    return result.rows;
  }

  /**
   * Count total rows matching the given filters (for pagination metadata).
   *
   * @param {object} [opts] Same filters as `list()`.
   * @returns {Promise<number>}
   */
  async count({ sender, receiver, status } = {}) {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS total
         FROM articles
        WHERE ($1::text IS NULL OR articles.sender   = $1)
          AND ($2::text IS NULL OR articles.receiver = $2)
          AND ($3::text IS NULL OR articles.status   = $3)`,
      [sender || null, receiver || null, status || null]
    );
    return result.rows[0].total;
  }

  /**
   * Closes the underlying pool. Called on graceful shutdown.
   */
  async close() {
    await this.pool.end();
  }
}
