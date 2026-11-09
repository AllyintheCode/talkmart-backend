# Flutter üçün Talkmart test API təlimatı

9 noyabr vəziyyəti: aşağıdakı [private preview bölməsi](#private-preview-lokal-optimizasiya-buraxılışı) test serverində tətbiq olunub. İstifadəçi mövcud APK-də səssiz/səsli oynatma, seek və 11 dəqiqədən sonra sahibin videosunun yenidən açılması axınını təsdiqləyib.

Backend optimizasiyaları hazırda test mühitindədir. Giriş, provider video yükləməsi, emal, AI təsdiqi, oynatma, bəyənmə/yadda saxlama və admin moderasiyası real serverdə yoxlanılıb. Ayrıca [hissəli birbaşa R2 upload müqaviləsi](FLUTTER_DIRECT_UPLOAD_AZ.md) yeni lokal mərhələdir; onun real R2 yoxlaması, test backend buraxılışı və Flutter inteqrasiyası hələ gözlənilir. Hazırkı APK multipart yolunu istifadə etməyə davam edir.

- Test base URL: `https://api.talkmart.az/test-api/api`
- Swagger: `https://api.talkmart.az/test-api/api-docs/`
- Tam giriş URL nümunəsi: `https://api.talkmart.az/test-api/api/auth/login`

Aşağıdakı endpoint yolları test base URL-ə əlavə olunur. Test build-in faktiki sorğu ünvanını tam giriş URL nümunəsi ilə yoxlayın. User və provider girişləri ayrıca paylaşılmalıdır; onları mənbə koduna yazmayın. Test hesablarının email və nömrələri sintetikdir. Qeydiyyat, OTP, real əlaqə və silinmə sınaqları üçün ayrıca test hesabı istifadə edin.

1. **Sessiya və şifrə sıfırlama.** Login cavabındakı `token` access token-dir; normal müddəti yeddi gündür. Təhlükəsiz daimi yaddaşa yazın, startup-da yaddaş oxunması tamamlandıqdan sonra auth vəziyyətini bərpa edin və qorunan sorğularda `Authorization: Bearer <token>` göndərin. App-i bağlamaq logout deyil. Təsdiqlənmiş auth rəddi (`SESSION_REVOKED` və ya JWT validation uğursuzluğu) yenidən giriş tələb edə bilər; `TOKEN_MISSING` üçün startup/header sırasını araşdırın. Timeout/offline/`5xx` və media xətalarını logout-a çevirməyin. Ayrı refresh-token endpoint-i yoxdur. [Sessiya bərpası diaqnostikası](FLUTTER_SESSION_RESTORE_AZ.md) detalları verir. Forgot-password axınındakı `resetToken` yalnız `POST /auth/forgot-password/reset-password` gövdəsində `{resetToken,newPassword}` üçün istifadə olunur. Reset tamamlananda yenidən login edin.

2. **Cavab formatı.** Xətanı `error.code` və `error.message` ilə oxuyun: `{success:false,data:null,error:{code,message},meta:{requestId}}`. Uğurlu cavablarda mövcud `token`, `user`, `video`, `videos` kimi sahələr saxlanılıb; `data` və `meta` də əlavə olunur. `429` cavabında `Retry-After` başlığını nəzərə alın.

3. **Provider təsdiqi.** Email OTP təsdiqi və provider-in admin təsdiqi ayrı mərhələlərdir. Video üçün `providerProfile.verified === true` tələb olunur. `403 / PROVIDER_NOT_VERIFIED` zamanı təsdiq gözləmə vəziyyətini göstərin. Admin təsdiqi sessiyanı yeniləməyə səbəb olur; köhnə token `401` qaytardıqda yenidən giriş tələb olunur.

4. **Video yükləmə və status.** `POST /videos/upload` multipart sahələri: `title`, `description`, `price`, `categoryId`, `video`. Hər yeni yükləmə üçün `Idempotency-Key` yaradın; həmin yükləmənin şəbəkə təkrarlarında eyni açarı saxlayın. Açar 8–100 hərf/rəqəm/`_`/`-` olmalıdır; UUID uyğundur. İlk qəbul `201` və `processingStatus: queued` qaytarır. Təkrar qəbul `200` və `replayed:true` qaytara bilər. `video._id` ilə `GET /videos/my-videos` nəticəsindən statusu izləyin. Upload cavabı emala qəbul deməkdir. İctimai yayımlanma üçün `processingStatus=ready`, `moderationStatus=approved`, `status=active` birlikdə olmalıdır. UI emal, admin baxışı (`review`), rədd və emal xətasını ayrı göstərsin. Server maksimum 250 MB və 5 dəqiqə qəbul edir. Upload sorğusunun timeout-u ilə sonrakı status yoxlamasını ayrı idarə edin.

5. **Bəyənmə və yadda saxlama.** Sorğular istənilən son vəziyyəti göndərməlidir:
   - `POST /videos/{id}/like`: `{liked:true}` və ya `{liked:false}`.
   - `POST /videos/{id}/save`: `{saved:true}` və ya `{saved:false}`.
   - Eyni sorğunun təkrarı sayı artırmır. UI sayları serverin `likeCount` / `saveCount` cavabından götürsün. `DELETE` eyni endpointlərdə qarşılıqlı əlaqəni silir.

6. **Baxış və guest sessiyası.** `POST /videos/{id}/view` üçün `{watchedMs:2000}` və ya daha böyük faktiki izləmə müddəti göndərin. Guest üçün serverin `tm_view` cookie-sini saxlayıb sonrakı sorğulara qaytarın. Eyni sessiyanın təkrar baxışı 24 saatda əlavə sayılmır.

7. **Əlaqə və WhatsApp.** Lentdən telefon və ünvan oxumağa əsaslanmayın. Əlaqə üçün tokenlə `GET /users/provider/{id}/contact` çağırın; guest-i girişə yönləndirin. `GET /users/provider/{id}/whatsapp` da token tələb edir və `302` qaytarır. Tokenli API sorğusunun `Location` ünvanı açılmalıdır.

8. **Siyahılar və silinmə.** `page` / `limit` istifadə edin; maksimum `limit=50`. `nextCursor` qaytaran endpointlərdə sonrakı səhifəyə həmin `cursor` ilə davam edin. `DELETE /videos/{id}` və `DELETE /users/account` silinməni qəbul edəndə UI-dən müvafiq elementi çıxarın; hesab silinirsə sessiyanı təmizləyin. Server media və əlaqəli məlumatları fonda təmizləyir.

Tətbiqdə sınaq ardıcıllığı: guest lent və video oynatma → user login → like/unlike və save/unsave → əlaqə və WhatsApp → provider login və upload → statusların yenilənməsi → OTP və şifrə sıfırlama → ayrıca test hesabında silinmə.

Test build-i və yoxlamaların nəticələrini göndərin. Uğursuz sorğu üçün endpoint, HTTP status, `error.code` və `meta.requestId` kifayətdir. Canlı API-yə keçid backend buraxılışı ilə uyğunlaşdırılacaq.

## Private preview: lokal optimizasiya buraxılışı

Upload sahələri və endpointlər saxlanılıb. Uyğun H.264 faylı orijinal ölçüdə təkrar encode edilmədən hazırlanır; digər fayllar H.264/AAC-a çevrilir.

- Sahibin `GET /videos/my-videos` və admin video siyahısında təsdiqsiz/gizli hazır video üçün `videoUrl` və `thumbnail` müddətli imzalı link ola bilər. `mediaUrlExpiresAt` varsa link 10 dəqiqəlik preview-dir. Emal bitməyibsə URL boş qala bilər.
- Bu URL-ni daimi bazaya, loglara və analytics-ə yazmayın. Saxlanmış linki girişdən və hesab dəyişməsindən sonra təkrar istifadə etməyin. Video ekranı açılarkən və müddət bitəndə tokenlə siyahını yeniləyin, həmin video ID-sinin yeni URL-sini player-ə verin. Vaxtı bitmiş media linkinin `403` cavabı API access token-in bitməsi demək deyil.
- İmzalı R2 URL-ni query parametrləri daxil olduğu kimi açın. Ona backend Bearer token-i əlavə etməyin. Flutter Web üçün private bucket GET/HEAD CORS və Range playback ayrıca yoxlanmalıdır.
- Profil sahibi `review`/`rejected` videosuna baxa bilər; ictimai lentdə və başqa istifadəçinin profil görünüşündə həmin video görünməməlidir. Status nişanları `processingStatus`, `moderationStatus`, `status` üzrə göstərilsin.
- Admin təsdiq cavabı zamanı saxlama xidməti əlçatan deyilsə video `approved`, amma `inactive` qala bilər. Siyahını yeniləyərək `ready` + `approved` + `active` nəticəsini gözləyin. İctimai URL sonrakı təkrar təsdiqdə dəyişə bilər; video ID-si UI identifikatoru olaraq qalır.

APK sınağı: səssiz və səsli H.264 → başqa codec → istiqamət/seek/səs → rədd edilmiş videonun öz profilində preview-si → 10 dəqiqə sonra yenilənmə → admin təsdiqi və ictimai oynatma → gizlətmə/rədd və lentdən çıxma. Artıq endirilmiş/cached public faylın dərhal yox olmasına əsaslanmayın.
