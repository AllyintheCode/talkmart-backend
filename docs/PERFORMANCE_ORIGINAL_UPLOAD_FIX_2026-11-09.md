# Orijinal 4K upload-da lazımsız encode — 9 noyabr 2026

335eeac test buraxılışında real upload funksional olaraq keçdi: `6af0e6d487dd1d2bb07b2f1f` birinci cəhddə `ready/approved/active`, AI source və 95 bal aldı. Lakin `createdAt=2026-11-08T21:17:08.286Z` → `completedAt=2026-11-08T21:19:15.540Z` intervalı **127.254 saniyədir**. Bu, media commit-ə qədər olan vaxtdır; telefondan API-yə upload və sonrakı public copy vaxtının tam ölçüsü deyil. `updatedAt` maintenance və digər yazılarda dəyişdiyinə görə bitmə vaxtı kimi götürülmür.

## Səbəb və düzəliş

İlkin smart compression qaydasında 12 Mbps sabit limit vardı. Real testin 32,350,603 byte-lıq mənbəyi H.264 High, level 5.2, 8-bit yuv420p, 2160×3840, 25 FPS, 20.24 s, səssiz və fırlanmasızdır. Video bitrate-i 12,784,205 bit/s-dir. Digər remux şərtlərinə uyğun olsa da həmin sabit limitdən yuxarı olduğu üçün yenidən encode edilirdi. Bu, istifadəçinin orijinal keyfiyyəti saxlamaq seçimi üçün lazımsız iş idi.

Sabit bandwidth limiti H.264 səviyyə/profilinin NAL bitrate həddi ilə əvəz edilib. Mövcud codec, pixel format, profil, maksimum level 5.2, 30 FPS, rotation, səs, stream sayı və 195 MB remux giriş limiti saxlanılıb. Uyğun olmayan və ya səviyyə həddini aşan girişlər H.264/AAC çevirmə yolunda qalır. Bu yoxlama bütün decoder/device uyğunluğunun tam sübutu deyil; real APK yoxlaması tələb olunur.

## Eyni orijinal faylda lokal müqayisə

Bu ölçmə əvvəlki hesabatdakı 26.72 MB-lıq artıq emal edilmiş staging rendition-dan fərqli olaraq orijinal Downloads faylındadır: `6195513-uhd_2160_3840_25fps.mp4`. Ölçüsü server cavabının `sourceBytes` sahəsi ilə eynidir. Serverdə mənbə SHA-256 saxlanmadığından onun kriptoqrafik eyniliyi həmin cavabla ayrıca sübut edilmir.

Hər iki lokal trial-da eyni giriş SHA-256: `ae239bff40cb19d8168c8630d42baaca07bb8e7dfe92de633dcf7339a7689bfb`. Giriş dəyişməyib.

| Ölçmə | Düzəlişdən əvvəl | Düzəlişdən sonra |
|---|---:|---:|
| Rejim | transcode | remux |
| Video hazırlama | 46,538.6 ms | 264.3 ms |
| Ölçülən lokal ardıcıl mərhələlərin cəmi | 52,271.6 ms | 5,177.0 ms |
| Çıxış ölçüsü | 26,721,428 byte | 32,350,393 byte |
| Resolution / FPS / müddət | 2160×3840 / 25 / 20.24 s | 2160×3840 / 25 / 20.24 s |
| H.264 level | 5.1, yenidən encode | Orijinal 5.2 saxlanılıb |

Yeni çıxışdakı **506 video paketinin hamısının SHA-256 dəyərləri mənbə ilə eynidir**. Audio yoxdur. Container metadata/faststart yenidən yazıldığından bütöv MP4 faylının hash-i eyni olmalı deyil. Yeni çıxış əvvəlki encode nəticəsindən təxminən 5.63 MB böyükdür; bu, keyfiyyəti və orijinal axını saxlamaq seçiminin nəticəsidir.

Bu iki lokal trial VPS p95 və ya yeni server emal vaxtı deyil. AI, R2, queue və mobil şəbəkə ölçməyə daxil deyil. Kadr/thumbnail vaxtlarındakı trial fərqləri həmin kodda yeni optimizasiya kimi təqdim edilmir.

- Əvvəlki report: `tmp/performance/media-2026-11-08T21-23-09-074Z-ssrz7I/media-report.json`, source hash `17d479324ce17258a893d2187862b525ca9eda87fcc892962870d77115cd0d50`.
- Yeni report: `tmp/performance/media-2026-11-08T21-28-44-126Z-JgXRF8/media-report.json`, source hash `6e27a477a62797269b603911877c2db411e32858112742dd8afb3d3e2a55d7dd`.

## Yoxlamalar və test serverində davam

Lint, 30 unit/media/performance/staging və 30 integration testi keçdi: **60 test**. 12 Mbps-dən yuxarı real H.264 fixture-in paketləri remux zamanı dəyişmir; qeyri-mümkün bitrate/level və ölçü limitləri rədd edilir. Digər codec üçün transcode testi də keçib. İlk 100k/API və worker crash nəticələri əvvəlki revision-a aiddir, yenidən işlədilmiş kimi təqdim edilmir.

`scripts/staging/check-upload.js --id=<id> [--wait]` yalnız test provider-in videosunu, R2 obyekt ölçülərini və cari test worker-in ümumi mərhələ metriklərini oxuyur. Credential, media key və imzalı URL çap etmir. Worker göstəriciləri proses üzrə aggregate-dir, per-video trace deyil. Worker restartından əvvəl köhnə upload üçün göstəricilər saxlanmalıdır.

`scripts/staging/restart-test-worker.js` test qovluğu/proses yollarını və boş video növbəsini yoxlayıb yalnız `talkmart-worker-test`-i yenidən başladır. Yeni PID-yə aid heartbeat, test health, test API və production PID-lərinin saxlanması yoxlanır. API endpointləri və MongoDB schema dəyişmir; mövcud videolar yenidən emal edilmir.

## Test serverində təsdiqlənmiş nəticə

`6c794e124ccebf4e74bcc5a2c665f32e0d1bb346` yalnız test worker-ə tətbiq edilib; yeni heartbeat yoxlanıb, test API və production proseslərinin PID-ləri saxlanıb. Serverdə media/preparation üzrə 9 test də keçib. Yeni upload `perf-upload-20261109-02`, video ID `6af0ee2f87dd1d2bb07b2f20` ilə birinci cəhddə `ready/approved/active`, AI 95 bal alıb.

| Mərhələ | Köhnə worker / upload | Düzəlişdən sonra |
|---|---:|---:|
| FFmpeg hazırlama | 117,040 ms | 350 ms |
| AI, kadrlar daxil | 14,314 ms | 11,056 ms |
| Paralel hazırlama | 117,042 ms | 11,056 ms |
| R2 download | 3,375 ms | 1,169 ms |
| Private upload və thumbnail mərhələsi | 3,907 ms | 4,714 ms |
| Worker işi | 130,397 ms | 20,459 ms |
| createdAt → private media commit | 127.254 s | 20.524 s |
| Private/public MP4 ölçüsü | 26,723,964 byte | 32,350,392 byte |

Worker işi bu sınaqda təxminən **6.37 dəfə sürətlənib**, vaxt 84.31% azalıb. İki worker prosesinin hərəsində yalnız bir media job nümunəsi var; bunlar p95 təminatı deyil. Hər iki halda `sourceBytes=32,350,603`, müddət 20 s, bir cəhd və AI 95 baldır. Mənbə internet upload-u ayrıca ölçülməyib. `r2_upload_ms` thumbnail yaradılmasını da əhatə edir; yalnız şəbəkə vaxtı deyil. `ai_ms` kadr çıxarma və model çağırışını birlikdə ölçür.

Yeni worker PID 677419, heartbeat `2026-11-08T21:49:57.121Z`; müşahidə `2026-11-08T21:50:02.092Z`-dir. İstifadəçi yeni videonun telefondakı test APK-də normal oynadığını və irəli/geri sarıldığını təsdiqləyib. Bu mənbədə səs yoxdur, ayrıca səsli mobil klip sınağı kimi təqdim edilmir.

Server hesabatları: `tmp/upload-check-6af0e6d487dd1d2bb07b2f1f-0c758e63-21cd-4f46-aba8-2583d6ccd1ca.json` və `tmp/upload-check-6af0ee2f87dd1d2bb07b2f20-3d3f70aa-62b4-4086-afcf-1204ced319ae.json`. Lokal əməliyyat qeydi: `tmp/deployment/bitrate-fix-manifest.json`.

AI mərhələsi 11.056 s və worker işi 20.459 s olduğuna görə PDF-dəki `<5 s AI` və sərt `<20 s processing` hədəflərinin keçdiyi iddia edilmir. Növbəti profiling kadr/model vaxtını ayırmaq üçündür. Direct upload və Redis/CDN ayrıca mərhələlərdir. Production-a keçid edilməyib.

Texniki mənbə: [FFmpeg H.264 level yoxlaması](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/h264_levels.c) — H.264 MaxBR cədvəli və profil üzrə NAL bitrate faktorları.

Növbəti lokal mərhələ: [AI kadr seçimi və ayrıca vaxt ölçmələri](PERFORMANCE_AI_SAMPLING_2026-11-09.md). Yeni kadr optimizasiyası üçün serverdə ayrıca upload nəticəsi hələ tələb olunur.
