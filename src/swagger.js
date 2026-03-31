export default {
  "openapi": "3.0.0",
  "info": {
    "title": "TalkMart API Sənədləri",
    "description": "Flutter tərtibatçıları üçün Backend API endpointləri. Autentifikasiya və Video xidmətlərini ehtiva edir.",
    "version": "1.0.0"
  },
  "servers": [
    {
      "url": "http://localhost:5000/api",
      "description": "Lokal inkişaf serveri"
    }
  ],
  "components": {
    "securitySchemes": {
      "bearerAuth": {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "JWT"
      }
    }
  },
  "security": [
    {
      "bearerAuth": []
    }
  ],
  "paths": {
    "/auth/register/user": {
      "post": {
        "summary": "Yeni istifadəçi qeydiyyatı",
        "tags": ["Authentication"],
        "security": [],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["fullName", "phone", "email", "password"],
                "properties": {
                  "fullName": { "type": "string", "example": "Əli Əliyev" },
                  "phone": { "type": "string", "example": "+994551234567" },
                  "email": { "type": "string", "format": "email", "example": "ali@example.com" },
                  "password": { "type": "string", "format": "password", "example": "sirr123" }
                }
              }
            }
          }
        },
        "responses": {
          "201": { "description": "Qeydiyyat tamamlandı, e-poçta OTP göndərildi." },
          "400": { "description": "Validasiya xətası" },
          "409": { "description": "E-poçt və ya telefon artıq qeydiyyatdan keçib" }
        }
      }
    },
    "/auth/register/provider": {
      "post": {
        "summary": "Yeni xidmət təminatçısı (provider) qeydiyyatı",
        "tags": ["Authentication"],
        "security": [],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["fullName", "companyName", "phone", "email", "password", "primaryServices", "location", "about"],
                "properties": {
                  "fullName": { "type": "string", "example": "Cəmilə Məmmədova" },
                  "companyName": { "type": "string", "example": "Cəmilə Təmizlik" },
                  "phone": { "type": "string", "example": "+994501234567" },
                  "email": { "type": "string", "format": "email", "example": "cemile@example.com" },
                  "password": { "type": "string", "format": "password", "example": "sirr123" },
                  "primaryServices": {
                    "type": "array",
                    "items": { "type": "string" },
                    "example": ["Təmizlik", "Santexnika"]
                  },
                  "location": { "type": "string", "example": "Bakı, Azərbaycan" },
                  "about": { "type": "string", "example": "Şəhərdə ən yaxşı təmizlik xidmətlərini təklif edirik." }
                }
              }
            }
          }
        },
        "responses": {
          "201": { "description": "Qeydiyyat tamamlandı, e-poçta OTP göndərildi." },
          "400": { "description": "Validasiya xətası" },
          "409": { "description": "E-poçt və ya telefon artıq qeydiyyatdan keçib" }
        }
      }
    },
    "/auth/register/verify-otp": {
      "post": {
        "summary": "Qeydiyyat üçün göndərilmiş OTP-ni təsdiqlə",
        "tags": ["Authentication"],
        "security": [],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["email", "code"],
                "properties": {
                  "email": { "type": "string", "format": "email", "example": "ali@example.com" },
                  "code": { "type": "string", "example": "123456" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "description": "E-poçt uğurla təsdiqləndi və İstifadəçi məlumatları & JWT token qaytarılır." },
          "400": { "description": "Yanlış OTP və ya vaxtı keçib" },
          "429": { "description": "Çox sayda uyğun olmayan cəhd" }
        }
      }
    },
    "/auth/login": {
      "post": {
        "summary": "İstifadəçi və ya providerin E-poçt & Şifrə ilə daxil olması",
        "tags": ["Authentication"],
        "security": [],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["email", "password"],
                "properties": {
                  "email": { "type": "string", "format": "email", "example": "ali@example.com" },
                  "password": { "type": "string", "format": "password", "example": "sirr123" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "description": "Uğurlu giriş, JWT token və İstifadəçi məlumatlarını qaytarır." },
          "401": { "description": "Yanlış məlumatlar (şifrə və ya e-poçt səhvdir)" }
        }
      }
    },
    "/auth/forgot-password": {
      "post": {
        "summary": "Şifrənin sıfırlanması üçün OTP tələb et",
        "tags": ["Authentication"],
        "security": [],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["email"],
                "properties": {
                  "email": { "type": "string", "format": "email", "example": "ali@example.com" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "description": "OTP göndərildi (Təhlükəsizlik məqsədilə, format düzgündürsə həmişə uğur qaytarır)." }
        }
      }
    },
    "/auth/forgot-password/verify-otp": {
      "post": {
        "summary": "Şifrə sıfırlamaq üçün göndərilən OTP-ni təsdiqlə",
        "tags": ["Authentication"],
        "security": [],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["email", "code"],
                "properties": {
                  "email": { "type": "string", "format": "email", "example": "ali@example.com" },
                  "code": { "type": "string", "example": "123456" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "description": "Kod uğurla təsdiqləndi, müvəqqəti sıfırlama tokeni (reset token) qaytarır." },
          "400": { "description": "Yanlış OTP və ya vaxtı keçib" }
        }
      }
    },
    "/auth/forgot-password/reset-password": {
      "post": {
        "summary": "Müvəqqəti token vasitəsilə şifrəni yenilə",
        "tags": ["Authentication"],
        "security": [],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["resetToken", "newPassword"],
                "properties": {
                  "resetToken": { "type": "string", "example": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." },
                  "newPassword": { "type": "string", "format": "password", "example": "yeniSirr123" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "description": "Şifrə uğurla dəyişdirildi." },
          "400": { "description": "Yanlış və ya vaxtı keçmiş sıfırlama tokeni." }
        }
      }
    },
    "/users/user": {
      "put": {
        "summary": "Yalnız adi istifadəçi (User) məlumatlarını yenilə",
        "tags": ["User"],
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "fullName": { "type": "string", "example": "Yeni Ad Soyad" },
                  "email": { "type": "string", "format": "email", "example": "yeniemail@example.com" },
                  "password": { "type": "string", "format": "password", "example": "yenisirr123" },
                  "confirmPassword": { "type": "string", "format": "password", "example": "yenisirr123" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "description": "İstifadəçi profili uğurla yeniləndi." },
          "400": { "description": "Şifrələr eyni deyil və ya validasiya xətası var" },
          "401": { "description": "İcazəsiz (Token əskik və ya keçərsizdir)" },
          "403": { "description": "Provider və ya Admin bu api-dən istifadə edə bilməz" },
          "404": { "description": "İstifadəçi tapılmadı" },
          "409": { "description": "E-poçt ünvanı artıq istifadədədir" }
        }
      }
    },
    "/users/provider": {
      "put": {
        "summary": "Yalnız xidmət təminatçısı (Provider) məlumatlarını yenilə",
        "tags": ["User"],
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "fullName": { "type": "string", "example": "Yeni Şirkət Sahibi" },
                  "email": { "type": "string", "format": "email", "example": "sirket@example.com" },
                  "password": { "type": "string", "format": "password", "example": "yenisirr123" },
                  "confirmPassword": { "type": "string", "format": "password", "example": "yenisirr123" },
                  "bio": { "type": "string", "example": "Xidmətlərimizi daha sərfəli və keyfiyyətli etdik. (Bioqrafiya)" },
                  "location": { "type": "string", "example": "Gəncə, Azərbaycan" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "description": "Provider profili uğurla yeniləndi." },
          "400": { "description": "Şifrələr eyni deyil və ya validasiya xətası var" },
          "401": { "description": "İcazəsiz (Token əskik və ya keçərsizdir)" },
          "403": { "description": "İstifadəçi provayder deyil (icazə yoxdur)" },
          "404": { "description": "İstifadəçi tapılmadı" },
          "409": { "description": "E-poçt ünvanı artıq istifadədədir" }
        }
      }
    },
    "/videos/upload": {
      "post": {
        "summary": "Yeni xidmət videosu yüklə (Yalnız Providerlər üçün)",
        "tags": ["Video"],
        "requestBody": {
          "required": true,
          "content": {
            "multipart/form-data": {
              "schema": {
                "type": "object",
                "required": ["title", "description", "price", "video"],
                "properties": {
                  "title": { "type": "string", "description": "Video xidmətinin başlığı", "example": "Peşəkar Santexnika Xidməti" },
                  "description": { "type": "string", "description": "Xidmət haqqında ətraflı məlumat", "example": "Boru və su xətlərini tez bir zamanda təmir edirik." },
                  "price": { "type": "number", "format": "float", "description": "Xidmət videosu üzrə təyin edilmiş qiymət", "example": 50.5 },
                  "video": { "type": "string", "format": "binary", "description": "Əsas video faylı (.mp4, .mov, vs.) Maksimum 500MB." }
                }
              }
            }
          }
        },
        "responses": {
          "201": { "description": "Video uğurla Cloudinary-yə yükləndi və bazada yadda saxlanıldı." },
          "400": { "description": "Validasiya xətası, əskik məlumatlar və ya keçərsiz fayl." },
          "401": { "description": "İcazəsiz (Token əskikdir və ya keçərsizdir)" },
          "403": { "description": "Qadağan edilib (İstifadəçi Provider deyil)" }
        }
      }
    },
    "/videos/my-videos": {
      "get": {
        "summary": "Providerin öz yüklədiyi bütün videoları gətir",
        "tags": ["Video"],
        "responses": {
          "200": { "description": "Providerin videolarından ibarət massiv (array) qaytarır." },
          "401": { "description": "İcazəsiz" },
          "403": { "description": "Qadağan edilib (Provider deyil)" }
        }
      }
    },
    "/videos/{id}": {
      "delete": {
        "summary": "İD-yə əsasən videonu sil",
        "tags": ["Video"],
        "parameters": [
          {
            "in": "path",
            "name": "id",
            "required": true,
            "schema": { "type": "string" },
            "description": "Videonun MongoDB ObjectId-si",
            "example": "64efc9abc1234567890def12"
          }
        ],
        "responses": {
          "200": { "description": "Video uğurla həm MDB (baza), həm də Cloudinary-dən silindi." },
          "401": { "description": "İcazəsiz" },
          "403": { "description": "Qadağan edilib (Provider deyil)" },
          "404": { "description": "Video tapılmadı və ya sizə aid deyil." }
        }
      }
    },
    "/videos/{id}/like": {
      "post": {
        "summary": "Videonu bəyən / bəyənməkdən voz keç (Toggle Like)",
        "description": "Videonu bəyənmək və ya bəyənməkdən çıxarmaq üçün istifadə olunur. Hər istifadəçi videonu yalnız 1 dəfə bəyənə bilər. Təkrar çağırıldıqda bəyənmə geri alınır (toggle). Həm istifadəçilər, həm də providerlər üçün keçərlidir. Anti-fake: İstifadəçilər öz videolarını bəyənə bilməz. Rate limit: dəqiqədə 30 istək.\n",
        "tags": ["Engagement"],
        "parameters": [
          {
            "in": "path",
            "name": "id",
            "required": true,
            "schema": { "type": "string" },
            "description": "Videonun MongoDB ObjectId-si",
            "example": "64efc9abc1234567890def12"
          }
        ],
        "responses": {
          "200": {
            "description": "Bəyənmə statusunu və yenilənmiş likeCount (bəyənmə sayını) qaytarır.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "example": true },
                    "liked": { "type": "boolean", "description": "Videonun hazırda bəyənilib-bəyənilməməsi.", "example": true },
                    "likeCount": { "type": "integer", "example": 42 },
                    "message": { "type": "string", "example": "Like edildi." }
                  }
                }
              }
            }
          },
          "400": { "description": "Keçərsiz video ID formatı" },
          "401": { "description": "İcazəsiz" },
          "403": { "description": "Öz videonuzu bəyənə bilməzsiniz" },
          "404": { "description": "Video tapılmadı" },
          "429": { "description": "Çox sayda istək (rate limit aşıldı)" }
        }
      }
    },
    "/videos/{id}/save": {
      "post": {
        "summary": "Videonu yadda saxla / yaddaşdan sil (Toggle Save/Bookmark)",
        "description": "Videonu yadda saxlamaq və ya silmək. Hər istifadəçi yalnız 1 dəfə yadda saxlaya bilər. Təkrar çağırıldıqda yaddaşdan silinir (toggle). Həm istifadəçilər, həm də providerlər üçün. Anti-fake: İstifadəçilər öz videolarını yadda saxlaya bilməz. Rate limit: dəqiqədə 30 istək.\n",
        "tags": ["Engagement"],
        "parameters": [
          {
            "in": "path",
            "name": "id",
            "required": true,
            "schema": { "type": "string" },
            "description": "Videonun MongoDB ObjectId-si",
            "example": "64efc9abc1234567890def12"
          }
        ],
        "responses": {
          "200": {
            "description": "Yadda saxlama statusunu və yenilənmiş saveCount (yaddaşlanma sayını) qaytarır.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "example": true },
                    "saved": { "type": "boolean", "description": "Videonun hazırda yadda saxlanılıb-saxlanılmaması.", "example": true },
                    "saveCount": { "type": "integer", "example": 15 },
                    "message": { "type": "string", "example": "Video kayd edildi." }
                  }
                }
              }
            }
          },
          "400": { "description": "Keçərsiz video ID formatı" },
          "401": { "description": "İcazəsiz" },
          "403": { "description": "Öz videonuzu yadda saxlaya bilməzsiniz" },
          "404": { "description": "Video tapılmadı" },
          "429": { "description": "Çox sayda istək (rate limit aşıldı)" }
        }
      }
    },
    "/videos/{id}/view": {
      "post": {
        "summary": "Video üçün baxış qeyd etməklə (24 saatlıq limitli)",
        "description": "Baxış (view) sayını qeyd edir. Anti-fake önləmləri: 1) Eyni istifadəçi hər 24 saatda yalnız 1 baxış qeyd edə bilər. 2) Provider öz videosunun baxış sayını artıra bilməz. 3) Rate limit: dəqiqədə 30 istək. 4) Atomik sayğaclar qorunması. Kimsə videoya baxmağa başlayanda bu endpoint-i çağırın.\n",
        "tags": ["Engagement"],
        "parameters": [
          {
            "in": "path",
            "name": "id",
            "required": true,
            "schema": { "type": "string" },
            "description": "Videonun MongoDB ObjectId-si",
            "example": "64efc9abc1234567890def12"
          }
        ],
        "responses": {
          "200": {
            "description": "Baxışın nəzərə alınıb-alınmadığını və cari baxış (viewCount) sayını qaytarır.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "example": true },
                    "counted": { "type": "boolean", "description": "Baxışın məqbul sayılıb-sayılmadığını göstərir.", "example": true },
                    "viewCount": { "type": "integer", "example": 128 },
                    "message": { "type": "string", "example": "Görüntülənmə qeyd edildi." }
                  }
                }
              }
            }
          },
          "400": { "description": "Keçərsiz video ID formatı" },
          "401": { "description": "İcazəsiz" },
          "404": { "description": "Video tapılmadı" },
          "429": { "description": "Çox sayda istək (rate limit aşıldı)" }
        }
      }
    },
    "/videos/{id}/engagement": {
      "get": {
        "summary": "Video üçün statistika (baxış sayı + user statusu) gətir",
        "description": "Videonun bəyənmə/baxış/yaddaşlanma saylarını və mövcud istifadəçinin onu bəyənib/yadda saxlayıb-saxlamadığını qaytarır. UI dizaynı hazırlamaq üçün faydalıdır.\n",
        "tags": ["Engagement"],
        "parameters": [
          {
            "in": "path",
            "name": "id",
            "required": true,
            "schema": { "type": "string" },
            "description": "Videonun MongoDB ObjectId-si",
            "example": "64efc9abc1234567890def12"
          }
        ],
        "responses": {
          "200": {
            "description": "Bütün etkileşim/statistika məlumatlarını qaytarır.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "example": true },
                    "likeCount": { "type": "integer", "example": 42 },
                    "viewCount": { "type": "integer", "example": 128 },
                    "saveCount": { "type": "integer", "example": 15 },
                    "isLiked": { "type": "boolean", "description": "Cari istifadəçi bu videonu bəyənibmi.", "example": true },
                    "isSaved": { "type": "boolean", "description": "Cari istifadəçi bu videonu yadda saxlayıbmı.", "example": false }
                  }
                }
              }
            }
          },
          "400": { "description": "Keçərsiz video ID formatı" },
          "401": { "description": "İcazəsiz" },
          "404": { "description": "Video tapılmadı" }
        }
      }
    },
    "/onboarding": {
      "get": {
        "summary": "Bütün onboarding ekranlarını sıralı olaraq gətir",
        "tags": ["Public"],
        "security": [],
        "responses": {
          "200": { "description": "Ekranların siyahısı" }
        }
      }
    },
    "/categories": {
      "get": {
        "summary": "Yalnız aktiv xidmət kateqoriyalarını gətir",
        "tags": ["Public"],
        "security": [],
        "responses": {
          "200": { "description": "Katoqoriyaların siyahısı" }
        }
      }
    },
    "/admin/categories": {
      "get": {
        "summary": "Bütün kateqoriyaları gətir (Həm aktiv, həm deaktiv)",
        "tags": ["Admin/Categories"],
        "security": [{ "bearerAuth": [] }],
        "responses": {
          "200": { "description": "Bütün kateqoriyalar" }
        }
      },
      "post": {
        "summary": "Yeni kateqoriya yarat",
        "tags": ["Admin/Categories"],
        "security": [{ "bearerAuth": [] }],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["name"],
                "properties": {
                  "name": { "type": "string", "example": "Təmizlik" },
                  "status": { "type": "string", "enum": ["active", "inactive"], "example": "active" }
                }
              }
            }
          }
        },
        "responses": {
          "201": { "description": "Kateqoriya yaradıldı" }
        }
      }
    },
    "/admin/categories/{id}": {
      "put": {
        "summary": "Mövcud kateqoriyanı yenilə",
        "tags": ["Admin/Categories"],
        "security": [{ "bearerAuth": [] }],
        "parameters": [
          { "in": "path", "name": "id", "required": true, "schema": { "type": "string" } }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "name": { "type": "string" },
                  "status": { "type": "string", "enum": ["active", "inactive"] }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "description": "Kateqoriya yeniləndi" }
        }
      },
      "delete": {
        "summary": "Mövcud kateqoriyanı sil",
        "tags": ["Admin/Categories"],
        "security": [{ "bearerAuth": [] }],
        "parameters": [
          { "in": "path", "name": "id", "required": true, "schema": { "type": "string" } }
        ],
        "responses": {
          "200": { "description": "Kateqoriya silindi" }
        }
      }
    },
    "/admin/onboarding": {
      "post": {
        "summary": "Yeni Onboarding ekranı yarat (Yalnız Admin)",
        "tags": ["Admin/Onboarding"],
        "security": [
          { "bearerAuth": [] }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "multipart/form-data": {
              "schema": {
                "type": "object",
                "required": ["title", "description", "image"],
                "properties": {
                  "title": { "type": "string", "example": "Xoş Gəldiniz!" },
                  "description": { "type": "string", "example": "TalkMart-da ən yaxşı xidmətləri tapın." },
                  "order": { "type": "number", "example": 1 },
                  "image": { "type": "string", "format": "binary", "description": "Ekran şəkli (Maksimum 10MB)" }
                }
              }
            }
          }
        },
        "responses": {
          "201": { "description": "Onboarding ekranı yaradıldı." },
          "400": { "description": "Validasiya xətası" },
          "401": { "description": "İcazəsiz" },
          "403": { "description": "Admin deyil" }
        }
      }
    },
    "/admin/onboarding/{id}": {
      "put": {
        "summary": "Mövcud Onboarding ekranını yenilə (Yalnız Admin)",
        "tags": ["Admin/Onboarding"],
        "security": [
          { "bearerAuth": [] }
        ],
        "parameters": [
          {
            "in": "path",
            "name": "id",
            "required": true,
            "schema": { "type": "string" },
            "description": "Onboarding ObjectId-si"
          }
        ],
        "requestBody": {
          "content": {
            "multipart/form-data": {
              "schema": {
                "type": "object",
                "properties": {
                  "title": { "type": "string" },
                  "description": { "type": "string" },
                  "order": { "type": "number" },
                  "image": { "type": "string", "format": "binary" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "description": "Ekran yeniləndi." },
          "401": { "description": "İcazəsiz" },
          "403": { "description": "Admin deyil" },
          "404": { "description": "Ekran tapılmadı" }
        }
      },
      "delete": {
        "summary": "Mövcud Onboarding ekranını sil (Yalnız Admin)",
        "tags": ["Admin/Onboarding"],
        "security": [
          { "bearerAuth": [] }
        ],
        "parameters": [
          {
            "in": "path",
            "name": "id",
            "required": true,
            "schema": { "type": "string" },
            "description": "Onboarding ObjectId-si"
          }
        ],
        "responses": {
          "200": { "description": "Ekran silindi." },
          "401": { "description": "İcazəsiz" },
          "403": { "description": "Admin deyil" },
          "404": { "description": "Ekran tapılmadı" }
        }
      }
    }
  }
};