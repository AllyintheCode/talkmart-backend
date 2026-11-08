# Performans buraxılışının test serverinə keçirilməsi

9 noyabr 2026: istifadəçinin server nəticəsi ilə R2 private presigned GET, 600 saniyə expiry, `no-store`, Range, private→public→private copy və origin-dən silinmə yoxlanıb. `talkmart-test-staging` panelində public development URL disabled, custom domain yoxdur; yeganə lifecycle qaydası 7 günlük incomplete multipart abort-dur. Tamamlanmış private obyektlərə expiration tətbiq edilmir. Runtime token dəyişdirilməyib.

Yeni kod qovluğu `/var/www/backend-perf-test-20261108`, köhnə test qovluğu `/var/www/backend-test`-dir. `scripts/staging/rollout.js --deploy` yalnız `talkmart-api-test` və `talkmart-worker-test` proseslərini dəyişir. `talkmart-api` və `talkmart-worker` üçün cari production qovluğu və proses məlumatları yoxlanılır; keçidin sonunda onların PID/start vaxtı dəyişməməlidir.

## Keçidin daxilində görülən işlər

1. Staging DB/bucket/JWT ayrılığı, PM2 adları və tam script yolları, təmiz kod, boş emal/silinmə növbəsi və production health yoxlanır.
2. Köhnə test API və worker dayandırılır. Production işinə davam edir.
3. `/root/talkmart-backups/perf-staging-*` altında test kodu, git bundle, yalnız test `.env`-i və `talkmart_staging` MongoDB archive-i saxlanır. Şifrəli URI stdout/argv-yə yazılmır; müvəqqəti config faylı private yaradılır və sonda silinir. Fayl checksum-ları və gzip yoxlanır, `mongorestore --dryRun` yalnız `talkmart_staging.*` üçün işlədilir.
4. Videoların, original-ların və profil şəkillərinin R2 istinadları inventarlaşdırılır; yalnız URL-də qalmış legacy istinadlar da nəzərə alınır. Mövcud obyektlər private bucket-də `talkmart/private/rollout-backups/<id>/...` altına server-side copy edilir, ölçülər yoxlanır. Bu prefix worker-in orphan skanına daxil deyil. Əvvəldən olmayan obyektlər ayrıca qeyd olunur, mövcud kimi təqdim edilmir.
5. Yeni test worker başladılır və məhz onun PID-sinə aid yeni heartbeat gözlənilir. Sonra test API loopback 5001-də açılır. Daxili health, `/test-api/health`, production health və production PID-ləri yoxlanır, PM2 vəziyyəti saxlanır.

Yeni worker başlamazdan əvvəl problem yaranarsa köhnə test prosesləri avtomatik açılır. Yeni worker başladıqdan sonra xəta olarsa yeni test prosesləri saxlanır; media/DB artıq dəyişmiş ola biləcəyi üçün köhnə kod kor-koranə açılmır. Terminal backup yolunu göstərir. Bu halda nəticə yoxlanmadan deploy təkrar işlədilmir.

## Geri dönüş

Backup yolunu terminalın göstərdiyi dəqiq yol ilə əvəz edin. Standart geri dönüş əmri yalnız önizləmədir:

```bash
node scripts/staging/rollout.js --rollback-backup=/root/talkmart-backups/perf-staging-...
```

Önizləmə DB archive/checksum və private media nüsxələrini yoxlayır. Faktiki bərpa üçün ayrıca `--apply` tələb olunur. O, test proseslərini saxlayır, backup-dakı R2 obyektlərini əvvəlki test key-lərinə qaytarır, yalnız `talkmart_staging.*` kolleksiyalarını `mongorestore --drop` ilə bərpa edir və köhnə test proseslərini açır. Backup-dan sonra testdə yaradılmış DB dəyişiklikləri bu əməliyyatda geri alınır. Yeni yaranmış media faylları avtomatik silinmir; ayrıca istinadsız-fayl təmizləməsi ilə qiymətləndirilir. Production bazası və bucket-ləri bu əmrlərin hədəfi ola bilməz.

Köhnə test kodu, `.env` və bootstrap helper-ləri backup-dan sonra dəyişibsə bərpa dayanır. Backup prefix-i qəbul yoxlamaları tamamlananadək saxlanır. Backup fayllarında test açarları olduğuna görə onları chat-a və ya açıq repository-yə göndərmək olmaz.

## Yoxlama sərhədi

Process/backup scope, production restart, təhlükəli key/path və URL-only media üzrə 3 yeni test, əvvəlki 4 staging testi və source check keçib. Linux PM2 keçidi və faktiki `--apply` rollback hələ serverdə icra olunmayıb; bu sənəd onları artıq uğurlu saymır. Keçiddən sonra real upload/AI, provider/admin preview, köhnə-yeni playback və Flutter yoxlanmalıdır.

MongoDB parametrləri: [mongorestore rəsmi sənədi](https://www.mongodb.com/docs/database-tools/mongorestore/) — `--dryRun`, `--nsInclude`, `--archive`, `--gzip` və `--drop`.
