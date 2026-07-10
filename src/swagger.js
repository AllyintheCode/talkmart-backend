export default {
  "openapi": "3.0.0",
  "info": {
    "title": "TalkMart API Sənədləri",
    "description": "Flutter tərtibatçıları üçün Backend API endpointləri. Autentifikasiya və Video xidmətlərini ehtiva edir.",
    "version": "1.0.0"
  },
  "servers": [
    {
      "url": "https://talkmart-backend.vercel.app/api",
      "description": "Production (Vercel)"
    },
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
                "required": ["firstName", "lastName", "companyName", "email", "phone", "categoryId", "address", "password", "confirmPassword"],
                "properties": {
                  "firstName":       { "type": "string", "example": "Cəmilə" },
                  "lastName":        { "type": "string", "example": "Məmmədova" },
                  "companyName":     { "type": "string", "example": "Cəmilə Təmizlik" },
                  "email":           { "type": "string", "format": "email", "example": "cemile@example.com" },
                  "phone":           { "type": "string", "example": "+994501234567" },
                  "categoryId":      { "type": "string", "example": "64efc9abc1234567890abc01", "description": "Seçilmiş xidmət kateqoriyasının ObjectId-si" },
                  "address":         { "type": "string", "example": "Neftчilər pr, 12, Bakı" },
                  "password":        { "type": "string", "format": "password", "example": "sirr123" },
                  "confirmPassword": { "type": "string", "format": "password", "example": "sirr123" }
                }
              }
            }
          }
        },
        "responses": {
          "201": { "description": "Qeydiyyat tamamlandı, e-poçta OTP göndərildi." },
          "400": { "description": "Validasiya xətası (məs. şifrələr uyğun gəlmir)" },
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
    "/auth/register/resend-otp": {
      "post": {
        "summary": "Müddəti bitmiş və ya təsdiqlənməmiş hesablar üçün yeni OTP tələb et",
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
          "200": { "description": "Yeni OTP göndərildi." },
          "400": { "description": "Validasiya xətası və ya hesab artıq təsdiqlənib" },
          "404": { "description": "İstifadəçi tapılmadı" },
          "429": { "description": "Lütfən 1 dəqiqə gözləyin (Çox tez-tez cəhd)" },
          "500": { "description": "Server xətası" }
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
    "/users/change-password": {
      "put": {
        "summary": "İstifadəçinin (User və Provider) şifrəsini yenilə",
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
                "required": ["currentPassword", "newPassword", "confirmPassword"],
                "properties": {
                  "currentPassword": { "type": "string", "format": "password", "example": "kohneSirr123" },
                  "newPassword": { "type": "string", "format": "password", "example": "yeniSirr123" },
                  "confirmPassword": { "type": "string", "format": "password", "example": "yeniSirr123" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "description": "Şifrə uğurla yeniləndi." },
          "400": { "description": "Şifrələr uyğun gəlmir və ya cari şifrə səhvdir." },
          "401": { "description": "İcazəsiz (Token əskik və ya keçərsizdir)" },
          "404": { "description": "İstifadəçi tapılmadı." }
        }
      }
    },
    "/users/user": {
      "get": {
        "summary": "Adi istifadəçi profilini gətir",
        "tags": ["User"],
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "responses": {
          "200": {
            "description": "İstifadəçi profili uğurla gətirildi.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "example": true },
                    "user": {
                      "type": "object",
                      "properties": {
                        "_id": { "type": "string", "example": "64efc9abc1234567890def12" },
                        "role": { "type": "string", "example": "user" },
                        "fullName": { "type": "string", "example": "Əli Əliyev" },
                        "email": { "type": "string", "example": "ali@example.com" },
                        "phone": { "type": "string", "example": "+994551234567" },
                        "emailVerified": { "type": "boolean", "example": true },
                        "profileImage": { "type": "string", "example": "https://your-r2-domain.r2.dev/talkmart/images/profile.jpg", "nullable": true },
                        "createdAt": { "type": "string", "format": "date-time" },
                        "updatedAt": { "type": "string", "format": "date-time" }
                      }
                    }
                  }
                }
              }
            }
          },
          "401": { "description": "İcazəsiz (Token əskik və ya keçərsizdir)" },
          "403": { "description": "Bu API yalnız adi istifadəçilər üçündür." },
          "404": { "description": "İstifadəçi tapılmadı" }
        }
      },
      "put": {
        "summary": "Yalnız adi istifadəçi (User) məlumatlarını yenilə",
        "description": "Əgər email dəyişdirilərsə, təsdiq üçün yeni email ünvanına OTP kodu göndəriləcək.",
        "tags": ["User"],
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "multipart/form-data": {
              "schema": {
                "type": "object",
                "properties": {
                  "fullName": { "type": "string", "example": "Yeni Ad Soyad" },
                  "email": { "type": "string", "format": "email", "example": "yeniemail@example.com" },
                  "bio": { "type": "string", "example": "Mənim haqqımda yeni məlumat" },
                  "profileImage": { "type": "string", "format": "binary", "description": "Profil şəkli (fayl)" }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "İstifadəçi profili uğurla yeniləndi.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "example": true },
                    "message": { "type": "string", "example": "Profiliniz yeniləndi. Email dəyişikliyi üçün yeni emailinizə təsdiq kodu göndərildi." },
                    "requiresEmailVerification": { "type": "boolean", "example": true }
                  }
                }
              }
            }
          },
          "400": { "description": "Şifrələr eyni deyil və ya validasiya xətası var" },
          "401": { "description": "İcazəsiz (Token əskik və ya keçərsizdir)" },
          "403": { "description": "Provider və ya Admin bu api-dən istifadə edə bilməz" },
          "404": { "description": "İstifadəçi tapılmadı" },
          "409": { "description": "E-poçt ünvanı artıq istifadədədir" }
        }
      }
    },
    "/users/profile": {
      "get": {
        "summary": "Adi istifadəçi profilini gətir",
        "tags": ["User"],
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "responses": {
          "200": {
            "description": "İstifadəçi profili uğurla gətirildi.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "example": true },
                    "user": {
                      "type": "object",
                      "properties": {
                        "_id": { "type": "string", "example": "64efc9abc1234567890def12" },
                        "role": { "type": "string", "example": "user" },
                        "fullName": { "type": "string", "example": "Əli Əliyev" },
                        "email": { "type": "string", "example": "ali@example.com" },
                        "phone": { "type": "string", "example": "+994551234567" },
                        "emailVerified": { "type": "boolean", "example": true },
                        "profileImage": { "type": "string", "example": "https://your-r2-domain.r2.dev/talkmart/images/profile.jpg", "nullable": true },
                        "bio": { "type": "string", "example": "Mənim haqqımda qısa məlumat", "nullable": true },
                        "createdAt": { "type": "string", "format": "date-time" },
                        "updatedAt": { "type": "string", "format": "date-time" }
                      }
                    }
                  }
                }
              }
            }
          },
          "401": { "description": "İcazəsiz (Token əskik və ya keçərsizdir)" },
          "403": { "description": "Bu API yalnız adi istifadəçilər üçündür." },
          "404": { "description": "İstifadəçi tapılmadı" }
        }
      },
      "post": {
        "summary": "Adi istifadəçi (User) profilini, bio və şəklini yenilə",
        "description": "Əgər email dəyişdirilərsə, təsdiq üçün yeni email ünvanına OTP kodu göndəriləcək.",
        "tags": ["User"],
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "multipart/form-data": {
              "schema": {
                "type": "object",
                "properties": {
                  "fullName": { "type": "string", "example": "Yeni Ad Soyad" },
                  "email": { "type": "string", "format": "email", "example": "yeniemail@example.com" },
                  "bio": { "type": "string", "example": "Mənim haqqımda yeni məlumat" },
                  "profileImage": { "type": "string", "format": "binary", "description": "Profil şəkli (fayl)" }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "İstifadəçi profili uğurla yeniləndi.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "example": true },
                    "message": { "type": "string", "example": "Profiliniz yeniləndi. Email dəyişikliyi üçün yeni emailinizə təsdiq kodu göndərildi." },
                    "requiresEmailVerification": { "type": "boolean", "example": true }
                  }
                }
              }
            }
          },
          "400": { "description": "Validasiya xətası var" },
          "401": { "description": "İcazəsiz (Token əskik və ya keçərsizdir)" },
          "403": { "description": "Provider və ya Admin bu api-dən istifadə edə bilməz" },
          "404": { "description": "İstifadəçi tapılmadı" },
          "409": { "description": "E-poçt ünvanı artıq istifadədədir" }
        }
      }
    },
    "/users/provider": {
      "get": {
        "summary": "Provider profilini gətir",
        "tags": ["User"],
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "responses": {
          "200": {
            "description": "Provider profili uğurla gətirildi.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "example": true },
                    "provider": {
                      "type": "object",
                      "properties": {
                        "_id": { "type": "string", "example": "64efc9abc1234567890def12" },
                        "role": { "type": "string", "example": "provider" },
                        "fullName": { "type": "string", "example": "Cəmilə Məmmədova" },
                        "email": { "type": "string", "example": "cemile@example.com" },
                        "phone": { "type": "string", "example": "+994501234567" },
                        "emailVerified": { "type": "boolean", "example": true },
                        "profileImage": { "type": "string", "example": "https://your-r2-domain.r2.dev/talkmart/images/profile.jpg", "nullable": true },
                        "providerProfile": {
                          "type": "object",
                          "properties": {
                            "companyName": { "type": "string", "example": "Cəmilə Təmizlik" },
                            "categoryId": { "type": "string", "example": "64efc9abc1234567890abc01" },
                            "address": { "type": "string", "example": "Neftçilər pr, 12, Bakı" },
                            "verified": { "type": "boolean", "example": true }
                          }
                        },
                        "createdAt": { "type": "string", "format": "date-time" },
                        "updatedAt": { "type": "string", "format": "date-time" }
                      }
                    }
                  }
                }
              }
            }
          },
          "401": { "description": "İcazəsiz (Token əskik və ya keçərsizdir)" },
          "403": { "description": "Bu API yalnız providerlər üçündür." },
          "404": { "description": "Provider tapılmadı" }
        }
      },
      "put": {
        "summary": "Yalnız xidmət təminatçısı (Provider) məlumatlarını yenilə",
        "description": "Əgər email dəyişdirilərsə, təsdiq üçün yeni email ünvanına OTP kodu göndəriləcək.",
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
                  "bio": { "type": "string", "example": "Xidmətlərimizi daha sərfəli və keyfiyyətli etdik. (Bioqrafiya)" },
                  "location": { "type": "string", "example": "Gəncə, Azərbaycan" },
                  "companyName": { "type": "string", "example": "Cəmilə Təmizlik", "description": "Şirkət adı (providerProfile.companyName)" },
                  "profileImage": { "type": "string", "example": "https://your-r2-domain.r2.dev/talkmart/images/profile.jpg", "nullable": true, "description": "Profil şəkli URL-i" }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Provider profili uğurla yeniləndi.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "example": true },
                    "message": { "type": "string", "example": "Profiliniz yeniləndi. Email dəyişikliyi üçün yeni emailinizə təsdiq kodu göndərildi." },
                    "requiresEmailVerification": { "type": "boolean", "example": true }
                  }
                }
              }
            }
          },
          "400": { "description": "Şifrələr eyni deyil və ya validasiya xətası var" },
          "401": { "description": "İcazəsiz (Token əskik və ya keçərsizdir)" },
          "403": { "description": "İstifadəçi provayder deyil (icazə yoxdur)" },
          "404": { "description": "İstifadəçi tapılmadı" },
          "409": { "description": "E-poçt ünvanı artıq istifadədədir" }
        }
      }
    },
    "/users/profile-image": {
      "delete": {
        "summary": "Profil şəklini sil",
        "description": "🔐 **LOGIN TƏLƏB OLUNUR** — Həm User, həm Provider istifadə edə bilər. R2-dən silinir və DB-dən təmizlənir.",
        "tags": ["User"],
        "security": [{ "bearerAuth": [] }],
        "responses": {
          "200": {
            "description": "Profil şəkli silindi",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "example": true },
                    "message": { "type": "string", "example": "Profil şəkli silindi." }
                  }
                }
              }
            }
          },
          "400": { "description": "Profil şəkli mövcud deyil" },
          "401": { "description": "Login tələb olunur" }
        }
      }
    },
    "/users/verify-email-change": {
      "post": {
        "summary": "Email dəyişmə təsdiq OTP",
        "description": "🔐 **LOGIN TƏLƏB OLUNUR** — Profil yenilənməsində göndərilən OTP kodunu təsdiqləyib yeni emailə keçid edir.",
        "tags": ["User"],
        "security": [{ "bearerAuth": [] }],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "code": { "type": "string", "example": "123456" }
                }
              }
            }
          }
        },
        "responses": {
          "200": { "description": "Email ünvanı uğurla yeniləndi" },
          "400": { "description": "OTP kodu daxil edin və ya OTP yanlışdır/vaxtı bitib" },
          "401": { "description": "Login tələb olunur" },
          "404": { "description": "İstifadəçi tapılmadı" },
          "409": { "description": "Bu email artıq başqa bir istifadəçiyə məxsusdur" },
          "429": { "description": "Çox cəhd edildi" }
        }
      }
    },
    "/videos/feed": {
      "get": {
        "summary": "Ana Səhifə (Reels) üçün sonsuz təsadüfi/trend videolar (TikTok tərzi)",
        "description": "🔓 **GUEST DOSTu** — Token olmadan da işləyir. Login olmamış istifadəçilər videoları sərbəst izləyə bilər.\n\n📦 **BİRLƏŞDİRİLMİŞ API** — Hər video ilə birlikdə provider telefon nömrəsi, likeCount, saveCount, viewCount, isLiked, isSaved hamısı bir response-da qaytarılır. Ayrıca `/engagement` və ya `/contact` çağırmağa ehtiyac yoxdur.",
        "tags": ["Video"],
        "security": [],
        "parameters": [
          { "in": "query", "name": "limit", "schema": { "type": "integer", "default": 10 }, "description": "Qaytarılacaq video sayı" }
        ],
        "responses": {
          "200": {
            "description": "Təsadüfi seçilmiş (yalnız aktiv) videolar axını — provider məlumatları və engagement statusu daxildir",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "example": true },
                    "count": { "type": "integer", "example": 10 },
                    "videos": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "_id": { "type": "string", "example": "64efc9abc1234567890def12" },
                          "title": { "type": "string", "example": "Peşəkar Santexnika Xidməti" },
                          "description": { "type": "string", "example": "Boru təmiri və su xətləri." },
                          "price": { "type": "number", "example": 50.5 },
                          "videoUrl": { "type": "string", "example": "https://your-r2-domain.r2.dev/talkmart/videos/video.mp4" },
                          "thumbnail": { "type": "string", "example": "https://your-r2-domain.r2.dev/talkmart/thumbnails/thumb.jpg" },
                          "categoryId": { "type": "string", "example": "64efc9abc1234567890abc01" },
                          "duration": { "type": "number", "example": 30 },
                          "likeCount": { "type": "integer", "example": 42 },
                          "viewCount": { "type": "integer", "example": 128 },
                          "saveCount": { "type": "integer", "example": 15 },
                          "createdAt": { "type": "string", "format": "date-time" },
                          "provider": {
                            "type": "object",
                            "properties": {
                              "_id": { "type": "string", "example": "64efc9abc1234567890def99", "description": "Providerin ID-si" },
                              "fullName": { "type": "string", "example": "Cəmilə Məmmədova" },
                              "companyName": { "type": "string", "example": "Cəmilə Təmizlik", "nullable": true },
                              "phone": { "type": "string", "example": "+994501234567", "description": "Providerin əlaqə nömrəsi" },
                              "address": { "type": "string", "example": "Neftçilər pr, 12, Bakı", "nullable": true, "description": "Providerin ünvanı" },
                              "profileImage": { "type": "string", "example": "https://your-r2-domain.r2.dev/talkmart/images/profile.jpg", "nullable": true, "description": "Providerin profil şəkli" }
                            }
                          },
                          "isLiked": { "type": "boolean", "description": "Cari istifadəçi bu videonu bəyənibmi. Guest üçün həmişə false.", "example": true },
                          "isSaved": { "type": "boolean", "description": "Cari istifadəçi bu videonu yadda saxlayıbmı. Guest üçün həmişə false.", "example": false }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          "500": { "description": "Server xətası" }
        }
      }
    },
    "/videos/explore": {
      "get": {
        "summary": "Kəşf Et (Explore) səhifəsi üçün kateqoriyalı və axtarışlı list",
        "description": "🔓 **GUEST DOSTu** — Token olmadan da işləyir. Login olmamış istifadəçilər sərbəst axtarış edə bilər.\n\n📦 **BİRLƏŞDİRİLMİŞ API** — Hər video ilə birlikdə provider telefon nömrəsi, likeCount, saveCount, viewCount, isLiked, isSaved hamısı bir response-da qaytarılır. Ayrıca `/engagement` və ya `/contact` çağırmağa ehtiyac yoxdur.",
        "tags": ["Video"],
        "security": [],
        "parameters": [
          { "in": "query", "name": "page", "schema": { "type": "integer", "default": 1 }, "description": "Səhifə nömrəsi" },
          { "in": "query", "name": "limit", "schema": { "type": "integer", "default": 15 }, "description": "Hər səhifədəki video sayı" },
          { "in": "query", "name": "categoryId", "schema": { "type": "string" }, "description": "Yalnız bu kateqoriya ID-dəki videolar" },
          { "in": "query", "name": "search", "schema": { "type": "string" }, "description": "Video başlığı və ya açıqlamasına görə axtarış" },
          { "in": "query", "name": "sort", "schema": { "type": "string", "enum": ["newest", "trending", "price_low", "price_high"] }, "description": "Sıralama (default: newest)" },
          { "in": "query", "name": "location", "schema": { "type": "string" }, "description": "Provider ünvanına görə filter (məs: 'Bakı', 'Sumqayıt')" },
          { "in": "query", "name": "minPrice", "schema": { "type": "number" }, "description": "Minimum qiymət (məs: 10)" },
          { "in": "query", "name": "maxPrice", "schema": { "type": "number" }, "description": "Maksimum qiymət (məs: 500)" }
        ],
        "responses": {
          "200": {
            "description": "Səhifələnmiş, filterlənmiş videolar siyahısı — provider məlumatları və engagement statusu daxildir",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "example": true },
                    "count": { "type": "integer", "description": "Bu səhifədəki video sayı", "example": 15 },
                    "total": { "type": "integer", "description": "Ümumi uyğun video sayı", "example": 87 },
                    "page": { "type": "integer", "example": 1 },
                    "totalPages": { "type": "integer", "example": 6 },
                    "videos": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "_id": { "type": "string", "example": "64efc9abc1234567890def12" },
                          "title": { "type": "string", "example": "Peşəkar Santexnika Xidməti" },
                          "description": { "type": "string", "example": "Boru təmiri və su xətləri." },
                          "price": { "type": "number", "example": 50.5 },
                          "videoUrl": { "type": "string", "example": "https://your-r2-domain.r2.dev/talkmart/videos/video.mp4" },
                          "thumbnail": { "type": "string", "example": "https://your-r2-domain.r2.dev/talkmart/thumbnails/thumb.jpg" },
                          "categoryId": { "type": "string", "example": "64efc9abc1234567890abc01" },
                          "duration": { "type": "number", "example": 30 },
                          "likeCount": { "type": "integer", "example": 42 },
                          "viewCount": { "type": "integer", "example": 128 },
                          "saveCount": { "type": "integer", "example": 15 },
                          "createdAt": { "type": "string", "format": "date-time" },
                          "provider": {
                            "type": "object",
                            "properties": {
                              "_id": { "type": "string", "example": "64efc9abc1234567890def99", "description": "Providerin ID-si" },
                              "fullName": { "type": "string", "example": "Cəmilə Məmmədova" },
                              "companyName": { "type": "string", "example": "Cəmilə Təmizlik", "nullable": true },
                              "phone": { "type": "string", "example": "+994501234567", "description": "Providerin əlaqə nömrəsi" },
                              "address": { "type": "string", "example": "Neftçilər pr, 12, Bakı", "nullable": true, "description": "Providerin ünvanı" },
                              "profileImage": { "type": "string", "example": "https://your-r2-domain.r2.dev/talkmart/images/profile.jpg", "nullable": true, "description": "Providerin profil şəkli" }
                            }
                          },
                          "isLiked": { "type": "boolean", "description": "Cari istifadəçi bu videonu bəyənibmi. Guest üçün həmişə false.", "example": true },
                          "isSaved": { "type": "boolean", "description": "Cari istifadəçi bu videonu yadda saxlayıbmı. Guest üçün həmişə false.", "example": false }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          "500": { "description": "Server xətası" }
        }
      }
    },
    "/videos/liked": {
      "get": {
        "summary": "İstifadəçinin bəyəndiyi videoları gətir",
        "description": "🔐 **LOGIN TƏLƏB OLUNUR** — Cari istifadəçinin like etdiyi bütün videoları səhifələnmiş formada qaytarır. Hər video ilə birlikdə provider phone, isLiked, isSaved daxildir.",
        "tags": ["Engagement"],
        "security": [{ "bearerAuth": [] }],
        "parameters": [
          { "in": "query", "name": "page", "schema": { "type": "integer", "default": 1 } },
          { "in": "query", "name": "limit", "schema": { "type": "integer", "default": 15 } }
        ],
        "responses": {
          "200": {
            "description": "Bəyənilmiş videoların siyahısı",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "example": true },
                    "count": { "type": "integer", "example": 10 },
                    "total": { "type": "integer", "example": 25 },
                    "page": { "type": "integer", "example": 1 },
                    "totalPages": { "type": "integer", "example": 2 },
                    "videos": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "_id": { "type": "string" },
                          "title": { "type": "string" },
                          "description": { "type": "string" },
                          "price": { "type": "number" },
                          "videoUrl": { "type": "string" },
                          "thumbnail": { "type": "string" },
                          "categoryId": { "type": "string" },
                          "duration": { "type": "number" },
                          "likeCount": { "type": "integer" },
                          "viewCount": { "type": "integer" },
                          "saveCount": { "type": "integer" },
                          "createdAt": { "type": "string", "format": "date-time" },
                          "provider": {
                            "type": "object",
                            "properties": {
                              "_id": { "type": "string", "description": "Providerin ID-si" },
                              "fullName": { "type": "string" },
                              "companyName": { "type": "string", "nullable": true },
                              "phone": { "type": "string" },
                              "address": { "type": "string", "nullable": true, "description": "Providerin ünvanı" },
                              "profileImage": { "type": "string", "nullable": true, "description": "Providerin profil şəkli" }
                            }
                          },
                          "isLiked": { "type": "boolean", "example": true },
                          "isSaved": { "type": "boolean" },
                          "likedAt": { "type": "string", "format": "date-time", "description": "Like edilmə tarixi" }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          "401": { "description": "Login tələb olunur" }
        }
      }
    },
    "/videos/saved": {
      "get": {
        "summary": "İstifadəçinin yadda saxladığı videoları gətir",
        "description": "🔐 **LOGIN TƏLƏB OLUNUR** — Cari istifadəçinin save etdiyi bütün videoları səhifələnmiş formada qaytarır. Hər video ilə birlikdə provider phone, isLiked, isSaved daxildir.",
        "tags": ["Engagement"],
        "security": [{ "bearerAuth": [] }],
        "parameters": [
          { "in": "query", "name": "page", "schema": { "type": "integer", "default": 1 } },
          { "in": "query", "name": "limit", "schema": { "type": "integer", "default": 15 } }
        ],
        "responses": {
          "200": {
            "description": "Yadda saxlanmış videoların siyahısı",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "example": true },
                    "count": { "type": "integer", "example": 5 },
                    "total": { "type": "integer", "example": 12 },
                    "page": { "type": "integer", "example": 1 },
                    "totalPages": { "type": "integer", "example": 1 },
                    "videos": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "_id": { "type": "string" },
                          "title": { "type": "string" },
                          "description": { "type": "string" },
                          "price": { "type": "number" },
                          "videoUrl": { "type": "string" },
                          "thumbnail": { "type": "string" },
                          "categoryId": { "type": "string" },
                          "duration": { "type": "number" },
                          "likeCount": { "type": "integer" },
                          "viewCount": { "type": "integer" },
                          "saveCount": { "type": "integer" },
                          "createdAt": { "type": "string", "format": "date-time" },
                          "provider": {
                            "type": "object",
                            "properties": {
                              "_id": { "type": "string", "description": "Providerin ID-si" },
                              "fullName": { "type": "string" },
                              "companyName": { "type": "string", "nullable": true },
                              "phone": { "type": "string" },
                              "address": { "type": "string", "nullable": true, "description": "Providerin ünvanı" },
                              "profileImage": { "type": "string", "nullable": true, "description": "Providerin profil şəkli" }
                            }
                          },
                          "isLiked": { "type": "boolean" },
                          "isSaved": { "type": "boolean", "example": true },
                          "savedAt": { "type": "string", "format": "date-time", "description": "Yadda saxlanma tarixi" }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          "401": { "description": "Login tələb olunur" }
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
                "required": ["title", "description", "price", "categoryId", "video"],
                "properties": {
                  "title": { "type": "string", "description": "Video xidmətinin başlığı", "example": "Peşəkar Santexnika Xidməti" },
                  "description": { "type": "string", "description": "Xidmət haqqında ətraflı məlumat", "example": "Boru və su xətlərini tez bir zamanda təmir edirik." },
                  "price": { "type": "number", "format": "float", "description": "Xidmət videosu üzrə təyin edilmiş qiymət", "example": 50.5 },
                  "categoryId": { "type": "string", "description": "Sistemin bazasından gələn Kateqoriya ObjectId-si" },
                  "video": { "type": "string", "format": "binary", "description": "Əsas video faylı (.mp4, .mov, vs.) Maksimum 250MB." }
                }
              }
            }
          }
        },
        "responses": {
          "201": { "description": "Video uğurla R2-yə yükləndi və bazada yadda saxlanıldı." },
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
            "example": "64efc9abc1234567890def12"
          }
        ],
        "responses": {
          "200": { "description": "Video uğurla həm MDB (baza), həm də R2-dən silindi." },
          "401": { "description": "İcazəsiz" },
          "403": { "description": "Qadağan edilib (Provider deyil)" },
          "404": { "description": "Video tapılmadı və ya sizə aid deyil." }
        }
      }
    },
    "/videos/{id}/like": {
      "post": {
        "summary": "Videonu bəyən / bəyənməkdən voz keç (Toggle Like)",
        "description": "🔐 **LOGIN TƏLƏB OLUNUR** — Token olmadan `LOGIN_REQUIRED` xətası qaytarılır. Mobil tətbiq bu xətaı alıb istifadəçini login ekranına aparmalıdır.\n\nBäyənmək və ya bəyənməkdən çıxarmaq üçün istifadə olunur. Anti-fake: Öz videolarınızı bəyənə bilməzsiniz. Rate limit: dəqiqədə 30 istək.",
        "tags": ["Engagement"],
        "security": [{ "bearerAuth": [] }],
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
                    "liked": { "type": "boolean", "example": true },
                    "likeCount": { "type": "integer", "example": 42 },
                    "message": { "type": "string", "example": "Like edildi." }
                  }
                }
              }
            }
          },
          "400": { "description": "Keçərsiz video ID formatı" },
          "401": {
            "description": "🔐 Token yoxdur → LOGIN_REQUIRED — Mobil bu kodu alıb login ekranına yönləndirir",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "example": false },
                    "error": { "type": "string", "example": "LOGIN_REQUIRED" },
                    "message": { "type": "string", "example": "Bu əməliyyat üçün giriş tələb olunur." }
                  }
                }
              }
            }
          },
          "403": { "description": "Öz videonuzu bəyənə bilməzsiniz" },
          "404": { "description": "Video tapılmadı" },
          "429": { "description": "Çox saydə istək (rate limit aşıldı)" }
        }
      }
    },
    "/videos/{id}/save": {
      "post": {
        "summary": "Videonu yadda saxla / yaddaşdan sil (Toggle Save/Bookmark)",
        "description": "🔐 **LOGIN TƏLƏB OLUNUR** — Token olmadan `LOGIN_REQUIRED` xətası qaytarılır. Mobil tətbiq bu xətaı alıb istifadəçini login ekranına aparmalıdır.\n\nYadda saxlamaq və ya silmək. Anti-fake: Öz videolarınızı yadda saxlaya bilməzsiniz. Rate limit: dəqiqədə 30 istək.",
        "tags": ["Engagement"],
        "security": [{ "bearerAuth": [] }],
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
            "description": "Yadda saxlama statusunu və yenilnmiş saveCount qaytarır.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "example": true },
                    "saved": { "type": "boolean", "example": true },
                    "saveCount": { "type": "integer", "example": 15 },
                    "message": { "type": "string", "example": "Video kayd edildi." }
                  }
                }
              }
            }
          },
          "400": { "description": "Keçərsiz video ID formatı" },
          "401": {
            "description": "🔐 Token yoxdur → LOGIN_REQUIRED — Mobil bu kodu alıb login ekranına yönləndirir",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "example": false },
                    "error": { "type": "string", "example": "LOGIN_REQUIRED" },
                    "message": { "type": "string", "example": "Bu əməliyyat üçün giriş tələb olunur." }
                  }
                }
              }
            }
          },
          "403": { "description": "Öz videonuzu yadda saxlaya bilməzsiniz" },
          "404": { "description": "Video tapılmadı" },
          "429": { "description": "Çox saydə istək (rate limit aşıldı)" }
        }
      }
    },
    "/videos/{id}/view": {
      "post": {
        "summary": "Video üçün baxış qeyd et (24 saatlıq limitli)",
        "description": "🔓 **GUEST DOSTu** — Token olmadan da işləyir. Guest baxışlar anonim sayılır.\n\nLogin olan istifadəçilər üçün 24 saatlıq rate-limit tətbiq edilir. Provider öz videosunun sayını artıra bilməz. Rate limit: dəqiqədə 30 istək.",
        "tags": ["Engagement"],
        "security": [],
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
                    "counted": { "type": "boolean", "example": true },
                    "viewCount": { "type": "integer", "example": 128 },
                    "message": { "type": "string", "example": "Görüntülənmə qeyd edildi." }
                  }
                }
              }
            }
          },
          "400": { "description": "Keçərsiz video ID formatı" },
          "404": { "description": "Video tapılmadı" },
          "429": { "description": "Çox sayda istək (rate limit aşıldı)" }
        }
      }
    },
    "/videos/{id}/engagement": {
      "get": {
        "summary": "Video üçün statistika və user statusu gətir",
        "description": "🔓 **GUEST DOSTu** — Token olmadan da işləyir. Guest üçün `isLiked: false`, `isSaved: false`, `isGuest: true` qaytarılır. Login olan istifadəçilər üçün real status gəlir.",
        "tags": ["Engagement"],
        "security": [],
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
            "description": "Bütün statistika məlumatlarını qaytarır.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success":   { "type": "boolean", "example": true },
                    "likeCount": { "type": "integer", "example": 42 },
                    "viewCount": { "type": "integer", "example": 128 },
                    "saveCount": { "type": "integer", "example": 15 },
                    "isLiked":   { "type": "boolean", "description": "Cari istifadəçi bu videonu bəyənibmi. Guest üçün həmişə false.", "example": true },
                    "isSaved":   { "type": "boolean", "description": "Cari istifadəçi bu videonu yadda saxlayıbmı. Guest üçün həmişə false.", "example": false },
                    "isGuest":   { "type": "boolean", "description": "Token olmadan istek gəlibsə true qaytarılır.", "example": false }
                  }
                }
              }
            }
          },
          "400": { "description": "Keçərsiz video ID formatı" },
          "404": { "description": "Video tapılmadı" }
        }
      }
    },
    "/users/provider/{id}/contact": {
      "get": {
        "summary": "Providerin əlaqə məlumatlarını gətir",
        "description": "🔐 **LOGIN TƏLƏB OLUNUR** — Token olmadan `LOGIN_REQUIRED` xətası qaytarılır. Mobil tətbiq bu xətaı alıb istifadəçini login ekranına aparmalıdır.\n\nLogin olan istifadəçilər providerin telefon, e-poçt, şirkət adı, yer, vebsayt, Instagram və WhatsApp məlumatlarını gətirə bilər.",
        "tags": ["User"],
        "security": [{ "bearerAuth": [] }],
        "parameters": [
          {
            "in": "path",
            "name": "id",
            "required": true,
            "schema": { "type": "string" },
            "description": "Providerin MongoDB ObjectId-si",
            "example": "64efc9abc1234567890def12"
          }
        ],
        "responses": {
          "200": {
            "description": "Providerin əlaqə məlumatlarını qaytarır.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "example": true },
                    "contact": {
                      "type": "object",
                      "properties": {
                        "fullName":    { "type": "string", "example": "Cəmilə Məmmədova" },
                        "email":       { "type": "string", "example": "cemile@example.com" },
                        "phone":       { "type": "string", "example": "+994501234567", "nullable": true },
                        "companyName": { "type": "string", "example": "Cəmilə Təmizlik", "nullable": true },
                        "location":    { "type": "string", "example": "Bakı, Azərbaycan", "nullable": true },
                        "website":     { "type": "string", "example": "https://cemile.az", "nullable": true },
                        "instagram":   { "type": "string", "example": "@cemile_temizlik", "nullable": true },
                        "whatsapp":    { "type": "string", "example": "+994501234567", "nullable": true }
                      }
                    }
                  }
                }
              }
            }
          },
          "401": {
            "description": "🔐 Token yoxdur → LOGIN_REQUIRED",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "example": false },
                    "error":   { "type": "string", "example": "LOGIN_REQUIRED" },
                    "message": { "type": "string", "example": "Bu əməliyyat üçün giriş tələb olunur." }
                  }
                }
              }
            }
          },
          "404": { "description": "Provider tapılmadı və ya bu istifadəçi provider deyil" }
        }
      }
    },
    "/users/provider/{id}/whatsapp": {
      "get": {
        "summary": "Provider'ın WhatsApp nömrəsinə birbaşa yönləndirmə (302 Redirect)",
        "description": "🔓 **GUEST DOSTU** — Token tələb olunmur. Qonaqlar da birbaşa WhatsApp-a yönləndirilə bilər.\n\nBu endpoint brauzerdə və ya mobil tətbiqdə birbaşa çağırıldıqda `https://wa.me/number` ünvanına 302 yönləndirməsi edir.",
        "tags": ["User"],
        "security": [],
        "parameters": [
          {
            "in": "path",
            "name": "id",
            "required": true,
            "schema": { "type": "string" },
            "description": "Providerin MongoDB ObjectId-si",
            "example": "64efc9abc1234567890def12"
          }
        ],
        "responses": {
          "302": { "description": "WhatsApp-a yönləndirmə uğurludur." },
          "404": { "description": "Provider tapılmadı" }
        }
      }
    },
    "/admin/dashboard/stats": {
      "get": {
        "summary": "Admin dashboard üçün unikal hesabatlar və daxili statistikalar",
        "tags": ["Admin/Dashboard"],
        "security": [{ "bearerAuth": [] }],
        "responses": {
          "200": { "description": "Dashboard məlumatları" }
        }
      }
    },
    "/admin/users": {
      "get": {
        "summary": "Sistemdəki bütün istifadəçiləri limitsiz və filtersiz gətirir",
        "tags": ["Admin/Users"],
        "security": [{ "bearerAuth": [] }],
        "responses": {
          "200": {
            "description": "İstifadəçilərin siyahısı uğurla gətirildi",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "example": true },
                    "count": { "type": "integer", "example": 1 },
                    "users": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "_id": { "type": "string", "example": "64efc9abc1234567890def12" },
                          "role": { "type": "string", "example": "user" },
                          "fullName": { "type": "string", "example": "Əli Əliyev" },
                          "email": { "type": "string", "example": "ali@example.com" },
                          "phone": { "type": "string", "example": "+994551234567" },
                          "bio": { "type": "string", "example": "Haqqında", "nullable": true },
                          "profileImage": { "type": "string", "example": "https://...", "nullable": true },
                          "emailVerified": { "type": "boolean", "example": true },
                          "createdAt": { "type": "string", "format": "date-time" },
                          "updatedAt": { "type": "string", "format": "date-time" }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          "401": { "description": "Token tapılmadı və ya yanlışdır" },
          "403": { "description": "Bu əməliyyat yalnız adminlər üçündür" }
        }
      }
    },
    "/admin/users/{id}/block": {
      "patch": {
        "summary": "İstifadəçini blokla (Admin paneli)",
        "description": "Admin seçilmiş istifadəçini bloklayır. Bloklanmış istifadəçi sisteme giriş edə bilmir. Admin hesabları bloklanamaz.",
        "tags": ["Admin/Users"],
        "security": [{ "bearerAuth": [] }],
        "parameters": [
          {
            "in": "path",
            "name": "id",
            "required": true,
            "schema": { "type": "string" },
            "description": "İstifadəçinin MongoDB ObjectId-si",
            "example": "64efc9abc1234567890def12"
          }
        ],
        "responses": {
          "200": {
            "description": "İstifadəçi uğurla bloklandı",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "example": true },
                    "message": { "type": "string", "example": "Əli Əliyev uğurla bloklandı." }
                  }
                }
              }
            }
          },
          "401": { "description": "Token tapılmadı və ya yanlışdır" },
          "403": { "description": "Admin hesabını bloklamaq mümkün deyil" },
          "404": { "description": "İstifadəçi tapılmadı" },
          "409": { "description": "İstifadəçi artıq bloklanıb" }
        }
      }
    },
    "/admin/users/{id}/unblock": {
      "patch": {
        "summary": "İstifadəçinin blokunu aç (Admin paneli)",
        "description": "Admin tərəfindən əvvəlcədən bloklanmış istifadəçinin blokunu aradan qaldırır.",
        "tags": ["Admin/Users"],
        "security": [{ "bearerAuth": [] }],
        "parameters": [
          {
            "in": "path",
            "name": "id",
            "required": true,
            "schema": { "type": "string" },
            "description": "İstifadəçinin MongoDB ObjectId-si",
            "example": "64efc9abc1234567890def12"
          }
        ],
        "responses": {
          "200": {
            "description": "İstifadəçinin bloku uğurla açıldı",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "example": true },
                    "message": { "type": "string", "example": "Əli Əliyev uğurla blokdan çıxarıldı." }
                  }
                }
              }
            }
          },
          "401": { "description": "Token tapılmadı və ya yanlışdır" },
          "403": { "description": "Bu əməliyyat yalnız adminlər üçündür" },
          "404": { "description": "İstifadəçi tapılmadı" },
          "409": { "description": "İstifadəçi bloklanmayıb" }
        }
      }
    },
    "/admin/users/{id}": {
      "delete": {
        "summary": "İstifadəçini sil (Admin paneli)",
        "description": "Admin seçilmiş istifadəçi hesabını sistemdən tamamilə silir. R2-dəki profil şəkli də silinir. Admin hesabları silinə bilməz.",
        "tags": ["Admin/Users"],
        "security": [{ "bearerAuth": [] }],
        "parameters": [
          {
            "in": "path",
            "name": "id",
            "required": true,
            "schema": { "type": "string" },
            "description": "İstifadəçinin MongoDB ObjectId-si",
            "example": "64efc9abc1234567890def12"
          }
        ],
        "responses": {
          "200": {
            "description": "İstifadəçi uğurla silindi",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean", "example": true },
                    "message": { "type": "string", "example": "Əli Əliyev hesabı uğurla silindi." }
                  }
                }
              }
            }
          },
          "401": { "description": "Token tapılmadı və ya yanlışdır" },
          "403": { "description": "Admin hesabını silmək mümkün deyil" },
          "404": { "description": "İstifadəçi tapılmadı" }
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
    "/categories/top": {
      "get": {
        "summary": "Ən çox istifadə olunan kateqoriyaları gətir (aktiv video sayına görə)",
        "description": "Aktiv videoların sayına görə azalan sırada kateqoriyaları qaytarır. Yalnız aktiv kateqoriyalar daxildir.",
        "tags": ["Public"],
        "security": [],
        "parameters": [
          {
            "in": "query",
            "name": "limit",
            "required": false,
            "schema": {
              "type": "integer",
              "default": 10,
              "minimum": 1,
              "maximum": 50
            },
            "description": "Qaytarılacaq kateqoriya sayı (standart: 10, maks: 50)"
          }
        ],
        "responses": {
          "200": {
            "description": "Top kateqoriyaların siyahısı",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": {
                      "type": "boolean",
                      "example": true
                    },
                    "count": {
                      "type": "integer",
                      "description": "Qaytarılan kateqoriya sayı",
                      "example": 5
                    },
                    "categories": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "categoryId": {
                            "type": "string",
                            "description": "Kateqoriyanın ObjectId-si",
                            "example": "64efc9abc1234567890def12"
                          },
                          "name": {
                            "type": "string",
                            "description": "Kateqoriyanın adı",
                            "example": "Təmizlik"
                          },
                          "videoCount": {
                            "type": "integer",
                            "description": "Bu kateqoriyada aktiv video sayı",
                            "example": 24
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          "500": { "description": "Server xətası" }
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