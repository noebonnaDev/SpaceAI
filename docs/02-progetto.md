# 02 — Progetto di Ritrovo

> Documento della fase B. Data: 13/10/2026. Nome di lavoro del prodotto: **Ritrovo** (alternative: *Agorà Spazi*, *Planimetro*).

## 0. Valori predefiniti applicati (profilo dell'ufficio)

Non ho ricevuto risposte alle domande iniziali, quindi applico questi valori. Sono tutti modificabili senza toccare il codice: dati di esempio, configurazione `.env` e impostazioni nel pannello di amministrazione.

| Campo | Valore applicato |
|-------|------------------|
| Piattaforma email/calendario | Microsoft 365 / Exchange Online (niente Exchange on-premises; niente EWS) |
| Numero di utenti | fino a 100 |
| Sale, postazioni, risorse | dati di esempio modificabili: 4 sale riunioni, 20 postazioni su 2 piani, 3 risorse condivise (un'auto aziendale, un proiettore portatile, un kit per videoconferenza) |
| Hosting | una VM Linux o un server on-premises con Docker (alternativa documentata: Azure App Service) |
| Moduli della prima versione | Room, Desk, BookMe, pannello di amministrazione con report, add-in Outlook, pannello fuori-porta, totem e flussi QR code; Care come semplice gestione richieste; Monitoring e biglietto da visita digitale in fase 2 |
| Hardware esistente | nessuno (tablet, sensori e badge non presenti) |

## 1. Principio guida dell'architettura

> **Outlook/Exchange è la fonte di verità per i calendari.**
> **Ritrovo è la fonte di verità per regole, check-in, metadati di postazioni e risorse, e analisi.**

In pratica:

- una prenotazione di una sala (o di una risorsa con casella Exchange) **è** un evento di calendario Exchange in cui la casella della sala è invitata come risorsa. Ritrovo non tiene un calendario parallelo: tiene una *copia di lavoro* sincronizzata, che arricchisce con check-in, check-out, rilascio e origine;
- se Outlook e Ritrovo divergono, vince il calendario Exchange: la riconciliazione (delta query) aggiorna Ritrovo, mai il contrario;
- le regole (periodo di tolleranza, durata massima, finestra di prenotazione, ruoli), i check-in, le postazioni senza casella Exchange, le planimetrie e i KPI sono gestiti solo da Ritrovo.

## 2. Architettura

```
                 ┌────────────────────────── Microsoft 365 (tenant del cliente) ─────────────────────────┐
                 │  Entra ID (SSO, ruoli app)      Exchange Online (caselle utente, sale, attrezzature)   │
                 │            ▲                                   ▲            │ notifiche di modifica    │
                 └────────────┼───────────────────────────────────┼────────────┼──────────────────────────┘
                              │ token (MSAL / NAA)                │ Graph      │ (webhook HTTPS)
┌───────────────┐   HTTPS     │                                   │ REST       ▼
│ Outlook       │──add-in─────┤        ┌────────────────────────────────────────────────────┐
│ (web, nuovo,  │ (Office.js) │        │ Server Ritrovo (Node.js + TypeScript, Fastify)      │
│ classico, Mac,│             ├──────► │  • API REST /api/*            • job pianificati      │
│ mobile)       │             │        │  • gateway Graph (live|mock)  • file statici PWA     │
├───────────────┤             │        │  • webhook /api/graph/*       • add-in /addin/*      │
│ Browser / PWA │─────────────┘        └───────────────┬────────────────────────────────────┘
│ (utenti,      │                                      │ SQL
│ reception,    │   pannelli fuori-porta e totem       ▼
│ admin)        │   (token dispositivo)       ┌──────────────────┐
└───────────────┘                             │ PostgreSQL 16    │
                                              └──────────────────┘
```

Componenti (un solo repository, monorepo npm):

| Pacchetto | Contenuto |
|-----------|-----------|
| `packages/server` | API REST (Fastify), autenticazione Entra ID, gateway Microsoft Graph (implementazione reale e mock), logica di prenotazione, sincronizzazione, job pianificati, KPI, migrazioni SQL, dati di esempio, test |
| `packages/web` | PWA React con interfaccia in italiano (pronta per altre lingue): area utente, reception, pannello di amministrazione, pannello fuori-porta, totem, pagine QR; pagina del task pane dell'add-in Outlook |
| `packages/addin` | manifest dell'add-in Outlook (formato XML "add-in only"), generatore del manifest per il dominio del cliente, script di validazione |

In produzione un solo container applicativo serve API, PWA e add-in sullo stesso dominio HTTPS, davanti c'è un reverse proxy (Caddy) per i certificati TLS, e PostgreSQL gira in un container separato con volume persistente.

### 2.1 Scelte tecnologiche e motivazioni

- **TypeScript ovunque** (stack predefinito, nessun motivo per cambiarlo).
- **Fastify** per l'API: validazione rapida, test con `inject()` senza rete.
- **SQL esplicito con `pg`** (nessun ORM con motori binari da scaricare): migrazioni in file `.sql` leggibili da un amministratore.
- **PGlite** (PostgreSQL compilato in WebAssembly) per i test: `npm test` funziona anche senza un server PostgreSQL; con `TEST_DATABASE_URL` i test girano sul PostgreSQL reale.
- **@azure/msal-browser** per PWA e add-in (NAA), **@azure/msal-node** per OBO e client credentials, **jose** per validare i token.
- **Luxon** per i fusi orari: memorizzazione in UTC, visualizzazione in `Europe/Rome`.

## 3. Integrazione Microsoft 365 (verificata)

Ogni punto è stato verificato sulle fonti di Microsoft Learn (elenco in §11). Dove ho trovato prove che una delle ipotesi del mandato non regge, lo indico come **Deviazione**.

### 3.1 Add-in Outlook

- Add-in web **Office.js** (nessun COM/VSTO).
- **Deviazione — formato del manifest.** Il mandato chiede "il formato che Microsoft raccomanda". Microsoft Learn documenta due formati: il manifest XML "add-in only" (valido in produzione per Outlook) e il manifest unificato JSON. Il manifest unificato **non è supportato in Outlook per Mac né in Office per dispositivi mobili** (tabella *Client and platform support*, `unified-manifest-overview.md`); per coprire tutte le piattaforme Microsoft indica di distribuire due versioni dell'add-in. Poiché il requisito è che l'add-in funzioni in Outlook nuovo e classico per Windows, Mac, web e mobile, usiamo il **manifest XML "add-in only"**, che copre tutte le piattaforme con un solo pacchetto. Il manifest unificato si potrà aggiungere quando Microsoft estenderà il supporto.
- Superfici: *organizzatore di appuntamenti* (pulsante nella composizione di una riunione: suggerisce sale libere per data/ora della riunione e le aggiunge alla riunione con Office.js oppure prenota direttamente), *partecipante di appuntamenti* e *lettura messaggi* (task pane con prenotazione rapida, le mie prenotazioni, check-in). Su mobile Microsoft consente per add-in generici solo la superficie di lettura messaggi (`MobileMessageReadCommandSurface`): da mobile l'add-in apre quindi il task pane in lettura; la prenotazione completa da smartphone si fa con la PWA.
- **Autenticazione: nested app authentication (NAA)** con MSAL.js (`createNestablePublicClientApplication`), che Microsoft indica come approccio raccomandato; i token legacy di Exchange (identity/callback token) sono disattivati in tutti i tenant Microsoft 365. NAA (requisito `NestedAppAuth 1.1`) è GA in Outlook web, Windows (nuovo e classico), Mac, iOS e Android. La registrazione dell'app deve includere il redirect SPA `brk-multihub://<dominio-add-in>`. Se NAA non è disponibile (client vecchi), l'add-in ripiega su un popup di accesso MSAL.
- L'add-in richiede un **token di accesso per l'API di Ritrovo** (scope `api://<client-id>/access_as_user`), non usa l'ID token per autenticarsi al server: è la pratica che Microsoft indica nelle FAQ NAA.
- Distribuzione: Microsoft 365 admin center → **Settings** → **Integrated apps** → **Add-ins** → **Deploy Add-in** (caricamento del manifest). Gli add-in possono impiegare 24–72 ore per comparire.

### 3.2 Microsoft Graph

| Operazione | API Graph | Chi chiama |
|------------|-----------|-----------|
| Disponibilità di sale e risorse | `POST /me/calendar/getSchedule` | utente (delegato) |
| Creare / modificare / annullare una prenotazione | `POST /me/events`, `PATCH`, `DELETE`, `POST /cancel` | utente organizzatore (delegato, flusso on-behalf-of) |
| Occorrenze di una serie | `GET /me/events/{id}/instances` | utente (delegato) |
| Rilascio automatico, check-out anticipato, scadenza proposte | `POST /users/{sala}/events/{id}/decline` | applicazione, **solo sulle caselle risorsa** |
| Prenotazione immediata dal pannello fuori-porta | `POST /users/{sala}/events` | applicazione, solo caselle risorsa |
| Sincronizzazione Outlook → Ritrovo | `GET /users/{sala}/calendarView/delta` + webhook su `/users/{sala}/events` | applicazione, solo caselle risorsa |
| Importazione sale ed elenchi sale | `GET /places/microsoft.graph.room`, `.../roomList` | amministratore (delegato) |
| Ricerca colleghi (prenotazione "per conto di") | `GET /users?$search=…` | utente (delegato) |
| Riunione Teams nella prenotazione | `isOnlineMeeting: true`, `onlineMeetingProvider: teamsForBusiness` | utente (delegato) |

Note verificate:

- `findMeetingTimes` è **solo delegato** (nessun permesso applicativo): lo usiamo solo dove c'è un utente; per i suggerimenti di sale alternative usiamo `getSchedule`, disponibile anche con `Calendars.ReadBasic`.
- `iCalUId` è **diverso per ogni occorrenza** di una serie: Ritrovo collega ogni occorrenza tramite il suo `iCalUId`, identico tra il calendario dell'organizzatore e quello della sala.
- Le date in ingresso sono inviate in UTC; per le serie ricorrenti usiamo il fuso Windows **`W. Europe Standard Time`** (Graph accetta i fusi Windows; `Europe/Rome` non è tra i nomi IANA aggiuntivi elencati da Graph), così l'ora resta corretta col cambio dell'ora legale.
- Creazione idempotente: ogni evento creato da Ritrovo ha `transactionId` = id della prenotazione, così un nuovo tentativo dopo un timeout non duplica l'evento.

### 3.3 Sale, attrezzature e postazioni in Exchange

- **Sale riunioni** → caselle *Room* di Exchange (obbligatorio). Una prenotazione è un evento con la sala come partecipante di tipo `resource`. Valgono le regole della casella (`Set-CalendarProcessing`): `AutomateProcessing AutoAccept`, `AllowConflicts`, `BookingWindowInDays` (predefinito 180), `MaximumDurationInMinutes` (predefinito 1440), `AllowRecurringMeetings`.
- **Risorse condivise (BookMe)** → caselle *Equipment* (consigliato) oppure gestite solo da Ritrovo.
- **Deviazione — postazioni.** Il mandato ipotizza di usare caselle risorsa anche per le postazioni "se il modello lo supporta". Le prove: (1) nella documentazione di `Set-Mailbox -Type`, il valore `Desk` "non crea una postazione prenotabile": serve creare la postazione con `New-Place` di **Microsoft Places** e collegarla con `Set-PlaceV3`; (2) nella Places API v1.0 una `desk` deve stare in una `section` e un `workspace` è un *insieme* di postazioni con casella. Le postazioni Exchange richiedono quindi la configurazione di Microsoft Places (i requisiti di licenza **non sono verificati**). **Alternativa adottata:** per impostazione predefinita le postazioni sono gestite da Ritrovo (fonte di verità: Ritrovo), con planimetria propria; ogni prenotazione crea una voce nel calendario Outlook dell'utente (stato "libero", nessun invito via email). Una postazione, come qualsiasi risorsa, può comunque essere collegata a una casella Exchange (*Workspace* o *Desk* di Places) impostando il campo "casella Exchange": in quel caso segue lo stesso flusso delle sale.
- **Serie ricorrenti e conflitti.** Con le impostazioni predefinite di Exchange (`AllowConflicts $false`, `MaximumConflictInstances 0`, `ConflictPercentageAllowed 0`) una serie con **anche un solo** conflitto viene **rifiutata per intero** dalla sala. Ritrovo quindi controlla prima ogni occorrenza e, se l'utente sceglie di saltare le occorrenze in conflitto, crea la serie **in segmenti** che escludono quelle date (una serie Outlook per segmento, una sola serie in Ritrovo), proponendo per ogni data in conflitto una sala alternativa come prenotazione singola. Questo comportamento non dipende da come è configurata la casella.

### 3.4 Permessi Graph (minimo privilegio)

Una sola registrazione app in Entra ID (client SPA + API + client riservato per OBO/app-only).

**Permessi delegati** (consenso amministratore per tutta l'organizzazione):

| Permesso | Perché serve | Alternativa scartata |
|----------|--------------|----------------------|
| `User.Read` | accesso SSO e profilo dell'utente connesso | — |
| `Calendars.ReadWrite` | creare, modificare e annullare le prenotazioni **nel calendario dell'utente**, leggere lo stato di risposta della sala, `getSchedule` delle sale | `Calendars.ReadWrite.Shared` non serve: Ritrovo non scrive nei calendari altrui con permessi delegati |
| `User.ReadBasic.All` | cercare un collega per la prenotazione "per conto di" e come partecipante (solo nome, email, foto di base) | `User.Read.All` espone troppi attributi |
| `Place.Read.All` | importare sale ed elenchi sale dal pannello di amministrazione | importazione manuale (resta possibile) |
| `openid`, `profile`, `offline_access` | richiesti in automatico da MSAL | — |

**Permessi applicativi** (servono per i job senza utente: rilascio automatico, sincronizzazione, pannello fuori-porta):

| Permesso | Perché serve | Come lo limitiamo |
|----------|--------------|-------------------|
| `Calendars.ReadWrite` (applicativo) | leggere i calendari delle sale (delta + webhook), rifiutare dal lato sala gli eventi senza check-in, creare prenotazioni immediate dal pannello | **Non** viene concesso in Entra ID a livello di tenant. Viene assegnato con **RBAC for Applications di Exchange Online** (ruolo `Application Calendars.ReadWrite`) con un *management scope* che include **solo le caselle risorsa gestite da Ritrovo** (filtro `CustomAttribute15 -eq 'Ritrovo'`, attributo impostato sulle caselle di sale e attrezzature; la procedura è in `03-installazione.md`). Microsoft Graph rimanda a questo meccanismo nella sezione "Limit mailbox access". Le concessioni Entra e RBAC si sommano: per questo il permesso applicativo **non** va aggiunto in Entra. |

Ritrovo non legge né modifica i calendari degli utenti senza un utente connesso.

### 3.5 Autenticazione e ruoli

- **Single sign-on Entra ID**: PWA con MSAL.js (redirect), add-in con NAA. Il server valida i JWT (firma via JWKS, emittente del tenant, audience = client ID o `api://<client-id>`, scope `access_as_user`).
- **Ruoli**: `utente` (predefinito), `reception`, `amministratore`. Si assegnano con i **ruoli app** di Entra ID (`Ritrovo.Reception`, `Ritrovo.Admin`) a utenti o gruppi in *Enterprise apps*; in alternativa l'amministratore li imposta nel pannello di amministrazione. Il primo amministratore si indica con `INITIAL_ADMIN_EMAILS`.
- **Pannelli fuori-porta e totem**: nessun account Microsoft sul tablet. L'amministratore genera un **link di abbinamento** con un token casuale (salvato solo come hash), valido solo per quella sala o edificio e revocabile.
- **Modalità demo** (`AUTH_MODE=dev`): login con utenti di esempio, ammessa **solo** con `GRAPH_MODE=mock`; il server rifiuta di avviarsi con combinazioni non sicure.

## 4. Modello dati

Tutti gli orari sono `timestamptz` in UTC.

| Tabella | Campi principali | Note |
|---------|------------------|------|
| `app_user` | id, entra_oid, email, display_name, department, role, hide_from_colleagues, last_login_at | creato al primo accesso SSO |
| `building`, `floor` | nome, indirizzo; piano con immagine planimetria (SVG/PNG in DB, max 2 MB) | |
| `resource` | kind (`room`/`desk`/`asset`), name, mailbox_email (facoltativa), floor, capacity, features[], map_x/map_y (0–1), qr_token, regole: check_in_required, check_in_grace_minutes, max_duration_minutes, booking_window_days | `mailbox_email` presente = calendario Exchange fonte di verità |
| `booking` | resource, organizer, booked_for, created_by, title, start_at, end_at, effective_end_at, status, source, series_id, proposal_id, ical_uid, organizer_event_id, resource_event_id, user_event_id, checked_in_at, checked_out_at, released_at, release_reason, exchange_released, anonymized | stati: `pending`, `confirmed`, `tentative`, `completed`, `released`, `cancelled`, `declined` |
| `booking_series` | pattern (giornaliero/settimanale, intervallo, giorni, fine), segmenti Graph | |
| `proposal` | utente, titolo, stato (`open`/`confirmed`/`expired`/`cancelled`), scadenza | |
| `facility_request` | richiedente, categoria, descrizione, risorsa/luogo, stato, assegnatario, nota di chiusura | modulo Care |
| `kiosk_device` | nome, sala o edificio, hash del token, ultimo contatto, revoca | |
| `graph_subscription`, `sync_state` | id sottoscrizione, scadenza, clientState; deltaLink per casella | |
| `user_favorite` | postazioni preferite | |
| `setting` | impostazioni globali (tolleranza, orario lavorativo, conservazione dati…) | |
| `audit_log` | chi, cosa, quando | conservazione limitata |

## 5. Flussi principali

1. **Prenotazione di una sala** (web, add-in, QR): controllo regole → controllo conflitti nel DB (con lock sulla risorsa) → `getSchedule` sulla casella della sala → in caso di conflitto risposta con **alternative** (altre sale libere di capienza adeguata e prossimi orari liberi della stessa sala) → altrimenti evento creato nel calendario dell'organizzatore con la sala come risorsa → stato `pending` finché la sala non accetta (in Exchange l'elaborazione è asincrona) → `confirmed` quando la copia compare nel calendario della sala (verifica immediata + webhook/delta), `declined` se la sala rifiuta.
2. **Prenotazione "per conto di"** (reception): l'organizzatore Exchange è la reception, il beneficiario è invitato come partecipante obbligatorio, quindi la riunione compare nel calendario del beneficiario. Ritrovo registra `created_by` (reception) e `booked_for` (beneficiario), che può fare check-in.
3. **Check-in**: da 10 minuti prima dell'inizio fino alla fine del periodo di tolleranza (valori predefiniti: 10 + 10 minuti, configurabili per risorsa). Possibile da PWA, add-in, QR code/NFC o pannello fuori-porta.
4. **Rilascio automatico (no-show)**: un job ogni minuto rilascia le prenotazioni senza check-in oltre la tolleranza. Per le sale, la **sala rifiuta l'evento** (`decline` lato sala, con commento): la sala torna libera e l'organizzatore riceve la notifica. È lo stesso schema usato da Microsoft per il rilascio automatico delle sale sui Teams panels. L'evento resta nel calendario dell'organizzatore con la sala segnata come rifiutata.
5. **Check-out anticipato**: chiude l'uso effettivo (`effective_end_at`); per le sale, rifiuto lato sala, così il tempo rimanente torna libero in Exchange; nel DB la parte non usata smette di bloccare nuove prenotazioni.
6. **Ricorrenze**: espansione delle occorrenze nel fuso `Europe/Rome`, controllo di ogni occorrenza, scelta dell'utente sulle occorrenze in conflitto (saltare, oppure usare la sala alternativa proposta), creazione per segmenti (§3.3).
7. **Proposte di prenotazione**: fino a 3 opzioni bloccate come eventi *provvisori* (`showAs: tentative`, oggetto con prefisso "[Proposta]"); alla conferma, l'opzione scelta diventa definitiva e le altre vengono annullate dall'organizzatore (le sale tornano libere). Le proposte non confermate scadono (predefinito 24 ore e comunque prima dell'inizio della prima opzione) e vengono rilasciate lato sala.
8. **Postazioni**: planimetria interattiva, prenotazione per uno o più giorni, preferite, "trova un collega" (disattivabile per singolo utente), doppia prenotazione impossibile (lock sulla risorsa + controllo di sovrapposizione).
9. **QR code e NFC**: ogni risorsa ha un URL univoco `https://<dominio>/q/<token>` stampabile come QR code; lo stesso URL si scrive su un tag NFC (record NDEF di tipo URI). L'URL apre la scheda della risorsa: stato, agenda del giorno, "Prenota ora", check-in e check-out.
10. **Pannello fuori-porta e totem**: viste a schermo intero per tablet (stato libera/occupata, riunione in corso, prossime riunioni, check-in, check-out, prenotazione immediata di 15/30/60 minuti); il totem mostra lo stato di tutte le sale di un edificio.
11. **Care**: richieste (categoria, descrizione, luogo) con stati *aperta → in lavorazione → risolta → chiusa*, gestite da reception e amministratori.

## 6. Strategia di sincronizzazione

| Direzione | Meccanismo |
|-----------|-----------|
| Ritrovo → Outlook | scrittura immediata via Graph (delegato) al momento della prenotazione |
| Outlook → Ritrovo | **webhook** (change notifications) su `/users/{sala}/events` per ogni casella risorsa + **delta query** su `calendarView` (finestra: da ieri a +180 giorni) per la riconciliazione |
| Rinnovo | le sottoscrizioni agli eventi Outlook durano al massimo **10.080 minuti** (meno di 7 giorni): un job rinnova quelle in scadenza entro 24 ore; le *lifecycle notifications* (`reauthorizationRequired`, `subscriptionRemoved`, `missed`) causano rinnovo, ricreazione o delta immediata |
| Senza URL pubblico | se il server non è raggiungibile da Internet (`GRAPH_WEBHOOKS_ENABLED=false`), Ritrovo usa solo il polling delta (predefinito ogni 2 minuti) |
| Riconciliazione | ogni 15 minuti delta su tutte le caselle anche con i webhook attivi; la finestra della delta viene rigenerata ogni giorno |
| Throttling | rispetto di HTTP 429/503 con `Retry-After`, backoff esponenziale con jitter, **massimo 4 richieste concorrenti per casella** (limite Outlook per app e casella; altro limite: 10.000 richieste in 10 minuti) |
| Fusi orari | memorizzazione in UTC, `Prefer: outlook.timezone="UTC"` nelle letture, visualizzazione in `Europe/Rome` |

Regole di riconciliazione per un evento letto dal calendario di una sala:

- `iCalUId` già noto → aggiornamento di orari, titolo e stato (`confirmed`); se l'evento non c'è più (`@removed`) → `cancelled`, salvo che sia già `released` o `completed`;
- `iCalUId` sconosciuto → nuova prenotazione con `source = outlook`, organizzatore collegato all'utente se l'email è nota. Anche queste prenotazioni seguono le regole di check-in e rilascio automatico.

## 7. Sicurezza

- Nessun segreto nel repository: `.env.example` contiene solo segnaposto; `.gitignore` esclude `.env`, certificati e chiavi. Il client riservato usa preferibilmente un **certificato** (in alternativa un client secret con scadenza breve).
- Tutto il traffico è in HTTPS (requisito degli add-in); i webhook verificano `clientState` e rispondono al `validationToken`.
- Controllo dei ruoli lato server su ogni endpoint (`utente`, `reception`, `amministratore`); il pannello di amministrazione è inaccessibile ai non amministratori (test di accettazione n. 11).
- Token dei pannelli: 256 bit casuali, salvati come hash SHA-256, revocabili; operazioni limitate alla sala o all'edificio abbinato.
- Intestazioni di sicurezza (CSP, `X-Content-Type-Options`, `Referrer-Policy`); per le pagine dell'add-in nessun blocco del framing, perché Outlook le carica in un iframe.
- Registro di audit per le azioni amministrative e i rilasci; nei log non compaiono token né il contenuto delle riunioni.

## 8. Privacy e GDPR

| Dato | Base e finalità | Minimizzazione | Conservazione |
|------|-----------------|----------------|---------------|
| Identità (nome, email, reparto) | gestione delle prenotazioni per il rapporto di lavoro | solo i campi di base da Entra ID | finché l'utente è attivo |
| Prenotazioni e check-in (dato di presenza) | organizzazione degli spazi | il titolo può essere nascosto sui pannelli; nessuna posizione GPS, nessun Bluetooth | **anonimizzazione dopo 180 giorni** (configurabile): restano risorsa, orari ed esito, senza persona né titolo |
| KPI | pianificazione degli spazi | **solo aggregati** per risorsa, tipo, fascia oraria; nessun report per persona | illimitata (dati anonimi) |
| "Trova un collega" | collaborazione | solo postazione e giorno, mai le riunioni; ogni utente può nascondersi | come le prenotazioni |
| Audit log | sicurezza | azione, oggetto, autore | 365 giorni (configurabile) |
| Monitoring (fase 2) | occupazione degli spazi | **solo conteggi** dai sensori; **mai video**, mai immagini, nessun identificativo personale | aggregazione oraria |

Note: il trattamento dei dati di presenza dei dipendenti in Italia richiede di valutare anche l'art. 4 dello Statuto dei lavoratori (L. 300/1970) per gli strumenti da cui può derivare un controllo a distanza. Va coinvolto il DPO o il consulente privacy prima di attivare il check-in obbligatorio e, in fase 2, i sensori. È predisposta una bozza di informativa in `docs/04-uso.md`. Questa nota non è una consulenza legale.

## 9. Tabella di tracciabilità

Legenda: **MVP** = implementato; **Fase 2** = progettato, non implementato; **Fuori ambito** = escluso, con motivo. Gli ID sono quelli di `01-analisi.md`.

| ID | Funzionalità | Esito | Dove / motivo |
|----|--------------|-------|---------------|
| P-01 | Suite modulare | MVP | moduli Sale, Postazioni, Risorse, Richieste; Monitoring in fase 2 |
| P-02 | Pannello di amministrazione unico | MVP | `/admin`: risorse, edifici/piani, regole, utenti, pannelli, impostazioni, sincronizzazione |
| P-03 | Regole di prenotazione | MVP | per risorsa: durata massima, finestra di prenotazione, check-in obbligatorio, tolleranza |
| P-04 | Limite persone per spazio | MVP | capienza della risorsa, filtro di ricerca, avviso se i partecipanti superano la capienza |
| P-05 | Regole di controllo presenze | MVP | check-in obbligatorio, tolleranza, apertura anticipata del check-in |
| P-06 | Monitoraggio in tempo reale e allarmi | MVP (parziale) + Fase 2 | stato in tempo reale di sale e postazioni (libera/occupata/no-show) nella dashboard; allarmi da sensori in fase 2 |
| P-07 | Dashboard, report, KPI | MVP | occupazione, no-show, ore di punta, utilizzo per risorsa, esportazione CSV |
| P-08 | KPI anti-affollamento | Fase 2 | servono i sensori (Monitoring) |
| R-01 | Prenotazione sale rapida | MVP | PWA, add-in Outlook, QR |
| R-02 | Check-in sale | MVP | PWA, add-in, QR/NFC, pannello |
| R-03 | Liberazione sale non usate | MVP | rilascio automatico (test n. 3) |
| R-04 | Integrazione Exchange/Office 365 | MVP | Microsoft Graph (mai EWS). **G Suite fuori ambito**: l'ufficio usa Microsoft 365 |
| R-05 | Filtri di ricerca avanzati | MVP | capienza, dotazioni, edificio, piano, disponibilità nell'intervallo |
| R-06 | Check-out | MVP | test n. 4 |
| R-07 | Prenotazione "per conto di" | MVP | ruolo reception (test n. 7) |
| R-08 | Agenda impegni personale | MVP | "Le mie prenotazioni" (PWA e add-in) |
| R-09 | NFC/QR vicino alla sala | MVP | QR stampabile; stesso URL su tag NFC |
| R-10 | Proposte di prenotazione | MVP | test n. 6 |
| R-11 | Prenotazioni ricorrenti | MVP | giornaliere/settimanali (test n. 5) |
| R-12 | Integrazione con sistemi di collaborazione | MVP (Teams) | riunione Teams nella prenotazione; altri sistemi non specificati: fuori ambito |
| R-13 | Canali: pannello, web, mobile, client di posta, totem | MVP | pannello fuori-porta, PWA, add-in Outlook, vista totem |
| R-14 | Digital signage | MVP (via URL) | la vista totem è un URL apribile da qualsiasi player di signage con browser |
| R-15 | Controllo accessi e building automation | Fase 2 | servono hardware e protocolli di campo non presenti in ufficio |
| D-01 | Planimetrie interattive | MVP | caricamento SVG/PNG e posizionamento delle postazioni con un clic |
| D-02 | Prenotazione su più giorni | MVP | intervallo di date → una prenotazione per giorno lavorativo |
| D-03 | Check-in/out anche da remoto | MVP | da PWA/add-in (remoto) o QR (in presenza) |
| D-04 | Check-in NFC, QR, beacon BLE | MVP (QR, NFC) / Fase 2 (BLE) | il BLE richiede un'app nativa |
| D-05 | Postazioni preferite | MVP | stella sulla planimetria e nell'elenco |
| D-06 | Trova un collega | MVP | ricerca per nome con evidenziazione sulla planimetria; ogni utente può nascondersi |
| D-07 | Check-in di prossimità automatico | Fase 2 | richiede app nativa con posizione/Bluetooth in background e una valutazione privacy |
| B-01 | Prenotazione asset condivisi | MVP | risorse di tipo asset, con o senza casella *Equipment* (test n. 9) |
| V-01 | Auto aziendali e chiavi | MVP (parziale) | l'auto è un asset prenotabile; check-in/check-out = ritiro e riconsegna delle chiavi; integrazione con armadietti delle chiavi in fase 2 |
| C-01 | Richieste aziendali | MVP | modulo Richieste (gestione semplice con stati) |
| M-01…M-08 | Monitoring | Fase 2 | interfaccia `OccupancySource` (solo conteggi), endpoint di ingestione, modello spazi (m², persone massime, densità); nessun video |
| BC-01…BC-04 | Biglietto da visita digitale | Fase 2 | profilo da Entra ID (`User.ReadBasic.All` già presente) e QR univoco |
| A-01…A-03 | App iOS/Android | MVP come PWA | ipotesi 4 del mandato: PWA installabile al posto delle app native |
| A-04 | Dati trattati dall'app | MVP | informativa e minimizzazione (§8) |

Ogni voce "confermata" di Room, Desk, BookMe e amministrazione/report è implementata nell'MVP oppure motivata (D-04 BLE e D-07 prossimità: servono app native; P-06 allarmi e P-08: servono sensori).

## 10. Ambito: MVP e fase 2

**MVP (questa consegna)**

- Server API, PostgreSQL, gateway Graph reale e mock dietro la stessa interfaccia.
- PWA in italiano (struttura i18n pronta per altre lingue): prenotazione di sale, postazioni e risorse, le mie prenotazioni, proposte, richieste, area reception.
- Pannello di amministrazione con KPI ed esportazione CSV.
- Pannello fuori-porta, totem, pagine QR.
- Add-in Outlook (manifest XML, NAA).
- Job: rilascio automatico, scadenza proposte, rinnovo sottoscrizioni, delta, anonimizzazione.
- Avvio con un comando (`docker compose up`) con dati di esempio e Graph in modalità mock; 11 test di accettazione automatici.

**Fase 2**

- Monitoring con sensori (solo conteggi), allarmi in tempo reale, KPI anti-affollamento.
- Biglietto da visita digitale.
- Check-in BLE e di prossimità (app native).
- Controllo accessi, armadietti per le chiavi, building automation.
- Manifest unificato JSON quando sarà supportato su Mac e mobile.
- Notifiche email/Teams proattive (richiedono `Mail.Send` o un bot, da valutare).

## 11. Fonti Microsoft verificate

Verificate il 13/10/2026 sui repository GitHub da cui Microsoft Learn viene pubblicato (`learn.microsoft.com` è bloccato dalla policy di rete di questo ambiente). Revisioni: `OfficeDev/office-js-docs-pr` 123de8e (09/10/2026), `microsoftgraph/microsoft-graph-docs-contrib` 2ae7381 (13/10/2026), `MicrosoftDocs/office-docs-powershell` (30/09/2026), `MicrosoftDocs/entra-docs` (12/10/2026), `MicrosoftDocs/microsoft-365-docs`, `OfficeDev/office-js-docs-reference`.

| Argomento | Pagina Microsoft Learn |
|-----------|------------------------|
| Tipi di manifest | https://learn.microsoft.com/office/dev/add-ins/develop/add-in-manifests |
| Supporto del manifest unificato per piattaforma | https://learn.microsoft.com/office/dev/add-ins/develop/unified-manifest-overview#client-and-platform-support |
| NAA | https://learn.microsoft.com/office/dev/add-ins/develop/enable-nested-app-authentication-in-your-add-in |
| Requisito NestedAppAuth 1.1 per client | https://learn.microsoft.com/javascript/api/requirement-sets/common/nested-app-auth-requirement-sets |
| Token legacy Exchange disattivati | https://learn.microsoft.com/office/dev/add-ins/outlook/faq-nested-app-auth-outlook-legacy-tokens |
| Add-in su mobile | https://learn.microsoft.com/office/dev/add-ins/outlook/outlook-mobile-addins |
| Validazione del manifest | https://learn.microsoft.com/office/dev/add-ins/testing/troubleshoot-manifest |
| Distribuzione (Integrated apps) | https://learn.microsoft.com/microsoft-365/admin/manage/manage-deployment-of-add-ins |
| getSchedule (permessi) | https://learn.microsoft.com/graph/api/calendar-getschedule |
| findMeetingTimes (solo delegato) | https://learn.microsoft.com/graph/api/user-findmeetingtimes |
| decline / cancel | https://learn.microsoft.com/graph/api/event-decline, https://learn.microsoft.com/graph/api/event-cancel |
| Evento (iCalUId, transactionId, Teams) | https://learn.microsoft.com/graph/api/resources/event |
| Fusi orari supportati | https://learn.microsoft.com/graph/api/resources/datetimetimezone |
| Delta query su calendarView | https://learn.microsoft.com/graph/delta-query-events |
| Notifiche Outlook e durata sottoscrizioni | https://learn.microsoft.com/graph/outlook-change-notifications-overview, https://learn.microsoft.com/graph/change-notifications-overview#subscription-lifetime |
| Throttling Outlook | https://learn.microsoft.com/graph/throttling-limits#outlook-service-limits |
| Places API (room, workspace, desk) | https://learn.microsoft.com/graph/api/resources/places-api-overview |
| Limitare l'accesso alle caselle (RBAC for Applications) | https://learn.microsoft.com/exchange/permissions-exo/application-rbac |
| `Set-CalendarProcessing` | https://learn.microsoft.com/powershell/module/exchangepowershell/set-calendarprocessing |
| `Set-Mailbox -Type` (Desk/Workspace) | https://learn.microsoft.com/powershell/module/exchangepowershell/set-mailbox |
| `New-ManagementRoleAssignment -App`, `New-ServicePrincipal`, `Test-ServicePrincipalAuthorization` | https://learn.microsoft.com/powershell/module/exchangepowershell/new-managementroleassignment |
| Registrazione app, esposizione API, ruoli app, credenziali | https://learn.microsoft.com/entra/identity-platform/quickstart-register-app |
| Rilascio automatico delle sale (schema Microsoft) | https://learn.microsoft.com/microsoftteams/devices/check-in-and-auto-release |
| Ritiro di EWS in Exchange Online (dal 01/10/2026, definitivo dal 01/04/2027) | https://learn.microsoft.com/exchange/clients-and-mobile-in-exchange-online/deprecation-of-ews-exchange-online |

**Non verificato**: requisiti di licenza di Microsoft Places per le postazioni Exchange; il comportamento esatto di Exchange dopo un `decline` lato sala (rimozione dal calendario della sala). Ritrovo gestisce entrambi i casi: dopo il `decline` controlla l'evento e, se è ancora presente, lo elimina dal calendario della sala.
