# Flutter üçün Talkmart test API təlimatı

Backend dəyişiklikləri hazırda test mühitindədir. Giriş, provider video yükləməsi, emal, AI təsdiqi, oynatma, bəyənmə/yadda saxlama və admin moderasiyası real serverdə yoxlanılıb. Flutter uyğunlaşdırması və tətbiq daxilində sınaq qalıb.

- Test base URL: `https://api.talkmart.az/test-api/api`
- Swagger: `https://api.talkmart.az/test-api/api-docs/`
- Tam giriş URL nümunəsi: `https://api.talkmart.az/test-api/api/auth/login`

Aşağıdakı endpoint yolları test base URL-ə əlavə olunur. Test build-in faktiki sorğu ünvanını tam giriş URL nümunəsi ilə yoxlayın. User və provider girişləri ayrıca paylaşılmalıdır; onları mənbə koduna yazmayın. Test hesablarının email və nömrələri sintetikdir. Qeydiyyat, OTP, real əlaqə və silinmə sınaqları üçün ayrıca test hesabı istifadə edin.

1. **Sessiya və şifrə sıfırlama.** Login cavabındakı `token` access token-dir. Qorunan sorğularda `Authorization: Bearer <token>` göndərin. Köhnə sessiyalar yenidən giriş tələb edir. `401` / `SESSION_REVOKED` / `TOKEN_EXPIRED` zamanı saxlanmış sessiyanı yeniləyin və giriş ekranına keçin. Forgot-password axınındakı `resetToken` yalnız `POST /auth/forgot-password/reset-password` gövdəsində `{resetToken,newPassword}` üçün istifadə olunur. Reset tamamlananda yenidən login edin.

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
