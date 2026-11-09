# Direct upload-un test serverində aktivləşdirilməsi

9 noyabr 2026: real test R2 uyğunluq sınağı istifadəçinin server çıxışı ilə keçib. Yanlış ölçülü imzalı hissə və vaxtı bitmiş URL rədd edilib; multipart/HEAD/private metadata və byte hash-i uyğundur; tamamlanmış source köhnə part URL ilə dəyişdirilə bilmir. Sınağın öz object/MPU-ları silinib, test və production PID-ləri saxlanıb. Hesabat: `tmp/direct-r2-preflight-8b97c5c4-bb1b-44f0-9bd2-11696a120cd1.json`.

Keçid tamamlanıb: test buraxılışı `73de3a9f5447db17e0d4ffb4b0e1e9c5cfd0814b`, əvvəlki baza `ffc1c33b193f9a6b31a8457cfab8482ffb8e75cb`-dir. Ehtiyat nüsxə `/root/talkmart-backups/direct-staging-2026-11-09T17-11-08-827Z-nuNvzB` altında saxlanıb. Production PID-ləri dəyişməyib. Real upload/resume/complete və ilk worker/AI nəticəsi [ayrıca hesabatdadır](DIRECT_UPLOAD_STAGING_RESULT_2026-11-09.md). Aşağıdakı ardıcıllıq hazırlanmış paketə aiddir; artıq keçmiş helper-i yenidən işlətmək üçün göstəriş deyil.

## Paket və guard-lar

Dörd fayl `/root/`-a göndərilir: `talkmart-direct-upload.bundle`, `talkmart-direct-release.json`, `direct-upload-activate.mjs` və sonrakı upload sınağı üçün `talkmart-direct-original.mp4`. Standalone helper manifestin SHA-256 dəyərinə bağlanır; manifest bundle hash-ini, release commit-i, dəyişməmiş dependency lock-u və konkret real R2 preflight hesabatını pin edir. Əmr veriləndə ayrıca helper SHA-256 yoxlanır.

`node /root/direct-upload-activate.mjs --activate` faktiki keçidi başladır. Arqumentsiz və `--help` dəyişiklik etmir. Linux, dəqiq script/repo/env yolları, kernel `flock` ilə tək icra, təmiz tracked kod və gözlənilən base commit tələb olunur. Manifest arbitrary komanda, URL və fayl yolu qəbul etmir. Preflight 24 saatdan köhnə olmamalıdır. Dörd PM2 prosesinin dəqiq ad/script/cwd məlumatları yoxlanır; yalnız `talkmart-api-test` və `talkmart-worker-test` üçün stop/restart icazəsi var.

Testdə aktiv upload reservation, video emalı, silinmə/media cleanup, silinən hesab və ya əvvəlki direct session varsa keçid dayandırılır. Bu guard yeni admission açılana qədər təkrar yoxlanır. Başqa operatorun tracked kod/env dəyişikliyi üzərindən yazılmır. Mövcud JWT, OTP, R2, SMTP, DB və digər env qiymətləri saxlanır; yalnız `DIRECT_UPLOAD_ENABLED` dəyəri əlavə edilir.

## Keçid ardıcıllığı

1. Yalnız test API və worker saxlanılır. Production PID/start vaxtı hər PM2 addımından əvvəl yoxlanır.
2. `/root/talkmart-backups/direct-staging-*` altında kod tar/bundle, tam test env və yalnız `talkmart_staging` MongoDB archive-i yaradılır. Checksum, gzip və `mongorestore --dryRun` yoxlanır. URI müvəqqəti private config-dədir; stdout/argv-yə çıxmır. Backup qovluğu 0700, fayllar 0600-dur.
3. Mövcud video/avatar media istinadları server-side copy ilə private `talkmart/private/rollout-backups/<id>/...` prefix-ində saxlanır, ölçüləri yoxlanır. Əvvəldən olmayan obyektlər ayrıca işarələnir. Backup prefix-i orphan scan-a daxil deyil. Bütün mərhələlər private manifestə yazılır.
4. Bundle yalnız fast-forward tətbiq olunur. Dependency lock eyni qalmalıdır; yeni paket quraşdırılmır. Source check və unit/media/performance/staging testləri serverdə işlədilir.
5. Yeni worker və API əvvəlcə `DIRECT_UPLOAD_ENABLED=false` ilə açılır. Worker üçün yeni uptime və həmin PID-yə aid heartbeat tələb olunur. Verified `.invalid` test provider üçün token yalnız yaddaşda yaradılır; yanlış JSON ilə yeni endpointin `DIRECT_UPLOAD_DISABLED` cavabı yoxlanır. Heç bir yeni upload/video yaradılmır.
6. Sessiya və növbə hələ boşdursa yalnız test env-də flag `true` edilir və test API yenidən açılır. Worker artıq yeni source-validasiya/cleanup kodundadır; flag yalnız yeni init-i idarə etdiyi üçün worker-in təkrar restartı tələb olunmur. Daxili və HTTPS test yolunda yanlış JSON-a `INVALID_DIRECT_UPLOAD` cavabı yeni yolun aktivliyini sübut edir; burada da upload sessiyası yaradılmır.
7. Health, production PID-ləri və repo commit yoxlanır; PM2 dump private saxlanır. Əvvəlki backup silinmir. Sonra real direct upload və Flutter resume sınağı aparılmalıdır.

## Xəta və geri dönüş sərhədi

Yeni admission hələ açıla bilməyibsə, DB-də heç bir direct session yoxdursa, kod/env başqa operator tərəfindən dəyişməyibsə köhnə test kodu və env avtomatik qaytarılıb test prosesləri açılır. Bu yol application DB-ni snapshot-dan bərpa etmir və yeni, normal legacy məlumatları silmir.

Yeni API direct upload qəbul etmiş ola bilərsə köhnə worker-ə avtomatik dönüş edilmir. Test API saxlanır, yeni init bağlanır və təmiz, yoxlanmış yeni kodla API yenidən açılır; mövcud sessiyalar üçün resume/complete/cancel və yeni worker cleanup-ı qalır. Kod/env kənardan dəyişibsə test API bağlı saxlanıb nəticə nəzərdən keçirilməlidir. Production proseslərinə toxunulmur.

İstənilən uğursuz nəticədə helper-i kor-koranə təkrar işlətməyin. Backup manifestində son mərhələ və admission sərhədi var. Yeni sessiyalar tamamlanıb/ləğv olunmalı və növbə boşalmalıdır. Tam DB/media restore backup-dan sonrakı test dəyişikliklərini geri alacağı üçün ayrıca qiymətləndirilən əməliyyatdır; bu aktivləşdirmə helper-i onu avtomatik etmir.

Lokal doğrulama: manifest/path, env dəyərlərinin qorunması, operator edit-i və admission sonrası rollback guard-ı üçün dörd, upload sınağının R2 scope-u üçün iki yeni unit testi. Source check, ümumilikdə 41 unit/media/performance/staging və 50 integration testi keçib: cəmi 91 test. Mövcud functional testlər real R2 sınağının yerinə təqdim edilmir. Faktiki Linux keçidi və post-deploy direct upload nəticələri [nəticə sənədindədir](DIRECT_UPLOAD_STAGING_RESULT_2026-11-09.md).

## Keçiddən sonrakı orijinal upload sınağı

Paketlə `/root/talkmart-direct-original.mp4` də göndərilir: əvvəl ölçülmüş 32,350,603 byte-lıq orijinaldır, SHA-256 `ae239bff40cb19d8168c8630d42baaca07bb8e7dfe92de633dcf7339a7689bfb`. Mənbə və onun surəti hash ilə yoxlanır. Digər server faylının və ya symlink-in bu helper-lə yüklənməsi qəbul edilmir.

Keçid uğurla bitəndən sonra ayrıca `node scripts/staging/direct-smoke.js --upload` işlədilir. Arqumentsiz/`--help` upload etmir. Helper yalnız staging guard-dan keçib məlum `.invalid` provider-in saxlanmış test girişini istifadə edir; token/parol çap etmir. İlk hissə R2-yə stream olunur, `GET uploads/{id}` ilə onun saxlandığı yoxlanır, qalan hissələr yeni URL-lərlə yüklənir. Qəbul və repeat-complete eyni video/job ID-sini verməlidir.

Hər hissənin ölçüsü, offset-i, R2 host/bucket/key/UploadId/partNumber və signed-length qaydası yoxlanır; R2 sorğusuna backend token-i verilmir. İki əlavə unit testi gözlənilməyən host/key və byte-range qəbulunu rədd edir. Source init/resume/part/complete vaxtları ayrıca yazılır; bunlar telefondan upload və worker/AI bitmə vaxtı deyil. Sınaq worker-in nəticəsini avtomatik təsdiqləmir: mövcud `check-upload.js --id=<id> --wait` ilə davam edilir. Qəbul olunmuş video saxlanır. Uğursuz unfinished sessiya mümkün olduqda cancel olunur; naməlum commit kor-koranə silinmir.

`flock` davranışının mənbəyi: [Linux flock(2)](https://man7.org/linux/man-pages/man2/flock.2.html). Lock faylı mövcud olsa da işləyən kernel lock-u olmaya bilər; köhnə PID yazısını əl ilə silmək lazım deyil.
