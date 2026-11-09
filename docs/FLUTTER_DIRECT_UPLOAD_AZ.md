# Flutter: hissəli birbaşa R2 upload müqaviləsi

9 noyabr 2026: yeni yol yalnız test serverində `73de3a9f5447db17e0d4ffb4b0e1e9c5cfd0814b` buraxılışı ilə aktivdir. Real R2 upload, hissə saxlanmaqla resume, idempotent complete və worker/AI işi keçib. “PERF direct təmizlik” videosu test APK-də oynadılıb, lakin sonrakı yoxlamada user lentində bəzi videolarda aralıq oynatma problemi bildirilib. Əvvəl [oynatma diaqnostikası](FLUTTER_PLAYBACK_DIAGNOSTICS_AZ.md) tamamlanmalıdır. Playback nəticəsi APK-nın artıq yeni direct upload yolundan istifadə etdiyini göstərmir; aşağıdakı axın Flutter-də ayrıca qoşulmalıdır.

Production-a bu dəyişiklik tətbiq edilməyib. `DIRECT_UPLOAD_ENABLED` standart olaraq `false`-dur. Mövcud `POST /videos/upload` multipart yolu saxlanılıb. Yeni axın əvvəlcə test APK-də yoxlanmalıdır; bu tapşırıq üçün production base URL-ni dəyişməyin.

Backend test base URL: `https://api.talkmart.az/test-api/api`. Aşağıdakı yollar bu base-ə əlavə olunur. Backend sorğularına provider access token-i verin. R2 URL-lərinə backend Bearer token-i göndərməyin.

## 1. Upload sessiyası açmaq

`POST /videos/upload-init`, `Content-Type: application/json`, `Authorization: Bearer <access-token>`, hər yeni məntiqi upload üçün `Idempotency-Key: <UUID>`.

```json
{
  "title": "Təmizlik xidməti",
  "description": "Ev təmizliyi xidməti",
  "price": 50.5,
  "categoryId": "6adfd4c4eefbfb98a5fbfa2c",
  "bytes": 32350603,
  "contentType": "video/mp4"
}
```

`bytes` faylın həqiqi byte ölçüsüdür, MB deyil; maksimum 262,144,000 byte. JSON-da `price` və `bytes` number-dır. `title` istəyə bağlıdır. Dəstəklənən MIME-lər: `video/mp4`, `video/quicktime`, `video/x-msvideo`, `video/x-matroska`. Backend fayl adını, bucket-i və object key-ni client-dən qəbul etmir.

Yeni sessiya `201`, eyni açar/məlumat təkrarı `200/replayed` qaytarır. Mövcud API wrapper-i səbəbindən `upload` top-level-də və `data.upload` içində ola bilər; tətbiq eyni məntiqi obyekti oxusun. Sessiyada `sessionId`, `expiresAt`, `urlExpiresAt`, `partSize`, `partCount`, `parts`, `uploadedParts`, `storageComplete` var. Hələ video queued deyil. Init göndərilməzdən əvvəl məntiqi açarı, metadata-nı və dəyişməyən yerli fayl istinadını saxlayın. Init cavabı itərsə yeni UUID yaratmadan eyni payload/açarla retry edin.

## 2. Fayl hissələrini R2-yə göndərmək

Hər `parts[]` elementi: `partNumber`, `offset`, `bytes`, `uploadUrl`, `method=PUT`, `headers.Content-Length`. Hissə ölçüsü 8 MiB-dir; son hissə qısadır, ən çox 32 hissə var.

- Yerli faylın `[offset, offset + bytes)` aralığını stream edin; multipart/form-data yaratmayın. Bütöv faylı hər URL-yə göndərməyin.
- `uploadUrl`-i bütün query parametrləri ilə dəyişmədən istifadə edin. `Content-Length` həqiqi hissə ölçüsünə tam bərabər olmalıdır. Bu başlıq imzaya daxildir. Backend JWT, əlavə S3 credential və öz checksum başlıqlarınızı əlavə etməyin.
- Dio üçün ayrı R2 client/interceptor istifadə edin; backend auth interceptor-u bu sorğuya Bearer əlavə etməsin. `File.openRead(offset, offset + bytes)` kimi hissə stream-i istifadə edin. `contentLength` məlum olsun, chunked/naməlum uzunluqdan istifadə etməyin. Brauzerdə bu başlığı browser özü Blob uzunluğundan göndərir.
- UI upload progress-i bütün hissələr üzrə real göndərilmiş byte-ların cəmi ilə göstərsin. Eyni hissənin təkrar cəhdini iki dəfə tamamlanmış kimi saymayın. Məhdud sayda paralel hissə göndərin; bütün 250 MB faylı RAM-a yığmayın.
- R2 `2xx` hissənin ötürülməsini təsdiqləyir. Backend tamamlamada R2-dən həqiqi ETag/ölçüləri özü alır; client onların siyahısını `upload-complete` gövdəsinə yazmır.

R2 URL-i bearer icazəsidir; log/analytics/daimi bazaya yazmayın. Token ləğvi artıq verilmiş URL-i öz-özünə silmir; URL maksimum 10 dəqiqə və ya multipart abort-a qədər işləyə bilər. API sahiblik və cari sessiyanı hər control sorğusunda yoxlayır; həmin icazə başqa istifadəçiyə queue/publication yaratmaq hüququ vermir.

## 3. Dayanma və davam etmə

Sessiya maksimum 30 dəqiqədir. Access token təhlükəsiz auth yaddaşında saxlanır; `sessionId`, yerli fayl identifikatoru, ölçü və başlanğıcdakı məntiqi `Idempotency-Key` ayrıca saxlanmalıdır. Yerli faylı sessiya bitənədək dəyişməyən, tətbiqin yenidən açıldıqda oxuya biləcəyi yerdə saxlayın; ölçüsü eyni olsa da başqa video ilə əvəz etməyin. Yeni API cavabı alınanda köhnə signed URL-ləri yeniləri ilə əvəz edin.

`GET /videos/uploads/{sessionId}` tokenlə çağırılır. Backend R2-də həqiqətən olan hissələri yoxlayır. `uploadedParts` hazır hissələrdir; `parts` yalnız çatışmayan və ya ölçüsü uyğun olmayan hissələrin yeni URL-ləridir. Eyni yerli fayl ilə həmin offset-lərdən davam edin. Yerli fayl dəyişibsə köhnə hissələri qarışdırmayın: cancel edin və yeni açarla yeni upload başladın. Eyni ölçülü dəyişmiş faylı backend init metadata-sından müəyyən edə bilməz.

`storageComplete=true` olduqda R2 artıq yığılıb, amma queue acceptance cavabı itmiş ola bilər. Hissələri yenidən göndərmədən `upload-complete`-i təkrar çağırın. `upload.status=completed` və `video` varsa həmin video ID-si ilə mövcud status axınına keçin.

`409/UPLOAD_INITIALIZING`, `409/UPLOAD_COMPLETING`, `409/UPLOAD_BUSY`: məhdud backoff ilə retry edin. Control sorğularını upload progress polling kimi davamlı göndərməyin. API prosesinin yaratma mərhələsində cavabı itmədən əvvəl heç bir URL verilməyibsə, stale sessiya təmizlənib `410/UPLOAD_RESTART_REQUIRED` verə bilər. Bu halda yeni açarla yenidən başlayın.

## 4. Tamamlamaq

`POST /videos/upload-complete`, JSON `{"sessionId":"<id>"}`, backend Bearer token-i ilə. Əlavə bucket, key, parts, ETag, owner və ya MIME göndərməyin.

Backend hissələrin sayını/ölçüsünü, R2 metadata sahibini və bütöv fayl ölçüsünü yoxlayır. R2 multipart bağlanır; əvvəlki part URL-ləri ilə orijinalın dəyişdirilməsi mümkün olmamalıdır. Sonra bir transaction-da bir video queue qeydi yaradılır. `201` ilk qəbul, `200/replayed` həmin videonun təkrarıdır. Şəbəkə/DB cavabı itəndə eyni `sessionId` ilə retry edin.

`video.processingStatus=queued`, `moderationStatus=pending`, `status=inactive` normal ilkin nəticədir. Faylın faktiki konteyner/codec/duration yoxlamasını worker edir. MIME və upload tamamlanması AI təsdiqi deyil. Saxta və ya zədəli fayl worker-də `failed` ola bilər. Mövcud `GET /videos/my-videos` və `ready + approved + active` nəşr qaydası saxlanılır.

Progress 100% yalnız faylın ötürüldüyünü göstərir. Sonra UI “Emal olunur / yoxlanılır” mərhələsinə keçsin. Upload sessiyasının statusunu video `processingStatus` ilə qarışdırmayın. Öz videoları siyahısında `queued/processing`, `failed`, `pending/review`, `rejected` hallarını statusla göstərin; `ready` təkbaşına yayımlanma və ya təsdiq demək deyil. Public görünürlük üçün backend nəticəsi və `ready + approved + active` əsasdır.

## 5. Ləğv və xətalar

`DELETE /videos/uploads/{sessionId}` unfinished multipart-ı ləğv edir. Cleanup uğurlu olduqda yüklənməmiş gündəlik ehtiyat byte-lar qaytarılır; artıq yüklənmiş byte-lar həmin günün sayında qalır. Storage xətası olduqda sessiya təmizləmə növbəsində qalır, counter yalnız bir dəfə hesablaşır. Təkrar DELETE təhlükəsizdir. Tamamlanmış video üçün adi `DELETE /videos/{id}` istifadə edin.

| Kod | Tətbiqin davranışı |
|---|---|
| `DIRECT_UPLOAD_DISABLED` | Bu mühitdə yeni yol aktiv deyil; dəstəklənən multipart yolunu istifadə edin. |
| `IDEMPOTENCY_CONFLICT` | Eyni açarın məlumatları dəyişib; mövcud sessiyanı qarışdırmayın. |
| `UPLOAD_INCOMPLETE` | Statusu alın, çatışmayan hissələri göndərin, complete retry edin. |
| `UPLOAD_SIZE_OR_TYPE_MISMATCH` | Tamamlanmış obyekt gözlənilən ölçüdə deyil; cancel və yeni upload tələb olunur. |
| `UPLOAD_EXPIRED` / `UPLOAD_RESTART_REQUIRED` | Yeni açar və sessiya ilə yenidən başlayın. |
| `UPLOAD_VIDEO_UNAVAILABLE` | Video silinib/əlçatmazdır; stale retry ilə onu yenidən yaratmayın. |
| `UPLOAD_CONCURRENCY` | Bu provider-in başqa upload-u davam edir; onu davam etdirin və ya ləğv edin. |
| `UPLOAD_QUOTA` / `UPLOAD_DAILY_QUOTA` | Limit UI-si və `Retry-After`; sonsuz retry etməyin. |
| `UPLOAD_UNAVAILABLE` | Müvəqqəti xəta; eyni sessiya/açarla məhdud retry, sonra status. |
| `SESSION_REVOKED` / `TOKEN_EXPIRED` | Mövcud auth axını ilə yenidən giriş. Yeni tokenlə sessiyanın sahibinə aid resume mümkündür. |

Legacy multipart-a avtomatik fallback yalnız həmin məntiqi upload üçün ilk init-in açıq şəkildə `DIRECT_UPLOAD_DISABLED` verdiyi və əvvəlki naməlum init cəhdi olmadığı halda tətbiq olunsun. Əvvəlki init cavabı itibsə sonrakı `DIRECT_UPLOAD_DISABLED` həmin köhnə sessiyanın yaradılmadığını sübut etmir. Şəbəkə timeout-u, başqa `5xx`, R2 part xətası və ya naməlum complete cavabı üçün ayrıca legacy upload yaratmayın: əvvəl eyni açar/sessiya ilə vəziyyəti bərpa edin. Əks halda iki ayrı video yarana bilər.

## Test qəbul sınağı

Real test R2 multipart/signed-length/expiry/abort/overwrite sınağı və test backend-də aktivləşdirmə tamamlanıb. Bir real direct video `ready / approved / active` olub; telefon playback/seek təsdiqlənib. Server ölçməsi və məhdudiyyətlər [nəticə hesabatındadır](DIRECT_UPLOAD_STAGING_RESULT_2026-11-09.md).

Flutter-də bunlar ayrıca yoxlanmalıdır:

1. Test APK-dən 20/35/50 MB video; real progress, complete-dən sonra emal statusu və sonda oynatma. Fayl PUT-larının R2-yə getdiyi, `/videos/upload`-a tam fayl göndərilmədiyi development yoxlamasında təsdiqlənsin. Token və signed URL-ləri paylaşılmış loglara çıxarmayın.
2. Bir hissə bitəndən sonra şəbəkəni kəsib bərpa etmək; daha sonra tətbiqi bağlayıb açmaq. Eyni sessiya davam etsin, hazır hissələr təkrar yüklənməsin və bir video yaransın.
3. Vaxtı bitmiş part URL üçün statusdan təzə URL almaq; sessiya bitibsə yeni sessiya ilə başlamaq. Başqa/dəyişmiş faylı köhnə hissələrlə qarışdırmamaq.
4. Cancel və təkrarı; naməlum complete cavabından sonra eyni sessionId ilə retry; eyni istifadəçinin ikinci paralel upload-u üçün anlaşılan limit davranışı.
5. Uyğunsuz kateqoriya/zədəli video və AI review/reject hallarında düzgün status; həmin videonun başqa user/feed üçün açılmaması. Köhnə multipart yolunun regressiyası ayrıca yoxlanılsın.

Flutter Web üçün private bucket-də uyğun origin/PUT CORS lazımdır; `ETag` expose faydalıdır. Mobil APK sınağı üçün bucket-in public çıxışını açmaq lazım deyil. Public development URL private bucket-də bağlı qalmalıdır. Developer nəticəsində APK versiyası, video ID-si, şəbəkə növü, resume/cancel/retry nəticələri və qəbul/emal vaxtları ayrıca verilsin.

Mənbələr: [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [R2 multipart əməliyyatları və limitləri](https://developers.cloudflare.com/r2/api/s3/api/). Cloudflare davranışı real test bucket-də ayrıca yoxlanmadan lokal emulator nəticəsi xidmət təsdiqi sayılmır.
