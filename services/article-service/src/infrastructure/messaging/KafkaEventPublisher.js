import { Kafka, logLevel } from 'kafkajs';
import { CircuitBreaker } from './CircuitBreaker.js';

export class KafkaEventPublisher {
  constructor({ brokers, clientId }) {
    this.brokers = (brokers || 'localhost:9092').split(',');
    this.clientId = clientId || 'publisher';
    this.kafka = new Kafka({ clientId: this.clientId, brokers: this.brokers, logLevel: logLevel.WARN });
    this.producer = null;
    this.breaker = new CircuitBreaker({
      failureThreshold: Number(process.env.KAFKA_CIRCUIT_FAILURE_THRESHOLD) || 3,
      cooldownMs: Number(process.env.KAFKA_CIRCUIT_COOLDOWN_MS) || 10_000
    });
  }

  async connect() {
    if (!this.producer) {
      this.producer = this.kafka.producer();
      await this.producer.connect();
    }
  }

  async publish({ topic, key, value }) {
    await this.breaker.execute(async () => {
      await this.connect();
      return this.producer.send({
        topic,
        messages: [{ key, value: JSON.stringify(value) }]
      });
    });
  }

  async disconnect() {
    if (this.producer) {
      await this.producer.disconnect();
      this.producer = null;
    }
  }
}
