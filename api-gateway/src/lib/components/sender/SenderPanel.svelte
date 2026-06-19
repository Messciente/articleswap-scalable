<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { slide } from "svelte/transition";
  import {
    HttpError,
    submitArticle,
    getArticle,
    listArticles,
    fileToBase64
  } from "$lib/api/articles";
  import type { ArticleDetail, ListedArticle, SubmitArticlePayload } from "$lib/api/articles";

  type SubmitResult = {
    success: boolean;
    message: string;
    detail?: string;
    articleId?: string;
  };

  let {
    initialRecent = [],
    initialRecentTotal = 0,
    initialRecentError = "",
    submitResult = undefined
  }: {
    initialRecent?: ListedArticle[];
    initialRecentTotal?: number;
    initialRecentError?: string;
    submitResult?: SubmitResult;
  } = $props();

  const MAX_FILE_BYTES = 25 * 1024 * 1024;
  const LIST_LIMIT = 10;

  let title = $state("");
  let content = $state("");
  let sender = $state("");
  let receiver = $state("");
  let uploadType = $state<"text" | "pdf">("text");
  let selectedFile: File | null = $state(null);

  // Submit feedback
  let status = $state<"idle" | "submitting" | "success" | "error">(
    (() => (submitResult ? (submitResult.success ? "success" : "error") : "idle"))()
  );
  let statusMessage = $state((() => submitResult?.message ?? "")());
  let statusDetail = $state((() => submitResult?.detail ?? "")());
  let articleId = $state((() => submitResult?.articleId ?? "")());
  let lastFetched: ArticleDetail | null = $state(null);
  let progressPercent = $state(0);
  let progressLabel = $state("Menunggu submit");
  let progressTimer: ReturnType<typeof setTimeout> | null = null;

  // Recent submissions list (auto-fetched from article-service)
  let recent = $state<ListedArticle[]>((() => initialRecent)());
  let recentTotal = $state((() => initialRecentTotal)());
  let recentLoading = $state(false);
  let recentError = $state((() => initialRecentError)());

  let fileInputEl = $state<HTMLInputElement | null>(null);

  $effect(() => {
    recent = initialRecent;
    recentTotal = initialRecentTotal;
    recentError = initialRecentError;
  });

  $effect(() => {
    if (!submitResult) return;
    status = submitResult.success ? "success" : "error";
    statusMessage = submitResult.message;
    statusDetail = submitResult.detail ?? "";
    articleId = submitResult.articleId ?? "";
  });

  function handleFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      selectedFile = input.files[0];
    }
  }

  function clearForm() {
    title = "";
    content = "";
    selectedFile = null;
    lastFetched = null;
    if (fileInputEl) fileInputEl.value = "";
  }

  function formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleString("id-ID", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit"
      });
    } catch {
      return iso;
    }
  }

  function statusColor(s: string): string {
    switch (s) {
      case "PENDING": return "#f59e0b";
      case "STEMMED": return "#3b82f6";
      case "WORDCLOUD_GENERATED": return "#8b5cf6";
      case "DELIVERED": return "#10b981";
      case "FAILED": return "#ef4444";
      default: return "#6b7280";
    }
  }

  function progressForStatus(s?: string): { percent: number; label: string; done: boolean } {
    switch (s) {
      case "PENDING": return { percent: 25, label: "Artikel disimpan, menunggu stemming", done: false };
      case "STEMMED": return { percent: 50, label: "Stemming selesai, membuat wordcloud", done: false };
      case "WORDCLOUD_GENERATED": return { percent: 75, label: "Wordcloud selesai, mengirim ke inbox", done: false };
      case "DELIVERED": return { percent: 100, label: "Selesai: artikel terkirim ke inbox", done: true };
      case "FAILED": return { percent: 100, label: "Pipeline gagal", done: true };
      default: return { percent: 10, label: "Mengirim ke pipeline", done: false };
    }
  }

  function stopProgressPolling() {
    if (progressTimer) {
      clearTimeout(progressTimer);
      progressTimer = null;
    }
  }

  function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
  }

  function httpErrorIssues(error: unknown): string | undefined {
    if (!(error instanceof HttpError)) return undefined;
    const body = error.body;
    if (typeof body !== "object" || body === null || !("issues" in body)) return undefined;
    const issues = body.issues;
    return typeof issues === "string" ? issues : undefined;
  }

  /**
   * Fetch recent articles from the article-service.
   * Called on mount, after each successful submit, and on manual refresh.
   * Catches its own errors to avoid breaking the UI.
   */
  async function refreshList() {
    recentLoading = true;
    recentError = "";
    try {
      const result = await listArticles({ limit: LIST_LIMIT });
      recent = result.items ?? [];
      recentTotal = result.total ?? 0;
    } catch (e: unknown) {
      recentError = errorMessage(e, "Gagal fetch daftar artikel");
      recent = [];
    } finally {
      recentLoading = false;
    }
  }

  /**
   * Fetch a single article by id (used by the "Verifikasi dari DB" button).
   * Populates `lastFetched` for display in the success alert.
   */
  async function fetchArticle(id: string) {
    if (!id) return;
    try {
      const data = await getArticle(id);
      lastFetched = data;
      const progress = progressForStatus(data?.status);
      progressPercent = progress.percent;
      progressLabel = progress.label;
    } catch (e: unknown) {
      statusMessage = "Gagal mengambil artikel";
      statusDetail = errorMessage(e, "Gagal mengambil artikel dari database");
    }
  }

  async function pollProgress(id: string) {
    stopProgressPolling();
    try {
      const data = await getArticle(id);
      if (data) {
        lastFetched = data;
        const progress = progressForStatus(data.status);
        progressPercent = progress.percent;
        progressLabel = progress.label;
        statusDetail = `${progress.label}. Status: ${data.status}.`;
        await refreshList();
        if (progress.done) {
          status = data.status === "FAILED" ? "error" : "success";
          return;
        }
      }
    } catch (e: unknown) {
      progressLabel = errorMessage(e, "Gagal cek progress pipeline");
    }
    progressTimer = setTimeout(() => void pollProgress(id), 1500);
  }

  /**
   * Refresh + auto-verify are triggered after each successful submit so
   * the sender sees the new row in the "Recent" list AND the full DB
   * record inline. Runs `Promise.allSettled` so a failure in one path
   * doesn't block the other.
   */
  async function onSubmitSuccess(newId: string) {
    await Promise.allSettled([
      refreshList(),
      fetchArticle(newId)
    ]);
  }

  onMount(() => {
    if (window.location.search.includes("/submitArticle")) {
      window.history.replaceState(null, "", window.location.pathname);
    }
    refreshList();
  });

  onDestroy(() => {
    stopProgressPolling();
  });

  async function handleSubmit(e: Event) {
    e.preventDefault();
    stopProgressPolling();
    status = "submitting";
    statusMessage = "Sedang mengirim artikel...";
    statusDetail = "";
    lastFetched = null;
    progressPercent = 5;
    progressLabel = "Menyiapkan payload";

    try {
      const payload: SubmitArticlePayload = { title, sender, receiver, articleId: crypto.randomUUID() };

      if (uploadType === "text") {
        if (!content.trim()) {
          status = "error";
          statusMessage = "Isi artikel kosong";
          statusDetail = "Tulis isi artikel atau pilih tab File PDF.";
          return;
        }
        payload.content = content;
      } else {
        if (!selectedFile) {
          status = "error";
          statusMessage = "Pilih file PDF dulu";
          statusDetail = "Klik area upload lalu pilih file PDF.";
          return;
        }
        if (selectedFile.size > MAX_FILE_BYTES) {
          status = "error";
          statusMessage = "File terlalu besar";
          statusDetail = `Maks ${(MAX_FILE_BYTES / 1024 / 1024).toFixed(0)} MB. File Anda: ${(selectedFile.size / 1024 / 1024).toFixed(2)} MB.`;
          return;
        }
        progressPercent = 15;
        progressLabel = "Membaca PDF ke base64";
        payload.fileData = await fileToBase64(selectedFile);
        payload.fileName = selectedFile.name;
      }

      progressPercent = 20;
      progressLabel = "Mengirim artikel ke service";
      const result = await submitArticle(payload);
      status = "submitting";
      statusMessage = result.message;
      statusDetail = `Article ID tersimpan di database. Status: ${result.status}.`;
      articleId = result.articleId;
      clearForm();
      await onSubmitSuccess(result.articleId);
      await pollProgress(result.articleId);
    } catch (err: unknown) {
      stopProgressPolling();
      status = "error";
      statusMessage = errorMessage(err, "Gagal mengirim artikel");
      statusDetail = httpErrorIssues(err) || (err instanceof HttpError ? `HTTP ${err.status}` : "HTTP ?");
    }
  }
</script>

<section class="card panel">
  <div class="panel-header-badge sender-badge">Pengirim</div>
  <h2>Kirim Artikel Baru</h2>
  <p class="section-desc">
    Kirim artikel (teks langsung atau file PDF) ke sistem pemrosesan pipeline.
  </p>

  <form method="POST" action="?/submitArticle" enctype="multipart/form-data" onsubmit={handleSubmit}>
    <div class="tab-group">
      <input
        class="tab-radio tab-radio-text"
        type="radio"
        id="upload-text"
        name="uploadType"
        value="text"
        bind:group={uploadType}
        checked
      />
      <input
        class="tab-radio tab-radio-pdf"
        type="radio"
        id="upload-pdf"
        name="uploadType"
        value="pdf"
        bind:group={uploadType}
      />
      <div class="tab-slider"></div>
      <label class="tab-btn tab-btn-text" for="upload-text">Teks Langsung</label>
      <label class="tab-btn tab-btn-pdf" for="upload-pdf">File PDF</label>
    </div>
    <div class="form-grid">
      <div class="field">
        <label for="sender">Username Pengirim</label>
        <input
          type="text"
          id="sender"
          name="sender"
          autocomplete="username"
          bind:value={sender}
          placeholder="Contoh: alice"
          required
        />
      </div>
      <div class="field">
        <label for="receiver">Username Penerima</label>
        <input
          type="text"
          id="receiver"
          name="receiver"
          autocomplete="username"
          bind:value={receiver}
          placeholder="Contoh: bob"
          required
        />
      </div>
    </div>

    <div class="field">
      <label for="title">Judul Artikel</label>
      <input
        type="text"
        id="title"
        name="title"
        autocomplete="on"
        bind:value={title}
        placeholder="Tulis judul artikel..."
        required
      />
    </div>

    <div class="text-field-wrapper">
      <div class="field">
        <label for="content">Isi Artikel</label>
        <textarea
          id="content"
          name="content"
          bind:value={content}
          rows="5"
          placeholder="Tulis atau tempel isi artikel di sini..."
        ></textarea>
      </div>
    </div>

    <div class="pdf-field-wrapper">
      <div class="field">
        <label for="file">Pilih Dokumen PDF</label>
        <label class="file-upload-box" for="file">
          <input
            type="file"
            id="file"
            name="file"
            accept=".pdf,application/pdf"
            onchange={handleFileChange}
            bind:this={fileInputEl}
          />
          <div class="file-info-text">
            {#if selectedFile}
              <span class="file-selected">
                Selected: {selectedFile.name} ({(selectedFile.size / 1024).toFixed(1)} KB)
              </span>
            {:else}
              <span>Klik untuk memilih PDF (maks 25 MB)</span>
            {/if}
          </div>
        </label>
      </div>
    </div>

    <button
      type="submit"
      class="submit-btn"
      class:submitting={status === "submitting"}
      disabled={status === "submitting"}
    >
      {#if status === "submitting"}
        <span class="spinner"></span> Mengirim...
      {:else}
        Kirim ke Sistem
      {/if}
    </button>
  </form>

  {#if status !== "idle"}
    <div class="alert {status}" transition:slide={{ duration: 250 }}>
      <div class="alert-icon">
        {#if status === "success"}[OK]{:else if status === "error"}[ERROR]{:else}[INFO]{/if}
      </div>
      <div class="alert-content">
        <p class="alert-message">{statusMessage}</p>
        {#if statusDetail}
          <p class="alert-detail">{statusDetail}</p>
        {/if}
        {#if status === "submitting" || progressPercent > 0}
          <div class="progress-wrap" aria-label="Progress pipeline" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progressPercent}>
            <div class="progress-bar" style="width: {progressPercent}%"></div>
          </div>
          <p class="progress-text">{progressPercent}% — {progressLabel}</p>
        {/if}
        {#if articleId && status === "success"}
          <code class="article-id">ID: {articleId}</code>
          {#if lastFetched}
            <div class="db-record">
              <strong>DB record:</strong>
              <pre>{JSON.stringify(lastFetched, null, 2)}</pre>
              {#if lastFetched.wordcloud_url}
                <a class="wordcloud-link" href={lastFetched.wordcloud_url} target="_blank" rel="noreferrer">Buka wordcloud</a>
              {/if}
            </div>
          {/if}
        {/if}
      </div>
    </div>
  {/if}
</section>

<section class="card panel recent-panel">
  <div class="panel-header-badge sender-badge">Recent</div>
  <div class="recent-header">
    <h3>Artikel Terbaru</h3>
    <button
      type="button"
      class="refresh-btn"
      onclick={refreshList}
      disabled={recentLoading}
    >
      {#if recentLoading}
        <span class="spinner-sm"></span> Memuat...
      {:else}
        Refresh
      {/if}
    </button>
  </div>
  <p class="section-desc">
    Auto-fetched dari <code>GET /api/articles</code> (limit {LIST_LIMIT}).
    Total di database: <strong>{recentTotal}</strong>.
  </p>

  {#if recentError}
    <div class="alert error" transition:slide>
      <div class="alert-content">
        <p class="alert-message">Gagal fetch: {recentError}</p>
      </div>
    </div>
  {/if}

  {#if recentLoading && recent.length === 0}
    <p class="empty-state">Memuat daftar artikel...</p>
  {:else if recent.length === 0}
    <p class="empty-state">Belum ada artikel terkirim. Submit form di atas.</p>
  {:else}
    <ul class="recent-list">
      {#each recent as article (article.id)}
        <li class="recent-item">
          <div class="recent-main">
            <div class="recent-title-row">
              <span class="recent-title">{article.title}</span>
              {#if article.has_file}
                <span class="file-badge">[FILE] {article.file_name ?? '?'}</span>
              {:else}
                <span class="text-badge">[TEXT]</span>
              {/if}
            </div>
            <div class="recent-meta">
              <span><strong>{article.sender}</strong> → <strong>{article.receiver}</strong></span>
              <span class="dot">·</span>
              <span>{formatDate(article.created_at)}</span>
            </div>
          </div>
          <div class="recent-side">
            <span class="status-pill" style="background: {statusColor(article.status)}">
              {article.status}
            </span>
            {#if article.wordcloud_url}
              <a
                class="wordcloud-result-btn"
                href={article.wordcloud_url}
                target="_blank"
                rel="noreferrer"
                aria-label={`Lihat hasil wordcloud untuk ${article.title}`}
              >
                Lihat Wordcloud
              </a>
            {/if}
            <code class="mini-id" title={article.id}>
              {article.id.slice(0, 8)}…
            </code>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  @import "./SenderPanel.css";

  .recent-panel {
    margin-top: 1.5rem;
  }
  .tab-radio {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .tab-radio-pdf:checked ~ .tab-slider {
    transform: translateX(100%);
  }
  .tab-radio-text:checked ~ .tab-btn-text,
  .tab-radio-pdf:checked ~ .tab-btn-pdf {
    color: #ffffff;
  }
  .tab-radio-text:not(:checked) ~ .tab-btn-text,
  .tab-radio-pdf:not(:checked) ~ .tab-btn-pdf {
    color: #737373;
  }
  .pdf-field-wrapper {
    display: none;
  }
  form:has(.tab-radio-pdf:checked) .text-field-wrapper {
    display: none;
  }
  form:has(.tab-radio-pdf:checked) .pdf-field-wrapper {
    display: block;
  }
  .recent-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .refresh-btn {
    padding: 0.4rem 0.8rem;
    font-size: 0.85rem;
    border-radius: 6px;
    border: 1px solid #d1d5db;
    background: white;
    cursor: pointer;
  }
  .refresh-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .recent-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .recent-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    gap: 1rem;
  }
  .recent-main {
    flex: 1;
    min-width: 0;
  }
  .recent-title-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .recent-title {
    font-weight: 600;
    color: #111827;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 280px;
  }
  .file-badge, .text-badge {
    font-size: 0.7rem;
    padding: 0.15rem 0.45rem;
    border-radius: 4px;
    font-weight: 600;
  }
  .file-badge {
    background: #ddd6fe;
    color: #5b21b6;
  }
  .text-badge {
    background: #d1fae5;
    color: #065f46;
  }
  .recent-meta {
    font-size: 0.8rem;
    color: #6b7280;
    margin-top: 0.2rem;
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .dot { opacity: 0.5; }
  .recent-side {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.25rem;
  }
  .status-pill {
    color: white;
    font-size: 0.7rem;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }
  .mini-id {
    font-family: monospace;
    font-size: 0.7rem;
    color: #6b7280;
  }
  .wordcloud-result-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.3rem 0.55rem;
    border-radius: 999px;
    background: #eef2ff;
    color: #4338ca;
    border: 1px solid #c7d2fe;
    font-size: 0.72rem;
    font-weight: 800;
    text-decoration: none;
    white-space: nowrap;
  }
  .wordcloud-result-btn:hover {
    background: #4338ca;
    color: #ffffff;
  }
  .spinner-sm {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 2px solid #d1d5db;
    border-top-color: #6b7280;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-right: 4px;
    vertical-align: middle;
  }
  .progress-wrap {
    width: 100%;
    height: 12px;
    margin-top: 0.75rem;
    border: 1px solid #d1d5db;
    background: #f3f4f6;
    overflow: hidden;
  }
  .progress-bar {
    height: 100%;
    background: linear-gradient(90deg, #111827, #2563eb, #10b981);
    transition: width 0.3s ease;
  }
  .progress-text {
    margin: 0.4rem 0 0;
    font-size: 0.8rem;
    color: #374151;
  }
  .wordcloud-link {
    display: inline-block;
    margin-top: 0.5rem;
    font-weight: 700;
    color: #1d4ed8;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
