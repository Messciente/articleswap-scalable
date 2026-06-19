import { Kafka, logLevel } from 'kafkajs';

export class KafkaTopicEnsurer {
  constructor({ brokers, clientId }) {
    this.brokers = (brokers || 'localhost:9092').split(',');
    this.clientId = clientId || 'topic-ensurer';
    this.kafka = new Kafka({ clientId: this.clientId, brokers: this.brokers, logLevel: logLevel.WARN });
  }

  async ensure(topic, { partitions = 3, replicationFactor = 1 } = {}) {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const admin = this.kafka.admin();
      try {
        await admin.connect();
        const existing = await admin.listTopics();
        if (!existing.includes(topic)) {
          await admin.createTopics({
            topics: [{ topic, numPartitions: partitions, replicationFactor }],
            waitForLeaders: true
          });
          console.log(`[topic-ensurer] created topic "${topic}" (partitions=${partitions})`);
        } else {
          console.log(`[topic-ensurer] topic "${topic}" already exists`);
        }
        await delay(300);
        return;
      } catch (e) {
        console.error(`[topic-ensurer] failed for "${topic}" attempt ${attempt}:`, e.message);
        if (attempt === 8) throw e;
        await delay(attempt * 500);
      } finally {
        await admin.disconnect().catch(() => {});
      }
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
