# AppNest Studio DJ

## עברית

אולפן בדפדפן עם שני נגני DJ, גלי קול, תכנון מעבר לפי קצב ועורך מדויק לקטעים ולמילים. אין צורך בקובץ התקנה. עיבוד ה־DJ מתבצע בדפדפן, על קובצי השמע שבחרתם.

### העלאה ל־GitHub Pages

1. חלצו את החבילה והעלו **את כל תוכן תיקיית האפליקציה** לאותה תיקייה במאגר. הקובץ index.html צריך להיות בשורש התיקייה שמתפרסמת.
2. שמרו על שמות הקבצים והתיקיות. כל קובצי JavaScript, קובצי CSS, תמונות ו־workers נחוצים; העלו גם את .nojekyll אם הוא מופיע בחבילה.
3. הפעילו GitHub Pages עבור הענף והתיקייה שאליהם העליתם את הקבצים, ופתחו את כתובת האתר ב־HTTPS לאחר סיום הפרסום. אין צורך להתקין שרת או תוכנה על המחשב של המשתמש.
4. אחרי עדכון, רעננו את האתר. אם הגרסה הישנה עדיין מופיעה, סגרו לשוניות ישנות ונסו רענון מלא. שמרו קודם קובץ פרויקט של עבודה חשובה.

### התחלה מהירה

- פתחו את סביבת ה־DJ. **„דוגמת תרגול”** טוענת שני קטעים סינתטיים ב־120 וב־124 BPM להיכרות עם הנגנים והמעבר.
- לעבודה על שירים, טענו קובץ ב־A וקובץ ב־B. לחצו ניגון בכל נגן; **„שמע רק A/B”** מבודד נגן, ו־**„מרכז”** מחזיר את המחוון למיקס של שניהם.
- גל הקול העליון מציג את השיר כולו. התקריב מציג שמונה שניות ורשת פעימות. לחיצה על הגל מנווטת למיקום; אפשר גם להשתמש במחוון ובחיצי המקלדת.
- בדקו את ה־BPM בהאזנה. אפשר להזין אותו ידנית, להקיש לפי הביט או לתקן חצי/כפול BPM. **„סמן ביט ראשון כאן”** מעגן את רשת הפעימות במיקום הנוכחי.
- בחרו נקודת מעבר ב־A ונקודת כניסה ב־B. **„סמן מעבר כאן”** משתמש במיקום הנוכחי; **„יישור לביט”** מצמיד את הנקודה לרשת. ההצעה האוטומטית היא התחלה לבדיקה בהאזנה.
- קבעו קצב יעד ואורך מעבר בתיבות, ואז לחצו **„האזן למעבר המתוכנן”**. תצוגת המעבר מראה את החיבור ואת מיקומו בזמן. שנו נקודות ואורך עד שהתוצאה מתאימה.

### מיקס, ייצוא ושמירה

לכל נגן יש מהירות, עוצמה ו־EQ של נמוכים, אמצע וגבוהים. המחוון שבמרכז משנה את היחס בין A ל־B בזמן ניגון. מד הנגן מציג אות לפני המחוון; מד העוצמה הראשי מציג את האות שנשלח לפלט. אם מד הפלט מתקרב לשיא, הנמיכו עוצמה או EQ.

ייצוא ה־DJ יוצר **WAV בסטריאו, 24-bit**: קטע מעבר לבדיקה או חיבור מלא של A מתחילתו, דרך המעבר, והמשך B מנקודת הכניסה ועד סופו. הייצוא משתמש בקצב היעד, בנקודות, בעקומת המעבר ובעוצמות וב־EQ שהוגדרו. **הוא אינו מקליט תנועות ידניות של המחוון.** האזינו לתוצאה לפני שמירת הקובץ הסופי.

**„שמירת קובץ מיקס”** מורידה קובץ .appnest-dj הכולל את השמע ואת ההגדרות. אין שמירה אוטומטית של מיקס ה־DJ: שמרו לפני סגירת הלשונית או החלפת עבודה, ובדקו שההורדה הושלמה. „פתיחת מיקס” משחזרת את הקובץ. WAV הוא תוצאת שמע ולא פרויקט שניתן לפתוח להמשך עריכה.

הכפתור **„עריכה מדויקת ומילים”** פותח את העורך הקיים לחיתוך, חפיפות, החלפת קטעים ועבודה עם שירה וליווי. פרויקט העורך בפורמט .appnest נפרד מקובץ מיקס .appnest-dj. ייצוא MP3 בעורך המדויק משתמש ברכיב חיצוני מ־CDN ודורש זמינות שלו; ייצוא WAV ב־DJ אינו תלוי ברכיב הזה.

### אם אין קול

1. נסו „בדיקת צליל”, ודאו שהלשונית והמחשב אינם מושתקים ושהרמקולים או האוזניות הנכונים נבחרו.
2. לחצו „שמע רק A/B” ובדקו את עוצמת הנגן, ה־EQ והעוצמה הראשית. נגן שמנגן יכול להיות מושתק על ידי המחוון.
3. פתחו **„נגן מקור ובדיקת שמע”** בנגן הרצוי. הוא עוקף את המיקס; הפעלתו עוצרת את נגני ה־DJ. אם גם המקור שקט, בדקו את הקובץ ואת התקן הפלט.
4. פורמטים תלויים ביכולת הפענוח של הדפדפן. נסו קובץ MP3 או WAV תקין אם M4A, FLAC או פורמט אחר אינו נטען. קובץ עם סיומת מתאימה אינו מבטיח קידוד נתמך.

### גבולות שחשוב להכיר

- זיהוי BPM הוא הערכה על סמך שלוש הדקות הראשונות לכל היותר, בחיפוש בטווח 70–180 BPM. הזנה ידנית תומכת ב־40–240 BPM. פתיחות ארוכות, משקל חריג וקצב משתנה עלולים להטעות את הזיהוי.
- תיבה בתכנון המעבר היא **ארבע פעימות**. התאמת BPM אינה מזהה לבדה גבולות של משפט מוזיקלי; יש לבדוק אותם בהאזנה.
- שינוי המהירות משנה גם את גובה הצליל. **אין נעילת סולם / Key Lock** או מתיחת זמן ששומרת על גובה הצליל.
- אורך מעבר והאזנה לפניו ואחריו דורשים מספיק שמע בנקודות שנבחרו. אם מתקבלת הודעה שאין מספיק שמע, הזיזו את הנקודה, קצרו את המעבר או את זמני ההאזנה שסביבו.
- עבודה וייצוא של קבצים ארוכים דורשים זיכרון בדפדפן. במקרה של מגבלת זיכרון, השתמשו בקטעים קצרים יותר או ייצאו רק את המעבר.

## English

A browser-based studio with two DJ decks, waveforms, tempo-based transition planning, and the existing precision/word editor. **No desktop installer is required.** DJ audio processing takes place locally in the browser using the files you select.

### Publish with GitHub Pages

1. Extract the package and upload **all app contents** into the published repository folder. Keep index.html at that folder's root.
2. Preserve every filename and directory. Include the JavaScript, CSS, images, workers and the .nojekyll file if supplied.
3. Enable GitHub Pages for that branch/folder and open the published HTTPS address after deployment completes. Users do not need to install an application or server.
4. Refresh after updating. If an old version persists, close old tabs and perform a full refresh. Save important projects before doing so.

### Use the DJ workspace

- **Practice demo** loads two synthetic tracks at 120 and 124 BPM. To use your own music, load a track into A and B and play each first.
- **Listen to A/B** isolates one deck; **Center** restores the crossfader to a blend of both. The full-track waveform seeks through the song; the detail view follows playback over an eight-second window.
- Verify the estimated BPM by listening. Enter BPM, tap the beat, or correct a half/double estimate. **Set beat grid here** anchors the grid at the current position.
- Choose the outgoing cue in A and the incoming cue in B. Use **Set cue here**, **Snap cue to beat**, or the suggested cues as a starting point.
- Set the target tempo and transition length in bars, then **Audition planned transition**. Refine cue positions and duration while watching and listening to the join.
- Each deck has speed, gain and low/mid/high EQ. The crossfader controls the live balance. Deck meters are before the crossfader; the master meter shows the signal sent to output. Reduce gain or EQ when the output approaches clipping.

### Export and keep your work

DJ export produces **stereo 24-bit WAV**: either a transition check or the full joined mix. The full mix plays A from its beginning through the fade and continues B from its cue through its end. Export follows the target tempo, cues, fade curve, gains and EQ. **It does not record improvised crossfader movements.** Audition the rendered result before saving the final audio.

**Save mix project** downloads a portable .appnest-dj file containing audio and settings. DJ projects are **not autosaved**: save before closing the tab or replacing your work, and check that the download completed. **Open mix project** restores that file. A WAV export is mixed audio, not an editable session.

**Precision & word editing** opens the existing editor for detailed cuts, overlaps, replacement segments and separate vocals/backing tracks. Its .appnest project format is separate from DJ's .appnest-dj. MP3 export in the precision editor uses an external CDN component and needs that component to be available; DJ WAV export has no such dependency.

### Silent audio or unsupported files

Try **Sound test**, check browser-tab mute, system volume and the selected speakers/headphones. Use **Listen to A/B** and check deck/master gain and EQ; the crossfader can mute a deck that is playing.

The **Original-file player & sound check** bypasses the mixer and stops DJ playback when used. If it is also silent, check the source file and output device. Format support depends on the browser's decoder: try a valid MP3 or WAV if M4A, FLAC or another format cannot be decoded.

### Limits

BPM detection examines at most the first three minutes and searches 70–180 BPM; manual entry supports 40–240 BPM. Treat detection as an estimate, especially with long introductions or changing tempo. Transition bars assume **four beats**; musical phrase boundaries still need listening.

Tempo matching changes playback speed **and pitch**. There is no Key Lock or pitch-preserving time stretch. Choose cues with enough audio for the overlap and the audition handles. For memory-limit errors with long files, use shorter sources or export only the transition.
