export class PostgresProcessingRepository {
  constructor({ pool }) {
    if (!pool) throw new Error('PostgresProcessingRepository requires a pg.Pool');
    this.pool = pool;
  }

  async markWordcloudGenerated(articleId, wordcloudUrl) {
    await this.pool.query('BEGIN');
    try {
      await this.pool.query(
        `INSERT INTO article_processing (article_id, stage, wordcloud_url, processed_at)
         VALUES ($1, 'WORDCLOUD_GENERATED', $2, NOW())
         ON CONFLICT (article_id, stage)
         DO UPDATE SET wordcloud_url = EXCLUDED.wordcloud_url, processed_at = NOW()`,
        [articleId, wordcloudUrl]
      );
      await this.pool.query(
        `UPDATE articles SET status = 'WORDCLOUD_GENERATED', updated_at = NOW() WHERE id = $1`,
        [articleId]
      );
      await this.pool.query('COMMIT');
    } catch (error) {
      await this.pool.query('ROLLBACK');
      throw error;
    }
  }
}
