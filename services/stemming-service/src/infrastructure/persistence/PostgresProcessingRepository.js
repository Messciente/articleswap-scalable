export class PostgresProcessingRepository {
  constructor({ pool }) {
    if (!pool) throw new Error('PostgresProcessingRepository requires a pg.Pool');
    this.pool = pool;
  }

  async markStemmed(articleId, stemmedContent) {
    await this.pool.query('BEGIN');
    try {
      await this.pool.query(
        `INSERT INTO article_processing (article_id, stage, stemmed_content, processed_at)
         VALUES ($1, 'STEMMED', $2, NOW())
         ON CONFLICT (article_id, stage)
         DO UPDATE SET stemmed_content = EXCLUDED.stemmed_content, processed_at = NOW()`,
        [articleId, stemmedContent]
      );
      await this.pool.query(
        `UPDATE articles SET status = 'STEMMED', updated_at = NOW() WHERE id = $1`,
        [articleId]
      );
      await this.pool.query('COMMIT');
    } catch (error) {
      await this.pool.query('ROLLBACK');
      throw error;
    }
  }
}
