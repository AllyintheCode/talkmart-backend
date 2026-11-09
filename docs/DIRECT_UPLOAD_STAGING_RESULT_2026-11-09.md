# Birbaşa R2 upload: real test serverinin nəticəsi

9 noyabr 2026. Mənbə istifadəçinin göndərdiyi server çıxışlarıdır; remote JSON faylları lokal olaraq yenidən oxunmayıb. Yeni axın yalnız test mühitində aktivdir. Production dəyişdirilməyib.

## Keçid və sınaq

- Test qovluğu: `/var/www/backend-perf-test-20261108`.
- Serverdəki buraxılış: `73de3a9f5447db17e0d4ffb4b0e1e9c5cfd0814b`.
- Ehtiyat nüsxə: `/root/talkmart-backups/direct-staging-2026-11-09T17-11-08-827Z-nuNvzB`.
- Kod, DB, sazlama və private media backup-ı, server source/unit yoxlamaları, yeni worker heartbeat və test API yoxlamaları keçib. Production API/worker PID-ləri saxlanıb.
- R2 ilkin yoxlama: `tmp/direct-r2-preflight-8b97c5c4-bb1b-44f0-9bd2-11696a120cd1.json`.
- Real API upload sınağı: `tmp/direct-upload-smoke-0e8020f6-c499-4db8-813e-92d77fd635f4.json`.
- Emal hesabatı: `tmp/upload-check-6af20006f92d21d5b9d0d2fc-ffc6c568-f48f-471c-8b57-9ed6626cd833.json`.

Məlum 32,350,603 byte-lıq orijinal H.264 video istifadə edilib. İlk 8 MiB hissədən sonra status/resume ilk hissənin saxlandığını və yalnız qalan hissələr üçün URL verildiyini yoxlayıb. Dörd hissə tamamlanıb. Complete və repeat-complete bir video/job yaradıb: `6af20006f92d21d5b9d0d2fc`, başlıq **PERF direct təmizlik**. Bu, real R2 və staging API ilə funksional sınaqdır; telefon şəbəkəsi sınağı deyil.

| Qəbul mərhələsi | Bir müşahidə |
| --- | ---: |
| Init | 982 ms |
| Dörd R2 hissəsinin müddətlərinin cəmi | 3,216 ms |
| Complete | 1,364 ms |

Bu üç rəqəmin cəmi tam client-to-ready müddəti deyil: resume, əlavə yoxlamalar, worker/AI və public publication daxil deyil. Init `<300 ms` hədəfi bu müşahidədə ödənməyib. Telefondan upload və API RSS azalması hələ ölçülməyib.

## Worker və nəşr

Video `ready / approved / active`, `moderationSource=ai`, confidence 95 və attempt 1-dir. Müddət faktiki probe-dan 20 saniyə yazılıb. Private və public MP4 obyektləri mövcuddur, hər biri 32,350,392 byte-dır; `mediaRevocationPending=false`.

DB `createdAt=2026-11-09T17:17:00.230Z`, `completedAt=2026-11-09T17:17:23.094Z`: **media commit-ə qədər 22.864 saniyə**. Bu vaxt ilkin client upload-u və sonrakı public publication-ı daxil etmir.

Test worker PID-si 708510-dur, başlanğıc vaxtı `2026-11-09T17:12:15.589Z`; heartbeat `2026-11-09T17:17:54.867Z`, running 0 və metricsCoverMediaCommit true-dur. Aşağıdakı metriklərin hərəsində bir sample var. Onlar worker aggregate-dir; per-video trace və ya statistik p95 təminatı deyil.

| Worker mərhələsi | Bir sample |
| --- | ---: |
| Növbədə gözləmə | 480 ms |
| R2-dən endirmə | 3,023 ms |
| FFmpeg/remux | 1,325 ms |
| AI kadrları | 8,092 ms |
| AI model çağırışı | 4,466 ms |
| Ümumi AI/preparation | 12,559 ms |
| R2-yə media yükləmə | 5,840 ms |
| Video job | 25,662 ms |

AI kadrları və model birlikdə `<5 s` hədəfini bu müşahidədə ödəmir. Əvvəlki legacy upload ölçməsi ilə dəyişən R2/model vaxtları arasında bir sample əsasında sürət üstünlüyü və ya reqressiya iddia edilmir. Direct yol fayl body-sini API-dən kənarlaşdırır; worker isə əvvəlki kimi private original-ı endirib yoxlayır və emal edir.

## Qalan yoxlamalar

İstifadəçi əvvəlcə test APK-də “PERF direct təmizlik” videosunun normal oynadığını və irəli/geri sarıldığını təsdiqləyib. Sonra user lentində oynatmanın aralıq nasaz olduğunu, direct videonun işlədiyini, “PERF səsli təmizlik” videosunun isə bəzən işləmədiyini bildirib. Hər iki nümunənin eyni telefonda brauzerdə işləməsi təsdiqlənib. Oynatma sabitliyi üzrə [açıq diaqnostika](FLUTTER_PLAYBACK_DIAGNOSTICS_AZ.md) var; ilk uğurlu sınaq yekun mobil qəbul deyil. Cihaz/şəbəkə trace-i alınmayıb. Mövcud APK-də videonun oynadılması Flutter-in yeni direct upload/resume yolunu artıq istifadə etdiyini sübut etmir. Flutter dəyişiklikləri [müqaviləyə](FLUTTER_DIRECT_UPLOAD_AZ.md) uyğun ayrıca tətbiq və sınaq tələb edir.

Qalan işlər: telefon şəbəkəsində direct upload/progress, tətbiqi bağlayıb açaraq resume, expiry/cancel/retry; eyni şərtlərlə 20/35/50 MB və paralel provider ölçmələri; API RSS və worker yükü; init/AI gecikmə hədəfləri. Production-a bu mərhələdə keçilməyib.
