# Paralel HTTP upload qəbulu — 9 noyabr 2026

Mobil qəbul sınaqları tamamlanıb: səssiz 4K oynatma/seek, sahibin private videosunun 11 dəqiqə sonra yenidən açılması, ayrıca səsli H.264/AAC klipin oynadılması və sarıldıqdan sonra səsin davam etməsi istifadəçi tərəfindən təsdiqlənib. [Server media/AI ölçmələri](PERFORMANCE_AI_SAMPLING_2026-11-09.md) ayrıca saxlanır. Yeni lokal upload dəsti həmin nəticələrdən fərqli mərhələni ölçür.

Bu ölçmədən sonrakı iş: [direct R2 backend-i lokalda hazırlanıb](DIRECT_UPLOAD_IMPLEMENTATION_2026-11-09.md). Aşağıdakı rəqəmlər əvvəlki multipart qəbul yolunundur; direct upload yaddaş/sürət nəticəsi kimi götürülməməlidir.

## Nə həqiqidir, nə simulyasiyadır

Yeni `scripts/perf/uploads.js` ayrıca müvəqqəti MongoDB replica set-i və loopback-də təsadüfi portda real Express tətbiqini açır. HTTP multipart body, JWT və provider yoxlaması, dəyişdirilməmiş rate/quota qaydaları, Multer disk storage, FFprobe, AWS SDK `Upload` multipart hissələri və MongoDB-də durable `queued` video qeydi həqiqidir. API üçün 25 ayrıca sintetik provider yaradılır. Baza və HTTP origin parametr kimi kənardan qəbul edilmir; production və staging ünvanları guard tərəfindən rədd edilir. Child proses caller açarlarını və `.env` faylını istifadə etmir.

R2 SDK `send` funksiyası yalnız bu run-a məxsus disk adapteri ilə əvəz olunur. `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload`, `PutObject`, `DeleteObject` yalnız `perf-private` bucket və sintetik private staging original key-ləri üçün qəbul edilir. Hissələr dəqiq sıra ilə yığılır; onların sayı və nəticənin SHA-256 dəyəri yoxlanır. Bu, Cloudflare R2, onun şəbəkəsi və multipart uğursuzluqlarının tam emulatoru deyil. Gemini, Redis, SMTP və video worker bu dəstdə işləmir.

Fayllar dəqiq **20 / 35 / 50 decimal MB** ölçüsündədir. Eyni bir saniyəlik 160×120 H.264/AAC sintetik videoya MP4 `free` box əlavə edilir. Tam fayl HTTP-dən və multipart storage yolundan keçir. Bu, qəbul zamanı byte/streaming/queue davranışını ölçür; 20–50 MB real 4K videonun decode, AI və worker yükünü təmsil etmir. Əvvəlki 5/10/25 worker sınaqları artıq queued job-lar idi; bu dəfə həqiqi HTTP upload qəbuluna baxılır.

## Ölçülən nəticə

Windows / Node 22.15.0 / i7-13620H / 16 logical CPU, təxminən 31.6 GiB RAM; generator, API və MongoDB eyni kompüterdədir. Hər kombinasiyada bir qısa burst var. Fayllar hər burst-dən sonra yoxlanıb təmizlənir; əvvəlki case-in job-ları növbəti case ilə birlikdə saxlanmır.

| Payload | Paralel provider | HTTP 201 | Tam HTTP müddəti p95, ms | API peak RSS, MiB |
|---|---:|---:|---:|---:|
| 20 MB | 5 | 5/5 | 588 | 268 |
| 20 MB | 10 | 10/10 | 1,018 | 324 |
| 20 MB | 25 | 25/25 | 2,192 | 594 |
| 35 MB | 5 | 5/5 | 536 | 320 |
| 35 MB | 10 | 10/10 | 1,228 | 437 |
| 35 MB | 25 | 25/25 | 2,883 | 1,024 |
| 50 MB | 5 | 5/5 | 649 | 335 |
| 50 MB | 10 | 10/10 | 1,659 | 496 |
| 50 MB | 25 | 25/25 | 3,764 | 1,013 |

9 kombinasiyada **120/120 upload** qəbul edilib; gözlənilməyən HTTP xəta və 429 yoxdur. Bütün qəbul edilmiş job-lar `queued/pending/inactive`-dir, original-lar private adapterdə byte səviyyəsində eynidir, public media yoxdur. AWS multipart hissələrinin sayı gözlənilən sayla eynidir; aktiv multipart, hissə və Multer temp faylı qalmayıb. API event-loop p95 bu burst-lərdə təxminən 22–40 ms-dir.

Birinci case-də eyni `Idempotency-Key` ilə faylı yenidən göndərmədən təkrar HTTP sorğusu `200/replayed` və eyni video ID-ni qaytarıb, əlavə job yaranmayıb. API child prosesi dayandırılıb yenidən başladıldıqdan sonra real `GET /videos/my-videos` və DB/storage hash yoxlamaları queued job-ların və original-ların saxlandığını təsdiqləyib.

Eyni provider üçün ayrıca 5 paralel upload sorğusu: **1 qəbul, 4 gözlənilən `429/UPLOAD_CONCURRENCY`**. Bu qoruma server xətası kimi sayılmır. Bir job yaranıb, temp/part faylı qalmayıb. Bu əlavə qəbul və replay 120 upload-luq performans matrisinə daxil deyil.

Ölçülən HTTP vaxtı client-in loopback üzərindən bütöv body-ni göndərməsini də əhatə edir. Bu, PDF-dəki direct `upload-init <300 ms` endpointinin ölçməsi deyil; həmin endpoint hələ yoxdur. 5/10/25 nümunənin p95-i yalnız bu burst-ün quyruğunu təsvir edir, xidmət SLO-su deyil. Warm cache, GC və eyni kompüterdə resurs paylaşımı nəticələrə təsir edir; 35 MB/c5-in 20 MB/c5-dən sürətli olması ayrıca optimizasiya kimi yozulmur.

## Resurs nəticəsi və məhdudiyyət

25 paralel qəbulda API RSS təxminən **1 GiB**-a çatır. Multer faylı diskə yazsa da AWS multipart hissələri və HTTP/storage buffer-ləri yaddaş istifadə edir. Bu ölçmə 50 ms aralıqla yalnız API Node prosesini izləyir; generator, MongoDB, FFprobe child və OS file cache daxil deyil. Bu rəqəm VPS-in 25 real yükləməni eyni gecikmə ilə daşıyacağına təminat vermir. Bu nəticə əsasında production concurrency və ya multipart queue ölçüsü dəyişdirilməyib.

Növbəti resurs işi üçün direct R2 upload və ya ölçülmüş ümumi upload paralelliyi həddi qiymətləndirilə bilər. Direct upload ayrıca auth/kvota/sahiblik/immutable finalization/replay/orphan/cleanup sınaqları və Flutter inteqrasiyası tələb edir. Hazırkı endpoint və mobil müqavilə saxlanılıb. Real R2 şəbəkəsi ilə uzunmüddətli yük, eyni vaxtda worker/AI işi, Redis/CDN və zəif mobil şəbəkə ayrıca mərhələlərdir. AI-nin bütün mərhələsi üçün `<5 s` hədəfi hələ təmin edilməyib. Production buraxılışı dəyişdirilməyib.

## Təkrar işlətmək

Windows-da layihə qovluğunda:

```text
node scripts/perf/uploads.js --sizes=20 --concurrency=5
node scripts/perf/uploads.js
npm run perf:uploads
```

Matris yalnız 20/35/50 MB və 5/10/25 seçimlərinə məhduddur. Hər provider üçün limitlər söndürülmür. Dəst maksimum 180 saniyəlik deadline istifadə edir, öz API/MongoDB child proseslərini bağlayır və öz upload temp qovluğunu təmizləyir. Sintetik fixture və hesabatlar ignored `tmp/performance/uploads-*` qovluğunda qalır. Mənbədəki istifadəçi faylları bu sınağa daxil edilmir.

Əsas nəticə: `tmp/performance/uploads-2026-11-09T15-39-58-805Z-fcsqRV/upload-report.json`. Runtime source hash `e4e3e2e8ccfdda27c6d96fbb01850a4f7c308e639ec9472bc2eb44b020bd1f15`, harness hash `fe14c421cff1762e7334616bddbd941618001b07e54344902d6d592e6cbcfd5e`. Runtime bazası `ffc1c33b193f9a6b31a8457cfab8482ffb8e75cb`; ölçmə zamanı yeni harness və sənədlər hələ working tree-də idi. İlk 20 MB/c5 smoke report-u `tmp/performance/uploads-2026-11-09T15-38-32-142Z-Hh61l4/upload-report.json`-dadır.

Source check, 35 unit/media/staging/performance və 30 integration testi keçib: **65 test**. Üç yeni test matris hədlərini, production/unrelated key-lərin rəddini, disk multipart yığımını, natamam commit-in rəddini, abort cleanup-ını və run sahiblik yoxlamasını əhatə edir.
