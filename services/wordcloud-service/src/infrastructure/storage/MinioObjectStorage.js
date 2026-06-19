import { Client } from 'minio';

export class MinioObjectStorage {
  constructor({ endPoint, port, useSSL, accessKey, secretKey, bucket }) {
    this.client = new Client({
      endPoint: endPoint || 'localhost',
      port: Number(port) || 9000,
      useSSL: useSSL === true || useSSL === 'true',
      accessKey,
      secretKey
    });
    this.bucket = bucket;
  }

  async upload(objectName, buffer, metaData = {}) {
    await this.client.putObject(this.bucket, objectName, buffer, buffer.length, metaData);
  }

  publicUrl(objectName, publicBaseUrl) {
    return `${publicBaseUrl}/${this.bucket}/${objectName}`;
  }
}
