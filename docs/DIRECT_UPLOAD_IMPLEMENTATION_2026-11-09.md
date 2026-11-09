# Birbaşa R2 upload — lokal backend, 9 noyabr 2026

Yeni API/worker yalnız staging-də `73de3a9f5447db17e0d4ffb4b0e1e9c5cfd0814b` buraxılışı ilə aktivləşdirilib; production əvvəlki audit buraxılışındadır. Yeni yol `DIRECT_UPLOAD_ENABLED=false` ilə standart olaraq bağlıdır, yalnız staging env-də açılıb. Mövcud multipart APK yolu, video status adları və public görünürlük qaydaları saxlanılıb. Real R2 transfer/resume/complete və ilk worker/AI işi keçib; [faktiki nəticə və qalan yoxlamalar](DIRECT_UPLOAD_STAGING_RESULT_2026-11-09.md) ayrıca qeyd olunub.

## Yeni axın və məlumatlar

`POST /videos/upload-init` verified provider, access JWT və məcburi `Idempotency-Key` ilə JSON metadata alır. Bir `UploadSession` yaradılır, gündəlik byte ehtiyatı ayrılır və private staging bucket-də serverin seçdiyi UUID key üçün S3 multipart açılır. Session 30 dəqiqədir; hər UploadPart URL-i ən çox 10 dəqiqə və sessiya müddəti qədər qüvvədədir. 8 MiB hissələr, maksimum 250 MiB / 32 hissə dəstəklənir. Fayl body-si API-yə gəlmir. Eyni provider-in legacy və direct upload-u eyni reservation, aktiv-job və byte kvotalarını bölüşür.

Hər hissənin `Content-Length` başlığı SigV4 imzasına bağlıdır. Başqa part nömrəsi, object və ya UploadId üçün URL redaktəsi imzanı pozmalıdır. Direct-only S3 client `requestChecksumCalculation=WHEN_REQUIRED`, `maxAttempts=1` istifadə edir: backend-in malik olmadığı body üçün boş checksum imzalanmır və SDK-nın Create multipart-ı kor-koranə təkrar açmasına yol verilmir. Legacy AWS Upload client-in konfiqurasiyası dəyişməyib.

`GET /videos/uploads/{sessionId}` yalnız həmin sahibə uploaded hissələri və çatışmayan hissələr üçün təzə URL-lər verir. Multipart artıq yığılıb, queue transaction-ı tamamlanmayıbsa `storageComplete=true` qaytarılır. Stale completing lease bərpa olunur. Client həmin halda hissələri yenidən göndərmədən complete retry edir. Yerli faylın eyni ölçüdə dəyişməsini server init metadata-sından müəyyən edə bilməz; Flutter faylın identik qalmasını təmin etməli və dəyişibsə yeni sessiya açmalıdır.

`POST /videos/upload-complete` yalnız sessionId alır. Server R2 ListParts-dan həqiqi hissə sayı, ölçü və ETag-ları götürür, multipart-ı bağlayır, HEAD metadata sahibini, ContentLength və ContentType-ı yoxlayır. API client-ə bütöv object PUT icazəsi vermir. Köhnə part URL-i bağlanmış UploadId-yə aiddir və artıq orijinalı dəyişə bilmir. Bu xüsusiyyət real R2 preflight-də ayrıca yoxlanıb.

Video ID-si UploadSession ID-si ilə əvvəlcədən sabitlənib. Account/sessionVersion, reservation və lease yenidən yoxlanaraq bir MongoDB transaction-ında bir `queued/pending/inactive` Video və `completed` UploadSession commit olunur. Eyni complete retry eyni video ID-ni qaytarır. Storage və DB cavabı itəndə HEAD və terminal session vəziyyəti ilə reconciliation var; kor-koranə ikinci video yaradılmır və commit olunmuş source silinmir.

Complete yalnız transferin qəbuludur. Worker ilk dəfə faktiki konteyner/codec/resolution/duration və byte sayını yoxlayır, müddəti authoritative probe-dan yazır, sonra AI/media hazırlayır. Zədəli və saxta girişlər qalıcı `failed` olur; storage/network xətalarının əvvəlki məhdud retry qaydası saxlanır. AI/publişə çıxış yenə `ready + approved + active` və aktiv/təsdiqli owner tələb edir.

## Cleanup və kvota

`DELETE /videos/uploads/{sessionId}` unfinished sessiyanı ləğv edir. Server qəbul olunmuş byte sayını silmədən əvvəl saxlayır, məlum və cavabı itmiş Create nəticələrinin exact-key multipart-larını abort edir və yalnız öz source obyektini silir. Sonra bir transaction-da yüklənməmiş ehtiyat byte-lar qaytarılır, gündəlik istifadə ledger-i bir dəfə hesablaşır və yalnız həmin reservation boşaldılır. Storage outage zamanı cleanup vəziyyəti durable qalır; retry byte sayını sıfırlayıb səhv refund yaratmır. Artıq yüklənmiş byte-lar video/sessiya silinsə də həmin günün istifadəsində qalır.

Worker maintenance batch başına ən çox 5 expired/stale/closing sessiyanı təmizləyir. Orphan scan tamamlanmamış sessiyanın source istinadını saxlayır. Account deletion pending multipart/source-ları təmizləmədən istifadəçini silmir; tamamlanmış video üçün mövcud media cleanup işləyir. Video silindikdə completed transferin mətn metadata-sı təmizlənir, idempotency tombstone-u maksimum 30 gün qalır. Tam hesab silinməsi session qeydlərini də silir. Terminal retention üçün ayrıca `purgeAt` TTL var; active sessiya təkcə TTL ilə silinmir.

URL bearer icazəsidir: access JWT-nin ləğvi əvvəl verilmiş R2 URL-ni öz-özünə ləğv etmir. API yeni control əməliyyatlarını rədd edir; R2 hissə icazəsi expiry/abort-a qədər mövcud ola bilər. O, public nəşr və ya başqa owner-in videosunu yaratmaq imkanı vermir. Şəbəkə trace-i və real bucket sınağı olmadan ani R2 capability revocation iddia edilmir.

## Lokal yoxlamalar

35 əvvəlki unit/media/performance/staging və 30 əvvəlki integration testi keçib. Əlavə direct dəsti real Express, ayrıca MongoDB replica set, real AWS presigner, loopback PUT serverində SDK SigV4 müqayisəsi və məhdud storage modeli istifadə edir. R2/Gemini real şəbəkəsinə çağırış edilmir. Direct testlərdə bir həqiqi FFmpeg/worker işi private review ilə tamamlanır; ayrıca saxta fayl birinci cəhddə failed olur.

Ssenarilər: opt-in/verified-provider/token tipi/sahiblik, metadata və ölçü limitləri, concurrent init/idempotency/quota, signed length/part/method, partial resume, concurrent complete, Complete/DB commit cavabının itməsi, geri alınmış DB transaction-ının eyni source ilə retry-si, cancel/outage/refund, unknown Create nəticələrinin cleanup-ı, expiry və stale lease, block/revocation yarışları, account silinməsi, completed object-in ölçü/sahiblik uyğunsuzluğu, legacy yol ilə reservation/replay uyğunluğu, silinmiş videonun resubmit edilməməsi və UTF-8 JSON həddi. Yeni init üçün JSON limiti 32 KiB-dir; digər endpointlərin 10 KiB limiti saxlanıb.

Son direct dəsti **20 ssenaridən** ibarətdir. Yuxarıdakı 35 unit və 30 əvvəlki integration ilə birlikdə **85 test keçib**. Sonrakı aktivləşdirmə/upload helper-lərinə altı guard testi əlavə edilib; yekun source check, **41 unit və 50 integration — 91 test** keçib. Init retry ilə tamamlanma yarışında cavab forması saxlanır; yanlış/sonsuz/mənfi kvota konfiqurasiyası limitləri səssizcə ləğv etmir. İki OpenAPI mənbəyinin eyniliyi yoxlanıb. Lokal guard yoxlaması standalone R2 script-in Windows workspace-dən servis açmadan dayanmasını təsdiqləyib. Bu lokal testlərdən əlavə real Cloudflare preflight nəticəsi aşağıda ayrıca göstərilir.

OpenAPI 1.3.0 hər iki mənbədə yenilənib. [Flutter müqaviləsi](FLUTTER_DIRECT_UPLOAD_AZ.md) sorğu nümunələrini, hissə offset-lərini, progress/resume/cancel/retry və səhv kodlarını verir. Test API/worker aktivdir, real upload keçib. Telefonda ilk playback/seek uğurlu olsa da sonradan user lentində aralıq oynatma problemi bildirilib; [diaqnostika](FLUTTER_PLAYBACK_DIAGNOSTICS_AZ.md) açıqdır. Bu problem həll olunduqdan sonra yeni axının test APK-də qoşulması və mobil resume sınaqları davam edir. Production-a bu mərhələdə keçilmir.

## Növbəti addım: R2 uyğunluğu

Standalone `tmp/deployment/direct-r2-preflight.mjs` yalnız test serverinin `tmp/direct-r2-preflight.mjs` yerindən işləyir. Mövcud staging guard-dan DB/bucket/JWT ayrılığını və dəqiq PM2 yollarını yoxlayır. Test bucket-də UUID-li bir private object üçün iki hissə yaradır: 8 MiB və kiçik marker. Yanlış ölçülü imzalı PUT, vaxtı bitmiş URL, ListParts/Complete/HEAD metadata, tamamlandıqdan sonra köhnə part URL-in rəddi və tam source SHA-256 yoxlanır. Sonda öz multipart/object-i silinir və bütün API/worker PID/start vaxtları müqayisə edilir.

Bu preflight application DB-yə yazmır, `.env` dəyişmir, proses restart etmir və yeni feature-i açmır. Signed URL və credential stdout-a yazılmır. O, həqiqi R2 imza/MPU davranışı üçündür; yeni API-nin real R2 ilə end-to-end yük sınağının əvəzi deyil.

Real server nəticəsi alınıb: yeddi yoxlamanın hamısı keçib, sınaq object/MPU-ları silinib və bütün API/worker PID-ləri saxlanıb. Report: `tmp/direct-r2-preflight-8b97c5c4-bb1b-44f0-9bd2-11696a120cd1.json`. Sonra [test API/worker keçidi](DIRECT_UPLOAD_STAGING_ROLLOUT_AZ.md) və real upload/worker işi də keçib. [Nəticə](DIRECT_UPLOAD_STAGING_RESULT_2026-11-09.md) telefon playback/resume və performans hədəflərinin hələ qaldığını ayrıca göstərir.

Preflight keçəndən sonra ayrıca test kod/env backup-ı ilə API və worker birlikdə yenilənməli, yalnız staging-də feature açılmalıdır. Worker yeni direct job-ların müddətini probe ilə doldurmalıdır. Aktiv direct sessiyalar və ya yeni queued job-lar varkən köhnə worker-ə kor-koranə rollback olmaz: əvvəl yeni init bağlanır, yeni kodla sessiyalar tamamlanır/ləğv olunur və növbə boşaldılır. Bundan sonra Flutter və 20/35/50 MB müqayisəsi aparılır. Init `<300 ms`, API RSS azalması və real model/R2 p95 hələ ölçülmüş təminat deyil.

Mənbələr: [R2 presigned URL semantikası](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [R2 multipart/S3 dəstəyi](https://developers.cloudflare.com/r2/api/s3/api/). Hazırkı real S3 davranışı staging nəticəsi ilə təsdiqlənməlidir.
