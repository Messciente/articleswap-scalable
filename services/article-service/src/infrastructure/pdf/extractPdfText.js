import { PDFParse } from 'pdf-parse';

export async function extractPdfText(fileData) {
  if (!fileData) return '';
  const buffer = Buffer.from(fileData, 'base64');
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return normalizePdfText(result.text || '');
  } finally {
    await parser.destroy();
  }
}

function normalizePdfText(text) {
  return text
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
