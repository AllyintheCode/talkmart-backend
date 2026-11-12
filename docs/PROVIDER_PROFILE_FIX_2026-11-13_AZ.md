# Admin əlaqə məlumatları və provider profilində videolar

13 noyabr 2026: düzəliş `main` əsasında `codex/admin-contact-provider-videos` branch-ində hazırlanıb. Canlı serverə tətbiq edilməyib. Ayrıca yaradılmış provider videoları API-si istifadəçinin istəyi ilə silinib; mövcud Explore sorğusundakı provider filtri saxlanılıb.

## Tapılan problemlər

- Admin panel `https://api.talkmart.az/api/admin/users` ünvanını çağırır. Canlı versiyaya uyğun controller yalnız seçilmiş sahələri qaytarırdı; `email` və `phone` həmin seçimdə yox idi. İkisi də admin cavabına əlavə edilib.
- Canlı `GET /api/videos/explore?providerId=...&limit=50` sorğusunda real provider ID-si və mövcud olmayan ID eyni `total: 18` və üç providerin videolarını qaytardı. Controller `providerId` parametrini istifadə etmirdi.

Mobil layihənin kodu bu kompüterdə deyil. Buna görə tətbiqin faktiki hansı yolu çağırdığı və cavabı necə göstərdiyi təsdiqlənməyib; yuxarıdakılar birbaşa API yoxlaması ilə təsdiqlənmiş backend problemləridir.

## Mobil tətbiqin profil sorğusu

Profil açıldıqda lentdəki `video.provider._id` ilə çağırın:

```http
GET /api/videos/explore?providerId={providerId}&page=1&limit=15
```

Guest baxa bilər. Login varsa mövcud Bearer access token-i göndərin: `isLiked`, `isSaved` və qarşılıqlı bloklama nəzərə alınır. Nəticəni `videos` massivindən oxuyun. `count`, `total`, `page`, `totalPages`, `nextCursor` mövcuddur. Sonrakı səhifə üçün eyni provider ID-si və `page`, yaxud `cursor` göndərin; ikisini birlikdə istifadə etməyin.

Yalnız həmin providerin `ready` + `approved` + `active`, gizlədilməmiş və ictimai video linki olan videoları qaytarılır. Sahib bloklanıbsa, hesab silinirsə, email təsdiqlənməyibsə və ya giriş etmiş istifadəçi ilə bloklama varsa nəticə boşdur. Mövcud olmayan provider ID-si boş siyahı, yanlış ID formatı `400` qaytarır. Provider seçimi səhifələmədən əvvəl tətbiq edilir.

`GET /api/videos/my-videos` giriş etmiş providerin öz videolarıdır; başqa providerin ictimai profil ekranı üçün nəzərdə tutulmayıb. Email və telefon yalnız admin siyahısına əlavə edilib, ictimai videolara daxil edilməyib.

## Yoxlama

Üç yeni integration testi əvvəlki kodda uğursuz oldu: email/telefon yox idi, provider seçimi başqa hesabların videolarını qaytarırdı və bloklanmış providerin profilində başqa sahibin videosu qalırdı. Düzəlişdən sonra admin icazələri, sahə seçimi, iki providerin qarışmaması, səhifələmə/cursor, bəyənmə/yadda saxlama, yanlış/mövcud olmayan ID, media statusları və ikitərəfli bloklama yoxlamaları keçdi. Əvvəl email/telefonun olmamasını tələb edən mövcud admin səhifələmə testi də yeni tələbə uyğunlaşdırıldı.

- `npm run lint`: keçdi.
- `npm test`: 54/54 keçdi.
- `npm run test:integration`: 53/53 keçdi.
- OpenAPI JS/JSON nüsxələrinin eyniliyi və Explore provider filtri yoxlandı.
- `git diff --check`: keçdi.

Ayrıca API silindikdən sonra admin əlaqə məlumatları, provider filtri, səhifələmə və bloklama üzrə 5 əlaqəli integration testi yenidən keçdi. Route və OpenAPI-dən yeni yolun çıxarıldığı, Explore filtrinin qaldığı ayrıca yoxlandı.

Serverə tətbiqdən sonra admin siyahısında `email` və `phone`, real mobil tətbiqdə isə provider profilinin düzgün ID, mövcud Explore sorğusu və `videos` cavabı ilə işləməsi yoxlanmalıdır.
