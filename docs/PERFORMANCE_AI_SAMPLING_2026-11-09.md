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

Ölçmələr ayrı lokal trial-lardır; warm cache, proses yükü və avadanlıq fərqləri təsir edə bilər. Bunlar VPS-də Gemini vaxtı, AI üçün `<5 s`, worker üçün `<20 s`, p95 və ya tam upload müddəti kimi təqdim edilmir. Serverdə yeni upload hələ tələb olunur.

Lokal nəticələr:

- `tmp/performance/media-2026-11-08T22-17-13-289Z-JqmItL/media-report.json`: orijinal, 3 trial, source hash `e4e3e2e8ccfdda27c6d96fbb01850a4f7c308e639ec9472bc2eb44b020bd1f15`.
- `tmp/performance/media-2026-11-08T22-17-57-965Z-lipaHo/media-report.json`: uzun GOP-lu rendition, bir keçid saxlanır.
- `tmp/performance/adaptive-sampling-pixel-check.json`: dörd kadrın piksel eyniliyi.
- Əvvəlki lokal bir keçid: `tmp/performance/media-2026-11-08T21-28-44-126Z-JgXRF8/media-report.json`.

Lint, 32 unit/media/performance/staging və 30 integration testi keçib: **62 test**. Bundan əlavə, real worker prosesində 6 lokal ssenari keçib: download zamanı SIGKILL və recovery, private commit/public copy arasındakı SIGKILL və recovery, model 503 olduqda private review, 5/10/25 növbəyə qoyulmuş iş. Son üç batch-də ayrıca kadr/model metriklərinin nümunə sayı işlərin sayı ilə eynidir. Report: `tmp/performance/worker-2026-11-08T22-18-44-246Z-tJtydM/worker-report.json`. Modelin təxminən 250 ms cavabı və R2 orada simulyasiya edilir, real xidmət performansı ölçülmür.

## Test serverinə tətbiq və növbəti ölçmə

Yalnız `/var/www/backend-perf-test-20261108` və `talkmart-worker-test` hədəfdir. Yeni paket `6c794e1` üzərinə fast-forward tətbiq olunur; boş test növbəsi, staging env, process yolları və production PID-ləri yoxlanır. Test API və production restart edilmir; DB miqrasiyası və mövcud videoların təkrar emalı yoxdur. Köhnə upload-a recheck etmək yeni işin tam vaxtını ölçməz.

Yeniləmədən sonra eyni orijinal ilə yeni `PERF test təmizlik 3` upload-u və yeni `Idempotency-Key` istifadə olunmalıdır. Sonra mövcud `scripts/staging/check-upload.js --id=<yeni-id> --wait` ilə yeni PID-yə aid metriklər götürülür. Kadr və model vaxtlarını bu nəticə ayıracaq. Signed preview-nun 600 saniyədən sonra yenilənməsi Flutter tərəfdə ayrıca qəbul sınağı olaraq qalır. Direct R2 upload, real paralel HTTP upload və production Redis/CDN yük sınaqları bu paketin hissəsi deyil.

Texniki mənbələr: FFmpeg-in [dəqiq input seek izahı](https://github.com/FFmpeg/FFmpeg/blob/master/doc/ffmpeg.texi) və FFprobe-un [packet və seçilmiş sahələrin çıxışı](https://github.com/FFmpeg/FFmpeg/blob/master/doc/ffprobe.texi). Packet indeksi yol seçir, moderasiya sübutu isə həmişə decode olunmuş dörd şəkildir.
