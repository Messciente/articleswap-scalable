import { env } from "$env/dynamic/private";
import { fail, redirect, type Actions } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import type { ListedArticle } from "$lib/api/articles";

const DEFAULT_ARTICLE_SERVICE_URL = "http://localhost:3000";
const LIST_LIMIT = 10;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

type SubmitResult = {
  success: boolean;
  message: string;
  detail?: string;
  articleId?: string;
};

function articleServiceUrl(path = ""): string {
  const base = env.ARTICLE_SERVICE_URL || DEFAULT_ARTICLE_SERVICE_URL;
  return `${base.replace(/\/$/, "")}/api/articles${path}`;
}

function formValue(data: FormData, key: string): string {
  const value = data.get(key);
  return typeof value === "string" ? value.trim() : "";
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  return Buffer.from(bytes).toString("base64");
}

export const load: PageServerLoad = async ({ fetch }) => {
  try {
    const response = await fetch(articleServiceUrl(`?limit=${LIST_LIMIT}`));
    if (!response.ok) {
      return {
        recent: [],
        recentTotal: 0,
        recentError: `GET /api/articles failed: HTTP ${response.status}`
      };
    }

    const result = await response.json() as { items?: ListedArticle[]; total?: number };
    return {
      recent: result.items ?? [],
      recentTotal: result.total ?? 0,
      recentError: ""
    };
  } catch (error) {
    return {
      recent: [],
      recentTotal: 0,
      recentError: error instanceof Error ? error.message : "Gagal fetch daftar artikel"
    };
  }
};

export const actions: Actions = {
  submitArticle: async ({ request, fetch }) => {
    const data = await request.formData();
    const uploadType = formValue(data, "uploadType") || "text";
    const title = formValue(data, "title");
    const sender = formValue(data, "sender");
    const receiver = formValue(data, "receiver");
    const content = formValue(data, "content");

    const payload: {
      title: string;
      sender: string;
      receiver: string;
      content?: string;
      fileData?: string;
      fileName?: string;
    } = { title, sender, receiver };

    if (uploadType === "pdf") {
      const fileValue = data.get("file");
      if (!(fileValue instanceof File) || fileValue.size === 0) {
        return fail(400, {
          submitResult: {
            success: false,
            message: "Pilih file PDF dulu",
            detail: "File PDF wajib dipilih."
          } satisfies SubmitResult
        });
      }
      if (!fileValue.name.toLowerCase().endsWith(".pdf")) {
        return fail(400, {
          submitResult: {
            success: false,
            message: "File harus PDF",
            detail: "Gunakan file dengan ekstensi .pdf."
          } satisfies SubmitResult
        });
      }
      if (fileValue.size > MAX_FILE_BYTES) {
        return fail(413, {
          submitResult: {
            success: false,
            message: "File terlalu besar",
            detail: `Maks ${(MAX_FILE_BYTES / 1024 / 1024).toFixed(0)} MB.`
          } satisfies SubmitResult
        });
      }
      payload.fileData = await fileToBase64(fileValue);
      payload.fileName = fileValue.name;
    } else {
      payload.content = content;
    }

    const response = await fetch(articleServiceUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({})) as {
      message?: string;
      articleId?: string;
      status?: string;
      error?: string;
      issues?: string;
    };

    if (!response.ok) {
      return fail(response.status, {
        submitResult: {
          success: false,
          message: body.error || "Gagal mengirim artikel",
          detail: body.issues || `HTTP ${response.status}`
        } satisfies SubmitResult
      });
    }

    throw redirect(303, `/?submitted=${encodeURIComponent(body.articleId || "")}`);
  }
};
