# Stress Testing Report

## Overview

Pengujian dilakukan menggunakan **Grafana k6** terhadap endpoint:

```http
POST /api/articles
```

Tujuan pengujian adalah untuk mengevaluasi:

1. Fungsionalitas normal endpoint.
2. Ketahanan terhadap input berukuran besar.
3. Validasi input tidak valid.
4. Ketahanan terhadap payload berbahaya (XSS dan SQL Injection).
5. Mekanisme proteksi rate limiting.
6. Perilaku sistem ketika menerima request secara bersamaan (Concurrent Virtual Users).
7. Dampak beban besar terhadap pipeline pemrosesan backend.

---

# Test Environment

| Parameter    | Nilai                                             |
| ------------ | ------------------------------------------------- |
| Tool         | Grafana k6                                        |
| Endpoint     | POST /api/articles                                |
| Protocol     | HTTPS                                             |
| Request Type | JSON Payload                                      |
| Load Pattern | Single User, Burst Load, Concurrent Virtual Users |

---

# Test Case 1 - Normal Submission

## Objective

Memastikan endpoint dapat menerima dan memproses artikel valid dalam kondisi normal.

## Result

| Metric                | Value     |
| --------------------- | --------- |
| Success Rate          | 100%      |
| Failed Requests       | 0%        |
| Average Response Time | 276.67 ms |
| Maximum Response Time | 300.56 ms |

## Analysis

Endpoint berhasil menerima dan memproses seluruh request tanpa error.

Tidak ditemukan timeout, validasi gagal, ataupun indikasi bottleneck pada sisi API.

## Conclusion

**PASS**

---

# Test Case 2 - Rate Limit Protection

## Objective

Memastikan sistem memiliki mekanisme proteksi terhadap spam atau abuse request.

## Configuration

* Maximum VUs: 100
* Duration: 30 seconds

## Result

| Metric                | Value     |
| --------------------- | --------- |
| Total Requests        | 2500      |
| Successful Requests   | 30        |
| Rejected Requests     | 2470      |
| Success Rate          | 1.20%     |
| Rejection Rate        | 98.80%    |
| Average Response Time | 202.88 ms |

## Sample Response

```json
{
  "error": "Too many article submissions from this IP. Please retry later.",
  "retryAfterMs": 60000
}
```

## Analysis

Sebagian besar request ditolak menggunakan HTTP 429 (Too Many Requests).

Hal ini menunjukkan bahwa sistem berhasil mengaktifkan mekanisme rate limiting untuk membatasi spam dan mencegah abuse dari satu alamat IP.

Tidak ditemukan indikasi server crash, timeout massal, ataupun kegagalan aplikasi.

Request ditolak secara terkontrol sesuai kebijakan proteksi yang telah diterapkan.

## Conclusion

**PASS**

---

# Test Case 3 - Large Payload Test

## Objective

Menguji kemampuan sistem dalam menangani payload berukuran besar dan mengevaluasi dampaknya terhadap proses backend.

## Result

| Metric                | Value     |
| --------------------- | --------- |
| Success Rate          | 100%      |
| Failed Requests       | 0%        |
| Average Response Time | 363.83 ms |
| Maximum Response Time | 403.21 ms |

## Sample Response

```json
{
  "message": "Article submitted successfully",
  "status": "PENDING"
}
```

## Client-Side Observation

Dari perspektif client, request berhasil diterima dan diproses dengan status sukses.

Tidak ditemukan timeout maupun error pada endpoint.

## Server-Side Observation

Berdasarkan observasi pada backend setelah pengujian dilakukan:

* Payload berukuran besar membutuhkan waktu pemrosesan yang sangat lama.
* Proses stemming dan wordcloud tidak dapat diselesaikan dalam waktu normal.
* Artikel tetap berada dalam status pemrosesan untuk waktu yang sangat lama.
* Job berikutnya mengalami antrean (queue backlog) dan tertahan selama lebih dari **3 jam**.
* Endpoint API tetap responsif dan tidak mengalami crash.
* Server masih dapat menerima request baru selama backlog terjadi.
* Dampak utama terjadi pada pipeline pemrosesan asynchronous setelah artikel diterima.

## Analysis

Hasil ini menunjukkan bahwa endpoint submission mampu menerima payload besar, namun terdapat bottleneck serius pada pipeline pemrosesan backend.

Kemungkinan bottleneck terjadi pada:

* Text preprocessing
* Stemming
* Word frequency calculation
* Wordcloud generation
* Queue worker processing

Satu payload besar mampu memonopoli worker sehingga job lain harus menunggu hingga pekerjaan tersebut selesai.

Kondisi ini berpotensi menyebabkan:

* Queue backlog
* Throughput rendah
* Latensi pemrosesan sangat tinggi
* Starvation terhadap job lain

## Recommendation

1. Menetapkan batas maksimum ukuran artikel.
2. Menambahkan timeout pada proses stemming dan wordcloud.
3. Memisahkan worker NLP dari worker submission.
4. Memecah pekerjaan besar menjadi batch yang lebih kecil.
5. Menambahkan monitoring terhadap queue dan durasi job.
6. Mengimplementasikan prioritas antrean.

## Conclusion

**PARTIAL PASS**

Endpoint berhasil menerima payload besar tanpa error, namun ditemukan bottleneck serius pada pipeline backend yang menyebabkan antrean pemrosesan tertahan selama lebih dari 3 jam.

---

# Test Case 4 - XSS Injection Test

## Objective

Menguji kemampuan sistem dalam menangani input yang mengandung HTML dan JavaScript berbahaya tanpa mengganggu proses backend maupun pipeline NLP.

## Payload Example

```html
<script>alert("xss")</script>
<img src=x onerror=alert("xss")>
```

## Result

| Metric                | Value     |
| --------------------- | --------- |
| Success Rate          | 100%      |
| Failed Requests       | 0%        |
| Average Response Time | 125.07 ms |

## Analysis

Payload yang mengandung elemen HTML dan JavaScript berhasil diterima oleh endpoint tanpa menyebabkan error pada aplikasi.

Selama proses preprocessing teks, karakter non-alfabet dihapus sehingga simbol dan sintaks HTML/JavaScript tidak ikut diproses pada tahap stemming maupun pembentukan wordcloud.

Contoh:

Input:

```text
<script>alert("xss")</script>
```

Hasil preprocessing:

```text
script alert xss script
```

Token hasil preprocessing tetap berhasil diproses oleh pipeline NLP dan muncul pada hasil wordcloud tanpa menyebabkan gangguan pada sistem.

Wordcloud berhasil dibuat dan ditampilkan dengan normal menggunakan hasil tokenisasi tersebut.

Tidak ditemukan:

* Server crash
* Exception backend
* Kegagalan stemming
* Kegagalan wordcloud generation
* Kegagalan rendering wordcloud

## Security Observation

Payload XSS diperlakukan sebagai data teks biasa setelah melalui proses preprocessing.

Karakter khusus yang digunakan dalam sintaks HTML dan JavaScript berhasil dihilangkan sehingga hanya tersisa token alfabet yang relevan untuk proses NLP.

Selain itu, hasil preprocessing tetap dapat diproses hingga tahap wordcloud tanpa memengaruhi kestabilan sistem.

## Conclusion

**PASS**

---

# Test Case 5 - SQL Injection Test

## Objective

Menguji ketahanan sistem terhadap input yang menyerupai SQL Injection dan memastikan pipeline NLP tetap dapat memproses data tersebut.

## Payload Example

```sql
'; DROP TABLE articles; --
```

## Result

| Metric                | Value     |
| --------------------- | --------- |
| Success Rate          | 100%      |
| Failed Requests       | 0%        |
| Average Response Time | 280.39 ms |

## Analysis

Payload yang menyerupai SQL Injection berhasil diterima sebagai data biasa dan tidak dieksekusi sebagai perintah database.

Selama proses preprocessing, karakter non-alfabet dihilangkan sebelum tahap stemming dan wordcloud.

Contoh:

Input:

```text
'; DROP TABLE articles; --
```

Hasil preprocessing:

```text
DROP TABLE articles
```

Token hasil preprocessing tetap berhasil diproses oleh pipeline NLP dan muncul pada wordcloud tanpa menyebabkan error.

Tidak ditemukan:

* SQL execution
* Database corruption
* Table deletion
* Query error
* Backend exception
* Kegagalan stemming
* Kegagalan wordcloud generation

## Security Observation

Sistem memperlakukan payload SQL Injection sebagai konten teks biasa dan tidak menunjukkan indikasi bahwa input diinterpretasikan sebagai query database.

Karakter khusus yang umum digunakan pada serangan SQL Injection berhasil dihilangkan selama preprocessing sehingga hanya token alfabet yang tersisa untuk dianalisis.

Hasil tokenisasi tetap dapat diproses hingga tahap wordcloud dan ditampilkan dengan normal.

## Conclusion

**PASS**

---

# Test Case 6 - Empty Payload Validation

## Objective

Memastikan sistem melakukan validasi terhadap request yang tidak valid.

## Result

| Metric                | Value     |
| --------------------- | --------- |
| Success Rate          | 0%        |
| Failed Requests       | 100%      |
| Average Response Time | 117.72 ms |

## Sample Response

```json
{
  "error": "Invalid request body",
  "issues": "body: Either content or fileData must be provided"
}
```

## Analysis

Server menolak request kosong menggunakan HTTP 400 Bad Request.

Validasi berjalan dengan benar dan memberikan pesan error yang informatif kepada client.

Tidak ditemukan crash maupun error internal server.

## Conclusion

**PASS**

---

# Test Case 7 - Concurrent Virtual Users

## Objective

Menguji perilaku sistem ketika menerima banyak request secara bersamaan.

## Configuration

* Concurrent Users: 100 VUs
* Duration: 1 second burst

## Result

| Metric                | Value     |
| --------------------- | --------- |
| Total Requests        | 100       |
| Successful Requests   | 30        |
| Rejected Requests     | 70        |
| Success Rate          | 30%       |
| Rejection Rate        | 70%       |
| Average Response Time | 159.88 ms |

## Analysis

Sebagian request berhasil diproses.

Sebagian lainnya ditolak menggunakan HTTP 429 karena mekanisme rate limiting aktif.

Tidak ditemukan:

* Server crash
* Deadlock
* Memory exhaustion
* Timeout massal

Hasil menunjukkan bahwa sistem mampu mempertahankan stabilitas ketika menerima burst request secara bersamaan sambil tetap menerapkan proteksi terhadap spam.

Kegagalan request pada pengujian ini disebabkan oleh rate limiting yang memang dirancang untuk membatasi jumlah submission dari satu sumber dalam periode waktu tertentu, bukan karena kegagalan infrastruktur.

## Conclusion

**PASS**

---

# Overall Assessment

| Test Case                | Result       |
| ------------------------ | ------------ |
| Normal Submission        | PASS         |
| Rate Limit Protection    | PASS         |
| Large Payload Test       | PARTIAL PASS |
| XSS Injection Test       | PASS         |
| SQL Injection Test       | PASS         |
| Empty Payload Validation | PASS         |
| Concurrent Virtual Users | PASS         |

---

# Final Conclusion

Berdasarkan seluruh pengujian yang dilakukan, endpoint `/api/articles` menunjukkan stabilitas yang baik pada kondisi normal maupun berbagai skenario abnormal.

Temuan utama dari pengujian adalah:

* Endpoint mampu memproses request normal dengan tingkat keberhasilan 100%.
* Validasi input berjalan dengan baik untuk request yang tidak valid.
* Mekanisme rate limiting berhasil mencegah spam dan abuse request.
* Payload XSS dan SQL Injection tidak menyebabkan gangguan pada sistem backend.
* Karakter non-alfabet berhasil dinormalisasi sehingga payload tetap dapat diproses oleh pipeline NLP.
* Hasil preprocessing dari payload XSS dan SQL Injection tetap dapat diproses hingga tahap stemming dan wordcloud tanpa menyebabkan kegagalan sistem.
* Tidak ditemukan crash selama pengujian concurrent users.
* Payload berukuran besar berhasil diterima oleh API, namun menyebabkan bottleneck serius pada pipeline backend sehingga antrean pemrosesan tertahan selama lebih dari 3 jam.

Secara keseluruhan, sistem memiliki stabilitas yang baik pada sisi API, validasi input, proteksi keamanan dasar, serta kemampuan pemrosesan berbagai bentuk input tidak normal. Area utama yang memerlukan optimasi lebih lanjut adalah pipeline NLP dan mekanisme pemrosesan payload berukuran besar agar tidak menyebabkan backlog berkepanjangan pada antrean pemrosesan.
