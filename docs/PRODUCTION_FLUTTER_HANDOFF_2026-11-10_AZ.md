# Flutter: 10 noyabr canlı backend buraxılışı

Backend hazır optimizasiya dəyişiklikləri ilə canlıdadır: `740c57e09cb9e25439d994a1ed8ae0fa527e7b8f`. Serverdə yeni worker/indekslər, auth, public feed/Range və direct init yoxlanıb. Mövcud hesab/video ID-ləri, JWT/OTP və xidmət açarları qorunub. Test hesabları production-a köçürülməyib. Backend versiyasının dəyişməsi APK-dəki oynatma və sessiya-bərpa səhvlərinin düzəldildiyini göstərmir.

## Ünvanlar

| Build | API base | Swagger |
| --- | --- | --- |
| Production | `https://api.talkmart.az/api` | `https://api.talkmart.az/api-docs/` |
| Test | `https://api.talkmart.az/test-api/api` | `https://api.talkmart.az/test-api/api-docs/` |

Production login tam ünvanı `https://api.talkmart.az/api/auth/login`-dir. Endpoint sənədindəki `/videos/...`, `/users/...` yolları seçilmiş base-ə əlavə edilir; `/api/api` və ya `/test-api` qarışması olmasın. Hər mühit öz hesab, kateqoriya və tokenlərini istifadə etsin. Tokenin yaddaş key-i mühitlə ayrılmalıdır. Staging tokeni production-da işləmir. Mövcud etibarlı production tokenini build yenilənməsi səbəbilə silməyin; auth backend tərəfindən rədd edilərsə uyğun giriş axınını göstərin.

## Hazır backend müqaviləsi

Əvvəlki `POST /videos/upload` multipart yolu işləyir. Yeni hissəli R2 upload backend-də hər iki mühitdə aktivdir; APK bunu özü seçib qoşmalıdır. [Direct upload müqaviləsi](FLUTTER_DIRECT_UPLOAD_AZ.md) init → imzalı raw part PUT → status/resume → complete/cancel axınını və retry/idempotency qaydalarını verir. Nümunə categoryId test bazasındandır; production üçün canlı `/categories` nəticəsindən ID götürün.

Mobil direct axın əvvəlcə test APK-də sınaqdan keçirilsin. Fayl body-si API/Multer-ə göndərilməsin; R2 PUT-larına backend Bearer tokeni əlavə edilməsin; 8 MiB hissələr stream edilsin. Bir məntiqi upload-un eyni açar/sessionId-si şəbəkə retry-si və tətbiqi yenidən açanda saxlanmalıdır. 100% transfer AI təsdiqi demək deyil. `queued/pending/inactive` → emal/baxış UI-si; public görünürlük `ready + approved + active` ilə idarə olunur. [Ümumi müqavilə](FLUTTER_INTEGRATION_AZ.md) və private preview expiry qaydaları da qüvvədədir.

## İki açıq APK problemi

1. **Aralıq oynatma:** user lentində səsli test videosu bəzən işləmir; eyni telefonda brauzer səs və seek ilə sağlamdır. Server HEAD/Range, tam software decode və source packet hash yoxlamaları keçib. Dəqiq səbəb üçün nasaz anın player/ExoPlayer/MediaCodec xətası və controller lifecycle lazımdır. [Diaqnostika](FLUTTER_PLAYBACK_DIAGNOSTICS_AZ.md).
2. **Bağlayanda sessiyanın itməsi:** tokenin təhlükəsiz yaddaşa yazılması və startup-da oxunmasının gözlənilməsi, interceptor-un offline/5xx/media xətasını logout etməməsi yoxlanmalıdır. Normal access müddəti yeddi gündür; ayrıca refresh endpoint-i yoxdur. [Diaqnostika](FLUTTER_SESSION_RESTORE_AZ.md).

Flutter mənbə kodu bu backend workspace-də yoxdur, bu iki səbəb client logu ilə hələ təsdiqlənməyib. Yeni APK və düzəliş qeydi tələb olunur.

## Mobil qəbul

Əvvəl test build-də iki problemin düzəlişi, oynatma/səs/seek, app-i tam bağlayıb yenidən açanda sessiyanın qalması, like/save və upload/emal/moderasiya yoxlanılsın. Yeni direct axında şəbəkə kəsilməsi, app restart/resume, URL expiry, cancel və complete retry bir video ilə nəticələnməlidir.

Sonra production build-də canlı mühitin idarə olunan hesabı ilə fresh login/profil, app restart, lent, like/save və uyğun kateqoriyada bir controlled upload → AI/media statusu → oynatma yoxlanılsın. Yeni production test hesabı/video bu server keçidi zamanı avtomatik yaradılmayıb. OTP və silinmə sınaqları üçün istifadəçinin ayrıca seçdiyi hesabdan istifadə edin. Nəticədə build versiyası, mühit, video ID-si, şəbəkə və xəta/sınaq nəticələrini verin; token/parol/signed URL paylaşmayın.
