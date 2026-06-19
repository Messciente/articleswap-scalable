/**
 * Thin client wrapper for the article-service HTTP API.
 * Consumed by the SenderPanel (and any other UI component) in api-gateway.
 */

const API_BASE = ''; // same-origin: nginx routes /api/* to article-service

export interface SubmitArticlePayload {
  title: string;
  content?: string;
  fileData?: string;
  fileName?: string;
  sender: string;
  receiver: string;
  articleId?: string;
}

export interface SubmitArticleResponse {
  message: string;
  articleId: string;
  status: string;
}

export interface ListArticlesFilters {
  limit?: number;
  offset?: number;
  sender?: string;
  receiver?: string;
  status?: string;
}

export interface ListedArticle {
  id: string;
  title: string;
  sender: string;
  receiver: string;
  status: string;
  file_name: string | null;
  file_size: number | null;
  has_file: boolean;
  created_at: string;
  updated_at: string;
  stemmed_content?: string | null;
  wordcloud_url?: string | null;
  delivered_at?: string | null;
}

export interface ListArticlesResult {
  items: ListedArticle[];
  total: number;
  limit: number;
  offset: number;
}

export interface ArticleDetail extends ListedArticle {
  content: string | null;
  hasFile: boolean;
  fileName: string | null;
  read_at?: string | null;
}

export class HttpError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

function isSubmitArticleResponse(body: unknown): body is SubmitArticleResponse {
  if (typeof body !== 'object' || body === null) return false;
  return 'message' in body && typeof body.message === 'string'
    && 'articleId' in body && typeof body.articleId === 'string'
    && 'status' in body && typeof body.status === 'string';
}

/**
 * Submits a new article. Throws HttpError on non-2xx.
 */
export async function submitArticle(payload: SubmitArticlePayload): Promise<SubmitArticleResponse> {
  const res = await fetch(`${API_BASE}/api/articles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await res.json().catch(() => ({})) as { error?: string; issues?: string };
  if (!res.ok) {
    throw new HttpError(body.issues || body.error || `HTTP ${res.status}`, res.status, body);
  }
  if (!isSubmitArticleResponse(body)) {
    throw new HttpError('Unexpected response from article service', res.status, body);
  }
  return body;
}

/**
 * Fetches a single article by id. Returns null if 404.
 */
export async function getArticle(id: string): Promise<ArticleDetail | null> {
  const res = await fetch(`${API_BASE}/api/articles/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Converts a File to a base64 string (without the `data:...;base64,` prefix).
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Unexpected FileReader result'));
        return;
      }
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('FileReader error'));
    reader.readAsDataURL(file);
  });
}

/**
 * Lists recent articles, with optional filters.
 * Auto-coerces query values to strings (URLSearchParams requires it).
 */
export async function listArticles(filters: ListArticlesFilters = {}): Promise<ListArticlesResult> {
  const params = new URLSearchParams();
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  if (filters.offset !== undefined) params.set('offset', String(filters.offset));
  if (filters.sender) params.set('sender', filters.sender);
  if (filters.receiver) params.set('receiver', filters.receiver);
  if (filters.status) params.set('status', filters.status);

  const qs = params.toString();
  const url = `${API_BASE}/api/articles${qs ? `?${qs}` : ''}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}
