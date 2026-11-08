# Lokal performans nəticələri - 8 noyabr 2026

Müqayisə olunan tətbiq: canlıya çıxmış `94cc79d5d57365fcd41aeecb576587e49dcc19b3` kodu. Bu mərhələdə `src/` dəyişdirilməyib. Ayrı branch: `codex/performance-baseline`.

Mühit: Windows x64, Node 22.15.0, Intel Core i7-13620H, 16 logical CPU, təxminən 34 GB sistem RAM. Generator, API və MongoDB eyni kompüterdədir. API ayrıca prosesdə və loopback portunda, MongoDB ayrıca müvəqqəti single-member replica set-də işləyib. Redis söndürülüb, shared rate limit MongoDB fallback yolu ilə həqiqətən işləyib. Xarici R2/Gemini/SMTP çağırışı və canlı VPS yük testi aparılmayıb.

## API nəticələri

Hər ssenaridə 5 warmup və 100 ölçülən sorğu; paralellik ayrıca 1 və 4. Cəmi 1 600 ölçülən HTTP sorğusu, 0 gözlənilməyən HTTP/kontrakt/məxfilik xətası, 0 rate-limit cavabı. Aşağıdakı cədvəl 4 paralel sorğu variantını göstərir. Video sayı məlumat dəstinin ölçüsüdür, paralel istifadəçi sayı deyil.

| Videolar | Ssenari | p95 | p99 | PDF-in 500 ms başlanğıc hədəfi |
|---:|---|---:|---:|---|
| 1 000 | Guest feed | 18.8 ms | 22.3 ms | Keçir |
| 1 000 | Authed feed | 32.7 ms | 34.4 ms | Keçir |
| 1 000 | Explore newest | 80.8 ms | 82.5 ms | Keçir |
| 10 000 | Guest feed | 39.1 ms | 42.8 ms | Keçir |
| 10 000 | Authed feed | 55.2 ms | 58.9 ms | Keçir |
| 10 000 | Explore newest | 545.4 ms | 553.4 ms | Aşılır |

1 paralel sorğuda 10k explore p95-i 473.4 ms olub. Bu, məlumat və paralellik artanda explore-un ilk optimizasiya namizədi olduğunu göstərir. Lokal nəticə production SLO zəmanəti deyil.

### Darboğazın sübutu

Real HTTP sorğusunun MongoDB driver-də tutulan pipeline-ı eyni test bazasında `executionStats` ilə yoxlanılıb. 10k variantında video cursor təxminən 5 454 sənədə baxıb. Explore daxilində owner `$lookup` təxminən 5 456 sənəd yoxlaması edib, halbuki cavab 15 video qaytarıb. Bu say eyni 20 sintetik provider sənədinin təkrar yoxlanmalarını da ehtiva edir; minlərlə unikal provider demək deyil.

İndeks var: `status_1_createdAt_-1` və owner `_id_` istifadə edilib. Təkcə indeksin mövcudluğu böyük intermediate iş həcmini aradan qaldırmır. Explore owner filtrini və tam `total` sayını hesablayır, sonra `$facet` daxilində data sıralanır və limitlənir. Təklif edilən dəyişiklik count/owner/sort planını azaltmalı, eyni zamanda total, cursor, sıralama və dərhal görünürlük qaydalarını saxlamalıdır.

Guest sorğusunda orta 2 DB əmri, authed feed-də 5 DB əmri müşahidə olunub. Bu saya rate-limit yazılması da daxildir. Məxfilik və session yoxlamasını zəiflətmək hesabına bu rəqəmi azaltmaq düzgün optimizasiya sayılmır.

### Payload

10k / concurrency 4 variantında guest feed orta 14 437 wire byte, ayrıca gzip feed isə 964 wire byte verib. Random feed nümunələri eyni deyil, buna görə bu, konkret bir cavabın dəqiq sıxılma nisbəti kimi təqdim olunmur. Gzip-in artıq tətbiq olunduğu və faydalı olduğu görünür; bunu yenidən yazmaq ilk prioritet deyil.

API Node RSS nümunələri təxminən 113-152 MB aralığında olub. Bu göstəriciyə MongoDB və generator daxil deyil, bütün server RAM istifadəsi kimi şərh olunmamalıdır.

## Media nəticələri

Hər fayl üçün bir trial. FFprobe, dörd kadr, mövcud `compressVideo` və thumbnail funksiyaları ayrı ölçülüb. Giriş hash-ləri dəyişməyib. Model, queue və şəbəkə vaxtı daxil deyil.

| Giriş | Müddət / ölçü | Kadrlar | Transcode | Thumbnail | Çıxış ölçüsü |
|---|---|---:|---:|---:|---:|
| Sintetik 1280x720 | 6 s / 1.99 MB | 0.26 s | 1.58 s | 0.20 s | 1.90 MB |
| Sintetik 1080x1920 | 3 s / 2.27 MB | 0.28 s | 1.78 s | 0.35 s | 2.14 MB |
| Saxlanmış 2160x3840 H.264 nümunə | təxminən 20 s / 26.72 MB | 6.07 s | 89.96 s | 1.58 s | 27.04 MB |

4K fayl əvvəlki staging testindən qalan, artıq emal olunmuş rendition-dır; original mobil upload deyil. Onun təkrar encode edilməsi 314 745 byte artım verib. Bu nümunə uyğun faylı şərtsiz encode etməyin əlavə CPU/vaxt sərf etdiyini göstərir; bütün orijinal 4K videolarda ölçünün artacağı nəticəsi çıxarılmır.

4K üçün ölçülən ardıcıl mərhələlərin cəmi təxminən 97.71 saniyədir. Burada hətta Gemini, R2 və queue yoxdur. Deməli bu profil üçün yalnız AI paralelliyi ilə 20 saniyə hədəfinə çatmaq gözlənilməməlidir; transcode seçimi əsas namizəddir. Mobil çıxış profili, copy/remux meyarı və keyfiyyət müqayisəsi ayrıca qərar və test tələb edir. Tək trial p95 deyil.

## Tövsiyə edilən sıra

1. Yeni planın obyekt məxfiliyi tələbi: review/rejected emal nəticəsinin public media bucket-də saxlanması ayrıca düzəldilməlidir. Lentdən gizlənmə obyektin private olmasını sübut etmir.
2. Explore-un count/owner lookup/sort işini azaltmaq və eyni dataset/kontraktla müqayisə etmək.
3. Smart media profili: uyğun faylda copy/remux, digər faylda ölçülmüş transcode; eyni fayl, hash, SSIM/VMAF və real playback müqayisəsi.
4. Direct R2 upload + Flutter init/complete/resume müqaviləsi; bütün yollar eyni durable finalizer/worker məntiqini istifadə etməlidir.
5. Sonra ayrıca VPS/load generator üzərində 100k video, Redis, 20/35/50 MB upload, 5/10/25 paralel iş, real process crash və real telefon şəbəkə sınaqları.

Mövcud MongoDB durable queue-nu sırf PDF-də BullMQ adı çəkildiyi üçün dəyişmək bu nəticələrdən çıxmır. Əvvəl ölçülən bahalı hissələr və tələb fərqləri həll edilməlidir.

## Dəstin yoxlanması

Source checks keçib. 17 unit/media/qoruma testi və 23 integration testi keçib; cəmi 40. Yeni qoruma testləri canlı/xarici DB və HTTP hədəfinin rədd edilməsini, caller açarlarının child prosesə keçməməsini, percentile hesabını və child prosesin normal/signal ilə bağlanmasını yoxlayır. Son kiçik smoke run-da 100 fixture ilə test backend-in açılıb-bağlanması da təkrar yoxlanılıb; onun üç sorğulu rəqəmləri yuxarıdakı 100 nümunəli baseline-a daxil edilməyib.

## Xam nəticələr və təkrar icra

- API baseline: `tmp/performance/api-2026-11-07T21-44-01-745Z-aksjAJ/api-report.json` və yanındakı `api-report.md` / `explain-*.json`.
- Sintetik media: `tmp/performance/media-2026-11-07T21-50-40-996Z-YzZ2zW/media-report.json`.
- 4K media: `tmp/performance/media-2026-11-07T21-51-25-092Z-xwfhui/media-report.json`.
- İcra və sərhədlər: `docs/PERFORMANCE_PLAN_AZ.md`.

Xam nəticələr `tmp/` altında saxlanılır və Git-ə daxil edilmir. Başlanğıc statistikası bir dəfəki lokal ölçmədir; eyni tətbiqin təkrar icralarında p95 dəyişə bilər. Şəbəkə/model/cache/topologiya nəticələri bu rəqəmlərdən çıxarılmır.
