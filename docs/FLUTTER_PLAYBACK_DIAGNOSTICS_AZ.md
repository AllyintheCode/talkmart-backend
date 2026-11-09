# Test APK-də aralıq video oynatma problemi

9 noyabr 2026. Yeni direct upload-un server axını keçib, lakin APK-də oynatma sabitliyi üzrə açıq problem var. Yeni upload yolunun mobil qəbulunu bu problem həll olunana qədər tamamlanmış saymayın.

## Təkrar yaratmaq üçün məlumat

İstifadəçi user hesabında / əsas lentdə bəzi videoların bəzən işlədiyini, bəzən açılmadığını bildirir. “PERF direct təmizlik” sonradan işləyib; konkret işləməyən nümunə **PERF səsli təmizlik**-dir. Eyni telefonda həmin səsli video brauzerdə səslə normal oynayır və irəli/geri sarılır. Telefon modeli, OS/APK versiyası və bağlantı növü hələ verilməyib.

- Backend test base: `https://api.talkmart.az/test-api/api`.
- Səsli video ID: `6af1e68f87dd1d2bb07b2f23`.
- İctimai metadata: [GET video/public](https://api.talkmart.az/test-api/api/videos/6af1e68f87dd1d2bb07b2f23/public).
- İctimai MP4: [Səsli test videosu](https://pub-4cc7f7a623fc4b02852a0e4f3c5502e4.r2.dev/talkmart/videos/6af1e68f87dd1d2bb07b2f23/39c13c74-96ef-4989-a6c7-10ad22a2320c.mp4).
- Digər nümunə, direct video ID: `6af20006f92d21d5b9d0d2fc`.

Tətbiqi yenidən açıb user lentində bu videoya keçin, başqa videoya keçib geri dönün, seek edin və tətbiqi arxa plana alıb geri açın. Nasaz anın player və şəbəkə qeydləri lazımdır. Brauzerdə tək videonun işləməsi lentdə eyni anda yaradılmış player-lərin də sağlam olduğunu sübut etmir.

## Faktiki server/fayl yoxlaması

Bu, bir vaxt aralığında aparılmış məhdud read-only yoxlamadır; fasiləsiz şəbəkə təminatı deyil.

- Lentdə qaytarılan altı videonun public object-i HEAD üçün 200, ilk 1 KiB Range üçün 206 verib. `Content-Type=video/mp4`, `Accept-Ranges=bytes`, ölçülər uyğundur. Bu sorğularda 403/404/429 müşahidə edilməyib.
- Direct videoda başlanğıc, orta və sondan Range-lər düzgün 206/Content-Range verib. Tam fayl 32,350,392 byte-dır; SHA-256 `73f697e2bb3c09aaca554ca1ef22027deee24a3f624d1ba3638fcb80006705fb`. Moov mdat-dan əvvəldir, 506 video packet-in hash-i orijinalla eynidir; tam strict FFmpeg decode keçib.
- Səsli video tam endirilib: 13,257,583 byte, SHA-256 `835165e34ba756878f02cf9555d843c605954d5efe88a036333eee95f64142fa`. H.264 High / level 5.2, 2160×3840, 25 fps, 8 saniyə; AAC-LC 48 kHz mono. Ümumi bitrate təxminən 13.26 Mbit/s-dir. Faststart var, video/audio packet hash-ləri yerli test fixture ilə eynidir, tam video və audio strict decode keçib.
- Yoxlama bu kompüterdə software decode istifadə edir; telefondakı hardware decoder və Flutter lifecycle üçün ekvivalent test deyil.

Lokal report-lar: `tmp/deployment/direct-playback-http.json`, `direct-playback-file.json`, `feed-playback-http.json`, `audio-playback-file.json`. Heç bir server prosesi, env və media obyekti dəyişdirilməyib.

## Flutter developerindən tələb olunan nəticə

1. Nasazlıq vaxtı video ID-si, APK/plugin versiyaları, cihaz modeli/OS, bağlantı növü və UI halını qeyd edin: initialize alınmır, sonsuz buffering, qara ekran, yoxsa seek-dən sonra dayanma.
2. İstifadə olunan player-in initialize/play xətasını və error description-ı tutun. `video_player` istifadə olunursa `initialize()` Future xətası və `controller.value.errorDescription` qeydə alınsın. Android-də həmin anın ExoPlayer/MediaCodec/decoder xəta səbəbi, iOS-da AVPlayer xəta səbəbi də lazımdır. Token və imzalı URL query-ləri paylaşılmış logda olmamalıdır.
3. Hər video/controller üçün create → initialize → play/pause → dispose hadisələrini fərqləndirin. Lentdə eyni anda neçə controller/decoder saxlandığını ölçün. Ekrandan çıxmış player-lərin buraxılması, widget-in stabil video ID-yə bağlanması, gec tamamlanan initialize nəticəsinin artıq dəyişmiş/dispose edilmiş controller-ə tətbiq olunmaması yoxlanılsın. Bunlar araşdırılan ehtimallardır; mənbə kodu və xəta qeydi olmadan konkret lifecycle səhvi təsdiqlənməyib.
4. APK-nın istifadə etdiyi URL/path-i cari metadata ilə müqayisə edin. Nasaz sorğunun həqiqi HTTP statusu və Range nəticəsi ayrı yazılsın. Cache və controller-in əvvəlki videonun URL/state-i ilə davam etmədiyini yoxlayın. Bu approved public video üçün JWT və ya 10 dəqiqəlik private-preview expiry səbəbi müəyyən edilməyib.
5. Minimal tək-player ekranında eyni səsli URL-ni açıb lent ilə müqayisə edin. Tək-player sağlam, lent nasazdırsa controller lifecycle/prefetch istiqamətini daraldın. Decoder xətası varsa həmin cihazın 4K/profile/level və paralel decoder imkanlarını yoxlayın. Sonra ölçülmüş səbəbə uyğun düzəliş edin.

Qəbul üçün yeni APK-də iki nümunə, lentdə videolararası keçid, geri qayıtma, seek və background/resume təkrar yoxlanmalı; nasazlıq səbəbi və dəyişiklik qeydi verilməlidir. Sonra [direct upload/resume müqaviləsinin](FLUTTER_DIRECT_UPLOAD_AZ.md) mobil sınaqları davam edir. Backend fayllarının resolution/quality siyasəti bu diaqnostikada dəyişdirilməyib.

R2 `r2.dev` development çıxışının dəyişən rate limit-i var; production media üçün custom domain ayrıca planlanmalıdır. Cari yoxlamalarda limit cavabı görülmədiyi üçün bu məhdudiyyət nasazlığın təsdiqlənmiş səbəbi sayılmır. [Cloudflare public bucket sənədi](https://developers.cloudflare.com/r2/buckets/public-buckets/).

Player lifecycle üçün rəsmi əsas: [Flutter video nümunəsi](https://docs.flutter.dev/cookbook/plugins/play-video), [VideoPlayerController API](https://pub.dev/documentation/video_player/latest/video_player/VideoPlayerController-class.html). Paralel codec sayının cihaz imkanına aid olması: [Android media resource manager](https://source.android.com/docs/core/media/oem). Bu mənbələr konkret APK xəta qeydini əvəz etmir.
