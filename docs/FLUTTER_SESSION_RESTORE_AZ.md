# Tətbiqi yenidən açanda sessiyanın itməsi

10 noyabr 2026: istifadəçi tətbiqi bağlayıb açanda hesabdan çıxdığını bildirir. Flutter mənbə kodu bu workspace-də yoxdur; nasaz APK-nın ilk auth sorğusu və xəta qeydi alınmayıb. Konkret səbəb hələ təsdiqlənməyib.

## Backend-dən təsdiqlənənlər

`src/utils/jwt.js` həm staging buraxılışında, həm production audit buraxılışında access token-i `7d` ilə yaradır. Tokenin normal müddəti yeddi gündür. Tətbiqin bağlanması backend-də avtomatik sessiya ləğvi kimi işlənmir. Hesab vəziyyəti və `sessionVersion` hər qorunan sorğuda yoxlanır; parol/təhlükəsizlik dəyişiklikləri köhnə tokeni daha tez etibarsız edə bilər.

`src/middlewares/auth.middleware.js` nəticələri ayırmağa kömək edir:

- `TOKEN_MISSING`: sorğuda gözlənilən Bearer token yoxdur. Startup restore və auth header-in əlavə olunmasını yoxlayın.
- `TOKEN_EXPIRED`: hazırkı backend bu kodu təkcə müddət bitməsinə deyil, digər JWT verification uğursuzluqlarına da verir. Quote/JSON ilə səhv saxlanmış token, test/production token və base URL qarışması da araşdırılmalıdır; bu koddan təkbaşına yeddi günün keçdiyi çıxmır.
- `SESSION_REVOKED`: tokenin sessionVersion-u hesabla uyğun deyil; istifadəçi yenidən daxil olmalıdır.
- Bloklanmış və ya silinən hesab üçün backend qərarı əsasdır. Offline/client cache qorunan əməliyyatlara icazə vermir.

## Flutter-də yoxlanmalı axın

1. Login cavabındakı `token` / `data.token` access token-dir. Onu təhlükəsiz daimi telefon yaddaşına yazın və yazma tamamlandıqdan sonra əsas ekrana keçin. Yalnız RAM-da token və ya ayrıca `isLoggedIn` flag-i saxlamaq kifayət deyil. Raw tokeni saxlayın; JSON quote-larını və ya bütöv login response-u Bearer token kimi oxumayın.
2. Soyuq açılışda qısa auth-loading vəziyyətindən başlayın. Yaddaşdan oxuma tamamlanmadan guest/login marşrutunu və ya token tələb edən ilk sorğunu işə salmayın. Token varsa əvvəl auth header-i bərpa edin, sonra qorunan profil sorğusu ilə vəziyyəti yoxlayın.
3. App pause, widget dispose və tətbiqin normal bağlanması explicit logout əməliyyatı deyil. Bu hadisələrdə tokenin/yaddaşın silinmədiyini və auth flag-in sıfırlanmadığını yoxlayın.
4. Interceptor-da cavabın origin/endpoint və `error.code` məlumatını ayırın. Timeout, offline, `5xx`, player/R2 xətası səbəbindən sessiyanı silməyin. Təsdiqlənmiş auth rəddi üçün düzgün giriş axınını tətbiq edin. `TOKEN_MISSING` startup yarışıdırsa restore/ilk sorğunun sırası düzəldilməlidir.
5. Test və production base URL-ləri və onların token yaddaşları qarışmasın. Backend-də ayrıca refresh-token endpoint-i yoxdur; hər açılışda olmayan refresh endpoint-i çağırıb onun uğursuzluğu ilə logout etməyin. Etibarlı access token bərpa olunur; həqiqi auth rəddi olduqda yenidən login edilir.

Nasaz an üçün yalnız bunları paylaşın: APK/cihaz versiyası, bağlama üsulu, startup storage oxunmasının uğuru/tokenin olub-olmaması, sorğunun origin və endpoint-i, Bearer header-in olub-olmaması, HTTP status/error.code. Token, parol və tam Authorization dəyərini paylaşılmış loga yazmayın.

Qəbul sınağı: login → app-i arxa plana alıb qayıtmaq → tam bağlayıb dərhal yenidən açmaq → hesabın qalması; sonra explicit logout → yenidən açılışda girişin tələb olunması. Parol dəyişdikdən sonra köhnə sessiyanın rədd edilməsi də saxlanmalıdır. Bu yoxlama [oynatma problemi](FLUTTER_PLAYBACK_DIAGNOSTICS_AZ.md) və [direct upload/resume](FLUTTER_DIRECT_UPLOAD_AZ.md) üçün ayrıca mobil qəbul maddəsidir.
