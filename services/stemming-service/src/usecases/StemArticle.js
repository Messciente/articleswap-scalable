import natural from 'natural';
import { Stemmer as SastrawiStemmer } from 'sastrawijs';

const indonesianStemmer = new SastrawiStemmer();
const englishStemmer = natural.PorterStemmer;

export class StemArticle {
  constructor({ stemmer } = {}) {
    this.stemmer = stemmer;
  }

  async execute(article) {
    const stemmedContent = this.stemmer
      ? await this.stemmer(article.content)
      : stemMixedLanguageText(article.content || '');

    return {
      ...article,
      stemmedContent,
      stemmedAt: new Date().toISOString()
    };
  }
}

const INDONESIAN_STOPWORDS = new Set([
  'yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'dengan', 'atau', 'ini', 'itu', 'pada',
  'adalah', 'sebagai', 'dalam', 'oleh', 'bagi', 'dapat', 'akan', 'tidak', 'karena',
  'sangat', 'sedang', 'agar', 'jika', 'maka', 'kami', 'kita', 'mereka', 'artikel'
]);

const ENGLISH_STOPWORDS = new Set([
  'the', 'is', 'at', 'which', 'on', 'and', 'a', 'an', 'to', 'in', 'of', 'for', 'with',
  'it', 'that', 'by', 'are', 'as', 'be', 'this', 'from', 'can', 'we', 'you', 'they',
  'users', 'user', 'share', 'article', 'articles', 'quickly', 'quick'
]);

const INDONESIAN_COMMON_WORDS = new Set([
  'aplikasi', 'pengembangan', 'menyenangkan', 'berita', 'bahasa', 'indonesia', 'teks',
  'kata', 'konten', 'membaca', 'menulis', 'sistem', 'layanan', 'proses', 'cepat'
]);

const ENGLISH_COMMON_WORDS = new Set([
  'application', 'applications', 'development', 'service', 'services', 'text', 'word',
  'content', 'read', 'write', 'users', 'user', 'share', 'shares', 'sharing', 'shared',
  'articles', 'article', 'quickly', 'quick', 'because'
]);

const TECHNICAL_TERMS = new Set([
  'api', 'kafka', 'redis', 'docker', 'postgres', 'postgresql', 'scalable', 'cloud',
  'worker', 'gateway', 'http', 'https', 'json', 'sql', 'nosql', 'node', 'nodejs',
  'javascript', 'typescript', 'react', 'vue', 'nextjs', 'express',
  'database', 'db', 'url', 'uri', 'email', 'oauth', 'jwt', 'uuid', 'id', 'cpu', 'ram',
  'storage', 'recycle'
]);

const URL_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WORD_PATTERN = /^\p{L}[\p{L}'’]*$/u;
const NUMBER_PATTERN = /^\d+(?:[.,:]\d+)*$/;
const CODELIKE_PATTERN = /(?:[_/\\]|[a-z]+\d+|\d+[a-z]+)/i;

export function tokenizeText(text) {
  if (!text) return [];
  return text.match(/[a-z][a-z\d+.-]*:\/\/[^\s]+|[^\s@]+@[^\s@]+\.[^\s@]+|\d+(?:[.,:]\d+)*|\p{L}[\p{L}'’]*|\s+|[^\s]/giu) || [];
}

export function detectTokenLanguage(token) {
  if (!isWordToken(token) || shouldPreserveToken(token)) return 'technical';

  const value = token.toLowerCase();
  let indonesianScore = 0;
  let englishScore = 0;

  if (INDONESIAN_STOPWORDS.has(value)) indonesianScore += 3;
  if (ENGLISH_STOPWORDS.has(value)) englishScore += 3;
  if (INDONESIAN_COMMON_WORDS.has(value)) indonesianScore += 3;
  if (ENGLISH_COMMON_WORDS.has(value)) englishScore += 3;

  if (/^(me|mem|men|meng|meny|ber|ter|pe|pem|pen|peng|peny|per)[a-z]{3,}/.test(value)) indonesianScore += 2;
  if (/(kan|nya|lah|pun|ku|mu|an)$/u.test(value) && value.length > 5) indonesianScore += 2;

  if (/(ing|ed|ly|tion|ions|ment|ness|able|ible|ers?)$/u.test(value) && value.length > 4) englishScore += 2;
  if (/^[a-z]+s$/u.test(value) && value.length > 4) englishScore += 1;

  if (indonesianScore > englishScore) return 'id';
  if (englishScore > indonesianScore) return 'en';
  return 'unknown';
}

export function stemToken(token, fallbackLanguage = 'id') {
  if (!isWordToken(token) || shouldPreserveToken(token)) return token;

  const language = detectTokenLanguage(token);
  const selectedLanguage = language === 'unknown' ? fallbackLanguage : language;
  const value = token.toLowerCase();

  if (selectedLanguage === 'en') return normalizeEnglishStem(value, englishStemmer.stem(value));
  if (selectedLanguage === 'id') return normalizeIndonesianStem(value, indonesianStemmer.stem(value));
  return token;
}

export function stemMixedLanguageText(text) {
  const tokens = tokenizeText(text);
  const fallbackLanguage = getMajorityLanguage(tokens);

  return tokens
    .map((token) => isWordToken(token) ? stemToken(token, fallbackLanguage) : token)
    .join('');
}

function getMajorityLanguage(tokens) {
  const counts = { id: 0, en: 0 };

  for (const token of tokens) {
    const language = detectTokenLanguage(token);
    if (language === 'id' || language === 'en') counts[language] += 1;
  }

  return counts.en > counts.id ? 'en' : 'id';
}

function isWordToken(token) {
  return WORD_PATTERN.test(token);
}

function shouldPreserveToken(token) {
  const value = token.toLowerCase();
  return URL_PATTERN.test(token)
    || EMAIL_PATTERN.test(token)
    || NUMBER_PATTERN.test(token)
    || CODELIKE_PATTERN.test(token)
    || TECHNICAL_TERMS.has(value)
    || token.length <= 1
    || /^[A-Z0-9]{2,}$/.test(token);
}

function normalizeEnglishStem(original, stemmed) {
  if (original === 'article' || original === 'articles') return 'article';
  if (original.endsWith('ly') && stemmed.endsWith('li')) return stemmed.slice(0, -2);
  return stemmed;
}

function normalizeIndonesianStem(original, stemmed) {
  if (stemmed !== original) return stemmed;
  if (/^peng[aiueo][a-z]+an$/u.test(original) && original.length > 8) return `k${original.slice(4, -2)}`;
  if (/^peng[a-z]+an$/u.test(original) && original.length > 8) return original.slice(4, -2);
  if (/^pem[a-z]+an$/u.test(original) && original.length > 8) return original.slice(3, -2);
  if (/^peny[a-z]+an$/u.test(original) && original.length > 8) return `s${original.slice(4, -2)}`;
  if (/^pen[a-z]+an$/u.test(original) && original.length > 8) return original.slice(3, -2);
  return stemmed;
}
