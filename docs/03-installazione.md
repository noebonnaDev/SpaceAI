# 03 — Guida di installazione per l'amministratore IT

> Documento della fase D. Aggiornato al 13/10/2026.
> Destinatario: l'amministratore IT dell'ufficio. Non serve saper programmare. Servono però i diritti di amministratore su Microsoft 365 e un server Linux.

## Prima di iniziare

**Cosa fa questa guida.** Porta Ritrovo dalla modalità demo all'uso reale. Al termine, Ritrovo legge e scrive i calendari Exchange del tuo tenant, gli utenti accedono con l'account Microsoft 365 e l'add-in compare in Outlook.

**Cosa non fa Ritrovo da solo.** Ritrovo non modifica il tenant e non crea niente nel cloud. Tutti i passi nel tenant (registrazione dell'app, consenso, caselle delle sale, permessi Exchange, distribuzione dell'add-in) li esegui tu, nell'ordine indicato. Nessuno di questi passi è stato fatto per te.

**Segnaposto.** Tutto ciò che è scritto tra `< >` è un valore tuo, per esempio `<host>` = `prenotazioni.azienda.it`. Non esistono valori predefiniti per tenant, client ID, segreti o domini: vanno presi dal tuo tenant, nei punti indicati.

**Nomi dei menu.** I percorsi sono quelli della documentazione Microsoft Learn al 13/10/2026 (fonti in fondo), con le voci in inglese. Se il portale è in italiano le voci sono tradotte, ma le traduzioni non sono state verificate. Microsoft rinomina spesso i menu: se una voce non c'è, apri la pagina Microsoft citata nel passo.

**Tempo stimato.** 2–3 ore di lavoro, più i tempi di attesa di Microsoft (fino a 72 ore perché l'add-in compaia a tutti).

### Riepilogo dei passi

| # | Passo | Dove | Chi |
|---|-------|------|-----|
| 0 | Provare la demo (facoltativo) | il tuo PC | chiunque |
| 1 | Prerequisiti, nome DNS e HTTPS | DNS aziendale, server | IT |
| 2 | Registrare l'applicazione | Microsoft Entra admin center | Cloud Application Administrator |
| 3 | Caselle delle sale e delle attrezzature | Microsoft 365 admin center + Exchange PowerShell | Exchange Administrator |
| 4 | Limitare l'accesso dell'app alle sole caselle risorsa | Exchange PowerShell | Exchange Administrator |
| 5 | (Facoltativo) Abilitare Microsoft Places per l'importazione | PowerShell MicrosoftPlaces | amministratore Places |
| 6 | Installare Ritrovo sul server | server Linux | IT |
| 7 | Primo accesso e configurazione | Ritrovo → Amministrazione | amministratore di Ritrovo |
| 8 | Distribuire l'add-in Outlook | Microsoft 365 admin center | Exchange Administrator con ruolo Application Administrator |
| 9 | Pannelli, totem, QR code e NFC | Ritrovo + tablet | IT / reception |
| 10 | Backup | server | IT |
| 11 | Privacy (prima dell'avvio) | DPO / consulente | titolare del trattamento |

---

## 0. Provare la demo (facoltativo, 5 minuti)

Su un PC con Docker Desktop (o Docker Engine con Compose v2):

```bash
git clone <indirizzo-del-repository> ritrovo
cd ritrovo
docker compose up
```

Apri `http://localhost:8080` e scegli un utente di esempio: *Giulia Rinaldi* (amministratrice), *Paolo Ferri* (reception) o un dipendente. In modalità demo Exchange è **simulato**: nessuna email parte e nessun calendario reale viene toccato. Per fermare la demo: `Ctrl+C`, poi `docker compose down -v` (`-v` cancella anche i dati di esempio).

---

## 1. Prerequisiti

### 1.1 Account e ruoli Microsoft 365

| Attività | Ruolo minimo necessario | Fonte |
|----------|------------------------|-------|
| Registrare l'app, creare ruoli e scope | Application Developer (registrazione); Cloud Application Administrator (esposizione API) | Entra: *Register an application*, *Expose a web API* |
| Consenso amministratore ai permessi **delegati** di Microsoft Graph | Cloud Application Administrator o Application Administrator | Entra: *Grant tenant-wide admin consent* |
| Creare le caselle delle sale, `Set-CalendarProcessing`, RBAC for Applications | Exchange Administrator (o Global Administrator) | Exchange PowerShell |
| Distribuire l'add-in | Exchange Administrator con in più il ruolo Application Administrator (o la proprietà *App Registrations* abilitata) | Microsoft 365: *Centralized deployment of add-ins*, sezione *Admin requirements* |

Un *Global Administrator* può eseguire tutti i passi, ma per il principio del minimo privilegio è meglio usare i ruoli indicati. Ritrovo **non** chiede permessi applicativi di Microsoft Graph in Entra, quindi non serve il ruolo *Privileged Role Administrator*.

**Licenze.** Le caselle di sale e attrezzature non richiedono licenza (FAQ Microsoft *Room and equipment mailboxes*). Gli utenti di Ritrovo usano la loro licenza Microsoft 365 con Exchange Online.

### 1.2 Server

- Una VM Linux (per esempio Ubuntu Server LTS) oppure un server on-premises, con **Docker Engine** e **Docker Compose v2.24 o successivo** (serve per la direttiva `!reset` di `docker-compose.prod.yml`). Per controllare: `docker compose version`.
- Risorse indicative per un ufficio fino a 100 persone: 2 vCPU, 4 GB di RAM, 20 GB di disco. Sono una stima, non una misura.
- `git` e `openssl`, normalmente già presenti.

### 1.3 Nome DNS e certificato HTTPS

L'add-in Outlook e l'accesso Microsoft funzionano **solo in HTTPS**. Scegli un nome, per esempio `prenotazioni.azienda.it`, e crea un record DNS A/AAAA verso il server.

Hai due possibilità:

| Scenario | Certificato | Notifiche in tempo reale da Exchange |
|----------|-------------|---------------------------------------|
| **A. Server raggiungibile da Internet** (porte 80 e 443 aperte) | automatico e gratuito con Let's Encrypt, gestito da Caddy (incluso) | sì: `GRAPH_WEBHOOKS_ENABLED=true` |
| **B. Server solo nella rete interna** | certificato aziendale (`ritrovo.crt` e `ritrovo.key` nella cartella `secrets/`) | no: Ritrovo interroga Exchange ogni 2 minuti (`GRAPH_WEBHOOKS_ENABLED=false`) |

Nello scenario B, Outlook su smartphone funziona solo se il telefono raggiunge la rete interna (VPN o Wi-Fi aziendale). Nello scenario A, solo il traffico HTTPS va esposto; il database resta nella rete interna di Docker.

---

## 2. Registrare l'applicazione in Microsoft Entra ID

Fonte: *Quickstart: Register an application* e pagine collegate. Accedi a **https://entra.microsoft.com**. Se gestisci più tenant, usa l'icona **Settings** in alto per passare al tenant giusto.

### 2.1 Nuova registrazione

1. **Entra ID** > **App registrations** > **New registration**.
2. **Name**: `Ritrovo` (gli utenti vedranno questo nome).
3. **Supported account types**: **Single tenant only - <nome del tuo tenant>**.
4. Lascia vuoto il redirect URI per ora. Seleziona **Register**.
5. Nella pagina **Overview** annota questi due valori:
   - **Application (client) ID** → in `.env` diventa `ENTRA_CLIENT_ID`;
   - **Directory (tenant) ID** → in `.env` diventa `ENTRA_TENANT_ID`.

### 2.2 Indirizzi di ritorno (redirect URI)

Fonte: *How to add a redirect URI*; *Enable nested app authentication* (per l'add-in).

1. Nella registrazione: **Manage** > **Authentication**.
2. Scheda **Redirect URI configuration** > **Add Redirect URI** > riquadro **Single-page application**.
3. Inserisci `https://<host>/redirect.html` e seleziona **Configure**.
4. Ripeti **Add Redirect URI** > **Single-page application** e inserisci `brk-multihub://<host>`.
   È il redirect che permette all'add-in di ottenere l'accesso dentro Outlook senza chiedere di nuovo la password (NAA, *nested app authentication*). Indica solo il dominio, senza percorsi: per esempio `brk-multihub://prenotazioni.azienda.it`.

Non aggiungere altri tipi di piattaforma.

### 2.3 Esporre l'API di Ritrovo

Fonte: *Configure an application to expose a web API*.

1. **Expose an API** > accanto ad **Application ID URI** seleziona **Add**: lascia il valore proposto `api://<client-id>` > **Save**.
2. **Add a scope** e compila:
   - **Scope name**: `access_as_user` (esattamente così);
   - **Who can consent**: **Admins and users**;
   - **Admin consent display name**: `Accedere a Ritrovo come utente connesso`;
   - **Admin consent description**: `Consente a Ritrovo di gestire le prenotazioni dell'utente connesso.`;
   - **User consent display name** e **User consent description**: gli stessi testi;
   - **State**: **Enabled**.
3. Seleziona **Add scope**.

### 2.4 Ruoli dell'applicazione (reception e amministratori)

Fonte: *Add app roles to your application*.

1. **App roles** > **Create app role**, due volte:

   | Display name | Allowed member types | Value | Description |
   |--------------|---------------------|-------|-------------|
   | Ritrovo amministratore | **Users/Groups** | `Ritrovo.Admin` | Gestione di risorse, regole, report e utenti |
   | Ritrovo reception | **Users/Groups** | `Ritrovo.Reception` | Prenotazioni per conto di altri e gestione delle richieste |

2. Per ciascun ruolo spunta la casella che abilita il ruolo e seleziona **Apply**.

I valori in **Value** devono essere scritti esattamente così: Ritrovo li riconosce nel token. Chi non ha ruoli è un utente normale.

### 2.5 Permessi API e consenso amministratore

Fonte: *Configure a client application to access a web API*; *Grant tenant-wide admin consent*.

1. **API permissions** > **Add a permission** > **Microsoft Graph** > **Delegated permissions**, poi spunta:
   - `User.Read` (già presente);
   - `Calendars.ReadWrite`;
   - `User.ReadBasic.All`;
   - `Place.Read.All`;
   - `offline_access`, `openid`, `profile`.
   
   Seleziona **Add permissions**.
2. **Add a permission** > **My APIs** > **Ritrovo** > **Delegated permissions** > spunta `access_as_user` > **Add permissions**.
3. Seleziona **Grant admin consent for <nome del tenant>** > **Yes**. Poi **Refresh**: nella colonna **Status** deve comparire **Granted for <nome del tenant>** su ogni riga.

> **Importante: non aggiungere permessi di tipo "Application" per Microsoft Graph** (in particolare `Calendars.ReadWrite` applicativo). Ritrovo riceve l'accesso applicativo **solo alle caselle delle sale**, tramite Exchange (passo 4). Un permesso applicativo concesso qui varrebbe per **tutte** le caselle dell'organizzazione e annullerebbe la restrizione, perché i permessi di Entra e quelli di Exchange si sommano.

Perché serve ciascun permesso: vedi `02-progetto.md`, §3.4.

### 2.6 Credenziale del server (certificato consigliato)

Il server di Ritrovo si identifica presso Microsoft con un **certificato** (consigliato) oppure con un **client secret**. Fonte: *Add and manage application credentials*.

**Opzione consigliata: certificato.** Sul server, nella cartella di Ritrovo (vedi passo 6.1):

```bash
cd /opt/ritrovo/secrets
openssl req -x509 -newkey rsa:2048 -sha256 -days 730 -nodes \
  -keyout ritrovo-app.key -out ritrovo-app.crt -subj "/CN=Ritrovo"
sudo chown 1000:1000 ritrovo-app.key ritrovo-app.crt   # l'app nel container gira come utente 1000
chmod 600 ritrovo-app.key
```

Poi in Entra: **App registrations** > **Ritrovo** > **Certificates & secrets** > **Certificates** > **Upload certificate**. Carica **solo** `ritrovo-app.crt` (mai il file `.key`) e seleziona **Add**. Il certificato vale 2 anni: annota in agenda la data di scadenza e ripeti questo passo prima che scada.

**Alternativa: client secret.** **Certificates & secrets** > **Client secrets** > **New client secret**, poi scegli una scadenza breve (per esempio 6 mesi) e seleziona **Add**. Copia subito la colonna **Value**: dopo che lasci la pagina non viene più mostrata. In `.env` va in `ENTRA_CLIENT_SECRET`.

### 2.7 Assegnare i ruoli a reception e amministratori

Fonte: *Add app roles… > Assign users and groups to roles*.

1. **Entra ID** > **Enterprise apps** > **All applications** > **Ritrovo**.
2. **Manage** > **Users and groups** > **Add user** (oppure **Add user/group**).
3. **Users and groups**: scegli le persone o i gruppi > **Select**.
4. **Select a role**: scegli `Ritrovo amministratore` o `Ritrovo reception` > **Select** > **Assign**.

Facoltativo: per permettere l'accesso solo ad alcune persone, in **Enterprise apps** > **Ritrovo** > **Properties** imposta **Assignment required?** su **Yes**. In quel caso devi assegnare **tutti** gli utenti (o un gruppo che li contiene), non solo reception e amministratori.

In alternativa, i ruoli si possono assegnare anche dentro Ritrovo (**Amministrazione** > **Utenti e ruoli**). Vale il ruolo più alto tra i due.

### 2.8 Annotazione per l'add-in (Object ID)

Per il passo 4 ti serve l'**Object ID dell'applicazione aziendale**, che è diverso da quello della registrazione:
**Entra ID** > **Enterprise apps** > **All applications** > **Ritrovo** > **Overview** (o **Properties**) > **Object ID**.

---

## 3. Caselle delle sale e delle attrezzature

**Principio:** ogni sala riunioni (e ogni attrezzatura che vuoi vedere in Outlook, come un'auto aziendale o un proiettore) è una **casella risorsa** di Exchange. Le prenotazioni sono eventi del suo calendario. Le **postazioni** invece sono gestite solo da Ritrovo e non richiedono caselle (motivo in `02-progetto.md`, §3.3).

### 3.1 Creare le caselle (se non esistono già)

Fonte: *Room and equipment mailboxes*.

1. Accedi a **https://admin.microsoft.com**.
2. **… Show all** > **Resources** > **Rooms & equipment** > **+ Add resource**.
3. Compila: **Room** (sala) o **Equipment** (attrezzatura), **Name**, **Email** (per esempio `sala.verde@azienda.it`), **Capacity**, **Location**, **Phone number** (facoltativo).
4. Seleziona **Save**.

Ripeti per ogni sala o attrezzatura. Consiglio di Microsoft: blocca l'accesso diretto a queste caselle (vedi *Block sign-in for the shared mailbox account*).

### 3.2 Collegarsi a Exchange Online PowerShell

Su un PC Windows con PowerShell 7 (o Windows PowerShell 5.1), una volta sola:

```powershell
Install-Module -Name ExchangeOnlineManagement -Scope CurrentUser
```

Poi, ogni volta:

```powershell
Connect-ExchangeOnline -UserPrincipalName <tuo-account-admin@azienda.it>
```

### 3.3 Regole di prenotazione delle caselle e marcatura per Ritrovo

Per **ogni** casella di sala o attrezzatura che Ritrovo deve gestire:

```powershell
Set-CalendarProcessing -Identity "<email-della-sala>" -AutomateProcessing AutoAccept -AllowConflicts $false `
  -BookingWindowInDays 180 -MaximumDurationInMinutes 480 -AllowRecurringMeetings $true -ProcessExternalMeetingMessages $false

Set-Mailbox -Identity "<email-della-sala>" -CustomAttribute15 "Ritrovo"
```

- `AutoAccept` + `AllowConflicts $false`: la sala accetta da sola le richieste libere e rifiuta quelle in conflitto, anche se arrivano da Outlook senza passare da Ritrovo.
- `BookingWindowInDays` (anticipo massimo in giorni) e `MaximumDurationInMinutes` (durata massima) vanno allineati alle regole che imposti in Ritrovo: i valori sopra sono quelli predefiniti di Ritrovo, 180 giorni e 8 ore. Dopo aver creato le risorse in Ritrovo, in **Amministrazione** > **Risorse** > *modifica risorsa* trovi già i comandi pronti con i valori giusti (sezione **Allineamento Exchange (PowerShell)**).
- `CustomAttribute15 "Ritrovo"` **marca** la casella: al passo 4 l'accesso dell'app viene limitato alle sole caselle con questa marcatura. Se l'attributo 15 è già usato per altro nella tua organizzazione, scegli un altro attributo (da 1 a 15) e adegua il filtro del passo 4.

Per controllare le caselle marcate:

```powershell
Get-Mailbox -RecipientTypeDetails RoomMailbox,EquipmentMailbox -ResultSize Unlimited | Where-Object CustomAttribute15 -eq "Ritrovo" | Format-Table DisplayName,PrimarySmtpAddress
```

Nota sulla privacy: con le impostazioni predefinite di Exchange, nel calendario della sala l'oggetto della riunione viene sostituito dal nome dell'organizzatore (`AddOrganizerToSubject`, `DeleteSubject`). Ritrovo funziona in entrambi i casi, quindi lascia questi valori come sono, salvo esigenze diverse.

### 3.4 Postazioni: nessuna casella necessaria

Per le postazioni **non serve creare caselle**. Ritrovo le gestisce direttamente: planimetria, regole e check-in. Quando un dipendente prenota una postazione, nel suo calendario Outlook compare una voce informativa (disattivabile in **Amministrazione** > **Regole**).

Le caselle Exchange di tipo *Desk* o *Workspace* esistono, ma per essere prenotabili vanno create e configurate con **Microsoft Places** (`New-Place`, `Set-PlaceV3`; vedi la pagina di `Set-Mailbox`, parametro `-Type`). I requisiti di licenza di Places non sono stati verificati. Se la tua organizzazione usa già postazioni o workspace di Places con casella, puoi collegarli a Ritrovo così:

1. esegui per ciascuna casella il passo 3.3, compresa la marcatura `CustomAttribute15`;
2. in Ritrovo indica l'email della casella nel campo **Casella Exchange** della postazione.

La postazione seguirà poi lo stesso flusso delle sale. Configurare Microsoft Places non rientra in questa guida.

---

## 4. Limitare l'accesso dell'app alle sole caselle risorsa (RBAC for Applications)

Senza un utente connesso, Ritrovo deve leggere e aggiornare i calendari delle sale: per la sincronizzazione, per il rilascio automatico dei no-show e per le prenotazioni dal pannello. Questo accesso viene concesso **da Exchange** e limitato alle caselle marcate al passo 3.3. Fonti: *Limit Microsoft Graph application permissions to specific Exchange mailboxes* (RBAC for Applications), `New-ServicePrincipal`, `New-ManagementScope`, `New-ManagementRoleAssignment`, `Test-ServicePrincipalAuthorization`.

In Exchange Online PowerShell (passo 3.2):

```powershell
# 1. Registra l'app in Exchange. AppId = Application (client) ID (passo 2.1);
#    ObjectId = Object ID dell'applicazione aziendale (passo 2.8).
New-ServicePrincipal -AppId <client-id> -ObjectId <object-id-enterprise-app> -DisplayName "Ritrovo"

# 2. Ambito: solo le caselle marcate "Ritrovo".
New-ManagementScope -Name "Ritrovo - caselle risorsa" -RecipientRestrictionFilter "CustomAttribute15 -eq 'Ritrovo'"

# 3. Permesso calendari solo all'interno di quell'ambito.
New-ManagementRoleAssignment -Name "Ritrovo - calendari sale" -Role "Application Calendars.ReadWrite" `
  -App <object-id-enterprise-app> -CustomResourceScope "Ritrovo - caselle risorsa"
```

**Verifica.** Il primo comando deve mostrare `InScope = True`, il secondo `InScope = False`:

```powershell
Test-ServicePrincipalAuthorization -Identity <object-id-enterprise-app> -Resource "<email-di-una-sala>" | Format-Table
Test-ServicePrincipalAuthorization -Identity <object-id-enterprise-app> -Resource "<email-di-un-dipendente>" | Format-Table
```

Le modifiche RBAC possono richiedere tempo prima di diventare effettive (la durata esatta non è stata verificata). Se Ritrovo mostra errori di accesso negato subito dopo, attendi e riprova da **Amministrazione** > **Sincronizzazione** > **Sincronizza ora**.

**Nuove sale in futuro:** basta creare la casella, eseguire il passo 3.3 (inclusa la marcatura) e aggiungerla in Ritrovo. L'ambito RBAC la include automaticamente.

---

## 5. (Facoltativo) Importare le sale con Microsoft Places

In **Amministrazione** > **Risorse**, il pulsante **Importa sale da Microsoft 365** usa l'API Places di Microsoft Graph. Secondo la documentazione Microsoft, l'elenco dei luoghi restituisce risultati solo se gli edifici di Places sono abilitati:

```powershell
Install-Module -Name MicrosoftPlaces -Scope CurrentUser
Connect-MicrosoftPlaces
Set-PlacesSettings -EnableBuildings 'Default:true'
```

Se non vuoi modificare le impostazioni di Places, salta questo passo e aggiungi le sale a mano in Ritrovo, indicando l'email della casella (passo 7). Il risultato è lo stesso. I requisiti di licenza di Microsoft Places non sono stati verificati.

---

## 6. Installare Ritrovo sul server

### 6.1 Scaricare il codice

```bash
sudo mkdir -p /opt/ritrovo && sudo chown "$USER" /opt/ritrovo
git clone <indirizzo-del-repository> /opt/ritrovo
cd /opt/ritrovo
```

### 6.2 Compilare il file `.env`

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

| Variabile | Valore | Da dove viene |
|-----------|--------|---------------|
| `PUBLIC_BASE_URL` | `https://<host>` (senza `/` finale) | passo 1.3 |
| `RITROVO_DOMAIN` | `<host>` | passo 1.3 |
| `POSTGRES_PASSWORD` | password lunga e casuale | `openssl rand -base64 32` |
| `ENTRA_TENANT_ID` | Directory (tenant) ID | passo 2.1 |
| `ENTRA_CLIENT_ID` | Application (client) ID | passo 2.1 |
| `ENTRA_CLIENT_CERT_PATH`, `ENTRA_CLIENT_KEY_PATH` | lascia i valori proposti | passo 2.6 (file in `secrets/`) |
| `ENTRA_CLIENT_SECRET` | solo se non usi il certificato | passo 2.6 |
| `INITIAL_ADMIN_EMAILS` | la tua email aziendale (anche più di una, separate da virgola) | — |
| `GRAPH_WEBHOOKS_ENABLED` | `true` nello scenario A, `false` nello scenario B | passo 1.3 |

Lascia `AUTH_MODE=entra`, `GRAPH_MODE=live`, `NODE_ENV=production`, `SEED_DEMO_DATA=false`. Ritrovo **rifiuta di avviarsi** se mancano valori obbligatori o se la combinazione non è sicura (per esempio accesso demo con Exchange reale): leggi il messaggio con `docker compose logs app`.

### 6.3 Certificato HTTPS (solo scenario B)

Copia in `secrets/` il certificato aziendale come `ritrovo.crt` (con l'eventuale catena intermedia) e la chiave come `ritrovo.key`. Poi in `deploy/Caddyfile` togli il `#` dalla riga `tls /certs/ritrovo.crt /certs/ritrovo.key`.

### 6.4 Avvio

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose ps
curl -s https://<host>/api/health
```

La risposta di `/api/health` deve contenere `"status":"ok"`. Il database viene creato e aggiornato automaticamente all'avvio. Se il server non ha accesso a Internet in uscita, la build non può scaricare le dipendenze: costruisci l'immagine su un'altra macchina e trasferiscila (`docker save` / `docker load`).

---

## 7. Primo accesso e configurazione di Ritrovo

1. Apri `https://<host>` e seleziona **Accedi con Microsoft** con l'account indicato in `INITIAL_ADMIN_EMAILS`. Al primo accesso diventi amministratore.
2. **Amministrazione** > **Edifici e piani**: crea l'edificio e i piani, poi carica la planimetria di ogni piano (SVG, PNG o JPEG, massimo 2 MB).
3. **Amministrazione** > **Risorse**:
   - **sale e attrezzature**: **Importa sale da Microsoft 365** (passo 5) oppure **Nuova risorsa**, indicando l'email della casella in **Casella Exchange**;
   - **postazioni**: **Nuova risorsa** di tipo *Postazione*, **senza** casella;
   - per ogni risorsa: capienza, dotazioni, check-in obbligatorio, tolleranza, durata massima, anticipo massimo.
   
   Poi, in **Edifici e piani**, seleziona una risorsa e clicca sulla planimetria per posizionarla.
4. Per ogni sala apri *modifica risorsa*, copia i comandi in **Allineamento Exchange (PowerShell)** ed eseguili (passo 3.3), così le regole di Exchange coincidono con quelle di Ritrovo.
5. **Amministrazione** > **Regole**: orario e giorni lavorativi (usati dai KPI), tolleranza predefinita del check-in, conservazione dei dati, cosa mostrare sui pannelli.
6. **Amministrazione** > **Sincronizzazione**: ogni casella deve avere una data di **Ultima sincronizzazione** e nessun **Ultimo errore**. Con i webhook attivi compare anche la scadenza della sottoscrizione, che Ritrovo rinnova da solo.
7. Prova completa: prenota una sala da Ritrovo e verifica che la riunione compaia nel tuo calendario Outlook e che la sala risulti accettata. Poi prenota la stessa sala da Outlook e verifica che la prenotazione compaia in Ritrovo entro 2 minuti (subito con i webhook).

---

## 8. Distribuire l'add-in Outlook

Ritrovo genera il manifest dell'add-in già compilato con il tuo indirizzo: `https://<host>/addin/manifest.xml`. È un manifest XML (*add-in only*), il formato che funziona su Outlook per Windows (nuovo e classico), Mac, web e mobile. Il motivo della scelta è in `02-progetto.md`, §3.3.

Fonte: *Deploy Office Add-ins in the Microsoft 365 admin center*.

1. **https://admin.microsoft.com** > **… Show all** > **Settings** > **Integrated apps**.
2. Seleziona il link **Add-ins** nella parte alta della pagina > **Deploy Add-in** > **Next**.
3. Scegli il caricamento di un add-in personalizzato. In **Choose how to upload app**:
   - indica l'URL `https://<host>/addin/manifest.xml` (consigliato: gli aggiornamenti del manifest vengono letti da lì), **oppure**
   - scarica il file da quell'URL e caricalo con **Choose File**.
   
   Poi seleziona **Upload**.
4. Scegli i destinatari: **Just me** per una prima prova, poi **Specific users/groups** (consigliato: un gruppo pilota) e infine **Everyone**.
5. Seleziona **Deploy**, poi **Next**.

L'add-in può impiegare **da 24 a 72 ore** per comparire a tutti; gli utenti potrebbero dover riavviare Outlook.

Dove compare (gruppo **Ritrovo** sulla barra multifunzione): nella finestra di una nuova riunione, pulsante **Prenota una sala**, con le sale libere nell'orario della riunione e il comando **Aggiungi alla riunione**; nella lettura di messaggi e riunioni, pulsante **Prenotazioni**, con la prenotazione rapida e le prenotazioni del giorno.

---

## 9. Pannelli fuori-porta, totem, QR code e NFC

**Pannello fuori-porta** (un tablet accanto alla porta della sala):

1. **Amministrazione** > **Pannelli e totem** > **Nuovo dispositivo** > *Pannello fuori-porta*, poi scegli la sala.
2. Apri il **link di abbinamento** sul tablet, **una sola volta**: il link non viene più mostrato. Se lo perdi, revoca il dispositivo e creane uno nuovo.
3. Sul tablet attiva la modalità a schermo intero o kiosk del sistema operativo (per esempio *Accesso guidato* su iPad, *Blocco app su schermo* su Android) e disattiva lo spegnimento automatico dello schermo.

Il tablet non usa account Microsoft: la chiave del dispositivo vale solo per quella sala ed è revocabile da **Pannelli e totem** > **Revoca**.

**Totem** (lo stato di tutte le sale di un edificio, per esempio su uno schermo all'ingresso): stessa procedura con *Totem*. L'indirizzo funziona su qualsiasi player di digital signage dotato di browser.

**QR code**: **Amministrazione** > **Risorse** > **Stampa i QR code**. Stampa e applica l'etichetta su sale, postazioni e risorse. Inquadrando il codice si aprono la scheda della risorsa, il check-in e la prenotazione immediata.

**NFC**: con un'app per scrivere tag NFC (per esempio *NFC Tools*), scrivi sul tag un record **URL/URI** con lo stesso indirizzo del QR code (`https://<host>/q/…`), che trovi nella scheda della risorsa.

---

## 10. Backup e ripristino

Il backup salva il database (regole, check-in, postazioni, planimetrie, storico). I calendari stanno in Exchange e seguono i backup di Microsoft 365.

```bash
cd /opt/ritrovo
./scripts/backup.sh                 # crea backups/ritrovo-AAAA-MM-GG_HHMM.dump
crontab -e                          # backup ogni notte alle 02:15
15 2 * * * cd /opt/ritrovo && ./scripts/backup.sh >> backups/backup.log 2>&1
```

Vengono conservati gli ultimi 14 giorni (modificabile con `KEEP_DAYS=30 ./scripts/backup.sh`). **Copia la cartella `backups/` anche fuori dal server** (NAS, archivio aziendale) e conserva in un luogo sicuro anche `.env` e `secrets/`, senza i quali il backup non basta per ripartire.

**Ripristino** (sostituisce i dati attuali e chiede conferma scrivendo `SI`):

```bash
./scripts/restore.sh backups/ritrovo-2026-10-13_0215.dump
```

Prova il ripristino almeno una volta, per esempio su una VM di prova.

---

## 11. Aggiornamenti

```bash
cd /opt/ritrovo
./scripts/backup.sh
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Le modifiche al database vengono applicate automaticamente all'avvio. Se cambia la versione del manifest dell'add-in e l'hai distribuito tramite URL, Microsoft 365 rileva l'aggiornamento da solo; se l'hai caricato come file, ricaricalo da **Integrated apps**.

---

## 12. Privacy e GDPR (prima di usare Ritrovo con i colleghi)

Ritrovo è progettato con la minimizzazione dei dati (`02-progetto.md`, §8): KPI solo aggregati, anonimizzazione delle prenotazioni dopo 180 giorni, nessuna geolocalizzazione e nessun video. Restano adempimenti che solo l'organizzazione può fare:

- aggiornare il **registro dei trattamenti** e valutare con il DPO se serve una **DPIA**;
- consegnare ai dipendenti l'**informativa** (bozza in `04-uso.md`, da adattare);
- valutare l'**art. 4 dello Statuto dei lavoratori** (L. 300/1970) prima di rendere obbligatorio il check-in, perché le registrazioni di presenza potrebbero rientrare tra gli strumenti di controllo a distanza;
- decidere in **Amministrazione** > **Regole** i tempi di conservazione e cosa mostrare sui pannelli (per impostazione predefinita l'oggetto delle riunioni è nascosto);
- informare che ogni utente può nascondersi da "trova un collega" (pagina **Oggi** > **Privacy**).

Questa sezione non è una consulenza legale.

---

## 13. Risoluzione dei problemi

| Sintomo | Causa probabile | Cosa fare |
|---------|-----------------|-----------|
| Ritrovo non parte: `docker compose logs app` mostra un errore di configurazione | variabile mancante o combinazione non sicura in `.env` | correggi `.env` come indicato nel messaggio, poi rilancia il passo 6.4 |
| Dopo l'accesso: "AADSTS50011 … redirect URI" | redirect mancante o scritto male | passo 2.2: `https://<host>/redirect.html` di tipo *Single-page application* |
| "Il token non contiene lo scope access_as_user" | scope non creato o nome diverso | passo 2.3 e 2.5 (punto 2) |
| Richiesta di consenso agli utenti, oppure "need admin approval" | consenso amministratore non concesso | passo 2.5, punto 3 |
| **Sincronizzazione**: "ErrorAccessDenied" o 403 su una sala | casella non marcata o RBAC non ancora attivo | passi 3.3 e 4 (`Test-ServicePrincipalAuthorization`); attendi e poi **Sincronizza ora** |
| Prenotazione "In attesa di conferma" che poi diventa "Rifiutata" | Exchange ha rifiutato (conflitto o regole della casella) | confronta `Set-CalendarProcessing` con le regole in Ritrovo (passo 7.4) |
| Le prenotazioni fatte in Outlook arrivano in Ritrovo con ritardo | webhook disattivati (scenario B) | normale: polling ogni 2 minuti (`GRAPH_DELTA_INTERVAL_SECONDS`) |
| Webhook attivi ma nessuna notifica | il server non è raggiungibile da Internet in HTTPS | verifica porte e certificato, oppure imposta `GRAPH_WEBHOOKS_ENABLED=false` |
| L'add-in non compare | distribuzione in corso (fino a 72 ore), utente escluso o add-in disattivati nell'organizzazione | **Integrated apps**: controlla stato e destinatari; riavvia Outlook. In Exchange PowerShell `Get-OrganizationConfig \| fl AppsForOfficeEnabled` deve restituire `True` |
| L'add-in compare ma chiede di accedere ogni volta | redirect NAA mancante | passo 2.2, punto 4 (`brk-multihub://<host>`) |
| **Importa sale da Microsoft 365** non trova nulla | edifici di Places non abilitati | passo 5, oppure aggiungi le sale a mano |
| Il pannello mostra "Pannello non abbinato" | chiave revocata o dati del browser del tablet cancellati | crea un nuovo dispositivo e apri il nuovo link |

Per una diagnosi più dettagliata: imposta temporaneamente `LOG_LEVEL=debug` in `.env`, riavvia e poi riportalo a `info`. Nel livello debug i log contengono gli indirizzi IP, che sono dati personali.

---

## 14. Alternativa: Azure App Service (non verificato)

Ritrovo è un'immagine Docker standard (porta 8080, controllo di salute su `/api/health`) e richiede PostgreSQL 16. In teoria può girare su **Azure App Service for Containers** con **Azure Database for PostgreSQL – Flexible Server**, impostando le stesse variabili di `.env` come *Application settings* e `DATABASE_URL` verso il database gestito; Caddy non servirebbe, perché l'HTTPS è fornito da App Service.

Questa configurazione **non è stata provata** e i passi nel portale Azure **non sono stati verificati**. Inoltre crea risorse a pagamento nel cloud: valutala solo dopo aver controllato i costi e la documentazione Microsoft aggiornata.

---

## 15. Lista di controllo finale

- [ ] Registrazione app con due redirect SPA, scope `access_as_user`, ruoli `Ritrovo.Admin` e `Ritrovo.Reception`
- [ ] Permessi delegati con stato **Granted for <tenant>**; nessun permesso applicativo Graph in Entra
- [ ] Certificato caricato in Entra (data di scadenza in agenda)
- [ ] Caselle delle sale con `Set-CalendarProcessing` e `CustomAttribute15 = Ritrovo`
- [ ] RBAC for Applications: `InScope = True` sulle sale, `False` sugli utenti
- [ ] `.env` compilato con permessi `600`, `secrets/` con la chiave leggibile solo dall'utente 1000
- [ ] `https://<host>/api/health` risponde `ok`
- [ ] **Sincronizzazione** senza errori; prova Ritrovo → Outlook e Outlook → Ritrovo superata
- [ ] Add-in distribuito al gruppo pilota, poi a tutti
- [ ] Backup notturno in cron, copia esterna, ripristino provato
- [ ] Informativa consegnata e valutazione privacy fatta

---

## Fonti (verificate il 13/10/2026)

Verificate sui repository GitHub da cui Microsoft Learn viene pubblicato: `MicrosoftDocs/entra-docs` (commit 7d26185 del 12/10/2026), `MicrosoftDocs/microsoft-365-docs`, `MicrosoftDocs/office-docs-powershell`, `OfficeDev/office-js-docs-pr`, `microsoftgraph/microsoft-graph-docs-contrib`. Da questo ambiente `learn.microsoft.com` non era raggiungibile.

| Passo | Pagina |
|-------|--------|
| 2.1 | https://learn.microsoft.com/entra/identity-platform/quickstart-register-app |
| 2.2 | https://learn.microsoft.com/entra/identity-platform/how-to-add-redirect-uri |
| 2.2 (NAA) | https://learn.microsoft.com/office/dev/add-ins/develop/enable-nested-app-authentication-in-your-add-in |
| 2.3, 2.4 | https://learn.microsoft.com/entra/identity-platform/quickstart-configure-app-expose-web-apis, https://learn.microsoft.com/entra/identity-platform/howto-add-app-roles-in-apps |
| 2.5 | https://learn.microsoft.com/entra/identity-platform/quickstart-configure-app-access-web-apis, https://learn.microsoft.com/entra/identity/enterprise-apps/grant-admin-consent |
| 2.6 | https://learn.microsoft.com/entra/identity-platform/how-to-add-credentials |
| 2.7 | https://learn.microsoft.com/entra/identity-platform/howto-add-app-roles-in-apps#assign-users-and-groups-to-microsoft-entra-roles, https://learn.microsoft.com/entra/identity/enterprise-apps/application-properties |
| 3.1 | https://learn.microsoft.com/microsoft-365/admin/manage/room-and-equipment-mailboxes |
| 3.2 | https://learn.microsoft.com/powershell/module/exchangepowershell/connect-exchangeonline |
| 3.3 | https://learn.microsoft.com/powershell/module/exchangepowershell/set-calendarprocessing, https://learn.microsoft.com/powershell/module/exchangepowershell/set-mailbox |
| 4 | https://learn.microsoft.com/exchange/permissions-exo/application-rbac, https://learn.microsoft.com/powershell/module/exchangepowershell/new-serviceprincipal, https://learn.microsoft.com/powershell/module/exchangepowershell/new-managementscope, https://learn.microsoft.com/powershell/module/exchangepowershell/new-managementroleassignment, https://learn.microsoft.com/powershell/module/exchangepowershell/test-serviceprincipalauthorization |
| 5 | https://learn.microsoft.com/graph/api/resources/places-api-overview, https://learn.microsoft.com/microsoft-365/places/powershell/set-placessettings |
| 8 | https://learn.microsoft.com/microsoft-365/admin/manage/manage-deployment-of-add-ins, https://learn.microsoft.com/microsoft-365/admin/manage/centralized-deployment-of-add-ins |

**Non verificato:** traduzioni italiane delle voci di menu; tempo di propagazione delle assegnazioni RBAC; requisiti di licenza di Microsoft Places; tutta la sezione 14 (Azure App Service).
