# Performans planının təhlili və lokal ölçmə

Ən son vəziyyət: [10 noyabr production buraxılışı](PRODUCTION_PERFORMANCE_RELEASE_2026-11-10_AZ.md) tamamlanıb; [qalan Flutter işləri](PRODUCTION_FLUTTER_HANDOFF_2026-11-10_AZ.md) və ölçmə hədəfləri ayrılıqda saxlanır. Əvvəlki [9 noyabr paralel HTTP upload hesabatı](PERFORMANCE_PARALLEL_UPLOAD_2026-11-09.md), [server AI/media və APK nəticələri](PERFORMANCE_AI_SAMPLING_2026-11-09.md) müqayisə materialıdır. Aşağıdakı müqayisə ilkin vəziyyətin və yol xəritəsinin qeydidir.

[Birbaşa hissəli R2 upload backend-i](DIRECT_UPLOAD_IMPLEMENTATION_2026-11-09.md) həm staging, həm production-da aktivdir. Real R2/server sınaqları keçib; yeni mobil axının Flutter inteqrasiyası və APK problemlərinin düzəlişi qalır. PDF-in bütün SLO və yük hədəfləri keçmiş sayılmır.

Mənbə: `Talkmart_Backend_Performans_Optimizasiya_Plani_2026-10-25.pdf`, 15 səhifə. Müqayisə bazası: canlıya çıxmış `94cc79d5d57365fcd41aeecb576587e49dcc19b3`. Sənəddəki vaxtlar və prioritetlər təklifdir; hazırkı sistemin ölçülmüş nəticəsi deyil.

İlk mərhələdə mövcud backend-in ayrıca lokal sınaq mühiti yaradılıb. Aşağıdakı müqayisə dəyişiklikdən əvvəlki vəziyyəti təsvir edir. Sonra istifadəçinin göstərişi ilə private media, Explore və keyfiyyəti saxlayan remux lokal branch-də tətbiq edilib. Yeni davranış, əvvəl/sonra ölçmələri və qalan testlər [8 noyabr optimizasiya hesabatındadır](PERFORMANCE_OPTIMIZATION_2026-11-08.md). Canlı VPS-ə yük göndərilmir, real istifadəçilər/baza köçürülmür.

## PDF ilə ilkin kodun müqayisəsi

| İstiqamət | Hazırkı vəziyyət | Növbəti yoxlama və ya iş |
|---|---|---|
| 1. Direct R2 upload | Yoxdur. Fayl API/Multer-dən private staging bucket-ə keçir. | `upload-init` / `upload-complete`, icazə müddəti, sahiblik, real ölçü/format, idempotency, yarımçıq upload, təkrar PUT/complete və resume sınaqları. Flutter dəyişiklikləri də tələb olunur. |
| 2. AI / FFmpeg paralelliyi | Hazırda AI, transcode və media yazılması ardıcıldır. | Mərhələ vaxtlarını ayrıca ölçüb paralelləşdirməni eyni fayllarla müqayisə etmək. Rədd/timeout/admin qərarı qaydaları saxlanmalıdır. |
| 3. Durable worker | MongoDB-də lease, heartbeat, retry və idempotency ilə ayrıca worker var. | BullMQ əlavə etmək ilkin şərt deyil: hazırkı mexanizmin tələb olunan davranışı artıq var. Həqiqi worker-prosesinin iş ortasında öldürülməsi və 5/10/25 upload altında bərpa ayrıca ölçülməlidir. |
| 4. Smart compression | Stream ilə R2 yazılması var. Uyğun video da yenidən H.264/AAC encode olunur, resolution saxlanılır. | Copy/remux/transcode seçimi üçün cihaz siyasəti; eyni giriş faylında vaxt, ölçü, keyfiyyət və playback müqayisəsi. |
| 5. MongoDB | Limit, sahə seçimi, cursor və indekslər var. Feed `$sample` edir; explore owner join və ümumi say üçün `$facet` işlədir. | Real API-dən tutulmuş pipeline üzrə `executionStats`, baxılan sənəd/açar sayı və owner lookup ölçülür. Cursor ikinci səhifə, dərin səhifə, axtarış və 100k məlumat ayrıca genişləndirmədir. |
| 6. Redis | Kateqoriya/onboarding versiyaları, DB fallback və `SCAN` mövcuddur. | Ayrıca Redis nümunəsi ilə hit/miss, invalidasiya və stampede ölçmək. Feed hazırda təzə görünürlük qərarını bazadan oxuyur; sadə TTL keşinin bloklanan/rədd edilən videonu geri göstərməsinə yol verilməməlidir. |
| 7. Playback / CDN | MP4 faststart, WebP, versiyalı media key-ləri və HTTP Range var; real serverdə media oynadılıb. | Cache-Control/CDN hit, real telefonda ilk kadr, zəif 4G, prefetch və data sərfi ayrıca ölçülməlidir. Lokal HTTP vaxtı ilk video kadrının vaxtı deyil. |
| 8. Gemini | Zod schema, ümumi 20 s büdcə, məhdud cəhdlər, manual review və model konfiqurasiyası var. | Real model p95, 429/503/backoff və keyframe/network vaxtlarını ayrıca ölçmək. Lokal dəstdə real Gemini çağırılmır. |
| 9. API payload | Bağlantılar proses üzrə təkrar istifadə edilir, DTO və gzip var. | Wire/decompressed byte sayları ölçülür. Uyğunluq üçün cavabda həm köhnə top-level sahələr, həm `data` var; bunu silmək Flutter kontraktını dəyişir. |
| 10. Monitoring | Worker mərhələ metrikləri var; bütün mərhələlər ayrıca ayrılmayıb. | Lokal dəst HTTP p50/p95/p99, xəta/429, DB əmrləri, Node CPU/RSS və event-loop ölçür. İstehsalda trace/alert və ayrıca FFmpeg/DB resurs ölçmələri qalır. |

### Əlavə uyğunluq fərqi: rədd edilmiş faylın saxlanması

PDF-in 3, 5 və 10-cu səhifələri yalnız təsdiqlənmiş media üçün public/CDN çıxışı istəyir. Hazırda orijinal private staging-dədir və API ictimai nəticələrdə yalnız ready/approved/active videonu göstərir. Lakin worker review/rejected nəticəsinin sıxılmış faylını da public media bucket-də saxlayır və URL-ni sahibinin siyahısında qaytarır. URL məlum olduqda obyekt səviyyəsində məxfilik API lent filtrindən fərqli məsələdir.

Bu, yeni planla ayrıca həll edilməli boşluqdur: təsdiqsiz emal nəticələrini private bucket/prefix-də saxlamaq, provider/admin baxışını qısaömürlü icazə ilə vermək və yalnız təsdiqdə public obyekt yaratmaq. Lokal feed sınağının keçməsi obyektin private olmasını sübut etmir. Bu dəyişiklik R2 cleanup, admin override və playback regressiyası ilə birlikdə yoxlanmalıdır.

### Nələri olduğu kimi köçürmək düzgün olmaz

- PDF-dəki `processingState` / `moderationDecision` nümunə adlarıdır. Mövcud API `processingStatus` / `moderationStatus` istifadə edir; adların dəyişməsi mobil kontraktı poza bilər.
- BullMQ yeni funksional tələb deyil. İki ayrı növbə mexanizmi yaratmadan mövcud durable MongoDB worker-i ölçmək daha əsaslıdır.
- `720p`, paralellik və cache TTL rəqəmləri əvvəlcədən təminat deyil. Keyfiyyət, təhlükəsizlik, CPU və gecikmə birlikdə müqayisə olunmalıdır.
- 20 saniyə hədəfi internet upload-u daxil etmir. Hazırkı AI büdcəsi də bütöv videonun 20 saniyəyə hazır olacağı demək deyil.
- R2 presigned URL müəyyən əməliyyat/obyekt/müddət üçün bearer icazəsidir; istifadə edildikdən sonra avtomatik birdəfəlik olmur. Complete-dən sonra eyni key-in dəyişdirilməsi ayrıca TOCTOU sınağı tələb edir. MIME başlığı təkbaşına video doğrulaması deyil.

## Lokal dəsti işə salmaq

Əmrlər Windows kompüterində bu layihənin qovluğunda işlədilir. Serverə SSH daxilində işlətmək lazım deyil. Asılılıqlar `npm ci --include=dev` ilə quraşdırılır. Ölçmə dəsti ayrıca load-generator paketi tələb etmir; sonrakı private preview funksiyası üçün AWS presigner əlavə olunub. İlk dəfə MongoDB test executable-i rəsmi distributordan yüklənə bilər.

```text
npm run perf:api
npm run perf:media
```

`perf:api` öz müvəqqəti MongoDB replica set-ini və real Express tətbiqini ayrıca prosesdə qaldırır, sınaq bitəndə onları bağlayır. Baza və port kənardan verilmir. `.env` oxunmur: child prosesə ayrıca test açarları və istifadə olunmayan dotenv yolu verilir. R2/SMTP localhost-un bağlı portuna yönləndirilir, Gemini açarları boşdur, Redis söndürülür. Backend işçi prosesi və xarici xidmət çağırışları bu sınaqda işləmir.

Məlumatlar: 20 sintetik provider, 1 istifadəçi, 7 kateqoriya; approved/pending/review/rejected/hidden videolar, blocked/deleting/unverified owner-lər və qarşılıqlı bloklama. Media URL-ləri `media.invalid` placeholder-dir, onlara sorğu edilmir. Authed feed üçün test sessiyası yaradılır və həqiqi auth middleware istifadə olunur; login/şifrə hash vaxtı ölçülmür.

Standart API matrisi: 1k və 10k video, hər ssenariyə 5 warmup + 100 ölçülən sorğu, paralellik 1 və 4. Ssenarilər: guest feed, authenticated feed, explore newest, gzip guest feed. Hər sınaq eyni təhlükəsizlik limitləri ilə ayrıca sintetik proxy client IP-dən gedir; 429 cavabları ayrıca sayılır və uğurlu gecikmə percentillərinə qarışdırılmır. Localhost-a bind və run identifikatoru yoxlaması test başlıqlarının canlı serverə göndərilməsinin qarşısını alır.

```text
node scripts/perf/api.js --videos=1000 --requests=100 --concurrency=1,4
node scripts/perf/api.js --videos=100000 --requests=100 --concurrency=1,4
```

Video sayı maksimum 100k, sorğu sayı hər ssenari üçün maksimum 200, paralellik maksimum 8-dir. Bu, tədrici lokal başlanğıc dəstdir; 100k sınağı standart əmrlə avtomatik işləmir.

API hesabatı: `tmp/performance/api-*/api-report.md`, `api-report.json`, hər ssenari üçün `explain-*.json`. Explain pipeline ayrıca təqlid edilmir: real HTTP sorğusunda MongoDB driver-dən tutulur və öz test bazasında `executionStats` ilə icra edilir. DB əmrlərinə rate-limit yazılması da daxildir. Explain baxış sayları API gecikməsinin əvəzi deyil; cursor və lookup sayları ayrıca göstərilir.

`perf:media` standart olaraq qısa 720p və portrait 1080p `testsrc2` videoları yaradır. Mövcud media funksiyalarını işlədir: FFprobe, dörd keyframe, remux/transcode və WebP thumbnail. Modelə sorğu göndərilmir, fayl yüklənmir. Giriş faylının SHA-256 dəyəri sınaqdan sonra yenidən yoxlanır. Yeni çıxış təmizlənir; orijinal giriş faylı saxlanılır. Hesabatdakı `processingMode` seçilmiş yolu göstərir.

```text
node scripts/perf/media.js --input="C:\path\to\video.mp4" --runs=1
```

Parametrli çağırışlar birbaşa `node` ilə göstərilir: bu, Windows PowerShell-də `npm.ps1` üzərindən `--` və əlavə arqumentlərin ötürülməsi fərqini aradan qaldırır.

Media hesabatı: `tmp/performance/media-*/media-report.md` və `media-report.json`. Tək və ya bir neçə trial-dan ümumi media p95 nəticəsi çıxarılmır. VMAF/SSIM, R2 şəbəkəsi, canlı Gemini, queue və FFmpeg child CPU/RAM bu ölçməyə daxil deyil.

## Nəticəni necə şərh etmək lazımdır

- Bu real API və real MongoDB ilə lokal ölçmədir. Generator, API və tək MongoDB üzvü eyni kompüteri bölüşür; Atlas şəbəkəsi, VPS diski, real trafik bölgüsü və Redis burada yoxdur.
- Bounded closed-loop testdə server yavaşladıqca yeni sorğuların başlanması da yavaşıyır. Göstərilən RPS sistemin maksimum tutumu deyil. Tutum sınağı üçün ayrıca load generator və k6 arrival-rate ssenariləri lazımdır.
- 100 sorğulu p95/p99 ilkin göstəricidir, uzunmüddətli statistik təminat deyil. 500 ms PDF-dən gələn başlanğıc hədəfdir; aşılma məlumat kimi qeyd edilir. Kontrakt, məxfilik, 429 və digər HTTP xətaları ayrıca görünür.
- API Node CPU/RSS göstəriciləri MongoDB, generator və FFmpeg child proseslərini əhatə etmir. RSS 100 ms aralıqla nümunələnir; dəqiq sistem maksimumu deyil.
- Synth fixture/media nəticələri real istifadəçi iş yükünü tam təmsil etmir. Real klip ölçülürsə onun müddəti, resolution, ölçüsü və hash-i müqayisədə eyni saxlanmalıdır.

## Növbəti mərhələlər

1. Bu nəticəni baseline kimi saxlamaq; ilk ölçülən darboğazı test branch-də dəyişib eyni matrisi yenidən işlətmək. İlk namizəd explore count/owner lookup və sort planıdır; total/pagination və görünürlük kontraktı qorunmalıdır.
2. Media obyektinin private-by-default qaydasını və smart compression seçim siyasətini test mühitində hazırlamaq. Copy/remux keyfiyyət və mobil uyğunluqla təsdiqlənməlidir.
3. Direct upload üçün ayrıca API/Flutter kontraktı və R2 emulatoru/ayrı test bucket-ləri: 20/35/50 MB, multipart resume, yanlış sahib, müddəti bitmiş icazə, eyni complete, complete-dən sonra overwrite, quota və orphan cleanup.
4. Ayrı worker-proses crash, 5/10/25 parallel upload, Gemini timeout/503 və admin/AI yarışı. Xarici xidmətlərin real vaxtı yalnız ayrıca sandbox ölçməsində hesabatlandırılmalıdır.
5. Ayrıca test VPS-də production-a yaxın MongoDB/Redis/R2 topologiyası və başqa load generator. Əvvəl 1k/10k, sonra 100k video; HTTP p95, queue p95, bütün proseslərin CPU/RAM və disk göstəriciləri birlikdə ölçülməlidir.
6. Real cihazda Wi-Fi/4G/zəif 4G playback. Yalnız təsdiqlənən qazancdan sonra ayrıca buraxılış və rollback.

Canlı backend və mövcud Flutter müqaviləsi bu ilkin lokal dəst üçün dəyişdirilməyib. Tam PDF checklist-i keçmiş kimi işarələnmir.

## Texniki mənbələr

- [Cloudflare R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/): əməliyyat, obyekt, müddət və bearer icazə semantikası.
- [MongoDB explain nəticələri](https://www.mongodb.com/docs/manual/reference/explain-results/): docs/keys examined və lookup statistikasının şərhi.
- [k6 open və closed modellər](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/): gecikmə və arrival-rate arasındakı fərq.
