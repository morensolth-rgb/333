# Task: تحويل 333 (FridaCtl) إلى أداة استخراج Unity/IL2CPP أوفلاين

## الهدف (كما طلب المستخدم)
1. إلغاء تسجيل الدخول/الترخيص — التطبيق أوفلاين تماماً، يفتح مباشرة لأي حدا.
2. إزالة كل ما يخص Frida (server/inject/gadget/downloads/scripts).
3. إزالة ما يحجّم التطبيق (apktool.jar download, uber-signer.jar 3.1MB إذا ما إله لزوم, gg-mem 744KB إذا ما إله لزوم, Repack).
4. الوظيفة الجديدة:
   - المستخدم يختار لعبة → يستخرج ملفاتها (APK/assets).
   - يبحث عن global-metadata.dat + libil2cpp.so → يعمل dump (dump.cs) ويعرضه.
   - أداة استخراج data.unity3d (مثل سكربت UnityPy اللي بعته): يستخرج MonoBehaviour + TextAsset وباقي الأنواع.
   - عرض الملفات المستخرجة + بحث عن كلمة داخل الملفات → يعطي اسم الملف يلي فيه الكلمة.

## القرارات التقنية
- **dump IL2CPP على الجهاز**: ثنائي Rust static arm64 (Rodroid Il2CppDumper / il2cpp_dumper) ينحط بـ assets ويشتغل عبر root shell — نفس نمط gg-mem-arm64 الموجود. بدون نت، بدون سيرفر.
- **استخراج unity3d**: Chaquopy (Python داخل الأندرويد، صار مجاني/MIT من v12) + UnityPy. بديل: دعم UnityPy قد يتطلب deps ثقيلة — نختبر. إذا تعقّد، نستخدم Chaquopy لـ UnityPy فقط.
- **البحث**: native Kotlin على الملفات المستخرجة (grep-like) — لا يحتاج Python.
- البناء عبر GitHub Actions workflow الموجود (build.yml) — نعدّله: نشيل تنزيل frida/apktool.

## ما سيُحذف
- LicenseScreen + منطق الترخيص في App.tsx (fetch لسيرفر الترخيص).
- CommunityScreen (يعتمد على API خارجي).
- HackGamesScreen (يعتمد على API خارجي) — أو نعيد توظيفه؟ لا، يعتمد على سيرفر → حذف.
- frida: startFridaServer/downloadFridaBinaries/runScript/stopScript/isFridaRunning + HomeScreen download UI.
- RepackModule (apktool/uber-signer) — حجم 3.1MB.
- gg-mem + FloatingMemoryScanService إذا ما إلها لزوم للاستخراج.
- GameScreen/ScriptScreen/ConsoleScreen/AnalyzerScreen (كلها frida/memory) → تُحذف أو تُستبدل.

## الشاشات الجديدة
- GamesScreen: قائمة الألعاب المثبتة (إعادة استخدام AppsScreen).
- ExtractScreen: لكل لعبة — أزرار: [Dump IL2CPP] [Extract Unity Assets] → نتائج.
- FilesViewer: تصفح الملفات المستخرجة + بحث نصي يعرض اسماء الملفات المطابقة.

## الفحوصات الحرجة (ناجحة)
- UnityPy 1.7.43 (آخر pure-Python wheel) ينزل عبر Chaquopy ويشتغل مع stubs لـ (tkinter, texture2ddecoder, astc_encoder, etcpak, fmod_toolkit). export path نجح الاستيراد.
- il2cpp_dumper 0.7.0 (Rust, rodroidmods) عنده CLI flags --binary/--metadata/--output؛ الأسئلة التفاعلية فقط بحالات حافة (Mach-O fat/manual) مش متعلقة بأندرويد ELF.
- lz4/brotli/Pillow موجودين بـ chaquo.com/pypi-13.1؛ الباقي stub.
- Chaquopy 17.0.0 موجود على Maven Central. Gradle 8.3, RN 0.73.6, NDK 25.1.
- اسم التطبيق بالعرض "ApexTracker" لكن app.json/MainActivity يستخدمان "FridaCtl" — إبقاء "FridaCtl" لتجنب كسر التسجيل.

## الخطوات
- [x] خطة معتمدة من المستخدم
- [ ] تنظيف App.tsx (بدون license)
- [ ] حذف الشاشات/الموديولات الميتة + assets الثقيلة
- [ ] تعديل workflow
- [ ] RootBridge: دوال الاستخراج/dump/البحث + Chaquopy init
- [ ] سكربت بايثون extract (stubs + UnityPy)
- [ ] الشاشات الجديدة (Apps→Extract→Files/Search)
- [ ] بناء تجريبي + رفع
