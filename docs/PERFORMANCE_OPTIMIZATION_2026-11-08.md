# Lokal performans dəyişiklikləri — 8 noyabr 2026

9 noyabr düzəlişi: [orijinal upload-da 12 Mbps həddinin yaratdığı əlavə encode və ölçmələr](PERFORMANCE_ORIGINAL_UPLOAD_FIX_2026-11-09.md). Aşağıdakı 12 Mbps qaydası və 26.72 MB rendition ölçmələri əvvəlki revision-un qeydidir.

Sonrakı mərhələ: [AI/FFmpeg paralelliyi, 100k API və worker crash nəticələri](PERFORMANCE_CONTINUATION_2026-11-08.md). Aşağıdakı vaxtlar ilk optimizasiya ölçməsinin saxlanmış nəticələridir.

Üç dəyişiklik `codex/performance-baseline` branch-də hazırlanıb və lokal yoxlanıb: təsdiqsiz medianın private saxlanması, Explore sorğusunun sürətləndirilməsi və uyğun H.264 videonun təkrar encode edilməməsi. Canlı VPS, onun bazası və R2 obyektləri dəyişdirilməyib. GitHub-a göndərilməyib.

Müqayisə bazası: `94cc79d5d57365fcd41aeecb576587e49dcc19b3`. Ölçülən dəyişikliklərin `src` SHA-256 dəyəri: `c0856e3dfa90bdccb3759bb794032708c05de1cedcc82f8879a61fb6df5fc533`. Hesabatlar dəyişdirilmiş iş qovluğundan alınıb; HEAD hash-i təkbaşına bu dəyişiklikləri təsvir etmir.

## Ölçülmüş nəticələr

Eyni kompüter: Windows x64, Node 22.15.0, i7-13620H, 16 logical CPU, təxminən 31.6 GiB RAM. API və müvəqqəti MongoDB eyni kompüterdədir, Redis söndürülüb. API matrisi əvvəlki ilə eynidir: 1k/10k sintetik video, 20 provider, hər ssenari üçün 5 warmup + 100 ölçülən sorğu, paralellik 1 və 4.

| Ölçmə | Əvvəl | Sonra |
|---|---:|---:|
| 10k Explore newest, p95, paralellik 1 | 473.4 ms | 32.3 ms |
| 10k Explore newest, p95, paralellik 4 | 545.4 ms | 38.8 ms |
| Explore owner lookup, baxılan sənəd sayı | 5,456 | 15 |
| Eyni 4K klipin video hazırlama mərhələsi | 89.96 s encode | 0.254 s remux |
| 4K klipin ölçülən ardıcıl lokal mərhələləri | 97.71 s | 4.74 s |
| 4K çıxış ölçüsü | 27,038,718 byte | 26,723,965 byte |

API üzrə 1,600 ölçülən sorğunun hamısı uğurludur: 0 xəta, 0 rate-limit cavabı. Explore cavab ölçüsü və 15 nəticə saxlanılıb. Guest Explore üçün rate-limit daxil 2 əmr əvəzinə 4 MongoDB əmri var. Owner join yalnız seçilmiş səhifəyə tətbiq olunur; ayrıca provider-count mərhələsi qalır. Hər iki pipeline 10k dəstində 5,454 video sənədinə baxır. 1,000-dən çox fərqli owner olduqda əvvəlki join/facet yolu işləyir; bu halda eyni sürət qazancı iddia edilmir.

4K giriş: əvvəlki staging emalından saxlanmış `staging-4k.mp4`, 26,723,973 byte, H.264, 2160×3840, 25 FPS, 20.24 s. Bu, ilk telefon upload-unun orijinalı deyil. Hər iki ölçmədə giriş SHA-256 eynidir: `dee023b162cc22482d4d6a53a6ef73cc55e1bd0501282b385bde8999b297fa49`; giriş faylı dəyişməyib. Yeni çıxış 2160×3840, 25 FPS və 20.24 s saxlayır. Kadr çıxarma 6.07 s-dən 3.39 s-ə dəyişib, lakin həmin kod bu mərhələdə dəyişdirilməyib; bu fərq optimizasiya qazancı kimi təqdim edilmir.

Tək media trial-ı ümumi p95 və ya bütün videolar üçün təminat deyil. Cəmi 4.74 s yalnız FFprobe, keyframe, media hazırlama və thumbnail vaxtlarının cəmidir. Upload/download, növbə, R2 copy, Gemini və cihazda ilk kadr buna daxil deyil. Bu nəticələr VPS tutumu və ya PDF-in bütün hədəflərinin keçməsi demək deyil.

Xam hesabatlar layihə kökünə görə:

- Əvvəlki API: `tmp/performance/api-2026-11-07T21-44-01-745Z-aksjAJ/api-report.json`.
- Yeni API: `tmp/performance/api-2026-11-07T22-46-10-373Z-CAoCt1/api-report.json`; eyni qovluqda əsas və `provider-counts` explain faylları var.
- Əvvəlki 4K: `tmp/performance/media-2026-11-07T21-51-25-092Z-xwfhui/media-report.json`.
- Yeni 4K: `tmp/performance/media-2026-11-07T22-47-09-290Z-gbL6VH/media-report.json`.

## Yeni davranış

**Media.** Worker emal edilmiş video və thumbnail-i də private bucket-də `talkmart/private/` altında saxlayır. `review`/`rejected` fayl üçün public URL yaradılmır. Sahib və admin siyahılarında 600 saniyəlik imzalı preview və `mediaUrlExpiresAt` qaytarılır; cavab `Cache-Control: private, no-store` alır. Private key-lər və yeni saxlama lease sahələri cavabdan çıxarılır. Linkin vaxtı bitəndə siyahını yenidən oxumaq lazımdır.

Hazır, təsdiqlənmiş, görünən və aktiv sahibə aid video ayrıca UUID key-ə R2 server-side copy ilə public olur. Qərar versiyası və media lease-i admin/worker yarışını məhdudlaşdırır. Copy və ya DB cavabı uğursuz olduqda mövcud istinadlar yoxlanmadan fayl silinmir; yarımçıq çıxışlar təmizlənir və worker təkrar cəhd edir. Admin əmri qəbul ediləndə `status` hələ `inactive` qala bilər; tətbiq son nəticəni siyahıdan yeniləməlidir.

Rədd/gizlətmə API görünürlüyünü dərhal bağlayır. Köhnə public faylın private nüsxəsi saxlanır, public istinadlar boşaldılır, silinmə tapşırığı bazada qalır və R2 bərpa olunanda tamamlanır. Bu, R2 ilə MongoDB arasında ani atomik keçid deyil. Storage nasazlığında köhnə public obyektin silinməsi gecikə bilər. Yeni public copy-lər 60 saniyəlik cache müddəti alır; CDN qaydaları bunu uzatmamalıdır. Əvvəlki faylların köhnə cache başlıqları, artıq endirilmiş nüsxələr və verilmiş preview linkləri ayrıca məhdudiyyətdir. Preview linki onu əldə edən şəxs üçün müddətli bearer icazəsidir.

**Explore.** Əvvəl provider üzrə say alınır, uyğun owner-lər seçilir, sonra səhifənin videolarına owner/personal məlumatları birləşdirilir. Sort, filter, cursor, `total` və səhifələmə müqaviləsi saxlanılıb. Owner səhifə seçimi zamanı yenidən yoxlanır. Paralel bloklama zamanı səhifədə az element qala və `total` həmin an əvvəlki say ola bilər; bloklanan owner-in videosu nəticəyə qaytarılmır. Böyük owner dəstində əvvəlki yol qalır.

**Keyfiyyət.** İstifadəçinin seçiminə uyğun ölçü azaldılmır. MP4 ailəsindən H.264, 8-bit `yuv420p`, uyğun profil/level, 30 FPS-dək, 12 Mbps-dək, 195 MB-dan kiçik, fırlanmasız və ən çox stereo AAC səsli fayl remux edilir. Səssiz video da uyğundur. Digər girişlər əvvəlki H.264/AAC yoluna keçir. Remux testində encode olunmuş video/səs paketlərinin hash-ləri eyni çıxıb. Metadata/chapters silinir, MP4 faststart saxlanır; container faylının hash-i eyni olmalı deyil. Çıxış müddəti də yoxlanır və limitə görə qısalmış fayl qəbul edilmir.

## Yoxlamalar

`npm.cmd run lint`, `npm.cmd test`, `npm.cmd run test:integration`: **19 unit/media/performance + 30 integration = 49 test keçdi**. Yeni testlərə H.264/AAC paketlərinin saxlanması, alternativ codec-in çevrilməsi, Explore filter/sort/total/cursor və owner yarışı, private preview səlahiyyəti, təsdiq/rədd/gizlətmə, yarımçıq copy, qeyri-müəyyən DB cavabı, R2 nasazlığı, davamlı silinmə növbəsi və orphan təmizləmə daxildir.

R2 testləri lokal storage mock ilədir; real R2 cross-bucket copy və private preview playback bu mərhələdə yoxlanmayıb. Gemini, SMTP və production DB çağırılmayıb. Swagger hər iki faylda 1.2.0-a yenilənib; endpoint yolları və multipart upload müqaviləsi dəyişməyib. Yeni runtime asılılıq: `@aws-sdk/s3-request-presigner` 3.1156.0.

## Test serverində növbəti ardıcıllıq

1. Bu branch-i ayrıca test buraxılışı kimi hazırlamaq, hazırkı test kodu və DB üçün geri dönüş nöqtəsi saxlamaq. Production-a hələ keçməmək.
2. `R2_STAGING_BUCKET` public olmamalıdır. Avtomatik original expiry qaydası yalnız `talkmart/staging/` prefix-inə aid olmalıdır; `talkmart/private/` emal edilmiş faylları saxlayır. R2 açarının hər iki test bucket-də oxuma/yazma/copy/silmə imkanını yoxlamaq. Web üçün private bucket CORS ayrıca yoxlanır.
3. Mövcud legacy media key-lərinin `talkmart/videos/` və `talkmart/thumbnails/` ilə uyğunluğunu, URL-də qalıb key-i boş olan faylları inventarlaşdırmaq. Kənar/naməlum storage URL-lərinə avtomatik R2 quarantine təminatı verilmir. Mövcud review/rejected public obyektlər maintenance skanı ilə mərhələli köçürülür; buraxılış bitən an hamısının artıq private olduğu qəbul edilmir.
4. Ayrı test provider-i ilə uyğun H.264 və uyğun olmayan codec yükləmək. Rədd edilən video yalnız sahib/admin preview-də görünməli, anonim birbaşa private giriş uğursuz olmalıdır. Preview 10 dəqiqədən sonra yenilənməlidir. Təsdiq → public oynatma/Range → rədd/gizlətmə → origin silinməsi → yeni təsdiq/yeni URL yoxlanmalıdır.
5. Admin operations-də `awaitingPublication`, `mediaRevocationBacklog`, `staleMediaLeases` izləmək. Əlavə private saxlanma və copy əməliyyatlarının xərci nəzərə alınmalıdır; private emal nüsxəsi sonrakı gizlətmə və təkrar təsdiq üçün saxlanılır.
6. Flutter APK-də köhnə və yeni videonun səs, istiqamət, seek və oynatmasını, preview yenilənməsini yoxlamaq. Sonra production-a yaxın ölçmə və ayrıca buraxılış qərarı.

Direct R2 upload/init/complete, real paralel HTTP upload və Redis/CDN ölçmələri qalır. 100k dəsti, faktiki worker prosesinin crash sınaqları, 5/10/25 hazır job və AI/FFmpeg paralelliyi sonrakı davam hesabatında tamamlanıb; real xidmət/şəbəkə sınaqlarını əvəz etmir.

## Mənbələr

- [İlkin təhlil və lokal dəst](PERFORMANCE_PLAN_AZ.md), [əvvəlki nəticələr](PERFORMANCE_BASELINE_2026-11-08.md).
- [Cloudflare R2 S3 uyğunluğu](https://developers.cloudflare.com/r2/api/s3/api/): CopyObject, metadata və Cache-Control dəstəyi.
- [Cloudflare presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/): müddətli bearer icazəsi.
