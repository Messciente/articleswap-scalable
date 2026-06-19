<script lang="ts">
  import { onDestroy } from "svelte";
  import { fade, slide } from "svelte/transition";

  // Receiver states
  let activeReceiver = $state("");
  let isListening = $state(false);
  let receivedArticles = $state<
    Array<{
      id: string;
      title: string;
      sender: string;
      content: string;
      file?: { name: string; data: string };
      time: string;
      status?: string;
      stemmedContent?: string;
      wordcloudUrl?: string;
      deliveredAt?: string;
    }>
  >([]);
  let eventSource: EventSource | null = null;

  /**
   * Toggles the SSE connection state for the active receiver client.
   */
  function toggleListening() {
    if (isListening) {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      isListening = false;
    } else {
      if (!activeReceiver) return;
      isListening = true;
      eventSource = new EventSource(
        `/api/receive?receiver=${encodeURIComponent(activeReceiver)}`,
      );
      console.log("Connecting to SSE stream...");

      eventSource.onopen = () => {
        console.log("SSE connection successfully opened");
      };

      eventSource.onmessage = (event) => {
        console.log("SSE Message received:", event.data);
        const payload = JSON.parse(event.data);
        receivedArticles = [
          {
            id: payload.id,
            title: payload.title,
            sender: payload.sender,
            content: payload.content,
            file: payload.file,
            time: new Date().toLocaleTimeString(),
            status: payload.status,
            stemmedContent: payload.stemmedContent ?? payload.stemmed_content,
            wordcloudUrl: payload.wordcloudUrl ?? payload.wordcloud_url,
            deliveredAt: payload.deliveredAt,
          },
          ...receivedArticles,
        ];
      };

      eventSource.onerror = (e) => {
        console.error("SSE Error/Connection closed:", e);
        if (eventSource) eventSource.close();
        isListening = false;
      };
    }
  }

  /**
   * Downloads a file locally from base64 data.
   *
   * @param fileName Target filename.
   * @param base64Data Base64 representation.
   */
  function downloadPdf(fileName: string, base64Data: string) {
    const linkSource = `data:application/pdf;base64,${base64Data}`;
    const downloadLink = document.createElement("a");
    downloadLink.href = linkSource;
    downloadLink.download = fileName;
    downloadLink.click();
  }

  onDestroy(() => {
    if (eventSource) {
      eventSource.close();
    }
  });
</script>

<section class="card panel">
  <div class="panel-header-badge receiver-badge">Penerima</div>
  <h2>Artikel Masuk</h2>
  <p class="section-desc">
    Hubungkan akun Anda untuk menerima hasil pengolahan artikel secara
    real-time.
  </p>

  <div class="receiver-controls">
    <input
      type="text"
      name="receiver"
      autocomplete="username"
      bind:value={activeReceiver}
      disabled={isListening}
      placeholder="Nama Penerima (Contoh: bob)"
    />
    <button
      class="listen-btn"
      class:listening={isListening}
      onclick={toggleListening}
      disabled={!activeReceiver}
    >
      {isListening ? "Putus Koneksi" : "Mulai Listening"}
    </button>
  </div>

  <div class="submissions-list">
    {#if receivedArticles.length === 0}
      <div class="empty-state" transition:fade={{ duration: 150 }}>
        <p>
          {isListening
            ? "Listening... Menunggu pengiriman artikel baru."
            : "Masukkan username dan klik mulai listening untuk memantau pesan masuk."}
        </p>
      </div>
    {:else}
      {#each receivedArticles as article (article.id)}
        <div class="incoming-card" transition:slide={{ duration: 250 }}>
          <div class="card-header">
            <h3>{article.title}</h3>
            <span class="time">{article.time}</span>
          </div>
          <div class="card-details">
            <span class="sender-info"
              >Dari: <strong>{article.sender}</strong></span
            >
          </div>

          {#if article.content}
            <p class="incoming-content">{article.content}</p>
          {/if}

          {#if article.status === 'DELIVERED' || article.stemmedContent || article.wordcloudUrl}
            <div class="analysis-results">
              {#if article.stemmedContent}
                <div class="stemming-box">
                  <strong>Hasil Stemming:</strong>
                  <span class="stemmed-tokens">{article.stemmedContent}</span>
                </div>
              {/if}

              {#if article.wordcloudUrl}
                <div class="word-cloud-box">
                  <strong>Word Cloud:</strong>
                  <a href={article.wordcloudUrl} target="_blank" rel="noreferrer">Buka gambar wordcloud</a>
                  <img src={article.wordcloudUrl} alt={`Wordcloud untuk ${article.title}`} loading="lazy" />
                </div>
              {/if}
            </div>
          {/if}

          {#if article.file}
            <div class="incoming-file-action">
              <span>[PDF] {article.file.name}</span>
              <button
                class="download-btn"
                onclick={() =>
                  downloadPdf(article!.file!.name, article!.file!.data)}
              >
                Unduh PDF
              </button>
            </div>
          {/if}
          <code class="uuid">{article.id}</code>
        </div>
      {/each}
    {/if}
  </div>
</section>

<style>
  @import "./ReceiverPanel.css";
</style>
