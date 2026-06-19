export class CircuitBreaker {
  constructor({ failureThreshold = 3, cooldownMs = 10_000, now = Date.now } = {}) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.failureCount = 0;
    this.openedAt = 0;
  }

  async execute(operation) {
    if (this.isOpen()) {
      const error = new Error('Kafka publisher circuit breaker is open');
      error.code = 'CIRCUIT_OPEN';
      throw error;
    }

    try {
      const result = await operation();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  isOpen() {
    return this.openedAt > 0 && this.now() - this.openedAt < this.cooldownMs;
  }

  recordSuccess() {
    this.failureCount = 0;
    this.openedAt = 0;
  }

  recordFailure() {
    this.failureCount += 1;
    if (this.failureCount >= this.failureThreshold) {
      this.openedAt = this.now();
    }
  }
}
