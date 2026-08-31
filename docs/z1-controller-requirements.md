# Makera Z1 Control — krav- och featurelista

Senast uppdaterad: 2026-08-31

Detta är den gemensamma källan för vad vi vill bygga runt Makera Z1. Listan omfattar den lokala touch-controllern, CNC-Proxy, fjärråtkomst, kameror och Fusion 360-integrationen. Den beskriver önskat slutläge; den säger inte att allt redan är implementerat.

## Produktmål

En dedikerad, touchvänlig Ubuntu-controller vid maskinen som är snabbare och tryggare att använda än en vanlig laptop, men som också ger säker insyn och begränsad kontroll på distans. Vi ska återanvända CNC-Proxy och relevanta communityprojekt där det är rimligt i stället för att bygga ett parallellt protokoll- och controller-ekosystem.

Den planerade första hårdvaran är en begagnad Surface Pro 5 med Ubuntu. Arkitekturen ska samtidigt vara portabel till en Raspberry Pi eller annan Linux-dator.

## Prioritering och status

- **P0** — säkerhets- eller arkitekturkrav som allt annat måste respektera.
- **P1** — krävs för den första version vi faktiskt vill använda vid maskinen.
- **P2** — värdefull fortsättning efter en stabil första version.
- **P3** — idé/backlog.
- **Finns** — stödet finns i nuvarande CNC-Proxy eller närliggande lokal kod.
- **Delvis** — delar finns, men användarflödet är inte komplett.
- **Saknas** — behöver implementeras.
- **Utred** — kräver ett avgränsat test eller produktbeslut först.

## Säkerhetsprinciper

| ID | Prio | Status | Krav |
|---|---:|---|---|
| SAFE-001 | P0 | Delvis | Ett fysiskt nödstopp är den primära säkerhetsfunktionen. Kamera, notiser, Tailscale och mjukvaruknappen **Halt** får aldrig beskrivas som ersättning för ett hårdvarunödstopp. |
| SAFE-002 | P0 | Delvis | En fjärransluten användare ska kunna skicka **Halt/Stop** med lägsta möjliga fördröjning. Kvittens ska skilja på “kommandot skickades” och “maskinen har bekräftat nytt tillstånd”. |
| SAFE-003 | P0 | Delvis | Z1 får ha flera samtidiga transportanslutningar för observation och read-only-status, men rörelse, MDI, jobbstart och filtransfer ska ha en tydlig aktiv ägare åt gången. Proxy/session-arbiter ska hindra att Studio, kiosk, API och andra klienter blandar muterande transaktioner. |
| SAFE-004 | P0 | Finns | Observerläge (`-api-read-only`) gör dashboarden strikt läsbar: servern avvisar alla muterande HTTP-metoder med 403 och UI:t döljer styrning, filåtgärder och jobbstyrning. Verifierat 2026-08-31 mot den lokala Z1-proxyn. |
| SAFE-004 | P0 | Delvis | Filoperationer och jobbstarter ska faila stängt vid okänt eller gammalt maskintillstånd. Uppladdning till maskinen får bara ske när firmwaretillståndet är säkert, normalt `Idle`. |
| SAFE-005 | P0 | Saknas | Fjärrstyrning ska kräva autentisering och normalt endast exponeras via det privata Tailscale-nätet, inte direkt på internet. |
| SAFE-006 | P0 | Saknas | Ingen notis eller automation får automatiskt återuppta ett pausat jobb eller starta maskinrörelse. Resume, jogg och start kräver ett medvetet kommando i det autentiserade gränssnittet. |
| SAFE-007 | P0 | Delvis | Gränssnittet ska tydligt visa om status eller kamera är gammal/frånkopplad. Gammal bild eller status får inte presenteras som live. |

## Övergripande arkitektur

```text
Fusion 360-plugin ──HTTPS/Tailscale──┐
Fjärrmobil/webb ────Tailscale───────┼── CNC-Proxy på Ubuntu/Surface
Lokal touch-GUI ────localhost───────┤        ├── USB till Z1 (föredragen målväg)
Kameror ────────────lokalt──────────┘        ├── TCP/Wi-Fi till Z1 (sekundär/kompatibilitet)
                                             └── intern + extern kamera
```

CNC-Proxy är integrationslagret och ska normalt kunna hålla en egen observer/read-only-anslutning även när Studio eller mobilappen är ansluten, förutsatt att verkliga Z1-tester bekräftar säker svars-routing. Touch-GUI, Fusion-plugin och fjärrklienter använder i första hand proxyns API. Muterande kommandon och filtransfer får däremot bara ha en aktiv ägare åt gången. Transparent relay är fortfarande värdefullt för full trafiksynlighet och Studio-kompatibilitet, men är inte ett krav för all passiv observation.

Vi bygger inte en särskild “Studio-switch” innan praktiska USB/TCP-tester visar att den behövs. Kravet är kompatibilitet utan samtidiga, okontrollerade kommandokällor — inte en komplicerad switch för sin egen skull.

## Lokal touch-controller

| ID | Prio | Status | Krav |
|---|---:|---|---|
| UI-001 | P1 | Delvis | Fullskärms-/kioskläge på Ubuntu med automatisk start efter boot och återstart efter krasch. |
| UI-002 | P1 | Delvis | Touchanpassad översikt över maskinläge, anslutning, aktiv fil, förlopp, återstående tid, verktyg, spindel och kritiska temperaturer. |
| UI-003 | P1 | Delvis | Visa maskin- och arbetskoordinater tydligt, inklusive A-axel. |
| UI-004 | P1 | Delvis | Joggning av X/Y/Z/A med valbar steglängd/hastighet och dead-man-beteende. Släpp/förlorad input ska stoppa fortsatt joggning. |
| UI-005 | P1 | Delvis | Home, Unlock, Hold/Pause, Resume och Halt med tillståndsanpassade bekräftelser. Farliga eller ogiltiga knappar ska inte kunna tryckas. |
| UI-006 | P1 | Saknas | Touchvänliga probingflöden och nollpunkts-/work-offset-flöden utan att behöva skriva rå G-code. |
| UI-007 | P1 | Saknas | Verktygsflöden: aktuellt/nästa verktyg, manuellt verktygsbyte, probe-status och tydlig guidning när användarinput krävs. |
| UI-008 | P1 | Delvis | Filväljare och jobbkö: ladda upp, granska, starta, ta bort och se varför ett jobb väntar. |
| UI-009 | P1 | Saknas | Visuell redesign med tydlig CNC-hierarki, stora tryckytor och lugn industrikänsla; undvik generisk dashboard-/“AI-byggd” estetik. |
| UI-010 | P1 | Delvis | Tydliga lägen för offline, ansluter, återansluter, stale status, upptagen maskin och proxy relay/owner. |
| UI-011 | P2 | Delvis | Makron för säkra, återkommande arbetsflöden med beskrivning och bekräftelse där det behövs. |
| UI-012 | P2 | Delvis | Fysiskt tangentbord, mus, gamepad och touch ska kunna samexistera utan olika säkerhetsregler. |
| UI-013 | P1 | Saknas | Surface ska vara en lokal digital jog-pendant. När maskinen är ledig är **Jogga** standardvy; under körning visas aktivt jobb/översikt och vid väntan visas en särskild attention-vy. Automatisk växling och fast startvy ska kunna väljas per enhet. |
| UI-014 | P1 | Saknas | Joggvyn ska implementera både konventionell riktningsjogg och ett experimentellt virtuellt MPG-handhjul. MPG-läget väljer exakt en axel X/Y/Z/A, ger ett steg per hjulhack och har separata hållkontroller för kontinuerlig negativ/positiv förflyttning utan upprepade tryck. Hjulet får aldrig ha inertial/coasting-rörelse efter att fingret släppts. Båda lägena använder exakt samma dead-man-, idle-, stale-status- och hastighetsgränser. |
| UI-015 | P1 | Saknas | Från joggvyn ska en separat XY-karta kunna öppnas. Ett tryck väljer och förhandsvisar en målpunkt inom verifierade soft limits men startar ingen rörelse. Körning kräver avsiktlig hållbekräftelse och en explicit säker-Z-före-XY-sekvens. Z styrs separat; A-axeln är inte del av första kartversionen. Kartan får aldrig antyda att okända fixturer eller hinder detekteras. |
| UI-016 | P1 | Saknas | Riktningsjogg, virtuellt MPG och XY-karta ska kunna jämföras fysiskt på Surface och riktig Z1 utan att vald steglängd, hastighet eller koordinatvy tappas vid byte. Valt standardläge sparas per enhet. Utvärdera tid, antal tryck, överskjutning, felval och upplevd trygghet för representativa setupmoment innan slutlig standard väljs. |

## Maskinanslutning och Makera Studio

| ID | Prio | Status | Krav |
|---|---:|---|---|
| CONN-001 | P1 | Utred | Validera USB mot Z1 på riktig hårdvara och gör det till föredragen anslutning om stabilitet och funktion motsvarar Makera Studio. |
| CONN-002 | P1 | Delvis | Behåll TCP/Wi-Fi-stöd, UDP-discovery och möjlighet att använda maskinens LAN-protokoll. |
| CONN-003 | P0 | Delvis | Alla protokolltransaktioner ska serialiseras eftersom firmwareprotokollet saknar robust korrelation för parallella samtal. |
| CONN-004 | P1 | Delvis | Automatisk återanslutning ska bevara korrekt säkerhetsläge och aldrig anta att en tidigare `Idle` fortfarande gäller. |
| CONN-005 | P1 | Utred | Testa om Z1 accepterar flera samtidiga TCP-klienter eller USB plus TCP, och vad som händer under jobb. Implementera ingen extra växling förrän resultatet kräver det. |
| CONN-006 | P1 | Utred | Dokumentera ett enkelt, säkert flöde för att tillfälligt använda Makera Studio. Proxyägarskap ska lämnas/återtas kontrollerat om exklusiv anslutning krävs. |
| CONN-007 | P2 | Saknas | Visa ansluten transport, klientägare och konfliktorsak i GUI:t så att användaren slipper felsöka “mystiska” låsningar. |

## Filer, jobb och Fusion 360

| ID | Prio | Status | Krav |
|---|---:|---|---|
| JOB-001 | P1 | Delvis | Säker uppladdningskö till Z1 med checksumma, retry, synligt resultat och idle-gating. En 291-byte no-motion-fil har verifierats mot produktions-Z1 genom separat nedladdning och identisk MD5; tydligare skillnad mellan överförd och efterverifierad återstår i UI/modellen. |
| JOB-002 | P1 | Delvis | Lista, ladda ned och hantera G-code-filer på maskinen via proxy/API. |
| JOB-003 | P1 | Delvis | Spara jobbhistorik med fil, start/slut, utfall, viktiga tillståndsbyten och felorsak. |
| JOB-004 | P1 | Delvis | Visa aktivt jobb, verkligt maskintillstånd och förlopp; skilj uppladdat, köat, startat, pausat och färdigt. |
| JOB-005 | P1 | Finns | Sensei frågar själv Z1 med den read-only `0xB7`-ram som rapporterar `sökväg|MD5`, registrerar även jobb som startats utanför Sensei, laddar ned den aktiva filen och bygger G-code/preview. Verifierat 2026-08-31 mot produktions-Z1 under pågående körning, utan Studio som brygga: 1 212 198 byte och 63 980 G-code-rader hämtades med matchande MD5. |
| JOB-006 | P1 | Delvis | Titel, progress, G-code-källa och 3D-preview ska alltid avse samma aktiva sökväg när firmware/Studio ersätter en tidigare proxyvald fil. Ett livefynd 2026-08-31 visade korrekt titel men kvarhållen källa/segment från föregående fil; minnesbytet är patchat och täcks av regressionstest, men väntar på omstart och fysisk UI-verifiering efter pågående jobb. |
| FUS-001 | P1 | Saknas | Fusion 360-communitypluginet ska kunna postprocessa och ladda upp resultatet direkt till CNC-Proxy över lokalt nät eller Tailscale. Implementationen ska göras på vår befintliga `dev-4_axis_fix`-branch; prototypen som låg i fel upstream-klon är borttagen. |
| FUS-002 | P1 | Saknas | Pluginet ska visa vald maskin/destination, filnamn, uppladdningsresultat och tydligt fel — inte starta körning implicit efter uppladdning. |
| FUS-003 | P1 | Delvis | Stöd flera setups och indexering av A-axeln enligt vårt befintliga rotary-flöde. |
| FUS-004 | P1 | Saknas | Varje avsiktlig operatörspaus som pluginet skapar ska få stabil maskinläsbar metadata: typ, instruktion, setup/operation och önskad A-vinkel när relevant. Proxyparsern finns, men rätt Fusion-branch skriver ännu ingen markör. |
| FUS-005 | P1 | Delvis | Vår `dev-4_axis_fix`-branch skriver Z1:s `M600` före varje indexerat setup. Säker ordning och JSON-baserad `@z1-attention`-markör ska verifieras och implementeras på samma branch innan detta räknas som färdigt. |
| FUS-006 | P1 | Finns | Proxyn läser attention points ur den cachade uppladdade filen och korrelerar dem med `Wait`/`Pause` och spelarens radförlopp. Verifierat 2026-08-31 på produktions-Z1 med ett no-motion-jobb: `P:5,28,2` kopplades till markören på rad 5 och gav `rotary_index`. Separat upload-manifest behövs inte för första versionen. |
| FUS-007 | P2 | Saknas | Möjlighet att välja “upload”, “upload och öppna i controller” och, först efter separat säkerhetsbeslut, “upload och starta”. |

## Mobilnotifikationer och “needs attention”

Detta är ett kärnkrav. Målet är att användaren ska kunna lämna maskinens omedelbara närhet och ändå få veta att jobbet står still och behöver mänsklig input.

| ID | Prio | Status | Krav |
|---|---:|---|---|
| NOT-001 | P1 | Delvis | Skicka mobilnotis när maskinen går till ett tillstånd som kräver uppmärksamhet: `Tool`, `Pause`, `Wait`, `Hold` och `Alarm`. Attention-detektering är verifierad på produktions-Z1; opt-in ntfy-leverans finns men var inte konfigurerad under hårdvarutestet och mobilmottagning återstår. |
| NOT-002 | P1 | Delvis | Skilj på **verktygsbyte**, **A-axelindexering**, **användar-/programpaus**, **hold** och **alarm/fel**. `Pause` med A-indexmetadata är verifierad på produktions-Z1; verktygsbyte, hold och alarm återstår som verkliga tester. |
| NOT-003 | P1 | Delvis | En rotary-notis anger önskad vinkel från Fusion-jobbets markör och säger att frigång ska kontrolleras före Resume. Verifiering i Fusion/Z1 återstår. |
| NOT-004 | P1 | Delvis | En verktygsnotis anger aktuellt och efterfrågat verktyg när firmwarefältet `T` innehåller dem. |
| NOT-005 | P1 | Finns | Ett vänteläge skapar en händelse/notis. Upprepade statuspollningar dedupliceras och firmwaresekvensen `Wait` → `Pause` sammanfogas. |
| NOT-006 | P1 | Delvis | Händelsen markeras löst och kan valfritt ge en ntfy-uppföljning via `-notify-resolved`; UI-inställning återstår. |
| NOT-007 | P1 | Delvis | ntfy-payload innehåller maskin, jobb/fil, orsak, prioritet och valfri länk till autentiserat fjärrgränssnitt. |
| NOT-008 | P0 | Finns | ntfy-adaptern skapar inga control actions. Click öppnar endast konfigurerad Tailscale-/auth-skyddad controller-URL. |
| NOT-009 | P1 | Delvis | Leveranshistorik, felstatus, alarmprioritet och test-API finns. Testknapp och val per händelsetyp i GUI återstår. |
| NOT-010 | P1 | Delvis | Första provider är ntfy bakom ett litet providergränssnitt. Beslut om egenhostad ntfy och senare Home Assistant/Gotify/Pushover-adaptrar återstår. |
| NOT-011 | P2 | Saknas | Notifiera även jobb klart, jobb avbrutet, tappad maskinanslutning under körning, kamera offline och kritisk temperatur. Varje typ ska kunna slås av/på. |
| NOT-012 | P2 | Saknas | Påminn igen efter konfigurerbar tid om ett attention-läge fortfarande inte är löst, men med hård begränsning för frekvens. |

### Hur pausorsaken korreleras

Firmwaretillståndet räcker för att säkert upptäcka att maskinen behöver uppmärksamhet, men inte alltid varför. Lösningen ska därför ha två nivåer:

1. En tillståndsövergång till `Tool`, `Pause`, `Wait`, `Hold` eller `Alarm` ger alltid rätt generisk händelse.
2. Fusion-pluginet lägger attention-markörer och metadata i jobbordning. Proxyn korrelerar nästa avsiktliga paus med rätt markör och kan då visa “manuell A-rotation till 90°” i stället för bara “pausad”. Om korrelationen är osäker används den generiska texten.

Vår riktiga Fusion-arbetskopia är `dev-4_axis_fix`. Den skriver i nuläget `M600` före varje indexerat setup, men ännu ingen `@z1-attention`-markör. Proxyn kan redan tolka markören och koppla den till firmwarets `Wait`/`Pause` när pluginstödet senare läggs på denna branch; tills dess används generisk text.

### Acceptanskriterier för första notifieringsversionen

- Ett testjobb med verktygsbyte ger exakt en verktygsnotis inom tio sekunder från observerat `Tool`/relevant vänteläge.
- Ett testjobb med plugin-genererad manuell rotary-paus ger exakt en notis med rätt A-vinkel.
- En vanlig manuell paus ger en generisk pausnotis och felklassas inte som rotary.
- Upprepad identisk status i minst två minuter skapar inte fler notiser.
- Alarmnotis innehåller firmwarets haltkod och begripliga feltext när de finns.
- Resume/start kan inte utföras direkt från en olåst pushnotis.
- Notifieringshistoriken visar leveransförsök och den maskinhändelse som utlöste varje notis.

## Kamera och fjärrövervakning

| ID | Prio | Status | Krav |
|---|---:|---|---|
| CAM-001 | P1 | Saknas | Visa Z1:s inbyggda kamera och en extern kamera samtidigt, lokalt och på distans. |
| CAM-002 | P1 | Utred | Extern kamera ska i första hand vara en vanlig UVC USB-kamera med bra Linuxstöd; verifiera upplösning, fokus, montering och ljus. |
| CAM-003 | P1 | Saknas | Kameraström ska fungera genom Tailscale utan publik portforwarding. |
| CAM-004 | P1 | Saknas | Kamera-widget ska visa live/stale/offline, senaste bildtid och försöka återansluta utan att låsa controller-GUI:t. |
| CAM-005 | P2 | Saknas | Snapshot, timelapse och valbar inspelning kopplad till jobbhistoriken. |
| CAM-006 | P2 | Saknas | Kameraoffline under aktiv körning kan utlösa mobilnotis. |

## Fjärråtkomst

| ID | Prio | Status | Krav |
|---|---:|---|---|
| REM-001 | P1 | Delvis | Tailscale på controller och behöriga klienter; ingen publik exponering krävs. |
| REM-002 | P1 | Delvis | Responsivt webbgränssnitt för status, båda kamerorna, jobb och händelsehistorik. |
| REM-003 | P0 | Delvis | Fjärr-Halt ska vara lätt att hitta och tillgänglig även om en vanlig protokolltransaktion pågår. |
| REM-004 | P1 | Saknas | Riskfyllda fjärrkommandon ska ha roll/behörighet, bekräftelse och auditlogg. Read-only-visning ska kunna separeras från kontroll. |
| REM-005 | P1 | Saknas | GUI:t ska visa nätverksfördröjning/statusålder så att användaren vet när fjärrbilden inte är tillräckligt färsk för beslut. |

## Drift, underhåll och utveckling

| ID | Prio | Status | Krav |
|---|---:|---|---|
| OPS-001 | P1 | Saknas | Reproducerbar Ubuntu-installation för Surface: linux-surface vid behov, touch, rotation, kamera, Tailscale, CNC-Proxy och kiosk-service. |
| OPS-002 | P1 | Saknas | Systemd-tjänster med automatisk omstart, begripliga loggar och en enkel lokal diagnosticsida. |
| OPS-003 | P1 | Delvis | Export/import och backup av konfiguration, makron, jobbmetadata och historik. Hemligheter ska inte hamna i vanlig export eller Git. |
| OPS-004 | P1 | Saknas | Kontrollerad uppdatering med versionsvisning och enkel rollback till senaste fungerande version. |
| OPS-005 | P1 | Delvis | Automatiska tester för protokoll, statusövergångar, filkö och säkerhetsregler; hårdvarutester dokumenteras separat. |
| OPS-006 | P1 | Saknas | Maskin-/kamera-simulator för UI- och notifieringstest utan att en riktig CNC är ansluten. |
| MAINT-001 | P0 | Delvis | Bygg vidare på CNC-Proxy/communitykoden med små, tydliga moduler. Undvik att duplicera transport, filöverföring och statusparser i GUI eller Fusion-plugin. |
| MAINT-002 | P1 | Saknas | Egna ändringar ska hållas möjliga att återbasera/uppströmsa; dokumentera vad som är vårt tillägg och varför. |
| MAINT-003 | P1 | Saknas | Ett stabilt lokalt API/eventschema ska vara gränsen mellan proxy, touch-GUI, Fusion-plugin och notifieringsproviders. |

## Föreslagen leveransordning

1. Verifiera USB, samtidiga klienter och faktiska maskintillstånd för tool change, M0/M1, manuell pause och rotary-flödet.
2. Färdigställ Surface/Ubuntu-kiosk, anslutningssäkerhet och grundläggande touchflöden.
3. Lägg till ett internt händelselager i proxyn: tillståndsövergångar, `needs_attention`, deduplicering och historik.
4. Implementera första mobilkanalen och generiska notiser för Tool/Pause/Wait/Hold/Alarm.
5. Utöka Fusion-pluginet med explicit rotary-paus, attention-metadata och direkt upload till proxyn.
6. Lägg till båda kamerorna, fjärrvy och kamerahealth.
7. Förfina GUI, probing, verktygsflöden och senare notifieringstyper.

## Öppna beslut och tester

- Ett ofarligt testjobb utan axel-, spindel-, laser- eller kylkommandon har körts på produktions-Z1. `play` accepterades, filstorlek 291 rapporterades och maskinen nådde `Pause` vid `M600`; Sensei upptäckte och deduplicerade attention-läget. Testjobbet lämnades medvetet pausat utan automatisk Resume.
- Hur exponeras verktygsbyte på Z1: `Tool`, `Wait`, statusfältet `T`, textmeddelande eller en kombination?
- Första adaptern är ntfy. Bestäm om den ska vara egenhostad och om Home Assistant/Gotify/Pushover behövs senare.
- Flera fysiska TCP-klienter kan observerat samexistera (bland annat Studio och mobilapp). Verifiera på produktions-ESP32 exakt vilka svar som är per-klient, broadcastade eller snapshot-baserade innan proxyn använder en parallell observer-anslutning för annat än read-only-trafik.
- Produktions-Z1 har verifierats svara på en tom `0xB7`-fråga med `sökväg|MD5`. En separat Sensei-instans identifierade och laddade ned den aktiva filen under körning utan Studio som informationskälla; parser, MD5-kontroll, cache och G-code-preview är implementerade.
- Produktions-Z1 kräver Studio-kompatibel `CTRL_MULTI`-inramning utan avslutande CR/LF i payloaden. Med radbrytning gav `play` ett P1/filnamns-CRC-fel; efter central normalisering accepterades samma verifierade fil direkt. `FILE_START`-överföringskommandon behåller sin separata radslutskonvention.
- Avgör om någon status levereras spontant till flera TCP-klienter eller om varje klient måste skicka `?`. Nuvarande livefångst visar regelbundna `?`/STATUS_RES-ramar; ingen CNC-status-WebSocket är ännu observerad.
- Vilken transport är stabilast i verklig drift på Surface: direkt USB eller maskinens ESP32/TCP?
- Hur hämtas den inbyggda kameran stabilt samtidigt som en extern UVC-kamera används?
- Vilka kommandon ska vara tillåtna på distans utöver Halt, och vilka ska kräva fysisk närvaro?

## Funktioner som uttryckligen inte ingår i första versionen

- Att ersätta Z1:s LPC-firmware eller den slutna ESP32-firmwaredelen.
- Obemannad automatisk start eller resume från en mobilnotis.
- Publik internetexponering utan VPN och autentisering.
- En egen hårdvarupanel/case innan Surface-lösningen är praktiskt utvärderad.
