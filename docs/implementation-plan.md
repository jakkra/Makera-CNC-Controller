# Sensei Controller — implementation plan

Planen blir följande. Implementering sker först när respektive fas startas.

## Fas 0 – Säkra nuläget

1. Granska de 11 modifierade filerna så att inget experimentellt eller halvfärdigt följer med.
2. Köra relevanta JS-, Go- och race-tester.
3. Verifiera på Surface: kamera 1080p/snapshot/zoom, fokusreglage, feed override, Pause/Hold/Resume och manuell MDI under Pause.
4. Commit och push som en tydlig checkpoint.

## Fas 1 – Separera Pause, Resume och spindelkontroll

Pause ska inte automatiskt bestämma om spindeln ska stanna. Operatören väljer själv.

### Serverns spindle-context

Sensei håller reda på senaste giltiga S-värde, riktning (M3/M4), M5-status, target/faktiskt RPM, fil, MD5, rad och verifieringstid. Prioritet är G-code fram till aktuell rad, observerad maskintrafik, rapporterat target RPM och annars okänt. Kontexten kopplas till path/MD5 och bör överleva proxyomstart.

### Kontroller i Active Job

Under körning: Pause job. Under Pause: Start spindle (med explicit RPM), Stop spindle och Resume job.

- Pause skickar bara `suspend`.
- Stop spindle skickar `M5`.
- Start spindle skickar exempelvis `M3 S10000`, aldrig bara `M3`.
- Okänt varvtal kräver explicit inmatning.
- Start verifierar target/actual RPM.
- Resume startar aldrig spindeln automatiskt och ska tydligt visa avvikande/stillastående spindle.
- Hold förblir separat realtime hold.
- Resultat visas endast i bottom status bar.

Tester ska täcka M3/S-varianter, falska kommentarer, fil-/MD5-byte, omstart, okänt varvtal, Pause med spindel igång, Pause → M5 → cached M3 → Resume och förlorad anslutning.

## Fas 2 – Korrekt ETA

Ersätt rad/procentbaserad uppskattning med kumulativ planerad tid per segment: G0 rapid, G1 aktiv F, verklig G2/G3-båglängd, simultana XYZ, A grader/minut, canned cycles, dwell, tool changes/pauser samt modal feed, units, distance mode och WCS. Community-controllerns estimator jämförs med Makera Studio/Fusion.

Remaining blir planerad tid efter aktuell rad plus begränsad kalibrering från faktisk takt. Pause/Hold/Tool/Wait får inte multiplicera estimatet. Timern står still i dessa lägen. Validera Fusion-estimat, Studio-estimat, Sensei-estimat och faktiskt utfall på verkliga filer.

## Fas 3 – Händelser på jobbtidslinjen och tool-metadata

Skapa markörer för tool change, spindle start/stop/speed change, A-indexering, programmerad Pause/attention och coolant/vacuum. Markörerna ska vara stabila under liveuppdatering och visa typ, rad och värde vid tryck/hover.

### Tool-metadata från Fusion/Makera G-code

Parsern ska läsa kommentarer som `(T1 Makera Metal - 1*3mm D=1. CR=0.5 SD=3.175 ... - ball end mill)`, koppla dem till `T<number>M6`, extrahera nummer, namn, typ, diameter, corner radius, shank diameter och tillgängliga längder, samt stödja flera verktyg, byten, saknade fält och olika postprocessorer. Metadata visas i Overview och Active Job. G-code/job metadata föredras framför Fusion:s privata SQLite/cache-schema.

## Fas 4 – Job history och Notifications

Bygg Maintenance-vy ovanpå backend-endpoints.

Job history visar fil, start/slut, körtid, utfall (completed/aborted/alarm/unknown), pauser, attention, tool changes och uppskattad kontra faktisk tid. Detaljvy visar tidslinje.

Notification history visar typ, jobb, skapad tid, leveransstatus och konkret felorsak, samt resolved-notis där relevant. Inställningar ska omfatta Tool change, Pause/Wait/Hold, Alarm, Job completed/aborted, connection lost och camera offline; dessutom testknapp, valfri påminnelse och rate limit. Notification actions får inte starta/återuppta jobb. Transient feedback ligger bara i bottom status bar.

## Fas 5 – Dokumentation och Fusion-status

Fusion-upload implementeras inte igen. Uppdatera kravdokumentet så Fusion upload, systemd/kiosk, virtual MPG, A-jog, probing och kamera får korrekt status; XY Target Map markeras preview-only och direkt USB som separat kvarvarande transportarbete. Rätta gamla `Saknas`-markeringar.

## Senare – frontend-refaktor

Separat insats utan samtidig redesign eller ramverksbyte: lås beteende med tester, skapa gemensam API-klient, flytta state/selectors/formatters till moduler, dela upp efter machine/active-job/gcode-viewer/jog/probing/camera/files/notifications-history, separera CSS, behåll stabila DOM-noder/SSE-livscykel och överväg Web Worker för tung geometri/ETA.

## Föreslagen genomförandeordning

1. Checkpoint av nuvarande arbete.
2. Explicit spindle Start/Stop och cached spindle-context.
3. Säkert Pause/Resume-UI.
4. Rörelsebaserad ETA.
5. Tidslinjemarkörer och tool-metadata.
6. Job history och Notifications.
7. Uppdatera kravdokumentet.
8. Frontend-refaktor senare.
