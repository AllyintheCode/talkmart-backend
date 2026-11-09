# AI kadr hazırlama — 9 noyabr 2026

Əvvəlki test-server buraxılışı `6c794e1` ilə yeni upload birinci cəhddə `ready/approved/active` oldu. Worker işi 130.397 saniyədən 20.459 saniyəyə endi; istifadəçi yeni videonun test APK-də normal oynadığını və irəli/geri sarıldığını təsdiqlədi. Production hələ əvvəlki audit buraxılışındadır. [Əvvəlki ölçmə](PERFORMANCE_ORIGINAL_UPLOAD_FIX_2026-11-09.md) tam rəqəmləri və məhdudiyyətləri saxlayır.

## Bu dəyişiklik

AI-nin 11.056 saniyəlik mərhələsi kadr hazırlama və Gemini çağırışını bir yerdə ölçürdü. İndi `ai_frames_ms` bütün kadr mərhələsini, `ai_model_ms` hər model cəhdini ayrıca ölçür. Retry iki model nümunəsi yarada bilər; bu göstəricilər proses üzrə aggregate-dir, video üzrə trace deyil. Mövcud `ai_ms` ümumi mərhələ olaraq qalır. Yeni sahələr public video cavabına əlavə edilmir.

8–30 saniyəlik, ən azı 8 MiB və 1080p sahəsi olan videoda FFprobe packet indeksi oxunur. Bu, kadrları decode etmir; maksimum 750 ms və 2 MiB çıxış limiti var. PTS başlanğıcı sıfır və etibarlı keyframe mövqeləri olduqda ayrı-ayrı dəqiq seek-lərin təxmini decode işi hesablanır. Proses açılışları üçün ehtiyat əlavə edildikdən sonra bu iş bir keçidin 65%-indən azdırsa ayrı seek seçilir. Digər qısa videolar əvvəlki bir keçid, 30 saniyədən uzun videolar əvvəlki ayrı seek yolu ilə işlənir. İndeks alınmasa əvvəlki bir keçid yoluna qayıdılır, AI avtomatik təsdiqlənmir.

Orijinal 4K nümunənin keyframe-ləri 0 / 3.04 / 6.08 / 9.12 / 12.16 / 15.2 / 18.24 saniyələrdədir. Dörd nümunə yenə 2.5 / 7.5 / 12.5 / 17.5 saniyələrdən alınır. Təxmini decode intervalı 17.5 saniyədən cəmi 6.56 saniyəyə düşür. Əvvəl emal edilmiş, 10 saniyəlik GOP-ları olan rendition-da ayrıca seek daha çox decode tələb etdiyindən bir keçid saxlanır. Bu, əvvəlki `AI_FRAME_TIMEOUT` probleminə qayıtmağın qarşısını alır.

Bir FFmpeg prosesi eyni anda işləyir, əvvəlki 2 decoder thread limiti saxlanır. İki paralel decoder prototipi lokalda əlavə təxminən 0.2 s qazandırsa da runtime-a daxil edilməyib. Dörd vaxt pəncərəsi, şəkil ölçüsü, ümumi 13.5 s kadr büdcəsi, hər seek üçün 5 s limit, 20 s AI büdcəsi, moderasiya qərarı və minimum confidence dəyişməyib. Çatışmayan kadrlar yenə yoxlamanı uğursuz edir; input və müvəqqəti fayllar əvvəlki qaydada təmizlənir.

## Lokal nəticə

Mənbə: `6195513-uhd_2160_3840_25fps.mp4`, 32,350,603 byte, SHA-256 `ae239bff40cb19d8168c8630d42baaca07bb8e7dfe92de633dcf7339a7689bfb`. Mənbə faylı dəyişməyib.

| Ölçmə | Əvvəlki bir keçid | Yeni seçim |
|---|---:|---:|
| Orijinal 4K: kadrlar | 3,738.7 ms, əvvəlki report | 2,017.2 / 1,990.6 / 1,993.4 ms |
| Dörd çıxışın sayı | 4 | Hər trial-da 4 |
| Orijinal video stream | Remux | Remux, 506 paket hash-i dəyişməyib |
| Uzun GOP-lu 4K rendition | Bir keçid | Bir keçid, 3,390.6 ms |

Eyni dörd orijinal kadrın yeni çıxışındakı decode olunmuş piksel buffer-ləri əvvəlki bir keçid nəticəsi ilə tam eynidir. Rəngli dörd zaman pəncərəsi olan real H.264 fixture-lər həm qısa, həm uzun GOP üçün yoxlanıb. Natamam nümunələr, bitmiş deadline və müvəqqəti faylların silinməsi də yoxlanıb.

Ölçmələr ayrı lokal trial-lardır; warm cache, proses yükü və avadanlıq fərqləri təsir edə bilər. Lokal ölçmələr VPS-də Gemini vaxtı, AI üçün `<5 s`, worker üçün `<20 s`, p95 və ya tam upload müddəti kimi təqdim edilmir. Ayrı server nəticəsi aşağıda qeyd olunub.

Lokal nəticələr:

- `tmp/performance/media-2026-11-08T22-17-13-289Z-JqmItL/media-report.json`: orijinal, 3 trial, source hash `e4e3e2e8ccfdda27c6d96fbb01850a4f7c308e639ec9472bc2eb44b020bd1f15`.
- `tmp/performance/media-2026-11-08T22-17-57-965Z-lipaHo/media-report.json`: uzun GOP-lu rendition, bir keçid saxlanır.
- `tmp/performance/adaptive-sampling-pixel-check.json`: dörd kadrın piksel eyniliyi.
- Əvvəlki lokal bir keçid: `tmp/performance/media-2026-11-08T21-28-44-126Z-JgXRF8/media-report.json`.

Lint, 32 unit/media/performance/staging və 30 integration testi keçib: **62 test**. Bundan əlavə, real worker prosesində 6 lokal ssenari keçib: download zamanı SIGKILL və recovery, private commit/public copy arasındakı SIGKILL və recovery, model 503 olduqda private review, 5/10/25 növbəyə qoyulmuş iş. Son üç batch-də ayrıca kadr/model metriklərinin nümunə sayı işlərin sayı ilə eynidir. Report: `tmp/performance/worker-2026-11-08T22-18-44-246Z-tJtydM/worker-report.json`. Modelin təxminən 250 ms cavabı və R2 orada simulyasiya edilir, real xidmət performansı ölçülmür.

## Test serverinə tətbiq və növbəti ölçmə

Yalnız `/var/www/backend-perf-test-20261108` və `talkmart-worker-test` hədəfdir. Yeni paket `6c794e1` üzərinə fast-forward tətbiq olunub: `ffc1c33b193f9a6b31a8457cfab8482ffb8e75cb`. Boş test növbəsi, staging env, process yolları və production PID-ləri yoxlanıb. Serverdə 32 test keçib və yeni worker heartbeat təsdiqlənib. Test API və production PID-ləri saxlanıb; DB miqrasiyası və mövcud videoların təkrar emalı yoxdur. Köhnə upload-a recheck etmək yeni işin tam vaxtını ölçməz.

Yeni `PERF test təmizlik 3` upload-u `perf-upload-20261109-03` açarı ilə qəbul olunub: `6af0f77287dd1d2bb07b2f21`. `scripts/staging/check-upload.js --id=6af0f77287dd1d2bb07b2f21 --wait` nəticəsində `ready/approved/active`, AI 95 bal və bir cəhd təsdiqlənib.

## Serverdə ölçülən nəticə

| Mərhələ | Lazımsız encode ilə | Remux düzəlişi | Adaptiv kadr seçimi |
|---|---:|---:|---:|
| Worker işi | 130,397 ms | 20,459 ms | 14,586 ms |
| AI, kadrlar daxil | 14,314 ms | 11,056 ms | 6,931 ms |
| FFmpeg hazırlama | 117,040 ms | 350 ms | 420 ms |
| createdAt → private media commit | 127.254 s | 20.524 s | 15.040 s |

Yeni metriklər: `ai_frames_ms=5,259`, `ai_model_ms=1,671`; hərəsində bir nümunə var. AI toplamı ölçmə sərhədlərinə görə cəmdən 1 ms fərqlənir. R2 download 1,061 ms, private upload/thumbnail mərhələsi 4,132 ms, queue göstəricisi 2,674 ms-dir. Bu mərhələlərin ölçmə sərhədləri və paralelliyi fərqlidir; hamısını sadə cəmlə worker müddəti kimi təqdim etmək düzgün deyil.

Bu trial-da worker işi əvvəlki remux buraxılışına nisbətən 28.71%, AI mərhələsi 37.31% azalıb. İlkin işlə müqayisədə worker təxminən 8.94 dəfə sürətlidir. Dəyişən model/şəbəkə vaxtı da müqayisəyə təsir edir; bütün fərq yalnız kadr koduna aid edilmir. Əvvəlki worker-də ayrıca kadr metrikləri olmadığından serverdə kadr müddətinin dəqiq əvvəl/sonra nisbəti çıxarılmır.

Yeni worker PID 680359, başlanğıc `2026-11-08T22:26:31.226Z`, heartbeat `22:28:36.141Z`, report müşahidəsi `22:28:40.604Z`. Video `22:28:02.619Z` yaradılıb, private media `22:28:17.659Z` commit olunub. Mənbə ölçüsü yenə 32,350,603 byte, private/public MP4 ölçüsü 32,350,392 byte-dır; revocation gözləmədə deyil.

Server report: `tmp/upload-check-6af0f77287dd1d2bb07b2f21-ea5c02c0-2275-470d-9582-7d813a455438.json`. Lokal əməliyyat qeydi: `tmp/deployment/ai-sampling-server-result.json`.

Bu bir iş nümunəsi 20 saniyədən aşağıdır, p95 və ya bütün videolar üçün təminat deyil. Ümumi AI 6.931 saniyə olduğundan PDF-dəki `<5 s AI` hədəfi hələ keçməyib; yalnız model çağırışının 1.671 s olmasını bütün AI mərhələsinin vaxtı kimi götürmək olmaz. Client internet upload-u və sonrakı public copy tam olaraq `createdAt → completedAt` intervalına daxil deyil. Adaptiv yolun seçimi report-da ayrıca yazılmır; burada ölçülən kadr vaxtı yeni kodun ümumi extraction müddətidir.

İstifadəçi manual APK sınağında uyğun olmayan videonun yalnız sahibinin profilində qaldığını, başqa user və lentdə görünmədiyini, 11 dəqiqə sonra profilə qayıdıb videonu açanda normal oynadığını təsdiqləyib. Bu, həmin istifadəçi axınının keçməsidir; yeni URL alınması ilə cached playback-i ayıran şəbəkə trace-i götürülməyib.

Səsli klip üçün ayrıca lokal `tmp/deployment/talkmart-audio-test-20261109.mp4` hazırlanıb: əvvəlki təmizlik videosunun ilk 8 saniyəsi, 2160×3840 H.264 görüntü və əlavə edilmiş 440 Hz mono AAC test tonu. Bu, səhnənin orijinal səsi deyil. Fayl 13,257,584 byte-dır. Lokal real backend remux-u video və audio paket hash-lərini saxlayır; remux-dan decode olunmuş audio səssiz deyil. Orijinal mənbə faylı dəyişməyib. Report: `tmp/deployment/audio-test-manifest.json`.

Real staging upload `6af1e68f87dd1d2bb07b2f23` (`PERF səsli təmizlik`) eyni `ffc1c33` kodunda `ready/approved/active`, AI 95 bal və bir worker cəhdi ilə tamamlanıb. `createdAt=2026-11-09T15:28:15.961Z` → `completedAt=2026-11-09T15:28:35.813Z`, private media commit intervalı 19.852 s-dir. Private/public MP4 13,257,583 byte-dır, revocation gözləmədə deyil. Bu interval client upload-u və sonrakı public copy-ni tam əhatə etmir. 8 saniyəlik yeni klip əvvəlki 20 saniyəlik klipin sürət müqayisəsi kimi götürülməməlidir.

Bu dəfə worker PID yenə 680359-dur və metriklər 3 media işi / 4 model cəhdi üzrə aggregate-dir. `video_job_ms p95=18,318`, `ai_ms p95=14,140`, `ai_frames_ms p95=5,259`, `ai_model_ms p95=6,508` dəyərləri yalnız bu səsli videonun vaxtları deyil və belə kiçik nümunə xidmət p95 təminatı yaratmır. Server report: `tmp/upload-check-6af1e68f87dd1d2bb07b2f23-2a83d876-5022-4473-b81a-7ce74d201765.json`; lokal əməliyyat qeydi `tmp/deployment/audio-test-server-result.json`. İstifadəçi test APK-də test səsinin eşidildiyini, irəli/geri sarılmanın işlədiyini və sarıldıqdan sonra səsin davam etdiyini təsdiqləyib. Səsli mobil oynatma sınağı keçib.

Direct R2 upload, real paralel HTTP upload və production Redis/CDN yük sınaqları bu paketin hissəsi deyil. Production-a keçid edilməyib.

Növbəti lokal iş: [real paralel HTTP upload qəbulu sınağı](PERFORMANCE_PARALLEL_UPLOAD_2026-11-09.md). Bu, worker-də əvvəlcədən yaradılmış job batch-lərindən ayrıca ölçmədir.

Texniki mənbələr: FFmpeg-in [dəqiq input seek izahı](https://github.com/FFmpeg/FFmpeg/blob/master/doc/ffmpeg.texi) və FFprobe-un [packet və seçilmiş sahələrin çıxışı](https://github.com/FFmpeg/FFmpeg/blob/master/doc/ffprobe.texi). Packet indeksi yol seçir, moderasiya sübutu isə həmişə decode olunmuş dörd şəkildir.
