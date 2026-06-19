export class PostgresDeliveryRepository {
  constructor({ pool }) {
    if (!pool) throw new Error('PostgresDeliveryRepository requires a pg.Pool');
    this.pool = pool;
  }

  async markDelivered(articleId, receiver) {
    await this.pool.query('BEGIN');
    try {
      await this.pool.query(
        `INSERT INTO article_delivery (article_id, receiver, delivered_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (article_id, receiver)
         DO UPDATE SET delivered_at = EXCLUDED.delivered_at`,
        [articleId, receiver]
      );
      await this.pool.query(
        `UPDATE articles SET status = 'DELIVERED', updated_at = NOW() WHERE id = $1`,
        [articleId]
      );
      await this.pool.query('COMMIT');
    } catch (error) {
      await this.pool.query('ROLLBACK');
      throw error;
    }
  }
}
