# Audit və performans dəyişikliklərinin canlıya hazırlanması

10 noyabr 2026: istifadəçi iki PDF üzrə hazır backend dəyişikliklərinin canlı serverə keçirilməsini istəyib. Əlavə deploy təsdiqi tələb olunmur. Audit buraxılışı artıq production-dadır: `94cc79d5d57365fcd41aeecb576587e49dcc19b3`. Hazır optimizasiya kodu bunun descendant-ıdır. Bu sənəd hazırlığı qeyd edir; faktiki production keçidi hələ baş verməyib.

## Buraxılışın sərhədi

Private emal/media preview, təsdiqdə public copy və rədddə origin cleanup; AI/FFmpeg paralel hazırlama; orijinal resolution saxlanmaqla uyğun H.264 remux; adaptiv dörd kadr seçimi və ayrıca vaxtlar; Explore owner/count düzəlişləri; durable queue/recovery və direct R2 multipart init/resume/complete/cancel backend-i daxildir. Mövcud multipart upload və API status adları qalır. JWT/OTP/SMTP/DB/R2 açarları dəyişdirilmir.

Birinci PDF-in audit düzəlişləri əvvəlki production buraxılışına daxildir. Performans PDF-inin bütün ölçmə hədəfləri tamamlanmış sayılmır: init `<300 ms`, bütöv AI `<5 s`, real mobil/concurrent p95, Redis/CDN və zəif 4G ölçmələri qalır. APK-də aralıq oynatma və hər bağlanmada sessiyanın itməsi üzrə [oynatma](FLUTTER_PLAYBACK_DIAGNOSTICS_AZ.md) və [sessiya](FLUTTER_SESSION_RESTORE_AZ.md) diaqnostikaları açıqdır. Bunlar üçün Flutter mənbə kodu və nasaz anın client logu lazımdır; backend buraxılışının onları artıq düzəltdiyi iddia edilmir.

## İlkin yoxlama paketi

`talkmart-performance-live.bundle`, `talkmart-performance-live.json` və `talkmart-performance-preflight.mjs` `/root/`-a göndərilir. Helper manifest SHA-256-sına, manifest isə dəqiq commit/bundle/lockfile-a bağlıdır. Arqumentsiz/`--help` dəyişiklik etmir. `--prepare` yalnız Linux serverdə dəqiq packaged yoldan işləyir.

1. Mövcud production kodu/versiyası, dörd production/test PM2 prosesinin ad/script/cwd/PID/start vaxtı yoxlanır. Staging-də faktiki src tree və dependency lock buraxılışla eyni olmalıdır; docs/helper commit fərqi runtime fərqi kimi sayılmır. Eyni helper-in paralel icrası kernel flock ilə bloklanır.
2. `/var/www/backend-release-20261110` ayrıca, işləməyən candidate hazırlanır. Mövcud başqa commit, symlink, candidate `.env` və ya həmin qovluqdan işləyən PM2 prosesi varsa üstündən yazılmır. Live kod/env və proseslərə toxunulmur.
3. Candidate-də pinned dependency lock üzrə `npm ci`, source/unit/integration testləri işləyir. Child komandaların mühitinə live xidmət açarları/Mongo URI ötürülmür; dotenv yolu olmayan fayla yönəlir. Integration öz lokal test bazasını yaradır. Nəticələr private qovluqda saxlanır. `--check` yalnız son 24 saatın eyni commit/lock/Node test sübutu ilə install/test-i təkrarlamadan xarici xidmətləri yenidən yoxlaya bilər.
4. Production `.env` yalnız oxunur; mövcud database `test`, replica set, v2 schema, counts və aktiv işlər nəzərdən keçirilir. MongoDB application məlumatı/indeksi yaradılmır. Əvvəl/sonra kolleksiya və indeks fingerprint-i müqayisə olunur. Saylar əvvəlki 14/18-ə zorla bərabərləşdirilmir.
5. Production və staging health, nginx syntax, MongoDB backup alətləri və PM2 systemd vəziyyəti yoxlanır. SMTP yalnız `verify` edir, email göndərmir. Mövcud Redis aktivdirsə yalnız PING edilir.
6. Həqiqi `talkmart` / `talkmart-staging` R2 çıxışı yoxlanır: hər run üçün yalnız öz UUID-li dörd canary key-si. Private signed GET/Range/no-store, iki istiqamətli copy/public origin silinməsi, 8 MiB+marker multipart, signed-length/expiry/complete-dən sonra immutable source/hash yoxlanır. Naməlum Create nəticəsi də exact key üzrə ListMultipartUploads ilə abort olunur. Sonda yalnız öz obyektləri silinir. Existing media re-encode/delete olunmur.
7. Private lifecycle oxunarsa təhlükəli expiration rədd edilir; AccessDenied bütöv fayl testlərini dayandırmır, panel yoxlamasını gözləyir. Canlı **talkmart-staging** üçün public r2.dev/custom domain çıxışının bağlı olması və `talkmart/private/` üzərindən expiration olmaması ayrıca paneldə təsdiqlənməlidir. Test bucket üçün əvvəlki təsdiq production bucket təsdiqi kimi götürülmür.

Report `/root/talkmart-deployments/performance-preflight-20261110-*/preflight.json` altında 0700/0600 icazələrlədir. `passed=true` ilkin texniki yoxlamanın nəticəsidir; private dashboard yoxlamasını və actual cutover backup-ını əvəz etmir. Bu mərhələdə API/worker dayandırılmır, `.env` və application DB dəyişdirilmir, mövcud media silinmir. Paket hələ deploy deyil.

## Sonrakı faktiki keçid

İlkin çıxış və canlı bucket panel məlumatı alındıqdan sonra cari növbə/reservation/cleanup vəziyyətinə uyğun dəqiq cutover hazırlanır. Keçiddə təzə kod/env/DB/media backup-ı, production proseslərinin idarəli dayandırılması, yeni indekslər və birlikdə API/worker startı, heartbeat/health və public/private görünürlük smoke-u tələb olunur. Staging işlək saxlanmalıdır. Yeni worker və ya direct admission işləyəndən sonra köhnə kod/DB snapshot-ına kor rollback etmək olmaz; yeni session/private-media yazıları saxlanmalıdır. Əvvəlki snapshot-dan tam DB restore bu ilkin helper-in işi deyil.
