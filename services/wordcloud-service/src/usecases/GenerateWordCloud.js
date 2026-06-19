export class GenerateWordCloud {
  constructor({ objectStorage, publicBaseUrl }) {
    this.objectStorage = objectStorage;
    this.publicBaseUrl = publicBaseUrl;
  }

  async execute(article) {
    const frequencies = countWords(article.stemmedContent || article.content || '');
    const svg = renderWordCloudSvg(frequencies, article.title || 'Article');
    const imageBuffer = Buffer.from(svg, 'utf8');

    const objectName = `${article.id}.svg`;
    await this.objectStorage.upload(objectName, imageBuffer, { 'Content-Type': 'image/svg+xml' });
    const wordcloudUrl = this.objectStorage.publicUrl(objectName, this.publicBaseUrl);

    return {
      ...article,
      wordcloudUrl,
      generatedAt: new Date().toISOString()
    };
  }
}

const STOP_WORDS = new Set([
  'yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'dengan', 'atau', 'ini', 'itu', 'pada',
  'the', 'a', 'an', 'of', 'to', 'in', 'and', 'or', 'for', 'with', 'is', 'are'
]);

function countWords(text) {
  const counts = new Map();
  for (const token of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) {
    if (token.length < 3 || STOP_WORDS.has(token)) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 40);
}

function renderWordCloudSvg(frequencies, title) {
  const width = 800;
  const height = 450;
  const words = frequencies.length > 0 ? frequencies : [[title, 1]];
  const max = Math.max(...words.map(([, count]) => count));
  const min = Math.min(...words.map(([, count]) => count));
  const palette = ['#1d4ed8', '#047857', '#be123c', '#7c3aed', '#c2410c', '#0f766e'];
  const placed = placeWords(words.map(([word, count], index) => ({
    word,
    count,
    index,
    size: scaleFont(count, min, max)
  })), width, height);
  const body = placed.map(({ word, count, index, size, x, y, rotate }) => {
    const color = palette[index % palette.length];
    return `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-family="Arial, sans-serif" font-weight="700" text-anchor="middle" dominant-baseline="middle" transform="rotate(${rotate} ${x} ${y})">${escapeXml(word)}</text>`;
  }).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Word cloud">
<rect width="100%" height="100%" fill="#f8fafc"/>
<text x="40" y="46" font-size="24" fill="#0f172a" font-family="Arial, sans-serif" font-weight="700">ArticleSwap Word Cloud</text>
${body}
</svg>`;
}

function scaleFont(count, min, max) {
  if (max === min) return 34;
  const ratio = Math.sqrt((count - min) / (max - min));
  return Math.round(18 + ratio * 48);
}

function placeWords(words, width, height) {
  const boxes = [];
  const placed = [];
  const centerX = width / 2;
  const centerY = height / 2 + 20;

  for (const item of words) {
    const rotate = item.index % 5 === 0 ? -90 : 0;
    const boxWidth = rotate === 0 ? item.word.length * item.size * 0.58 : item.size * 1.3;
    const boxHeight = rotate === 0 ? item.size * 1.3 : item.word.length * item.size * 0.58;
    let position = null;

    for (let step = 0; step < 240; step += 1) {
      const angle = step * 0.55;
      const radius = 5 + step * 2.4;
      const x = centerX + Math.cos(angle) * radius;
      const y = centerY + Math.sin(angle) * radius;
      const box = {
        left: x - boxWidth / 2,
        right: x + boxWidth / 2,
        top: y - boxHeight / 2,
        bottom: y + boxHeight / 2
      };
      if (box.left < 24 || box.right > width - 24 || box.top < 68 || box.bottom > height - 24) continue;
      if (boxes.every((existing) => !intersects(box, existing))) {
        position = { x: Math.round(x), y: Math.round(y), rotate, box };
        break;
      }
    }

    if (!position) continue;
    boxes.push(position.box);
    placed.push({ ...item, x: position.x, y: position.y, rotate: position.rotate });
  }

  return placed;
}

function intersects(a, b) {
  const padding = 6;
  return !(a.right + padding < b.left || a.left - padding > b.right || a.bottom + padding < b.top || a.top - padding > b.bottom);
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
