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

Serverə çıxarılma və yeni upload vaxtı bu qeydin yazıldığı anda hələ gözlənilir. Düzəlişdən sonra eyni mənbə **yeni** Idempotency-Key (`perf-upload-20261109-02`) ilə yüklənməlidir. Yeni commit vaxtı, worker AI/FFmpeg/preparation göstəriciləri və çıxış ölçüsü müqayisə olunur. APK-də H.264 level 5.2 olan orijinal axının səs/istiqamət/seek/playback uyğunluğu ayrıca yoxlanmalıdır. Production-a keçid edilməyib.

Texniki mənbə: [FFmpeg H.264 level yoxlaması](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/h264_levels.c) — H.264 MaxBR cədvəli və profil üzrə NAL bitrate faktorları.
