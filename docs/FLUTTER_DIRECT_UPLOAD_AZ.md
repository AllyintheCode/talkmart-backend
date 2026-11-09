# Flutter: hissəli birbaşa R2 upload müqaviləsi

Bu yeni yol hazırda lokal test branch-dədir. Test serverində ayrıca buraxılış və real R2 yoxlamasından sonra aktivləşdirilməlidir. `DIRECT_UPLOAD_ENABLED` standart olaraq `false`-dur. Mövcud `POST /videos/upload` multipart yolu saxlanılıb; əvvəlki APK həmin yolla işləyir.

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

Yeni sessiya `201`, eyni açar/məlumat təkrarı `200/replayed` qaytarır. Mövcud API wrapper-i səbəbindən `upload` top-level-də və `data.upload` içində ola bilər; tətbiq eyni məntiqi obyekti oxusun. Sessiyada `sessionId`, `expiresAt`, `urlExpiresAt`, `partSize`, `partCount`, `parts`, `uploadedParts`, `storageComplete` var. Hələ video queued deyil.

## 2. Fayl hissələrini R2-yə göndərmək

Hər `parts[]` elementi: `partNumber`, `offset`, `bytes`, `uploadUrl`, `method=PUT`, `headers.Content-Length`. Hissə ölçüsü 8 MiB-dir; son hissə qısadır, ən çox 32 hissə var.

- Yerli faylın `[offset, offset + bytes)` aralığını stream edin; multipart/form-data yaratmayın. Bütöv faylı hər URL-yə göndərməyin.
- `uploadUrl`-i bütün query parametrləri ilə dəyişmədən istifadə edin. `Content-Length` həqiqi hissə ölçüsünə tam bərabər olmalıdır. Bu başlıq imzaya daxildir. Backend JWT, əlavə S3 credential və öz checksum başlıqlarınızı əlavə etməyin.
- Dio üçün ayrı R2 client/interceptor istifadə edin; backend auth interceptor-u bu sorğuya Bearer əlavə etməsin. `File.openRead(offset, offset + bytes)` kimi hissə stream-i istifadə edin. `contentLength` məlum olsun, chunked/naməlum uzunluqdan istifadə etməyin. Brauzerdə bu başlığı browser özü Blob uzunluğundan göndərir.
- UI upload progress-i bütün hissələr üzrə real göndərilmiş byte-ların cəmi ilə göstərsin. Eyni hissənin təkrar cəhdini iki dəfə tamamlanmış kimi saymayın. Məhdud sayda paralel hissə göndərin; bütün 250 MB faylı RAM-a yığmayın.
- R2 `2xx` hissənin ötürülməsini təsdiqləyir. Backend tamamlamada R2-dən həqiqi ETag/ölçüləri özü alır; client onların siyahısını `upload-complete` gövdəsinə yazmır.

R2 URL-i bearer icazəsidir; log/analytics/daimi bazaya yazmayın. Token ləğvi artıq verilmiş URL-i öz-özünə silmir; URL maksimum 10 dəqiqə və ya multipart abort-a qədər işləyə bilər. API sahiblik və cari sessiyanı hər control sorğusunda yoxlayır; həmin icazə başqa istifadəçiyə queue/publication yaratmaq hüququ vermir.

## 3. Dayanma və davam etmə

Sessiya maksimum 30 dəqiqədir. Access token təhlükəsiz auth yaddaşında saxlanır; `sessionId`, yerli fayl identifikatoru, ölçü və başlanğıcdakı məntiqi `Idempotency-Key` ayrıca saxlanmalıdır. Yeni API cavabı alınanda köhnə signed URL-ləri yeniləri ilə əvəz edin.

`GET /videos/uploads/{sessionId}` tokenlə çağırılır. Backend R2-də həqiqətən olan hissələri yoxlayır. `uploadedParts` hazır hissələrdir; `parts` yalnız çatışmayan və ya ölçüsü uyğun olmayan hissələrin yeni URL-ləridir. Eyni yerli fayl ilə həmin offset-lərdən davam edin. Yerli fayl dəyişibsə köhnə hissələri qarışdırmayın: cancel edin və yeni açarla yeni upload başladın. Eyni ölçülü dəyişmiş faylı backend init metadata-sından müəyyən edə bilməz.

`storageComplete=true` olduqda R2 artıq yığılıb, amma queue acceptance cavabı itmiş ola bilər. Hissələri yenidən göndərmədən `upload-complete`-i təkrar çağırın. `upload.status=completed` və `video` varsa həmin video ID-si ilə mövcud status axınına keçin.

`409/UPLOAD_INITIALIZING`, `409/UPLOAD_COMPLETING`, `409/UPLOAD_BUSY`: məhdud backoff ilə retry edin. Control sorğularını upload progress polling kimi davamlı göndərməyin. API prosesinin yaratma mərhələsində cavabı itmədən əvvəl heç bir URL verilməyibsə, stale sessiya təmizlənib `410/UPLOAD_RESTART_REQUIRED` verə bilər. Bu halda yeni açarla yenidən başlayın.

## 4. Tamamlamaq

`POST /videos/upload-complete`, JSON `{"sessionId":"<id>"}`, backend Bearer token-i ilə. Əlavə bucket, key, parts, ETag, owner və ya MIME göndərməyin.

Backend hissələrin sayını/ölçüsünü, R2 metadata sahibini və bütöv fayl ölçüsünü yoxlayır. R2 multipart bağlanır; əvvəlki part URL-ləri ilə orijinalın dəyişdirilməsi mümkün olmamalıdır. Sonra bir transaction-da bir video queue qeydi yaradılır. `201` ilk qəbul, `200/replayed` həmin videonun təkrarıdır. Şəbəkə/DB cavabı itəndə eyni `sessionId` ilə retry edin.

`video.processingStatus=queued`, `moderationStatus=pending`, `status=inactive` normal ilkin nəticədir. Faylın faktiki konteyner/codec/duration yoxlamasını worker edir. MIME və upload tamamlanması AI təsdiqi deyil. Saxta və ya zədəli fayl worker-də `failed` ola bilər. Mövcud `GET /videos/my-videos` və `ready + approved + active` nəşr qaydası saxlanılır.

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

## Test qəbul sınağı

Əvvəl real test R2 multipart/signed-length/expiry/abort/overwrite sınağı, sonra test backend-də aktivləşdirmə. Flutter-də 20/35/50 MB, upload zamanı şəbəkənin kəsilməsi, tətbiqin bağlanıb açılması, artıq tamamlanmış hissələrin təkrar göndərilməməsi, yanlış fayl seçimi, cancel, 10 dəqiqədən köhnə URL-in yenilənməsi, ikiqat complete və köhnə APK multipart regressiyası yoxlanmalıdır. Flutter Web üçün private bucket-də uyğun origin/PUT CORS lazımdır; `ETag` expose faydalıdır. Public development URL private bucket-də bağlı qalmalıdır.

Mənbələr: [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [R2 multipart əməliyyatları və limitləri](https://developers.cloudflare.com/r2/api/s3/api/). Cloudflare davranışı real test bucket-də ayrıca yoxlanmadan lokal emulator nəticəsi xidmət təsdiqi sayılmır.
