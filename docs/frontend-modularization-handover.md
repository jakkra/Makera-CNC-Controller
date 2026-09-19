# Frontendmodularisering: Terra-handover och fas 0

Datum: 2026-09-19. Detta är en startkontroll och ett genomförandeunderlag, inte en implementerad frontendrefaktorering.

## Uppdaterat arbetsflöde efter handover

Arkitekturbeslutet är nu fast: native ES-moduler med komponenter som äger sina DOM-områden, befintliga lokala utkast/pending och resurser. Ingen ramverksmigrering eller Lit-pilot ska startas. Läs slutplanens **Arkitekturbeslut: native komponenter med explicit ägarskap**. Varje feature flyttas först mekaniskt och får därefter begränsad stateåtkomst i ett separat verifierat steg. Ett stort delat state/context eller kvarvarande korsskrivningar är inte ett godkänt slutläge. Uppdraget är arkitekturrefaktor, inte enbart filuppdelning.

Windows-kopian har fast-forwardats till `ddc9d7c`; endast README och det nya `docs/target-computer-development.md` ändrades. Dokumentet och `scripts/update-sensei-proxy.sh` är lästa. Följ den uppdaterade slutplanens avsnitt **Arbetsflöde: Windows och emulerad Z1 först**. Det ersätter antaganden om att daglig refaktorutveckling ska ske på Surface: användarens uttryckliga arbetsfördelning är Windows + lokal fakemachine först, Surface för riktade Linux/hårdvarukontroller och testad deploy. Tabellen nedan beskriver den ursprungliga startkontrollens baseline.

SSH `surface` till `jakkra@192.168.1.121` är nu verifierat. Proxy/kiosk kör som användartjänster och kameran som `sensei-ustreamer.service` på systemnivå. Deploy görs på Surface med det befintliga uppdateringsskriptet, inte med en andra proxy eller manuella nohup-processer. Läs färsk maskinstatus före omstart; maskinen var i `Run` under kontrollen. Windows-race saknar för närvarande CGO/C-kompilator; checkpointen behöver en fungerande toolchain eller isolerad Linux-testkopia. Slutplanen innehåller adresser, portar, loggning, simulatorstart och rollbackvillkor.

## Bekräftad arbetskopia

| Kontroll | Resultat |
| --- | --- |
| Repo | `C:\\Users\\ijakk\\Documents\\ChatGPT\\David CNC\\Sensei-Local` |
| Remote | `origin` = `git@github.com:jakkra/Makera-CNC-Controller.git` |
| Branch | `codex/sensei-controller` |
| HEAD | `e6f012b8c08d629852618ee10ece0abe91cb55db` (`fix: verify paused spindle controls from status`) |
| Arbetskopia | Inga spårade ändringar. Otrackat: befintlig `.tools/` och `docs/frontend-modularization-final-plan.md`; båda lämnas orörda här. |
| Runtime | Node fanns för tidigare JS-baslinje. Go: `C:\\Program Files\\Go\\bin\\go.exe`, version `go1.27.0 windows/amd64`; inte i `PATH`. |

`AGENTS.md`, `docs/ui-ux-quality.md` och `docs/frontend-modularization-final-plan.md` är lästa. Fortsatt arbete måste bevara stabil DOM-/inputägarskap vid liveuppdateringar, bottom status bar som enda transienta meddelandeyta, samt befintlig pending/verification-livscykel för maskin-actions. Chrome/Chromium via Playwright är förbjudet.

## Körda kontroller

| Kommando/kontroll | Resultat |
| --- | --- |
| `git branch --show-current`, `git rev-parse HEAD`, `git status --short` | Bekräftar arbetskopian ovan. |
| `git diff --check` | Grön. |
| `C:\\Program Files\\Go\\bin\\go.exe test -mod=mod ./internal/api -run '^TestWebUIServed$'` | Grön: `ok github.com/uwin/cnc-proxy/internal/api 0.147s`. Kontrollerar serverad markup, `/app.js`, Three-asset och `Cache-Control: no-store`. |
| JS-baslinje från planreview | `node --test internal/api/web/app.test.mjs internal/api/web/outline_json.test.mjs` passerade 194/194 på samma HEAD. Upprepades inte utan kodändring. |

Alla Go-kommandon kräver `-mod=mod`. Full `go test -mod=mod -race ./...` och `go vet -mod=mod ./...` är checkpoints före större extraktion respektive slutleverans och är inte körda i fas 0. Ingen browser-, fakemachine- eller långlivad-processkontroll har körts; inga processer eller portar har skapats.

## Beroende- och resursägarkarta

| Område | Nuvarande kod/DOM | Delat state och beroenden | I/O, resurser och ägarskap | Föreslagen gräns/test |
| --- | --- | --- | --- | --- |
| Bootstrap och navigation | `init()`, `showTab()`, `viewTabFromURL()` | `activeTab`, `surface`, maskinstatus | Installerar globala listeners; startar control-SSE/pollning och väljer lazy files-SSE. | Behåll i bootstrap tills feature-API:n finns. Testa URL/tabbordning och en listener-installation. |
| Transport/live-status | `request()`, `connectControlSSE()`, `connectFilesSSE()`, `pollMachine()`, `applySnapshot()`, `applyChange()` | `controlES`, `filesES`, `machine`, `files`, `jobs` | `request()` returnerar `Response`; behåll credentials/cache/options/felkontrakt. Control-SSE är eager, files-SSE lazy; pollning uppdaterar status/jobs. | Senare `api.js` och `live-updates.js`; ingen feature får skapa egen stream/timer. API-testet söker nu markörer i `app.js`. |
| Feedback/connectivity | notice/status-hjälpare och status-bar | `noticeKey`, `noticeSeq`, `notices`, `statusMessages`, `connectivityIssues` | Notice-timers och bottom status bar är enda transient/live region. | Senare `feedback.js`; featuremoduler tar namngivna callbacks, inte egna noticesystem. |
| Formattering: första flytt | `fmtCoord()` och `fmtPos()` vid rader 445–451 | Inget state, DOM eller I/O; `fmtPos` beror endast på `fmtCoord`. | Används av machine readouts, saved origins, probing/work area och båda G-code-vyerna; ren synkron beräkning. | `modules/format.js`, riktiga named imports och direkta Node-importtester. Flytta inte `fmtActiveTool`: den beror på `toolDisplayName`. Flytta inte `fmtTime`: locale/timezone är synligt beteende. |
| Maintenance/history/notifications | `runOutcome`, `runHistoryEvents`, `openRunHistoryDetail`, `renderMaintenance`, `loadMaintenance`, `testMaintenanceNotification` vid rader 14413–14548; dialog/listor i `index.html` | `runs`, `notificationSnapshot`, `maintenanceLoading`, `notificationTestPending`, `readOnly` | GET `/api/runs`, GET `/api/notifications`, POST `/api/notifications/test`; request vid tabval. Äger `maintenance-runs`, `maintenance-notifications`, testknapp och `run-history-dialog`. Status via `setStatusMessage`; inga timers/SSE/WS/observers. | Nästa featurecommit: `modules/maintenance.js` med injected `state`, `request`, `setStatusMessage`, `setTextIfChanged`, `fmtDuration`, `fmtTime`. Behåll tabtriggning i bootstrap; migrera `runHistoryEvents` från VM till modulimport. |
| Files | `renderFiles`, mapp-/filactions och `connectFilesSSE` | `files`, `filesLoaded`, `fileActions`, `fileRenderTimer`, `currentDir`, `jobs` | Lazy files-SSE; fil-API och request-pending per nod. | Egen feature efter maintenance. Bevara lazy start och nodidentitet. |
| Camera | dashboard-kamera, WS/snapshot/focus | `cameraFocus`, `cameras`, dashboard-drafts | Builtin WS, object URLs, reconnect-/retrytimers och visibility-delegering. | Egen modul efter Files; äger och städar mediaresurser. |
| Active Job/G-code | source, timeline, Three-renderare/splitter | `activeGcode*`, `activeGcodeSource`, `activeGcodeGeometry`, `gcodeView`, `dashboardGcodeView` | Fetches för source/segments, rAF, resize observers, WebGL och sena-svar guards. | Dela action/progress från viewer och bevara cache, observer- och renderägarskap. |
| Jog/probe/work area | jog, outline, origin, Surface-input | `jog`, `outline`, `workarea`; probe-confirmation, gesture/audio-globala | Jog WS, heartbeat/reconnect/sampletimers, pointer capture, blur/pagehide och audio. | Sen feature; flytta först efter explicit cleanup-/releasekarta. |

## Startordning och resursinvarianter

`init()` etablerar DOM-eventhandlers och lifecycle, hämtar kapabiliteter, startar statuspollning/control-SSE och laddar Maintenance om den redan är aktiv. `showTab()` behåller DOM-noder, kopplar Files-SSE endast när Files öppnas och laddar Maintenance när Maintenance väljs. `applySnapshot()` kan rendera machine, files och jobs från båda streams. Därför får en modul inte initiera vid import, starta en andra `EventSource`, överta pollning eller återskapa en feature-rot vid varje snapshot.

Resurser som behöver namngiven ägare i senare faser: `controlES`/`filesES`, jog-WS och reconnect/sampletimers, kamerans WS/object URLs/retrytimers, G-code-rAF och resize observers, foreground/bfcache/visibility/blur/pagehide, pull-to-refresh samt Surface-MPG:s pointer/audio-resurser.

## Exakt första vertikala modulflytt

**Commit: `refactor(web): serve and import coordinate formatters`**

1. Lägg `internal/api/web/modules/format.js` med exakt de befintliga implementationerna av `fmtCoord(v)` och `fmtPos(p, estimated)` som namngivna exports.
2. Importera endast dessa två exports i `app.js` och ta bort deras lokala definitioner. Ändra inga callers, texter, rounding eller fallbackvärden.
3. Utöka `internal/api/web.go` med den uttryckliga produktionskatalogen `web/modules/`; bädda inte in hela `web/` eftersom tester och dokument då kan exponeras.
4. Migrera berörda Node-assertions från text-/VM-extraktion till riktig ESM-import. Behåll övriga VM-tester tills respektive funktion flyttas. Anpassa Go-assertions från formatterarkod i bootstrap till entrypoint-import och modulens HTTP-svar.
5. Verifiera `/app.js` och `/modules/format.js`: 200, JavaScript-MIME, `Cache-Control: no-store`, fungerande relativ import och 404 för okänd modul. Kör berörda Node-tester och `go test -mod=mod ./internal/api`.

Detta flyttar kod, importkedja, embed/serving och teststrategi i samma lilla commit. Det bevisar ESM-assetkontraktet utan state, DOM-livstid, statusmeddelanden eller maskin-I/O. Fortsätt därefter med slutplanens små infrastruktursteg. Första featurekandidaten är Maintenance/history/notifications enligt kartan ovan, när dess beroenden är förberedda.

## Återstående kontroller före implementation

- Kontrollera exakt `web.go`-embed/serving-design och lägg API-tester för modul-URL, MIME, no-store och 404 före första committen.
- Kör riktiga ESM-importtester med repo-lokal Node-konfiguration; gör ingen global/runtime-omläggning enbart för tester.
- Ta kontrollerade visuella baselines för desktop, Surface och mobil före featureflyttar. Chrome/Chromium via Playwright får inte användas.
- Före större extraktion: `go test -mod=mod -race ./...`. Vid slutleverans: relevanta JS-sviter, `go test -mod=mod -race ./...` och `go vet -mod=mod ./...`.
- Före actionberörd feature: kontrollera endpoint/metod/payload, pending/disabled/`aria-busy`, observerad verifiering, failure i bottom status bar samt att snapshots bevarar fokus, dirty draft, pointer capture och nodidentitet.
