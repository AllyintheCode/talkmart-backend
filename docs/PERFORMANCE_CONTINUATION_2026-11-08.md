# Optimizasiyanın davamı — 8 noyabr 2026

9 noyabr real server nəticəsi: admin/user/guest və public/private media silinməsi sınaqları keçdi. Yeni upload AI tərəfindən təsdiqləndi, lakin media commit 127.254 s çəkdi. Bu səbəbdən [orijinal upload üçün bitrate seçim düzəlişi](PERFORMANCE_ORIGINAL_UPLOAD_FIX_2026-11-09.md) hazırlanıb; serverdə təkrar sürət ölçməsi qalır.

Bu mərhələdə AI/FFmpeg paralel hazırlama tətbiq edilib, 100k video ilə API ölçülüb və faktiki worker prosesinin qəfil dayanması yoxlanıb. Kod lokal `codex/performance-baseline` branch-dədir. Real VPS, production baza və bucket-lər dəyişdirilməyib.

## Hazır olan hissələr

| İş | Nəticə |
|---|---|
| AI və media hazırlamanın paralel başlaması | Tətbiq edildi; hər iki mərhələ bitmədən giriş faylı silinmir. |
| Mərhələlərdən birinin xətası | Digəri gözlənir; yaranmış çıxış təmizlənir, worker-in əvvəlki retry qaydası saxlanılır. |
| 1 saniyəlik / 23.976 FPS videoda kadrlar | Kadr seçimi düzəldildi; vaxt yuvarlaqlaşdırmasının yığılıb dördüncü kadrı itirməsi aradan qaldırıldı. |
| 100k sintetik video | 800 sorğu, 0 xəta, 0 rate-limit cavabı. |
| Download ortasında worker-in SIGKILL ilə dayandırılması | Eyni job ID-si və 2-ci cəhdlə tamamlandı; aktiv lease yeni worker tərəfindən alınmadı. |
| Private commit-dən sonra public copy ortasında SIGKILL | Aktiv media lease qorundu; bərpada yarımçıq copy təmizləndi, yeni key ilə bir dəfə yayımlandı. |
| Modeldən HTTP 503 | Video `ready/review/inactive` oldu; fayllar private qaldı, public obyekt yaranmadı. |
| 5 / 10 / 25 hazır job-un növbəyə verilməsi | Hamısı tamamlandı, itki və təkrar publication olmadı. |

Əvvəlki [private media, Explore və remux dəyişiklikləri](PERFORMANCE_OPTIMIZATION_2026-11-08.md) də bu buraxılışa daxildir. Upload endpointi, multipart sahələri və mövcud status adları dəyişməyib. `processingStatus=ready` təkbaşına ictimai yayımlanma deyil: `moderationStatus=approved` və `status=active` də tələb olunur.

## 100k API nəticələri

Eyni lokal ölçmə qaydası: Node 22.15.0 / Windows, i7-13620H, təxminən 31.6 GiB RAM; real Express və ayrıca müvəqqəti MongoDB, Redis bağlıdır. 20 sintetik provider, hər ssenari üçün 5 warmup + 100 sorğu; paralellik 1 və 4.

| Ssenari | p95, paralellik 1 | p95, paralellik 4 |
|---|---:|---:|
| Guest feed | 137.4 ms | 153.5 ms |
| Giriş etmiş user feed | 151.7 ms | 164.3 ms |
| Explore newest | 156.8 ms | 165.7 ms |
| Gzip guest feed | 147.5 ms | 157.2 ms |

Əsas və provider-count pipeline-ləri hərəsi 54,545 video sənədinə baxır; bütün skanlar aradan qalxmayıb. Bu, 20 owner ilə olan dəstdir. 1,000-dən çox fərqli owner üçün əvvəlki fallback qalır; onun davranışı integration testində yoxlanıb, böyük owner sayı ilə eyni gecikmə təmin edilmir.

Hesabat: `tmp/performance/api-2026-11-08T14-03-14-773Z-daCfsS/api-report.json`. Ölçmə zamanı `src` hash-i `c0856e3dfa90bdccb3759bb794032708c05de1cedcc82f8879a61fb6df5fc533` idi. Bundan sonra worker hazırlama və kadr seçimi dəyişib; HTTP/controller kodu dəyişməyib. Bu nəticə sonrakı worker ölçməsi ilə eyni source hash kimi təqdim edilmir.

## Worker sınağının sərhədləri

`node scripts/perf/worker.js` ayrıca local replica set, ayrıca müvəqqəti fayl qovluğu və həqiqi `src/worker.js` child prosesini işlədir. FFprobe/FFmpeg, lease, heartbeat, job commit, maintenance və cleanup həqiqidir. R2 yerinə prosesdən kənarda saxlanan IPC storage adapteri var; worker ölsə də fayllar adapterdə qalır. Google SDK/response parser işləyir, lakin model cavabı 250 ms-lik lokal stub və ya HTTP 503-dür. Heç bir real R2/Gemini/SMTP çağırışı edilmir.

Lease-lərin müddəti yalnız bu dəstin yaratdığı bazada əl ilə bitirilir; real beş dəqiqə gözlənmir. 5/10/25 ssenariləri HTTP upload deyil, artıq qəbul olunmuş növbə tapşırıqlarıdır. 1 saniyəlik 160×120 fixture, worker concurrency=1 istifadə olunur. Bunlardan VPS throughput-u, real upload vaxtı və Gemini p95 nəticəsi çıxarmaq olmaz. Ssenari müddətlərinə prosesin açılması/bağlanması da daxildir; bütün worker mərhələlərinin cəmi deyil.

Hesabat: `tmp/performance/worker-2026-11-08T14-10-38-981Z-ZVU4jM/worker-report.json`. Source hash: `17d479324ce17258a893d2187862b525ca9eda87fcc892962870d77115cd0d50`. Altı ssenarinin hamısı keçib. 25 job sınağında `ai_ms` p50 307 ms, `ffmpeg_ms` p50 102 ms, paralel `preparation_ms` p50 307 ms-dir; bu rəqəmlər yalnız həmin simulyasiyaya aiddir. Production-da CPU rəqabəti və model şəbəkəsi ayrıca ölçülməlidir.

İlk worker sınağı kadr seçiminin natamam qalması səbəbindən keçmədi. Yuxarıdakı son uğurlu hesabat düzəlişdən sonradır; uğursuz ilkin hesabat gizlədilməyib və `tmp/performance/worker-2026-11-08T14-08-04-180Z-gqtFQq/` altında qalır.

## Yoxlamalar və təkrar işə salma

Unit/media/performance/staging dəsti 24, integration dəsti 30 testdən ibarətdir: cəmi **54 test**. Əlavə olaraq altı proses/queue ssenarisi və 800 sorğulu 100k ölçmə var. AI/encode overlap, hər iki xəta ardıcıllığı, qısa klipin dörd rəngli vaxt pəncərələri və staging-in production sazlamalarını rədd etməsi testlə yoxlanır.

Windows-da layihə qovluğundan:

```text
npm.cmd run lint
npm.cmd test
npm.cmd run test:integration
node scripts/perf/api.js --videos=100000 --requests=100 --concurrency=1,4
node scripts/perf/worker.js
```

## Serverdə növbəti addım

Ayrıca `/var/www/backend-perf-test-20261108` qovluğu üçün `scripts/staging/preflight.js`, `api.js`, `worker.js` hazırlanıb. İlkin yoxlama mövcud `/var/www/backend-test/.env` sazlamasını istifadə edir, production açarları ilə ayrılığı yoxlayır, bazanı yalnız oxuyur. Real R2-də yalnız öz UUID-li kiçik test fayllarını yaradır/silir: private presigned GET və Range, cache başlıqları, iki istiqamətli copy və public origin-dən silinmə. API/PM2 proseslərini dəyişmir.

Private bucket-in lifecycle qaydası emal edilmiş `talkmart/private/` fayllarına aid olarsa ilkin yoxlama dayanır. Object Read & Write açarı bucket ayarlarını oxumağa icazə vermədikdə fayl sınaqları yenə aparılır, amma panel təsdiqi olmadan nəticə `PANEL_TESDIQI_GOZLENILIR`, exit code 2 olur. Runtime açarına admin icazəsi vermək tələb edilmir. Paneldə public r2.dev/custom-domain çıxışının bağlı olması və private faylları silən expiration qaydasının olmaması yoxlandıqdan sonra `node scripts/staging/preflight.js --dashboard-settings-confirmed` ilə təsdiqlənir. Bu seçim API-dən məlum olan təhlükəli qaydanı və ya digər R2 xətalarını keçmir. İmzalı linkin işləməsi bucket-in başqa public ünvanı olmadığını sübut etmir.

İlkin yoxlama keçdikdən sonra test bazasının backup-ı, test API/worker keçidi və real Flutter preview/playback sınağı aparılmalıdır. Production-a keçid bu mərhələyə daxil deyil. Yeni wrapper-lər yalnız loopback 5001 və test bucket/DB sazlamaları ilə işləyir. Köhnə test qovluğu və production prosesləri saxlanır.

Direct R2 upload/init/complete və mobil resume, Redis/CDN ayrıca ölçmələri, real 20/35/50 MB paralel HTTP upload, canlı AI gecikməsi və zəif 4G playback hələ qalır.

Texniki mənbə: [FFmpeg select filter-in rəsmi təsviri](https://github.com/FFmpeg/FFmpeg/blob/master/doc/filters.texi) — `selected_n` seçilmiş kadrın sıra sayını verir; seçim əvvəlki kadrdan yuvarlaqlaşdırılmış interval toplamaq əvəzinə mütləq hədəflərə bağlanıb.
