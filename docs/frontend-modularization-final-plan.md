# Slutplan: dela upp frontend utan beteendeförändringar

Datum: 2026-09-19. Granskad baseline: `e6f012b`, branch `codex/sensei-controller` i `Sensei-Local`.
Det finns också en äldre kopia, `CNC-Proxy-main` (`8de699b`). Planen utgår från den nyare kopian; verifiera arbetskopia och HEAD före implementation.
Denna plan ersätter uppdelningsförslaget i uppdraget, inte den separata funktionsplanen i `docs/implementation-plan.md`.

Uppdatering: `git pull --ff-only origin codex/sensei-controller` hämtade `ddc9d7c`. Hela [target-computer-development.md](target-computer-development.md) och `scripts/update-sensei-proxy.sh` är lästa. Pullen ändrade endast dokumentation; kodbaselinen och tidigare testresultat ovan gäller fortfarande samma produktionskod.

## Arkitekturbeslut: native komponenter med explicit ägarskap

Beslutet är fattat av ansvarig arkitekt på användarens uppdrag: fortsätt med native ES-moduler och inför konsekventa komponentgränser. Ingen React-, Vue- eller Lit-migrering och ingen jämförande ramverkspilot ingår i denna refaktor. Det tidigare diskussionsförslaget om en Lit-jämförelse ersätts av detta beslut. Användaren behöver inte välja webbteknik.

Motivering: den granskade koden har fungerande imperativa kontroller, Three.js-vyer, pointer-/deadman-livscykler och serverägda maskinkontrakt. De observerade underhållsproblemen är framför allt delat muterbart state, korsanrop mellan features och sammanblandning av rendering, I/O och resursägarskap. Dessa gränser behöver lösas även vid en ramverksmigrering. Jag bedömer att native komponenter ger bäst förhållande mellan underhållsvinst och regressionsrisk för denna befintliga app. Det är inte ett påstående om att reaktiva ramverk är olämpliga för maskinstyrning.

Målet är en beteendebevarande arkitekturrefaktor, inte enbart mindre filer. En komponent är här en vanlig JS-modul som äger ett namngivet DOM-område och sin befintliga lokala livscykel. Vi bygger inget eget generellt ramverk, ingen virtuell DOM, ingen generell event bus och inget nytt lager för automatiska subscriptions.

| Ansvar | Slutligt ägarskap |
| --- | --- |
| Serverdata | En gemensam, explicit väg tar emot och applicerar befintliga snapshots/deltas. Vyer läser relevanta data; de tolkar inte varsin egen SSE-ström. |
| Kommandoflöden | Namngivna funktioner äger befintlig request, pending och observerad verifiering. Overview och Active Job använder samma job-control-flöde. Ingen generell kommandokö eller ny retry införs. |
| Lokala utkast och interaktion | Tillhör respektive feature/kontroll: dirty inputs, sliderdrag, selection och pointer capture. Serveruppdateringar får inte överta dessa värden. |
| Resurser | SSE/poll, kamera och jog har var sin tydlig ägare för anslutningar, timers och cleanup. Delad resurs ska aldrig ägas av två vyer. |
| Presentation | Komponenten patchar sina stabila noder och tar emot befintliga data/kommandofunktioner genom ett litet dokumenterat gränssnitt. Ren modellberäkning hålls separat från DOM och I/O. |
| Appstart | `app.js` komponerar moduler och bevarar ordningen mellan init, statusapplicering och rendering. |

Uppdateringsflödet för vanliga servervärden är transport → befintlig statusapplicering → berörda vyer. En användaraction går via kontrollens lokala pending-state → befintligt kommandoflöde → verifierad återkoppling. Jog-heartbeat/release och realtime halt behåller sin direkta väg och får aldrig schemaläggas bakom renderarbete.

Genomför varje område i två små verifierbara steg: först mekanisk extraktion med befintliga referenser och beteenden, därefter begränsning av modulens stateåtkomst och korsanrop. I det andra steget flyttas befintligt featurelokalt state till dess ägare; delade konsumenter får namngivna läs-/action-ingångar. Ändra inte betydelsen av pending, drafts, snapshots eller initordningen. Dokumentera datakontrakten vid modulgränserna med JSDoc där det hjälper, utan krav på en samtidig TypeScript-migrering.

Ett stort exporterat `state` eller ett context-objekt med hela appens funktioner är endast en övergångsbrygga. För varje sådan brygga ska det stå vem som använder den och i vilket featuresteg den avvecklas. Översiktsvyn får inte direkt skriva i kamera-, jog- eller jobkontrollernas interna tillstånd.

Acceptans utöver gröna tester: en framtida ändring av exempelvis kamerafokus ska kunna göras i kamerans modul, dess befintliga API-koppling och dess tester utan ändringar i joggens eller filbrowserns interna kod. En återanvänd jobkontroll ska ha en implementation för kommandoflödet även när den visas i två vyer. En feature är inte färdigflyttad om dess gamla korsberoenden bara har flyttats till nya filnamn.

Första genomförandesteget förblir den lilla formatterar-/assetflytten. Därefter slutförs History/Maintenance som första hela komponent med denna ägarskapsmodell, och samma mönster används för följande features. Teknikvalet tas inte om vid varje steg. Om implementationen visar ett konkret hinder ansvarar arkitekten för att lösa det och motivera eventuell ändring av beslutet.

## Arbetsflöde: Windows och emulerad Z1 först

Användarens uttryckliga instruktion för denna refaktor gäller framför setupdokumentets generella standard att utveckla på måldatorn: gör i princip all utveckling på Windows i `Sensei-Local` och börja med projektets emulerade Z1 (`cmd/fakemachine`). Surface används för riktade Linux-/kamera-/touchkontroller och avsiktlig deploy av testade commits. Flytta inte hela utvecklingsarbetet till Surface på grund av ordet ”local” i setupdokumentet; där betyder det lokalt på Linux-måldatorn.

### Windows: dagligt arbete och första verifiering

- Arbetskopia: `C:\Users\ijakk\Documents\ChatGPT\David CNC\Sensei-Local`, branch `codex/sensei-controller`. Kontrollera `git status` före pull/commit och synka med fast-forward utan att skriva över andras ändringar.
- Go: `C:\Program Files\Go\bin\go.exe`. Bygg `./cmd/fakemachine` och `./cmd/proxy` med `-mod=mod` från den commit som testas. Befintliga binärer i `.tools/local-sim/bin/` är tidigare byggen, inte bevis på att nya JS/CSS-assets ingår. Använd en separat katalog under `.tools/` för refaktorns binärer, loggar och testdata; återanvänd inte produktionsdata eller en gammal kö.
- Simulator: `fakemachine -addr 127.0.0.1:12222 -sidecar 127.0.0.1:18422`. Proxy: `sensei-local-proxy -machine-transport tcp -machine 127.0.0.1:12222 -advertise=false -tcp-port 12200 -api-addr 127.0.0.1:18420 -dav-addr 127.0.0.1:18421 -data-dir <separat-testdatakatalog>`. Ersätt platshållaren med en faktisk isolerad katalog. Rensa ärvda `CNC_*`-inställningar enbart i testprocessens miljö så att produktionskameror/notifieringar/auth inte råkar följa med; fasta CLI-flaggor styr testmaskinen.
- Webbappen finns på `http://127.0.0.1:18420/`, simulatorpanelen på `http://127.0.0.1:18422/`. Kontrollera lediga portar och loggad maskinadress före tester. Ingen lokal proxy får ansluta till den riktiga Z1:an eller annonsera sig via discovery. API, WebDAV och simulator binds till loopback; nuvarande relayflagga binder port 12200 på alla interface, så beskriv inte hela processen som loopback-bunden och öppna inte LAN-brandväggen för testrelayn.
- Kör riktade Node-/Go-tester och actionflöden mot simulatorn efter varje steg. Gör första layoutkontrollerna vid desktop-, Surface- och mobilbredder på Windows. Fysisk Surface-touch, verklig kamerafokus/V4L2 och Linux-livscykel verifieras senare där de faktiskt finns. Simulatorn ersätter inte dessa hårdvarukontroller.
- Om agenten startar testprocesser: använd dold `Start-Process -WindowStyle Hidden -PassThru`, behåll exakta PID/sessioner och loggfiler, och städa egna processer/portar även vid fel, avbrott och handover. Starta inte en extra instans på upptagna portar.
- Windows rapporterade `CGO_ENABLED=0` och ingen C-kompilator hittades. Full race är därför ännu inte tillgänglig där. Kör vanliga riktade tester lokalt; ordna CGO vid behov eller kör checkpointens race-test mot exakt samma commit i en isolerad Linux-testkopia på Surface när den kan belastas. Redovisa miljö och resultat; kör inte tunga fullsviter för varje flytt och testa inte mot den installerade produktionsprocessen.

### Surface: verifierad åtkomst och installerad runtime

- Åtkomst är verifierad med `ssh surface`: användare `jakkra`, host `192.168.1.121`, port 22. Codex visar även den anslutna värden `remote-ssh-discovered:surface`. Ingen separat anslutning med namnet MCCO har identifierats. SSH i den begränsade kommandosandboxen saknade åtkomst till SSH-konfigurationen; samma läsande kommando fungerade med verktygets normala eskalering. Kopiera inte nycklar eller hemligheter till repot.
- Repo: `/home/jakkra/src/Makera-CNC-Controller`. Installerad binär: `/home/jakkra/.local/bin/sensei-cnc-proxy`. Data: `/home/jakkra/.local/share/sensei`. Privat konfiguration: `/home/jakkra/.config/sensei/proxy.env`, som aldrig ska committas eller skrivas ut i rapporter.
- Verifierade aktiva tjänster: användartjänsterna `sensei-cnc-proxy.service` och `sensei-kiosk.service`, samt systemtjänsten `sensei-ustreamer.service`. Proxyloggar: `journalctl --user -u sensei-cnc-proxy.service --no-pager -n 150`. Den äldre nohup-/PID-filbeskrivningen ska inte användas för deploy.
- På Surface: `http://127.0.0.1:8420/`, maskinstatus via `GET /api/machine/status`, kamerakonfiguration via `GET /api/cameras`. Port 8421 och kamerastreamer 8081 är loopback-bundna. Ingen ad hoc-proxy på installerade tjänstens port 8420.
- Go finns på `/usr/local/go/bin/go`, GCC och Firefox finns. Chrome/Chromium Playwright är fortsatt förbjudet. Läsande HTTP-kontroller kan göras över SSH. För browseråtkomst från Windows kan en tillfällig, ägd tunnel användas: `ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18430:127.0.0.1:8420 surface`. Kontrollera att lokal port 18430 är ledig och stäng tunneln efteråt. Browserns eventuella Host-/authkrav ska följas, inte stängas av för testet.
- Den tidigare Tailscale-HTTPS-adressen ska inte antas fungera: både vanlig och privilegierad `tailscale serve status` gav `No serve config` vid denna kontroll. SSH är verifierat; ändra inte nätverkskonfiguration som del av refaktorn.
- Maskinen rapporterade `Run` vid läsande kontroll 2026-09-19. Det är en tidsbunden observation: läs alltid färsk status inför belastande tester eller deploy. Hårdvarupåverkande actions görs först i emulatorn; detta planarbete har inte skickat några maskinkommandon eller startat om tjänster.

### Från testad Windows-commit till Surface

1. Testa och committa en avgränsad ändring på Windows; pusha till avtalad branch. På Surface: kontrollera arbetskopian, hämta ändringen och verifiera exakt commit. Gör ingen parallell frontendutveckling i en divergerande Surface-kopia.
2. Kör nödvändiga Linux-/race-kontroller vid checkpoints med `-mod=mod`. Installerad tjänst fortsätter köra sin tidigare binär medan källkod granskas och testas. Riktade manuella Surface-kontroller görs när lokala emulatorfallen är gröna.
3. Före deploy: verifiera färsk maskinstatus och att omstart kan ske utan att störa ett pågående jobb. Från den verifierade, rena Surface-arbetskopian körs `scripts/update-sensei-proxy.sh`, enligt [setupdokumentet](target-computer-development.md).
4. Skriptet bygger proxyn, sparar tidigare binär i `~/.local/share/sensei/releases/sensei-cnc-proxy.previous`, installerar kandidaten och startar om endast proxytjänsten. Vid misslyckad HTTP-healthcheck återställs tidigare binär. Skriptet testar inte commitens renhet eller om CNC:n kör; dessa förkontroller måste göras före anropet. Ett HTTP 200 är inte i sig verifierad maskinåteranslutning eller fungerande UI.
5. Kontrollera därefter färsk observerad maskinstatus, modul/CSS-laddning, relevanta vyer och pending/input under SSE. Kamera, kiosk och CNC startas inte om för denna deploy. Använd systemd/journal och skriptets rollback, inte manuella processbyten från äldre anteckningar.

## Review av ursprungsplanen

Riktningen är rätt: native ES modules, stabil DOM, featurevis flytt och små verifierade commits. Följande behöver ändras för att planen ska vara säker att genomföra:

1. **Testmigreringen måste komma före första flytten.** `app.test.mjs` och `outline_json.test.mjs` extraherar funktioner ur `app.js` med textmatchning och VM. `internal/api/api_test.go` söker dessutom efter JS-markörer i `/app.js` och CSS i HTML. Att bara köra de gamla testerna efter en flytt räcker inte; flytta deras källkoppling samtidigt och behåll beteendeassertionerna. Testa också riktiga modulimporter så att brutna exports eller importcykler inte göms av VM-stubbar.
2. **`request()` returnerar en Response, inte JSON.** Bevara credentials, cache, optionernas överlagringsordning, Response-retur och felbeteende. Gör inte om alla anropare till ett nytt JSON-kontrakt. Eventuella befintliga fel i felparsning hanteras separat efter reproduktion.
3. **SSE och polling kräver en gemensam, explicit ägare.** Koden har `/api/events?scope=control`, lazy anslutning till `/api/events?scope=files`, samt `pollMachine` var 3000 ms som också uppdaterar jobs. Status, filer och jobblogik får inte var för sig starta nya kopior av dessa resurser.
4. **State är inte ett rent objekt att flytta direkt.** Initialisering läser lokala preferenser och anropar defaults; dessutom finns modulglobala variabler utanför `state`. Behåll objektidentitet och nuvarande fält först. Inför inte ett nytt setters-/subscriptionsystem samtidigt med flytten.
5. **Featurelistan täcker inte hela monoliten.** Dashboard/Overview, navigering/Surface-routing, MDI/logg/macros, tool actions, inställningar och bottom status bar behöver också ägare. Annars blir bootstrap fortfarande en monolit.
6. **Ändrad render-timing är en separat ändring.** Det finns redan rAF-schemaläggning för vissa vyer. Bevara den, men inför inte global rAF-batchning under en mekanisk kodflytt. Jog release, halt, pending och eventordning får inte börja vänta på en bildruta.
7. **CSS måste först flyttas i exakt kaskadordning.** Att sortera befintliga regler direkt i åtta ämnesfiler kan ändra vilket deklarationsvärde som vinner. Flytta först till en stylesheet utan regeländringar; dela därefter bara där ordningen kan bevaras och verifieras.
8. **Asset-serving är redan no-store för fallback-routen.** `web.go` har däremot bara tre explicit inbäddade filer. Utöka embed avsiktligt, verifiera faktiska modul-URL:er, MIME och cacheheaders, och exponera inte tester/dokument genom att bädda in hela arbetskatalogen.

Detta är risker i planen och verifierade kodkopplingar, inte påståenden om nya produktbuggar.

## Bindande avgränsning

- Läs `AGENTS.md`, `docs/ui-ux-quality.md` och `docs/target-computer-development.md` före implementation och följ även eventuella mer lokala regler. Arbetsfördelningen Windows/Surface preciseras ovan för just denna refaktor.
- Ingen ändring i `vendor/`, inget ramverksbyte, ingen redesign och inga nya features. Behåll native ES modules och befintliga DOM-id:n, klasser, markupflöden och texter.
- Behåll REST-metoder, URL:er, payloads, auth, SSE-event, WebSocket-meddelanden, lazy loading, retryvillkor och intervall. Bevara backendens I/O-policyer. `api.go` och `internal/service/` är kontraktsreferenser, inte planerade ändringsytor.
- Liveuppdateringar ska bevara nodidentitet, fokus, selection, pointer capture, menyer, lokala drafts och pending requests. Ingen snapshot får återaktivera en request-busy kontroll eller skriva över aktiva formulärvärden.
- Maskinactions behåller befintlig pending/disabled/aria-busy-livscykel, observerad verifiering och terminal återkoppling. Bottom status bar förblir ensam transient meddelandeyta/live region. Ingen optimistisk ny success-text.
- Behåll skillnaden mellan Pause, Hold, Resume, halt och paused spindle commands exakt som i baselinen. Ny modulstruktur får inte införa köer eller retries för sådana anrop.
- Chrome/Chromium via Playwright är förbjudet. Tillgänglig och tillåten Firefox/WebKit eller annan godkänd browsermetod får användas. Saknad browservalidering ska redovisas som ej genomförd.
- Agenten äger och städar endast processer den själv startar; registrera PID/session och portar och verifiera att de är stängda före avslut eller handover. Rör inte befintliga `.tools/`-artefakter eller andras ändringar.

## Fas 0: baseline och karta över beroenden

1. Notera repo, branch, HEAD, arbetskatalogens status, runtime-versioner och exakta testkommandon. Blanda inte in annat pågående arbete.
2. Kör `node --test internal/api/web/app.test.mjs internal/api/web/outline_json.test.mjs` och `go test -mod=mod ./internal/api`. Kör full `go test -mod=mod -race ./...` som checkpoint före större extraktion. `-mod=mod` krävs för samtliga Go build/test/vet-kommandon.
3. Skapa en kort inventering per funktion/grupp: nuvarande plats, statefält som läses/skrivs, selectors och DOM-ägare, nätverksanrop, timers/listeners/observers, inkommande och utgående anrop, föreslagen modul och relevanta tester. Skilj rena beräkningar, DOM-patchning och funktioner som också ändrar state eller startar I/O; lita inte på prefixet `render`.
4. Lista state även utanför `state`, inklusive probe-confirmation, outline-revision, gesture-, audio- och foregroundvariabler. Kartlägg lokala drafts/pending och vilka snapshots som påverkar dem.
5. Dokumentera befintlig startordning, control/files-SSE, polling, jog och kamera-WS, foreground recovery, bfcache, URL-routing och cleanup. Kontrollera även timers via `setTimeout`, rAF, observers och media callbacks.
6. Ta jämförbara visuella baselines vid desktop-, Surface- och mobilbredder för berörda vyer. Använd fakemachine och kontrollerade responses för actiontester.

Granskarens observation: de två JS-sviterna passerade **194/194** på ovanstående HEAD. Terra verifierade därefter `go test -mod=mod ./internal/api -run '^TestWebUIServed$'`: grönt. Go finns på `C:\Program Files\Go\bin\go.exe` men låg inte i PATH. Full API-, race- och browserbaseline återstår. Befintlig otrackad katalog: `.tools/`.

## Fas 1: tester och asset-leverans

Gör först en liten vertikal flytt av exakt `fmtCoord` och `fmtPos` till `modules/format.js`, så att import, serving och teststrategi bevisas tillsammans. `fmtPos` beror bara på `fmtCoord`; båda saknar state, DOM och I/O. Behåll `fmtActiveTool` och dess beroende `toolDisplayName` samt den localeberoende `fmtTime` tills deras egna beroenden och tester hanteras.

- Lägg produktionsmoduler under `internal/api/web/modules/`. Testfiler ska ligga utanför inbäddade produktionskataloger. Använd `.js` för browsermoduler och en explicit, lokal Node-ESM-konfiguration om runtime kräver det; lägg den inte i serverns assetlista.
- Nya tester importerar riktiga exports. För ännu ej flyttade funktioner får VM-extraktion leva kvar temporärt med explicit mappning från funktion till faktisk källfil. Ingen kopierad implementation i tester, borttagna assertions eller generellt sammanfogande av alla källor som enda modulvalidering.
- Anpassa relevanta Go-källmarkörtester till rätt serverade asset. Bevara markup- och kontraktskontroller; börja inte kräva att featurekod finns i bootstrap.
- Utöka `web.go` med avsiktliga produktionskataloger när de finns. Testa entrypoint och samtliga transitiva imports via HTTP: 200, JS/CSS-MIME, `Cache-Control: no-store`, giltiga relativa paths och 404 för okända assets. Kontrollera även direkta vy-URL:er och att befintlig Three.js-URL fungerar. Ingen SPA-HTML för saknade moduler.
- Kör riktade JS-tester och `go test -mod=mod ./internal/api` innan nästa modul. Denna första end-to-end-flytt är en egen commit.

## Fas 2: små gemensamma moduler

Extrahera en grupp åt gången; undvik en stor samtidig omkoppling av alla anropare.

| Modul | Ansvar och gräns |
| --- | --- |
| `format.js` | Rena formatterare/pathhelpers med oförändrade enheter, rounding, defaultvärden och labels. |
| `dom.js` | Generella befintliga helpers, exempelvis `setTextIfChanged` och `setSoftDisabled`; inga featureselectors. |
| `api.js` | Nuvarande `request()` och endast befintlig transportlogik; inga DOM- eller notice-bieffekter. |
| `preferences.js` vid behov | Befintliga storagekeys/defaults/normalisering, utan formatmigration eller nya defaults. |
| `state.js` | Explicit skapande av delat server-/appstate efter att initialiseringsberoenden lösts. Befintliga statefält kan behållas under den mekaniska flytten, men featurelokala utkast, pending och resurser får sedan namngivna ägare enligt arkitekturbeslutet. Inget generellt settersystem. |
| `feedback.js` | Befintlig notice-/connectivity-livscykel och bottom bar. En ägare till nycklar, timers och deduplicering. |

Imports ska gå från bootstrap/features till infrastruktur/rena helpers. Features importerar inte `app.js`. Inga importcykler, featureinit vid import eller generisk event bus som döljer exekveringsordning. Använd namngivna beroenden/callbacks endast där verkliga korsanrop kräver dem; skapa inte ett context-objekt som exponerar hela monoliten.

## Fas 3: featurevis extraktion

Följande är ordningen att pröva efter beroendeinventeringen. Flytta en mindre sammanhängande del först om en modul annars blir för stor. Ändra ordningen bara med dokumenterat beroendeskäl.

1. **History/notifications**: maintenance-loading, historik, detaljer, attention-koppling och befintlig test-notification-action. Behåll loading/pending/feedback.
2. **Files**: lista/träd, upload, sync, queue och filactionernas nod-/requestägarskap. Files-SSE fortsätter att startas på nuvarande villkor.
3. **Camera**: builtin/external streaming, snapshots, zoom, fokus, requestrevisioner och timers. Kameran äger mediaresurserna; global visibility delegerar till den.
4. **MDI/macros/tool actions/settings**: separata sammanhängande moduler efter inventeringen. Bevara bland annat movement-disarm innan kommandon och verifiering av tool actions.
5. **Active job och G-code viewer**: skilj action/progress/pending från sourcefönster, timeline och Three.js-resurser. Bevara gemensamma Overview/Active Job-kontroller, sourcevirtualisering, paginering, cache och sena svar vid fil-/MD5-byte. Dashboard och Active Job ska fortsätta använda samma befintliga modeller, inte få kopierade implementationer.
6. **Machine-status och live transport**: en `live-updates.js` äger SSE/poll-resurser och delegerar befintliga apply-callbacks; `machine-status.js` äger readouts och statuspresentation. Bevara eventordning, snapshot/delta-semantik, stale/Unknown/read-only-gating och reconnect. Bootstrap startar detta en gång i nuvarande ordning. Flytta inte maskinpolicy till frontend.
7. **Jog och probing/work area**: håll rörelselease, deadman, heartbeat, release, capture och pending inom tydliga ägargränser. Samordna outline/origin/probe och delad work-area via smala explicita anrop. Bevara tab-exit, blur, hidden, pagehide, pointercancel/lost capture, WS-avbrott, backpressure och stop-före-nästa-action.
8. **Dashboard och navigation/lifecycle**: flytta återstående profil/layout/Overview-logik samt navigering och Surface-routing. Globala eventhandlers installeras en gång; features äger sin cleanup. Bevara bfcache-reload och foregroundtrösklar.

Varje feature har explicita init-/render-/action-/cleanup-ingångar där dessa behövs. Detta innebär inte ett nytt mount/unmount-flöde vid tabbyte: behåll nuvarande DOM-livstid och resursvillkor. Efter den mekaniska flytten begränsas featuremodulens stateåtkomst och korsanrop i en separat verifierad ändring. Stateutdrag eller callbacks som behövts för övergången har namngivna konsumenter; avveckla bryggorna när ägargränsen är etablerad. Nödvändiga permanenta beroenden förblir små och explicita.

## Fas 4: liten bootstrap

`app.js` importerar moduler, skapar state och kopplar ihop init, befintlig render-samordning, liveuppdateringar och global lifecycle. Ingen featureimplementation, kvarvarande stor eventhandler-samling eller förtäckt `legacy-app.js` får bära monoliten.

Kontrollera hela importgrafen, avsaknad av importcykler och dubbla listeners/streams/timers. Kontrollera att featurelokala tillstånd inte skrivs från andra features och att en gemensam kontroll inte har fått kopierad kommandologik. Bevara befintlig initordning och rAF på exakt de flöden som redan använder den. Radantal är ett symptom; tydligt ansvar och testbara gränser är acceptanskriteriet.

Checkpoint efter JS-extraktionen: samtliga relevanta JS-tester, `go test -mod=mod -race ./...`, samt regression av de operatörsflöden som listas nedan.

## Fas 5: CSS utan visuell ändring

1. Flytta hela nuvarande style-blocket till exempelvis `/styles/app.css`, länkat på samma plats i dokumentets laddordning. Behåll deklarationer och regelordning exakt. Bevara även relativa resurs-URL:ers upplösning om sådana finns.
2. Anpassa HTML/CSS-källtester och embed/serving i samma steg. Jämför ursprungligt style-innehåll mot den serverade filen samt visuella baselines.
3. Dela i `base`, `layout`, `machine`, `active-job`, `jog`, `camera`, `files`, `mobile` endast där regelordningen kan bevaras. Använd vid behov numrerade sammanhängande sektioner; samla inte alla media queries sist om det ändrar kaskaden. Ingen ny cascade layer, specificityändring, deduplicering eller breakpointändring.
4. Verifiera att filernas innehåll i laddordning motsvarar föregående CSS och att layouten är oförändrad vid alla berörda bredder och tillstånd. JS- och CSS-flyttar ska vara separata commits.

## Kontroll före varje commit

- Kör berörda Node-tester, inklusive outline-sviten när dess beroenden flyttas. Kör Go API-tester när embed/serving eller Go-källmarkörtester påverkas; kör berörda Go-paket vid annan serverändring. Full race är en checkpoint, inte ett kommando för varje helperflytt.
- Testa importerade modulernas verkliga beroenden och faktiska HTTP-assets. Behåll tidigare assertions under testmigreringen.
- Mata in en snapshot under fokus/selection, dirty input, sliderdrag/pointer capture och pending request. Kontrollera samma nodobjekt och lokala värden, att handlers fortfarande fungerar och att busy inte försvinner.
- För actions: verifiera exakt endpoint/metod/payload eller WS-meddelande, ingen dubbel submission, befintlig observed-success-verifiering och korrekt failure-/pending-livscykel i bottom bar. Täck också sena svar efter fil-/vybyte där befintliga guards finns.
- Testa berörd vy mot emulatorn på Windows vid desktop- och Surface/mobilbredder, med tangentbord/fokus, loading/empty/busy/stale/disconnected/error samt långa labels. Gör fysisk Surface-verifiering vid relevanta checkpoints enligt arbetsflödet ovan. Spara vad som faktiskt observerats; Node-tester och emulerad viewport är inte ett substitut för verklig touch, pointer capture eller WebGL.
- Granska diff: endast avsedd flytt, imports/wiring, nödvändig serving/testanpassning och dokumentation. Commit per liten verifierad enhet. Vid regression, återställ bara den egna enheten; använd inte en bred reset över andras arbete.

## Slutverifiering och Surface

Kör alla relevanta JS-sviter, `go test -mod=mod -race ./...` och `go vet -mod=mod ./...`. Redovisa exakta resultat; ett saknat race-toolchain eller en otillgänglig Surface är en återstående kontroll, inte ett grönt resultat.

Verifiera Overview, Active Job, Jog, Camera och Files samt berörda Control/Maintenance-flöden. Täck Pause/Hold/Resume, paused spindle controls, feed override, tool wait, MDI/macros, probe/origin, filactions, reconnect, kort/lång bakgrundssuspension, bfcache och befintlig Surface auto/manual routing. Maskinactions testas först mot fakemachine; skapa inte riktiga rörelser bara för att UI ska kunna demonstreras.

Förbered en identifierbar byggversion från testad Windows-commit och deploya enligt arbetsflödet ovan och `docs/target-computer-development.md`, med `scripts/update-sensei-proxy.sh` på Surface. Kontrollera pågående maskinjobb före omstart och verifiera rätt byggversion, maskinåteranslutning, modul/CSS-laddning och operatörsflöden efter deploy. Om uppgifter eller åtkomst saknas, färdigställ lokalt granskningsbart resultat och redovisa den specifika återstående deploykontrollen.

Refaktorn är klar först när featurelogik är ute ur bootstrap, import/assetkedjan fungerar, kontrakten och DOM-/actionägarskapet är oförändrade, relevanta tester är gröna och Surface-verifiering är genomförd eller uttryckligen redovisad som kvarstående. Skilj färdig lokal implementation från fullständigt verifierad/deployad leverans.

## Separat framtida prestandaarbete

Global rAF-batchning, generella state-setters, ändrade regler för draft/commit och Web Worker ingår inte i denna beteendebevarande refaktor. Att ge befintliga drafts och pending-state en lokal ägare ingår däremot i arkitekturarbetet ovan. Bevara befintliga skydd; påvisade beteendefel dokumenteras och hanteras i avgränsade ändringar med egna regressionsfall. Efter refaktorn kan profileringsdata motivera att en specifik tung ren beräkning flyttas till worker. Ingen spekulativ worker eller ändrad ETA-/geometrialgoritm i denna serie.

## Terra-handover

Mottagare: Terra (`gpt-5.6-terra`). Den avgränsade startkontrollen är mottagen och genomförd: regler/arbetskopia/HEAD är verifierade, en första beroendekarta och testförutsättningar finns, och första vertikala modulflytt är vald. Resultatet finns i `docs/frontend-modularization-handover.md` med körda respektive återstående kontroller. Full fas 0, inklusive bredare tester och visuella baselines, är ännu inte klar. Ingen produktionskod har ändrats. Fortsatt implementation följer faserna ovan i små verifierade steg.
