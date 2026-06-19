#!/usr/bin/env node
// Canary deploy: pull + start one service at a time, wait for it to be
// healthy, then move on. Stops on the first failure so the blast radius is
// limited to the current service.
//
// Order respects docker-compose.prod.yml dependencies:
//   1. infrastructure (kafka, postgres, minio, minio-init) — public images, no canary
//   2. article-service
//   3. api-gateway1, api-gateway2
//   4. stemming-service, wordcloud-service, forwarding-inbox-service
//   5. nginx (binds host port 8080)
//
// Usage:
//   node scripts/ensure-images-fresh.mjs
//   IMAGE_TAG=sha-1fe398b node scripts/ensure-images-fresh.mjs
//   SKIP_PULL=1 node scripts/ensure-images-fresh.mjs   # reuse local images
//   FORCE_DEPLOY=1 node scripts/ensure-images-fresh.mjs # deploy even if digests unchanged

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync } from 'node:fs';

const composeFile = process.env.COMPOSE_FILE || 'docker-compose.prod.yml';
const envFile = process.env.ENV_FILE || '.env.prod';
const tag = process.env.IMAGE_TAG || 'latest';
const registry = process.env.IMAGE_REGISTRY || 'ghcr.io';
const namespace = process.env.IMAGE_NAMESPACE || process.env.GITHUB_REPOSITORY_OWNER || 'feinru';
const minFreeBytes = Number(process.env.MIN_FREE_DISK_BYTES || 5 * 1024 * 1024 * 1024);
const hostPlatform = process.env.HOST_PLATFORM || detectHostPlatform();
const skipPull = process.env.SKIP_PULL === '1';
const forceDeploy = process.env.FORCE_DEPLOY === '1';
const healthTimeoutMs = Number(process.env.HEALTH_TIMEOUT_MS || 60_000);
const healthIntervalMs = Number(process.env.HEALTH_INTERVAL_MS || 2_000);

const INFRA_SERVICES = ['kafka', 'postgres', 'minio', 'minio-init'];

const APP_SERVICES = [
  {
    name: 'article-service',
    image: `${registry}/${namespace}/articleswap-article-service:${tag}`,
    health: { type: 'http', url: 'http://article-service:3000/health' }
  },
  {
    name: 'api-gateway1',
    image: `${registry}/${namespace}/articleswap-api-gateway:${tag}`,
    health: { type: 'tcp', host: 'api-gateway1', port: 5173 }
  },
  {
    name: 'api-gateway2',
    image: `${registry}/${namespace}/articleswap-api-gateway:${tag}`,
    health: { type: 'tcp', host: 'api-gateway2', port: 5173 }
  },
  {
    name: 'stemming-service',
    image: `${registry}/${namespace}/articleswap-stemming-service:${tag}`,
    health: { type: 'container', expect: 'running' }
  },
  {
    name: 'wordcloud-service',
    image: `${registry}/${namespace}/articleswap-wordcloud-service:${tag}`,
    health: { type: 'container', expect: 'running' }
  },
  {
    name: 'forwarding-inbox-service',
    image: `${registry}/${namespace}/articleswap-forwarding-inbox-service:${tag}`,
    health: { type: 'container', expect: 'running' }
  },
  {
    name: 'nginx',
    image: `${registry}/${namespace}/articleswap-nginx:${tag}`,
    health: { type: 'tcp', host: 'nginx', port: 8080 }
  }
];

console.log(`[canary] compose=${composeFile} tag=${tag} platform=${hostPlatform}`);

await ensureDiskSpace(minFreeBytes);
await pruneOldImages();

console.log('[canary] step 1/2: bring up infrastructure');
for (const service of INFRA_SERVICES) {
  const result = await runCompose(['up', '-d', '--no-deps', service]);
  if (result.status !== 0) {
    console.error(`[canary] FAILED to start infrastructure service: ${service}`);
    process.exit(result.status || 1);
  }
}

console.log('[canary] waiting for kafka to become healthy');
if (!(await waitComposeHealthy('kafka', healthTimeoutMs))) {
  console.error('[canary] FAILED: kafka never became healthy');
  process.exit(1);
}
console.log('[canary] kafka healthy');

const seenImages = new Set();
const updatedImages = new Set();
let aborted = false;

console.log('[canary] step 2/2: canary deploy each app service');
for (const service of APP_SERVICES) {
  const { name, image, health } = service;
  console.log('');
  console.log(`[canary] >>> ${name} <<<`);

  if (image && !seenImages.has(image)) {
    seenImages.add(image);
    const before = await getLocalDigest(image);
    const changed = forceDeploy || !before || (await pullImage(image)) && before !== (await getLocalDigest(image));
    if (!skipPull) {
      await pullImage(image);
      const after = await getLocalDigest(image);
      if (changed) updatedImages.add(image);
    }
  }

  const upResult = await runCompose(['up', '-d', '--no-deps', name]);
  if (upResult.status !== 0) {
    console.error(`[canary] FAILED to start ${name}`);
    aborted = true;
    break;
  }

  const healthy = await waitHealthy(name, health, healthTimeoutMs);
  if (!healthy) {
    console.error(`[canary] FAILED health check for ${name}`);
    await showServiceLogs(name);
    await stopService(name);
    aborted = true;
    break;
  }
  console.log(`[canary] ${name} OK`);
}

if (aborted) {
  console.error('[canary] aborted — see errors above');
  process.exit(1);
}

if (updatedImages.size === 0 && !forceDeploy) {
  console.log('');
  console.log('[canary] no image digest changed — no service was actually updated');
}

console.log('');
console.log('[canary] summary:');
for (const image of updatedImages) console.log(`  updated ${image}`);
console.log(`[canary] all ${APP_SERVICES.length} services healthy — deploy complete`);

async function pullImage(image) {
  console.log(`[canary] pull ${image}`);
  const result = await run('docker', ['pull', '--platform', hostPlatform, image], { inheritStdio: true });
  if (result.status !== 0) {
    throw new Error(`pull failed for ${image}`);
  }
}

async function waitHealthy(service, health, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (health.type === 'http') {
      const r = await run('curl', ['--max-time', '3', '-fs', '-o', '/dev/null', health.url], { inheritStdio: false });
      if (r.status === 0) return true;
    } else if (health.type === 'tcp') {
      const r = await run('docker', ['compose', '-f', composeFile, 'exec', '-T', service, 'sh', '-c', `</dev/tcp/127.0.0.1/${health.port}`], { inheritStdio: false });
      if (r.status === 0) return true;
    } else if (health.type === 'container') {
      const r = await run('docker', ['inspect', containerName(service), '--format', '{{.State.Status}}']);
      const status = r.stdout.trim();
      if (status === health.expect) return true;
      if (status === 'exited' || status === 'dead') return false;
    }
    process.stdout.write('.');
    await sleep(healthIntervalMs);
  }
  process.stdout.write('\n');
  return false;
}

async function waitComposeHealthy(service, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await run('docker', ['compose', '-f', composeFile, 'ps', '--format', 'json', service]);
    if (r.status === 0 && r.stdout.trim().includes('"Health":"healthy"')) return true;
    process.stdout.write('.');
    await sleep(2000);
  }
  process.stdout.write('\n');
  return false;
}

async function showServiceLogs(service) {
  console.error(`[canary] last logs for ${service}:`);
  await run('docker', ['compose', '-f', composeFile, 'logs', '--tail=50', service], { inheritStdio: true });
}

async function stopService(service) {
  await run('docker', ['compose', '-f', composeFile, 'rm', '-fs', service]);
}

function containerName(service) {
  const map = {
    'article-service': 'articleswap-article-service',
    'api-gateway1': 'articleswap-gateway1',
    'api-gateway2': 'articleswap-gateway2',
    'stemming-service': 'articleswap-stemming-service',
    'wordcloud-service': 'articleswap-wordcloud-service',
    'forwarding-inbox-service': 'articleswap-forwarding-inbox-service',
    'nginx': 'articleswap-nginx'
  };
  return map[service] || `articleswap-${service}`;
}

async function ensureDiskSpace(minBytes) {
  const df = await run('df', ['-B1', '/var/lib/docker']);
  if (df.status !== 0) return;
  const line = df.stdout.split('\n')[1] || '';
  const cols = line.trim().split(/\s+/);
  const available = Number(cols[3]);
  if (Number.isFinite(available) && available < minBytes) {
    console.warn(`[canary] WARNING: only ${formatBytes(available)} free on /var/lib/docker (want ${formatBytes(minBytes)}). Pruning first.`);
  }
}

async function pruneOldImages() {
  console.log('[canary] pruning dangling images, stopped containers, and build cache');
  await run('docker', ['image', 'prune', '-f', '--filter', 'until=24h']);
  await run('docker', ['container', 'prune', '-f', '--filter', 'until=24h']);
  await run('docker', ['builder', 'prune', '-f', '--keep-storage', '1g']);
}

function detectHostPlatform() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  return `linux/${arch}`;
}

async function getLocalDigest(image) {
  const result = await run('docker', ['image', 'inspect', image, '--format', '{{ index .RepoDigests 0 }}']);
  if (result.status !== 0) return null;
  const stdout = result.stdout.trim();
  if (!stdout) return null;
  const at = stdout.lastIndexOf('@');
  return at >= 0 ? stdout.slice(at + 1) : null;
}

function runCompose(args) {
  const cmdArgs = ['compose', '-f', composeFile];
  if (existsSync(envFile)) cmdArgs.push('--env-file', envFile);
  cmdArgs.push(...args);
  return run('docker', cmdArgs, { inheritStdio: true });
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function run(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: options.inheritStdio ? 'inherit' : 'pipe' });
    let stdout = '';
    let stderr = '';
    if (!options.inheritStdio) {
      child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    }
    child.on('close', (code) => resolve({ status: code ?? 0, stdout, stderr }));
    child.on('error', (err) => resolve({ status: 1, stdout, stderr: stderr + err.message }));
  });
}
